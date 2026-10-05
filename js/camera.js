// Camera: map-style controls with terrain collision, limits, presets, and
// smooth flights that any user input interrupts.

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { W } from './geo.js';

// presets: camera and target as [lon, lat, height m]
export const PRESETS = {
  pacific: { label: 'The Pacific', cam: [-122.531, 37.739, 1450], tgt: [-122.452, 37.797, 0] },
  gate: { label: 'Golden Gate', cam: [-122.5045, 37.8078, 330], tgt: [-122.4777, 37.8185, 95] },
  downtown: { label: 'Downtown', cam: [-122.3745, 37.7742, 520], tgt: [-122.4005, 37.7925, 70] },
  above: { label: 'Above Karl', cam: [-122.476, 37.672, 5600], tgt: [-122.452, 37.778, 0] },
};

function presetVectors(p) {
  const [cx, cz] = W(p.cam[0], p.cam[1]);
  const [tx, tz] = W(p.tgt[0], p.tgt[1]);
  return { pos: new THREE.Vector3(cx, p.cam[2], cz), tgt: new THREE.Vector3(tx, p.tgt[2], tz) };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  constructor(camera, dom, ground, { obstacles = [] } = {}) {
    this.camera = camera;
    this.ground = ground;
    this.obstacles = obstacles; // [{ x, z, r, top }]: bridge towers etc.
    const c = new MapControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.minDistance = 120;
    c.maxDistance = 60000;
    c.maxPolarAngle = THREE.MathUtils.degToRad(84);
    c.rotateSpeed = 0.6;
    c.panSpeed = 1.0;
    c.zoomSpeed = 1.1;
    c.keyPanSpeed = 30;
    this.controls = c;
    this.tween = null;
    this.onChange = null;
    this._v = new THREE.Vector3();
    this._q = new THREE.Vector3();
    this.current = 'pacific';

    const stop = () => { if (this.tween) this.tween = null; };
    dom.addEventListener('pointerdown', stop);
    dom.addEventListener('wheel', stop, { passive: true });
    dom.addEventListener('touchstart', stop, { passive: true });
    c.addEventListener('start', () => { stop(); this.moving = true; });
    c.addEventListener('end', () => { this.moving = false; });
    this.moving = false;
    this.set('pacific');
  }

  set(name) {
    const { pos, tgt } = presetVectors(PRESETS[name]);
    this.camera.position.copy(pos);
    this.controls.target.copy(tgt);
    this.current = name;
    this.controls.update();
  }

  // fogTop(x, z) -> height of the fog layer's top where it is dense, or null
  fly(name, duration = 2.2, fogTop = null) {
    const p = PRESETS[name];
    if (!p) return;
    const { pos, tgt } = presetVectors(p);
    // a preset should show the fog, not put you inside it: rise above the top
    const top = fogTop ? fogTop(pos.x, pos.z) : null;
    if (top != null && pos.y < top + 140) {
      const lift = top + 140 - pos.y;
      pos.y += lift;
      tgt.y = Math.max(tgt.y, Math.min(top - 40, tgt.y + lift * 0.5));
    }
    this.flyTo(pos, tgt, duration);
    this.current = name;
  }

  rise(top) {
    const c = this.controls;
    const pos = this.camera.position.clone();
    pos.y = top + 160;
    this.flyTo(pos, c.target.clone(), 1.2);
  }

  flyTo(pos, tgt, duration = 1.6) {
    if (duration <= 0) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
      return;
    }
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const dist = p0.distanceTo(pos);
    // long flights arc upward so they never clip through hills or the bridge
    const lift = Math.min(3500, dist * 0.18);
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.tween = { p0, t0, p1: pos.clone(), t1: tgt.clone(), k: 0, dur: reduce ? 0.35 : Math.max(0.6, duration * Math.min(1.25, 0.55 + dist / 12000)), lift: reduce ? 0 : lift };
  }

  zoom(factor) {
    const c = this.controls;
    const dir = this._v.subVectors(this.camera.position, c.target);
    const d = THREE.MathUtils.clamp(dir.length() * factor, c.minDistance, c.maxDistance);
    dir.setLength(d);
    this.flyTo(c.target.clone().add(dir), c.target.clone(), 0.5);
  }

  // rotate to face north, keeping distance and tilt
  north() {
    const c = this.controls;
    const off = this._v.subVectors(this.camera.position, c.target);
    const horiz = Math.hypot(off.x, off.z);
    const pos = c.target.clone().add(new THREE.Vector3(0, off.y, horiz));
    this.flyTo(pos, c.target.clone(), 0.9);
  }

  // compass heading in degrees, 0 = looking north, clockwise
  heading() {
    const d = this.camera.getWorldDirection(this._q);
    return (THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z)) + 360) % 360;
  }

  update(dt) {
    const cam = this.camera, c = this.controls;
    if (this.tween) {
      const tw = this.tween;
      tw.k = Math.min(1, tw.k + dt / tw.dur);
      const e = ease(tw.k);
      cam.position.lerpVectors(tw.p0, tw.p1, e);
      cam.position.y += Math.sin(Math.PI * e) * tw.lift;
      c.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.k >= 1) this.tween = null;
    }
    c.update(dt);

    // keep the pivot on the ground so orbiting feels anchored
    const gt = Math.max(0, this.ground(c.target.x, c.target.z));
    if (!this.tween) c.target.y += (gt - c.target.y) * Math.min(1, dt * 2.5);
    // stay inside the map
    const R = 32000;
    c.target.x = THREE.MathUtils.clamp(c.target.x, -R, R);
    c.target.z = THREE.MathUtils.clamp(c.target.z, -R, R);

    // never inside a hill, the water, or a bridge tower
    const g = Math.max(0, this.ground(cam.position.x, cam.position.z));
    let minY = g + 35;
    for (const o of this.obstacles) {
      const d = Math.hypot(cam.position.x - o.x, cam.position.z - o.z);
      if (d < o.r) minY = Math.max(minY, o.top + 15 * (1 - d / o.r));
    }
    if (cam.position.y < minY) {
      const lift = minY - cam.position.y;
      cam.position.y = minY;
      if (!this.tween) c.target.y = Math.min(c.target.y + lift * 0.5, cam.position.y - 1);
    }

    // depth precision: the near plane follows height above the ground
    const above = Math.max(1, cam.position.y - g);
    const near = THREE.MathUtils.clamp(above * 0.25, 1.5, 120);
    const far = 140000;
    if (Math.abs(near - cam.near) > near * 0.05 || cam.far !== far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    if (this.onChange) this.onChange();
  }
}
