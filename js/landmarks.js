// Hand-built landmarks whose shapes a plain extrusion cannot capture, placed on
// their real footprints (tools/bake/buildings.py writes data/landmarks.json).

import * as THREE from 'three';
import { W } from './geo.js';
import { glowPoints } from './bridges.js';

const DEG = Math.PI / 180;

function signedArea2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a;
}

// area centroid: footprints often carry extra vertices along one side
function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
    const c = x0 * z1 - x1 * z0;
    a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c;
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// Loft a footprint through levels [[y, scale], ...] about a center. `flat` gives
// hard edges between ring segments (a pyramid), otherwise the ring is smooth
// (a rounded tower). aFac holds facade coordinates in meters: x along the wall,
// y above the base.
function loft(ring, levels, { flat = false, cap = true, center = centroid(ring) } = {}) {
  const pts = signedArea2(ring) > 0 ? ring.slice().reverse() : ring; // counter-clockwise from above
  const n = pts.length;
  const [cx, cz] = center;
  const base = levels[0][0];
  const at = (i, y, s) => {
    const [x, z] = pts[i % n];
    return [cx + (x - cx) * s, y, cz + (z - cz) * s];
  };
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(x1 - x0, z1 - z0));
  }
  const pos = [], fac = [], idx = [];
  if (flat) {
    for (let i = 0; i < n; i++) {
      const len = cum[i + 1] - cum[i];
      const v0 = pos.length / 3;
      for (const [y, s] of levels) {
        pos.push(...at(i, y, s), ...at(i + 1, y, s));
        // centered on the face at true width, so window columns stay upright as it narrows
        fac.push(i * 1000 - (len * s) / 2, y - base, i * 1000 + (len * s) / 2, y - base);
      }
      for (let L = 1; L < levels.length; L++) {
        const b = v0 + (L - 1) * 2, t = v0 + L * 2;
        idx.push(b, b + 1, t, b + 1, t + 1, t);
      }
    }
  } else {
    levels.forEach(([y, s], L) => {
      for (let i = 0; i <= n; i++) {
        pos.push(...at(i, y, s));
        fac.push(cum[i], y - base);
      }
      if (L > 0) {
        const a0 = (L - 1) * (n + 1), a1 = L * (n + 1);
        for (let i = 0; i < n; i++) idx.push(a0 + i, a0 + i + 1, a1 + i, a0 + i + 1, a1 + i + 1, a1 + i);
      }
    });
  }
  const capAt = pos.length / 3;
  if (cap) {
    const [y, s] = levels[levels.length - 1];
    for (let i = 0; i < n; i++) { pos.push(...at(i, y, s)); fac.push(0, y - base); }
    pos.push(cx, y, cz); fac.push(0, y - base);
    for (let i = 0; i < n; i++) idx.push(capAt + i, capAt + ((i + 1) % n), capAt + n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFac', new THREE.Float32BufferAttribute(fac, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (!flat) {
    // close the shading seam where the ring starts and ends
    const nrm = g.attributes.normal;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let L = 0; L < levels.length; L++) {
      const a = L * (n + 1), b = a + n;
      v.fromBufferAttribute(nrm, a).add(w.fromBufferAttribute(nrm, b)).normalize();
      nrm.setXYZ(a, v.x, v.y, v.z);
      nrm.setXYZ(b, v.x, v.y, v.z);
    }
  }
  return g;
}

// an upright box in a local frame: u, t extents, y0..y1
function prism(P, u0, u1, t0, t1, y0, y1) {
  return loft([P(u0, t0), P(u1, t0), P(u1, t1), P(u0, t1)], [[y0, 1], [y1, 1]], { flat: true });
}

const LM_PARS = /* glsl */`
  varying vec2 vFac;
  varying vec3 vLmPos;
  uniform float uNightK;
  uniform float uLitHour;
  float lmHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

// A facade with a window grid that fades to its average where it would alias,
// and offices lit at night, the same way the city's buildings are shaded.
function facade(o) {
  const f = (v) => v.toFixed(4);
  const v3 = (c) => `vec3(${c.map(f).join(', ')})`;
  const mat = new THREE.MeshStandardMaterial({ roughness: o.roughness, metalness: o.metalness ?? 0 });
  mat.userData.uniforms = { uNightK: { value: 0 }, uLitHour: { value: 0.5 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mat.userData.uniforms);
    sh.vertexShader = 'attribute vec2 aFac;\nvarying vec2 vFac;\nvarying vec3 vLmPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vFac = aFac;
      vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `);
    sh.fragmentShader = LM_PARS + sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        vec3 fN = normalize(cross(dFdx(vLmPos), dFdy(vLmPos)));
        float isRoof = step(0.6, fN.y);
        vec2 cell = vec2(vFac.x / ${f(o.cellW)}, vFac.y / ${f(o.floorH)});
        vec2 fw = fwidth(cell);
        float aa = clamp(1.0 - max(fw.x, fw.y) * 2.2, 0.0, 1.0);
        vec2 fc = fract(cell);
        vec2 hw = vec2(${f(o.win[0] / 2)}, ${f(o.win[1] / 2)});
        vec2 e = max(fw * 0.75, vec2(0.001));
        float wx = smoothstep(0.5 - hw.x - e.x, 0.5 - hw.x + e.x, fc.x) * (1.0 - smoothstep(0.5 + hw.x - e.x, 0.5 + hw.x + e.x, fc.x));
        float wy = smoothstep(0.5 - hw.y - e.y, 0.5 - hw.y + e.y, fc.y) * (1.0 - smoothstep(0.5 + hw.y - e.y, 0.5 + hw.y + e.y, fc.y));
        float band = step(${f(o.from ?? 6)}, vFac.y) * step(vFac.y, ${f(o.to ?? 1e4)});
        float winMask = mix(${f(o.win[0] * o.win[1])}, wx * wy, aa) * (1.0 - isRoof) * band;
        // lit in sections of a few windows across two floors, as on the city's buildings
        float h = lmHash(floor(cell) + ${f(o.seed ?? 1)});
        float litK = ${f(o.lit ?? 0)} * uLitHour;
        vec2 sec = cell / vec2(3.0, 1.0);
        vec2 fwS = fwidth(sec);
        float lodR = log2(max(max(fwS.x, fwS.y), 1e-4) * 2.0);
        float lod = clamp(lodR, 0.0, 4.0);
        float l0 = floor(lod), lf = lod - l0;
        float sd = ${f((o.seed ?? 1) * 3.1)} + l0 * 13.0;
        float hs0 = lmHash(floor(sec / exp2(l0)) + sd);
        float hs1 = lmHash(floor(sec / exp2(l0 + 1.0)) + sd + 13.0);
        float on0 = step(hs0, litK) * (0.45 + 0.55 * fract(hs0 * 7.31));
        float on1 = step(hs1, litK) * (0.45 + 0.55 * fract(hs1 * 7.31));
        float lit = winMask * mix(mix(on0, on1, lf) * mix(0.8, step(h, 0.8), aa), litK * 0.58, smoothstep(4.0, 5.0, lodR));
        float glowK = ${o.glow ? `${f(o.glow[1])} * step(${f(o.glow[0])}, vFac.y) * (1.0 - isRoof)` : '0.0'};
        diffuseColor.rgb = mix(mix(${v3(o.wall)}, ${v3(o.glass)}, winMask), ${v3(o.roof ?? [0.3, 0.3, 0.29])}, isRoof);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = mix(roughness, ${f(o.glassRough ?? 0.08)}, winMask);
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        float metalnessFactor = mix(metalness, 0.0, winMask);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        totalEmissiveRadiance += (${v3(o.litCol ?? [1, 0.75, 0.48])} * lit * 0.3 + ${v3(o.glowCol ?? [0.85, 0.88, 0.95])} * glowK) * uNightK;
      `);
  };
  const key = JSON.stringify(o);
  mat.customProgramCacheKey = () => 'karl-landmark-' + key;
  return mat;
}

// Salesforce Tower: a rounded square of glass and pearl-white sunshades that
// tapers and softens as it rises; the top 46 m is the open crown, lit at night
function salesforce(lm, red) {
  const g = lm.ground, H = lm.height || 326, CROWN = 280;
  const s = (y) => { const u = (y - g) / H; return 1 - 0.14 * u * u - 0.18 * Math.pow(u, 8); };
  const center = centroid(lm.ring);
  const lv = (ys) => ys.map((y) => [g + y, s(g + y)]);
  const body = facade({
    wall: [0.6, 0.61, 0.61], glass: [0.04, 0.055, 0.065], roughness: 0.42, metalness: 0.25, glassRough: 0.05,
    floorH: 4.15, cellW: 1.52, win: [0.86, 0.6], from: 9, to: CROWN - 3, lit: 0.4, litCol: [0.9, 0.92, 0.95], seed: 7,
  });
  const crown = facade({
    wall: [0.64, 0.65, 0.65], glass: [0.2, 0.21, 0.22], roughness: 0.55, metalness: 0.2, glassRough: 0.6,
    floorH: 1.6, cellW: 1.2, win: [0.5, 0.45], from: 0, glow: [0, 0.045], roof: [0.18, 0.18, 0.18], seed: 3,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(loft(lm.ring, lv([-2, 40, 90, 140, 180, 210, 235, 255, 270, CROWN]), { cap: false, center }), body));
  group.add(new THREE.Mesh(loft(lm.ring, lv([CROWN, 292, 303, 312, 320, H]), { center }), crown));
  // aviation lights on the crown's corners
  const top = g + H + 1.5, sc = s(g + H);
  for (let k = 0; k < 4; k++) {
    const [x, z] = lm.ring[Math.floor((k * lm.ring.length) / 4)];
    red.push(center[0] + (x - center[0]) * sc, top, center[1] + (z - center[1]) * sc);
  }
  group.userData.mats = [body, crown];
  return { group, obstacle: { x: center[0], z: center[1], r: 50, top: g + H + 4 } };
}

// Transamerica Pyramid: four faces of white quartz aggregate rising to the
// spire, and the two upright wings (elevators east, stairs west) that the
// narrowing floors push out of the faces from the 29th floor up
function transamerica(lm, red) {
  const g = lm.ground, H = lm.height || 260;
  // oriented minimum-area rectangle of the footprint
  let best = null;
  for (let a = 0; a < 90; a += 0.25) {
    const ux = Math.cos(a * DEG), uz = Math.sin(a * DEG);
    let u0 = Infinity, u1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const [x, z] of lm.ring) {
      const u = x * ux + z * uz, t = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (u1 - u0) * (t1 - t0);
    if (!best || area < best.area) best = { a, area, uc: (u0 + u1) / 2, tc: (t0 + t1) / 2, hu: (u1 - u0) / 2, ht: (t1 - t0) / 2 };
  }
  const a0 = best.a * DEG;
  const cx = best.uc * Math.cos(a0) - best.tc * Math.sin(a0);
  const cz = best.uc * Math.sin(a0) + best.tc * Math.cos(a0);
  // u should point (roughly) east, where the elevator wing is
  const a = best.a > 45 ? best.a - 90 : best.a;
  const ux = Math.cos(a * DEG), uz = Math.sin(a * DEG);
  const P = (u, t) => [cx + ux * u - uz * t, cz + uz * u + ux * t];
  const half = THREE.MathUtils.clamp(Math.min(best.hu, best.ht), 22, 29);
  const halfAt = (y) => half * (1 - (y - g) / H);

  const white = facade({
    wall: [0.66, 0.64, 0.6], glass: [0.04, 0.045, 0.05], roughness: 0.82, glassRough: 0.1,
    floorH: 3.85, cellW: 1.55, win: [0.42, 0.55], from: 9, to: 197, lit: 0.42, litCol: [1.0, 0.8, 0.56],
    glow: [199, 0.03], glowCol: [1.0, 0.92, 0.78], seed: 11,
  });
  const plain = facade({ wall: [0.64, 0.62, 0.58], glass: [0.3, 0.3, 0.3], roughness: 0.85, floorH: 3.85, cellW: 1.55, win: [0, 0], seed: 5 });
  const group = new THREE.Group();
  const sq = [P(-half, -half), P(half, -half), P(half, half), P(-half, half)];
  const levels = [];
  for (let i = 0; i <= 6; i++) { const y = g - 2 + (i / 6) * (H + 2); levels.push([y, Math.max(0.002, 1 - (y - g) / H)]); }
  group.add(new THREE.Mesh(loft(sq, levels, { flat: true, cap: false, center: [cx, cz] }), white));
  const W0 = g + 117, W1 = g + 205, D = halfAt(W0);
  for (const side of [-1, 1]) {
    const geo = prism((u, t) => P(u * side, t), D - 11, D, -5, 5, W0 - 12, W1);
    group.add(new THREE.Mesh(geo, plain));
    const [lx, lz] = P((D - 5.5) * side, 0);
    red.push(lx, W1 + 1.5, lz);
  }
  red.push(cx, g + H + 1, cz);
  group.userData.mats = [white, plain];
  return { group, obstacle: { x: cx, z: cz, r: 45, top: g + H + 4 } };
}

// Sutro Tower: a 298 m three-legged lattice mast on Mt. Sutro, red and white
function sutro(ground, red) {
  const [cx, cz] = W(-122.45285, 37.75524);
  const g0 = ground(cx, cz);
  const H = 298;
  const group = new THREE.Group();
  const redMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.55, 0.06, 0.04), roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.62, 0.62, 0.6), roughness: 0.6 });
  const legGeo = new THREE.CylinderGeometry(0.9, 1.6, 1, 6, 1);
  legGeo.translate(0, 0.5, 0);
  // legs lean in toward the waist (~1/3 height), then out toward the top
  const spread = (y) => {
    const u = y / H;
    return u < 0.33 ? 34 - 40 * u : 20.8 + 30 * (u - 0.33);
  };
  const bands = 8;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    for (const [y0, y1] of [[0, 0.33 * H], [0.33 * H, 0.66 * H], [0.66 * H, H]]) {
      const sub = Math.round((y1 - y0) / (H / bands));
      for (let s = 0; s < sub; s++) {
        const ya = y0 + ((y1 - y0) * s) / sub, yb = y0 + ((y1 - y0) * (s + 1)) / sub;
        const p0 = new THREE.Vector3(cx + Math.cos(a) * spread(ya), g0 + ya, cz + Math.sin(a) * spread(ya));
        const p1 = new THREE.Vector3(cx + Math.cos(a) * spread(yb), g0 + yb, cz + Math.sin(a) * spread(yb));
        const m = new THREE.Mesh(legGeo, (Math.floor((ya / H) * bands * 2) % 2) ? white : redMat);
        m.position.copy(p0);
        m.scale.set(1.6, p0.distanceTo(p1), 1.6);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
        group.add(m);
      }
    }
    // an antenna mast on each leg
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 22, 6), white);
    mast.position.set(cx + Math.cos(a) * spread(H), g0 + H + 11, cz + Math.sin(a) * spread(H));
    group.add(mast);
    red.push(cx + Math.cos(a) * spread(H), g0 + H + 23, cz + Math.sin(a) * spread(H));
    red.push(cx + Math.cos(a) * spread(0.66 * H), g0 + 0.66 * H + 2, cz + Math.sin(a) * spread(0.66 * H));
  }
  // cross-arms: triangular frames at three levels
  for (const y of [0.33 * H, 0.66 * H, H]) {
    for (let i = 0; i < 3; i++) {
      const a0 = (i / 3) * Math.PI * 2 + 0.3, a1 = ((i + 1) / 3) * Math.PI * 2 + 0.3;
      const r = spread(y);
      const p0 = new THREE.Vector3(cx + Math.cos(a0) * r, g0 + y, cz + Math.sin(a0) * r);
      const p1 = new THREE.Vector3(cx + Math.cos(a1) * r, g0 + y, cz + Math.sin(a1) * r);
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 3.2, 2.4), redMat);
      m.position.copy(p0).lerp(p1, 0.5);
      m.scale.x = p0.distanceTo(p1);
      m.rotation.y = -Math.atan2(p1.z - p0.z, p1.x - p0.x);
      group.add(m);
    }
  }
  return { group, obstacle: { x: cx, z: cz, r: 90, top: g0 + H + 27 } };
}

export class Landmarks {
  // data: data/landmarks.json, or null (then only Sutro Tower, which needs no footprint)
  constructor(scene, ground, data) {
    this.group = new THREE.Group();
    this.group.name = 'landmarks';
    this.mats = [];
    this.obstacles = [];
    const red = [];
    const add = ({ group, obstacle }) => {
      group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.mats.push(...(group.userData.mats || []));
      this.obstacles.push(obstacle);
      this.group.add(group);
    };
    add(sutro(ground, red));
    if (data?.salesforce) add(salesforce(data.salesforce, red));
    if (data?.transamerica) add(transamerica(data.transamerica, red));
    this.redMat = glowPoints(new THREE.Color(1.0, 0.12, 0.06), 12);
    this.group.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(red, 3)), this.redMat));
    scene.add(this.group);
  }

  setNight(k, litHour = 0.5) {
    for (const m of this.mats) {
      m.userData.uniforms.uNightK.value = k;
      m.userData.uniforms.uLitHour.value = litHour;
    }
    this.redMat.opacity = k;
  }
}
