import { useCallback, useMemo, useRef, useState } from "react";
import type { HandSnapshot } from "../types";

interface SimState {
  left: HandSnapshot;
  right: HandSnapshot;
}

const emptyHand: HandSnapshot = {
  present: false,
  pinch: 0,
  pinchVelocity: 0,
  isFist: false,
  palm: { x: 0.5, y: 0.5, z: 0 },
};

/**
 * Hand tracking adapter.
 *
 * This ships with a simulation mode so the project can run without model assets,
 * and exposes a `connectMediaPipe` method where you can wire MediaPipe Hands or
 * HandLandmarker callbacks directly.
 */
export function useHandTracking() {
  const [enabled, setEnabled] = useState(false);
  const stateRef = useRef<SimState>({ left: emptyHand, right: emptyHand });
  const prevPinchRef = useRef({ left: 0, right: 0 });

  const connectMediaPipe = useCallback((
    input: {
      left?: { pinch: number; palmX: number; palmY: number; fist?: boolean };
      right?: { pinch: number; palmX: number; palmY: number; fist?: boolean };
    },
  ) => {
    const now = performance.now();
    const dt = 16;
    void now;
    const leftPinch = input.left?.pinch ?? 0;
    const rightPinch = input.right?.pinch ?? 0;

    stateRef.current.left = {
      present: !!input.left,
      pinch: leftPinch,
      pinchVelocity: (leftPinch - prevPinchRef.current.left) / dt,
      isFist: !!input.left?.fist,
      palm: { x: input.left?.palmX ?? 0.5, y: input.left?.palmY ?? 0.5, z: 0 },
    };

    stateRef.current.right = {
      present: !!input.right,
      pinch: rightPinch,
      pinchVelocity: (rightPinch - prevPinchRef.current.right) / dt,
      isFist: !!input.right?.fist,
      palm: { x: input.right?.palmX ?? 0.5, y: input.right?.palmY ?? 0.5, z: 0 },
    };

    prevPinchRef.current.left = leftPinch;
    prevPinchRef.current.right = rightPinch;
    setEnabled(true);
  }, []);

  const simulateFromMouse = useCallback((e: MouseEvent) => {
    const pinch = e.buttons === 1 ? 1 : 0;
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    stateRef.current.left = {
      present: true,
      pinch,
      pinchVelocity: pinch - prevPinchRef.current.left,
      isFist: false,
      palm: { x, y, z: 0 },
    };
    prevPinchRef.current.left = pinch;
    setEnabled(true);
  }, []);

  const snapshot = useMemo(() => {
    return {
      getHands() {
        return stateRef.current;
      },
      connectMediaPipe,
      simulateFromMouse,
      enabled,
    };
  }, [connectMediaPipe, enabled, simulateFromMouse]);

  return snapshot;
}
