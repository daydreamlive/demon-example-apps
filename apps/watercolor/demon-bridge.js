// Watercolor → DEMON bridge.
//
// A plain DEMON session: a server-side fixture is loaded via the standard
// handshake (`use_server_fixture`, no PCM upload) and DEMON remixes it
// live. The watercolor canvas is purely a CONTROL SURFACE — physical
// properties of the painting, measured on the GPU, drive the knobs:
//
//   canvas wetness        → `denoise`        (dry sheet = the source song)
//   pigment coverage      → `hint_strength`  (blank paper follows structure)
//   stroke energy         → `feedback`       (vigorous brushing = echo)
//   mean pigment warmth   → `steer_warm`     (crimsons warm / indigos cool)
//   wash lightness        → `steer_bright`   (pale washes brighten)
//   composition sparsity  → `steer_density`  (empty sheet = sparse music)
//   granulation           → `steer_rough`    (gritty texture = gritty sound)
//
// Nothing is hardcoded against the backend: every knob is gated on its
// presence in the served knob manifest and clamped to the manifest's
// min/max (see packages/demon-client/AGENTS.md — discover, don't declare).
// Knobs the manifest doesn't serve render grayed-out and are never sent.

// Shared demon-client browser bundle (packages/demon-client/dist), mounted
// at /sdk/ by the demo server — one SDK copy for every static demo.
import {
  RemoteBackend,
  AudioPlayer,
  SLICE_FLAG_DELTA,
  fetchKnobManifest,
} from "/sdk/demon-client.js";

import { createWatercolor } from "./watercolor.js";

// ── UI handles ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ui = {
  status: $("demon-status"),
  fixture: $("demon-fixture"),
  prompt: $("demon-prompt"),
  start: $("demon-start"),
  reload: $("demon-reload"),
  test: $("demon-test"),
  palette: $("palette"),
  brushSize: $("brush-size"),
  brushWater: $("brush-water"),
  dry: $("brush-dry"),
  clear: $("brush-clear"),
  knobRows: $("knob-rows"),
  glError: $("gl-error"),
  glErrorDetail: $("gl-error-detail"),
};
const setStatus = (s) => {
  if (ui.status) ui.status.textContent = s;
};
const START_LABEL = ui.start?.textContent || "Start";
const setLoading = (loading, status) => {
  if (status) setStatus(status);
  if (ui.start) {
    ui.start.disabled = loading;
    ui.start.textContent = loading ? "Loading..." : START_LABEL;
  }
  if (ui.reload) ui.reload.disabled = loading || !remote;
};

// ── Session config ─────────────────────────────────────────────────────────
// Pingpong/ODE remix: sde:false so the live cover knob is `denoise`.
const DEPTH = 4;
const STEPS = 8;
const DEFAULT_PROMPT = "instrumental ambient electronic, flowing textures";
const PARAM_PERIOD_MS = 80; // analysis readback + knob push rate
const SLEW = 0.22;          // per-tick lerp toward targets, tames jitter

// ── Watercolor pigments ────────────────────────────────────────────────────
// Real-pigment palette spanning the warm/cool and light/dark axes the
// steering mappings listen to. `water` is a pure rewetting brush.
const PIGMENTS = [
  { name: "Cadmium Yellow", rgb: [0.95, 0.76, 0.18] },
  { name: "Burnt Sienna", rgb: [0.62, 0.32, 0.16] },
  { name: "Alizarin Crimson", rgb: [0.70, 0.13, 0.22] },
  { name: "Rose Madder", rgb: [0.85, 0.45, 0.58] },
  { name: "Viridian", rgb: [0.12, 0.48, 0.36] },
  { name: "Prussian Blue", rgb: [0.10, 0.22, 0.38] },
  { name: "Indigo", rgb: [0.16, 0.20, 0.34] },
  { name: "Payne's Grey", rgb: [0.23, 0.26, 0.31] },
  { name: "Lamp Black", rgb: [0.12, 0.12, 0.12] },
  { name: "Clear water", rgb: null, water: true },
];

// ── Painting → knob mappings ───────────────────────────────────────────────
// `compute` turns the latest GPU analysis into a target value; the pump
// slews toward it and clamps to the served manifest range before sending.
// Steering magnitudes stay in the musical 0..12 band (the knobs accept
// ±30 but ~5..15 is the by-ear useful range — see acestep/steering).
const STEER_MAG = 12;
const PAINTED = 0.02; // min coverage before color-derived steering engages
const MAPPINGS = [
  {
    knob: "denoise",
    src: "canvas wetness",
    compute: (a) => 0.85 * Math.min(1, Math.pow(a.wetness * 4.5, 0.7)),
  },
  {
    knob: "hint_strength",
    src: "blank paper",
    compute: (a) => 1 - 0.8 * Math.min(1, a.coverage * 1.2),
  },
  {
    knob: "feedback",
    src: "stroke energy",
    compute: (a) => 0.45 * a.energy,
  },
  {
    knob: "steer_warm",
    src: "pigment warmth",
    bipolar: true,
    compute: (a) => (a.coverage > PAINTED ? (a.warmth - 0.5) * 2 * STEER_MAG : 0),
  },
  {
    knob: "steer_bright",
    src: "wash lightness",
    bipolar: true,
    compute: (a) =>
      a.coverage > PAINTED ? (0.5 - a.paintedDensity) * 2 * (STEER_MAG - 2) : 0,
  },
  {
    knob: "steer_density",
    src: "sparseness",
    bipolar: true,
    compute: (a) => (0.5 - Math.min(1, a.coverage * 1.2)) * 2 * (STEER_MAG - 2),
  },
  {
    knob: "steer_rough",
    src: "granulation",
    bipolar: true,
    compute: (a) => Math.min(STEER_MAG - 2, a.roughness * 45),
  },
];

// ── Live state ─────────────────────────────────────────────────────────────
let sim = null;
let remote = null;
let player = null;
let started = false;
let paramTimer = null;
let testTimers = [];
let manifestKnobs = null;        // /api/knobs (pre-session probe)
let sessionKnobs = null;         // ready.knob_manifest (per-session truth)
let steeringAvailable = null;    // ready.steeringAvailable
let lastAnalysis = null;
const live = {};                 // smoothed values actually sent, by knob name

// ── Knob HUD ───────────────────────────────────────────────────────────────
const rowEls = new Map();
function buildKnobRows() {
  if (!ui.knobRows) return;
  ui.knobRows.innerHTML = "";
  for (const m of MAPPINGS) {
    const row = document.createElement("div");
    row.className = "knob-row";
    row.innerHTML = `
      <div class="labels">
        <span class="name">${m.knob}</span>
        <span class="src">${m.src}</span>
        <span class="val">–</span>
      </div>
      <div class="bar"><div class="fill"></div></div>`;
    ui.knobRows.appendChild(row);
    rowEls.set(m.knob, {
      row,
      val: row.querySelector(".val"),
      fill: row.querySelector(".fill"),
    });
  }
}

function knobSpec(name) {
  return (sessionKnobs ?? manifestKnobs)?.[name] ?? null;
}
function knobActive(m) {
  if (!knobSpec(m.knob)) return false;
  if (m.knob.startsWith("steer_") && steeringAvailable === false) return false;
  return true;
}
function clampToSpec(name, v) {
  const spec = knobSpec(name);
  const lo = spec?.min ?? 0;
  const hi = spec?.max ?? 1;
  return Math.max(lo, Math.min(hi, v));
}
function regateKnobRows() {
  for (const m of MAPPINGS) {
    const els = rowEls.get(m.knob);
    if (!els) continue;
    const active = knobActive(m);
    els.row.classList.toggle("inactive", !active);
    if (!active) els.val.textContent = "n/a";
  }
}
function updateKnobRow(m, v) {
  const els = rowEls.get(m.knob);
  if (!els) return;
  const spec = knobSpec(m.knob);
  const lo = spec?.min ?? 0;
  const hi = spec?.max ?? 1;
  els.val.textContent = v.toFixed(2);
  if (m.bipolar) {
    const half = Math.max(Math.abs(lo), Math.abs(hi), 1e-6);
    const frac = Math.max(-1, Math.min(1, v / half));
    if (frac >= 0) {
      els.fill.style.left = "50%";
      els.fill.style.width = `${frac * 50}%`;
    } else {
      els.fill.style.left = `${50 + frac * 50}%`;
      els.fill.style.width = `${-frac * 50}%`;
    }
  } else {
    const frac = Math.max(0, Math.min(1, (v - lo) / Math.max(hi - lo, 1e-6)));
    els.fill.style.left = "0%";
    els.fill.style.width = `${frac * 100}%`;
  }
}

// ── Pump: measure the painting, slew, push to the model ────────────────────
function pushParams() {
  if (!sim) return;
  lastAnalysis = sim.analysis();

  const raw = {};
  for (const m of MAPPINGS) {
    if (!knobActive(m)) continue;
    const target = clampToSpec(m.knob, m.compute(lastAnalysis));
    const cur = live[m.knob] ?? target;
    const next = cur + (target - cur) * SLEW;
    live[m.knob] = next;
    raw[m.knob] = next;
    updateKnobRow(m, next);
  }

  if (!remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  if (Object.keys(raw).length === 0) return;
  remote.sendParams(raw, player?.positionSec ?? 0);
}

// ── Model output: slices → AudioPlayer ─────────────────────────────────────
function wireEvents(r) {
  r.addEventListener("slice", (e) => {
    const d = e.detail;
    if (!player) return;
    if (d.epoch !== player.swapCount) return; // stale (pre-swap) slice
    const startFrame = Math.floor(d.startSample);
    if (d.flags === SLICE_FLAG_DELTA) player.addDelta(startFrame, d.audio);
    else player.patch(startFrame, d.audio);
  });
  r.addEventListener("close", () => {
    if (!r.closedByUser) setStatus("disconnected - press Reload to retry");
  });
}

// ── Fixtures + manifest ────────────────────────────────────────────────────
async function populateFixtures() {
  if (!ui.fixture) return;
  try {
    const res = await fetch("/api/fixtures");
    const names = await res.json();
    ui.fixture.innerHTML = "";
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      ui.fixture.appendChild(opt);
    }
    setStatus(`${names.length} songs · paint while you listen — press Start`);
  } catch (e) {
    setStatus("couldn't load fixtures (" + (e?.message || e) + ")");
  }
}

async function loadManifest() {
  try {
    const { knobs } = await fetchKnobManifest(false);
    manifestKnobs = knobs;
  } catch (e) {
    console.warn("[demon] couldn't load knob manifest:", e);
    manifestKnobs = null;
  }
  regateKnobRows();
}

// ── Session lifecycle ──────────────────────────────────────────────────────
async function stopSession() {
  // The param pump is a single persistent interval started at boot: it
  // animates the HUD with or without a session and only sends when the
  // WS is open, so teardown leaves it alone.
  stopTest();

  const oldPlayer = player;
  const oldRemote = remote;
  player = null;
  remote = null;
  started = false;
  sessionKnobs = null;
  steeringAvailable = null;
  if (ui.reload) ui.reload.disabled = true;

  try {
    await oldPlayer?.close?.();
  } catch (e) {
    console.warn("[demon] player close:", e);
  }
  try {
    oldRemote?.close?.();
  } catch (e) {
    console.warn("[demon] remote close:", e);
  }
}

async function reloadSession() {
  if (!started && !remote && !player) {
    await start();
    return;
  }
  setLoading(true, "Reloading DEMON model...");
  await stopSession();
  await start();
}

async function start() {
  if (started) return;
  started = true;
  setLoading(true, "Loading DEMON model...");

  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  const fixtureName = ui.fixture?.value;
  if (!fixtureName) {
    setStatus("no song selected");
    setLoading(false);
    started = false;
    return;
  }

  // Standard handshake, server-side variant: the pod loads the fixture
  // waveform from its own cache, so no audio is uploaded. sde:false makes
  // `denoise` the live cover knob.
  const config = {
    use_server_fixture: true,
    fixture_name: fixtureName,
    sde: false,
    depth: DEPTH,
    steps: STEPS,
    prompt: ui.prompt?.value || DEFAULT_PROMPT,
  };

  try {
    setLoading(true, `Connecting to DEMON model... ${fixtureName}`);
    // sliceWorkerUrl: required when loading the prebuilt /sdk/ bundle — the
    // SDK's bundler-analyzed default worker path doesn't exist here.
    remote = new RemoteBackend(wsUrl, new Float32Array(0), 2, config, {
      sliceWorkerUrl: "/sdk/sliceDecoder.worker.js",
    });
    wireEvents(remote);
    await remote.connect();

    setLoading(true, "Preparing playback...");
    player = new AudioPlayer({ workletUrl: "/sdk/audio-worklet.js?v=5" });
    await player.init(remote.initialBuffer, remote.channels);
    await player.resume();
  } catch (e) {
    console.error("[demon] startup failed:", e);
    setStatus("DEMON startup failed: " + (e?.message || e));
    try {
      remote?.close?.();
    } catch {}
    remote = null;
    player = null;
    started = false;
    setLoading(false);
    return;
  }

  // Per-session knob truth: re-gate the HUD on what THIS session serves.
  sessionKnobs = remote.knobManifest?.knobs ?? null;
  steeringAvailable = remote.steeringAvailable;
  regateKnobRows();

  // Loop the song so the remix runs continuously. Trim a small margin off
  // each end so the loop seam avoids the model's intro/outro edge transients.
  const dur = remote.duration || 0;
  if (dur > 2.0) {
    const margin = Math.min(0.4, dur * 0.05);
    remote.sendLoopBand(margin, dur - margin);
    player.setLoopBand(margin, dur - margin);
  } else if (dur > 0.1) {
    remote.sendLoopBand(0, dur);
    player.setLoopBand(0, dur);
  }

  const keyLabel = remote.detectedKey ? ` · ${remote.detectedKey}` : "";
  const bpmLabel = remote.detectedBpm ? ` · ${Math.round(remote.detectedBpm)} BPM` : "";
  setStatus(`live · ${fixtureName}${keyLabel}${bpmLabel} — paint`);
  if (ui.start) ui.start.textContent = "Live";
  if (ui.reload) ui.reload.disabled = false;
}

// ── No-hands test path ─────────────────────────────────────────────────────
// An autopainter sweeps a Lissajous stroke through the palette, with a
// periodic flash-dry, so every painting→knob mapping can be exercised
// without a human (or a GPU backend — the HUD meters move regardless).
let testColorIdx = 0;
function stopTest() {
  if (!testTimers.length) return;
  testTimers.forEach(clearInterval);
  testTimers = [];
  sim?.injectPointer(0, 0, false);
  if (ui.test) ui.test.textContent = "Test";
}
function toggleTest() {
  if (testTimers.length) {
    stopTest();
    return;
  }
  if (!sim) return;
  if (ui.test) ui.test.textContent = "Stop test";

  let t = 0;
  testTimers.push(
    setInterval(() => {
      t += 0.045;
      const x = 0.5 + 0.38 * Math.sin(t * 0.9);
      const y = 0.5 + 0.34 * Math.sin(t * 1.37 + 1.3);
      sim.injectPointer(x, y, true);
    }, 30),
  );
  testTimers.push(
    setInterval(() => {
      testColorIdx = (testColorIdx + 1) % PIGMENTS.length;
      selectSwatch(testColorIdx);
      sim.injectPointer(0, 0, false); // lift between color changes
    }, 6000),
  );
  testTimers.push(
    setInterval(() => sim.dry(), 25000),
  );
}

// ── Palette + studio controls ──────────────────────────────────────────────
const WATER_ONLY_COLOR = [0.97, 0.97, 0.97]; // near-zero absorbance
let swatchEls = [];
function selectSwatch(idx) {
  const pig = PIGMENTS[idx];
  if (!pig || !sim) return;
  swatchEls.forEach((el, i) => el.classList.toggle("active", i === idx));
  if (pig.water) {
    sim.setColor(WATER_ONLY_COLOR);
    sim.setWaterLoad(1);
    if (ui.brushWater) ui.brushWater.value = "1";
  } else {
    sim.setColor(pig.rgb);
    sim.setWaterLoad(parseFloat(ui.brushWater?.value ?? "0.6"));
  }
}
function buildPalette() {
  if (!ui.palette) return;
  ui.palette.innerHTML = "";
  swatchEls = PIGMENTS.map((pig, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "swatch" + (pig.water ? " water" : "");
    el.title = pig.name;
    if (!pig.water) {
      const [r, g, b] = pig.rgb.map((c) => Math.round(c * 255));
      el.style.background = `radial-gradient(circle at 35% 30%, rgb(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)}), rgb(${r},${g},${b}))`;
    }
    el.addEventListener("click", () => selectSwatch(i));
    ui.palette.appendChild(el);
    return el;
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
buildKnobRows();
buildPalette();

try {
  sim = createWatercolor($("paper"));
} catch (e) {
  console.error("[watercolor] init failed:", e);
  if (ui.glError) ui.glError.hidden = false;
  if (ui.glErrorDetail) ui.glErrorDetail.textContent = String(e?.message || e);
  setStatus("paint simulation unavailable: " + (e?.message || e));
}
if (sim) {
  selectSwatch(5); // Prussian Blue
  // The HUD breathes even before a session starts, so the audience can see
  // the painting "play" the (not-yet-connected) desk.
  paramTimer = setInterval(pushParams, PARAM_PERIOD_MS);
}

ui.start?.addEventListener("click", start);
ui.reload?.addEventListener("click", reloadSession);
ui.test?.addEventListener("click", toggleTest);
ui.fixture?.addEventListener("change", () => {
  if (remote) {
    setStatus("song changed - press Reload");
    if (ui.reload) ui.reload.disabled = false;
  }
});
ui.brushSize?.addEventListener("input", (e) => sim?.setBrushSize(parseFloat(e.target.value)));
ui.brushWater?.addEventListener("input", (e) => sim?.setWaterLoad(parseFloat(e.target.value)));
ui.dry?.addEventListener("click", () => sim?.dry());
ui.clear?.addEventListener("click", () => sim?.clear());
// Live prompt: re-send on commit (blur / Enter) so the vibe is editable
// mid-session, not just at connect.
ui.prompt?.addEventListener("change", () => {
  if (remote && remote.ws?.readyState === WebSocket.OPEN) {
    remote.sendPrompt(ui.prompt.value || DEFAULT_PROMPT);
  }
});

populateFixtures();
loadManifest();

// ── Debug / test hooks (headless verification) ─────────────────────────────
window.__demonDebug = {
  get knobs() { return { ...live }; },
  get analysis() { return lastAnalysis; },
  get wsOpen() { return remote?.ws?.readyState === 1; },
  get duration() { return remote?.duration ?? null; },
  get detectedKey() { return remote?.detectedKey ?? null; },
  get detectedBpm() { return remote?.detectedBpm ?? null; },
  get positionSec() { return player?.positionSec ?? null; },
  get started() { return started; },
  get steeringAvailable() { return steeringAvailable; },
};
window.__demonTest = {
  get sim() { return sim; },
  mappings: MAPPINGS,
  selectSwatch,
  pigments: PIGMENTS,
  knobActive,
  clampToSpec,
  analysis: () => sim?.analysis() ?? null,
};
