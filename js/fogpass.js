// Karl himself: a raymarched volumetric marine layer, rendered as a half-res
// post pass against the scene depth buffer, then composited with tone mapping.
//
// The fog density field is shaped like the real thing:
//  · a blanket that advances eastward from the Pacific
//  · a jet that pours through the Golden Gate and fans out into the bay
//  · blocked by the Twin Peaks ridge until the marine layer is deep enough to spill over
//  · capped by the inversion (uFogTop), wisped up with drifting 3-D noise

import * as THREE from 'three';
import { KMP, hU } from './geo.js';

const fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fogFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;

  uniform float uIntensity;   // 0..1 how much Karl
  uniform float uFogTop;      // inversion height, world units
  uniform float uDensity;     // extinction per unit at the core
  uniform float uReachW;      // km the west blanket has advanced past the shoreline
  uniform float uReachG;      // km the gate jet has traveled into the bay
  uniform float uSpill;       // km of ridge-line forgiveness once fog tops the peaks
  uniform float uBlanket;     // 0..1 everything-is-gone factor
  uniform vec3 uNoiseOff;     // wind-advected noise offset
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uFogAmb;
  uniform float uGlowK;       // night city glow strength
  uniform float uJitter;

  // geography constants (km, +x east, +y south to match world z)
  uniform vec2 uGateKm;
  uniform vec2 uGateDir;
  uniform float uShoreKm;
  uniform float uXRidge;
  uniform float uZPres;
  uniform vec2 uDowntownKm;

  float hash13(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 3; i++) {
      s += a * vnoise(p);
      p = p * 2.13 + vec3(11.7, 5.1, 7.3);
      a *= 0.5;
    }
    return s;
  }

  // horizontal fog coverage at a point (xz in world units)
  float coverage(vec2 xz) {
    vec2 km = xz * 0.1;

    // wobble the front edge so it never looks like a wall chart
    float wob = (fbm(vec3(km.y * 0.32, km.x * 0.08, 3.7) + uNoiseOff * 0.06) - 0.5) * 3.2;

    // — west blanket —
    float frontX = uShoreKm + uReachW;
    // south of the Presidio the central ridge holds the line until fog tops it
    float ridgeGate = smoothstep(uZPres - 1.2, uZPres + 1.2, km.y);
    float capX = mix(60.0, uXRidge + uSpill, ridgeGate);
    float frontEff = min(frontX, capX);
    float cw = smoothstep(frontEff + 1.6, frontEff - 1.8, km.x + wob);

    // — Golden Gate jet —
    vec2 g = km - uGateKm;
    float de = dot(g, uGateDir);                       // distance along the jet
    float lat = abs(g.x * (-uGateDir.y) + g.y * uGateDir.x);
    float spread = 1.0 + max(de, 0.0) * 0.55;
    float cg = smoothstep(uReachG, uReachG - 2.5, de)
             * smoothstep(spread, spread * 0.45, lat + wob * 0.35)
             * smoothstep(-9.0, -6.0, de);

    // — total whiteout —
    float c = max(max(cw, cg), uBlanket);
    return clamp(c, 0.0, 1.0);
  }

  float density(vec3 p) {
    if (p.y > uFogTop + 1.0 || p.y < -0.5) return 0.0;
    float cov = coverage(p.xz);
    if (cov < 0.01) return 0.0;

    // marine layer profile: dense low, soft rounded top
    float vert = smoothstep(uFogTop + 0.6, uFogTop - 1.8, p.y) * (0.72 + 0.28 * smoothstep(3.2, 0.0, p.y));

    vec3 np = p * vec3(0.055, 0.11, 0.055) + uNoiseOff;
    float n = fbm(np);
    float shape = cov * vert;
    float d = clamp(shape * 1.25 - (1.0 - n) * 0.55, 0.0, 1.0);
    return uDensity * d;
  }

  void main() {
    float depth = texture2D(tDepth, vUv).x;
    vec3 ndc = vec3(vUv * 2.0 - 1.0, depth * 2.0 - 1.0);
    vec4 vp = uProjInv * vec4(ndc, 1.0);
    vp /= vp.w;
    vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;

    vec3 ro = uCamPos;
    vec3 rd = wp - ro;
    float surfDist = length(rd);
    rd /= surfDist;
    if (depth > 0.99995) surfDist = 1e5;   // sky
    float maxT = min(surfDist, 620.0);

    float j = hash13(vec3(gl_FragCoord.xy, uJitter));

    const int N = 44;
    float T = 1.0;
    vec3 acc = vec3(0.0);
    float prevT = 0.0;

    float mu = dot(rd, uSunDir);
    // Henyey–Greenstein-ish forward scattering, g = 0.5
    float phase = 0.7 * (1.0 - 0.25) / pow(1.0 + 0.25 - 1.0 * mu, 1.5) * 0.25 + 0.18;

    for (int i = 0; i < N; i++) {
      float fi = (float(i) + j) / float(N);
      float t = pow(fi, 1.55) * maxT;
      float dt = t - prevT;
      prevT = t;
      if (dt <= 0.0) continue;

      vec3 p = ro + rd * t;
      float sig = density(p);
      if (sig > 1e-4) {
        // how shadowed by the fog above
        float sh = exp(-uDensity * 0.30 * clamp(uFogTop - p.y, 0.0, uFogTop) / max(uSunDir.y, 0.12));
        sh = max(sh, 0.05);

        vec3 src = uFogAmb * 0.85 + uSunCol * phase * sh * max(uSunDir.y + 0.06, 0.0) * 1.35;

        // city glow seeping up through Karl at night
        if (uGlowK > 0.002) {
          vec2 dkm = p.xz * 0.1 - uDowntownKm;
          float glow = exp(-dot(dkm, dkm) / 14.0) * exp(-max(p.y, 0.0) * 0.45);
          src += vec3(1.0, 0.55, 0.25) * glow * uGlowK * 2.2;
        }

        float a = exp(-sig * dt);
        acc += T * (1.0 - a) * src;
        T *= a;
        if (T < 0.015) { T = 0.0; break; }
      }
    }

    gl_FragColor = vec4(acc, T);
  }
`;

const compositeFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tFog;
  uniform float uTime;

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 scene = texture2D(tScene, vUv).rgb;
    vec4 fog = texture2D(tFog, vUv);
    vec3 col = scene * fog.a + fog.rgb;

    col = aces(col * 1.05);
    col = pow(col, vec3(1.0 / 2.2));

    // gentle vignette
    vec2 q = vUv - 0.5;
    col *= 1.0 - dot(q, q) * 0.45;

    // whisper of animated grain so gradients never band
    float g = fract(sin(dot(vUv * 911.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    col += (g - 0.5) * 0.012;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function fullscreenTriangle() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return geo;
}

export class FogPipeline {
  constructor(renderer) {
    this.renderer = renderer;

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.floor(size.x * pr), h = Math.floor(size.y * pr);

    const depthTexture = new THREE.DepthTexture(w, h);
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture,
      samples: 0,
    });
    this.fogRT = new THREE.WebGLRenderTarget(Math.floor(w / 2), Math.floor(h / 2), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });

    // geography constants for the shader (km space: x east, y south)
    const gate = KMP(-122.4780, 37.8185);
    const alca = KMP(-122.4230, 37.8270);
    const gdir = new THREE.Vector2(alca[0] - gate[0], alca[1] - gate[1]).normalize();
    const downtown = KMP(-122.3985, 37.7905);
    const shore = KMP(-122.5095, 37.7750)[0];
    const ridgeX = KMP(-122.4520, 37.76)[0];
    const presZ = KMP(-122.46, 37.7980)[1];

    this.fogUniforms = {
      tDepth: { value: depthTexture },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uIntensity: { value: 0.5 },
      uFogTop: { value: hU(400) },
      uDensity: { value: 0.6 },
      uReachW: { value: 5 },
      uReachG: { value: 10 },
      uSpill: { value: 0 },
      uBlanket: { value: 0 },
      uNoiseOff: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color('#fff3e0') },
      uFogAmb: { value: new THREE.Color('#cfd8de') },
      uGlowK: { value: 0 },
      uJitter: { value: 0 },
      uGateKm: { value: new THREE.Vector2(gate[0], gate[1]) },
      uGateDir: { value: gdir },
      uShoreKm: { value: shore },
      uXRidge: { value: ridgeX },
      uZPres: { value: presZ },
      uDowntownKm: { value: new THREE.Vector2(downtown[0], downtown[1]) },
    };

    this.compUniforms = {
      tScene: { value: this.sceneRT.texture },
      tFog: { value: this.fogRT.texture },
      uTime: { value: 0 },
    };

    const tri = fullscreenTriangle();
    this.fogScene = new THREE.Scene();
    this.fogScene.add(new THREE.Mesh(tri, new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: fogFrag,
      uniforms: this.fogUniforms,
      depthTest: false,
      depthWrite: false,
    })));

    this.compScene = new THREE.Scene();
    this.compScene.add(new THREE.Mesh(tri.clone(), new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: compositeFrag,
      uniforms: this.compUniforms,
      depthTest: false,
      depthWrite: false,
    })));

    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(w, h, pr) {
    const W2 = Math.floor(w * pr), H2 = Math.floor(h * pr);
    this.sceneRT.setSize(W2, H2);
    this.fogRT.setSize(Math.max(2, Math.floor(W2 / 2)), Math.max(2, Math.floor(H2 / 2)));
  }

  render(scene, camera, time) {
    const r = this.renderer;
    const u = this.fogUniforms;

    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    u.uJitter.value = (time % 10);
    this.compUniforms.uTime.value = time % 100;

    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    r.setRenderTarget(this.fogRT);
    r.render(this.fogScene, this.quadCam);

    r.setRenderTarget(null);
    r.render(this.compScene, this.quadCam);
  }
}
