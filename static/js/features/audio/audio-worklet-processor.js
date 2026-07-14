class ClientAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.bufferSize = options.processorOptions.bufferSize || 2048;
        this.buffer = new Float32Array(this.bufferSize);
        this.pointer = 0;
    }

    process(inputs) {
        const inputChannelData = inputs[0]?.[0];
        if (!inputChannelData) return true;

        for (let i = 0; i < inputChannelData.length; i++) {
            this.buffer[this.pointer++] = inputChannelData[i];

            if (this.pointer >= this.bufferSize) {
                const int16Chunk = new Int16Array(this.bufferSize);
                for (let j = 0; j < this.bufferSize; j++) {
                    const s = Math.max(-1, Math.min(1, this.buffer[j]));
                    int16Chunk[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                this.port.postMessage({ type: "pcmData", pcmData: int16Chunk.buffer }, [int16Chunk.buffer]);
                this.pointer = 0;
            }
        }
        return true;
    }
}

registerProcessor("client-audio-processor", ClientAudioProcessor);

class ServerAudioPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        const currentSampleRate = globalThis.sampleRate || 48000;

        this.capacity = currentSampleRate * 2;
        this.buffer = new Float32Array(this.capacity);

        this.readIndex = 0;
        this.writeIndex = 0;
        this.samplesAvailable = 0;

        this.targetBufferSamples = Math.floor(currentSampleRate * 0.12);
        this.maxBufferSamples = Math.floor(currentSampleRate * 0.3);

        this.isBuffering = true;

        this.fadeVolume = 0.0;
        this.fadeStep = 0.002;
        this.lastSample = 0.0;

        this.port.onmessage = (event) => {
            if (event.data.type === "pcm") {
                const samples = event.data.samples;
                const len = samples.length;

                for (let i = 0; i < len; i++) {
                    this.buffer[this.writeIndex] = samples[i];
                    this.writeIndex = (this.writeIndex + 1) % this.capacity;
                }

                this.samplesAvailable += len;

                if (this.samplesAvailable > this.capacity) {
                    this.readIndex = this.writeIndex;
                    this.samplesAvailable = this.capacity;
                }

                if (this.samplesAvailable > this.maxBufferSamples) {
                    const excess = this.samplesAvailable - this.targetBufferSamples;
                    this.readIndex = (this.readIndex + excess) % this.capacity;
                    this.samplesAvailable = this.targetBufferSamples;
                    this.isBuffering = false;
                }
            }
        };
    }

    process(_inputs, outputs, _parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const channelData = output[0];
        const length = channelData.length;

        for (let i = 0; i < length; i++) {
            if (this.isBuffering && this.samplesAvailable >= this.targetBufferSamples) {
                this.isBuffering = false;
            } else if (!this.isBuffering && this.samplesAvailable === 0) {
                this.isBuffering = true;
            }

            if (this.isBuffering) {
                this.fadeVolume = Math.max(0.0, this.fadeVolume - this.fadeStep);
                channelData[i] = this.lastSample * this.fadeVolume;
            } else {
                this.fadeVolume = Math.min(1.0, this.fadeVolume + this.fadeStep);
                this.lastSample = this.buffer[this.readIndex];

                channelData[i] = this.lastSample * this.fadeVolume;

                this.readIndex = (this.readIndex + 1) % this.capacity;
                this.samplesAvailable--;
            }
        }

        return true;
    }
}

registerProcessor("server-audio-playback-processor", ServerAudioPlaybackProcessor);
