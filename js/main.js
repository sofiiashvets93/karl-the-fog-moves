// Karl — the San Francisco Fog. Boot, simulation clock, render loop.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { W, hU } from './geo.js';
import { buildWorld } from './world.js';
import { SkyRig } from './sky.js';
import { FogPipeline } from './fogpass.js';
import { Weather } from './weather.js';
import { UI } from './ui.js';

const canvas = document.getElementById('scene');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.getContext().getParameter) throw new Error('no gl');
} catch (e) {
  document.getElementById('webgl-fail').classList.remove('hidden');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping; // the composite pass tone-maps

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 5200);

// ————— camera viewpoints —————
const gateW = W(-122.4780, 37.8190);
const twinW = W(-122.4477, 37.7544);
const dtW = W(-122.3985, 37.7905);

const VIEWS = {
  ocean:    { pos: [-118, 34, 64], tgt: [0, 2, -14] },
  gate:     { pos: [gateW[0] - 6, 3.4, gateW[1] + 7], tgt: [gateW[0] + 2, 2.8, gateW[1] - 4] },
  downtown: { pos: [dtW[0] + 48, 14, dtW[1] - 26], tgt: [dtW[0] - 14, 2, dtW[1] + 6] },
  above:    { pos: [twinW[0] + 14, 95, twinW[1] + 60], tgt: [twinW[0], 0, twinW[1] - 18] },
};

camera.position.set(...VIEWS.ocean.pos);

const controls = new OrbitControls(camera, canvas);
controls.target.set(...VIEWS.ocean.tgt);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 6;
controls.maxDistance = 420;
controls.autoRotate = true;
controls.autoRotateSpeed = -0.22;
canvas.addEventListener('pointerdown', () => { controls.autoRotate = false; }, { once: true });

// camera fly-to tween
let camTween = null;
function flyTo(view) {
  camTween = {
    p0: camera.position.clone(),
    t0: controls.target.clone(),
    p1: new THREE.Vector3(...view.pos),
    t1: new THREE.Vector3(...view.tgt),
    k: 0,
  };
  controls.autoRotate = false;
}

document.querySelectorAll('#views button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#views button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    flyTo(VIEWS[b.dataset.view]);
  });
});

// ————— build the world —————
const sky = new SkyRig(scene);
const { cityLights } = await buildWorld(scene); // loads the baked USGS heightfield
const fogPipe = new FogPipeline(renderer);

// ————— simulation clock —————
const NOW = Date.now();
const sim = {
  t: NOW,
  live: true,       // tracking the real clock
  playing: false,
  speed: 3600,      // sim seconds per real second when playing (1h ≈ 1s)
  span: { t0: NOW - 2 * 3600e3, t1: NOW + 24 * 3600e3 },
};

// ————— weather + UI —————
const weather = new Weather();
let ui = null;

weather.load().then(() => {
  ui = new UI(sim, weather);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('loading').classList.add('gone');
  setTimeout(() => document.getElementById('loading').remove(), 1100);
});

// smoothed fog parameters, eased toward their targets so scrubbing never pops
const smooth = {
  I: 0.4, reachW: 4, reachG: 8, fogTop: hU(350), density: 0.5, blanket: 0, glow: 0,
};
function ease(cur, target, dt, rate = 5) {
  return cur + (target - cur) * (1 - Math.exp(-dt * rate));
}

// ————— resize —————
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  fogPipe.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
});

// ————— main loop —————
const clock = new THREE.Clock();
let noiseT = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  const elapsed = clock.elapsedTime;

  // advance the sim clock
  if (sim.playing) {
    sim.t += dt * sim.speed * 1000;
    if (sim.t > sim.span.t1) sim.t = Date.now(); // wrap back to the present
  } else if (sim.live) {
    sim.t = Date.now();
  }

  // weather targets at the sim time
  const I = weather.intensityAt(sim.t);
  const simHours = (sim.t - NOW) / 3600e3;
  noiseT = simHours * 4.0 + elapsed * 0.10;

  smooth.I = ease(smooth.I, I, dt);
  smooth.reachW = ease(smooth.reachW, -2.5 + 26 * Math.pow(smooth.I, 1.2), dt);
  smooth.reachG = ease(smooth.reachG, 30 * Math.pow(smooth.I, 1.1), dt);
  smooth.fogTop = ease(smooth.fogTop, hU(170 + 430 * smooth.I), dt);
  smooth.density = ease(smooth.density, 0.14 + 0.62 * Math.pow(smooth.I, 1.4), dt);
  smooth.blanket = ease(smooth.blanket, THREE.MathUtils.smoothstep(smooth.I, 0.78, 0.96), dt);

  // sun, sky, lights
  const skyState = sky.update(new Date(sim.t), camera);
  cityLights.material.opacity = skyState.nightF * 0.95;
  smooth.glow = ease(smooth.glow, skyState.nightF * Math.min(smooth.I * 1.4, 1), dt);

  // feed the fog
  const u = fogPipe.fogUniforms;
  u.uIntensity.value = smooth.I;
  u.uFogTop.value = smooth.fogTop;
  u.uDensity.value = smooth.density;
  u.uReachW.value = smooth.reachW;
  u.uReachG.value = smooth.reachG;
  u.uSpill.value = Math.max(0, smooth.fogTop - hU(280)) * 0.35 * 10; // km of ridge spill
  u.uBlanket.value = smooth.blanket;
  u.uNoiseOff.value.set(noiseT * 0.55, noiseT * 0.06, noiseT * 0.18);
  u.uSunDir.value.copy(skyState.sunDir);
  u.uSunCol.value.copy(skyState.sunCol).multiplyScalar(0.55);
  u.uFogAmb.value.copy(skyState.fogAmb);
  u.uGlowK.value = smooth.glow;

  // camera tween
  if (camTween) {
    camTween.k = Math.min(1, camTween.k + dt / 1.6);
    const e = 1 - Math.pow(1 - camTween.k, 3);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (camTween.k >= 1) camTween = null;
  }
  controls.update();

  fogPipe.render(scene, camera, elapsed);
  if (ui) ui.update(Date.now());
}

frame();
