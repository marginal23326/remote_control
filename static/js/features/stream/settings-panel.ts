import { apiCall } from "@/shared/api";
import { showNotification } from "@/shared/feedback";
import { setStunServer } from "./stream-state";
import { getNativeDimensions, setNativeDimensions } from "./geometry";
import { readEncoderPropsFromDOM, setEncoderProperties, setEncoderPropertyConstraints } from "./encoder-properties";
import type { StreamSettings, UpdateStreamSettingsPayload } from "@/shared/types";

let maxFps = 60;

export function updateSettingsDisplay(settings: StreamSettings | null | undefined): void {
    if (!settings) return;

    if (settings.stun_server !== undefined) {
        setStunServer(settings.stun_server);
    }

    if (settings.native_width !== undefined) {
        setNativeDimensions(settings.native_width, settings.native_height);
    }

    (document.getElementById("streamBitrate") as HTMLInputElement).value = String(settings.bitrate);
    (document.getElementById("streamResolution") as HTMLInputElement).value = String(settings.resolution_percentage);
    if (settings.max_fps) {
        maxFps = settings.max_fps;
        (document.getElementById("streamFPS") as HTMLInputElement).max = String(maxFps);
    }
    (document.getElementById("streamFPS") as HTMLInputElement).value = String(settings.target_fps);

    const bitrateVal = settings.bitrate;
    document.getElementById("bitrateValue")!.textContent =
        bitrateVal >= 1000 ? `${(bitrateVal / 1000).toFixed(1)} Mbps` : `${bitrateVal} kbps`;

    const resText = formatResolutionLabel(settings.resolution_percentage);
    document.getElementById("resolutionValue")!.textContent = resText;

    document.getElementById("fpsValue")!.textContent = `(Target: ${settings.target_fps} FPS)`;

    if (settings.encoder_type) {
        document.getElementById("encoderTypeLabel")!.textContent = settings.encoder_type;
    }
    if (settings.encoder_property_constraints) {
        setEncoderPropertyConstraints(settings.encoder_property_constraints);
    }
    if (settings.encoder_properties) {
        setEncoderProperties(settings.encoder_properties);
    }
}

function formatResolutionLabel(pct: number): string {
    const { width, height } = getNativeDimensions();
    const w = width || 1920;
    const h = height || 1080;
    return pct === 100 ? "100% (Native)" : `${pct}% (${Math.round((w * pct) / 100)} x ${Math.round((h * pct) / 100)})`;
}

function updateSliderLabels(): void {
    const bitrate = parseInt((document.getElementById("streamBitrate") as HTMLInputElement).value, 10);
    const resolution = parseInt((document.getElementById("streamResolution") as HTMLInputElement).value, 10);
    const fps = parseInt((document.getElementById("streamFPS") as HTMLInputElement).value, 10);
    document.getElementById("bitrateValue")!.textContent =
        bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)} Mbps` : `${bitrate} kbps`;
    document.getElementById("resolutionValue")!.textContent = formatResolutionLabel(resolution);
    document.getElementById("fpsValue")!.textContent = `(Target: ${fps} FPS)`;
}

async function updateStreamSettings(includeEncoderProps = false): Promise<void> {
    const bitrate = parseInt((document.getElementById("streamBitrate") as HTMLInputElement).value, 10);
    const resolutionPercentage = parseInt((document.getElementById("streamResolution") as HTMLInputElement).value, 10);
    const fps = parseInt((document.getElementById("streamFPS") as HTMLInputElement).value, 10);

    const payload: UpdateStreamSettingsPayload = {
        bitrate,
        resolution_percentage: resolutionPercentage,
        target_fps: fps,
    };

    if (includeEncoderProps) {
        const encoderProps = readEncoderPropsFromDOM();
        if (encoderProps === null) return;
        payload.encoder_properties = encoderProps;
    }

    const response = await apiCall<StreamSettings>("/api/stream/settings", "POST", payload);
    if (response.rejected_properties?.length) {
        showNotification(`Invalid encoder properties: ${response.rejected_properties.join(", ")}`, "error");
    }
    updateSettingsDisplay(response);
}

function setAutoFPS(): void {
    (document.getElementById("streamFPS") as HTMLInputElement).value = String(maxFps);
    document.getElementById("fpsValue")!.textContent = `${maxFps} FPS`;
    void updateStreamSettings();
}

export function initSettingsPanel(): void {
    document.getElementById("streamBitrate")!.addEventListener("input", updateSliderLabels);
    document.getElementById("streamBitrate")!.addEventListener("change", () => void updateStreamSettings());
    document.getElementById("streamResolution")!.addEventListener("input", updateSliderLabels);
    document.getElementById("streamResolution")!.addEventListener("change", () => void updateStreamSettings());
    document.getElementById("streamFPS")!.addEventListener("input", updateSliderLabels);
    document.getElementById("streamFPS")!.addEventListener("change", () => void updateStreamSettings());
    document.getElementById("autoFpsButton")!.addEventListener("click", setAutoFPS);
}

// Front-loaded like the rest of the advanced-settings panel, so it works regardless of when initializeStream() runs.
document.addEventListener("DOMContentLoaded", () => {
    const applyBtn = document.getElementById("applyEncoderProps");
    if (applyBtn) {
        applyBtn.addEventListener("click", () => {
            void updateStreamSettings(true);
        });
    }
});

export { updateStreamSettings, updateSliderLabels, setAutoFPS };
