import { useEffect } from "react";

interface AudioAnalyzerProps {
  onAttach: () => Promise<void>;
}

export function AudioAnalyzer({ onAttach }: AudioAnalyzerProps) {
  useEffect(() => {
    void onAttach();
  }, [onAttach]);

  return null;
}
