// Karl — the San Francisco fog. Boot, simulation clock, quality, render loop.

import * as THREE from 'three';
import { AssetLoader } from './assets.js';
import { World } from './world.js';
import { SkyRig } from './sky.js';
import { Pipeline } from './fogpass.js';
import { FogField, noiseVolume } from './fogfield.js';
import { Weather } from './weather.js';
import { CameraRig } from './camera.js';
import { UI } from './ui.js';

const params = new URLSearchParams(location.search);
const STILL = params.has('still');            // render on demand only (testing)
const canvas = document.getElementById('scene');
const ui = new UI();

// ————— renderer —————
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
} catch (e) {
  ui.fatal('This map needs WebGL 2, which this browser or device does not provide. A recent Chrome, Edge, Firefox or Safari will work.');
  throw e;
}
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the composite pass encodes sRGB
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // re-rendered only when something it depends on changes

// ————— quality tiers —————
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(screen.width, screen.height) < 820;
const TIERS = {
  low: { pr: 1.0, fog: 0.33, steps: 22, shadow: 1024, msaa: 0, bloom: false, lod: 0.55 },
  medium: { pr: 1.25, fog: 0.42, steps: 30, shadow: 2048, msaa: 2, bloom: true, lod: 0.8 },
  high: { pr: 1.6, fog: 0.5, steps: 40, shadow: 4096, msaa: 4, bloom: true, lod: 1.0 },
};
const ORDER = ['low', 'medium', 'high'];
let tierName = params.get('q') || (coarse || small ? 'low' : 'medium');
if (!TIERS[tierName]) tierName = 'medium';
let tier = TIERS[tierName];

function pixelRatio() { return Math.min(window.devicePixelRatio || 1, tier.pr); }
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
// portrait screens get a taller field of view so the city is not cropped away
const fovFor = (aspect) => (aspect < 0.8 ? 58 : aspect < 1.2 ? 50 : 42);
const camera = new THREE.PerspectiveCamera(fovFor(window.innerWidth / window.innerHeight), window.innerWidth / window.innerHeight, 2, 140000);
const pipeline = new Pipeline(renderer, { fogScale: tier.fog, msaa: tier.msaa, bloom: tier.bloom });
pipeline.fogUniforms.uSteps.value = tier.steps;

// ————— simulation clock —————
const sim = {
  t: Date.now(),
  live: true,          // follows the real clock
  playing: false,
  speed: 1,            // multiplier of 1 forecast hour per second
  span: { t0: Date.now() - 6 * 3600e3, t1: Date.now() + 30 * 3600e3 },
};

// ————— load —————
const assets = new AssetLoader((p) => ui.progress(p));
const weather = new Weather();
const weatherReady = weather.load();
const world = new World(renderer, scene);
let sky, rig, fogField = null;

try {
  await world.load(assets, { lite: tierName === 'low' });
} catch (e) {
  console.error(e);
  ui.fatal('The map data could not be loaded. Check your connection and reload the page.');
  throw e;
}
sky = new SkyRig(renderer, scene, { shadowSize: tier.shadow });
world.attachSky(sky);
rig = new CameraRig(camera, canvas, world.solid, { obstacles: world.obstacles() });
applyTier();

pipeline.fogUniforms.tNoise.value = noiseVolume(64);
pipeline.fogUniforms.tSky.value = sky.skyRT.texture;
pipeline.fogUniforms.tGlow.value = world.glow;
pipeline.fogUniforms.uGlowRect.value.copy(world.glowRect);

await weatherReady;
setSpan();
fogField = new FogField(world.ground);
fogField.build(weather, sim.span).then(() => {
  pipeline.fogUniforms.tField.value = fogField.texture;
  pipeline.fogUniforms.uFogOn.value = 1;
  pipeline.fogUniforms.uMaxTop.value = Math.max(...weather.hours.map((h) => h.top)) + 60;
  requestRender();
}).catch((e) => console.error('fog field', e));

// top of the modeled fog layer at a point (where it is reasonably dense), or null
function fogTopAt(x, z) {
  if (!fogField || !fogField.texture) return null;
  const cov = fogField.coverageAt(x, z, sim.t);
  if (cov < 0.35) return null;
  return weather.at(sim.t, 'top') + 60;
}

// keep "Live" honest: refresh the forecast every 30 minutes while the page is open
setInterval(async () => {
  if (document.hidden || weather.illustrative || ui.typical) return;
  const prev = weather.state;
  await weather.load();
  if (weather.state === 'illustrative' && prev !== 'illustrative') return;
  setSpan();
  await fogField.build(weather, sim.span);
  pipeline.fogUniforms.tField.value = fogField.texture;
  pipeline.fogUniforms.uMaxTop.value = Math.max(...weather.hours.map((h) => h.top)) + 60;
  ui.dataChanged();
}, 30 * 60e3);

function setSpan() {
  const now = Date.now();
  const s = weather.span;
  sim.span = {
    t0: Math.max(s ? s.t0 : now - 6 * 3600e3, now - 6 * 3600e3),
    t1: Math.min(s ? s.t1 : now + 30 * 3600e3, now + 30 * 3600e3),
  };
}

ui.init({
  sim, weather, rig, world,
  onPreset: (name) => { rig.fly(name, 2.2, fogTopAt); requestRender(); },
  onRise: () => { const t = fogTopAt(camera.position.x, camera.position.z); if (t != null) rig.rise(t); requestRender(); },
  onRetry: async () => {
    await weather.load();
    setSpan();
    await fogField.build(weather, sim.span);
    pipeline.fogUniforms.tField.value = fogField.texture;
    pipeline.fogUniforms.uMaxTop.value = Math.max(...weather.hours.map((h) => h.top)) + 60;
    ui.dataChanged();
    requestRender();
  },
  onFields: async () => {
    setSpan();
    await fogField.build(weather, sim.span);
    pipeline.fogUniforms.tField.value = fogField.texture;
    pipeline.fogUniforms.uMaxTop.value = Math.max(...weather.hours.map((h) => h.top)) + 60;
    requestRender();
  },
  onQuality: (name) => { setTier(name, true); },
  onChange: () => requestRender(),
  tier: () => tierName,
});

function applyTier() {
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  pipeline.setSize(s.x, s.y);
  pipeline.setFogScale(tier.fog);
  pipeline.fogUniforms.uSteps.value = tier.steps;
  if (pipeline.sceneRT.samples !== tier.msaa) { pipeline.sceneRT.samples = tier.msaa; pipeline.sceneRT.dispose(); }
  pipeline.compUniforms.uBloomK.value = tier.bloom ? 0.06 : 0;
  sky.sun.shadow.mapSize.set(tier.shadow, tier.shadow);
  if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
  renderer.shadowMap.needsUpdate = true;
  world.terrain.lodBias = tier.lod;
  world.buildings.lodBias = tier.lod;
  world.trees.lodBias = tier.lod;
}

let autoTier = !params.has('q');
function setTier(name, fromUser = false) {
  if (fromUser) {
    autoTier = name === 'auto';
    if (autoTier) { ui.qualityChanged(tierName, true); return; }
  }
  if (!TIERS[name]) return;
  if (name !== tierName) {
    tierName = name;
    tier = TIERS[name];
    applyTier();
    requestRender();
  }
  ui.qualityChanged(name, autoTier);
}

// ————— resize / visibility —————
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = fovFor(camera.aspect);
  camera.updateProjectionMatrix();
  applyTier();
  requestRender();
});
let hidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  hidden = document.hidden;
  if (!hidden) { clock.getDelta(); requestRender(); }
});

// ————— frame —————
const clock = new THREE.Clock();
let elapsed = 0;
let frameTimes = [];
let lastAdapt = performance.now();
let pending = false;
let lastUiNow = 0;

function requestRender() {
  if (STILL || pending || hidden) return;
  pending = true;
  requestAnimationFrame(loop);
}

let lastFrameAt = 0;
function loop(now) {
  pending = false;
  if (hidden) return;
  // nothing moving and time not playing: half rate is plenty for water and drifting fog
  const idle = !sim.playing && !rig.tween && !rig.moving && performance.now() - lastInput > 1500;
  if (idle && now - lastFrameAt < 30) { requestRender(); return; }
  lastFrameAt = now;
  const t0 = performance.now();
  frame(Math.min(clock.getDelta(), 0.1));
  const ft = performance.now() - t0;
  adapt(ft);
  requestRender();   // the scene is always alive: water, drifting fog, clock
}
let lastInput = performance.now();
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true });
}

// shadow map: only when the light's view or the geometry it sees changes
const shadowKey = { pos: new THREE.Vector3(Infinity), sun: new THREE.Vector3(), frames: 0 };
function shadowsNeedUpdate(st) {
  const p = sky.sun.position;
  const moved = p.distanceToSquared(shadowKey.pos) > 0.25 || st.sunDir.angleTo(shadowKey.sun) > 0.0015;
  shadowKey.frames++;
  if (moved || shadowKey.frames > 45) {
    shadowKey.pos.copy(p);
    shadowKey.sun.copy(st.sunDir);
    shadowKey.frames = 0;
    renderer.shadowMap.needsUpdate = true;
  }
}

function frame(dt) {
  elapsed += dt;
  // advance the clock
  if (sim.playing) {
    sim.t += dt * sim.speed * 3600e3;
    if (sim.t >= sim.span.t1) { sim.t = sim.span.t1; sim.playing = false; ui.syncPlay(); }
  } else if (sim.live) {
    sim.t = Date.now();
  }
  const date = new Date(sim.t);
  const w = weather;
  const windX = w.at(sim.t, 'windX') ?? 4, windZ = w.at(sim.t, 'windZ') ?? 0;
  const high = (w.at(sim.t, 'high') ?? 10) / 100, mid = (w.at(sim.t, 'mid') ?? 5) / 100;
  const vis = w.at(sim.t, 'vis');
  const fog = (w.at(sim.t, 'fog') ?? 0) / 100;

  rig.update(dt);
  camera.updateMatrixWorld();

  const st = sky.update(date, camera, {
    haze: 0.12 + 0.3 * fog,
    cloudCover: Math.min(1, high * 0.9 + mid * 0.6),
    windX: windX * 3, windZ: windZ * 3, time: elapsed,
  });
  const camDist = camera.position.distanceTo(rig.controls.target);
  sky.fitShadow(rig.controls.target, camDist);
  shadowsNeedUpdate(st);

  world.terrain.update(camera);
  world.terrain.setNight(st.nightF);
  const litHour = litShare(date);
  world.buildings.update(camera, { nightK: st.nightF, litHour });
  world.landmarks.setNight(st.nightF, litHour);
  world.trees.update(camera, st);
  world.water.update(camera, st, { time: elapsed, windX, windZ });
  world.bridges.update(camera, renderer.getDrawingBufferSize(_v2).y, st.nightF);

  // the marine layer
  const u = pipeline.fogUniforms;
  if (fogField && fogField.texture) {
    u.uHourW.value = fogField.w(sim.t);
    const [dx, dz] = w.drift(sim.t);
    u.uDrift.value.set(dx, dz);
  }
  u.uTime.value = elapsed + (sim.t - Date.now()) / 1000 * 0.02;
  u.uSunDir.value.copy(st.sunDir);
  u.uSunCol.value.copy(st.sunColor);
  u.uSunI.value = st.sunIrr;
  u.uSkyAmb.value.copy(st.skyAmbient);
  u.uGroundAmb.value.copy(st.groundAmbient);
  u.uNight.value = st.nightF;
  // clear-air haze from forecast visibility. Forecast visibility tops out
  // around 20-24 km, so anything above 15 km means clear air; the marine layer
  // itself is handled by the fog volume, not by haze.
  let hazeVis = 90000;
  if (vis != null && vis < 15000 && fog < 0.4) hazeVis = THREE.MathUtils.clamp(vis * 2.5, 12000, 90000);
  u.uHaze0.value = 3.912 / hazeVis;
  pipeline.compUniforms.uExposure.value = 1.8 * (1 + 0.9 * st.duskF) + 3.2 * st.nightF;
  pipeline.compUniforms.uWB.value.copy(st.wb);

  // fog accumulates over frames while the view holds still; less so while playing
  pipeline.render(scene, camera, elapsed, { blend: sim.playing ? 0.6 : 0.3 });

  const now = performance.now();
  if (now - lastUiNow > 120) {
    lastUiNow = now;
    // is the camera inside the layer? (the view is white, which can look like an error)
    const top = fogTopAt(camera.position.x, camera.position.z);
    const base = weather.at(sim.t, 'base') ?? 0;
    ui.insideFog(top != null && camera.position.y < top - 50 && camera.position.y > base + 20 && !rig.tween);
    ui.update(st);
  }
}
const _v2 = new THREE.Vector2();

// share of windows lit: evenings bright, small hours dim (Pacific time)
function litShare(date) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(date)) % 24;
  if (h >= 17 && h < 23) return 1;
  if (h >= 23 || h < 1) return 0.7;
  if (h < 5) return 0.35;
  return 0.6;
}

// adaptive quality: step down when frames are slow, back up when there is room
function adapt(ft) {
  if (STILL || !autoTier) return;
  frameTimes.push(ft);
  if (frameTimes.length > 90) frameTimes.shift();
  const now = performance.now();
  if (now - lastAdapt < 4000 || frameTimes.length < 60) return;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = sorted[sorted.length >> 1];
  const i = ORDER.indexOf(tierName);
  if (p50 > 30 && i > 0) { setTier(ORDER[i - 1]); lastAdapt = now; frameTimes = []; }
  else if (p50 < 9 && i < ORDER.length - 1 && !coarse) { setTier(ORDER[i + 1]); lastAdapt = now; frameTimes = []; }
}

ui.ready();
if (STILL) frame(0.016); else requestRender();

// small hook for automated previews and debugging
window.karl = {
  sim, weather, rig, world, pipeline, renderer, camera, scene, get sky() { return sky; },
  setTime(ms) { sim.t = ms; sim.live = false; sim.playing = false; ui.syncPlay(); },
  view(name) { rig.set(name); },
  preset(name) { rig.fly(name, 0, fogTopAt); },
  frames(n = 1) { for (let i = 0; i < n; i++) frame(1 / 30); return renderer.info.render; },
  fogReady: () => !!(fogField && fogField.texture),
  tier: () => tierName,
  setTier,
};
