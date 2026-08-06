import { apiCall } from "@/shared/api";
import { byId, onAsync } from "@/shared/dom-helpers";
import { LoadingButton, runWithFeedback, showNotification } from "@/shared/feedback";
import { bindMediaSessionReconnect } from "@/shared/media-session";
import { registerShortcuts } from "@/core/shortcuts";
import {
    clearStreamUI,
    displayScreenshot,
    getStartButtonLoader,
    hideScreenshotView,
    hideStreamUI,
    isCursorCaptureEnabled,
    setStreamToggleUI,
    streamUI,
    updateStreamMeta,
} from "./view";
import { invalidateDimensionsCache } from "./geometry";
import { streamState } from "./stream-state";
import { cleanupPeerConnection, initializePeerConnectionSignaling } from "./peer-connection";
import { initSettingsPanel, updateSettingsDisplay } from "./settings-panel";
import type { AppSocket } from "@/core/socket";
import type { StreamSettings } from "@/shared/types";

async function executeStopStream(): Promise<void> {
    if (!streamState.active) return;
    streamState.active = false;

    getStartButtonLoader()?.stopLoading();
    setStreamToggleUI(false);
    await apiCall("/api/stream/stop").catch(() => {});
    cleanupPeerConnection();
    clearStreamUI();
}

export function initializeStream(socket: AppSocket): void {
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

    onAsync(byId("toggleStream"), "click", async () => {
        if (streamState.active) {
            hideStreamUI();
            hideScreenshotView();
            await executeStopStream();
        } else {
            hideScreenshotView();
            streamState.active = true;

            getStartButtonLoader()?.startLoading();

            socket.emit("start_stream", { capture_cursor: isCursorCaptureEnabled() });
        }
    });

    byId("streamOverlayPlayButton")?.addEventListener("click", () => {
        byId("toggleStream")!.click();
    });

    let currentScreenshotUrl: string | null = null;

    onAsync(byId("screenshot"), "click", async () => {
        const loader = new LoadingButton(byId<HTMLButtonElement>("screenshot")!, "");

        await runWithFeedback(loader, async () => {
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
            displayScreenshot(currentScreenshotUrl);
            await executeStopStream();

            showNotification("Screenshot captured. Right-click to save.", "info");
        });
    });

    let isFullscreen = false;
    const fullscreenBtn = byId("fullscreenBtn")!;

    function handleFullscreen(): void {
        if (isFullscreen) {
            void document.exitFullscreen();
        } else {
            void streamUI.container.requestFullscreen();
        }
    }

    fullscreenBtn.addEventListener("click", handleFullscreen);

    document.addEventListener("fullscreenchange", () => {
        isFullscreen = Boolean(document.fullscreenElement);
    });

    socket.on("active_window", (data) => {
        updateStreamMeta({ win: data.title });
    });

    bindMediaSessionReconnect(socket, {
        isActive: () => streamState.active,
        onDisconnect: () => {
            streamState.active = false;
            getStartButtonLoader()?.stopLoading();
            setStreamToggleUI(false);
            cleanupPeerConnection();
        },
        onReconnect: () => {
            streamState.active = true;
            setStreamToggleUI(true);
            socket.emit("start_stream", { capture_cursor: isCursorCaptureEnabled() });
        },
    });

    (["pull", "push"] as const).forEach((action) => {
        onAsync(byId(`${action}ClipboardBtn`), "click", async (e) => {
            if (!navigator.clipboard) {
                showNotification(
                    "Clipboard sync requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                    "error",
                );
                return;
            }

            const loader = new LoadingButton(e.currentTarget as HTMLButtonElement, "");
            await runWithFeedback(
                loader,
                async () => {
                    if (action === "pull") {
                        const data = await apiCall<{ text: string }>("/api/system/clipboard", "GET");
                        await navigator.clipboard.writeText(data.text);
                    } else {
                        const text = await navigator.clipboard.readText();
                        await apiCall("/api/system/clipboard", "POST", { text });
                    }
                    showNotification(`${action === "pull" ? "Remote" : "Local"} clipboard synced!`, "info");
                },
                `Failed to ${action} clipboard`,
            );
        });
    });

    registerShortcuts("streamSection", {
        " ": () => byId("toggleStream")?.click(),
        f: () => byId("fullscreenBtn")?.click(),
        k: () => byId("keyboardCaptureBtn")?.click(),
        m: () => byId("mouseCaptureBtn")?.click(),
        s: () => byId("screenshot")?.click(),
    });
}
