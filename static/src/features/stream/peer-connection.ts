import { showNotification } from "@/shared/feedback";
import {
    getStartButtonLoader,
    hideStreamUI,
    setStreamToggleUI,
    showStreamUI,
    startFpsCounter,
    stopFpsCounter,
    streamUI,
} from "./view";
import { streamState } from "./stream-state";
import { apiCall } from "@/shared/api";
import { updateSettingsDisplay } from "./settings-panel";
import { initWebRtcFeature } from "@/shared/webrtc-feature";
import type { AppSocket } from "@/core/socket";
import type { MouseEventPayload } from "@/core/socket-events";
import type { StreamSettings } from "@/shared/types";
import type { WebRtcFeature } from "@/shared/webrtc-feature";

let webrtcFeature: WebRtcFeature | null = null;

let mouseMoveChannel: RTCDataChannel | null = null;
let mouseControlChannel: RTCDataChannel | null = null;
let pendingMouseMove: (MouseEventPayload & { seq: number }) | null = null;
let mouseInputSeq = 0;

export function initializePeerConnectionSignaling(socket: AppSocket): void {
    webrtcFeature = initWebRtcFeature(socket, "stream", {
        getStunServer: () => streamState.stunServer,
        isActive: () => streamState.active,
        onConnectionCreated: (pc) => {
            pc.ondatachannel = (event) => {
                registerInputDataChannel(event.channel);
            };

            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "connected") {
                    startFpsCounter();
                    void apiCall<StreamSettings>("/api/stream/settings", "GET").then((s) => {
                        if (s) updateSettingsDisplay(s);
                    });
                }
            };
        },
        onError: handleStreamError,
        onOfferReceived: () => {
            getStartButtonLoader()?.stopLoading();
            showStreamUI();
            setStreamToggleUI(true);
        },
        onTrack: (stream) => {
            if (streamUI.view.srcObject !== stream) {
                streamUI.view.srcObject = stream;
            }
        },
    });
}

function handleStreamError(message: string): void {
    showNotification(message, "error");
    streamState.active = false;
    getStartButtonLoader()?.stopLoading();
    setStreamToggleUI(false);
    cleanupPeerConnection();
    hideStreamUI();
}

export function cleanupPeerConnection(): void {
    stopFpsCounter();
    mouseMoveChannel = null;
    mouseControlChannel = null;
    pendingMouseMove = null;
    webrtcFeature?.cleanup();
}

function onChannelLost(channel: RTCDataChannel, onCleared: () => void): void {
    const clear = () => onCleared();
    channel.addEventListener("close", clear);
    channel.addEventListener("error", clear);
}

function registerInputDataChannel(channel: RTCDataChannel): void {
    if (channel.label === "mouse-move") {
        mouseMoveChannel = channel;
        mouseMoveChannel.bufferedAmountLowThreshold = 1024;
        channel.addEventListener("bufferedamountlow", () => {
            flushPendingMouseMove();
        });
        onChannelLost(channel, () => {
            if (mouseMoveChannel === channel) {
                mouseMoveChannel = null;
                pendingMouseMove = null;
            }
        });
    } else if (channel.label === "mouse-control") {
        mouseControlChannel = channel;
        onChannelLost(channel, () => {
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
