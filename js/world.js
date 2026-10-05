// Assembles the city: terrain, water, buildings, trees, bridges, landmarks.

import * as THREE from 'three';
import { NEAR_M, FAR_M, Heightfield, makeGround } from './geo.js';
import { Terrain } from './terrain.js';
import { Water } from './water.js';
import { Buildings } from './buildings.js';
import { Trees } from './trees.js';
import { Bridges } from './bridges.js';
import { Landmarks } from './landmarks.js';

export class World {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
  }

  async load(assets, { lite = false } = {}) {
    const [nearH, farH, nearBmp, farBmp] = await Promise.all([
      assets.heights('terrain-near.png', 2.7e6),
      assets.heights('terrain-far.png', 1.35e6),
      assets.bitmap(lite ? 'ground-near-2k.webp' : 'ground-near.webp', lite ? 0.45e6 : 1.0e6),
      assets.bitmap('ground-far.webp', 0.23e6),
    ]);
    this.near = new Heightfield(nearH.data, nearH.w, nearH.h, NEAR_M);
    this.far = new Heightfield(farH.data, farH.w, farH.h, FAR_M);
    this.ground = makeGround(this.near, this.far);
    this.terrain = new Terrain(this.renderer, this.scene, this.near, this.far, nearBmp, farBmp);

    this.bridges = new Bridges(this.scene, this.ground);
    // without the footprints, only Sutro Tower (which needs none) is built
    const lm = await assets.json('landmarks.json', 2e3).catch(() => null);
    this.landmarks = new Landmarks(this.scene, this.ground, lm);

    // buildings and trees stream in after the terrain is up
    this.buildings = new Buildings(this.scene);
    this.trees = new Trees(this.scene);
    const bBuf = assets.gz('buildings.bin.gz', 4.1e6).then((b) => this.buildings.load(b));
    const tBuf = assets.gz('trees.bin.gz', 1.6e6).then((b) => this.trees.load(b, this.ground));
    await Promise.all([bBuf, tBuf]);
    this.glow = this._glowTexture();
    for (const u of [this.terrain.uniformsNear, this.terrain.uniformsFar]) {
      u.tGlow.value = this.glow;
      u.uGlowRect.value.copy(this.glowRect);
    }
    // ground + roofs, for camera collision
    this.solid = (x, z) => Math.max(this.ground(x, z), this.buildings.roofAt(x, z));
    return this;
  }

  attachSky(sky) {
    const gate = this.bridges.goldenGate;
    this.water = new Water(this.scene, this.terrain, sky.skyRT.texture, gate.S[0]);
  }

  // city light under the fog at night: building density, brighter where
  // taller, and the Golden Gate's roadway lamps; spread out, since light
  // diffuses through the layer over a kilometer or so
  _glowTexture() {
    const g = this.buildings.hgrid;
    const N = 64, k = g.n / N;
    const v = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) {
          const h = g.data[(j * k + b) * g.n + i * k + a];
          if (h > -999) {
            const x = g.x0 + ((i * k + a + 0.5) / g.n) * g.w, z = g.z0 + ((j * k + b + 0.5) / g.n) * g.d;
            s += 0.55 + 0.45 * Math.min(1, Math.max(0, h - this.ground(x, z)) / 70);
          }
        }
        v[j * N + i] = Math.min(1, (s / (k * k)) * 1.4);
      }
    }
    const f = this.bridges.goldenGate;
    for (let s = -340; s <= f.L + 340; s += 40) {
      const i = Math.floor(((f.S[0] + f.axis[0] * s) - g.x0) / g.w * N);
      const j = Math.floor(((f.S[1] + f.axis[1] * s) - g.z0) / g.d * N);
      if (i >= 0 && j >= 0 && i < N && j < N) v[j * N + i] = Math.max(v[j * N + i], 0.6);
    }
    const blur = v.slice(), tmp = new Float32Array(N * N), K = [1, 4, 6, 4, 1];
    for (let pass = 0; pass < 2; pass++) {
      for (const [from, to, dx, dy] of [[blur, tmp, 1, 0], [tmp, blur, 0, 1]]) {
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            let a = 0, w = 0;
            for (let o = -2; o <= 2; o++) {
              const ii = i + o * dx, jj = j + o * dy;
              if (ii >= 0 && jj >= 0 && ii < N && jj < N) { a += from[jj * N + ii] * K[o + 2]; w += K[o + 2]; }
            }
            to[j * N + i] = a / w;
          }
        }
      }
    }
    const data = new Uint8Array(N * N * 4);
    for (let n = 0; n < N * N; n++) {
      data[n * 4] = Math.round(Math.min(1, 0.55 * v[n] + 0.8 * blur[n]) * 255);
      data[n * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(data, N, N);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    this.glowRect = new THREE.Vector4(g.x0, g.z0, g.w, g.d);
    return t;
  }

  obstacles() {
    const f = this.bridges.goldenGate;
    const out = [];
    for (const s of [0, f.L]) {
      out.push({ x: f.S[0] + f.axis[0] * s, z: f.S[1] + f.axis[1] * s, r: 70, top: 232 });
    }
    return out.concat(this.landmarks.obstacles);
  }
}
