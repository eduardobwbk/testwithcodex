import type { CSSProperties } from "react";
import type {
  BlobParams,
  EnvelopeParams,
  HandParams,
  MomentumParams,
  PlayheadMode,
  RenderParams,
  SegmentRoamParams,
} from "../types";

interface ControlPanelProps {
  mode: PlayheadMode;
  onModeChange: (mode: PlayheadMode) => void;
  hand: HandParams;
  setHand: (next: HandParams) => void;
  blob: BlobParams;
  setBlob: (next: BlobParams) => void;
  env: EnvelopeParams;
  setEnv: (next: EnvelopeParams) => void;
  segment: SegmentRoamParams;
  setSegment: (next: SegmentRoamParams) => void;
  momentum: MomentumParams;
  setMomentum: (next: MomentumParams) => void;
  render: RenderParams;
  setRender: (next: RenderParams) => void;
}

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
      <span>
        {label}: {value.toFixed(2)}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function ControlPanel(props: ControlPanelProps) {
  const sectionStyle: CSSProperties = {
    border: "1px solid #2f3342",
    borderRadius: 10,
    padding: 10,
    display: "grid",
    gap: 8,
    minWidth: 220,
    background: "#11131a",
  };

  return (
    <aside
      style={{
        display: "flex",
        gap: 10,
        overflowX: "auto",
        paddingBottom: 8,
      }}
    >
      <section style={sectionStyle}>
        <strong>Playhead Mode</strong>
        <select value={props.mode} onChange={(e) => props.onModeChange(e.target.value as PlayheadMode)}>
          <option value="position">Position</option>
          <option value="velocity">Velocity</option>
          <option value="segment-roam">Segment Roam</option>
        </select>
      </section>

      <section style={sectionStyle}>
        <strong>Hand Controls</strong>
        <Slider label="Sensitivity" value={props.hand.sensitivity} min={0.1} max={4} onChange={(v) => props.setHand({ ...props.hand, sensitivity: v })} />
        <Slider label="Damping" value={props.hand.damping} min={0.5} max={0.99} onChange={(v) => props.setHand({ ...props.hand, damping: v })} />
        <Slider label="Dead Zone" value={props.hand.deadZone} min={0} max={0.2} onChange={(v) => props.setHand({ ...props.hand, deadZone: v })} />
      </section>

      <section style={sectionStyle}>
        <strong>Envelope</strong>
        <Slider label="Attack" value={props.env.attackMs} min={5} max={400} step={1} onChange={(v) => props.setEnv({ ...props.env, attackMs: v })} />
        <Slider label="Release" value={props.env.releaseMs} min={20} max={1200} step={1} onChange={(v) => props.setEnv({ ...props.env, releaseMs: v })} />
        <Slider label="Mix" value={props.env.mix} min={0} max={1} onChange={(v) => props.setEnv({ ...props.env, mix: v })} />
      </section>

      <section style={sectionStyle}>
        <strong>Segment Roam</strong>
        <Slider label="Segment Size" value={props.segment.segmentSize} min={0.05} max={1} onChange={(v) => props.setSegment({ ...props.segment, segmentSize: v })} />
        <Slider label="Size Jitter" value={props.segment.sizeJitter} min={0} max={1} onChange={(v) => props.setSegment({ ...props.segment, sizeJitter: v })} />
        <Slider label="Continuity" value={props.segment.continuity} min={0} max={1} onChange={(v) => props.setSegment({ ...props.segment, continuity: v })} />
      </section>

      <section style={sectionStyle}>
        <strong>Blob Tracker</strong>
        <Slider label="Sensitivity" value={props.blob.sensitivity} min={5} max={80} step={1} onChange={(v) => props.setBlob({ ...props.blob, sensitivity: v })} />
        <Slider label="Min Area" value={props.blob.minArea} min={10} max={2000} step={1} onChange={(v) => props.setBlob({ ...props.blob, minArea: v })} />
      </section>

      <section style={sectionStyle}>
        <strong>Momentum</strong>
        <Slider label="Damping" value={props.momentum.damping} min={0.5} max={0.999} onChange={(v) => props.setMomentum({ ...props.momentum, damping: v })} />
        <Slider label="Elastic" value={props.momentum.elasticReturn} min={0} max={8} onChange={(v) => props.setMomentum({ ...props.momentum, elasticReturn: v })} />
      </section>

      <section style={sectionStyle}>
        <strong>Render</strong>
        <Slider label="Trail" value={props.render.trailAmount} min={0} max={1} onChange={(v) => props.setRender({ ...props.render, trailAmount: v })} />
        <Slider label="Blend" value={props.render.frameBlend} min={0} max={1} onChange={(v) => props.setRender({ ...props.render, frameBlend: v })} />
      </section>
    </aside>
  );
}
