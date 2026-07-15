import { showNotification } from "@/shared/feedback.ts";
import { getStartButtonLoader, setStreamToggleUI, streamUI } from "./view.ts";
import { activeStunServer, setStreamActive, streamActive } from "./stream-state.ts";
import { apiCall } from "@/shared/api.ts";
import { updateSettingsDisplay } from "./settings-panel.ts";
import type { AppSocket } from "@/core/socket.ts";
import type { MouseEventPayload } from "@/core/socket-events.ts";
import type { StreamSettings } from "@/shared/types.ts";

let peerConnection: RTCPeerConnection | null = null;
let pendingIceCandidates: RTCIceCandidateInit[] = [];

let mouseMoveChannel: RTCDataChannel | null = null;
let mouseControlChannel: RTCDataChannel | null = null;
let pendingMouseMove: (MouseEventPayload & { seq: number }) | null = null;
let mouseInputSeq = 0;

export function initializePeerConnectionSignaling(socket: AppSocket): void {
    socket.on("webrtc_offer", async (sdpText) => {
        if (!streamActive) return;

        getStartButtonLoader()?.stopLoading();
        streamUI.show();
        setStreamToggleUI(true);

        if (!peerConnection) {
            const rtcConfig: RTCConfiguration = {};
            if (activeStunServer) {
                rtcConfig.iceServers = [{ urls: activeStunServer }];
            }
            peerConnection = new RTCPeerConnection(rtcConfig);

            peerConnection.ontrack = (event) => {
                if (streamUI.view.srcObject !== event.streams[0]) {
                    streamUI.view.srcObject = event.streams[0]!;
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("webrtc_ice_candidate", {
                        candidate: event.candidate.candidate,
                        sdp_mline_index: event.candidate.sdpMLineIndex,
                    });
                }
            };

            peerConnection.ondatachannel = (event) => {
                registerInputDataChannel(event.channel);
            };

            peerConnection.onconnectionstatechange = () => {
                if (peerConnection!.connectionState === "connected") {
                    streamUI.startFpsCounter();
                    void apiCall<StreamSettings>("/api/stream/settings", "GET").then((s) => {
                        if (s) updateSettingsDisplay(s);
                    });
                }
            };
        }

        try {
            await peerConnection.setRemoteDescription({ sdp: sdpText, type: "offer" });

            const pc = peerConnection;
            await Promise.all(pendingIceCandidates.map((c) => pc.addIceCandidate(c)));
            pendingIceCandidates = [];

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit("webrtc_answer", answer.sdp!);
        } catch (error) {
            console.error("WebRTC offer handling failed:", error);
            handleStreamError("Failed to establish stream connection");
        }
    });

    socket.on("webrtc_remote_ice", async (data) => {
        if (!streamActive) return;
        if (peerConnection) {
            const candidate: RTCIceCandidateInit = {
                candidate: data.candidate,
                sdpMLineIndex: data.sdp_mline_index,
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
        handleStreamError(data.message);
    });
}

function handleStreamError(message: string): void {
    showNotification(message, "error");
    setStreamActive(false);
    getStartButtonLoader()?.stopLoading();
    setStreamToggleUI(false);
    cleanupPeerConnection();
    streamUI.hide();
}

export function cleanupPeerConnection(): void {
    streamUI.stopFpsCounter();
    mouseMoveChannel = null;
    mouseControlChannel = null;
    pendingMouseMove = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
}

function registerInputDataChannel(channel: RTCDataChannel): void {
    if (channel.label === "mouse-move") {
        mouseMoveChannel = channel;
        mouseMoveChannel.bufferedAmountLowThreshold = 1024;
        channel.addEventListener("bufferedamountlow", () => {
            flushPendingMouseMove();
        });
        channel.addEventListener("close", () => {
            if (mouseMoveChannel === channel) {
                mouseMoveChannel = null;
                pendingMouseMove = null;
            }
        });
        channel.addEventListener("error", () => {
            if (mouseMoveChannel === channel) {
                mouseMoveChannel = null;
                pendingMouseMove = null;
            }
        });
    } else if (channel.label === "mouse-control") {
        mouseControlChannel = channel;
        channel.addEventListener("close", () => {
            if (mouseControlChannel === channel) mouseControlChannel = null;
        });
        channel.addEventListener("error", () => {
            if (mouseControlChannel === channel) mouseControlChannel = null;
        });
    }
}

export function sendMouseEventOverDataChannel(data: MouseEventPayload): boolean {
    const lowLatency = data.type === "move";
    const channel = lowLatency ? mouseMoveChannel : mouseControlChannel;
    if (!channel || channel.readyState !== "open") {
        return false;
    }

    const payload: MouseEventPayload & { seq: number } = {
        ...data,
        seq: ++mouseInputSeq,
    };

    if (lowLatency && channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        pendingMouseMove = payload;
        return true;
    }

    return sendRawMousePayload(channel, payload);
}

function sendRawMousePayload(channel: RTCDataChannel, payload: MouseEventPayload & { seq: number }): boolean {
    try {
        channel.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function flushPendingMouseMove(): void {
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
