# 🌁 Karl — the San Francisco Fog, live in 3-D

**Live: [karlthefog.site](https://karlthefog.site)**

Created by [Sofiia Shvets](https://sofiiashvets.com/).

A volumetric simulation of Karl the Fog rolling in and out of San Francisco,
on a stylized 3-D map of the city — built to show visiting friends why the
Sunset disappears every evening.

## Run it

No build step. Serve the folder over HTTP (ES modules need it):

```sh
python3 -m http.server 8137
# then open http://localhost:8137
```

## What it does

- **Live forecast** — pulls hourly low-cloud cover, visibility, wind and
  dew-point spread from [Open-Meteo](https://open-meteo.com) for the Ocean
  Beach coast and turns it into a per-hour "Karl intensity".
- **24-hour timeline** — scrub (drag or mouse-wheel) the chart to time-travel;
  press play to watch the next day unfold at 1 h ≈ 1 s (toggle 3× for a
  flyover). Sun position, sky, city lights and the fog all follow the
  simulated clock.
- **Real fog behavior** — the marine layer sits offshore, pours through the
  Golden Gate as a jet, floods the Sunset and Richmond, stalls against the
  Twin Peaks ridge, and only spills over once the layer is deep enough.
  Burn-off clears downtown first, just like real life.
- **Classic Karl mode** — click the LIVE chip to swap the real forecast for a
  textbook fog-season day (full evening surge + morning burn-off), for when
  you're showing friends during a rare clear week.
- **Viewpoints** — Pacific overview, standing at the Golden Gate, downtown
  skyline, and "Above Karl" for the sea-of-fog view.
- **Foghorn** — yes, the button works. Two tones, like the real one under the
  south tower.

## How the fog is rendered

The scene renders to an off-screen target, then a half-resolution post pass
raymarches a 3-D noise density field against the depth buffer (44 jittered
steps, Beer–Lambert absorption, forward-scattering toward the sun, warm city
glow injected from below at night) and composites with ACES tone mapping.
The fog's horizontal coverage is an analytic model of SF geography: a west
blanket front, a Golden Gate jet, a ridge-line cap, and an everything-is-gone
blanket above ~80% intensity.

## Real topography & park data

The terrain is a real USGS heightfield and the parks are true OpenStreetMap
polygons, baked into static files by `tools/fetch-geodata.mjs`:

- **Elevation** — [AWS Open Data Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (terrarium encoding; USGS 3DEP/NED for the US), resampled to a 640×640 grid
  over the region and packed into `js/data/heightmap.png` (16-bit in R/G).
  Coastlines fall out of the elevation for free: land is wherever the DEM
  rises above the sea.
- **Parks & lakes** — OpenStreetMap via the Overpass API
  (© OpenStreetMap contributors, ODbL), simplified and stored in
  `js/data/geodata.js`.

To regenerate: `cd tools && npm i pngjs && node fetch-geodata.mjs`

## Files

- `js/geo.js` — lon/lat → world mapping (1 unit = 100 m, heights exaggerated)
- `js/world.js` — terrain from the USGS heightfield, real park shapes, buildings, bridges, landmarks
- `js/data/` — baked heightmap + park polygons (generated, see above)
- `tools/fetch-geodata.mjs` — the one-time data pipeline
- `js/sky.js` — solar position, sky dome, day/night lighting rig
- `js/fogpass.js` — the volumetric fog raymarcher + composite
- `js/weather.js` — Open-Meteo ingestion, climatology fallback, Karl's narration
- `js/ui.js` — timeline chart, scrubbing, readouts, foghorn
- `js/main.js` — boot, sim clock, render loop
