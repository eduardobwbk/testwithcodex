import { useEffect, useRef } from "react";
import type { Blob, BlobParams } from "../types";
import { detectBlobs } from "../utils/blobDetection";

interface BlobTrackerProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  params: BlobParams;
  freeze: boolean;
  onBlobs?: (blobs: Blob[]) => void;
}

export function BlobTracker({ canvasRef, params, freeze, onBlobs }: BlobTrackerProps) {
  const prevFrameRef = useRef<ImageData | null>(null);
  const blobStateRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas || !params.enabled) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const w = Math.max(8, Math.floor(canvas.width * params.resolutionScale));
      const h = Math.max(8, Math.floor(canvas.height * params.resolutionScale));
      const frame = ctx.getImageData(0, 0, w, h);

      if (!freeze && prevFrameRef.current) {
        const blobs = detectBlobs(prevFrameRef.current, frame, w, h, {
          threshold: params.sensitivity,
          minArea: params.minArea,
          maxBlobs: params.maxBlobs,
          smoothing: params.smoothing,
        }, blobStateRef.current);
        blobStateRef.current = blobs;
        onBlobs?.(blobs);
      }

      prevFrameRef.current = frame;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [canvasRef, freeze, onBlobs, params]);

  return null;
}
