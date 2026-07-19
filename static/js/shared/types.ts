import type {
    AudioSourceInfo,
    CameraDeviceInfo,
    CurrentSettingsResponse,
    DriveEntry,
    EncoderPropertyConstraint,
    FileEntry,
    ProcessDTO as ProcessInfo,
    ProcessDetailsDTO as ProcessDetails,
    StreamSettingsDTO,
    SystemInfoDTO as SystemInfo,
} from "@/generated/bindings.ts";

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

export type { SystemInfo };

export type { EncoderPropertyConstraint };

export type StreamSettings = Omit<CurrentSettingsResponse, "encoder_properties" | "encoder_property_constraints"> & {
    encoder_properties: Record<string, string>;
    encoder_property_constraints: Record<string, EncoderPropertyConstraint>;
};

export type UpdateStreamSettingsPayload = Omit<StreamSettingsDTO, "encoder_properties"> & {
    encoder_properties?: Record<string, string>;
};

export type { ProcessInfo };
export type { ProcessDetails };

export interface ProcessDetailsResponse {
    status: "success";
    data: ProcessDetails;
}

export type { AudioSourceInfo };

export interface AudioFormat {
    rate: number;
    channels: number;
    format: "int16" | "float32" | (string & {});
}

export type { CameraDeviceInfo };

export interface ApiMessageResponse {
    status: string;
    message?: string;
}
