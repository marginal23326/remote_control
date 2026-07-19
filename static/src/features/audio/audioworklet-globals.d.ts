export {};

declare global {
    /** Sample rate (Hz) of the associated `BaseAudioContext`. */
    const sampleRate: number;

    abstract class AudioWorkletProcessor {
        readonly port: MessagePort;
        constructor(options?: AudioWorkletNodeOptions);
        abstract process(
            inputs: Float32Array[][],
            outputs: Float32Array[][],
            parameters: Record<string, Float32Array>,
        ): boolean;
    }

    function registerProcessor(name: string, processorCtor: new (...args: any[]) => AudioWorkletProcessor): void;
}
