import { showNotification } from "@/shared/feedback";
import { bindMediaSessionReconnect } from "@/shared/media-session";
import AudioConverterWorker from "./audio-converter.worker.ts?worker";
import audioWorkletProcessorUrl from "./audio-worklet-processor.ts?worker&url";
import type { AppSocket } from "@/core/socket";
import type { AudioFormat } from "@/shared/types";
import type { AudioStartPayload } from "@/core/socket-events";

const MIN_RATE = 3000;
const MAX_RATE = 768_000;

type AudioKind = "server" | "client";

const AUDIO_KIND_CONFIG = {
    client: { toggleButtonId: "toggleClientAudio", startEvent: "start_client_audio", stopEvent: "stop_client_audio" },
    server: { toggleButtonId: "toggleServerAudio", startEvent: "start_server_audio", stopEvent: "stop_server_audio" },
} as const;

interface AudioKindSettings {
    rate: number;
    chunk?: number;
    source?: string;
    device_id?: string | null;
}

function settingsEqual(a: AudioKindSettings, b: AudioKindSettings): boolean {
    return a.rate === b.rate && a.chunk === b.chunk && a.source === b.source && a.device_id === b.device_id;
}

interface WorkletPortMessage {
    type: string;
    pcmData?: ArrayBuffer;
}

class AudioManager {
    socket: AppSocket;
    audioContext: AudioContext | null;
    currentStream: MediaStream | null;
    workletNode: AudioWorkletNode | null;
    serverAudioWorker: Worker | null;
    audioWorkletModulePromise: Promise<void> | null;
    audioFormat: AudioFormat;
    playbackNode: AudioWorkletNode | null;
    currentSettings: Record<AudioKind, AudioKindSettings>;
    streamActive: Record<AudioKind, boolean>;

    constructor(socket: AppSocket) {
        this.socket = socket;
        this.audioContext = null;
        this.currentStream = null;
        this.workletNode = null;
        this.serverAudioWorker = null;
        this.audioWorkletModulePromise = null;

        this.audioFormat = { channels: 1, format: "int16", rate: 48000 };
        this.playbackNode = null;

        this.currentSettings = {
            client: { chunk: 512, rate: 48000 },
            server: { rate: 48000 },
        };
        this.streamActive = {
            client: false,
            server: false,
        };

        this.initializeEventListeners();
    }

    async ensureAudioContext(sampleRate: number): Promise<void> {
        if (this.audioContext && this.audioContext.sampleRate !== sampleRate) {
            await this.audioContext.close();
            this.audioContext = null;
            this.audioWorkletModulePromise = null;
        }

        this.audioContext ??= new AudioContext({ sampleRate });

        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }
    }

    async initializeAudioWorklet(): Promise<void> {
        try {
            if (this.workletNode) {
                this.cleanupWorklet();
            }
            await this.ensureAudioWorkletModule();
        } catch (error) {
            console.error("Failed to add audio worklet module:", error);
            throw error;
        }
    }

    async ensureAudioWorkletModule(): Promise<void> {
        this.audioWorkletModulePromise ??= this.audioContext!.audioWorklet.addModule(audioWorkletProcessorUrl).catch(
            (error) => {
                this.audioWorkletModulePromise = null;
                throw error;
            },
        );

        await this.audioWorkletModulePromise;
    }

    async startAudioStream(type: AudioKind, settings: Partial<AudioKindSettings> = {}): Promise<void> {
        try {
            const targetSettings: AudioKindSettings = { ...this.currentSettings[type], ...settings };
            const settingsChanged = !settingsEqual(this.currentSettings[type], targetSettings);

            if (this.streamActive[type]) {
                if (!settingsChanged) {
                    this.updateAudioToggleButton(type);
                    return;
                }
                await this.stopAudioStream(type, true);
            }

            this.currentSettings[type] = targetSettings;
            targetSettings.rate = Math.max(MIN_RATE, Math.min(MAX_RATE, targetSettings.rate || 48_000));

            if (type === "client") {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    throw new Error(
                        "Microphone access requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                    );
                }

                const rateInput = document.getElementById("clientAudioRate") as HTMLInputElement | null;
                if (rateInput) rateInput.value = String(targetSettings.rate);

                await this.ensureAudioContext(targetSettings.rate);
                this.currentStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        autoGainControl: true,
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: targetSettings.rate,
                    },
                });

                if (!this.currentStream) throw new Error("Microphone access denied");

                await this.initializeAudioWorklet();
                this.setupWorkletNode(targetSettings.chunk || 4096);

                const source = this.audioContext!.createMediaStreamSource(this.currentStream);
                source.connect(this.workletNode!);
            }

            if (type === "server") {
                this.socket.off("server_audio_data", this.handleServerAudioData);
                this.socket.off("server_audio_format");

                this.socket.on("server_audio_format", async (info) => {
                    this.audioFormat = {
                        channels: info.channels,
                        format: info.format,
                        rate: info.rate,
                    };

                    const rateInput = document.getElementById("serverAudioRate") as HTMLInputElement | null;
                    if (rateInput) rateInput.value = String(info.rate);

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
                    this.playbackNode = new AudioWorkletNode(this.audioContext!, "server-audio-playback-processor");
                    this.playbackNode.connect(this.audioContext!.destination);
                    this.ensureServerAudioWorker();
                });

                this.socket.on("server_audio_data", this.handleServerAudioData);
            }

            const payload: AudioStartPayload = targetSettings;
            this.socket.emit(AUDIO_KIND_CONFIG[type].startEvent, payload);
            this.streamActive[type] = true;
            this.updateAudioToggleButton(type);
        } catch (error) {
            console.error(`Error starting ${type} audio:`, error);
            await this.stopAudioStream(type, true);
            showNotification(`Audio Error: ${(error as Error).message}`, "error");
        }
    }

    async refreshAudioSources(): Promise<void> {
        const select = document.getElementById("audioSourceSelect") as HTMLSelectElement | null;
        if (!select) return;

        let sources: { id: string; name: string; kind: string }[] = [];
        try {
            sources = await new Promise((resolve, reject) => {
                this.socket.once("audio_sources", (data) => {
                    resolve(data.sources || []);
                });
                this.socket.once("audio_sources_error", (data) => {
                    reject(new Error(data?.message));
                });
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
        micGroup.append(defaultMic);

        const defaultSystem = new Option("Default Output", "system");
        defaultSystem.dataset.kind = "system";
        systemGroup.append(defaultSystem);

        for (const source of sources) {
            const option = new Option(source.name, source.id);
            option.dataset.kind = source.kind;
            (source.kind === "system" ? systemGroup : micGroup).append(option);
        }

        select.append(micGroup);
        select.append(systemGroup);

        if ([...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
        }
    }

    updateAudioToggleButton(type: AudioKind, active: boolean = this.streamActive[type]): void {
        const button = document.getElementById(AUDIO_KIND_CONFIG[type].toggleButtonId);
        if (!button) return;

        button.textContent = active ? "Stop" : "Start";
        button.classList.toggle("bg-zinc-100", !active);
        button.classList.toggle("hover:bg-white", !active);
        button.classList.toggle("text-zinc-900", !active);
        button.classList.toggle("bg-zinc-800", active);
        button.classList.toggle("hover:bg-zinc-700", active);
        button.classList.toggle("text-zinc-100", active);
    }

    setupWorkletNode(bufferSize: number): void {
        this.workletNode = new AudioWorkletNode(this.audioContext!, "client-audio-processor", {
            processorOptions: { bufferSize },
        });

        this.workletNode.port.onmessage = (event: MessageEvent<WorkletPortMessage>) => {
            if (event.data.type === "pcmData") {
                this.socket.emit("client_audio_data", event.data.pcmData!);
            }
        };
    }

    ensureServerAudioWorker(): void {
        if (this.serverAudioWorker) return;

        this.serverAudioWorker = new AudioConverterWorker();
        this.serverAudioWorker.addEventListener(
            "message",
            (event: MessageEvent<{ type: string; samples: Float32Array }>) => {
                const { type, samples } = event.data;

                if (type === "pcm") {
                    if (!this.playbackNode) return;
                    this.playbackNode.port.postMessage({ samples, type: "pcm" }, [samples.buffer]);
                }
            },
        );
        this.serverAudioWorker.postMessage({ format: this.audioFormat, type: "format" });
    }

    handleServerAudioData = (data: ArrayBuffer | ArrayBufferView | number[]): void => {
        let buffer: ArrayBuffer;
        if (data instanceof ArrayBuffer) {
            buffer = data;
        } else if (ArrayBuffer.isView(data)) {
            buffer =
                data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                    ? (data.buffer as ArrayBuffer)
                    : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else if (Array.isArray(data)) {
            buffer = new Uint8Array(data).buffer;
        } else {
            return;
        }

        if (buffer.byteLength === 0) return;

        this.ensureServerAudioWorker();
        this.serverAudioWorker!.postMessage({ buffer, type: "pcm" }, [buffer]);
    };

    async stopAudioStream(type: AudioKind, isResetting = false): Promise<void> {
        if (!this.streamActive[type] && !isResetting) {
            return;
        }

        this.socket.emit(AUDIO_KIND_CONFIG[type].stopEvent);

        if (type === "client") {
            this.cleanupWorklet();
        } else if (type === "server") {
            this.socket.off("server_audio_data", this.handleServerAudioData);
            this.socket.off("server_audio_format");
            this.cleanupServerPlayback();
        }

        this.streamActive[type] = false;
        this.updateAudioToggleButton(type);

        if (!isResetting && !this.streamActive.server && !this.streamActive.client && this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
            this.audioWorkletModulePromise = null;
        }
    }

    cleanupWorklet(): void {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach((track) => {
                track.stop();
            });
            this.currentStream = null;
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode.port.close();
            this.workletNode = null;
        }
    }

    cleanupServerPlayback(): void {
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

    getServerAudioSettingsFromForm(): AudioKindSettings {
        const select = document.getElementById("audioSourceSelect") as HTMLSelectElement;
        const selected = select.selectedOptions[0]!;
        const isDefault = selected.value === "mic" || selected.value === "system";

        return {
            device_id: isDefault ? null : selected.value,
            rate: parseInt((document.getElementById("serverAudioRate") as HTMLInputElement).value, 10),
            source: selected.dataset.kind ?? "mic",
        };
    }

    initializeEventListeners(): void {
        document.getElementById("toggleServerAudio")!.addEventListener("click", async (e) => {
            if ((e.currentTarget as HTMLElement).textContent?.trim() === "Stop") {
                await this.stopAudioStream("server");
                return;
            }

            await this.startAudioStream("server", this.getServerAudioSettingsFromForm());
        });

        document.getElementById("audioSourceSelect")!.addEventListener("change", () => {
            const targetSettings = { ...this.currentSettings.server, ...this.getServerAudioSettingsFromForm() };
            const matchesRunning =
                this.streamActive.server && settingsEqual(this.currentSettings.server, targetSettings);
            this.updateAudioToggleButton("server", matchesRunning);
        });

        document.getElementById("toggleClientAudio")!.addEventListener("click", async (e) => {
            if ((e.currentTarget as HTMLElement).textContent?.trim() === "Stop") {
                await this.stopAudioStream("client");
                return;
            }

            const settings: AudioKindSettings = {
                chunk: parseInt((document.getElementById("clientAudioChunk") as HTMLInputElement).value, 10),
                rate: parseInt((document.getElementById("clientAudioRate") as HTMLInputElement).value, 10),
            };
            await this.startAudioStream("client", settings);
        });

        this.socket.on("connect", () => {
            void this.refreshAudioSources();
        });

        (["server", "client"] as const).forEach((kind) => {
            bindMediaSessionReconnect(this.socket, {
                isActive: () => this.streamActive[kind],
                onDisconnect: () => {
                    void this.stopAudioStream(kind, true);
                },
                onReconnect: () => {
                    void this.startAudioStream(kind, this.currentSettings[kind]);
                },
            });
        });

        if (this.socket.connected) {
            void this.refreshAudioSources();
        }
    }
}

export { AudioManager };
