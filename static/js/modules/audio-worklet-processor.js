class ClientAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.buffer = [];
        // Increase buffer size slightly to reduce network jitter noise
        this.bufferSize = options.processorOptions.bufferSize || 2048;
    }

    process(inputs, _outputs, _parameters) {
        const input = inputs[0];

        if (input && input.length > 0) {
            const inputChannelData = input[0]; // Get first channel (Mono)

            // 1. Push all samples to buffer
            for (let i = 0; i < inputChannelData.length; i++) {
                this.buffer.push(inputChannelData[i]);
            }

            // 2. Send chunks when buffer is full
            while (this.buffer.length >= this.bufferSize) {
                const chunk = this.buffer.splice(0, this.bufferSize);

                // Convert Float32 (-1.0 to 1.0) to Int16
                const int16Chunk = new Int16Array(chunk.length);
                for (let i = 0; i < chunk.length; i++) {
                    const s = Math.max(-1, Math.min(1, chunk[i]));
                    // 0x7FFF = 32767
                    int16Chunk[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }

                this.port.postMessage(
                    {
                        type: "pcmData",
                        pcmData: int16Chunk.buffer,
                    },
                    [int16Chunk.buffer],
                );
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

        if (this.isBuffering) {
            if (this.samplesAvailable >= this.targetBufferSamples) {
                this.isBuffering = false;
            } else {
                for (let i = 0; i < length; i++) channelData[i] = 0.0;
                return true;
            }
        }

        for (let i = 0; i < length; i++) {
            if (this.samplesAvailable > 0) {
                channelData[i] = this.buffer[this.readIndex];
                this.readIndex = (this.readIndex + 1) % this.capacity;
                this.samplesAvailable--;
            } else {
                channelData[i] = 0.0;
                this.isBuffering = true;
            }
        }

        return true;
    }
}

registerProcessor("server-audio-playback-processor", ServerAudioPlaybackProcessor);
