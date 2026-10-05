# Karl — San Francisco Live Fog Map

**Live: [karlthefog.site](https://karlthefog.site)**

Created by [Sofiia Shvets](https://sofiiashvets.com/).

A live 3D map of San Francisco's fog. The city, the Golden Gate and the bay
are built from real elevation, satellite imagery and building data; the fog
is modeled from the current forecast and moves with it. Scrub or play the
timeline to see how the marine layer is expected to come and go.

## Run it

No build step. Serve the folder over HTTP (ES modules and workers need it):

```sh
python3 -m http.server 8137
# then open http://localhost:8137
```

`?q=low|medium|high` forces a graphics tier (otherwise it adapts to the
device), `?still` renders only on demand (for automated screenshots).

## What you see, and what it is based on

| Element | Source | Notes |
| --- | --- | --- |
| Terrain and seabed | AWS Terrain Tiles (USGS 3DEP on land, NOAA bathymetry) | ~10 m grid over the city, ~60 m backdrop to Mt Tamalpais and Mt Diablo, true vertical scale, coastline conformed to OpenStreetMap |
| Ground color | Copernicus Sentinel-2 L2A, 17 June 2025 | 10 m satellite color converted to surface reflectance, sharpened with OpenStreetMap roads, lawns, sand and roof outlines |
| Buildings | Overture Maps (OpenStreetMap, incl. San Francisco's LiDAR-derived heights) | 184,000 real footprints; 92% with measured heights; landmark towers from detailed building parts |
| Trees | OpenStreetMap trees + Sentinel-2 vegetation index | 280,000 trees, as lit impostors |
| Golden Gate Bridge | Surveyed tower foundations (OpenStreetMap), published dimensions | 1,280 m main span, 227 m towers, 27.4 m deck with see-through stiffening truss, 144 m cable sag, suspenders every 15.24 m |
| Bay Bridge | Surveyed supports (OpenStreetMap) | West span towers, center anchorage, east span tower |
| Weather | [Open-Meteo](https://open-meteo.com) forecast | Six points around the city, hourly, from 6 hours ago to 30 hours ahead |
| Fog | Modeled (see below) | Not a measurement |

### The fog model

The forecast gives low-cloud cover, visibility, wind, temperature and dew
point at six points (offshore, Ocean Beach, the Golden Gate, Twin Peaks,
downtown, the central bay), and — when available — a humidity and
temperature profile at the coast.

For every forecast hour (`js/workers/fogfield-worker.js`):

- **Layer top**: the top of the saturated layer in the coastal profile, or
  the base of the temperature inversion; estimated from the low-cloud
  forecast when the profile is missing. If Twin Peaks is forecast to be in
  cloud, the layer must be deeper than the hill.
- **Cloud base**: from the surface dew-point spread (≈125 m per °C), at the
  surface when coastal visibility is under ~1.2 km.
- **Extent**: fog spreads from the open Pacific through a cost field. It can
  only occupy places where the layer is deeper than the ground, travels more
  easily downwind and over water, and burns off faster over sunlit land. How
  far it reaches and how dense it is locally follow the forecast low-cloud
  cover at the six points.

The hourly fields are stored as one 3D texture and blended smoothly in time.
The renderer raymarches it against the scene depth, with a nearly flat
inversion top, wisps only where coverage is partial, sunlight and sky light
scattered through the layer, and city light glowing underneath at night.
Wisps drift with the forecast wind.

The **Fog cover** reading and the timeline curve are the forecast low-cloud
cover averaged over the four San Francisco points — a forecast value, not a
measurement of fog on a given street. The details panel (chart button in the
timeline) shows each point.

If the forecast cannot be loaded, the app uses a forecast saved in the last
12 hours (labeled "Offline"), or else an illustrative fog-season day
(labeled "Unavailable" / "Illustrative"). "Typical fog day" in Settings
shows the illustrative day on purpose.

## Controls

- Drag to pan, right-drag or Shift-drag to rotate, scroll or pinch to zoom.
- Zoom, reset and compass buttons at the bottom right; the compass turns the
  view to face north.
- Views: The Pacific, Golden Gate, Downtown, Above Karl.
- Timeline: drag, scroll, or focus it and use the arrow keys (15 min; Up/Down
  1 h; PageUp/PageDown 3 h; Home/End). Space plays and pauses. "Now" returns
  to the present. Times are San Francisco time.

## Rendering

- Scene rendered to a half-float target (MSAA on capable devices), then the
  marine layer and clear-air haze are raymarched at reduced resolution and
  upsampled with depth awareness; ACES tone mapping and a light bloom.
- Physically based sky (single scattering) that also lights the scene and
  feeds reflections; sun position from the NOAA solar algorithm; shadow map
  fitted to the view.
- Terrain chunks with distance-based detail and per-pixel normals; buildings
  built in a worker, tallest first per tile so distant tiles draw only their
  skyline; trees thinned with distance.
- Graphics tier adapts to the measured frame time; pixel ratio is capped;
  rendering pauses while the tab is hidden.

## Files

- `js/main.js` — boot, quality tiers, simulation clock, render loop
- `js/world.js` — assembles terrain, water, buildings, trees, bridges, landmarks
- `js/terrain.js`, `js/water.js`, `js/buildings.js`, `js/trees.js`, `js/bridges.js`
- `js/sky.js` — sun position, sky model, lighting
- `js/fogfield.js`, `js/workers/fogfield-worker.js` — the fog model
- `js/fogpass.js` — fog and haze raymarching, bloom, composite
- `js/weather.js` — forecast loading, caching, derived values
- `js/camera.js` — controls, collision, views
- `js/ui.js` — interface
- `data/` — baked geodata; `tools/bake/` — the scripts that make it (see
  `tools/bake/README.md`)

## Credits

Elevation: USGS 3DEP and NOAA via AWS Terrain Tiles. Imagery: contains
modified Copernicus Sentinel data 2025. Map data © OpenStreetMap
contributors (ODbL), via Overture Maps. Forecast: Open-Meteo (CC BY 4.0).
three.js (MIT), earcut (ISC).
