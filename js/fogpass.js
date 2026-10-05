// Render pipeline: scene -> HDR target, the marine layer and clear-air haze
// raymarched at reduced resolution against the depth buffer, a small bloom,
// and the composite (depth-aware upsample, tone mapping, grading).

import * as THREE from 'three';
import { DOMAIN } from './fogfield.js';

const fsVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fogFrag = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  varying vec2 vUv;
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform float uNear;
  uniform float uFar;

  uniform sampler3D tField;      // coverage, base/4, top/4, density
  uniform vec4 uDomain;          // x0, z0, w, d
  uniform float uHourW;
  uniform sampler3D tNoise;
  uniform vec2 uDrift;           // wind drift of the air mass (m)
  uniform float uTime;
  uniform float uSigma;          // extinction at density 1 (1/m)
  uniform float uMaxTop;
  uniform int uSteps;
  uniform float uJitter;
  uniform float uFogOn;

  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform float uSunI;
  uniform vec3 uSkyAmb;
  uniform vec3 uGroundAmb;
  uniform sampler2D tSky;
  uniform float uHaze0;          // clear-air extinction at sea level (1/m)
  uniform float uHazeH;          // haze scale height (m)
  uniform float uNight;
  uniform sampler2D tGlow;       // city light under the fog (2D)
  uniform vec4 uGlowRect;
  const float PI = 3.14159265;

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec3 skyH(vec3 d) {
    d.y = clamp(d.y, 0.07, 0.3);
    d = normalize(d);
    float phi = atan(d.x, -d.z);
    float th = asin(d.y);
    return texture2D(tSky, vec2(phi / (2.0 * PI) + 0.5, th / PI + 0.5)).rgb;
  }

  // optical depth of exponential haze along a ray segment
  float hazeTau(vec3 ro, vec3 rd, float t0, float t1) {
    float y0 = ro.y + rd.y * t0;
    float L = max(t1 - t0, 0.0);
    float k = rd.y * L / uHazeH;
    float e0 = exp(-max(y0, -50.0) / uHazeH);
    float f = abs(k) < 1e-3 ? 1.0 : (1.0 - exp(-k)) / k;
    return uHaze0 * e0 * L * f;
  }

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  // the layer's top surface at a point: the inversion height from the field
  // plus a gently rolling relief that drifts with the wind
  float topAt(vec2 xz, out float topBase) {
    vec2 uv = (xz - uDomain.xy) / uDomain.zw;
    topBase = texture(tField, vec3(uv, uHourW)).b * 1020.0;
    vec2 q = xz - uDrift;
    float r1 = texture(tNoise, vec3(q / 3400.0, uTime * 0.0003)).g;
    float r2 = texture(tNoise, vec3(q / 820.0, 0.37 + uTime * 0.0006)).r;
    // billow cells, warped and stronger in some places than others
    vec2 wq = q + (texture(tNoise, vec3(q / 1300.0, 0.53)).rb - 0.5) * 260.0;
    float r3 = texture(tNoise, vec3(wq / 270.0, 0.71)).g;
    float cellK = 0.35 + 1.1 * texture(tNoise, vec3(q / 5200.0, 0.19)).b;
    return topBase + (r1 - 0.5) * 60.0 + (r2 - 0.5) * 44.0 + (r3 - 0.5) * 22.0 * cellK;
  }

  // could there be fog here? Reads only the field, with room for the top's relief
  bool nearFog(vec3 p) {
    vec2 uv = (p.xz - uDomain.xy) / uDomain.zw;
    vec4 F = texture(tField, vec3(uv, uHourW));
    return F.r > 0.13 && p.y < F.b * 1020.0 + 85.0 && p.y > F.g * 1020.0 - 40.0;
  }

  // density in [0..1] times local density scale; also returns layer top
  float fogDensity(vec3 p, out float topL) {
    vec2 uv = (p.xz - uDomain.xy) / uDomain.zw;
    vec4 F = texture(tField, vec3(uv, uHourW));
    topL = F.b * 1020.0;
    // most places are either inside the layer or not; partial values are the
    // ragged transition zone along its edge
    float cov = smoothstep(0.12, 0.8, F.r);
    if (cov < 0.004) return 0.0;
    float base = F.g * 1020.0;
    vec3 q = vec3(p.x - uDrift.x, p.y, p.z - uDrift.y);
    // a nearly flat inversion with a gently rolling top
    float tb0;
    topL = topAt(p.xz, tb0);
    if (p.y > topL + 14.0) return 0.0;
    float v = smoothstep(base - 30.0, base + 30.0, p.y) * (1.0 - smoothstep(topL - 45.0, topL + 12.0, p.y));
    if (v <= 0.0) return 0.0;
    // where coverage is partial: large irregular lobes (warped, ~10 km noise,
    // equalized so the covered share follows the coverage value)
    vec3 wq = q + (texture(tNoise, q * vec3(1.0 / 2600.0, 1.0 / 900.0, 1.0 / 2600.0)).gbr - 0.5) * 1400.0;
    float nL = texture(tNoise, wq * vec3(1.0 / 10500.0, 1.0 / 2600.0, 1.0 / 7800.0)).r;
    float lobe = smoothstep(1.0 - cov - 0.16, 1.0 - cov + 0.16, nL);
    // softer, finer structure only along those edges
    float nM = texture(tNoise, q * vec3(1.0 / 1500.0, 1.0 / 420.0, 1.0 / 1500.0)).g;
    float rim = lobe * (1.0 - lobe) * 4.0;
    lobe = clamp(lobe + (nM - 0.55) * 0.9 * rim, 0.0, 1.0);
    return lobe * v * F.a;
  }

  void main() {
    float depth = texture2D(tDepth, vUv).x;
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInv * ndc;
    vp /= vp.w;
    vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
    vec3 ro = uCamPos;
    vec3 rd = wp - ro;
    float tSurf = length(rd);
    rd /= tSurf;
    bool sky = depth >= 0.99999;
    if (sky) tSurf = 60000.0;

    vec3 I = vec3(0.0);
    float T = 1.0;
    float mu = dot(rd, uSunDir);
    vec3 hz = skyH(rd);

    // slab where fog can exist
    float yLo = -5.0, yHi = uMaxTop + 40.0;
    float tA = 0.0, tB = tSurf;
    if (abs(rd.y) > 1e-5) {
      float t1 = (yLo - ro.y) / rd.y, t2 = (yHi - ro.y) / rd.y;
      tA = max(0.0, min(t1, t2));
      tB = min(tSurf, max(t1, t2));
    } else if (ro.y < yLo || ro.y > yHi) {
      tA = tSurf; tB = tSurf;
    }
    bool march = uFogOn > 0.5 && tB > tA;
    float tEnter = march ? tA : tSurf;

    // 1) clear air from the camera to the fog slab
    if (!sky) {
      float tau = hazeTau(ro, rd, 0.0, tEnter);
      float a = exp(-tau);
      I += T * (1.0 - a) * hz;
      T *= a;
    }

    // 2) through the marine layer. First skip the clear air above and around
    // it: coarse steps that read only the field find where the ray first comes
    // within reach of the fog, a few bisections refine that, and every fine
    // step lands where fog can be.
    bool found = false;
    float tIn = tB;
    if (march) {
      float tLo = tA, tHi = tB;
      found = nearFog(ro + rd * tA);
      if (!found) {
        for (int i = 1; i <= 20; i++) {
          float u = float(i) / 20.0;
          float tc = tA + (tB - tA) * u * u;
          if (nearFog(ro + rd * tc)) { tHi = tc; found = true; break; }
          tLo = tc;
        }
        if (found) {
          for (int k = 0; k < 5; k++) {
            float tm = 0.5 * (tLo + tHi);
            if (nearFog(ro + rd * tm)) tHi = tm; else tLo = tm;
          }
        }
      }
      tIn = found ? tLo : tB;
      if (!sky && tIn > tA) {
        float tau = hazeTau(ro, rd, tA, tIn);
        float a = exp(-tau);
        I += T * (1.0 - a) * hz;
        T *= a;
      }
    }
    if (found) {
      // interleaved gradient noise: well spread per pixel, so the upsampled result is smooth
      float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uJitter * 5.588238, vec2(0.06711056, 0.00583715))));
      float seg = tB - tIn;
      float prev = tIn;
      float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
      bool haveN = false;
      vec3 nTop = vec3(0.0, 1.0, 0.0);
      for (int i = 0; i < 64; i++) {
        if (i >= uSteps) break;
        float fi = (float(i) + j) / float(uSteps);
        float t = tIn + seg * fi * fi * (0.35 + 0.65 * fi);
        float dt = t - prev;
        prev = t;
        vec3 p = ro + rd * t;
        float topL;
        float dens = fogDensity(p, topL);
        float sigH = sky ? 0.0 : uHaze0 * exp(-max(p.y, 0.0) / uHazeH);
        float sigF = dens * uSigma;
        float sig = sigF + sigH;
        if (sig > 1e-7) {
          float a = exp(-sig * dt);
          vec3 Ls = vec3(0.0);
          if (sigF > 0.0) {
            // sunlight reaching this point: follow the sun ray to where it leaves
            // the layer, so swells facing the sun are bright and their lee is shaded
            float sy = max(uSunDir.y, 0.12);
            float above0 = max(topL - p.y, 0.0);
            vec2 exitXZ = p.xz + uSunDir.xz / sy * above0;
            float tb;
            float topS = topAt(exitXZ, tb);
            float above = max(topS - p.y, 0.0);
            float tauS = sigF * above / sy;
            vec3 sun = vec3(0.0);
            float aa = 1.0, bb = 1.0, cc = 1.0;
            for (int o = 0; o < 3; o++) {
              float ph = mix(hgPhase(mu, 0.8 * cc), 1.0 / (4.0 * PI), 0.25);
              sun += aa * ph * exp(-bb * tauS);
              aa *= 0.55; bb *= 0.4; cc *= 0.5;
            }
            sun *= uSunCol * uSunI * sunUp * 3.2;
            // the top surface's own slope, once per ray where it enters the layer
            if (!haveN) {
              float e = 70.0, t1, t2, t3;
              float h0 = topAt(p.xz, t1), hx = topAt(p.xz + vec2(e, 0.0), t2), hz = topAt(p.xz + vec2(0.0, e), t3);
              nTop = normalize(vec3(h0 - hx, e, h0 - hz));
              haveN = true;
            }
            float lam = clamp(dot(nTop, uSunDir) / sy, 0.35, 1.9);
            sun *= mix(1.0, lam, exp(-above0 / 40.0) * 0.85);
            // sky light from above, dim from below; deep fog is darker
            float hf = clamp((p.y - (topL - 260.0)) / 260.0, 0.0, 1.0);
            // troughs between swells see less sky
            float trough = clamp((tb - p.y) / 60.0, 0.0, 1.5);
            // (at night the sky over the city is not black: its glow lights the top a little)
            vec3 skyA = uSkyAmb * 1.25 + vec3(0.0065, 0.006, 0.0058) * uNight;
            vec3 amb = mix(uGroundAmb * 1.3, skyA, 0.25 + 0.75 * hf) * exp(-sigF * above0 * 0.12) * (1.0 - 0.18 * trough);
            vec3 glow = vec3(0.0);
            if (uNight > 0.01) {
              // city light from below, diffusing up through the layer: the whole
              // layer glows over the city, strongest near its base
              vec2 gu = (p.xz - uGlowRect.xy) / uGlowRect.zw;
              float inside = step(0.0, gu.x) * step(gu.x, 1.0) * step(0.0, gu.y) * step(gu.y, 1.0);
              float g = texture2D(tGlow, gu).r * inside;
              float depthIn = max(p.y - (topL - 450.0), 0.0);
              glow = vec3(1.0, 0.6, 0.32) * g * uNight * (0.035 + 0.11 * exp(-depthIn * sigF * 0.35));
            }
            Ls += (sun + amb + glow) * sigF;
          }
          Ls += hz * sigH;
          I += T * (1.0 - a) * Ls / sig;
          T *= a;
          if (T < 0.01) { T = 0.0; break; }
        }
      }
    }

    // 3) clear air beyond the slab, to the surface
    if (!sky && T > 0.0 && tB < tSurf) {
      float tau = hazeTau(ro, rd, march ? tB : tEnter, tSurf);
      float a = exp(-tau);
      I += T * (1.0 - a) * hz;
      T *= a;
    }
    gl_FragColor = vec4(I, T);
  }
`;

// the raymarch is jittered per pixel and per frame: a small depth-aware blur
// removes most of that noise, and while the view holds still, frames
// accumulate (any camera move restarts the history, so nothing smears)
const resolveFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tFog;
  uniform sampler2D tHist;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uNear;
  uniform float uFar;
  uniform float uBlend;
  float linDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }
  void main() {
    float d0 = linDepth(texture2D(tDepth, vUv).x);
    vec4 acc = vec4(0.0);
    float ws = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 uv = vUv + vec2(float(i), float(j)) * uTexel;
        float d = linDepth(texture2D(tDepth, uv).x);
        float k = (i == 0 ? 1.0 : 0.6) * (j == 0 ? 1.0 : 0.6);
        float w = k / (1e-3 + abs(d - d0) / max(d0, 1.0) * 30.0);
        acc += texture2D(tFog, uv) * w;
        ws += w;
      }
    }
    vec4 cur = acc / ws;
    gl_FragColor = uBlend >= 1.0 ? cur : mix(texture2D(tHist, vUv), cur, uBlend);
  }
`;

const downFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  void main() {
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    c *= 0.25;
    if (uThreshold > 0.0) {
      float l = max(c.r, max(c.g, c.b));
      c *= smoothstep(uThreshold, uThreshold * 2.5, l);
      c = min(c, vec3(60.0));
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

const upFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform sampler2D tPrev;
  uniform vec2 uTexel;
  void main() {
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb;
    gl_FragColor = vec4(c * 0.25 + texture2D(tPrev, vUv).rgb, 1.0);
  }
`;

const compFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tFog;
  uniform sampler2D tDepth;
  uniform sampler2D tBloom;
  uniform vec2 uFogSize;
  uniform float uNear;
  uniform float uFar;
  uniform float uExposure;
  uniform vec3 uWB;
  uniform float uBloomK;
  uniform float uTime;
  uniform vec2 uRes;

  float linDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }
  // Stephen Hill's ACES fit
  vec3 aces(vec3 c) {
    const mat3 Min = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 Mout = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    c = Min * c;
    vec3 a = c * (c + 0.0245786) - 0.000090537;
    vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
    return clamp(Mout * (a / b), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main() {
    vec3 scene = texture2D(tScene, vUv).rgb;
    float d0 = linDepth(texture2D(tDepth, vUv).x);
    // depth-aware upsample of the half-resolution fog
    vec2 fp = vUv * uFogSize - 0.5;
    vec2 f = fract(fp);
    vec2 base = (floor(fp) + 0.5) / uFogSize;
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 uv = base + vec2(float(i), float(j)) / uFogSize;
        float d = linDepth(texture2D(tDepth, uv).x);
        float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
        float wd = 1.0 / (1e-3 + abs(d - d0) / max(d0, 1.0) * 40.0);
        float w = wb * wd + 1e-5;
        acc += texture2D(tFog, uv) * w;
        wsum += w;
      }
    }
    vec4 fog = acc / wsum;
    vec3 col = scene * fog.a + fog.rgb;
    col += texture2D(tBloom, vUv).rgb * uBloomK * (0.4 + 0.6 * fog.a);
    col *= uExposure * uWB;
    col = aces(col);
    // a little more color and depth than the filmic curve leaves
    float lumC = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(lumC), col, 1.12), 0.0);
    col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
    // gentle grade: a touch of warmth in the highlights, cooler shadows
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, col * vec3(1.03, 1.0, 0.96), smoothstep(0.4, 0.9, l));
    col = mix(col, col * vec3(0.97, 0.99, 1.03), 1.0 - smoothstep(0.0, 0.35, l));
    col = toSRGB(col);
    vec2 q = vUv - 0.5;
    col *= 1.0 - dot(q, q) * 0.22;
    // dither so gradients never band
    float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    col += (n - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// matrices equal within tol on the translation (meters), tol / 1000 elsewhere
function same(a, b, tol) {
  const x = a.elements, y = b.elements;
  for (let i = 0; i < 16; i++) {
    const t = i >= 12 && i <= 14 ? tol : tol * 1e-3;
    if (Math.abs(x[i] - y[i]) > Math.max(t, 1e-9)) return false;
  }
  return true;
}

function tri() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

export class Pipeline {
  constructor(renderer, { fogScale = 0.5, msaa = 4, bloom = true } = {}) {
    this.renderer = renderer;
    this.fogScale = fogScale;
    this.bloomOn = bloom;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = size.x, h = size.y;
    this.depthTexture = new THREE.DepthTexture(w, h);
    this.depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthTexture: this.depthTexture, samples: msaa,
    });
    this.fogRT = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w * fogScale)), Math.max(2, Math.floor(h * fogScale)), {
      type: THREE.HalfFloatType, depthBuffer: false,
    });
    this.fogRT.texture.minFilter = this.fogRT.texture.magFilter = THREE.LinearFilter;
    this.hist = [0, 1].map(() => {
      const rt = new THREE.WebGLRenderTarget(this.fogRT.width, this.fogRT.height, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      return rt;
    });
    this.histIdx = 0;
    this.histValid = false;
    this._prevView = new THREE.Matrix4();
    this._prevProj = new THREE.Matrix4();
    this.bloomRTs = [];
    this._makeBloom(w, h);

    this.fogUniforms = {
      tDepth: { value: this.depthTexture },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uNear: { value: 1 }, uFar: { value: 1e5 },
      tField: { value: null },
      uDomain: { value: new THREE.Vector4(DOMAIN.x0, DOMAIN.z0, DOMAIN.w, DOMAIN.d) },
      uHourW: { value: 0 },
      tNoise: { value: null },
      uDrift: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uSigma: { value: 0.012 },
      uMaxTop: { value: 800 },
      uSteps: { value: 40 },
      uJitter: { value: 0 },
      uFogOn: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSunI: { value: 3 },
      uSkyAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
      uGroundAmb: { value: new THREE.Color(0.1, 0.1, 0.1) },
      tSky: { value: null },
      uHaze0: { value: 1.2e-4 },
      uHazeH: { value: 900 },
      uNight: { value: 0 },
      tGlow: { value: null },
      uGlowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    this.compUniforms = {
      tScene: { value: this.sceneRT.texture },
      tFog: { value: this.hist[0].texture },
      tDepth: { value: this.depthTexture },
      tBloom: { value: null },
      uFogSize: { value: new THREE.Vector2(this.fogRT.width, this.fogRT.height) },
      uNear: this.fogUniforms.uNear, uFar: this.fogUniforms.uFar,
      uExposure: { value: 1 },
      uWB: { value: new THREE.Vector3(1, 1, 1) },
      uBloomK: { value: bloom ? 0.06 : 0 },
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(w, h) },
    };
    const g = tri();
    const mk = (frag, uniforms) => {
      const s = new THREE.Scene();
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: fsVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }));
      m.frustumCulled = false;
      s.add(m);
      return { scene: s, mat: m.material };
    };
    this.fogPass = mk(fogFrag, this.fogUniforms);
    this.resolveU = {
      tFog: { value: this.fogRT.texture }, tHist: { value: null }, tDepth: { value: this.depthTexture },
      uTexel: { value: new THREE.Vector2() }, uNear: this.fogUniforms.uNear, uFar: this.fogUniforms.uFar, uBlend: { value: 1 },
    };
    this.resolvePass = mk(resolveFrag, this.resolveU);
    this.compPass = mk(compFrag, this.compUniforms);
    this.downU = { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } };
    this.upU = { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() } };
    this.downPass = mk(downFrag, this.downU);
    this.upPass = mk(upFrag, this.upU);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.compUniforms.tBloom.value = this.bloomRTs.length ? this.bloomRTs[0].up.texture : this.blackTex();
  }

  blackTex() {
    if (!this._black) {
      this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this._black.needsUpdate = true;
    }
    return this._black;
  }

  _makeBloom(w, h) {
    for (const r of this.bloomRTs) { r.down.dispose(); r.up.dispose(); }
    this.bloomRTs = [];
    if (!this.bloomOn) return;
    let bw = w, bh = h;
    for (let i = 0; i < 5; i++) {
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
      const o = { type: THREE.HalfFloatType, depthBuffer: false };
      const down = new THREE.WebGLRenderTarget(bw, bh, o), up = new THREE.WebGLRenderTarget(bw, bh, o);
      for (const t of [down.texture, up.texture]) { t.minFilter = t.magFilter = THREE.LinearFilter; }
      this.bloomRTs.push({ down, up, w: bw, h: bh });
    }
  }

  _sizeFog(w, h) {
    const fw = Math.max(2, Math.floor(w * this.fogScale)), fh = Math.max(2, Math.floor(h * this.fogScale));
    this.fogRT.setSize(fw, fh);
    for (const rt of this.hist) rt.setSize(fw, fh);
    this.histValid = false;
    this.compUniforms.uFogSize.value.set(fw, fh);
  }

  setSize(w, h) {
    this.sceneRT.setSize(w, h);
    this._sizeFog(w, h);
    this.compUniforms.uRes.value.set(w, h);
    this._makeBloom(w, h);
    this.compUniforms.tBloom.value = this.bloomRTs.length ? this.bloomRTs[0].up.texture : this.blackTex();
  }

  setFogScale(s) {
    this.fogScale = s;
    this._sizeFog(this.sceneRT.width, this.sceneRT.height);
  }

  // blend: how much of this frame goes into the accumulated fog (1 = none of
  // the history). Moving the camera always starts over.
  render(scene, camera, time, { blend = 0.3 } = {}) {
    const r = this.renderer;
    const u = this.fogUniforms;
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uJitter.value = (time * 60) % 97;
    this.compUniforms.uTime.value = (time * 13.1) % 100;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    r.setRenderTarget(this.fogRT);
    r.render(this.fogPass.scene, this.cam);

    const moved = !same(this._prevView, camera.matrixWorld, 1e-3) || !same(this._prevProj, camera.projectionMatrix, 1e-7);
    this._prevView.copy(camera.matrixWorld);
    this._prevProj.copy(camera.projectionMatrix);
    const src = this.hist[this.histIdx], dst = this.hist[1 - this.histIdx];
    this.resolveU.tHist.value = src.texture;
    this.resolveU.uTexel.value.set(1 / this.fogRT.width, 1 / this.fogRT.height);
    this.resolveU.uBlend.value = moved || !this.histValid ? 1 : blend;
    r.setRenderTarget(dst);
    r.render(this.resolvePass.scene, this.cam);
    this.histIdx = 1 - this.histIdx;
    this.histValid = true;
    this.compUniforms.tFog.value = dst.texture;

    if (this.bloomRTs.length) {
      let src = this.sceneRT.texture, sw = this.sceneRT.width, sh = this.sceneRT.height;
      this.bloomRTs.forEach((b, i) => {
        this.downU.tSrc.value = src;
        this.downU.uTexel.value.set(0.5 / sw, 0.5 / sh);
        this.downU.uThreshold.value = i === 0 ? 1.6 : 0;
        r.setRenderTarget(b.down);
        r.render(this.downPass.scene, this.cam);
        src = b.down.texture; sw = b.w; sh = b.h;
      });
      for (let i = this.bloomRTs.length - 1; i >= 0; i--) {
        const b = this.bloomRTs[i];
        const lower = this.bloomRTs[i + 1];
        this.upU.tSrc.value = lower ? lower.up.texture : b.down.texture;
        this.upU.tPrev.value = lower ? b.down.texture : this.blackTex();
        this.upU.uTexel.value.set(1 / b.w, 1 / b.h);
        r.setRenderTarget(b.up);
        r.render(this.upPass.scene, this.cam);
      }
    }

    r.setRenderTarget(null);
    r.render(this.compPass.scene, this.cam);
  }
}
