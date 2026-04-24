export interface EnvelopeFollowerState {
  value: number;
}

export interface EnvelopeFollowerParams {
  attackMs: number;
  releaseMs: number;
  sensitivity: number;
  punch: number;
}

export function updateEnvelope(
  state: EnvelopeFollowerState,
  input: number,
  dtMs: number,
  params: EnvelopeFollowerParams,
): number {
  const boosted = Math.pow(Math.max(0, input * params.sensitivity), params.punch);
  const attackAlpha = 1 - Math.exp(-dtMs / Math.max(1, params.attackMs));
  const releaseAlpha = 1 - Math.exp(-dtMs / Math.max(1, params.releaseMs));

  const alpha = boosted > state.value ? attackAlpha : releaseAlpha;
  state.value += (boosted - state.value) * alpha;
  state.value = Math.max(0, Math.min(1, state.value));
  return state.value;
}

export function rmsFromByteFrequencyData(data: Uint8Array): number {
  if (!data.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const normalized = data[i] / 255;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

export function splitBands(data: Uint8Array): { bass: number; mid: number; high: number } {
  if (!data.length) {
    return { bass: 0, mid: 0, high: 0 };
  }
  const bassEnd = Math.floor(data.length * 0.15);
  const midEnd = Math.floor(data.length * 0.55);

  const avg = (start: number, end: number) => {
    if (end <= start) {
      return 0;
    }
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      sum += data[i] / 255;
    }
    return sum / (end - start);
  };

  return {
    bass: avg(0, bassEnd),
    mid: avg(bassEnd, midEnd),
    high: avg(midEnd, data.length),
  };
}
