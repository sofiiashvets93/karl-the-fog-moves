// Builds the modeled fog extent for every forecast hour (in a worker) and
// stores it as a 3D texture: x, z, and time. The shader blends between hours
// with trilinear filtering, so scrubbing the timeline is smooth.

import * as THREE from 'three';
import { NEAR_M, W } from './geo.js';
import { POINTS } from './weather.js';

export const DOMAIN = {
  x0: NEAR_M.x0 - 30000, z0: NEAR_M.z0 - 12000,
  w: NEAR_M.w + 42000, d: NEAR_M.d + 22000,
};
const CELL = 250;
const GATE_X = W(-122.4785, 37.8199)[0];   // the Golden Gate strait

export class FogField {
  constructor(ground) {
    this.nx = Math.round(DOMAIN.w / CELL);
    this.nz = Math.round(DOMAIN.d / CELL);
    this.cell = CELL;
    // highest ground in each cell (fog cannot flow through a ridge between samples)
    const elev = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        let m = -Infinity;
        for (let b = 0; b < 3; b++) {
          for (let a = 0; a < 3; a++) {
            m = Math.max(m, ground(DOMAIN.x0 + (i + (a + 0.5) / 3) * CELL, DOMAIN.z0 + (j + (b + 0.5) / 3) * CELL));
          }
        }
        elev[j * this.nx + i] = m;
      }
    }
    this.elev = elev;
    this.texture = null;
    this.t0 = 0;
    this.nHours = 0;
    this.version = 0;
  }

  // fields for the hours the timeline can show (plus one on each side)
  build(weather, span) {
    let src = weather.hours;
    if (span) {
      const a = Math.max(0, src.findIndex((h) => h.t >= span.t0) - 1);
      let b = src.findIndex((h) => h.t > span.t1);
      b = b < 0 ? src.length : Math.min(src.length, b + 1);
      src = src.slice(a, b);
    }
    const hours = src.map((h) => ({
      low: h.low, top: h.top, base: h.base, windX: h.windX, windZ: h.windZ,
      heat: h.heat, reach: h.reach, source: h.source, dens: h.dens,
    }));
    const worker = new Worker(new URL('./workers/fogfield-worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        worker.terminate();
        const tex = new THREE.Data3DTexture(e.data.data, this.nx, this.nz, hours.length);
        tex.format = THREE.RGBAFormat;
        tex.type = THREE.UnsignedByteType;
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        if (this.texture) this.texture.dispose();
        this.texture = tex;
        this.data = e.data.data;
        this.t0 = src[0].t;
        this.nHours = hours.length;
        this.version++;
        resolve(this);
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'fog worker failed')); };
      worker.postMessage({
        elev: this.elev, nx: this.nx, nz: this.nz, cell: CELL, x0: DOMAIN.x0, z0: DOMAIN.z0,
        hours, points: POINTS.map((p) => ({ x: p.x, z: p.z })), gateX: GATE_X,
      });
    });
  }

  // texture w-coordinate for a time
  w(ms) {
    if (!this.nHours) return 0;
    const h = Math.max(0, Math.min(this.nHours - 1, (ms - this.t0) / 3600e3));
    return (h + 0.5) / this.nHours;
  }

  // modeled coverage (0..1) at a world point and time, for readouts
  coverageAt(x, z, ms) {
    if (!this.data) return 0;
    const i = Math.floor((x - DOMAIN.x0) / CELL), j = Math.floor((z - DOMAIN.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    const h = Math.max(0, Math.min(this.nHours - 1, Math.round((ms - this.t0) / 3600e3)));
    return this.data[(h * this.nx * this.nz + j * this.nx + i) * 4] / 255;
  }
}

// tileable 3D noise: R = soft fbm (layer undulation), G = billowy fbm, B = fine detail
export function noiseVolume(S = 64) {
  const hash = (x, y, z, s) => {
    x = ((x % s) + s) % s; y = ((y % s) + s) % s; z = ((z % s) + s) % s;
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y, z, s) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const L = (a, b, t) => a + (b - a) * t;
    return L(
      L(L(hash(ix, iy, iz, s), hash(ix + 1, iy, iz, s), fx), L(hash(ix, iy + 1, iz, s), hash(ix + 1, iy + 1, iz, s), fx), fy),
      L(L(hash(ix, iy, iz + 1, s), hash(ix + 1, iy, iz + 1, s), fx), L(hash(ix, iy + 1, iz + 1, s), hash(ix + 1, iy + 1, iz + 1, s), fx), fy),
      fz);
  };
  const fbm = (x, y, z, base, oct) => {
    let s = 0, a = 0.5, f = base, n = 0;
    for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, y * f, z * f, f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  };
  const data = new Uint8Array(S * S * S * 4);
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, w = z / S;
        const r = fbm(u, v, w, 4, 3);
        const g0 = fbm(u, v, w, 8, 4);
        const g = 1 - Math.abs(g0 * 2 - 1);           // ridged: billows
        const b = fbm(u, v, w, 16, 3);
        const i = ((z * S + y) * S + x) * 4;
        data[i] = r * 255; data[i + 1] = Math.pow(g, 0.8) * 255; data[i + 2] = b * 255; data[i + 3] = 255;
      }
    }
  }
  // equalize R so that "coverage c" selects the top c of the volume:
  // a patch threshold of (1 - c) then covers about c of the area
  {
    const n = S * S * S;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) r[i] = data[i * 4] + ((i * 2654435761) >>> 0) / 4294967296 * 0.999; // break ties
    idx.sort((a, b) => r[a] - r[b]);
    for (let k = 0; k < n; k++) data[idx[k] * 4] = Math.round((k / (n - 1)) * 255);
  }
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
