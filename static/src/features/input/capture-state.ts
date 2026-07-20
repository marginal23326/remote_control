import { setToggleStyle } from "@/shared/dom-helpers";

export const captureState = {
    keyboard: false,
    mouse: false,
};

function toggleBtn(id: string, active: boolean): void {
    const btn = document.getElementById(id);
    if (!btn) return;
    setToggleStyle(btn, active);
}

function updateCaptureUI(): void {
    const anyActive = captureState.keyboard || captureState.mouse;
    const container = document.getElementById("streamContainer");

    if (container) {
        container.classList.toggle("ring-2", anyActive);
        container.classList.toggle("ring-zinc-300/80", anyActive);
        container.classList.toggle("border-zinc-400/60", anyActive);
        container.classList.toggle("border-zinc-800", !anyActive);
    }

    toggleBtn("keyboardCaptureBtn", captureState.keyboard);
    toggleBtn("mouseCaptureBtn", captureState.mouse);
}

export function initializeCaptureToggles(): void {
    document.getElementById("keyboardCaptureBtn")?.addEventListener("click", (e) => {
        captureState.keyboard = !captureState.keyboard;
        updateCaptureUI();
        (e.currentTarget as HTMLElement).blur();
    });

    document.getElementById("mouseCaptureBtn")?.addEventListener("click", (e) => {
        captureState.mouse = !captureState.mouse;
        updateCaptureUI();
        (e.currentTarget as HTMLElement).blur();
    });
}
