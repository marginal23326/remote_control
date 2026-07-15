import { apiCall } from "@/shared/api.ts";
import { LoadingButton, showNotification } from "@/shared/feedback.ts";
import { registerShortcuts } from "@/core/shortcuts.ts";
import { getStartButtonLoader, isCursorCaptureEnabled, setStreamToggleUI, streamUI } from "./view.ts";
import { invalidateDimensionsCache } from "./geometry.ts";
import { setStreamActive, streamActive } from "./stream-state.ts";
import { cleanupPeerConnection, initializePeerConnectionSignaling } from "./peer-connection.ts";
import { initSettingsPanel, updateSettingsDisplay } from "./settings-panel.ts";
import type { AppSocket } from "@/core/socket.ts";
import type { StreamSettings } from "@/shared/types.ts";

async function executeStopStream(): Promise<void> {
    if (!streamActive) return;
    setStreamActive(false);

    getStartButtonLoader()?.stopLoading();
    setStreamToggleUI(false);
    await apiCall("/api/stream/stop").catch(() => {});
    cleanupPeerConnection();
    streamUI.clear();
}

export function initializeStream(sessionId: string, socket: AppSocket): void {
    window.addEventListener("resize", invalidateDimensionsCache);
    window.addEventListener("scroll", invalidateDimensionsCache, { capture: true, passive: true });
    streamUI.view.addEventListener("resize", () => {
        invalidateDimensionsCache();
        apiCall<StreamSettings>("/api/stream/settings")
            .then(updateSettingsDisplay)
            .catch(() => {});
    });

    initializePeerConnectionSignaling(socket);
    initSettingsPanel();

    // Populate the settings panel with whatever the server currently has,
    // Independent of whether/when a WebRTC connection actually starts.
    apiCall<StreamSettings>("/api/stream/settings", "GET")
        .then(updateSettingsDisplay)
        .catch(() => {
            console.log("Stream settings not yet available");
        });

    document.getElementById("toggleStream")!.addEventListener("click", async () => {
        if (streamActive) {
            streamUI.hide();
            streamUI.hideScreenshot();
            await executeStopStream();
        } else {
            streamUI.hideScreenshot();
            setStreamActive(true);

            getStartButtonLoader()?.startLoading();

            socket.emit("start_stream", { capture_cursor: isCursorCaptureEnabled(), sessionId });
        }
    });

    document.getElementById("streamOverlayPlayButton")?.addEventListener("click", () => {
        document.getElementById("toggleStream")!.click();
    });

    let currentScreenshotUrl: string | null = null;

    document.getElementById("screenshot")!.addEventListener("click", async () => {
        const loader = new LoadingButton(document.getElementById("screenshot") as HTMLButtonElement, "");
        loader.startLoading();

        try {
            const response = await fetch("/api/stream/screenshot");
            if (!response.ok) {
                const errorObj = (await response.json().catch(() => ({}))) as { message?: string };
                throw new Error(errorObj.message ?? "Capture failed");
            }

            const blob = await response.blob();

            if (currentScreenshotUrl) {
                URL.revokeObjectURL(currentScreenshotUrl);
            }

            currentScreenshotUrl = URL.createObjectURL(blob);
            streamUI.displayScreenshot(currentScreenshotUrl);
            await executeStopStream();

            showNotification("Screenshot captured. Right-click to save.", "info");
        } catch (error) {
            showNotification((error as Error).message, "error");
        } finally {
            loader.stopLoading();
        }
    });

    let isFullscreen = false;
    const fullscreenBtn = document.getElementById("fullscreenBtn")!;

    function handleFullscreen(): void {
        if (isFullscreen) {
            if (document.exitFullscreen) {
                void document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                void document.webkitExitFullscreen();
            }
        } else if (streamUI.container.requestFullscreen) {
            void streamUI.container.requestFullscreen();
        } else if (streamUI.container.webkitRequestFullscreen) {
            void streamUI.container.webkitRequestFullscreen();
        }
    }

    fullscreenBtn.addEventListener("click", handleFullscreen);

    document.addEventListener("fullscreenchange", () => {
        isFullscreen = Boolean(document.fullscreenElement);
    });
    document.addEventListener("webkitfullscreenchange", () => {
        isFullscreen = Boolean(document.webkitFullscreenElement);
    });

    socket.on("active_window", (data) => {
        streamUI.updateMeta({ win: data.title });
    });

    let wasStreamActive = false;

    socket.on("disconnect", () => {
        if (streamActive) {
            wasStreamActive = true;
            setStreamActive(false);

            getStartButtonLoader()?.stopLoading();
            setStreamToggleUI(false);

            cleanupPeerConnection();
        }
    });

    socket.on("connect", () => {
        if (wasStreamActive) {
            wasStreamActive = false;
            setStreamActive(true);
            setStreamToggleUI(true);

            socket.emit("start_stream", { capture_cursor: isCursorCaptureEnabled(), sessionId });
        }
    });

    (["pull", "push"] as const).forEach((action) => {
        document.getElementById(`${action}ClipboardBtn`)?.addEventListener("click", async (e) => {
            if (!navigator.clipboard) {
                showNotification(
                    "Clipboard sync requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                    "error",
                );
                return;
            }

            const loader = new LoadingButton(e.currentTarget as HTMLButtonElement, "").startLoading();
            try {
                if (action === "pull") {
                    const data = await apiCall<{ text: string }>("/api/system/clipboard", "GET");
                    await navigator.clipboard.writeText(data.text);
                } else {
                    const text = await navigator.clipboard.readText();
                    await apiCall("/api/system/clipboard", "POST", { text });
                }
                showNotification(`${action === "pull" ? "Remote" : "Local"} clipboard synced!`, "info");
            } catch (error) {
                showNotification(`Failed to ${action} clipboard: ${(error as Error).message}`, "error");
            } finally {
                loader.stopLoading();
            }
        });
    });

    registerShortcuts("streamSection", {
        " ": () => document.getElementById("toggleStream")?.click(),
        f: () => document.getElementById("fullscreenBtn")?.click(),
        k: () => document.getElementById("keyboardCaptureBtn")?.click(),
        m: () => document.getElementById("mouseCaptureBtn")?.click(),
        s: () => document.getElementById("screenshot")?.click(),
    });
}
