# DEMON example apps

Small frontend examples and creative interfaces for
[DEMON](https://github.com/daydreamlive/DEMON), the realtime music
generation engine.

These apps are plain static files. They do not vendor the DEMON browser
SDK; when mounted by a DEMON backend they load the shared SDK from
`/sdk/demon-client.js`.

## Apps

| App | Path | Route | What it shows |
|---|---|---|---|
| DEMON Tides | `apps/tides` | `/tides` | Audio-reactive flow-field visualizer that doubles as an XY control surface. |
| DEMON Summon | `apps/summon` | `/arp` | Hand-tracking control surface for a live DEMON remix session. |
| DEMON Bloom | `apps/bloom` | `/bloom` | Reaction-diffusion organism that maps cursor chemistry to DEMON remix controls. |

## Run

From a DEMON checkout:

```powershell
uv run python -u -m demos.realtime_motion_graph_web.run `
  --demo C:\path\to\demon-example-apps\apps\tides `
  --demo C:\path\to\demon-example-apps\apps\summon `
  --demo C:\path\to\demon-example-apps\apps\bloom
```

The backend prints direct static demo URLs at startup.

You can also mount one app at a time:

```powershell
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\path\to\demon-example-apps\apps\tides
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\path\to\demon-example-apps\apps\summon
uv run python -u -m demos.realtime_motion_graph_web.run --demo C:\path\to\demon-example-apps\apps\bloom
```

## Structure

Each app directory contains a `demon.demo.json` manifest:

```json
{
  "route": "/tides",
  "entry": "index.html"
}
```

The DEMON backend serves the app as static files at `route` and serves
the shared browser SDK at `/sdk/`.

## Catalog

`examples.json` mirrors this README in a small structured format so docs,
websites, and agents can discover the examples without scraping markdown.
