// Builds the stylized 3-D San Francisco: terrain, water, city, bridges, landmarks.
// Topography is the real thing: a USGS heightfield baked into js/data/heightmap.png
// by tools/fetch-geodata.mjs; parks are OpenStreetMap polygons from the same script.

import * as THREE from 'three';
import { REGION, KM_LON, KM_LAT, UPK, C_LON, C_LAT, W, hU, WORLD_W, WORLD_H } from './geo.js';
import { HF_META, PARKS, WATERS } from './data/geodata.js';

// ————— real topography —————

const G = HF_META.grid;
let elev = null; // Float32Array G×G, meters above sea level, row 0 = north

export async function loadTerrainData() {
  const img = new Image();
  img.src = new URL('./data/heightmap.png', import.meta.url).href;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = cv.height = G;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, G, G).data;
  elev = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    elev[i] = (px[i * 4] * 256 + px[i * 4 + 1] - HF_META.off) / HF_META.scale;
  }
}

// world x/z → fractional heightfield coords (grid is lon/lat aligned over REGION)
const GXK = (G - 1) / ((REGION.lonE - REGION.lonW) * KM_LON * UPK);
const GYK = (G - 1) / ((REGION.latN - REGION.latS) * KM_LAT * UPK);
const GX0 = (C_LON - REGION.lonW) * KM_LON * UPK * GXK;
const GY0 = (REGION.latN - C_LAT) * KM_LAT * UPK * GYK;

// meters above sea level at a world (x, z), bilinear
export function elevM(x, z) {
  const gx = Math.min(G - 1.001, Math.max(0, GX0 + x * GXK));
  const gy = Math.min(G - 1.001, Math.max(0, GY0 + z * GYK));
  const ix = gx | 0, iy = gy | 0;
  const fx = gx - ix, fy = gy - iy;
  const i = iy * G + ix;
  const a = elev[i] + (elev[i + 1] - elev[i]) * fx;
  const b = elev[i + G] + (elev[i + G + 1] - elev[i + G]) * fx;
  return a + (b - a) * fy;
}

const isLand = (x, z) => elevM(x, z) > 1.0;

export function heightAt(x, z) {
  const m = elevM(x, z);
  if (m > 0) return hU(m);
  return Math.max(hU(m), -0.5); // real bathymetry, capped so the seabed stays shallow
}

// ————— real park & lake polygons (OpenStreetMap) —————

function toWorldPoly(poly) {
  const pts = poly.map((q) => W(q[0], q[1]));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { pts, x0, x1, z0, z1 };
}

const parksW = PARKS.map((p) => ({ ...toWorldPoly(p.poly), trees: p.trees, area: p.area }));
const watersW = WATERS.map((w) => toWorldPoly(w.poly));

function ptInPoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function inPark(x, z) {
  for (const p of parksW) {
    if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && ptInPoly(p.pts, x, z)) return true;
  }
  return false;
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

// land character by geography: dry-grass headlands vs. the urban peninsula
function isGrassland(lon, lat) {
  return lat > 37.84 || (lat > 37.81 && lon < -122.47);
}

// hillshade: relief shading from the heightfield, light out of the northwest
function shadeAt(x, z) {
  const e = 0.35;   // sample offset in world units (~35 m)
  const boost = 6;  // relief exaggeration, shading only
  const sx = ((elevM(x + e, z) - elevM(x - e, z)) / (2 * e * 100)) * boost;
  const sz = ((elevM(x, z + e) - elevM(x, z - e)) / (2 * e * 100)) * boost;
  let nx = -sx, ny = 1, nz = -sz;
  const L = Math.hypot(nx, ny, nz);
  nx /= L; ny /= L; nz /= L;
  const d = nx * -0.45 + ny * 0.78 + nz * -0.43; // light from the NW, fairly high
  return 0.55 + 0.45 * Math.max(0, d);           // flat ground ≈ 0.90
}

function groundTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = TEX_SIZE;
  const ctx = cv.getContext('2d');
  const rnd = mulberry(7);
  const PXU = TEX_SIZE / PLANE_W; // pixels per world unit (~10 px = 1 km / 10)

  // — base raster straight from the heightfield: water, sand, city, grass —
  // also build masks so the painterly overlays stay on their own landmass
  const base = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const urbanMaskCv = document.createElement('canvas');
  const grassMaskCv = document.createElement('canvas');
  urbanMaskCv.width = urbanMaskCv.height = grassMaskCv.width = grassMaskCv.height = TEX_SIZE;
  const urbanCtx = urbanMaskCv.getContext('2d');
  const grassCtx = grassMaskCv.getContext('2d');
  const urbanMask = urbanCtx.createImageData(TEX_SIZE, TEX_SIZE);
  const grassMask = grassCtx.createImageData(TEX_SIZE, TEX_SIZE);

  for (let py = 0; py < TEX_SIZE; py++) {
    const z = ((py + 0.5) / TEX_SIZE) * PLANE_H - PLANE_H / 2;
    const lat = C_LAT - z / (KM_LAT * UPK);
    for (let pxi = 0; pxi < TEX_SIZE; pxi++) {
      const x = ((pxi + 0.5) / TEX_SIZE) * PLANE_W - PLANE_W / 2;
      const m = elevM(x, z);
      const k = (py * TEX_SIZE + pxi) * 4;
      let r, g, b;
      if (m <= 0.6) {
        // water, a touch darker as it deepens, teal in the shallows
        const d = Math.min(1, Math.max(0, -m / 40));
        const sh = Math.min(1, Math.max(0, (m + 3.5) / 4.1)); // shallow near shore
        r = 36 - 8 * d + 14 * sh; g = 64 - 12 * d + 16 * sh; b = 79 - 12 * d + 12 * sh;
        // a whisper of surf right at the waterline
        if (m > -1.2) { const f = (m + 1.2) / 1.8; r += 46 * f; g += 44 * f; b += 38 * f; }
      } else {
        const lon = x / (KM_LON * UPK) + C_LON;
        if (isGrassland(lon, lat)) {
          r = 141; g = 150; b = 99;             // Marin / headlands dry grass
          grassMask.data[k + 3] = 255;
        } else if (m < 4.5 && lon < -122.483) {
          r = 217; g = 199; b = 157;            // Ocean Beach sand strip
        } else {
          r = 178; g = 173; b = 163;            // the city itself
          urbanMask.data[k + 3] = 255;
        }
        // baked relief shading so the hills read even in flat light
        const s = shadeAt(x, z);
        r *= s; g *= s; b *= s;
      }
      base.data[k] = r; base.data[k + 1] = g; base.data[k + 2] = b;
      base.data[k + 3] = 255;
    }
  }
  ctx.putImageData(base, 0, 0);
  urbanCtx.putImageData(urbanMask, 0, 0);
  grassCtx.putImageData(grassMask, 0, 0);

  // a masked painter: draw() onto a scratch layer, keep only the masked part
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = TEX_SIZE;
  const sctx = scratch.getContext('2d');
  function masked(maskCv, draw) {
    sctx.save();
    sctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    draw(sctx);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(maskCv, 0, 0);
    sctx.restore();
    ctx.drawImage(scratch, 0, 0);
  }

  // headlands get dry-grass mottling
  masked(grassMaskCv, (c) => {
    for (let i = 0; i < 1600; i++) {
      c.fillStyle = rnd() > 0.5 ? 'rgba(120,130,80,0.25)' : 'rgba(160,160,100,0.18)';
      c.fillRect(rnd() * TEX_SIZE, rnd() * TEX_SIZE, 4 + rnd() * 14, 3 + rnd() * 10);
    }
  });

  // everything urban is masked to city land
  ctx.save();

  // block mottling
  masked(urbanMaskCv, (c) => {
    for (let i = 0; i < 5200; i++) {
      const l = rnd();
      c.fillStyle = l > 0.55 ? 'rgba(255,250,240,0.05)' : 'rgba(70,65,55,0.05)';
      c.fillRect(rnd() * TEX_SIZE, rnd() * TEX_SIZE, 3 + rnd() * 9, 3 + rnd() * 9);
    }
  });

  // street grids + arteries, masked to city land so nothing draws into the bay
  masked(urbanMaskCv, (c) => {
    c.strokeStyle = 'rgba(64,70,74,0.34)';
    c.lineWidth = 1.6;
    for (const g of GRIDS) {
      const a0 = texLL(g.b[0], g.b[1]);
      const a1 = texLL(g.b[2], g.b[3]);
      const cx = (a0[0] + a1[0]) / 2, cy = (a0[1] + a1[1]) / 2;
      const hw = Math.abs(a1[0] - a0[0]) / 2, hh = Math.abs(a1[1] - a0[1]) / 2;
      const ext = Math.hypot(hw, hh);
      c.save();
      // clip to the (unrotated) district rect, then draw a rotated line family
      c.beginPath();
      c.rect(cx - hw, cy - hh, hw * 2, hh * 2);
      c.clip();
      c.translate(cx, cy);
      c.rotate(g.a);
      const stepX = g.sx * 10 * PXU, stepZ = g.sz * 10 * PXU;
      c.beginPath();
      for (let x = -ext; x <= ext; x += stepX) { c.moveTo(x, -ext); c.lineTo(x, ext); }
      for (let y = -ext; y <= ext; y += stepZ) { c.moveTo(-ext, y); c.lineTo(ext, y); }
      c.stroke();
      c.restore();
    }

    c.strokeStyle = 'rgba(52,58,62,0.5)';
    c.lineWidth = 3.2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const road of ARTERIES) {
      c.beginPath();
      road.forEach((p, i) => {
        const [px, py] = texLL(p[0], p[1]);
        i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
      });
      c.stroke();
    }
  });

  // real park shapes paint over the streets
  for (const p of parksW) {
    ctx.save();
    tracePoly(ctx, p.pts);
    ctx.fillStyle = '#5e7d4f';
    ctx.fill();
    ctx.clip();
    const [px0, py0] = texPt(p.x0, p.z0);
    const [px1, py1] = texPt(p.x1, p.z1);
    for (let i = 0; i < (px1 - px0) * (py1 - py0) / 110; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(40,70,35,0.35)' : 'rgba(120,150,90,0.3)';
      const r = 1.5 + rnd() * 3;
      ctx.beginPath();
      ctx.arc(px0 + rnd() * (px1 - px0), py0 + rnd() * (py1 - py0), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // lakes (Merced, Stow) are actually lakes
  for (const w of watersW) {
    tracePoly(ctx, w.pts);
    ctx.fillStyle = '#2e4a57';
    ctx.fill();
  }

  ctx.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ————————————————— terrain mesh —————————————————

function buildTerrain() {
  const RES = 448; // ~45 m cells, close to the 30 m heightfield resolution
  const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_H, RES, RES);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    roughness: 1.0,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

// ————————————————— ocean —————————————————
// A live water surface: drifting wave normals, Fresnel toward the sky,
// and a glitter path under the sun. Normals are shaded per-pixel; the
// mesh itself stays a flat disc.

const waterVert = /* glsl */`
  varying vec3 vWorld;
  varying float vFogDepth;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const waterFrag = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying float vFogDepth;

  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uSkyHor;
  uniform vec3 uSkyZen;
  uniform float uDayF;
  uniform float uTime;
  uniform vec3 fogColor;
  uniform float fogDensity;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }
  float waveH(vec2 p, float t) {
    float h = 0.0;
    h += vnoise(p * 0.45 + vec2(t * 0.045, t * 0.018)) * 0.60;
    h += vnoise(p * 1.45 + vec2(-t * 0.085, t * 0.040)) * 0.30;
    h += vnoise(p * 4.30 + vec2(t * 0.150, -t * 0.070)) * 0.10;
    return h;
  }

  void main() {
    vec3 V = normalize(uCamPos - vWorld);
    float dist = length(uCamPos - vWorld);

    // wave normal, detail fading with distance so the horizon stays calm
    float k = clamp(60.0 / (dist + 8.0), 0.12, 1.0);
    float e = 0.30;
    vec2 p = vWorld.xz;
    float h0 = waveH(p, uTime);
    float hx = waveH(p + vec2(e, 0.0), uTime);
    float hz = waveH(p + vec2(0.0, e), uTime);
    vec3 N = normalize(vec3(-(hx - h0) / e * 0.40 * k, 1.0, -(hz - h0) / e * 0.40 * k));

    // base color: deep sea toward straight-down looks, sky toward grazing
    vec3 deepDay   = vec3(0.075, 0.145, 0.185);
    vec3 deepNight = vec3(0.010, 0.018, 0.032);
    vec3 deep = mix(deepNight, deepDay, uDayF) * (0.9 + 0.2 * h0);

    float fres = 0.035 + 0.965 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
    vec3 skyRef = mix(uSkyHor, uSkyZen, 0.35);
    vec3 col = mix(deep, skyRef, fres * 0.85);

    // sun glitter path
    vec3 R = reflect(-V, N);
    float sunUp = smoothstep(-0.04, 0.05, uSunDir.y);
    float glint = pow(max(dot(R, uSunDir), 0.0), 640.0) * 6.0
                + pow(max(dot(R, uSunDir), 0.0), 48.0) * 0.35;
    col += uSunCol * glint * sunUp;

    // aerial perspective (matches the scene's FogExp2)
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    col = mix(col, fogColor, fogFactor);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function buildWater() {
  const geo = new THREE.CircleGeometry(900, 48);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color('#fff3e0') },
      uSkyHor: { value: new THREE.Color('#c9d5dd') },
      uSkyZen: { value: new THREE.Color('#4d80b8') },
      uDayF: { value: 1 },
      uTime: { value: 0 },
      fogColor: { value: new THREE.Color('#aebdc9') },
      fogDensity: { value: 0.00055 },
    },
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
    // solid land, with a margin: no rowhouses wading into the surf
    if (elevM(x, z) < 2.5) continue;
    if (!isLand(x + 0.35, z) || !isLand(x - 0.35, z) || !isLand(x, z + 0.35) || !isLand(x, z - 0.35)) continue;
    if (inPark(x, z)) continue;
    const h = heightAt(x, z);
    if (h < 0.05 || h > 3.9) continue;
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
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, positions };
}

// ————————————————— trees, piers —————————————————

function buildTrees() {
  const rnd = mulberry(424242);
  const spots = [];
  const treed = parksW.filter(p => p.trees);
  // weight park choice by area so Golden Gate Park gets its forest
  const cum = [];
  let total = 0;
  for (const p of treed) { total += p.area; cum.push(total); }
  for (let i = 0; i < 12000 && spots.length < 1700; i++) {
    const pick = rnd() * total;
    let pi = 0;
    while (cum[pi] < pick) pi++;
    const p = treed[pi];
    const x = p.x0 + rnd() * (p.x1 - p.x0);
    const z = p.z0 + rnd() * (p.z1 - p.z0);
    if (!ptInPoly(p.pts, x, z)) continue;
    if (elevM(x, z) < 2) continue;
    const h = heightAt(x, z);
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
  mesh.castShadow = true;
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
    if (isLand(x + nx, z + nz)) { nx = -nx; nz = -nz; }
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

export async function buildWorld(scene) {
  await loadTerrainData();
  const group = new THREE.Group();
  group.add(buildTerrain());
  const water = buildWater();
  group.add(water);

  const { mesh: buildings, positions } = buildBuildings();
  group.add(buildings);

  const gate = buildGoldenGate();
  group.add(gate.group);
  const bay = buildBayBridge();
  group.add(bay);
  const landmarks = buildLandmarks();
  group.add(landmarks);
  group.add(buildTrees());
  group.add(buildPiers());

  for (const g of [gate.group, bay, landmarks]) {
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }

  const lights = buildCityLights(positions, gate);
  group.add(lights);

  scene.add(group);
  return { group, cityLights: lights, water };
}
