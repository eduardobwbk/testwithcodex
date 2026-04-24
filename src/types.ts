export type PlayheadMode = "position" | "velocity" | "segment-roam";

export type BlobStyle = "circles" | "hexagons" | "boxes" | "trails";

export interface HandParams {
  sensitivity: number;
  damping: number;
  smoothingMs: number;
  reach: number;
  floor: number;
  deadZone: number;
  invert: boolean;
  twoHandMode: boolean;
}

export interface EnvelopeParams {
  attackMs: number;
  releaseMs: number;
  sensitivity: number;
  punch: number;
  jitter: number;
  snap: number;
  mix: number;
}

export interface SegmentRoamParams {
  enabled: boolean;
  segmentSize: number;
  sizeJitter: number;
  direction: "any" | "forward" | "backward";
  continuity: number;
  glideMs: number;
}

export interface BlobParams {
  enabled: boolean;
  sensitivity: number;
  minArea: number;
  maxBlobs: number;
  smoothing: number;
  resolutionScale: number;
  style: BlobStyle;
  showMetrics: boolean;
}

export interface MomentumParams {
  damping: number;
  elasticReturn: number;
  bassDrive: number;
  midDrive: number;
  highDrive: number;
}

export interface RenderParams {
  trailAmount: number;
  frameBlend: number;
  loopMode: boolean;
  backwardAllowed: boolean;
}

export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export interface HandSnapshot {
  present: boolean;
  pinch: number;
  pinchVelocity: number;
  isFist: boolean;
  palm: LandmarkPoint;
}

export interface Blob {
  id: number;
  x: number;
  y: number;
  area: number;
  vx: number;
  vy: number;
}
