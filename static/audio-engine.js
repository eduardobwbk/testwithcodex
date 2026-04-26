// audio-engine.js
// Real-time audio analysis for driving the playhead.
// Outputs three envelopes (bass / mid / high) + an onset transient flag per audio frame.
//
// We use a single AnalyserNode with FFT=2048. From the frequency bins we compute
// band energies, then apply attack/release smoothing (separate for each band) to
// produce clean envelopes. Onset detection: spectral flux on the bass band.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    this.audioBuffer = null;
    this.freqData = null;
    this.timeData = null;
    this.gain = null;

    // envelopes (smoothed)
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.rms = 0;

    // onset detection
    this._prevBassRaw = 0;
    this._prevHighRaw = 0;
    this.transient = 0;       // bass onset impulse, decays fast
    this.highTransient = 0;   // high-band onset impulse (hats/snares), decays very fast
    this._transientDecay = 0.85;
    this._highTransientDecay = 0.70; // snappier decay for micro-tremor

    // attack/release (per ms-ish)
    this.attack = 0.55;
    this.release = 0.12;

    // state
    this.playing = false;
    this.startedAt = 0;
    this.offset = 0;
    this.duration = 0;

    // pre-computed full-track waveform (for visualization)
    this.waveformPeaks = null;
  }

  async loadFile(file) {
    this._ensureCtx();
    const arr = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arr.slice(0));
    this.audioBuffer = audioBuffer;
    this.duration = audioBuffer.duration;
    this.waveformPeaks = this._computePeaks(audioBuffer, 1024);
    return {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    };
  }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.0; // we do our own smoothing
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.analyser.connect(this.gain).connect(this.ctx.destination);
  }

  play(fromOffset = 0) {
    if (!this.audioBuffer) return;
    this._ensureCtx();
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.connect(this.analyser);
    src.start(0, fromOffset);
    this.source = src;
    this.startedAt = this.ctx.currentTime - fromOffset;
    this.offset = fromOffset;
    this.playing = true;
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
      }
    };
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
    this.playing = false;
  }

  // Pause without resetting — remembers current offset so play() resumes here.
  pause() {
    if (!this.playing) return;
    const t = this.currentTime();
    this.stop();
    this.offset = Math.max(0, Math.min(this.duration, t));
  }

  // Seek to a specific time in the track. If currently playing, restart the
  // source at the new offset without a click/pop (AudioBufferSourceNode is
  // single-shot, so we stop + recreate). If paused, just remember the offset.
  seek(timeSec) {
    if (!this.audioBuffer) return;
    const t = Math.max(0, Math.min(this.duration - 0.001, timeSec));
    if (this.playing) {
      this.play(t); // play() handles stop+recreate internally
    } else {
      this.offset = t;
    }
  }

  currentTime() {
    if (!this.ctx) return 0;
    if (!this.playing) return this.offset;
    return this.ctx.currentTime - this.startedAt;
  }

  // Call each animation frame. Updates bass/mid/high envelopes + transient.
  update() {
    if (!this.analyser || !this.playing) {
      // decay towards zero
      this.bass *= 0.9; this.mid *= 0.9; this.high *= 0.9; this.rms *= 0.9;
      this.transient *= this._transientDecay;
      this.highTransient *= this._highTransientDecay;
      return;
    }

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    const sr = this.ctx.sampleRate;
    const nyquist = sr / 2;
    const binCount = this.freqData.length;
    const hzPerBin = nyquist / binCount;

    // Band ranges (Hz)
    const bassRange = [20, 200];
    const midRange  = [200, 2000];
    const highRange = [2000, 12000];

    const avgBand = (lo, hi) => {
      const i0 = Math.max(1, Math.floor(lo / hzPerBin));
      const i1 = Math.min(binCount - 1, Math.ceil(hi / hzPerBin));
      let s = 0, n = 0;
      for (let i = i0; i <= i1; i++) { s += this.freqData[i]; n++; }
      return n ? (s / n) / 255 : 0;
    };

    const bassRaw = avgBand(...bassRange);
    const midRaw  = avgBand(...midRange);
    const highRaw = avgBand(...highRange);

    // perceptual curve (emphasize transients)
    const shape = x => Math.pow(x, 1.4);
    const bT = shape(bassRaw);
    const mT = shape(midRaw);
    const hT = shape(highRaw);

    // Attack/release smoothing
    this.bass = bT > this.bass ? this.bass + (bT - this.bass) * this.attack : this.bass + (bT - this.bass) * this.release;
    this.mid  = mT > this.mid  ? this.mid  + (mT - this.mid)  * this.attack : this.mid  + (mT - this.mid)  * this.release;
    this.high = hT > this.high ? this.high + (hT - this.high) * this.attack : this.high + (hT - this.high) * this.release;

    // RMS from time domain
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sumSq += v * v;
    }
    this.rms = Math.sqrt(sumSq / this.timeData.length);

    // Spectral flux onset on bass (kicks, low thuds)
    const fluxB = Math.max(0, bassRaw - this._prevBassRaw);
    this._prevBassRaw = bassRaw;
    if (fluxB > 0.06) {
      this.transient = Math.max(this.transient, fluxB * 4);
    }
    this.transient *= this._transientDecay;

    // Spectral flux onset on high band (hats, snares, clicks)
    const fluxH = Math.max(0, highRaw - this._prevHighRaw);
    this._prevHighRaw = highRaw;
    if (fluxH > 0.04) {
      this.highTransient = Math.max(this.highTransient, fluxH * 5);
    }
    this.highTransient *= this._highTransientDecay;
  }

  _computePeaks(buffer, bins) {
    const ch = buffer.getChannelData(0);
    const step = Math.floor(ch.length / bins);
    const peaks = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(ch.length, start + step);
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  dispose() {
    this.stop();
    this.audioBuffer = null;
    this.waveformPeaks = null;
  }
}
