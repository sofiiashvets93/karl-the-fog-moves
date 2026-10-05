// Sun position, a physically based sky (single scattering, Rayleigh + Mie),
// high cloud layer, and the lighting rig derived from them: sun light with
// atmospheric transmittance, and an environment map for sky ambient and
// reflections.

import * as THREE from 'three';

const DEG = Math.PI / 180;

// ————— sun position (NOAA solar calculator, accurate to ~1 minute) —————
export function sunPosition(date, lat = 37.776, lon = -122.44) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * DEG) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);
  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG));
  const y = Math.tan((eps / 2) * DEG) ** 2;
  const eqTime = 4 / DEG * (y * Math.sin(2 * L0 * DEG) - 2 * e * Math.sin(M * DEG)
    + 4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG)
    - 0.5 * y * y * Math.sin(4 * L0 * DEG) - 1.25 * e * e * Math.sin(2 * M * DEG)); // minutes
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = utcMin + eqTime + 4 * lon;       // true solar time, minutes
  const ha = (tst / 4 - 180) * DEG;           // hour angle
  const la = lat * DEG;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let elev = 90 - zen / DEG;
  // atmospheric refraction near the horizon
  if (elev > -0.575) {
    const te = Math.tan(elev * DEG);
    elev += (elev > 5 ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
      : 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))) / 3600;
  }
  // azimuth, clockwise from north
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(decl) * Math.cos(la)) / DEG + 180;
  const el = elev * DEG, a = az * DEG;
  // world: +x east, +z south, +y up
  const dir = new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
  return { dir, elev, az };
}

// ————— atmosphere —————
const ATMO = /* glsl */`
  const float PI = 3.14159265;
  const float R_E = 6371e3;
  const float R_A = 6471e3;
  const vec3 BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6);
  const vec3 BETA_O = vec3(0.65e-6, 1.881e-6, 0.085e-6);   // ozone absorption (Chappuis band)
  const float H_R = 8000.0;
  float ozone(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }
  const float H_M = 1200.0;
  uniform float uMie;       // Mie scattering coefficient (haze)
  uniform float uMieG;

  vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  // single-scattered sky radiance along rd for a viewer at altitude h0 (m).
  // Samples are packed near the viewer (quadratic spacing): a horizontal ray
  // crosses ~1000 km of atmosphere but almost all of the scattering happens
  // in the first few tens of kilometers.
  vec3 skyRadiance(vec3 rd, vec3 sunDir, float h0, out vec3 transmit) {
    vec3 ro = vec3(0.0, R_E + h0, 0.0);
    vec2 ta = raySphere(ro, rd, R_A);
    vec2 tg = raySphere(ro, rd, R_E);
    float tmax = ta.y;
    if (tg.x > 0.0) tmax = min(tmax, tg.x);
    const int N = 32;
    const int NL = 8;
    vec3 betaM = vec3(uMie);
    vec3 sumR = vec3(0.0), sumM = vec3(0.0);
    float odR = 0.0, odM = 0.0, odO = 0.0;
    float mu = dot(rd, sunDir);
    float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float g = uMieG;
    float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    for (int i = 0; i < N; i++) {
      float u0 = float(i) / float(N), u1 = float(i + 1) / float(N);
      float t0 = tmax * u0 * u0, t1 = tmax * u1 * u1;
      float ds = t1 - t0;
      vec3 p = ro + rd * (0.5 * (t0 + t1));
      float h = length(p) - R_E;
      float hr = exp(-h / H_R) * ds, hm = exp(-h / H_M) * ds, ho = ozone(h) * ds;
      odR += hr; odM += hm; odO += ho;
      // light path toward the sun, also packed near its start
      vec2 tl = raySphere(p, sunDir, R_A);
      float lR = 0.0, lM = 0.0, lO = 0.0;
      bool lit = true;
      for (int j = 0; j < NL; j++) {
        float v0 = float(j) / float(NL), v1 = float(j + 1) / float(NL);
        float s0 = tl.y * v0 * v0, s1 = tl.y * v1 * v1;
        vec3 q = p + sunDir * (0.5 * (s0 + s1));
        float hq = length(q) - R_E;
        if (hq < 0.0) { lit = false; break; }
        lR += exp(-hq / H_R) * (s1 - s0); lM += exp(-hq / H_M) * (s1 - s0); lO += ozone(hq) * (s1 - s0);
      }
      if (lit) {
        vec3 tau = BETA_R * (odR - 0.5 * hr + lR) + betaM * 1.11 * (odM - 0.5 * hm + lM) + BETA_O * (odO - 0.5 * ho + lO);
        vec3 att = exp(-tau);
        sumR += att * hr;
        sumM += att * hm;
      }
    }
    transmit = exp(-(BETA_R * odR + betaM * 1.11 * odM + BETA_O * odO));
    return sumR * BETA_R * pR + sumM * betaM * pM;
  }
`;

const fsVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// equirectangular sky (lower half = lit ground, for ambient bounce)
const skyTexFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uSunDir;
  uniform float uSunI;
  uniform vec3 uGround;      // ground irradiance color for the lower hemisphere
  uniform vec3 uMS;          // approximate multiple scattering (diffuse sky glow)
  uniform float uNight;
  ${ATMO}
  void main() {
    float phi = (vUv.x - 0.5) * 2.0 * PI;
    float theta = (vUv.y - 0.5) * PI;            // -pi/2 (down) .. pi/2 (up)
    vec3 rd = vec3(cos(theta) * sin(phi), sin(theta), -cos(theta) * cos(phi));
    vec3 col;
    // the sky continues a few degrees below the horizon (the far sea reflects it),
    // so nothing that samples near the horizon picks up ground color
    if (rd.y > -0.1) {
      vec3 dir = normalize(vec3(rd.x, max(rd.y, 0.002), rd.z));
      vec3 tr;
      col = skyRadiance(dir, uSunDir, 30.0, tr) * uSunI;
      // light scattered more than once: brightens the horizon by day and keeps
      // the anti-sun sky blue at twilight, which single scattering alone cannot
      col += uMS * (1.0 - tr);
      // night: faint blue airglow so the scene never goes pure black
      col += vec3(0.0035, 0.0055, 0.011) * uNight * (1.0 - 0.6 * dir.y);
      col = mix(uGround, col, smoothstep(-0.1, -0.06, rd.y));
    } else {
      col = uGround;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// the dome the camera sees: sky texture + sun disc + clouds + stars
const domeVert = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;   // on the far plane
  }
`;

const domeFrag = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform sampler2D tSky;
  uniform vec3 uSunDir;
  uniform vec3 uSunRad;       // sun disc radiance (already transmitted)
  uniform float uNight;
  uniform float uTime;
  uniform vec3 uCloudLit;     // cloud colors
  uniform vec3 uCloudShade;
  uniform float uCloudCover;  // high/mid cloud fraction 0..1
  uniform vec2 uCloudWind;    // m/s, drift
  uniform vec3 uCamPos;
  const float PI = 3.14159265;

  vec3 sampleSky(vec3 d) {
    float phi = atan(d.x, -d.z);
    float theta = asin(clamp(d.y, 0.0, 1.0));
    return texture2D(tSky, vec2(phi / (2.0 * PI) + 0.5, theta / PI + 0.5)).rgb;
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
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = sampleSky(d);
    // sun disc with limb darkening
    float cs = dot(d, uSunDir);
    float r = acos(clamp(cs, -1.0, 1.0));
    float disc = 1.0 - smoothstep(0.0040, 0.0050, r);
    float limb = sqrt(max(0.0, 1.0 - pow(r / 0.0047, 2.0)));
    col += uSunRad * disc * (0.4 + 0.6 * limb) * step(0.0, d.y + 0.01);

    // stars
    if (uNight > 0.05 && d.y > 0.0) {
      vec3 sp = d * 300.0;
      vec3 cell = floor(sp);
      float h = hash12(cell.xy + cell.z * 7.31);
      float dd = length(fract(sp) - 0.5);
      float star = step(0.9965, h) * smoothstep(0.30, 0.0, dd) * (0.3 + 0.7 * hash12(cell.zx));
      col += vec3(star) * uNight * 0.06 * smoothstep(0.0, 0.25, d.y);
    }

    // high cloud deck (~7 km): cirrus streaks and altocumulus patches
    if (uCloudCover > 0.01 && d.y > 0.01) {
      float t = (7000.0 - uCamPos.y) / d.y;
      vec2 p = (uCamPos.xz + d.xz * t + uCloudWind * uTime) * 0.00011;
      vec2 q = vec2(p.x * 0.6 + p.y * 0.25, p.y * 1.6);   // stretched along the jet
      float n = fbm(q + vec2(3.1, 1.7));
      float cov = smoothstep(1.0 - uCloudCover * 0.85, 1.12 - uCloudCover * 0.6, n);
      float detail = fbm(q * 3.7 + n * 1.5);
      float a = cov * (0.55 + 0.45 * detail) * smoothstep(0.01, 0.12, d.y);
      float fwd = pow(max(cs, 0.0), 6.0);
      vec3 cc = mix(uCloudShade, uCloudLit, 0.55 + 0.45 * detail) * (1.0 + 2.5 * fwd);
      col = mix(col, cc, clamp(a, 0.0, 0.85));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// JS port of the transmittance integral, for the sun's color at the ground
const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6];
const BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const ozoneJS = (h) => Math.max(0, 1 - Math.abs(h - 25000) / 15000);
function sunTransmittance(sunDir, mie, out) {
  const RE = 6371e3, RA = 6471e3;
  const p0 = [0, RE + 30, 0];
  const d = [sunDir.x, Math.max(sunDir.y, -0.08), sunDir.z];
  const L = Math.hypot(d[0], d[1], d[2]);
  d[0] /= L; d[1] /= L; d[2] /= L;
  const b = p0[0] * d[0] + p0[1] * d[1] + p0[2] * d[2];
  const c = p0[0] ** 2 + p0[1] ** 2 + p0[2] ** 2 - RA * RA;
  const tmax = -b + Math.sqrt(Math.max(0, b * b - c));
  const N = 64;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < N; i++) {
    const ta = tmax * (i / N) ** 2, tb = tmax * ((i + 1) / N) ** 2;
    const ds = tb - ta, t = (ta + tb) / 2;
    const h = Math.hypot(p0[0] + d[0] * t, p0[1] + d[1] * t, p0[2] + d[2] * t) - RE;
    if (h < 0) { odR += 1e7; break; }
    odR += Math.exp(-h / 8000) * ds;
    odM += Math.exp(-h / 1200) * ds;
    odO += ozoneJS(h) * ds;
  }
  out.setRGB(
    Math.exp(-(BETA_R[0] * odR + mie * 1.11 * odM + BETA_O[0] * odO)),
    Math.exp(-(BETA_R[1] * odR + mie * 1.11 * odM + BETA_O[1] * odO)),
    Math.exp(-(BETA_R[2] * odR + mie * 1.11 * odM + BETA_O[2] * odO)),
  );
  return out;
}

// JS port of skyRadiance() (coarser), for ambient light levels
function skyRadianceJS(rd, sd, mie) {
  const RE = 6371e3, RA = 6471e3, HR = 8000, HM = 1200, g = 0.76;
  const ro = [0, RE + 30, 0];
  const isect = (o, d, r) => {
    const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
    const c = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - r * r;
    const D = b * b - c;
    if (D < 0) return [1e9, -1e9];
    const q = Math.sqrt(D);
    return [-b - q, -b + q];
  };
  const ta = isect(ro, rd, RA), tg = isect(ro, rd, RE);
  let tmax = ta[1];
  if (tg[0] > 0) tmax = Math.min(tmax, tg[0]);
  const N = 20, NL = 6;
  const mu = rd[0] * sd[0] + rd[1] * sd[1] + rd[2] * sd[2];
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const pM = (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  const sR = [0, 0, 0], sM = [0, 0, 0];
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < N; i++) {
    const t0 = tmax * (i / N) ** 2, t1 = tmax * ((i + 1) / N) ** 2;
    const ds = t1 - t0, t = (t0 + t1) / 2;
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const h = Math.hypot(p[0], p[1], p[2]) - RE;
    const hr = Math.exp(-h / HR) * ds, hm = Math.exp(-h / HM) * ds, ho = ozoneJS(h) * ds;
    odR += hr; odM += hm; odO += ho;
    const tl = isect(p, sd, RA);
    let lR = 0, lM = 0, lO = 0, lit = true;
    for (let j = 0; j < NL; j++) {
      const s0 = tl[1] * (j / NL) ** 2, s1 = tl[1] * ((j + 1) / NL) ** 2, sm = (s0 + s1) / 2;
      const hq = Math.hypot(p[0] + sd[0] * sm, p[1] + sd[1] * sm, p[2] + sd[2] * sm) - RE;
      if (hq < 0) { lit = false; break; }
      lR += Math.exp(-hq / HR) * (s1 - s0); lM += Math.exp(-hq / HM) * (s1 - s0); lO += ozoneJS(hq) * (s1 - s0);
    }
    if (!lit) continue;
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(BETA_R[c] * (odR - hr / 2 + lR) + mie * 1.11 * (odM - hm / 2 + lM) + BETA_O[c] * (odO - ho / 2 + lO)));
      sR[c] += att * hr; sM[c] += att * hm;
    }
  }
  return [0, 1, 2].map((c) => sR[c] * BETA_R[c] * pR + sM[c] * mie * pM);
}

function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

export class SkyRig {
  constructor(renderer, scene, { shadowSize = 4096 } = {}) {
    this.renderer = renderer;
    this.scene = scene;

    // equirect sky texture
    this.skyRT = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, depthBuffer: false });
    this.skyRT.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.skyRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.skyUniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunI: { value: 20 },
      uGround: { value: new THREE.Color(0.1, 0.1, 0.1) },
      uMS: { value: new THREE.Color(0, 0, 0) },
      uNight: { value: 0 },
      uMie: { value: 21e-6 },
      uMieG: { value: 0.76 },
    };
    this.skyScene = new THREE.Scene();
    this.skyScene.add(new THREE.Mesh(fullscreenTriangle(), new THREE.ShaderMaterial({
      vertexShader: fsVert, fragmentShader: skyTexFrag, uniforms: this.skyUniforms, depthTest: false, depthWrite: false,
    })));
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // dome
    this.domeUniforms = {
      tSky: { value: this.skyRT.texture },
      uSunDir: this.skyUniforms.uSunDir,
      uSunRad: { value: new THREE.Color() },
      uNight: this.skyUniforms.uNight,
      uTime: { value: 0 },
      uCloudLit: { value: new THREE.Color() },
      uCloudShade: { value: new THREE.Color() },
      uCloudCover: { value: 0.15 },
      uCloudWind: { value: new THREE.Vector2(6, 2) },
      uCamPos: { value: new THREE.Vector3() },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.ShaderMaterial({
        vertexShader: domeVert, fragmentShader: domeFrag, uniforms: this.domeUniforms,
        side: THREE.BackSide, depthWrite: false,
      }),
    );
    this.dome.scale.setScalar(1000);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    // sun
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(shadowSize, shadowSize);
    sh.bias = -0.0002;
    sh.normalBias = 0.6;
    sh.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this._lastSun = new THREE.Vector3(0, -2, 0);
    this._lastMie = 0;
    this._sunCol = new THREE.Color();
    this._tmp = new THREE.Color();
    this.state = {
      sunDir: new THREE.Vector3(0, 1, 0), elev: 45, dayF: 1, duskF: 0, nightF: 0,
      sunColor: new THREE.Color(1, 1, 1), sunIrr: 3, skyAmbient: new THREE.Color(0.3, 0.35, 0.45),
      horizon: new THREE.Color(0.6, 0.7, 0.8), groundAmbient: new THREE.Color(0.1, 0.1, 0.1), envReady: false,
    };
  }

  // haze: Mie coefficient from visibility-like haze factor 0..1
  update(date, camera, { haze = 0.3, cloudCover = 0.15, windX = 6, windZ = 2, time = 0 } = {}) {
    const { dir, elev } = sunPosition(date);
    const st = this.state;
    st.sunDir.copy(dir);
    st.elev = elev;
    st.dayF = THREE.MathUtils.smoothstep(elev, -6, 8);
    st.duskF = Math.exp(-Math.pow((elev - 2) / 8, 2));
    st.nightF = 1 - THREE.MathUtils.smoothstep(elev, -14, -2);

    const mie = 8e-6 + 40e-6 * haze;
    this.skyUniforms.uMie.value = mie;
    this.skyUniforms.uSunDir.value.copy(dir);
    this.skyUniforms.uNight.value = st.nightF;

    // sunlight at the ground: transmittance x extraterrestrial
    sunTransmittance(dir, mie, this._sunCol);
    const above = THREE.MathUtils.smoothstep(elev, -1.5, 3);
    st.sunColor.copy(this._sunCol);
    st.sunIrr = 3.6 * above;
    this.sun.color.copy(this._sunCol);
    this.sun.intensity = st.sunIrr;
    this.domeUniforms.uSunRad.value.copy(this._sunCol).multiplyScalar(4000 * above);

    // ground color for the lower hemisphere (bounce light): albedo ~0.12
    const gI = 0.12 * (st.sunIrr * Math.max(dir.y, 0) + 0.6 * st.dayF + 0.02) / Math.PI;
    this.skyUniforms.uGround.value.setRGB(gI * this._sunCol.r * 1.0, gI * this._sunCol.g * 0.95, gI * this._sunCol.b * 0.85);

    // clouds take the sun's color on top, the sky's underneath
    this.domeUniforms.uCloudLit.value.copy(this._sunCol).multiplyScalar(1.6 * st.dayF + 0.02);
    this.domeUniforms.uCloudShade.value.setRGB(0.32, 0.36, 0.44).multiplyScalar(0.9 * st.dayF + 0.015);
    this.domeUniforms.uCloudCover.value = cloudCover;
    this.domeUniforms.uCloudWind.value.set(windX, windZ);
    this.domeUniforms.uTime.value = time;
    this.domeUniforms.uCamPos.value.copy(camera.position);

    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(camera.far * 0.9);

    // re-render the sky + environment when the sun or haze moves enough
    if (dir.angleTo(this._lastSun) > 0.004 || Math.abs(mie - this._lastMie) > 1.5e-6 || !st.envReady) {
      this._lastSun.copy(dir);
      this._lastMie = mie;
      // multiple-scattering glow: scaled zenith-sky color by day, a blue-hour glow at twilight
      const zen = skyRadianceJS([0, 1, 0], [dir.x, dir.y, dir.z], mie).map((v) => v * this.skyUniforms.uSunI.value);
      const blueHour = Math.exp(-Math.pow((elev + 3) / 5, 2));
      this.skyUniforms.uMS.value.setRGB(
        zen[0] * 0.9 + 0.025 * blueHour, zen[1] * 0.9 + 0.045 * blueHour, zen[2] * 0.9 + 0.095 * blueHour);
      const r = this.renderer;
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.skyRT);
      r.render(this.skyScene, this.quadCam);
      r.setRenderTarget(prev);
      // ambient: cosine-weighted sky radiance over the upper hemisphere, low
      // elevations included (they carry most of the glow at dusk). skyAmbient is
      // irradiance / π on a horizontal surface.
      const sd = [dir.x, dir.y, dir.z];
      const acc = [0, 0, 0];
      let wsum = 0;
      for (const el of [3, 10, 22, 40, 62, 84]) {
        const n = el > 80 ? 1 : 8;
        const w = Math.sin(el * DEG) * Math.cos(el * DEG) * (el > 80 ? 8 : 1);
        for (let k = 0; k < n; k++) {
          const az = (k / n) * Math.PI * 2;
          const ce = Math.cos(el * DEG);
          const L = skyRadianceJS([Math.sin(az) * ce, Math.sin(el * DEG), -Math.cos(az) * ce], sd, mie);
          for (let c = 0; c < 3; c++) acc[c] += L[c] * w;
          wsum += w;
        }
      }
      const I = this.skyUniforms.uSunI.value;
      const night = st.nightF;
      st.skyAmbient.setRGB(
        (acc[0] / wsum) * I + 0.004 * night, (acc[1] / wsum) * I + 0.006 * night, (acc[2] / wsum) * I + 0.011 * night);
      const gA = this.skyUniforms.uGround.value;
      st.groundAmbient.copy(gA);
      const env = this.pmrem.fromEquirectangular(this.skyRT.texture, this.envRT || undefined);
      if (this.envRT && this.envRT !== env) this.envRT.dispose();
      this.envRT = env;
      this.scene.environment = env.texture;
      st.envReady = true;
    }
    // white balance: partly neutralize the illuminant on a horizontal surface
    // (direct sun + sky), the way eyes and cameras adapt; less at dusk so
    // sunsets stay warm, none at night
    const E = st.sunIrr * Math.max(dir.y, 0);
    const ill = [0, 1, 2].map((c) => st.sunColor.toArray()[c] * E + st.skyAmbient.toArray()[c] * Math.PI);
    const lum = 0.2126 * ill[0] + 0.7152 * ill[1] + 0.0722 * ill[2];
    const k = 0.7 * THREE.MathUtils.smoothstep(elev, -8, 4) * (1 - 0.3 * st.duskF);
    st.wb = st.wb || new THREE.Vector3(1, 1, 1);
    st.wb.set(...ill.map((v) => Math.pow(lum / Math.max(v, 1e-5), k)));
    // keep luminance unchanged
    const wl = 0.2126 * st.wb.x + 0.7152 * st.wb.y + 0.0722 * st.wb.z;
    st.wb.multiplyScalar(1 / wl);
    return st;
  }

  // keep the shadow frustum tight around what the camera is looking at
  fitShadow(target, camDist) {
    const s = this.sun.shadow;
    const half = THREE.MathUtils.clamp(camDist * 0.9, 350, 9000);
    const cam = s.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 10;
    cam.far = 6000 + half * 2;
    // snap to texels to stop shadow shimmer while panning
    const texel = (2 * half) / s.mapSize.x;
    const d = this.state.sunDir;
    const dist = 3000 + half;
    const tx = Math.round(target.x / texel) * texel;
    const tz = Math.round(target.z / texel) * texel;
    this.sun.target.position.set(tx, target.y, tz);
    this.sun.position.set(tx + d.x * dist, target.y + Math.max(d.y, 0.05) * dist, tz + d.z * dist);
    this.sun.target.updateMatrixWorld();
    cam.updateProjectionMatrix();
    s.normalBias = 0.15 + texel * 0.6;
  }
}
