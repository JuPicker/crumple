/*! Crumple v1.0.0 | MIT | Julien Picker | github.com/JuPicker/crumple
 * Crumple any element into a paper ball, then throw it in the bin.
 * WebGL2 + a tiny 2D physics + synthesized sound. Zero dependency.
 *
 * DOM capture: pass `snapshot(el, scale) => Promise<canvas>` or load
 * modern-screenshot first (window.modernScreenshot), it is used by default.
 *
 *   const toss = Crumple.create({ sound: true });
 *   toss.prepare(dialog);                        // optional: capture ahead of time
 *   button.onpointerdown = (e) => toss.grab(dialog, e);
 *   toss.on('score', (ball) => closeDialog());
 *   toss.discard(ball);                          // a quiet undo: the ball leaves the bin
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Crumple = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const now = () => performance.now() / 1000;

  // quaternions [x, y, z, w]
  const qId = () => [0, 0, 0, 1];
  const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
  function qSpin(q, w, dt) {
    const s = Math.hypot(w[0], w[1], w[2]);
    const a = s * dt;
    if (a < 1e-7) return q;
    const k = Math.sin(a / 2) / s;
    return qNorm(qMul([w[0] * k, w[1] * k, w[2] * k, Math.cos(a / 2)], q));
  }
  function qLerp(a, b, t) {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    return qNorm([lerp(a[0], b[0] * s, t), lerp(a[1], b[1] * s, t), lerp(a[2], b[2] * s, t), lerp(a[3], b[3] * s, t)]);
  }
  function qMat(q, out) {
    const [x, y, z, w] = q;
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + w * z); out[2] = 2 * (x * z - w * y);
    out[3] = 2 * (x * y - w * z); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z + w * x);
    out[6] = 2 * (x * z + w * y); out[7] = 2 * (y * z - w * x); out[8] = 1 - 2 * (x * x + y * y);
    return out;
  }

  function parseColor(str, fallback) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return fallback;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length > 3 && p[3] === 0) return fallback;
    return [p[0] / 255, p[1] / 255, p[2] / 255];
  }

  /* -------------------------------------------------------------- shaders */
  // Voronoi F2-F1: zero on the cell borders, so the surface stays continuous
  // and every border becomes a sharp fold. Each cell pops up or down.
  const CREASES = `
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float cell(vec2 x, float salt) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash2(n + g + salt) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = n + g; } else if (d < d2) { d2 = d; }
  }
  float s = fract(sin(dot(id + salt, vec2(41.3, 289.1))) * 43758.5453) * 2.0 - 1.0;
  return (sqrt(d2) - sqrt(d1)) * s;
}
float creases(vec2 q) {
  return cell(q * 3.6, uSeed) + cell(q * 8.0, uSeed + 17.0) * 0.5 + cell(q * 17.0, uSeed + 41.0) * 0.16;
}`;

  const BALL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aUV;
uniform vec2 uRes, uPos, uSize, uStep;
uniform float uT, uSeed, uScale, uRb, uAmp;
uniform mat3 uRot;
out vec2 vUV;
out vec3 vN;
out vec3 vP;
const float PI = 3.14159265;
${CREASES}

// the overall shape: a sheet wrapped on a sphere whose radius shrinks
vec3 shape(vec2 uv, out vec3 ns) {
  vec2 hs = uSize * 0.5;
  vec2 p = (uv - 0.5) * uSize;
  float r = length(p);
  vec2 dir = r > 1e-3 ? p / r : vec2(1.0, 0.0);
  float th = atan(p.y, p.x);
  float rn = max(abs(p.x) / hs.x, abs(p.y) / hs.y);

  // the sheet closes unevenly: some sides fold before others
  float sector = 0.55 * sin(2.0 * th + uSeed * 3.1) + 0.3 * sin(3.0 * th + uSeed * 5.3) + 0.15 * sin(5.0 * th + uSeed * 7.7);
  float g0 = smoothstep(0.08, 0.96, uT);
  float g = clamp(g0 + sector * 0.24 * sin(PI * g0) * (0.35 + rn), 0.0008, 1.0);

  // rho blends a length-preserving map (flat) into a border-to-pole map (no holes)
  float D0 = sqrt(hs.x * hs.y);
  float rho = mix(r / D0, rn, g * g);
  float phi = PI * g * rho;
  float R = D0 / (PI * g);
  float sp = sin(phi), sh = sin(phi * 0.5);
  vec3 pos = vec3(dir * R * sp, -2.0 * R * sh * sh);
  ns = vec3(dir * sp, cos(phi));

  // a paper ball is lumpy, never round
  float lump = sin(ns.x * 3.1 + uSeed) * sin(ns.y * 2.7 + uSeed * 1.3) * sin(ns.z * 2.3 + uSeed * 0.7)
             + 0.5 * sin(ns.x * 5.3 - uSeed) * sin(ns.z * 4.1 + uSeed * 2.1);
  pos += ns * lump * uRb * 0.16 * g * g;
  pos.xy *= 1.0 - 0.06 * smoothstep(0.0, 0.3, uT) * (1.0 - g);
  return pos;
}

void main() {
  vec3 ns, n1;
  vec3 p0 = shape(aUV, ns);
  vec3 pu = shape(aUV + vec2(uStep.x, 0.0), n1);
  vec3 pv = shape(aUV + vec2(0.0, uStep.y), n1);
  vec3 n = normalize(cross(pu - p0, pv - p0));
  // the folds move the geometry too (self-overlap, bumpy outline)
  p0 += ns * creases((aUV - 0.5) * uSize / max(uSize.x, uSize.y)) * uAmp;
  vec3 pivot = vec3(0.0, 0.0, -uRb);
  vec3 pr = uRot * (p0 - pivot) + pivot;
  vN = uRot * n;
  vUV = aUV;
  vec2 s = uPos + pr.xy * uScale;
  float z = pr.z * uScale;
  vP = vec3(s, z);
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, clamp(-z / 1200.0, -1.0, 1.0), 1.0);
}`;

  const BALL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vN;
in vec3 vP;
uniform sampler2D uTex;
uniform vec3 uBack;
uniform vec2 uSize;
uniform float uLit, uAlpha, uSeed, uAmp, uScale;
out vec4 o;
${CREASES}
void main() {
  vec4 tx = texture(uTex, vUV);
  if (tx.a < 0.02) discard;
  bool front = gl_FrontFacing;
  vec3 N = normalize(vN);
  if (!front) N = -N;

  // folds, evaluated per pixel so every crease stays sharp
  float big = max(uSize.x, uSize.y);
  vec2 k = uSize / big;
  vec2 q = (vUV - 0.5) * k;
  float e = 0.5 / big;
  float h = creases(q);
  float hx = creases(q + vec2(e, 0.0));
  float hy = creases(q + vec2(0.0, e));
  vec2 dhduv = vec2(hx - h, hy - h) / e * k;      // dh/du, dh/dv

  // surface gradient of h (cotangent frame from screen derivatives)
  vec3 dpx = dFdx(vP), dpy = dFdy(vP);
  vec2 dux = dFdx(vUV), duy = dFdy(vUV);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 grad = (r1 * (dhduv.x * dux.x + dhduv.y * dux.y) + r2 * (dhduv.x * duy.x + dhduv.y * duy.y));
  grad /= (abs(det) > 1e-8 ? det : 1e-8);
  vec3 n = normalize(N - grad * uAmp * uScale * (front ? 1.0 : -1.0));

  vec3 base = front ? tx.rgb : uBack;
  vec3 L = normalize(vec3(-0.42, -0.62, 0.66));
  float ndl = dot(n, L);
  float diff = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
  float ao = clamp(0.94 + h * 0.11, 0.76, 1.03);
  float rim = mix(0.88, 1.0, smoothstep(0.0, 0.5, n.z));
  vec3 lit = base * (0.64 + 0.42 * diff) * ao * rim;
  if (!front) lit *= 0.92;
  // dark paper needs light added, not only multiplied, or the folds vanish
  float lum = dot(base, vec3(0.3, 0.59, 0.11));
  float dark = 1.0 - smoothstep(0.15, 0.75, lum);
  lit += vec3(0.16 * (diff - 0.45) * dark * ao);
  vec3 hv = normalize(L + vec3(0.0, 0.0, 1.0));
  lit += pow(max(dot(n, hv), 0.0), 40.0) * mix(0.05, 0.1, dark);
  // rim light so a dark ball still reads against a dark page
  lit += vec3(pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0) * 0.14 * dark);
  lit = max(lit, vec3(0.0));
  vec3 col = mix(base, lit, uLit);
  float a = tx.a * uAlpha;
  o = vec4(col * a, a);
}`;

  const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aP;
uniform vec2 uRes, uPivot;
uniform vec4 uRect;
uniform float uAng;
out vec2 vUV;
out vec2 vL;
void main() {
  vec2 p = uRect.xy + aP * uRect.zw;
  vec2 d = p - uPivot;
  float c = cos(uAng), s = sin(uAng);
  p = uPivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  vUV = aP;
  vL = (aP - 0.5) * uRect.zw;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

  const GLASS_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vL;
uniform sampler2D uTex, uMask;
uniform vec4 uBin;
uniform vec2 uRes;
uniform float uBlur, uDpr;
out vec4 o;
void main() {
  vec2 px = vUV * uRes;
  vec2 t = vec2(vUV.x, 1.0 - vUV.y);
  vec4 sharp = texture(uTex, t);
  vec2 m = (px - uBin.xy) / uBin.zw;
  float mask = (m.x >= 0.0 && m.x <= 1.0 && m.y >= 0.0 && m.y <= 1.0) ? texture(uMask, m).a : 0.0;
  if (mask < 0.004) { o = sharp; return; }
  // smooth blur: sample a coarse mip level, then a small gaussian of it
  float lod = max(0.0, log2(uBlur * uDpr) - 1.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 d = vec2(float(i), float(j)) / 2.0;
    float w = exp(-dot(d, d) * 2.0);
    acc += textureLod(uTex, t + d * uBlur / uRes * vec2(1.0, -1.0), lod) * w; ws += w;
  }
  o = mix(sharp, acc / ws, mask);
}`;

  const TEX_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vL;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 o;
void main() { o = texture(uTex, vUV) * uAlpha; }`;

  // soft rounded-box shadow, used for the dialog, the ball and the bin
  const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vL;
uniform vec2 uHalf;
uniform float uRadius, uBlur, uAlpha, uMode;
uniform vec3 uColor;
out vec4 o;
void main() {
  float a;
  if (uMode > 0.5) {
    // soft elliptical pool of light: a plain gaussian, no edge at all
    vec2 e = vL / uHalf;
    a = exp(-dot(e, e) * 4.5) * uAlpha;
  } else {
    vec2 q = abs(vL) - uHalf + uRadius;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    a = 1.0 - smoothstep(-uBlur, uBlur, d);
    a = a * a * uAlpha;
  }
  o = vec4(uColor * a, a);
}`;

  /* ---------------------------------------------------------------- sound */
  class Sfx {
    constructor() { this.ctx = null; this.enabled = true; }
    ensure() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        const ctx = (this.ctx = new AC());
        this.master = ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(ctx.destination);
        const len = ctx.sampleRate * 1.5;
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    burst(t0, dur, freq, q, gain, type = 'bandpass') {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.003, dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t0, Math.random() * 1.2, dur + 0.02);
    }
    tone(t0, dur, freq, gain, endFreq) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(freq, t0);
      if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    crumple(duration = 0.7, intensity = 1) {
      if (!this.ensure()) return;
      const t = this.ctx.currentTime + 0.01;
      // paper crackle: lots of tiny high clicks, in clusters
      const n = Math.round(70 * intensity);
      for (let i = 0; i < n; i++) {
        const u = Math.pow(Math.random(), 0.85);
        const env = Math.sin(Math.PI * clamp(u * 1.1, 0, 1)) * 0.8 + 0.2;
        this.burst(t + u * duration, 0.005 + Math.random() * 0.03, 1400 + Math.random() * 5600, 0.6 + Math.random() * 2.2, (0.12 + Math.random() * 0.5) * env * intensity);
      }
      this.burst(t, duration * 0.9, 3200, 0.4, 0.05 * intensity);
    }
    whoosh(speed) {
      if (!this.ensure()) return;
      const t = this.ctx.currentTime;
      const g = clamp(speed / 3000, 0.05, 0.4);
      const ctx = this.ctx, src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(380, t); f.frequency.exponentialRampToValueAtTime(1300, t + 0.28);
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(g * 0.5, t + 0.06); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      src.connect(f); f.connect(gn); gn.connect(this.master);
      src.start(t, Math.random(), 0.4);
    }
    rim(v) {
      if (!this.ensure()) return;
      const t = this.ctx.currentTime, g = clamp(v / 1400, 0.03, 0.22);
      this.tone(t, 0.22, 2100 + Math.random() * 300, g * 0.5);
      this.tone(t, 0.14, 3350 + Math.random() * 300, g * 0.3);
      this.burst(t, 0.02, 4500, 1, g * 0.6);
    }
    land(v) {
      if (!this.ensure()) return;
      const t = this.ctx.currentTime, g = clamp(v / 1500, 0.12, 0.5);
      this.tone(t, 0.16, 120, g * 0.7, 55);
      this.burst(t, 0.06, 700, 0.7, g * 0.5, 'lowpass');
      for (let i = 0; i < 9; i++) this.burst(t + 0.01 + Math.random() * 0.12, 0.01 + Math.random() * 0.02, 2000 + Math.random() * 4000, 1.2, g * 0.3);
    }
    tap(v) {
      if (!this.ensure()) return;
      const t = this.ctx.currentTime, g = clamp(v / 1800, 0.02, 0.3);
      this.burst(t, 0.035, 1100, 0.8, g, 'lowpass');
      for (let i = 0; i < 4; i++) this.burst(t + Math.random() * 0.05, 0.008, 3000 + Math.random() * 3000, 1.5, g * 0.4);
    }
  }

  /* ------------------------------------------------------------------ bin */
  // A perforated aluminium bin, drawn as two layers (inside / outside) so the
  // balls fall INSIDE it and show through the holes.
  const BIN_THEMES = {
    // white, like a desktop trash can
    light: {
      metal: [[0, '#c3c4c9'], [.04, '#ececef'], [.16, '#ffffff'], [.3, '#f3f3f5'], [.37, '#ffffff'], [.46, '#ededf0'], [.7, '#e1e2e6'], [.9, '#d2d3d8'], [.97, '#e4e5e8'], [1, '#b9bac0']],
      rim: [[0, '#bfc0c5'], [.3, '#ffffff'], [.55, '#f0f0f3'], [.85, '#d4d5da'], [1, '#b3b4ba']],
      inner: ['#cdced3', '#a6a7ad'], innerSide: .28, backHoles: ['#f4f4f6', .95], floorIn: '#9c9da3',
      lip: ['#000', .1, -.5], brush: 0, brushDark: 0, spec: .5, fade: .1, base: '#d7d8dd', baseLine: ['#fff', .9],
      rimShadow: .14, rimLight: .95, backRimLight: .7,
    },
    // black anodised steel
    dark: {
      metal: [[0, '#46474c'], [.035, '#1b1b1e'], [.16, '#0c0c0d'], [.27, '#202124'], [.36, '#4b4d53'], [.45, '#232427'], [.64, '#101012'], [.88, '#0a0a0b'], [.965, '#1e1f22'], [1, '#3a3b40']],
      rim: [[0, '#3c3d42'], [.12, '#151517'], [.34, '#8d8f95'], [.44, '#2c2d31'], [.8, '#121214'], [1, '#46474c']],
      inner: ['#18181b', '#070708'], innerSide: .7, backHoles: ['#1f2023', .9], floorIn: '#050506',
      lip: ['#fff', .07, .5], brush: .11, brushDark: .35, spec: .09, fade: .5, base: '#141416', baseLine: ['#fff', .1],
      rimShadow: .5, rimLight: .38, backRimLight: .16,
    },
  };
  const stops = (list) => list.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');

  // Frosted glass, like a desktop trash can: milky walls, a thick rolled lip, a heavier base.
  function glassSVG(layer, g) {
    const { Wt, Wb, Hb, ryT, ryB, pad } = g;
    const W = Wt + pad * 2, H = Hb + ryT + ryB + pad * 2;
    const cx = W / 2, ty = pad + ryT, by = ty + Hb;
    const at = (f) => ({ y: lerp(ty, by, f), rx: lerp(Wt / 2, Wb / 2, f), ry: lerp(ryT, ryB, f) });
    const back = (e) => `M ${cx - e.rx} ${e.y} A ${e.rx} ${e.ry} 0 0 1 ${cx + e.rx} ${e.y}`;
    const front = (e) => `M ${cx - e.rx} ${e.y} A ${e.rx} ${e.ry} 0 0 0 ${cx + e.rx} ${e.y}`;
    const top = at(0), bot = at(1);
    const lip = Math.max(3, Wt * 0.055);
    // sides run straight down, then turn into the bottom with a soft round corner (no ring)
    const rc = Hb * 0.07, k8 = 0.86, ky = Math.sqrt(1 - k8 * k8);
    const wall = (half, sweep) => {
      const dir = sweep ? 1 : -1;             // front: corners curve under, back: they curve over
      const yE = bot.y + dir * bot.ry * ky;
      return `${half(top)} L ${cx + bot.rx} ${bot.y - rc}`
        + ` Q ${cx + bot.rx} ${bot.y + dir * bot.ry * 0.3} ${cx + bot.rx * k8} ${yE}`
        + ` A ${bot.rx} ${bot.ry} 0 0 ${sweep} ${cx - bot.rx * k8} ${yE}`
        + ` Q ${cx - bot.rx} ${bot.y + dir * bot.ry * 0.3} ${cx - bot.rx} ${bot.y - rc} Z`;
    };
    const op = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none"><defs>`;
    // thicker glass on the silhouette (it reads as a cylinder), clearer in the middle
    s += `<linearGradient id="milk" x1="0" y1="0" x2="1" y2="0">${op([[0, '#fff', .96], [.07, '#fff', .82], [.3, '#fff', .62], [.52, '#fff', .55], [.78, '#fff', .64], [.94, '#fff', .84], [1, '#fff', .96]])}</linearGradient>`;
    s += `<linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">${op([[0, '#6f7889', .46], [.05, '#6f7889', .14], [.2, '#6f7889', 0], [.8, '#6f7889', 0], [.95, '#6f7889', .14], [1, '#6f7889', .46]])}</linearGradient>`;
    s += `<linearGradient id="foot" x1="0" y1="0" x2="0" y2="1">${op([[0, '#fff', 0], [.78, '#fff', 0], [1, '#fff', .3]])}</linearGradient>`;
    s += `<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">${op([[.1, '#fff', 0], [.18, '#fff', .75], [.27, '#fff', 0], [.86, '#fff', 0], [.9, '#fff', .55], [.94, '#fff', 0]])}</linearGradient>`;
    s += `<linearGradient id="tint" x1="0" y1="0" x2="0" y2="1">${op([[0, '#eef1f6', .0], [1, '#c9d0db', .22]])}</linearGradient>`;
    s += `<linearGradient id="rimband" x1="0" y1="${(top.y - top.ry) / H}" x2="0" y2="${(top.y + top.ry + Hb * 0.12) / H}">${op([[0, '#fff', 0], [.45, '#fff', .32], [1, '#fff', 0]])}</linearGradient>`;
    s += `<linearGradient id="hollow" x1="0" y1="${(top.y - top.ry) / H}" x2="0" y2="${(top.y + top.ry * 2.2) / H}">${op([[0, '#5d6677', .16], [1, '#5d6677', 0]])}</linearGradient>`;
    s += `<clipPath id="body"><path d="${wall(front, 1)}"/></clipPath></defs>`;
    if (layer === 'mask') {
      s += `<path d="${wall(front, 1)}" fill="#fff" stroke="#fff" stroke-width="${Math.max(3, lip * 0.8)}" stroke-linejoin="round"/>`;
    } else if (layer === 'back') {
      // the far wall, seen from inside through the opening
      s += `<path d="${wall(back, 0)}" fill="#fff" fill-opacity=".34"/>`;
      s += `<path d="${wall(back, 0)}" fill="url(#edge)" opacity=".7"/>`;
      // a soft shade just under the far rim: the opening reads as a hollow
      s += `<path d="${wall(back, 0)}" fill="url(#hollow)"/>`;
      s += `<ellipse cx="${cx}" cy="${bot.y}" rx="${bot.rx}" ry="${bot.ry}" fill="#fff" fill-opacity=".4"/>`;
      // far edge of the glass: a thin bright cut, its thickness a hairline lower
      s += `<path d="${back(top)}" stroke="#fff" stroke-opacity=".55" stroke-width="${Math.max(1.2, lip * 0.4)}" stroke-linecap="round"/>`;
    } else {
      s += `<path d="${wall(front, 1)}" fill="url(#milk)"/>`;
      s += `<path d="${wall(front, 1)}" fill="url(#tint)"/>`;
      s += `<path d="${wall(front, 1)}" fill="url(#edge)"/>`;
      s += `<path d="${wall(front, 1)}" fill="url(#foot)"/>`;
      s += `<rect width="${W}" height="${H}" fill="url(#shine)" clip-path="url(#body)"/>`;
      // the glass wall ends in its own cut edge: a little denser near the top, a thin bright line, its thickness just under it
      s += `<path d="${front(top)}" stroke="#fff" stroke-opacity=".6" stroke-width="${Math.max(1.2, lip * 0.4)}" stroke-linecap="round"/>`;
    }
    return { svg: s + '</svg>', W, H, cx, ty, by };
  }

  function binSVG(layer, g) {
    if (g.theme === 'glass') return glassSVG(layer, g);
    const T = BIN_THEMES[g.theme] || BIN_THEMES.light;
    const { Wt, Wb, Hb, ryT, ryB, pad } = g;
    const W = Wt + pad * 2, H = Hb + ryT + ryB + pad * 2;
    const cx = W / 2, ty = pad + ryT, by = ty + Hb;
    const at = (f) => ({ y: lerp(ty, by, f), rx: lerp(Wt / 2, Wb / 2, f), ry: lerp(ryT, ryB, f) });
    // half ellipses, left to right: back goes over the top, front under the bottom
    const back = (e) => `M ${cx - e.rx} ${e.y} A ${e.rx} ${e.ry} 0 0 1 ${cx + e.rx} ${e.y}`;
    const front = (e) => `M ${cx - e.rx} ${e.y} A ${e.rx} ${e.ry} 0 0 0 ${cx + e.rx} ${e.y}`;
    const top = at(0), bot = at(1);
    const rimW = Math.max(3, Wt * 0.05);
    const rows = 8, cols = 14;

    // slots follow the cylinder: squeezed near the edges, curved along the rows
    const slots = (backSide) => {
      let s = '';
      for (let r = 0; r < rows; r++) {
        const f = lerp(0.14, 0.86, r / (rows - 1));
        const e = at(f);
        const sh = (Hb * 0.72 / rows) * 0.64;
        for (let c = 0; c < cols; c++) {
          const a = ((c + (r % 2 ? 0.5 : 0.0) + 0.25) / cols) * Math.PI + (backSide ? Math.PI : 0);
          const k = Math.abs(Math.sin(a));
          if (k < 0.2) continue;
          const sw = (Math.PI * e.rx / cols) * 0.4 * k;
          const x = cx + Math.cos(a) * e.rx, y = e.y + Math.sin(a) * e.ry;
          s += `<rect x="${(x - sw / 2).toFixed(2)}" y="${(y - sh / 2).toFixed(2)}" width="${sw.toFixed(2)}" height="${sh.toFixed(2)}" rx="${(Math.min(sw, sh) / 2).toFixed(2)}"/>`;
        }
      }
      return s;
    };

    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">`;
    // black anodised steel: deep body, a broad soft sheen, glints on both silhouettes
    s += `<defs>
      <linearGradient id="metal" x1="0" y1="0" x2="1" y2="0">${stops(T.metal)}</linearGradient>
      <linearGradient id="rim" x1="0" y1="0" x2="1" y2="0">${stops(T.rim)}</linearGradient>
      <linearGradient id="inner" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.inner[0]}"/><stop offset="1" stop-color="${T.inner[1]}"/></linearGradient>
      <linearGradient id="innerSide" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#000" stop-opacity="${T.innerSide}"/><stop offset=".3" stop-color="#000" stop-opacity="0"/>
        <stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${T.innerSide}"/>
      </linearGradient>
      <linearGradient id="spec" x1="0" y1="0" x2="1" y2="0">
        <stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset=".36" stop-color="#fff" stop-opacity="${T.spec}"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".7" stop-color="#000" stop-opacity="${T.fade * 0.3}"/><stop offset="1" stop-color="#000" stop-opacity="${T.fade}"/>
      </linearGradient>
      <filter id="brush" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="1.1 0.012" numOctaves="2" seed="4"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.8 0 0 0 -0.75"/>
      </filter>
      <filter id="brushDark" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.7 0.02" numOctaves="2" seed="11"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.8 0 0 0 -0.7"/>
      </filter>`;
    const wall = (half, bottomSweep) => `${half(top)} L ${cx + bot.rx} ${bot.y} A ${bot.rx} ${bot.ry} 0 0 ${bottomSweep} ${cx - bot.rx} ${bot.y} Z`;
    const rimPath = (half, shift) => `<path d="${half(top)}" stroke="#000" stroke-opacity="${T.rimShadow}" stroke-width="${rimW * 1.1}" stroke-linecap="round" transform="translate(0 ${rimW * shift})"/>`
      + `<path d="${half(top)}" stroke="url(#rim)" stroke-width="${rimW}" stroke-linecap="round"/>`;
    if (layer === 'back') {
      s += `<clipPath id="inwall"><path d="${wall(back, 0)}"/></clipPath></defs>`;
      // the inside of the far wall; its holes show the room behind, a touch lighter
      s += `<path d="${wall(back, 0)}" fill="url(#inner)"/>`;
      if (T.brush) s += `<rect width="${W}" height="${H}" filter="url(#brush)" opacity="${T.brush * 0.45}" clip-path="url(#inwall)"/>`;
      s += `<g fill="${T.backHoles[0]}" fill-opacity="${T.backHoles[1]}">${slots(true)}</g>`;
      s += `<path d="${wall(back, 0)}" fill="url(#innerSide)"/>`;
      s += `<ellipse cx="${cx}" cy="${bot.y}" rx="${bot.rx}" ry="${bot.ry}" fill="${T.floorIn}"/>`;
      s += rimPath(back, 0.55);
      s += `<path d="${back(top)}" stroke="#fff" stroke-opacity="${T.backRimLight}" stroke-width=".6" transform="translate(0 ${-rimW * 0.32})"/>`;
    } else {
      s += `<mask id="holes" maskUnits="userSpaceOnUse"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${slots(false)}</g></mask>`;
      s += `<clipPath id="body"><path d="${wall(front, 1)}"/></clipPath></defs>`;
      s += `<g mask="url(#holes)">`;
      s += `<path d="${wall(front, 1)}" fill="url(#metal)"/>`;
      // brushed grain: light and dark streaks, very low contrast
      if (T.brush) s += `<rect width="${W}" height="${H}" filter="url(#brush)" opacity="${T.brush}" clip-path="url(#body)"/>`;
      if (T.brushDark) s += `<rect width="${W}" height="${H}" filter="url(#brushDark)" opacity="${T.brushDark}" clip-path="url(#body)"/>`;
      s += `<rect width="${W}" height="${H}" fill="url(#spec)" clip-path="url(#body)"/>`;
      s += `<path d="${wall(front, 1)}" fill="url(#fade)"/>`;
      s += `</g>`;
      // the lower lip of each hole catches a little light: it gives the steel its thickness
      s += `<g fill="none" stroke="${T.lip[0]}" stroke-opacity="${T.lip[1]}" stroke-width=".5" clip-path="url(#body)" transform="translate(0 ${T.lip[2]})">${slots(false)}</g>`;
      // base ring
      const b0 = at(1 - Math.max(6, Hb * 0.05) / Hb);
      s += `<path d="${front(b0)} L ${cx + bot.rx} ${bot.y} A ${bot.rx} ${bot.ry} 0 0 1 ${cx - bot.rx} ${bot.y} Z" fill="${T.base}"/>`;
      s += `<path d="${front(b0)}" stroke="${T.baseLine[0]}" stroke-opacity="${T.baseLine[1]}" stroke-width=".6"/>`;
      // rolled rim with one crisp highlight
      s += rimPath(front, 0.75);
      s += `<path d="${front(top)}" stroke="#fff" stroke-opacity="${T.rimLight}" stroke-width=".6" transform="translate(0 ${-rimW * 0.32})"/>`;
    }
    return { svg: s + '</svg>', W, H, cx, ty, by };
  }

  /* -------------------------------------------------------------- engine */
  const DEFAULTS = {
    container: null,       // defaults to document.body
    zIndex: 1000,
    sound: true,
    assist: 0.5,           // 0..1, how much a near miss gets bent toward the bin
    gravity: null,         // px/s², defaults to 3.3 x viewport height
    ballSize: null,        // ball radius in px when held, defaults to a size based on the viewport
    binTheme: 'glass',     // 'glass' (frosted), 'light' (white steel) or 'dark' (black steel)
    binDepth: 0.5,         // apparent size of the bin at the back (1 = on the screen plane)
    crumpleTime: 0.72,     // seconds
    paperBack: null,       // [r,g,b] 0..1 for the back of the sheet, defaults to the element background
    shadow: { y: 26, blur: 46, alpha: 0.16, radius: 18 },
    stage: { color: 'rgba(255,255,255,.6)', blur: 22 }, // backdrop while throwing, or false
    snapshot: null,        // (el, scale) => Promise<HTMLCanvasElement>
    reducedMotion: 'auto', // true, false or 'auto'
  };

  class Toss {
    constructor(opts = {}) {
      this.o = Object.assign({}, DEFAULTS, opts);
      this.o.shadow = Object.assign({}, DEFAULTS.shadow, opts.shadow || {});
      this.listeners = {};
      this.balls = [];
      this.cache = new Map();
      this.sfx = new Sfx();
      this.sfx.enabled = !!this.o.sound;
      this.pointer = null;
      this.time = 0;
      // show: 0..1 fade of the stage and the bin, ang: wobble
      this.bin = { show: 0, target: 0, ang: 0, angV: 0, hideAt: 0, tex: null };
      this.reduced = this.o.reducedMotion === 'auto'
        ? !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)
        : !!this.o.reducedMotion;
      this._mount();
      this._bind();
      this._last = now();
      this._raf = requestAnimationFrame(this._frame);
    }

    /* ---------- public api */
    on(name, fn) { (this.listeners[name] ||= []).push(fn); return () => this.off(name, fn); }
    off(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn); }
    emit(name, ...a) { (this.listeners[name] || []).forEach((f) => f(...a)); const cb = this.o['on' + name[0].toUpperCase() + name.slice(1)]; if (cb) cb(...a); }
    setSound(on) { this.sfx.enabled = !!on; if (!on && this.sfx.ctx) this.sfx.ctx.suspend(); }
    setAssist(v) { this.o.assist = clamp(+v || 0, 0, 1); }

    /** Capture an element ahead of time so the crumple starts instantly. */
    prepare(el) {
      const job = this._capture(el);
      this.cache.set(el, job);
      return job;
    }

    /** Start crumpling `el` under the pointer of `event` (a pointerdown). */
    grab(el, event) {
      if (this.reduced) return this._fadeAway(el);
      this.sfx.ensure();
      const p = { id: event.pointerId, x: event.clientX, y: event.clientY, samples: [], down: now() };
      p.samples.push({ x: p.x, y: p.y, t: p.down });
      this.pointer = p;
      return this._spawn(el, { held: true });
    }

    /** Keyboard path: crumple in place and make a perfect shot. */
    throwInto(el) {
      if (this.reduced) return this._fadeAway(el);
      this.sfx.ensure();
      return this._spawn(el, { auto: true });
    }

    /** Undo: a ball in the bin flies back and unfolds into its element. */
    restore(ball) {
      ball = ball || [...this.balls].reverse().find((b) => b.state === 'bin');
      if (!ball || !this.balls.includes(ball) || ball.state !== 'bin') return Promise.resolve(false);
      if (this.reduced) { ball.el.style.visibility = ''; this._remove(ball); return Promise.resolve(true); }
      ball.el.style.visibility = 'hidden';
      this._showBin();
      return new Promise((res) => {
        const r = ball.el.getBoundingClientRect();
        const wait = this.bin.show < 0.6 ? 0.45 : 0;
        Object.assign(ball, {
          state: 'flyback', done: res,
          fly: { t: -wait, a: [ball.X, ball.Y, ball.Z], b: [r.left + r.width / 2, r.top + r.height / 2, 0], q0: ball.q.slice() },
        });
        this.emit('restore', ball);
      });
    }

    /** Take a ball out of the bin without any animation (a quiet undo). */
    discard(ball) {
      if (ball && this.balls.includes(ball)) this._remove(ball);
    }

    /** Remove every ball and hide the bin. */
    clear() {
      for (const b of [...this.balls]) { if (b.el && b.state !== 'bin') b.el.style.visibility = ''; this._remove(b); }
      this.bin.target = 0; this.bin.hideAt = 0;
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this._unbind();
      this.clear();
      this.root.remove();
      if (this.sfx.ctx) this.sfx.ctx.close();
    }

    /* ---------- setup */
    _mount() {
      const root = (this.root = document.createElement('div'));
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${this.o.zIndex};`;
      if (this.o.stage) {
        const st = (this.stageEl = document.createElement('div'));
        const blur = this.o.stage.blur ? `backdrop-filter:blur(${this.o.stage.blur}px);-webkit-backdrop-filter:blur(${this.o.stage.blur}px);` : '';
        st.style.cssText = `position:absolute;inset:0;opacity:0;background:${this.o.stage.color};${blur}`;
        root.appendChild(st);
      }
      const c = (this.canvas = document.createElement('canvas'));
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      root.appendChild(c);
      (this.o.container || document.body).appendChild(root);
      const gl = (this.gl = c.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true }));
      if (!gl) { this.noGL = true; return; }
      const prog = (vs, fs) => {
        const p = gl.createProgram();
        for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
          const s = gl.createShader(type);
          gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Crumple shader: ' + gl.getShaderInfoLog(s));
          gl.attachShader(p, s);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Crumple link: ' + gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
        return { p, u };
      };
      this.pBall = prog(BALL_VS, BALL_FS);
      this.pTex = prog(QUAD_VS, TEX_FS);
      this.pShadow = prog(QUAD_VS, SHADOW_FS);
      this.pGlass = prog(QUAD_VS, GLASS_FS);
      this.quad = gl.createVertexArray();
      gl.bindVertexArray(this.quad);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.meshes = new Map();
      this.rot = new Float32Array(9);
      this.shadeColor = this.o.binTheme === 'dark' ? [0.02, 0.02, 0.03] : [0.08, 0.1, 0.16];
      this._resize();
    }

    _bind() {
      this._frame = this._frame.bind(this);
      this._onDown = (e) => this._pointerDown(e);
      this._onMove = (e) => this._pointerMove(e);
      this._onUp = (e) => this._pointerUp(e);
      this._onResize = () => this._resize();
      window.addEventListener('pointerdown', this._onDown, true);
      window.addEventListener('pointermove', this._onMove, { passive: true });
      window.addEventListener('pointerup', this._onUp);
      window.addEventListener('pointercancel', this._onUp);
      window.addEventListener('resize', this._onResize);
    }
    _unbind() {
      window.removeEventListener('pointerdown', this._onDown, true);
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointercancel', this._onUp);
      window.removeEventListener('resize', this._onResize);
    }

    /* ---------- the scene: a floor, a camera, a bin at the back */
    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.W = window.innerWidth; this.H = window.innerHeight; this.dpr = dpr;
      if (!this.gl) return;
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      if (this.o.binTheme === 'glass') this._target(this.canvas.width, this.canvas.height);
      this.ballR = this.o.ballSize || clamp(Math.min(this.W, this.H) * 0.042, 24, 40);
      this.g = this.o.gravity || clamp(this.H * 3.3, 2000, 3600);
      // camera: vanishing point high on the screen, the floor meets the bottom edge at depth 0
      const F = this.H * 1.15;
      const kB = clamp(this.o.binDepth, 0.25, 0.9);
      const R = this.ballR * 2.5;
      this.cam = { vx: this.W / 2, vy: this.H * 0.02, F };   // a high vanishing point puts the bin further up the screen
      this.floor = this.H - 4;
      this.B = { X: this.W / 2, Z: F * (1 / kB - 1), R, Rb: R * 0.84, Hb: R * 2.35, k: kB };
      this.B.top = this.floor - this.B.Hb;
      // a back wall just behind the bin: a long throw drops behind it instead of vanishing into the distance
      this.zMax = this.B.Z + R * 3.2;
      this._paintStage();
      // the bin is always at the same spot: balls already inside would be misplaced
      for (const b of [...this.balls]) if (b.state === 'bin') this._remove(b);
      this._buildBin();
    }

    _paintStage() {
      if (this.stageEl) this.stageEl.style.background = this.o.stage.color;
    }

    // offscreen colour + depth, for the balls seen through the frosted glass
    _target(w, h) {
      const gl = this.gl;
      if (this.fbo) { gl.deleteFramebuffer(this.fbo.fb); gl.deleteTexture(this.fbo.tex); gl.deleteRenderbuffer(this.fbo.rb); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fbo = { fb, tex, rb };
    }

    proj(X, Y, Z) {
      const c = this.cam, k = c.F / (c.F + Math.max(Z, -c.F * 0.5));
      return { x: c.vx + (X - c.vx) * k, y: c.vy + (Y - c.vy) * k, k };
    }

    _buildBin() {
      const gl = this.gl, dpr = this.dpr, B = this.B;
      // true perspective of the two rings: their near and far points
      const ry = (Y, R) => (this.proj(B.X, Y, B.Z - R).y - this.proj(B.X, Y, B.Z + R).y) / 2;
      const k = B.k;
      const geo = { Wt: B.R * 2 * k, Wb: B.Rb * 2 * k, Hb: B.Hb * k, ryT: ry(B.top, B.R), ryB: ry(this.floor, B.Rb), pad: 8, theme: this.o.binTheme };
      geo.pad = Math.ceil(Math.max(3, geo.Wt * 0.05) * 1.6 + 4);
      this.binGeo = geo;
      const make = (layer) => new Promise((res) => {
        const b = binSVG(layer, geo);
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = Math.ceil(b.W * dpr); c.height = Math.ceil(b.H * dpr);
          const x = c.getContext('2d'); x.scale(dpr, dpr); x.drawImage(img, 0, 0, b.W, b.H);
          res({ tex: this._texture(c, false), info: b });
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(b.svg);
      });
      const layers = this.o.binTheme === 'glass' ? ['back', 'front', 'mask'] : ['back', 'front'];
      Promise.all(layers.map(make)).then(([back, front, mask]) => {
        if (this.bin.tex) for (const l of Object.values(this.bin.tex)) gl.deleteTexture(l.tex);
        this.bin.tex = mask ? { back, front, mask } : { back, front };
      });
    }

    _texture(canvas, mip) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !mip);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (mip) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      return t;
    }

    _mesh(nx, ny) {
      const key = nx + 'x' + ny;
      if (this.meshes.has(key)) return this.meshes.get(key);
      const gl = this.gl;
      const v = new Float32Array((nx + 1) * (ny + 1) * 2);
      let k = 0;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { v[k++] = i / nx; v[k++] = j / ny; }
      const idx = new Uint32Array(nx * ny * 6);
      k = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const m = { vao, count: idx.length, nx, ny };
      this.meshes.set(key, m);
      return m;
    }

    async _capture(el) {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      let canvas;
      if (this.o.snapshot) canvas = await this.o.snapshot(el, scale);
      else if (window.modernScreenshot) canvas = await window.modernScreenshot.domToCanvas(el, { scale, backgroundColor: null, style: { animation: 'none', transition: 'none', opacity: '1', visibility: 'visible' } });
      else throw new Error('Crumple: no snapshot function. Load modern-screenshot or pass options.snapshot.');
      return canvas;
    }

    /* ---------- balls */
    async _spawn(el, mode) {
      if (this.noGL) return this._fadeAway(el);
      const rect = el.getBoundingClientRect();
      let job = this.cache.get(el);
      if (!job) job = this.prepare(el);
      let canvas;
      try { canvas = await job; } catch (err) { console.warn(err); return this._fadeAway(el); }
      this.cache.delete(el);
      const w = rect.width, h = rect.height;
      const nx = 128, ny = clamp(Math.round(128 * h / w), 40, 180);
      const D0 = Math.sqrt((w / 2) * (h / 2));
      const Rb = D0 / Math.PI;
      const cs = getComputedStyle(el);
      const back = this.o.paperBack || parseColor(cs.backgroundColor, [0.96, 0.96, 0.95]).map((c) => c * 0.94);
      const radius = parseFloat(cs.borderTopLeftRadius) || this.o.shadow.radius;
      const cx = rect.left + w / 2, cy = rect.top + h / 2;
      const ball = {
        el, w, h, Rb, back, radius,
        tex: this._texture(canvas, true),
        mesh: this._mesh(nx, ny),
        seed: Math.random() * 40,
        t: 0, tDir: 1,
        sFinal: this.ballR / (Rb * 1.08),
        x0: cx, y0: cy,
        X: cx, Y: cy, Z: 0, vX: 0, vY: 0, vZ: 0, sx: cx, sy: cy, k: 1,
        r: this.ballR, q: qId(), w3: [0, 0, 0],
        state: mode.held ? 'held' : 'crumple',
        auto: !!mode.auto, lift: 0, floorShadow: 0, born: this.time,
        rest: 0, missed: false, layer: 'front',
      };
      ball.w3 = [(Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 1.6];
      this.balls.push(ball);
      this._pendingHide = ball;
      this.sfx.crumple(this.o.crumpleTime * 1.05);
      this._showBin();
      this.emit('crumple', ball);
      return ball;
    }

    _remove(ball) {
      const i = this.balls.indexOf(ball);
      if (i >= 0) this.balls.splice(i, 1);
      if (ball.tex && this.gl) this.gl.deleteTexture(ball.tex);
      ball.tex = null;
    }

    _fadeAway(el) {
      el.style.transition = 'opacity .2s ease';
      el.style.opacity = '0';
      setTimeout(() => { el.style.visibility = 'hidden'; el.style.opacity = ''; el.style.transition = ''; this.emit('score', { el, state: 'bin' }); }, 220);
      return Promise.resolve(null);
    }

    _showBin() { this.bin.target = 1; this.bin.hideAt = 0; }

    /* ---------- pointer */
    _hit(x, y) {
      for (let i = this.balls.length - 1; i >= 0; i--) {
        const b = this.balls[i];
        if (!['hover', 'free'].includes(b.state)) continue;
        if (Math.hypot(b.sx - x, b.sy - y) < Math.max(b.r * b.k * 1.6, 22)) return b;
      }
      return null;
    }
    _pointerDown(e) {
      if (this.pointer) return;
      const b = this._hit(e.clientX, e.clientY);
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      this.sfx.ensure();
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, samples: [{ x: e.clientX, y: e.clientY, t: now() }], down: now() };
      b.state = 'held'; b.missed = false; b.rest = 0; b.auto = false;
      b.x0 = b.sx; b.y0 = b.sy; b.hvx = 0; b.hvy = 0;
      this.sfx.tap(300);
      this._showBin();
      this.emit('pickup', b);
    }
    _pointerMove(e) {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        p.x = ev.clientX; p.y = ev.clientY;
        p.samples.push({ x: p.x, y: p.y, t: (ev.timeStamp || performance.now()) / 1000 });
      }
      const cut = now() - 0.12;
      while (p.samples.length > 3 && p.samples[0].t < cut) p.samples.shift();
    }
    _pointerUp(e) {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      this.pointer = null;
      const ball = this.balls.find((b) => b.state === 'held');
      if (!ball) return;
      // release velocity from the last ~80 ms of movement
      const t1 = now(), s = p.samples.filter((q) => q.t > t1 - 0.085);
      let vx = 0, vy = 0;
      if (s.length >= 2) {
        const a = s[0], b = s[s.length - 1], dt = Math.max(b.t - a.t, 0.008);
        vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt;
      }
      const sp = Math.hypot(vx, vy), max = 5200;
      if (sp > max) { vx *= max / sp; vy *= max / sp; }
      if (sp < 160) {
        // a plain click: the ball waits in the air to be thrown
        ball.state = 'hover'; ball.hx = ball.X; ball.hy = ball.Y; ball.Z = 0; ball.vX = ball.vY = ball.vZ = 0;
        this.emit('hover', ball);
        return;
      }
      this._launch(ball, vx, vy);
      ball.throwAt = this.time;
      if (sp > 500) this.sfx.whoosh(sp);
      this.emit('throw', ball, { vx, vy });
    }

    // A flick on the glass becomes a throw into the room: up = forward.
    _launch(b, vx, vy) {
      const B = this.B;
      // power 1 = a medium flick, tuned so it lands right in the bin
      const up = Math.max(0, -vy);
      // power is forgiving near the sweet spot, then honest: a lob falls short, a rocket flies over
      const p0 = up / (this.H * 1.6), d = p0 - 1, ad = Math.abs(d);
      const p = Math.max(0, 1 + Math.sign(d) * (ad < 0.6 ? ad * 0.35 : 0.21 + (ad - 0.6)));
      const T0 = 0.92;            // a high lob, so it drops into the bin instead of skimming the rim
      const vZ0 = (B.Z - b.Z) / T0 * 1.06;   // makes up for air drag
      const vY0 = (B.top - b.r * 0.3 - b.Y - 0.5 * this.g * T0 * T0) / T0;
      b.vZ = vZ0 * p;
      b.vY = Math.min(vY0, 0) * p + Math.max(vy, 0) * 0.5;
      // aim: follow the flick on screen up to the rim, and fly to that spot
      const binY = this.proj(B.X, B.top, B.Z).y;
      if (up > 60 && b.vZ > 1) {
        const dyS = Math.max(60, b.sy - binY);
        const xt = b.sx + (vx / up) * dyS;
        const T = clamp((B.Z - b.Z) / b.vZ, 0.15, 2.5);
        const Xat = this.cam.vx + (xt - this.cam.vx) / B.k;
        b.vX = (Xat - b.X) / T;
      } else b.vX = vx * 0.8;
      b.state = 'free';
      b.w3 = [-b.vZ / b.r * 0.25 + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, b.vX / b.r * 0.3 + (Math.random() - 0.5) * 2];
    }

    /* ---------- simulation */
    _step(dt) {
      const bin = this.bin;
      if (bin.hideAt && this.time >= bin.hideAt) { bin.target = 0; bin.hideAt = 0; }
      // fade the stage and the bin in or out
      const speed = bin.target > bin.show ? 2.4 : 2.0;
      bin.show = clamp(bin.show + Math.sign(bin.target - bin.show) * dt * speed, 0, 1);
      if (Math.abs(bin.target - bin.show) < 0.01) bin.show = bin.target;
      bin.angV += (-420 * bin.ang - 9 * bin.angV) * dt;
      bin.ang += bin.angV * dt;

      const p = this.pointer;
      const sub = 4, h = dt / sub;
      for (const b of this.balls) {
        if (b.tDir > 0 && b.t < 1) b.t = Math.min(1, b.t + dt / this.o.crumpleTime);
        b.q = qSpin(b.q, b.w3, dt);

        if (b.state === 'held' || b.state === 'crumple') {
          const e = easeOut(b.t);
          if (b.state === 'held' && p) {
            // follow the pointer on the glass, fast but with a little weight
            const tx = lerp(b.x0, p.x, e), ty = lerp(b.y0, p.y, e);
            // critically damped spring, sub-stepped so it stays stable at 30 fps
            const w = 34, n = 6, hs = dt / n;
            let sx = b.sx, sy = b.sy, vx = b.hvx || 0, vy = b.hvy || 0;
            for (let i = 0; i < n; i++) {
              vx += (w * w * (tx - sx) - 2 * w * vx) * hs; vy += (w * w * (ty - sy) - 2 * w * vy) * hs;
              sx += vx * hs; sy += vy * hs;
            }
            b.hvx = vx; b.hvy = vy;
            b.Z *= Math.exp(-dt * 12);                 // a ball picked up far away comes back to the glass
            if (b.Z < 0.5) b.Z = 0;
            const k = this.cam.F / (this.cam.F + b.Z);
            b.X = this.cam.vx + (sx - this.cam.vx) / k; b.Y = this.cam.vy + (sy - this.cam.vy) / k;
            b.w3[2] = lerp(b.w3[2], b.hvx / b.r * 0.5, 0.1);
            b.w3[0] = lerp(b.w3[0], -b.hvy / b.r * 0.25, 0.1);
            b.w3[1] = lerp(b.w3[1], 0, 0.05);
          } else if (b.state === 'crumple' && b.auto && b.t >= 0.86) this._autoShot(b);
          b.lift = Math.min(1, b.lift + dt * 4);
          continue;
        }
        if (b.state === 'hover') {
          b.X = lerp(b.X, b.hx, 0.2);
          b.Y = lerp(b.Y, b.hy + Math.sin((this.time - b.born) * 2.4) * 5, 0.2);
          b.w3 = [0.25, 0.4, 0.15];
          continue;
        }
        if (b.state === 'flyback') { this._flyback(b, dt); continue; }
        b.lift = Math.max(0, b.lift - dt * 6);
        for (let s = 0; s < sub; s++) this._integrate(b, h);
      }
      this._collideBalls();

      // auto-hide once nothing is in play
      const busy = this.balls.some((b) => ['held', 'crumple', 'hover', 'free', 'flyback'].includes(b.state));
      if (bin.target === 1 && !busy && !bin.hideAt) bin.hideAt = this.time + 0.9;
      if (busy && bin.hideAt) bin.hideAt = 0;
      if (bin.show === 0) {
        const inBin = this.balls.filter((b) => b.state === 'bin');
        while (inBin.length > 6) this._remove(inBin.shift());
      }
    }

    _integrate(b, h) {
      const B = this.B, g = this.g, r = b.r;
      const inBin = b.state === 'bin';
      b.vY += g * h;
      const drag = b.auto ? 0 : 0.12;
      const fd = Math.exp(-drag * h);
      b.vX *= fd; b.vY *= fd; b.vZ *= fd;

      if (!inBin && !b.auto && this.o.assist > 0 && b.vZ > 50) this._assist(b, h);

      b.X += b.vX * h; b.Y += b.vY * h; b.Z += b.vZ * h;

      // floor
      if (b.Y + r > this.floor) {
        const vin = b.vY;
        b.Y = this.floor - r;
        if (b.vY > 0) {
          b.vY = -b.vY * 0.34;
          b.vX *= 0.8; b.vZ *= 0.8;
          if (vin > 260) { inBin ? this.sfx.land(vin * 0.6) : this.sfx.tap(vin * this.proj(b.X, b.Y, b.Z).k); }
          if (Math.abs(b.vY) < 60) b.vY = 0;
        }
        const f = Math.exp(-2.6 * h);
        b.vX *= f; b.vZ *= f;
        b.w3 = [b.vZ / r, b.w3[1] * 0.9, b.vX / r];
      }
      // the room: glass in front, a far wall, and side walls at the edges of the view
      if (b.Z < 0) { b.Z = 0; if (b.vZ < 0) b.vZ = -b.vZ * 0.4; }
      if (b.Z > this.zMax) { b.Z = this.zMax; if (b.vZ > 0) { b.vZ = -b.vZ * 0.4; this.sfx.tap(Math.abs(b.vZ) * 0.4); } }
      const k = this.cam.F / (this.cam.F + b.Z), half = (this.W / 2) / k - r;
      if (b.X < this.cam.vx - half) { b.X = this.cam.vx - half; if (b.vX < 0) b.vX = -b.vX * 0.45; }
      if (b.X > this.cam.vx + half) { b.X = this.cam.vx + half; if (b.vX > 0) b.vX = -b.vX * 0.45; }

      if (this.bin.show > 0.5 || inBin) this._binCollide(b, inBin);

      if (!inBin && b.state === 'free') {
        const dh = Math.hypot(b.X - B.X, b.Z - B.Z);
        if (b.Y > B.top + r * 0.4 && dh < B.R - r * 0.25) {
          b.state = 'bin';
          b.auto = false;
          this.sfx.land(Math.hypot(b.vX, b.vY, b.vZ));
          this.bin.angV += clamp(b.vX * 0.0012, -1.2, 1.2) + (Math.random() - 0.5) * 0.6;
          if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) try { navigator.vibrate(12); } catch (_) {}
          this.emit('score', b);
        } else if (b.Y + r >= this.floor - 1 && Math.hypot(b.vX, b.vY, b.vZ) < 40) {
          b.rest += h;
          if (b.rest > 0.35 && !b.missed) { b.missed = true; this.emit('miss', b); }
        } else b.rest = 0;
      }
    }

    // bend a near miss toward the bin: aim (sideways) and power (depth)
    _assist(b, h) {
      const B = this.B, g = this.g, a = this.o.assist;
      const tau = (B.Z - b.Z) / b.vZ;
      if (tau > 0.04) {
        const err = B.X - (b.X + b.vX * tau);
        if (Math.abs(err) < B.R * 2.2) b.vX += a * 1.6 * err / tau * h;
      }
      // where will it cross the rim height on the way down?
      const dy = B.top - b.Y, A = 0.5 * g;
      const disc = b.vY * b.vY + 4 * A * dy;
      if (disc > 0) {
        const tr = (-b.vY + Math.sqrt(disc)) / (2 * A);
        if (tr > 0.04) {
          const errZ = B.Z - (b.Z + b.vZ * tr);
          if (Math.abs(errZ) < B.R * 3) b.vZ += a * 2.6 * errZ / tr * h;
        }
      }
    }

    _binCollide(b, inBin) {
      const B = this.B, r = b.r;
      const dx = b.X - B.X, dz = b.Z - B.Z;
      const dh = Math.hypot(dx, dz) || 1e-6;
      const ux = dx / dh, uz = dz / dh;
      // rolled rim: a ring of radius R
      const px = B.X + ux * B.R, pz = B.Z + uz * B.R, py = B.top;
      let nx = b.X - px, ny = b.Y - py, nz = b.Z - pz;
      const d = Math.hypot(nx, ny, nz), min = r * 0.8 + 3;   // paper gives a little
      if (d < min && d > 1e-6) {
        nx /= d; ny /= d; nz /= d;
        b.X = px + nx * min; b.Y = py + ny * min; b.Z = pz + nz * min;
        const vn = b.vX * nx + b.vY * ny + b.vZ * nz;
        if (vn < 0) {
          b.vX -= 1.48 * vn * nx; b.vY -= 1.48 * vn * ny; b.vZ -= 1.48 * vn * nz;
          if (-vn > 140) { this.sfx.rim(-vn); this.bin.angV += clamp(-vn * nx * 0.0012, -0.9, 0.9); }
          b.w3 = [b.w3[0] + nz * 3, b.w3[1], b.w3[2] - nx * 3];
        }
      }
      // walls, below the rim
      if (b.Y > B.top) {
        const f = clamp((b.Y - B.top) / B.Hb, 0, 1);
        const Rw = lerp(B.R, B.Rb, f);
        const dh2 = Math.hypot(b.X - B.X, b.Z - B.Z) || 1e-6;
        const vr = (b.vX * ux + b.vZ * uz);
        if (inBin || dh2 < Rw) {
          if (dh2 > Rw - r) {
            b.X = B.X + ux * (Rw - r); b.Z = B.Z + uz * (Rw - r);
            if (vr > 0) { b.vX -= 1.3 * vr * ux; b.vZ -= 1.3 * vr * uz; if (vr > 200) this.sfx.tap(vr * 0.5); }
          }
        } else if (dh2 < Rw + r) {
          b.X = B.X + ux * (Rw + r); b.Z = B.Z + uz * (Rw + r);
          if (vr < 0) { b.vX -= 1.3 * vr * ux; b.vZ -= 1.3 * vr * uz; if (-vr > 200) { this.sfx.rim(-vr * 0.5); this.bin.angV += clamp(-vr * ux * 0.0008, -0.6, 0.6); } }
        }
      }
    }

    _collideBalls() {
      const L = this.balls.filter((b) => b.state === 'free' || b.state === 'bin');
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        let dx = b.X - a.X, dy = b.Y - a.Y, dz = b.Z - a.Z;
        const d = Math.hypot(dx, dy, dz), min = a.r + b.r;
        if (d >= min || d < 1e-6) continue;
        dx /= d; dy /= d; dz /= d;
        const push = (min - d) / 2;
        a.X -= dx * push; a.Y -= dy * push; a.Z -= dz * push;
        b.X += dx * push; b.Y += dy * push; b.Z += dz * push;
        const rv = (b.vX - a.vX) * dx + (b.vY - a.vY) * dy + (b.vZ - a.vZ) * dz;
        if (rv < 0) {
          const imp = -1.2 * rv / 2;
          a.vX -= imp * dx; a.vY -= imp * dy; a.vZ -= imp * dz;
          b.vX += imp * dx; b.vY += imp * dy; b.vZ += imp * dz;
        }
      }
    }

    _autoShot(b) {
      const B = this.B;
      const T = 0.92;
      b.vZ = (B.Z - b.Z) / T;
      b.vX = (B.X - b.X) / T;
      b.vY = (B.top - b.r * 0.5 - b.Y) / T - 0.5 * this.g * T;
      b.state = 'free';
      b.w3 = [-2, 1.5, b.vX / b.r * 0.3];
      this.sfx.whoosh(1800);
      this.emit('throw', b, { auto: true });
    }

    _flyback(b, dt) {
      const f = b.fly;
      f.t += dt;
      if (f.t < 0) return;
      const D = 0.66, U = 0.62;
      const s = clamp(f.t / D, 0, 1), e = easeInOut(s);
      b.X = lerp(f.a[0], f.b[0], e);
      b.Z = lerp(f.a[2], f.b[2], e);
      b.Y = lerp(f.a[1], f.b[1], e) - this.H * 0.28 * 4 * e * (1 - e);
      if (!f.sound) { f.sound = true; this.sfx.whoosh(1600); }
      const u = clamp((f.t - D * 0.55) / U, 0, 1);
      if (u > 0 && !f.unfold) { f.unfold = true; this.sfx.crumple(U * 0.9, 0.55); }
      b.tDir = -1;
      b.t = 1 - easeInOut(u);
      b.q = qLerp(f.q0, qId(), easeInOut(clamp(u * 1.15, 0, 1)));
      b.w3 = [0, 0, 0];
      b.lift = Math.min(1, b.lift + dt * 3);
      if (u >= 1) {
        b.el.style.visibility = '';
        this._remove(b);
        this.emit('restored', b);
        if (b.done) b.done(true);
      }
    }

    /* ---------- render */
    _frame() {
      this._raf = requestAnimationFrame(this._frame);
      const t = now();
      const dt = Math.min(t - this._last, 1 / 30);
      this._last = t;
      this.time += dt;
      if (this.noGL) return;
      this._step(dt);
      if (this.stageEl) this.stageEl.style.opacity = easeInOut(this.bin.show).toFixed(3);
      this._render();
      if (this._pendingHide) {
        // the mesh is on screen in this very frame: hide the real element now
        this._pendingHide.el.style.visibility = 'hidden';
        this._pendingHide = null;
      }
    }

    _render() {
      const gl = this.gl, B = this.B;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const stage = easeInOut(this.bin.show);
      // the bin arrives a beat after the room goes dark, and leaves first
      const show = easeOut(smooth(0.35, 1, this.bin.show));
      const binOn = show > 0.001 && this.bin.tex;
      void stage;

      // project every ball and sort it into: behind the bin, inside, in front
      for (const b of this.balls) {
        const P = this.proj(b.X, b.Y, b.Z);
        b.sx = P.x; b.sy = P.y; b.k = P.k;
        const dh = Math.hypot(b.X - B.X, b.Z - B.Z);
        if (b.state === 'bin' || ((b.state === 'free' || b.state === 'flyback') && dh < B.R && b.Y > B.top - b.r)) b.layer = 'inside';
        // anything deeper than the bin is drawn before it, whatever its side
        else if (b.Z > B.Z && b.state !== 'held') b.layer = 'behind';
        else b.layer = 'front';
      }
      const byDepth = (layer) => this.balls.filter((b) => b.layer === layer).sort((a, c) => c.Z - a.Z);

      // floor light and shadows
      if (binOn) {
        const P = this.proj(B.X, this.floor, B.Z);
        const g = this.binGeo;
        // a faint pool of light on the floor, then contact shadow and occlusion
        const dark = this.o.binTheme === 'dark';
        if (dark) this._shadow(P.x, P.y - g.ryB * 0.4, g.Wt * 3.4, g.ryB * 6, 0, 0, 0.06 * show, [1, 1, 1], true);
        this._shadow(P.x, P.y, g.Wb * 1.3, g.ryB * 2.2, 0, 0, (dark ? 0.5 : 0.16) * show, this.shadeColor, true);
        this._shadow(P.x, P.y, g.Wb * 0.62, g.ryB * 1.05, 0, 0, (dark ? 0.75 : 0.34) * show, this.shadeColor, true);
      }
      for (const b of this.balls) {
        if (b.layer === 'inside' || b.state === 'bin') continue;
        const hgt = this.floor - (b.Y + b.r);
        const vis = (b.state === 'free' ? 1 : 0) * clamp(1 - hgt / (this.H * 0.9), 0, 1);
        b.floorShadow = lerp(b.floorShadow, vis, 0.25);
        if (b.floorShadow > 0.01) {
          const P = this.proj(b.X, this.floor, b.Z);
          const ry = (this.proj(b.X, this.floor, b.Z - b.r).y - this.proj(b.X, this.floor, b.Z + b.r).y) / 2;
          const sp = 1 + hgt / 700, rx = b.r * P.k * 0.95 * sp, ryy = Math.max(rx * 0.24, ry * sp);
          // a soft contact shadow and a wider, fainter one
          this._shadow(P.x, P.y, rx * 1.5, ryy * 2.2, 0, 0, 0.22 * b.floorShadow, null, true);
          this._shadow(P.x, P.y, rx * 0.9, ryy * 1.2, 0, 0, 0.32 * b.floorShadow * clamp(1 - hgt / 160, 0, 1), null, true);
        }
      }

      for (const b of byDepth('behind')) this._ball(b, 1);
      if (binOn) this._binLayer(this.bin.tex.back, show);
      const inside = byDepth('inside');
      if (binOn && this.bin.tex.mask && this.fbo && inside.length) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        for (const b of inside) this._ball(b, b.state === 'bin' ? show : 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._glass(show);
      } else for (const b of inside) this._ball(b, b.state === 'bin' ? show : 1);
      if (binOn) this._binLayer(this.bin.tex.front, show);
      for (const b of byDepth('front')) { this._liftShadow(b); this._ball(b, 1); }
    }

    _binRect(info, show) {
      const B = this.B, base = this.proj(B.X, this.floor, B.Z);
      const rise = (1 - show) * 24, sc = lerp(0.9, 1, show);
      return { x: base.x - info.cx * sc, y: base.y + rise - info.by * sc, w: info.W * sc, h: info.H * sc, px: base.x, py: base.y + rise };
    }

    // what is inside the bin, seen through frosted glass: sharp above the rim, blurred behind the wall
    _glass(show) {
      const gl = this.gl, P = this.pGlass, r = this._binRect(this.bin.tex.mask.info, show);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(P.p);
      gl.bindVertexArray(this.quad);
      gl.uniform2f(P.u.uRes, this.W, this.H);
      gl.uniform4f(P.u.uRect, 0, 0, this.W, this.H);
      gl.uniform2f(P.u.uPivot, 0, 0);
      gl.uniform1f(P.u.uAng, 0);
      gl.uniform4f(P.u.uBin, r.x, r.y, r.w, r.h);
      gl.uniform1f(P.u.uBlur, Math.max(4, this.binGeo.Wt * 0.07));
      gl.uniform1f(P.u.uDpr, this.dpr);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbo.tex); gl.generateMipmap(gl.TEXTURE_2D); gl.uniform1i(P.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bin.tex.mask.tex); gl.uniform1i(P.u.uMask, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
    }

    _binLayer(layer, show) {
      const gl = this.gl, P = this.pTex, i = layer.info;
      const r = this._binRect(i, show);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(P.p);
      gl.bindVertexArray(this.quad);
      gl.uniform2f(P.u.uRes, this.W, this.H);
      gl.uniform4f(P.u.uRect, r.x, r.y, r.w, r.h);
      gl.uniform2f(P.u.uPivot, r.px, r.py);
      gl.uniform1f(P.u.uAng, this.bin.ang * 0.06);
      gl.uniform1f(P.u.uAlpha, show);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.uniform1i(P.u.uTex, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _shadow(cx, cy, hw, hh, radius, blur, alpha, color, glow) {
      if (alpha <= 0.002) return;
      const gl = this.gl, P = this.pShadow;
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(P.p);
      gl.bindVertexArray(this.quad);
      gl.uniform1f(P.u.uMode, glow ? 1 : 0);
      const ew = glow ? hw : hw + blur * 2, eh = glow ? hh : hh + blur * 2;
      gl.uniform2f(P.u.uRes, this.W, this.H);
      gl.uniform4f(P.u.uRect, cx - ew, cy - eh, ew * 2, eh * 2);
      gl.uniform2f(P.u.uPivot, cx, cy);
      gl.uniform1f(P.u.uAng, 0);
      gl.uniform2f(P.u.uHalf, hw, hh);
      gl.uniform1f(P.u.uRadius, Math.min(radius, hw, hh));
      gl.uniform1f(P.u.uBlur, Math.max(blur, 0.5));
      gl.uniform1f(P.u.uAlpha, alpha);
      const c = color || this.shadeColor;
      gl.uniform3f(P.u.uColor, c[0], c[1], c[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _liftShadow(b) {
      if (b.lift <= 0.01) return;
      // from the element's own shadow to a small shadow under the ball
      const S = this.o.shadow, e = easeOut(b.t), k = b.k;
      const hw = lerp(b.w / 2 - 8, b.r * 0.8, e) * k, hh = lerp(b.h / 2 - 8, b.r * 0.8, e) * k;
      const oy = lerp(S.y, b.r * 0.7, e) * k, blur = lerp(S.blur, b.r * 0.55, e) * k;
      const a = lerp(S.alpha, 0.3, e) * b.lift;
      this._shadow(b.sx, b.sy + oy, hw, hh, lerp(b.radius, b.r * 0.8, e) * k, blur, a);
    }

    _ball(b, alpha) {
      if (!b.tex || alpha <= 0.002) return;
      const gl = this.gl, P = this.pBall, u = P.u;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.frontFace(gl.CW);
      gl.useProgram(P.p);
      gl.bindVertexArray(b.mesh.vao);
      const e = easeOut(b.t);
      gl.uniform2f(u.uRes, this.W, this.H);
      gl.uniform2f(u.uPos, b.sx, b.sy);
      gl.uniform2f(u.uSize, b.w, b.h);
      gl.uniform2f(u.uStep, 1 / b.mesh.nx, 1 / b.mesh.ny);
      gl.uniform1f(u.uT, b.t);
      gl.uniform1f(u.uSeed, b.seed);
      gl.uniform1f(u.uScale, lerp(1, b.sFinal, e) * b.k);
      gl.uniform1f(u.uRb, b.Rb);
      // fold depth: shallow on the flat sheet, deep on the ball
      const big = Math.max(b.w, b.h);
      gl.uniform1f(u.uAmp, smooth(0, 0.26, b.t) * lerp(0.016 * big, 0.46 * b.Rb, smooth(0.18, 0.9, b.t)));
      // no tumble while the sheet is still flat
      const q = qLerp(qId(), b.q, smooth(0.0, 0.7, b.t));
      gl.uniformMatrix3fv(u.uRot, false, qMat(q, this.rot));
      gl.uniform3f(u.uBack, b.back[0], b.back[1], b.back[2]);
      gl.uniform1f(u.uLit, smooth(0, 0.1, b.t));
      gl.uniform1f(u.uAlpha, alpha);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform1i(u.uTex, 0);
      gl.drawElements(gl.TRIANGLES, b.mesh.count, gl.UNSIGNED_INT, 0);
    }
  }

  return { create: (opts) => new Toss(opts), version: '1.0.0' };
});
