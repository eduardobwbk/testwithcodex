import { useMemo, useRef } from "react";
import type { SegmentRoamParams } from "../types";

interface SegmentState {
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  glideLeftMs: number;
}

export function useSegmentRoam(params: SegmentRoamParams) {
  const stateRef = useRef<SegmentState>({
    start: 0,
    end: params.segmentSize,
    targetStart: 0,
    targetEnd: params.segmentSize,
    glideLeftMs: 0,
  });

  return useMemo(() => {
    return {
      update(dtMs: number) {
        const state = stateRef.current;
        if (state.glideLeftMs > 0) {
          const t = Math.min(1, dtMs / Math.max(1, state.glideLeftMs));
          state.start += (state.targetStart - state.start) * t;
          state.end += (state.targetEnd - state.end) * t;
          state.glideLeftMs -= dtMs;
        }
        return { floor: state.start, reach: state.end };
      },
      triggerTransient(currentPos: number) {
        if (!params.enabled) {
          return;
        }
        const state = stateRef.current;
        const baseSize = params.segmentSize;
        const jitter = (Math.random() * 2 - 1) * params.sizeJitter * baseSize;
        const nextSize = Math.max(0.05, Math.min(1, baseSize + jitter));

        const continuityWindow = nextSize * params.continuity;
        let center = currentPos + (Math.random() * 2 - 1) * continuityWindow;

        if (params.direction === "forward") {
          center = Math.max(center, currentPos + continuityWindow * 0.25);
        } else if (params.direction === "backward") {
          center = Math.min(center, currentPos - continuityWindow * 0.25);
        }

        center = ((center % 1) + 1) % 1;
        let start = center - nextSize / 2;
        let end = center + nextSize / 2;

        if (start < 0) {
          end -= start;
          start = 0;
        }
        if (end > 1) {
          start -= end - 1;
          end = 1;
        }

        state.targetStart = Math.max(0, start);
        state.targetEnd = Math.min(1, end);
        state.glideLeftMs = params.glideMs;
      },
      mapLocalToGlobal(local: number) {
        const state = stateRef.current;
        return state.start + (state.end - state.start) * local;
      },
    };
  }, [params]);
}
