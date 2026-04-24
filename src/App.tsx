import { useCallback, useEffect, useRef, useState } from "react";
import { AudioAnalyzer } from "./components/AudioAnalyzer";
import { BlobTracker } from "./components/BlobTracker";
import { ControlPanel } from "./components/ControlPanel";
import { HandTracker } from "./components/HandTracker";
import { VideoPlayer } from "./components/VideoPlayer";
import { useAudioEnvelope } from "./hooks/useAudioEnvelope";
import { useHandTracking } from "./hooks/useHandTracking";
import { useSegmentRoam } from "./hooks/useSegmentRoam";
import type { Blob, PlayheadMode } from "./types";
import { clampOrWrap, integratePlayhead } from "./utils/playheadPhysics";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<PlayheadMode>("position");
  const [playhead, setPlayhead] = useState(0);
  const [blobs, setBlobs] = useState<Blob[]>([]);

  const [handParams, setHandParams] = useState({
    sensitivity: 2,
    damping: 0.9,
    smoothingMs: 80,
    reach: 1,
    floor: 0,
    deadZone: 0.02,
    invert: false,
    twoHandMode: true,
  });

  const [blobParams, setBlobParams] = useState({
    enabled: true,
    sensitivity: 20,
    minArea: 100,
    maxBlobs: 16,
    smoothing: 0.5,
    resolutionScale: 0.5,
    style: "circles" as const,
    showMetrics: true,
  });

  const [envParams, setEnvParams] = useState({
    attackMs: 80,
    releaseMs: 300,
    sensitivity: 1.2,
    punch: 1.2,
    jitter: 0.2,
    snap: 0.4,
    mix: 0.6,
  });

  const [segmentParams, setSegmentParams] = useState({
    enabled: true,
    segmentSize: 0.25,
    sizeJitter: 0.5,
    direction: "any" as const,
    continuity: 0.35,
    glideMs: 80,
  });

  const [momentumParams, setMomentumParams] = useState({
    damping: 0.96,
    elasticReturn: 2,
    bassDrive: 0.9,
    midDrive: 0.6,
    highDrive: 0.4,
  });

  const [renderParams, setRenderParams] = useState({
    trailAmount: 0.3,
    frameBlend: 1,
    loopMode: true,
    backwardAllowed: true,
  });

  const hand = useHandTracking();
  const envelope = useAudioEnvelope(envParams);
  const segment = useSegmentRoam(segmentParams);
  const physics = useRef({ position: 0, velocity: 0 });
  const lastTime = useRef(performance.now());

  const tick = useCallback(() => {
    const now = performance.now();
    const dt = Math.min(0.04, (now - lastTime.current) / 1000);
    lastTime.current = now;

    const hands = hand.getHands();
    const left = hands.left;
    const right = hands.right;

    let handDrive = 0;
    const pinch = handParams.invert ? 1 - left.pinch : left.pinch;

    if (mode === "position") {
      const mapped = handParams.floor + (handParams.reach - handParams.floor) * pinch;
      physics.current.position += (mapped - physics.current.position) * (1 - handParams.damping);
      physics.current.velocity *= handParams.damping;
    } else {
      const dz = Math.abs(left.pinchVelocity) < handParams.deadZone ? 0 : left.pinchVelocity;
      handDrive = dz * handParams.sensitivity;
    }

    if (mode === "segment-roam" && envelope.transient()) {
      segment.triggerTransient(physics.current.position);
    }

    integratePlayhead(
      physics.current,
      dt,
      {
        hand: handDrive,
        envelope: envelope.level * envParams.mix,
        bass: envelope.bands.bass,
        mid: envelope.bands.mid,
        high: envelope.bands.high,
      },
      momentumParams,
    );

    let normalized = clampOrWrap(physics.current.position, renderParams.loopMode);
    if (mode === "segment-roam") {
      segment.update(dt * 1000);
      normalized = segment.mapLocalToGlobal(normalized);
    }

    setPlayhead(normalized);

    if (right.present && right.pinch > 0.8) {
      setBlobParams((prev) => {
        const styles = ["circles", "hexagons", "boxes", "trails"] as const;
        const idx = styles.indexOf(prev.style);
        return { ...prev, style: styles[(idx + 1) % styles.length] };
      });
    }

    requestAnimationFrame(tick);
  }, [envelope, envParams.mix, hand, handParams, mode, momentumParams, renderParams.loopMode, segment]);

  useEffect(() => {
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [tick]);

  const drawOverlays = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = "#00ffff";
    ctx.lineWidth = 2;

    for (const blob of blobs) {
      const x = (blob.x / (canvas.width * blobParams.resolutionScale)) * canvas.width;
      const y = (blob.y / (canvas.height * blobParams.resolutionScale)) * canvas.height;
      const radius = Math.sqrt(blob.area);

      if (blobParams.style === "boxes") {
        ctx.strokeRect(x - radius / 2, y - radius / 2, radius, radius);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(4, radius / 3), 0, Math.PI * 2);
        ctx.stroke();
      }

      if (blobParams.showMetrics) {
        ctx.fillStyle = "#00ffff";
        ctx.fillText(`#${blob.id} (${x.toFixed(0)}, ${y.toFixed(0)})`, x + 6, y - 6);
      }
    }

    ctx.restore();
    requestAnimationFrame(drawOverlays);
  }, [blobParams.resolutionScale, blobParams.showMetrics, blobParams.style, blobs]);

  useEffect(() => {
    const id = requestAnimationFrame(drawOverlays);
    return () => cancelAnimationFrame(id);
  }, [drawOverlays]);

  const onFile = (setter: (url: string) => void) => (file: File | null) => {
    if (!file) {
      return;
    }
    const url = URL.createObjectURL(file);
    setter(url);
  };

  return (
    <main style={{ padding: 16, color: "#d8deef", background: "#0a0c12", minHeight: "100vh" }}>
      <h1 style={{ marginTop: 0 }}>Real-time Hand + Audio Reactive Video Scrubber</h1>
      <p style={{ marginTop: -8, color: "#9ba3b8" }}>
        Upload video/audio, use left-hand pinch (mouse fallback) for playhead, and right-hand pinch to cycle blob style.
      </p>

      <section style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <label>
          Video MP4:
          <input type="file" accept="video/mp4,video/*" onChange={(e) => onFile((url) => setVideoUrl(url))(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          Audio Track:
          <input type="file" accept="audio/*" onChange={(e) => onFile((url) => setAudioUrl(url))(e.target.files?.[0] ?? null)} />
        </label>
      </section>

      <canvas ref={canvasRef} width={960} height={540} style={{ width: "100%", maxWidth: 960, borderRadius: 10, border: "1px solid #2f3342" }} />

      <ControlPanel
        mode={mode}
        onModeChange={setMode}
        hand={handParams}
        setHand={setHandParams}
        blob={blobParams}
        setBlob={setBlobParams}
        env={envParams}
        setEnv={setEnvParams}
        segment={segmentParams}
        setSegment={setSegmentParams}
        momentum={momentumParams}
        setMomentum={setMomentumParams}
        render={renderParams}
        setRender={setRenderParams}
      />

      <VideoPlayer videoUrl={videoUrl} playhead={playhead} canvasRef={canvasRef} onVideoReady={(v) => (videoElRef.current = v)} />
      {blobParams.enabled && (
        <BlobTracker
          canvasRef={canvasRef}
          params={blobParams}
          freeze={hand.getHands().right.isFist}
          onBlobs={setBlobs}
        />
      )}
      <HandTracker onMove={hand.simulateFromMouse} />
      <AudioAnalyzer
        onAttach={async () => {
          if (audioUrl) {
            const audio = new Audio(audioUrl);
            audio.loop = true;
            await envelope.setupFromMediaElement(audio);
            await audio.play();
          } else {
            await envelope.setupFromMic();
          }
        }}
      />
    </main>
  );
}
