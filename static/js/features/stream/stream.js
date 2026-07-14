import { apiCall } from "@/shared/api.js";
import { showNotification, LoadingButton } from "@/shared/feedback.js";
import { registerShortcuts } from "@/core/shortcuts.js";
import { streamUI, isCursorCaptureEnabled, setStreamToggleUI, getStartButtonLoader } from "./view.js";
import { invalidateDimensionsCache } from "./geometry.js";
import { streamActive, setStreamActive } from "./stream-state.js";
import { initializePeerConnectionSignaling, cleanupPeerConnection } from "./peer-connection.js";
import { updateSettingsDisplay, initSettingsPanel } from "./settings-panel.js";

function initializeStream(sessionId, socket) {
    window.addEventListener("resize", invalidateDimensionsCache);
    window.addEventListener("scroll", invalidateDimensionsCache, { capture: true, passive: true });
    streamUI.view.addEventListener("resize", () => {
        invalidateDimensionsCache();
        apiCall("/api/stream/settings")
            .then(updateSettingsDisplay)
            .catch(() => {});
    });

    initializePeerConnectionSignaling(socket);
    initSettingsPanel();

    // Populate the settings panel with whatever the server currently has,
    // independent of whether/when a WebRTC connection actually starts.
    apiCall("/api/stream/settings", "GET")
        .then(updateSettingsDisplay)
        .catch(() => console.log("Stream settings not yet available"));

    document.getElementById("toggleStream").addEventListener("click", async () => {
        if (!streamActive) {
            streamUI.hideScreenshot();
            setStreamActive(true);

            getStartButtonLoader()?.startLoading();

            socket.emit("start_stream", { sessionId, capture_cursor: isCursorCaptureEnabled() });
        } else {
            streamUI.hide();
            streamUI.hideScreenshot();
            await executeStopStream();
        }
    });

    document.getElementById("streamOverlayPlayButton")?.addEventListener("click", () => {
        document.getElementById("toggleStream").click();
    });

    async function executeStopStream() {
        if (!streamActive) return;
        setStreamActive(false);

        getStartButtonLoader()?.stopLoading();
        setStreamToggleUI(false);
        await apiCall("/api/stream/stop").catch(() => {});
        cleanupPeerConnection();
        streamUI.clear();
    }

    let currentScreenshotUrl = null;

    document.getElementById("screenshot").addEventListener("click", async () => {
        const loader = new LoadingButton(document.getElementById("screenshot"), "");
        loader.startLoading();

        try {
            const response = await fetch("/api/stream/screenshot");
            if (!response.ok) {
                const errorObj = await response.json().catch(() => ({}));
                throw new Error(errorObj.message || "Capture failed");
            }

            const blob = await response.blob();

            if (currentScreenshotUrl) {
                URL.revokeObjectURL(currentScreenshotUrl);
            }

            currentScreenshotUrl = URL.createObjectURL(blob);
            streamUI.displayScreenshot(currentScreenshotUrl);
            await executeStopStream();

            showNotification("Screenshot captured. Right-click to save.", "info");
        } catch (err) {
            showNotification(err.message, "error");
        } finally {
            loader.stopLoading();
        }
    });

    let isFullscreen = false;
    const fullscreenBtn = document.getElementById("fullscreenBtn");

    function handleFullscreen() {
        if (!isFullscreen) {
            if (streamUI.container.requestFullscreen) {
                streamUI.container.requestFullscreen();
            } else if (streamUI.container.webkitRequestFullscreen) {
                streamUI.container.webkitRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    }

    fullscreenBtn.addEventListener("click", handleFullscreen);

    document.addEventListener("fullscreenchange", () => {
        isFullscreen = !!document.fullscreenElement;
    });
    document.addEventListener("webkitfullscreenchange", () => {
        isFullscreen = !!document.webkitFullscreenElement;
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

            socket.emit("start_stream", { sessionId, capture_cursor: isCursorCaptureEnabled() });
        }
    });

    ["pull", "push"].forEach((action) => {
        document.getElementById(`${action}ClipboardBtn`)?.addEventListener("click", async (e) => {
            if (!navigator.clipboard) {
                showNotification(
                    "Clipboard sync requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                    "error",
                );
                return;
            }

            const loader = new LoadingButton(e.currentTarget, "").startLoading();
            try {
                if (action === "pull") {
                    const data = await apiCall("/api/system/clipboard", "GET");
                    await navigator.clipboard.writeText(data.text);
                } else {
                    const text = await navigator.clipboard.readText();
                    await apiCall("/api/system/clipboard", "POST", { text });
                }
                showNotification(`${action === "pull" ? "Remote" : "Local"} clipboard synced!`, "info");
            } catch (err) {
                showNotification(`Failed to ${action} clipboard: ${err.message}`, "error");
            } finally {
                loader.stopLoading();
            }
        });
    });

    registerShortcuts("streamSection", {
        " ": () => document.getElementById("toggleStream")?.click(),
        s: () => document.getElementById("screenshot")?.click(),
        f: () => document.getElementById("fullscreenBtn")?.click(),
        k: () => document.getElementById("keyboardCaptureBtn")?.click(),
        m: () => document.getElementById("mouseCaptureBtn")?.click(),
    });
}

export { initializeStream };
