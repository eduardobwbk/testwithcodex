// video-decoder.js
// Pre-decodes a short (10-20s) video into an array of ImageBitmaps.
//
// IMPORTANT ORIENTATION NOTE:
// Phone-recorded MP4s carry a rotation flag in their container metadata. A <video>
// element applies that rotation automatically when it presents frames (i.e. via
// drawImage / captureStream's renderer). Raw VideoFrame objects from
// MediaStreamTrackProcessor however expose the *pre-rotation* pixel buffer on some
// browsers, which is why phone videos were showing up-side down.
//
// To be robust across devices and codecs we always decode by playing the <video>
// element and sampling via requestVideoFrameCallback (rVFC). Sampling happens via
// ctx.drawImage(video,…) which always respects rotation + aspect + color space.
// This is slightly slower than the raw-frame path but guaranteed correct.

export class VideoDecoder {
  constructor() {
    this.frames = [];
    this.fps = 30;
    this.width = 0;
    this.height = 0;
    this.duration = 0;
  }

  async decode(file, onProgress = () => {}) {
    this.dispose();
    const url = URL.createObjectURL(file);

    // Prefer rVFC path. Fall back to seek-based if rVFC is unavailable.
    try {
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        await this._decodeViaRVFC(url, onProgress);
      } else {
        await this._decodeViaSeek(url, onProgress);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
    return this._result();
  }

  _result() {
    return {
      frames: this.frames,
      fps: this.fps,
      width: this.width,
      height: this.height,
      duration: this.duration,
      frameCount: this.frames.length,
    };
  }

  async _decodeViaRVFC(url, onProgress) {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video load error'));
    });

    // Use the *displayed* dimensions (post-rotation) so portrait phone videos
    // come out as actual portrait, not the stored landscape raster.
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    // Hard-cap effective duration at 50s regardless of source length
    this.duration = Math.min(video.duration, 50);

    // Adaptive frame rate: keep total frame count bounded so long clips don't
    // blow up memory. Sub-frame blending in the renderer means dropping from
    // 30fps to 20fps is visually imperceptible during playback.
    const targetFps = this._pickFps(this.duration);
    this.fps = targetFps;
    const maxFrames = Math.min(Math.ceil(this.duration * targetFps), 1200);
    const minStep = 1 / targetFps;

    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false, alpha: false });

    let lastTime = -1;
    const hardStop = this.duration; // 50s cap honored here
    const donePromise = new Promise((resolve) => {
      const step = async (now, metadata) => {
        const mediaTime = metadata.mediaTime;
        if (mediaTime - lastTime >= minStep - 0.001 &&
            this.frames.length < maxFrames &&
            mediaTime <= hardStop) {
          // draw via video element → respects rotation/orientation metadata
          ctx.drawImage(video, 0, 0, this.width, this.height);
          try {
            const bmp = await createImageBitmap(canvas);
            this.frames.push(bmp);
            lastTime = mediaTime;
            onProgress(Math.min(1, this.frames.length / maxFrames));
          } catch (e) { /* skip */ }
        }
        if (video.ended || this.frames.length >= maxFrames || mediaTime > hardStop) {
          resolve();
        } else {
          video.requestVideoFrameCallback(step);
        }
      };
      video.requestVideoFrameCallback(step);
      video.addEventListener('ended', () => resolve(), { once: true });
    });

    await video.play();
    await donePromise;
    try { video.pause(); } catch (e) {}

    // Recompute fps based on actual
    if (this.frames.length > 1) this.fps = this.frames.length / this.duration;
  }

  async _decodeViaSeek(url, onProgress) {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video load error'));
    });
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.duration = video.duration;

    const targetFps = this._pickFps(this.duration);
    this.fps = targetFps;
    const total = Math.min(Math.ceil(this.duration * targetFps), 1200);

    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d', { alpha: false });

    for (let i = 0; i < total; i++) {
      const t = (i / total) * this.duration;
      await this._seek(video, t);
      ctx.drawImage(video, 0, 0, this.width, this.height);
      const bmp = await createImageBitmap(canvas);
      this.frames.push(bmp);
      onProgress((i + 1) / total);
    }
  }

  _seek(video, t) {
    return new Promise((res) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); res(); };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = Math.min(t, video.duration - 0.001);
    });
  }

  // Adaptive sampling rate based on clip duration. Shorter clips get higher
  // fidelity; longer clips trade fps for memory. Because the renderer does
  // sub-frame blending, visual smoothness is preserved down to ~20fps.
  _pickFps(duration) {
    if (duration <= 20) return 30;
    if (duration <= 30) return 28;
    if (duration <= 40) return 24;
    return 20; // 40–50s clips
  }

  memoryBytes() {
    return this.frames.length * this.width * this.height * 4;
  }

  dispose() {
    for (const f of this.frames) { try { f.close?.(); } catch (e) {} }
    this.frames = [];
  }
}
