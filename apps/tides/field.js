// DEMON TIDES — flow-field visualizer + control surface.
//
// The whole canvas is both the instrument and the picture. A field of
// particles drifts along an animated noise flow-field; the pointer warps the
// current (an attractor with swirl) and the LIVE DEMON audio output drives the
// global energy, bloom, and color temperature via an analyser tap that the
// bridge injects through `audioProvider`.
//
// This file owns ALL input + rendering. It exposes a small, stable surface the
// DEMON bridge reads each tick — exactly like the arp game in the summon demo:
//   field.pointer = { x, y, down, speed }   // normalized 0..1, top-left origin
//   field.structure                         // 0..1 wheel accumulator
//   field.audioProvider = () => ({level, bass})   // set by the bridge
// There is NO audio synthesis here. DEMON renders every sound; the field only
// pictures it and reads the pointer.

const TAU = Math.PI * 2;

// Value noise (hash-based) so the flow-field needs zero dependencies.
function hash(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// DEMON palette anchors (green → cyan), matched to the summon demo.
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    // Control-surface state the bridge reads.
    this.pointer = { x: 0.5, y: 0.5, down: false, speed: 0 };
    this.structure = 0.6; // wheel accumulator → hint_strength
    this.audioProvider = null; // () => ({ level, bass }) — injected by bridge

    // Smoothed visual energy.
    this.level = 0;
    this.bass = 0;
    this._kick = 0;

    // Smoothed pointer (for both visuals and the reported speed).
    this._px = 0.5;
    this._py = 0.5;
    this._rawSpeed = 0;

    this.particles = [];
    this.t = 0;
    this._running = false;
    this._raf = 0;

    this._resize = this._resize.bind(this);
    this._loop = this._loop.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();
    this._seed();
    this._bindInput();
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _seed() {
    const n = window.innerWidth < 760 ? 700 : 1500;
    this.particles = [];
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        life: Math.random(),
        seed: Math.random() * 1000,
      });
    }
  }

  _bindInput() {
    const setFromEvent = (clientX, clientY) => {
      this.pointer.x = Math.max(0, Math.min(1, clientX / this.w));
      this.pointer.y = Math.max(0, Math.min(1, clientY / this.h));
    };
    window.addEventListener("pointermove", (e) => setFromEvent(e.clientX, e.clientY));
    window.addEventListener("pointerdown", (e) => {
      // Ignore presses that land on the control panel (its own UI).
      if (e.target && e.target.closest && e.target.closest("#tides-panel")) return;
      this.pointer.down = true;
      setFromEvent(e.clientX, e.clientY);
    });
    window.addEventListener("pointerup", () => { this.pointer.down = false; });
    window.addEventListener("pointercancel", () => { this.pointer.down = false; });
    // Wheel sets structure (scroll up = tighter / more source adherence).
    window.addEventListener(
      "wheel",
      (e) => {
        if (e.target && e.target.closest && e.target.closest("#tides-panel")) return;
        this.structure = Math.max(0, Math.min(1, this.structure - e.deltaY * 0.0008));
      },
      { passive: true },
    );
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  // Vector field angle at a point, animated over time and warped by the pointer.
  _flowAngle(x, y, cx, cy) {
    const s = 0.0016;
    const a =
      vnoise(x * s + this.t * 0.06, y * s) * 1.4 +
      vnoise(x * s, y * s + this.t * 0.05) * 1.4;
    let ang = a * TAU;
    // Pointer swirl: rotate the field around the cursor, strength falling off
    // with distance. More remix (denoise, ~ pointer X) tightens the swirl.
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy) + 1;
    const pull = Math.min(1, 240 / dist);
    const swirl = Math.atan2(dy, dx) + Math.PI / 2;
    ang = ang * (1 - pull) + swirl * pull;
    return ang;
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._loop);

    // ── Audio energy (from the live DEMON output) ──────────────────────────
    let level = 0, bass = 0;
    if (this.audioProvider) {
      try {
        const a = this.audioProvider();
        level = a.level || 0;
        bass = a.bass || 0;
      } catch {}
    }
    this.level += (level - this.level) * 0.2;
    this.bass += (bass - this.bass) * 0.25;
    // Kick detector: bass rising above its smoothed floor fires a pulse.
    const kickHit = bass - this.bass > 0.06 ? bass : 0;
    this._kick = Math.max(this._kick * 0.9, kickHit);
    document.documentElement.style.setProperty("--bloom", this._kick.toFixed(3));

    // ── Pointer smoothing + speed ──────────────────────────────────────────
    const tx = this.pointer.x * this.w;
    const ty = this.pointer.y * this.h;
    const cx = this._px * this.w + (tx - this._px * this.w) * 0.18;
    const cy = this._py * this.h + (ty - this._py * this.h) * 0.18;
    const moved = Math.hypot(cx - this._px * this.w, cy - this._py * this.h);
    this._px = cx / this.w;
    this._py = cy / this.h;
    this._rawSpeed += (moved - this._rawSpeed) * 0.2;
    this.pointer.speed = Math.max(0, Math.min(1, this._rawSpeed / 26));

    this.t += 0.016;

    const ctx = this.ctx;
    // Trails: fade the previous frame toward near-black (deep teal tint).
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(2, 9, 7, 0.14)";
    ctx.fillRect(0, 0, this.w, this.h);

    // Color: green → cyan with remix (pointer X); energy brightens it.
    const remix = this.pointer.x;
    const base = mix([108, 255, 176], [79, 208, 255], remix);
    const glow = 0.25 + this.level * 1.4 + this._kick * 0.6;
    const speed = 0.6 + this.pointer.speed * 2.6 + this.level * 2.2;

    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const ang = this._flowAngle(p.x, p.y, cx, cy);
      p.x += Math.cos(ang) * speed;
      p.y += Math.sin(ang) * speed;
      p.life -= 0.004 + this.pointer.speed * 0.01;

      if (
        p.life <= 0 ||
        p.x < -20 || p.x > this.w + 20 ||
        p.y < -20 || p.y > this.h + 20
      ) {
        // Respawn, biased toward the cursor so the current stays inhabited.
        if (Math.random() < 0.45) {
          p.x = cx + (Math.random() - 0.5) * 220;
          p.y = cy + (Math.random() - 0.5) * 220;
        } else {
          p.x = Math.random() * this.w;
          p.y = Math.random() * this.h;
        }
        p.life = 0.6 + Math.random() * 0.4;
        continue;
      }

      const a = Math.min(1, p.life * glow) * 0.5;
      const r = 0.6 + this.level * 1.6 + this._kick * 1.4;
      ctx.fillStyle = `rgba(${base[0]}, ${base[1]}, ${base[2]}, ${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }

    // ── Cursor halo + bloom ────────────────────────────────────────────────
    const haloR = 26 + this.bass * 80 + this._kick * 120;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    const ha = 0.18 + this._kick * 0.5 + (this.pointer.down ? 0.25 : 0);
    grad.addColorStop(0, `rgba(${base[0]}, ${base[1]}, ${base[2]}, ${ha})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, TAU);
    ctx.fill();

    // Crosshair ring marking the control point.
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `rgba(${base[0]}, ${base[1]}, ${base[2]}, ${0.5 + this._kick * 0.4})`;
    ctx.lineWidth = this.pointer.down ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, this.pointer.down ? 16 : 11, 0, TAU);
    ctx.stroke();
  }

  dispose() {
    this.stop();
    window.removeEventListener("resize", this._resize);
  }
}
