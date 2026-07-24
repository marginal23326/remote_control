use strum::IntoStaticStr;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, IntoStaticStr, TS)]
#[strum(serialize_all = "snake_case")]
#[ts(export, export_to = "bindings.ts", rename_all = "snake_case")]
pub enum ServerEvent {
    AuthStatus,
    AuthError,

    ShellOutput,
    ShellCreated,
    ShellError,
    ShellClosed,
    AvailableShells,

    TaskList,

    AudioSources,
    AudioSourcesError,
    ServerAudioFormat,
    ServerAudioData,
    ServerAudioError,
    ClientAudioError,

    StreamError,
    WebrtcOffer,
    WebrtcRemoteIce,
    ActiveWindow,

    CameraList,
    CameraWebrtcOffer,
    CameraWebrtcRemoteIce,
    CameraStreamError,
}

impl ServerEvent {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Clone, Copy, Debug, IntoStaticStr, TS)]
#[strum(serialize_all = "snake_case")]
#[ts(export, export_to = "bindings.ts", rename_all = "snake_case")]
pub enum ClientEvent {
    MouseEvent,
    KeyboardEvent,

    ShellCreate,
    ShellInput,
    ShellResize,
    ShellClose,
    ListShells,

    TaskPollStart,
    TaskPollStop,

    ListAudioSources,
    StartServerAudio,
    StopServerAudio,
    StartClientAudio,
    StopClientAudio,
    ClientAudioData,

    StartStream,
    WebrtcAnswer,
    WebrtcIceCandidate,

    ListCameras,
    StartCameraStream,
    StopCameraStream,
    CameraWebrtcAnswer,
    CameraWebrtcIceCandidate,
}

impl ClientEvent {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}
