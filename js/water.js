// Water: one plane at sea level shaded per pixel. Depth comes from the
// bathymetry in the elevation grids, waves from a tileable normal map aligned
// to the forecast wind, reflections from the sky model (and, at higher
// quality, a planar reflection of the scene).

import * as THREE from 'three';

// tileable wave slopes: sum of waves with integer wavevectors (so it wraps)
function waveTexture(size = 256, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const waves = [];
  for (let i = 0; i < 72; i++) {
    const kmag = 1 + Math.floor(Math.pow(rnd(), 1.6) * 28);
    const ang = (rnd() - 0.5) * Math.PI * 0.9; // mostly along +x (the wind axis)
    const kx = Math.round(Math.cos(ang) * kmag), ky = Math.round(Math.sin(ang) * kmag);
    if (kx === 0 && ky === 0) continue;
    const amp = 1 / Math.pow(Math.hypot(kx, ky), 1.25);
    waves.push([kx, ky, amp, rnd() * Math.PI * 2]);
  }
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const [kx, ky, a, ph] of waves) {
        // sharpened crests: |sin|-ish profile
        const t = Math.sin(((kx * x + ky * y) / size) * Math.PI * 2 + ph);
        v += a * (t - 0.35 * t * t * t);
      }
      h[y * size + x] = v;
    }
  }
  const out = new Uint8Array(size * size * 4);
  let maxS = 0;
  const slopes = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const sy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      slopes[(y * size + x) * 2] = sx; slopes[(y * size + x) * 2 + 1] = sy;
      maxS = Math.max(maxS, Math.abs(sx), Math.abs(sy));
    }
  }
  let hMin = Infinity, hMax = -Infinity;
  for (const v of h) { hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); }
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = (slopes[i * 2] / maxS * 0.5 + 0.5) * 255;
    out[i * 4 + 1] = (slopes[i * 2 + 1] / maxS * 0.5 + 0.5) * 255;
    out[i * 4 + 2] = ((h[i] - hMin) / (hMax - hMin)) * 255;
    out[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const vert = /* glsl */`
  varying vec3 vWorld;
  varying vec4 vClip;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    vClip = gl_Position;
  }
`;

const frag = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying vec4 vClip;
  uniform sampler2D tWaves;
  uniform sampler2D tSky;
  uniform sampler2D tHNear; uniform vec4 uRNear; uniform vec2 uSNear;
  uniform sampler2D tHFar;  uniform vec4 uRFar;  uniform vec2 uSFar;
  uniform sampler2D tGround;
  uniform sampler2D tReflect;
  uniform float uReflectK;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform float uSunI;
  uniform vec3 uAmb;
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uGateX;
  uniform float uNight;
  uniform vec2 uViewport;
  const float PI = 3.14159265;

  float hAt(sampler2D t, vec4 r, vec2 s, vec2 xz) {
    vec2 g = (xz - r.xy) / r.zw * s - 0.5;
    g = clamp(g, vec2(0.0), s - 1.001);
    ivec2 i = ivec2(floor(g));
    vec2 f = g - vec2(i);
    float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
    float c = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float depthAt(vec2 xz) {
    vec2 un = (xz - uRNear.xy) / uRNear.zw;
    if (all(greaterThan(un, vec2(0.0))) && all(lessThan(un, vec2(1.0)))) return -hAt(tHNear, uRNear, uSNear, xz);
    vec2 uf = (xz - uRFar.xy) / uRFar.zw;
    if (all(greaterThan(uf, vec2(0.0))) && all(lessThan(uf, vec2(1.0)))) return -hAt(tHFar, uRFar, uSFar, xz);
    return 60.0;
  }
  vec3 sky(vec3 d) {
    d.y = max(d.y, 0.002);
    d = normalize(d);
    float phi = atan(d.x, -d.z);
    float th = asin(clamp(d.y, -1.0, 1.0));
    return texture2D(tSky, vec2(phi / (2.0 * PI) + 0.5, th / PI + 0.5)).rgb;
  }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    vec2 p = vWorld.xz;

    float ws = length(uWind);
    vec2 wd = ws > 0.05 ? uWind / ws : vec2(1.0, 0.0);
    mat2 toW = mat2(wd.x, -wd.y, wd.y, wd.x);     // world -> wind frame
    vec2 q = toW * p;
    // warp the lookup at a few-kilometer scale so the tiles never line up
    q += (vec2(noise(p * 0.00045), noise(p * 0.00045 + 17.3)) - 0.5) * 900.0;
    float t = uTime;
    vec4 w1 = texture2D(tWaves, q / 290.0 + vec2(t * 0.0105, 0.0));
    vec4 w2 = texture2D(tWaves, (q * mat2(0.96, 0.28, -0.28, 0.96)) / 77.0 + vec2(t * 0.0190, t * 0.0040));
    vec4 w3 = texture2D(tWaves, (q * mat2(0.8, 0.6, -0.6, 0.8)) / 21.0 + vec2(t * 0.036, -t * 0.009));
    float amp = 0.05 + 0.11 * clamp(ws / 8.0, 0.0, 1.5);
    vec2 sl = ((w1.rg * 2.0 - 1.0) * 0.5 + (w2.rg * 2.0 - 1.0) * 0.35 + (w3.rg * 2.0 - 1.0) * 0.25) * amp;
    // unresolved waves far away: calmer normals, rougher glint instead
    sl *= mix(1.0, 0.3, smoothstep(500.0, 9000.0, dist));
    vec2 slW = sl * toW;                              // back to world (transpose)
    vec3 N = normalize(vec3(-slW.x, 1.0, -slW.y));

    float depth = max(depthAt(p), 0.0);
    float ocean = smoothstep(uGateX + 1200.0, uGateX - 600.0, p.x);

    // body color: sediment-green bay, deeper blue-green Pacific
    vec3 bay = vec3(0.009, 0.018, 0.021);
    vec3 pac = vec3(0.005, 0.013, 0.024);
    vec3 body = mix(bay, pac, ocean);
    body *= mix(1.25, 1.0, smoothstep(2.0, 25.0, depth));
    // light reaching into the water
    float sunUp = max(uSunDir.y, 0.0);
    vec3 light = uSunCol * uSunI * sunUp * 0.9 + uAmb;
    vec3 col = body * light;
    // the seabed shows through a few meters of water near beaches
    vec2 gu = (p - uRNear.xy) / uRNear.zw;
    if (depth < 6.0 && all(greaterThan(gu, vec2(0.0))) && all(lessThan(gu, vec2(1.0)))) {
      vec3 bed = texture2D(tGround, gu).rgb;
      float k = exp(-depth / 1.6) * 0.55;
      col = mix(col, bed * light * vec3(0.75, 0.9, 0.85), k);
    }

    // reflection
    float NdV = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    vec3 R = reflect(-V, N);
    vec3 refl = sky(R);
    if (uReflectK > 0.0) {
      vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
      suv.x = suv.x;
      vec2 off = slW * vec2(0.6, 0.6) * 0.06 / max(1.0, dist / 800.0);
      vec4 pr = texture2D(tReflect, vec2(suv.x, suv.y) + off);
      refl = mix(refl, pr.rgb, pr.a * uReflectK);
    }
    col = mix(col, refl, fres * 0.98);

    // sun glint (GGX); rougher when windier and far away (unresolved waves)
    vec3 L = uSunDir;
    vec3 H = normalize(L + V);
    float rough = clamp(0.04 + 0.025 * ws / 8.0 + dist * 0.000006, 0.035, 0.4);
    float a2 = rough * rough;
    float NdH = max(dot(N, H), 0.0);
    float dd = NdH * NdH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float NdL = max(dot(N, L), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    col += uSunCol * uSunI * D * F * NdL / max(4.0 * NdV * max(NdL, 0.05), 0.08) * smoothstep(-0.02, 0.04, uSunDir.y) * 0.25;

    // surf on the exposed Pacific shore, a little white water elsewhere
    float shore = 1.0 - smoothstep(0.0, 7.0, depth);
    float bands = smoothstep(0.82, 1.0, fract(depth / 2.4 - t * 0.09 + noise(p * 0.01) * 0.7));
    float swash = 1.0 - smoothstep(0.2, 1.4, depth);
    float n = noise(p * 0.06 + t * 0.15) * 0.6 + noise(p * 0.21 - t * 0.1) * 0.4;
    float foam = ocean * shore * max(bands, swash) * smoothstep(0.25, 0.65, n);
    foam += (1.0 - ocean) * swash * 0.25 * n;
    // wind whitecaps
    float caps = smoothstep(0.80, 0.97, w2.b * 0.6 + w1.b * 0.4) * smoothstep(6.0, 12.0, ws) * smoothstep(3000.0, 300.0, dist);
    foam = clamp(foam + caps * 0.5, 0.0, 1.0);
    vec3 foamCol = vec3(0.75) * (uSunCol * uSunI * (0.3 + 0.7 * sunUp) * 0.3 + uAmb * 1.4);
    col = mix(col, foamCol, foam * 0.85);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Water {
  constructor(scene, terrain, skyTexture, gateX) {
    this.uniforms = {
      tWaves: { value: waveTexture() },
      tSky: { value: skyTexture },
      tHNear: { value: terrain.uniformsNear.tHeight.value },
      uRNear: { value: terrain.uniformsNear.uRect.value },
      uSNear: { value: terrain.uniformsNear.uHSize.value },
      tHFar: { value: terrain.uniformsFar.tHeight.value },
      uRFar: { value: terrain.uniformsFar.uRect.value },
      uSFar: { value: terrain.uniformsFar.uHSize.value },
      tGround: { value: terrain.uniformsNear.tColor.value },
      tReflect: { value: null },
      uReflectK: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSunI: { value: 3 },
      uAmb: { value: new THREE.Color(0.3, 0.35, 0.4) },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(5, 1) },
      uGateX: { value: gateX },
      uNight: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.set(400000, 1, 400000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'water';
    scene.add(this.mesh);
  }

  update(camera, sky, { time, windX, windZ }) {
    const u = this.uniforms;
    // keep the plane centered under the camera (precision), snapped to avoid swimming
    this.mesh.position.set(Math.round(camera.position.x / 1000) * 1000, 0, Math.round(camera.position.z / 1000) * 1000);
    u.uTime.value = time;
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunCol.value.copy(sky.sunColor);
    u.uSunI.value = sky.sunIrr;
    u.uAmb.value.copy(sky.skyAmbient);
    u.uWind.value.set(windX, windZ);
    u.uNight.value = sky.nightF;
  }
}
