// static/js/modules/audio.js
class AudioManager {
    constructor(socket) {
        this.socket = socket;
        this.audioContext = null;
        this.currentStream = null;
        this.workletNode = null;
        this.audioQueue = [];
        this.isProcessingAudio = false;

        // Default format mapping until Rust handshakes
        this.audioFormat = { rate: 48000, channels: 1, format: "int16" };
        this.playbackNode = null;

        this.currentSettings = {
            server: { rate: 48000, chunk: 4096 },
            client: { rate: 48000, chunk: 512 },
        };
        this.streamActive = {
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
            alert(`Sample rate must be between ${MIN_RATE} and ${MAX_RATE}`);
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
            await this.audioContext.audioWorklet.addModule("/static/js/modules/audio-worklet-processor.js");
        } catch (e) {
            console.error("Failed to add audio worklet module:", e);
            throw e;
        }
    }

    async updateSettings(settings) {
        const type = settings.type;
        const needsReset = JSON.stringify(this.currentSettings[type]) !== JSON.stringify(settings);

        if (needsReset) {
            await this.stopAudioStream(type, true);
            this.currentSettings[type] = { ...settings };
        }

        return needsReset;
    }

    async startAudioStream(type, settings = {}) {
        try {
            if (this.streamActive[type] && !(await this.updateSettings({ ...settings, type }))) {
                return;
            }

            await this.stopAudioStream(type, true);

            const targetRate = settings.rate || 48000;

            if (type === "client") {
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
                this.setupWorkletNode(settings.chunk || 4096);

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

                    if (this.audioContext && this.audioContext.sampleRate !== info.rate) {
                        await this.audioContext.close();
                        this.audioContext = null;
                    }
                    await this.ensureAudioContext(info.rate);

                    if (this.playbackNode) {
                        try {
                            this.playbackNode.disconnect();
                        } catch (e) {
                            console.warn("Error disconnecting old playback node:", e);
                        }
                        this.playbackNode = null;
                    }

                    await this.audioContext.audioWorklet.addModule("/static/js/modules/audio-worklet-processor.js");
                    this.playbackNode = new AudioWorkletNode(this.audioContext, "server-audio-playback-processor");
                    this.playbackNode.connect(this.audioContext.destination);
                });

                this.socket.on("server_audio_data", this.handleServerAudioData);
            }

            this.socket.emit(`start_${type}_audio`, settings);
            this.streamActive[type] = true;
        } catch (error) {
            console.error(`Error starting ${type} audio:`, error);
            await this.stopAudioStream(type);
            alert("Audio Error: " + error.message);
        }
    }

    setupWorkletNode(bufferSize) {
        this.workletNode = new AudioWorkletNode(this.audioContext, "client-audio-processor", {
            processorOptions: { bufferSize },
        });

        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === "pcmData") {
                this.audioQueue.push(event.data.pcmData);
                if (!this.isProcessingAudio) {
                    this.processAudioQueue();
                }
            }
        };
    }

    async processAudioQueue() {
        if (this.audioQueue.length === 0) {
            this.isProcessingAudio = false;
            return;
        }

        this.isProcessingAudio = true;
        const audioData = this.audioQueue.shift();

        this.socket.emit("client_audio_data", audioData, () => {
            this.processAudioQueue();
        });
    }

    handleServerAudioData(data) {
        if (!this.playbackNode) return;

        let buffer;
        if (data instanceof ArrayBuffer) {
            buffer = data;
        } else if (data && data.buffer instanceof ArrayBuffer) {
            buffer = data.buffer;
        } else if (Array.isArray(data)) {
            buffer = new Uint8Array(data).buffer;
        } else {
            return;
        }

        const view = new DataView(buffer);
        const format = this.audioFormat.format;
        const channels = this.audioFormat.channels;

        let bytesPerSample = format === "float32" ? 4 : 2;
        let frameSize = bytesPerSample * channels;
        let frameCount = Math.floor(buffer.byteLength / frameSize);

        if (frameCount === 0) return;

        const float32Samples = new Float32Array(frameCount);

        for (let i = 0; i < frameCount; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                const offset = i * frameSize + c * bytesPerSample;
                let val = format === "float32" ? view.getFloat32(offset, true) : view.getInt16(offset, true) / 32768.0;
                sum += val;
            }
            float32Samples[i] = sum / channels;
        }

        this.playbackNode.port.postMessage({ type: "pcm", samples: float32Samples }, [float32Samples.buffer]);
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
            if (this.playbackNode) {
                this.playbackNode.disconnect();
                this.playbackNode = null;
            }
        }

        if (!isResetting && this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }

        this.streamActive[type] = false;
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
        this.audioQueue = [];
        this.isProcessingAudio = false;
    }

    cleanup() {
        this.cleanupWorklet();
    }

    initializeEventListeners() {
        document.getElementById("startServerAudio").addEventListener("click", async () => {
            const settings = {
                source: document.getElementById("audioSourceSelect").value,
                rate: parseInt(document.getElementById("serverAudioRate").value),
                chunk: parseInt(document.getElementById("serverAudioChunk").value),
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
    }
}

export { AudioManager };
