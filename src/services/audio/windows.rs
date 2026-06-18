use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crossbeam_queue::ArrayQueue;
use socketioxide::extract::SocketRef;
use wasapi::*;

pub(crate) fn server_loop(
    socket: SocketRef,
    source: String,
    _rate: u32, // We ignore the requested rate and use the hardware's zero-latency native rate
    is_running: Arc<AtomicBool>,
) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;

    // Direction::Capture on a Render device automatically enables loopback capture
    let direction = if source == "system" {
        Direction::Render
    } else {
        Direction::Capture
    };

    let device = enumerator.get_default_device(&direction).map_err(|e| e.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let mix_format = audio_client.get_mixformat().map_err(|e| e.to_string())?;

    let (_, min_time) = audio_client.get_device_period().unwrap_or((0, 0));
    let mode = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: min_time,
    };

    audio_client
        .initialize_client(&mix_format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;

    let actual_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels() as usize;
    let sample_type = mix_format.get_subformat().unwrap_or(SampleType::Float);
    let blockalign = mix_format.get_blockalign() as usize;
    let bytes_per_sample = blockalign / channels;

    const OUTPUT_FORMAT: &str = "int16";

    let _ = socket.emit(
        "server_audio_format",
        &serde_json::json!({
            "rate": actual_rate,
            "channels": 1,
            "format": OUTPUT_FORMAT,
        }),
    );

    let h_event = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let render_client = audio_client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    let mut sample_queue = VecDeque::new();
    let chunksize = 1024;

    loop {
        if !is_running.load(Ordering::SeqCst) {
            let _ = audio_client.stop_stream();
            break;
        }

        if render_client.read_from_device_to_deque(&mut sample_queue).is_err() {
            break;
        }

        while sample_queue.len() >= blockalign * chunksize {
            let mut pcm = Vec::with_capacity(chunksize * 2);

            for _ in 0..chunksize {
                let mut sum = 0.0;

                for _ in 0..channels {
                    let val = match (sample_type, bytes_per_sample) {
                        (SampleType::Float, 4) => {
                            let b = [
                                sample_queue.pop_front().unwrap(),
                                sample_queue.pop_front().unwrap(),
                                sample_queue.pop_front().unwrap(),
                                sample_queue.pop_front().unwrap(),
                            ];
                            f32::from_le_bytes(b)
                        }
                        (SampleType::Int, 2) => {
                            let b = [sample_queue.pop_front().unwrap(), sample_queue.pop_front().unwrap()];
                            i16::from_le_bytes(b) as f32 / i16::MAX as f32
                        }
                        _ => {
                            for _ in 0..bytes_per_sample {
                                sample_queue.pop_front().unwrap();
                            }
                            0.0
                        }
                    };
                    sum += val;
                }

                // Downmix to perfectly centered Mono, compressed to Int16
                let avg = sum / channels as f32;
                let s = (avg.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                pcm.extend_from_slice(&s.to_le_bytes());
            }
            let _ = socket.emit("server_audio_data", &pcm);
        }

        let _ = h_event.wait_for_event(100);
    }
    Ok(())
}

pub(crate) fn client_loop(_rate: u32, is_running: Arc<AtomicBool>, queue: Arc<ArrayQueue<f32>>) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;

    let mix_format = audio_client.get_mixformat().map_err(|e| e.to_string())?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(&mix_format, &Direction::Render, &mode)
        .map_err(|e| e.to_string())?;

    let channels = mix_format.get_nchannels() as usize;
    let sample_type = mix_format.get_subformat().unwrap_or(SampleType::Float);
    let blockalign = mix_format.get_blockalign() as usize;
    let bytes_per_sample = blockalign / channels;

    let h_event = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let render_client = audio_client.get_audiorenderclient().map_err(|e| e.to_string())?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    let mut sample_queue = VecDeque::new();

    loop {
        if !is_running.load(Ordering::SeqCst) {
            let _ = audio_client.stop_stream();
            break;
        }

        let buffer_frame_count = match audio_client.get_available_space_in_frames() {
            Ok(frames) => frames as usize,
            Err(_) => break,
        };

        while sample_queue.len() < blockalign * buffer_frame_count {
            let f = queue.pop().unwrap_or(0.0);

            for _ in 0..channels {
                if sample_type == SampleType::Float && bytes_per_sample == 4 {
                    sample_queue.extend(&f.to_le_bytes());
                } else if sample_type == SampleType::Int && bytes_per_sample == 2 {
                    let i = (f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    sample_queue.extend(&i.to_le_bytes());
                } else {
                    for _ in 0..bytes_per_sample {
                        sample_queue.push_back(0);
                    }
                }
            }
        }

        let _ = render_client.write_to_device_from_deque(buffer_frame_count, &mut sample_queue, None);
        let _ = h_event.wait_for_event(100);
    }
    Ok(())
}
