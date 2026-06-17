# DEMON · BLOOM

A no-build front end for the [DEMON](https://github.com/RyanOnTheInside) realtime
music engine — but instead of yet another spectrum-bars-on-black visualizer, the
whole screen is a **living reaction-diffusion organism** (Gray-Scott) running on
the GPU. It grows, crawls and blooms in time with the remix, and you sculpt it
with your cursor.

The twist: **your cursor's position in the tissue *is* the chemistry**, and that
same position steers the model. One gesture transforms the living texture and the
music together.

- **Move** the cursor → set the reaction's feed/kill rates. Walk left→right and
  the pattern morphs through worms → mitosis → coral; walk up→down and it opens
  from tight order into riot. The same two axes drive DEMON:
  - **X** → `denoise` (how hard the model remixes the source)
  - **Y** → `hint_strength` (how much of the original survives)
- **Drag** → sculpt living tissue directly (inject chemical and watch it grow).
  **Shift-drag** dissolves it back.
- **Beat** → bass kicks scatter fresh spores and pulse the feed, so the organism
  throbs with the track.
- **reseed** scatters new spores; **wild** lets the organism sculpt itself with a
  slow autonomous drift through the chemistry.

Everything you see is the live model output: the AudioPlayer's master bus is
tapped into an `AnalyserNode` that drives the brightness, membrane glow and the
beat pulse.

It is a plain DEMON session — boots a server-side fixture via the standard
`use_server_fixture` handshake and remixes it on a loop. No real-time audio input;
the cursor only steers.

## Run

```bash
uv run python -u -m demos.realtime_motion_graph_web.run \
  --demo C:\_dev\projects\demos\demon-bloom-frontend
```

The launcher prints the direct URL (route `/bloom`, e.g.
`http://localhost:1318/bloom/`). Pick a song, hit **GROW IT**, then drag through
the organism.

## How it's built

| File | Role |
|---|---|
| `demon.demo.json` | mount manifest read by `demos/common/static_site.py` |
| `index.html` | one `<canvas>` + a tucking control panel |
| `styles.css` | the look + the brush ring |
| `app.js` | WebGL2 ping-pong Gray-Scott sim, cursor sculpting, audio coupling, and the DEMON session wiring against `/sdk/demon-client.js` |

Raw WebGL2 — two `RGBA16F` framebuffers ping-ponging a reaction-diffusion step
(needs `EXT_color_buffer_float`; falls back to a notice if unavailable). No build
step, no dependencies, no vendored SDK: the one copy mounted at `/sdk/` is the
whole runtime.
