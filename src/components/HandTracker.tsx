import { useEffect } from "react";

interface HandTrackerProps {
  onMove: (e: MouseEvent) => void;
}

export function HandTracker({ onMove }: HandTrackerProps) {
  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [onMove]);

  return null;
}
