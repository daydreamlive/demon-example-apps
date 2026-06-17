import {
  AudioPlayer,
  RemoteBackend,
  SLICE_FLAG_DELTA,
  fetchKnobManifest,
  fetchWireContract,
} from "/sdk/demon-client.js";

const TICK_MS = 8;
const CONTROL_NAMES = [
  "denoise",
  "sde_amp",
  "feedback",
  "feedback_depth",
  "shift",
  "hint_strength",
  "steps_override",
  "dcw_enabled",
  "dcw_mode",
  "dcw_wavelet",
  "dcw_scaler",
  "dcw_high_scaler",
  "dcw_mult_blend",
  "dcw_mag_phase",
  "dcw_soft_thresh",
];

const SESSION_CONFIG = {
  telemetry_version: 1,
  sde: false,
  lora: 0,
  depth: 4,
  vae_window: 60,
  crop: 60,
  steps: 4,
  fast_vae: true,
  walk_window: false,
  walk_window_s: 60,
  prompt: "high definition liquid watercolor techno, detailed paper fibers, luminous pigments, deep stereo groove",
};

const els = {
  canvas: document.getElementById("paper"),
  fallback: document.getElementById("fallback"),
  status: document.getElementById("status"),
  fixtureSelect: document.getElementById("fixtureSelect"),
  startBtn: document.getElementById("startBtn"),
  muteBtn: document.getElementById("muteBtn"),
  controls: document.getElementById("controls"),
  promptA: document.getElementById("promptA"),
  wetReadout: document.getElementById("wetReadout"),
  gestureReadout: document.getElementById("gestureReadout"),
  fixtureReadout: document.getElementById("fixtureReadout"),
};

const state = {
  fixtures: [],
  serverSideFixtures: [],
  knobManifest: null,
  controlSpecs: {},
  controlEls: {},
  params: {},
  remote: null,
  player: null,
  timer: 0,
  running: false,
  muted: false,
};

function setStatus(text) {
  els.status.textContent = text;
}

function httpBase() {
  return window.location.origin;
}

function wsUrl() {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function valueLabel(value) {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}

function seedParams(knobs) {
  const params = {};
  for (const [name, spec] of Object.entries(knobs)) {
    params[name] = spec.default;
  }
  params.steps_override = SESSION_CONFIG.steps;
  state.params = params;
}

function renderControls(knobs) {
  els.controls.innerHTML = "";
  state.controlSpecs = {};
  state.controlEls = {};
  for (const name of CONTROL_NAMES) {
    const spec = knobs[name];
    if (!spec) continue;
    state.controlSpecs[name] = spec;
    const row = document.createElement("div");
    row.className = "control";

    const head = document.createElement("div");
    head.className = "controlHead";
    const label = document.createElement("strong");
    label.textContent = name;
    const readout = document.createElement("span");
    readout.textContent = valueLabel(state.params[name]);
    head.append(label, readout);
    row.append(head);

    if (spec.type === "float" || spec.type === "int") {
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(spec.min ?? 0);
      input.max = String(spec.max ?? 1);
      input.step = spec.type === "int" ? "1" : String(((spec.max ?? 1) - (spec.min ?? 0)) / 400);
      input.value = String(state.params[name]);
      input.addEventListener("input", () => {
        const next = spec.type === "int" ? Math.round(Number(input.value)) : Number(input.value);
        state.params[name] = next;
        readout.textContent = valueLabel(next);
      });
      state.controlEls[name] = { input, readout };
      row.append(input);
    } else if (spec.type === "bool") {
      const wrap = document.createElement("label");
      wrap.className = "toggleLine";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(state.params[name]);
      input.addEventListener("change", () => {
        state.params[name] = input.checked;
        readout.textContent = valueLabel(input.checked);
      });
      state.controlEls[name] = { input, readout };
      wrap.append(input, document.createTextNode("enabled"));
      row.append(wrap);
    } else if (spec.type === "enum") {
      const input = document.createElement("select");
      for (const option of spec.options ?? []) {
        const opt = document.createElement("option");
        opt.value = String(option);
        opt.textContent = String(option);
        input.append(opt);
      }
      input.value = String(state.params[name]);
      input.addEventListener("change", () => {
        state.params[name] = input.value;
        readout.textContent = input.value;
      });
      state.controlEls[name] = { input, readout };
      row.append(input);
    }

    els.controls.append(row);
  }
}

function updateControlDomFromParams(raw) {
  for (const [name, value] of Object.entries(raw)) {
    if (!(name in state.controlSpecs)) continue;
    state.params[name] = value;
    syncControl(name);
  }
}

function applyGestureToParams(gesture) {
  const p = state.params;
  const k = state.controlSpecs;
  if (k.denoise) p.denoise = clamp(0.22 + gesture.wetness * 0.58, k.denoise.min ?? 0, k.denoise.max ?? 1);
  if (k.sde_amp) p.sde_amp = clamp(0.15 + gesture.wetness * 0.75, k.sde_amp.min ?? 0, k.sde_amp.max ?? 1);
  if (k.feedback) p.feedback = clamp(gesture.velocity * 0.38, k.feedback.min ?? 0, k.feedback.max ?? 1);
  if (k.hint_strength) p.hint_strength = clamp(0.38 + (1 - gesture.wetness) * 0.55, k.hint_strength.min ?? 0, k.hint_strength.max ?? 1);
  if (k.shift) p.shift = clamp(2.0 + gesture.y * 3.4, k.shift.min ?? 1, k.shift.max ?? 6);
  if (k.dcw_scaler) p.dcw_scaler = clamp(0.02 + gesture.x * 0.2, k.dcw_scaler.min ?? 0, k.dcw_scaler.max ?? 0.5);
  if (k.dcw_high_scaler) p.dcw_high_scaler = clamp(0.015 + gesture.velocity * 0.08, k.dcw_high_scaler.min ?? 0, k.dcw_high_scaler.max ?? 0.5);
  for (const name of ["denoise", "sde_amp", "feedback", "hint_strength", "shift", "dcw_scaler", "dcw_high_scaler"]) {
    syncControl(name);
  }
}

function syncControl(name) {
  const spec = state.controlSpecs[name];
  const elsForControl = state.controlEls[name];
  if (!spec || !elsForControl) return;
  const value = state.params[name];
  if (elsForControl.input.type === "checkbox") {
    elsForControl.input.checked = Boolean(value);
  } else {
    elsForControl.input.value = String(value);
  }
  elsForControl.readout.textContent = valueLabel(value);
}

function renderFixtureOptions() {
  els.fixtureSelect.innerHTML = "";
  for (const name of state.fixtures) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    els.fixtureSelect.append(opt);
  }
  if (state.fixtures.length) {
    els.fixtureReadout.textContent = state.fixtures[0];
  }
}

function wireRemote(remote, player) {
  remote.addEventListener("slice", (event) => {
    const slice = event.detail;
    if (slice.epoch !== player.swapCount) return;
    if (slice.flags === SLICE_FLAG_DELTA) player.addDelta(slice.startSample, slice.audio);
    else player.patch(slice.startSample, slice.audio);
  });
  remote.addEventListener("params", (event) => updateControlDomFromParams(event.detail?.raw ?? event.detail ?? {}));
  remote.addEventListener("params_echo", (event) => updateControlDomFromParams(event.detail ?? {}));
  remote.addEventListener("swap_ready", (event) => {
    const detail = event.detail;
    if (detail?.interleaved) player.swap(detail.interleaved, detail.channels);
  });
  remote.addEventListener("close", () => {
    stopTick();
    state.running = false;
    els.startBtn.disabled = false;
    els.muteBtn.disabled = true;
    setStatus("Session closed");
  });
}

async function startSession() {
  if (state.running) return;
  const fixtureName = els.fixtureSelect.value || state.fixtures[0];
  if (!fixtureName || !state.serverSideFixtures.includes(fixtureName)) {
    setStatus("No server-side fixture available on this backend");
    return;
  }

  els.startBtn.disabled = true;
  setStatus("Opening DEMON session...");
  const config = {
    ...SESSION_CONFIG,
    prompt: els.promptA.value.trim() || SESSION_CONFIG.prompt,
    fixture_name: fixtureName,
    use_server_fixture: true,
  };

  const remote = new RemoteBackend(wsUrl(), new Float32Array(0), 2, config, {
    sliceWorkerUrl: `${httpBase()}/sdk/sliceDecoder.worker.js`,
  });
  const player = new AudioPlayer({
    workletUrl: `${httpBase()}/sdk/audio-worklet.js`,
  });
  wireRemote(remote, player);

  await remote.connect();
  await player.init(remote.initialBuffer, remote.channels);
  await player.resume();
  remote.sendPrompt(config.prompt);

  state.remote = remote;
  state.player = player;
  state.running = true;
  state.muted = false;
  els.muteBtn.disabled = false;
  els.muteBtn.textContent = "Mute";
  els.fixtureReadout.textContent = fixtureName;
  setStatus("Live. Paint the paper.");
  startTick();
}

function startTick() {
  stopTick();
  state.timer = window.setInterval(() => {
    if (!state.running || !state.remote || !state.player) return;
    const gesture = watercolor.gesture();
    applyGestureToParams(gesture);
    els.wetReadout.textContent = gesture.wetness.toFixed(2);
    els.gestureReadout.textContent = gesture.active ? "painting" : "drying";
    state.remote.sendParams({ ...state.params }, state.player.positionSec);
  }, TICK_MS);
}

function stopTick() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = 0;
}

async function toggleMute() {
  if (!state.player?.ctx) return;
  if (state.player.ctx.state === "running") {
    await state.player.ctx.suspend();
    els.muteBtn.textContent = "Resume";
  } else {
    await state.player.resume();
    els.muteBtn.textContent = "Mute";
  }
}

class WatercolorGL {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error("WebGL2 unavailable");
    const gl = this.gl;
    gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");
    this.pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, down: 0, speed: 0 };
    this.ink = [0.1, 0.36, 0.42];
    this.wetness = 0;
    this.last = performance.now();
    this.quad = this.createQuad();
    this.simProgram = this.program(VERT, SIM_FRAG);
    this.viewProgram = this.program(VERT, VIEW_FRAG);
    this.splatProgram = this.program(VERT, SPLAT_FRAG);
    this.resize();
    this.attach();
    window.addEventListener("resize", () => this.resize());
  }

  attach() {
    const move = (event) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.px = this.pointer.x;
      this.pointer.py = this.pointer.y;
      this.pointer.x = clamp((event.clientX - r.left) / r.width, 0, 1);
      this.pointer.y = clamp(1 - (event.clientY - r.top) / r.height, 0, 1);
      const dx = this.pointer.x - this.pointer.px;
      const dy = this.pointer.y - this.pointer.py;
      this.pointer.speed = clamp(Math.hypot(dx, dy) * 36, 0, 1);
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      this.pointer.down = 1;
      this.canvas.setPointerCapture(event.pointerId);
      this.pickInk();
      move(event);
    });
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", () => {
      this.pointer.down = 0;
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.pointer.down = 0;
    });
  }

  pickInk() {
    const palettes = [
      [0.04, 0.42, 0.46],
      [0.74, 0.32, 0.46],
      [0.86, 0.58, 0.2],
      [0.18, 0.29, 0.58],
      [0.22, 0.44, 0.24],
    ];
    this.ink = palettes[Math.floor(Math.random() * palettes.length)];
  }

  createQuad() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return vao;
  }

  program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) || "Shader compile failed");
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || "Program link failed");
    }
    return p;
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Floating framebuffer unavailable");
    }
    return { tex, fbo, w, h };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.a) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const simW = Math.max(320, Math.floor(w * 0.5));
    const simH = Math.max(220, Math.floor(h * 0.5));
    this.a = this.makeTarget(simW, simH);
    this.b = this.makeTarget(simW, simH);
    this.read = this.a;
    this.write = this.b;
    this.clearTarget(this.a);
    this.clearTarget(this.b);
  }

  clearTarget(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(0.92, 0.87, 0.77, 0.04);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  uniforms(program, values) {
    const gl = this.gl;
    for (const [name, value] of Object.entries(values)) {
      const loc = gl.getUniformLocation(program, name);
      if (loc == null) continue;
      if (typeof value === "number") gl.uniform1f(loc, value);
      else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    }
  }

  bindTexture(program, name, tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }

  draw(program, target = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, target?.w ?? this.canvas.width, target?.h ?? this.canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  step() {
    const now = performance.now();
    const dt = Math.min(0.033, (now - this.last) / 1000);
    this.last = now;
    const gl = this.gl;
    gl.disable(gl.BLEND);

    gl.useProgram(this.simProgram);
    this.bindTexture(this.simProgram, "uState", this.read.tex, 0);
    this.uniforms(this.simProgram, {
      uTexel: [1 / this.read.w, 1 / this.read.h],
      uTime: now * 0.001,
      uDt: dt,
    });
    this.draw(this.simProgram, this.write);
    this.swap();

    if (this.pointer.down) {
      gl.useProgram(this.splatProgram);
      this.bindTexture(this.splatProgram, "uState", this.read.tex, 0);
      this.uniforms(this.splatProgram, {
        uPoint: [this.pointer.x, this.pointer.y],
        uPrev: [this.pointer.px, this.pointer.py],
        uInk: this.ink,
        uForce: 0.45 + this.pointer.speed * 0.85,
      });
      this.draw(this.splatProgram, this.write);
      this.swap();
      this.wetness = clamp(this.wetness + 0.035 + this.pointer.speed * 0.08, 0, 1);
    } else {
      this.wetness *= 0.985;
    }

    gl.useProgram(this.viewProgram);
    this.bindTexture(this.viewProgram, "uState", this.read.tex, 0);
    this.uniforms(this.viewProgram, {
      uResolution: [this.canvas.width, this.canvas.height],
      uTime: now * 0.001,
    });
    this.draw(this.viewProgram, null);
    requestAnimationFrame(() => this.step());
  }

  swap() {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }

  gesture() {
    return {
      wetness: this.wetness,
      velocity: this.pointer.speed,
      active: Boolean(this.pointer.down),
      x: this.pointer.x,
      y: this.pointer.y,
    };
  }
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uTime;
uniform float uDt;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
void main() {
  vec4 c = texture(uState, vUv);
  vec4 n = texture(uState, vUv + vec2(0.0, uTexel.y));
  vec4 s = texture(uState, vUv - vec2(0.0, uTexel.y));
  vec4 e = texture(uState, vUv + vec2(uTexel.x, 0.0));
  vec4 w = texture(uState, vUv - vec2(uTexel.x, 0.0));
  vec3 blur = (n.rgb + s.rgb + e.rgb + w.rgb) * 0.25;
  float paper = hash(floor(vUv * vec2(900.0, 620.0)));
  float fiber = smoothstep(0.18, 0.95, paper);
  float water = c.a;
  float spread = 0.018 + water * 0.18;
  vec3 pigment = mix(c.rgb, blur, spread);
  pigment *= 0.999 - fiber * 0.0015;
  water = max(0.0, water - uDt * (0.035 + fiber * 0.035));
  outColor = vec4(pigment, water);
}`;

const SPLAT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uState;
uniform vec2 uPoint;
uniform vec2 uPrev;
uniform vec3 uInk;
uniform float uForce;
float capsule(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec4 c = texture(uState, vUv);
  float d = capsule(vUv, uPrev, uPoint);
  float bloom = smoothstep(0.16, 0.0, d) * 0.35 + smoothstep(0.055, 0.0, d);
  vec3 pigment = mix(c.rgb, uInk, bloom * uForce);
  float water = clamp(c.a + bloom * (0.18 + uForce * 0.34), 0.0, 1.0);
  outColor = vec4(pigment, water);
}`;

const VIEW_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uState;
uniform vec2 uResolution;
uniform float uTime;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 12475.173);
}
void main() {
  vec4 c = texture(uState, vUv);
  float grain = hash(floor(vUv * uResolution.xy * 0.55));
  float fiber = hash(vec2(floor(vUv.x * 1000.0), floor(vUv.y * 90.0)));
  vec3 paper = vec3(0.9, 0.855, 0.755) + (grain - 0.5) * 0.055 + (fiber - 0.5) * 0.035;
  float wet = smoothstep(0.01, 0.62, c.a);
  vec3 stain = mix(paper, c.rgb, 0.74);
  float edge = smoothstep(0.06, 0.0, abs(c.a - 0.18)) * 0.08;
  stain -= edge;
  vec3 color = mix(paper, stain, smoothstep(0.025, 0.95, length(c.rgb - paper) + wet * 0.45));
  color += wet * vec3(0.055, 0.07, 0.065);
  color = pow(max(color, 0.0), vec3(0.92));
  outColor = vec4(color, 1.0);
}`;

let watercolor;

class Watercolor2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, down: 0, speed: 0 };
    this.wetness = 0;
    this.ink = "rgba(25, 120, 132, 0.24)";
    this.drops = [];
    this.resize();
    this.attach();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintPaper();
  }

  paintPaper() {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight));
    const ctx = this.ctx;
    ctx.fillStyle = "#e8ddc9";
    ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 18;
      img.data[i] = clamp(img.data[i] + n, 0, 255);
      img.data[i + 1] = clamp(img.data[i + 1] + n, 0, 255);
      img.data[i + 2] = clamp(img.data[i + 2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
  }

  attach() {
    const move = (event) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.px = this.pointer.x;
      this.pointer.py = this.pointer.y;
      this.pointer.x = clamp((event.clientX - r.left) / r.width, 0, 1);
      this.pointer.y = clamp(1 - (event.clientY - r.top) / r.height, 0, 1);
      const dx = this.pointer.x - this.pointer.px;
      const dy = this.pointer.y - this.pointer.py;
      this.pointer.speed = clamp(Math.hypot(dx, dy) * 36, 0, 1);
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      this.pointer.down = 1;
      this.pickInk();
      move(event);
    });
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", () => {
      this.pointer.down = 0;
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.pointer.down = 0;
    });
  }

  pickInk() {
    const colors = [
      "rgba(17, 128, 136, 0.25)",
      "rgba(184, 73, 112, 0.24)",
      "rgba(205, 132, 45, 0.24)",
      "rgba(56, 82, 155, 0.24)",
      "rgba(63, 118, 69, 0.24)",
    ];
    this.ink = colors[Math.floor(Math.random() * colors.length)];
  }

  step() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.save();
    ctx.globalAlpha = 0.012;
    ctx.fillStyle = "#e8ddc9";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    if (this.pointer.down) {
      const x = this.pointer.x * w;
      const y = (1 - this.pointer.y) * h;
      this.drops.push({ x, y, r: 12 + this.pointer.speed * 42, life: 1, color: this.ink });
      this.wetness = clamp(this.wetness + 0.035 + this.pointer.speed * 0.08, 0, 1);
    } else {
      this.wetness *= 0.985;
    }

    ctx.save();
    ctx.filter = "blur(9px)";
    for (const drop of this.drops) {
      ctx.globalAlpha = drop.life * 0.8;
      ctx.fillStyle = drop.color;
      ctx.beginPath();
      ctx.arc(drop.x, drop.y, drop.r, 0, Math.PI * 2);
      ctx.fill();
      drop.r += 0.45;
      drop.life *= 0.982;
    }
    ctx.restore();
    this.drops = this.drops.filter((drop) => drop.life > 0.05);
    requestAnimationFrame(() => this.step());
  }

  gesture() {
    return {
      wetness: this.wetness,
      velocity: this.pointer.speed,
      active: Boolean(this.pointer.down),
      x: this.pointer.x,
      y: this.pointer.y,
    };
  }
}

async function init() {
  try {
    watercolor = new WatercolorGL(els.canvas);
    watercolor.step();
  } catch (error) {
    console.warn("WebGL2 watercolor unavailable, using 2D fallback", error);
    watercolor = new Watercolor2D(els.canvas);
    watercolor.step();
  }

  const [protocol, knobManifest, fixtures, info] = await Promise.all([
    fetchWireContract(),
    fetchKnobManifest(false),
    fetchJson("/api/fixtures"),
    fetchJson("/api/server-info"),
  ]);

  state.knobManifest = knobManifest;
  state.fixtures = fixtures;
  state.serverSideFixtures = Array.isArray(info.server_side_fixtures) ? info.server_side_fixtures : [];
  seedParams(knobManifest.knobs);
  renderControls(knobManifest.knobs);
  renderFixtureOptions();
  setStatus(`Contract v${protocol.version}, knobs v${knobManifest.version}. Ready.`);

  els.startBtn.disabled = false;
  els.startBtn.addEventListener("click", () => {
    startSession().catch((error) => {
      console.error(error);
      setStatus(error.message || "Failed to start session");
      els.startBtn.disabled = false;
    });
  });
  els.muteBtn.addEventListener("click", () => {
    toggleMute().catch(console.error);
  });
}

els.startBtn.disabled = true;
init().catch((error) => {
  console.error(error);
  setStatus(error.message || "Failed to initialize");
});
