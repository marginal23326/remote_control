import type {
    AudioFormat,
    AudioSourceInfo,
    AudioStartPayload,
    CameraDeviceInfo,
    KeyboardEventPayload,
    MouseEventPayload,
    ShellCreatePayload,
    ShellInputPayload,
    ShellResizePayload,
    StartCameraStreamPayload,
    StartStreamPayload,
    TaskListPayload,
} from "@/shared/types";

export type { AudioStartPayload, KeyboardEventPayload, MouseEventPayload };

export interface ShellCreatedPayload {
    status: "success";
    session_id: string;
}

export interface ShellOutputPayload {
    session_id: string;
    output: string;
}

export interface ShellClosedPayload {
    session_id: string;
}

export interface AvailableShellsPayload {
    shells: string[];
    default?: string;
}

export interface AudioSourcesPayload {
    sources: AudioSourceInfo[];
}

export interface ActiveWindowPayload {
    title: string;
}

export interface CameraListPayload {
    cameras: CameraDeviceInfo[];
}

export interface IceCandidatePayload {
    sdp_mline_index?: number | null;
    candidate: string;
}

export interface MessagePayload {
    message: string;
}

export type ServerAudioData = ArrayBuffer | ArrayBufferView | number[];

export interface ServerToClientEvents {
    auth_status: (data: { authenticated: boolean }) => void;
    auth_error: (data: MessagePayload) => void;

    shell_output: (data: ShellOutputPayload) => void;
    shell_created: (data: ShellCreatedPayload) => void;
    shell_error: (data: MessagePayload) => void;
    shell_closed: (data: ShellClosedPayload) => void;
    available_shells: (data: AvailableShellsPayload) => void;

    task_list: (data: TaskListPayload) => void;

    audio_sources: (data: AudioSourcesPayload) => void;
    audio_sources_error: (data: MessagePayload) => void;
    server_audio_format: (data: AudioFormat) => void;
    server_audio_data: (data: ServerAudioData) => void;
    server_audio_error: (data: MessagePayload) => void;
    client_audio_error: (data: MessagePayload) => void;

    stream_error: (data: MessagePayload) => void;
    webrtc_offer: (sdp: string) => void;
    webrtc_remote_ice: (data: IceCandidatePayload) => void;
    active_window: (data: ActiveWindowPayload) => void;

    camera_list: (data: CameraListPayload) => void;
    camera_webrtc_offer: (sdp: string) => void;
    camera_webrtc_remote_ice: (data: IceCandidatePayload) => void;
    camera_stream_error: (data: MessagePayload) => void;
}

export interface ClientToServerEvents {
    mouse_event: (data: MouseEventPayload) => void;
    keyboard_event: (data: KeyboardEventPayload) => void;

    shell_create: (data: ShellCreatePayload) => void;
    shell_input: (data: ShellInputPayload) => void;
    shell_resize: (data: ShellResizePayload) => void;
    shell_close: () => void;
    list_shells: () => void;

    task_poll_start: () => void;
    task_poll_stop: () => void;

    list_audio_sources: () => void;
    start_server_audio: (data: AudioStartPayload) => void;
    stop_server_audio: () => void;
    start_client_audio: (data: AudioStartPayload) => void;
    stop_client_audio: () => void;
    client_audio_data: (data: ArrayBuffer) => void;

    start_stream: (data: StartStreamPayload) => void;

    webrtc_answer: (sdp: string) => void;
    webrtc_ice_candidate: (data: IceCandidatePayload) => void;

    list_cameras: () => void;
    start_camera_stream: (data: StartCameraStreamPayload) => void;
    stop_camera_stream: () => void;

    camera_webrtc_answer: (sdp: string) => void;
    camera_webrtc_ice_candidate: (data: IceCandidatePayload) => void;
}
