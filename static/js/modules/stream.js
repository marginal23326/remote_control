import { apiCall } from './utils.js';

const streamUI = {
    container: document.getElementById('streamContainer'),
    status: document.getElementById('streamStatus'),
    view: document.getElementById('streamView'),
    nativeWidth: null,
    nativeHeight: null,
    fpsCounter: document.getElementById('currentFPS'),
    activeWindowText: document.getElementById('activeWindow'),
    frameTimes: [],

    show() {
        this.container.classList.remove('h-0');
        this.container.classList.add('h-auto');
        this.status.classList.remove('hidden');
        this.status.classList.add('inline-flex');
    },

    hide() {
        this.container.classList.remove('h-auto');
        this.container.classList.add('h-0');
        this.status.classList.remove('inline-flex');
        this.status.classList.add('hidden');
    },

    startFpsCounter() {
        const frameTimes = this.frameTimes;
        const fpsCounter = this.fpsCounter;
        const video = this.view;

        let rafId;

        function onFrame(now, _metadata) {
            frameTimes.push(now);
            while (frameTimes.length > 0 && frameTimes[0] <= now - 1000) {
                frameTimes.shift();
            }
            fpsCounter.textContent = frameTimes.length;
            rafId = video.requestVideoFrameCallback(onFrame);
        }

        rafId = video.requestVideoFrameCallback(onFrame);
        this._stopFpsCounter = () => video.cancelVideoFrameCallback(rafId);
    },

    stopFpsCounter() {
        if (this._stopFpsCounter) {
            this._stopFpsCounter();
            this._stopFpsCounter = null;
        }
    },

    updateMeta(data) {
        if (Object.prototype.hasOwnProperty.call(data, 'win')) {
            this.activeWindowText.textContent = `Active Window: ${data.win || 'Unknown'}`;
        }
    },

    clear() {
        this.stopFpsCounter();
        this.fpsCounter.textContent = '0';
        this.frameTimes = [];
        if (this.view.srcObject) {
            this.view.srcObject.getTracks().forEach(t => t.stop());
            this.view.srcObject = null;
        }
    }
};

let streamActive = false;
let peerConnection = null;
let isFullscreen = false;
let nativeWidth = null;
let nativeHeight = null;
let maxFps = 60;

function initializeStream(sessionId, socket) {
    document.getElementById('startStream').addEventListener('click', () => {
        if (!streamActive) {
            streamActive = true;
            streamUI.show();

            socket.emit('start_stream', { sessionId });

            socket.on('webrtc_offer', async (sdpText) => {
                if (!peerConnection) {
                    peerConnection = new RTCPeerConnection({
                        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
                    });

                    peerConnection.ontrack = (event) => {
                        if (streamUI.view.srcObject !== event.streams[0]) {
                            streamUI.view.srcObject = event.streams[0];
                        }
                    };

                    peerConnection.onicecandidate = (event) => {
                        if (event.candidate) {
                            socket.emit('webrtc_ice_candidate', {
                                sdp_mline_index: event.candidate.sdpMLineIndex,
                                candidate: event.candidate.candidate
                            });
                        }
                    };

                    peerConnection.onconnectionstatechange = () => {
                        if (peerConnection.connectionState === 'connected') {
                            streamUI.startFpsCounter();
                        }
                    };

                }

                await peerConnection.setRemoteDescription({ type: 'offer', sdp: sdpText });
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('webrtc_answer', answer.sdp);
            });

            socket.on('webrtc_remote_ice', async (data) => {
                if (peerConnection) {
                    try {
                        await peerConnection.addIceCandidate({
                            sdpMLineIndex: data.sdp_mline_index,
                            candidate: data.candidate
                        });
                    } catch (e) {
                        console.warn('ICE add error:', e);
                    }
                }
            });

            socket.on('stream_error', (data) => {
                console.error('Stream error:', data.message);
                streamActive = false;
                streamUI.hide();
            });
        }
    });

    document.getElementById('stopStream').addEventListener('click', async () => {
        if (streamActive) {
            streamActive = false;
            streamUI.hide();
            cleanupPeerConnection();
            await apiCall('/api/stream/stop');
            streamUI.clear();
            socket.off('webrtc_offer');
            socket.off('webrtc_remote_ice');
            socket.off('stream_error');
        }
    });

    document.getElementById('streamBitrate').addEventListener('input', updateStreamSettings);
    document.getElementById('streamResolution').addEventListener('input', updateResolutionLabel);
    document.getElementById('streamResolution').addEventListener('change', updateStreamSettings);
    document.getElementById('streamFPS').addEventListener('input', updateStreamSettings);
    document.getElementById('autoFpsButton').addEventListener('click', setAutoFPS);

    const fullscreenBtn = document.getElementById('fullscreenBtn');

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

    fullscreenBtn.addEventListener('click', handleFullscreen);

    document.addEventListener('fullscreenchange', () => {
        isFullscreen = !!document.fullscreenElement;
    });
    document.addEventListener('webkitfullscreenchange', () => {
        isFullscreen = !!document.webkitFullscreenElement;
    });

    socket.on('active_window', (data) => {
        streamUI.updateMeta({ win: data.title });
    });
}

function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
}

function updateSettingsDisplay(settings) {
    if (!settings) return;

    if (settings.native_width !== undefined) {
        nativeWidth = settings.native_width;
        nativeHeight = settings.native_height;
        streamUI.nativeWidth = settings.native_width;
        streamUI.nativeHeight = settings.native_height;
    }

    document.getElementById('streamBitrate').value = settings.bitrate;
    document.getElementById('streamResolution').value = settings.resolution_percentage;
    if (settings.max_fps) {
        maxFps = settings.max_fps;
        document.getElementById('streamFPS').max = maxFps;
    }
    document.getElementById('streamFPS').value = settings.target_fps;

    const bitrateVal = settings.bitrate;
    document.getElementById('bitrateValue').textContent = bitrateVal >= 1000
        ? (bitrateVal / 1000).toFixed(1) + ' mbps'
        : bitrateVal + ' kbps';

    const resPct = settings.resolution_percentage;
    const w = nativeWidth || 1920;
    const h = nativeHeight || 1080;
    const resText = resPct == 100
        ? "100% (Native)"
        : `${resPct}% (${Math.round(w * resPct / 100)} x ${Math.round(h * resPct / 100)})`;
    document.getElementById('resolutionValue').textContent = resText;

    document.getElementById('fpsValue').textContent = `(Target: ${settings.target_fps} FPS)`;
}

function updateResolutionLabel() {
    const pct = parseInt(document.getElementById('streamResolution').value);
    document.getElementById('resolutionValue').textContent = pct + '%';
}

async function updateStreamSettings() {
    const bitrate = parseInt(document.getElementById('streamBitrate').value);
    const resolutionPercentage = parseInt(document.getElementById('streamResolution').value);
    const fps = parseInt(document.getElementById('streamFPS').value);

    document.getElementById('bitrateValue').textContent = bitrate >= 1000
        ? (bitrate / 1000).toFixed(1) + ' mbps'
        : bitrate + ' kbps';
    document.getElementById('resolutionValue').textContent = resolutionPercentage + '%';
    document.getElementById('fpsValue').textContent = `(Target: ${fps} FPS)`;

    const response = await apiCall('/api/stream/settings', 'POST', {
        bitrate,
        resolution_percentage: resolutionPercentage,
        target_fps: fps
    });

    if (response) {
        updateSettingsDisplay(response);
    }
}

function setAutoFPS() {
    document.getElementById('streamFPS').value = maxFps;
    document.getElementById('fpsValue').textContent = `${maxFps} FPS`;
    updateStreamSettings();
}

function calculateStreamDimensions() {
    const w = nativeWidth || streamUI.view.videoWidth || 1920;
    const h = nativeHeight || streamUI.view.videoHeight || 1080;
    const rect = streamUI.view.getBoundingClientRect();
    const container = streamUI.container.getBoundingClientRect();

    let streamWidth = rect.width;
    let streamHeight = rect.height;

    if (isFullscreen) {
        const containerAspect = container.width / container.height;
        const streamAspect = w / h;

        if (containerAspect > streamAspect) {
            streamWidth = container.height * streamAspect;
            streamHeight = container.height;
        } else {
            streamWidth = container.width;
            streamHeight = container.width / streamAspect;
        }
    }

    const offsetX = (container.width - streamWidth) / 2;
    const offsetY = (container.height - streamHeight) / 2;

    return {
        container,
        streamWidth,
        streamHeight,
        offsetX,
        offsetY,
        scaleX: w / streamWidth,
        scaleY: h / streamHeight,
        nativeWidth: w,
        nativeHeight: h,
    };
}

export {
    initializeStream,
    streamUI,
    updateSettingsDisplay,
    updateStreamSettings,
    setAutoFPS,
    streamActive,
    isFullscreen,
    calculateStreamDimensions,
};
