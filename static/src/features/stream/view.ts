import { LoadingButton } from "@/shared/feedback";

const STREAM_ICON_PLAY = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 5L19 12L7 19Z"></path></svg>`;
const STREAM_ICON_STOP = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" stroke-width="2"></rect></svg>`;

interface StreamUI {
    container: HTMLElement;
    status: HTMLElement;
    view: HTMLVideoElement;
    screenshotView: HTMLImageElement | null;
    nativeWidth: number | null;
    nativeHeight: number | null;
    fpsCounter: HTMLElement;
    activeWindowText: HTMLElement;
    frameTimes: number[];

    show(): void;
    hide(): void;
    startFpsCounter(): void;
    stopFpsCounter(): void;
    updateMeta(data: { win?: string }): void;
    clear(): void;
    initScreenshotView(): void;
    displayScreenshot(url: string): void;
    hideScreenshot(): void;
}

let cancelFpsCounter: (() => void) | null = null;

export const streamUI: StreamUI = {
    activeWindowText: document.getElementById("activeWindow")!,
    clear() {
        this.stopFpsCounter();
        this.fpsCounter.textContent = "0";
        this.frameTimes = [];
        if (this.view.srcObject) {
            (this.view.srcObject as MediaStream).getTracks().forEach((t) => {
                t.stop();
            });
            this.view.srcObject = null;
        }
    },
    container: document.getElementById("streamContainer")!,
    displayScreenshot(url) {
        this.initScreenshotView();
        this.screenshotView!.src = url;
        this.screenshotView!.classList.remove("hidden");
        this.view.classList.add("hidden");

        document.getElementById("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
    },
    fpsCounter: document.getElementById("currentFPS")!,
    frameTimes: [],
    hide() {
        document.getElementById("streamOverlay")?.classList.remove("opacity-0", "pointer-events-none");
        this.view.classList.add("opacity-0");

        this.status.classList.remove("inline-flex");
        this.status.classList.add("hidden");
    },
    hideScreenshot() {
        if (this.screenshotView) {
            this.screenshotView.classList.add("hidden");
        }
        this.view.classList.remove("hidden");
    },
    initScreenshotView() {
        if (!this.screenshotView) {
            this.screenshotView = document.createElement("img");
            this.screenshotView.className =
                "absolute inset-0 w-full h-full object-contain object-center pointer-events-auto hidden z-10 bg-black";
            this.view.parentNode!.insertBefore(this.screenshotView, this.view.nextSibling);
        }
    },
    nativeHeight: null,
    nativeWidth: null,
    screenshotView: null,
    show() {
        document.getElementById("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
        this.view.classList.remove("opacity-0");

        this.status.classList.remove("hidden");
        this.status.classList.add("inline-flex");
    },
    startFpsCounter() {
        this.stopFpsCounter();
        const frameTimes = this.frameTimes;
        const fpsCounter = this.fpsCounter;
        const video = this.view;

        let rafId: number;

        function onFrame(now: number, _metadata: VideoFrameCallbackMetadata) {
            frameTimes.push(now);
            while (frameTimes.length > 0 && frameTimes[0]! <= now - 1000) {
                frameTimes.shift();
            }
            fpsCounter.textContent = String(frameTimes.length);
            rafId = video.requestVideoFrameCallback(onFrame);
        }

        rafId = video.requestVideoFrameCallback(onFrame);
        cancelFpsCounter = () => {
            video.cancelVideoFrameCallback(rafId);
        };
    },
    status: document.getElementById("streamStatus")!,
    stopFpsCounter() {
        if (cancelFpsCounter) {
            cancelFpsCounter();
            cancelFpsCounter = null;
        }
    },
    updateMeta(data) {
        if (Object.prototype.hasOwnProperty.call(data, "win")) {
            this.activeWindowText.textContent = `Active Window: ${data.win || "Unknown"}`;
        }
    },
    view: document.getElementById("streamView") as HTMLVideoElement,
};

function isCursorCaptureEnabled(): boolean {
    const checkbox = document.getElementById("showCursorToggle") as HTMLInputElement | null;
    return checkbox ? checkbox.checked : true;
}

function setStreamToggleUI(active: boolean): void {
    const btn = document.getElementById("toggleStream");
    if (!btn) return;
    btn.innerHTML = active ? STREAM_ICON_STOP : STREAM_ICON_PLAY;
    btn.title = active ? "Stop Stream (Space)" : "Start Stream (Space)";
    btn.classList.toggle("hover:text-red-400", active);
    btn.classList.toggle("hover:text-zinc-100", !active);
}

// Lazily-created loading spinner for the toggle-stream button.
let startButtonLoader: LoadingButton | null = null;

function getStartButtonLoader(): LoadingButton | null {
    const btn = document.getElementById("toggleStream") as HTMLButtonElement | null;
    if (btn && !startButtonLoader) {
        startButtonLoader = new LoadingButton(btn, "");
    }
    return startButtonLoader;
}

export { isCursorCaptureEnabled, setStreamToggleUI, getStartButtonLoader };
