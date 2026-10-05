// Terrain: the detailed region as GPU-displaced chunks with distance-based
// level of detail, plus a coarser backdrop out to Mt Tamalpais and Mt Diablo.
// Shading uses a per-pixel normal map derived from the elevation grid, so the
// relief stays smooth at any mesh resolution.

import * as THREE from 'three';

const CHUNKS = 16;
const LODS = [128, 64, 32, 16, 8];
const SKIRT = 30;

// grid in [0,1]² with a skirt ring (aSkirt = 1) hanging below every edge
function gridWithSkirt(n) {
  const verts = (n + 1) * (n + 1) + 4 * (n + 1);
  const pos = new Float32Array(verts * 3);
  const skirt = new Float32Array(verts);
  let v = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      pos[v * 3] = i / n; pos[v * 3 + 2] = j / n; v++;
    }
  }
  const idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // edges in order: north (j=0), south (j=n), west (i=0), east (i=n)
  const edges = [
    (k) => k, (k) => n * (n + 1) + k, (k) => k * (n + 1), (k) => k * (n + 1) + n,
  ];
  for (let e = 0; e < 4; e++) {
    const base = v;
    for (let k = 0; k <= n; k++) {
      const src = edges[e](k);
      pos[v * 3] = pos[src * 3]; pos[v * 3 + 2] = pos[src * 3 + 2];
      skirt[v] = 1; v++;
    }
    for (let k = 0; k < n; k++) {
      const a = edges[e](k), b = edges[e](k + 1), c = base + k, d = base + k + 1;
      idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings: skirts are seen from either side
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
  g.setIndex(idx);
  return g;
}

function heightTexture(hf) {
  const t = new THREE.DataTexture(hf.data, hf.w, hf.h, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// RGB = world normal, A = cavity (concave = dark), mipmapped
function normalTexture(hf) {
  const { w, h, data, rect } = hf;
  const dx = (rect.x1 - rect.x0) / w, dz = (rect.z1 - rect.z0) / h;
  const out = new Uint8Array(w * h * 4);
  const H = (x, z) => data[Math.min(h - 1, Math.max(0, z)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = H(x, z);
      const sx = (H(x + 1, z) - H(x - 1, z)) / (2 * dx);
      const sz = (H(x, z + 1) - H(x, z - 1)) / (2 * dz);
      const L = Math.hypot(sx, 1, sz);
      const i = (z * w + x) * 4;
      out[i] = ((-sx / L) * 0.5 + 0.5) * 255;
      out[i + 1] = ((1 / L) * 0.5 + 0.5) * 255;
      out[i + 2] = ((-sz / L) * 0.5 + 0.5) * 255;
      // cavity from a wider Laplacian (valleys and gullies darker, ridges lighter)
      const r = 3;
      const lap = (H(x + r, z) + H(x - r, z) + H(x, z + r) + H(x, z - r)) / 4 - c;
      out[i + 3] = Math.max(0, Math.min(255, 128 + lap * 14));
    }
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function colorTexture(bitmap, renderer) {
  const t = new THREE.Texture(bitmap);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const TERRAIN_VERT_PARS = /* glsl */`
  uniform sampler2D tHeight;
  uniform sampler2D tNormal;
  uniform vec4 uRect;          // x0, z0, width, depth (m)
  uniform vec2 uHSize;         // height texture size
  uniform float uSink;         // backdrop: how far to sink inside the detailed region
  uniform vec4 uSinkRect;
  attribute float aSkirt;
  varying vec2 vTUv;
  varying vec3 vWorldPos;
  float terrainHeight(vec2 wxz) {
    vec2 g = (wxz - uRect.xy) / uRect.zw * uHSize - 0.5;
    g = clamp(g, vec2(0.0), uHSize - 1.001);
    ivec2 i = ivec2(floor(g));
    vec2 f = g - vec2(i);
    float a = texelFetch(tHeight, i, 0).r;
    float b = texelFetch(tHeight, i + ivec2(1, 0), 0).r;
    float c = texelFetch(tHeight, i + ivec2(0, 1), 0).r;
    float d = texelFetch(tHeight, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

const TERRAIN_FRAG_PARS = /* glsl */`
  #ifndef TERRAIN_NORMAL_DECLARED
  uniform sampler2D tNormal;
  #endif
  uniform sampler2D tColor;
  uniform float uDetail;
  uniform float uNightK;
  uniform sampler2D tGlow;
  uniform vec4 uGlowRect;
  varying vec2 vTUv;
  varying vec3 vWorldPos;
  float tHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tNoise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
  }
`;

function makeMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = TERRAIN_VERT_PARS + sh.vertexShader
      .replace('#include <beginnormal_vertex>', /* glsl */`
        vec4 wp0 = modelMatrix * vec4(position.x, 0.0, position.z, 1.0);
        vTUv = (wp0.xz - uRect.xy) / uRect.zw;
        vec3 objectNormal = normalize(textureLod(tNormal, vTUv, 2.0).xyz * 2.0 - 1.0);
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        float hgt = terrainHeight(wp0.xz) - aSkirt * ${SKIRT.toFixed(1)};
        if (uSink > 0.0) {
          vec2 q = wp0.xz;
          float inside = step(uSinkRect.x, q.x) * step(q.x, uSinkRect.z) * step(uSinkRect.y, q.y) * step(q.y, uSinkRect.w);
          hgt -= inside * uSink;
        }
        vec3 transformed = vec3(position.x, hgt, position.z);
        vWorldPos = vec3(wp0.x, hgt, wp0.z);
      `);
    sh.fragmentShader = TERRAIN_FRAG_PARS + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        vec4 tc = texture2D(tColor, vTUv);
        vec4 nm = texture2D(tNormal, vTUv);
        vec3 nW = normalize(nm.xyz * 2.0 - 1.0);
        float camDist = length(vWorldPos - cameraPosition);
        vec3 alb = tc.rgb;
        // satellite greens are muted by the atmosphere: give vegetation back some color
        float lumA = dot(alb, vec3(0.2126, 0.7152, 0.0722));
        float veg = smoothstep(0.0, 0.25, (alb.g - max(alb.r, alb.b)) / max(lumA, 1e-3));
        alb = max(mix(vec3(lumA), alb, 1.0 + 0.45 * veg), 0.0) * (1.0 + 0.15 * veg);
        // steep ground shows soil and rock, not the canopy the satellite saw from above
        float steep = smoothstep(0.82, 0.55, nW.y) * tc.a;
        alb = mix(alb, vec3(0.20, 0.17, 0.13) * (0.75 + 0.5 * tNoise(vWorldPos.xz * 0.05)), steep * 0.55);
        // cavity: gullies hold shadow and darker vegetation
        alb *= mix(1.0, 0.75 + 0.5 * nm.a, 0.6);
        // close-range detail so 5 m texels never read as smears
        float dk = uDetail * (1.0 - smoothstep(150.0, 1400.0, camDist));
        if (dk > 0.001) {
          float n = tNoise(vWorldPos.xz * 0.55) * 0.6 + tNoise(vWorldPos.xz * 2.3) * 0.4;
          alb *= 1.0 + (n - 0.5) * 0.28 * dk;
        }
        // the seabed is dark and silty under the water surface
        alb = mix(alb * vec3(0.55, 0.62, 0.6), alb, smoothstep(0.2, 0.6, tc.a));
        diffuseColor.rgb *= alb;
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        if (uNightK > 0.01) {
          // street lighting: roads are marked in the ground texture's alpha (0.78 on roads, 1 off them)
          vec2 gu = (vWorldPos.xz - uGlowRect.xy) / uGlowRect.zw;
          float inside = step(0.0, gu.x) * step(gu.x, 1.0) * step(0.0, gu.y) * step(gu.y, 1.0);
          float urban = texture2D(tGlow, gu).r * inside;
          float road = smoothstep(0.93, 0.81, tc.a) * smoothstep(0.3, 0.6, tc.a);
          totalEmissiveRadiance += vec3(1.0, 0.7, 0.42) * (urban * (0.01 + 0.16 * road) + 0.018 * road) * uNightK;
        }
      `)
      .replace('#include <normal_fragment_begin>', /* glsl */`
        #include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        nonPerturbedNormal = normal;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        roughnessFactor = mix(0.6, roughnessFactor, smoothstep(0.2, 0.7, tc.a));
      `);
  };
  mat.customProgramCacheKey = () => 'karl-terrain';
  return mat;
}

// shadow pass: same displacement, depth only
function makeDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = TERRAIN_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      vec4 wp0 = modelMatrix * vec4(position.x, 0.0, position.z, 1.0);
      vTUv = (wp0.xz - uRect.xy) / uRect.zw;
      float hgt = terrainHeight(wp0.xz) - aSkirt * ${SKIRT.toFixed(1)};
      vec3 transformed = vec3(position.x, hgt, position.z);
      vWorldPos = vec3(wp0.x, hgt, wp0.z);
    `);
  };
  mat.customProgramCacheKey = () => 'karl-terrain-depth';
  return mat;
}

export class Terrain {
  constructor(renderer, scene, near, far, nearBitmap, farBitmap) {
    this.near = near;
    this.far = far;
    const nr = near.rect, fr = far.rect;
    this.uniformsNear = {
      tHeight: { value: heightTexture(near) },
      tNormal: { value: normalTexture(near) },
      tColor: { value: colorTexture(nearBitmap, renderer) },
      uRect: { value: new THREE.Vector4(nr.x0, nr.z0, nr.x1 - nr.x0, nr.z1 - nr.z0) },
      uHSize: { value: new THREE.Vector2(near.w, near.h) },
      uSink: { value: 0 },
      uSinkRect: { value: new THREE.Vector4() },
      uDetail: { value: 1 },
      uNightK: { value: 0 },
      tGlow: { value: null },
      uGlowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    const inset = ((fr.x1 - fr.x0) / far.w) * 1.5;
    this.uniformsFar = {
      tHeight: { value: heightTexture(far) },
      tNormal: { value: normalTexture(far) },
      tColor: { value: colorTexture(farBitmap, renderer) },
      uRect: { value: new THREE.Vector4(fr.x0, fr.z0, fr.x1 - fr.x0, fr.z1 - fr.z0) },
      uHSize: { value: new THREE.Vector2(far.w, far.h) },
      uSink: { value: 60 },
      uSinkRect: { value: new THREE.Vector4(nr.x0 + inset, nr.z0 + inset, nr.x1 - inset, nr.z1 - inset) },
      uDetail: { value: 0 },
      uNightK: { value: 0 },
      tGlow: { value: null },
      uGlowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    this.matNear = makeMaterial(this.uniformsNear);
    this.matFar = makeMaterial(this.uniformsFar);
    this.depthNear = makeDepthMaterial(this.uniformsNear);
    this.matFar.polygonOffset = true;
    this.matFar.polygonOffsetFactor = 2;
    this.matFar.polygonOffsetUnits = 4;

    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    // backdrop: one mesh
    const fg = gridWithSkirt(256);
    fg.scale(fr.x1 - fr.x0, 1, fr.z1 - fr.z0);
    this.farMesh = new THREE.Mesh(fg, this.matFar);
    this.farMesh.position.set(fr.x0, 0, fr.z0);
    this.farMesh.frustumCulled = false;
    this.farMesh.receiveShadow = true;
    this.group.add(this.farMesh);

    // detailed chunks, one geometry per LOD level scaled to chunk size
    const cw = (nr.x1 - nr.x0) / CHUNKS, cd = (nr.z1 - nr.z0) / CHUNKS;
    this.chunkW = cw; this.chunkD = cd;
    this.lodGeoms = LODS.map((n) => { const g = gridWithSkirt(n); g.scale(cw, 1, cd); return g; });
    this.chunks = [];
    for (let j = 0; j < CHUNKS; j++) {
      for (let i = 0; i < CHUNKS; i++) {
        const x0 = nr.x0 + i * cw, z0 = nr.z0 + j * cd;
        const [lo, hi] = near.maxIn(x0, z0, x0 + cw, z0 + cd);
        const m = new THREE.Mesh(this.lodGeoms[2], this.matNear);
        m.position.set(x0, 0, z0);
        m.frustumCulled = false;
        m.castShadow = true;
        m.receiveShadow = true;
        m.customDepthMaterial = this.depthNear;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        this.group.add(m);
        this.chunks.push({
          mesh: m, lod: 2,
          box: new THREE.Box3(new THREE.Vector3(x0, Math.min(lo, 0) - SKIRT, z0), new THREE.Vector3(x0 + cw, Math.max(hi, 0) + 2, z0 + cd)),
        });
      }
    }
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this.lodBias = 1;
  }

  update(camera) {
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const cp = camera.position;
    const k = 0.006 * this.lodBias; // target vertex spacing ≈ k × distance
    for (const c of this.chunks) {
      const vis = this._frustum.intersectsBox(c.box);
      c.mesh.visible = vis;
      if (!vis) continue;
      c.box.clampPoint(cp, this._p);
      const d = Math.max(1, this._p.distanceTo(cp));
      let lod = 0;
      while (lod < LODS.length - 1 && (this.chunkW / LODS[lod + 1]) < d * k) lod++;
      if (lod !== c.lod) { c.lod = lod; c.mesh.geometry = this.lodGeoms[lod]; }
    }
  }

  setNight(k) {
    this.uniformsNear.uNightK.value = k;
    this.uniformsFar.uNightK.value = k;
  }
}
