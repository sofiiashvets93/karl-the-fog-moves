// Interface: brand and data state, metrics, camera presets, the timeline,
// map controls, popovers and settings. All times are shown in San Francisco
// time, whatever the viewer's own time zone.

import { sunPosition } from './sky.js';
import { POINTS } from './weather.js';

const $ = (id) => document.getElementById(id);
const TZ = 'America/Los_Angeles';
const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });
const F_TIME = fmt({ hour: 'numeric', minute: '2-digit' });
const F_DAY = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const F_HOUR = fmt({ hour: 'numeric' });
const F_FULL = fmt({ weekday: 'long', hour: 'numeric', minute: '2-digit' });
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIR_NAMES = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const SPEEDS = [1, 2, 4];
const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { /* storage unavailable */ }
  return null;
}

export class UI {
  constructor() {
    this.units = store('karl-units') === 'metric' ? 'metric' : 'us';
  }

  // ————— loading —————
  progress(p) {
    $('load-fill').style.width = `${Math.round(4 + p * 96)}%`;
  }

  fatal(msg) {
    $('fatal-msg').textContent = msg;
    $('fatal').classList.remove('hidden');
    $('loading')?.classList.add('gone');
  }

  ready() {
    $('hud').classList.remove('hidden');
    this._resizeChart();
    $('loading').classList.add('gone');
    setTimeout(() => $('loading')?.remove(), 900);
    if (!store('karl-hinted')) {
      const h = $('hint');
      setTimeout(() => h.classList.add('show'), 900);
      setTimeout(() => h.classList.remove('show'), 5200);
      store('karl-hinted', '1');
    }
  }

  init({ sim, weather, rig, world, onPreset, onRise, onRetry, onFields, onQuality, onChange, tier }) {
    Object.assign(this, { sim, weather, rig, world, onPreset, onRise, onRetry, onQuality, onChange, tier });
    this.onRetryFields = onFields;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.chart = $('chart');
    this.ctx = this.chart.getContext('2d');
    this.typical = false;
    this._bind();
    window.addEventListener('resize', () => this._resizeChart());
    this.dataChanged();
    this.qualityChanged(tier(), true);
    this._unitsUI();
  }

  // ————— data state —————
  dataChanged() {
    const w = this.weather;
    const btn = $('state');
    btn.classList.remove('live', 'cached', 'illustrative', 'loading');
    const at = w.fetchedAt ? F_TIME.format(new Date(w.fetchedAt)) : null;
    let text, tip, fresh, desc;
    if (this.typical) {
      text = 'Illustrative'; btn.classList.add('illustrative');
      tip = 'Showing a typical fog-season day, not the forecast. Turn off “Typical fog day” in Settings to return to live data.';
      fresh = 'Illustrative day';
      desc = 'A typical fog-season day, for illustration.';
    } else if (w.state === 'live') {
      text = 'Live'; btn.classList.add('live');
      tip = `Forecast loaded at ${at} from Open-Meteo. Fog extent is modeled from it.`;
      fresh = `Forecast updated ${at}`;
      desc = 'Fog movement modeled from live forecast data.';
    } else if (w.state === 'cached') {
      text = 'Offline'; btn.classList.add('cached');
      tip = `${w.error} Showing the forecast saved at ${at}.`;
      fresh = `Saved forecast from ${at}`;
      desc = 'Fog modeled from a saved forecast.';
    } else {
      text = 'Unavailable'; btn.classList.add('illustrative');
      tip = `${w.error || 'The forecast is unavailable.'} Showing an illustrative fog-season day instead. Select to try again.`;
      fresh = 'Forecast unavailable';
      desc = 'Live data unavailable: showing an illustrative day.';
    }
    $('state-text').textContent = text;
    $('state-tip').textContent = tip;
    $('fresh').textContent = `· ${fresh}`;
    $('desc').textContent = desc;
    const illus = this.typical || w.state === 'illustrative';
    $('model-note').textContent = illus ? 'Illustrative data' : 'Modeled visualization';
    $('legend').innerHTML = illus ? 'Fog cover, % <span class="legend-sub">illustrative day, not a forecast</span>'
      : 'Fog cover, % <span class="legend-sub">forecast low cloud</span>';
    $('announcer').textContent = tip;
    this._sunMarks = null;
  }

  qualityChanged(name, auto) {
    const sel = auto ? 'auto' : name;
    document.querySelectorAll('#quality button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.q === sel)));
  }

  _unitsUI() {
    document.querySelectorAll('#units button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.u === this.units)));
    const m = this.units === 'metric';
    $('m-vis-u').textContent = m ? 'km' : 'mi';
    $('m-temp-u').textContent = m ? '°C' : '°F';
    $('m-wind-u').textContent = m ? 'Wind km/h' : 'Wind mph';
  }

  // ————— controls —————
  _bind() {
    const sim = this.sim;
    $('play').addEventListener('click', () => {
      if (!sim.playing && sim.t >= sim.span.t1 - 60e3) sim.t = sim.span.t0;
      sim.playing = !sim.playing;
      if (sim.playing) sim.live = false;
      this.syncPlay();
      this.onChange();
    });
    $('now').addEventListener('click', () => {
      sim.live = true; sim.playing = false; sim.t = Date.now();
      this.syncPlay();
      this.onChange();
    });
    $('speed').addEventListener('click', () => {
      sim.speed = SPEEDS[(SPEEDS.indexOf(sim.speed) + 1) % SPEEDS.length];
      $('speed').textContent = `${sim.speed}×`;
      $('speed').setAttribute('aria-label', `Playback speed: ${sim.speed} forecast hour${sim.speed > 1 ? 's' : ''} per second`);
    });

    // timeline: pointer, wheel, keyboard
    const tl = $('timeline');
    let drag = false;
    const scrub = (clientX) => {
      const r = tl.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      this._setTime(sim.span.t0 + f * (sim.span.t1 - sim.span.t0));
    };
    tl.addEventListener('pointerdown', (e) => {
      drag = true;
      try { tl.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      scrub(e.clientX);
    });
    tl.addEventListener('pointermove', (e) => { if (drag) scrub(e.clientX); });
    const end = () => { drag = false; };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);
    tl.addEventListener('wheel', (e) => {
      e.preventDefault();
      let d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      if (e.deltaMode === 1) d *= 30;
      this._setTime(sim.t + d * 60e3 * 1.2);
    }, { passive: false });
    tl.addEventListener('keydown', (e) => {
      const H = 3600e3;
      const steps = { ArrowRight: H / 4, ArrowLeft: -H / 4, ArrowUp: H, ArrowDown: -H, PageUp: 3 * H, PageDown: -3 * H };
      if (e.key in steps) { this._setTime(sim.t + steps[e.key] * (e.shiftKey ? 4 : 1)); e.preventDefault(); }
      else if (e.key === 'Home') { this._setTime(sim.span.t0); e.preventDefault(); }
      else if (e.key === 'End') { this._setTime(sim.span.t1); e.preventDefault(); }
      else if (e.key === ' ' || e.key === 'Enter') { $('play').click(); e.preventDefault(); }
    });

    // presets
    document.querySelectorAll('#presets button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#presets button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.onPreset(b.dataset.view);
      });
    });

    // map controls
    $('zoom-in').addEventListener('click', () => { this.rig.zoom(0.6); this.onChange(); });
    $('zoom-out').addEventListener('click', () => { this.rig.zoom(1.6); this.onChange(); });
    $('reset').addEventListener('click', () => { this.onPreset(this.rig.current || 'pacific'); });
    $('compass').addEventListener('click', () => { this.rig.north(); this.onChange(); });
    $('scene').addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') { this.rig.zoom(0.7); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { this.rig.zoom(1.4); e.preventDefault(); }
      else if (e.key === 'n' || e.key === 'N') { this.rig.north(); }
    });
    this.rig.controls.listenToKeyEvents($('scene'));

    // popovers
    const closeAll = (returnFocus) => {
      let opener = null;
      document.querySelectorAll('.panel').forEach((p) => {
        if (!p.hidden) opener = document.querySelector(`[aria-controls="${p.id}"]`);
        p.hidden = true;
      });
      document.querySelectorAll('.tool').forEach((t) => t.setAttribute('aria-expanded', 'false'));
      if (returnFocus && opener) opener.focus();
    };
    const pop = (btnId, panelId) => {
      const btn = $(btnId), panel = $(panelId);
      panel.tabIndex = -1;
      btn.addEventListener('click', () => {
        const open = panel.hidden;
        closeAll(false);
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) {
          this._details();
          (panel.querySelector('button, a') || panel).focus();
        }
      });
    };
    pop('btn-data', 'panel-data');
    pop('btn-settings', 'panel-settings');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll(true);
    });
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.panel, .tool')) return;
      closeAll(false);
    });

    // settings
    document.querySelectorAll('#quality button').forEach((b) => b.addEventListener('click', () => this.onQuality(b.dataset.q)));
    document.querySelectorAll('#units button').forEach((b) => b.addEventListener('click', () => {
      this.units = b.dataset.u;
      store('karl-units', this.units);
      this._unitsUI();
      this._lastText = 0;
    }));
    $('typical').addEventListener('click', async () => {
      this.typical = !this.typical;
      $('typical').setAttribute('aria-checked', String(this.typical));
      if (this.typical) {
        this._saved = { state: this.weather.state, hours: this.weather.hours, fetchedAt: this.weather.fetchedAt, error: this.weather.error };
        this.weather._illustrative();
        this.weather.state = this._saved.state;
      } else if (this._saved) {
        Object.assign(this.weather, { hours: this._saved.hours, state: this._saved.state, fetchedAt: this._saved.fetchedAt, error: this._saved.error, illustrative: false, _cum: null });
      }
      await this.onRetryFields?.();
      this.dataChanged();
    });
    $('state').addEventListener('click', async () => {
      if (this.weather.state === 'live' || this.typical) return;
      const b = $('state');
      b.classList.add('loading');
      $('state-text').textContent = 'Retrying…';
      await this.onRetry();
      this.dataChanged();
    });
    $('foghorn').addEventListener('click', () => foghorn());
    $('rise').addEventListener('click', () => this.onRise());
  }

  insideFog(on) {
    if (on === this._inside) return;
    this._inside = on;
    const el = $('inside');
    el.hidden = !on;
  }

  _setTime(ms) {
    const s = this.sim;
    s.t = Math.max(s.span.t0, Math.min(s.span.t1, ms));
    s.live = Math.abs(s.t - Date.now()) < 60e3;
    s.playing = false;
    this.syncPlay();
    this._lastText = 0;
    this.onChange();
  }

  syncPlay() {
    const p = $('play');
    p.setAttribute('aria-pressed', String(this.sim.playing));
    p.setAttribute('aria-label', this.sim.playing ? 'Pause' : 'Play the forecast');
    $('now').setAttribute('aria-pressed', String(this.sim.live));
  }

  // ————— per frame (throttled by the caller) —————
  update(sky) {
    const s = this.sim, w = this.weather;
    // light text and dark glass once the scene behind the interface is dark
    const dark = !!sky && sky.elev < 3;
    if (dark !== this._dark) { this._dark = dark; $('hud').classList.toggle('dark', !!dark); document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#141b24' : '#dfe6ec'); }
    this._drawChart();
    $('needle').style.transform = `rotate(${-this.rig.heading()}deg)`;
    if (!prefersReducedMotion) { /* compass already eased by the camera */ }

    const now = performance.now();
    if (now - (this._lastText || 0) < 200) return;
    this._lastText = now;
    const t = s.t, d = new Date(t);
    $('t-clock').textContent = F_TIME.format(d);
    $('t-day').textContent = F_DAY.format(d);
    const ahead = t - Date.now();
    const tag = $('t-tag');
    tag.className = 'tag';
    if (this.typical || w.state === 'illustrative') { tag.textContent = 'Illustrative'; tag.classList.add('illustrative'); }
    else if (Math.abs(ahead) < 20 * 60e3) tag.textContent = 'Now';
    else if (ahead > 0) tag.textContent = `Forecast +${fmtDur(ahead)}`;
    else { tag.textContent = `${fmtDur(-ahead)} ago`; tag.classList.add('past'); }

    const fog = w.at(t, 'fog'), vis = w.at(t, 'vis'), ws = w.at(t, 'windSpeed'), wd = w.at(t, 'windFrom'), tc = w.at(t, 'tempC');
    const m = this.units === 'metric';
    $('m-fog').textContent = fog == null ? '–' : Math.round(fog);
    if (vis == null) $('m-vis').textContent = '–';
    else {
      const v = m ? vis / 1000 : vis / 1609.34;
      const cap = m ? 16 : 10;
      $('m-vis').textContent = v >= cap ? `${cap}+` : v >= 2 ? Math.round(v) : v.toFixed(1);
    }
    $('m-wind').textContent = ws == null ? '–' : Math.round(ws * (m ? 3.6 : 2.23694));
    $('m-wind-dir').textContent = wd == null ? '' : DIRS[Math.round(wd / 45) % 8];
    $('m-temp').textContent = tc == null ? '–' : Math.round(m ? tc : tc * 9 / 5 + 32);

    // the slider's accessible value
    const tl = $('timeline');
    tl.setAttribute('aria-valuemin', String(Math.round(s.span.t0 / 60e3)));
    tl.setAttribute('aria-valuemax', String(Math.round(s.span.t1 / 60e3)));
    tl.setAttribute('aria-valuenow', String(Math.round(t / 60e3)));
    const when = Math.abs(ahead) < 20 * 60e3 ? 'now' : ahead > 0 ? 'forecast' : 'earlier';
    tl.setAttribute('aria-valuetext', `${F_FULL.format(d)}, ${when}, fog cover ${fog == null ? 'unknown' : Math.round(fog) + ' percent'}`);
    if (!$('panel-data').hidden) this._details();
    document.title = `Karl · ${fog == null ? '' : Math.round(fog) + '% fog · '}San Francisco Live Fog Map`;
    void sky;
  }

  _details() {
    const w = this.weather, t = this.sim.t;
    $('pd-time').textContent = `${F_TIME.format(new Date(t))}, ${F_DAY.format(new Date(t))}`;
    const pair = w._pair(t);
    if (!pair) return;
    const [a, b, f] = pair;
    const ul = $('pd-points');
    ul.replaceChildren(...POINTS.map((p, i) => {
      const v = a.low[i] + (b.low[i] - a.low[i]) * f;
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span><span class="bar"><i style="width:${Math.round(v)}%"></i></span><span class="pct">${Math.round(v)}%</span>`;
      li.setAttribute('aria-label', `${p.name}: low cloud ${Math.round(v)} percent`);
      return li;
    }));
    const m = this.units === 'metric';
    const base = w.at(t, 'base'), top = w.at(t, 'top');
    const ft = (x) => (m ? `${Math.round(x / 10) * 10} m` : `${Math.round(x * 3.281 / 50) * 50} ft`);
    $('pd-layer').textContent = `${base < 30 ? 'Down to the surface' : `Base about ${ft(base)}`}, top about ${ft(top)} ${a.fromProfile ? '(from the forecast humidity profile)' : '(estimated)'}`;
    const ws = w.at(t, 'windSpeed'), wd = w.at(t, 'windFrom');
    $('pd-wind').textContent = ws == null ? '–' : `${Math.round(ws * (m ? 3.6 : 2.23694))} ${m ? 'km/h' : 'mph'} from the ${DIR_NAMES[Math.round(wd / 45) % 8]} at the Golden Gate`;
    const st = this.typical ? 'Illustrative typical day' : w.state === 'live' ? `Open-Meteo forecast, loaded ${F_TIME.format(new Date(w.fetchedAt))}` : w.state === 'cached' ? `Saved forecast from ${F_TIME.format(new Date(w.fetchedAt))}` : 'Illustrative day (forecast unavailable)';
    $('pd-data').textContent = st;
  }

  // ————— chart —————
  _resizeChart() {
    if (!this.chart) return;
    const r = this.chart.getBoundingClientRect();
    this.chart.width = Math.max(1, Math.floor(r.width * this.dpr));
    this.chart.height = Math.max(1, Math.floor(r.height * this.dpr));
    this._sunMarks = null;
  }

  _sunMarkers() {
    if (this._sunMarks) return this._sunMarks;
    const { t0, t1 } = this.sim.span;
    const marks = [];
    let prev = sunPosition(new Date(t0)).elev;
    for (let t = t0 + 300e3; t <= t1; t += 300e3) {
      const e = sunPosition(new Date(t)).elev;
      if (prev < -0.83 && e >= -0.83) marks.push({ t, rise: true });
      if (prev >= -0.83 && e < -0.83) marks.push({ t, rise: false });
      prev = e;
    }
    this._sunMarks = { marks, dark0: sunPosition(new Date(t0)).elev < -0.83 };
    return this._sunMarks;
  }

  _drawChart() {
    const ctx = this.ctx, W = this.chart.width, H = this.chart.height, d = this.dpr;
    if (W < 4) { this._resizeChart(); return; }
    const { t0, t1 } = this.sim.span;
    const padL = 2 * d, padR = 2 * d, top = 12 * d, bottom = H - 18 * d;
    const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
    const Y = (v) => bottom - (v / 100) * (bottom - top);
    ctx.clearRect(0, 0, W, H);
    const nowMs = Date.now();
    const ink = this._dark ? (a) => `rgba(237,241,244,${Math.min(1, a * 1.15)})` : (a) => `rgba(28,38,49,${a})`;
    const accent = this._dark ? '#9da0f2' : '#6467d8';

    // night bands
    const sm = this._sunMarkers();
    ctx.fillStyle = ink(0.045);
    let dark = sm.dark0, start = t0;
    for (const m of sm.marks) {
      if (m.rise && dark) { ctx.fillRect(X(start), top - 6 * d, X(m.t) - X(start), bottom - top + 6 * d); dark = false; }
      else if (!m.rise && !dark) { dark = true; start = m.t; }
    }
    if (dark) ctx.fillRect(X(start), top - 6 * d, X(t1) - X(start), bottom - top + 6 * d);

    // the past is the model's recent hours, shown lighter
    const xNow = X(Math.max(t0, Math.min(t1, nowMs)));
    // gridlines at 0 / 50 / 100 %
    ctx.strokeStyle = ink(0.08);
    ctx.lineWidth = 1;
    for (const v of [0, 50, 100]) { ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke(); }
    ctx.fillStyle = ink(0.4);
    ctx.font = `${9.5 * d}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('100%', padL + 2 * d, Y(100) - 3 * d);

    // curve
    const N = 160;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = t0 + (i / N) * (t1 - t0);
      pts.push([X(t), Y(this.weather.at(t, 'fog') ?? 0), t]);
    }
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, ink(0.16));
    grad.addColorStop(1, ink(0.02));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], bottom);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(pts[N][0], bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1.6 * d;
    ctx.lineJoin = 'round';
    // earlier hours dashed, forecast solid
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, xNow, H); ctx.clip();
    ctx.setLineDash([3 * d, 3 * d]);
    ctx.strokeStyle = ink(0.45);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(xNow, 0, W, H); ctx.clip();
    ctx.strokeStyle = ink(0.72);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    ctx.restore();

    // hour ticks and labels
    ctx.fillStyle = ink(0.62);
    ctx.strokeStyle = ink(0.16);
    ctx.font = `500 ${9.5 * d}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const firstHour = Math.ceil(t0 / 3600e3) * 3600e3;
    const every = W / d < 520 ? 6 : 3;
    for (let t = firstHour; t <= t1; t += 3600e3) {
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
      const x = X(t);
      ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + (hour % every === 0 ? 4 : 2) * d); ctx.stroke();
      if (hour % every === 0 && x > 14 * d && x < W - 14 * d) {
        ctx.fillText(F_HOUR.format(new Date(t)).replace(' ', '').toUpperCase(), x, H - 3 * d);
      }
    }

    // now marker (labeled unless the playhead is already there)
    if (nowMs >= t0 && nowMs <= t1) {
      const nearHead = Math.abs(X(this.sim.t) - xNow) < 30 * d;
      ctx.strokeStyle = ink(0.5);
      ctx.lineWidth = 1 * d;
      ctx.setLineDash([2 * d, 2.5 * d]);
      ctx.beginPath(); ctx.moveTo(xNow, top - 4 * d); ctx.lineTo(xNow, bottom); ctx.stroke();
      ctx.setLineDash([]);
      if (!nearHead) {
        ctx.fillStyle = ink(0.55);
        ctx.font = `500 ${9 * d}px Inter, system-ui, sans-serif`;
        ctx.textAlign = xNow > W - 40 * d ? 'right' : 'left';
        ctx.fillText('NOW', xNow + (xNow > W - 40 * d ? -4 : 4) * d, top + 2 * d);
      }
    }

    // playhead
    const xp = X(this.sim.t);
    const yp = Y(this.weather.at(this.sim.t, 'fog') ?? 0);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.moveTo(xp, top - 2 * d); ctx.lineTo(xp, bottom); ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(xp, top - 2 * d, 4.5 * d, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this._dark ? '#1c2631' : '#fff';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6 * d;
    ctx.beginPath(); ctx.arc(xp, yp, 3.5 * d, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

function fmtDur(ms) {
  const h = ms / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60e3))} min`;
  return `${h < 10 ? (Math.round(h * 2) / 2).toString().replace('.5', '½') : Math.round(h)} h`;
}

// ————— the Golden Gate foghorn, synthesized —————
let audioCtx = null;
export function foghorn() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const ac = audioCtx;
  if (ac.state === 'suspended') ac.resume();
  const t = ac.currentTime;
  const master = ac.createGain();
  master.gain.value = 0;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  lp.Q.value = 2.5;
  master.connect(lp).connect(ac.destination);
  for (const f of [95, 76]) {
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lfo = ac.createOscillator();
    const lfoG = ac.createGain();
    lfo.frequency.value = 5.5;
    lfoG.gain.value = 1.6;
    lfo.connect(lfoG).connect(o.frequency);
    const g = ac.createGain();
    g.gain.value = f === 95 ? 0.5 : 0.4;
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 3.2);
    lfo.start(t); lfo.stop(t + 3.2);
  }
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(0.6, t + 0.18);
  master.gain.setValueAtTime(0.6, t + 1.9);
  master.gain.exponentialRampToValueAtTime(0.001, t + 3.1);
}
