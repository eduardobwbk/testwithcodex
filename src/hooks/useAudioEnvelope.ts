import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvelopeParams } from "../types";
import { rmsFromByteFrequencyData, splitBands, updateEnvelope } from "../utils/envelopeFollower";

export function useAudioEnvelope(params: EnvelopeParams) {
  const [ready, setReady] = useState(false);
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState({ bass: 0, mid: 0, high: 0 });

  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const envRef = useRef({ value: 0 });
  const transientPrevRef = useRef(0);

  const setupFromMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;

    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    contextRef.current = context;
    analyserRef.current = analyser;
    sourceRef.current = source;
    setReady(true);
  }, []);

  const setupFromMediaElement = useCallback(async (el: HTMLMediaElement) => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;

    const source = context.createMediaElementSource(el);
    source.connect(analyser);
    analyser.connect(context.destination);

    contextRef.current = context;
    analyserRef.current = analyser;
    sourceRef.current = source;
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !analyserRef.current) {
      return;
    }
    const analyser = analyserRef.current;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let last = performance.now();

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const now = performance.now();
      const dt = now - last;
      last = now;

      const rms = rmsFromByteFrequencyData(data);
      const env = updateEnvelope(envRef.current, rms, dt, {
        attackMs: params.attackMs,
        releaseMs: params.releaseMs,
        sensitivity: params.sensitivity,
        punch: params.punch,
      });
      const nextBands = splitBands(data);

      setLevel(env);
      setBands(nextBands);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [params, ready]);

  const transient = () => {
    const jump = Math.max(0, level - transientPrevRef.current);
    transientPrevRef.current = level;
    return jump > 0.15 + (1 - params.snap) * 0.1;
  };

  return {
    ready,
    level,
    bands,
    setupFromMic,
    setupFromMediaElement,
    transient,
  };
}
