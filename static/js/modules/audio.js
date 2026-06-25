// static/js/modules/audio.js
class AudioManager {
    constructor(socket) {
        this.socket = socket;
        this.audioContext = null;
        this.currentStream = null;
        this.workletNode = null;

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
                        "Microphone access is restricted to Secure Contexts (HTTPS or localhost).\n\n" +
                            'See "Secure Context Workaround" in the README for HTTP access.',
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

            this.socket.emit(`start_${type}_audio`, targetSettings);
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
                this.socket.emit("client_audio_data", event.data.pcmData);
            }
        };
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

        this.streamActive[type] = false;

        if (!isResetting && !this.streamActive["server"] && !this.streamActive["client"] && this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
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
            if (this.wasActive.server) {
                this.wasActive.server = false;
                this.startAudioStream("server", this.currentSettings.server);
            }
            if (this.wasActive.client) {
                this.wasActive.client = false;
                this.startAudioStream("client", this.currentSettings.client);
            }
        });
    }
}

export { AudioManager };
