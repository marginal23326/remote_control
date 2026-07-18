// Files
export interface FileListItem {
    name: string;
    path: string;
    is_dir: boolean;
    size?: number;
    last_modified?: number | null;
    drive_type?: number;
}

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

// System info
export interface SystemInfo {
    os: string;
    architecture: string;
    processor: string;
    cpu_cores: string;
    cpu_threads: string;
    cpu_base_speed: string;
    cpu_max_speed: string;
    memory: string;
    gpu: string;
    monitors: string;
    disks: string;
    battery: string;
    username: string;
    pc_name: string;
    domain: string;
    hostname: string;
    system_drive: string;
    uptime: string;
    mac_address: string;
    lan_ip: string;
    wan_ip: string;
    asn: string;
    isp: string;
    antivirus: string;
    firewall: string;
    timezone: string;
    country: string;
    disk_total: string;
    disk_used: string;
    disk_free: string;
    active_processes: number;
}

// Stream / encoder settings
export interface EncoderPropertyConstraint {
    value_type: "enum" | "int" | "bool" | "string";
    min?: number;
    max?: number;
    enum_values?: string[];
}

export interface StreamSettings {
    bitrate: number;
    resolution_percentage: number;
    target_fps: number;
    max_fps: number;
    native_width: number;
    native_height: number;
    encoder_type: string;
    encoder_properties: Record<string, string>;
    encoder_property_constraints: Record<string, EncoderPropertyConstraint>;
    rejected_properties?: string[];
    stun_server: string | null;
}

export interface UpdateStreamSettingsPayload {
    bitrate: number;
    resolution_percentage: number;
    target_fps: number;
    encoder_properties?: Record<string, string>;
}

// Tasks / processes
export interface ProcessInfo {
    pid: number;
    name: string;
    cpu_percent: number;
    memory_usage: number;
    ppid?: number | null;
}

export interface ProcessDetails {
    pid: number;
    name: string;
    rss_memory_mb: number;
    exact_memory_mb: number;
}

export interface ProcessDetailsResponse {
    status: "success";
    data: ProcessDetails;
}

// Audio
export interface AudioSourceInfo {
    id: string;
    name: string;
    kind: "mic" | "system" | (string & {});
}

export interface AudioFormat {
    rate: number;
    channels: number;
    format: "int16" | "float32" | (string & {});
}

// Camera
export interface CameraDeviceInfo {
    id: string;
    name: string;
}

// Generic API responses
export interface ApiMessageResponse {
    status: string;
    message?: string;
}
