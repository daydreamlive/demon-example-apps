# DEMON ⟡ ORRERY

A celestial-mechanics control surface for the DEMON realtime music
backend. The live stream is rendered as a star system: the star at the
center breathes with the actual audio (an FFT over the player's buffer
mirror at the playhead), every core knob is a planet you drag along an
engraved orbit, the eight channel-group amplifiers form a fan of
draggable spokes around the star, and the six keystone channels are
diamond studs on an outer band. Enabling a LoRA adds a new violet orbit
to the system while it plays.

No build step. The page loads the shared SDK bundle from
`/sdk/demon-client.js` and renders its entire control surface from the
backend's self-describing manifests (`/api/knobs`, the per-session
`ready.knob_manifest`, `/api/fixtures`); no knob, range, or enum is
hand-declared.

## Run

This is an external demo repo: mount it from the DEMON checkout with
the `--demo` flag (DEMON serves the files and the `/sdk` bundle, and
never runs code from this repo):

```bash
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\_dev\projects\demos\demon-orrery-frontend
# or backend-only:
uv run python -u -m demos.realtime_motion_graph_web.server --demo C:\_dev\projects\demos\demon-orrery-frontend
```

Open the URL printed at startup: `http://localhost:1318/orrery/`,
pick a world (fixture), and press **Engage**.

## Controls

- **Drag a planet** along its orbit to set that knob; the value arc and
  comet trail follow. Click anywhere on an orbit's tick scale to jump
  the planet there.
- **Wheel** over a planet for fine trim (hold Shift for coarse);
  **double-click** resets to the registry default.
- **Drag spokes / studs** radially: the dashed circle marks unity gain.
- **Flight plan**: prompt A and B with a live blend crossfade
  (`set_prompt_blend`), Transmit re-encodes both.
- **World**: mid-stream fixture swap by name (`swap_source` with
  `use_server_source`, so no PCM round-trip).
- **Resonators**: LoRA toggles from the live catalog, with trigger-word
  auto-prepend on every prompt send and a strength orbit per enabled
  LoRA.
- **Subsystems**: every remaining manifest knob (guidance, DCW, steps,
  seed) rendered generically by group.
- **H** hides the console for the full-screen instrument view.

External control (MCP / control bus) is mirrored: `params_echo` and
`prompt_blend_echo` move the planets and the blend slider, so an agent
driving the session animates the instrument.
