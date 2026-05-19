use std::fs;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::process;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use ashpd::desktop::{
    Session,
    remote_desktop::{
        Axis, DeviceType, KeyState, NotifyKeyboardKeysymOptions, NotifyPointerAxisDiscreteOptions,
        NotifyPointerAxisOptions, NotifyPointerButtonOptions, NotifyPointerMotionAbsoluteOptions,
        RemoteDesktop, SelectDevicesOptions,
    },
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream},
};
use ashpd::enumflags2::BitFlags;
use crossbeam_channel::{Receiver, Sender, TrySendError};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use pipewire as pw;
use pw::{properties::properties, spa};
use tokio::sync::Mutex as AsyncMutex;
use zbus::{Connection, MatchRule, MessageStream, Proxy, message::Type as DbusMessageType};

use super::{FrameRateLimiter, RawFrame, StreamSettings};

static PORTAL_SESSION: Lazy<Arc<PortalSessionManager>> =
    Lazy::new(|| Arc::new(PortalSessionManager::new()));

pub(crate) fn portal_session() -> Arc<PortalSessionManager> {
    PORTAL_SESSION.clone()
}

pub(crate) fn get_max_fps() -> u64 {
    let out = process::Command::new("wayland-info").output().ok();
    if let Some(out) = out {
        if let Ok(s) = std::str::from_utf8(&out.stdout) {
            let hz = s
                .lines()
                .filter_map(|line| line.split_once("refresh:"))
                .filter_map(|(_, rest)| {
                    let hz_str = rest.trim_start().split_whitespace().next()?;
                    hz_str.parse::<f64>().ok()
                })
                .fold(0.0, f64::max);
            if hz > 0.0 {
                return hz.round() as u64;
            }
        }
    }
    60
}

pub(crate) fn run_pipewire_capture(
    node_id: u32,
    fd: OwnedFd,
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    settings: Arc<Mutex<StreamSettings>>,
    is_running: Arc<AtomicBool>,
    native_size: Arc<Mutex<(i32, i32)>>,
) -> Result<()> {
    pw::init();

    let mainloop = pw::main_loop::MainLoopBox::new(None)?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)?;
    let core = context.connect_fd(fd, None)?;

    struct PipeWireUserData {
        format: spa::param::video::VideoInfoRaw,
        work_tx: Sender<RawFrame>,
        recycle_rx: Receiver<Vec<u8>>,
        is_running: Arc<AtomicBool>,
        native_size: Arc<Mutex<(i32, i32)>>,
        main_loop: *mut pw::sys::pw_main_loop,
        settings: Arc<Mutex<StreamSettings>>,
        limiter: FrameRateLimiter,
    }

    let data = PipeWireUserData {
        format: Default::default(),
        work_tx,
        recycle_rx,
        is_running,
        native_size,
        main_loop: mainloop.as_raw_ptr(),
        settings,
        limiter: FrameRateLimiter::new(),
    };

    let stream = pw::stream::StreamBox::new(
        &core,
        "remote-control-screen",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
            *pw::keys::NODE_FORCE_QUANTUM => "512",
        },
    )?;

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else { return };
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }

            let Ok((media_type, media_subtype)) = pw::spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != pw::spa::param::format::MediaType::Video
                || media_subtype != pw::spa::param::format::MediaSubtype::Raw
            {
                return;
            }

            if user_data.format.parse(param).is_ok() {
                let size = user_data.format.size();
                *user_data.native_size.lock().unwrap() = (size.width as i32, size.height as i32);

                let fr = user_data.format.framerate();
                if fr.denom > 0 {
                    if let Some(fps_val) = fr.num.checked_div(fr.denom).filter(|&v| v > 0) {
                        user_data.settings.lock().unwrap().max_fps = fps_val as u64;
                    }
                } else {
                    user_data.settings.lock().unwrap().max_fps = fr.num.max(1) as u64;
                }
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

            let (target_fps, max_fps) = {
                let s = user_data.settings.lock().unwrap();
                (s.target_fps, s.max_fps)
            };
            if !user_data.limiter.should_process(target_fps, max_fps) {
                return;
            }

            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };

            let size = user_data.format.size();
            let width = size.width;
            let height = size.height;
            if width == 0 || height == 0 {
                return;
            }

            let chunk = data.chunk();
            let offset = chunk.offset() as usize;
            let frame_size = chunk.size() as usize;
            let stride = if chunk.stride() > 0 {
                chunk.stride() as usize
            } else {
                (width * 4) as usize
            };
            let format = user_data.format.format();

            let Some(bytes) = data.data() else {
                return;
            };
            if offset >= bytes.len() {
                return;
            }

            let available = bytes.len().saturating_sub(offset).min(frame_size);
            let source = &bytes[offset..offset + available];
            let mut output = user_data.recycle_rx.try_recv().unwrap_or_default();
            if normalize_to_bgra(source, width, height, stride, format, &mut output).is_err() {
                return;
            }

            let raw = RawFrame {
                buffer: output,
                width,
                height,
            };
            if let Err(TrySendError::Full(returned)) = user_data.work_tx.try_send(raw) {
                let _ = user_data.recycle_rx.try_recv().unwrap_or(returned.buffer);
            }
        })
        .register()?;

    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::RGBA,
            pw::spa::param::video::VideoFormat::RGBx
        )
    );
    let values = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .context("Failed to serialize PipeWire format parameters")?
    .0
    .into_inner();
    let mut params = [spa::pod::Pod::from_bytes(&values)
        .ok_or_else(|| anyhow::anyhow!("Failed to parse Pod from bytes"))?];

    stream.connect(
        spa::utils::Direction::Input,
        Some(node_id),
        pw::stream::StreamFlags::AUTOCONNECT
            | pw::stream::StreamFlags::MAP_BUFFERS
            | pw::stream::StreamFlags::DRIVER,
        &mut params,
    )?;

    mainloop.run();
    Ok(())
}

fn normalize_to_bgra(
    source: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    format: spa::param::video::VideoFormat,
    output: &mut Vec<u8>,
) -> Result<()> {
    let width = width as usize;
    let height = height as usize;
    let row_bytes = width * 4;
    output.resize(row_bytes * height, 0);

    for y in 0..height {
        let src_start = y * stride;
        let src_end = src_start + row_bytes;
        let dst_start = y * row_bytes;
        if src_end > source.len() {
            return Err(anyhow!("PipeWire frame buffer was smaller than expected"));
        }

        let src = &source[src_start..src_end];
        let dst = &mut output[dst_start..dst_start + row_bytes];

        if format == spa::param::video::VideoFormat::BGRA {
            dst.copy_from_slice(src);
        } else if format == spa::param::video::VideoFormat::BGRx {
            for (p_in, p_out) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                p_out[0] = p_in[0];
                p_out[1] = p_in[1];
                p_out[2] = p_in[2];
                p_out[3] = 255;
            }
        } else if format == spa::param::video::VideoFormat::RGBA
            || format == spa::param::video::VideoFormat::RGBx
        {
            for (p_in, p_out) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                p_out[0] = p_in[2];
                p_out[1] = p_in[1];
                p_out[2] = p_in[0];
                p_out[3] = if format == spa::param::video::VideoFormat::RGBA {
                    p_in[3]
                } else {
                    255
                };
            }
        } else {
            return Err(anyhow!("Unsupported PipeWire video format: {format:?}"));
        }
    }
    Ok(())
}

fn stream_info(stream: &Stream) -> PortalStreamInfo {
    let size = stream.size().unwrap_or((0, 0));
    PortalStreamInfo {
        node_id: stream.pipe_wire_node_id(),
        size,
    }
}

static ACTIVE_WINDOW_TITLE: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

#[allow(dead_code)]
pub(crate) fn get_active_window_title() -> String {
    ACTIVE_WINDOW_TITLE.lock().unwrap().clone()
}

pub(crate) fn run_active_window_title_poll(is_running: Arc<AtomicBool>) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    while is_running.load(Ordering::SeqCst) {
        let title = runtime
            .block_on(query_active_window_title())
            .unwrap_or_default();
        *ACTIVE_WINDOW_TITLE.lock().unwrap() = title;
        thread::sleep(Duration::from_secs(1));
    }
    ACTIVE_WINDOW_TITLE.lock().unwrap().clear();
}

async fn query_active_window_title() -> Result<String> {
    let connection = Connection::session().await?;
    let unique_name = connection
        .unique_name()
        .ok_or_else(|| anyhow!("DBus connection has no unique name"))?
        .to_string();

    let rule = MatchRule::builder()
        .msg_type(DbusMessageType::MethodCall)
        .destination(unique_name.as_str())?
        .path("/")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &connection, Some(4)).await?;

    tokio::time::sleep(Duration::from_millis(200)).await;

    let script_name = format!("remote-control-active-window-{}", unique_suffix());
    let script_path = std::env::temp_dir().join(format!("{script_name}.js"));
    fs::write(&script_path, active_window_script(&unique_name))?;

    let scripting = Proxy::new(
        &connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )
    .await?;
    let script_id: i32 = scripting
        .call(
            "loadScript",
            &(
                script_path.to_string_lossy().into_owned().as_str(),
                script_name.as_str(),
            ),
        )
        .await?;

    if script_id < 0 {
        let _ = fs::remove_file(&script_path);
        return Err(anyhow!("KWin refused to load active-window script"));
    }

    let script = Proxy::new(
        &connection,
        "org.kde.KWin",
        format!("/Scripting/Script{script_id}"),
        "org.kde.kwin.Script",
    )
    .await?;
    let _: () = script.call("run", &()).await?;
    let _ = fs::remove_file(&script_path);
    let _: () = script.call("stop", &()).await?;

    let title = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = stream.next().await {
            let message = message?;
            if message.header().member().map(|m| m.as_str()) != Some("result") {
                continue;
            }
            return Ok(message.body().deserialize::<String>()?);
        }
        Ok::<_, anyhow::Error>(String::new())
    })
    .await
    .context("Timed out waiting for KWin active-window title")?;

    let _: Result<bool, _> = scripting.call("unloadScript", &script_name).await;
    title
}

fn active_window_script(dbus_name: &str) -> String {
    format!(
        "let window = workspace.activeWindow;\nlet title = window ? window.caption : \"\";\ncallDBus(\"{dbus_name}\", \"/\", \"\", \"result\", title.toString());\n"
    )
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
        ^ process::id() as u128
}

#[derive(Clone, Copy)]
struct PortalStreamInfo {
    node_id: u32,
    size: (i32, i32),
}

struct PortalSession {
    remote_desktop: RemoteDesktop,
    screencast: Screencast,
    session: Session<RemoteDesktop>,
    stream: PortalStreamInfo,
}

pub(crate) struct PortalSessionManager {
    state: AsyncMutex<Option<PortalSession>>,
}

impl PortalSessionManager {
    fn new() -> Self {
        Self {
            state: AsyncMutex::new(None),
        }
    }

    async fn ensure_started(&self) -> Result<PortalStreamInfo> {
        let mut state = self.state.lock().await;
        if let Some(session) = state.as_ref() {
            return Ok(session.stream);
        }

        let restore_token = read_restore_token();
        let session = match create_portal_session(restore_token.as_deref()).await {
            Ok(session) => session,
            Err(err) if restore_token.is_some() => {
                tracing::warn!("Portal restore token failed: {err:#}");
                create_portal_session(None).await?
            }
            Err(err) => return Err(err),
        };
        let stream = session.stream;
        *state = Some(session);
        Ok(stream)
    }

    pub(crate) async fn open_pipewire_remote(&self) -> Result<(u32, (i32, i32), OwnedFd)> {
        let info = self.ensure_started().await?;
        let state = self.state.lock().await;
        let session = state
            .as_ref()
            .ok_or_else(|| anyhow!("Portal session uninitialized"))?;
        let fd = session
            .screencast
            .open_pipe_wire_remote(&session.session, Default::default())
            .await?;
        Ok((info.node_id, info.size, fd))
    }

    pub(crate) async fn notify_pointer_motion_absolute(&self, x: f64, y: f64) -> Result<()> {
        self.ensure_started().await?;
        let state = self.state.lock().await;
        let session = state.as_ref().unwrap();
        session
            .remote_desktop
            .notify_pointer_motion_absolute(
                &session.session,
                session.stream.node_id,
                x,
                y,
                NotifyPointerMotionAbsoluteOptions::default(),
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn notify_pointer_button(&self, button: i32, state: KeyState) -> Result<()> {
        self.ensure_started().await?;
        let guard = self.state.lock().await;
        let session = guard.as_ref().unwrap();
        session
            .remote_desktop
            .notify_pointer_button(
                &session.session,
                button,
                state,
                NotifyPointerButtonOptions::default(),
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn notify_pointer_axis(&self, dx: i32, dy: i32) -> Result<()> {
        self.ensure_started().await?;
        let guard = self.state.lock().await;
        let session = guard.as_ref().unwrap();

        if dx != 0 {
            session
                .remote_desktop
                .notify_pointer_axis_discrete(
                    &session.session,
                    Axis::Horizontal,
                    dx,
                    NotifyPointerAxisDiscreteOptions::default(),
                )
                .await?;
        }
        if dy != 0 {
            session
                .remote_desktop
                .notify_pointer_axis_discrete(
                    &session.session,
                    Axis::Vertical,
                    dy,
                    NotifyPointerAxisDiscreteOptions::default(),
                )
                .await?;
        }
        session
            .remote_desktop
            .notify_pointer_axis(
                &session.session,
                dx as f64,
                dy as f64,
                NotifyPointerAxisOptions::default().set_finish(true),
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn notify_keyboard_keysym(&self, keysym: i32, state: KeyState) -> Result<()> {
        self.ensure_started().await?;
        let guard = self.state.lock().await;
        let session = guard.as_ref().unwrap();
        session
            .remote_desktop
            .notify_keyboard_keysym(
                &session.session,
                keysym,
                state,
                NotifyKeyboardKeysymOptions::default(),
            )
            .await?;
        Ok(())
    }
}

async fn create_portal_session(restore_token: Option<&str>) -> Result<PortalSession> {
    let remote_desktop = RemoteDesktop::new().await?;
    let screencast = Screencast::new().await?;
    let session = remote_desktop.create_session(Default::default()).await?;

    remote_desktop
        .select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
                .set_restore_token(restore_token),
        )
        .await?
        .response()?;
    screencast
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_sources(BitFlags::from_flag(SourceType::Monitor))
                .set_multiple(false)
                .set_cursor_mode(CursorMode::Embedded)
                .set_restore_token(restore_token),
        )
        .await?
        .response()?;

    let selected = remote_desktop
        .start(&session, None, Default::default())
        .await?
        .response()?;
    if let Some(token) = selected.restore_token() {
        write_restore_token(token);
    }

    let selected_stream = selected
        .streams()
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("Portal session did not return a PipeWire stream"))?;
    let stream = stream_info(&selected_stream);

    Ok(PortalSession {
        remote_desktop,
        screencast,
        session,
        stream,
    })
}

fn restore_token_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
        })?;
    Some(base.join("remote-control").join("portal-restore-token"))
}

fn read_restore_token() -> Option<String> {
    fs::read_to_string(restore_token_path()?)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn write_restore_token(token: &str) {
    if let Some(path) = restore_token_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, token);
    }
}
