// blob-tracker.js
//
// Browser port of nicholaspjm/touchdesigner-blobtracker (main.py).
// Pipeline (runs once per frame from app.js):
//
//   1. Copy a downscaled RGBA snapshot of the source canvas/video into an
//      off-screen work canvas (detection resolution). GL canvases must be
//      drawn with preserveDrawingBuffer=true OR read the same frame we just
//      rendered; app.js takes care of that ordering.
//   2. Convert to luminance and diff against the previous luminance buffer
//      (motion mask). Threshold → binary uint8.
//   3. Connected-component labeling via two-pass flood fill to produce raw
//      blobs {cx, cy, area, bx0, by0, bx1, by1} — here we use a
//      scan-line union-find which is ~3× faster than recursive flood fill.
//   4. Nearest-neighbor blob matching with previous frame's smoothed blobs
//      to assign persistent IDs (port of match_blobs_fast).
//   5. Confidence-weighted EMA smoothing of centers and sizes (port of the
//      motion_smoothing / size_smoothing logic).
//   6. Store per-blob trail history (capped length) for the Trails overlay.
//
// Public shape:
//   tracker.setParams({...})
//   tracker.update(sourceCanvas, outW, outH, dt)
//   tracker.blobs → [
//     {
//       id,                  // persistent integer
//       x, y,                // smoothed center in OUTPUT-canvas (overlay) coords
//       size,                // smoothed radius in OUTPUT-canvas coords
//       area,                // raw area in work-canvas px²
//       bbox: {x, y, w, h},  // output-canvas coords
//       vx, vy,              // velocity per second (output coords)
//       speed,               // hypot(vx, vy)
//       age,                 // frames since first seen
//       confidence,          // 1..10 stability
//       trail,               // [[x,y], ...]  history in output coords
//     }, ...
//   ]

export class BlobTracker {
  constructor() {
    // Detection parameters (match the repo's params)
    this.diffThresh       = 18;      // luminance diff threshold 0..255
    this.minArea          = 60;      // px² at work resolution
    this.maxArea          = 100000;
    this.maxBlobs         = 40;
    this.maxDistance      = 120;     // px in output coords for ID matching
    this.motionSmoothing  = 0.5;
    this.sizeSmoothing    = 0.5;
    this.resolutionScale  = 0.5;     // 0.1..1.0 — downsample factor for detection
    this.frameSkip        = 0;       // 0 = every frame
    this.frozen           = false;   // freeze: keep last state, skip detection
    this.trailLength      = 18;      // max points per blob trail

    // Work canvases (created lazily)
    this._work = null;               // <canvas> at detection resolution
    this._workCtx = null;
    this._prevLuma = null;           // Uint8Array luminance of previous frame
    this._mask = null;               // Uint8Array binary motion mask

    // Labeling scratch
    this._labels = null;             // Int32Array, same length as _mask

    // Tracking state (between frames)
    this._prevBlobs = [];            // smoothed blobs carried over
    this._nextId = 0;
    this._confidence = new Map();    // id → 1..10

    // Frame skipping
    this._frameCounter = 0;

    // Output
    this.blobs = [];                 // latest blob list in OUTPUT coords
  }

  setParams(p) {
    if (p == null) return;
    if (p.diffThresh       != null) this.diffThresh      = Math.max(1, Math.min(255, p.diffThresh));
    if (p.minArea          != null) this.minArea         = Math.max(1, p.minArea);
    if (p.maxArea          != null) this.maxArea         = Math.max(this.minArea + 1, p.maxArea);
    if (p.maxBlobs         != null) this.maxBlobs        = Math.max(1, p.maxBlobs);
    if (p.maxDistance      != null) this.maxDistance     = Math.max(1, p.maxDistance);
    if (p.motionSmoothing  != null) this.motionSmoothing = Math.max(0, Math.min(1, p.motionSmoothing));
    if (p.sizeSmoothing    != null) this.sizeSmoothing   = Math.max(0, Math.min(1, p.sizeSmoothing));
    if (p.resolutionScale  != null) {
      const v = Math.max(0.1, Math.min(1, p.resolutionScale));
      if (v !== this.resolutionScale) {
        this.resolutionScale = v;
        this._prevLuma = null;   // invalidate — resolution changed
        this._work     = null;
      }
    }
    if (p.frameSkip        != null) this.frameSkip       = Math.max(0, p.frameSkip | 0);
    if (p.frozen           != null) this.frozen          = !!p.frozen;
    if (p.trailLength      != null) this.trailLength     = Math.max(2, p.trailLength | 0);
  }

  reset() {
    this._prevBlobs = [];
    this._prevLuma  = null;
    this._confidence.clear();
    this._nextId   = 0;
    this._frameCounter = 0;
    this.blobs = [];
  }

  // ---------- Public update ----------
  //
  // source: HTMLCanvasElement | HTMLVideoElement
  // outW, outH: OUTPUT (overlay) canvas dimensions in CSS pixels — blob
  //             positions/sizes are returned in these coordinates.
  // dt:   seconds since last frame
  update(source, outW, outH, dt) {
    if (!source || outW <= 0 || outH <= 0) return;

    this._frameCounter++;

    // Frozen — just decay velocities and age, don't re-detect
    if (this.frozen) {
      for (const b of this._prevBlobs) {
        b.vx *= 0.9; b.vy *= 0.9; b.speed *= 0.9;
        b.age += 1;
      }
      this.blobs = this._prevBlobs;
      return;
    }

    // Detection resolution
    const dw = Math.max(2, Math.round(outW * this.resolutionScale));
    const dh = Math.max(2, Math.round(outH * this.resolutionScale));

    // (Re)alloc work buffers on resolution change
    if (!this._work || this._work.width !== dw || this._work.height !== dh) {
      this._work = document.createElement('canvas');
      this._work.width  = dw;
      this._work.height = dh;
      this._workCtx = this._work.getContext('2d', { willReadFrequently: true });
      this._prevLuma = null;
      this._mask   = new Uint8Array(dw * dh);
      this._labels = new Int32Array(dw * dh);
    }

    // Scale source → work canvas
    try {
      this._workCtx.drawImage(source, 0, 0, dw, dh);
    } catch (_) {
      // Source not yet ready (e.g. video metadata still loading)
      return;
    }

    // Pull pixel data
    let imgData;
    try {
      imgData = this._workCtx.getImageData(0, 0, dw, dh);
    } catch (_) {
      return;
    }
    const px = imgData.data;
    const N  = dw * dh;

    // Luminance buffer (pooled)
    if (!this._curLuma || this._curLuma.length !== N) this._curLuma = new Uint8Array(N);
    const curLuma = this._curLuma;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      // rec. 601 approximation: (r*77 + g*150 + b*29) >> 8
      curLuma[i] = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
    }

    // First-frame init
    if (!this._prevLuma || this._prevLuma.length !== N) {
      this._prevLuma = new Uint8Array(curLuma);
      this.blobs = [];
      return;
    }

    // Frame skip: every (frameSkip+1)th frame runs full detection.
    // Other frames still update prevLuma so we don't get a huge diff on
    // the next detection tick.
    const shouldDetect =
      this.frameSkip <= 0 || (this._frameCounter % (this.frameSkip + 1) === 0);

    // Diff → binary motion mask
    const mask = this._mask;
    const th = this.diffThresh;
    for (let i = 0; i < N; i++) {
      const d = curLuma[i] - this._prevLuma[i];
      mask[i] = ((d < 0 ? -d : d) >= th) ? 1 : 0;
    }

    // Promote current luma to prev for next frame
    this._prevLuma.set(curLuma);

    if (!shouldDetect) {
      // carry last blobs unchanged (with age++)
      for (const b of this._prevBlobs) b.age += 1;
      this.blobs = this._prevBlobs;
      return;
    }

    // Connected components → raw blobs (work-canvas coords)
    const rawBlobs = this._connectedComponents(mask, dw, dh);

    // Scale to output coords
    const sx = outW / dw;
    const sy = outH / dh;
    const sAvg = 0.5 * (sx + sy);
    const areaScaleInv = 1 / (this.resolutionScale * this.resolutionScale);

    const filtered = [];
    for (const r of rawBlobs) {
      // r.area is in work-canvas px²; compare against min/max in work-canvas px²
      if (r.area < this.minArea) continue;
      if (r.area > this.maxArea) continue;
      filtered.push({
        x: r.cx * sx,
        y: r.cy * sy,
        size: Math.sqrt(r.area / Math.PI) * sAvg * 1.6,  // visual radius hint
        area: r.area * areaScaleInv,                      // "true" px² at output scale
        bbox: {
          x: r.bx0 * sx,
          y: r.by0 * sy,
          w: (r.bx1 - r.bx0 + 1) * sx,
          h: (r.by1 - r.by0 + 1) * sy,
        },
      });
    }

    // Cap at maxBlobs, keeping the largest
    filtered.sort((a, b) => b.area - a.area);
    if (filtered.length > this.maxBlobs) filtered.length = this.maxBlobs;

    // ID matching + smoothing
    const matched = this._matchAndSmooth(filtered, dt);

    this.blobs = matched;
    this._prevBlobs = matched;
  }

  // ---------- Internals ----------

  // Scan-line two-pass connected components with union-find. Returns an array
  // of {cx, cy, area, bx0, by0, bx1, by1} in work-canvas coordinates.
  _connectedComponents(mask, w, h) {
    const labels = this._labels;
    labels.fill(0);

    // Union-find parent array — index 0 reserved for "no label".
    // Max labels bounded by width*height but in practice far fewer.
    const parentCap = 1 + Math.min(w * h, 20000);
    const parent = new Int32Array(parentCap);
    let nextLabel = 1;

    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]; // path compression
        x = parent[x];
      }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return ra;
      if (ra < rb) { parent[rb] = ra; return ra; }
      parent[ra] = rb; return rb;
    };

    // First pass — 4-connectivity (left, up)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        const left = x > 0 ? labels[i - 1] : 0;
        const up   = y > 0 ? labels[i - w] : 0;
        if (left && up) {
          labels[i] = union(left, up);
        } else if (left) {
          labels[i] = left;
        } else if (up) {
          labels[i] = up;
        } else {
          if (nextLabel >= parentCap) continue; // safety — skip once we're over cap
          labels[i] = nextLabel;
          parent[nextLabel] = nextLabel;
          nextLabel++;
        }
      }
    }

    // Second pass — resolve labels, collect stats
    // stats index is a compact root-label id
    const rootMap = new Map(); // root label → stats index
    const sumX = [];
    const sumY = [];
    const count = [];
    const x0Arr = [];
    const y0Arr = [];
    const x1Arr = [];
    const y1Arr = [];

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const l = labels[i];
        if (!l) continue;
        const r = find(l);
        labels[i] = r;
        let idx = rootMap.get(r);
        if (idx === undefined) {
          idx = sumX.length;
          rootMap.set(r, idx);
          sumX.push(0); sumY.push(0); count.push(0);
          x0Arr.push(x); y0Arr.push(y); x1Arr.push(x); y1Arr.push(y);
        }
        sumX[idx] += x;
        sumY[idx] += y;
        count[idx]++;
        if (x < x0Arr[idx]) x0Arr[idx] = x;
        if (x > x1Arr[idx]) x1Arr[idx] = x;
        if (y < y0Arr[idx]) y0Arr[idx] = y;
        if (y > y1Arr[idx]) y1Arr[idx] = y;
      }
    }

    const blobs = new Array(count.length);
    for (let i = 0; i < count.length; i++) {
      blobs[i] = {
        cx:   sumX[i] / count[i],
        cy:   sumY[i] / count[i],
        area: count[i],
        bx0:  x0Arr[i], by0: y0Arr[i],
        bx1:  x1Arr[i], by1: y1Arr[i],
      };
    }
    return blobs;
  }

  // Nearest-neighbor ID matching with greedy assignment (port of
  // match_blobs_fast + confidence-weighted smoothing block from the repo).
  _matchAndSmooth(current, dt) {
    const prev = this._prevBlobs;
    const maxD = this.maxDistance;
    const maxD2 = maxD * maxD;

    // Greedy nearest match: for each current blob, pick the closest unused
    // previous blob within maxDistance. O(N*M) but N and M are small (<100).
    const prevUsed = new Array(prev.length).fill(false);
    const assignment = new Array(current.length).fill(-1); // prev index or -1

    // Sort current by area desc so big blobs get first pick
    const order = current.map((_, i) => i).sort((a, b) => current[b].area - current[a].area);

    for (const i of order) {
      const c = current[i];
      let bestIdx = -1;
      let bestD2  = maxD2;
      for (let j = 0; j < prev.length; j++) {
        if (prevUsed[j]) continue;
        const p = prev[j];
        const dx = c.x - p.x;
        const dy = c.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = j;
        }
      }
      if (bestIdx >= 0) {
        assignment[i] = bestIdx;
        prevUsed[bestIdx] = true;
      }
    }

    // Smoothing coefficients (port)
    const mLow  = 0.2 + this.motionSmoothing * 0.2;   // low confidence blobs
    const mHigh = 0.4 + this.motionSmoothing * 0.3;   // high confidence blobs
    const sLow  = 0.2 + this.sizeSmoothing   * 0.2;
    const sHigh = 0.4 + this.sizeSmoothing   * 0.3;

    const out = [];
    const seenIds = new Set();

    for (let i = 0; i < current.length; i++) {
      const c = current[i];
      const j = assignment[i];
      let id, conf, p = null;
      if (j >= 0) {
        p = prev[j];
        id = p.id;
        conf = Math.min(10, (this._confidence.get(id) || 0) + 1);
      } else {
        id = this._nextId++;
        conf = 1;
      }
      this._confidence.set(id, conf);
      seenIds.add(id);

      const mA = conf >= 3 ? mHigh : mLow;
      const sA = conf >= 3 ? sHigh : sLow;

      // Smoothed position / size (EMA toward current)
      let x, y, size;
      if (p) {
        x    = p.x    + (c.x    - p.x)    * mA;
        y    = p.y    + (c.y    - p.y)    * mA;
        size = p.size + (c.size - p.size) * sA;
      } else {
        x = c.x; y = c.y; size = c.size;
      }

      // Velocity in output coords
      let vx = 0, vy = 0, speed = 0;
      if (p && dt > 0) {
        vx = (x - p.x) / dt;
        vy = (y - p.y) / dt;
        speed = Math.hypot(vx, vy);
      }

      // Trail (copy prev trail forward, append new point)
      const trail = p && p.trail ? p.trail.slice() : [];
      trail.push([x, y]);
      if (trail.length > this.trailLength) trail.splice(0, trail.length - this.trailLength);

      out.push({
        id,
        x, y, size,
        area: c.area,
        bbox: c.bbox,
        vx, vy, speed,
        age: p ? p.age + 1 : 1,
        confidence: conf,
        trail,
      });
    }

    // Clean confidence map — drop ids we didn't see for a while
    if (this._confidence.size > this.maxBlobs * 3) {
      for (const id of this._confidence.keys()) {
        if (!seenIds.has(id)) this._confidence.delete(id);
      }
    }

    return out;
  }
}
