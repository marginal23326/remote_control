import type {
    AudioConfig,
    AudioFormatPayload as AudioFormat,
    AudioSourceInfo,
    CameraDeviceInfo,
    CameraStartConfig as StartCameraStreamPayload,
    CurrentSettingsResponse,
    EncoderPropertyConstraint,
    FileEntry,
    KeyboardEventPayload,
    MouseEventPayload,
    PowerAction,
    ProcessDTO as ProcessInfo,
    ProcessDetailsDTO as ProcessDetails,
    ShellCreateEvent as ShellCreatePayload,
    ShellInputEvent as ShellInputPayload,
    ShellResizeEvent as ShellResizePayload,
    StartStreamConfig as StartStreamPayload,
    StreamSettingsDTO,
    SystemInfoDTO as SystemInfo,
    TaskPayload as TaskListPayload,
} from "@/generated/bindings";

export type FileListItem = Pick<FileEntry, "name" | "path" | "is_dir"> &
    Partial<Pick<FileEntry, "size" | "last_modified">>;

export interface RenderableFileItem extends FileListItem {
    _safePath: string;
    _safeName: string;
    _nameLower: string;
    _formattedSize: string;
    _formattedDate: string;
}

export interface UploadResponse {
    status: string;
    message?: string;
    count: number;
}

export type AudioStartPayload = AudioConfig;

export type StreamSettings = Omit<CurrentSettingsResponse, "encoder_properties" | "encoder_property_constraints"> & {
    encoder_properties: Record<string, string>;
    encoder_property_constraints: Record<string, EncoderPropertyConstraint>;
};

export type UpdateStreamSettingsPayload = Omit<StreamSettingsDTO, "encoder_properties"> & {
    encoder_properties?: Record<string, string>;
};

export interface ProcessDetailsResponse {
    status: "success";
    data: ProcessDetails;
}

export type {
    AudioFormat,
    AudioSourceInfo,
    CameraDeviceInfo,
    EncoderPropertyConstraint,
    KeyboardEventPayload,
    MouseEventPayload,
    PowerAction,
    ProcessDetails,
    ProcessInfo,
    ShellCreatePayload,
    ShellInputPayload,
    ShellResizePayload,
    StartCameraStreamPayload,
    StartStreamPayload,
    SystemInfo,
    TaskListPayload,
};

export interface ApiMessageResponse {
    status: string;
    message?: string;
}
