// The plate: one WebGL surface that prints the hero engraving.
//
// It draws the griffin from an ink mask (alpha = line density; red = the
// creature's silhouette) and can:
//   - ink it in (progress 0..1): a sweep crosses the plate and the deepest
//     grooves fill first, the finest hairlines last, as intaglio ink fills a plate;
//   - show it under UV: inside the lamp's pool the stock goes dark violet, the
//     ordinary ink goes dead, and the engraving's second, fluorescent printing
//     glows amber along the same lines, among fluorescent paper fibres.
// On the light stock it prints bottle green; on the dark stock, gold lines over
// a faint gold body. Without WebGL the page keeps the CSS print underneath.
//
// No dependencies. WebGL1, so it runs wherever WebGL runs.

const VERT = `
attribute vec2 p;
varying vec2 v;
void main() { v = p * 0.5 + 0.5; v.y = 1.0 - v.y; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 v;
uniform sampler2D uInk, uFibres;
uniform vec2 uRes;
uniform vec4 uFit;          // where the engraving sits in the canvas: x, y, w, h (uv)
uniform float uProgress;    // ink fill 0..1
uniform vec3 uInkCol;
uniform float uDark;
uniform float uUV;          // 0..1 lamp strength
uniform vec2 uUVPos;        // lamp centre (canvas uv)
uniform float uUVR;         // pool radius (device px)
uniform float uHalo;        // the violet spill outside the pool
uniform float uTime;
uniform float uFibreScale;

vec2 plateAt(vec2 uv) {
  vec2 t = (uv - uFit.xy) / uFit.zw;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return vec2(0.0);
  vec4 k = texture2D(uInk, t);
  return vec2(k.a, k.r); // line density, body silhouette
}

void main() {
  vec2 pb = plateAt(v);
  float d = pb.x;

  // The sweep leans with the hatching; behind it the reveal threshold drops,
  // so dense ink (deep grooves) shows first and hairlines last.
  float lean = (1.0 - v.y) * 0.18;
  float r = uProgress * 1.5 - 0.25;
  float behind = clamp((r - v.x - lean) / 0.32, 0.0, 1.0);
  float shown = smoothstep(1.0 - behind, 1.0 - behind + 0.12, d) * d;
  float wet = smoothstep(0.0, 0.05, r - v.x - lean) * (1.0 - smoothstep(0.05, 0.25, r - v.x - lean));
  float inkA = clamp(shown * 1.15, 0.0, 1.0);
  // On the dark stock: gold lines over a faint gold body, so the creature has mass.
  if (uDark > 0.5) inkA = clamp(inkA + pb.y * 0.12 * (1.0 - inkA) * smoothstep(0.0, 0.4, behind), 0.0, 1.0);

  // A soft diagonal sheen on the gold, like struck metal catching the room.
  float sheen = 1.0 + uDark * 0.16 * (1.0 - abs(v.x * 0.8 + v.y * 0.6 - 0.72) * 2.2);
  vec3 col = uInkCol * sheen;
  col = mix(col, col * 1.25 + 0.05, wet * 0.6);
  float alpha = inkA;

  if (uUV > 0.0) {
    float dist = distance(v * uRes, uUVPos * uRes);
    float pool = (1.0 - smoothstep(uUVR * 0.45, uUVR, dist)) * uUV;
    if (pool > 0.001) {
      vec3 stock = mix(vec3(0.10, 0.06, 0.24), vec3(0.06, 0.04, 0.16), uDark);
      vec3 uvCol = mix(stock, vec3(0.04, 0.02, 0.09), inkA * 0.6);
      float lines = shown * (0.6 + 0.4 * pb.y);
      float flick = 0.94 + 0.06 * sin(uTime * 3.1 + v.y * 9.0);
      uvCol += vec3(1.0, 0.62, 0.16) * lines * 1.15 * flick;
      uvCol += vec3(1.0, 0.75, 0.35) * smoothstep(0.55, 1.0, lines) * 0.35;
      vec4 f = texture2D(uFibres, v * uFibreScale);
      uvCol += f.rgb * f.a * 1.35;
      col = mix(col, uvCol, pool);
      alpha = mix(alpha, 1.0, pool);
    }
    float halo = (1.0 - smoothstep(uUVR * 0.75, uUVR * 1.35, dist)) * (1.0 - pool) * uUV * uHalo;
    vec3 tint = vec3(0.40, 0.28, 0.95);
    float a = halo * mix(0.16, 0.24, uDark);
    col = (col * alpha * (1.0 - a) + tint * a) / max(alpha * (1.0 - a) + a, 0.001);
    alpha = alpha * (1.0 - a) + a;
  }
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const NAMES = ['uInk', 'uFibres', 'uRes', 'uFit', 'uProgress', 'uInkCol', 'uDark', 'uUV', 'uUVPos', 'uUVR', 'uHalo', 'uTime', 'uFibreScale'];

const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = rej; i.src = src; });

export class Plate {
  constructor(canvas, { fit = [0, 0, 1, 1], maxDpr = 2 } = {}) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL unavailable');
    const shader = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(pr); gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(NAMES.map((n) => [n, gl.getUniformLocation(pr, n)]));
    Object.assign(this, { gl, canvas, fit, maxDpr, ready: false, css: [1, 1], dpr: 1 });
    this.state = { progress: 1, uv: 0, uvPos: [0.5, 0.5], uvR: 200, halo: 1 };
  }

  texture(unit, name, img, repeat) {
    const gl = this.gl; const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(this.u[name], unit);
  }

  async load(ink, fibres) {
    const [i, f] = await Promise.all([loadImage(ink), loadImage(fibres)]);
    this.texture(0, 'uInk', i, false);
    // WebGL1 repeats only power-of-two textures: redraw the fibre tile to 1024.
    const c = document.createElement('canvas'); c.width = c.height = 1024; c.getContext('2d').drawImage(f, 0, 0, 1024, 1024);
    this.texture(1, 'uFibres', c, true);
    this.ready = true;
  }

  colours() {
    const cs = getComputedStyle(this.canvas);
    const m = /#([0-9a-f]{6})/i.exec(cs.getPropertyValue('--plate-ink')) || [0, 'd9aa45'];
    const n = parseInt(m[1], 16);
    return { ink: [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255], dark: cs.getPropertyValue('--plate-dark').trim() === '1' ? 1 : 0 };
  }

  draw(time) {
    if (!this.ready) return;
    const gl = this.gl; const s = this.state; const c = this.colours();
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, this.maxDpr);
    const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.css = [r.width, r.height]; this.dpr = dpr;
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.u;
    gl.uniform2f(u.uRes, w, h);
    gl.uniform4f(u.uFit, ...this.fit);
    gl.uniform1f(u.uProgress, s.progress);
    gl.uniform3fv(u.uInkCol, c.ink);
    gl.uniform1f(u.uDark, c.dark);
    gl.uniform1f(u.uUV, s.uv);
    gl.uniform2f(u.uUVPos, s.uvPos[0], s.uvPos[1]);
    gl.uniform1f(u.uUVR, s.uvR * dpr);
    gl.uniform1f(u.uHalo, s.halo);
    gl.uniform1f(u.uTime, time / 1000);
    gl.uniform1f(u.uFibreScale, r.width / 520);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
