let audioFormat = { rate: 48000, channels: 1, format: "int16" };

self.onmessage = (event) => {
    const { type, format, buffer } = event.data;

    if (type === "format") {
        audioFormat = {
            rate: Number(format?.rate) || 48000,
            channels: Math.max(1, Number(format?.channels) || 1),
            format: format?.format || "int16",
        };
        return;
    }

    if (type !== "pcm" || !(buffer instanceof ArrayBuffer)) {
        return;
    }

    const samples = convertServerAudio(buffer);
    if (samples.length > 0) {
        self.postMessage({ type: "pcm", samples }, [samples.buffer]);
    }
};

function convertServerAudio(buffer) {
    const channels = audioFormat.channels;
    const bytesPerSample = audioFormat.format === "float32" ? 4 : 2;
    const frameSize = bytesPerSample * channels;
    const frameCount = Math.floor(buffer.byteLength / frameSize);

    if (frameCount === 0) {
        return new Float32Array(0);
    }

    if (audioFormat.format !== "float32" && audioFormat.format !== "int16") {
        throw new Error(`Unsupported server audio format: ${audioFormat.format}`);
    }

    const view = new DataView(buffer);
    const samples = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) {
            const offset = frame * frameSize + channel * bytesPerSample;
            sum +=
                audioFormat.format === "float32" ? view.getFloat32(offset, true) : view.getInt16(offset, true) / 32768;
        }
        samples[frame] = sum / channels;
    }

    return samples;
}
