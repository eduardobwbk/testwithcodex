import { useEffect, useRef } from "react";

interface VideoPlayerProps {
  videoUrl: string | null;
  playhead: number;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onVideoReady?: (video: HTMLVideoElement) => void;
}

export function VideoPlayer({ videoUrl, playhead, canvasRef, onVideoReady }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = document.createElement("video");
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    video.preload = "auto";
    videoRef.current = video;

    if (videoUrl) {
      video.src = videoUrl;
      video.load();
    }

    const onLoaded = () => onVideoReady?.(video);
    video.addEventListener("loadedmetadata", onLoaded);
    return () => {
      video.pause();
      video.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [onVideoReady, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.duration || Number.isNaN(video.duration)) {
      return;
    }
    video.currentTime = Math.min(video.duration - 0.001, Math.max(0, playhead * video.duration));

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    ctx.drawImage(video, 0, 0, width, height);
  }, [canvasRef, playhead]);

  return null;
}
