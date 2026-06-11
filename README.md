# 🌁 Karl — the San Francisco Fog, live in 3-D

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

## Files

- `js/geo.js` — lon/lat → world mapping (1 unit = 100 m, heights exaggerated)
- `js/world.js` — terrain from real hill/coastline data, buildings, bridges, landmarks
- `js/sky.js` — solar position, sky dome, day/night lighting rig
- `js/fogpass.js` — the volumetric fog raymarcher + composite
- `js/weather.js` — Open-Meteo ingestion, climatology fallback, Karl's narration
- `js/ui.js` — timeline chart, scrubbing, readouts, foghorn
- `js/main.js` — boot, sim clock, render loop
