import { apiCall } from "@/shared/api";
import { byId, intValue } from "@/shared/dom-helpers";
import { showNotification } from "@/shared/feedback";
import { streamState } from "./stream-state";
import { setNativeDimensions } from "./geometry";
import { readEncoderPropsFromDOM, setEncoderProperties, setEncoderPropertyConstraints } from "./encoder-properties";
import type { StreamSettings, UpdateStreamSettingsPayload } from "@/shared/types";

let maxFps = 60;

const settingsUI = {
    bitrateInput: byId<HTMLInputElement>("streamBitrate")!,
    resolutionInput: byId<HTMLInputElement>("streamResolution")!,
    fpsInput: byId<HTMLInputElement>("streamFPS")!,
    bitrateValue: byId("bitrateValue")!,
    resolutionValue: byId("resolutionValue")!,
    fpsValue: byId("fpsValue")!,
    encoderTypeLabel: byId("encoderTypeLabel")!,
    autoFpsButton: byId("autoFpsButton")!,
};

export function updateSettingsDisplay(settings: StreamSettings | null | undefined): void {
    if (!settings) return;

    if (settings.stun_server !== undefined) {
        streamState.stunServer = settings.stun_server;
    }

    if (settings.native_width !== undefined) {
        setNativeDimensions(settings.native_width, settings.native_height);
    }

    settingsUI.bitrateInput.value = String(settings.bitrate);
    settingsUI.resolutionInput.value = String(settings.resolution_percentage);
    if (settings.max_fps) {
        maxFps = settings.max_fps;
        settingsUI.fpsInput.max = String(maxFps);
    }
    settingsUI.fpsInput.value = String(settings.target_fps);

    const bitrateVal = settings.bitrate;
    settingsUI.bitrateValue.textContent = formatBitrateLabel(bitrateVal);

    const resText = formatResolutionLabel(settings.resolution_percentage);
    settingsUI.resolutionValue.textContent = resText;

    settingsUI.fpsValue.textContent = `(Target: ${settings.target_fps} FPS)`;

    if (settings.encoder_type) {
        settingsUI.encoderTypeLabel.textContent = settings.encoder_type;
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
    const w = streamState.nativeWidth || 1920;
    const h = streamState.nativeHeight || 1080;
    return pct === 100 ? "100% (Native)" : `${pct}% (${Math.round((w * pct) / 100)} x ${Math.round((h * pct) / 100)})`;
}

function updateSliderLabels(): void {
    const bitrate = intValue(settingsUI.bitrateInput.value);
    const resolution = intValue(settingsUI.resolutionInput.value);
    const fps = intValue(settingsUI.fpsInput.value);
    settingsUI.bitrateValue.textContent = formatBitrateLabel(bitrate);
    settingsUI.resolutionValue.textContent = formatResolutionLabel(resolution);
    settingsUI.fpsValue.textContent = `(Target: ${fps} FPS)`;
}

async function updateStreamSettings(includeEncoderProps = false): Promise<void> {
    const bitrate = intValue(settingsUI.bitrateInput.value);
    const resolutionPercentage = intValue(settingsUI.resolutionInput.value);
    const fps = intValue(settingsUI.fpsInput.value);

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
    settingsUI.fpsInput.value = String(maxFps);
    settingsUI.fpsValue.textContent = `${maxFps} FPS`;
    void updateStreamSettings();
}

export function initSettingsPanel(): void {
    for (const input of [settingsUI.bitrateInput, settingsUI.resolutionInput, settingsUI.fpsInput]) {
        input.addEventListener("input", updateSliderLabels);
        input.addEventListener("change", () => void updateStreamSettings());
    }
    settingsUI.autoFpsButton.addEventListener("click", setAutoFPS);
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
