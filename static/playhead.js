// playhead.js
// Two modes:
//
// 1) MOMENTUM — physics-driven. Audio injects forward velocity; playhead integrates
//    over time with damping + elastic return. Good for drums, kicks, DJ scrubbing.
//
// 2) ENVELOPE — direct envelope follower. Playhead position = envelope(audio) × range.
//    Silence → position 0 (flower closed). Sustained note → position holds at peak
//    (flower open). Release → position returns to 0 (flower closes smoothly).
//    Attack/Release control the rise/fall speed independently, like a synth ADSR.
//    This is the correct model for blooming, breathing, morphing, growth footage.
//
// The two modes are genuinely different animation paradigms — switch per material.

export class Playhead {
  constructor() {
    this.position = 0;     // float frame index
    this.velocity = 0;     // frames per second (momentum mode only)
    this.anchor = 0;       // elastic resting point (momentum mode only)
    this.frameCount = 0;

    // ---- Mode ----
    this.mode = 'envelope'; // 'momentum' | 'envelope' | 'hand'

    // ---- Shared ----
    this.loop = true;

    // ---- Hand mode params ----
    // Two mappings:
    //   'position'  — pinchNormalized directly → absolute playhead position (scrubber)
    //   'velocity'  — change in pinch adds velocity → playhead integrates (jog wheel)
    this.handMapping   = 'velocity';
    this.handReach     = 1.0;   // fraction of clip reached at full pinch open
    this.handFloor     = 0.0;   // fraction at full pinch closed
    this.handSensitivity = 2.0; // velocity mode: velocity gain per pinch-unit/sec
    this.handDamping   = 0.9;   // velocity mode: per-frame-ish damping (0..1)
    this.handSmoothMs  = 80;    // position mode: glide time constant
    this.handHoldOnLost = true; // when hand disappears, freeze (vs drift back)

    // Hand-mode audio layering — optionally let audio still add jitter/snap on top
    this.handAudioJitter = 0.0; // 0..1 — high-band jitter on top of hand motion
    this.handAudioSnap   = 0.0; // 0..1 — bass transients cause instant jumps on top

    // internal hand state
    this._handPos = 0;          // smoothed fractional position (0..1) for position mapping
    this._handVel = 0;          // frames/sec accumulator for velocity mapping
    this._handLastNorm = 0;     // last pinchNormalized value (for velocity deriv)
    this._handLostFor  = 0;     // seconds since hand was last visible

    // ---- Momentum mode params ----
    this.bassGain = 1.4;
    this.midGain  = 0.6;
    this.highGain = 0.35;
    this.damping = 0.88;
    this.elastic = 0.15;
    this.backwardScrub = true;
    this._baseImpulse = 60;
    this._jitterScale = 8;
    this._anchorFollow = 0.004;

    // ---- Envelope mode params ----
    this.envAttackMs  = 80;      // rise time (ms) when audio gets louder
    this.envReleaseMs = 300;     // fall time (ms) when audio decays
    this.envReach     = 1.0;     // fraction of clip reached at peak envelope (0..1)
    this.envFloor     = 0.0;     // min position fraction at silence (0..1)
    this.envSource    = 'rms';   // 'rms' | 'bass' | 'mid' | 'high' | 'mix'
    this.envMixBass = 1.0;
    this.envMixMid  = 0.5;
    this.envMixHigh = 0.2;
    this.envGain    = 1.2;       // pre-clip gain on the source signal
    this.envCurve   = 1.2;       // gamma curve on envelope (>1 = more punchy)
    this.envJitter  = 0.0;       // 0..1 — high-band micro-tremor ON TOP of envelope

    // Twitch additions
    this.envSnap    = 0.0;       // 0..1 — how much bass transients cause instant jumps
    this.envHold    = 0.0;       // 0..1 — hold at peak before snap-back release

    // ---- Segment Roam params ----
    // When enabled, the "reach window" (segStart..segEnd) isn't fixed — it jumps
    // to a new range on each trigger. The envelope still drives the playhead
    // WITHIN the current segment, so micro-motion (envelope) layers on top of
    // macro-motion (segment picks). See _rollSegment() for the picker.
    this.roamEnabled   = false;
    this.roamTrigger   = 'transient';  // 'transient' | 'tempo' | 'random'
    this.roamBpm       = 120;          // for 'tempo' trigger
    this.roamInterval  = [0.25, 0.9];  // seconds, min/max for 'random'
    this.roamSize      = 0.25;         // segment width as fraction of clip (0..1)
    this.roamSizeJitter = 0.5;         // 0..1 — ± randomness on segment size
    this.roamDirection = 'any';        // 'forward' | 'backward' | 'any'
    this.roamSmoothMs  = 80;           // glide time when a new segment slides in
    this.roamContinuity = 0.35;        // 0..1 — probability new segment starts adjacent
                                       //        to the old one (vs jumping randomly)

    // internal state
    this._env = 0;
    this._snapBoost = 0;
    this._holdTimer = 0;
    this._prevTarget = 0;
    this._jitterOffset = 0;

    // Segment roam state. "current" is what's actually in use; "target" is
    // where we're gliding to after a trigger. Values are fractions [0..1].
    this._segStartCur = 0;
    this._segEndCur   = 1;
    this._segStartTgt = 0;
    this._segEndTgt   = 1;
    this._nextRoamAt  = 0;     // wall-clock (seconds) for tempo/random triggers
    this._roamClock   = 0;
    this._roamInit    = false;
  }

  reset(frameCount) {
    this.frameCount = frameCount;
    this.position = 0;
    this.velocity = 0;
    this.anchor = 0;
    this._env = 0;
  }

  setMode(mode) {
    if (mode !== 'momentum' && mode !== 'envelope' && mode !== 'hand') return;
    this.mode = mode;
    // soft reset of motion state when switching
    this.velocity = 0;
    this.anchor = this.position;
    // seed hand state to current position so switching into hand mode doesn't jump
    const last = Math.max(1, this.frameCount - 1);
    this._handPos = this.position / last;
    this._handVel = 0;
    this._handLostFor = 0;
  }

  setHandParams(p) {
    if (p.handMapping      != null) this.handMapping      = p.handMapping;
    if (p.handReach        != null) this.handReach        = p.handReach;
    if (p.handFloor        != null) this.handFloor        = p.handFloor;
    if (p.handSensitivity  != null) this.handSensitivity  = p.handSensitivity;
    if (p.handDamping      != null) this.handDamping      = p.handDamping;
    if (p.handSmoothMs     != null) this.handSmoothMs     = p.handSmoothMs;
    if (p.handHoldOnLost   != null) this.handHoldOnLost   = !!p.handHoldOnLost;
    if (p.handAudioJitter  != null) this.handAudioJitter  = p.handAudioJitter;
    if (p.handAudioSnap    != null) this.handAudioSnap    = p.handAudioSnap;
  }

  setParams(p) {
    if (p.mode != null) this.setMode(p.mode);

    // shared
    if (p.loop != null) this.loop = p.loop;

    // momentum
    if (p.bassGain != null) this.bassGain = p.bassGain;
    if (p.midGain  != null) this.midGain  = p.midGain;
    if (p.highGain != null) this.highGain = p.highGain;
    if (p.damping  != null) this.damping  = p.damping;
    if (p.elastic  != null) this.elastic  = p.elastic;
    if (p.backwardScrub != null) this.backwardScrub = p.backwardScrub;

    // envelope
    if (p.envAttackMs  != null) this.envAttackMs  = p.envAttackMs;
    if (p.envReleaseMs != null) this.envReleaseMs = p.envReleaseMs;
    if (p.envReach     != null) this.envReach     = p.envReach;
    if (p.envFloor     != null) this.envFloor     = p.envFloor;
    if (p.envSource    != null) this.envSource    = p.envSource;
    if (p.envMixBass   != null) this.envMixBass   = p.envMixBass;
    if (p.envMixMid    != null) this.envMixMid    = p.envMixMid;
    if (p.envMixHigh   != null) this.envMixHigh   = p.envMixHigh;
    if (p.envGain      != null) this.envGain      = p.envGain;
    if (p.envCurve     != null) this.envCurve     = p.envCurve;
    if (p.envJitter    != null) this.envJitter    = p.envJitter;
    if (p.envSnap      != null) this.envSnap      = p.envSnap;
    if (p.envHold      != null) this.envHold      = p.envHold;

    // roam
    if (p.roamEnabled    != null) {
      const was = this.roamEnabled;
      this.roamEnabled = !!p.roamEnabled;
      // When enabling, seed the segment to the current fixed reach/floor so there's
      // no visual jump. When disabling, reset so next re-enable is clean.
      if (this.roamEnabled && !was) {
        this._segStartCur = this._segStartTgt = this.envFloor;
        this._segEndCur   = this._segEndTgt   = this.envReach;
        this._roamInit = true;
        this._nextRoamAt = this._roamClock; // trigger a roll on next update
      }
    }
    if (p.roamTrigger    != null) this.roamTrigger    = p.roamTrigger;
    if (p.roamBpm        != null) this.roamBpm        = p.roamBpm;
    if (p.roamSize       != null) this.roamSize       = p.roamSize;
    if (p.roamSizeJitter != null) this.roamSizeJitter = p.roamSizeJitter;
    if (p.roamDirection  != null) this.roamDirection  = p.roamDirection;
    if (p.roamSmoothMs   != null) this.roamSmoothMs   = p.roamSmoothMs;
    if (p.roamContinuity != null) this.roamContinuity = p.roamContinuity;

    // hand
    this.setHandParams(p);
  }

  // Pick a fresh (segStartTgt, segEndTgt) pair. Segments can go backwards
  // (segStart > segEnd) — envelope will scrub the video in reverse within that
  // window. Outer bounds honored via envFloor..envReach.
  _rollSegment() {
    const lo = Math.max(0, Math.min(1, this.envFloor));
    const hi = Math.max(lo + 0.02, Math.min(1, this.envReach));
    const span = hi - lo;

    // segment width (jittered)
    const jit = 1 + (Math.random() * 2 - 1) * this.roamSizeJitter;
    let size = this.roamSize * Math.max(0.1, jit);
    size = Math.max(0.03, Math.min(span, size));

    // direction for this segment
    let dir;
    if (this.roamDirection === 'forward')      dir = +1;
    else if (this.roamDirection === 'backward') dir = -1;
    else                                        dir = Math.random() < 0.5 ? +1 : -1;

    // Decide whether to continue adjacent to the previous segment or jump.
    // Continuity gives a "DJ moving forward through the track" feel; jumps
    // give the glitchy "picking different parts of the video" feel.
    const continueFromPrev = this._roamInit && Math.random() < this.roamContinuity;

    let segA, segB;
    if (continueFromPrev) {
      // start where the previous segment ended
      const prevEnd = this._segEndTgt;
      segA = prevEnd;
      segB = segA + dir * size;
      // if we ran off the allowed range, reflect the direction
      if (segB > hi || segB < lo) {
        dir = -dir;
        segB = segA + dir * size;
      }
    } else {
      // jump somewhere random inside the allowed outer range
      // pick segA such that segA + dir*size stays inside [lo, hi]
      let aLo = lo, aHi = hi;
      if (dir > 0) aHi = hi - size;
      else         aLo = lo + size;
      if (aHi < aLo) { // range too tight for this size — clamp
        const mid = (lo + hi) * 0.5;
        aLo = aHi = Math.max(lo, Math.min(hi, mid));
      }
      segA = aLo + Math.random() * (aHi - aLo);
      segB = segA + dir * size;
    }

    // final clamp
    segA = Math.max(lo, Math.min(hi, segA));
    segB = Math.max(lo, Math.min(hi, segB));

    this._segStartTgt = segA;
    this._segEndTgt   = segB;
    this._roamInit = true;
  }

  _updateRoam(audio, dt) {
    this._roamClock += dt;

    if (!this.roamEnabled) return;

    // Initialize segment targets on first tick after enable
    if (!this._roamInit) this._rollSegment();

    // Decide whether to trigger a new segment pick
    let trigger = false;
    if (this.roamTrigger === 'transient') {
      // Edge-detect on bass transient (true onset, not just elevated level).
      if (audio.transient > 0.18 && !this._transArmed) {
        trigger = true;
        this._transArmed = true;
      }
      if (audio.transient < 0.05) this._transArmed = false;
    } else if (this.roamTrigger === 'tempo') {
      const period = 60 / Math.max(30, Math.min(240, this.roamBpm));
      if (this._roamClock >= this._nextRoamAt) {
        trigger = true;
        this._nextRoamAt = this._roamClock + period;
      }
    } else if (this.roamTrigger === 'random') {
      if (this._roamClock >= this._nextRoamAt) {
        trigger = true;
        const [mn, mx] = this.roamInterval;
        this._nextRoamAt = this._roamClock + mn + Math.random() * (mx - mn);
      }
    }

    if (trigger) this._rollSegment();

    // Glide current segment toward target (smooth slide, NOT snap).
    // This implements answer (b) to your question: the position rides the
    // segment window as it moves underneath, rather than snapping.
    const tau = Math.max(0.001, this.roamSmoothMs / 1000);
    const coef = 1 - Math.exp(-dt / tau);
    this._segStartCur += (this._segStartTgt - this._segStartCur) * coef;
    this._segEndCur   += (this._segEndTgt   - this._segEndCur)   * coef;
  }

  // audio: {bass, mid, high, transient, rms}
  // hand:  {visible, pinchNormalized, pinchVelocity, ...}  (optional)
  update(audio, dt, hand) {
    if (this.frameCount <= 1) return;
    if (dt > 0.05) dt = 0.05;

    if (this.mode === 'envelope') {
      this._updateEnvelope(audio, dt);
    } else if (this.mode === 'hand') {
      this._updateHand(hand, audio, dt);
    } else {
      this._updateMomentum(audio, dt);
    }
  }

  // -------- Hand mode --------
  // Two sub-mappings controlled by this.handMapping:
  //   'position' — absolute: pinchNorm directly sets position (scrubber)
  //   'velocity' — relative: d(pinchNorm)/dt pushes velocity (jog wheel)
  //
  // Both respect floor..reach bounds. Audio can optionally add jitter/snap on top.
  _updateHand(hand, audio, dt) {
    const last = this.frameCount - 1;
    // Hand mode uses its own handFloor/handReach for the scrubbable range.
    const lo = Math.max(0, Math.min(1, this.handFloor));
    const hi = Math.max(lo + 0.02, Math.min(1, this.handReach));

    const visible = hand && hand.visible;
    if (visible) this._handLostFor = 0;
    else         this._handLostFor += dt;

    if (this.handMapping === 'position') {
      // Absolute mapping — pinchNorm is treated as a direct slider 0..1
      // mapped into [floor..reach]. Smoothed with handSmoothMs for physical feel.
      if (visible) {
        const target = lo + (hand.pinchNormalized) * (hi - lo);
        const tau = Math.max(0.001, this.handSmoothMs / 1000);
        const coef = 1 - Math.exp(-dt / tau);
        this._handPos += (target - this._handPos) * coef;
      }
      // If not visible and handHoldOnLost, just hold _handPos (do nothing).
      // If not holding, could drift toward floor — leave as hold for now.
    } else {
      // Velocity mapping — opening pinch (positive vel) pushes forward;
      // closing pinch (negative vel) pushes backward. Integrates with damping.
      if (visible) {
        // Convert normalized-per-sec into frames-per-sec through sensitivity.
        // handSensitivity of 1.0 means "full open→closed in 1s moves `handSensitivity × frameCount` frames/sec".
        const impulse = hand.pinchVelocity * this.handSensitivity * last;
        this._handVel += impulse * dt * 60; // scale so a "1 unit/sec" pinch feels strong
      }
      // Damping (per-frame @60 → per-dt)
      const dampPerSec = Math.pow(this.handDamping, 60);
      this._handVel *= Math.pow(dampPerSec, dt);

      this._handPos += (this._handVel / Math.max(1, last)) * dt;

      // Clamp to [floor..reach]
      if (this._handPos > hi) { this._handPos = hi; this._handVel = 0; }
      if (this._handPos < lo) { this._handPos = lo; this._handVel = 0; }
    }

    // Map fraction → frame index
    let pos = this._handPos * last;

    // Optional audio layering on top — subtle snap + jitter so the motion still
    // reacts to the beat even when the hand is mostly still.
    if (this.handAudioSnap > 0 && audio && audio.transient > 0.05) {
      const boost = audio.transient * this.handAudioSnap * 1.5;
      this._snapBoost = Math.max(this._snapBoost, boost);
    }
    this._snapBoost *= Math.exp(-dt / 0.10);
    if (this._snapBoost > 0.001) {
      // Add a forward frame nudge proportional to boost, up to ~reach
      pos += this._snapBoost * (hi - lo) * last * 0.15;
    }

    if (this.handAudioJitter > 0 && audio) {
      const ht = audio.highTransient !== undefined ? audio.highTransient : audio.high;
      const magnitude = ht * 0.7 + audio.high * 0.3;
      const range = magnitude * this.handAudioJitter * 12;
      const target = (Math.random() - 0.5) * 2 * range;
      const jCoef = 1 - Math.exp(-dt / 0.008);
      this._jitterOffset += (target - this._jitterOffset) * jCoef;
      pos += this._jitterOffset;
    } else {
      this._jitterOffset *= 0.8;
    }

    // Clamp to valid frame range (after all layers)
    if (pos < 0) pos = 0;
    if (pos > last) pos = last;

    this.velocity = (pos - (this._lastPos ?? pos)) / Math.max(dt, 0.0001);
    this.position = pos;
    this._lastPos = pos;
  }

  // -------- Envelope mode --------
  _updateEnvelope(audio, dt) {
    // 1. Pick raw source signal from selected band(s)
    let raw;
    switch (this.envSource) {
      case 'bass': raw = audio.bass; break;
      case 'mid':  raw = audio.mid; break;
      case 'high': raw = audio.high; break;
      case 'mix':
        raw = audio.bass * this.envMixBass
            + audio.mid  * this.envMixMid
            + audio.high * this.envMixHigh;
        break;
      case 'rms':
      default:
        raw = Math.max(audio.rms * 1.6, audio.bass * 0.9 + audio.mid * 0.6 + audio.high * 0.3);
        break;
    }

    // 2. Apply gain + curve, clamp to [0,1]
    let target = raw * this.envGain;
    target = Math.pow(Math.max(0, Math.min(1, target)), this.envCurve);

    // 3. Attack/Release smoothing with optional "hold-then-snap-back" curve
    const rising = target > this._env;
    if (rising) {
      // rising phase: normal attack time constant, reset hold timer
      const tau = Math.max(0.001, this.envAttackMs / 1000);
      const coef = 1 - Math.exp(-dt / tau);
      this._env += (target - this._env) * coef;
      this._holdTimer = 0;
    } else {
      // falling phase: hold for envHold fraction of release, then snap fast
      const relSec = Math.max(0.001, this.envReleaseMs / 1000);
      this._holdTimer += dt;
      // hold duration: up to 50% of release time at envHold=1
      const holdDur = relSec * this.envHold * 0.5;
      let tau;
      if (this._holdTimer < holdDur) {
        // holding: very slow decay (tau = 10× release → essentially freezes)
        tau = relSec * 10;
      } else {
        // post-hold snap: faster than the nominal release so it feels like a snap
        // the higher envHold, the snappier the back-end
        const snapFactor = 1 - this.envHold * 0.7; // 1.0 at hold=0, 0.3 at hold=1
        tau = relSec * snapFactor;
      }
      const coef = 1 - Math.exp(-dt / Math.max(0.001, tau));
      this._env += (target - this._env) * coef;
    }

    // 4. Snap layer — bass transients cause instant jumps that bypass attack smoothing
    //    The snap boost adds to the envelope directly, then decays fast.
    if (this.envSnap > 0 && audio.transient > 0.05) {
      const boost = audio.transient * this.envSnap * 1.5;
      this._snapBoost = Math.max(this._snapBoost, boost);
    }
    // decay snap boost (independent of envelope smoothing) — ~100ms
    const snapTau = 0.10;
    this._snapBoost *= Math.exp(-dt / snapTau);

    // combined envelope (clamped) — this is what drives position
    let combined = this._env + this._snapBoost;
    if (combined > 1) combined = 1;
    if (combined < 0) combined = 0;

    // 5. Update the roaming segment window (only mutates state when enabled).
    //    When disabled, we use the static envFloor..envReach range below.
    this._updateRoam(audio, dt);

    // 6. Map envelope to position using either the roaming segment (dynamic)
    //    or the fixed floor..reach range (static).
    const last = this.frameCount - 1;
    let segA, segB;
    if (this.roamEnabled) {
      // roam segment — can go backwards (segA may be > segB) giving reverse scrub
      segA = this._segStartCur;
      segB = this._segEndCur;
    } else {
      segA = this.envFloor;
      segB = Math.min(1, this.envReach);
    }
    const segAFrame = segA * last;
    const segBFrame = segB * last;
    let pos = segAFrame + (segBFrame - segAFrame) * combined;

    // 6. Dual-band micro-tremor jitter — uses high-band TRANSIENTS for snappy hats/snares,
    //    plus a small amount of continuous high-band energy. Independent of envelope.
    if (this.envJitter > 0) {
      // instantaneous target: high transient punches + baseline high energy
      const ht = audio.highTransient !== undefined ? audio.highTransient : audio.high;
      const magnitude = ht * 0.7 + audio.high * 0.3;
      const range = magnitude * this.envJitter * 14; // frames
      const target = (Math.random() - 0.5) * 2 * range;
      // smooth the jitter a bit so it doesn't strobe at render fps (8ms tau)
      const jTau = 0.008;
      const jCoef = 1 - Math.exp(-dt / jTau);
      this._jitterOffset += (target - this._jitterOffset) * jCoef;
      pos += this._jitterOffset;
    } else {
      this._jitterOffset = 0;
    }

    // 7. Clamp to valid range
    if (pos < 0) pos = 0;
    if (pos > last) pos = last;

    this.position = pos;
    this.velocity = (pos - (this._lastPos ?? pos)) / Math.max(dt, 0.0001);
    this._lastPos = pos;
  }

  // -------- Momentum mode (original physics) --------
  _updateMomentum(audio, dt) {
    const bass = audio.bass;
    const mid  = audio.mid;
    const high = audio.high;
    const trans = audio.transient;

    let forward = bass * this.bassGain * this._baseImpulse;
    if (trans > 0.05) forward += trans * this.bassGain * 180;
    forward += mid * this.midGain * 25;

    const jitter = (Math.random() - 0.5) * 2 * high * this.highGain * this._jitterScale;

    let pull = 0;
    if (this.backwardScrub) {
      const diff = this.position - this.anchor;
      pull = -diff * this.elastic * 12;
    }

    this.velocity += (forward + pull) * dt;
    const dampPerSec = Math.pow(this.damping, 60);
    this.velocity *= Math.pow(dampPerSec, dt);

    this.position += this.velocity * dt + jitter * dt * 60;

    const target = this.position;
    if (target > this.anchor) {
      this.anchor += (target - this.anchor) * Math.min(1, this._anchorFollow * 1000 * dt);
    } else {
      this.anchor += (target - this.anchor) * Math.min(1, this._anchorFollow * 200 * dt);
    }

    const last = this.frameCount - 1;
    if (this.loop) {
      if (this.position >= last) { this.position -= last; this.anchor = Math.max(0, this.anchor - last); }
      else if (this.position < 0) { this.position += last; this.anchor += last; }
    } else {
      if (this.position > last) { this.position = last; this.velocity = 0; }
      if (this.position < 0)   { this.position = 0;    this.velocity = 0; }
    }
  }

  // Returns { frameA, frameB, mix } where mix ∈ [0,1] between them
  sample() {
    const last = this.frameCount - 1;
    if (last <= 0) return { frameA: 0, frameB: 0, mix: 0 };
    let p = this.position;
    if (this.mode === 'momentum' && this.loop) {
      p = ((p % this.frameCount) + this.frameCount) % this.frameCount;
    } else {
      p = Math.max(0, Math.min(last, p));
    }
    const a = Math.floor(p);
    const b = Math.min(last, a + 1);
    const mix = p - a;
    return { frameA: a, frameB: b, mix };
  }

  // Envelope value for HUD/visualization (includes snap boost)
  envelopeValue() {
    const combined = this._env + this._snapBoost;
    return Math.max(0, Math.min(1, combined));
  }

  // Current segment bounds as fractions [0..1] — used by HUD/waveform viz
  segmentBounds() {
    if (this.roamEnabled) {
      return { a: this._segStartCur, b: this._segEndCur, roaming: true };
    }
    return { a: this.envFloor, b: this.envReach, roaming: false };
  }
}
