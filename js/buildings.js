// San Francisco's buildings: real footprints and heights (OpenStreetMap via
// Overture Maps), extruded in a worker, shaded with procedural facades.

import * as THREE from 'three';

const FACADE_PARS = /* glsl */`
  varying vec2 vWall;      // u along the perimeter, v above the base (m)
  varying vec4 vInfo;      // kind, variant, roof luminance, height/2
  varying vec3 vWPos;
  uniform float uNightK;
  uniform float uLitHour;  // 0..1 share of windows still lit
  float bHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 pick(float k, vec3 a, vec3 b, vec3 c, vec3 d) {
    return k < 0.25 ? a : k < 0.5 ? b : k < 0.75 ? c : d;
  }
`;

function facadeMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
  mat.userData.uniforms = { uNightK: { value: 0 }, uLitHour: { value: 0.5 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mat.userData.uniforms);
    sh.vertexShader = /* glsl */`
      attribute vec2 aWall;
      attribute vec4 aInfo;
      varying vec2 vWall;
      varying vec4 vInfo;
      varying vec3 vWPos;
    ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vWall = aWall / 20.0;
      vInfo = aInfo;
      vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `);
    sh.fragmentShader = FACADE_PARS + sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        // all derivatives first: they must not sit inside divergent branches
        vec3 fN = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
        float kind = floor(vInfo.x + 0.5);
        float variant = vInfo.y / 255.0;
        float bh = vInfo.w * 2.0;
        float isRoof = step(0.6, fN.y);
        float glassTower = (kind > 1.5 && kind < 2.5 && bh > 45.0) ? 1.0 : 0.0;
        float floorH = kind < 1.5 ? 3.1 : kind < 2.5 ? 3.9 : kind < 3.5 ? 5.5 : 4.4;
        float cellW = kind < 1.5 ? 2.8 + 0.6 * fract(variant * 5.0) : kind < 2.5 ? 2.4 : kind < 3.5 ? 6.0 : 3.4;
        vec2 wf = kind < 1.5 ? vec2(0.46, 0.52) : kind < 2.5 ? vec2(0.62, 0.56) : kind < 3.5 ? vec2(0.3, 0.26) : vec2(0.42, 0.6);
        if (glassTower > 0.5) { cellW = 1.55; floorH = 4.0; wf = vec2(0.88, 0.74); }
        if (kind > 4.5) wf = vec2(0.0);
        vec2 cell = vec2(vWall.x / cellW, (vWall.y - 0.6) / floorH);
        vec2 fw = fwidth(cell);
        float aa = clamp(1.0 - max(fw.x, fw.y) * 2.2, 0.0, 1.0);
        vec2 f = fract(cell);
        vec2 hw = wf * 0.5;
        vec2 e = max(fw * 0.75, vec2(0.001));
        float wx = smoothstep(0.5 - hw.x - e.x, 0.5 - hw.x + e.x, f.x) * (1.0 - smoothstep(0.5 + hw.x - e.x, 0.5 + hw.x + e.x, f.x));
        float wy = smoothstep(0.5 - hw.y - e.y, 0.5 - hw.y + e.y, f.y) * (1.0 - smoothstep(0.5 + hw.y - e.y, 0.5 + hw.y + e.y, f.y));
        float above = step(0.6, vWall.y) * step(vWall.y, bh - 1.2);
        float winMask = mix(wf.x * wf.y, wx * wy, aa) * above * (1.0 - isRoof);
        float h = bHash(floor(cell) + vec2(variant * 113.0, kind * 7.0));
        // windows are lit in sections (a few windows across a floor); further out
        // the sections merge into larger clusters, like mip levels of the same
        // pattern, so the lights stay visible as specks instead of averaging
        // into a flat glowing wall. Some buildings are mostly dark.
        float bShare = 0.2 + 0.8 * fract(variant * 17.31);
        float litK = (kind < 1.5 ? 0.32 : kind < 2.5 ? 0.42 : kind < 3.5 ? 0.1 : 0.25) * uLitHour * bShare;
        vec2 sec = cell / (kind < 1.5 ? vec2(2.0, 1.0) : vec2(3.0, 1.0));
        vec2 fwS = fwidth(sec);
        float lodR = log2(max(max(fwS.x, fwS.y), 1e-4) * 2.0);
        float lod = clamp(lodR, 0.0, 4.0);
        float l0 = floor(lod), lf = lod - l0;
        vec2 sd = vec2(variant * 57.0 + l0 * 13.0, kind * 3.0 + 0.5);
        float hs0 = bHash(floor(sec / exp2(l0)) + sd);
        float hs1 = bHash(floor(sec / exp2(l0 + 1.0)) + sd + 13.0);
        // lit sections differ in brightness too (lamps, blinds, distance from the glass)
        float on0 = step(hs0, litK) * (0.45 + 0.55 * fract(hs0 * 7.31 + variant));
        float on1 = step(hs1, litK) * (0.45 + 0.55 * fract(hs1 * 7.31 + variant));
        float lit = winMask * mix(mix(on0, on1, lf) * mix(0.8, step(h, 0.8), aa), litK * 0.58, smoothstep(4.0, 5.0, lodR));
        vec3 litCol = kind > 1.5 && kind < 2.5 ? vec3(0.9, 0.92, 0.95) : vec3(1.0, 0.72, 0.42);

        // facade palettes (linear albedo), mostly the light stucco San Francisco is known for
        float k2 = fract(variant * 3.7);
        vec3 wallC;
        if (kind < 1.5) {
          wallC = k2 < 0.55
            ? pick(fract(variant * 11.0), vec3(0.62, 0.60, 0.56), vec3(0.56, 0.54, 0.50), vec3(0.66, 0.64, 0.60), vec3(0.52, 0.52, 0.52))
            : pick(fract(variant * 13.0), vec3(0.50, 0.53, 0.56), vec3(0.58, 0.55, 0.42), vec3(0.46, 0.50, 0.44), vec3(0.58, 0.47, 0.40));
        } else if (kind < 2.5) {
          wallC = pick(k2, vec3(0.46, 0.45, 0.43), vec3(0.54, 0.50, 0.44), vec3(0.60, 0.60, 0.58), vec3(0.24, 0.24, 0.25));
        } else if (kind < 3.5) {
          wallC = pick(k2, vec3(0.40, 0.39, 0.37), vec3(0.48, 0.45, 0.40), vec3(0.33, 0.35, 0.37), vec3(0.52, 0.50, 0.47));
        } else if (kind < 4.5) {
          wallC = pick(k2, vec3(0.55, 0.50, 0.42), vec3(0.34, 0.20, 0.15), vec3(0.58, 0.56, 0.52), vec3(0.46, 0.42, 0.36));
        } else {
          wallC = vec3(0.30, 0.29, 0.27);
        }
        // grime toward the street, a lighter cornice line at the top
        wallC *= mix(0.78, 1.0, smoothstep(0.0, 5.0, vWall.y));
        wallC *= 1.0 + 0.12 * smoothstep(bh - 1.0, bh - 0.4, vWall.y);
        vec3 glass = glassTower > 0.5 ? vec3(0.035, 0.05, 0.06) : vec3(0.03, 0.035, 0.04);
        wallC = mix(wallC, glass, winMask);

        float lum = vInfo.z / 1000.0;
        vec3 sat = vec3(lum * 1.04, lum, lum * 0.93);
        vec3 tar = pick(fract(variant * 7.13), vec3(0.16, 0.16, 0.15), vec3(0.24, 0.23, 0.21), vec3(0.32, 0.31, 0.29), vec3(0.45, 0.45, 0.44));
        vec3 roofC = mix(tar, clamp(sat * 1.6, 0.05, 0.7), bh > 30.0 ? 0.25 : 0.5);
        roofC *= 0.92 + 0.16 * bHash(floor(vWPos.xz * 0.5));

        diffuseColor.rgb = mix(wallC, roofC, isRoof);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = mix(mix(0.82, glassTower > 0.5 ? 0.06 : 0.12, winMask), 0.92, isRoof);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        totalEmissiveRadiance += litCol * lit * uNightK * 0.3;
      `);
  };
  mat.customProgramCacheKey = () => 'karl-facade';
  return mat;
}

export class Buildings {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    scene.add(this.group);
    this.material = facadeMaterial();
    this.tiles = [];
    this.ready = false;
    this.lodBias = 1;
    this._p = new THREE.Vector3();
  }

  async load(buffer) {
    const worker = new Worker(new URL('./workers/buildings-worker.js', import.meta.url), { type: 'module' });
    const res = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
      worker.onerror = (e) => reject(new Error(e.message || 'buildings worker failed'));
      worker.postMessage({ buffer }, [buffer]);
    });
    worker.terminate();
    const inv = 1 / res.Q;
    for (const t of res.tiles) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(t.nrm, 4, true));
      g.setAttribute('aWall', new THREE.BufferAttribute(t.wall, 2));
      g.setAttribute('aInfo', new THREE.BufferAttribute(t.info, 4));
      g.setIndex(new THREE.BufferAttribute(t.idx, 1));
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, t.minY * res.Q, 0), new THREE.Vector3(t.w * res.Q, t.maxY * res.Q, t.d * res.Q));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, this.material);
      m.position.set(t.ox, 0, t.oz);
      m.scale.setScalar(inv);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      this.tiles.push({
        mesh: m, lodCounts: t.lodCounts,
        box: new THREE.Box3(new THREE.Vector3(t.ox, t.minY, t.oz), new THREE.Vector3(t.ox + t.w, t.maxY, t.oz + t.d)),
      });
    }
    this.count = res.count;
    this.hgrid = res.hgrid;
    this.ready = true;
  }

  // highest roof near a point (coarse), or -Infinity
  roofAt(x, z) {
    const g = this.hgrid;
    if (!g) return -Infinity;
    const i = Math.floor(((x - g.x0) / g.w) * g.n), j = Math.floor(((z - g.z0) / g.d) * g.n);
    let m = -Infinity;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < g.n && jj < g.n) m = Math.max(m, g.data[jj * g.n + ii]);
    }
    return m;
  }

  // distance LOD: far tiles only draw their taller buildings (sorted first)
  update(camera, { nightK = 0, litHour = 0.5 } = {}) {
    const u = this.material.userData.uniforms;
    u.uNightK.value = nightK;
    u.uLitHour.value = litHour;
    const cp = camera.position;
    const b = this.lodBias;
    for (const t of this.tiles) {
      t.box.clampPoint(cp, this._p);
      const d = this._p.distanceTo(cp) / b;
      const L = d < 6000 ? 0 : d < 11000 ? 1 : d < 18000 ? 2 : 3;
      t.mesh.geometry.setDrawRange(0, t.lodCounts[L]);
      t.mesh.visible = t.lodCounts[L] > 0;
    }
  }
}
