// The Golden Gate Bridge and the Bay Bridge, built from real dimensions and
// placed on their surveyed tower foundations (OpenStreetMap bridge supports).
//
// Golden Gate: main span 1280 m, side spans 343 m, towers 227 m above water,
// roadway ~67-75 m, deck 27.4 m wide with 7.6 m stiffening trusses, main
// cables 0.92 m on 27.4 m centers with 144 m sag, suspenders every 15.24 m.

import * as THREE from 'three';
import { W } from './geo.js';

// ————— geometry builder in a bridge-local frame (s along, l lateral, y up) —————
class Builder {
  constructor(origin, axis) {
    this.o = origin;                  // [x, z]
    this.a = axis;                    // unit [x, z] along the bridge
    this.b = [-axis[1], axis[0]];     // lateral (to the right looking along +s)
    this.pos = []; this.nrm = []; this.uv = [];
  }
  P(s, l, y) {
    return [this.o[0] + this.a[0] * s + this.b[0] * l, y, this.o[1] + this.a[1] * s + this.b[1] * l];
  }
  quad(p0, p1, p2, p3, n, uv) {
    // p0..p3 counter-clockwise seen from outside
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = [p0, p1, p2, p3][i];
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(uv[i][0], uv[i][1]);
    }
  }
  dirW(ds, dl, dy) {
    return [this.a[0] * ds + this.b[0] * dl, dy, this.a[1] * ds + this.b[1] * dl];
  }
  // box aligned with the bridge frame; uv in meters on every face
  box(s0, s1, l0, l1, y0, y1, faces = 'all') {
    const c = (s, l, y) => this.P(s, l, y);
    const ds = s1 - s0, dl = l1 - l0, dy = y1 - y0;
    const F = (name) => faces === 'all' || faces.includes(name);
    // the lateral axis is to the right of +s, so (s, l, y) is left-handed in world terms;
    // vertex order below is set so faces wind outward in world space
    if (F('l1')) this.quad(c(s0, l1, y0), c(s1, l1, y0), c(s1, l1, y1), c(s0, l1, y1), this.dirW(0, 1, 0), [[s0, y0], [s1, y0], [s1, y1], [s0, y1]]);
    if (F('l0')) this.quad(c(s1, l0, y0), c(s0, l0, y0), c(s0, l0, y1), c(s1, l0, y1), this.dirW(0, -1, 0), [[s1, y0], [s0, y0], [s0, y1], [s1, y1]]);
    if (F('s1')) this.quad(c(s1, l1, y0), c(s1, l0, y0), c(s1, l0, y1), c(s1, l1, y1), this.dirW(1, 0, 0), [[l1, y0], [l0, y0], [l0, y1], [l1, y1]]);
    if (F('s0')) this.quad(c(s0, l0, y0), c(s0, l1, y0), c(s0, l1, y1), c(s0, l0, y1), this.dirW(-1, 0, 0), [[l0, y0], [l1, y0], [l1, y1], [l0, y1]]);
    if (F('y1')) this.quad(c(s0, l0, y1), c(s0, l1, y1), c(s1, l1, y1), c(s1, l0, y1), [0, 1, 0], [[s0, l0], [s0, l1], [s1, l1], [s1, l0]]);
    if (F('y0')) this.quad(c(s0, l1, y0), c(s0, l0, y0), c(s1, l0, y0), c(s1, l1, y0), [0, -1, 0], [[s0, l1], [s0, l0], [s1, l0], [s1, l1]]);
    void ds; void dl; void dy;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    // fix any face whose stored normal disagrees with its winding
    const p = this.pos, n = this.nrm;
    const idx = [];
    for (let i = 0; i < p.length / 3; i += 3) {
      const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
      const ux = p[i * 3 + 3] - ax, uy = p[i * 3 + 4] - ay, uz = p[i * 3 + 5] - az;
      const vx = p[i * 3 + 6] - ax, vy = p[i * 3 + 7] - ay, vz = p[i * 3 + 8] - az;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const ok = cx * n[i * 3] + cy * n[i * 3 + 1] + cz * n[i * 3 + 2] >= 0;
      if (ok) idx.push(i, i + 1, i + 2); else idx.push(i, i + 2, i + 1);
    }
    g.setIndex(idx);
    return g;
  }
}

// thin parts (cables, suspenders) never shrink below ~0.7 px: inflate along the normal
function inflate(mat, radius, shared) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPxWorld = shared.uPxWorld;
    sh.vertexShader = 'uniform float uPxWorld;\n' + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec4 wq = modelMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          vec4 wq = modelMatrix * vec4(position, 1.0);
        #endif
        float dc = length(wq.xyz - cameraPosition);
        float minR = dc * uPxWorld * 0.7;
        transformed += normal * max(minR - ${radius.toFixed(3)}, 0.0);
      }
    `);
  };
  mat.customProgramCacheKey = () => `karl-thin-${radius}`;
  return mat;
}

// art-deco fluting on the tower faces, see-through Warren truss on the deck
function steelMaterial(color, { flutes = false, truss = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.0, side: truss ? THREE.DoubleSide : THREE.FrontSide });
  if (truss) { mat.alphaTest = 0.5; mat.alphaToCoverage = true; }
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec2 vBUv;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvBUv = uv;');
    sh.fragmentShader = 'varying vec2 vBUv;\n' + sh.fragmentShader.replace('#include <color_fragment>', /* glsl */`
      #include <color_fragment>
      ${flutes ? /* glsl */`
        {
          float u = vBUv.x / 1.7;
          float fw = fwidth(u);
          float g = smoothstep(0.42 - fw, 0.42 + fw, abs(fract(u) - 0.5));
          diffuseColor.rgb *= mix(1.0, mix(1.0, 0.72, g), clamp(1.0 - fw * 3.0, 0.0, 1.0));
        }` : ''}
      ${truss ? /* glsl */`
        {
          // panel 7.62 m long, 7.6 m deep: chords, verticals, alternating diagonals
          float pu = vBUv.x / 7.62;
          float v = vBUv.y;
          float pv = clamp(v / 7.6, 0.0, 1.0);
          float fu = fract(pu);
          float odd = mod(floor(pu), 2.0);
          float dd = abs(fu - (odd > 0.5 ? 1.0 - pv : pv)) * 7.62 * 0.7;
          float vert = min(fu, 1.0 - fu) * 7.62;
          float chord = min(v, 7.6 - v);
          float m = min(min(dd, vert * 1.6), chord);
          float w = 0.42;
          float fwm = fwidth(m) + 1e-4;
          float cov = 1.0 - smoothstep(w - fwm, w + fwm, m);
          // far away: the lattice averages to ~55% coverage
          float far = clamp(fwidth(pu) * 2.5, 0.0, 1.0);
          diffuseColor.a = mix(cov, 0.62, far);
          diffuseColor.rgb *= mix(1.0, 0.82, far);
        }` : ''}
    `);
  };
  mat.customProgramCacheKey = () => `karl-steel-${flutes}-${truss}`;
  return mat;
}

// soft round sprites for lamps (additive, HDR so they bloom a little)
export function glowPoints(color, size) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.PointsMaterial({
    color: color.clone().multiplyScalar(4), size, map: tex, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
}

const ORANGE = new THREE.Color().setRGB(0.52, 0.055, 0.022);         // International Orange, linear
const BAY_GRAY = new THREE.Color().setRGB(0.36, 0.38, 0.40);
const CONCRETE = new THREE.Color().setRGB(0.42, 0.40, 0.37);
const SAS_WHITE = new THREE.Color().setRGB(0.62, 0.63, 0.63);

// parabolic main cable between two tower tops (s0..s1), sagging `sag` meters
function cableY(s, s0, s1, y0, y1, sag) {
  const u = (s - s0) / (s1 - s0);
  return y0 + (y1 - y0) * u - 4 * sag * u * (1 - u);
}

function cableGeometry(B, samples, lat) {
  const pts = samples.map(([s, y]) => new THREE.Vector3(...B.P(s, lat, y)));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(16, samples.length * 2), 0.46, 8, false);
}

function suspenders(B, list, lat, radius, mat) {
  // list: [s, yTop, yBottom]
  const geo = new THREE.CylinderGeometry(radius, radius, 1, 6, 1, true);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, mat, list.length * 2);
  const m = new THREE.Matrix4();
  let k = 0;
  for (const [s, yt, yb] of list) {
    for (const l of [-lat, lat]) {
      const p = B.P(s, l, yb);
      m.makeScale(1, Math.max(0.1, yt - yb), 1).setPosition(p[0], p[1], p[2]);
      mesh.setMatrixAt(k++, m);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  return mesh;
}

function goldenGate(ground, shared) {
  const S = W(-122.47789, 37.81401), N = W(-122.47923, 37.82550);
  const L = Math.hypot(N[0] - S[0], N[1] - S[1]);
  const axis = [(N[0] - S[0]) / L, (N[1] - S[1]) / L];
  const steel = new Builder(S, axis), truss = new Builder(S, axis), conc = new Builder(S, axis), road = new Builder(S, axis);
  const towers = new Builder(S, axis);
  const SIDE = 343, LAT = 13.7, TOP = 227, SADDLE = 224;
  const deckY = (s) => 62 + 13 * (1 - ((s - L / 2) / (L / 2 + SIDE)) ** 2);

  // ——— towers ———
  for (const s0 of [0, L]) {
    const steps = [[0, 70, 8.6, 16.2], [70, 104, 8.0, 14.4], [104, 141, 7.4, 12.8], [141, 178, 6.8, 11.4], [178, TOP, 6.2, 10.2]];
    for (const side of [-1, 1]) {
      for (const [y0, y1, wl, ws] of steps) {
        // inner face stays plumb; setbacks happen on the outside
        const inner = LAT - 4.4, outer = inner + wl;
        const l0 = side > 0 ? inner : -outer, l1 = side > 0 ? outer : -inner;
        towers.box(s0 - ws / 2, s0 + ws / 2, l0, l1, y0, y1);
      }
      // cap and saddle housing
      towers.box(s0 - 5.5, s0 + 5.5, side > 0 ? LAT - 4.4 : -LAT - 1.8, side > 0 ? LAT + 1.8 : -LAT + 4.4, TOP, TOP + 2.2);
    }
    // portal struts above the deck (the tower's signature), and the deck portal
    for (const [y0, y1, d] of [[96, 104, 8.6], [133, 141, 7.8], [169, 178, 7.0], [210, TOP, 6.6]]) {
      towers.box(s0 - d / 2, s0 + d / 2, -LAT + 4.4, LAT - 4.4, y0, y1);
    }
    towers.box(s0 - 7.5, s0 + 7.5, -LAT + 4.4, LAT - 4.4, 52, 58);
    // X-bracing below the deck
    for (const [ya, yb] of [[12, 52]]) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        for (const dir of [-1, 1]) {
          const la = -LAT + 4.4 + (2 * LAT - 8.8) * (dir > 0 ? t0 : 1 - t0);
          const lb = -LAT + 4.4 + (2 * LAT - 8.8) * (dir > 0 ? t1 : 1 - t1);
          const y0 = ya + (yb - ya) * t0, y1 = ya + (yb - ya) * t1;
          steel.box(s0 - 1.2, s0 + 1.2, Math.min(la, lb) - 0.6, Math.max(la, lb) + 0.6, y0, y1 + 0.6);
        }
      }
    }
  }
  // south tower fender ring and piers
  {
    const ring = 64;
    for (let i = 0; i < ring; i++) {
      const a0 = (i / ring) * Math.PI * 2, a1 = ((i + 1) / ring) * Math.PI * 2;
      const s0 = Math.cos(a0) * 52, l0 = Math.sin(a0) * 30, s1 = Math.cos(a1) * 52, l1 = Math.sin(a1) * 30;
      const sm = (s0 + s1) / 2, lm = (l0 + l1) / 2;
      const len = Math.hypot(s1 - s0, l1 - l0);
      const ang = Math.atan2(l1 - l0, s1 - s0);
      // approximate each ring segment with a small box rotated in the frame
      const B2 = new Builder(conc.P(sm, lm, 0).filter((_, k) => k !== 1), [
        axis[0] * Math.cos(ang) + conc.b[0] * Math.sin(ang), axis[1] * Math.cos(ang) + conc.b[1] * Math.sin(ang)]);
      B2.box(-len / 2 - 0.3, len / 2 + 0.3, -3, 3, -2, 9);
      conc.pos.push(...B2.pos); conc.nrm.push(...B2.nrm); conc.uv.push(...B2.uv);
    }
    conc.box(-24, 24, -21, 21, -2, 12);
    conc.box(L - 24, L + 24, -21, 21, -2, 12);
  }
  // pylons at the ends of the side spans (concrete, stepped)
  for (const s0 of [-SIDE, L + SIDE]) {
    for (const side of [-1, 1]) {
      const [gx, gz] = [S[0] + axis[0] * s0 + conc.b[0] * side * 15, S[1] + axis[1] * s0 + conc.b[1] * side * 15];
      const g = Math.max(0, ground(gx, gz));
      conc.box(s0 - 6, s0 + 6, side * 15 - 4.5, side * 15 + 4.5, g - 2, deckY(s0) + 12);
      conc.box(s0 - 4.5, s0 + 4.5, side * 15 - 3.4, side * 15 + 3.4, deckY(s0) + 12, deckY(s0) + 22);
    }
  }

  // ——— deck: roadway slab, sidewalks, stiffening trusses, underside ———
  const s0d = -SIDE - 110, s1d = L + SIDE + 60;
  const step = 15.24;
  for (let s = s0d; s < s1d; s += step) {
    const sa = s, sb = Math.min(s + step, s1d);
    const ya = deckY(Math.max(-SIDE, Math.min(L + SIDE, sa))), yb = deckY(Math.max(-SIDE, Math.min(L + SIDE, sb)));
    const y = (ya + yb) / 2;
    road.box(sa, sb, -LAT - 1.6, LAT + 1.6, y - 0.9, y, ['y1', 'y0']);
    // trusses: two vertical lattice panels under the deck edges
    truss.box(sa, sb, -LAT - 0.4, -LAT + 0.4, y - 7.6, y, ['l0', 'l1']);
    truss.box(sa, sb, LAT - 0.4, LAT + 0.4, y - 7.6, y, ['l0', 'l1']);
    // floor beams and lateral bracing read as a darker underside
    steel.box(sa, sb, -LAT, LAT, y - 7.6, y - 7.0, ['y0']);
    // railings
    steel.box(sa, sb, -LAT - 1.6, -LAT - 1.35, y, y + 1.3, ['l0', 'l1', 'y1']);
    steel.box(sa, sb, LAT + 1.35, LAT + 1.6, y, y + 1.3, ['l0', 'l1', 'y1']);
  }
  // fix truss uv: v measured from the bottom chord
  {
    const p = truss.pos, uv = truss.uv;
    for (let i = 0; i < uv.length / 2; i++) {
      const sLocal = uv[i * 2];
      const y = p[i * 3 + 1];
      uv[i * 2 + 1] = y - (deckY(Math.max(-SIDE, Math.min(L + SIDE, sLocal))) - 7.6);
    }
  }
  // Fort Point arch under the south approach (span ~98 m)
  {
    const a0 = -SIDE - 98, a1 = -SIDE;
    const [gx, gz] = [S[0] + axis[0] * (a0 + a1) / 2, S[1] + axis[1] * (a0 + a1) / 2];
    const g = Math.max(4, ground(gx, gz));
    const crown = deckY(-SIDE) - 9;
    const n = 16;
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const u0 = i / n, u1 = (i + 1) / n;
        const y0 = g + (crown - g) * Math.sin(u0 * Math.PI), y1 = g + (crown - g) * Math.sin(u1 * Math.PI);
        steel.box(a0 + (a1 - a0) * u0, a0 + (a1 - a0) * u1, side * LAT - 1, side * LAT + 1, Math.min(y0, y1) - 1.6, Math.max(y0, y1) + 1.6);
        if (i % 2 === 0 && i > 0) steel.box(a0 + (a1 - a0) * u0 - 0.5, a0 + (a1 - a0) * u0 + 0.5, side * LAT - 0.6, side * LAT + 0.6, y0, crown + 1);
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'golden-gate';
  const steelMat = steelMaterial(ORANGE, { flutes: true });
  // the towers are floodlit at night
  const towerMat = steelMaterial(ORANGE, { flutes: true });
  towerMat.emissive = new THREE.Color(0.95, 0.38, 0.14);
  towerMat.emissiveIntensity = 0;
  const trussMat = steelMaterial(ORANGE, { truss: true });
  const concMat = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9 });
  const roadMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.07, 0.07, 0.075), roughness: 0.85 });
  for (const [b, m] of [[steel, steelMat], [towers, towerMat], [truss, trussMat], [conc, concMat], [road, roadMat]]) {
    const mesh = new THREE.Mesh(b.geometry(), m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ——— main cables and suspenders ———
  const cableMat = inflate(new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.55 }), 0.46, shared);
  const suspMat = inflate(new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.6 }), 0.035, shared);
  const SAG = 144;
  const anchorY = deckY(-SIDE) + 3;
  for (const lat of [-LAT, LAT]) {
    const main = [], sideS = [], sideN = [];
    for (let i = 0; i <= 64; i++) { const s = (i / 64) * L; main.push([s, cableY(s, 0, L, SADDLE, SADDLE, SAG)]); }
    for (let i = 0; i <= 16; i++) {
      const s = -SIDE + (i / 16) * SIDE; sideS.push([s, cableY(s, -SIDE, 0, anchorY, SADDLE, 14)]);
      const s2 = L + (i / 16) * SIDE; sideN.push([s2, cableY(s2, L, L + SIDE, SADDLE, anchorY, 14)]);
    }
    for (const samples of [main, sideS, sideN]) {
      const m = new THREE.Mesh(cableGeometry(steel, samples, lat), cableMat);
      m.castShadow = true;
      group.add(m);
    }
  }
  const list = [];
  for (let s = step; s < L - 4; s += step) list.push([s, cableY(s, 0, L, SADDLE, SADDLE, SAG), deckY(s)]);
  for (let s = -step; s > -SIDE + 6; s -= step) list.push([s, cableY(s, -SIDE, 0, anchorY, SADDLE, 14), deckY(s)]);
  for (let s = L + step; s < L + SIDE - 6; s += step) list.push([s, cableY(s, L, L + SIDE, SADDLE, anchorY, 14), deckY(s)]);
  group.add(suspenders(steel, list.filter((e) => e[1] - e[2] > 1), LAT, 0.035, suspMat));

  // night: roadway lamps along both rails, red aviation lights on the towers
  const lamps = [], red = [];
  for (let s = -SIDE; s <= L + SIDE; s += 30) for (const l of [-LAT - 1.2, LAT + 1.2]) lamps.push(...steel.P(s, l, deckY(s) + 7));
  for (const s0 of [0, L]) for (const l of [-LAT, LAT]) red.push(...steel.P(s0, l, TOP + 3));
  const lampMat = glowPoints(new THREE.Color(1.0, 0.78, 0.5), 9);
  const redMat = glowPoints(new THREE.Color(1.0, 0.12, 0.06), 10);
  const lampPts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3)), lampMat);
  const redPts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(red, 3)), redMat);
  lampPts.frustumCulled = redPts.frustumCulled = false;
  group.add(lampPts, redPts);
  const night = (k) => {
    towerMat.emissiveIntensity = 0.22 * k;
    lampMat.opacity = k;
    redMat.opacity = k;
  };
  return { group, night, frame: { S, N, axis, L, deckY } };
}

function bayBridge(ground, shared) {
  // surveyed supports: W1 (SF), W2, W3 towers, W4 center anchorage, W5, W6 towers, YBI anchorage
  const P = [[-122.38845, 37.78830], [-122.38582, 37.79075], [-122.38065, 37.79559], [-122.37786, 37.79819],
    [-122.37508, 37.80079], [-122.36990, 37.80562], [-122.36714, 37.80820]].map(([lo, la]) => W(lo, la));
  const A = P[0], Z = P[6];
  const Lt = Math.hypot(Z[0] - A[0], Z[1] - A[1]);
  const axis = [(Z[0] - A[0]) / Lt, (Z[1] - A[1]) / Lt];
  const st = P.map((p) => (p[0] - A[0]) * axis[0] + (p[1] - A[1]) * axis[1]);
  const steel = new Builder(A, axis), truss = new Builder(A, axis), conc = new Builder(A, axis);
  const LAT = 9.5, TOP = 160, deck = (s) => 52 + 8 * Math.sin(Math.PI * Math.max(0, Math.min(1, s / Lt)));
  // towers: two legs with X-bracing
  for (const k of [1, 2, 4, 5]) {
    const s0 = st[k];
    for (const side of [-1, 1]) steel.box(s0 - 3.2, s0 + 3.2, side * LAT - 2.4, side * LAT + 2.4, 0, TOP);
    for (let y = 20; y < TOP - 10; y += 26) {
      for (let i = 0; i < 8; i++) {
        const t0 = i / 8, t1 = (i + 1) / 8;
        for (const dir of [-1, 1]) {
          const la = -LAT + 2 * LAT * (dir > 0 ? t0 : 1 - t0), lb = -LAT + 2 * LAT * (dir > 0 ? t1 : 1 - t1);
          steel.box(s0 - 0.8, s0 + 0.8, Math.min(la, lb) - 0.5, Math.max(la, lb) + 0.5, y + 24 * t0, y + 24 * t1 + 0.5);
        }
      }
      steel.box(s0 - 1.4, s0 + 1.4, -LAT, LAT, y + 23, y + 25);
    }
    conc.box(s0 - 14, s0 + 14, -LAT - 5, LAT + 5, -2, 8);
  }
  // center anchorage and the shore anchorages
  conc.box(st[3] - 26, st[3] + 26, -LAT - 6, LAT + 6, -2, 67);
  conc.box(st[0] - 18, st[0] + 18, -LAT - 4, LAT + 4, Math.max(-2, ground(A[0], A[1])) - 2, deck(st[0]) - 4);
  // double-deck truss
  for (let s = st[0] - 20; s < Lt + 20; s += 12) {
    const y = deck(s);
    truss.box(s, s + 12, -LAT - 0.4, -LAT + 0.4, y - 10, y, ['l0', 'l1']);
    truss.box(s, s + 12, LAT - 0.4, LAT + 0.4, y - 10, y, ['l0', 'l1']);
    conc.box(s, s + 12, -LAT - 0.5, LAT + 0.5, y - 0.8, y, ['y1', 'y0']);
    conc.box(s, s + 12, -LAT + 0.5, LAT - 0.5, y - 9.2, y - 8.6, ['y1', 'y0']);
  }
  {
    const p = truss.pos, uv = truss.uv;
    for (let i = 0; i < uv.length / 2; i++) uv[i * 2 + 1] = (p[i * 3 + 1] - (deck(uv[i * 2]) - 10)) * 0.76;
  }
  const group = new THREE.Group();
  group.name = 'bay-bridge';
  const steelMat = steelMaterial(BAY_GRAY);
  const trussMat = steelMaterial(BAY_GRAY, { truss: true });
  const concMat = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9 });
  for (const [b, m] of [[steel, steelMat], [truss, trussMat], [conc, concMat]]) {
    const mesh = new THREE.Mesh(b.geometry(), m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  }
  const cableMat = inflate(new THREE.MeshStandardMaterial({ color: BAY_GRAY, roughness: 0.5 }), 0.4, shared);
  const suspMat = inflate(new THREE.MeshStandardMaterial({ color: BAY_GRAY, roughness: 0.6 }), 0.03, shared);
  const list = [];
  const spans = [[0, 1, 18], [1, 2, 78], [2, 3, 18], [3, 4, 18], [4, 5, 78], [5, 6, 18]];
  for (const lat of [-LAT, LAT]) {
    for (const [i, j, sag] of spans) {
      const ya = (i === 0 || i === 3) ? (i === 3 ? 66 : deck(st[i]) + 4) : TOP - 2;
      const yb = (j === 3 || j === 6) ? (j === 3 ? 66 : deck(st[j]) + 4) : TOP - 2;
      const samples = [];
      for (let k = 0; k <= 32; k++) { const s = st[i] + (st[j] - st[i]) * (k / 32); samples.push([s, cableY(s, st[i], st[j], ya, yb, sag)]); }
      const m = new THREE.Mesh(cableGeometry(steel, samples, lat), cableMat);
      m.castShadow = true;
      group.add(m);
      if (lat > 0) {
        for (let s = st[i] + 15; s < st[j] - 10; s += 15) list.push([s, cableY(s, st[i], st[j], ya, yb, sag), deck(s)]);
      }
    }
  }
  group.add(suspenders(steel, list.filter((e) => e[1] - e[2] > 1), LAT, 0.03, suspMat));

  // the east span's self-anchored suspension tower (white) and the skyway toward Oakland
  {
    const T = W(-122.35851, 37.81527), E = W(-122.3303, 37.82128);
    const L2 = Math.hypot(E[0] - T[0], E[1] - T[1]);
    const ax2 = [(E[0] - T[0]) / L2, (E[1] - T[1]) / L2];
    const w = new Builder(T, ax2), c2 = new Builder(T, ax2);
    for (const [ls, le] of [[-6, -2], [2, 6]]) for (const [ss, se] of [[-4, -1], [1, 4]]) w.box(ss, se, ls, le, 0, 160);
    for (let y = 40; y < 160; y += 30) w.box(-4, 4, -6, 6, y, y + 3);
    const dk = (s) => 48 - 26 * Math.max(0, Math.min(1, (s - 400) / (L2 - 400)));
    for (let s = -180; s < L2; s += 14) {
      c2.box(s, s + 14, -26, -2, dk(s) - 4, dk(s), ['y1', 'y0', 'l0', 'l1']);
      c2.box(s, s + 14, 2, 26, dk(s) - 4, dk(s), ['y1', 'y0', 'l0', 'l1']);
      if (Math.round(s / 14) % 12 === 0 && s > 300) for (const l of [-14, 14]) c2.box(s, s + 4, l - 3, l + 3, -2, dk(s) - 4);
    }
    const whiteMat = new THREE.MeshStandardMaterial({ color: SAS_WHITE, roughness: 0.55 });
    for (const [b, m] of [[w, whiteMat], [c2, concMat]]) {
      const mesh = new THREE.Mesh(b.geometry(), m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    }
    const sasCable = inflate(new THREE.MeshStandardMaterial({ color: SAS_WHITE, roughness: 0.5 }), 0.4, shared);
    for (const l of [-4, 4]) {
      const samples = [];
      for (let k = 0; k <= 24; k++) { const s = -180 + (565) * (k / 24); samples.push([s, s < 0 ? 158 + (s / 180) * 108 : cableY(s, 0, 385, 158, 50, 40)]); }
      group.add(new THREE.Mesh(cableGeometry(w, samples, l), sasCable));
    }
  }
  return { group };
}

export class Bridges {
  constructor(scene, ground) {
    this.shared = { uPxWorld: { value: 0.001 } };
    const gg = goldenGate(ground, this.shared);
    const bb = bayBridge(ground, this.shared);
    this.group = new THREE.Group();
    this.group.add(gg.group, bb.group);
    scene.add(this.group);
    this.goldenGate = gg.frame;
    this._night = gg.night;
  }

  update(camera, viewportHeight, nightK = 0) {
    this.shared.uPxWorld.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    this._night(nightK);
  }
}
