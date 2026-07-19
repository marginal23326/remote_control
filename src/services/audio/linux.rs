use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crossbeam_channel::bounded;
use crossbeam_queue::ArrayQueue;
use socketioxide::extract::SocketRef;

use pipewire as pw;
use pw::{properties::properties, spa, types::ObjectType};

pub(crate) fn server_loop(
    socket: SocketRef,
    source: String,
    device_id: Option<String>,
    rate: u32,
    is_running: Arc<AtomicBool>,
) -> Result<(), String> {
    let mainloop = pw::main_loop::MainLoopBox::new(None).map_err(|e| e.to_string())?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None).map_err(|e| e.to_string())?;
    let core = context.connect(None).map_err(|e| e.to_string())?;

    let capture_queue = Arc::new(ArrayQueue::<i16>::new(48000 * 2));

    let (wake_tx, wake_rx) = bounded::<()>(1);

    struct CaptureUserData {
        capture_queue: Arc<ArrayQueue<i16>>,
        is_running: Arc<AtomicBool>,
        main_loop: *mut pw::sys::pw_main_loop,
        wake_tx: crossbeam_channel::Sender<()>,
        socket: SocketRef,
    }

    let data = CaptureUserData {
        capture_queue: capture_queue.clone(),
        is_running: is_running.clone(),
        main_loop: mainloop.as_raw_ptr(),
        wake_tx,
        socket: socket.clone(),
    };

    let mut props = if source == "system" {
        properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Music",
            *pw::keys::STREAM_CAPTURE_SINK => "true",
        }
    } else {
        properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Communication",
        }
    };

    if let Some(id) = device_id.filter(|id| !id.is_empty()) {
        props.insert(*pw::keys::TARGET_OBJECT, id);
    }

    let stream = pw::stream::StreamBox::new(&core, "remote-control-audio-capture", props).map_err(|e| e.to_string())?;

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else { return };
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }

            let mut format = spa::param::audio::AudioInfoRaw::default();
            if format.parse(param).is_ok() {
                let negotiated_rate = format.rate();
                let _ = user_data.socket.emit(
                    "server_audio_format",
                    &serde_json::json!({
                        "rate": negotiated_rate,
                        "channels": 1,
                        "format": "int16"
                    }),
                );
            }
        })
        .process(|stream, user_data| {
            if !user_data.is_running.load(Ordering::SeqCst) {
                unsafe {
                    pw::sys::pw_main_loop_quit(user_data.main_loop);
                }
                return;
            }

            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }

            let chunk = datas[0].chunk();
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;

            if let Some(mapped_data) = datas[0].data()
                && offset + size <= mapped_data.len()
            {
                let valid_data = &mapped_data[offset..offset + size];

                for chunk in valid_data.chunks_exact(4) {
                    let f = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    let s = (f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;

                    if user_data.capture_queue.push(s).is_err() {
                        let _ = user_data.capture_queue.pop();
                        let _ = user_data.capture_queue.push(s);
                    }
                }

                let _ = user_data.wake_tx.try_send(());
            }
        })
        .register()
        .map_err(|e| e.to_string())?;

    let socket_clone = socket.clone();
    let thread_running = is_running.clone();
    let thread_queue = capture_queue.clone();

    thread::spawn(move || {
        let mut pcm = Vec::new();

        while thread_running.load(Ordering::SeqCst) {
            if wake_rx.recv().is_err() {
                break;
            }

            while let Some(sample) = thread_queue.pop() {
                pcm.extend_from_slice(&sample.to_le_bytes());
            }

            if !pcm.is_empty() {
                let _ = socket_clone.emit("server_audio_data", &pcm);
                pcm.clear();
            }
        }

        while let Some(sample) = thread_queue.pop() {
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        if !pcm.is_empty() {
            let _ = socket_clone.emit("server_audio_data", &pcm);
        }
    });

    let mut audio_info = spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
    audio_info.set_rate(rate);
    audio_info.set_channels(1);

    let obj = pw::spa::pod::Object {
        type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pw::spa::param::ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };

    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .unwrap()
    .0
    .into_inner();

    let mut params = [spa::pod::Pod::from_bytes(&values).unwrap()];

    stream
        .connect(
            spa::utils::Direction::Input,
            None,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::RT_PROCESS,
            &mut params,
        )
        .map_err(|e| e.to_string())?;

    mainloop.run();
    Ok(())
}

pub(crate) fn client_loop(rate: u32, is_running: Arc<AtomicBool>, queue: Arc<ArrayQueue<f32>>) -> Result<(), String> {
    let mainloop = pw::main_loop::MainLoopBox::new(None).map_err(|e| e.to_string())?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None).map_err(|e| e.to_string())?;
    let core = context.connect(None).map_err(|e| e.to_string())?;

    struct PlaybackUserData {
        queue: Arc<ArrayQueue<f32>>,
        is_running: Arc<AtomicBool>,
        main_loop: *mut pw::sys::pw_main_loop,
    }

    let data = PlaybackUserData {
        queue,
        is_running,
        main_loop: mainloop.as_raw_ptr(),
    };

    let props = properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Playback",
        *pw::keys::MEDIA_ROLE => "Communication",
    };

    let stream =
        pw::stream::StreamBox::new(&core, "remote-control-audio-playback", props).map_err(|e| e.to_string())?;

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .process(|stream, user_data| {
            if !user_data.is_running.load(Ordering::SeqCst) {
                unsafe {
                    pw::sys::pw_main_loop_quit(user_data.main_loop);
                }
                return;
            }

            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let requested_frames = buffer.requested() as usize;
            let stride = 4;

            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];

            if let Some(slice) = data.data() {
                let frames_to_write = if requested_frames > 0 {
                    requested_frames.min(slice.len() / 4)
                } else {
                    slice.len() / 4
                };

                let bytes_to_write = frames_to_write * 4;

                for chunk in slice[..bytes_to_write].chunks_exact_mut(4) {
                    let f = user_data.queue.pop().unwrap_or(0.0);
                    chunk.copy_from_slice(&f.to_le_bytes());
                }

                let chunk_mut = data.chunk_mut();
                *chunk_mut.offset_mut() = 0;
                *chunk_mut.size_mut() = bytes_to_write as u32;
                *chunk_mut.stride_mut() = stride;
            }
        })
        .register()
        .map_err(|e| e.to_string())?;

    let mut audio_info = spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
    audio_info.set_rate(rate);
    audio_info.set_channels(1);

    let obj = pw::spa::pod::Object {
        type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pw::spa::param::ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };

    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .unwrap()
    .0
    .into_inner();

    let mut params = [spa::pod::Pod::from_bytes(&values).unwrap()];

    stream
        .connect(
            spa::utils::Direction::Output,
            None,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::RT_PROCESS,
            &mut params,
        )
        .map_err(|e| e.to_string())?;

    mainloop.run();
    Ok(())
}

pub(crate) fn list_sources() -> Result<Vec<super::AudioSourceInfo>, String> {
    let mainloop = pw::main_loop::MainLoopBox::new(None).map_err(|e| e.to_string())?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None).map_err(|e| e.to_string())?;
    let core = context.connect(None).map_err(|e| e.to_string())?;
    let registry = core.get_registry().map_err(|e| e.to_string())?;

    let sources = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(Cell::new(false));
    let main_loop_ptr = mainloop.as_raw_ptr();

    let sources_for_global = sources.clone();
    let _listener_reg = registry
        .add_listener_local()
        .global(move |global| {
            if global.type_ != ObjectType::Node {
                return;
            }
            let Some(props) = global.props else { return };

            let kind = match props.get("media.class") {
                Some("Audio/Source") | Some("Audio/Source/Virtual") => super::AudioSourceKind::Mic,
                Some("Audio/Sink") => super::AudioSourceKind::System,
                _ => return,
            };

            let Some(node_name) = props.get(*pw::keys::NODE_NAME) else {
                return;
            };
            let display_name = props
                .get(*pw::keys::NODE_DESCRIPTION)
                .or_else(|| props.get(*pw::keys::NODE_NICK))
                .unwrap_or(node_name);

            sources_for_global.borrow_mut().push(super::AudioSourceInfo {
                id: node_name.to_string(),
                name: display_name.to_string(),
                kind,
            });
        })
        .register();

    let pending = core.sync(0).map_err(|e| e.to_string())?;
    let done_for_core = done.clone();
    let _listener_core = core
        .add_listener_local()
        .done(move |id, seq| {
            if id == pw::core::PW_ID_CORE && seq == pending {
                done_for_core.set(true);
                unsafe { pw::sys::pw_main_loop_quit(main_loop_ptr) };
            }
        })
        .register();

    while !done.get() {
        mainloop.run();
    }

    drop(_listener_reg);
    drop(_listener_core);

    Ok(Rc::try_unwrap(sources).map(RefCell::into_inner).unwrap_or_default())
}
