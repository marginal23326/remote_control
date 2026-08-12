import { createPeerSignaling } from "./peer-signaling";
import type { AppSocket } from "@/core/socket";
import type { ClientEvent, ServerEvent } from "@/generated/bindings";

interface WebRtcEventNames {
    offer: ServerEvent;
    remoteIce: ServerEvent;
    error: ServerEvent;
    answer: ClientEvent;
    iceCandidate: ClientEvent;
}

const STREAM_EVENTS = {
    answer: "webrtc_answer",
    error: "webrtc_error",
    iceCandidate: "webrtc_ice_candidate",
    offer: "webrtc_offer",
    remoteIce: "webrtc_remote_ice",
} as const satisfies WebRtcEventNames;

const CAMERA_EVENTS = {
    answer: `camera_${STREAM_EVENTS.answer}`,
    error: `camera_${STREAM_EVENTS.error}`,
    iceCandidate: `camera_${STREAM_EVENTS.iceCandidate}`,
    offer: `camera_${STREAM_EVENTS.offer}`,
    remoteIce: `camera_${STREAM_EVENTS.remoteIce}`,
} as const satisfies WebRtcEventNames;

const WEBRTC_FEATURE_CONFIG = {
    camera: {
        ...CAMERA_EVENTS,
        logLabel: "Camera",
        negotiationErrorMessage: "Failed to establish camera connection",
    },
    stream: {
        ...STREAM_EVENTS,
        logLabel: "Stream",
        negotiationErrorMessage: "Failed to establish stream connection",
    },
} as const;

export type WebRtcFeatureKind = keyof typeof WEBRTC_FEATURE_CONFIG;

export interface WebRtcFeatureHooks {
    isActive: () => boolean;
    getStunServer: () => string | null | undefined;
    getTurnServer: () => string | null | undefined;
    onConnectionCreated?: (pc: RTCPeerConnection) => void;
    onTrack: (stream: MediaStream) => void;
    onOfferReceived?: () => void;
    onError: (message: string) => void;
}

export interface WebRtcFeature {
    cleanup: () => void;
}

export function initWebRtcFeature(
    socket: AppSocket,
    kind: WebRtcFeatureKind,
    hooks: WebRtcFeatureHooks,
): WebRtcFeature {
    const config = WEBRTC_FEATURE_CONFIG[kind];

    const signaling = createPeerSignaling({
        getStunServer: hooks.getStunServer,
        getTurnServer: hooks.getTurnServer,
        onAnswer: (sdp) => {
            socket.emit(config.answer, sdp);
        },
        onConnectionCreated: hooks.onConnectionCreated,
        onIceCandidate: (candidate) => {
            socket.emit(config.iceCandidate, candidate);
        },
        onNegotiationError: (error) => {
            console.error(`${config.logLabel} WebRTC offer handling failed:`, error);
            hooks.onError(config.negotiationErrorMessage);
        },
        onTrack: hooks.onTrack,
    });

    socket.on(config.offer, async (sdpText) => {
        if (!hooks.isActive()) return;
        hooks.onOfferReceived?.();
        await signaling.handleOffer(sdpText);
    });

    socket.on(config.remoteIce, async (data) => {
        if (!hooks.isActive()) return;
        await signaling.handleRemoteIce(data);
    });

    socket.on(config.error, (data) => {
        if (!hooks.isActive()) return;
        console.error(`${config.logLabel} error:`, data.message);
        hooks.onError(data.message);
    });

    return { cleanup: signaling.cleanup };
}
