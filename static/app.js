// app.js — wires together the video decoder, audio engine, playhead, and GL renderer.

import { VideoDecoder } from '/static/video-decoder.js';
import { AudioEngine } from '/static/audio-engine.js';
import { Playhead } from '/static/playhead.js';
import { GLRenderer } from '/static/renderer-gl.js';
import { HandTracker } from '/static/hand-tracker.js';
import { BlobTracker } from '/static/blob-tracker.js';
import { BlobRenderer } from '/static/blob-renderer.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const videoDrop = $('video-drop'), videoInput = $('video-input');
const audioDrop = $('audio-drop'), audioInput = $('audio-input');
const videoMeta = $('video-meta'), videoProgress = $('video-progress'), videoProgressBar = $('video-progress-bar');
const audioMeta = $('audio-meta');
const playBtn = $('play-btn'), stopBtn = $('stop-btn');
const idleOverlay = $('idle-overlay');
const statusText = $('status-text'), fpsText = $('fps-text');
const glCanvas = $('gl-canvas');
const overlayCanvas = $('overlay-canvas');
const waveCanvas = $('wave-canvas');
const hudMode = $('hud-mode'),
      hudPos = $('hud-pos'), hudTotal = $('hud-total'),
      hudEnv = $('hud-env'),
      hudBass = $('hud-bass'), hudMid = $('hud-mid'), hudHigh = $('hud-high');

// ---------- Engine ----------
const decoder = new VideoDecoder();
const audio = new AudioEngine();
const playhead = new Playhead();
const hand = new HandTracker();
const blobTracker = new BlobTracker();
const blobRenderer = new BlobRenderer();
let renderer = null;
try { renderer = new GLRenderer(glCanvas); }
catch (e) { alert('WebGL2 required. ' + e.message); }

// ---------- Control state ----------
const ctrl = {
  // mode
  mode: 'envelope', // 'envelope' | 'momentum'

  // envelope params
  envAttackMs: 80,
  envReleaseMs: 300,
  envReach: 1.0,
  envFloor: 0.0,
  envGain: 1.2,
  envCurve: 1.2,
  envJitter: 0.0,
  envSnap: 0.0,
  envHold: 0.0,
  envSource: 'rms',

  // segment roam
  roamEnabled: false,
  roamTrigger: 'transient',
  roamBpm: 120,
  roamSize: 0.25,
  roamSizeJitter: 0.5,
  roamDirection: 'any',
  roamSmoothMs: 80,
  roamContinuity: 0.35,

  // momentum params
  bassGain: 1.4, midGain: 0.6, highGain: 0.35,
  damping: 0.88, elastic: 0.15,
  loop: true, backwardScrub: true,

  // hand params
  handMapping: 'velocity',
  handReach: 1.0,
  handFloor: 0.0,
  handSensitivity: 2.0,
  handDamping: 0.9,
  handSmoothMs: 80,
  handAudioJitter: 0.0,
  handAudioSnap: 0.0,

  // two-hand — left hand = playhead, right hand = blob tracker gestures
  twoHand: false,
  swapHands: false,

  // ---- Blob tracker (port of touchdesigner-blobtracker) ----
  // Standalone: works regardless of Hand tracker / mode.
  blobEnabled: false,
  blobSource: 'video',           // 'video' | 'webcam'
  blobStyle: 'circles',          // 'circles' | 'hex' | 'boxes' | 'trails'
  blobDiffThresh: 18,            // 0..255 — frame-diff luminance threshold
  blobMinArea: 60,               // px² in work-canvas coords
  blobMaxArea: 100000,
  blobMaxBlobs: 40,
  blobMaxDistance: 120,          // ID matching max travel between frames (px)
  blobMotionSmoothing: 0.5,      // 0..1
  blobSizeSmoothing: 0.5,        // 0..1
  blobResolutionScale: 0.5,      // detection resolution (0.1..1.0)
  blobFrameSkip: 0,              // 0 = every frame; N = process 1 of every N

  // Blob overlay look
  blobColor: '#ffffff',
  blobOpacity: 0.65,
  blobLineWeight: 1.0,
  blobShowIds: false,
  blobShowXy: false,
  blobShowMetrics: false,
  blobDrawConnections: false,
  blobTrailLength: 18,
  blobFrozen: false,             // fist-gesture freeze flag

  // Right-hand gesture control of the blob tracker
  blobGestureDrive: false,       // when true + hand enabled + twoHand → right hand controls tracker

  // render (shared)
  trail: 0.30, blend: 1.0,
};

// push all params to playhead
function pushParams() { playhead.setParams(ctrl); }
pushParams();

// ---------- Mode switcher ----------
const modeEnvBtn = $('mode-envelope'), modeMomBtn = $('mode-momentum'), modeHandBtn = $('mode-hand');
const panelEnv = $('panel-envelope'), panelMom = $('panel-momentum'), panelHand = $('panel-hand');
const panelRoam = $('panel-roam');
const modeDesc = $('mode-desc');

const MODE_DESC = {
  envelope: 'Position tracks audio envelope directly. Loud = open, quiet = closed. Perfect for blooming, breathing, morphing.',
  momentum: 'Audio injects forward velocity; playhead integrates and scrubs back on decay. Perfect for drums, explosions, DJ scrubbing.',
  hand:     'Pinch gesture drives the playhead. Opening pinch = forward, closing = backward. Audio can layer on top.',
};

function applyMode(mode) {
  ctrl.mode = mode;
  pushParams();
  modeEnvBtn.classList.toggle('active', mode === 'envelope');
  modeMomBtn.classList.toggle('active', mode === 'momentum');
  modeHandBtn.classList.toggle('active', mode === 'hand');
  panelEnv.classList.toggle('hidden', mode !== 'envelope');
  panelMom.classList.toggle('hidden', mode !== 'momentum');
  panelHand.classList.toggle('hidden', mode !== 'hand');
  // Roam only makes sense within envelope mode — hide it elsewhere
  if (panelRoam) panelRoam.classList.toggle('hidden', mode !== 'envelope');
  modeDesc.textContent = MODE_DESC[mode];
  hudMode.textContent = mode;
}
modeEnvBtn.addEventListener('click', () => applyMode('envelope'));
modeMomBtn.addEventListener('click', () => applyMode('momentum'));
modeHandBtn.addEventListener('click', () => applyMode('hand'));
applyMode('envelope');

// ---------- Slider wiring ----------
function wireSlider(id, valId, key, fmt = v => v.toFixed(2)) {
  const s = $(id), v = $(valId);
  if (!s || !v) return;
  s.addEventListener('input', () => {
    ctrl[key] = parseFloat(s.value);
    v.textContent = fmt(ctrl[key]);
    pushParams();
  });
}

// momentum sliders
wireSlider('ctrl-bass', 'val-bass', 'bassGain');
wireSlider('ctrl-mid',  'val-mid',  'midGain');
wireSlider('ctrl-high', 'val-high', 'highGain');
wireSlider('ctrl-damp', 'val-damp', 'damping');
wireSlider('ctrl-elastic', 'val-elastic', 'elastic');

// envelope sliders
wireSlider('ctrl-env-attack', 'val-env-attack', 'envAttackMs', v => Math.round(v) + ' ms');
wireSlider('ctrl-env-release','val-env-release','envReleaseMs', v => Math.round(v) + ' ms');
wireSlider('ctrl-env-reach',  'val-env-reach',  'envReach', v => Math.round(v * 100) + '%');
wireSlider('ctrl-env-floor',  'val-env-floor',  'envFloor', v => Math.round(v * 100) + '%');
wireSlider('ctrl-env-gain',   'val-env-gain',   'envGain');
wireSlider('ctrl-env-curve',  'val-env-curve',  'envCurve');
wireSlider('ctrl-env-jitter', 'val-env-jitter', 'envJitter');
wireSlider('ctrl-env-snap',   'val-env-snap',   'envSnap');
wireSlider('ctrl-env-hold',   'val-env-hold',   'envHold');

// Roam sliders
wireSlider('ctrl-roam-bpm',     'val-roam-bpm',     'roamBpm',        v => Math.round(v));
wireSlider('ctrl-roam-size',    'val-roam-size',    'roamSize',       v => Math.round(v * 100) + '%');
wireSlider('ctrl-roam-sizejit', 'val-roam-sizejit', 'roamSizeJitter');
wireSlider('ctrl-roam-cont',    'val-roam-cont',    'roamContinuity');
wireSlider('ctrl-roam-smooth',  'val-roam-smooth',  'roamSmoothMs',   v => Math.round(v) + ' ms');

// Hand sliders
wireSlider('ctrl-hand-sens',       'val-hand-sens',       'handSensitivity');
wireSlider('ctrl-hand-damp',       'val-hand-damp',       'handDamping');
wireSlider('ctrl-hand-smooth',     'val-hand-smooth',     'handSmoothMs',    v => Math.round(v) + ' ms');
wireSlider('ctrl-hand-reach',      'val-hand-reach',      'handReach',       v => Math.round(v * 100) + '%');
wireSlider('ctrl-hand-floor',      'val-hand-floor',      'handFloor',       v => Math.round(v * 100) + '%');
wireSlider('ctrl-hand-audiosnap',  'val-hand-audiosnap',  'handAudioSnap');
wireSlider('ctrl-hand-audiojit',   'val-hand-audiojit',   'handAudioJitter');

// Hand dead-zone is applied to the tracker itself (not the playhead)
$('ctrl-hand-dead').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  $('val-hand-dead').textContent = v.toFixed(2);
  hand.setDeadZone(v);
});
$('ctrl-hand-invert').addEventListener('change', e => {
  hand.setInvert(e.target.checked);
});

// Mapping (velocity / position)
function setHandMapping(m) {
  ctrl.handMapping = m;
  document.querySelectorAll('.hand-map-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.map === m);
  });
  $('val-hand-map').textContent = m === 'position' ? 'Position' : 'Velocity';
  pushParams();
}
document.querySelectorAll('.hand-map-btn').forEach(b => {
  b.addEventListener('click', () => setHandMapping(b.dataset.map));
});
setHandMapping('velocity');

// Enable / calibrate buttons
const handEnableBtn    = $('hand-enable');
const handCalibrateBtn = $('hand-calibrate');
const handStatusEl     = $('hand-status');
const handPreview      = $('hand-preview');
const handNoCam        = $('hand-no-cam');

// Size the preview canvas to its CSS size × DPR so drawImage is crisp.
function sizeHandPreview() {
  if (!handPreview) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = handPreview.getBoundingClientRect();
  handPreview.width  = Math.max(1, Math.floor(r.width  * dpr));
  handPreview.height = Math.max(1, Math.floor(r.height * dpr));
}
sizeHandPreview();
window.addEventListener('resize', sizeHandPreview);

handEnableBtn.addEventListener('click', async () => {
  if (hand.enabled) {
    hand.disable();
    handEnableBtn.textContent = 'Enable';
    handStatusEl.textContent = 'Camera off. Click Enable to start hand tracking.';
    handNoCam.classList.remove('hidden');
    return;
  }
  handEnableBtn.textContent = 'Loading…';
  handEnableBtn.disabled = true;
  handStatusEl.textContent = 'Requesting camera permission & loading MediaPipe…';
  try {
    await hand.enable();
    handEnableBtn.textContent = 'Disable';
    handStatusEl.textContent =
      'Tracking active. Pinch thumb + index. Opening = forward, closing = backward. Click Calibrate and move from fully closed → wide open.';
    handNoCam.classList.add('hidden');
    sizeHandPreview();
    // Auto-calibrate on first enable so bounds learn immediately
    hand.recalibrate();
  } catch (e) {
    console.error(e);
    handEnableBtn.textContent = 'Enable';
    handStatusEl.textContent = 'Camera error: ' + (e.message || e) + '. Check browser permissions.';
  } finally {
    handEnableBtn.disabled = false;
  }
});

handCalibrateBtn.addEventListener('click', () => {
  if (!hand.enabled) {
    handStatusEl.textContent = 'Enable camera first.';
    return;
  }
  hand.recalibrate();
  handStatusEl.textContent = 'Calibrating… pinch all the way closed, then open wide. (2s)';
  setTimeout(() => {
    handStatusEl.textContent = 'Calibration locked. Pinch to drive the playhead.';
  }, 2100);
});

// ---------- Two-hand wiring (left = playhead, right = blob gestures) ----------
async function setTwoHand(on) {
  ctrl.twoHand = on;
  const chk = $('ctrl-two-hand'); if (chk) chk.checked = on;
  try { await hand.setNumHands(on ? 2 : 1); } catch (_) {}
  if (on && hand.enabled) {
    handStatusEl.textContent =
      'Two-hand: left hand drives the playhead, right hand controls the blob tracker.';
  }
}
const twoHandCtrl = $('ctrl-two-hand');
if (twoHandCtrl) twoHandCtrl.addEventListener('change', e => setTwoHand(e.target.checked));

const swapHandsCtrl = $('ctrl-swap-hands');
if (swapHandsCtrl) swapHandsCtrl.addEventListener('change', e => {
  ctrl.swapHands = e.target.checked;
  hand.setSwapHands(ctrl.swapHands);
});

// ---------- Blob Tracker wiring ----------
const blobTrackerCtrls = $('blob-tracker-controls');
function setBlobEnabled(on) {
  ctrl.blobEnabled = on;
  const chk = $('ctrl-blob-enabled'); if (chk) chk.checked = on;
  if (blobTrackerCtrls) {
    blobTrackerCtrls.classList.toggle('opacity-50', !on);
    blobTrackerCtrls.classList.toggle('pointer-events-none', !on);
  }
  if (!on) {
    // Clear overlay immediately
    if (overlayCanvas) {
      const octx = overlayCanvas.getContext('2d');
      octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
    blobTracker.reset();
  }
}
const blobEnabledCtrl = $('ctrl-blob-enabled');
if (blobEnabledCtrl) blobEnabledCtrl.addEventListener('change', e => setBlobEnabled(e.target.checked));

function setBlobSource(s) {
  ctrl.blobSource = s;
  document.querySelectorAll('.blob-src-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.src === s);
  });
  const label = $('val-blob-source');
  if (label) label.textContent = s === 'webcam' ? 'Webcam' : 'Video';
  blobTracker.reset(); // source changed — invalidate prev luma
}
document.querySelectorAll('.blob-src-btn').forEach(b => {
  b.addEventListener('click', () => setBlobSource(b.dataset.src));
});
setBlobSource('video');

function setBlobStyle(s) {
  ctrl.blobStyle = s;
  document.querySelectorAll('.blob-style-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.style === s);
  });
  const labels = { circles: 'Circles', hex: 'Hex', boxes: 'Boxes', trails: 'Trails' };
  const label = $('val-blob-style');
  if (label) label.textContent = labels[s] || s;
}
document.querySelectorAll('.blob-style-btn').forEach(b => {
  b.addEventListener('click', () => setBlobStyle(b.dataset.style));
});
setBlobStyle('circles');

// Detection sliders
wireSlider('ctrl-blob-diff',          'val-blob-diff',          'blobDiffThresh',       v => Math.round(v));
wireSlider('ctrl-blob-minarea',       'val-blob-minarea',       'blobMinArea',          v => Math.round(v));
wireSlider('ctrl-blob-maxblobs',      'val-blob-maxblobs',      'blobMaxBlobs',         v => Math.round(v));
wireSlider('ctrl-blob-motionsmooth',  'val-blob-motionsmooth',  'blobMotionSmoothing');
wireSlider('ctrl-blob-resscale',      'val-blob-resscale',      'blobResolutionScale');

// Look controls
wireSlider('ctrl-blob-opacity',       'val-blob-opacity',       'blobOpacity');
wireSlider('ctrl-blob-lineweight',    'val-blob-lineweight',    'blobLineWeight');

const blobColorCtrl = $('ctrl-blob-color');
if (blobColorCtrl) blobColorCtrl.addEventListener('input', e => {
  ctrl.blobColor = e.target.value;
  const lbl = $('val-blob-color'); if (lbl) lbl.textContent = e.target.value;
});

['ctrl-blob-showids', 'ctrl-blob-showxy', 'ctrl-blob-showmetrics', 'ctrl-blob-connections'].forEach(id => {
  const el = $(id); if (!el) return;
  el.addEventListener('change', e => {
    if (id === 'ctrl-blob-showids')      ctrl.blobShowIds         = e.target.checked;
    if (id === 'ctrl-blob-showxy')       ctrl.blobShowXy          = e.target.checked;
    if (id === 'ctrl-blob-showmetrics')  ctrl.blobShowMetrics     = e.target.checked;
    if (id === 'ctrl-blob-connections')  ctrl.blobDrawConnections = e.target.checked;
  });
});

const blobGestureCtrl = $('ctrl-blob-gesture');
if (blobGestureCtrl) blobGestureCtrl.addEventListener('change', e => {
  ctrl.blobGestureDrive = e.target.checked;
});

// ---------- Gesture drive: right hand controls the blob tracker ----------
// Pinch-cycle model:
//   - right hand present >0.5s → tracker ON (hide >1s → OFF)
//   - each pinch (thumb + index CLOSE then OPEN) advances the overlay style:
//       circles → hex → boxes → trails → circles …
//   - fist → freeze blobs
// Hysteresis thresholds on pinchNormalized (0 = fully closed, 1 = fully open):
const PINCH_CLOSED_TH = 0.20;
const PINCH_OPEN_TH   = 0.55;
const STYLE_CYCLE = ['circles', 'hex', 'boxes', 'trails'];

const gestureState = {
  presentSince: 0,       // ms while right hand continuously visible
  absentSince: 0,        // ms while right hand continuously invisible
  active: false,         // tracker on/off driven by presence
  pinchPhase: 'open',    // 'open' | 'closed' — tracks pinch state machine
  lastPinchAt: 0,        // ms timestamp of last accepted pinch cycle (cooldown)
  pinchCount: 0,         // how many full pinches seen this session
};

function cycleBlobStyle() {
  const i = STYLE_CYCLE.indexOf(ctrl.blobStyle);
  const next = STYLE_CYCLE[(i + 1) % STYLE_CYCLE.length];
  setBlobStyle(next);
}

function applyBlobGestureDrive(dt) {
  if (!ctrl.blobGestureDrive) {
    // Keep status label in sync even when gesture drive is off
    const status = $('val-blob-status');
    if (status) {
      status.textContent = ctrl.blobEnabled
        ? (blobTracker.blobs.length ? `tracking (${blobTracker.blobs.length})` : 'idle')
        : 'off';
    }
    const cnt = $('val-blob-count'); if (cnt) cnt.textContent = String(blobTracker.blobs.length);
    const hlbl = $('val-blob-hand'); if (hlbl) hlbl.textContent = '—';
    const fz = $('val-blob-freeze'); if (fz) fz.textContent = ctrl.blobFrozen ? 'ON' : '—';
    return;
  }
  if (!hand.enabled || !ctrl.twoHand) {
    const status = $('val-blob-status');
    if (status) status.textContent = 'gesture: need 2-hand';
    const hlbl = $('val-blob-hand'); if (hlbl) hlbl.textContent = '—';
    return;
  }

  const rh = hand.rightDriver;
  const dtMs = dt * 1000;
  const now = performance.now();

  // --- Presence hysteresis → enable/disable tracker ---
  if (rh && rh.visible) {
    gestureState.presentSince += dtMs;
    gestureState.absentSince = 0;
    if (!gestureState.active && gestureState.presentSince > 500) {
      gestureState.active = true;
      setBlobEnabled(true);
    }
  } else {
    gestureState.absentSince += dtMs;
    gestureState.presentSince = 0;
    if (gestureState.active && gestureState.absentSince > 1000) {
      gestureState.active = false;
      setBlobEnabled(false);
      // Reset pinch machine so re-appearing hand starts clean
      gestureState.pinchPhase = 'open';
    }
  }

  // --- Pinch cycle → advance style (circles → hex → boxes → trails) ---
  // Detect a full CLOSE→OPEN stroke, with a small cooldown to prevent double-fires.
  if (rh && rh.visible && rh.pinchNormalized != null) {
    const p = rh.pinchNormalized;
    if (gestureState.pinchPhase === 'open' && p < PINCH_CLOSED_TH) {
      gestureState.pinchPhase = 'closed';
    } else if (
      gestureState.pinchPhase === 'closed' &&
      p > PINCH_OPEN_TH &&
      (now - gestureState.lastPinchAt) > 350
    ) {
      gestureState.pinchPhase = 'open';
      gestureState.lastPinchAt = now;
      gestureState.pinchCount++;
      cycleBlobStyle();
    }
  }

  // --- Fist → freeze blobs ---
  const frozen = !!(rh && rh.visible && rh.isFist);
  if (frozen !== ctrl.blobFrozen) {
    ctrl.blobFrozen = frozen;
  }

  // --- Status HUD ---
  const status = $('val-blob-status');
  if (status) {
    status.textContent = gestureState.active
      ? (ctrl.blobFrozen
          ? 'frozen'
          : (blobTracker.blobs.length ? `tracking (${blobTracker.blobs.length})` : 'armed'))
      : 'waiting';
  }
  const cnt = $('val-blob-count'); if (cnt) cnt.textContent = String(blobTracker.blobs.length);
  const hlbl = $('val-blob-hand');
  if (hlbl) {
    hlbl.textContent = rh && rh.visible
      ? `${gestureState.pinchPhase === 'closed' ? 'pinch' : 'open'} · ×${gestureState.pinchCount}`
      : '—';
  }
  const fz = $('val-blob-freeze'); if (fz) fz.textContent = ctrl.blobFrozen ? 'ON' : '—';
}

// Roam enable toggle
const roamCtrls = $('roam-controls');
function setRoamEnabled(on) {
  ctrl.roamEnabled = on;
  $('ctrl-roam-enabled').checked = on;
  roamCtrls.classList.toggle('opacity-50', !on);
  roamCtrls.classList.toggle('pointer-events-none', !on);
  pushParams();
}
$('ctrl-roam-enabled').addEventListener('change', e => setRoamEnabled(e.target.checked));

// Roam trigger buttons
function setRoamTrigger(t) {
  ctrl.roamTrigger = t;
  document.querySelectorAll('.roam-trig-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.trig === t);
  });
  const labels = { transient: 'Transient', tempo: 'Tempo', random: 'Random' };
  $('val-roam-trigger').textContent = labels[t];
  $('roam-bpm-wrap').classList.toggle('hidden', t !== 'tempo');
  pushParams();
}
document.querySelectorAll('.roam-trig-btn').forEach(b => {
  b.addEventListener('click', () => setRoamTrigger(b.dataset.trig));
});
setRoamTrigger('transient');

// Roam direction buttons
function setRoamDirection(d) {
  ctrl.roamDirection = d;
  document.querySelectorAll('.roam-dir-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.dir === d);
  });
  const labels = { forward: 'Forward', backward: 'Backward', any: 'Any' };
  $('val-roam-dir').textContent = labels[d];
  pushParams();
}
document.querySelectorAll('.roam-dir-btn').forEach(b => {
  b.addEventListener('click', () => setRoamDirection(b.dataset.dir));
});
setRoamDirection('any');

// render sliders
wireSlider('ctrl-trail', 'val-trail', 'trail');
wireSlider('ctrl-blend', 'val-blend', 'blend');

// momentum checkboxes
$('ctrl-loop').addEventListener('change', e => { ctrl.loop = e.target.checked; pushParams(); });
$('ctrl-scrub').addEventListener('change', e => { ctrl.backwardScrub = e.target.checked; pushParams(); });

// envelope source buttons
function setEnvSource(src) {
  ctrl.envSource = src;
  pushParams();
  document.querySelectorAll('.env-src-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.src === src);
  });
  const labels = { rms: 'RMS', bass: 'Bass', mid: 'Mid', high: 'High', mix: 'Mix' };
  $('val-env-src').textContent = labels[src];
}
document.querySelectorAll('.env-src-btn').forEach(btn => {
  btn.addEventListener('click', () => setEnvSource(btn.dataset.src));
});
setEnvSource('rms');

// ---------- Presets ----------
const PRESETS = {
  // Envelope-based presets
  twitch: {
    // cloud.i0-style: puppet-face reaction. Every kick = snap to extreme, every hat = micro-tremor.
    mode: 'envelope',
    envSource: 'mix', envAttackMs: 8, envReleaseMs: 140, envReach: 1.0, envFloor: 0.0,
    envGain: 1.6, envCurve: 2.0,
    envJitter: 0.30, envSnap: 0.85, envHold: 0.55,
    roamEnabled: false,
    trail: 0.15, blend: 1.0,
  },
  roam: {
    // Segment roaming — each beat picks a new window, envelope animates within it.
    // Uses the whole video as a pool; great for abstract / variety-rich clips.
    mode: 'envelope',
    envSource: 'rms', envAttackMs: 30, envReleaseMs: 220, envReach: 1.0, envFloor: 0.0,
    envGain: 1.4, envCurve: 1.3,
    envJitter: 0.10, envSnap: 0.40, envHold: 0.20,
    roamEnabled: true,
    roamTrigger: 'transient',
    roamSize: 0.22, roamSizeJitter: 0.6,
    roamDirection: 'any', roamContinuity: 0.30, roamSmoothMs: 60,
    trail: 0.20, blend: 1.0,
  },
  bloom: {
    mode: 'envelope',
    envSource: 'rms', envAttackMs: 120, envReleaseMs: 450, envReach: 1.0, envFloor: 0.0,
    envGain: 1.3, envCurve: 1.0, envJitter: 0.0, envSnap: 0.0, envHold: 0.0,
    roamEnabled: false,
    trail: 0.10, blend: 1.0,
  },
  breath: {
    mode: 'envelope',
    envSource: 'rms', envAttackMs: 300, envReleaseMs: 800, envReach: 0.85, envFloor: 0.05,
    envGain: 1.1, envCurve: 0.8, envJitter: 0.0, envSnap: 0.0, envHold: 0.0,
    roamEnabled: false,
    trail: 0.05, blend: 1.0,
  },
  pulse: {
    mode: 'envelope',
    envSource: 'bass', envAttackMs: 15, envReleaseMs: 180, envReach: 1.0, envFloor: 0.0,
    envGain: 1.8, envCurve: 1.6, envJitter: 0.15, envSnap: 0.60, envHold: 0.25,
    roamEnabled: false,
    trail: 0.25, blend: 1.0,
  },
  // Momentum-based presets
  smooth: {
    mode: 'momentum',
    bassGain: 0.9, midGain: 0.5, highGain: 0.15, damping: 0.94, elastic: 0.08,
    trail: 0.15, blend: 1.0,
  },
  punch:  {
    mode: 'momentum',
    bassGain: 1.8, midGain: 0.5, highGain: 0.25, damping: 0.82, elastic: 0.25,
    trail: 0.20, blend: 1.0,
  },
  dj:     {
    mode: 'momentum',
    bassGain: 2.2, midGain: 0.7, highGain: 0.40, damping: 0.72, elastic: 0.55,
    trail: 0.40, blend: 1.0,
  },
  // Hand-based presets
  jog: {
    // Velocity mapping — pinch motion pushes the playhead like a jog wheel.
    // This is the closest to the reference reel: open = fwd, close = back.
    mode: 'hand',
    handMapping: 'velocity',
    handSensitivity: 2.5, handDamping: 0.88,
    handReach: 1.0, handFloor: 0.0,
    handAudioSnap: 0.0, handAudioJitter: 0.0,
    trail: 0.20, blend: 1.0,
  },
  scrubber: {
    // Position mapping — pinch distance = absolute scrub position (fader feel).
    mode: 'hand',
    handMapping: 'position',
    handSmoothMs: 60,
    handReach: 1.0, handFloor: 0.0,
    handAudioSnap: 0.0, handAudioJitter: 0.0,
    trail: 0.10, blend: 1.0,
  },
  handAudio: {
    // Hand drives position, audio layers snap + jitter on top — best of both.
    mode: 'hand',
    handMapping: 'position',
    handSmoothMs: 80,
    handReach: 1.0, handFloor: 0.0,
    handAudioSnap: 0.6, handAudioJitter: 0.25,
    trail: 0.25, blend: 1.0,
  },
};

function applyPreset(p) {
  if (p.mode) applyMode(p.mode);
  Object.assign(ctrl, p);

  // Sync sliders → DOM
  const syncs = [
    ['ctrl-bass',  'val-bass',  ctrl.bassGain, v => v.toFixed(2)],
    ['ctrl-mid',   'val-mid',   ctrl.midGain,  v => v.toFixed(2)],
    ['ctrl-high',  'val-high',  ctrl.highGain, v => v.toFixed(2)],
    ['ctrl-damp',  'val-damp',  ctrl.damping,  v => v.toFixed(2)],
    ['ctrl-elastic','val-elastic', ctrl.elastic, v => v.toFixed(2)],
    ['ctrl-env-attack',  'val-env-attack',  ctrl.envAttackMs,  v => Math.round(v) + ' ms'],
    ['ctrl-env-release', 'val-env-release', ctrl.envReleaseMs, v => Math.round(v) + ' ms'],
    ['ctrl-env-reach',   'val-env-reach',   ctrl.envReach,     v => Math.round(v * 100) + '%'],
    ['ctrl-env-floor',   'val-env-floor',   ctrl.envFloor,     v => Math.round(v * 100) + '%'],
    ['ctrl-env-gain',    'val-env-gain',    ctrl.envGain,      v => v.toFixed(2)],
    ['ctrl-env-curve',   'val-env-curve',   ctrl.envCurve,     v => v.toFixed(2)],
    ['ctrl-env-jitter',  'val-env-jitter',  ctrl.envJitter,    v => v.toFixed(2)],
    ['ctrl-env-snap',    'val-env-snap',    ctrl.envSnap,      v => v.toFixed(2)],
    ['ctrl-env-hold',    'val-env-hold',    ctrl.envHold,      v => v.toFixed(2)],
    ['ctrl-roam-bpm',     'val-roam-bpm',     ctrl.roamBpm,        v => Math.round(v)],
    ['ctrl-roam-size',    'val-roam-size',    ctrl.roamSize,       v => Math.round(v * 100) + '%'],
    ['ctrl-roam-sizejit', 'val-roam-sizejit', ctrl.roamSizeJitter, v => v.toFixed(2)],
    ['ctrl-roam-cont',    'val-roam-cont',    ctrl.roamContinuity, v => v.toFixed(2)],
    ['ctrl-roam-smooth',  'val-roam-smooth',  ctrl.roamSmoothMs,   v => Math.round(v) + ' ms'],
    ['ctrl-hand-sens',      'val-hand-sens',      ctrl.handSensitivity, v => v.toFixed(2)],
    ['ctrl-hand-damp',      'val-hand-damp',      ctrl.handDamping,     v => v.toFixed(2)],
    ['ctrl-hand-smooth',    'val-hand-smooth',    ctrl.handSmoothMs,    v => Math.round(v) + ' ms'],
    ['ctrl-hand-reach',     'val-hand-reach',     ctrl.handReach,       v => Math.round(v * 100) + '%'],
    ['ctrl-hand-floor',     'val-hand-floor',     ctrl.handFloor,       v => Math.round(v * 100) + '%'],
    ['ctrl-hand-audiosnap', 'val-hand-audiosnap', ctrl.handAudioSnap,   v => v.toFixed(2)],
    ['ctrl-hand-audiojit',  'val-hand-audiojit',  ctrl.handAudioJitter, v => v.toFixed(2)],
    ['ctrl-trail', 'val-trail', ctrl.trail, v => v.toFixed(2)],
    ['ctrl-blend', 'val-blend', ctrl.blend, v => v.toFixed(2)],
  ];
  for (const [sid, vid, val, fmt] of syncs) {
    const s = $(sid), v = $(vid);
    if (s) s.value = val;
    if (v) v.textContent = fmt(val);
  }
  if (p.envSource) setEnvSource(p.envSource);
  if (p.roamTrigger) setRoamTrigger(p.roamTrigger);
  if (p.roamDirection) setRoamDirection(p.roamDirection);
  if (p.roamEnabled !== undefined) setRoamEnabled(p.roamEnabled);
  if (p.handMapping) setHandMapping(p.handMapping);
  pushParams();
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset]; if (!preset) return;
    applyPreset(preset);
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// ---------- Drop zones ----------
function enableDrop(zone, input, cb) {
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', e => { if (e.target.files[0]) cb(e.target.files[0]); });
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drop-active'); }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drop-active'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) cb(f); });
}
enableDrop(videoDrop, videoInput, handleVideoFile);
enableDrop(audioDrop, audioInput, handleAudioFile);

// ---------- Video handling ----------
let videoLoaded = false;
async function handleVideoFile(file) {
  statusText.textContent = 'decoding video...';
  videoProgress.classList.remove('hidden');
  videoProgressBar.style.width = '0%';

  try {
    const dur = await quickDuration(file);
    if (dur > 50) {
      if (!confirm(`Video is ${dur.toFixed(1)}s — only the first 50s will be used (memory limit). Continue?`)) {
        statusText.textContent = 'idle';
        videoProgress.classList.add('hidden');
        return;
      }
    } else if (dur > 30) {
      if (!confirm(`Video is ${dur.toFixed(1)}s. Long clips use more memory and sample at a lower frame rate. Continue?`)) {
        statusText.textContent = 'idle';
        videoProgress.classList.add('hidden');
        return;
      }
    }
  } catch(e) {}

  try {
    const res = await decoder.decode(file, p => {
      videoProgressBar.style.width = (p * 100).toFixed(0) + '%';
    });
    videoProgressBar.style.width = '100%';
    renderer.setFrames(res.frames, res.width, res.height);
    playhead.reset(res.frameCount);

    $('video-frames').textContent = res.frameCount;
    $('video-duration').textContent = res.duration.toFixed(2) + 's';
    $('video-res').textContent = `${res.width}×${res.height}`;
    $('video-mem').textContent = (decoder.memoryBytes() / 1048576).toFixed(1) + ' MB';
    videoMeta.classList.remove('hidden');
    videoLoaded = true;
    idleOverlay.classList.toggle('hidden', videoLoaded && audioLoaded);
    setTimeout(() => videoProgress.classList.add('hidden'), 400);
    statusText.textContent = audioLoaded ? 'ready' : 'add audio';
    updateReadyState();
  } catch (e) {
    console.error(e);
    statusText.textContent = 'video error';
    alert('Failed to decode video: ' + e.message);
  }
}

function quickDuration(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { res(v.duration); URL.revokeObjectURL(v.src); };
    v.onerror = () => rej();
    v.src = URL.createObjectURL(file);
  });
}

// ---------- Audio handling ----------
let audioLoaded = false;
async function handleAudioFile(file) {
  statusText.textContent = 'decoding audio...';
  try {
    const info = await audio.loadFile(file);
    $('audio-duration').textContent = info.duration.toFixed(2) + 's';
    $('audio-sr').textContent = info.sampleRate + ' Hz';
    audioMeta.classList.remove('hidden');
    audioLoaded = true;
    idleOverlay.classList.toggle('hidden', videoLoaded && audioLoaded);
    statusText.textContent = videoLoaded ? 'ready' : 'add video';
    drawWaveformStatic();
    $('time-tot').textContent = fmtTime(info.duration);
    updateReadyState();
  } catch (e) {
    console.error(e);
    statusText.textContent = 'audio error';
    alert('Failed to decode audio: ' + e.message);
  }
}

function updateReadyState() {
  const ready = videoLoaded && audioLoaded;
  playBtn.disabled = !ready;
  stopBtn.disabled = !ready;
}

// ---------- Playback controls ----------
let isPlaying = false;
function setPlayingUI(on) {
  isPlaying = on;
  playBtn.innerHTML = on
    ? '<i class="fas fa-pause text-xs"></i>'
    : '<i class="fas fa-play text-xs"></i>';
}
playBtn.addEventListener('click', () => {
  if (!videoLoaded || !audioLoaded) return;
  if (isPlaying) {
    audio.pause();
    setPlayingUI(false);
    statusText.textContent = 'paused';
  } else {
    // Resume from the current offset (set by previous pause or scrub)
    const startFrom = audio.offset || 0;
    audio.play(startFrom >= audio.duration - 0.05 ? 0 : startFrom);
    setPlayingUI(true);
    statusText.textContent = 'playing';
  }
});
stopBtn.addEventListener('click', () => {
  audio.stop();
  audio.offset = 0;
  setPlayingUI(false);
  statusText.textContent = 'stopped';
  playhead.reset(playhead.frameCount);
});

// ---------- Waveform scrubbing ----------
// Click or drag anywhere on the waveform to seek. Preserves play/pause state.
// Hover shows a preview indicator + time tooltip without affecting playback.
let scrubState = {
  dragging: false,
  wasPlaying: false,
  hoverX: -1,      // CSS pixels, for hover indicator (-1 = no hover)
  hoverTime: 0,    // seconds
};

function xToTime(clientX) {
  if (!audio.duration) return 0;
  const rect = waveCanvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return frac * audio.duration;
}

function scrubBegin(clientX) {
  if (!audioLoaded) return;
  scrubState.dragging = true;
  scrubState.wasPlaying = isPlaying;
  // During active drag we stop the audio briefly to avoid repeatedly
  // recreating sources on every mousemove (would click/pop on every frame).
  if (isPlaying) {
    audio.pause();
    setPlayingUI(false);
  }
  scrubMove(clientX);
}
function scrubMove(clientX) {
  if (!scrubState.dragging) return;
  const t = xToTime(clientX);
  audio.seek(t); // sets offset only since we paused above
}
function scrubEnd(clientX) {
  if (!scrubState.dragging) return;
  scrubState.dragging = false;
  if (clientX !== undefined) {
    const t = xToTime(clientX);
    audio.seek(t);
  }
  // Resume playback if we were playing before
  if (scrubState.wasPlaying) {
    audio.play(audio.offset);
    setPlayingUI(true);
  }
}

waveCanvas.style.cursor = 'pointer';

waveCanvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  scrubBegin(e.clientX);
  // capture moves even outside the canvas
  const onMove = (ev) => scrubMove(ev.clientX);
  const onUp   = (ev) => {
    scrubEnd(ev.clientX);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

// Touch support
waveCanvas.addEventListener('touchstart', (e) => {
  if (!e.touches[0]) return;
  e.preventDefault();
  scrubBegin(e.touches[0].clientX);
}, { passive: false });
waveCanvas.addEventListener('touchmove', (e) => {
  if (!e.touches[0]) return;
  e.preventDefault();
  scrubMove(e.touches[0].clientX);
}, { passive: false });
waveCanvas.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  scrubEnd(t ? t.clientX : undefined);
}, { passive: false });

// Hover preview (non-drag)
waveCanvas.addEventListener('mousemove', (e) => {
  if (scrubState.dragging) return;
  const rect = waveCanvas.getBoundingClientRect();
  scrubState.hoverX = e.clientX - rect.left;
  scrubState.hoverTime = xToTime(e.clientX);
});
waveCanvas.addEventListener('mouseleave', () => {
  scrubState.hoverX = -1;
});

// ---------- Waveform draw ----------
function drawWaveformStatic() {
  const c = waveCanvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  if (!audio.waveformPeaks) return;
  const peaks = audio.waveformPeaks;
  const w = c.width, h = c.height, mid = h/2;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  const step = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const ph = peaks[i] * mid * 0.9;
    ctx.fillRect(i * step, mid - ph, Math.max(1, step - 0.5), ph * 2);
  }
}

function drawWaveformLive() {
  const c = waveCanvas;
  const ctx = c.getContext('2d');
  drawWaveformStatic();
  if (!audio.duration) return;
  const t = audio.currentTime();
  const prog = Math.max(0, Math.min(1, t / audio.duration));
  const x = prog * c.width;

  const energy = Math.min(1, audio.bass * 1.2 + audio.mid * 0.6);
  const grad = ctx.createLinearGradient(0, 0, x, 0);
  grad.addColorStop(0, `rgba(239,68,68,${0.25 + energy*0.5})`);
  grad.addColorStop(1, `rgba(239,68,68,${0.1 + energy*0.3})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, x, c.height);

  // Playhead line
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 1, 0, 2, c.height);

  // Hover preview (not dragging): vertical dashed line + time tooltip
  if (scrubState.hoverX >= 0 && !scrubState.dragging) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const hx = scrubState.hoverX * dpr;

    // Dashed vertical line
    ctx.save();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, c.height);
    ctx.stroke();
    ctx.restore();

    // Time tooltip — positioned near the top, flips to the left near the right edge
    const label = fmtTime(scrubState.hoverTime);
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    const padX = 6 * dpr, padY = 3 * dpr;
    const textW = ctx.measureText(label).width;
    const boxW = textW + padX * 2;
    const boxH = 14 * dpr + padY;
    let boxX = hx + 6 * dpr;
    if (boxX + boxW > c.width) boxX = hx - boxW - 6 * dpr;
    const boxY = 4 * dpr;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, boxX + padX, boxY + 11 * dpr);
  }

  // Dragging: show the drag position as a brighter red line
  if (scrubState.dragging) {
    ctx.fillStyle = 'rgba(239,68,68,0.9)';
    ctx.fillRect(x - 1.5, 0, 3, c.height);
  }
}

// ---------- Main loop ----------
let lastTs = performance.now();
let fpsAccum = 0, fpsCount = 0, fpsTimer = 0;

function loop(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;

  audio.update();

  // Playhead driver source — left hand in two-hand mode, else the legacy single driver
  const playheadHand = (hand.enabled && ctrl.twoHand) ? hand.leftDriver : hand.driver;

  playhead.update(
    { bass: audio.bass, mid: audio.mid, high: audio.high,
      transient: audio.transient, highTransient: audio.highTransient,
      rms: audio.rms },
    dt,
    playheadHand
  );

  // Webcam preview + pinch meter (no blob crosshair — blob is now a real tracker)
  if (hand.enabled && handPreview) {
    hand.drawPreview(handPreview);
    const pm = $('pinch-meter');
    const pv = $('val-pinch-live');
    const src = (ctrl.twoHand ? hand.leftDriver : hand.driver);
    if (pm) pm.style.width = (src.pinchNormalized * 100).toFixed(1) + '%';
    if (pv) pv.textContent = src.pinchNormalized.toFixed(2);
  }

  if (renderer && playhead.frameCount > 0) {
    const sample = playhead.sample();
    renderer.draw(sample, { trail: ctrl.trail, blendAmount: ctrl.blend });

    hudPos.textContent = String(Math.floor(playhead.position)).padStart(4,'0');
    hudTotal.textContent = String(playhead.frameCount - 1).padStart(4,'0');
    hudEnv.textContent = playhead.envelopeValue().toFixed(2);
    hudBass.textContent = audio.bass.toFixed(2);
    hudMid.textContent  = audio.mid.toFixed(2);
    hudHigh.textContent = audio.high.toFixed(2);
  }

  // ---------- Blob tracker + overlay ----------
  // The overlay 2D canvas is sized/positioned exactly over the GL canvas, then
  // the blob tracker analyzes the rendered frame and the blob renderer paints
  // detected blobs on the overlay.
  if (overlayCanvas) {
    const r = glCanvas.getBoundingClientRect();
    const parentR = overlayCanvas.parentElement.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(r.width));
    const cssH = Math.max(1, Math.round(r.height));
    if (overlayCanvas.width !== cssW) overlayCanvas.width = cssW;
    if (overlayCanvas.height !== cssH) overlayCanvas.height = cssH;
    overlayCanvas.style.width  = cssW + 'px';
    overlayCanvas.style.height = cssH + 'px';
    overlayCanvas.style.left   = (r.left - parentR.left) + 'px';
    overlayCanvas.style.top    = (r.top  - parentR.top)  + 'px';

    const octx = overlayCanvas.getContext('2d');
    octx.clearRect(0, 0, cssW, cssH);

    // Apply right-hand gesture control over tracker params (Path B)
    applyBlobGestureDrive(dt);

    if (ctrl.blobEnabled) {
      // Source selection: the uploaded video's rendered frame, or webcam
      let srcCanvas = null;
      if (ctrl.blobSource === 'webcam' && hand.video && hand.video.readyState >= 2) {
        srcCanvas = hand.video;
      } else if (glCanvas && glCanvas.width > 0 && glCanvas.height > 0) {
        srcCanvas = glCanvas;
      }
      if (srcCanvas) {
        blobTracker.setParams({
          diffThresh:       ctrl.blobDiffThresh,
          minArea:          ctrl.blobMinArea,
          maxArea:          ctrl.blobMaxArea,
          maxBlobs:         ctrl.blobMaxBlobs,
          maxDistance:      ctrl.blobMaxDistance,
          motionSmoothing:  ctrl.blobMotionSmoothing,
          sizeSmoothing:    ctrl.blobSizeSmoothing,
          resolutionScale:  ctrl.blobResolutionScale,
          frameSkip:        ctrl.blobFrameSkip,
          frozen:           ctrl.blobFrozen,
          trailLength:      ctrl.blobTrailLength,
        });
        blobTracker.update(srcCanvas, cssW, cssH, dt);

        blobRenderer.setParams({
          style:            ctrl.blobStyle,
          color:            ctrl.blobColor,
          opacity:          ctrl.blobOpacity,
          lineWeight:       ctrl.blobLineWeight,
          showIds:          ctrl.blobShowIds,
          showXY:           ctrl.blobShowXy,
          showMetrics:      ctrl.blobShowMetrics,
          drawConnections:  ctrl.blobDrawConnections,
        });
        blobRenderer.draw(octx, cssW, cssH, blobTracker.blobs);
      }
    }
  }

  // Envelope meter in sidebar
  if (ctrl.mode === 'envelope') {
    const env = playhead.envelopeValue();
    const meter = $('env-meter');
    const live  = $('val-env-live');
    if (meter) meter.style.width = (env * 100).toFixed(1) + '%';
    if (live)  live.textContent = env.toFixed(2);

    // Segment roam indicator (shows current segment as a blue bar)
    const seg = playhead.segmentBounds();
    const indicator = $('seg-indicator');
    const segLive = $('val-seg-live');
    if (indicator) {
      const lo = Math.min(seg.a, seg.b) * 100;
      const hi = Math.max(seg.a, seg.b) * 100;
      indicator.style.left  = lo.toFixed(1) + '%';
      indicator.style.width = Math.max(0.5, hi - lo).toFixed(1) + '%';
    }
    if (segLive) {
      const aPct = Math.round(seg.a * 100);
      const bPct = Math.round(seg.b * 100);
      const arrow = seg.b >= seg.a ? '→' : '←';
      segLive.textContent = `${aPct}% ${arrow} ${bPct}%`;
    }
  }

  drawWaveformLive();

  if (audioLoaded) {
    const ct = audio.currentTime();
    $('time-cur').textContent = fmtTime(ct);
    if (isPlaying && ct >= audio.duration) {
      isPlaying = false;
      playBtn.innerHTML = '<i class="fas fa-play text-xs"></i>';
      statusText.textContent = 'ended';
    }
  }

  fpsAccum += dt; fpsCount++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    fpsText.textContent = Math.round(fpsCount / fpsAccum) + ' fps';
    fpsAccum = 0; fpsCount = 0; fpsTimer = 0;
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1);
  return `${m}:${s.padStart(4,'0')}`;
}

// ---------- Resize ----------
let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (renderer) renderer.resize();
    drawWaveformStatic();
  });
});
