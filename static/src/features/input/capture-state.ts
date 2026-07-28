import { byId, setToggleStyle, toggleClasses } from "@/shared/dom-helpers";

export const captureState = {
    keyboard: false,
    mouse: false,
};

function toggleBtn(id: string, active: boolean): void {
    const btn = byId(id);
    if (!btn) return;
    setToggleStyle(btn, active);
}

function updateCaptureUI(): void {
    const anyActive = captureState.keyboard || captureState.mouse;
    const container = byId("streamContainer");

    if (container) {
        toggleClasses(container, anyActive, ["ring-2", "ring-zinc-300/80", "border-zinc-400/60"], ["border-zinc-800"]);
    }

    toggleBtn("keyboardCaptureBtn", captureState.keyboard);
    toggleBtn("mouseCaptureBtn", captureState.mouse);
}

export function initializeCaptureToggles(): void {
    byId("keyboardCaptureBtn")?.addEventListener("click", (e) => {
        captureState.keyboard = !captureState.keyboard;
        updateCaptureUI();
        (e.currentTarget as HTMLElement).blur();
    });

    byId("mouseCaptureBtn")?.addEventListener("click", (e) => {
        captureState.mouse = !captureState.mouse;
        updateCaptureUI();
        (e.currentTarget as HTMLElement).blur();
    });
}
