// analysis.js: spectral probe over the live stream buffer.
//
// The AudioPlayer keeps a main-thread mirror of the loop buffer
// (player.getMirror()) that patch/addDelta maintain in lockstep with the
// worklet, so the visualization can read the exact audio at the playhead
// without touching the audio thread. Each frame we window 2048 frames
// ending at the playhead, run a radix-2 FFT, and fold the magnitudes
// into 24 log-spaced bands with a global AGC so quiet and loud material
// both light the instrument.

const N = 2048;
const BANDS = 24;
const F_LO = 40;
const F_HI = 16000;

function makeFFT(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float32Array(n / 2);
  const sinT = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const idx = k * step;
          const wr = cosT[idx];
          const wi = -sinT[idx];
          const lo = i + k;
          const hi = lo + half;
          const tr = re[hi] * wr - im[hi] * wi;
          const ti = re[hi] * wi + im[hi] * wr;
          re[hi] = re[lo] - tr;
          im[hi] = im[lo] - ti;
          re[lo] += tr;
          im[lo] += ti;
        }
      }
    }
  };
}

export function createAnalyser(sampleRate = 48000) {
  const fft = makeFFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  // Log-spaced band edges in FFT-bin units.
  const binHz = sampleRate / N;
  const edges = new Uint32Array(BANDS + 1);
  for (let b = 0; b <= BANDS; b++) {
    const f = F_LO * Math.pow(F_HI / F_LO, b / BANDS);
    edges[b] = Math.max(1, Math.min(N / 2 - 1, Math.round(f / binHz)));
  }

  const state = {
    rms: 0,
    kick: 0,
    bands: new Float32Array(BANDS),
    centroid: 0.45,
    flareId: 0,
    flarePower: 0,
  };

  let agc = 1e-3;
  let bassFast = 0;
  let bassSlow = 0;
  let lastFlareAt = -1;

  function update(mirror, channels, posSec, kick, now) {
    state.kick = kick || 0;
    if (!mirror || mirror.length < channels * N) return state;

    const totalFrames = (mirror.length / channels) | 0;
    const head = ((posSec * sampleRate) | 0) % totalFrames;
    let start = head - N;
    if (start < 0) start += totalFrames;

    // Mono mix of the window, wrapping at the loop seam.
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const f = (start + i) % totalFrames;
      let s = 0;
      const base = f * channels;
      for (let c = 0; c < channels; c++) s += mirror[base + c];
      s /= channels;
      sumSq += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    state.rms = Math.sqrt(sumSq / N);

    fft(re, im);

    // Band fold with attack/release smoothing.
    let frameMax = 1e-6;
    let centNum = 0;
    let centDen = 1e-9;
    for (let b = 0; b < BANDS; b++) {
      let acc = 0;
      const k0 = edges[b];
      const k1 = Math.max(k0 + 1, edges[b + 1]);
      for (let k = k0; k < k1; k++) {
        acc += Math.hypot(re[k], im[k]);
      }
      acc /= k1 - k0;
      if (acc > frameMax) frameMax = acc;
      centNum += acc * b;
      centDen += acc;
    }
    agc = Math.max(agc * 0.995, frameMax, 1e-4);
    for (let b = 0; b < BANDS; b++) {
      let acc = 0;
      const k0 = edges[b];
      const k1 = Math.max(k0 + 1, edges[b + 1]);
      for (let k = k0; k < k1; k++) acc += Math.hypot(re[k], im[k]);
      acc /= k1 - k0;
      const v = Math.min(1, Math.pow(acc / agc, 0.6));
      const prev = state.bands[b];
      state.bands[b] = prev + (v - prev) * (v > prev ? 0.5 : 0.12);
    }
    const cent = centNum / centDen / (BANDS - 1);
    state.centroid += (cent - state.centroid) * 0.05;

    // Bass-transient flare: fast envelope punching through the slow one.
    const bass = (state.bands[0] + state.bands[1] + state.bands[2]) / 3;
    bassFast += (bass - bassFast) * 0.5;
    bassSlow += (bass - bassSlow) * 0.03;
    if (
      bassFast > bassSlow * 1.4 &&
      bassFast > 0.18 &&
      now - lastFlareAt > 0.18
    ) {
      lastFlareAt = now;
      state.flareId++;
      state.flarePower = Math.min(1, bassFast);
    }
    return state;
  }

  // Pre-engage attract mode: a gentle synthetic breath so the idle
  // instrument still looks alive behind the overlay.
  function idle(now) {
    state.rms = 0.05 + 0.02 * Math.sin(now * 0.7);
    state.kick = 0;
    for (let b = 0; b < BANDS; b++) {
      state.bands[b] =
        0.12 +
        0.1 * Math.max(0, Math.sin(now * 0.8 + b * 0.55)) +
        0.05 * Math.sin(now * 2.1 + b * 1.7);
    }
    state.centroid = 0.45 + 0.1 * Math.sin(now * 0.23);
    state.flarePower *= 0.95;
    return state;
  }

  return { state, update, idle };
}
