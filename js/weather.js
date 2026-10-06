// Forecast data from Open-Meteo (https://open-meteo.com), and what the app
// derives from it. Everything here is model output, not observation:
//   · hourly forecast at six points around San Francisco (low/mid/high cloud,
//     visibility, wind, temperature, dew point), including the last few hours
//   · optionally, a humidity/temperature profile at the coast to estimate how
//     deep the marine layer is
// If the network fails, a recent cached forecast is used; failing that, an
// illustrative fog-season day that is labeled as such everywhere.

import { W } from './geo.js';
import { sunPosition } from './sky.js';

export const POINTS = [
  { id: 'offshore', name: 'Offshore', lat: 37.765, lon: -122.62 },
  { id: 'ocean', name: 'Ocean Beach', lat: 37.760, lon: -122.508 },
  { id: 'gate', name: 'Golden Gate', lat: 37.808, lon: -122.476 },
  { id: 'twin', name: 'Twin Peaks', lat: 37.752, lon: -122.447 },
  { id: 'downtown', name: 'Downtown', lat: 37.792, lon: -122.400 },
  { id: 'bay', name: 'Central Bay', lat: 37.823, lon: -122.400 },
].map((p) => { const [x, z] = W(p.lon, p.lat); return { ...p, x, z }; });

const SF = ['ocean', 'gate', 'twin', 'downtown'].map((id) => POINTS.findIndex((p) => p.id === id));
const INLAND = ['gate', 'twin', 'downtown', 'bay'].map((id) => POINTS.findIndex((p) => p.id === id));
const OFFSHORE = POINTS.findIndex((p) => p.id === 'offshore');
const COAST = POINTS.findIndex((p) => p.id === 'ocean');
const GATE = POINTS.findIndex((p) => p.id === 'gate');

const BASE = 'https://api.open-meteo.com/v1/forecast';
const CORE_VARS = 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_direction_10m,temperature_2m,dew_point_2m';
const LEVELS = [1000, 975, 950, 925, 900, 850];
const PROFILE_VARS = LEVELS.flatMap((l) => [`relative_humidity_${l}hPa`, `temperature_${l}hPa`, `geopotential_height_${l}hPa`]).join(',');
const COMMON = '&past_hours=6&forecast_days=3&timeformat=unixtime&wind_speed_unit=ms&timezone=GMT';
const CACHE_KEY = 'karl-forecast-v2';

async function getJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

export class Weather {
  constructor() {
    this.state = 'loading';   // loading | live | cached | illustrative
    this.error = null;        // plain-language reason when not live
    this.fetchedAt = null;
    this.profile = false;     // whether the marine-layer depth came from the profile
    this.hours = [];          // per hour, see _derive()
    this.illustrative = false;
  }

  async load() {
    const lat = POINTS.map((p) => p.lat).join(','), lon = POINTS.map((p) => p.lon).join(',');
    try {
      const core = await getJSON(`${BASE}?latitude=${lat}&longitude=${lon}&hourly=${CORE_VARS}${COMMON}`);
      let profile = null;
      try {
        const c = POINTS[COAST];
        profile = await getJSON(`${BASE}?latitude=${c.lat}&longitude=${c.lon}&hourly=${PROFILE_VARS}${COMMON}`, 7000);
      } catch (e) {
        console.info('Marine-layer profile unavailable; estimating layer depth.', e.message);
      }
      this._ingest(core, profile);
      this.state = 'live';
      this.fetchedAt = Date.now();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: this.fetchedAt, core, profile })); } catch { /* private mode */ }
    } catch (e) {
      this.error = e.name === 'AbortError' ? 'The forecast service did not respond.' : 'The forecast could not be loaded.';
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { /* ignore */ }
      if (cached && Date.now() - cached.at < 12 * 3600e3) {
        this._ingest(cached.core, cached.profile);
        this.state = 'cached';
        this.fetchedAt = cached.at;
      } else {
        this._illustrative();
      }
    }
    return this;
  }

  // ————— ingest the API response —————
  _ingest(core, profile) {
    const locs = Array.isArray(core) ? core : [core];
    const t = locs[0].hourly.time.map((s) => s * 1000);
    const series = (v) => locs.map((L) => L.hourly[v] || []);
    const low = series('cloud_cover_low'), mid = series('cloud_cover_mid'), high = series('cloud_cover_high');
    const vis = series('visibility'), ws = series('wind_speed_10m'), wd = series('wind_direction_10m');
    const temp = series('temperature_2m'), dew = series('dew_point_2m');
    let prof = null;
    if (profile && profile.hourly) {
      const H = profile.hourly;
      const ptimes = new Map(H.time.map((s, i) => [s * 1000, i]));
      prof = (ms) => {
        const i = ptimes.get(ms);
        if (i == null) return null;
        return LEVELS.map((l) => ({
          rh: H[`relative_humidity_${l}hPa`]?.[i], t: H[`temperature_${l}hPa`]?.[i], z: H[`geopotential_height_${l}hPa`]?.[i],
        }));
      };
    }
    this.profile = !!prof;
    this.illustrative = false;
    this._cum = null;
    this.hours = t.map((ms, k) => this._derive(ms, {
      low: low.map((s) => s[k] ?? 0), mid: mid.map((s) => s[k] ?? 0), high: high.map((s) => s[k] ?? 0),
      vis: vis.map((s) => s[k]), ws: ws.map((s) => s[k]), wd: wd.map((s) => s[k]),
      temp: temp.map((s) => s[k]), dew: dew.map((s) => s[k]),
    }, prof ? prof(ms) : null));
  }

  // marine-layer top (m) from the coastal profile: top of the saturated layer,
  // else the base of the temperature inversion
  static layerTop(levels) {
    if (!levels || levels.some((l) => l.rh == null || l.z == null)) return null;
    let top = null;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i].rh >= 88) top = levels[i].z; else break;
    }
    if (top != null) {
      const above = levels[levels.findIndex((l) => l.z === top) + 1];
      return above ? (top + above.z) / 2 : top;
    }
    for (let i = 0; i + 1 < levels.length; i++) {
      if (levels[i + 1].t != null && levels[i].t != null && levels[i + 1].t > levels[i].t + 0.3) return (levels[i].z + levels[i + 1].z) / 2;
    }
    return null;
  }

  _derive(ms, d, levels) {
    const avg = (arr, idx) => idx.reduce((s, i) => s + (arr[i] ?? 0), 0) / idx.length;
    const fog = avg(d.low, SF);                     // forecast low-cloud cover, SF average (%)
    const inland = avg(d.low, INLAND) / 100;
    const visSF = SF.map((i) => d.vis[i]).filter((v) => v != null).sort((a, b) => a - b);
    const vis = visSF.length ? visSF[visSF.length >> 1] : null;
    const tC = avg(d.temp, SF), dewC = avg(d.dew, SF);
    const spread = (d.temp[COAST] ?? tC) - (d.dew[COAST] ?? dewC);
    const visCoast = d.vis[COAST];
    // cloud base from the surface dew-point spread (lifting condensation level ≈ 125 m/°C)
    let base = Math.max(0, Math.min(500, 125 * spread - 40));
    if (visCoast != null && visCoast < 1200) base = 0;
    let top = Weather.layerTop(levels);
    const fromProfile = top != null;
    if (top == null) top = 320 + 260 * inland;      // typical depth when we cannot see the profile
    // if the forecast puts low cloud on Twin Peaks, the layer must be deeper than the hill
    const twin = POINTS.findIndex((p) => p.id === 'twin');
    if (d.low[twin] > 60) top = Math.max(top, 360);
    top = Math.max(top, base + 120);
    const windFrom = d.wd[GATE] ?? 270, windSpeed = d.ws[GATE] ?? 5;
    const toward = ((windFrom + 180) * Math.PI) / 180;
    // world: +x east, +z south; direction the air moves toward
    const windX = Math.sin(toward) * windSpeed, windZ = -Math.cos(toward) * windSpeed;
    const visFog = Math.min(...d.vis.filter((v, i) => v != null && d.low[i] > 50), 20000);
    // solar heating of land (burns fog off from the inside out): sun height, less under high cloud
    const elev = sunPosition(new Date(ms)).elev;
    const heat = Math.max(0, Math.sin((elev * Math.PI) / 180)) * (1 - 0.4 * Math.min(1, (avg(d.mid, SF) + avg(d.high, SF)) / 100));
    return {
      t: ms,
      fog, low: d.low.slice(), mid: avg(d.mid, SF), high: avg(d.high, SF),
      vis, tempC: tC, dewC, windSpeed, windFrom, windX, windZ,
      base, top, fromProfile, heat,
      source: Math.min(1, (d.low[OFFSHORE] ?? fog) / 85 + 0.15 * inland),
      reach: 1500 + 36000 * smooth((inland - 0.06) / 0.86),
      dens: base > 40 ? 0.55 : Math.max(0.15, Math.min(1, 300 / Math.max(150, visFog))),
    };
  }

  // a typical fog-season day, used only when no forecast is available
  _illustrative() {
    this.state = 'illustrative';
    this.illustrative = true;
    this._cum = null;
    this.profile = false;
    const now = Date.now();
    const start = Math.floor(now / 3600e3) * 3600e3 - 6 * 3600e3;
    const pacificHour = (ms) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date(ms));
      return Number(parts) % 24;
    };
    const typical = (h) => {
      if (h < 9) return 0.86;
      if (h < 13) return 0.86 - 0.78 * smooth((h - 9) / 4);
      if (h < 17) return 0.08;
      if (h < 22) return 0.08 + 0.78 * smooth((h - 17) / 5);
      return 0.86;
    };
    this.hours = [];
    for (let k = 0; k < 6 + 72; k++) {
      const ms = start + k * 3600e3;
      const f = typical(pacificHour(ms));
      const low = POINTS.map((p) => {
        const west = Math.max(0, Math.min(1, (-122.40 - p.lon) / 0.12));
        return 100 * Math.min(1, f * (0.45 + 0.65 * west));
      });
      const ws = 4 + 6 * f;
      this.hours.push(this._derive(ms, {
        low, mid: low.map(() => 5), high: low.map(() => 15),
        vis: low.map((l) => 24000 * Math.pow(1 - l / 100, 2.4) + 200), ws: low.map(() => ws), wd: low.map(() => 275),
        temp: low.map(() => 14 + 6 * (1 - f)), dew: low.map(() => 12.5 + 1 * f),
      }, null));
    }
  }

  // ————— time interpolation —————
  _pair(ms) {
    const hs = this.hours;
    if (!hs.length) return null;
    if (ms <= hs[0].t) return [hs[0], hs[0], 0];
    if (ms >= hs[hs.length - 1].t) return [hs[hs.length - 1], hs[hs.length - 1], 0];
    let k = Math.floor((ms - hs[0].t) / 3600e3);
    k = Math.max(0, Math.min(hs.length - 2, k));
    while (k > 0 && hs[k].t > ms) k--;
    while (k < hs.length - 2 && hs[k + 1].t <= ms) k++;
    return [hs[k], hs[k + 1], (ms - hs[k].t) / (hs[k + 1].t - hs[k].t)];
  }

  at(ms, key) {
    const p = this._pair(ms);
    if (!p) return null;
    const [a, b, f] = p;
    const va = a[key], vb = b[key];
    if (va == null || vb == null) return va ?? vb;
    if (key === 'windFrom') {
      let d = vb - va;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return (va + d * f + 360) % 360;
    }
    return va + (vb - va) * f;
  }

  get span() {
    return this.hours.length ? { t0: this.hours[0].t, t1: this.hours[this.hours.length - 1].t } : null;
  }

  // cumulative wind drift (m) since the first hour: moves the fog texture
  // consistently with the forecast wind, and deterministically for any time
  drift(ms) {
    const hs = this.hours;
    if (!hs.length) return [0, 0];
    if (!this._cum) {
      this._cum = [[0, 0]];
      for (let k = 1; k < hs.length; k++) {
        const dt = (hs[k].t - hs[k - 1].t) / 1000;
        const p = this._cum[k - 1];
        this._cum.push([p[0] + (hs[k - 1].windX + hs[k].windX) / 2 * dt, p[1] + (hs[k - 1].windZ + hs[k].windZ) / 2 * dt]);
      }
    }
    const [a] = this._pair(ms);
    const k = Math.max(0, hs.indexOf(a));
    const dt = (ms - a.t) / 1000;
    const c = this._cum[k];
    return [c[0] + this.at(ms, 'windX') * dt, c[1] + this.at(ms, 'windZ') * dt];
  }
}
