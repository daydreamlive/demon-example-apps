// Arpeggiator → DEMON bridge (vanilla remix demo).
//
// This is a plain DEMON session: it boots from a NORMAL input song (a
// server-side test fixture, loaded via the standard PCM-upload handshake
// with `use_server_fixture`) and DEMON remixes it live. There is NO
// real-time audio input anywhere — the arpeggiator does not feed the model.
//
// The hand-gesture surface is purely a CONTROL SURFACE. Finger gestures
// are read straight off the MediaPipe landmarks the arp game already tracks
// (`window.__arpGame.hands[i].landmarks`) and mapped to DEMON knobs:
//   - hand #1 (index 0) pinch        → `denoise`         (remix strength)
//   - hand #1 (index 0) palm height  → `steer_density`    (DENSITY steering)
//   - hand #2 (index 1) pinch        → `timbre_strength` (timbre blend)
//   - hand #2 (index 1) palm height  → `steer_rough`     (ROUGH steering)
//   - hands close/apart              → `hint_strength`   (structure adherence)
//
// There is NO Tone.js synth here any more — DEMON renders every sound; the
// hands only steer the model. A no-camera "Test" path sweeps the knobs so the
// whole pipeline can be verified headlessly.

import * as Tone from "https://esm.sh/tone";
// Source credit: Colliding Scopes' arpeggiator
// https://github.com/collidingScopes/arpeggiator
// Shared demon-client browser bundle (packages/demon-client/dist), mounted
// at /sdk/ by the demo server — one SDK copy for every static demo, no
// vendoring. See demos/common/static_site.py.
import {
  RemoteBackend,
  AudioPlayer,
  SLICE_FLAG_DELTA,
} from "/sdk/demon-client.js";

// ── UI handles ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ui = {
  status: $("demon-status"),
  fixture: $("demon-fixture"),
  prompt: $("demon-prompt"),
  start: $("demon-start"),
  reload: $("demon-reload"),
  test: $("demon-test"),
  denoise: $("demon-denoise"),
  density: $("demon-density"),
  timbre: $("demon-timbre"),
  rough: $("demon-rough"),
  structure: $("demon-structure"),
  denoiseMeter: $("demon-denoise-fill"),
  densityMeter: $("demon-density-fill"),
  timbreMeter: $("demon-timbre-fill"),
  roughMeter: $("demon-rough-fill"),
  structureMeter: $("demon-structure-fill"),
  loraA: $("demon-lora-a"),
  loraB: $("demon-lora-b"),
  loraAStrength: $("demon-lora-a-strength"),
  loraBStrength: $("demon-lora-b-strength"),
  loraAStrengthNumber: $("demon-lora-a-strength-number"),
  loraBStrengthNumber: $("demon-lora-b-strength-number"),
  loraAValue: $("demon-lora-a-value"),
  loraBValue: $("demon-lora-b-value"),
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
// Pingpong/ODE remix: sde:false so the live cover knob is `denoise`. depth/steps
// are the usual streaming defaults; the model character rides the gestures.
const DEPTH = 4;
const STEPS = 8;
const DEFAULT_PROMPT = "instrumental electronic music";
const PARAM_PERIOD_MS = 80; // how often gestures are sampled + pushed
const SLEW = 0.25; // per-tick lerp toward gesture target (0..1), tames jitter
const DEFAULT_LORA_STRENGTH = 0.8;
const STRUCTURE_FULL_DIST = 0.34;
const STRUCTURE_ZERO_DIST = 0.78;
const DEFAULT_LORA_SLOTS = [
  { select: "loraA", strength: "loraAStrength", number: "loraAStrengthNumber", value: "loraAValue", name: "Ambient" },
  { select: "loraB", strength: "loraBStrength", number: "loraBStrengthNumber", value: "loraBValue", name: "Deep House" },
];
// Activation-steering alpha at full palm height. The knobs (`steer_density`,
// `steer_rough`) accept -30..30; useful magnitude is ~5..15 by ear, so a
// raised hand tops out at a strong-but-musical 15 and a lowered hand is 0
// (off). See acestep/steering/policy.py.
const STEER_MAX = 15;

// ── Live state ───────────────────────────────────────────────────────────
let remote = null;
let player = null;
let started = false;
let paramTimer = null;
let testTimers = [];
let loraCatalog = [];
let activeLoras = new Map();
let loraCatalogReady = Promise.resolve();

// Knob targets (driven by gestures) and the smoothed values actually sent.
// Idle defaults are musically useful so the remix is audibly "doing something"
// before any gesture: a middling cover with the song's structure followed.
const knob = {
  denoiseTarget: 0.6,
  hintTarget: 0.6,
  denoise: 0.6,
  hint: 0.6,
  // DENSITY / ROUGH activation-steering (hand #1 / hand #2 palm height).
  // Stored 0..1 here and scaled to the knob's alpha range at send time.
  // Default 0 = steering off, so the remix is neutral until a hand reaches up.
  densityTarget: 0.0,
  density: 0.0,
  roughTarget: 0.0,
  rough: 0.0,
  // Timbre = distance between the two hands; only sent once both are visible.
  timbreTarget: 0.0,
  timbre: 0.0,
  lastTimbreSent: -1,
  timbreEngaged: false,
};

// Live debug for headless verification.
window.__demonDebug = {
  get denoise() { return knob.denoise; },
  get structure() { return knob.hint; },
  get density() { return knob.density; },
  get rough() { return knob.rough; },
  get timbre() { return knob.timbre; },
  get wsOpen() { return remote?.ws?.readyState === 1; },
  get duration() { return remote?.duration ?? null; },
  get detectedKey() { return remote?.detectedKey ?? null; },
  get detectedBpm() { return remote?.detectedBpm ?? null; },
  get positionSec() { return player?.positionSec ?? null; },
  get started() { return started; },
};

// ── Tempo lock ──────────────────────────────────────────────────────────────
// Lock the on-screen beat metronome to the input song's detected BPM. (The
// pitch/scale mapping is gone with the synth — hands now steer the model.)
function applySongTempo() {
  if (typeof remote?.detectedBpm === "number" && remote.detectedBpm > 0) {
    try {
      Tone.Transport.bpm.value = remote.detectedBpm;
    } catch {}
  }
}

// ── Gesture reading (off the arp game's MediaPipe landmarks) ───────────────
// pinch: thumb-tip(4) ↔ index-tip(8) distance, scaled like the arp's own
// "velocity" (distance * 5, clamped). Open hand → ~1, pinched shut → ~0.
function pinchOf(lm) {
  const t = lm[4], x = lm[8];
  const dx = t.x - x.x, dy = t.y - x.y;
  return Math.max(0, Math.min(1, Math.sqrt(dx * dx + dy * dy) * 5));
}
// Active control band: positional (palm-height) gestures saturate within a
// CENTERED region rather than at the camera-frame edges, so the operator never
// has to reach to the very top/bottom of the monitor. `ACTIVE_MARGIN` is the
// fraction trimmed off each end — 0.22 = the top & bottom 22% are dead zones
// and the middle ~56% spans the full 0..1 range.
const ACTIVE_MARGIN = 0.22;
function bandRemap(v01) {
  const span = 1 - 2 * ACTIVE_MARGIN;
  return Math.max(0, Math.min(1, (v01 - ACTIVE_MARGIN) / span));
}
// Palm height: landmark 9 (middle-finger MCP) y is 0 at the TOP of frame.
// Invert so raising the hand increases the value, then map through the
// centered active band.
function palmHeight(lm) {
  return bandRemap(1 - lm[9].y);
}

function sampleGestures() {
  const game = window.__arpGame;
  if (!game || !Array.isArray(game.hands)) return;
  const h0 = game.hands[0]?.landmarks || null;
  const h1 = game.hands[1]?.landmarks || null;

  // Only update a target while its hand is visible; otherwise hold the last
  // value so a hand leaving frame doesn't snap a knob to zero.
  if (h0 && h0.length >= 9) {
    knob.denoiseTarget = pinchOf(h0);     // hand #1 pinch  → denoise
    knob.densityTarget = palmHeight(h0);   // hand #1 height → DENSITY
  }
  if (h1 && h1.length >= 9) {
    knob.timbreTarget = pinchOf(h1);      // hand #2 pinch  → timbre
    knob.roughTarget = palmHeight(h1);    // hand #2 height → ROUGH
    knob.timbreEngaged = true;
  }
  // Structure = inverse palm-to-palm distance (needs both hands). Close hands
  // preserve more source structure; spreading hands lets the model drift.
  if (h0 && h1 && h0.length >= 10 && h1.length >= 10) {
    const dx = h0[9].x - h1[9].x, dy = h0[9].y - h1[9].y;
    const dist = Math.hypot(dx, dy);
    const t = (dist - STRUCTURE_FULL_DIST) / (STRUCTURE_ZERO_DIST - STRUCTURE_FULL_DIST);
    knob.hintTarget = 1 - Math.max(0, Math.min(1, t));
  }
}

// ── Pump: slew toward targets and push to the model ────────────────────────
function pushParams() {
  if (!remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  sampleGestures();

  knob.denoise += (knob.denoiseTarget - knob.denoise) * SLEW;
  knob.hint += (knob.hintTarget - knob.hint) * SLEW;
  knob.density += (knob.densityTarget - knob.density) * SLEW;
  knob.rough += (knob.roughTarget - knob.rough) * SLEW;

  const pos = player?.positionSec ?? 0;
  // DENSITY / ROUGH are activation-steering knobs (alpha range); scale the
  // smoothed 0..1 palm heights up to the knob's useful magnitude.
  remote.sendParams(
    {
      denoise: knob.denoise,
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

  // Timbre = inter-hand distance; sent once both hands have engaged it.
  if (knob.timbreEngaged) {
    knob.timbre += (knob.timbreTarget - knob.timbre) * SLEW;
    if (Math.abs(knob.timbre - knob.lastTimbreSent) > 0.01) {
      remote.sendSetTimbreStrength(knob.timbre);
      knob.lastTimbreSent = knob.timbre;
    }
  }

  // Readouts.
  if (ui.denoise) ui.denoise.textContent = knob.denoise.toFixed(2);
  if (ui.density) ui.density.textContent = (knob.density * STEER_MAX).toFixed(1);
  if (ui.timbre) ui.timbre.textContent = knob.timbre.toFixed(2);
  if (ui.rough) ui.rough.textContent = (knob.rough * STEER_MAX).toFixed(1);
  if (ui.structure) ui.structure.textContent = knob.hint.toFixed(2);
  if (ui.denoiseMeter) ui.denoiseMeter.style.width = `${Math.round(knob.denoise * 100)}%`;
  if (ui.densityMeter) ui.densityMeter.style.width = `${Math.round(knob.density * 100)}%`;
  if (ui.timbreMeter) ui.timbreMeter.style.width = `${Math.round(knob.timbre * 100)}%`;
  if (ui.roughMeter) ui.roughMeter.style.width = `${Math.round(knob.rough * 100)}%`;
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

// ── Session lifecycle ──────────────────────────────────────────────────────
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
    console.warn("[demon] couldn't load LoRA catalog:", e);
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

async function stopSession() {
  if (paramTimer) {
    clearInterval(paramTimer);
    paramTimer = null;
  }
  if (testTimers.length) {
    testTimers.forEach(clearInterval);
    testTimers = [];
    if (ui.test) ui.test.textContent = "Test";
  }

  const oldPlayer = player;
  const oldRemote = remote;
  player = null;
  remote = null;
  started = false;
  activeLoras.clear();
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
  await loraCatalogReady;

  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  // Start the Tone audio context + Transport (needs the Start-click gesture).
  // Drives the on-screen beat metronome only; failures here must not block the
  // DEMON session.
  try {
    await window.__arpGame?.musicManager?.start();
  } catch (e) {
    console.warn("[demon] tone start:", e);
  }

  const fixtureName = ui.fixture?.value;
  if (!fixtureName) {
    setStatus("no fixture selected");
    setLoading(false);
    started = false;
    return;
  }

  // Standard PCM-upload handshake, server-side variant: the pod loads the
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

  // Lock the on-screen beat metronome to the detected song BPM.
  applySongTempo();
  enableConfiguredLoras();

  // Use the input track as the timbre reference, matching the default
  // structure source. Hand 2 pinch controls how strongly that self-timbre is
  // preserved in the remix.
  remote.sendSetTimbreStrength(0.6);
  knob.timbre = knob.timbreTarget = knob.lastTimbreSent = 0.6;

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
  setStatus(`live · ${fixtureName}${keyLabel}${bpmLabel}`);
  if (ui.start) ui.start.textContent = "Live";
  if (ui.reload) ui.reload.disabled = false;
  paramTimer = setInterval(pushParams, PARAM_PERIOD_MS);
}

// ── No-camera test path ────────────────────────────────────────────────────
// Sweeps every DEMON knob (offset phases so they move independently) so the
// full pipeline can be exercised without a camera. Drives the same knob
// targets the gestures would — including DENSITY and ROUGH steering.
function toggleTest() {
  if (testTimers.length) {
    testTimers.forEach(clearInterval);
    testTimers = [];
    ui.test.textContent = "Test";
    return;
  }
  if (!started || !remote) {
    setStatus("press Start first");
    return;
  }
  ui.test.textContent = "Stop test";
  knob.timbreEngaged = true;

  let t = 0;
  testTimers.push(
    setInterval(() => {
      t += 0.05;
      knob.denoiseTarget = Math.sin(t) * 0.5 + 0.5;
      knob.timbreTarget = Math.sin(t * 0.6 + 1.0) * 0.5 + 0.5;
      knob.hintTarget = Math.sin(t * 0.4 + 2.0) * 0.5 + 0.5;
      knob.densityTarget = Math.sin(t * 0.3 + 3.0) * 0.5 + 0.5;
      knob.roughTarget = Math.sin(t * 0.5 + 4.0) * 0.5 + 0.5;
    }, 100),
  );
}

// Test hooks: pure helpers + the gesture sampler + the live knob state, so a
// headless harness can verify the gesture→knob mapping (denoise, density,
// rough, timbre, structure) without a GPU backend or a camera.
window.__demonTest = { pinchOf, palmHeight, sampleGestures, knob };

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
