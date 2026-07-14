const captureState = {
    keyboard: false,
    mouse: false,
};

function updateCaptureUI() {
    const anyActive = captureState.keyboard || captureState.mouse;
    const container = document.getElementById("streamContainer");

    if (container) {
        container.classList.toggle("ring-2", anyActive);
        container.classList.toggle("ring-zinc-300/80", anyActive);
        container.classList.toggle("border-zinc-400/60", anyActive);
        container.classList.toggle("border-zinc-800", !anyActive);
    }

    const toggleBtn = (id, active) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle("bg-zinc-200", active);
        btn.classList.toggle("text-zinc-900", active);
        btn.classList.toggle("hover:bg-zinc-800", !active);
        btn.classList.toggle("hover:text-zinc-100", !active);
        btn.classList.toggle("text-zinc-400", !active);
    };

    toggleBtn("keyboardCaptureBtn", captureState.keyboard);
    toggleBtn("mouseCaptureBtn", captureState.mouse);
}

function initializeCaptureToggles() {
    document.getElementById("keyboardCaptureBtn")?.addEventListener("click", (e) => {
        captureState.keyboard = !captureState.keyboard;
        updateCaptureUI();
        e.currentTarget.blur();
    });

    document.getElementById("mouseCaptureBtn")?.addEventListener("click", (e) => {
        captureState.mouse = !captureState.mouse;
        updateCaptureUI();
        e.currentTarget.blur();
    });
}

export { captureState, initializeCaptureToggles };
