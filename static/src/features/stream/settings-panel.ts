import { apiCall } from "@/shared/api";
import { byId } from "@/shared/dom-helpers";
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

    byId<HTMLInputElement>("streamBitrate")!.value = String(settings.bitrate);
    byId<HTMLInputElement>("streamResolution")!.value = String(settings.resolution_percentage);
    if (settings.max_fps) {
        maxFps = settings.max_fps;
        byId<HTMLInputElement>("streamFPS")!.max = String(maxFps);
    }
    byId<HTMLInputElement>("streamFPS")!.value = String(settings.target_fps);

    const bitrateVal = settings.bitrate;
    byId("bitrateValue")!.textContent = formatBitrateLabel(bitrateVal);

    const resText = formatResolutionLabel(settings.resolution_percentage);
    byId("resolutionValue")!.textContent = resText;

    byId("fpsValue")!.textContent = `(Target: ${settings.target_fps} FPS)`;

    if (settings.encoder_type) {
        byId("encoderTypeLabel")!.textContent = settings.encoder_type;
    }
    if (settings.encoder_property_constraints) {
        setEncoderPropertyConstraints(settings.encoder_property_constraints);
    }
    if (settings.encoder_properties) {
        setEncoderProperties(settings.encoder_properties);
    }
}

function formatBitrateLabel(bitrate: number): string {
    return bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)} Mbps` : `${bitrate} kbps`;
}

function formatResolutionLabel(pct: number): string {
    const { width, height } = getNativeDimensions();
    const w = width || 1920;
    const h = height || 1080;
    return pct === 100 ? "100% (Native)" : `${pct}% (${Math.round((w * pct) / 100)} x ${Math.round((h * pct) / 100)})`;
}

function updateSliderLabels(): void {
    const bitrate = parseInt(byId<HTMLInputElement>("streamBitrate")!.value, 10);
    const resolution = parseInt(byId<HTMLInputElement>("streamResolution")!.value, 10);
    const fps = parseInt(byId<HTMLInputElement>("streamFPS")!.value, 10);
    byId("bitrateValue")!.textContent = formatBitrateLabel(bitrate);
    byId("resolutionValue")!.textContent = formatResolutionLabel(resolution);
    byId("fpsValue")!.textContent = `(Target: ${fps} FPS)`;
}

async function updateStreamSettings(includeEncoderProps = false): Promise<void> {
    const bitrate = parseInt(byId<HTMLInputElement>("streamBitrate")!.value, 10);
    const resolutionPercentage = parseInt(byId<HTMLInputElement>("streamResolution")!.value, 10);
    const fps = parseInt(byId<HTMLInputElement>("streamFPS")!.value, 10);

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
    byId<HTMLInputElement>("streamFPS")!.value = String(maxFps);
    byId("fpsValue")!.textContent = `${maxFps} FPS`;
    void updateStreamSettings();
}

export function initSettingsPanel(): void {
    for (const id of ["streamBitrate", "streamResolution", "streamFPS"]) {
        byId(id)!.addEventListener("input", updateSliderLabels);
        byId(id)!.addEventListener("change", () => void updateStreamSettings());
    }
    byId("autoFpsButton")!.addEventListener("click", setAutoFPS);
}

// Front-loaded like the rest of the advanced-settings panel, so it works regardless of when initializeStream() runs.
document.addEventListener("DOMContentLoaded", () => {
    const applyBtn = byId("applyEncoderProps");
    if (applyBtn) {
        applyBtn.addEventListener("click", () => {
            void updateStreamSettings(true);
        });
    }
});

export { updateStreamSettings, updateSliderLabels, setAutoFPS };
