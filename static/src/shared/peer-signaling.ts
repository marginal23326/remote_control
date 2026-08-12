import type { IceCandidatePayload } from "@/core/socket-events";

export interface PeerSignalingHandlers {
    onAnswer: (sdp: string) => void;
    onConnectionCreated?: (pc: RTCPeerConnection) => void;
    onIceCandidate: (candidate: IceCandidatePayload) => void;
    onNegotiationError: (error: unknown) => void;
    onTrack: (stream: MediaStream) => void;
    getStunServer: () => string | null | undefined;
    getTurnServer: () => string | null | undefined;
}

function parseTurnServer(turnUrl: string): RTCIceServer | null {
    try {
        const url = new URL(turnUrl);
        if (!url.username) return null;

        return {
            urls: `${url.protocol}${url.host}${url.search}`,
            username: decodeURIComponent(url.username),
            credential: decodeURIComponent(url.password),
        };
    } catch {
        return null;
    }
}

export interface PeerSignaling {
    cleanup: () => void;
    handleOffer: (sdpText: string) => Promise<void>;
    handleRemoteIce: (data: IceCandidatePayload) => Promise<void>;
}

export function createPeerSignaling(handlers: PeerSignalingHandlers): PeerSignaling {
    let peerConnection: RTCPeerConnection | null = null;
    let pendingIceCandidates: RTCIceCandidateInit[] = [];

    async function handleOffer(sdpText: string): Promise<void> {
        if (!peerConnection) {
            const iceServers: RTCIceServer[] = [];

            const stunServer = handlers.getStunServer();
            if (stunServer) {
                iceServers.push({ urls: stunServer });
            }

            const turnServer = handlers.getTurnServer();
            const parsedTurnServer = turnServer ? parseTurnServer(turnServer) : null;
            if (parsedTurnServer) {
                iceServers.push(parsedTurnServer);
            }

            const rtcConfig: RTCConfiguration = iceServers.length > 0 ? { iceServers } : {};

            peerConnection = new RTCPeerConnection(rtcConfig);

            peerConnection.ontrack = (event) => {
                handlers.onTrack(event.streams[0]!);
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    handlers.onIceCandidate({
                        candidate: event.candidate.candidate,
                        sdp_mline_index: event.candidate.sdpMLineIndex,
                    });
                }
            };

            handlers.onConnectionCreated?.(peerConnection);
        }

        try {
            await peerConnection.setRemoteDescription({ sdp: sdpText, type: "offer" });

            const pc = peerConnection;
            await Promise.all(pendingIceCandidates.map((candidate) => pc.addIceCandidate(candidate)));
            pendingIceCandidates = [];

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            handlers.onAnswer(answer.sdp!);
        } catch (error) {
            handlers.onNegotiationError(error);
        }
    }

    async function handleRemoteIce(data: IceCandidatePayload): Promise<void> {
        if (!peerConnection) return;

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

    function cleanup(): void {
        pendingIceCandidates = [];
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    }

    return { cleanup, handleOffer, handleRemoteIce };
}
