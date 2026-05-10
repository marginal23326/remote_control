// static/js/modules/stream.js
import { apiCall } from './utils.js';

const streamUI = {
    container: document.getElementById('streamContainer'),
    status: document.getElementById('streamStatus'),
    view: document.getElementById('streamView'),
    fpsCounter: document.getElementById('currentFPS'),
    activeWindowText: document.getElementById('activeWindow'),
    cursorOverlay: document.getElementById('cursorOverlay'),
    nativeWidth: null,
    nativeHeight: null,

    lastObjectUrl: null,
    frameTimes: [],
    _lastFpsUpdate: 0,

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

    updateImage(blob) {
        if (this.lastObjectUrl) {
            URL.revokeObjectURL(this.lastObjectUrl);
        }
        this.lastObjectUrl = URL.createObjectURL(blob);
        this.view.src = this.lastObjectUrl;
    },

    updateFps() {
        const now = performance.now();
        this.frameTimes.push(now);
        while (this.frameTimes.length > 0 && this.frameTimes[0] <= now - 1000) {
            this.frameTimes.shift();
        }
        if (now - this._lastFpsUpdate >= 500) {
            this.fpsCounter.textContent = this.frameTimes.length;
            this._lastFpsUpdate = now;
        }
    },
    
    updateMeta(data) {
        if(Object.prototype.hasOwnProperty.call(data, 'win')) {
             this.activeWindowText.textContent = `Active Window: ${data.win || 'Unknown'}`;
        }
    },

    clear() {
        if (this.lastObjectUrl) {
            URL.revokeObjectURL(this.lastObjectUrl);
            this.lastObjectUrl = null;
        }
        this.view.src = '';
        this.fpsCounter.textContent = '0';
        this.cursorOverlay.style.display = 'none';
        this.frameTimes = [];
        this._lastFpsUpdate = 0;
    }
};

let streamActive = false;
let ws = null;
let nativeWidth, nativeHeight;
let isFullscreen = false;

function initializeStream(sessionId, socket) {
    document.getElementById('startStream').addEventListener('click', () => {
        if (!streamActive) {
            streamActive = true;
            streamUI.show();

            // Establish WebSocket Connection
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/api/stream?sid=${sessionId}`);
            ws.binaryType = "blob"; // Important: Receive data as Blob directly

            ws.onmessage = (event) => {
                if (typeof event.data === "string") {
                    // It's a JSON metadata packet
                    try {
                        const meta = JSON.parse(event.data);
                        streamUI.updateMeta(meta);
                    } catch (e) { console.error("Meta parse error", e); }
                } else {
                    // It's a binary JPEG blob
                    streamUI.updateFps();
                    streamUI.updateImage(event.data);
                }
            };

            ws.onclose = () => {
                if(streamActive) {
                    console.log("Stream socket closed unexpectedly");
                    // Optional: Auto-reconnect logic here
                }
            };

            // ... Mouse position logic (same as before) ...
            socket.on('mouse_position', (data) => {
                const dimensions = calculateStreamDimensions();
                const adjustedX = (data.x / dimensions.scaleX) + dimensions.offsetX;
                const adjustedY = (data.y / dimensions.scaleY) + dimensions.offsetY;
                streamUI.cursorOverlay.style.display = 'block';
                streamUI.cursorOverlay.style.left = `${adjustedX}px`;
                streamUI.cursorOverlay.style.top = `${adjustedY}px`;
            });
        }
    });

    document.getElementById('stopStream').addEventListener('click', async () => {
        if (streamActive) {
            streamActive = false;
            streamUI.hide();

            if (ws) {
                ws.close();
                ws = null;
            }
            await apiCall('/api/stream/stop');
            streamUI.clear();
            socket.off('mouse_position');
        }
    });

    document.getElementById('screenshot').addEventListener('click', async () => {
        streamUI.show();

        const response = await apiCall('/api/screenshot');
        if (response.status === 'success') {
            streamUI.view.src = `data:image/jpeg;base64,${response.image}`;
        }
    });

    document.getElementById('streamQuality').addEventListener('input', updateStreamSettings);
    document.getElementById('streamResolution').addEventListener('input', updateStreamSettings);
    document.getElementById('streamFPS').addEventListener('input', updateStreamSettings);
    document.getElementById('autoFpsButton').addEventListener('click', setAutoFPS);

    // Fullscreen handling
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    
    function handleFullscreen() {
        if (!isFullscreen) {
            if (streamUI.container.requestFullscreen) {
                streamUI.container.requestFullscreen();
            } else if (streamUI.container.mozRequestFullScreen) {
                streamUI.container.mozRequestFullScreen();
            } else if (streamUI.container.webkitRequestFullscreen) {
                streamUI.container.webkitRequestFullscreen();
            } else if (streamUI.container.msRequestFullscreen) {
                streamUI.container.msRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
    }

    function adjustStreamSize() {
        if (isFullscreen) {
            streamUI.container.classList.add('fullscreen');
            streamUI.container.style.display = 'none';
            void streamUI.container.offsetHeight;
            streamUI.container.style.display = 'flex';
        } else {
            streamUI.container.classList.remove('fullscreen');
            streamUI.view.style.width = '';
            streamUI.view.style.height = '';
        }
    }

    function onFullscreenChange() {
        isFullscreen = !isFullscreen;
        if (isFullscreen) {
            streamUI.view.classList.add('fullscreen');
        } else {
            streamUI.view.classList.remove('fullscreen');
        }
        adjustStreamSize();
    }

    fullscreenBtn.addEventListener('click', handleFullscreen);

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
    window.addEventListener('load', adjustStreamSize);
    window.addEventListener('resize', adjustStreamSize);
}

function calculateStreamDimensions() {
    const rect = streamUI.view.getBoundingClientRect();
    const container = streamUI.container.getBoundingClientRect();

    let streamWidth = rect.width;
    let streamHeight = rect.height;

    if (isFullscreen) {
        const containerAspect = container.width / container.height;
        const streamAspect = nativeWidth / nativeHeight;

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

function updateSettingsDisplay(settings) {
    if (!settings || settings.native_width === undefined) return;

    nativeWidth = settings.native_width;
    nativeHeight = settings.native_height;
    streamUI.nativeWidth = settings.native_width;
    streamUI.nativeHeight = settings.native_height;

    // Sync Slider Values
    document.getElementById('streamQuality').value = settings.quality;
    document.getElementById('streamResolution').value = settings.resolution_percentage;
    document.getElementById('streamFPS').value = settings.target_fps;

    // Update Labels
    document.getElementById('qualityValue').textContent = settings.quality + '%';
    
    const resPct = settings.resolution_percentage;
    const resText = resPct == 100 ? 
        "100% (Native)" : 
        `${resPct}% (${Math.round(nativeWidth * resPct / 100)} x ${Math.round(nativeHeight * resPct / 100)})`;
    document.getElementById('resolutionValue').textContent = resText;

    const fpsValue = document.getElementById('fpsValue');
    fpsValue.textContent = settings.target_fps ? 
        `(Target: ${settings.target_fps} FPS)` : 
        '(Unlimited FPS)';
}

async function updateStreamSettings() {
    const quality = document.getElementById('streamQuality').value;
    const resolutionPercentage = document.getElementById('streamResolution').value;
    const fps = document.getElementById('streamFPS').value;

    // Immediate UI feedback for labels (so it feels snappy)
    document.getElementById('qualityValue').textContent = quality + '%';
    const resText = resolutionPercentage == 100 ? 
        "100% (Native)" : 
        `${resolutionPercentage}% (${Math.round(nativeWidth * resolutionPercentage / 100)} x ${Math.round(nativeHeight * resolutionPercentage / 100)})`;
    document.getElementById('resolutionValue').textContent = resText;
    document.getElementById('fpsValue').textContent = `(Target: ${fps} FPS)`;

    // Send to server
    const response = await apiCall('/api/stream/settings', 'POST', {
        quality: parseInt(quality),
        resolution_percentage: parseInt(resolutionPercentage),
        target_fps: parseInt(fps)
    });

    if (response) {
        updateSettingsDisplay(response);
    }
}

function setAutoFPS() {
    document.getElementById('streamFPS').value = 60;
    document.getElementById('fpsValue').textContent = "60 FPS";
    updateStreamSettings();
}

export {
    initializeStream,
    streamUI,
    updateSettingsDisplay,
    updateStreamSettings,
    setAutoFPS,
    streamActive,
    isFullscreen,
    calculateStreamDimensions
};
