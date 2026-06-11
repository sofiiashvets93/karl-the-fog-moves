// Builds the stylized 3-D San Francisco: terrain, water, city, bridges, landmarks.

import * as THREE from 'three';
import { W, hU, WORLD_W, WORLD_H } from './geo.js';

// ————— coastline polygons (lon, lat), walked around each landmass —————

const SF_COAST = [
  [-122.5135, 37.7885], // Lands End
  [-122.4920, 37.7905], // Sea Cliff
  [-122.4770, 37.8105], // Fort Point (south side of the Gate)
  [-122.4640, 37.8060], // Crissy Field
  [-122.4460, 37.8075], // Marina
  [-122.4245, 37.8085], // Aquatic Park
  [-122.4080, 37.8105], // Fisherman's Wharf
  [-122.3920, 37.7990], // North Beach piers
  [-122.3870, 37.7950], // Ferry Building
  [-122.3855, 37.7780], // South Beach
  [-122.3790, 37.7700], // Mission Bay
  [-122.3755, 37.7550], // Central Waterfront
  [-122.3870, 37.7430], // Islais Creek
  [-122.3580, 37.7290], // Hunters Point
  [-122.3760, 37.7100], // Candlestick
  [-122.3900, 37.6960], // south edge
  [-122.5050, 37.6960], // SW corner
  [-122.5065, 37.7350], // Fort Funston
  [-122.5095, 37.7750], // Ocean Beach
];

const MARIN_COAST = [
  [-122.5520, 37.8150],
  [-122.5290, 37.8155], // Point Bonita
  [-122.4900, 37.8265], // Kirby Cove
  [-122.4775, 37.8255], // Lime Point (north side of the Gate)
  [-122.4680, 37.8330], // Horseshoe Bay
  [-122.4770, 37.8530], // Sausalito
  [-122.4720, 37.8690],
  [-122.5520, 37.8690],
];

// hills: lon, lat, summit meters, radius meters
const HILLS = [
  [-122.4477, 37.7544, 281, 520], // Twin Peaks
  [-122.4585, 37.7600, 265, 450], // Mount Sutro
  [-122.4540, 37.7383, 283, 480], // Mount Davidson
  [-122.4695, 37.7565, 210, 480], // Golden Gate Heights
  [-122.4438, 37.7437, 190, 420], // Diamond Heights
  [-122.4380, 37.7660, 160, 330], // Corona Heights / Buena Vista
  [-122.4140, 37.7430, 134, 380], // Bernal Heights
  [-122.3995, 37.7590, 90, 480],  // Potrero Hill
  [-122.4190, 37.7190, 150, 700], // McLaren ridge
  [-122.4194, 37.8010, 88, 300],  // Russian Hill
  [-122.4130, 37.7925, 100, 330], // Nob Hill
  [-122.4058, 37.8020, 84, 200],  // Telegraph Hill
  [-122.4400, 37.7918, 105, 520], // Pacific Heights
  [-122.4525, 37.7780, 88, 380],  // Lone Mountain / USF
  [-122.4655, 37.7935, 95, 550],  // Presidio hills
  [-122.5060, 37.7830, 95, 480],  // Lands End bluffs
  // Marin
  [-122.4995, 37.8265, 240, 800],
  [-122.5230, 37.8330, 290, 900],
  [-122.4870, 37.8430, 230, 700],
  [-122.4790, 37.8560, 220, 800],
  [-122.5150, 37.8620, 280, 1000],
];

// islands rise from the bay on their own: lon, lat, meters, radius m, flatten
const ISLANDS = [
  [-122.4230, 37.8267, 41, 170, 1.0],   // Alcatraz
  [-122.4310, 37.8620, 230, 620, 1.0],  // Angel Island
  [-122.3640, 37.8090, 100, 280, 1.0],  // Yerba Buena
  [-122.3705, 37.8230, 8, 380, 0.25],   // Treasure Island (flat pancake)
];

// parks (lon0, lat0, lon1, lat1, gets trees)
const PARKS = [
  [-122.5110, 37.7655, -122.4540, 37.7737, true],  // Golden Gate Park
  [-122.4790, 37.7870, -122.4450, 37.8060, true],  // Presidio
  [-122.4300, 37.7140, -122.4050, 37.7250, true],  // McLaren
  [-122.4970, 37.7050, -122.4790, 37.7300, false], // Lake Merced / Fort Funston
  [-122.4545, 37.7715, -122.4370, 37.7737, true],  // the Panhandle
  [-122.4278, 37.7578, -122.4248, 37.7620, false], // Dolores Park
  [-122.4415, 37.7660, -122.4355, 37.7700, true],  // Buena Vista
  [-122.4440, 37.7350, -122.4390, 37.7455, true],  // Glen Canyon
  [-122.4770, 37.7350, -122.4590, 37.7385, true],  // Stern Grove
];

// precomputed world-space versions
const sfPoly = SF_COAST.map(p => W(p[0], p[1]));
const marinPoly = MARIN_COAST.map(p => W(p[0], p[1]));
const hillsW = HILLS.map(h => ({ x: W(h[0], h[1])[0], z: W(h[0], h[1])[1], h: hU(h[2]), r: h[3] / 100 }));
const islesW = ISLANDS.map(h => ({ x: W(h[0], h[1])[0], z: W(h[0], h[1])[1], h: hU(h[2]), r: h[3] / 100, f: h[4] }));
const parksW = PARKS.map(p => {
  const a = W(p[0], p[1]), b = W(p[2], p[3]);
  return {
    x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
    z0: Math.min(a[1], b[1]), z1: Math.max(a[1], b[1]),
    trees: p[4],
  };
});

// signed distance to polygon: positive inside, in world units
function polySDF(pts, x, z) {
  let d2 = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    const ex = xj - xi, ez = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / (ex * ex + ez * ez)));
    const dx = x - (xi + ex * t), dz = z - (zi + ez * t);
    const dd = dx * dx + dz * dz;
    if (dd < d2) d2 = dd;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  const d = Math.sqrt(d2);
  return inside ? d : -d;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function landSDF(x, z) {
  return Math.max(polySDF(sfPoly, x, z), polySDF(marinPoly, x, z));
}

export function inPark(x, z) {
  for (const p of parksW) {
    if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return true;
  }
  return false;
}

export function heightAt(x, z) {
  const sdf = landSDF(x, z);
  const mask = smoothstep(0, 0.45, sdf);   // steep coast, cliffy
  let h = 0;
  if (mask > 0) {
    h = mask * (0.1 + 0.1 * smoothstep(0, 8, sdf)); // gentle base rise inland
    for (const k of hillsW) {
      const dx = x - k.x, dz = z - k.z;
      h += mask * k.h * Math.exp(-(dx * dx + dz * dz) / (k.r * k.r));
    }
  }
  // islands stand on their own
  for (const k of islesW) {
    const dx = x - k.x, dz = z - k.z;
    const g = Math.exp(-(dx * dx + dz * dz) / (k.r * k.r));
    const gg = k.f < 0.5 ? Math.min(1, g * 2.2) * k.h : Math.pow(g, 0.8) * k.h;
    if (gg > h) h = gg;
  }
  // ocean floor
  if (h < 0.02) h = -0.4 + 0.42 * smoothstep(-1.4, 0.4, sdf);
  return h;
}

// deterministic pseudo-random
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ————————————————— ground texture: blocks, streets, parks —————————————————

// street grids: bounds (lon/lat), rotation, avenue/street spacing in km
const GRIDS = [
  { b: [-122.5130, 37.7705, -122.4460, 37.7885], a: 0, sx: 0.17, sz: 0.26 },     // Richmond
  { b: [-122.5100, 37.7345, -122.4520, 37.7655], a: 0, sx: 0.17, sz: 0.26 },     // Sunset
  { b: [-122.4440, 37.7370, -122.4050, 37.7720], a: 0, sx: 0.16, sz: 0.21 },     // Mission / Noe / Castro
  { b: [-122.4470, 37.7720, -122.4120, 37.8060], a: 0, sx: 0.16, sz: 0.22 },     // Western Addition → Marina
  { b: [-122.4200, 37.7880, -122.3960, 37.8080], a: 0, sx: 0.14, sz: 0.17 },     // North Beach / FiDi
  { b: [-122.4230, 37.7660, -122.3870, 37.7900], a: -0.32, sx: 0.25, sz: 0.18 }, // SoMa, the rotated grid
  { b: [-122.4080, 37.7180, -122.3700, 37.7460], a: -0.32, sx: 0.20, sz: 0.20 }, // Bayview
  { b: [-122.4550, 37.7060, -122.4060, 37.7330], a: 0.30, sx: 0.18, sz: 0.20 },  // Excelsior / Outer Mission
];

// major arteries as lon/lat polylines
const ARTERIES = [
  [[-122.3935, 37.7948], [-122.4190, 37.7750], [-122.4355, 37.7625]],                       // Market St
  [[-122.3980, 37.7895], [-122.4195, 37.7645], [-122.4200, 37.7480], [-122.4350, 37.7300], [-122.4430, 37.7180]], // Mission St
  [[-122.4225, 37.8060], [-122.4205, 37.7450]],                                              // Van Ness
  [[-122.5095, 37.7810], [-122.4460, 37.7810], [-122.4035, 37.7880]],                        // Geary
  [[-122.4755, 37.7080], [-122.4755, 37.7655]],                                              // 19th Ave
  [[-122.4725, 37.7737], [-122.4725, 37.7960]],                                              // Park Presidio
  [[-122.4120, 37.8060], [-122.4035, 37.7945]],                                              // Columbus
  [[-122.4055, 37.8095], [-122.3935, 37.7955], [-122.3880, 37.7900], [-122.3865, 37.7835]],  // Embarcadero
  [[-122.4465, 37.8045], [-122.4120, 37.8035]],                                              // Lombard
  [[-122.5095, 37.7750], [-122.5065, 37.7360]],                                              // Great Highway
  [[-122.4940, 37.7655], [-122.4940, 37.7345]],                                              // Sunset Blvd
  [[-122.4350, 37.7480], [-122.3920, 37.7485]],                                              // Cesar Chavez
  [[-122.4055, 37.7405], [-122.4100, 37.7100]],                                              // Bayshore
];

const TEX_SIZE = 2048;
const PLANE_W = WORLD_W + 14, PLANE_H = WORLD_H + 14;

function texPt(x, z) {
  return [
    ((x + PLANE_W / 2) / PLANE_W) * TEX_SIZE,
    ((z + PLANE_H / 2) / PLANE_H) * TEX_SIZE,
  ];
}
function texLL(lon, lat) {
  const [x, z] = W(lon, lat);
  return texPt(x, z);
}

function tracePoly(ctx, poly) {
  ctx.beginPath();
  poly.forEach((p, i) => {
    const [px, py] = texPt(p[0], p[1]);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.closePath();
}

function groundTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = TEX_SIZE;
  const ctx = cv.getContext('2d');
  const rnd = mulberry(7);
  const PXU = TEX_SIZE / PLANE_W; // pixels per world unit (~10 px = 1 km / 10)

  // water
  ctx.fillStyle = '#24404f';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // landmasses
  tracePoly(ctx, sfPoly);
  ctx.fillStyle = '#b2ada3';
  ctx.fill();
  tracePoly(ctx, marinPoly);
  ctx.fillStyle = '#8d9663';
  ctx.fill();

  // Marin gets dry-grass mottling
  ctx.save();
  tracePoly(ctx, marinPoly);
  ctx.clip();
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(120,130,80,0.25)' : 'rgba(160,160,100,0.18)';
    ctx.fillRect(rnd() * TEX_SIZE, rnd() * TEX_SIZE * 0.45, 4 + rnd() * 14, 3 + rnd() * 10);
  }
  ctx.restore();

  // everything urban is clipped to the peninsula
  ctx.save();
  tracePoly(ctx, sfPoly);
  ctx.clip();

  // block mottling
  for (let i = 0; i < 5200; i++) {
    const l = rnd();
    ctx.fillStyle = l > 0.55 ? 'rgba(255,250,240,0.05)' : 'rgba(70,65,55,0.05)';
    ctx.fillRect(rnd() * TEX_SIZE, rnd() * TEX_SIZE, 3 + rnd() * 9, 3 + rnd() * 9);
  }

  // street grids
  ctx.strokeStyle = 'rgba(64,70,74,0.34)';
  ctx.lineWidth = 1.6;
  for (const g of GRIDS) {
    const a0 = texLL(g.b[0], g.b[1]);
    const a1 = texLL(g.b[2], g.b[3]);
    const cx = (a0[0] + a1[0]) / 2, cy = (a0[1] + a1[1]) / 2;
    const hw = Math.abs(a1[0] - a0[0]) / 2, hh = Math.abs(a1[1] - a0[1]) / 2;
    const ext = Math.hypot(hw, hh);
    ctx.save();
    // clip to the (unrotated) district rect, then draw a rotated line family
    ctx.beginPath();
    ctx.rect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(g.a);
    const stepX = g.sx * 10 * PXU, stepZ = g.sz * 10 * PXU;
    ctx.beginPath();
    for (let x = -ext; x <= ext; x += stepX) { ctx.moveTo(x, -ext); ctx.lineTo(x, ext); }
    for (let y = -ext; y <= ext; y += stepZ) { ctx.moveTo(-ext, y); ctx.lineTo(ext, y); }
    ctx.stroke();
    ctx.restore();
  }

  // arteries
  ctx.strokeStyle = 'rgba(52,58,62,0.5)';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const road of ARTERIES) {
    ctx.beginPath();
    road.forEach((p, i) => {
      const [px, py] = texLL(p[0], p[1]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // parks paint over the streets
  for (const p of parksW) {
    const [px0, py0] = texPt(p.x0, p.z0);
    const [px1, py1] = texPt(p.x1, p.z1);
    ctx.fillStyle = '#5e7d4f';
    ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
    for (let i = 0; i < (px1 - px0) * (py1 - py0) / 110; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(40,70,35,0.35)' : 'rgba(120,150,90,0.3)';
      const r = 1.5 + rnd() * 3;
      ctx.beginPath();
      ctx.arc(px0 + rnd() * (px1 - px0), py0 + rnd() * (py1 - py0), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Lake Merced is actually a lake
  {
    const [cx, cy] = texLL(-122.4885, 37.7185);
    ctx.fillStyle = '#2e4a57';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 11, 16, 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ocean Beach sand
  {
    const [sx0, sy0] = texLL(-122.5125, 37.7890);
    const [sx1, sy1] = texLL(-122.5030, 37.7060);
    ctx.fillStyle = '#d9c79d';
    ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  }

  ctx.restore(); // end peninsula clip

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ————————————————— terrain mesh —————————————————

function buildTerrain() {
  const RES = 320;
  const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_H, RES, RES);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    flatShading: true,
    roughness: 1.0,
    metalness: 0.0,
  });
  return new THREE.Mesh(geo, mat);
}

function buildWater() {
  const geo = new THREE.CircleGeometry(900, 48);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: '#26404f',
    roughness: 0.32,
    metalness: 0.12,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0.02;
  return m;
}

// ————————————————— buildings —————————————————

function districtHeight(x, z, rnd) {
  // returns building height in world units, or 0 to skip
  const [dtx, dtz] = W(-122.3985, 37.7905);     // Financial District
  const [smx, smz] = W(-122.4060, 37.7800);     // SoMa
  const ddt = Math.hypot(x - dtx, z - dtz);
  const dsm = Math.hypot(x - smx, z - smz);
  const downtown = Math.exp(-(ddt * ddt) / (8 * 8));
  const soma = Math.exp(-(dsm * dsm) / (11 * 11));
  let h = 0.07 + rnd() * 0.08;                  // rowhouse San Francisco
  h += downtown * (0.5 + rnd() * rnd() * 2.6);  // FiDi towers
  h += soma * (0.15 + rnd() * rnd() * 0.9);
  return h;
}

function buildBuildings() {
  const rnd = mulberry(1337);
  const positions = [];
  const TRIES = 30000;
  const [x0w, z0w] = W(-122.515, 37.812);
  const [x1w, z1w] = W(-122.355, 37.700);

  for (let i = 0; i < TRIES; i++) {
    const x = x0w + rnd() * (x1w - x0w);
    const z = z0w + rnd() * (z1w - z0w);
    if (polySDF(sfPoly, x, z) < 0.35) continue;
    if (inPark(x, z)) continue;
    const h = heightAt(x, z);
    if (h < 0.06 || h > 2.6) continue;
    // skip steep slopes
    const s = Math.abs(heightAt(x + 0.4, z) - h) + Math.abs(heightAt(x, z + 0.4) - h);
    if (s > 0.42) continue;
    const bh = districtHeight(x, z, rnd);
    positions.push({ x, z, ground: h, bh });
  }

  const count = positions.length;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const [smx, smz] = W(-122.4060, 37.7860);

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const big = p.bh > 0.5;
    const w = big ? 0.13 + rnd() * 0.1 : 0.05 + rnd() * 0.05;
    dummy.position.set(p.x, p.ground + p.bh / 2 - 0.01, p.z);
    dummy.scale.set(w, p.bh, w * (0.8 + rnd() * 0.5));
    // SoMa / downtown street grid runs diagonal to the rest of the city
    const dts = Math.hypot(p.x - smx, p.z - smz);
    dummy.rotation.y = dts < 14 ? -0.32 : 0;
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    if (big) col.setHSL(0.55, 0.06 + rnd() * 0.05, 0.62 + rnd() * 0.14); // glassy
    else col.setHSL(0.09 + rnd() * 0.04, 0.08 + rnd() * 0.1, 0.68 + rnd() * 0.16); // painted ladies, roughly
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return { mesh, positions };
}

// ————————————————— trees, piers —————————————————

function buildTrees() {
  const rnd = mulberry(424242);
  const spots = [];
  const treed = parksW.filter(p => p.trees);
  for (let i = 0; i < 4200 && spots.length < 1700; i++) {
    const p = treed[(rnd() * treed.length) | 0];
    const x = p.x0 + rnd() * (p.x1 - p.x0);
    const z = p.z0 + rnd() * (p.z1 - p.z0);
    if (landSDF(x, z) < 0.4) continue;
    const h = heightAt(x, z);
    if (h < 0.05) continue;
    spots.push({ x, z, h });
  }
  const geo = new THREE.ConeGeometry(0.045, 0.15, 5);
  const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const k = 0.7 + rnd() * 0.7;
    dummy.position.set(s.x, s.h + 0.075 * k, s.z);
    dummy.scale.set(k, k, k);
    dummy.rotation.y = rnd() * Math.PI;
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    col.setHSL(0.29 + rnd() * 0.05, 0.32, 0.2 + rnd() * 0.1);
    mesh.setColorAt(i, col);
  }
  return mesh;
}

function buildPiers() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#b9b2a2', roughness: 0.9 });
  // the pier arc from Fisherman's Wharf down to the Bay Bridge
  const A = W(-122.4145, 37.8098);
  const B = W(-122.3895, 37.7905);
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const x = A[0] + (B[0] - A[0]) * t;
    const z = A[1] + (B[1] - A[1]) * t;
    // local coast direction and an outward (bay-side) normal
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const L = Math.hypot(dx, dz);
    let nx = -dz / L, nz = dx / L;
    if (landSDF(x + nx, z + nz) > 0) { nx = -nx; nz = -nz; }
    const pier = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.34), mat);
    pier.position.set(x + nx * 0.16, 0.05, z + nz * 0.16);
    pier.rotation.y = Math.atan2(nx, nz);
    g.add(pier);
  }
  return g;
}

// ————————————————— landmarks —————————————————

const ORANGE = new THREE.MeshStandardMaterial({
  color: '#c8401f', roughness: 0.6, metalness: 0.15,
  emissive: '#c8401f', emissiveIntensity: 0.12,
});

function bridgeTower(x, z, deckY, topY, mat, width = 0.66) {
  const g = new THREE.Group();
  const colGeo = new THREE.BoxGeometry(0.13, topY, 0.13);
  for (const s of [-1, 1]) {
    const c = new THREE.Mesh(colGeo, mat);
    c.position.set(x + s * width / 2, topY / 2, z);
    g.add(c);
  }
  for (const fy of [0.45, 0.72, 0.97]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width, 0.1, 0.11), mat);
    bar.position.set(x, topY * fy, z);
    g.add(bar);
  }
  return g;
}

function buildGoldenGate() {
  const g = new THREE.Group();
  const A = W(-122.4775, 37.8065);  // south anchorage (Fort Point)
  const B = W(-122.4790, 37.8345);  // north anchorage (Vista Point)
  const deckY = hU(67);
  const towY = hU(227);
  const ax = A[0], az = A[1], bx = B[0], bz = B[1];
  const len = Math.hypot(bx - ax, bz - az);
  const ang = Math.atan2(bx - ax, bz - az); // rotation about Y for a Z-aligned box

  // deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, len + 1.5), ORANGE);
  deck.position.set((ax + bx) / 2, deckY, (az + bz) / 2);
  deck.rotation.y = ang;
  g.add(deck);

  // towers at 30% / 70% of the span
  const towers = [0.3, 0.7].map(t => [ax + (bx - ax) * t, az + (bz - az) * t]);
  for (const [tx, tz] of towers) {
    const tw = bridgeTower(0, 0, deckY, towY, ORANGE);
    tw.position.set(tx, 0, tz);
    tw.rotation.y = ang;
    g.add(tw);
  }

  // main cables: anchor — tower top — mid-sag — tower top — anchor
  const cablePts = (side) => {
    const off = 0.21;
    const px = Math.cos(ang) * off * side, pz = -Math.sin(ang) * off * side;
    const mid = [(towers[0][0] + towers[1][0]) / 2, (towers[0][1] + towers[1][1]) / 2];
    return [
      new THREE.Vector3(ax + px, deckY + 0.05, az + pz),
      new THREE.Vector3(towers[0][0] + px, towY, towers[0][1] + pz),
      new THREE.Vector3(mid[0] + px, deckY + 0.12, mid[1] + pz),
      new THREE.Vector3(towers[1][0] + px, towY, towers[1][1] + pz),
      new THREE.Vector3(bx + px, deckY + 0.05, bz + pz),
    ];
  };
  const suspPts = [];
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3(cablePts(side), false, 'catmullrom', 0.08);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.035, 5), ORANGE));
    // suspender ropes
    for (let i = 0; i <= 56; i++) {
      const p = curve.getPoint(i / 56);
      if (p.y > deckY + 0.18) suspPts.push(p.x, p.y, p.z, p.x, deckY + 0.03, p.z);
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(suspPts), 3));
  g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: '#b43a1c', transparent: true, opacity: 0.8 })));

  return { group: g, deckCurveA: A, deckCurveB: B, deckY };
}

function buildBayBridge() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#9aa0a8', roughness: 0.7, metalness: 0.2 });
  const A = W(-122.3880, 37.7868);  // SF anchorage
  const B = W(-122.3625, 37.8095);  // Yerba Buena
  const Cc = W(-122.3300, 37.8180); // toward Oakland, edge of the region
  const deckY = hU(55);
  const seg = (P, Q, towers) => {
    const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    const ang = Math.atan2(Q[0] - P[0], Q[1] - P[1]);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, len), mat);
    deck.position.set((P[0] + Q[0]) / 2, deckY, (P[1] + Q[1]) / 2);
    deck.rotation.y = ang;
    g.add(deck);
    for (const t of towers) {
      const tw = bridgeTower(0, 0, deckY, hU(150), mat, 0.5);
      tw.position.set(P[0] + (Q[0] - P[0]) * t, 0, P[1] + (Q[1] - P[1]) * t);
      tw.rotation.y = ang;
      g.add(tw);
    }
  };
  seg(A, B, [0.3, 0.68]);
  seg(B, Cc, []);
  return g;
}

function buildLandmarks(scene) {
  const g = new THREE.Group();

  // Transamerica Pyramid
  {
    const [x, z] = W(-122.4028, 37.7952);
    const h = hU(260);
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(0.30, h, 4),
      new THREE.MeshStandardMaterial({ color: '#ded7c9', roughness: 0.6 })
    );
    m.position.set(x, heightAt(x, z) + h / 2, z);
    m.rotation.y = Math.PI / 4;
    g.add(m);
  }
  // Salesforce Tower
  {
    const [x, z] = W(-122.3967, 37.7897);
    const h = hU(326);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.21, h, 12),
      new THREE.MeshStandardMaterial({ color: '#aebfca', roughness: 0.35, metalness: 0.3 })
    );
    m.position.set(x, heightAt(x, z) + h / 2, z);
    g.add(m);
  }
  // 555 California
  {
    const [x, z] = W(-122.4040, 37.7920);
    const h = hU(237);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, h, 0.18),
      new THREE.MeshStandardMaterial({ color: '#9b8f7d', roughness: 0.7 })
    );
    m.position.set(x, heightAt(x, z) + h / 2, z);
    m.rotation.y = -0.32;
    g.add(m);
  }
  // Coit Tower
  {
    const [x, z] = W(-122.4058, 37.8024);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 0.55, 10),
      new THREE.MeshStandardMaterial({ color: '#e3ddd0', roughness: 0.8 })
    );
    m.position.set(x, heightAt(x, z) + 0.27, z);
    g.add(m);
  }
  // Sutro Tower — the tripod that floats above the fog
  {
    const [x, z] = W(-122.4527, 37.7552);
    const base = heightAt(x, z);
    const h = hU(297);
    const mat = new THREE.MeshStandardMaterial({
      color: '#c8503a', roughness: 0.6,
      emissive: '#c8503a', emissiveIntensity: 0.1,
    });
    const tower = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, h, 6), mat);
      const spread = 0.30;
      leg.position.set(x + Math.cos(a) * spread * 0.55, base + h / 2, z + Math.sin(a) * spread * 0.55);
      leg.rotation.z = Math.cos(a) * (spread / h) * 1.6;
      leg.rotation.x = -Math.sin(a) * (spread / h) * 1.6;
      tower.add(leg);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 4), mat);
      ant.position.set(x + Math.cos(a) * 0.13, base + h + 0.42, z + Math.sin(a) * 0.13);
      tower.add(ant);
    }
    for (const fy of [0.55, 0.78]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8, 1, true), mat);
      ring.position.set(x, base + h * fy, z);
      tower.add(ring);
    }
    g.add(tower);
  }
  // Alcatraz cellhouse + lighthouse
  {
    const [x, z] = W(-122.4230, 37.8267);
    const base = heightAt(x, z);
    const cell = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.12, 0.16),
      new THREE.MeshStandardMaterial({ color: '#d8d2c2', roughness: 0.9 })
    );
    cell.position.set(x, base + 0.06, z);
    cell.rotation.y = 0.5;
    g.add(cell);
    const lh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.03, 0.26, 6),
      new THREE.MeshStandardMaterial({ color: '#e8e2d2' })
    );
    lh.position.set(x + 0.15, base + 0.2, z + 0.1);
    g.add(lh);
  }
  // Palace of Fine Arts rotunda
  {
    const [x, z] = W(-122.4486, 37.8029);
    const base = heightAt(x, z);
    const mat = new THREE.MeshStandardMaterial({ color: '#c9b896', roughness: 0.8 });
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.16, 10), mat);
    drum.position.set(x, base + 0.08, z);
    g.add(drum);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    dome.position.set(x, base + 0.16, z);
    g.add(dome);
  }
  // Ferry Building
  {
    const [x, z] = W(-122.3935, 37.7955);
    const base = heightAt(x, z);
    const hall = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.09, 0.1),
      new THREE.MeshStandardMaterial({ color: '#d9cfb8', roughness: 0.8 })
    );
    hall.position.set(x, base + 0.045, z);
    hall.rotation.y = 0.6;
    g.add(hall);
    const clock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.05), hall.material);
    clock.position.set(x, base + 0.16, z);
    g.add(clock);
  }
  return g;
}

// ————————————————— city lights (night) —————————————————

function lightSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildCityLights(buildingPositions, gate) {
  const rnd = mulberry(99);
  const pts = [];
  const cols = [];
  const warm = [new THREE.Color('#ffb46b'), new THREE.Color('#ffd9a0'), new THREE.Color('#fff2cf')];
  const cool = new THREE.Color('#cfe0ff');

  for (const p of buildingPositions) {
    if (rnd() > 0.62) continue;
    const n = p.bh > 0.8 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      pts.push(p.x + (rnd() - 0.5) * 0.12, p.ground + p.bh * (0.4 + rnd() * 0.65), p.z + (rnd() - 0.5) * 0.12);
      const c = rnd() > 0.85 ? cool : warm[(rnd() * 3) | 0];
      cols.push(c.r, c.g, c.b);
    }
  }
  // necklace of lights along the Golden Gate deck
  const A = gate.deckCurveA, B = gate.deckCurveB;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push(A[0] + (B[0] - A[0]) * t, gate.deckY + 0.1, A[1] + (B[1] - A[1]) * t);
    cols.push(1.0, 0.85, 0.6);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
  const mat = new THREE.PointsMaterial({
    size: 0.55,
    map: lightSprite(),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// ————————————————— assemble —————————————————

export function buildWorld(scene) {
  const group = new THREE.Group();
  group.add(buildTerrain());
  group.add(buildWater());

  const { mesh: buildings, positions } = buildBuildings();
  group.add(buildings);

  const gate = buildGoldenGate();
  group.add(gate.group);
  group.add(buildBayBridge());
  group.add(buildLandmarks());
  group.add(buildTrees());
  group.add(buildPiers());

  const lights = buildCityLights(positions, gate);
  group.add(lights);

  scene.add(group);
  return { group, cityLights: lights };
}
