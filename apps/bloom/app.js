// DEMON · BLOOM — a living reaction-diffusion organism (Gray-Scott) running on
// the GPU. It grows, crawls and blooms in time with the remix; you sculpt it by
// dragging your cursor through the tissue. Your cursor's position in the field
// IS the chemistry (feed/kill), and that same position steers the DEMON model:
//
//   cursor X  → feed rate   ⇄  `denoise`       (how hard the model remixes)
//   cursor Y  → kill rate    ⇄  `hint_strength`  (how much of the source survives)
//
// So one gesture transforms the living texture and the music together. Bass
// kicks inject spores and pulse the feed, so the organism throbs on the beat.
//
// Plain DEMON session: boot a server-side fixture via the standard
// `use_server_fixture` handshake and remix it on a loop. No real-time audio
// input; the cursor only steers. Shared SDK is mounted at /sdk/ by the demo
// server (see demos/common/static_site.py, packages/demon-client/AGENTS.md).
import {
  RemoteBackend,
  AudioPlayer,
  SLICE_FLAG_DELTA,
} from "/sdk/demon-client.js";

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $("gl"),
  fixture: $("fixture"), prompt: $("prompt"),
  start: $("start"), reseed: $("reseed"), wild: $("wild"),
  status: $("status"), panel: $("panel"), readout: $("readout"),
  rFeed: $("r-feed"), rKill: $("r-kill"), nogl: $("nogl"), brush: $("brush"),
};
const setStatus = (s) => { if (ui.status) ui.status.textContent = s; };

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — the organism (raw WebGL2, ping-pong Gray-Scott reaction-diffusion)
// ════════════════════════════════════════════════════════════════════════════
const cv = ui.canvas;
const gl = cv.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
let glOK = !!gl && !!gl.getExtension("EXT_color_buffer_float");
if (!glOK) {
  ui.nogl.hidden = false;
  console.warn("[bloom] WebGL2 + EXT_color_buffer_float required");
}

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;

// Seed: A=1 everywhere, B sprinkled as spore cells so growth starts immediately.
const SEED = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform float seed;
float h(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1))+seed)*43758.5453); }
void main(){
  vec2 cell = floor(uv*26.0);
  float b = h(cell) > 0.86 ? 1.0 : 0.0;
  // a faint central smear so there's always a core that blooms
  float d = distance(uv, vec2(0.5));
  if (d < 0.06 && h(cell+7.0) > 0.3) b = 1.0;
  o = vec4(1.0, b, 0.0, 1.0);
}`;

// One Gray-Scott step. State is (A,B) in the red/green channels.
const SIM = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D state;
uniform vec2 texel;     // 1/simRes
uniform vec2 res;       // simRes (px)
uniform float feed, kill, dt;
uniform vec2 brush;     // uv of brush centre, or <0 = none
uniform float brushR;   // px radius
uniform float brushSign;
void main(){
  vec2 c = texture(state, uv).xy;
  vec2 lap = vec2(0.0);
  lap += texture(state, uv+texel*vec2(-1.0, 0.0)).xy * 0.20;
  lap += texture(state, uv+texel*vec2( 1.0, 0.0)).xy * 0.20;
  lap += texture(state, uv+texel*vec2( 0.0,-1.0)).xy * 0.20;
  lap += texture(state, uv+texel*vec2( 0.0, 1.0)).xy * 0.20;
  lap += texture(state, uv+texel*vec2(-1.0,-1.0)).xy * 0.05;
  lap += texture(state, uv+texel*vec2( 1.0,-1.0)).xy * 0.05;
  lap += texture(state, uv+texel*vec2(-1.0, 1.0)).xy * 0.05;
  lap += texture(state, uv+texel*vec2( 1.0, 1.0)).xy * 0.05;
  lap -= c;
  float a = c.x, b = c.y;
  float rxn = a*b*b;
  float na = a + (1.0*lap.x - rxn + feed*(1.0-a)) * dt;
  float nb = b + (0.5*lap.y + rxn - (kill+feed)*b) * dt;
  if (brush.x >= 0.0) {
    float d = distance(uv*res, brush*res);
    if (d < brushR) nb += brushSign * (1.0 - d/brushR) * 0.85;
  }
  o = vec4(clamp(na,0.0,1.0), clamp(nb,0.0,1.0), 0.0, 1.0);
}`;

// Display: map B concentration + membrane edges to a warm bioluminescent palette.
const SHOW = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D state;
uniform vec2 texel;
uniform float bright, glow, hueShift, beat;
vec3 pal(float t){
  // organic warm→cool cosine palette (plum → rose → amber → cream)
  return vec3(0.34,0.16,0.22) + vec3(0.62,0.42,0.36)*cos(6.2831853*(vec3(1.0,1.05,0.92)*t + vec3(0.08,0.42,0.72)));
}
void main(){
  float b  = texture(state, uv).y;
  float bx = texture(state, uv+vec2(texel.x,0.0)).y - texture(state, uv-vec2(texel.x,0.0)).y;
  float by = texture(state, uv+vec2(0.0,texel.y)).y - texture(state, uv-vec2(0.0,texel.y)).y;
  float edge = length(vec2(bx,by));
  vec3 col = pal(0.12 + clamp(b,0.0,1.0)*0.9 + hueShift);
  col *= smoothstep(0.02, 0.28, b) * 0.92 + 0.08;     // empty tissue stays dark
  col += edge * (6.5 + beat*10.0) * glow * vec3(1.0,0.82,0.6);  // glowing membranes
  col *= bright;
  vec2 d = uv - 0.5;                                   // soft vignette
  col *= 1.0 - dot(d,d) * 0.85;
  col = col / (col + 0.6);                             // filmic-ish rolloff
  o = vec4(pow(col, vec3(0.85)), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error("shader: " + gl.getShaderInfoLog(s) + "\n" + src);
  return s;
}
function program(fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, "p");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error("link: " + gl.getProgramInfoLog(p));
  return p;
}

let progSeed, progSim, progShow, quad, texA, texB, fboA, fboB, simW, simH;

function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo };
}

let seedCounter = 1;
function seed() {
  gl.useProgram(progSeed);
  gl.uniform1f(gl.getUniformLocation(progSeed, "seed"), (seedCounter++ % 1000) * 0.137);
  for (const t of [fboA, fboB]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t);
    gl.viewport(0, 0, simW, simH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function initGL() {
  progSeed = program(SEED);
  progSim = program(SIM);
  progShow = program(SHOW);
  quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  allocSim();
}

function allocSim() {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(cv.clientWidth * DPR);
  cv.height = Math.round(cv.clientHeight * DPR);
  // Simulation grid: capped for steady framerate (the organism doesn't need 4K).
  const scale = Math.min(1, 900 / Math.max(cv.width, cv.height));
  simW = Math.max(64, Math.round(cv.width * scale));
  simH = Math.max(64, Math.round(cv.height * scale));
  const A = makeTarget(simW, simH), B = makeTarget(simW, simH);
  texA = A.tex; fboA = A.fbo; texB = B.tex; fboB = B.fbo;
  seed();
}

let resizeT = null;
window.addEventListener("resize", () => {
  if (!glOK) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(allocSim, 200);
});

// ── live sim parameters (driven by cursor + audio) ──────────────────────────
const sim = {
  feed: 0.038, kill: 0.058,          // smoothed values actually used
  feedT: 0.038, killT: 0.058,        // cursor targets
  beat: 0, bright: 1, glow: 0.5, hueShift: 0,
};
// Persistent cursor-sculpt state + a one-shot brush for audio spore bursts.
const pointer = { down: false, mx: 0.5, my: 0.5, shift: false };
let audioBrush = null;               // {u,v,r} consumed on the next frame

// brush = {u, v, r, sign} in sim-uv space (GL origin bottom-left), or null.
function stepFrame(brush) {
  if (!glOK) return;
  // ease chemistry toward the cursor target
  sim.feed += (sim.feedT - sim.feed) * 0.08;
  sim.kill += (sim.killT - sim.kill) * 0.08;

  const ITER = 10;
  gl.useProgram(progSim);
  const u = (n) => gl.getUniformLocation(progSim, n);
  gl.uniform2f(u("texel"), 1 / simW, 1 / simH);
  gl.uniform2f(u("res"), simW, simH);
  gl.uniform1f(u("dt"), 1.0);
  gl.uniform1f(u("kill"), sim.kill);
  gl.uniform1i(u("state"), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.viewport(0, 0, simW, simH);

  for (let i = 0; i < ITER; i++) {
    // beat-synced feed wobble keeps the tissue breathing
    gl.uniform1f(u("feed"), sim.feed + sim.beat * 0.006);
    // apply the brush only on the first sub-step of the frame
    if (i === 0 && brush) {
      gl.uniform2f(u("brush"), brush.u, brush.v);
      gl.uniform1f(u("brushR"), brush.r);
      gl.uniform1f(u("brushSign"), brush.sign);
    } else {
      gl.uniform2f(u("brush"), -1, -1);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
    gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // swap
    [texA, texB] = [texB, texA];
    [fboA, fboB] = [fboB, fboA];
  }

  // display to screen
  sim.beat *= 0.86;
  gl.useProgram(progShow);
  const s = (n) => gl.getUniformLocation(progShow, n);
  gl.uniform2f(s("texel"), 1 / simW, 1 / simH);
  gl.uniform1f(s("bright"), sim.bright);
  gl.uniform1f(s("glow"), sim.glow);
  gl.uniform1f(s("hueShift"), sim.hueShift);
  gl.uniform1f(s("beat"), sim.beat);
  gl.uniform1i(s("state"), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cv.width, cv.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — cursor: sculpt the tissue + set the chemistry + steer the model
// ════════════════════════════════════════════════════════════════════════════
// Chemistry bands chosen to stay inside Gray-Scott's "alive" regime: moving
// left→right walks worms → mitosis → coral; up→down opens it from tight to riotous.
const FEED_LO = 0.020, FEED_HI = 0.058;
const KILL_LO = 0.045, KILL_HI = 0.063;

const steer = { denoiseT: 0.6, denoise: 0.6, hintT: 0.6, hint: 0.6 };

// Moving the cursor sets the chemistry + model steering; the position is held
// in `pointer` so a held (motionless) press still sculpts every frame.
function cursor(ev) {
  const r = cv.getBoundingClientRect();
  const mx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  const my = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
  pointer.mx = mx; pointer.my = my; pointer.shift = ev.shiftKey;
  // brush ring follows the real pixel position
  ui.brush.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
  ui.brush.classList.add("show");
  ui.brush.classList.toggle("press", pointer.down);
  ui.brush.classList.toggle("dissolve", pointer.down && ev.shiftKey);
  // chemistry (and the readouts)
  sim.feedT = FEED_LO + mx * (FEED_HI - FEED_LO);
  sim.killT = KILL_HI - my * (KILL_HI - KILL_LO);   // up = lower kill = denser
  sim.hueShift = mx * 0.18;
  // model steering
  steer.denoiseT = mx;
  steer.hintT = 1 - my;
  if (wildMode) setWild(false);
}

cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture?.(e.pointerId); pointer.down = true; cursor(e); });
cv.addEventListener("pointermove", (e) => {
  if (e.buttons || e.pointerType === "touch") pointer.down = true;
  cursor(e);
});
cv.addEventListener("pointerup", () => { pointer.down = false; ui.brush.classList.remove("press", "dissolve"); });
cv.addEventListener("pointerleave", () => { pointer.down = false; ui.brush.classList.remove("show", "press", "dissolve"); });

// ── wild mode: the organism sculpts itself (slow drift through the chemistry) ─
let wildMode = false, wildT = 0;
function setWild(on) {
  wildMode = on;
  ui.wild.classList.toggle("on", on);
  ui.wild.textContent = on ? "wild ●" : "wild";
}

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — DEMON session
// ════════════════════════════════════════════════════════════════════════════
const DEPTH = 4, STEPS = 8;
const DEFAULT_PROMPT = "slow organic dub techno, deep and wet";
const PARAM_PERIOD_MS = 80, SLEW = 0.22;

let remote = null, player = null, analyser = null, freqData = null, timeData = null;
let started = false, paramTimer = null, prevBass = 0;

window.__bloom = {
  get denoise() { return steer.denoise; },
  get hint() { return steer.hint; },
  get feed() { return sim.feed; },
  get kill() { return sim.kill; },
  get wsOpen() { return remote?.ws?.readyState === 1; },
  get started() { return started; },
  get glOK() { return glOK; },
};

async function populateFixtures() {
  try {
    const names = await (await fetch("/api/fixtures")).json();
    ui.fixture.innerHTML = "";
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n; o.textContent = n; ui.fixture.appendChild(o);
    }
    setStatus(`${names.length} songs ready · pick one and GROW IT`);
  } catch (e) { setStatus("couldn't load fixtures (" + (e?.message || e) + ")"); }
}

function wireEvents(r) {
  r.addEventListener("slice", (e) => {
    const d = e.detail;
    if (!player || d.epoch !== player.swapCount) return; // epoch guard
    const f = Math.floor(d.startSample);
    if (d.flags === SLICE_FLAG_DELTA) player.addDelta(f, d.audio);
    else player.patch(f, d.audio);
  });
  r.addEventListener("close", () => {
    if (!r.closedByUser) setStatus("disconnected · press reseed→GROW IT to retry");
  });
}

function attachAnalyser() {
  try {
    const ac = player?.ctx;
    const src = player?._masterOut || player?._makeupGain || player?.node;
    if (!ac || !src) return;
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    src.connect(analyser);
  } catch (e) { console.warn("[bloom] analyser tap failed:", e); }
}

function readAudio() {
  if (!analyser) return { bass: 0, treble: 0, rms: 0 };
  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);
  const n = freqData.length, be = Math.floor(n * 0.1), me = Math.floor(n * 0.4);
  let bass = 0, treble = 0;
  for (let i = 0; i < be; i++) bass += freqData[i];
  for (let i = me; i < n; i++) treble += freqData[i];
  bass /= (be * 255); treble /= ((n - me) * 255);
  let rms = 0;
  for (let i = 0; i < timeData.length; i += 4) { const v = (timeData[i] - 128) / 128; rms += v * v; }
  rms = Math.sqrt(rms / (timeData.length / 4));
  return { bass, treble, rms };
}

function pushParams() {
  if (!remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  if (wildMode) {
    wildT += PARAM_PERIOD_MS / 1000;
    const mx = 0.5 + 0.45 * Math.sin(wildT * 0.13);
    const my = 0.5 + 0.45 * Math.sin(wildT * 0.09 + 1.7);
    sim.feedT = FEED_LO + mx * (FEED_HI - FEED_LO);
    sim.killT = KILL_HI - my * (KILL_HI - KILL_LO);
    sim.hueShift = mx * 0.18;
    steer.denoiseT = mx; steer.hintT = 1 - my;
  }
  steer.denoise += (steer.denoiseT - steer.denoise) * SLEW;
  steer.hint += (steer.hintT - steer.hint) * SLEW;
  remote.sendParams({ denoise: steer.denoise, hint_strength: steer.hint }, player?.positionSec ?? 0);
}

async function stopSession() {
  if (paramTimer) { clearInterval(paramTimer); paramTimer = null; }
  const op = player, or = remote;
  player = null; remote = null; analyser = null; started = false;
  try { await op?.close?.(); } catch (e) { console.warn(e); }
  try { or?.close?.(); } catch (e) { console.warn(e); }
}

async function start() {
  if (started) return;
  started = true;
  ui.start.disabled = true; ui.start.textContent = "GROWING…";
  setStatus("waking the model…");
  const name = ui.fixture?.value;
  if (!name) { setStatus("no song selected"); started = false; ui.start.disabled = false; ui.start.textContent = "GROW IT"; return; }

  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
  const config = {
    use_server_fixture: true, fixture_name: name,
    sde: false, depth: DEPTH, steps: STEPS,
    prompt: ui.prompt?.value || DEFAULT_PROMPT,
  };
  try {
    setStatus(`connecting · ${name}`);
    remote = new RemoteBackend(wsUrl, new Float32Array(0), 2, config, { sliceWorkerUrl: "/sdk/sliceDecoder.worker.js" });
    wireEvents(remote);
    await remote.connect();
    setStatus("preparing playback…");
    player = new AudioPlayer({ workletUrl: "/sdk/audio-worklet.js?v=5" });
    await player.init(remote.initialBuffer, remote.channels);
    await player.resume();
    attachAnalyser();
  } catch (e) {
    console.error("[bloom] startup failed:", e);
    setStatus("startup failed: " + (e?.message || e));
    try { remote?.close?.(); } catch {}
    remote = null; player = null; started = false;
    ui.start.disabled = false; ui.start.textContent = "GROW IT";
    return;
  }

  const dur = remote.duration || 0;
  if (dur > 2.0) {
    const m = Math.min(0.4, dur * 0.05);
    remote.sendLoopBand(m, dur - m); player.setLoopBand(m, dur - m);
  } else if (dur > 0.1) { remote.sendLoopBand(0, dur); player.setLoopBand(0, dur); }

  const key = remote.detectedKey ? ` · ${remote.detectedKey}` : "";
  const bpm = remote.detectedBpm ? ` · ${Math.round(remote.detectedBpm)} BPM` : "";
  setStatus(`alive${key}${bpm} · drag to sculpt`);
  ui.start.textContent = "ALIVE";
  ui.reseed.disabled = false; ui.wild.disabled = false;
  ui.panel.classList.add("tucked");
  ui.readout.classList.add("live");
  paramTimer = setInterval(pushParams, PARAM_PERIOD_MS);
}

// ── controls ────────────────────────────────────────────────────────────────
ui.start.addEventListener("click", start);
ui.reseed.addEventListener("click", () => { if (glOK) seed(); });
ui.wild.addEventListener("click", () => setWild(!wildMode));
ui.fixture.addEventListener("change", () => {
  if (remote) { setStatus("song changed · reseed to restart, or keep going"); }
});
ui.prompt.addEventListener("change", () => {
  if (remote && remote.ws?.readyState === WebSocket.OPEN) {
    remote.sendPrompt(ui.prompt.value || DEFAULT_PROMPT);
    setStatus("incantation updated · alive");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4 — the loop: read audio → couple to organism → step → draw
// ════════════════════════════════════════════════════════════════════════════
let idleT = 0;
function frame() {
  requestAnimationFrame(frame);
  if (!glOK) return;
  const a = readAudio();
  const idle = !analyser || a.rms < 0.002;

  if (idle) {
    // gentle autonomous life before the model is summoned
    idleT += 0.016;
    sim.bright = 0.85 + 0.06 * Math.sin(idleT * 0.7);
    sim.glow = 0.42;
  } else {
    sim.bright = 0.78 + a.rms * 1.7 + sim.beat * 0.25;
    sim.glow = 0.32 + a.treble * 0.9;
    // bass kick → spore burst at a wandering point + beat pulse
    if (a.bass - prevBass > 0.09 && a.bass > 0.4) {
      sim.beat = 1;
      audioBrush = {
        u: 0.5 + 0.42 * Math.sin(idleT * 1.3),
        v: 0.5 + 0.42 * Math.cos(idleT * 1.7),
        r: Math.max(simW, simH) * 0.05, sign: 1,
      };
      idleT += 0.21;
    }
    prevBass = a.bass;
  }

  // Pick this frame's brush: the held cursor wins; otherwise spend one audio spore.
  let brush = null;
  if (pointer.down) {
    brush = {
      u: pointer.mx, v: 1 - pointer.my,                 // GL origin is bottom-left
      r: Math.max(simW, simH) * 0.035,
      sign: pointer.shift ? -1 : 1,                     // shift-drag dissolves tissue
    };
  } else if (audioBrush) {
    brush = audioBrush;
  }
  audioBrush = null;

  stepFrame(brush);

  if (ui.rFeed) ui.rFeed.textContent = sim.feed.toFixed(3);
  if (ui.rKill) ui.rKill.textContent = sim.kill.toFixed(3);
}

if (glOK) { initGL(); frame(); }
populateFixtures();
