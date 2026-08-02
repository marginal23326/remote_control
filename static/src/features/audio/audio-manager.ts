import { byId, onAsync, toggleClasses } from "@/shared/dom-helpers";
import { showNotification } from "@/shared/feedback";
import { bindMediaSessionReconnect } from "@/shared/media-session";
import AudioConverterWorker from "./audio-converter.worker.ts?worker";
import audioWorkletProcessorUrl from "./audio-worklet-processor.ts?worker&url";
import type { AppSocket } from "@/core/socket";
import type { AudioSourceInfo, AudioFormat } from "@/shared/types";
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

let audioContext: AudioContext | null = null;
let currentStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let serverAudioWorker: Worker | null = null;
let audioWorkletModulePromise: Promise<void> | null = null;
let audioFormat: AudioFormat = { channels: 1, rate: 48000 };
let playbackNode: AudioWorkletNode | null = null;

const currentSettings: Record<AudioKind, AudioKindSettings> = {
    client: { chunk: 512, rate: 48000 },
    server: { rate: 48000 },
};
const streamActive: Record<AudioKind, boolean> = {
    client: false,
    server: false,
};

async function ensureAudioContext(sampleRate: number): Promise<void> {
    if (audioContext && audioContext.sampleRate !== sampleRate) {
        await audioContext.close();
        audioContext = null;
        audioWorkletModulePromise = null;
    }

    audioContext ??= new AudioContext({ sampleRate });

    if (audioContext.state === "suspended") {
        await audioContext.resume();
    }
}

async function initializeAudioWorklet(): Promise<void> {
    try {
        if (workletNode) {
            cleanupWorklet();
        }
        await ensureAudioWorkletModule();
    } catch (error) {
        console.error("Failed to add audio worklet module:", error);
        throw error;
    }
}

async function ensureAudioWorkletModule(): Promise<void> {
    audioWorkletModulePromise ??= audioContext!.audioWorklet.addModule(audioWorkletProcessorUrl).catch((error) => {
        audioWorkletModulePromise = null;
        throw error;
    });

    await audioWorkletModulePromise;
}

async function startAudioStream(
    socket: AppSocket,
    type: AudioKind,
    settings: Partial<AudioKindSettings> = {},
): Promise<void> {
    try {
        const targetSettings: AudioKindSettings = { ...currentSettings[type], ...settings };
        const settingsChanged = !settingsEqual(currentSettings[type], targetSettings);

        if (streamActive[type]) {
            if (!settingsChanged) {
                updateAudioToggleButton(type);
                return;
            }
            await stopAudioStream(socket, type, true);
        }

        currentSettings[type] = targetSettings;
        targetSettings.rate = Math.max(MIN_RATE, Math.min(MAX_RATE, targetSettings.rate || 48_000));

        if (type === "client") {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error(
                    "Microphone access requires a Secure Context (HTTPS or localhost). See the README for the Chrome flag workaround.",
                );
            }

            const rateInput = byId<HTMLInputElement>("clientAudioRate");
            if (rateInput) rateInput.value = String(targetSettings.rate);

            await ensureAudioContext(targetSettings.rate);
            currentStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    autoGainControl: true,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: targetSettings.rate,
                },
            });

            if (!currentStream) throw new Error("Microphone access denied");

            await initializeAudioWorklet();
            setupWorkletNode(socket, targetSettings.chunk || 4096);

            const source = audioContext!.createMediaStreamSource(currentStream);
            source.connect(workletNode!);
        }

        if (type === "server") {
            socket.off("server_audio_data", handleServerAudioData);
            socket.off("server_audio_format");

            socket.on("server_audio_format", async (info) => {
                audioFormat = {
                    channels: info.channels,
                    rate: info.rate,
                };

                const rateInput = byId<HTMLInputElement>("serverAudioRate");
                if (rateInput) rateInput.value = String(info.rate);

                if (playbackNode || serverAudioWorker) {
                    cleanupServerPlayback();
                }

                if (audioContext && audioContext.sampleRate !== info.rate) {
                    await audioContext.close();
                    audioContext = null;
                    audioWorkletModulePromise = null;
                }
                await ensureAudioContext(info.rate);

                await ensureAudioWorkletModule();
                playbackNode = new AudioWorkletNode(audioContext!, "server-audio-playback-processor");
                playbackNode.connect(audioContext!.destination);
                ensureServerAudioWorker();
            });

            socket.on("server_audio_data", handleServerAudioData);
        }

        const payload: AudioStartPayload = {
            device_id: targetSettings.device_id,
            rate: targetSettings.rate,
            source: targetSettings.source,
        };
        socket.emit(AUDIO_KIND_CONFIG[type].startEvent, payload);
        streamActive[type] = true;
        updateAudioToggleButton(type);
    } catch (error) {
        console.error(`Error starting ${type} audio:`, error);
        await stopAudioStream(socket, type, true);
        showNotification(`Audio Error: ${(error as Error).message}`, "error");
    }
}

async function refreshAudioSources(socket: AppSocket): Promise<void> {
    const select = byId<HTMLSelectElement>("audioSourceSelect");
    if (!select) return;

    let sources: AudioSourceInfo[] = [];
    try {
        sources = await new Promise((resolve, reject) => {
            socket.once("audio_sources", (data) => {
                resolve(data.sources || []);
            });
            socket.once("audio_sources_error", (data) => {
                reject(new Error(data?.message));
            });
            socket.emit("list_audio_sources");
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

function updateAudioToggleButton(type: AudioKind, active: boolean = streamActive[type]): void {
    const button = byId(AUDIO_KIND_CONFIG[type].toggleButtonId);
    if (!button) return;

    button.textContent = active ? "Stop" : "Start";
    toggleClasses(
        button,
        active,
        ["bg-zinc-800", "hover:bg-zinc-700", "text-zinc-100"],
        ["bg-zinc-100", "hover:bg-white", "text-zinc-900"],
    );
}

function setupWorkletNode(socket: AppSocket, bufferSize: number): void {
    workletNode = new AudioWorkletNode(audioContext!, "client-audio-processor", {
        processorOptions: { bufferSize },
    });

    workletNode.port.onmessage = (event: MessageEvent<WorkletPortMessage>) => {
        if (event.data.type === "pcmData") {
            socket.emit("client_audio_data", event.data.pcmData!);
        }
    };
}

function ensureServerAudioWorker(): void {
    if (serverAudioWorker) return;

    serverAudioWorker = new AudioConverterWorker();
    serverAudioWorker.addEventListener("message", (event: MessageEvent<{ type: string; samples: Float32Array }>) => {
        const { type, samples } = event.data;

        if (type === "pcm") {
            if (!playbackNode) return;
            playbackNode.port.postMessage({ samples, type: "pcm" }, [samples.buffer]);
        }
    });
    serverAudioWorker.postMessage({ format: audioFormat, type: "format" });
}

function handleServerAudioData(data: ArrayBuffer | ArrayBufferView | number[]): void {
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

    ensureServerAudioWorker();
    serverAudioWorker!.postMessage({ buffer, type: "pcm" }, [buffer]);
}

async function stopAudioStream(socket: AppSocket, type: AudioKind, isResetting = false): Promise<void> {
    if (!streamActive[type] && !isResetting) {
        return;
    }

    socket.emit(AUDIO_KIND_CONFIG[type].stopEvent);

    if (type === "client") {
        cleanupWorklet();
    } else if (type === "server") {
        socket.off("server_audio_data", handleServerAudioData);
        socket.off("server_audio_format");
        cleanupServerPlayback();
    }

    streamActive[type] = false;
    updateAudioToggleButton(type);

    if (!isResetting && !streamActive.server && !streamActive.client && audioContext) {
        await audioContext.close();
        audioContext = null;
        audioWorkletModulePromise = null;
    }
}

function cleanupWorklet(): void {
    if (currentStream) {
        currentStream.getTracks().forEach((track) => {
            track.stop();
        });
        currentStream = null;
    }
    if (workletNode) {
        workletNode.disconnect();
        workletNode.port.close();
        workletNode = null;
    }
}

function cleanupServerPlayback(): void {
    if (playbackNode) {
        playbackNode.disconnect();
        playbackNode.port.close();
        playbackNode = null;
    }

    if (serverAudioWorker) {
        serverAudioWorker.terminate();
        serverAudioWorker = null;
    }
}

function getServerAudioSettingsFromForm(): AudioKindSettings {
    const select = byId<HTMLSelectElement>("audioSourceSelect")!;
    const selected = select.selectedOptions[0]!;
    const isDefault = selected.value === "mic" || selected.value === "system";

    return {
        device_id: isDefault ? null : selected.value,
        rate: Math.trunc(Number(byId<HTMLInputElement>("serverAudioRate")!.value)),
        source: selected.dataset.kind ?? "mic",
    };
}

function handleAudioStartError(socket: AppSocket, type: AudioKind, message: string): void {
    showNotification(message, "error");
    void stopAudioStream(socket, type, true);
}

function initializeEventListeners(socket: AppSocket): void {
    onAsync(byId("toggleServerAudio"), "click", async () => {
        if (streamActive.server) {
            await stopAudioStream(socket, "server");
            return;
        }

        await startAudioStream(socket, "server", getServerAudioSettingsFromForm());
    });

    byId("audioSourceSelect")!.addEventListener("change", () => {
        const targetSettings = { ...currentSettings.server, ...getServerAudioSettingsFromForm() };
        const matchesRunning = streamActive.server && settingsEqual(currentSettings.server, targetSettings);
        updateAudioToggleButton("server", matchesRunning);
    });

    onAsync(byId("toggleClientAudio"), "click", async () => {
        if (streamActive.client) {
            await stopAudioStream(socket, "client");
            return;
        }

        const settings: AudioKindSettings = {
            chunk: Math.trunc(Number(byId<HTMLInputElement>("clientAudioChunk")!.value)),
            rate: Math.trunc(Number(byId<HTMLInputElement>("clientAudioRate")!.value)),
        };
        await startAudioStream(socket, "client", settings);
    });

    socket.on("server_audio_error", (data) => {
        handleAudioStartError(socket, "server", data.message);
    });

    socket.on("client_audio_error", (data) => {
        handleAudioStartError(socket, "client", data.message);
    });

    socket.on("connect", () => {
        void refreshAudioSources(socket);
    });

    (["server", "client"] as const).forEach((kind) => {
        bindMediaSessionReconnect(socket, {
            isActive: () => streamActive[kind],
            onDisconnect: () => {
                void stopAudioStream(socket, kind, true);
            },
            onReconnect: () => {
                void startAudioStream(socket, kind, currentSettings[kind]);
            },
        });
    });

    if (socket.connected) {
        void refreshAudioSources(socket);
    }
}

export function initializeAudioManager(socket: AppSocket): void {
    initializeEventListeners(socket);
}
