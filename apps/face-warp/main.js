import * as THREE from "three/webgpu";
import { GLTFLoader, OrbitControls } from "three/examples/jsm/Addons.js";
import { mix, texture, uniform } from "three/tsl";
import { setupTracker } from "https://esm.sh/three-mediapipe-rig@0.1.41?deps=three@0.183.1,@mediapipe/tasks-vision@0.10.32,fflate@0.8.2";
import {
  AudioPlayer,
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
  key: $("keySelect"),
  promptA: $("promptA"),
  promptB: $("promptB"),
  promptBlend: $("promptBlend"),
  depth: $("depth"),
  xKnob: $("xKnob"),
  yKnob: $("yKnob"),
  quickKnobs: $("quickKnobs"),
  xyPad: $("xyPad"),
  puck: $("puck"),
  energy: $("energyReadout"),
  engine: $("engineReadout"),
  eyeDistance: $("eyeDistance"),
  jawLine: $("jawLine"),
  kickReact: $("kickReact"),
  uvFactor: $("uvFactor"),
  roughness: $("roughness"),
  metalness: $("metalness"),
  clearcoat: $("clearcoat"),
  bass: $("bassMeter"),
  mid: $("midMeter"),
  spark: $("sparkMeter"),
};

const FACE_BLEND_LIMIT = 2.25;
const KICK_EYE_RESPONSE = 2.4;
const KICK_JAW_RESPONSE = 2.0;
const UV_FACTOR_DEAD_ZONE = 0.01;

const state = {
  fixtures: [],
  knobEntries: [],
  params: {},
  quick: new Map(),
  pointer: { x: 0, y: 0, active: false },
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
    const [tracker, fixtures, manifest, contract] = await Promise.all([
      setupTracker({
        onlyFace: true,
        displayScale: 0.75,
        drawLandmarksOverlay: false,
      }),
      fetchJson("/api/fixtures").catch(() => []),
      fetchKnobManifest().catch(() => ({ version: 0, knobs: {} })),
      fetchWireContract().catch(() => null),
      renderer.init(),
    ]);

    state.tracker = tracker;
    state.fixtures = Array.isArray(fixtures) ? fixtures : [];
    fillFixtures();
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

function applyManifest(manifest) {
  const knobs = manifest?.knobs && typeof manifest.knobs === "object" ? manifest.knobs : {};
  state.knobEntries = Object.entries(knobs).map(([name, spec]) => ({ name, spec }));
  state.params = {};
  for (const { name, spec } of state.knobEntries) {
    state.params[name] = defaultKnobValue(spec);
  }

  fillAxisSelect(els.xKnob, pickKnobName(["denoise", "feedback", "guidance", "timbre"], 0));
  fillAxisSelect(els.yKnob, pickKnobName(["structure", "timbre", "seed", "shift"], 1));
  makeQuickKnobs();
}

function fillAxisSelect(select, selected) {
  select.replaceChildren();
  for (const { name, spec } of state.knobEntries) {
    if (!isMappable(spec)) continue;
    const option = document.createElement("option");
    option.value = name;
    option.textContent = labelFor(name);
    select.append(option);
  }
  if (selected) select.value = selected;
}

function pickKnobName(words, fallbackIndex) {
  const candidates = state.knobEntries.filter(({ spec }) => isMappable(spec));
  for (const word of words) {
    const found = candidates.find(({ name }) => name.toLowerCase().includes(word));
    if (found) return found.name;
  }
  return candidates[fallbackIndex]?.name || candidates[0]?.name || "";
}

function makeQuickKnobs() {
  els.quickKnobs.replaceChildren();
  state.quick.clear();
  const numeric = state.knobEntries.filter(({ spec }) => isNumeric(spec)).slice(0, 5);
  for (const { name, spec } of numeric) {
    const min = numberOr(spec.min, 0);
    const max = numberOr(spec.max, 1);
    const step = numberOr(spec.step, (max - min) / 100);
    const value = numberOr(state.params[name], numberOr(spec.default, min));
    const row = document.createElement("div");
    row.className = "quick-row";
    const title = document.createElement("span");
    title.textContent = labelFor(name);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step || 0.01);
    input.value = String(value);
    const out = document.createElement("span");
    out.textContent = formatKnob(value);
    input.addEventListener("input", () => {
      const next = coerceKnobValue(spec, Number(input.value));
      state.params[name] = next;
      out.textContent = formatKnob(next);
    });
    row.append(title, input, out);
    els.quickKnobs.append(row);
    state.quick.set(name, { input, out, spec });
  }
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
  els.depth.addEventListener("change", () => {
    state.remote?.sendSetDepth(Number(els.depth.value));
  });
  els.fixture.addEventListener("change", () => {
    if (!state.remote || !els.fixture.value) return;
    state.remote.sendSwapSourceByName(els.fixture.value, els.promptA.value, els.key.value, "4");
  });
  for (const input of [els.promptA, els.promptB, els.key]) {
    input.addEventListener("change", sendPrompt);
  }
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
      depth: Number(els.depth.value),
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
    state.running = true;
    els.stop.disabled = false;
    setStatus("DEMON live. Kick is driving face reaction.", "live");
  } catch (error) {
    console.error(error);
    stopDemon();
    setStatus(error instanceof Error ? error.message : "DEMON connection failed.", "warn");
  }
}

function wireRemote(remote, player) {
  remote.addEventListener("ready", () => {
    if (remote.knobManifest) applyManifest(remote.knobManifest);
    if (remote.detectedKey) els.key.value = remote.detectedKey;
    if (remote.pipelineDepth) els.depth.value = String(remote.pipelineDepth);
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
  remote.addEventListener("depth_applied", (event) => {
    if (event.detail?.depth) els.depth.value = String(event.detail.depth);
  });
  remote.addEventListener("close", () => {
    if (!remote.closedByUser) setStatus("DEMON socket closed.", "warn");
  });
}

function mergeParams(raw) {
  if (!raw || typeof raw !== "object") return;
  Object.assign(state.params, raw);
  for (const [name, bind] of state.quick) {
    if (!(name in raw)) continue;
    bind.input.value = String(raw[name]);
    bind.out.textContent = formatKnob(raw[name]);
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
  state.remote?.sendPrompt(els.promptA.value, els.key.value, "4", els.promptB.value);
  state.remote?.sendSetPromptBlend(Number(els.promptBlend.value));
}

function render(timeMs) {
  const now = (timeMs || performance.now()) / 1000;
  const dt = Math.min(now - lastFrameSec, 0.05);
  lastFrameSec = now;
  elapsedSec += dt;

  updateAudio(dt, elapsedSec);
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
  const kick = state.audio.kick;
  const reaction = Number(els.kickReact.value);
  const eyeRest = Number(els.eyeDistance.value);
  const jawRest = Number(els.jawLine.value);
  const eyeKick = clamp01(kick * reaction * KICK_EYE_RESPONSE);
  const jawKick = clamp01(kick * reaction * KICK_JAW_RESPONSE);
  setMorph(mesh, "eyeDistance", kickTowardOppositeExtreme(eyeRest, eyeKick));
  setMorph(mesh, "jawLine", kickTowardOppositeExtreme(jawRest, jawKick));
  if (state.uvNode) {
    state.uvNode.value = uvFactorValue();
  }
  pink.intensity = 5.8;
  cyan.intensity = 4.8;
}

function uvFactorValue() {
  const value = Number(els.uvFactor.value);
  return value <= UV_FACTOR_DEAD_ZONE ? 0 : value;
}

function kickTowardOppositeExtreme(rest, amount) {
  const clampedRest = clamp(rest, -FACE_BLEND_LIMIT, FACE_BLEND_LIMIT);
  const direction = clampedRest >= 0 ? -1 : 1;
  const opposite = direction * FACE_BLEND_LIMIT;
  const biasedOpposite = lerp(opposite, clampedRest, 0.08);
  return lerp(clampedRest, biasedOpposite, amount);
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

  const raw = { ...state.params };
  mapAxis(raw, els.xKnob.value, (state.pointer.x + 1) / 2);
  mapAxis(raw, els.yKnob.value, (state.pointer.y + 1) / 2);
  for (const [name, bind] of state.quick) {
    raw[name] = coerceKnobValue(bind.spec, Number(bind.input.value));
  }
  state.params = raw;
  state.remote.sendParams(raw, state.player.positionSec);
}

function mapAxis(raw, name, unit) {
  if (!name) return;
  const entry = state.knobEntries.find((item) => item.name === name);
  if (!entry) return;
  raw[name] = valueFromUnit(entry.spec, clamp01(unit));
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

function isMappable(spec) {
  return isNumeric(spec) || spec?.type === "bool" || spec?.type === "enum";
}

function valueFromUnit(spec, unit) {
  if (spec.type === "bool") return unit >= 0.5;
  if (spec.type === "enum") {
    const options = Array.isArray(spec.options) ? spec.options : [];
    return options[Math.min(options.length - 1, Math.floor(unit * options.length))] ?? "";
  }
  const min = numberOr(spec.min, 0);
  const max = numberOr(spec.max, 1);
  return coerceKnobValue(spec, min + (max - min) * unit);
}

function coerceKnobValue(spec, value) {
  if (spec.type === "int") return Math.round(value);
  if (spec.type === "float") return Number(value);
  return value;
}

function labelFor(name) {
  return name.replace(/^lora_str_/, "lora ").replace(/_/g, " ");
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
