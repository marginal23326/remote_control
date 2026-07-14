import { showNotification } from "@/shared/feedback.js";
import { streamUI, setStreamToggleUI, stopStreamStartLoading } from "./view.js";
import { streamActive, setStreamActive, activeStunServer } from "./stream-state.js";
import { apiCall } from "@/shared/api.js";
import { updateSettingsDisplay } from "./settings-panel.js";

let peerConnection = null;
let pendingIceCandidates = [];

let mouseMoveChannel = null;
let mouseControlChannel = null;
let pendingMouseMove = null;
let mouseInputSeq = 0;

function initializePeerConnectionSignaling(socket) {
    socket.on("webrtc_offer", async (sdpText) => {
        if (!streamActive) return;

        stopStreamStartLoading();
        streamUI.show();
        setStreamToggleUI(true);

        if (!peerConnection) {
            const rtcConfig = {};
            if (activeStunServer) {
                rtcConfig.iceServers = [{ urls: activeStunServer }];
            }
            peerConnection = new RTCPeerConnection(rtcConfig);

            peerConnection.ontrack = (event) => {
                if (streamUI.view.srcObject !== event.streams[0]) {
                    streamUI.view.srcObject = event.streams[0];
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("webrtc_ice_candidate", {
                        sdp_mline_index: event.candidate.sdpMLineIndex,
                        candidate: event.candidate.candidate,
                    });
                }
            };

            peerConnection.ondatachannel = (event) => {
                registerInputDataChannel(event.channel);
            };

            peerConnection.onconnectionstatechange = () => {
                if (peerConnection.connectionState === "connected") {
                    streamUI.startFpsCounter();
                    apiCall("/api/stream/settings", "GET").then((s) => {
                        if (s) updateSettingsDisplay(s);
                    });
                }
            };
        }

        await peerConnection.setRemoteDescription({ type: "offer", sdp: sdpText });

        for (const c of pendingIceCandidates) {
            await peerConnection.addIceCandidate(c);
        }
        pendingIceCandidates = [];

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("webrtc_answer", answer.sdp);
    });

    socket.on("webrtc_remote_ice", async (data) => {
        if (!streamActive) return;
        if (peerConnection) {
            const candidate = {
                sdpMLineIndex: data.sdp_mline_index,
                candidate: data.candidate,
            };
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(candidate);
            } else {
                pendingIceCandidates.push(candidate);
            }
        }
    });

    socket.on("stream_error", (data) => {
        if (!streamActive) return;
        console.error("Stream error:", data.message);
        showNotification(data.message, "error");
        setStreamActive(false);

        stopStreamStartLoading();
        setStreamToggleUI(false);

        cleanupPeerConnection();
        streamUI.hide();
    });
}

function cleanupPeerConnection() {
    streamUI.stopFpsCounter();
    mouseMoveChannel = null;
    mouseControlChannel = null;
    pendingMouseMove = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
}

function registerInputDataChannel(channel) {
    if (channel.label === "mouse-move") {
        mouseMoveChannel = channel;
        mouseMoveChannel.bufferedAmountLowThreshold = 1024;
        channel.onbufferedamountlow = () => flushPendingMouseMove();
        channel.onclose = () => {
            if (mouseMoveChannel === channel) {
                mouseMoveChannel = null;
                pendingMouseMove = null;
            }
        };
        channel.onerror = () => {
            if (mouseMoveChannel === channel) {
                mouseMoveChannel = null;
                pendingMouseMove = null;
            }
        };
    } else if (channel.label === "mouse-control") {
        mouseControlChannel = channel;
        channel.onclose = () => {
            if (mouseControlChannel === channel) mouseControlChannel = null;
        };
        channel.onerror = () => {
            if (mouseControlChannel === channel) mouseControlChannel = null;
        };
    }
}

function sendMouseEventOverDataChannel(data) {
    const lowLatency = data.type === "move";
    const channel = lowLatency ? mouseMoveChannel : mouseControlChannel;
    if (!channel || channel.readyState !== "open") {
        return false;
    }

    const payload = {
        ...data,
        seq: ++mouseInputSeq,
    };

    if (lowLatency && channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        pendingMouseMove = payload;
        return true;
    }

    return sendRawMousePayload(channel, payload);
}

function sendRawMousePayload(channel, payload) {
    try {
        channel.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function flushPendingMouseMove() {
    if (!pendingMouseMove || !mouseMoveChannel || mouseMoveChannel.readyState !== "open") {
        return;
    }
    if (mouseMoveChannel.bufferedAmount > mouseMoveChannel.bufferedAmountLowThreshold) {
        return;
    }

    const payload = pendingMouseMove;
    pendingMouseMove = null;
    sendRawMousePayload(mouseMoveChannel, payload);
}

export { initializePeerConnectionSignaling, cleanupPeerConnection, sendMouseEventOverDataChannel };
