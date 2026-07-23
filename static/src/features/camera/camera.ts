import { apiCall } from "@/shared/api";
import { LoadingButton, showNotification } from "@/shared/feedback";
import { byId, escapeHtml, setToggleStyle } from "@/shared/dom-helpers";
import { bindMediaSessionReconnect } from "@/shared/media-session";
import { createPeerSignaling } from "@/shared/peer-signaling";
import type { AppSocket } from "@/core/socket";
import type { CameraDeviceInfo, StreamSettings } from "@/shared/types";

interface CameraPipElements {
    container: HTMLElement | null;
    deviceSelect: HTMLSelectElement;
    toggleBtn: HTMLButtonElement | null;
    video: HTMLVideoElement;
}

const pip: CameraPipElements = {
    container: byId("cameraPip"),
    deviceSelect: byId<HTMLSelectElement>("cameraDeviceSelect")!,
    toggleBtn: byId<HTMLButtonElement>("toggleCamera"),
    video: byId<HTMLVideoElement>("cameraPipView")!,
};

function showPip(): void {
    pip.container?.classList.remove("hidden");
}

function hidePip(): void {
    pip.container?.classList.add("hidden");
}

let cameraActive = false;
let peerSignaling: ReturnType<typeof createPeerSignaling> | null = null;
let activeStunServer: string | null = null;
let toggleBtnLoader: LoadingButton | null = null;

function setToggleUI(active: boolean): void {
    const btn = pip.toggleBtn;
    if (!btn) return;
    setToggleStyle(btn, active);
    btn.title = active ? "Stop Webcam" : "View Webcam";
}

function cleanupPeerConnection(): void {
    peerSignaling?.cleanup();
    if (pip.video?.srcObject) {
        (pip.video.srcObject as MediaStream).getTracks().forEach((track) => {
            track.stop();
        });
        pip.video.srcObject = null;
    }
}

function populateDeviceList(cameras: CameraDeviceInfo[] | undefined): void {
    const select = pip.deviceSelect;
    if (!select) return;

    if (!cameras || cameras.length < 2) {
        select.classList.add("hidden");
        select.innerHTML = "";
        return;
    }

    select.innerHTML = cameras
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
        .join("");
    select.classList.remove("hidden");
}

function selectedDeviceId(): string | null {
    const select = pip.deviceSelect;
    if (!select || select.classList.contains("hidden")) return null;
    return select.value || null;
}

function initializeCameraDrag(): void {
    const el = pip.container;
    const parent = byId("streamContainer");
    if (!el || !parent) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function clamp(left: number, top: number): { left: number; top: number } {
        const parentRect = parent!.getBoundingClientRect();
        const elRect = el!.getBoundingClientRect();
        const maxLeft = Math.max(0, parentRect.width - elRect.width);
        const maxTop = Math.max(0, parentRect.height - elRect.height);
        return {
            left: Math.min(Math.max(left, 0), maxLeft),
            top: Math.min(Math.max(top, 0), maxTop),
        };
    }

    function pinToPixelPosition(): void {
        const parentRect = parent!.getBoundingClientRect();
        const elRect = el!.getBoundingClientRect();
        el!.style.left = `${elRect.left - parentRect.left}px`;
        el!.style.top = `${elRect.top - parentRect.top}px`;
        el!.style.right = "auto";
        el!.style.bottom = "auto";
    }

    el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;

        pinToPixelPosition();

        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseFloat(el.style.left) || 0;
        startTop = parseFloat(el.style.top) || 0;
        el.setPointerCapture(e.pointerId);
    });

    el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const { left, top } = clamp(startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });

    function endDrag(e: PointerEvent): void {
        if (!dragging) return;
        dragging = false;
        try {
            el!.releasePointerCapture(e.pointerId);
        } catch {
            /* Ignore */
        }
    }

    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => {
        if (!el.style.left || el.classList.contains("hidden")) return;
        const { left, top } = clamp(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });
}

export function initializeCamera(socket: AppSocket): void {
    initializeCameraDrag();

    if (pip.toggleBtn && !toggleBtnLoader) {
        toggleBtnLoader = new LoadingButton(pip.toggleBtn, "");
    }

    apiCall<StreamSettings>("/api/stream/settings", "GET")
        .then((s) => {
            if (s?.stun_server) activeStunServer = s.stun_server;
        })
        .catch(() => {});

    socket.emit("list_cameras");
    socket.on("camera_list", (data) => {
        populateDeviceList(data.cameras);
    });

    pip.toggleBtn?.addEventListener("click", () => {
        if (cameraActive) {
            stopCamera(socket);
        } else {
            startCamera(socket);
        }
    });

    pip.deviceSelect?.addEventListener("change", () => {
        if (cameraActive) {
            stopCamera(socket);
            startCamera(socket);
        }
    });

    const signaling = createPeerSignaling({
        getStunServer: () => activeStunServer,
        onAnswer: (sdp) => {
            socket.emit("camera_webrtc_answer", sdp);
        },
        onIceCandidate: (candidate) => {
            socket.emit("camera_webrtc_ice_candidate", candidate);
        },
        onNegotiationError: (error) => {
            console.error("Camera WebRTC offer handling failed:", error);
            handleCameraError("Failed to establish camera connection");
        },
        onTrack: (stream) => {
            if (pip.video.srcObject !== stream) {
                pip.video.srcObject = stream;
            }
        },
    });
    peerSignaling = signaling;

    socket.on("camera_webrtc_offer", async (sdpText) => {
        if (!cameraActive) return;
        toggleBtnLoader?.stopLoading();
        await signaling.handleOffer(sdpText);
    });

    socket.on("camera_webrtc_remote_ice", async (data) => {
        if (!cameraActive) return;
        await signaling.handleRemoteIce(data);
    });

    socket.on("camera_stream_error", (data) => {
        if (!cameraActive) return;
        handleCameraError(data.message);
    });

    bindMediaSessionReconnect(socket, {
        isActive: () => cameraActive,
        onDisconnect: () => {
            cameraActive = false;
            toggleBtnLoader?.stopLoading();
            setToggleUI(false);
            hidePip();
            cleanupPeerConnection();
        },
        onReconnect: () => startCamera(socket),
    });
}

function handleCameraError(message: string): void {
    showNotification(message, "error");
    cameraActive = false;
    toggleBtnLoader?.stopLoading();
    setToggleUI(false);
    hidePip();
    cleanupPeerConnection();
}

function startCamera(socket: AppSocket): void {
    if (cameraActive) return;
    cameraActive = true;
    setToggleUI(true);
    showPip();
    toggleBtnLoader?.startLoading();
    socket.emit("start_camera_stream", { device_id: selectedDeviceId() });
}

function stopCamera(socket: AppSocket): void {
    if (!cameraActive) return;
    cameraActive = false;
    toggleBtnLoader?.stopLoading();
    setToggleUI(false);
    hidePip();
    socket.emit("stop_camera_stream");
    cleanupPeerConnection();
}
