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

    vec3 dayZen  = vec3(0.30, 0.50, 0.72);
    vec3 dayHor  = vec3(0.78, 0.84, 0.88);
    vec3 nightZen = vec3(0.012, 0.022, 0.045);
    vec3 nightHor = vec3(0.05, 0.075, 0.11);

    vec3 zen = mix(nightZen, dayZen, uDayF);
    vec3 hor = mix(nightHor, dayHor, uDayF);
    vec3 col = mix(zen, hor, pow(1.0 - max(ele, 0.0), 1.7));

    // sunset band toward the sun
    vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
    float toward = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), sunH), 0.0);
    float band = pow(toward, 3.0) * pow(1.0 - abs(ele), 4.0) * uDuskF;
    col += vec3(0.95, 0.42, 0.15) * band * 0.85;

    // sun disc + halo
    float s = max(dot(dir, uSunDir), 0.0);
    col += uSunCol * (pow(s, 1100.0) * 6.0 + pow(s, 24.0) * 0.16) * smoothstep(-0.06, 0.02, uSunDir.y);

    // stars
    float night = 1.0 - uDayF;
    if (night > 0.35 && ele > 0.02) {
      vec3 sp = floor(dir * 220.0);
      float h = hash(sp);
      float star = step(0.9965, h) * (0.4 + 0.6 * hash(sp + 1.7));
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

    // ambient color the fog volume scatters
    this._fogAmb.set('#141c26').lerp(this._tmpA.set('#cfd8de'), dayF);
    this._fogAmb.lerp(this._tmpA.set('#e8a268'), duskF * 0.35);

    // aerial perspective tint follows the sky
    this.fog.color.copy(this._tmpA.set('#10161e').lerp(this._tmpB.set('#aebdc9'), dayF));

    return {
      sunDir: dir,
      elev,
      dayF,
      duskF,
      nightF,
      fogAmb: this._fogAmb,
      sunCol: this._sunCol,
    };
  }
}
