// Watercolor simulation — WebGL2 ping-pong fluid/pigment solver.
//
// No dependencies, no build step. Two half-float ping-pong fields:
//
//   wet  RGBA16F : rgb = dissolved pigment absorbance, a = standing water
//   dep  RGBA16F : rgb = deposited pigment absorbance, a = deposit density
//
// plus a static procedural paper texture (height/grain/fiber). Per frame:
//
//   1. splat   — brush segments add water + pigment (additive blend)
//   2. update  — water spreads along an effective height (water + paper
//                grain) with a wet-front pin threshold (the hard watercolor
//                edge), carries pigment with it, evaporates, and absorbs
//                pigment into the deposit layer with edge darkening as the
//                front dries (classic dark-rimmed wash) and granulation
//                where the paper tooth is high
//   3. deposit — accumulates exactly the absorption the update pass removed
//                (both passes compute it from the same previous-frame state)
//   4. render  — Beer-Lambert composite over warm paper, display-resolution
//                grain, wet sheen, wet-paper darkening, soft vignette
//
// A 64x64 analysis pass + readPixels exposes what the painting *is* right
// now (wetness, coverage, painted density, warmth, roughness) so the host
// can map physical properties of the wash onto control signals.

const SIM_MAX = 1024; // long edge of the simulation grid
const ANALYSIS_RES = 64;
const SUBSTEPS = 2;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const NOISE = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.13; a *= 0.5; }
  return v;
}`;

const PAPER_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 o;
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // Cold-press tooth: low-frequency undulation + mid bumps + fine grain,
  // with faint horizontal fiber streaks.
  float lo = fbm(uv * 4.0);
  float mid = fbm(uv * 18.0 + 7.3);
  float hi = vnoise(uv * 90.0);
  float fiber = vnoise(vec2(uv.x * 160.0, uv.y * 22.0)) * 0.5
              + vnoise(vec2(uv.x * 18.0, uv.y * 240.0)) * 0.5;
  float height = clamp(0.45 * lo + 0.33 * mid + 0.16 * hi + 0.09 * (fiber - 0.5), 0.0, 1.0);
  o = vec4(height, hi, fiber, 1.0);
}`;

// Brush stamp: gaussian falloff from a capsule (stroke segment).
const SPLAT_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uA;       // segment start (sim px)
uniform vec2 uB;       // segment end   (sim px)
uniform float uRadius; // sim px
uniform vec3 uPig;     // pigment absorbance per unit
uniform float uPigAmt;
uniform float uWater;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 ab = uB - uA;
  float t = clamp(dot(p - uA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float d = length(p - (uA + ab * t)) / max(uRadius, 1e-3);
  float m = exp(-d * d * 3.2);
  if (m < 0.003) discard;
  o = vec4(uPig * (uPigAmt * m), uWater * m);
}`;

// Shared between update + deposit so both remove/add the *same* pigment.
// Edge darkening rises with the water gradient; the drying ramp dumps the
// remaining pigment as the film dies; paper tooth granulates the deposit.
const ABSORB_FN = `
vec3 absorbedPigment(vec4 w, float gradW, float paperH, float dryAll) {
  float edge = clamp(gradW * 22.0, 0.0, 1.0);
  float drying = smoothstep(0.030, 0.006, w.a);
  float rate = 0.012 * (1.0 + 2.6 * edge + 5.0 * drying) * (0.65 + 0.7 * paperH);
  rate = max(rate, dryAll);
  return w.rgb * clamp(rate, 0.0, 1.0);
}`;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uWet;
uniform sampler2D uPaper;
uniform vec2 uRes;
uniform float uDryAll; // 0 normally; 1 = flash-dry the whole sheet
out vec4 o;
${ABSORB_FN}
vec4 W(ivec2 c) {
  return texelFetch(uWet, clamp(c, ivec2(0), ivec2(uRes) - 1), 0);
}
float P(ivec2 c) {
  return texelFetch(uPaper, clamp(c, ivec2(0), ivec2(uRes) - 1), 0).r;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 w = W(c);
  float p0 = P(c);

  const float GRAIN = 0.10; // paper height in water-height units
  const float FLOW = 0.14;  // per-substep transfer rate
  const float PIN = 0.0045; // wet-front pin threshold (the hard edge)

  float h0 = w.a + p0 * GRAIN;
  float gateOut = smoothstep(PIN, PIN * 3.0, w.a);

  vec4 nb[4];
  nb[0] = W(c + ivec2(1, 0)); nb[1] = W(c - ivec2(1, 0));
  nb[2] = W(c + ivec2(0, 1)); nb[3] = W(c - ivec2(0, 1));
  float ph[4];
  ph[0] = P(c + ivec2(1, 0)); ph[1] = P(c - ivec2(1, 0));
  ph[2] = P(c + ivec2(0, 1)); ph[3] = P(c - ivec2(0, 1));

  float water = w.a;
  vec3 pig = w.rgb;
  for (int i = 0; i < 4; i++) {
    float hi = nb[i].a + ph[i] * GRAIN;
    float gateIn = smoothstep(PIN, PIN * 3.0, nb[i].a);
    float inflow = max(hi - h0, 0.0) * FLOW * gateIn;
    float outflow = max(h0 - hi, 0.0) * FLOW * gateOut;
    inflow = min(inflow, nb[i].a * 0.2);
    outflow = min(outflow, w.a * 0.2);
    water += inflow - outflow;
    pig += inflow * nb[i].rgb / max(nb[i].a, 1e-4)
         - outflow * w.rgb / max(w.a, 1e-4);
    // gentle in-film pigment diffusion (tea-like spread inside a wash)
    pig += 0.045 * (nb[i].rgb - w.rgb) * min(gateIn, gateOut);
  }

  // Evaporation, faster on the peaks of the tooth.
  water -= 0.0011 * (0.35 + 0.65 * p0);
  water = max(water, 0.0);
  water = min(water, 2.0);
  if (uDryAll > 0.5) water = 0.0;

  float gradW = abs(nb[0].a - nb[1].a) + abs(nb[2].a - nb[3].a);
  pig -= absorbedPigment(w, gradW, p0, uDryAll);
  pig = clamp(pig, vec3(0.0), vec3(6.0));

  o = vec4(pig, water);
}`;

const DEPOSIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uWet;
uniform sampler2D uDep;
uniform sampler2D uPaper;
uniform vec2 uRes;
uniform float uDryAll;
out vec4 o;
${ABSORB_FN}
vec4 W(ivec2 c) {
  return texelFetch(uWet, clamp(c, ivec2(0), ivec2(uRes) - 1), 0);
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 w = W(c);
  vec4 dep = texelFetch(uDep, c, 0);
  vec4 paper = texelFetch(uPaper, c, 0);
  float gradW = abs(W(c + ivec2(1, 0)).a - W(c - ivec2(1, 0)).a)
              + abs(W(c + ivec2(0, 1)).a - W(c - ivec2(0, 1)).a);
  vec3 add = absorbedPigment(w, gradW, paper.r, uDryAll);
  // Granulation: pigment settles preferentially into the tooth valleys.
  add *= 0.72 + 0.56 * (1.0 - paper.g);
  vec3 pig = clamp(dep.rgb + add, vec3(0.0), vec3(8.0));
  float density = 1.0 - exp(-dot(pig, vec3(0.299, 0.587, 0.114)));
  o = vec4(pig, density);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uWet;
uniform sampler2D uDep;
uniform sampler2D uPaper;
uniform sampler2D uDetail; // screen-res paper grain, baked once per resize
uniform vec2 uRes; // display px
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 wet = texture(uWet, uv);
  vec4 dep = texture(uDep, uv);
  vec4 paper = texture(uPaper, uv);

  // Display-resolution grain keeps the sheet crisp regardless of sim res.
  // Baked to a texture: computing multi-octave noise per pixel per frame
  // is a GPU-watchdog risk on software WebGL or a TRT-saturated GPU.
  float detail = texture(uDetail, uv).r * 0.6 + paper.r * 0.4;

  vec3 absorb = dep.rgb + wet.rgb * 0.85;
  float density = 1.0 - exp(-dot(absorb, vec3(0.333)));
  float granul = 1.0 + 0.45 * (detail - 0.5) * smoothstep(0.02, 0.45, density);
  vec3 trans = exp(-absorb * granul);

  vec3 paperCol = vec3(0.988, 0.978, 0.952) * (0.93 + 0.07 * detail);
  paperCol *= 1.0 - 0.07 * smoothstep(0.0, 0.30, wet.a); // wet paper darkens
  vec3 col = paperCol * trans;

  // Wet sheen: a soft directional glint off the standing water film.
  vec2 px = 1.0 / uRes;
  float wR = texture(uWet, uv + vec2(px.x, 0.0)).a;
  float wU = texture(uWet, uv + vec2(0.0, px.y)).a;
  vec3 n = normalize(vec3((wet.a - wR) * 30.0, (wet.a - wU) * 30.0, 1.0));
  vec3 lightDir = normalize(vec3(-0.45, 0.65, 0.9));
  float spec = pow(max(dot(n, lightDir), 0.0), 36.0);
  col += spec * 0.16 * smoothstep(0.04, 0.35, wet.a);

  float vig = 1.0 - 0.16 * pow(length(uv - 0.5) * 1.35, 3.0);
  o = vec4(clamp(col * vig, 0.0, 1.0), 1.0);
}`;

// Trivial blit to the default framebuffer. The watercolor composite is
// rendered into an offscreen RGBA8 texture first: complex shaders drawing
// straight to the backbuffer crash Chrome's software WebGL fallback
// (SwiftShader), and a crashed context gets WebGL blocklisted on reload.
const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
out vec4 o;
void main() { o = texture(uTex, gl_FragCoord.xy / uRes); }`;

// Low-res field measurements. r = water, g = perceived paint density,
// b = warmth of the transmitted color, a = local roughness (deposit
// variance — granulation/edges read as "gritty").
const ANALYSIS_FS = `#version 300 es
precision highp float;
uniform sampler2D uWet;
uniform sampler2D uDep;
uniform vec2 uRes; // analysis res
out vec4 o;
float densityAt(vec2 uv) {
  vec3 a = texture(uDep, uv).rgb + texture(uWet, uv).rgb * 0.85;
  return 1.0 - exp(-dot(a, vec3(0.333)));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 wet = texture(uWet, uv);
  vec4 dep = texture(uDep, uv);
  vec3 absorb = dep.rgb + wet.rgb * 0.85;
  float density = 1.0 - exp(-dot(absorb, vec3(0.333)));
  vec3 col = exp(-absorb);
  float warmth = clamp((col.r - col.b) * 1.4 * 0.5 + 0.5, 0.0, 1.0);
  vec2 px = 1.0 / uRes;
  float d0 = densityAt(uv);
  float v = abs(densityAt(uv + vec2(px.x, 0.0)) - d0)
          + abs(densityAt(uv - vec2(px.x, 0.0)) - d0)
          + abs(densityAt(uv + vec2(0.0, px.y)) - d0)
          + abs(densityAt(uv - vec2(0.0, px.y)) - d0);
  o = vec4(clamp(wet.a, 0.0, 1.0), density, warmth, clamp(v * 1.5, 0.0, 1.0));
}`;

// Exposed for the standalone shader diagnostic harness.
export const __SHADER_SOURCES = {
  PAPER_FS, SPLAT_FS, UPDATE_FS, DEPOSIT_FS, RENDER_FS, ANALYSIS_FS,
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, fs) {
  const pr = gl.createProgram();
  gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(pr));
  }
  return pr;
}

export function createWatercolor(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser");
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float is not available (needed for the paint simulation)");
  }

  // ── Resolution ──────────────────────────────────────────────────────────
  const rect = canvas.getBoundingClientRect();
  const aspect = Math.max(0.2, rect.width / Math.max(rect.height, 1));
  let simW, simH;
  if (aspect >= 1) { simW = SIM_MAX; simH = Math.round(SIM_MAX / aspect); }
  else { simH = SIM_MAX; simW = Math.round(SIM_MAX * aspect); }

  function fitCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(r.width * dpr));
    const h = Math.max(2, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  fitCanvas();

  // ── GPU state ───────────────────────────────────────────────────────────
  function makeTex(w, h, internal, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const wet = [
    makeTex(simW, simH, gl.RGBA16F, gl.LINEAR),
    makeTex(simW, simH, gl.RGBA16F, gl.LINEAR),
  ];
  const dep = [
    makeTex(simW, simH, gl.RGBA16F, gl.LINEAR),
    makeTex(simW, simH, gl.RGBA16F, gl.LINEAR),
  ];
  const paper = makeTex(simW, simH, gl.RGBA8, gl.LINEAR);
  const analysisTex = makeTex(ANALYSIS_RES, ANALYSIS_RES, gl.RGBA8, gl.NEAREST);
  let wetIdx = 0, depIdx = 0;

  const fbo = gl.createFramebuffer();
  const vao = gl.createVertexArray();

  const progPaper = program(gl, PAPER_FS);
  const progSplat = program(gl, SPLAT_FS);
  const progUpdate = program(gl, UPDATE_FS);
  const progDeposit = program(gl, DEPOSIT_FS);
  const progRender = program(gl, RENDER_FS);
  const progCopy = program(gl, COPY_FS);
  const progAnalysis = program(gl, ANALYSIS_FS);
  const U = (pr, n) => gl.getUniformLocation(pr, n);

  function target(tex, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  }
  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  function draw() {
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Bake the paper once.
  target(paper, simW, simH);
  gl.useProgram(progPaper);
  gl.uniform2f(U(progPaper, "uRes"), simW, simH);
  draw();

  function clearField(pair) {
    for (const t of pair) {
      target(t, simW, simH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }
  clearField(wet);
  clearField(dep);

  // ── Brush + stroke state ────────────────────────────────────────────────
  const brush = {
    pig: [1.6, 1.2, 0.25], // absorbance (set via setColor)
    size: 0.45,            // 0..1 UI value
    water: 0.6,            // 0..1 UI value
  };
  let segments = [];   // queued stroke segments for this frame
  let last = null;     // previous pointer position (sim px)
  let strokeEnergy = 0;
  let dryAllFrames = 0;
  let destroyed = false;

  function setColor(rgb) {
    // sRGB reflectance -> absorbance, Beer-Lambert style.
    brush.pig = rgb.map((c) => Math.min(4, -Math.log(Math.max(c, 0.025))));
  }
  function radiusPx() {
    return (0.012 + brush.size * 0.055) * Math.min(simW, simH);
  }
  function pushSegment(x, y, pressure) {
    const a = last || { x, y };
    const dist = Math.hypot(x - a.x, y - a.y);
    const press = Math.max(0.15, Math.min(1, pressure));
    // Faster strokes lay down a thinner, drier line — like a real brush.
    const speedThin = 1 / (1 + dist / (radiusPx() * 3));
    segments.push({
      ax: a.x, ay: a.y, bx: x, by: y,
      radius: radiusPx() * (0.6 + 0.5 * press),
      pig: brush.pig.slice(),
      water: (0.10 + brush.water * 0.45) * press * (0.45 + 0.55 * speedThin),
      pigAmt: (1.15 - brush.water * 0.85) * press * (0.4 + 0.6 * speedThin),
    });
    strokeEnergy = Math.min(1, strokeEnergy + dist / (simW * 0.55));
    last = { x, y };
  }

  function toSim(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / Math.max(r.width, 1)) * simW,
      y: (1 - (clientY - r.top) / Math.max(r.height, 1)) * simH,
    };
  }

  let pointerDown = false;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointerDown = true;
    last = null;
    const p = toSim(e.clientX, e.clientY);
    pushSegment(p.x, p.y, e.pressure || 0.7);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointerDown) return;
    const p = toSim(e.clientX, e.clientY);
    pushSegment(p.x, p.y, e.pressure || 0.7);
  });
  const lift = () => { pointerDown = false; last = null; };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);

  // Synthetic pointer for the no-hands test path (normalized 0..1, y up).
  function injectPointer(xn, yn, down) {
    if (!down) { last = null; return; }
    pushSegment(xn * simW, yn * simH, 0.7);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────
  function splatAll() {
    if (!segments.length) return;
    target(wet[wetIdx], simW, simH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progSplat);
    gl.uniform2f(U(progSplat, "uRes"), simW, simH);
    for (const s of segments.slice(-24)) {
      gl.uniform2f(U(progSplat, "uA"), s.ax, s.ay);
      gl.uniform2f(U(progSplat, "uB"), s.bx, s.by);
      gl.uniform1f(U(progSplat, "uRadius"), s.radius);
      gl.uniform3f(U(progSplat, "uPig"), s.pig[0], s.pig[1], s.pig[2]);
      gl.uniform1f(U(progSplat, "uPigAmt"), s.pigAmt);
      gl.uniform1f(U(progSplat, "uWater"), s.water);
      draw();
    }
    gl.disable(gl.BLEND);
    segments = [];
  }

  function step() {
    const dry = dryAllFrames > 0 ? 1 : 0;
    if (dryAllFrames > 0) dryAllFrames--;
    const src = wetIdx, dst = 1 - wetIdx;

    // Deposit reads the SAME previous wet state the update consumes.
    target(dep[1 - depIdx], simW, simH);
    gl.useProgram(progDeposit);
    bindTex(0, wet[src]); gl.uniform1i(U(progDeposit, "uWet"), 0);
    bindTex(1, dep[depIdx]); gl.uniform1i(U(progDeposit, "uDep"), 1);
    bindTex(2, paper); gl.uniform1i(U(progDeposit, "uPaper"), 2);
    gl.uniform2f(U(progDeposit, "uRes"), simW, simH);
    gl.uniform1f(U(progDeposit, "uDryAll"), dry);
    draw();
    depIdx = 1 - depIdx;

    target(wet[dst], simW, simH);
    gl.useProgram(progUpdate);
    bindTex(0, wet[src]); gl.uniform1i(U(progUpdate, "uWet"), 0);
    bindTex(1, paper); gl.uniform1i(U(progUpdate, "uPaper"), 1);
    gl.uniform2f(U(progUpdate, "uRes"), simW, simH);
    gl.uniform1f(U(progUpdate, "uDryAll"), dry);
    draw();
    wetIdx = dst;
  }

  let screenTex = null, detailTex = null, screenW = 0, screenH = 0;
  function render() {
    fitCanvas();
    if (!screenTex || screenW !== canvas.width || screenH !== canvas.height) {
      if (screenTex) gl.deleteTexture(screenTex);
      if (detailTex) gl.deleteTexture(detailTex);
      screenW = canvas.width;
      screenH = canvas.height;
      screenTex = makeTex(screenW, screenH, gl.RGBA8, gl.NEAREST);
      detailTex = makeTex(screenW, screenH, gl.RGBA8, gl.NEAREST);
      target(detailTex, screenW, screenH);
      gl.useProgram(progPaper);
      gl.uniform2f(U(progPaper, "uRes"), screenW, screenH);
      draw();
    }
    // Composite offscreen...
    target(screenTex, screenW, screenH);
    gl.useProgram(progRender);
    bindTex(0, wet[wetIdx]); gl.uniform1i(U(progRender, "uWet"), 0);
    bindTex(1, dep[depIdx]); gl.uniform1i(U(progRender, "uDep"), 1);
    bindTex(2, paper); gl.uniform1i(U(progRender, "uPaper"), 2);
    bindTex(3, detailTex); gl.uniform1i(U(progRender, "uDetail"), 3);
    gl.uniform2f(U(progRender, "uRes"), screenW, screenH);
    draw();
    // ...then a plain copy to the backbuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, screenW, screenH);
    gl.useProgram(progCopy);
    bindTex(0, screenTex); gl.uniform1i(U(progCopy, "uTex"), 0);
    gl.uniform2f(U(progCopy, "uRes"), screenW, screenH);
    draw();
  }

  function frame() {
    if (destroyed) return;
    splatAll();
    for (let i = 0; i < SUBSTEPS; i++) step();
    strokeEnergy *= 0.984;
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Analysis readback ───────────────────────────────────────────────────
  const pixels = new Uint8Array(ANALYSIS_RES * ANALYSIS_RES * 4);
  function analysis() {
    target(analysisTex, ANALYSIS_RES, ANALYSIS_RES);
    gl.useProgram(progAnalysis);
    bindTex(0, wet[wetIdx]); gl.uniform1i(U(progAnalysis, "uWet"), 0);
    bindTex(1, dep[depIdx]); gl.uniform1i(U(progAnalysis, "uDep"), 1);
    gl.uniform2f(U(progAnalysis, "uRes"), ANALYSIS_RES, ANALYSIS_RES);
    draw();
    gl.readPixels(0, 0, ANALYSIS_RES, ANALYSIS_RES, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let wetSum = 0, densSum = 0, covSum = 0, warmSum = 0, warmW = 0, roughSum = 0;
    const n = ANALYSIS_RES * ANALYSIS_RES;
    for (let i = 0; i < n; i++) {
      const r = pixels[i * 4] / 255;
      const g = pixels[i * 4 + 1] / 255;
      const b = pixels[i * 4 + 2] / 255;
      const a = pixels[i * 4 + 3] / 255;
      wetSum += r;
      densSum += g;
      covSum += Math.min(1, Math.max(0, (g - 0.05) / 0.10)); // soft "is painted"
      warmSum += b * g;
      warmW += g;
      roughSum += a;
    }
    const coverage = covSum / n;
    const paintedDensity = coverage > 0.003 ? (densSum / n) / Math.max(coverage, 1e-3) : 0;
    return {
      wetness: wetSum / n,
      coverage,
      paintedDensity: Math.min(1, paintedDensity),
      warmth: warmW > 0.02 ? warmSum / warmW : 0.5,
      roughness: roughSum / n,
      energy: strokeEnergy,
    };
  }

  return {
    setColor,
    setBrushSize: (v) => { brush.size = Math.max(0, Math.min(1, v)); },
    setWaterLoad: (v) => { brush.water = Math.max(0, Math.min(1, v)); },
    dry: () => { dryAllFrames = 3; },
    clear: () => { clearField(wet); clearField(dep); strokeEnergy = 0; },
    injectPointer,
    analysis,
    energy: () => strokeEnergy,
    destroy: () => { destroyed = true; },
  };
}
