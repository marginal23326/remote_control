// static/js/modules/audio.js
import { showNotification } from "./dom.js";

class AudioManager {
    constructor(socket) {
        this.socket = socket;
        this.audioContext = null;
        this.currentStream = null;
        this.workletNode = null;
        this.serverAudioWorker = null;
        this.audioWorkletModulePromise = null;

        // Default format mapping until Rust handshakes
        this.audioFormat = { rate: 48000, channels: 1, format: "int16" };
        this.playbackNode = null;

        this.currentSettings = {
            server: { rate: 48000 },
            client: { rate: 48000, chunk: 512 },
        };
        this.streamActive = {
            server: false,
            client: false,
        };
        this.wasActive = {
            server: false,
            client: false,
        };

        this.handleServerAudioData = this.handleServerAudioData.bind(this);
        this.initializeEventListeners();
    }

    validateSampleRate(rate) {
        const MIN_RATE = 3000;
        const MAX_RATE = 768000;
        if (rate < MIN_RATE || rate > MAX_RATE) {
            showNotification(`Sample rate must be between ${MIN_RATE} and ${MAX_RATE}`, "error");
            return false;
        }
        return true;
    }

    async ensureAudioContext(sampleRate) {
        if (!this.validateSampleRate(sampleRate)) {
            return false;
        }

        if (this.audioContext) {
            if (this.audioContext.sampleRate !== sampleRate) {
                await this.audioContext.close();
                this.audioContext = null;
                this.audioWorkletModulePromise = null;
            }
        }

        if (!this.audioContext) {
            this.audioContext = new AudioContext({ sampleRate });
        }

        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }

        return true;
    }

    async initializeAudioWorklet() {
        try {
            if (this.workletNode) {
                this.cleanupWorklet();
            }
            await this.ensureAudioWorkletModule();
        } catch (e) {
            console.error("Failed to add audio worklet module:", e);
            throw e;
        }
    }

    async ensureAudioWorkletModule() {
        if (!this.audioWorkletModulePromise) {
            this.audioWorkletModulePromise = this.audioContext.audioWorklet
                .addModule("/static/js/modules/audio-worklet-processor.js")
                .catch((error) => {
                    this.audioWorkletModulePromise = null;
                    throw error;
                });
        }

        await this.audioWorkletModulePromise;
    }

    async startAudioStream(type, settings = {}) {
        try {
            const targetSettings = { ...this.currentSettings[type], ...settings };
            const settingsChanged = JSON.stringify(this.currentSettings[type]) !== JSON.stringify(targetSettings);

            if (this.streamActive[type]) {
                if (!settingsChanged) {
                    return;
                }
                await this.stopAudioStream(type, true);
            }

            this.currentSettings[type] = targetSettings;
            const targetRate = targetSettings.rate || 48000;

            if (type === "client") {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    throw new Error(
                        "Microphone access requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                    );
                }

                await this.ensureAudioContext(targetRate);
                this.currentStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        sampleRate: targetRate,
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });

                if (!this.currentStream) throw new Error("Microphone access denied");

                await this.initializeAudioWorklet();
                this.setupWorkletNode(targetSettings.chunk || 4096);

                const source = this.audioContext.createMediaStreamSource(this.currentStream);
                source.connect(this.workletNode);
            }

            if (type === "server") {
                this.socket.off("server_audio_data", this.handleServerAudioData);
                this.socket.off("server_audio_format");

                this.socket.on("server_audio_format", async (info) => {
                    this.audioFormat = {
                        rate: info.rate,
                        channels: info.channels,
                        format: info.format,
                    };

                    const rateInput = document.getElementById("serverAudioRate");
                    if (rateInput) rateInput.value = info.rate;

                    if (this.playbackNode || this.serverAudioWorker) {
                        this.cleanupServerPlayback();
                    }

                    if (this.audioContext && this.audioContext.sampleRate !== info.rate) {
                        await this.audioContext.close();
                        this.audioContext = null;
                        this.audioWorkletModulePromise = null;
                    }
                    await this.ensureAudioContext(info.rate);

                    await this.ensureAudioWorkletModule();
                    this.playbackNode = new AudioWorkletNode(this.audioContext, "server-audio-playback-processor");
                    this.playbackNode.connect(this.audioContext.destination);
                    this.ensureServerAudioWorker();
                });

                this.socket.on("server_audio_data", this.handleServerAudioData);
            }

            this.socket.emit(`start_${type}_audio`, targetSettings);
            this.streamActive[type] = true;
        } catch (error) {
            console.error(`Error starting ${type} audio:`, error);
            this.streamActive[type] = true;
            await this.stopAudioStream(type);
            showNotification("Audio Error: " + error.message, "error");
        }
    }

    async refreshAudioSources() {
        const select = document.getElementById("audioSourceSelect");
        if (!select) return;

        let sources = [];
        try {
            sources = await new Promise((resolve, reject) => {
                this.socket.once("audio_sources", (data) => resolve(data.sources || []));
                this.socket.once("audio_sources_error", (data) => reject(new Error(data?.message)));
                this.socket.emit("list_audio_sources");
            });
        } catch (error) {
            console.error("Failed to load audio sources:", error);
            return;
        }

        const previousValue = select.value;

        select.innerHTML = "";
        const micGroup = document.createElement("optgroup");
        micGroup.label = "Microphone";
        const systemGroup = document.createElement("optgroup");
        systemGroup.label = "System Sound";

        const defaultMic = new Option("Default Microphone", "mic");
        defaultMic.dataset.kind = "mic";
        micGroup.appendChild(defaultMic);

        const defaultSystem = new Option("Default Output", "system");
        defaultSystem.dataset.kind = "system";
        systemGroup.appendChild(defaultSystem);

        for (const source of sources) {
            const option = new Option(source.name, source.id);
            option.dataset.kind = source.kind;
            (source.kind === "system" ? systemGroup : micGroup).appendChild(option);
        }

        select.appendChild(micGroup);
        select.appendChild(systemGroup);

        if ([...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
        }
    }

    setupWorkletNode(bufferSize) {
        this.workletNode = new AudioWorkletNode(this.audioContext, "client-audio-processor", {
            processorOptions: { bufferSize },
        });

        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === "pcmData") {
                this.socket.emit("client_audio_data", event.data.pcmData);
            }
        };
    }

    ensureServerAudioWorker() {
        if (this.serverAudioWorker) return;

        this.serverAudioWorker = new Worker("/static/js/modules/server-audio-converter-worker.js");
        this.serverAudioWorker.onmessage = (event) => {
            const { type, samples } = event.data;

            if (type === "pcm") {
                if (!this.playbackNode) return;
                this.playbackNode.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
            }
        };
        this.serverAudioWorker.postMessage({ type: "format", format: this.audioFormat });
    }

    handleServerAudioData(data) {
        let buffer;
        if (data instanceof ArrayBuffer) {
            buffer = data;
        } else if (ArrayBuffer.isView(data)) {
            buffer =
                data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                    ? data.buffer
                    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else if (Array.isArray(data)) {
            buffer = new Uint8Array(data).buffer;
        } else {
            return;
        }

        if (buffer.byteLength === 0) return;

        this.ensureServerAudioWorker();
        this.serverAudioWorker.postMessage({ type: "pcm", buffer }, [buffer]);
    }

    async stopAudioStream(type, isResetting = false) {
        if (!this.streamActive[type] && !isResetting) {
            return;
        }

        this.socket.emit(`stop_${type}_audio`);

        if (type === "client") {
            this.cleanupWorklet();
        } else if (type === "server") {
            this.socket.off("server_audio_data", this.handleServerAudioData);
            this.socket.off("server_audio_format");
            this.cleanupServerPlayback();
        }

        this.streamActive[type] = false;

        if (!isResetting && !this.streamActive["server"] && !this.streamActive["client"] && this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
            this.audioWorkletModulePromise = null;
        }
    }

    cleanupWorklet() {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach((track) => track.stop());
            this.currentStream = null;
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode.port.close();
            this.workletNode = null;
        }
    }

    cleanupServerPlayback() {
        if (this.playbackNode) {
            this.playbackNode.disconnect();
            this.playbackNode.port.close();
            this.playbackNode = null;
        }

        if (this.serverAudioWorker) {
            this.serverAudioWorker.terminate();
            this.serverAudioWorker = null;
        }
    }

    initializeEventListeners() {
        document.getElementById("startServerAudio").addEventListener("click", async () => {
            const select = document.getElementById("audioSourceSelect");
            const selected = select.selectedOptions[0];
            const isDefault = selected.value === "mic" || selected.value === "system";

            const settings = {
                source: selected.dataset.kind || "mic",
                device_id: isDefault ? null : selected.value,
                rate: parseInt(document.getElementById("serverAudioRate").value),
            };
            await this.startAudioStream("server", settings);
        });

        document.getElementById("stopServerAudio").addEventListener("click", () => {
            this.stopAudioStream("server");
        });

        document.getElementById("startClientAudio").addEventListener("click", async () => {
            const settings = {
                rate: parseInt(document.getElementById("clientAudioRate").value),
                chunk: parseInt(document.getElementById("clientAudioChunk").value),
            };
            await this.startAudioStream("client", settings);
        });

        document.getElementById("stopClientAudio").addEventListener("click", () => {
            this.stopAudioStream("client");
        });

        this.socket.on("disconnect", () => {
            if (this.streamActive.server) {
                this.wasActive.server = true;
                this.stopAudioStream("server", true);
            }
            if (this.streamActive.client) {
                this.wasActive.client = true;
                this.stopAudioStream("client", true);
            }
        });

        this.socket.on("connect", () => {
            this.refreshAudioSources();

            if (this.wasActive.server) {
                this.wasActive.server = false;
                this.startAudioStream("server", this.currentSettings.server);
            }
            if (this.wasActive.client) {
                this.wasActive.client = false;
                this.startAudioStream("client", this.currentSettings.client);
            }
        });

        if (this.socket.connected) {
            this.refreshAudioSources();
        }
    }
}

export { AudioManager };
