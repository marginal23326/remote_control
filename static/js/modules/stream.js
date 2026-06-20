import { apiCall } from "./utils.js";

const streamUI = {
    container: document.getElementById("streamContainer"),
    status: document.getElementById("streamStatus"),
    view: document.getElementById("streamView"),
    nativeWidth: null,
    nativeHeight: null,
    fpsCounter: document.getElementById("currentFPS"),
    activeWindowText: document.getElementById("activeWindow"),
    frameTimes: [],

    show() {
        this.container.classList.remove("h-0");
        this.container.classList.add("h-auto");
        this.status.classList.remove("hidden");
        this.status.classList.add("inline-flex");
    },

    hide() {
        this.container.classList.remove("h-auto");
        this.container.classList.add("h-0");
        this.status.classList.remove("inline-flex");
        this.status.classList.add("hidden");
    },

    startFpsCounter() {
        this.stopFpsCounter();
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
        if (Object.prototype.hasOwnProperty.call(data, "win")) {
            this.activeWindowText.textContent = `Active Window: ${data.win || "Unknown"}`;
        }
    },

    clear() {
        this.stopFpsCounter();
        this.fpsCounter.textContent = "0";
        this.frameTimes = [];
        if (this.view.srcObject) {
            this.view.srcObject.getTracks().forEach((t) => t.stop());
            this.view.srcObject = null;
        }
    },
};

let streamActive = false;
let peerConnection = null;
let isFullscreen = false;
let nativeWidth = null;
let nativeHeight = null;
let maxFps = 60;
let mouseMoveChannel = null;
let mouseControlChannel = null;
let pendingMouseMove = null;
let mouseInputSeq = 0;
let encoderProperties = {};
let encoderPropertyConstraints = {};
let cachedDimensions = null;
let pendingIceCandidates = [];

function removeWebRTCListeners(socket) {
    socket.off("webrtc_offer");
    socket.off("webrtc_remote_ice");
    socket.off("stream_error");
}

function initializeStream(sessionId, socket) {
    window.addEventListener("resize", () => (cachedDimensions = null));
    window.addEventListener("scroll", () => (cachedDimensions = null), { capture: true, passive: true });
    streamUI.view.addEventListener("resize", () => {
        cachedDimensions = null;
        apiCall("/api/stream/settings")
            .then(updateSettingsDisplay)
            .catch(() => {});
    });

    document.getElementById("startStream").addEventListener("click", () => {
        if (!streamActive) {
            streamActive = true;
            streamUI.show();

            socket.emit("start_stream", { sessionId });

            socket.on("webrtc_offer", async (sdpText) => {
                if (!peerConnection) {
                    peerConnection = new RTCPeerConnection({
                        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
                    });

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
                console.error("Stream error:", data.message);
                streamActive = false;
                cleanupPeerConnection();
                streamUI.hide();
                removeWebRTCListeners(socket);
            });
        }
    });

    document.getElementById("stopStream").addEventListener("click", async () => {
        if (streamActive) {
            streamActive = false;
            streamUI.hide();
            await apiCall("/api/stream/stop");
            cleanupPeerConnection();
            streamUI.clear();
            removeWebRTCListeners(socket);
        }
    });

    document.getElementById("streamBitrate").addEventListener("input", updateSliderLabels);
    document.getElementById("streamBitrate").addEventListener("change", updateStreamSettings);
    document.getElementById("streamResolution").addEventListener("input", updateSliderLabels);
    document.getElementById("streamResolution").addEventListener("change", updateStreamSettings);
    document.getElementById("streamFPS").addEventListener("input", updateSliderLabels);
    document.getElementById("streamFPS").addEventListener("change", updateStreamSettings);
    document.getElementById("autoFpsButton").addEventListener("click", setAutoFPS);

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

function updateSettingsDisplay(settings) {
    if (!settings) return;

    if (settings.native_width !== undefined) {
        nativeWidth = settings.native_width;
        nativeHeight = settings.native_height;
        streamUI.nativeWidth = settings.native_width;
        streamUI.nativeHeight = settings.native_height;
        cachedDimensions = null;
    }

    document.getElementById("streamBitrate").value = settings.bitrate;
    document.getElementById("streamResolution").value = settings.resolution_percentage;
    if (settings.max_fps) {
        maxFps = settings.max_fps;
        document.getElementById("streamFPS").max = maxFps;
    }
    document.getElementById("streamFPS").value = settings.target_fps;

    const bitrateVal = settings.bitrate;
    document.getElementById("bitrateValue").textContent =
        bitrateVal >= 1000 ? (bitrateVal / 1000).toFixed(1) + " mbps" : bitrateVal + " kbps";

    const resPct = settings.resolution_percentage;
    const w = nativeWidth || 1920;
    const h = nativeHeight || 1080;
    const resText =
        resPct == 100
            ? "100% (Native)"
            : `${resPct}% (${Math.round((w * resPct) / 100)} x ${Math.round((h * resPct) / 100)})`;
    document.getElementById("resolutionValue").textContent = resText;

    document.getElementById("fpsValue").textContent = `(Target: ${settings.target_fps} FPS)`;

    if (settings.encoder_type) {
        document.getElementById("encoderTypeLabel").textContent = settings.encoder_type;
    }
    if (settings.encoder_property_constraints) {
        encoderPropertyConstraints = { ...settings.encoder_property_constraints };
    }
    if (settings.encoder_properties) {
        encoderProperties = { ...settings.encoder_properties };
        renderEncoderProperties();
    }
}

function updateSliderLabels() {
    const bitrate = parseInt(document.getElementById("streamBitrate").value);
    const resolution = parseInt(document.getElementById("streamResolution").value);
    const fps = parseInt(document.getElementById("streamFPS").value);
    document.getElementById("bitrateValue").textContent =
        bitrate >= 1000 ? (bitrate / 1000).toFixed(1) + " mbps" : bitrate + " kbps";
    document.getElementById("resolutionValue").textContent = resolution + "%";
    document.getElementById("fpsValue").textContent = `(Target: ${fps} FPS)`;
}

async function updateStreamSettings(includeEncoderProps = false) {
    const bitrate = parseInt(document.getElementById("streamBitrate").value);
    const resolutionPercentage = parseInt(document.getElementById("streamResolution").value);
    const fps = parseInt(document.getElementById("streamFPS").value);

    const payload = {
        bitrate,
        resolution_percentage: resolutionPercentage,
        target_fps: fps,
    };

    if (includeEncoderProps) {
        payload.encoder_properties = readEncoderPropsFromDOM();
    }

    const response = await apiCall("/api/stream/settings", "POST", payload);
    updateSettingsDisplay(response);
}

function setAutoFPS() {
    document.getElementById("streamFPS").value = maxFps;
    document.getElementById("fpsValue").textContent = `${maxFps} FPS`;
    updateStreamSettings();
}

function renderEncoderProperties() {
    const tbody = document.getElementById("encoderPropsList");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const [key, value] of Object.entries(encoderProperties)) {
        const row = document.createElement("tr");
        row.className = "group";
        const constraint = encoderPropertyConstraints[key];
        let valHtml;
        if (constraint) {
            if (constraint.value_type === "enum") {
                const options = (constraint.enum_values || [])
                    .map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${v}</option>`)
                    .join("");
                valHtml = `<select class="prop-val w-full px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200">${options}</select>`;
            } else if (constraint.value_type === "int") {
                valHtml = `<input type="number" class="prop-val w-full px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200" value="${escHtml(value)}"${constraint.min != null ? ' min="' + constraint.min + '"' : ""}${constraint.max != null ? ' max="' + constraint.max + '"' : ""}>`;
            } else if (constraint.value_type === "bool") {
                const checked = value === "true" ? "checked" : "";
                valHtml = `<input type="checkbox" class="prop-val w-4 h-4 accent-blue-500 mt-1" ${checked}>`;
            } else {
                valHtml = `<input type="text" class="prop-val w-full px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200" value="${escHtml(value)}">`;
            }
        } else {
            valHtml = `<input type="text" class="prop-val w-full px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200" value="${escHtml(value)}">`;
        }
        row.innerHTML = `
            <td class="pr-2"><input type="text" class="prop-key w-full px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200 focus:border-blue-500" value="${escHtml(key)}"></td>
            <td class="pr-2">${valHtml}</td>
            <td><button class="prop-remove px-2 py-1 text-xs text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove property">&times;</button></td>
        `;
        row.querySelector(".prop-remove").addEventListener("click", () => {
            delete encoderProperties[key];
            renderEncoderProperties();
        });
        row.querySelector(".prop-key").addEventListener("change", (e) => {
            const newKey = e.target.value.trim();
            if (newKey && newKey !== key) {
                delete encoderProperties[key];
                encoderProperties[newKey] = getRowValue(row);
                renderEncoderProperties();
            }
        });
        const valInput = row.querySelector(".prop-val");
        if (valInput && valInput.tagName === "INPUT" && valInput.type !== "checkbox") {
            valInput.addEventListener("change", () => {
                encoderProperties[key] = getValFromInput(valInput);
            });
        } else if (valInput && valInput.tagName === "SELECT") {
            valInput.addEventListener("change", () => {
                encoderProperties[key] = valInput.value;
            });
        }
        tbody.appendChild(row);
    }
}

function getValFromInput(input) {
    if (input.tagName === "SELECT") return input.value;
    if (input.type === "checkbox") return input.checked ? "true" : "false";
    if (input.type === "number" || input.type === "range") return String(input.value);
    return input.value.trim();
}

function getRowValue(row) {
    const input = row.querySelector(".prop-val");
    return input ? getValFromInput(input) : "";
}

function escHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readEncoderPropsFromDOM() {
    const props = {};
    const warnings = [];
    document.querySelectorAll("#encoderPropsList tr").forEach((row) => {
        const key = row.querySelector(".prop-key")?.value?.trim();
        if (!key) return;
        const valInput = row.querySelector(".prop-val");
        if (!valInput) return;
        let val = getValFromInput(valInput);
        if (!val && valInput.type !== "checkbox") return;
        const constraint = encoderPropertyConstraints[key];
        if (constraint) {
            if (constraint.value_type === "int") {
                const num = parseInt(val, 10);
                if (isNaN(num)) {
                    warnings.push(`"${key}": not a valid integer`);
                    return;
                }
                if (constraint.min != null && num < constraint.min) {
                    warnings.push(`"${key}": ${num} is below minimum ${constraint.min}`);
                    return;
                }
                if (constraint.max != null && num > constraint.max) {
                    warnings.push(`"${key}": ${num} exceeds maximum ${constraint.max}`);
                    return;
                }
                val = String(num);
            } else if (constraint.value_type === "enum") {
                if (!constraint.enum_values || !constraint.enum_values.includes(val)) {
                    warnings.push(`"${key}": "${val}" is not a valid option`);
                    return;
                }
            } else if (constraint.value_type === "bool") {
                val = val === "true" ? "true" : "false";
            }
        }
        props[key] = val;
    });
    encoderProperties = props;
    if (warnings.length) {
        console.warn("Encoder property validation warnings:", warnings);
    }
    return props;
}

document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("advancedToggle");
    const panel = document.getElementById("advancedSettingsPanel");
    const icon = document.getElementById("advancedToggleIcon");
    if (toggle && panel) {
        toggle.addEventListener("click", () => {
            panel.classList.toggle("hidden");
            icon.classList.toggle("-rotate-180");
        });
    }

    const addBtn = document.getElementById("addEncoderProp");
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            const knownKeys = Object.keys(encoderPropertyConstraints);
            const addedKeys = Object.keys(encoderProperties);
            const available = knownKeys.filter((k) => !addedKeys.includes(k));
            if (available.length === 0) {
                const key = prompt("Enter property name:");
                if (key && key.trim()) {
                    encoderProperties[key.trim()] = "";
                    renderEncoderProperties();
                }
                return;
            }
            const container = addBtn.parentElement;
            const existing = document.getElementById("addPropRow");
            if (existing) existing.remove();
            const row = document.createElement("div");
            row.id = "addPropRow";
            row.className = "flex gap-2 items-center mt-2 pt-2 border-t border-white/5";
            row.innerHTML = `
                <select id="addPropSelect" class="flex-1 px-2 py-1 bg-black/40 border border-gray-700 rounded text-xs font-mono text-gray-200">
                    ${available.map((k) => `<option value="${k}">${k}</option>`).join("")}
                </select>
                <button id="confirmAddProp" class="px-2 py-1 text-xs rounded bg-blue-600/30 hover:bg-blue-600/40 text-blue-300 border border-blue-500/30 transition-all">Add</button>
                <button id="cancelAddProp" class="px-2 py-1 text-xs rounded bg-gray-600/30 hover:bg-gray-600/40 text-gray-300 border border-gray-500/30 transition-all">Cancel</button>
            `;
            container.appendChild(row);
            document.getElementById("confirmAddProp").addEventListener("click", () => {
                const k = document.getElementById("addPropSelect").value;
                encoderProperties[k] = encoderPropertyConstraints[k]?.value_type === "bool" ? "false" : "";
                renderEncoderProperties();
                row.remove();
            });
            document.getElementById("cancelAddProp").addEventListener("click", () => row.remove());
        });
    }

    const applyBtn = document.getElementById("applyEncoderProps");
    if (applyBtn) {
        applyBtn.addEventListener("click", () => {
            readEncoderPropsFromDOM();
            updateStreamSettings(true);
        });
    }
});

function calculateStreamDimensions() {
    if (cachedDimensions) return cachedDimensions;

    const w = nativeWidth || streamUI.view.videoWidth || 1920;
    const h = nativeHeight || streamUI.view.videoHeight || 1080;
    const container = streamUI.container.getBoundingClientRect();

    const containerAspect = container.width / container.height;
    const streamAspect = w / h;

    let streamWidth, streamHeight;

    if (containerAspect > streamAspect) {
        streamHeight = container.height;
        streamWidth = container.height * streamAspect;
    } else {
        streamWidth = container.width;
        streamHeight = container.width / streamAspect;
    }

    const offsetX = (container.width - streamWidth) / 2;
    const offsetY = (container.height - streamHeight) / 2;

    cachedDimensions = {
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

    return cachedDimensions;
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
    sendMouseEventOverDataChannel,
};
