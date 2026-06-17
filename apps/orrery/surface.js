// surface.js: the Orrery itself. A full-canvas celestial-mechanics
// control surface: every core knob is a planet on an engraved orbit,
// the channel-group amplifiers are a fan of draggable spokes around the
// star, the keystone channels are diamond studs on an outer band, and
// the star at the center breathes with the live audio.
//
// Pure view + input layer: it reads knob state through the handles given
// to createSurface(), reports operator input through hooks.onInput, and
// never touches the network or the SDK.

const TAU = Math.PI * 2;

// Each orbit leaves a dead arc at the bottom of the dial so min and max
// never touch. Canvas angle convention: y down, clockwise positive.
const GAP_HALF = 0.45;
const ARC_START = Math.PI / 2 + GAP_HALF;
const ARC_SWEEP = TAU - 2 * GAP_HALF;

const HUES = { core: 42, lora: 268, groups: 174, keystones: 28 };

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function specMin(spec) {
  return typeof spec.min === "number" ? spec.min : 0;
}

function specMax(spec) {
  return typeof spec.max === "number" ? spec.max : 1;
}

function norm(spec, v) {
  const lo = specMin(spec);
  const hi = specMax(spec);
  return hi > lo ? clamp((v - lo) / (hi - lo), 0, 1) : 0;
}

function denorm(spec, n) {
  const lo = specMin(spec);
  const hi = specMax(spec);
  let v = lo + clamp(n, 0, 1) * (hi - lo);
  if (spec.type === "int") v = Math.round(v);
  return clamp(v, lo, hi);
}

function fmtValue(spec, v) {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v;
  if (spec.type === "int") return String(Math.round(v));
  return v.toFixed(3);
}

export function createSurface(canvas, hooks) {
  const ctx = canvas.getContext("2d");

  let w = 0;
  let h = 0;
  let dpr = 1;
  let cx = 0;
  let cy = 0;
  let R = 0;
  let lastHudW = -1;

  // Layout: name lists partitioned by main.js from the knob manifest.
  let orbitNames = [];
  let spokeNames = [];
  let studNames = [];
  let layoutDirty = true;

  // Per-knob render state the model doesn't need to know about.
  const trails = new Map(); // name -> smoothed display angle
  const colors = new Map(); // name -> {hue, line, glow}

  let stars = [];
  let flares = [];
  let lastFlareId = 0;
  let dialAngle = 0;
  let energyScroll = 0;

  let staticLayer = null; // engraved orbits, ticks, spoke bands
  let dialLayer = null; // outer degree dial (rotates as a bitmap)

  let hover = null; // {kind, name}
  let drag = null;

  function colorFor(name, spec, index) {
    let hue = HUES[spec.group] ?? HUES.core;
    if (name.startsWith("lora_str_")) hue = HUES.lora;
    // Core orbits walk a warm spectrum (gold, orange, rose) instead of
    // drifting into green; the fan/stud bands keep their band identity.
    const step = spec.group === "core" ? -16 : 9;
    hue = (((hue + index * step) % 360) + 360) % 360;
    return {
      hue,
      line: `hsl(${hue} 75% 70%)`,
      glow: `hsl(${hue} 90% 62%)`,
      dim: `hsla(${hue}, 60%, 70%, 0.35)`,
    };
  }

  // ---------------- geometry ----------------

  function orbitRadius(i) {
    const n = orbitNames.length;
    if (n <= 1) return R * 0.82;
    return R * (0.64 + 0.36 * (i / (n - 1)));
  }

  const SPOKE_R0 = 0.21;
  const SPOKE_R1 = 0.4;
  const STUD_R0 = 0.46;
  const STUD_R1 = 0.58;

  function spokeAngle(i) {
    return -Math.PI / 2 + (i * TAU) / Math.max(1, spokeNames.length);
  }

  function studAngle(i) {
    return -Math.PI / 2 + ((i + 0.5) * TAU) / Math.max(1, studNames.length);
  }

  function knobAngle(spec, v) {
    return ARC_START + norm(spec, v) * ARC_SWEEP;
  }

  function pointerNorm(mx, my) {
    const a = Math.atan2(my - cy, mx - cx);
    const rel = (((a - ARC_START) % TAU) + TAU) % TAU;
    if (rel <= ARC_SWEEP) return rel / ARC_SWEEP;
    // Inside the dead arc: snap to the nearer end.
    return rel - ARC_SWEEP < GAP_HALF ? 1 : 0;
  }

  // ---------------- static engraving layers ----------------

  function buildStars() {
    const count = clamp(Math.round((w * h) / 8500), 140, 420);
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.3 + 0.3,
        phase: Math.random() * TAU,
        speed: 0.4 + Math.random() * 1.6,
        depth: 0.2 + Math.random() * 0.8,
      });
    }
  }

  function buildStaticLayer() {
    staticLayer = document.createElement("canvas");
    staticLayer.width = Math.max(1, w * dpr);
    staticLayer.height = Math.max(1, h * dpr);
    const s = staticLayer.getContext("2d");
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.translate(cx, cy);

    // Star mount: concentric hairlines around the core.
    s.strokeStyle = "rgba(190, 210, 255, 0.10)";
    s.lineWidth = 1;
    for (const f of [0.155, 0.175]) {
      s.beginPath();
      s.arc(0, 0, R * f, 0, TAU);
      s.stroke();
    }

    // Spoke band: inner/outer guides, the unity circle, and one faint
    // guide ray per spoke so the fan reads as an instrument at rest.
    if (spokeNames.length) {
      s.strokeStyle = "rgba(127, 232, 224, 0.12)";
      for (const f of [SPOKE_R0, SPOKE_R1]) {
        s.beginPath();
        s.arc(0, 0, R * f, 0, TAU);
        s.stroke();
      }
      const k0 = hooks.knobs.get(spokeNames[0]);
      if (k0) {
        const un = norm(k0.spec, 1.0);
        s.strokeStyle = "rgba(127, 232, 224, 0.20)";
        s.setLineDash([2, 5]);
        s.beginPath();
        s.arc(0, 0, R * (SPOKE_R0 + un * (SPOKE_R1 - SPOKE_R0)), 0, TAU);
        s.stroke();
        s.setLineDash([]);
      }
      s.strokeStyle = "rgba(127, 232, 224, 0.08)";
      for (let i = 0; i < spokeNames.length; i++) {
        const a = spokeAngle(i);
        s.beginPath();
        s.moveTo(Math.cos(a) * R * SPOKE_R0, Math.sin(a) * R * SPOKE_R0);
        s.lineTo(Math.cos(a) * R * SPOKE_R1, Math.sin(a) * R * SPOKE_R1);
        s.stroke();
      }
    }

    // Keystone band.
    if (studNames.length) {
      s.strokeStyle = "rgba(255, 179, 107, 0.10)";
      for (const f of [STUD_R0, STUD_R1]) {
        s.beginPath();
        s.arc(0, 0, R * f, 0, TAU);
        s.stroke();
      }
      s.strokeStyle = "rgba(255, 179, 107, 0.08)";
      for (let i = 0; i < studNames.length; i++) {
        const a = studAngle(i);
        s.beginPath();
        s.moveTo(Math.cos(a) * R * STUD_R0, Math.sin(a) * R * STUD_R0);
        s.lineTo(Math.cos(a) * R * STUD_R1, Math.sin(a) * R * STUD_R1);
        s.stroke();
      }
    }

    // Orbits: ring, engraved tick scale, and end caps at the dead arc.
    for (let i = 0; i < orbitNames.length; i++) {
      const r = orbitRadius(i);
      s.strokeStyle = "rgba(190, 210, 255, 0.16)";
      s.lineWidth = 1;
      s.beginPath();
      s.arc(0, 0, r, ARC_START, ARC_START + ARC_SWEEP);
      s.stroke();

      const ticks = 100;
      for (let j = 0; j <= ticks; j++) {
        const a = ARC_START + (j / ticks) * ARC_SWEEP;
        const major = j % 10 === 0;
        const len = major ? 6 : 3;
        s.strokeStyle = major
          ? "rgba(190, 210, 255, 0.28)"
          : "rgba(190, 210, 255, 0.10)";
        s.beginPath();
        s.moveTo(Math.cos(a) * (r - len), Math.sin(a) * (r - len));
        s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        s.stroke();
      }
      for (const a of [ARC_START, ARC_START + ARC_SWEEP]) {
        s.strokeStyle = "rgba(190, 210, 255, 0.35)";
        s.beginPath();
        s.moveTo(Math.cos(a) * (r - 9), Math.sin(a) * (r - 9));
        s.lineTo(Math.cos(a) * (r + 4), Math.sin(a) * (r + 4));
        s.stroke();
      }
    }
  }

  function buildDialLayer() {
    const size = Math.ceil(R * 2.3);
    dialLayer = document.createElement("canvas");
    dialLayer.width = Math.max(1, size * dpr);
    dialLayer.height = Math.max(1, size * dpr);
    const s = dialLayer.getContext("2d");
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.translate(size / 2, size / 2);

    const r0 = R * 1.045;
    const r1 = R * 1.075;
    s.strokeStyle = "rgba(190, 210, 255, 0.14)";
    s.lineWidth = 1;
    for (const r of [r0, r1]) {
      s.beginPath();
      s.arc(0, 0, r, 0, TAU);
      s.stroke();
    }
    for (let deg = 0; deg < 360; deg += 2) {
      const a = (deg / 360) * TAU;
      const major = deg % 10 === 0;
      const len = major ? r1 - r0 : (r1 - r0) * 0.45;
      s.strokeStyle = major
        ? "rgba(190, 210, 255, 0.30)"
        : "rgba(190, 210, 255, 0.12)";
      s.beginPath();
      s.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      s.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len));
      s.stroke();
    }
    if (R > 240) {
      s.fillStyle = "rgba(190, 210, 255, 0.40)";
      s.font = "9px ui-monospace, Consolas, monospace";
      s.textAlign = "center";
      s.textBaseline = "middle";
      for (let deg = 0; deg < 360; deg += 30) {
        const a = (deg / 360) * TAU;
        s.save();
        s.translate(Math.cos(a) * R * 1.105, Math.sin(a) * R * 1.105);
        s.rotate(a + Math.PI / 2);
        s.fillText(String(deg).padStart(3, "0"), 0, 0);
        s.restore();
      }
    }
  }

  function rebuildGeometry() {
    const hudW = hooks.getHudWidth ? hooks.getHudWidth() : 0;
    cx = Math.max(260, (w - hudW) / 2);
    cy = h / 2;
    R = Math.max(110, Math.min(cx - 30, cy - 30) * 0.95);

    colors.clear();
    let idx = 0;
    for (const name of [...orbitNames, ...spokeNames, ...studNames]) {
      const k = hooks.knobs.get(name);
      if (k) colors.set(name, colorFor(name, k.spec, idx++));
    }
    buildStaticLayer();
    buildDialLayer();
    layoutDirty = false;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    buildStars();
    layoutDirty = true;
  }

  // ---------------- hit testing + input ----------------

  function planetPos(i, name) {
    const k = hooks.knobs.get(name);
    const r = orbitRadius(i);
    const a = knobAngle(k.spec, k.value);
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r, a };
  }

  function pick(mx, my) {
    for (let i = orbitNames.length - 1; i >= 0; i--) {
      const p = planetPos(i, orbitNames[i]);
      if (Math.hypot(mx - p.x, my - p.y) <= 14) {
        return { kind: "orbit", name: orbitNames[i], index: i };
      }
    }
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);

    if (studNames.length) {
      const b0 = R * STUD_R0 - 12;
      const b1 = R * STUD_R1 + 12;
      if (dist >= b0 && dist <= b1) {
        const sector = TAU / studNames.length;
        for (let i = 0; i < studNames.length; i++) {
          let d = Math.abs(ang - studAngle(i));
          d = Math.min(d, TAU - d);
          if (d < sector * 0.32) {
            return { kind: "stud", name: studNames[i], index: i };
          }
        }
      }
    }
    if (spokeNames.length) {
      const b0 = R * SPOKE_R0 - 12;
      const b1 = R * SPOKE_R1 + 12;
      if (dist >= b0 && dist <= b1) {
        const sector = TAU / spokeNames.length;
        for (let i = 0; i < spokeNames.length; i++) {
          let d = Math.abs(ang - spokeAngle(i));
          d = Math.min(d, TAU - d);
          if (d < sector * 0.36) {
            return { kind: "spoke", name: spokeNames[i], index: i };
          }
        }
      }
    }
    // Bare orbit ring: clicking the scale jumps the planet there.
    for (let i = 0; i < orbitNames.length; i++) {
      const r = orbitRadius(i);
      if (Math.abs(dist - r) <= 8) {
        const rel = (((ang - ARC_START) % TAU) + TAU) % TAU;
        if (rel <= ARC_SWEEP) {
          return { kind: "ring", name: orbitNames[i], index: i };
        }
      }
    }
    return null;
  }

  function applyPointer(target, mx, my) {
    const k = hooks.knobs.get(target.name);
    if (!k) return;
    let v;
    if (target.kind === "orbit" || target.kind === "ring") {
      v = denorm(k.spec, pointerNorm(mx, my));
    } else {
      const band0 = target.kind === "spoke" ? SPOKE_R0 : STUD_R0;
      const band1 = target.kind === "spoke" ? SPOKE_R1 : STUD_R1;
      const dist = Math.hypot(mx - cx, my - cy);
      const n = (dist - R * band0) / (R * (band1 - band0));
      v = denorm(k.spec, n);
    }
    hooks.onInput(target.name, v);
  }

  function localXY(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  canvas.addEventListener("pointerdown", (e) => {
    const [mx, my] = localXY(e);
    const t = pick(mx, my);
    if (!t) return;
    drag = t;
    canvas.setPointerCapture(e.pointerId);
    applyPointer(t, mx, my);
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    const [mx, my] = localXY(e);
    if (drag) {
      applyPointer(drag, mx, my);
    } else {
      hover = pick(mx, my);
      canvas.style.cursor = hover ? "grab" : "default";
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      const [mx, my] = localXY(e);
      const t = drag || hover || pick(mx, my);
      if (!t) return;
      const k = hooks.knobs.get(t.name);
      if (!k) return;
      e.preventDefault();
      const span = specMax(k.spec) - specMin(k.spec);
      const dir = e.deltaY < 0 ? 1 : -1;
      const step =
        k.spec.type === "int"
          ? dir
          : span * (e.shiftKey ? 0.02 : 0.004) * dir;
      hooks.onInput(
        t.name,
        clamp(k.target + step, specMin(k.spec), specMax(k.spec)),
      );
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", (e) => {
    const [mx, my] = localXY(e);
    const t = pick(mx, my);
    if (!t) return;
    const k = hooks.knobs.get(t.name);
    if (k && typeof k.spec.default === "number") {
      hooks.onInput(t.name, k.spec.default);
    }
  });

  // ---------------- drawing ----------------

  function drawBackground(t, az) {
    ctx.fillStyle = "#04050b";
    ctx.fillRect(0, 0, w, h);

    // Nebula washes, hue led by the spectral centroid.
    const hue = 200 + az.centroid * 120;
    const breathe = 0.05 + az.rms * 0.25;
    let g = ctx.createRadialGradient(
      cx - R * 0.9,
      cy - R * 0.7,
      0,
      cx - R * 0.9,
      cy - R * 0.7,
      R * 1.8,
    );
    g.addColorStop(0, `hsla(${hue}, 70%, 50%, ${breathe})`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    g = ctx.createRadialGradient(
      cx + R * 1.1,
      cy + R * 0.8,
      0,
      cx + R * 1.1,
      cy + R * 0.8,
      R * 1.6,
    );
    g.addColorStop(0, `hsla(${(hue + 90) % 360}, 65%, 45%, ${breathe * 0.7})`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    energyScroll += az.rms * 0.5 + 0.02;
    ctx.fillStyle = "#fff";
    for (const st of stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * st.speed + st.phase);
      const y = (st.y + energyScroll * st.depth) % h;
      ctx.globalAlpha = 0.18 + tw * 0.55 * st.depth;
      ctx.fillRect(st.x, y, st.r, st.r);
    }
    ctx.globalAlpha = 1;
  }

  function drawDial(t, az, playhead) {
    dialAngle += 0.0006 + az.rms * 0.004;
    const size = dialLayer.width / dpr;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(dialAngle);
    ctx.drawImage(dialLayer, -size / 2, -size / 2, size, size);
    ctx.restore();

    // Playhead progress arc rides above the dial and does not rotate.
    if (playhead.dur > 0) {
      const frac = clamp(playhead.pos / playhead.dur, 0, 1);
      const a0 = -Math.PI / 2;
      const a1 = a0 + frac * TAU;
      ctx.strokeStyle = "rgba(255, 217, 138, 0.55)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(255, 217, 138, 0.8)";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.06, a0, a1);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffe9bb";
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(a1) * R * 1.06,
        cy + Math.sin(a1) * R * 1.06,
        3,
        0,
        TAU,
      );
      ctx.fill();
    }
  }

  function drawSpokes(az) {
    for (let i = 0; i < spokeNames.length; i++) {
      const name = spokeNames[i];
      const k = hooks.knobs.get(name);
      if (!k) continue;
      const c = colors.get(name);
      const a = spokeAngle(i);
      const n = norm(k.spec, k.value);
      const r0 = R * SPOKE_R0;
      const r1 = r0 + n * R * (SPOKE_R1 - SPOKE_R0);
      const shimmer = az.bands[(i * 3) % az.bands.length];
      const hot =
        (hover && hover.name === name) || (drag && drag.name === name);

      ctx.strokeStyle = c.line;
      ctx.lineWidth = hot ? 4 : 3;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 6 + shimmer * 14;
      ctx.globalAlpha = 0.55 + shimmer * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#eaf6ff";
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(a) * r1,
        cy + Math.sin(a) * r1,
        hot ? 4.5 : 3,
        0,
        TAU,
      );
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawStuds(az) {
    for (let i = 0; i < studNames.length; i++) {
      const name = studNames[i];
      const k = hooks.knobs.get(name);
      if (!k) continue;
      const c = colors.get(name);
      const a = studAngle(i);
      const n = norm(k.spec, k.value);
      const r = R * (STUD_R0 + n * (STUD_R1 - STUD_R0));
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const hot =
        (hover && hover.name === name) || (drag && drag.name === name);
      const size = hot ? 7 : 5;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI / 4);
      ctx.fillStyle = c.line;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = hot ? 16 : 8;
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
  }

  function drawOrbits(t) {
    for (let i = 0; i < orbitNames.length; i++) {
      const name = orbitNames[i];
      const k = hooks.knobs.get(name);
      if (!k) continue;
      const c = colors.get(name);
      const r = orbitRadius(i);
      const a = knobAngle(k.spec, k.value);
      const hot =
        (hover && hover.name === name) || (drag && drag.name === name);

      // Value arc: a wide soft glow under a thin bright stroke.
      ctx.strokeStyle = c.dim;
      ctx.lineWidth = 5;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ARC_START, a);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ARC_START, a);
      ctx.stroke();

      // Comet trail: a fading arc behind the planet when it moves
      // (operator drags, automation, MCP echoes).
      let trail = trails.get(name);
      if (trail === undefined) trail = a;
      trail += (a - trail) * 0.08;
      trails.set(name, trail);
      const dAng = a - trail;
      if (Math.abs(dAng) > 0.004) {
        ctx.strokeStyle = c.glow;
        ctx.lineWidth = 4;
        ctx.globalAlpha = clamp(Math.abs(dAng) * 3, 0, 0.45);
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.min(a, trail), Math.max(a, trail));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // The planet.
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const pr = hot ? 9 : 6.5;
      const g = ctx.createRadialGradient(
        x - pr * 0.35,
        y - pr * 0.35,
        pr * 0.1,
        x,
        y,
        pr,
      );
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.45, c.line);
      g.addColorStop(1, `hsl(${c.hue} 70% 28%)`);
      ctx.fillStyle = g;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = hot ? 22 : 10;
      ctx.beginPath();
      ctx.arc(x, y, pr, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (hot) {
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, pr + 4, 0, TAU);
        ctx.stroke();
      }

      // Label just outside the planet, kept horizontal for legibility.
      // Alternate the radial offset by orbit parity so labels of planets
      // parked at similar angles (fresh defaults) don't stack.
      const lr = r + (i % 2 ? 28 : 16);
      const lx = cx + Math.cos(a) * lr;
      const ly = cy + Math.sin(a) * lr;
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.textAlign = Math.cos(a) >= 0 ? "left" : "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = hot
        ? "rgba(235, 242, 255, 0.95)"
        : "rgba(190, 210, 255, 0.45)";
      ctx.fillText(name.toUpperCase(), lx, ly);
      if (hot) {
        ctx.fillStyle = c.line;
        ctx.fillText(
          fmtValue(k.spec, k.value),
          lx,
          ly + 12,
        );
      }
    }
  }

  function drawStar(t, az) {
    // Flares: expanding rings spawned on bass transients.
    if (az.flareId !== lastFlareId) {
      lastFlareId = az.flareId;
      flares.push({ r: R * 0.14, alpha: 0.5 * (0.5 + az.flarePower) });
    }
    flares = flares.filter((f) => f.alpha > 0.02);
    for (const f of flares) {
      ctx.strokeStyle = `rgba(255, 226, 170, ${f.alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, f.r, 0, TAU);
      ctx.stroke();
      f.r += R * 0.012 + 2;
      f.alpha *= 0.93;
    }

    // The core stays white-gold like a star; the corona carries the
    // spectral-centroid hue (warm for bassy material, blue for bright).
    const coronaHue = 30 + az.centroid * 180;
    const rs = R * 0.115 * (0.85 + az.rms * 1.6 + az.kick * 0.4);

    // Corona rays, one band of the live spectrum each.
    const rays = 48;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + t * 0.05;
      const band = az.bands[i % az.bands.length];
      const len = rs * (0.25 + band * 1.7);
      ctx.strokeStyle = `hsla(${coronaHue}, 85%, 72%, ${0.08 + band * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rs * 0.92, cy + Math.sin(a) * rs * 0.92);
      ctx.lineTo(cx + Math.cos(a) * (rs + len), cy + Math.sin(a) * (rs + len));
      ctx.stroke();
    }

    // Core.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rs * 1.5);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, "#ffe9c0");
    g.addColorStop(0.8, `hsla(${coronaHue}, 85%, 60%, 0.30)`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rs * 1.5, 0, TAU);
    ctx.fill();
  }

  function wrapText(text, width) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > width) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
      if (lines.length === 3) break;
    }
    if (line && lines.length < 3) lines.push(line);
    return lines;
  }

  function drawChrome() {
    ctx.font = "12px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(207, 216, 238, 0.85)";
    ctx.fillText("D E M O N  ⟡  O R R E R Y", 22, 20);
    ctx.font = "9px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(108, 118, 147, 0.9)";
    ctx.fillText(hooks.getStatusLine(), 22, 38);

    ctx.textAlign = "right";
    ctx.fillText(
      "drag planets · wheel fine-trim · double-click reset · H console",
      w - 18,
      h - 22,
    );

    const focus = drag || hover;
    ctx.textAlign = "left";
    if (focus) {
      const k = hooks.knobs.get(focus.name);
      if (k) {
        const c = colors.get(focus.name);
        let y = h - 78;
        ctx.font = "11px ui-monospace, Consolas, monospace";
        ctx.fillStyle = c ? c.line : "#cfd8ee";
        ctx.fillText(
          `${focus.name.toUpperCase()}   ${fmtValue(k.spec, k.value)}` +
            `   [${fmtValue(k.spec, specMin(k.spec))} … ${fmtValue(k.spec, specMax(k.spec))}]`,
          22,
          y,
        );
        ctx.font = "9px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "rgba(150, 162, 192, 0.85)";
        for (const line of wrapText(k.spec.description || "", 64)) {
          y += 14;
          ctx.fillText(line, 22, y);
        }
      }
    }
  }

  // ---------------- main loop ----------------

  let raf = 0;
  const t0 = performance.now();

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = (performance.now() - t0) / 1000;

    if (canvas.clientWidth !== w || canvas.clientHeight !== h) resize();
    const hudW = hooks.getHudWidth ? hooks.getHudWidth() : 0;
    if (layoutDirty || hudW !== lastHudW) {
      lastHudW = hudW;
      rebuildGeometry();
    }

    const az = hooks.getAnalysis(t);
    const playhead = hooks.getPlayhead();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(t, az);
    drawDial(t, az, playhead);
    ctx.drawImage(staticLayer, 0, 0, w, h);
    drawSpokes(az);
    drawStuds(az);
    drawOrbits(t);
    drawStar(t, az);
    drawChrome();
  }

  resize();
  frame();

  return {
    setLayout({ orbits, spokes, studs }) {
      orbitNames = orbits;
      spokeNames = spokes;
      studNames = studs;
      layoutDirty = true;
    },
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}
