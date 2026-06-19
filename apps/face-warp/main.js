import * as THREE from "three/webgpu";
import { GLTFLoader, OrbitControls } from "three/examples/jsm/Addons.js";
import { mix, texture, uniform } from "three/tsl";
import { setupTracker } from "https://esm.sh/three-mediapipe-rig@0.1.41?deps=three@0.183.1,@mediapipe/tasks-vision@0.10.32,fflate@0.8.2";
import {
  AudioPlayer,
  DEFAULT_CONFIG,
  RemoteBackend,
  SLICE_FLAG_DELTA,
  fetchKnobManifest,
  fetchWireContract,
  KNOB_SCHEMA_VERSION,
  PROTOCOL_VERSION,
} from "/sdk/demon-client.js";

const $ = (id) => document.getElementById(id);

const els = {
  signal: $("signal"),
  status: $("status"),
  start: $("startBtn"),
  webcam: $("webcamBtn"),
  stop: $("stopBtn"),
  fixture: $("fixtureSelect"),
  promptA: $("promptA"),
  promptB: $("promptB"),
  promptBlend: $("promptBlend"),
  lora: $("loraSelect"),
  loraStrength: $("loraStrength"),
  loraStrengthValue: $("loraStrengthValue"),
  denoise: $("denoiseKnob"),
  denoiseValue: $("denoiseValue"),
  structure: $("structureKnob"),
  structureValue: $("structureValue"),
  timbre: $("timbreKnob"),
  timbreValue: $("timbreValue"),
  xyPad: $("xyPad"),
  puck: $("puck"),
  energy: $("energyReadout"),
  engine: $("engineReadout"),
  eyeDistance: $("eyeDistance"),
  jawLine: $("jawLine"),
  reactStrength: $("reactStrength"),
  reactDivision: $("reactDivision"),
  reactMethod: $("reactMethod"),
  reactMode: $("reactMode"),
  uvFactor: $("uvFactor"),
  roughness: $("roughness"),
  metalness: $("metalness"),
  clearcoat: $("clearcoat"),
  bass: $("bassMeter"),
  mid: $("midMeter"),
  spark: $("sparkMeter"),
};

const FACE_BLEND_LIMIT = 2.25;
const UV_FACTOR_DEAD_ZONE = 0.01;
// Divisions per full pattern cycle. The dot advances one quarter of a circle
// (or sine cycle) per division, so every division is a visible move.
const REACT_CYCLE_DIVS = 4;
const FALLBACK_BPM = 120;
const DEFAULT_KEY = "C";
const DEFAULT_BAR_LENGTH = "4";
const DEFAULT_DEPTH = 4;
const DEFAULT_LORA_STRENGTH = 0.5;
const SLIDER_DEFS = {
  denoise: {
    param: "denoise",
    fallback: { type: "float", min: 0, max: 1, step: 0.01, default: DEFAULT_CONFIG.controls.denoise },
  },
  structure: {
    param: "hint_strength",
    fallback: { type: "float", min: 0, max: 1, step: 0.01, default: DEFAULT_CONFIG.controls.hint_strength },
  },
  timbre: {
    param: "timbre_strength",
    fallback: { type: "float", min: 0, max: 1, step: 0.01, default: 1.0 },
    sendDirect: (remote, value) => remote.sendSetTimbreStrength(value),
  },
};

const state = {
  fixtures: [],
  loras: [],
  activeLora: "",
  loraStrength: DEFAULT_LORA_STRENGTH,
  knobEntries: [],
  params: {},
  sliderControls: new Map(),
  // Manual pad position (the dot's resting center) set by drag / sliders.
  pointer: { x: 0, y: 0, active: false },
  // Manual center + beat-synced reactive offset, clamped to the pad. Drives
  // the face morphs.
  effective: { x: 0, y: 0 },
  audio: { bass: 0, mid: 0, spark: 0, kick: 0, energy: 0 },
  remote: null,
  player: null,
  analyser: null,
  freq: null,
  tracker: null,
  webcamHandle: null,
  faceBinding: null,
  faceMesh: null,
  faceMaterial: null,
  uvNode: null,
  running: false,
};

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(22.5, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 11);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

const ambient = new THREE.AmbientLight(0xffffff, 0.38);
scene.add(ambient);

const pink = new THREE.PointLight(0xffffff, 6.5, 20);
pink.position.set(-2.8, 1.6, 4.4);
scene.add(pink);

const cyan = new THREE.PointLight(0xffffff, 5.4, 20);
cyan.position.set(2.8, -0.4, 4.5);
scene.add(cyan);

const fill = new THREE.PointLight(0xffffff, 2.8, 18);
fill.position.set(0, 2.2, 5.8);
scene.add(fill);

let lastFrameSec = performance.now() / 1000;
let elapsedSec = 0;
let lastParamsAt = 0;

window.__faceWarp = state;

boot();

async function boot() {
  bindMousePad();
  bindEngineControls();
  window.addEventListener("resize", resize);

  try {
    const [tracker, fixtures, loraCatalog, manifest, contract] = await Promise.all([
      setupTracker({
        onlyFace: true,
        displayScale: 0.75,
        drawLandmarksOverlay: false,
      }),
      fetchJson("/api/fixtures").catch(() => []),
      fetchJson("/api/loras").catch(() => ({ loras: [] })),
      fetchKnobManifest().catch(() => ({ version: 0, knobs: {} })),
      fetchWireContract().catch(() => null),
      renderer.init(),
    ]);

    state.tracker = tracker;
    state.fixtures = Array.isArray(fixtures) ? fixtures : [];
    state.loras = Array.isArray(loraCatalog?.loras) ? loraCatalog.loras : [];
    fillFixtures();
    fillLoras();
    applyManifest(manifest);
    warnOnVersionMismatch(manifest, contract);
    await loadCanonicalFace();
    renderer.setAnimationLoop(render);
    await startWebcam();
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Failed to boot face rig.", "warn");
  }
}

async function loadCanonicalFace() {
  const gltf = await new GLTFLoader().loadAsync("./mediapipe-canonical-face.glb");
  scene.add(gltf.scene);

  const mesh = scene.getObjectByName("face_model_with_iris");
  if (!mesh) throw new Error("canonical face mesh not found");

  state.faceMesh = mesh;
  mesh.scale.z *= 1.32;
  mesh.frustumCulled = false;

  const uvTexture = await new THREE.TextureLoader().loadAsync("./canonical_face_model_uv_visualization.png");
  uvTexture.colorSpace = THREE.SRGBColorSpace;
  uvTexture.flipY = false;
  uvTexture.generateMipmaps = false;
  uvTexture.needsUpdate = true;

  const uvNode = uniform(uvFactorValue());
  state.uvNode = uvNode;

  state.faceBinding = state.tracker.faceTracker.bindGeometry(mesh, (posNode, colorNode) => {
    mesh.material = new THREE.MeshPhysicalNodeMaterial({
      positionNode: posNode,
      colorNode: mix(colorNode, texture(uvTexture), uvNode),
      roughness: Number(els.roughness.value),
      metalness: Number(els.metalness.value),
      clearcoat: Number(els.clearcoat.value),
    });
    state.faceMaterial = mesh.material;
  });

  els.uvFactor.addEventListener("input", () => {
    uvNode.value = uvFactorValue();
  });
  for (const input of [els.roughness, els.metalness, els.clearcoat]) {
    input.addEventListener("input", applyMaterialSettings);
  }
}

function applyMaterialSettings() {
  const material = state.faceMaterial;
  if (!material) return;
  material.roughness = Number(els.roughness.value);
  material.metalness = Number(els.metalness.value);
  material.clearcoat = Number(els.clearcoat.value);
  material.needsUpdate = true;
}

function warnOnVersionMismatch(manifest, contract) {
  const warnings = [];
  if (manifest?.version && manifest.version !== KNOB_SCHEMA_VERSION) {
    warnings.push(`knobs v${manifest.version} != SDK v${KNOB_SCHEMA_VERSION}`);
  }
  if (contract?.version && contract.version !== PROTOCOL_VERSION) {
    warnings.push(`protocol v${contract.version} != SDK v${PROTOCOL_VERSION}`);
  }
  if (warnings.length) console.warn("[face-warp]", warnings.join("; "));
}

function fillFixtures() {
  els.fixture.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = state.fixtures.length ? "Select track" : "No fixtures found";
  els.fixture.append(empty);
  for (const name of state.fixtures) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    els.fixture.append(option);
  }
  const preferred = "low_fi_Gm_loop_60s_gnm.wav";
  els.fixture.value = state.fixtures.includes(preferred) ? preferred : state.fixtures[0] || "";
}

function fillLoras() {
  const selected = els.lora.value || state.activeLora;
  els.lora.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = state.loras.length ? "No LoRA" : "No LoRAs found";
  els.lora.append(empty);
  for (const lora of state.loras) {
    const option = document.createElement("option");
    option.value = lora.id || "";
    option.textContent = lora.name || lora.id || "Unnamed LoRA";
    els.lora.append(option);
  }
  const ids = state.loras.map((lora) => lora.id).filter(Boolean);
  els.lora.value = ids.includes(selected) ? selected : ids[0] || "";
  state.activeLora = els.lora.value;
}

function applyManifest(manifest) {
  const knobs = manifest?.knobs && typeof manifest.knobs === "object" ? manifest.knobs : {};
  state.knobEntries = Object.entries(knobs).map(([name, spec]) => ({ name, spec }));
  state.params = {};
  for (const { name, spec } of state.knobEntries) {
    state.params[name] = defaultKnobValue(spec);
  }

  state.sliderControls.clear();
  configureKnobSlider("denoise", els.denoise, els.denoiseValue);
  configureKnobSlider("structure", els.structure, els.structureValue);
  configureKnobSlider("timbre", els.timbre, els.timbreValue);
}

function configureKnobSlider(control, input, out) {
  const def = SLIDER_DEFS[control];
  const entry = state.knobEntries.find((item) => item.name === def.param);
  const spec = entry && isNumeric(entry.spec) ? entry.spec : def.fallback;
  const min = numberOr(spec.min, 0);
  const max = numberOr(spec.max, 1);
  const step = numberOr(spec.step, (max - min) / 100);
  const current = input.disabled ? undefined : Number(input.value);
  const value = numberOr(current, numberOr(state.params[def.param], numberOr(spec.default, min)));
  input.min = String(min);
  input.max = String(max);
  input.step = String(step || 0.01);
  input.value = String(value);
  input.disabled = false;
  out.textContent = formatKnob(value);
  state.params[def.param] = coerceKnobValue(spec, value);
  state.sliderControls.set(control, { input, out, spec, param: def.param, sendDirect: def.sendDirect });
}

function bindMousePad() {
  const setFromEvent = (event) => {
    const rect = els.xyPad.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    state.pointer.x = x * 2 - 1;
    state.pointer.y = (1 - y) * 2 - 1;
    els.puck.style.left = `${x * 100}%`;
    els.puck.style.top = `${y * 100}%`;
    els.eyeDistance.value = (state.pointer.x * FACE_BLEND_LIMIT).toFixed(3);
    els.jawLine.value = (state.pointer.y * FACE_BLEND_LIMIT).toFixed(3);
  };

  els.xyPad.addEventListener("pointerdown", (event) => {
    state.pointer.active = true;
    els.xyPad.setPointerCapture(event.pointerId);
    setFromEvent(event);
  });
  els.xyPad.addEventListener("pointermove", (event) => {
    if (state.pointer.active) setFromEvent(event);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    els.xyPad.addEventListener(type, () => {
      state.pointer.active = false;
    });
  }

  els.eyeDistance.addEventListener("input", () => {
    state.pointer.x = clamp(Number(els.eyeDistance.value) / FACE_BLEND_LIMIT, -1, 1);
    updatePuckFromSliders();
  });
  els.jawLine.addEventListener("input", () => {
    state.pointer.y = clamp(Number(els.jawLine.value) / FACE_BLEND_LIMIT, -1, 1);
    updatePuckFromSliders();
  });
}

function updatePuckFromSliders() {
  const x = (state.pointer.x + 1) / 2;
  const y = 1 - (state.pointer.y + 1) / 2;
  els.puck.style.left = `${x * 100}%`;
  els.puck.style.top = `${y * 100}%`;
}

function bindEngineControls() {
  els.start.addEventListener("click", startDemon);
  els.stop.addEventListener("click", stopDemon);
  els.webcam.addEventListener("click", startWebcam);
  els.promptBlend.addEventListener("input", () => {
    state.remote?.sendSetPromptBlend(Number(els.promptBlend.value));
  });
  bindKnobSlider("denoise", els.denoise, els.denoiseValue);
  bindKnobSlider("structure", els.structure, els.structureValue);
  bindKnobSlider("timbre", els.timbre, els.timbreValue);
  bindRangePointer(els.denoise);
  bindRangePointer(els.structure);
  bindRangePointer(els.timbre);
  bindRangePointer(els.loraStrength);
  els.loraStrength.addEventListener("input", () => {
    state.loraStrength = Number(els.loraStrength.value);
    els.loraStrengthValue.textContent = formatKnob(state.loraStrength);
    sendLoraStrength();
  });
  els.lora.addEventListener("change", () => {
    setActiveLora(els.lora.value);
  });
  els.fixture.addEventListener("change", () => {
    if (!state.remote || !els.fixture.value) return;
    state.remote.sendSwapSourceByName(els.fixture.value, els.promptA.value, DEFAULT_KEY, DEFAULT_BAR_LENGTH);
  });
  for (const input of [els.promptA, els.promptB]) {
    input.addEventListener("change", sendPrompt);
  }
}

function setActiveLora(id) {
  const prev = state.activeLora;
  state.activeLora = id;
  if (!state.remote) return;
  if (prev && prev !== id) state.remote.sendDisableLora(prev);
  if (id) {
    state.remote.sendEnableLora(id, state.loraStrength);
    sendLoraStrength();
  }
}

function sendLoraStrength() {
  if (!state.remote || !state.player || !state.activeLora) return;
  state.remote.sendParams(
    { [`lora_str_${state.activeLora}`]: state.loraStrength },
    state.player.positionSec,
  );
}

function bindKnobSlider(control, input, out) {
  input.addEventListener("input", () => {
    const bind = state.sliderControls.get(control);
    if (!bind) return;
    const next = coerceKnobValue(bind.spec, Number(input.value));
    state.params[bind.param] = next;
    out.textContent = formatKnob(next);
    if (bind.sendDirect && state.remote) bind.sendDirect(state.remote, next);
  });
}

function bindRangePointer(input) {
  let activePointer = null;

  input.addEventListener("pointerdown", (event) => {
    if (input.disabled) return;
    activePointer = event.pointerId;
    input.setPointerCapture(event.pointerId);
    input.focus();
    event.preventDefault();
    setRangeFromPointer(input, event.clientX);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  input.addEventListener("pointermove", (event) => {
    if (input.disabled || activePointer !== event.pointerId) return;
    event.preventDefault();
    setRangeFromPointer(input, event.clientX);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  for (const type of ["pointerup", "pointercancel"]) {
    input.addEventListener(type, (event) => {
      if (activePointer !== event.pointerId) return;
      activePointer = null;
      if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

function setRangeFromPointer(input, clientX) {
  const rect = input.getBoundingClientRect();
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 0;
  const unit = clamp01((clientX - rect.left) / Math.max(1, rect.width));
  let value = min + (max - min) * unit;
  if (step > 0) value = Math.round((value - min) / step) * step + min;
  input.value = String(clamp(value, min, max));
}

async function startWebcam() {
  if (!state.tracker) return;
  if (state.webcamHandle) {
    state.webcamHandle.stop();
    state.webcamHandle = null;
  }

  els.webcam.disabled = true;
  setStatus("Requesting webcam for three-mediapipe-rig...", "warn");
  try {
    state.webcamHandle = await state.tracker.setVideoFromWebcam(false);
    setStatus("Webcam driving the package canonical face geometry.", state.running ? "live" : "idle");
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Webcam failed.", "warn");
  } finally {
    els.webcam.disabled = false;
  }
}

async function startDemon() {
  if (state.remote || !els.fixture.value) return;
  setStatus("Connecting to DEMON...", "warn");
  els.start.disabled = true;

  const remote = new RemoteBackend(
    wsUrl(),
    new Float32Array(0),
    2,
    {
      prompt: els.promptA.value,
      prompt_b: els.promptB.value,
      lora: true,
      sde: false,
      depth: DEFAULT_DEPTH,
      steps: DEFAULT_CONFIG.engine.steps,
      fixture_name: els.fixture.value,
      use_server_fixture: true,
    },
    { sliceWorkerUrl: "/sdk/sliceDecoder.worker.js" },
  );
  const player = new AudioPlayer({ workletUrl: "/sdk/audio-worklet.js" });
  state.remote = remote;
  state.player = player;
  wireRemote(remote, player);

  try {
    await remote.connect();
    await player.init(remote.initialBuffer, remote.channels);
    await player.resume();
    attachAnalyser(player);
    sendPrompt();
    sendDirectSliderValues();
    if (els.lora.value) setActiveLora(els.lora.value);
    state.running = true;
    els.stop.disabled = false;
    setStatus("DEMON live. Beat is moving the control dot.", "live");
  } catch (error) {
    console.error(error);
    stopDemon();
    setStatus(error instanceof Error ? error.message : "DEMON connection failed.", "warn");
  }
}

function wireRemote(remote, player) {
  remote.addEventListener("ready", () => {
    if (!state.loras.length && Array.isArray(remote.loraCatalog)) {
      state.loras = remote.loraCatalog;
      fillLoras();
    }
    if (remote.knobManifest) applyManifest(remote.knobManifest);
  });
  remote.addEventListener("lora_catalog", (event) => {
    state.loras = Array.isArray(event.detail) ? event.detail : [];
    fillLoras();
    fetchKnobManifest()
      .then(applyManifest)
      .catch(() => {});
  });
  remote.addEventListener("params", (event) => mergeParams(event.detail));
  remote.addEventListener("params_echo", (event) => mergeParams(event.detail));
  remote.addEventListener("prompt_blend_echo", (event) => {
    if (Number.isFinite(event.detail)) els.promptBlend.value = String(event.detail);
  });
  remote.addEventListener("slice", (event) => {
    const slice = event.detail;
    if (slice.epoch !== player.swapCount) return;
    if (slice.flags === SLICE_FLAG_DELTA) player.addDelta(slice.startSample, slice.audio);
    else player.patch(slice.startSample, slice.audio);
  });
  remote.addEventListener("swap_ready", (event) => {
    player.swap(event.detail.interleaved, event.detail.channels);
    if (event.detail.fixture_name) els.fixture.value = event.detail.fixture_name;
  });
  remote.addEventListener("close", () => {
    if (!remote.closedByUser) setStatus("DEMON socket closed.", "warn");
  });
}

function mergeParams(raw) {
  if (!raw || typeof raw !== "object") return;
  Object.assign(state.params, raw);
  for (const bind of state.sliderControls.values()) {
    if (!(bind.param in raw)) continue;
    bind.input.value = String(raw[bind.param]);
    bind.out.textContent = formatKnob(raw[bind.param]);
  }
}

function attachAnalyser(player) {
  if (!player.ctx || !player.node) return;
  const analyser = player.ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.72;
  player.node.connect(analyser);
  state.analyser = analyser;
  state.freq = new Uint8Array(analyser.frequencyBinCount);
}

function stopDemon() {
  state.running = false;
  state.remote?.close();
  state.remote = null;
  state.player = null;
  state.analyser = null;
  state.freq = null;
  els.start.disabled = false;
  els.stop.disabled = true;
  setStatus("Stopped.", "idle");
}

function sendPrompt() {
  state.remote?.sendPrompt(els.promptA.value, DEFAULT_KEY, DEFAULT_BAR_LENGTH, els.promptB.value);
  state.remote?.sendSetPromptBlend(Number(els.promptBlend.value));
}

function sendDirectSliderValues() {
  if (!state.remote) return;
  for (const bind of state.sliderControls.values()) {
    if (!bind.sendDirect) continue;
    bind.sendDirect(state.remote, coerceKnobValue(bind.spec, Number(bind.input.value)));
  }
}

function render(timeMs) {
  const now = (timeMs || performance.now()) / 1000;
  const dt = Math.min(now - lastFrameSec, 0.05);
  lastFrameSec = now;
  elapsedSec += dt;

  updateAudio(dt, elapsedSec);
  updateReactor();
  applyPackageFaceControls();
  state.faceBinding?.update(dt);
  updateDemonParams(elapsedSec);
  controls.update();
  renderer.render(scene, camera);
}

function updateAudio(dt, t) {
  if (state.analyser && state.freq) {
    state.analyser.getByteFrequencyData(state.freq);
    state.audio.bass = bandAverage(state.freq, 0, 8);
    state.audio.mid = bandAverage(state.freq, 9, 46);
    state.audio.spark = bandAverage(state.freq, 47, state.freq.length - 1);
    state.audio.kick = state.player?.kick || state.audio.bass;
  } else {
    state.audio.bass = 0;
    state.audio.mid = 0;
    state.audio.spark = 0;
    state.audio.kick = 0;
  }
  state.audio.energy = lerp(
    state.audio.energy,
    clamp01(state.audio.bass * 0.52 + state.audio.mid * 0.32 + state.audio.spark * 0.22 + state.audio.kick * 0.5),
    1 - Math.exp(-dt * 9),
  );
  els.energy.textContent = state.audio.energy.toFixed(2);
  els.engine.textContent = state.running && state.player ? `${state.player.positionSec.toFixed(1)}s` : "idle";
  els.bass.style.transform = `scaleX(${Math.max(0.02, state.audio.bass)})`;
  els.mid.style.transform = `scaleX(${Math.max(0.02, state.audio.mid)})`;
  els.spark.style.transform = `scaleX(${Math.max(0.02, state.audio.spark)})`;
}

function applyPackageFaceControls() {
  const mesh = state.faceMesh;
  if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) return;
  const eff = state.effective;
  setMorph(mesh, "eyeDistance", clamp(eff.x * FACE_BLEND_LIMIT, -FACE_BLEND_LIMIT, FACE_BLEND_LIMIT));
  setMorph(mesh, "jawLine", clamp(eff.y * FACE_BLEND_LIMIT, -FACE_BLEND_LIMIT, FACE_BLEND_LIMIT));
  if (state.uvNode) {
    state.uvNode.value = uvFactorValue();
  }
  // The dot owns the warp; the kick only pulses the lights for ambiance.
  const kick = state.audio.kick;
  pink.intensity = 5.8 + kick * 4.2;
  cyan.intensity = 4.8 + kick * 3.6;
}

function uvFactorValue() {
  const value = Number(els.uvFactor.value);
  return value <= UV_FACTOR_DEAD_ZONE ? 0 : value;
}

// Beats elapsed on the music clock. Uses the playhead + detected BPM when a
// session is live, otherwise a wall-clock fallback so the dot still moves.
function beatClock() {
  const bpm = Number(state.remote?.detectedBpm) || FALLBACK_BPM;
  const pos = state.running && state.player ? state.player.positionSec : elapsedSec;
  return (pos * bpm) / 60;
}

// Cheap deterministic [0,1) hash so a step index always maps to the same point
// (lets continuous mode glide between consecutive random targets).
function reactHash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function reactRandomPoint(step) {
  const angle = reactHash(step) * Math.PI * 2;
  // Keep radius in [0.5, 1] so every retarget is a visible jump, never a nudge.
  const radius = 0.5 + 0.5 * reactHash(step * 1.37 + 19.19);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Beat-synced offset (in pad units) added to the manual center. Magnitude is
// scaled by Strength; Division sets the cadence; Method sets the path; Mode
// chooses snap (discrete) vs glide (continuous).
function computeReactOffset() {
  const strength = Number(els.reactStrength.value);
  if (!(strength > 0)) return { x: 0, y: 0 };

  const divBeats = Number(els.reactDivision.value) || 4;
  const method = els.reactMethod.value;
  const discrete = els.reactMode.value === "discrete";
  const p = beatClock() / divBeats; // advances 1.0 per division
  const step = Math.floor(p);
  const frac = p - step;

  let x = 0;
  let y = 0;
  if (method === "random") {
    if (discrete) {
      const pt = reactRandomPoint(step);
      x = pt.x;
      y = pt.y;
    } else {
      const a = reactRandomPoint(step);
      const b = reactRandomPoint(step + 1);
      const t = smoothstep(frac);
      x = lerp(a.x, b.x, t);
      y = lerp(a.y, b.y, t);
    }
  } else if (method === "circular") {
    const angle = ((discrete ? step : p) / REACT_CYCLE_DIVS) * Math.PI * 2;
    x = Math.cos(angle);
    y = Math.sin(angle);
  } else {
    // sine: oscillate horizontally through the center, one cycle per 4 divisions.
    const angle = ((discrete ? step : p) / REACT_CYCLE_DIVS) * Math.PI * 2;
    x = Math.sin(angle);
    y = 0;
  }

  return { x: x * strength, y: y * strength };
}

function updateReactor() {
  const offset = computeReactOffset();
  const ex = clamp(state.pointer.x + offset.x, -1, 1);
  const ey = clamp(state.pointer.y + offset.y, -1, 1);
  state.effective.x = ex;
  state.effective.y = ey;
  const px = (ex + 1) / 2;
  const py = 1 - (ey + 1) / 2;
  els.puck.style.left = `${px * 100}%`;
  els.puck.style.top = `${py * 100}%`;
}

function setMorph(mesh, name, value) {
  const index = mesh.morphTargetDictionary[name];
  if (index === undefined) return;
  mesh.morphTargetInfluences[index] = value;
}

function updateDemonParams(t) {
  if (!state.remote || !state.player) return;
  if (t - lastParamsAt < 0.035) return;
  lastParamsAt = t;

  const raw = {};
  for (const bind of state.sliderControls.values()) {
    if (bind.sendDirect) continue;
    raw[bind.param] = coerceKnobValue(bind.spec, Number(bind.input.value));
  }
  const loraParam = state.activeLora ? `lora_str_${state.activeLora}` : "";
  if (loraParam) raw[loraParam] = state.loraStrength;
  state.params = raw;
  state.remote.sendParams(raw, state.player.positionSec);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function setStatus(text, tone) {
  els.status.textContent = text;
  els.signal.classList.toggle("live", tone === "live");
  els.signal.classList.toggle("warn", tone === "warn");
}

function wsUrl() {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function defaultKnobValue(spec) {
  if ("default" in spec) return spec.default;
  if (spec.type === "bool") return false;
  if (spec.type === "enum") return spec.options?.[0] ?? "";
  return numberOr(spec.min, 0);
}

function isNumeric(spec) {
  return spec?.type === "float" || spec?.type === "int";
}

function coerceKnobValue(spec, value) {
  if (spec.type === "int") return Math.round(value);
  if (spec.type === "float") return Number(value);
  return value;
}

function formatKnob(value) {
  return typeof value === "number" ? value.toFixed(Math.abs(value) >= 10 ? 0 : 2) : String(value);
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function bandAverage(data, start, end) {
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end && i < data.length; i += 1) {
    sum += data[i] / 255;
    count += 1;
  }
  return count ? sum / count : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
