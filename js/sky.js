// Sky dome, sun position, and the scene lighting rig. Day/night follows the sim clock.

import * as THREE from 'three';

const DEG = Math.PI / 180;

// Approximate solar position for a JS Date at San Francisco.
// Returns { dir: THREE.Vector3 toward the sun, elev: degrees }
export function sunPosition(date, lat = 37.776, lon = -122.44) {
  const dayMs = 86400000;
  const start = new Date(date.getFullYear(), 0, 0);
  const n = (date - start) / dayMs;
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (n + 10)) * DEG;
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarH = utcH + lon / 15;          // approximate solar time, hours
  const H = (solarH * 15 - 180) * DEG;     // hour angle, 0 at solar noon
  const la = lat * DEG;
  const sinE = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinE)));
  // azimuth measured from south, positive toward west
  const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(decl) * Math.cos(la));
  const cosE = Math.cos(elev);
  // world: +x east, +z south, +y up
  const dir = new THREE.Vector3(-Math.sin(A) * cosE, Math.sin(elev), Math.cos(A) * cosE);
  return { dir, elev: elev / DEG };
}

const skyVert = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFrag = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform float uDayF;    // 0 night — 1 day
  uniform float uDuskF;   // peaks at sunrise/sunset
  uniform vec3 uSunCol;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vWorld - uCamPos);
    float ele = dir.y;

    // three-stop gradient: horizon haze, mid sky, zenith
    vec3 dayZen = vec3(0.16, 0.35, 0.64);
    vec3 dayMid = vec3(0.50, 0.65, 0.80);
    vec3 dayHor = vec3(0.83, 0.87, 0.89);
    vec3 nightZen = vec3(0.008, 0.014, 0.032);
    vec3 nightMid = vec3(0.020, 0.032, 0.060);
    vec3 nightHor = vec3(0.050, 0.070, 0.105);

    vec3 zen = mix(nightZen, dayZen, uDayF);
    vec3 mid = mix(nightMid, dayMid, uDayF);
    vec3 hor = mix(nightHor, dayHor, uDayF);
    vec3 col = mix(hor, mid, smoothstep(0.0, 0.14, ele));
    col = mix(col, zen, smoothstep(0.10, 0.62, ele));

    vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
    float toward = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), sunH), 0.0);

    // daytime warm haze pooling around the sun's side of the horizon
    col += vec3(0.30, 0.24, 0.16) * pow(toward, 2.0) * pow(1.0 - max(ele, 0.0), 6.0) * uDayF * 0.5;

    // dusk: fire toward the sun, a violet counter-glow opposite
    float lowBand = pow(1.0 - abs(ele), 5.0);
    col += vec3(0.98, 0.42, 0.14) * pow(toward, 2.6) * lowBand * uDuskF * 1.05;
    col += vec3(0.99, 0.62, 0.30) * pow(toward, 8.0) * lowBand * uDuskF * 0.85;
    col += vec3(0.38, 0.26, 0.44) * pow(1.0 - toward, 2.0) * pow(1.0 - abs(ele), 6.5) * uDuskF * 0.30;

    // sun disc + layered halo
    float s = max(dot(dir, uSunDir), 0.0);
    float sunUp = smoothstep(-0.06, 0.02, uSunDir.y);
    col += uSunCol * (pow(s, 1100.0) * 6.0 + pow(s, 80.0) * 0.35 + pow(s, 10.0) * 0.10) * sunUp;

    // stars: round points, not lit grid cells
    float night = 1.0 - uDayF;
    if (night > 0.35 && ele > 0.02) {
      vec3 sp = dir * 220.0;
      vec3 cell = floor(sp);
      float h = hash(cell);
      float d = length(fract(sp) - 0.5);
      float star = step(0.9945, h) * smoothstep(0.32, 0.04, d) * (0.35 + 0.65 * hash(cell + 1.7));
      col += vec3(star) * night * smoothstep(0.02, 0.2, ele);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class SkyRig {
  constructor(scene) {
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDayF: { value: 1 },
      uDuskF: { value: 0 },
      uSunCol: { value: new THREE.Color('#fff3e0') },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 18), mat);
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight('#ffffff', 3);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.near = 220;
    sh.camera.far = 900;
    sh.camera.left = -130; sh.camera.right = 130;
    sh.camera.top = 130; sh.camera.bottom = -130;
    sh.bias = -0.0004;
    sh.normalBias = 0.12;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight('#bcd2e8', '#5d564a', 0.8);
    scene.add(this.hemi);

    this.amb = new THREE.AmbientLight('#27313f', 0.25);
    scene.add(this.amb);

    this.fog = new THREE.FogExp2('#aebdc9', 0.00055); // faint aerial perspective
    scene.fog = this.fog;

    this._sunCol = new THREE.Color();
    this._fogAmb = new THREE.Color();
    this._skyHor = new THREE.Color();
    this._skyZen = new THREE.Color();
    this._tmpA = new THREE.Color();
    this._tmpB = new THREE.Color();
  }

  // returns colors the fog pass needs
  update(date, camera) {
    const { dir, elev } = sunPosition(date);
    const dayF = THREE.MathUtils.smoothstep(elev, -9, 12);
    const duskF = Math.exp(-Math.pow(elev / 9, 2));
    const nightF = 1 - THREE.MathUtils.smoothstep(elev, -10, 2);

    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uDayF.value = dayF;
    this.uniforms.uDuskF.value = duskF;
    this.dome.position.copy(camera.position);

    // sun light
    this._sunCol.set('#fff3e0').lerp(this._tmpA.set('#ff7430'), Math.pow(duskF, 1.5) * 0.9);
    this.uniforms.uSunCol.value.copy(this._sunCol);
    this.sun.color.copy(this._sunCol);
    this.sun.intensity = 3.4 * THREE.MathUtils.smoothstep(elev, -3, 10);
    this.sun.position.copy(dir).multiplyScalar(500);
    this.sun.target.position.set(0, 0, 0);

    // hemisphere + ambient
    this.hemi.color.copy(this._tmpA.set('#0d1722').lerp(this._tmpB.set('#bcd2e8'), dayF));
    this.hemi.groundColor.copy(this._tmpA.set('#070a0e').lerp(this._tmpB.set('#6b6354'), dayF));
    this.hemi.intensity = 0.34 + 0.55 * dayF;
    this.amb.intensity = 0.06 + 0.3 * (1 - dayF); // a little moonlight

    // ambient color the fog volume scatters — barely warmed at dusk;
    // dense fog saturates to this color, and too much warmth reads as mud
    this._fogAmb.set('#141c26').lerp(this._tmpA.set('#cfd8de'), dayF);
    this._fogAmb.lerp(this._tmpA.set('#dfa878'), duskF * 0.16);

    // aerial perspective tint follows the sky
    this.fog.color.copy(this._tmpA.set('#10161e').lerp(this._tmpB.set('#aebdc9'), dayF));

    // sky colors the water reflects (match the dome shader's stops)
    this._skyHor.set('#0d1219').lerp(this._tmpA.set('#d4dee3'), dayF);
    this._skyHor.lerp(this._tmpA.set('#e89050'), duskF * 0.4);
    this._skyZen.set('#020408').lerp(this._tmpA.set('#2959a3'), dayF);

    return {
      sunDir: dir,
      elev,
      dayF,
      duskF,
      nightF,
      fogAmb: this._fogAmb,
      sunCol: this._sunCol,
      skyHor: this._skyHor,
      skyZen: this._skyZen,
      fogColor: this.fog.color,
      fogDensity: this.fog.density,
    };
  }
}
