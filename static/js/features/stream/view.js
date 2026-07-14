import { LoadingButton } from "@/shared/feedback.js";

const STREAM_ICON_PLAY = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 5L19 12L7 19Z"></path></svg>`;
const STREAM_ICON_STOP = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" stroke-width="2"></rect></svg>`;

const streamUI = {
    container: document.getElementById("streamContainer"),
    status: document.getElementById("streamStatus"),
    view: document.getElementById("streamView"),
    screenshotView: null,
    nativeWidth: null,
    nativeHeight: null,
    fpsCounter: document.getElementById("currentFPS"),
    activeWindowText: document.getElementById("activeWindow"),
    frameTimes: [],

    show() {
        document.getElementById("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
        this.view.classList.remove("opacity-0");

        this.status.classList.remove("hidden");
        this.status.classList.add("inline-flex");
    },

    hide() {
        document.getElementById("streamOverlay")?.classList.remove("opacity-0", "pointer-events-none");
        this.view.classList.add("opacity-0");

        this.status.classList.remove("inline-flex");
        this.status.classList.add("hidden");
    },

    startFpsCounter() {
        this.stopFpsCounter();
        const frameTimes = this.frameTimes;
        const fpsCounter = this.fpsCounter;
        const video = this.view;

        let rafId;

        function onFrame(now, _metadata) {
            frameTimes.push(now);
            while (frameTimes.length > 0 && frameTimes[0] <= now - 1000) {
                frameTimes.shift();
            }
            fpsCounter.textContent = frameTimes.length;
            rafId = video.requestVideoFrameCallback(onFrame);
        }

        rafId = video.requestVideoFrameCallback(onFrame);
        this._stopFpsCounter = () => video.cancelVideoFrameCallback(rafId);
    },

    stopFpsCounter() {
        if (this._stopFpsCounter) {
            this._stopFpsCounter();
            this._stopFpsCounter = null;
        }
    },

    updateMeta(data) {
        if (Object.prototype.hasOwnProperty.call(data, "win")) {
            this.activeWindowText.textContent = `Active Window: ${data.win || "Unknown"}`;
        }
    },

    clear() {
        this.stopFpsCounter();
        this.fpsCounter.textContent = "0";
        this.frameTimes = [];
        if (this.view.srcObject) {
            this.view.srcObject.getTracks().forEach((t) => t.stop());
            this.view.srcObject = null;
        }
    },

    initScreenshotView() {
        if (!this.screenshotView) {
            this.screenshotView = document.createElement("img");
            this.screenshotView.className =
                "absolute inset-0 w-full h-full object-contain object-center pointer-events-auto hidden z-10 bg-black";
            this.view.parentNode.insertBefore(this.screenshotView, this.view.nextSibling);
        }
    },

    displayScreenshot(url) {
        this.initScreenshotView();
        this.screenshotView.src = url;
        this.screenshotView.classList.remove("hidden");
        this.view.classList.add("hidden");

        document.getElementById("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
    },

    hideScreenshot() {
        if (this.screenshotView) {
            this.screenshotView.classList.add("hidden");
        }
        this.view.classList.remove("hidden");
    },
};

function isCursorCaptureEnabled() {
    const checkbox = document.getElementById("showCursorToggle");
    return checkbox ? checkbox.checked : true;
}

function setStreamToggleUI(active) {
    const btn = document.getElementById("toggleStream");
    if (!btn) return;
    btn.innerHTML = active ? STREAM_ICON_STOP : STREAM_ICON_PLAY;
    btn.title = active ? "Stop Stream (Space)" : "Start Stream (Space)";
    btn.classList.toggle("hover:text-red-400", active);
    btn.classList.toggle("hover:text-zinc-100", !active);
}

// Lazily-created loading spinner for the toggle-stream button.
let startButtonLoader = null;

function getStartButtonLoader() {
    const btn = document.getElementById("toggleStream");
    if (btn && !startButtonLoader) {
        startButtonLoader = new LoadingButton(btn, "");
    }
    return startButtonLoader;
}

function stopStreamStartLoading() {
    startButtonLoader?.stopLoading();
}

export { streamUI, isCursorCaptureEnabled, setStreamToggleUI, getStartButtonLoader, stopStreamStartLoading };
