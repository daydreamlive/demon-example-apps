# DEMON Watercolor Codex

A no-build static DEMON frontend that turns a live watercolor surface into a
compact control panel for a server-side fixture remix.

## Run

From a DEMON checkout:

```powershell
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\path\to\demon-example-apps\apps\watercolor-codex
```

Open the printed `/watercolor-codex/` URL, choose a fixture, press **Start**,
and paint.

## Files

- `demon.demo.json` - static mount manifest for `/watercolor-codex`.
- `index.html` - canvas, fixture picker, prompt, and live controls.
- `app.js` - DEMON session wiring and watercolor control logic.
- `styles.css` - page and panel styling.
