// One-time data pipeline: bakes real SF-region topography and park shapes
// into static files the simulator loads at startup.
//
//   elevation  → AWS Open Data "Terrain Tiles" (Mapzen terrarium encoding,
//                US data is USGS 3DEP/NED ~10 m) → js/data/heightmap.png
//   parks      → OpenStreetMap via Overpass API  → js/data/geodata.js
//
// Run with:  node tools/fetch-geodata.mjs
// Needs pngjs:  NODE_PATH=<dir with pngjs> or npm i pngjs next to this file.

import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// must match js/geo.js
const REGION = { lonW: -122.55, lonE: -122.33, latS: 37.695, latN: 37.87 };

const Z = 13;           // ~15 m/px at this latitude
const GRID = 640;       // output heightfield resolution (~30 m cell)
const H_SCALE = 4;      // stored value = meters * 4 + H_OFF  (0.25 m steps)
const H_OFF = 8192;

// ————— slippy-map tile math —————
const t2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const t2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const lon2tx = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2ty = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function fetchTile(z, x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      if (attempt === 2) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function buildHeightfield() {
  const x0 = Math.floor(lon2tx(REGION.lonW, Z));
  const x1 = Math.floor(lon2tx(REGION.lonE, Z));
  const y0 = Math.floor(lat2ty(REGION.latN, Z));
  const y1 = Math.floor(lat2ty(REGION.latS, Z));
  console.log(`tiles z${Z}: x ${x0}–${x1}, y ${y0}–${y1} (${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles)`);

  const tiles = new Map();
  const jobs = [];
  for (let tx = x0; tx <= x1; tx++)
    for (let ty = y0; ty <= y1; ty++)
      jobs.push(fetchTile(Z, tx, ty).then((p) => tiles.set(`${tx}/${ty}`, p)));
  await Promise.all(jobs);

  // terrarium: meters = R*256 + G + B/256 - 32768
  const elevAtPx = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return 0;
    const ix = Math.min(255, Math.max(0, Math.round(px - tx * 256)));
    const iy = Math.min(255, Math.max(0, Math.round(py - ty * 256)));
    const k = (iy * 256 + ix) * 4;
    return t.data[k] * 256 + t.data[k + 1] + t.data[k + 2] / 256 - 32768;
  };

  // sample a GRID×GRID lon/lat-aligned heightfield over REGION
  const raw = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    const lat = REGION.latN + ((REGION.latS - REGION.latN) * gy) / (GRID - 1);
    const py = lat2ty(lat, Z) * 256;
    for (let gx = 0; gx < GRID; gx++) {
      const lon = REGION.lonW + ((REGION.lonE - REGION.lonW) * gx) / (GRID - 1);
      raw[gy * GRID + gx] = elevAtPx(lon2tx(lon, Z) * 256, py);
    }
  }

  // one gentle 3×3 blur pass: kills single-pixel DEM noise, keeps ridgelines
  const sm = new Float32Array(raw);
  for (let y = 1; y < GRID - 1; y++)
    for (let x = 1; x < GRID - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) s += raw[(y + dy) * GRID + x + dx];
      sm[y * GRID + x] = raw[y * GRID + x] * 0.5 + (s / 9) * 0.5;
    }

  // pack into a PNG: R = high byte, G = low byte of (m*4 + 8192), B unused
  const out = new PNG({ width: GRID, height: GRID, colorType: 2 });
  for (let i = 0; i < GRID * GRID; i++) {
    const v = Math.max(0, Math.min(65535, Math.round(sm[i] * H_SCALE + H_OFF)));
    out.data[i * 4] = v >> 8;
    out.data[i * 4 + 1] = v & 255;
    out.data[i * 4 + 2] = 0;
    out.data[i * 4 + 3] = 255;
  }
  const buf = PNG.sync.write(out);
  writeFileSync(join(ROOT, 'js/data/heightmap.png'), buf);

  let lo = Infinity, hi = -Infinity;
  for (const v of sm) { if (v < lo) lo = v; if (v > hi) hi = v; }
  console.log(`heightmap.png: ${GRID}×${GRID}, ${(buf.length / 1024) | 0} KB, elev ${lo.toFixed(0)}…${hi.toFixed(0)} m`);
}

// ————— parks from OpenStreetMap (same data the Felt map renders) —————

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BBOX = `${REGION.latS},${REGION.lonW},${REGION.latN},${REGION.lonE}`;
const QUERY = `
[out:json][timeout:120];
(
  way["leisure"~"^(park|nature_reserve|garden|recreation_ground|golf_course)$"](${BBOX});
  relation["leisure"~"^(park|nature_reserve|garden|recreation_ground|golf_course)$"](${BBOX});
  way["natural"="water"]["name"~"Merced|Stow"](${BBOX});
  relation["natural"="water"]["name"~"Merced|Stow"](${BBOX});
);
out geom;`;

// stitch a relation's outer ways into closed rings
function stitchOuters(members) {
  const segs = members
    .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry)
    .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
  const rings = [];
  while (segs.length) {
    const ring = segs.shift();
    let grew = true;
    while (grew) {
      grew = false;
      const [hx, hy] = ring[0], [tx, ty] = ring[ring.length - 1];
      if (Math.abs(hx - tx) < 1e-9 && Math.abs(hy - ty) < 1e-9) break; // closed
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
        if (eq(s[0], [tx, ty])) { ring.push(...s.slice(1)); segs.splice(i, 1); grew = true; break; }
        if (eq(s[s.length - 1], [tx, ty])) { ring.push(...s.reverse().slice(1)); segs.splice(i, 1); grew = true; break; }
        if (eq(s[s.length - 1], [hx, hy])) { ring.unshift(...s.slice(0, -1)); segs.splice(i, 1); grew = true; break; }
        if (eq(s[0], [hx, hy])) { ring.unshift(...s.reverse().slice(0, -1)); segs.splice(i, 1); grew = true; break; }
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// Douglas–Peucker in degrees (≈1e-4° ≙ 9–11 m here)
function simplify(pts, eps = 1.2e-4) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [];
  // closed ring: first == last makes the anchor segment degenerate, so split
  // at the point farthest from the start before running DP
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
  if (closed) {
    let ifar = 1, dfar = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > dfar) { dfar = d; ifar = i; }
    }
    keep[ifar] = 1;
    stack.push([0, ifar], [ifar, pts.length - 1]);
  } else stack.push([0, pts.length - 1]);
  while (stack.length) {
    const [a, b] = stack.pop();
    let imax = -1, dmax = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > eps) { keep[imax] = 1; stack.push([a, imax], [imax, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringAreaKm2(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(s / 2) * 87.9 * 111.1; // deg² → km² at 37.78°N
}

async function buildParks() {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'karlthefog.site geodata builder (one-time fetch)',
    },
    body: 'data=' + encodeURIComponent(QUERY),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const osm = await res.json();
  console.log(`overpass: ${osm.elements.length} elements`);

  const parks = [], waters = [];
  const seen = new Set();
  for (const el of osm.elements) {
    const tags = el.tags || {};
    const name = tags.name || '';
    const isWater = tags.natural === 'water';
    let rings = [];
    if (el.type === 'way' && el.geometry) {
      rings = [el.geometry.map((g) => [g.lon, g.lat])];
    } else if (el.type === 'relation' && el.members) {
      rings = stitchOuters(el.members);
    }
    for (let ring of rings) {
      ring = simplify(ring);
      const area = ringAreaKm2(ring);
      if (area < (isWater ? 0.05 : 0.015)) continue;     // skip pocket parks
      if (area > 25) continue;                            // marine sanctuaries etc.
      // keep only shapes actually centered in the region (bbox matching pulls
      // in giants like the Monterey Bay sanctuary whose bounds merely overlap)
      let cx = 0, cy = 0;
      for (const [lon, lat] of ring) { cx += lon; cy += lat; }
      cx /= ring.length; cy /= ring.length;
      if (cx < REGION.lonW || cx > REGION.lonE || cy < REGION.latS || cy > REGION.latN) continue;
      // dedupe: a relation and its member ways can both match
      const key = ring[0][0].toFixed(4) + ',' + ring[0][1].toFixed(4) + ':' + ring.length;
      if (seen.has(key)) continue;
      seen.add(key);
      const poly = ring.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]);
      if (isWater) waters.push({ name, poly });
      else parks.push({ name, area: +area.toFixed(3), trees: area > 0.07, poly });
    }
  }
  parks.sort((a, b) => b.area - a.area);
  console.log(`parks: ${parks.length} polygons, waters: ${waters.length}`);
  console.log('largest:', parks.slice(0, 8).map((p) => p.name || '?').join(' · '));

  const js = `// Generated by tools/fetch-geodata.mjs — do not edit by hand.
// Park & water polygons © OpenStreetMap contributors (ODbL), via Overpass API.
// Heightmap from AWS Open Data Terrain Tiles (USGS 3DEP/NED).

export const HF_META = { grid: ${GRID}, scale: ${H_SCALE}, off: ${H_OFF} };

export const PARKS = ${JSON.stringify(parks)};

export const WATERS = ${JSON.stringify(waters)};
`;
  writeFileSync(join(ROOT, 'js/data/geodata.js'), js);
  console.log(`geodata.js: ${(js.length / 1024) | 0} KB`);
}

await buildHeightfield();
await buildParks();
console.log('done.');
