import type { Blob } from "../types";

export interface BlobDetectionParams {
  threshold: number;
  minArea: number;
  maxBlobs: number;
  smoothing: number;
}

const OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function detectBlobs(
  prevFrame: ImageData,
  currFrame: ImageData,
  width: number,
  height: number,
  params: BlobDetectionParams,
  previousBlobs: Blob[],
): Blob[] {
  const length = width * height;
  const visited = new Uint8Array(length);
  const active = new Uint8Array(length);

  for (let i = 0; i < length; i += 1) {
    const pIdx = i * 4;
    const dr = Math.abs(currFrame.data[pIdx] - prevFrame.data[pIdx]);
    const dg = Math.abs(currFrame.data[pIdx + 1] - prevFrame.data[pIdx + 1]);
    const db = Math.abs(currFrame.data[pIdx + 2] - prevFrame.data[pIdx + 2]);
    const d = (dr + dg + db) / 3;
    if (d >= params.threshold) {
      active[i] = 1;
    }
  }

  const blobs: Blob[] = [];
  let nextId = 1;

  for (let i = 0; i < length; i += 1) {
    if (visited[i] || !active[i]) {
      continue;
    }
    const queue = [i];
    visited[i] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;

    while (queue.length) {
      const idx = queue.pop()!;
      const x = idx % width;
      const y = Math.floor(idx / width);
      area += 1;
      sumX += x;
      sumY += y;

      for (const [dx, dy] of OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }
        const ni = ny * width + nx;
        if (!visited[ni] && active[ni]) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    if (area >= params.minArea) {
      blobs.push({
        id: nextId,
        x: sumX / area,
        y: sumY / area,
        area,
        vx: 0,
        vy: 0,
      });
      nextId += 1;
      if (blobs.length >= params.maxBlobs) {
        break;
      }
    }
  }

  return smoothBlobs(previousBlobs, blobs, params.smoothing);
}

function smoothBlobs(previous: Blob[], current: Blob[], smoothing: number): Blob[] {
  return current.map((blob) => {
    let nearest: Blob | null = null;
    let nearestDist = Number.POSITIVE_INFINITY;

    for (const old of previous) {
      const dx = blob.x - old.x;
      const dy = blob.y - old.y;
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) {
        nearest = old;
        nearestDist = dist;
      }
    }

    if (!nearest) {
      return blob;
    }

    const x = nearest.x + (blob.x - nearest.x) * (1 - smoothing);
    const y = nearest.y + (blob.y - nearest.y) * (1 - smoothing);

    return {
      ...blob,
      id: nearest.id,
      x,
      y,
      vx: x - nearest.x,
      vy: y - nearest.y,
    };
  });
}
