# DEMON · Watercolor

A no-build external static demo for the DEMON realtime music backend.
You paint a live watercolor — a WebGL2 ping-pong fluid/pigment
simulation (water spread along paper grain, pigment advection,
evaporation, edge-darkening deposition, granulation, wet sheen) — and
the painting is the control surface: physical properties of the wash,
measured on the GPU, drive the model's live knobs.

| Painting property | Knob | Effect |
|---|---|---|
| Canvas wetness | `denoise` | dry sheet = the source song; soak it = deep remix |
| Pigment coverage | `hint_strength` | blank paper follows the song's structure |
| Stroke energy | `feedback` | vigorous brushing = echo; idle decays to 0 |
| Mean pigment warmth | `steer_warm` | crimsons warm the music, indigos cool it |
| Wash lightness | `steer_bright` | pale washes brighten, dense darks darken |
| Composition sparsity | `steer_density` | empty sheet = sparse arrangement |
| Granulation / edges | `steer_rough` | gritty texture = grittier sound |

Every knob is discovered from the backend's knob manifest (`/api/knobs`
pre-session, the `ready` frame's per-session manifest once live) and
clamped to the served ranges; knobs the backend doesn't serve render
grayed-out and are never sent. Steering rows also gate on the session's
`steeringAvailable` flag. Nothing here needs setup beyond a standard
DEMON install: server fixtures, the core ODE knobs, and the auto
steering axes (vectors fetch themselves at session boot).

## Run

From the DEMON repo:

```powershell
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\_dev\projects\demos\demon-watercolor
```

then open the printed `http://localhost:1318/watercolor/` URL, pick a
song, press **Start**, and paint.

## Files

- `watercolor.js` — the simulation: two RGBA16F ping-pong fields
  (dissolved pigment + standing water; deposited pigment), a procedural
  paper texture, and a 64x64 analysis pass read back ~12x/s.
- `demon-bridge.js` — session lifecycle against the shared
  `/sdk/demon-client.js` bundle (`use_server_fixture` handshake,
  epoch-guarded slice patching, loop band, live prompt) plus the
  painting→knob mappings.
- `demon.demo.json` — static-mount manifest (`/watercolor`).

## Test path

**Test** runs an autopainter (a Lissajous stroke cycling through the
palette with periodic flash-dries) so every mapping can be exercised
without a human. `window.__demonTest` exposes the sim, the mappings,
and `analysis()`; `window.__demonDebug` exposes the live knob values
and session state for headless verification.
