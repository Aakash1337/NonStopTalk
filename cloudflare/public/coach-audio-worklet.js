class CoachingMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.energy = 0;
    this.peak = 0;
    this.sampleCount = 0;
    this.framesUntilPost = Math.max(1, Math.round(sampleRate / 10));
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[frame] || 0;
      const sample = mixed / channels.length;
      this.energy += sample * sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
      this.sampleCount += 1;
      this.framesUntilPost -= 1;
      if (this.framesUntilPost <= 0) {
        this.port.postMessage({
          atMs: currentTime * 1000,
          rms: Math.sqrt(this.energy / Math.max(1, this.sampleCount)),
          peak: this.peak,
        });
        this.energy = 0;
        this.peak = 0;
        this.sampleCount = 0;
        this.framesUntilPost = Math.max(1, Math.round(sampleRate / 10));
      }
    }
    return true;
  }
}

registerProcessor("coaching-meter", CoachingMeterProcessor);
