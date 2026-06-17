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
        this.chunks = [];
        this.chunkIndex = 0;
        this.sampleIndex = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === "pcm") {
                this.chunks.push(event.data.samples);
            }
        };
    }

    process(_inputs, outputs, _parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const channelData = output[0];
        const length = channelData.length;

        for (let i = 0; i < length; i++) {
            if (this.chunkIndex < this.chunks.length) {
                const chunk = this.chunks[this.chunkIndex];
                channelData[i] = chunk[this.sampleIndex];
                this.sampleIndex++;

                if (this.sampleIndex >= chunk.length) {
                    this.sampleIndex = 0;
                    this.chunkIndex++;
                }
            } else {
                channelData[i] = 0.0;
            }
        }

        const maxPendingChunks = 30;
        if (this.chunks.length - this.chunkIndex > maxPendingChunks) {
            this.chunkIndex = this.chunks.length - 10;
            this.sampleIndex = 0;
        }

        if (this.chunkIndex > 64) {
            this.chunks.splice(0, this.chunkIndex);
            this.chunkIndex = 0;
        }

        return true;
    }
}

registerProcessor("server-audio-playback-processor", ServerAudioPlaybackProcessor);
