import type { MomentumParams } from "../types";

export interface PlayheadPhysicsState {
  position: number;
  velocity: number;
}

export function integratePlayhead(
  state: PlayheadPhysicsState,
  dt: number,
  impulses: { hand: number; envelope: number; bass: number; mid: number; high: number },
  params: MomentumParams,
): PlayheadPhysicsState {
  const frequencyDrive =
    impulses.bass * params.bassDrive + impulses.mid * params.midDrive + impulses.high * params.highDrive;
  const totalImpulse = impulses.hand + impulses.envelope + frequencyDrive;

  state.velocity += totalImpulse * dt;
  state.velocity *= Math.pow(params.damping, dt * 60);

  // Elastic return to nearest bound when out of range.
  if (state.position < 0) {
    state.velocity += (0 - state.position) * params.elasticReturn * dt;
  } else if (state.position > 1) {
    state.velocity += (1 - state.position) * params.elasticReturn * dt;
  }

  state.position += state.velocity * dt;
  return state;
}

export function clampOrWrap(position: number, loopMode: boolean): number {
  if (loopMode) {
    if (position < 0) {
      return 1 + (position % 1);
    }
    return position % 1;
  }
  return Math.max(0, Math.min(1, position));
}
