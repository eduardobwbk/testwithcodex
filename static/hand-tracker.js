// hand-tracker.js
//
// MediaPipe Tasks Vision — Hand Landmarker (WASM + WebGL).
// Tracks up to 2 hands and routes them by handedness into:
//
//   leftDriver  — playhead control (pinch → position/velocity)
//   rightDriver — blob-tracker gesture control (palm/back flip = style switch,
//                 pinch = sensitivity, fist = freeze)
//
// Each driver is the same shape:
//   {
//     visible,           // bool — this specific hand detected this frame
//     pinch,             // raw distance thumb-tip ↔ index-tip (normalized img units)
//     pinchNormalized,   // 0..1 after calibration
//     pinchVelocity,     // d(pinchNormalized)/dt
//     x, y,              // index-fingertip position in normalized image coords (0..1)
//     vx, vy,            // velocity of (x,y) per second
//     speed,             // sqrt(vx² + vy²)
//     handOpenness,      // 0..1 — mean fingertip distance to wrist
//     palmFacing,        // bool — true if palm faces camera, false if back of hand
//     isFist,            // bool — all fingertips curled near palm
//     rollAngle,         // radians — pinky_mcp → index_mcp 2D angle
//     landmarks          // 21×{x,y,z} for overlay drawing
//   }
//
// Handedness assignment:
//   MediaPipe reports "Left"/"Right" from the camera's point of view. Since we
//   mirror the preview, "Right" from MediaPipe = user's left hand on screen.
//   We expose a `swapHands` flag to flip routing if the user prefers.

const MP_VISION_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_FILESET =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function makeDriver() {
  return {
    visible: false,
    pinch: 0,
    pinchNormalized: 0,
    pinchVelocity: 0,
    x: 0.5, y: 0.5,
    vx: 0, vy: 0,
    speed: 0,
    handOpenness: 0,
    palmFacing: true,   // true = palm toward camera, false = back of hand
    isFist: false,      // true when all fingertips are curled near palm
    rollAngle: 0,       // radians, 2D angle of pinky_mcp → index_mcp
    landmarks: null,
  };
}

export class HandTracker {
  constructor() {
    this.enabled = false;
    this.ready   = false;
    this.running = false;

    this.video = null;
    this.stream = null;
    this.landmarker = null;

    // Number of hands to track (1 = single-hand legacy, 2 = two-hand split)
    this.numHands = 1;

    // Debug: raw count of hands MediaPipe detected last frame
    this.lastDetectionCount = 0;
    this.lastHandedness = [];

    // Flip which hand drives playhead vs blob-tracker gestures (for left-handed users)
    this.swapHands = false;

    // Per-hand drivers
    this.leftDriver  = makeDriver();  // playhead (pinch scrub)
    this.rightDriver = makeDriver();  // blob-tracker gesture control

    // Legacy single-hand driver (maps to whichever hand is visible first)
    this.driver = this.leftDriver;

    // Calibration — shared bounds for both hands (pinch ranges are ~equal)
    this.cal = {
      min: 0.02,
      max: 0.35,
      learning: true,
    };

    // Smoothing
    this.smoothingMs = 60;
    this.deadZone    = 0.02;
    this.invert      = false;

    // Per-driver internal state
    this._state = {
      left:  { sm: 0, lastTs: 0, lastX: 0.5, lastY: 0.5 },
      right: { sm: 0, lastTs: 0, lastX: 0.5, lastY: 0.5 },
    };

    this._rafId = 0;
  }

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    try {
      await this._initModel();
      await this._initCamera();
      this._startLoop();
    } catch (e) {
      this.enabled = false;
      throw e;
    }
  }

  disable() {
    this.enabled = false;
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    if (this.stream) {
      for (const tr of this.stream.getTracks()) tr.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.leftDriver  = makeDriver();
    this.rightDriver = makeDriver();
    this.driver = this.leftDriver;
  }

  recalibrate() {
    this.cal.min = 0.02;
    this.cal.max = 0.35;
    this.cal.learning = true;
    setTimeout(() => { this.cal.learning = false; }, 2000);
  }

  setSmoothing(ms)  { this.smoothingMs = Math.max(0, ms); }
  setDeadZone(v)    { this.deadZone = Math.max(0, Math.min(0.5, v)); }
  setInvert(v)      { this.invert = !!v; }
  setSwapHands(v)   { this.swapHands = !!v; }

  async setNumHands(n) {
    n = (n === 2) ? 2 : 1;
    if (n === this.numHands) return;
    this.numHands = n;
    if (this.landmarker) {
      // HandLandmarker doesn't expose a runtime setter, recreate cheaply
      try {
        await this.landmarker.setOptions({ numHands: n });
      } catch (_) {
        // fallback: recreate
        await this._recreateModel();
      }
    }
  }

  // ---------- Internals ----------

  async _initModel() {
    if (this.landmarker) return;
    const vision = await import(/* @vite-ignore */ MP_VISION_CDN);
    const { HandLandmarker, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(WASM_FILESET);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: this.numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence:  0.5,
      minTrackingConfidence:      0.5,
    });
    this.ready = true;
  }

  async _recreateModel() {
    if (this.landmarker) {
      try { this.landmarker.close(); } catch(_) {}
      this.landmarker = null;
    }
    await this._initModel();
  }

  async _initCamera() {
    const constraints = {
      audio: false,
      video: {
        facingMode: 'user',
        width:  { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true;
    v.srcObject = this.stream;
    await new Promise((res, rej) => {
      v.onloadedmetadata = () => v.play().then(res).catch(rej);
      v.onerror = rej;
    });
    this.video = v;
  }

  _startLoop() {
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this._processFrame();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _processFrame() {
    if (!this.landmarker || !this.video || this.video.readyState < 2) return;
    const now = performance.now();

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (_) { return; }

    const landmarksArr = (result && result.landmarks) || [];
    const handedArr    = (result && result.handedness) || [];

    // Debug telemetry
    this.lastDetectionCount = landmarksArr.length;
    this.lastHandedness = handedArr.map(h => (h && h[0]) ? h[0].categoryName : '?');

    // Mark all drivers invisible; we'll update the ones we see below.
    this.leftDriver.visible  = false;
    this.rightDriver.visible = false;
    this.leftDriver.landmarks  = null;
    this.rightDriver.landmarks = null;

    if (landmarksArr.length === 0) return;

    // Build (handedness → landmarks) assignments. In two-hand mode, route by
    // MediaPipe's handedness label. In single-hand mode, always route to leftDriver.
    if (this.numHands === 1) {
      this._updateDriver('left', landmarksArr[0], now);
      return;
    }

    // Two hands: walk detections and route by label
    for (let i = 0; i < landmarksArr.length; i++) {
      const cat = handedArr[i] && handedArr[i][0];
      let label = cat ? cat.categoryName : 'Right';
      // MediaPipe's label is from camera POV. Preview is mirrored, so what
      // MediaPipe calls "Right" appears on the user's LEFT in the preview.
      // We'll treat "MediaPipe=Right" → preview-left → "playhead" hand by default.
      // User can flip with swapHands.
      const isPlayheadHand = this.swapHands ? (label === 'Left') : (label === 'Right');
      this._updateDriver(isPlayheadHand ? 'left' : 'right', landmarksArr[i], now);
    }
  }

  _updateDriver(which, lm, now) {
    const driver = (which === 'left') ? this.leftDriver : this.rightDriver;
    const state  = this._state[which];

    const thumb = lm[4];
    const index = lm[8];
    const wrist = lm[0];

    // Pinch distance
    const dx = thumb.x - index.x;
    const dy = thumb.y - index.y;
    const pinchRaw = Math.hypot(dx, dy);

    if (this.cal.learning) {
      if (pinchRaw < this.cal.min) this.cal.min = pinchRaw;
      if (pinchRaw > this.cal.max) this.cal.max = pinchRaw;
    }

    const range = Math.max(0.01, this.cal.max - this.cal.min);
    let norm = (pinchRaw - this.cal.min) / range;
    norm = Math.max(0, Math.min(1, norm));
    if (this.invert) norm = 1 - norm;
    if (norm < this.deadZone) norm = 0;
    else norm = (norm - this.deadZone) / (1 - this.deadZone);

    // dt
    let dt = (now - state.lastTs) / 1000;
    if (!isFinite(dt) || dt <= 0 || dt > 0.2) dt = 1 / 30;
    state.lastTs = now;

    // EMA smoothing on pinch
    const tau = Math.max(0.001, this.smoothingMs / 1000);
    const coef = 1 - Math.exp(-dt / tau);
    const prevSm = state.sm;
    state.sm += (norm - state.sm) * coef;
    const pinchVel = (state.sm - prevSm) / Math.max(dt, 0.0001);

    // 2D position — use index fingertip (landmark 8). Mirror X so the
    // blob matches the mirrored preview (so hand-right on screen = x increases).
    const rawX = 1 - index.x; // flip for mirrored feel
    const rawY = index.y;

    // Smooth xy with the same tau so velocity is stable
    const px = state.lastX + (rawX - state.lastX) * coef;
    const py = state.lastY + (rawY - state.lastY) * coef;
    const vx = (px - state.lastX) / Math.max(dt, 0.0001);
    const vy = (py - state.lastY) / Math.max(dt, 0.0001);
    state.lastX = px;
    state.lastY = py;

    // Openness — mean tip-to-wrist distance
    const tips = [lm[8], lm[12], lm[16], lm[20]];
    let openSum = 0;
    for (const t of tips) openSum += Math.hypot(t.x - wrist.x, t.y - wrist.y);
    const openness = Math.max(0, Math.min(1, (openSum / 4) / 0.35));

    // ---- Gesture features for blob-tracker control ----
    //
    // palmFacing: palm vs. back-of-hand toward camera. Method: the cross product
    //   of (wrist→index_mcp) × (wrist→pinky_mcp) flips sign as the hand rotates.
    //   MediaPipe's coordinate system: +y is DOWN. For a right hand with palm
    //   toward the camera, the cross-Z is negative; back-of-hand flips it.
    //   We compensate for left/right handedness via the swapHands-aware routing
    //   already done before we got here — so here we just use sign.
    const indexMcp = lm[5];
    const pinkyMcp = lm[17];
    const ax = indexMcp.x - wrist.x;
    const ay = indexMcp.y - wrist.y;
    const bx = pinkyMcp.x - wrist.x;
    const by = pinkyMcp.y - wrist.y;
    const crossZ = ax * by - ay * bx;
    // Which sign means "palm facing" depends on handedness; we treat the
    // *left*-routed driver (playhead hand) as one convention and the
    // *right*-routed driver (blob hand) as the opposite — so both hands report
    // palmFacing=true when the palm is toward the camera regardless of which
    // one it is.
    const palmFacing = (which === 'right') ? (crossZ > 0) : (crossZ < 0);

    // isFist: all four non-thumb fingertips are curled close to the palm.
    //   Compare each tip's distance to wrist vs. the corresponding PIP joint's
    //   distance to wrist; when a finger is curled, tip is CLOSER to wrist
    //   than PIP. Require that for all 4 fingers. Cheap and robust.
    const pips = [lm[6], lm[10], lm[14], lm[18]];
    let curled = 0;
    for (let i = 0; i < 4; i++) {
      const tipD = Math.hypot(tips[i].x - wrist.x, tips[i].y - wrist.y);
      const pipD = Math.hypot(pips[i].x - wrist.x, pips[i].y - wrist.y);
      if (tipD < pipD * 1.05) curled++;
    }
    const isFist = curled >= 3; // tolerant: 3 of 4 fingers curled

    // Roll: 2D angle of (pinky_mcp → index_mcp). Rotates as the wrist tilts.
    const rollAngle = Math.atan2(indexMcp.y - pinkyMcp.y, indexMcp.x - pinkyMcp.x);

    // Write driver
    driver.visible         = true;
    driver.pinch           = pinchRaw;
    driver.pinchNormalized = state.sm;
    driver.pinchVelocity   = pinchVel;
    driver.x               = px;
    driver.y               = py;
    driver.vx              = vx;
    driver.vy              = vy;
    driver.speed           = Math.hypot(vx, vy);
    driver.handOpenness    = openness;
    driver.palmFacing      = palmFacing;
    driver.isFist          = isFist;
    driver.rollAngle       = rollAngle;
    driver.landmarks       = lm;

    // Keep `this.driver` pointing at the legacy single-hand driver
    if (this.numHands === 1) this.driver = this.leftDriver;
  }

  // Draw mirrored webcam + 21-pt hand landmarks for both hands
  drawPreview(canvas) {
    if (!canvas || !this.video) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();

    const BONES = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17],
    ];

    const drawHand = (lm, color, accent) => {
      if (!lm) return;
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [a,b] of BONES) {
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
      }
      ctx.stroke();
      for (let i = 0; i < lm.length; i++) {
        const big = (i === 4 || i === 8);
        ctx.fillStyle = big ? '#fff' : 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.arc(lm[i].x * w, lm[i].y * h, big ? 3 : 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lm[4].x * w, lm[4].y * h);
      ctx.lineTo(lm[8].x * w, lm[8].y * h);
      ctx.stroke();
      ctx.restore();
    };

    // Left hand = playhead control (red). Right hand = blob-tracker gestures (cyan).
    drawHand(this.leftDriver.landmarks,  'rgba(239,68,68,0.8)',   'rgba(255,255,255,0.9)');
    drawHand(this.rightDriver.landmarks, 'rgba(34,211,238,0.8)',  'rgba(250,204,21,0.9)');

    // Right-hand gesture badges — indicate what the blob tracker is currently
    // reading from the hand (palm/back, fist, pinch). Drawn in the preview's
    // top-right corner so the performer sees it without leaving the stage.
    if (this.numHands === 2 && this.rightDriver.visible) {
      const d = this.rightDriver;
      const lines = [
        d.palmFacing ? 'PALM' : 'BACK',
        d.isFist ? 'FIST' : '',
        `pinch ${d.pinchNormalized.toFixed(2)}`,
      ].filter(Boolean);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const boxW = 70, boxH = lines.length * 12 + 4;
      ctx.fillRect(w - boxW - 4, 4, boxW, boxH);
      ctx.fillStyle = d.isFist ? '#f87171' : '#22d3ee';
      ctx.font = '10px ui-monospace,Menlo,monospace';
      lines.forEach((ln, i) => ctx.fillText(ln, w - boxW, 15 + i * 12));
      ctx.restore();
    }

    // Debug badge: raw detection count + handedness labels
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(4, 4, 92, 16);
    ctx.fillStyle = '#22d3ee';
    ctx.font = '10px ui-monospace,Menlo,monospace';
    const label = `hands: ${this.lastDetectionCount} [${this.lastHandedness.join(',') || '-'}]`;
    ctx.fillText(label, 7, 15);
    ctx.restore();
  }
}
