// main.js: session orchestration for the Orrery demo.
//
// Built from the backend's self-describing contract, per the SDK's
// AGENTS.md recipe: the knob surface renders from /api/knobs (then the
// per-session ready.knob_manifest), fixtures from /api/fixtures, and
// nothing about the control surface is hand-declared. The five protocol
// invariants are all here: full knob dict every tick with the playhead
// position, no slice ever dropped before reaching the player, the
// swap-epoch guard, the worklet served from /sdk/, and reconnect as a
// full re-handshake with setSliceEpoch realignment.

import {
  AudioPlayer,
  KNOB_SCHEMA_VERSION,
  RemoteBackend,
  SLICE_FLAG_DELTA,
  fetchKnobManifest,
  fetchWithRetry,
} from "/sdk/demon-client.js";
import { createAnalyser } from "./analysis.js";
import { createSurface } from "./surface.js";

const PARAM_SEND_MS = 8; // ~125 Hz, matching the reference app
const SMOOTH = 0.18; // per-tick tween toward knob targets
const DEFAULT_FIXTURE = "inside_confusion_loop_60s_gsm.wav";

const $ = (id) => document.getElementById(id);
const ui = {
  overlay: $("overlay"),
  engage: $("engage"),
  boot: $("bootStatus"),
  lamp: $("lamp"),
  lampText: $("lampText"),
  promptA: $("promptA"),
  promptB: $("promptB"),
  blend: $("blend"),
  transmit: $("transmit"),
  fixture: $("fixture"),
  swapBtn: $("swapBtn"),
  worldNote: $("worldNote"),
  loraList: $("loraList"),
  subsystems: $("subsystems"),
  toast: $("toast"),
  hud: $("hud"),
  tBpm: $("tBpm"),
  tKey: $("tKey"),
  tTick: $("tTick"),
  tPos: $("tPos"),
};

// ---------------- state ----------------

// name -> {spec, value (smoothed, sent), target, touched}
const knobs = new Map();
const localLoraKnobs = new Set(); // lora_str_* knobs we shaped client-side
const enabledLoras = new Set();
const panelWidgets = new Map(); // name -> refresh()

let remote = null;
let player = null;
let playerReady = false;
let live = false;
let connecting = false;
let userEnded = false;
let catalog = [];
let staticManifest = {};
let firstParamsSeen = false;
const pendingSlices = [];
const telemetry = { tickMs: 0, decMs: 0 };

let toastTimer = 0;
function toast(msg, isErr = false) {
  ui.toast.textContent = msg;
  ui.toast.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.className = ""), 2600);
}

function setLamp(mode, text) {
  ui.lamp.className = `lamp ${mode}`;
  ui.lampText.textContent = text;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

// ---------------- knob model ----------------

function clampToSpec(spec, v) {
  if (typeof v !== "number") return v;
  const lo = typeof spec.min === "number" ? spec.min : 0;
  const hi = typeof spec.max === "number" ? spec.max : 1;
  if (spec.type === "int") v = Math.round(v);
  return Math.max(lo, Math.min(hi, v));
}

function setKnob(name, v, { touched = true } = {}) {
  const k = knobs.get(name);
  if (!k) return;
  k.target = clampToSpec(k.spec, v);
  if (typeof k.target !== "number" || k.spec.type !== "float") {
    k.value = k.target; // strings, bools, and ints apply instantly
  }
  if (touched) k.touched = true;
  panelWidgets.get(name)?.();
}

// Knobs that cannot function in this demo's sessions. x0_target needs a
// target latent to shift toward and nothing on this surface provides
// one, so exposing it would put a dead control next to the live ones.
// Never rendered, never sent; the server keeps it at its default.
const UNAVAILABLE = new Set(["x0_target"]);

function seedKnobs(specMap) {
  for (const [name, spec] of Object.entries(specMap)) {
    if (UNAVAILABLE.has(name)) continue;
    const prev = knobs.get(name);
    if (prev) {
      prev.spec = spec;
      if (!prev.touched) {
        prev.value = spec.default;
        prev.target = spec.default;
      }
    } else {
      knobs.set(name, {
        spec,
        value: spec.default,
        target: spec.default,
        touched: false,
      });
    }
  }
  for (const name of [...knobs.keys()]) {
    if (!(name in specMap) && !localLoraKnobs.has(name)) knobs.delete(name);
  }
  relayout();
}

// Partition the manifest into the surface's bands. Orbits are the
// continuous core bank knobs; the channel-group and keystone amplifier
// groups become the spoke fan and the stud band; everything else (raw
// params, guidance, DCW, huge-range ints like seed) renders in the HUD.
function partition() {
  const orbits = [];
  const spokes = [];
  const studs = [];
  const panel = [];
  for (const [name, k] of knobs) {
    const s = k.spec;
    const numeric = s.type === "float" || s.type === "int";
    const span = typeof s.max === "number" ? s.max : 1;
    if (s.group === "groups" && numeric) spokes.push(name);
    else if (s.group === "keystones" && numeric) studs.push(name);
    else if (s.group === "core" && s.bank !== false && numeric && span <= 1000)
      orbits.push(name);
    else panel.push(name);
  }
  return { orbits, spokes, studs, panel };
}

function currentRaw() {
  const raw = {};
  for (const [name, k] of knobs) {
    if (k.spec.type === "float") raw[name] = Math.round(k.value * 1e5) / 1e5;
    else if (k.spec.type === "int") raw[name] = Math.round(k.value);
    else raw[name] = k.value;
  }
  return raw;
}

// Full knob dict at UI rate with the playhead position, per invariant 1.
setInterval(() => {
  if (!live || !remote?.ready || !player) return;
  for (const k of knobs.values()) {
    if (k.spec.type === "float") {
      const d = k.target - k.value;
      k.value = Math.abs(d) < 1e-4 ? k.target : k.value + d * SMOOTH;
    } else {
      k.value = k.target;
    }
  }
  remote.sendParams(currentRaw(), player.positionSec);
}, PARAM_SEND_MS);

// ---------------- surface + analysis ----------------

const analyser = createAnalyser(48000);

const surface = createSurface($("surface"), {
  knobs,
  onInput: setKnob,
  getHudWidth: () =>
    document.body.classList.contains("hud-hidden") ? 0 : ui.hud.offsetWidth + 28,
  getAnalysis: (t) => {
    if (live && player) {
      return analyser.update(
        player.getMirror(),
        player.channels,
        player.positionSec,
        player.kick ?? 0,
        t,
      );
    }
    return analyser.idle(t);
  },
  getPlayhead: () =>
    live && player
      ? { pos: player.positionSec, dur: player.duration }
      : { pos: 0, dur: 0 },
  getStatusLine: () => {
    if (live && remote) {
      const parts = [remote.checkpoint || "live"];
      if (remote.detectedBpm) parts.push(`${Math.round(remote.detectedBpm)} bpm`);
      if (remote.detectedKey) parts.push(remote.detectedKey);
      return parts.join("  ·  ").toUpperCase();
    }
    return connecting ? "FORGING LINK…" : "AWAITING ENGAGEMENT";
  },
});

function relayout() {
  const { orbits, spokes, studs, panel } = partition();
  surface.setLayout({ orbits, spokes, studs });
  renderSubsystems(panel);
}

// ---------------- HUD: subsystems ----------------

function renderSubsystems(panelNames) {
  panelWidgets.clear();
  ui.subsystems.textContent = "";
  if (!panelNames.length) {
    ui.subsystems.innerHTML = '<div class="note">No auxiliary knobs.</div>';
    return;
  }

  // Group sections in manifest encounter order.
  const groups = new Map();
  for (const name of panelNames) {
    const g = knobs.get(name).spec.group || "misc";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(name);
  }

  for (const [group, names] of groups) {
    const sec = document.createElement("div");
    sec.className = "subGroup";
    const h = document.createElement("h3");
    h.textContent = group;
    sec.appendChild(h);
    for (const name of names) sec.appendChild(buildWidget(name));
    ui.subsystems.appendChild(sec);
  }
}

function buildWidget(name) {
  const k = knobs.get(name);
  const spec = k.spec;
  const row = document.createElement("div");
  row.className = "knobRow";
  if (name === "steps_override") row.classList.add("rebuild");

  const label = document.createElement("label");
  label.textContent = name;
  label.title = spec.description || name;
  row.appendChild(label);

  const isBigInt =
    spec.type === "int" && typeof spec.max === "number" && spec.max > 1000;

  if (isBigInt) {
    const wrap = document.createElement("div");
    wrap.className = "seedRow";
    const num = document.createElement("input");
    num.type = "number";
    num.min = String(spec.min ?? 0);
    num.max = String(spec.max);
    num.value = String(Math.round(k.target));
    num.addEventListener("change", () => setKnob(name, Number(num.value)));
    const dice = document.createElement("button");
    dice.className = "btn";
    dice.textContent = "⟲";
    dice.title = "New epoch (random seed)";
    dice.addEventListener("click", () => {
      const v = Math.floor(Math.random() * (spec.max + 1));
      setKnob(name, v);
      num.value = String(v);
    });
    wrap.append(num, dice);
    row.appendChild(wrap);
    panelWidgets.set(name, () => (num.value = String(Math.round(k.target))));
  } else if (spec.type === "float" || spec.type === "int") {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(spec.min ?? 0);
    slider.max = String(spec.max ?? 1);
    slider.step =
      spec.type === "int"
        ? "1"
        : String(((spec.max ?? 1) - (spec.min ?? 0)) / 200);
    slider.value = String(k.target);
    const val = document.createElement("b");
    const fmt = (v) => (spec.type === "int" ? String(Math.round(v)) : Number(v).toFixed(2));
    val.textContent = fmt(k.target);
    slider.addEventListener("input", () => {
      setKnob(name, Number(slider.value));
      val.textContent = fmt(k.target);
    });
    row.append(slider, val);
    panelWidgets.set(name, () => {
      slider.value = String(k.target);
      val.textContent = fmt(k.target);
    });
  } else if (spec.type === "enum") {
    const sel = document.createElement("select");
    for (const opt of spec.options || []) {
      const o = document.createElement("option");
      o.value = String(opt);
      o.textContent = String(opt);
      sel.appendChild(o);
    }
    sel.value = String(k.target);
    sel.addEventListener("change", () => setKnob(name, sel.value));
    row.appendChild(sel);
    panelWidgets.set(name, () => (sel.value = String(k.target)));
  } else {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(k.target);
    box.addEventListener("change", () => setKnob(name, box.checked));
    row.appendChild(box);
    panelWidgets.set(name, () => (box.checked = Boolean(k.target)));
  }
  return row;
}

// ---------------- HUD: LoRAs ----------------

function metaFor(id) {
  return catalog.find((e) => e.id === id)?.metadata || null;
}

// Enabled-LoRA trigger words ride every prompt send so the engine
// always hears its activation tokens (same pattern as the reference app).
function promptTransform(tags) {
  const trigs = [];
  for (const id of enabledLoras) {
    const t = metaFor(id)?.primary_trigger_word;
    if (t && !tags.toLowerCase().includes(t.toLowerCase())) trigs.push(t);
  }
  return trigs.length ? `${trigs.join(", ")}, ${tags}` : tags;
}

function renderLoras() {
  ui.loraList.textContent = "";
  if (!live) {
    ui.loraList.innerHTML = '<div class="note">Awaiting link…</div>';
    return;
  }
  const scale = remote?.checkpointScale ?? null;
  const rows = catalog.filter((e) => {
    const ls = e.metadata?.base_model_scale ?? null;
    return !scale || !ls || ls === scale;
  });
  if (!rows.length) {
    ui.loraList.innerHTML = '<div class="note">No resonators on this pod.</div>';
    return;
  }
  for (const entry of rows) {
    const on = enabledLoras.has(entry.id);
    const card = document.createElement("div");
    card.className = "lora" + (on ? " on" : "");

    const head = document.createElement("div");
    head.className = "loraHead";
    const gem = document.createElement("span");
    gem.className = "loraGem";
    gem.textContent = on ? "◆" : "◇";
    const nm = document.createElement("span");
    nm.className = "loraName";
    nm.textContent = entry.metadata?.name || entry.name || entry.id;
    const genre = document.createElement("span");
    genre.className = "loraGenre";
    genre.textContent = entry.metadata?.primary_genre || "";
    head.append(gem, nm, genre);
    head.addEventListener("click", () => setLora(entry.id, !on));
    card.appendChild(head);

    const trig = entry.metadata?.primary_trigger_word;
    if (trig) {
      const tr = document.createElement("div");
      tr.className = "loraTrig";
      tr.textContent = `trigger: ${trig}`;
      card.appendChild(tr);
    }

    if (on) {
      const kname = `lora_str_${entry.id}`;
      const k = knobs.get(kname);
      if (k) {
        const strRow = document.createElement("div");
        strRow.className = "loraStr";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(k.spec.min ?? 0);
        slider.max = String(k.spec.max ?? 2);
        slider.step = "0.01";
        slider.value = String(k.target);
        const val = document.createElement("b");
        val.textContent = Number(k.target).toFixed(2);
        slider.addEventListener("input", () => {
          setKnob(kname, Number(slider.value));
          val.textContent = Number(k.target).toFixed(2);
        });
        strRow.append(slider, val);
        card.appendChild(strRow);
      }
    }
    ui.loraList.appendChild(card);
  }
}

function setLora(id, on) {
  if (!live || !remote) return;
  const kname = `lora_str_${id}`;
  if (on) {
    const strength = metaFor(id)?.recommended_strength ?? 1.0;
    remote.sendEnableLora(id, strength);
    enabledLoras.add(id);
    if (!knobs.has(kname)) {
      // Prefer the per-session manifest's shape when the session already
      // declares this knob; otherwise mirror the registry's LoRA spec.
      const fromManifest = remote.knobManifest?.knobs?.[kname];
      knobs.set(kname, {
        spec: fromManifest || {
          type: "float",
          default: strength,
          min: 0,
          max: 2,
          group: "core",
          bank: true,
          description: `Strength for LoRA ${id}`,
        },
        value: strength,
        target: strength,
        touched: true,
      });
      localLoraKnobs.add(kname);
    }
    setKnob(kname, strength);
    toast(`Resonator engaged: ${id}`);
  } else {
    remote.sendDisableLora(id);
    enabledLoras.delete(id);
    knobs.delete(kname);
    localLoraKnobs.delete(kname);
    toast(`Resonator released: ${id}`);
  }
  relayout();
  renderLoras();
  sendCurrentPrompt(); // refresh the trigger prefix on the wire
}

// ---------------- prompts ----------------

function sendCurrentPrompt() {
  if (!live || !remote) return;
  const a = ui.promptA.value.trim();
  const b = ui.promptB.value.trim();
  if (!a) return;
  remote.sendPrompt(a, undefined, undefined, b || undefined);
}

ui.transmit.addEventListener("click", () => {
  sendCurrentPrompt();
  toast("Trajectory transmitted");
});

ui.blend.addEventListener("input", () => {
  if (live && remote) remote.sendSetPromptBlend(Number(ui.blend.value));
});

// ---------------- session ----------------

function applySlice(s) {
  if (s.epoch !== player.swapCount) return; // invariant 3: epoch guard
  if (s.flags === SLICE_FLAG_DELTA) player.addDelta(s.startSample, s.audio);
  else player.patch(s.startSample, s.audio);
  telemetry.tickMs += (s.tickMs - telemetry.tickMs) * 0.2;
  telemetry.decMs += (s.decMs - telemetry.decMs) * 0.2;
}

function attachRemoteListeners(r) {
  r.addEventListener("slice", (e) => {
    const s = e.detail;
    // Invariant 2: every slice reaches the player. Slices that land while
    // the worklet is still initializing queue instead of dropping, or the
    // delta basis desyncs.
    if (!playerReady) pendingSlices.push(s);
    else applySlice(s);
  });

  r.addEventListener("swap_ready", (e) => {
    const d = e.detail;
    player.swap(d.interleaved, d.channels);
    ui.worldNote.textContent = "";
    toast("World swapped");
  });
  r.addEventListener("swap_failed", (e) => {
    ui.worldNote.textContent = "";
    toast(`Swap failed: ${e.detail}`, true);
  });

  r.addEventListener("params", (e) => {
    // First authoritative snapshot: adopt the server's live values for
    // any knob the operator hasn't touched, so we never assert manifest
    // defaults against a session configured differently.
    if (firstParamsSeen) return;
    firstParamsSeen = true;
    for (const [name, v] of Object.entries(e.detail || {})) {
      if (name.startsWith("_")) continue;
      const k = knobs.get(name);
      if (k && !k.touched && typeof v === typeof k.target) {
        k.value = v;
        k.target = v;
        panelWidgets.get(name)?.();
      }
    }
  });

  // External control (MCP / control bus) echoes: mirror into our state
  // and let the normal send loop re-apply them through the tween.
  r.addEventListener("params_echo", (e) => {
    for (const [name, v] of Object.entries(e.detail || {})) {
      if (knobs.has(name)) setKnob(name, v);
    }
  });
  r.addEventListener("prompt_blend_echo", (e) => {
    ui.blend.value = String(e.detail);
    r.sendSetPromptBlend(Number(e.detail));
  });

  r.addEventListener("lora_catalog", (e) => {
    catalog = e.detail || [];
    renderLoras();
  });

  r.addEventListener("close", () => {
    if (r !== remote) return;
    live = false;
    setLamp("lost", "LOST");
    if (!r.closedByUser && !userEnded) {
      ui.boot.textContent = "signal lost · re-engage to resume";
      ui.boot.className = "boot err";
      ui.engage.textContent = "Re-engage";
      ui.engage.disabled = false;
      ui.overlay.classList.remove("hidden");
    }
  });
}

async function startSession() {
  if (connecting) return;
  connecting = true;
  userEnded = false;
  ui.engage.disabled = true;
  ui.boot.className = "boot";
  ui.boot.textContent = "forging link · cold start can take ~15 s…";
  setLamp("link", "LINK");

  try {
    const stepsDefault = knobs.get("steps_override")?.spec.default ?? 8;
    const config = {
      prompt: ui.promptA.value.trim() || "ambient drift",
      depth: 4,
      steps: Math.round(Number(stepsDefault)),
      use_server_fixture: true,
      fixture_name: ui.fixture.value,
    };
    const b = ui.promptB.value.trim();
    if (b) config.prompt_b = b;

    const r = new RemoteBackend(wsUrl(), new Float32Array(0), 2, config, {
      sliceWorkerUrl: "/sdk/sliceDecoder.worker.js",
      promptTransform,
    });
    remote = r;
    firstParamsSeen = false;
    attachRemoteListeners(r);
    await r.connect();

    // The per-session manifest resolves SDE mode and any LoRA strength
    // knobs for THIS session; adopt it over the static probe.
    if (r.knobManifest?.knobs) seedKnobs(r.knobManifest.knobs);

    if (!player) {
      player = new AudioPlayer({ workletUrl: "/sdk/audio-worklet.js" });
      await player.init(r.initialBuffer, r.channels);
      playerReady = true;
      while (pendingSlices.length) applySlice(pendingSlices.shift());
    } else {
      // Reconnect path (invariant 5): the player survives, the epoch
      // counter must be realigned after the swap bump.
      player.swap(r.initialBuffer, r.channels);
      r.setSliceEpoch(player.swapCount);
    }
    await player.resume();

    catalog = r.loraCatalog;
    live = true;
    setLamp("live", "LIVE");
    ui.tBpm.textContent = r.detectedBpm ? String(Math.round(r.detectedBpm)) : "—";
    ui.tKey.textContent = r.detectedKey || "—";
    ui.overlay.classList.add("hidden");
    ui.transmit.disabled = false;
    ui.swapBtn.disabled = false;
    renderLoras();
    toast(`Linked: ${r.checkpoint || "backend"} · ${ui.fixture.value}`);
  } catch (err) {
    console.error("[orrery] session start failed:", err);
    setLamp("lost", "FAIL");
    ui.boot.textContent = `link failed: ${err?.message || err}`;
    ui.boot.className = "boot err";
    ui.engage.disabled = false;
  } finally {
    connecting = false;
  }
}

ui.engage.addEventListener("click", startSession);

ui.swapBtn.addEventListener("click", () => {
  if (!live || !remote) return;
  ui.worldNote.textContent = "swapping world… generation pauses briefly";
  remote.sendSwapSourceByName(ui.fixture.value);
});

// ---------------- boot ----------------

async function boot() {
  try {
    const [manifestRes, fixturesRes] = await Promise.all([
      fetchKnobManifest(false),
      fetchWithRetry("/api/fixtures"),
    ]);
    staticManifest = manifestRes.knobs;
    if (
      typeof manifestRes.version === "number" &&
      manifestRes.version !== KNOB_SCHEMA_VERSION
    ) {
      console.warn(
        `[orrery] knob schema ${manifestRes.version} != SDK ${KNOB_SCHEMA_VERSION}`,
      );
    }
    seedKnobs(staticManifest);

    const fixtures = await fixturesRes.json();
    ui.fixture.textContent = "";
    for (const name of fixtures) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name.replace(/\.wav$/, "").replace(/_/g, " ");
      ui.fixture.appendChild(o);
    }
    if (fixtures.includes(DEFAULT_FIXTURE)) ui.fixture.value = DEFAULT_FIXTURE;

    ui.boot.textContent = "backend contract loaded · ready";
    ui.engage.disabled = false;
  } catch (err) {
    console.error("[orrery] boot failed:", err);
    ui.boot.textContent = `backend unreachable: ${err?.message || err}`;
    ui.boot.className = "boot err";
  }
}

boot();

// Debug/test handle (same spirit as the SDK's __demonPromptLog hook).
window.__orrery = { knobs, get remote() { return remote; }, get player() { return player; } };

// ---------------- chrome loops + keys ----------------

setInterval(() => {
  if (live && player) {
    const p = player.positionSec;
    const d = player.duration || 0;
    const mm = (s) =>
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    ui.tPos.textContent = `${mm(p)}/${mm(d)}`;
    ui.tTick.textContent = telemetry.tickMs ? telemetry.tickMs.toFixed(0) : "—";
  }
}, 250);

window.addEventListener("keydown", (e) => {
  const inField =
    e.target instanceof Element && e.target.closest("textarea, input, select");
  if (e.key.toLowerCase() === "h" && !inField) {
    document.body.classList.toggle("hud-hidden");
  }
});
