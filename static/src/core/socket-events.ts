import type {
    ActiveWindowPayload,
    AudioSourcesPayload,
    AuthStatusPayload,
    AvailableShellsPayload,
    CameraListPayload,
    ClientEvent,
    MessagePayload,
    RemoteIceCandidatePayload,
    ServerEvent,
    ShellClosedPayload,
    ShellCreatedPayload,
    ShellOutputPayload,
} from "@/generated/bindings";
import type {
    AudioFormat,
    AudioStartPayload,
    KeyboardEventPayload,
    MouseButton,
    MouseEventPayload,
    ShellCreatePayload,
    ShellInputPayload,
    ShellResizePayload,
    StartCameraStreamPayload,
    StartStreamPayload,
    TaskListPayload,
} from "@/shared/types";

export type {
    ActiveWindowPayload,
    AudioSourcesPayload,
    AudioStartPayload,
    AuthStatusPayload,
    AvailableShellsPayload,
    CameraListPayload,
    KeyboardEventPayload,
    MessagePayload,
    MouseButton,
    MouseEventPayload,
    RemoteIceCandidatePayload,
    ShellClosedPayload,
    ShellCreatedPayload,
    ShellOutputPayload,
};

export type IceCandidatePayload = Omit<RemoteIceCandidatePayload, "sdp_mline_index"> & {
    sdp_mline_index?: number | null;
};

export type ServerAudioData = ArrayBuffer | ArrayBufferView | number[];

interface ServerEventPayloads {
    auth_status: AuthStatusPayload;
    auth_error: MessagePayload;

    shell_output: ShellOutputPayload;
    shell_created: ShellCreatedPayload;
    shell_error: MessagePayload;
    shell_closed: ShellClosedPayload;
    available_shells: AvailableShellsPayload;

    task_list: TaskListPayload;

    audio_sources: AudioSourcesPayload;
    audio_sources_error: MessagePayload;
    server_audio_format: AudioFormat;
    server_audio_data: ServerAudioData;
    server_audio_error: MessagePayload;
    client_audio_error: MessagePayload;

    webrtc_error: MessagePayload;
    webrtc_offer: string;
    webrtc_remote_ice: RemoteIceCandidatePayload;
    active_window: ActiveWindowPayload;

    camera_list: CameraListPayload;
    camera_webrtc_offer: string;
    camera_webrtc_remote_ice: RemoteIceCandidatePayload;
    camera_webrtc_error: MessagePayload;
}

interface ClientEventPayloads {
    mouse_event: MouseEventPayload;
    keyboard_event: KeyboardEventPayload;

    shell_create: ShellCreatePayload;
    shell_input: ShellInputPayload;
    shell_resize: ShellResizePayload;
    shell_close: void;
    list_shells: void;

    task_poll_start: void;
    task_poll_stop: void;

    list_audio_sources: void;
    start_server_audio: AudioStartPayload;
    stop_server_audio: void;
    start_client_audio: AudioStartPayload;
    stop_client_audio: void;
    client_audio_data: ArrayBuffer;

    start_stream: StartStreamPayload;

    webrtc_answer: string;
    webrtc_ice_candidate: IceCandidatePayload;

    list_cameras: void;
    start_camera_stream: StartCameraStreamPayload;
    stop_camera_stream: void;

    camera_webrtc_answer: string;
    camera_webrtc_ice_candidate: IceCandidatePayload;
}

type EventHandler<T> = [T] extends [void] ? () => void : (data: T) => void;

export type ServerToClientEvents = { [K in ServerEvent]: EventHandler<ServerEventPayloads[K]> };
export type ClientToServerEvents = { [K in ClientEvent]: EventHandler<ClientEventPayloads[K]> };
