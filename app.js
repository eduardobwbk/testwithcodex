// Hand & Audio Reactive Playhead — main app
// Loaded as a single ES module. Uses MediaPipe Tasks Vision for hand tracking.

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---------- State ----------
const state = {
  mode: "position", // 'position' | 'velocity'
  loop: true,
  backward: true,
  twoHand: false,
  invertPinch: false,
  audioDrives: true,
  // hand
  hSensitivity: 2.0, hDamping: 0.90, hSmooth: 80,
  hReach: 1.0, hFloor: 0.0, hDead: 0.02,
  // envelope
  eAttack: 80, eRelease: 300, eSens: 1.20,
  eCurve: 1.20, eJitter: 0.20, eSnap: 0.30,
  // roam
  roamOn: false, rSize: 0.25, rJitter: 0.5, roamDir: "any",
  rCont: 0.35, rGlide: 80, rThresh: 0.55,
  // momentum
  mBass: 0.80, mMid: 0.40, mHigh: 0.20, mDamp: 0.92, mElastic: 0.10,
  // blob
  blobOn: true, blobStyle: "Circles",
  bSens: 22, bMinArea: 300, bMax: 16,
  bSmooth: 0.50, bScale: 0.5,
  bIds: false, bXY: false, bMetrics: true, bConn: false,
  // render
  rTrail: 0.30, rBlend: 1.00, rGain: 1.00,
  mirrorCam: true,
};

// runtime
const rt = {
  videoLoaded: false, audioLoaded: false, micActive: false,
  playing: false,
  playhead: 0,        // 0..1 normalized
  velocity: 0,
  smoothPinch: 0,
  pinchVel: 0,
  prevPinch: 0,
  envelope: 0,
  bass: 0, mid: 0, high: 0,
  transientLevel: 0, prevEnv: 0,
  segmentTarget: null, segmentGlideStart: 0, segmentFrom: 0, segmentTo: 0,
  hands: [],
  blobs: [],
  blobFrozen: false,
  fps: 0, lastT: performance.now(), frameCount: 0, fpsT: performance.now(),
  prevGray: null,
  trails: [], // for blob trail style
  blobIdSeed: 1,
  rightFist: false,
  rightPinchPrev: 0,
  rightPinchedAt: 0,
};

// presets
const PRESETS = {
  envelope: { eAttack: 50, eRelease: 220, eSens: 1.5, eCurve: 1.4, eJitter: 0.3, eSnap: 0.5, audioDrives: true },
  momentum: { mBass: 1.4, mMid: 0.6, mHigh: 0.3, mDamp: 0.95, mElastic: 0.18 },
  hand:     { hSensitivity: 2.5, hDamping: 0.88, hSmooth: 60, hReach: 1.0, hFloor: 0.0, hDead: 0.015, invertPinch: false, mode: "position" },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const out = $("output"), overlay = $("overlay");
const outCtx = out.getContext("2d");
const ovCtx  = overlay.getContext("2d");
const video = $("video"), webcam = $("webcam");
const camPreview = $("camPreview"), camCtx = camPreview.getContext("2d");
const statusEl = $("status");
const hudPlayhead = $("hudPlayhead"), hudPinch = $("hudPinch"), hudEnv = $("hudEnv"), hudFps = $("hudFps");
const envMeter = $("envMeter");
const camMeta = $("camMeta");
const timeEl = $("time");
const scrub = $("scrub");

function setStatus(text) { statusEl.textContent = text; }

// resize canvases to fit
function resize() {
  const stage = out.parentElement;
  const w = stage.clientWidth, h = stage.clientHeight;
  for (const c of [out, overlay]) {
    c.width = Math.max(2, Math.floor(w * devicePixelRatio));
    c.height = Math.max(2, Math.floor(h * devicePixelRatio));
    c.style.width = w + "px";
    c.style.height = h + "px";
  }
  camPreview.width = 320;
  camPreview.height = 240;
}
window.addEventListener("resize", resize);

// ---------- Knob (slider + label) builder ----------
function buildKnobs() {
  const nodes = document.querySelectorAll("[data-knob]");
  nodes.forEach((host) => {
    const key = host.dataset.knob;
    const min = parseFloat(host.dataset.min);
    const max = parseFloat(host.dataset.max);
    const step = parseFloat(host.dataset.step);
    const val = parseFloat(host.dataset.value);
    const label = host.dataset.label;
    if (key in state) state[key] = val;
    host.classList.add("knob");
    host.innerHTML = `
      <div class="knob-label">
        <span>${label}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" />
      </div>
      <div class="knob-value">${formatVal(val, step)}</div>
    `;
    const range = host.querySelector("input");
    const valOut = host.querySelector(".knob-value");
    range.addEventListener("input", () => {
      const v = parseFloat(range.value);
      state[key] = v;
      valOut.textContent = formatVal(v, step);
    });
    range.addEventListener("dblclick", () => {
      range.value = val; state[key] = val;
      valOut.textContent = formatVal(val, step);
    });
  });
}
function formatVal(v, step) {
  const decimals = step >= 1 ? 0 : (step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
  return Number(v).toFixed(decimals);
}
function applyPreset(p) {
  for (const k of Object.keys(p)) {
    state[k] = p[k];
    // sync UI
    const knobHost = document.querySelector(`[data-knob="${k}"]`);
    if (knobHost) {
      const input = knobHost.querySelector("input");
      const out = knobHost.querySelector(".knob-value");
      input.value = p[k];
      const step = parseFloat(input.step);
      out.textContent = formatVal(p[k], step);
    }
    const chk = $(k === "audioDrives" ? "audioDrives" : null);
    if (chk) chk.checked = !!p[k];
    if (k === "mode") {
      document.querySelectorAll("#modeSeg .seg-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.mode === p[k]);
      });
    }
    if (k === "invertPinch") $("invertPinch").checked = !!p[k];
  }
}

buildKnobs();
resize();

// ---------- UI wiring ----------
function bindCheckbox(id, key) {
  const el = $(id);
  el.checked = !!state[key];
  el.addEventListener("change", () => { state[key] = el.checked; });
}
bindCheckbox("loopChk", "loop");
bindCheckbox("backwardChk", "backward");
bindCheckbox("twoHand", "twoHand");
bindCheckbox("invertPinch", "invertPinch");
bindCheckbox("audioDrives", "audioDrives");
bindCheckbox("roamOn", "roamOn");
bindCheckbox("blobOn", "blobOn");
bindCheckbox("bIds", "bIds");
bindCheckbox("bXY", "bXY");
bindCheckbox("bMetrics", "bMetrics");
bindCheckbox("bConn", "bConn");
bindCheckbox("mirrorCam", "mirrorCam");

document.querySelectorAll("#modeSeg .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#modeSeg .seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.mode = btn.dataset.mode;
  });
});
$("blobStyle").addEventListener("change", (e) => state.blobStyle = e.target.value);
$("roamDir").addEventListener("change", (e) => state.roamDir = e.target.value);

$("presetEnvelope").addEventListener("click", () => applyPreset(PRESETS.envelope));
$("presetMomentum").addEventListener("click", () => applyPreset(PRESETS.momentum));
$("presetHand").addEventListener("click", () => applyPreset(PRESETS.hand));
$("resetAll").addEventListener("click", () => {
  rt.playhead = 0; rt.velocity = 0; rt.envelope = 0;
  if (video.duration) video.currentTime = 0;
});

$("loopBtn").addEventListener("click", () => {
  state.loop = !state.loop;
  $("loopChk").checked = state.loop;
  $("loopBtn").classList.toggle("active", state.loop);
});

$("playBtn").addEventListener("click", () => togglePlay());

scrub.addEventListener("input", () => {
  const v = parseFloat(scrub.value) / 1000;
  rt.playhead = v;
  if (video.duration) video.currentTime = v * video.duration;
});

// ---------- File / Drop / Mic ----------
function setupDropzone(id, inputId, onFile) {
  const dz = $(id), input = $(inputId);
  dz.addEventListener("click", (e) => {
    if (e.target.tagName !== "INPUT" && e.target.tagName !== "BUTTON") input.click();
  });
  input.addEventListener("change", (e) => {
    if (e.target.files[0]) onFile(e.target.files[0]);
  });
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.remove("dragover");
  }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

setupDropzone("dzVideo", "videoFile", (file) => {
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  video.addEventListener("loadedmetadata", () => {
    rt.videoLoaded = true;
    $("dzVideo").classList.add("loaded");
    $("dzVideo").querySelector(".dz-sub").textContent = file.name;
    setStatus("video loaded");
  }, { once: true });
});

setupDropzone("dzAudio", "audioFile", (file) => {
  loadAudioFile(file);
});

$("micBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  await enableMic();
});

// ---------- Audio Analyzer ----------
let audioCtx = null;
let analyser = null;
let analyserData = null;
let audioElement = null;
let audioSourceNode = null;

async function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

async function loadAudioFile(file) {
  await ensureAudioCtx();
  if (audioSourceNode) try { audioSourceNode.disconnect(); } catch (_) {}
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.crossOrigin = "anonymous";
    audioElement.loop = true;
  }
  audioElement.src = URL.createObjectURL(file);
  await audioElement.play().catch(() => {});
  audioSourceNode = audioCtx.createMediaElementSource(audioElement);
  audioSourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
  rt.audioLoaded = true;
  rt.micActive = false;
  $("dzAudio").classList.add("loaded");
  $("dzAudio").querySelector(".dz-sub").textContent = file.name;
  setStatus("audio loaded");
}

async function enableMic() {
  await ensureAudioCtx();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (audioSourceNode) try { audioSourceNode.disconnect(); } catch (_) {}
    audioSourceNode = audioCtx.createMediaStreamSource(stream);
    audioSourceNode.connect(analyser);
    rt.micActive = true;
    rt.audioLoaded = true;
    $("dzAudio").classList.add("loaded");
    $("dzAudio").querySelector(".dz-sub").textContent = "live mic";
    setStatus("mic active");
  } catch (err) {
    setStatus("mic denied");
    console.warn(err);
  }
}

function readEnvelope(dt) {
  if (!analyser) return;
  analyser.getByteFrequencyData(analyserData);
  // Bands: bass 0..6%, mid 6..30%, high 30..100%
  const N = analyserData.length;
  let bSum = 0, bN = 0, mSum = 0, mN = 0, hSum = 0, hN = 0, total = 0;
  for (let i = 0; i < N; i++) {
    const v = analyserData[i] / 255;
    total += v;
    if (i < N * 0.06) { bSum += v; bN++; }
    else if (i < N * 0.30) { mSum += v; mN++; }
    else { hSum += v; hN++; }
  }
  rt.bass = bN ? bSum / bN : 0;
  rt.mid  = mN ? mSum / mN : 0;
  rt.high = hN ? hSum / hN : 0;
  let raw = total / N;
  raw = Math.pow(raw * state.eSens, state.eCurve);
  raw = Math.min(1, raw);
  // attack/release envelope
  const att = 1 - Math.exp(-dt / Math.max(1, state.eAttack));
  const rel = 1 - Math.exp(-dt / Math.max(1, state.eRelease));
  if (raw > rt.envelope) rt.envelope += (raw - rt.envelope) * att;
  else rt.envelope += (raw - rt.envelope) * rel;
  rt.envelope = Math.max(0, Math.min(1, rt.envelope));
  // simple transient detection (delta against slower follower)
  rt.transientLevel = Math.max(0, rt.envelope - rt.prevEnv);
  rt.prevEnv = rt.prevEnv * 0.85 + rt.envelope * 0.15;
}

// ---------- Camera + MediaPipe HandLandmarker ----------
let handLandmarker = null;
let camStream = null;
let lastHandTs = -1;

async function initHandLandmarker() {
  setStatus("loading hand model…");
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  setStatus("hand model ready");
}

async function enableCamera() {
  if (!handLandmarker) await initHandLandmarker();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    webcam.srcObject = camStream;
    await webcam.play();
    $("camBtn").textContent = "Camera On";
    $("camBtn").disabled = true;
    setStatus("camera on");
  } catch (e) {
    setStatus("camera denied");
    console.warn(e);
  }
}
$("camBtn").addEventListener("click", enableCamera);

function detectHands(now) {
  if (!handLandmarker || webcam.readyState < 2) return;
  if (now === lastHandTs) return;
  lastHandTs = now;
  const result = handLandmarker.detectForVideo(webcam, now);
  rt.hands = [];
  if (!result || !result.landmarks) return;
  for (let i = 0; i < result.landmarks.length; i++) {
    const lm = result.landmarks[i];
    const handed = result.handedness?.[i]?.[0]?.categoryName || "Right";
    // landmarks: index 4 thumb tip, 8 index tip, 0 wrist
    const thumb = lm[4], index = lm[8];
    const dx = thumb.x - index.x, dy = thumb.y - index.y;
    const pinchDist = Math.sqrt(dx*dx + dy*dy);
    // normalize by hand size (wrist->middle base)
    const wrist = lm[0], midBase = lm[9];
    const handSize = Math.hypot(midBase.x - wrist.x, midBase.y - wrist.y) || 0.18;
    const pinchN = Math.min(1, pinchDist / (handSize * 1.1));
    // fist: avg fingertip distance to wrist small
    let avgTip = 0;
    for (const ti of [8, 12, 16, 20]) {
      avgTip += Math.hypot(lm[ti].x - wrist.x, lm[ti].y - wrist.y);
    }
    avgTip /= 4;
    const fist = avgTip < handSize * 1.2;
    rt.hands.push({
      landmarks: lm,
      handedness: handed,
      pinch: pinchN,
      fist,
      cx: lm[9].x, cy: lm[9].y,
    });
  }
}

// Pick which hand is "main" (red) vs "blob" (cyan)
function classifyHands() {
  if (rt.hands.length === 0) return { main: null, blob: null };
  if (!state.twoHand) return { main: rt.hands[0], blob: null };
  // Two-hand: use handedness. Webcam is mirrored visually. Right=cyan(blob), Left=red(main) by default.
  let main = null, blob = null;
  for (const h of rt.hands) {
    if (h.handedness === "Left") main = main || h;
    else blob = blob || h;
  }
  if (!main) main = rt.hands[0];
  if (!blob && rt.hands.length > 1) blob = rt.hands[1];
  return { main, blob };
}

// ---------- Playhead Update ----------
function updatePlayhead(dt) {
  const { main, blob } = classifyHands();

  // Smooth pinch (one-pole)
  let pinchTarget = rt.smoothPinch;
  if (main) {
    pinchTarget = main.pinch;
  }
  const sAlpha = 1 - Math.exp(-dt / Math.max(1, state.hSmooth));
  const newSmooth = rt.smoothPinch + (pinchTarget - rt.smoothPinch) * sAlpha;
  rt.pinchVel = (newSmooth - rt.smoothPinch) / Math.max(0.001, dt) * 1000; // per second
  rt.smoothPinch = newSmooth;

  // Map pinch to normalized 0..1 within reach/floor
  const reach = state.hReach, floor = state.hFloor;
  const span = Math.max(0.0001, reach - floor);
  let p = rt.smoothPinch * state.hSensitivity;
  p = Math.max(0, Math.min(1, p));
  if (state.invertPinch) p = 1 - p;
  // dead zone
  if (Math.abs(p - 0.5) < state.hDead) p = 0.5;
  const targetPosition = floor + p * span;

  // Audio momentum drive (signed direction from pinch direction)
  const dir = (rt.pinchVel >= 0 ? 1 : -1);
  const audioForce =
    rt.bass * state.mBass * 0.6 +
    rt.mid  * state.mMid  * 0.4 +
    rt.high * state.mHigh * 0.3;

  if (state.mode === "position") {
    // Direct position with optional audio nudge
    let target = targetPosition;
    if (state.audioDrives && rt.audioLoaded) {
      target += rt.envelope * 0.02 * (state.mElastic > 0 ? 1 : 1);
    }
    target = Math.max(0, Math.min(1, target));
    // glide toward target — momentum still applies as additive
    rt.velocity = rt.velocity * state.mDamp + (target - rt.playhead) * 0.18;
    if (state.audioDrives && rt.audioLoaded) {
      rt.velocity += dir * audioForce * 0.0018;
    }
    // Natural playback rate when Play is engaged and no hand is present
    if (rt.playing && !main && video.duration) {
      rt.velocity += (dt / 1000) / video.duration;
    }
    rt.playhead += rt.velocity;
  } else {
    // Velocity mode: pinch velocity adds to playhead velocity
    rt.velocity *= state.mDamp;
    rt.velocity += rt.pinchVel * 0.0008 * state.hSensitivity;
    if (state.audioDrives && rt.audioLoaded) {
      rt.velocity += dir * audioForce * 0.003;
    }
    // elastic return to mid
    rt.velocity += (0.5 - rt.playhead) * state.mElastic * 0.002;
    rt.playhead += rt.velocity;
  }

  // Backward clamp
  if (!state.backward && rt.velocity < 0) {
    rt.velocity = 0;
  }

  // Roam: snap into segment window when transient detected
  if (state.roamOn) updateRoam(dt);

  // Loop / clamp
  if (state.loop) {
    if (rt.playhead > 1) rt.playhead -= 1;
    if (rt.playhead < 0) rt.playhead += 1;
  } else {
    if (rt.playhead > 1) { rt.playhead = 1; rt.velocity = 0; }
    if (rt.playhead < 0) { rt.playhead = 0; rt.velocity = 0; }
  }

  // Apply to <video>
  if (rt.videoLoaded && video.duration) {
    const t = rt.playhead * video.duration;
    if (Math.abs(video.currentTime - t) > 0.04) {
      try { video.currentTime = t; } catch (_) {}
    }
  }

  // HUD
  hudPlayhead.textContent = (rt.playhead * 100).toFixed(1) + "%";
  hudPinch.textContent = main ? rt.smoothPinch.toFixed(2) : "—";
  hudEnv.textContent = rt.envelope.toFixed(2);
  envMeter.style.width = (rt.envelope * 100).toFixed(0) + "%";
  scrub.value = String(Math.round(rt.playhead * 1000));
  if (video.duration) {
    timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }
  camMeta.textContent = rt.hands.length === 0
    ? "no hands"
    : rt.hands.map(h => `${h.handedness} pinch=${h.pinch.toFixed(2)}${h.fist?" ✊":""}`).join("  ");
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ---------- Segment Roam ----------
function updateRoam(dt) {
  const transient = rt.transientLevel;
  const trig = transient > (1 - state.rThresh) * 0.25 + 0.02;
  if (trig && performance.now() - (rt._lastRoam || 0) > 180) {
    rt._lastRoam = performance.now();
    const sizeJ = state.rSize * (1 + (Math.random() * 2 - 1) * state.rJitter);
    const size = Math.max(0.05, Math.min(1, sizeJ));
    let center;
    if (Math.random() < state.rCont) {
      center = rt.playhead + (Math.random() * 2 - 1) * size * 0.5;
    } else {
      center = Math.random();
    }
    if (state.roamDir === "fwd") center = rt.playhead + Math.random() * size;
    if (state.roamDir === "bwd") center = rt.playhead - Math.random() * size;
    center = Math.max(0, Math.min(1, center));
    const floor = Math.max(0, center - size / 2);
    const reach = Math.min(1, center + size / 2);
    state.hFloor = floor;
    state.hReach = reach;
    syncKnob("hFloor", floor);
    syncKnob("hReach", reach);
    rt.segmentFrom = rt.playhead;
    rt.segmentTo = center;
    rt.segmentGlideStart = performance.now();
  }
  // glide assist
  const g = state.rGlide;
  if (g > 0 && rt.segmentGlideStart) {
    const t = (performance.now() - rt.segmentGlideStart) / g;
    if (t < 1) {
      const target = rt.segmentFrom + (rt.segmentTo - rt.segmentFrom) * easeOut(t);
      rt.playhead = rt.playhead * 0.7 + target * 0.3;
    }
  }
}
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function syncKnob(key, value) {
  const host = document.querySelector(`[data-knob="${key}"]`);
  if (!host) return;
  const input = host.querySelector("input");
  const out = host.querySelector(".knob-value");
  input.value = value;
  out.textContent = formatVal(value, parseFloat(input.step));
}

// ---------- Transport ----------
function togglePlay() {
  if (!rt.videoLoaded) { setStatus("load a video first"); return; }
  rt.playing = !rt.playing;
  $("playBtn").textContent = rt.playing ? "❚❚ Pause" : "▶︎ Play";
  $("playBtn").classList.toggle("active", rt.playing);
  if (rt.playing) {
    // we drive currentTime ourselves; keep video paused for precise scrubbing
    video.pause();
  }
  if (audioElement && rt.audioLoaded && !rt.micActive) {
    if (rt.playing) audioElement.play().catch(() => {});
    else audioElement.pause();
  }
}

// ---------- Blob Tracker ----------
// Works on a downscaled luma buffer derived from the current video frame.
const blobCanvas = document.createElement("canvas");
const blobCtx = blobCanvas.getContext("2d", { willReadFrequently: true });

function detectBlobs() {
  if (!rt.videoLoaded) return;
  if (!state.blobOn || rt.blobFrozen) return;
  if (video.readyState < 2) return;
  const scale = state.bScale;
  const w = Math.max(32, Math.floor(video.videoWidth * scale));
  const h = Math.max(32, Math.floor(video.videoHeight * scale));
  if (blobCanvas.width !== w || blobCanvas.height !== h) {
    blobCanvas.width = w; blobCanvas.height = h;
    rt.prevGray = null;
  }
  blobCtx.drawImage(video, 0, 0, w, h);
  const img = blobCtx.getImageData(0, 0, w, h);
  const len = w * h;
  const gray = new Uint8ClampedArray(len);
  for (let i = 0, j = 0; j < len; i += 4, j++) {
    gray[j] = (img.data[i] * 0.299 + img.data[i+1] * 0.587 + img.data[i+2] * 0.114) | 0;
  }
  if (!rt.prevGray || rt.prevGray.length !== len) {
    rt.prevGray = gray;
    return;
  }
  const thresh = state.bSens;
  const mask = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    if (Math.abs(gray[i] - rt.prevGray[i]) > thresh) mask[i] = 1;
  }
  rt.prevGray = gray;
  const blobs = connectedComponents(mask, w, h, state.bMinArea);
  blobs.sort((a, b) => b.area - a.area);
  const limited = blobs.slice(0, state.bMax);
  // smoothing & ID assignment by nearest-neighbor
  const sm = state.bSmooth;
  const next = limited.map(b => {
    const cx = b.cx / w, cy = b.cy / h;
    let id = -1, best = Infinity;
    for (const prev of rt.blobs) {
      const dx = prev.cx - cx, dy = prev.cy - cy;
      const d2 = dx*dx + dy*dy;
      if (d2 < best && d2 < 0.05) { best = d2; id = prev.id; }
    }
    if (id < 0) id = rt.blobIdSeed++;
    const prev = rt.blobs.find(p => p.id === id);
    const ncx = prev ? prev.cx + (cx - prev.cx) * (1 - sm) : cx;
    const ncy = prev ? prev.cy + (cy - prev.cy) * (1 - sm) : cy;
    return {
      id, cx: ncx, cy: ncy,
      area: b.area / len,
      r: Math.sqrt(b.area / Math.PI) / Math.max(w, h),
    };
  });
  rt.blobs = next;
  // trails
  if (state.blobStyle === "Trails") {
    rt.trails.push(next.map(b => ({ x: b.cx, y: b.cy, r: b.r, id: b.id })));
    if (rt.trails.length > 30) rt.trails.shift();
  } else if (rt.trails.length) {
    rt.trails.length = 0;
  }
}

function connectedComponents(mask, w, h, minArea) {
  const labels = new Int32Array(mask.length);
  const blobs = [];
  let nextLabel = 1;
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || labels[i]) continue;
      // flood fill
      let sp = 0;
      stackX[sp] = x; stackY[sp] = y; sp++;
      labels[i] = nextLabel;
      let count = 0, sx = 0, sy = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (sp > 0) {
        sp--;
        const cx = stackX[sp], cy = stackY[sp];
        count++; sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        const ns = [
          [cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1],
        ];
        for (const [nx, ny] of ns) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !labels[ni]) {
            labels[ni] = nextLabel;
            stackX[sp] = nx; stackY[sp] = ny; sp++;
          }
        }
      }
      if (count >= minArea) {
        blobs.push({
          cx: sx / count, cy: sy / count, area: count,
          minX, minY, maxX, maxY,
        });
      }
      nextLabel++;
    }
  }
  return blobs;
}

// ---------- Right-hand gesture handling (cycle blob style, freeze on fist) ----------
function handleRightHandGestures() {
  if (!state.twoHand) return;
  const { blob } = classifyHands();
  if (!blob) return;
  // pinch edge → cycle styles
  const styles = ["Circles", "Hexagons", "Boxes", "Trails"];
  const isPinched = blob.pinch < 0.18;
  const wasPinched = rt.rightPinchPrev < 0.18;
  if (isPinched && !wasPinched && performance.now() - rt.rightPinchedAt > 400) {
    rt.rightPinchedAt = performance.now();
    const idx = styles.indexOf(state.blobStyle);
    state.blobStyle = styles[(idx + 1) % styles.length];
    $("blobStyle").value = state.blobStyle;
  }
  rt.rightPinchPrev = blob.pinch;
  rt.blobFrozen = !!blob.fist;
}

// ---------- Drawing ----------
function drawFrame() {
  const w = out.width, h = out.height;
  const trail = state.rTrail;
  // motion trail: draw a translucent black to fade prior frame
  outCtx.globalCompositeOperation = "source-over";
  outCtx.fillStyle = `rgba(0,0,0,${1 - trail})`;
  outCtx.fillRect(0, 0, w, h);

  if (rt.videoLoaded && video.readyState >= 2) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw > 0) {
      const r = Math.min(w / vw, h / vh);
      const dw = vw * r, dh = vh * r;
      const dx = (w - dw) / 2, dy = (h - dh) / 2;
      outCtx.globalAlpha = state.rBlend * state.rGain;
      outCtx.drawImage(video, dx, dy, dw, dh);
      outCtx.globalAlpha = 1;
    }
  } else {
    // placeholder grid
    outCtx.fillStyle = "#0a0c12";
    outCtx.fillRect(0, 0, w, h);
    outCtx.strokeStyle = "rgba(255,59,107,0.08)";
    outCtx.lineWidth = 1;
    const gs = 40 * devicePixelRatio;
    for (let x = 0; x < w; x += gs) { outCtx.beginPath(); outCtx.moveTo(x, 0); outCtx.lineTo(x, h); outCtx.stroke(); }
    for (let y = 0; y < h; y += gs) { outCtx.beginPath(); outCtx.moveTo(0, y); outCtx.lineTo(w, y); outCtx.stroke(); }
  }

  drawOverlay();
}

function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  ovCtx.clearRect(0, 0, w, h);

  // Playhead bar
  ovCtx.fillStyle = "rgba(255,59,107,0.14)";
  ovCtx.fillRect(0, h - 10 * devicePixelRatio, w, 10 * devicePixelRatio);
  ovCtx.fillStyle = "#ff3b6b";
  ovCtx.fillRect(0, h - 10 * devicePixelRatio, rt.playhead * w, 10 * devicePixelRatio);
  // Floor/Reach window markers
  ovCtx.strokeStyle = "rgba(25,230,255,0.7)";
  ovCtx.lineWidth = 2 * devicePixelRatio;
  ovCtx.beginPath();
  ovCtx.moveTo(state.hFloor * w, h - 14 * devicePixelRatio); ovCtx.lineTo(state.hFloor * w, h);
  ovCtx.moveTo(state.hReach * w, h - 14 * devicePixelRatio); ovCtx.lineTo(state.hReach * w, h);
  ovCtx.stroke();

  drawBlobs();

  // Hand overlays in stage
  if (rt.hands.length) drawHandsOnStage();
}

function drawBlobs() {
  if (!state.blobOn) return;
  const w = overlay.width, h = overlay.height;
  const accent = "#19e6ff";
  ovCtx.lineWidth = 2 * devicePixelRatio;
  ovCtx.strokeStyle = accent;
  ovCtx.fillStyle = "rgba(25,230,255,0.18)";

  if (state.blobStyle === "Trails") {
    for (let i = 0; i < rt.trails.length; i++) {
      const arr = rt.trails[i];
      const a = (i + 1) / rt.trails.length;
      ovCtx.fillStyle = `rgba(25,230,255,${0.04 + a * 0.18})`;
      for (const b of arr) {
        const x = b.x * w, y = b.y * h, r = Math.max(4, b.r * w * 1.5);
        ovCtx.beginPath();
        ovCtx.arc(x, y, r, 0, Math.PI * 2);
        ovCtx.fill();
      }
    }
  }

  for (const b of rt.blobs) {
    const x = b.cx * w, y = b.cy * h;
    const r = Math.max(8 * devicePixelRatio, b.r * w * 1.6);
    ovCtx.beginPath();
    if (state.blobStyle === "Circles" || state.blobStyle === "Trails") {
      ovCtx.arc(x, y, r, 0, Math.PI * 2);
    } else if (state.blobStyle === "Hexagons") {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) ovCtx.moveTo(px, py); else ovCtx.lineTo(px, py);
      }
      ovCtx.closePath();
    } else if (state.blobStyle === "Boxes") {
      ovCtx.rect(x - r, y - r, r * 2, r * 2);
    }
    ovCtx.fill(); ovCtx.stroke();

    if (state.bIds) {
      ovCtx.fillStyle = "#fff";
      ovCtx.font = `${10 * devicePixelRatio}px ui-monospace, monospace`;
      ovCtx.fillText(`#${b.id}`, x + r + 4, y);
      ovCtx.fillStyle = "rgba(25,230,255,0.18)";
    }
    if (state.bXY) {
      ovCtx.fillStyle = "rgba(255,255,255,0.6)";
      ovCtx.font = `${9 * devicePixelRatio}px ui-monospace, monospace`;
      ovCtx.fillText(`(${b.cx.toFixed(2)}, ${b.cy.toFixed(2)})`, x + r + 4, y + 12 * devicePixelRatio);
      ovCtx.fillStyle = "rgba(25,230,255,0.18)";
    }
  }

  if (state.bConn && rt.blobs.length > 1) {
    ovCtx.strokeStyle = "rgba(25,230,255,0.35)";
    ovCtx.beginPath();
    for (let i = 0; i < rt.blobs.length; i++) {
      for (let j = i + 1; j < rt.blobs.length; j++) {
        const a = rt.blobs[i], b = rt.blobs[j];
        const dx = a.cx - b.cx, dy = a.cy - b.cy;
        if (dx*dx + dy*dy < 0.08) {
          ovCtx.moveTo(a.cx * w, a.cy * h);
          ovCtx.lineTo(b.cx * w, b.cy * h);
        }
      }
    }
    ovCtx.stroke();
  }

  if (state.bMetrics) {
    ovCtx.fillStyle = "rgba(25,230,255,0.9)";
    ovCtx.font = `${10 * devicePixelRatio}px ui-monospace, monospace`;
    ovCtx.fillText(
      `BLOBS ${rt.blobs.length}${rt.blobFrozen ? " ❄" : ""}`,
      14 * devicePixelRatio,
      h - 22 * devicePixelRatio
    );
  }
}

function drawHandsOnStage() {
  // light marker on top-right of stage canvas to indicate hand presence/activity
  const w = overlay.width, h = overlay.height;
  const { main, blob } = classifyHands();
  const drawHand = (h2, color, x0) => {
    if (!h2) return;
    ovCtx.strokeStyle = color;
    ovCtx.fillStyle = color + "55";
    ovCtx.lineWidth = 2 * devicePixelRatio;
    const r = 8 * devicePixelRatio + h2.pinch * 30 * devicePixelRatio;
    ovCtx.beginPath(); ovCtx.arc(x0, 30 * devicePixelRatio, r, 0, Math.PI * 2); ovCtx.fill(); ovCtx.stroke();
  };
  drawHand(main, "#ff3b6b", w - 80 * devicePixelRatio);
  drawHand(blob, "#19e6ff", w - 30 * devicePixelRatio);
}

function drawCamPreview() {
  if (webcam.readyState < 2) {
    camCtx.fillStyle = "#000"; camCtx.fillRect(0, 0, camPreview.width, camPreview.height);
    camCtx.fillStyle = "#7a8298"; camCtx.font = "11px ui-monospace, monospace";
    camCtx.fillText("camera off", 12, 22);
    return;
  }
  camCtx.save();
  if (state.mirrorCam) {
    camCtx.translate(camPreview.width, 0); camCtx.scale(-1, 1);
  }
  camCtx.drawImage(webcam, 0, 0, camPreview.width, camPreview.height);
  camCtx.restore();

  // landmark overlay
  for (const h of rt.hands) {
    const isMain = (state.twoHand ? h.handedness === "Left" : h === rt.hands[0]);
    const color = isMain ? "#ff3b6b" : "#19e6ff";
    drawLandmarks(camCtx, h.landmarks, color, camPreview.width, camPreview.height, state.mirrorCam);
    // pinch line
    const t = h.landmarks[4], i = h.landmarks[8];
    const tx = (state.mirrorCam ? 1 - t.x : t.x) * camPreview.width;
    const ty = t.y * camPreview.height;
    const ix = (state.mirrorCam ? 1 - i.x : i.x) * camPreview.width;
    const iy = i.y * camPreview.height;
    camCtx.strokeStyle = color; camCtx.lineWidth = 2;
    camCtx.beginPath(); camCtx.moveTo(tx, ty); camCtx.lineTo(ix, iy); camCtx.stroke();
  }
}

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
];
function drawLandmarks(ctx, lm, color, w, h, mirror) {
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const ax = (mirror ? 1 - lm[a].x : lm[a].x) * w;
    const ay = lm[a].y * h;
    const bx = (mirror ? 1 - lm[b].x : lm[b].x) * w;
    const by = lm[b].y * h;
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  }
  ctx.stroke();
  for (const p of lm) {
    const x = (mirror ? 1 - p.x : p.x) * w, y = p.y * h;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------- Main Loop ----------
function loop(now) {
  const dt = Math.min(60, now - rt.lastT);
  rt.lastT = now;

  if (webcam.readyState >= 2) {
    detectHands(now);
    handleRightHandGestures();
  }
  if (analyser) readEnvelope(dt);
  if (rt.videoLoaded) {
    updatePlayhead(dt);
    detectBlobs();
  }

  drawFrame();
  drawCamPreview();

  rt.frameCount++;
  if (now - rt.fpsT > 500) {
    rt.fps = Math.round((rt.frameCount * 1000) / (now - rt.fpsT));
    hudFps.textContent = String(rt.fps);
    rt.frameCount = 0; rt.fpsT = now;
  }

  requestAnimationFrame(loop);
}

// ---------- Boot ----------
async function boot() {
  setStatus("ready · load video & enable camera");
  // Eagerly preload model in background so the first camera-on is fast
  try { await initHandLandmarker(); } catch (e) { console.warn(e); setStatus("hand model failed — continuing"); }
  requestAnimationFrame(loop);
}
boot();
