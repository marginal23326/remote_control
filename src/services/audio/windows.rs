use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crossbeam_queue::ArrayQueue;
use socketioxide::extract::SocketRef;
use wasapi::*;

fn decode_sample(sample: &[u8], sample_type: SampleType, bytes_per_sample: usize) -> f32 {
    match (sample_type, bytes_per_sample) {
        (SampleType::Float, 4) => f32::from_le_bytes(sample.try_into().unwrap()),
        (SampleType::Int, 2) => i16::from_le_bytes(sample.try_into().unwrap()) as f32 / i16::MAX as f32,
        (SampleType::Int, 4) => i32::from_le_bytes(sample.try_into().unwrap()) as f32 / i32::MAX as f32,
        (SampleType::Int, 3) => {
            let b = [0, sample[0], sample[1], sample[2]];
            (i32::from_le_bytes(b) >> 8) as f32 / 8388607.0
        }
        _ => 0.0,
    }
}

fn encode_sample(f: f32, sample_type: SampleType, bytes_per_sample: usize, out: &mut VecDeque<u8>) {
    match (sample_type, bytes_per_sample) {
        (SampleType::Float, 4) => out.extend(&f.to_le_bytes()),
        (SampleType::Int, 2) => out.extend(&((f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes()),
        (SampleType::Int, 4) => out.extend(&((f.clamp(-1.0, 1.0) * i32::MAX as f32) as i32).to_le_bytes()),
        (SampleType::Int, 3) => {
            let i = (f.clamp(-1.0, 1.0) * 8388607.0) as i32;
            out.extend(&i.to_le_bytes()[0..3]);
        }
        _ => {
            for _ in 0..bytes_per_sample {
                out.push_back(0);
            }
        }
    }
}

pub(crate) fn server_loop(
    socket: SocketRef,
    source: String,
    device_id: Option<String>,
    _rate: u32,
    is_running: Arc<AtomicBool>,
) -> Result<(), String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;

    let device = match device_id.filter(|id| !id.is_empty()) {
        Some(id) => enumerator.get_device(&id).map_err(|e| e.to_string())?,
        None => {
            let direction = if source == "system" {
                Direction::Render
            } else {
                Direction::Capture
            };
            enumerator.get_default_device(&direction).map_err(|e| e.to_string())?
        }
    };

    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let mix_format = audio_client.get_mixformat().map_err(|e| e.to_string())?;

    let mode = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: 0,
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
    let mut pcm = Vec::new();

    loop {
        if !is_running.load(Ordering::SeqCst) {
            let _ = audio_client.stop_stream();
            break;
        }

        if render_client.read_from_device_to_deque(&mut sample_queue).is_err() {
            break;
        }

        let frame_count = sample_queue.len() / blockalign;
        if frame_count > 0 {
            pcm.clear();

            let flat_slice = sample_queue.make_contiguous();
            let process_bytes = frame_count * blockalign;

            for frame in flat_slice[..process_bytes].chunks_exact(blockalign) {
                let mut sum = 0.0;

                for c in 0..channels {
                    let offset = c * bytes_per_sample;
                    let sample = &frame[offset..offset + bytes_per_sample];
                    sum += decode_sample(sample, sample_type, bytes_per_sample);
                }

                let avg = sum / channels as f32;
                let s = (avg.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                pcm.extend_from_slice(&s.to_le_bytes());
            }

            sample_queue.drain(..process_bytes);

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
                encode_sample(f, sample_type, bytes_per_sample, &mut sample_queue);
            }
        }

        let _ = render_client.write_to_device_from_deque(buffer_frame_count, &mut sample_queue, None);
        let _ = h_event.wait_for_event(100);
    }
    Ok(())
}

pub(crate) fn list_sources() -> Result<Vec<super::AudioSourceInfo>, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let mut sources = Vec::new();
    let mut name_counts = std::collections::HashMap::new();

    for (direction, kind) in [
        (Direction::Capture, super::AudioSourceKind::Mic),
        (Direction::Render, super::AudioSourceKind::System),
    ] {
        let collection = enumerator
            .get_device_collection(&direction)
            .map_err(|e| e.to_string())?;

        for device in &collection {
            let Ok(device) = device else { continue };
            let (Ok(id), Ok(name)) = (device.get_id(), device.get_friendlyname()) else {
                continue;
            };

            let count = name_counts.entry(name.clone()).or_insert(0u32);
            *count += 1;

            let display_name = if *count > 1 {
                format!("{} #{}", name, count)
            } else {
                name
            };

            sources.push(super::AudioSourceInfo {
                id,
                name: display_name,
                kind,
            });
        }
    }

    Ok(sources)
}
