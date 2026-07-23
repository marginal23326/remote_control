import type {
    AudioConfig,
    AudioSourceInfo,
    CameraDeviceInfo,
    CameraStartConfig as StartCameraStreamPayload,
    CurrentSettingsResponse,
    DriveEntry,
    EncoderPropertyConstraint,
    FileEntry,
    KeyboardEvent as KeyboardEventPayload,
    MouseEvent as MouseEventDTO,
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
    Partial<Pick<FileEntry, "size" | "last_modified">> &
    Partial<Pick<DriveEntry, "drive_type">>;

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

export type MouseEventPayload = Omit<MouseEventDTO, "type" | "button"> & {
    type: "move" | "click" | "scroll";
    button?: "left" | "right" | "middle";
};

export type AudioStartPayload = AudioConfig & { chunk?: number };

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

export interface AudioFormat {
    rate: number;
    channels: number;
    format: "int16" | "float32" | (string & {});
}

export type {
    AudioSourceInfo,
    CameraDeviceInfo,
    EncoderPropertyConstraint,
    KeyboardEventPayload,
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
