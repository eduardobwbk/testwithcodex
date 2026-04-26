// blob-renderer.js
//
// Draws blobs from BlobTracker onto an HTML canvas in one of four styles:
//   - 'circles'   : concentric rings, center dot, optional id / metric labels
//   - 'hex'       : nested hexagon frames + connection lines + numeric labels
//   - 'boxes'     : bounding box + crosshair + bracket corners
//   - 'trails'    : smoothed motion trails as polylines
//
// Visual language inspired by mondniles.com/en/tools/blob-tracker:
// ultra-thin, low-opacity strokes, tabular numerics, high technical feel.
//
// Usage:
//   const rend = new BlobRenderer();
//   rend.setParams({ style: 'circles', color: '#ffffff', opacity: 0.65, ... });
//   rend.draw(ctx2d, canvasW, canvasH, blobs);

export class BlobRenderer {
  constructor() {
    this.style          = 'circles';    // 'circles' | 'hex' | 'boxes' | 'trails'
    this.color          = '#ffffff';
    this.opacity        = 0.65;
    this.lineWeight     = 1.0;
    this.showIds        = false;
    this.showMetrics    = false;        // area / size text
    this.showXY         = false;
    this.drawConnections= false;        // lines between nearby blobs
    this.connectionMaxDist = 260;       // px
    this.dotted         = false;        // dashed strokes
    this.bracketLen     = 12;           // for 'boxes' corner brackets
  }

  setParams(p) {
    if (!p) return;
    if (p.style       != null) this.style       = String(p.style);
    if (p.color       != null) this.color       = String(p.color);
    if (p.opacity     != null) this.opacity     = Math.max(0, Math.min(1, p.opacity));
    if (p.lineWeight  != null) this.lineWeight  = Math.max(0.25, p.lineWeight);
    if (p.showIds     != null) this.showIds     = !!p.showIds;
    if (p.showMetrics != null) this.showMetrics = !!p.showMetrics;
    if (p.showXY      != null) this.showXY      = !!p.showXY;
    if (p.drawConnections != null) this.drawConnections = !!p.drawConnections;
    if (p.connectionMaxDist != null) this.connectionMaxDist = Math.max(1, p.connectionMaxDist);
    if (p.dotted      != null) this.dotted      = !!p.dotted;
    if (p.bracketLen  != null) this.bracketLen  = Math.max(4, p.bracketLen);
  }

  // ctx: CanvasRenderingContext2D; w,h: canvas CSS size; blobs: BlobTracker.blobs
  draw(ctx, w, h, blobs) {
    if (!ctx || w <= 0 || h <= 0) return;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (!blobs || blobs.length === 0) { ctx.restore(); return; }

    ctx.globalAlpha = this.opacity;
    ctx.strokeStyle = this.color;
    ctx.fillStyle   = this.color;
    ctx.lineWidth   = this.lineWeight;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    if (this.dotted) ctx.setLineDash([3, 4]);

    // Optional global connection lines (drawn first so blobs paint on top)
    if (this.drawConnections) this._drawConnections(ctx, blobs);

    switch (this.style) {
      case 'hex':    this._drawHex(ctx, blobs, w, h); break;
      case 'boxes':  this._drawBoxes(ctx, blobs); break;
      case 'trails': this._drawTrails(ctx, blobs); break;
      case 'circles':
      default:       this._drawCircles(ctx, blobs); break;
    }

    ctx.restore();
  }

  // ---------- Connections ----------
  _drawConnections(ctx, blobs) {
    const md  = this.connectionMaxDist;
    const md2 = md * md;
    ctx.save();
    ctx.globalAlpha *= 0.45;
    for (let i = 0; i < blobs.length; i++) {
      const a = blobs[i];
      for (let j = i + 1; j < blobs.length; j++) {
        const b = blobs[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > md2) continue;
        // fade by distance
        const t = 1 - Math.sqrt(d2) / md;
        ctx.globalAlpha = this.opacity * 0.45 * t;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- Style: circles ----------
  _drawCircles(ctx, blobs) {
    for (const b of blobs) {
      const r = Math.max(6, b.size);
      // Outer thin ring
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // Mid ring
      ctx.save();
      ctx.globalAlpha *= 0.55;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      // Inner dot
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.opacity + 0.2);
      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(1.5, this.lineWeight * 1.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      this._drawLabels(ctx, b, r + 6);
    }
  }

  // ---------- Style: hex + numeric ----------
  _drawHex(ctx, blobs, w, h) {
    for (const b of blobs) {
      const r = Math.max(8, b.size);
      // Outer hex
      this._hexPath(ctx, b.x, b.y, r, 0);
      ctx.stroke();
      // Inner hex rotated 30°
      ctx.save();
      ctx.globalAlpha *= 0.55;
      this._hexPath(ctx, b.x, b.y, r * 0.58, Math.PI / 6);
      ctx.stroke();
      ctx.restore();
      // Tiny node marker
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.opacity + 0.2);
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Numeric label (like '5.8200') — derived from size/speed
      const metric = (b.size * 0.0872).toFixed(4);
      this._tinyLabel(ctx, metric, b.x + r + 8, b.y - r * 0.25);
      if (this.showIds)     this._tinyLabel(ctx, `#${b.id}`, b.x - r - 28, b.y - r * 0.25);
      if (this.showXY)      this._tinyLabel(ctx, `${b.x.toFixed(0)},${b.y.toFixed(0)}`, b.x - r, b.y + r + 12);
      if (this.showMetrics) this._tinyLabel(ctx, `A=${Math.round(b.area)}`, b.x + r + 8, b.y + 8);
    }
  }

  _hexPath(ctx, cx, cy, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + i * (Math.PI / 3);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // ---------- Style: boxes + crosshair ----------
  _drawBoxes(ctx, blobs) {
    const bl = this.bracketLen;
    for (const b of blobs) {
      const bb = b.bbox || { x: b.x - b.size, y: b.y - b.size, w: b.size * 2, h: b.size * 2 };
      const x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h;

      // Corner brackets
      ctx.beginPath();
      // TL
      ctx.moveTo(x0, y0 + bl); ctx.lineTo(x0, y0); ctx.lineTo(x0 + bl, y0);
      // TR
      ctx.moveTo(x1 - bl, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + bl);
      // BR
      ctx.moveTo(x1, y1 - bl); ctx.lineTo(x1, y1); ctx.lineTo(x1 - bl, y1);
      // BL
      ctx.moveTo(x0 + bl, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - bl);
      ctx.stroke();

      // Crosshair through center
      ctx.save();
      ctx.globalAlpha *= 0.6;
      ctx.beginPath();
      ctx.moveTo(b.x - 8, b.y); ctx.lineTo(b.x - 2, b.y);
      ctx.moveTo(b.x + 2, b.y); ctx.lineTo(b.x + 8, b.y);
      ctx.moveTo(b.x, b.y - 8); ctx.lineTo(b.x, b.y - 2);
      ctx.moveTo(b.x, b.y + 2); ctx.lineTo(b.x, b.y + 8);
      ctx.stroke();
      ctx.restore();

      this._drawLabels(ctx, b, Math.max(bb.w, bb.h) * 0.5 + 8);
    }
  }

  // ---------- Style: trails ----------
  _drawTrails(ctx, blobs) {
    for (const b of blobs) {
      const t = b.trail;
      if (!t || t.length < 2) continue;
      // Gradient-alpha polyline: older points fainter
      for (let i = 1; i < t.length; i++) {
        const a = i / t.length;
        ctx.save();
        ctx.globalAlpha = this.opacity * a;
        ctx.beginPath();
        ctx.moveTo(t[i - 1][0], t[i - 1][1]);
        ctx.lineTo(t[i][0],     t[i][1]);
        ctx.stroke();
        ctx.restore();
      }
      // Head marker
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.opacity + 0.25);
      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(2, this.lineWeight * 1.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (this.showIds)     this._tinyLabel(ctx, `#${b.id}`, b.x + 6, b.y - 6);
      if (this.showMetrics) this._tinyLabel(ctx, `v=${b.speed.toFixed(0)}`, b.x + 6, b.y + 10);
    }
  }

  // ---------- Labels ----------
  _drawLabels(ctx, b, offset) {
    let yCursor = b.y - offset;
    if (this.showIds) {
      this._tinyLabel(ctx, `#${b.id}`, b.x + offset, yCursor);
      yCursor += 11;
    }
    if (this.showXY) {
      this._tinyLabel(ctx, `${b.x.toFixed(0)},${b.y.toFixed(0)}`, b.x + offset, yCursor);
      yCursor += 11;
    }
    if (this.showMetrics) {
      this._tinyLabel(ctx, `A=${Math.round(b.area)}`, b.x + offset, yCursor);
    }
  }

  _tinyLabel(ctx, text, x, y) {
    ctx.save();
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}
