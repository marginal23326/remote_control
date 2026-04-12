use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use crossbeam_queue::ArrayQueue;
use socketioxide::extract::SocketRef;

pub struct AudioManager {
    server_input_stream: Arc<Mutex<Option<cpal::Stream>>>,
    client_output_stream: Arc<Mutex<Option<cpal::Stream>>>,
    client_audio_buffer: Arc<ArrayQueue<f32>>,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            server_input_stream: Arc::new(Mutex::new(None)),
            client_output_stream: Arc::new(Mutex::new(None)),
            client_audio_buffer: Arc::new(ArrayQueue::new(48000)), 
        }
    }

    pub fn start_server_stream(&self, socket: SocketRef, source: String, rate: u32) -> Result<(), String> {
        self.stop_server_stream();

        let host = cpal::default_host();
        
        let device = if source == "system" {
            host.default_output_device().ok_or("No output device (system)")?
        } else {
            host.default_input_device().ok_or("No input device (mic)")?
        };

        // FIX: Added 'mut' here
        let mut supported_configs_range = device.supported_input_configs().map_err(|e| e.to_string())?;
        
        let supported_config = supported_configs_range
            .find(|c| c.max_sample_rate() >= rate && c.min_sample_rate() <= rate)
            .ok_or("Device does not support requested sample rate")?
            .with_sample_rate(rate);

        let config: cpal::StreamConfig = supported_config.into();
        let channels = config.channels as usize;

        let socket_clone = socket.clone();
        let err_fn = move |err| tracing::error!("Audio input error: {}", err);

        let stream = device.build_input_stream(
            &config,
            move |data: &[f32], _: &_| {
                let mut mono_samples = Vec::with_capacity(data.len() / channels);
                for frame in data.chunks(channels) {
                    let sum: f32 = frame.iter().sum();
                    let avg = sum / channels as f32;
                    mono_samples.push(avg);
                }
                let pcm: Vec<u8> = mono_samples.iter()
                    .flat_map(|&sample| {
                        let s = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        s.to_le_bytes()
                    })
                    .collect();
                let _ = socket_clone.emit("server_audio_data", &pcm);
            },
            err_fn,
            None
        ).map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;
        *self.server_input_stream.lock().unwrap() = Some(stream);
        Ok(())
    }

    pub fn stop_server_stream(&self) {
        let mut stream = self.server_input_stream.lock().unwrap();
        if let Some(s) = stream.take() { drop(s); }
    }

    pub fn start_client_playback(&self, rate: u32) -> Result<(), String> {
        self.stop_client_playback();

        let host = cpal::default_host();
        let device = host.default_output_device().ok_or("No output device")?;
        
        // FIX: Added 'mut' here
        let mut supported_configs_range = device.supported_output_configs().map_err(|e| e.to_string())?;
        
        let supported_config = supported_configs_range
            .find(|c| c.max_sample_rate() >= rate && c.min_sample_rate() <= rate)
            .ok_or("Device does not support requested sample rate")?
            .with_sample_rate(rate);

        let config: cpal::StreamConfig = supported_config.into();
        let channels = config.channels as usize;
        let queue_ref = self.client_audio_buffer.clone();

        let stream = device.build_output_stream(
            &config,
            move |data: &mut [f32], _: &_| {
                for frame in data.chunks_mut(channels) {
                    if let Some(sample) = queue_ref.pop() {
                        for out in frame.iter_mut() {
                            *out = sample;
                        }
                    } else {
                        for out in frame.iter_mut() {
                            *out = 0.0;
                        }
                    }
                }
            },
            |err| tracing::error!("Playback error: {}", err),
            None
        ).map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;
        *self.client_output_stream.lock().unwrap() = Some(stream);
        Ok(())
    }

    pub fn process_client_audio(&self, data: Vec<u8>) {
        for chunk in data.chunks_exact(2) {
            let i16_sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            let f32_sample = i16_sample as f32 / i16::MAX as f32;
            if self.client_audio_buffer.push(f32_sample).is_err() {
                let _ = self.client_audio_buffer.pop();
                let _ = self.client_audio_buffer.push(f32_sample);
            }
        }
    }

    pub fn stop_client_playback(&self) {
        let mut stream = self.client_output_stream.lock().unwrap();
        if let Some(s) = stream.take() { drop(s); }
        while self.client_audio_buffer.pop().is_some() {}
    }
}