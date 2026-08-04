import { byId, toggleClasses } from "@/shared/dom-helpers";
import { LoadingButton } from "@/shared/feedback";
import { SVG_TEMPLATES } from "@/shared/icons";

interface StreamUIState {
    container: HTMLElement;
    status: HTMLElement;
    view: HTMLVideoElement;
    screenshotView: HTMLImageElement | null;
    fpsCounter: HTMLElement;
    activeWindowText: HTMLElement;
    frameTimes: number[];
}

export const streamUI: StreamUIState = {
    activeWindowText: byId("activeWindow")!,
    container: byId("streamContainer")!,
    fpsCounter: byId("currentFPS")!,
    frameTimes: [],
    screenshotView: null,
    status: byId("streamStatus")!,
    view: byId<HTMLVideoElement>("streamView")!,
};

export function showStreamUI(): void {
    byId("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
    streamUI.view.classList.remove("opacity-0");

    streamUI.status.classList.remove("hidden");
    streamUI.status.classList.add("inline-flex");
}

export function hideStreamUI(): void {
    byId("streamOverlay")?.classList.remove("opacity-0", "pointer-events-none");
    streamUI.view.classList.add("opacity-0");

    streamUI.status.classList.remove("inline-flex");
    streamUI.status.classList.add("hidden");
}

let cancelFpsCounter: (() => void) | null = null;

export function startFpsCounter(): void {
    stopFpsCounter();
    const { frameTimes, fpsCounter, view } = streamUI;

    let rafId: number;

    function onFrame(now: number, _metadata: VideoFrameCallbackMetadata) {
        frameTimes.push(now);
        while (frameTimes.length > 0 && frameTimes[0]! <= now - 1000) {
            frameTimes.shift();
        }
        fpsCounter.textContent = String(frameTimes.length);
        rafId = view.requestVideoFrameCallback(onFrame);
    }

    rafId = view.requestVideoFrameCallback(onFrame);
    cancelFpsCounter = () => {
        view.cancelVideoFrameCallback(rafId);
    };
}

export function stopFpsCounter(): void {
    if (cancelFpsCounter) {
        cancelFpsCounter();
        cancelFpsCounter = null;
    }
}

export function updateStreamMeta(data: { win?: string }): void {
    if (Object.prototype.hasOwnProperty.call(data, "win")) {
        streamUI.activeWindowText.textContent = `Active Window: ${data.win || "Unknown"}`;
    }
}

export function clearStreamUI(): void {
    stopFpsCounter();
    streamUI.fpsCounter.textContent = "0";
    streamUI.frameTimes = [];
    if (streamUI.view.srcObject) {
        (streamUI.view.srcObject as MediaStream).getTracks().forEach((t) => {
            t.stop();
        });
        streamUI.view.srcObject = null;
    }
}

function initScreenshotView(): void {
    if (!streamUI.screenshotView) {
        streamUI.screenshotView = document.createElement("img");
        streamUI.screenshotView.className =
            "absolute inset-0 w-full h-full object-contain object-center pointer-events-auto hidden z-10 bg-black";
        streamUI.view.parentNode!.insertBefore(streamUI.screenshotView, streamUI.view.nextSibling);
    }
}

export function displayScreenshot(url: string): void {
    initScreenshotView();
    streamUI.screenshotView!.src = url;
    streamUI.screenshotView!.classList.remove("hidden");
    streamUI.view.classList.add("hidden");

    byId("streamOverlay")?.classList.add("opacity-0", "pointer-events-none");
}

export function hideScreenshotView(): void {
    if (streamUI.screenshotView) {
        streamUI.screenshotView.classList.add("hidden");
    }
    streamUI.view.classList.remove("hidden");
}

export function isCursorCaptureEnabled(): boolean {
    const checkbox = byId<HTMLInputElement>("showCursorToggle");
    return checkbox ? checkbox.checked : true;
}

export function setStreamToggleUI(active: boolean): void {
    const btn = byId("toggleStream");
    if (!btn) return;
    btn.innerHTML = active ? SVG_TEMPLATES.stop() : SVG_TEMPLATES.play();
    btn.title = active ? "Stop Stream (Space)" : "Start Stream (Space)";
    toggleClasses(btn, active, ["hover:text-red-400"], ["hover:text-zinc-100"]);
}

// Lazily-created loading spinner for the toggle-stream button.
let startButtonLoader: LoadingButton | null = null;

export function getStartButtonLoader(): LoadingButton | null {
    const btn = byId<HTMLButtonElement>("toggleStream");
    if (btn && !startButtonLoader) {
        startButtonLoader = new LoadingButton(btn, "");
    }
    return startButtonLoader;
}
