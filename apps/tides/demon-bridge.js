// DEMON TIDES → DEMON bridge.
//
// A plain DEMON remix session (no real-time audio input): it boots from a
// server-side test fixture via the standard PCM-upload handshake with
// `use_server_fixture`, and DEMON remixes that song live. The flow-field canvas
// (field.js, exposed as `window.__tidesField`) is purely a CONTROL SURFACE plus
// a picture of the output — it feeds nothing to the model.
//
// Pointer → DEMON knobs:
//   pointer X            → `denoise`         (remix amount)
//   pointer height (1-Y) → `steer_density`   (DENSITY activation steering)
//   pointer speed        → `steer_rough`     (ROUGH steering — fast = grittier)
//   hold (pointer down)  → `timbre_strength` (bends timbre up while held)
//   wheel accumulator    → `hint_strength`   (structure adherence)
//
// DEMON renders every sound; the field's `audioProvider` analyser tap reads the
// live output back for the visuals. A no-camera "Test" path sweeps the same
// knobs so the whole pipeline can be verified without a pointer.

import { Field } from "./field.js";
// Shared demon-client browser bundle (packages/demon-client/dist), mounted at
// /sdk/ by the demo server — one SDK copy for every static demo, no vendoring.
import {
  RemoteBackend,
  AudioPlayer,
  SLICE_FLAG_DELTA,
} from "/sdk/demon-client.js";

// ── UI handles ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ui = {
  status: $("tides-status"),
  fixture: $("tides-fixture"),
  prompt: $("tides-prompt"),
  start: $("tides-start"),
  reload: $("tides-reload"),
  test: $("tides-test"),
  remix: $("tides-remix"),
  density: $("tides-density"),
  rough: $("tides-rough"),
  timbre: $("tides-timbre"),
  structure: $("tides-structure"),
  remixMeter: $("tides-remix-fill"),
  densityMeter: $("tides-density-fill"),
  roughMeter: $("tides-rough-fill"),
  timbreMeter: $("tides-timbre-fill"),
  structureMeter: $("tides-structure-fill"),
  loraA: $("tides-lora-a"),
  loraB: $("tides-lora-b"),
  loraAStrength: $("tides-lora-a-strength"),
  loraBStrength: $("tides-lora-b-strength"),
  loraAStrengthNumber: $("tides-lora-a-strength-number"),
  loraBStrengthNumber: $("tides-lora-b-strength-number"),
  loraAValue: $("tides-lora-a-value"),
  loraBValue: $("tides-lora-b-value"),
  loading: $("loading-overlay"),
  loadingMsg: $("loading-message"),
};
const setStatus = (s) => {
  if (ui.status) ui.status.textContent = s;
};
const START_LABEL = ui.start?.textContent || "Start";
const setLoading = (loading, status) => {
  if (status) setStatus(status);
  if (ui.loadingMsg && status) ui.loadingMsg.textContent = status;
  if (ui.loading) ui.loading.hidden = !loading;
  if (ui.start) {
    ui.start.disabled = loading;
    ui.start.textContent = loading ? "Loading..." : START_LABEL;
  }
  if (ui.reload) ui.reload.disabled = loading || !remote;
};

// ── Visual / control surface ───────────────────────────────────────────────
const field = new Field($("tides-canvas"));
field.start();
window.__tidesField = field;

// ── Session config ─────────────────────────────────────────────────────────
// Pingpong/ODE remix: sde:false so the live cover knob is `denoise`.
const DEPTH = 4;
const STEPS = 8;
const DEFAULT_PROMPT = "instrumental electronic music";
const PARAM_PERIOD_MS = 80; // gesture sample + push cadence
const SLEW = 0.25; // per-tick lerp toward target (tames jitter)
const DEFAULT_LORA_STRENGTH = 0.8;
// steer_density / steer_rough accept -30..30; ~5..15 is musical by ear.
const STEER_MAX = 15;
const TIMBRE_REST = 0.35; // baseline self-timbre when not holding
const DEFAULT_LORA_SLOTS = [
  { select: "loraA", strength: "loraAStrength", number: "loraAStrengthNumber", value: "loraAValue", name: "Ambient" },
  { select: "loraB", strength: "loraBStrength", number: "loraBStrengthNumber", value: "loraBValue", name: "Deep House" },
];

// ── Live state ───────────────────────────────────────────────────────────
let remote = null;
let player = null;
let started = false;
let paramTimer = null;
let testTimer = null;
let loraCatalog = [];
let activeLoras = new Map();
let loraCatalogReady = Promise.resolve();
let testState = null;

// Knob targets and the smoothed values actually sent. Idle defaults are
// musically useful so the remix is audibly doing something before any gesture.
const knob = {
  remixTarget: 0.6, densityTarget: 0.0, roughTarget: 0.0,
  timbreTarget: TIMBRE_REST, hintTarget: 0.6,
  remix: 0.6, density: 0.0, rough: 0.0, timbre: TIMBRE_REST, hint: 0.6,
  lastTimbreSent: -1,
};

// Live debug for headless verification.
window.__demonDebug = {
  get remix() { return knob.remix; },
  get density() { return knob.density; },
  get rough() { return knob.rough; },
  get timbre() { return knob.timbre; },
  get structure() { return knob.hint; },
  get wsOpen() { return remote?.ws?.readyState === 1; },
  get duration() { return remote?.duration ?? null; },
  get detectedKey() { return remote?.detectedKey ?? null; },
  get detectedBpm() { return remote?.detectedBpm ?? null; },
  get positionSec() { return player?.positionSec ?? null; },
  get started() { return started; },
};

// ── Pointer → targets, slew, push to model ─────────────────────────────────
function sampleGestures() {
  if (testState) return; // Test path drives targets directly.
  const p = field.pointer;
  if (!p) return;
  knob.remixTarget = p.x;                 // pointer X     → denoise
  knob.densityTarget = 1 - p.y;           // pointer height → density steer
  knob.roughTarget = p.speed;             // pointer speed → rough steer
  knob.timbreTarget = p.down ? 1.0 : TIMBRE_REST; // hold → timbre bend
  knob.hintTarget = field.structure;      // wheel → structure
}

function pushParams() {
  if (!remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  sampleGestures();

  knob.remix += (knob.remixTarget - knob.remix) * SLEW;
  knob.density += (knob.densityTarget - knob.density) * SLEW;
  knob.rough += (knob.roughTarget - knob.rough) * SLEW;
  knob.hint += (knob.hintTarget - knob.hint) * SLEW;

  const pos = player?.positionSec ?? 0;
  remote.sendParams(
    {
      denoise: knob.remix,
      hint_strength: knob.hint,
      steer_density: knob.density * STEER_MAX,
      steer_rough: knob.rough * STEER_MAX,
      ...Object.fromEntries(
        DEFAULT_LORA_SLOTS
          .map((slot) => [ui[slot.select]?.value, loraStrength(slot)])
          .filter(([id]) => id)
          .map(([id, strength]) => [`lora_str_${id}`, strength]),
      ),
    },
    pos,
  );

  // Timbre is a discrete sender; only push when it actually moves.
  knob.timbre += (knob.timbreTarget - knob.timbre) * SLEW;
  if (Math.abs(knob.timbre - knob.lastTimbreSent) > 0.01) {
    remote.sendSetTimbreStrength(knob.timbre);
    knob.lastTimbreSent = knob.timbre;
  }

  // Readouts.
  if (ui.remix) ui.remix.textContent = knob.remix.toFixed(2);
  if (ui.density) ui.density.textContent = (knob.density * STEER_MAX).toFixed(1);
  if (ui.rough) ui.rough.textContent = (knob.rough * STEER_MAX).toFixed(1);
  if (ui.timbre) ui.timbre.textContent = knob.timbre.toFixed(2);
  if (ui.structure) ui.structure.textContent = knob.hint.toFixed(2);
  if (ui.remixMeter) ui.remixMeter.style.width = `${Math.round(knob.remix * 100)}%`;
  if (ui.densityMeter) ui.densityMeter.style.width = `${Math.round(knob.density * 100)}%`;
  if (ui.roughMeter) ui.roughMeter.style.width = `${Math.round(knob.rough * 100)}%`;
  if (ui.timbreMeter) ui.timbreMeter.style.width = `${Math.round(knob.timbre * 100)}%`;
  if (ui.structureMeter) ui.structureMeter.style.width = `${Math.round(knob.hint * 100)}%`;
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

// Attach a passive analyser to the player output so the field reacts to the
// real audio. `player.node` is the worklet/script source; tapping it adds a
// read-only branch (the analyser is not connected onward, so no double audio).
function attachAnalyser() {
  try {
    const ctx = player?.ctx;
    if (!ctx || !player?.node) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    player.node.connect(analyser);
    const td = new Uint8Array(analyser.fftSize);
    const fd = new Uint8Array(analyser.frequencyBinCount);
    field.audioProvider = () => {
      analyser.getByteTimeDomainData(td);
      let sum = 0;
      for (let i = 0; i < td.length; i++) {
        const v = (td[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.sqrt(sum / td.length);
      analyser.getByteFrequencyData(fd);
      const nb = Math.max(1, Math.floor(fd.length * 0.08));
      let b = 0;
      for (let i = 0; i < nb; i++) b += fd[i];
      return { level, bass: b / nb / 255 };
    };
  } catch (e) {
    console.warn("[tides] analyser tap failed:", e);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
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
    setStatus(`${names.length} fixtures · pick a song and press Start`);
  } catch (e) {
    setStatus("couldn't load fixtures (" + (e?.message || e) + ")");
  }
}

// ── LoRA catalog ────────────────────────────────────────────────────────────
function loraLabel(entry) {
  return entry?.metadata?.name || entry?.name || entry?.id || "";
}
function findLoraId(name, slotIndex) {
  const needle = name.toLowerCase();
  const exact = loraCatalog.find((entry) =>
    entry.id?.toLowerCase() === needle ||
    entry.name?.toLowerCase() === needle ||
    entry.metadata?.name?.toLowerCase() === needle
  );
  if (exact) return exact.id;
  const compact = needle.replace(/[\s_-]+/g, "");
  const fuzzy = loraCatalog.find((entry) => {
    const labels = [entry.id, entry.name, entry.metadata?.name].filter(Boolean);
    return labels.some((label) => label.toLowerCase().replace(/[\s_-]+/g, "").includes(compact));
  });
  return fuzzy?.id || loraCatalog[slotIndex]?.id || "";
}
function loraStrength(slot) {
  const input = ui[slot.strength];
  const value = Number.parseFloat(input?.value || String(DEFAULT_LORA_STRENGTH));
  return Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : DEFAULT_LORA_STRENGTH;
}
function syncLoraStrengthUi(slot, value) {
  const v = Math.max(0, Math.min(2, Number.parseFloat(value) || 0));
  if (ui[slot.strength]) ui[slot.strength].value = String(v);
  if (ui[slot.number]) ui[slot.number].value = v.toFixed(2);
  if (ui[slot.value]) ui[slot.value].textContent = v.toFixed(2);
}
function sendLoraStrength(id, strength) {
  if (!id || !remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  remote.sendParams({ [`lora_str_${id}`]: strength }, player?.positionSec ?? 0);
}
function enableLoraSlot(slot, previousId = "") {
  const id = ui[slot.select]?.value || "";
  const strength = loraStrength(slot);
  if (previousId && previousId !== id) {
    remote?.sendDisableLora(previousId);
    activeLoras.delete(slot.select);
  }
  if (!id || !remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  remote.sendEnableLora(id, strength);
  sendLoraStrength(id, strength);
  activeLoras.set(slot.select, id);
}
function enableConfiguredLoras() {
  for (const slot of DEFAULT_LORA_SLOTS) enableLoraSlot(slot);
}
async function populateLoras() {
  try {
    const res = await fetch("/api/loras");
    const data = await res.json();
    loraCatalog = Array.isArray(data?.loras) ? data.loras : [];
  } catch (e) {
    console.warn("[tides] couldn't load LoRA catalog:", e);
    loraCatalog = [
      { id: "ambient-acestep1.5-v1", name: "Ambient" },
      { id: "deep_house-acestep1.5-v1", name: "Deep House" },
    ];
  }
  for (let i = 0; i < DEFAULT_LORA_SLOTS.length; i++) {
    const slot = DEFAULT_LORA_SLOTS[i];
    const select = ui[slot.select];
    if (!select) continue;
    select.innerHTML = "";
    for (const entry of loraCatalog) {
      const opt = document.createElement("option");
      opt.value = entry.id;
      opt.textContent = loraLabel(entry);
      select.appendChild(opt);
    }
    select.value = findLoraId(slot.name, i);
    syncLoraStrengthUi(slot, DEFAULT_LORA_STRENGTH);
  }
}

// ── Session lifecycle ──────────────────────────────────────────────────────
async function stopSession() {
  if (paramTimer) { clearInterval(paramTimer); paramTimer = null; }
  if (testTimer) { clearInterval(testTimer); testTimer = null; testState = null; if (ui.test) ui.test.textContent = "Test"; }

  const oldPlayer = player;
  const oldRemote = remote;
  player = null;
  remote = null;
  started = false;
  activeLoras.clear();
  field.audioProvider = null;
  if (ui.reload) ui.reload.disabled = true;

  try { await oldPlayer?.close?.(); } catch (e) { console.warn("[tides] player close:", e); }
  try { oldRemote?.close?.(); } catch (e) { console.warn("[tides] remote close:", e); }
}

async function reloadSession() {
  if (!started && !remote && !player) { await start(); return; }
  setLoading(true, "Reloading DEMON model...");
  await stopSession();
  await start();
}

async function start() {
  if (started) return;
  started = true;
  setLoading(true, "Loading DEMON model...");
  await loraCatalogReady;

  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  const fixtureName = ui.fixture?.value;
  if (!fixtureName) {
    setStatus("no fixture selected");
    setLoading(false);
    started = false;
    return;
  }

  // Standard PCM-upload handshake, server-fixture variant: the pod loads the
  // fixture waveform from its own cache, so no audio is uploaded. sde:false
  // makes `denoise` the live cover knob.
  const config = {
    use_server_fixture: true,
    fixture_name: fixtureName,
    lora: true,
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
    attachAnalyser();
  } catch (e) {
    console.error("[tides] startup failed:", e);
    setStatus("DEMON startup failed: " + (e?.message || e));
    try { remote?.close?.(); } catch {}
    remote = null;
    player = null;
    started = false;
    setLoading(false);
    return;
  }

  enableConfiguredLoras();

  // Use the input track as the timbre reference (matches the structure source);
  // holding the pointer bends how strongly that self-timbre is preserved.
  remote.sendSetTimbreStrength(TIMBRE_REST);
  knob.timbre = knob.timbreTarget = knob.lastTimbreSent = TIMBRE_REST;

  // Loop the song continuously. Trim a small margin off each end so the seam
  // avoids the model's intro/outro edge transients.
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
  setStatus(`live · ${fixtureName}${keyLabel}${bpmLabel}`);
  setLoading(false);
  if (ui.start) ui.start.textContent = "Live";
  if (ui.reload) ui.reload.disabled = false;
  paramTimer = setInterval(pushParams, PARAM_PERIOD_MS);
}

// ── No-pointer test path ────────────────────────────────────────────────────
// Sweeps every DEMON knob (offset phases so they move independently) so the
// full pipeline can be exercised without a pointer.
function toggleTest() {
  if (testTimer) {
    clearInterval(testTimer);
    testTimer = null;
    testState = null;
    ui.test.textContent = "Test";
    return;
  }
  if (!started || !remote) { setStatus("press Start first"); return; }
  ui.test.textContent = "Stop test";
  testState = { t: 0 };
  testTimer = setInterval(() => {
    testState.t += 0.05;
    const t = testState.t;
    knob.remixTarget = Math.sin(t) * 0.5 + 0.5;
    knob.densityTarget = Math.sin(t * 0.3 + 3.0) * 0.5 + 0.5;
    knob.roughTarget = Math.sin(t * 0.5 + 4.0) * 0.5 + 0.5;
    knob.timbreTarget = Math.sin(t * 0.6 + 1.0) * 0.5 + 0.5;
    knob.hintTarget = Math.sin(t * 0.4 + 2.0) * 0.5 + 0.5;
  }, 100);
}

// Test hooks for a headless harness: the gesture sampler + live knob state.
window.__demonTest = { sampleGestures, knob, field };

// ── Wiring ───────────────────────────────────────────────────────────────
ui.start?.addEventListener("click", start);
ui.reload?.addEventListener("click", reloadSession);
ui.test?.addEventListener("click", toggleTest);
ui.fixture?.addEventListener("change", () => {
  if (remote) {
    setStatus("track changed - press Reload");
    if (ui.reload) ui.reload.disabled = false;
  }
});
for (const slot of DEFAULT_LORA_SLOTS) {
  ui[slot.select]?.addEventListener("change", () => {
    const previousId = activeLoras.get(slot.select) || "";
    enableLoraSlot(slot, previousId);
  });
  const onStrength = (e) => {
    syncLoraStrengthUi(slot, e.target.value);
    sendLoraStrength(ui[slot.select]?.value || "", loraStrength(slot));
  };
  ui[slot.strength]?.addEventListener("input", onStrength);
  ui[slot.number]?.addEventListener("input", onStrength);
}
// Live prompt: re-send on commit (blur / Enter) so the genre is editable
// mid-session, not just at connect.
ui.prompt?.addEventListener("change", () => {
  if (remote && remote.ws?.readyState === WebSocket.OPEN) {
    remote.sendPrompt(ui.prompt.value || DEFAULT_PROMPT);
  }
});

populateFixtures();
loraCatalogReady = populateLoras();
