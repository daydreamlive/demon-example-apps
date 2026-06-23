// Face → DEMON bridge (DEMON Visage).
//
// A plain DEMON remix session: it boots from a NORMAL input song (a server
// fixture, loaded via the standard PCM-upload handshake with
// `use_server_fixture`) and DEMON remixes it live. There is NO real-time
// audio input — the face is a pure CONTROL SURFACE. Six facial movements are
// read off the MediaPipe blendshapes/landmarks published by face.js
// (`window.__faceTracker`) and mapped to DEMON knobs:
//
//   mouth open   (jawOpen)        → denoise       REMIX amount
//   smile        (mouthSmile)     → steer_bright  BRIGHTNESS
//   raise brows  (browInnerUp)    → feedback      ECHO / wash
//   furrow brows (browDown)       → steer_rough   GRIT
//   turn head    (yaw)            → steer_warm     WARMTH (bipolar)
//   nod head     (pitch)          → hint_strength STRUCTURE lock
//
// A no-camera "Test" path sweeps synthetic expressions so the whole pipeline
// can be verified headlessly, and `window.__demonFaceTest` exposes the pure
// mapping helpers + live knob state for the same reason.

import {
  RemoteBackend,
  AudioPlayer,
  SLICE_FLAG_DELTA,
  // Canonical, hand-authored control copy from the SDK — so every parameter
  // label/tooltip here matches what the engine, MIDI map, and the rest of the
  // DEMON UI call it, instead of invented names.
  displayNameFor,
  describeControl,
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
  srcCamera: $("src-camera"),
  srcVideo: $("src-video"),
  faceState: $("face-state"),
  remixSlider: $("remix-slider"),
  remixVal: $("remix-val"),
  remixLabel: $("remix-label"),
  loraA: $("demon-lora-a"),
  loraB: $("demon-lora-b"),
  loraAStrength: $("demon-lora-a-strength"),
  loraBStrength: $("demon-lora-b-strength"),
  loraAValue: $("demon-lora-a-value"),
  loraBValue: $("demon-lora-b-value"),
};
const setStatus = (s) => { if (ui.status) ui.status.textContent = s; };
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
const DEPTH = 4;
const STEPS = 8;
const DEFAULT_PROMPT = "instrumental electronic music";
const PARAM_PERIOD_MS = 80; // gesture sample + push cadence
const SLEW = 0.22; // per-tick lerp toward target (tames blendshape jitter)
const DEFAULT_LORA_STRENGTH = 0.8;
const STEER_MAX = 13; // activation-steering alpha at full expression
const DEFAULT_LORA_SLOTS = [
  { select: "loraA", strength: "loraAStrength", value: "loraAValue", name: "Phonk" },
  { select: "loraB", strength: "loraBStrength", value: "loraBValue", name: "Lo-Fi" },
];

// ── Face → knob mapping (pure; unit-tested headlessly) ──────────────────────
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Clamped linear remap.
export function remap(v, inLo, inHi, outLo, outHi) {
  return outLo + clamp01((v - inLo) / (inHi - inLo)) * (outHi - outLo);
}
// Bipolar shaping with a centered dead zone, returns [-1, 1].
export function bipolar(v, dead = 0.1) {
  const a = Math.abs(v);
  if (a < dead) return 0;
  return Math.sign(v) * Math.min(1, (a - dead) / (1 - dead));
}

const avg = (a, b) => ((a || 0) + (b || 0)) / 2;
// Signed difference of two 0..1 scores, scaled to ~[-1, 1].
const sdiff = (a, b, full) => Math.max(-1, Math.min(1, ((a || 0) - (b || 0)) / full));

// The face FEATURE palette — the selectable INPUT side. MediaPipe exposes 52
// blendshapes plus head pose; this is a curated set of the expressive,
// well-tracked ones, each calibrated to a canonical signal: unipolar features
// yield 0..1 (resting = 0), bipolar features yield -1..1 (resting = 0).
// REMIX is deliberately NOT here — it is a manual knob, since a face can't
// hold a steady remix level. The face shapes the CHARACTER of the remix, and
// BOTH which movement and which parameter it drives are user-assignable.
export const FEATURES = [
  { id: "mouthOpen", label: "Mouth open", bipolar: false, read: (b, p) => remap(b.jawOpen || 0, 0.04, 0.55, 0, 1) },
  { id: "smile", label: "Smile", bipolar: false, read: (b, p) => remap(avg(b.mouthSmileLeft, b.mouthSmileRight), 0.08, 0.7, 0, 1) },
  { id: "frown", label: "Frown", bipolar: false, read: (b, p) => remap(avg(b.mouthFrownLeft, b.mouthFrownRight), 0.05, 0.5, 0, 1) },
  { id: "pucker", label: "Pucker / kiss", bipolar: false, read: (b, p) => remap(b.mouthPucker || 0, 0.1, 0.85, 0, 1) },
  { id: "funnel", label: "Mouth funnel", bipolar: false, read: (b, p) => remap(b.mouthFunnel || 0, 0.08, 0.7, 0, 1) },
  { id: "browRaise", label: "Brow raise", bipolar: false, read: (b, p) => remap(b.browInnerUp || 0, 0.12, 0.75, 0, 1) },
  { id: "browFurrow", label: "Brow furrow", bipolar: false, read: (b, p) => remap(avg(b.browDownLeft, b.browDownRight), 0.1, 0.6, 0, 1) },
  { id: "squint", label: "Eye squint", bipolar: false, read: (b, p) => remap(avg(b.eyeSquintLeft, b.eyeSquintRight), 0.1, 0.7, 0, 1) },
  { id: "eyesWide", label: "Eyes wide", bipolar: false, read: (b, p) => remap(avg(b.eyeWideLeft, b.eyeWideRight), 0.04, 0.4, 0, 1) },
  { id: "cheekPuff", label: "Cheek puff", bipolar: false, read: (b, p) => remap(b.cheekPuff || 0, 0.05, 0.6, 0, 1) },
  { id: "sneer", label: "Nose sneer", bipolar: false, read: (b, p) => remap(avg(b.noseSneerLeft, b.noseSneerRight), 0.05, 0.5, 0, 1) },
  { id: "jawSide", label: "Jaw L↔R", bipolar: true, read: (b, p) => sdiff(b.jawRight, b.jawLeft, 0.4) },
  { id: "smirk", label: "Smirk L↔R", bipolar: true, read: (b, p) => sdiff(b.mouthSmileRight, b.mouthSmileLeft, 0.4) },
  { id: "headTurn", label: "Head turn", bipolar: true, read: (b, p) => bipolar(p.yaw, 0.1) },
  { id: "headNod", label: "Head nod", bipolar: true, read: (b, p) => bipolar(p.pitch, 0.1) },
  { id: "headTilt", label: "Head tilt", bipolar: true, read: (b, p) => bipolar((p.roll || 0) / 0.5, 0.1) },
];
export const FEATURE_BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f]));

// The assignable DEMON targets — the OUTPUT side. Each is a REAL engine knob;
// its `label` and tooltip come straight from the SDK's control copy
// (displayNameFor / describeControl), so the name shown is the actual
// parameter name. `lo`/`hi` are the knob range; bipolar targets are symmetric
// and take the feature's signed value. `neutral` is sent when nothing drives
// the target, so unmapping a parameter returns it to rest.
function makeTarget(knob, opts) {
  return {
    knob,
    label: displayNameFor(knob),
    desc: describeControl(knob) || "",
    bipolar: opts.bipolar,
    lo: opts.lo,
    hi: opts.hi,
    neutral: opts.neutral,
    fmt: opts.fmt,
  };
}
const STEER_FMT = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);
export const TARGETS = {
  off: { label: "— off —" },
  steer_bright: makeTarget("steer_bright", { bipolar: false, lo: 0, hi: STEER_MAX, neutral: 0, fmt: (v) => v.toFixed(1) }),
  steer_warm: makeTarget("steer_warm", { bipolar: true, lo: -STEER_MAX, hi: STEER_MAX, neutral: 0, fmt: STEER_FMT }),
  steer_rough: makeTarget("steer_rough", { bipolar: false, lo: 0, hi: STEER_MAX, neutral: 0, fmt: (v) => v.toFixed(1) }),
  steer_density: makeTarget("steer_density", { bipolar: true, lo: -STEER_MAX, hi: STEER_MAX, neutral: 0, fmt: STEER_FMT }),
  feedback: makeTarget("feedback", { bipolar: false, lo: 0, hi: 0.85, neutral: 0, fmt: (v) => v.toFixed(2) }),
  hint_strength: makeTarget("hint_strength", { bipolar: false, lo: 1.0, hi: 0.25, neutral: 0.6, fmt: (v) => v.toFixed(2) }),
  shift: makeTarget("shift", { bipolar: false, lo: 1.5, hi: 5.5, neutral: 3.5, fmt: (v) => v.toFixed(2) }),
};
const SENT_KNOBS = Object.values(TARGETS).filter((t) => t.knob);

// Read one feature's calibrated signal from a tracker blend/pose pair.
export function readFeature(featureId, blend, pose) {
  const f = FEATURE_BY_ID[featureId];
  if (!f) return 0;
  return f.read(blend || {}, pose || { yaw: 0, pitch: 0, roll: 0 });
}

// The knob value a target takes for a given feature signal. `featureBipolar`
// decides whether a unipolar target reads the signed value's magnitude.
export function targetValue(targetId, signal, featureBipolar) {
  const t = TARGETS[targetId];
  if (!t || !t.knob) return null;
  if (t.bipolar) {
    const mid = (t.lo + t.hi) / 2;
    const half = (t.hi - t.lo) / 2;
    return mid + Math.max(-1, Math.min(1, signal)) * half;
  }
  const intensity = featureBipolar ? Math.abs(signal) : clamp01(signal);
  return t.lo + intensity * (t.hi - t.lo);
}

// Resolve the slot list into a knob→value dict. Each target is claimed by the
// FIRST slot (in order) assigned to it; unclaimed targets emit their neutral
// so the parameter rests. Pure: tests call this directly.
export function computeKnobTargets(slots, blend, pose) {
  const claim = {}; // targetId → { signal, bipolar }
  for (const slot of slots || []) {
    const f = FEATURE_BY_ID[slot.feature];
    const tid = slot.target;
    if (!f || !tid || tid === "off" || !TARGETS[tid]?.knob || claim[tid]) continue;
    claim[tid] = { signal: f.read(blend || {}, pose || {}), bipolar: f.bipolar };
  }
  const out = {};
  for (const [tid, t] of Object.entries(TARGETS)) {
    if (!t.knob) continue;
    const c = claim[tid];
    out[t.knob] = c ? targetValue(tid, c.signal, c.bipolar) : t.neutral;
  }
  return out;
}

// ── Live state ───────────────────────────────────────────────────────────
let remote = null;
let player = null;
let started = false;
let paramTimer = null;
let testTimer = null;
let testT = 0;
let loraCatalog = [];
let activeLoras = new Map();
let loraCatalogReady = Promise.resolve();
let synth = null; // {blend, pose} when Test mode overrides the live tracker

// A "slot" pairs a face FEATURE (input) with a DEMON TARGET (output). Both
// ends are user-assignable, and slots can be added/removed.
const DEFAULT_SLOTS = [
  { feature: "mouthOpen", target: "steer_density" },
  { feature: "smile", target: "steer_bright" },
  { feature: "browRaise", target: "feedback" },
  { feature: "browFurrow", target: "steer_rough" },
  { feature: "headTurn", target: "steer_warm" },
  { feature: "headNod", target: "hint_strength" },
];
const MAX_SLOTS = 10;
const SLOTS_KEY = "visage.slots.v3";
function loadSlots() {
  try {
    const saved = JSON.parse(localStorage.getItem(SLOTS_KEY) || "null");
    if (Array.isArray(saved) && saved.length) {
      return saved
        .filter((s) => FEATURE_BY_ID[s.feature] && (s.target === "off" || TARGETS[s.target]))
        .map((s) => ({ feature: s.feature, target: s.target }));
    }
  } catch {}
  return DEFAULT_SLOTS.map((s) => ({ ...s }));
}
function saveSlots() {
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); } catch {}
}
let slots = loadSlots();

// Last sampled face (held when the face leaves frame) so off-slot meters and
// re-mapped slots read a current signal.
let lastFace = { blend: {}, pose: { yaw: 0, pitch: 0, roll: 0 } };
// Manual REMIX (denoise) — decoupled from the face.
let remixValue = 0.6;
// Smoothed knob values actually sent.
const knob = { denoise: remixValue };
for (const t of SENT_KNOBS) knob[t.knob] = t.neutral;

window.__demonDebug = {
  get knob() { return { ...knob }; },
  get slots() { return slots.map((s) => ({ ...s })); },
  get remix() { return remixValue; },
  get wsOpen() { return remote?.ws?.readyState === 1; },
  get duration() { return remote?.duration ?? null; },
  get detectedKey() { return remote?.detectedKey ?? null; },
  get detectedBpm() { return remote?.detectedBpm ?? null; },
  get positionSec() { return player?.positionSec ?? null; },
  get started() { return started; },
};

// ── Pump: read face, slew toward targets, push to the model ─────────────────
function sampleFace() {
  const t = window.__faceTracker;
  const live = t && t.faceVisible;
  const src = synth || (live ? { blend: t.blend, pose: t.pose } : null);
  if (ui.faceState) {
    ui.faceState.textContent = synth ? "test sweep" : live ? "face locked" : "no face — hold";
    ui.faceState.classList.toggle("on", !!src);
  }
  if (!src) return; // hold last face when none visible
  lastFace = { blend: src.blend || {}, pose: src.pose || {} };
}

function pushParams() {
  sampleFace();

  const raw = computeKnobTargets(slots, lastFace.blend, lastFace.pose);
  raw.denoise = remixValue;
  for (const k of Object.keys(knob)) {
    const tgt = raw[k] ?? knob[k];
    knob[k] += (tgt - knob[k]) * SLEW;
  }
  updateCards();

  if (!remote || remote.ws?.readyState !== WebSocket.OPEN) return;
  const pos = player?.positionSec ?? 0;
  remote.sendParams(
    {
      ...knob,
      ...Object.fromEntries(
        DEFAULT_LORA_SLOTS
          .map((slot) => [ui[slot.select]?.value, loraStrength(slot)])
          .filter(([id]) => id)
          .map(([id, strength]) => [`lora_str_${id}`, strength]),
      ),
    },
    pos,
  );
}

// ── Driver cards (dynamic feature → param slots) ────────────────────────────
const driversEl = $("drivers");
const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// Feature options use our face-movement labels (the camera side the SDK
// doesn't name); target options use the SDK's canonical parameter names
// (uppercased, DEMON-HUD style) with the SDK tooltip copy as the option title.
const FEATURE_OPTS = FEATURES.map((f) => `<option value="${f.id}">${f.label}</option>`).join("");
const TARGET_OPTS = Object.entries(TARGETS)
  .map(([id, t]) => {
    const text = id === "off" ? t.label : t.label.toUpperCase();
    const title = t.desc ? ` title="${escapeAttr(t.desc)}"` : "";
    return `<option value="${id}"${title}>${text}</option>`;
  })
  .join("");

function buildCards() {
  if (!driversEl) return;
  driversEl.innerHTML = "";
  slots.forEach((slot, i) => {
    const card = document.createElement("div");
    card.className = "drv";
    card.dataset.idx = String(i);
    card.innerHTML =
      `<div class="drv-head">` +
      `<select class="drv-feature">${FEATURE_OPTS}</select>` +
      `<button class="drv-remove" title="remove">×</button></div>` +
      `<div class="drv-map"><span class="drv-arrow">→</span>` +
      `<select class="drv-target">${TARGET_OPTS}</select>` +
      `<span class="drv-val">—</span></div>` +
      `<div class="drv-meter"><div class="drv-fill"></div></div>`;
    const fsel = card.querySelector(".drv-feature");
    const tsel = card.querySelector(".drv-target");
    fsel.value = slot.feature;
    tsel.value = slot.target;
    tsel.title = TARGETS[slot.target]?.desc || "";
    fsel.addEventListener("change", () => { slot.feature = fsel.value; saveSlots(); updateCards(); });
    tsel.addEventListener("change", () => {
      slot.target = tsel.value;
      tsel.title = TARGETS[tsel.value]?.desc || "";
      saveSlots();
      updateCards();
    });
    card.querySelector(".drv-remove").addEventListener("click", () => {
      slots.splice(i, 1);
      saveSlots();
      buildCards();
    });
    driversEl.appendChild(card);
  });

  if (slots.length < MAX_SLOTS) {
    const add = document.createElement("button");
    add.id = "drv-add";
    add.textContent = "+ add mapping";
    add.addEventListener("click", () => {
      slots.push({ feature: "mouthOpen", target: "off" });
      saveSlots();
      buildCards();
    });
    driversEl.appendChild(add);
  }
  updateCards();
}

function updateCards() {
  if (!driversEl) return;
  const cards = driversEl.querySelectorAll(".drv");
  cards.forEach((card) => {
    const i = Number(card.dataset.idx);
    const slot = slots[i];
    if (!slot) return;
    const f = FEATURE_BY_ID[slot.feature];
    const t = TARGETS[slot.target];
    const valEl = card.querySelector(".drv-val");
    const fillEl = card.querySelector(".drv-fill");
    if (!t || !t.knob) {
      // Off: show the raw feature signal so the movement is still visible.
      const sig = Math.abs(f ? f.read(lastFace.blend, lastFace.pose) : 0);
      if (valEl) valEl.textContent = "—";
      if (fillEl) fillEl.style.width = `${Math.round(clamp01(sig) * 100)}%`;
      card.classList.add("off");
      return;
    }
    card.classList.remove("off");
    const v = knob[t.knob];
    if (valEl) valEl.textContent = t.fmt(v);
    if (fillEl) {
      const pct = Math.max(0, Math.min(100, ((v - t.lo) / (t.hi - t.lo)) * 100));
      fillEl.style.width = `${pct}%`;
    }
  });
}

// ── Manual strength control (denoise; decoupled from the face) ──────────────
// Labelled with the SDK's canonical name for `denoise` ("strength").
if (ui.remixLabel) {
  ui.remixLabel.textContent = displayNameFor("denoise");
  ui.remixLabel.title = describeControl("denoise") || "";
}
function setRemix(v) {
  remixValue = Math.max(0, Math.min(1, v));
  if (ui.remixSlider) ui.remixSlider.value = String(remixValue);
  if (ui.remixVal) ui.remixVal.textContent = remixValue.toFixed(2);
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

// ── LoRA library (manual A/B slots) ─────────────────────────────────────────
function loraLabel(entry) {
  return entry?.metadata?.name || entry?.name || entry?.id || "";
}
function findLoraId(name, slotIndex) {
  const needle = name.toLowerCase();
  const exact = loraCatalog.find((entry) =>
    entry.id?.toLowerCase() === needle ||
    entry.name?.toLowerCase() === needle ||
    entry.metadata?.name?.toLowerCase() === needle,
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
      { id: "phonk-acestep1.5-v1", name: "Phonk" },
      { id: "low_fi-acestep1.5-v1", name: "Lo-Fi" },
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
  // The face pump keeps running between sessions so the meters stay live.
  stopTest();
  const oldPlayer = player;
  const oldRemote = remote;
  player = null;
  remote = null;
  started = false;
  activeLoras.clear();
  if (ui.reload) ui.reload.disabled = true;
  try { await oldPlayer?.close?.(); } catch (e) { console.warn("[demon] player close:", e); }
  try { oldRemote?.close?.(); } catch (e) { console.warn("[demon] remote close:", e); }
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

  // Standard PCM-upload handshake, server-fixture variant. sde:false makes
  // `denoise` the live cover knob.
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
    try { remote?.close?.(); } catch {}
    remote = null;
    player = null;
    started = false;
    setLoading(false);
    return;
  }

  enableConfiguredLoras();

  // Use the input track as its own timbre reference at a fixed blend.
  remote.sendSetTimbreStrength(0.6);

  // Loop the song so the remix runs continuously, trimming the edges.
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
  // The pump runs continuously (started on load); the session just gives it a
  // socket to send to. Nothing to start here.
}

// ── No-camera test path ────────────────────────────────────────────────────
// Sweeps a synthetic face (offset phases so each movement is independent)
// through the SAME pipeline the camera uses. Works with or without a live
// session, so the mapping/meters can be verified headlessly.
function stopTest() {
  if (testTimer) { clearInterval(testTimer); testTimer = null; }
  synth = null;
  if (ui.test) ui.test.textContent = "Test";
}
function toggleTest() {
  if (testTimer) { stopTest(); return; }
  if (ui.test) ui.test.textContent = "Stop test";
  testT = 0;
  testTimer = setInterval(() => {
    testT += 0.05;
    const sm = 0.4 + 0.35 * Math.sin(testT * 0.6 + 1.0);
    const bd = 0.3 + 0.28 * Math.sin(testT * 0.5 + 4.0);
    synth = {
      blend: {
        jawOpen: 0.3 + 0.27 * Math.sin(testT),
        mouthSmileLeft: sm, mouthSmileRight: sm,
        browInnerUp: 0.4 + 0.35 * Math.sin(testT * 0.4 + 2.0),
        browDownLeft: bd, browDownRight: bd,
        mouthPucker: 0.4 + 0.35 * Math.sin(testT * 0.7 + 0.5),
        cheekPuff: 0.3 + 0.28 * Math.sin(testT * 0.35 + 6.0),
        eyeSquintLeft: 0.35 + 0.3 * Math.sin(testT * 0.55 + 2.5),
        eyeSquintRight: 0.35 + 0.3 * Math.sin(testT * 0.55 + 2.5),
      },
      pose: {
        yaw: 0.6 * Math.sin(testT * 0.3 + 3.0),
        pitch: 0.5 * Math.sin(testT * 0.45 + 5.0),
        roll: 0.4 * Math.sin(testT * 0.4 + 1.5),
      },
    };
  }, PARAM_PERIOD_MS);
}

// ── Source switch (camera ↔ demo clip) ──────────────────────────────────────
async function switchSource(kind) {
  const t = window.__faceTracker;
  if (!t || !t.ready) return;
  ui.srcCamera?.classList.toggle("active", kind === "camera");
  ui.srcVideo?.classList.toggle("active", kind === "video");
  try {
    await t.setSource(kind);
  } catch (e) {
    console.warn("[visage] source switch failed:", e);
    setStatus("source switch failed: " + (e?.message || e));
  }
}

// Headless test hooks: pure mapping helpers + live state + a synthetic feeder,
// so a harness can verify the dynamic feature→param slots without GPU/camera.
window.__demonFaceTest = {
  remap, bipolar, readFeature, computeKnobTargets, targetValue,
  FEATURES, TARGETS, knob,
  get slots() { return slots; },
  setSlots(next) { slots = next.map((s) => ({ ...s })); saveSlots(); buildCards(); },
  setRemix,
  get remix() { return remixValue; },
  // Feed a synthetic {blend, pose} and pump once.
  feed(blend, pose) { synth = { blend, pose: pose || { yaw: 0, pitch: 0, roll: 0 } }; pushParams(); synth = null; },
};

// ── Wiring ──────────────────────────────────────────────────────────────────
ui.start?.addEventListener("click", start);
ui.reload?.addEventListener("click", reloadSession);
ui.test?.addEventListener("click", toggleTest);
ui.srcCamera?.addEventListener("click", () => switchSource("camera"));
ui.srcVideo?.addEventListener("click", () => switchSource("video"));
ui.remixSlider?.addEventListener("input", (e) => setRemix(Number.parseFloat(e.target.value)));
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
  ui[slot.strength]?.addEventListener("input", (e) => {
    syncLoraStrengthUi(slot, e.target.value);
    sendLoraStrength(ui[slot.select]?.value || "", loraStrength(slot));
  });
}
ui.prompt?.addEventListener("change", () => {
  if (remote && remote.ws?.readyState === WebSocket.OPEN) {
    remote.sendPrompt(ui.prompt.value || DEFAULT_PROMPT);
  }
});

populateFixtures();
loraCatalogReady = populateLoras();
buildCards();
setRemix(remixValue);
// Always-on face pump: samples the tracker, animates the meters, and (once a
// session is connected) streams the knobs to the model. Runs before Start so
// the face visibly drives the readouts the moment tracking locks.
paramTimer = setInterval(pushParams, PARAM_PERIOD_MS);
