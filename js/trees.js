// Trees as lit sphere impostors: one camera-facing quad per crown, shaded as a
// lumpy sphere, casting and receiving sun shadows. Positions come from
// OpenStreetMap trees and Sentinel-2 canopy (tools/bake/trees.py).

import * as THREE from 'three';
import { NEAR_M } from './geo.js';

const GRID = 8; // spatial tiles for culling and distance thinning

const vert = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>
  attribute vec3 iPos;     // x, ground y, z
  attribute vec4 iShape;   // height, crown radius, kind, tone
  uniform float uThin;     // 0..1 share of instances kept (distance thinning)
  uniform float uGrow;     // crowns grow slightly as thinning removes neighbors
  varying vec2 vQ;
  varying vec4 vShape;
  varying vec3 vWorld;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vFwd;
  void main() {
    float r = iShape.y * uGrow;
    float h = iShape.x;
    vec3 c = iPos + vec3(0.0, max(h - r * 0.95, r * 0.8), 0.0);
    vec3 fwd = normalize(cameraPosition - c);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd + vec3(0.0, 0.0, 1e-4)));
    vec3 up = cross(fwd, right);
    // squash conifers into a taller ellipsoid, eucalyptus a little narrower
    float vs = iShape.z > 0.5 && iShape.z < 1.5 ? 1.35 : 1.0;
    vec3 p = c + right * position.x * r + up * position.y * r * mix(1.0, vs, abs(up.y));
    p += fwd * r * 0.5;   // pull toward the camera so crowns don't sink into roofs
    vQ = position.xy;
    vShape = iShape;
    vRight = right; vUp = up; vFwd = fwd;
    vWorld = c;
    vec4 worldPosition = vec4(p, 1.0);
    vec3 transformedNormal = (viewMatrix * vec4(fwd, 0.0)).xyz;
    #include <shadowmap_vertex>
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const frag = /* glsl */`
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform float uSunI;
  uniform vec3 uAmb;
  uniform vec3 uAmbGround;
  varying vec2 vQ;
  varying vec4 vShape;
  varying vec3 vWorld;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vFwd;
  float th(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tn(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(th(i), th(i + vec2(1, 0)), f.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float tone = vShape.w / 255.0;
    vec2 q = vQ;
    float ang = atan(q.y, q.x);
    float rr = length(q);
    // irregular silhouette: a few lobes plus fine leafy noise
    float edge = 0.86 + 0.09 * sin(ang * 5.0 + tone * 40.0) + 0.06 * (tn(q * 7.0 + tone * 30.0) - 0.5);
    if (rr > edge) discard;
    float z = sqrt(max(0.0, 1.0 - (rr / edge) * (rr / edge)));
    // clumped foliage: perturb the sphere normal with noise
    vec2 bump = vec2(tn(q * 4.5 + tone * 17.0), tn(q * 4.5 + tone * 17.0 + 7.3)) - 0.5;
    vec3 nB = normalize(vec3(q / edge + bump * 0.9, z));
    vec3 N = normalize(vRight * nB.x + vUp * nB.y + vFwd * nB.z);
    float kind = vShape.z;
    vec3 base = kind < 0.5 ? vec3(0.040, 0.060, 0.024) : kind < 1.5 ? vec3(0.020, 0.036, 0.022) : vec3(0.050, 0.060, 0.042);
    base *= 0.8 + 0.45 * tone;
    float shadow = 1.0;
    #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow s = directionalLightShadows[0];
      shadow = getShadow(directionalShadowMap[0], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[0]);
    #endif
    float ndl = dot(N, uSunDir);
    float diff = max(ndl * 0.65 + 0.35, 0.0);                  // foliage wraps light
    float trans = pow(max(dot(-vFwd, uSunDir), 0.0), 3.0) * 0.35; // backlit leaves glow
    float ao = 0.45 + 0.55 * (N.y * 0.5 + 0.5);
    ao *= 0.75 + 0.25 * z;
    vec3 amb = mix(uAmbGround, uAmb, N.y * 0.5 + 0.5);
    vec3 col = base * (uSunCol * uSunI * (diff + trans) * shadow + amb * ao * 1.1);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const depthFrag = /* glsl */`
  #include <common>
  #include <packing>
  varying vec2 vQ;
  varying vec4 vShape;
  void main() {
    if (length(vQ) > 0.86) discard;
    gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
  }
`;

export class Trees {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'trees';
    scene.add(this.group);
    this.tiles = [];
    this.lodBias = 1;
    this._p = new THREE.Vector3();
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uSunI: { value: 3 },
        uAmb: { value: new THREE.Color(0.3, 0.35, 0.4) },
        uAmbGround: { value: new THREE.Color(0.1, 0.1, 0.08) },
        uThin: { value: 1 },
        uGrow: { value: 1 },
      },
    ]);
  }

  load(buffer, groundAt) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(6, true);
    const unit = dv.getFloat32(10, true);
    let o = 14;
    const xq = new Int16Array(buffer.slice(o, o + n * 2)); o += n * 2;
    const zq = new Int16Array(buffer.slice(o, o + n * 2)); o += n * 2;
    const hq = new Uint8Array(buffer, o, n); o += n;
    const rq = new Uint8Array(buffer, o, n); o += n;
    const kq = new Uint8Array(buffer, o, n); o += n;
    const tq = new Uint8Array(buffer, o, n); o += n;
    const cx = (NEAR_M.x0 + NEAR_M.x1) / 2, cz = (NEAR_M.z0 + NEAR_M.z1) / 2;
    const tw = NEAR_M.w / GRID, td = NEAR_M.d / GRID;
    const buckets = Array.from({ length: GRID * GRID }, () => []);
    for (let i = 0; i < n; i++) {
      const x = cx + xq[i] * unit, z = cz + zq[i] * unit;
      const ti = Math.min(GRID - 1, Math.max(0, Math.floor((z - NEAR_M.z0) / td))) * GRID
        + Math.min(GRID - 1, Math.max(0, Math.floor((x - NEAR_M.x0) / tw)));
      buckets[ti].push(i);
    }
    const quad = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, lights: true });
    const depthMat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: depthFrag, uniforms: this.uniforms, lights: true,
    });
    let seed = 9;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    buckets.forEach((b, ti) => {
      if (!b.length) return;
      // shuffle so any prefix is an even thinning of the tile
      for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
      const pos = new Float32Array(b.length * 3), shape = new Float32Array(b.length * 4);
      let lo = Infinity, hi = -Infinity;
      b.forEach((i, k) => {
        const x = cx + xq[i] * unit, z = cz + zq[i] * unit;
        const y = groundAt(x, z);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        shape[k * 4] = hq[i] / 4; shape[k * 4 + 1] = rq[i] / 10; shape[k * 4 + 2] = kq[i]; shape[k * 4 + 3] = tq[i];
        lo = Math.min(lo, y); hi = Math.max(hi, y + hq[i] / 4);
      });
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.getAttribute('position'));
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
      g.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 4));
      g.instanceCount = b.length;
      const x0 = NEAR_M.x0 + (ti % GRID) * tw, z0 = NEAR_M.z0 + Math.floor(ti / GRID) * td;
      const box = new THREE.Box3(new THREE.Vector3(x0 - 20, lo - 5, z0 - 20), new THREE.Vector3(x0 + tw + 20, hi + 5, z0 + td + 20));
      g.boundingBox = box.clone();
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, mat);
      m.customDepthMaterial = depthMat;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = true;
      this.group.add(m);
      this.tiles.push({ mesh: m, n: b.length, box });
    });
    this.count = n;
  }

  update(camera, sky) {
    const u = this.uniforms;
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunCol.value.copy(sky.sunColor);
    u.uSunI.value = sky.sunIrr;
    u.uAmb.value.copy(sky.skyAmbient);
    u.uAmbGround.value.copy(sky.groundAmbient);
    const cp = camera.position;
    for (const t of this.tiles) {
      t.box.clampPoint(cp, this._p);
      const d = this._p.distanceTo(cp) / this.lodBias;
      // full density up close, thinning with distance, gone beyond ~11 km
      const keep = d < 2200 ? 1 : d > 11000 ? 0 : Math.max(0.06, Math.pow(2200 / d, 1.6));
      t.mesh.geometry.instanceCount = Math.floor(t.n * keep);
      t.mesh.visible = keep > 0;
    }
  }
}
