// renderer-gl.js
// WebGL2 renderer.
//
// ORIENTATION POLICY (read this before touching anything):
//   1. Frames arrive as top-down ImageBitmaps (canvas convention).
//   2. We upload them with UNPACK_FLIP_Y_WEBGL=true so the GPU stores them
//      bottom-up (WebGL's native convention: V=0 is the bottom of the image).
//   3. FBOs are also bottom-up natively — no extra flips when reading/writing.
//   4. When we draw the final pixel to the *canvas element*, we flip V in the
//      vertex shader because the browser presents the WebGL framebuffer with
//      its bottom row at the top of the displayed canvas. This flip is ONLY
//      applied on the final-to-canvas pass.
//
// In short: exactly two flips — upload and final display — and they cancel out.

const VERT_NOFLIP = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Final display pass: flip V so the image's top row shows at the top of the canvas
const VERT_FLIPY = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_BLEND = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;
uniform float uBlendAmount;
out vec4 outColor;
void main() {
  vec4 a = texture(uA, vUv);
  vec4 b = texture(uB, vUv);
  float m = mix(0.0, uMix, uBlendAmount);
  outColor = mix(a, b, m);
}`;

const FRAG_TRAIL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uCurrent;
uniform sampler2D uPrev;
uniform float uTrail;
out vec4 outColor;
void main() {
  vec4 c = texture(uCurrent, vUv);
  vec4 p = texture(uPrev, vUv);
  vec3 decayed = p.rgb * uTrail;
  vec3 screen = 1.0 - (1.0 - c.rgb) * (1.0 - decayed);
  outColor = vec4(max(c.rgb, screen * 0.9 + c.rgb * 0.1), 1.0);
}`;

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader compile: ' + log);
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Intermediate (FBO-target) programs use no-flip vertex shader
    this.progBlend = program(gl, VERT_NOFLIP, FRAG_BLEND);

    // Final (canvas-target) programs flip V to correct for the canvas presentation
    this.progTrailFinal = program(gl, VERT_FLIPY, FRAG_TRAIL);
    this.progCopyFinal  = program(gl, VERT_FLIPY, FRAG_COPY);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1, 1,
      -1,  1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;

    this.texA = this._makeTex();
    this.texB = this._makeTex();

    this.fboSize = [0, 0];
    this.trailA = null;
    this.trailB = null;
    this.pingIdx = 0;

    this.frames = [];
    this.width = 0;
    this.height = 0;
    this._lastA = -1;
    this._lastB = -1;
  }

  _makeTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeFbo(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  setFrames(frames, width, height) {
    this.frames = frames;
    this.width = width;
    this.height = height;
    this._resize();
    this._lastA = -1; this._lastB = -1;
  }

  _resize() {
    const canvas = this.canvas;
    const stage = canvas.parentElement;
    const maxW = stage.clientWidth;
    const maxH = stage.clientHeight;
    const ar = this.width / this.height || 16/9;
    let cw = maxW, ch = maxW / ar;
    if (ch > maxH) { ch = maxH; cw = maxH * ar; }
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(2, Math.floor(cw * dpr));
    canvas.height = Math.max(2, Math.floor(ch * dpr));

    if (canvas.width !== this.fboSize[0] || canvas.height !== this.fboSize[1]) {
      this.fboSize = [canvas.width, canvas.height];
      if (this.trailA) {
        this.gl.deleteTexture(this.trailA.tex); this.gl.deleteFramebuffer(this.trailA.fbo);
        this.gl.deleteTexture(this.trailB.tex); this.gl.deleteFramebuffer(this.trailB.fbo);
      }
      this.trailA = this._makeFbo(canvas.width, canvas.height);
      this.trailB = this._makeFbo(canvas.width, canvas.height);
      const gl = this.gl;
      for (const f of [this.trailA, this.trailB]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  resize() { this._resize(); }

  _uploadFrame(tex, bmp) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Top-down ImageBitmap → flip to bottom-up WebGL texture convention
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  }

  draw(sample, opts) {
    const gl = this.gl;
    const { frameA, frameB, mix } = sample;
    const { trail = 0, blendAmount = 1 } = opts || {};

    if (!this.frames.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    if (frameA !== this._lastA) {
      this._uploadFrame(this.texA, this.frames[frameA]);
      this._lastA = frameA;
    }
    if (frameB !== this._lastB) {
      this._uploadFrame(this.texB, this.frames[frameB]);
      this._lastB = frameB;
    }

    gl.bindVertexArray(this.vao);

    // --- Pass 1: blend A/B into current trail FBO (no flip; FBO space is native) ---
    const cur = this.pingIdx === 0 ? this.trailA : this.trailB;
    const prev = this.pingIdx === 0 ? this.trailB : this.trailA;

    gl.bindFramebuffer(gl.FRAMEBUFFER, cur.fbo);
    gl.viewport(0, 0, this.fboSize[0], this.fboSize[1]);
    gl.useProgram(this.progBlend);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.uniform1i(gl.getUniformLocation(this.progBlend, 'uA'), 0);
    gl.uniform1i(gl.getUniformLocation(this.progBlend, 'uB'), 1);
    gl.uniform1f(gl.getUniformLocation(this.progBlend, 'uMix'), mix);
    gl.uniform1f(gl.getUniformLocation(this.progBlend, 'uBlendAmount'), blendAmount);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 2: final composite to canvas (flip V for canvas presentation) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (trail > 0.01) {
      gl.useProgram(this.progTrailFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prev.tex);
      gl.uniform1i(gl.getUniformLocation(this.progTrailFinal, 'uCurrent'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progTrailFinal, 'uPrev'), 1);
      gl.uniform1f(gl.getUniformLocation(this.progTrailFinal, 'uTrail'), trail);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } else {
      gl.useProgram(this.progCopyFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.uniform1i(gl.getUniformLocation(this.progCopyFinal, 'uTex'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    this.pingIdx ^= 1;
  }
}
