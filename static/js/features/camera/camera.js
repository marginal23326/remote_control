// static/js/features/camera/camera.js
import { apiCall } from "@/shared/api.js";
import { showNotification, LoadingButton } from "@/shared/feedback.js";

const pip = {
    container: document.getElementById("cameraPip"),
    video: document.getElementById("cameraPipView"),
    deviceSelect: document.getElementById("cameraDeviceSelect"),
    toggleBtn: document.getElementById("toggleCamera"),

    show() {
        this.container?.classList.remove("hidden");
    },
    hide() {
        this.container?.classList.add("hidden");
    },
};

let cameraActive = false;
let wasCameraActive = false;
let peerConnection = null;
let pendingIceCandidates = [];
let activeStunServer = null;
let toggleBtnLoader = null;

function setToggleUI(active) {
    const btn = pip.toggleBtn;
    if (!btn) return;
    btn.classList.toggle("bg-zinc-200", active);
    btn.classList.toggle("text-zinc-900", active);
    btn.classList.toggle("hover:bg-zinc-800", !active);
    btn.classList.toggle("hover:text-zinc-100", !active);
    btn.classList.toggle("text-zinc-400", !active);
    btn.title = active ? "Stop Webcam" : "View Webcam";
}

function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (pip.video?.srcObject) {
        pip.video.srcObject.getTracks().forEach((track) => track.stop());
        pip.video.srcObject = null;
    }
    pendingIceCandidates = [];
}

function populateDeviceList(cameras) {
    const select = pip.deviceSelect;
    if (!select) return;

    if (!cameras || cameras.length < 2) {
        select.classList.add("hidden");
        select.innerHTML = "";
        return;
    }

    select.innerHTML = cameras.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
    select.classList.remove("hidden");
}

function selectedDeviceId() {
    const select = pip.deviceSelect;
    if (!select || select.classList.contains("hidden")) return null;
    return select.value || null;
}

function initializeCameraDrag() {
    const el = pip.container;
    const parent = document.getElementById("streamContainer");
    if (!el || !parent) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function clamp(left, top) {
        const parentRect = parent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const maxLeft = Math.max(0, parentRect.width - elRect.width);
        const maxTop = Math.max(0, parentRect.height - elRect.height);
        return {
            left: Math.min(Math.max(left, 0), maxLeft),
            top: Math.min(Math.max(top, 0), maxTop),
        };
    }

    function pinToPixelPosition() {
        const parentRect = parent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        el.style.left = `${elRect.left - parentRect.left}px`;
        el.style.top = `${elRect.top - parentRect.top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
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

    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try {
            el.releasePointerCapture(e.pointerId);
        } catch {}
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

function initializeCamera(socket) {
    initializeCameraDrag();

    if (pip.toggleBtn && !toggleBtnLoader) {
        toggleBtnLoader = new LoadingButton(pip.toggleBtn, "");
    }

    apiCall("/api/stream/settings", "GET")
        .then((s) => {
            if (s?.stun_server) activeStunServer = s.stun_server;
        })
        .catch(() => {});

    socket.emit("list_cameras");
    socket.on("camera_list", (data) => populateDeviceList(data.cameras));

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

    socket.on("camera_webrtc_offer", async (sdpText) => {
        if (!cameraActive) return;
        toggleBtnLoader?.stopLoading();

        if (!peerConnection) {
            const rtcConfig = {};
            if (activeStunServer) {
                rtcConfig.iceServers = [{ urls: activeStunServer }];
            }
            peerConnection = new RTCPeerConnection(rtcConfig);

            peerConnection.ontrack = (event) => {
                if (pip.video.srcObject !== event.streams[0]) {
                    pip.video.srcObject = event.streams[0];
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("camera_webrtc_ice_candidate", {
                        sdp_mline_index: event.candidate.sdpMLineIndex,
                        candidate: event.candidate.candidate,
                    });
                }
            };
        }

        await peerConnection.setRemoteDescription({ type: "offer", sdp: sdpText });

        for (const candidate of pendingIceCandidates) {
            await peerConnection.addIceCandidate(candidate);
        }
        pendingIceCandidates = [];

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("camera_webrtc_answer", answer.sdp);
    });

    socket.on("camera_webrtc_remote_ice", async (data) => {
        if (!cameraActive || !peerConnection) return;

        const candidate = {
            sdpMLineIndex: data.sdp_mline_index,
            candidate: data.candidate,
        };

        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(candidate);
        } else {
            pendingIceCandidates.push(candidate);
        }
    });

    socket.on("camera_stream_error", (data) => {
        if (!cameraActive) return;
        showNotification(data.message, "error");
        cameraActive = false;
        toggleBtnLoader?.stopLoading();
        setToggleUI(false);
        pip.hide();
        cleanupPeerConnection();
    });

    socket.on("disconnect", () => {
        if (cameraActive) {
            wasCameraActive = true;
            cameraActive = false;
            toggleBtnLoader?.stopLoading();
            setToggleUI(false);
            pip.hide();
            cleanupPeerConnection();
        }
    });

    socket.on("connect", () => {
        if (wasCameraActive) {
            wasCameraActive = false;
            startCamera(socket);
        }
    });
}

function startCamera(socket) {
    if (cameraActive) return;
    cameraActive = true;
    setToggleUI(true);
    pip.show();
    toggleBtnLoader?.startLoading();
    socket.emit("start_camera_stream", { device_id: selectedDeviceId() });
}

function stopCamera(socket) {
    if (!cameraActive) return;
    cameraActive = false;
    toggleBtnLoader?.stopLoading();
    setToggleUI(false);
    pip.hide();
    socket.emit("stop_camera_stream");
    cleanupPeerConnection();
}

export { initializeCamera };
