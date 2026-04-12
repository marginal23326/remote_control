class ClientAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    // Increase buffer size slightly to reduce network jitter noise
    this.bufferSize = options.processorOptions.bufferSize || 2048; 
  }

  process(inputs, outputs, parameters) {
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
          int16Chunk[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        this.port.postMessage({
          type: 'pcmData',
          pcmData: int16Chunk.buffer
        }, [int16Chunk.buffer]); 
      }
    }

    return true;
  }
}

registerProcessor('client-audio-processor', ClientAudioProcessor);