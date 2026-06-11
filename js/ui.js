// HUD wiring: timeline chart + scrubbing, readouts, captions, foghorn.

import { sunPosition } from './sky.js';

const $ = (id) => document.getElementById(id);

const FMT_TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const FMT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const FMT_HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });

export class UI {
  constructor(sim, weather) {
    this.sim = sim;          // { t, live, playing, speed, span: {t0, t1} }
    this.weather = weather;

    this.chart = $('chart');
    this.ctx = this.chart.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._lastText = 0;
    this._caption = '';

    this._bind();
    this._resizeChart();
    window.addEventListener('resize', () => this._resizeChart());

    $('date-chip').textContent = FMT_DAY.format(new Date()).toUpperCase();
    this._modeChip();
    $('live-chip').style.cursor = 'pointer';
    $('live-chip').title = 'Toggle between the real forecast and a textbook Karl day';
    $('live-chip').addEventListener('click', () => {
      this.weather.classic = !this.weather.classic;
      this._modeChip();
    });
  }

  _modeChip() {
    const w = this.weather;
    if (w.classic) {
      $('live-chip-text').textContent = 'CLASSIC KARL';
      $('data-src').textContent = 'textbook fog-season day · tap LIVE to go back';
    } else if (w.live) {
      $('live-chip-text').textContent = 'LIVE';
      $('data-src').textContent = 'marine forecast: open-meteo · tap for classic karl';
    } else {
      $('live-chip-text').textContent = 'MODEL';
      $('data-src').textContent = 'offline · climatological model';
    }
  }

  _bind() {
    $('play').addEventListener('click', () => {
      this.sim.playing = !this.sim.playing;
      if (this.sim.playing) this.sim.live = false;
      this._playIcon();
    });
    $('now-btn').addEventListener('click', () => {
      this.sim.live = true;
      this.sim.playing = false;
      this.sim.t = Date.now();
      this._playIcon();
    });
    $('speed-btn').addEventListener('click', () => {
      this.sim.speed = this.sim.speed >= 10800 ? 3600 : 10800;
      $('speed-btn').innerHTML = this.sim.speed >= 10800 ? '3&times;' : '1&times;';
    });

    // scrub
    let dragging = false;
    const scrubTo = (clientX) => {
      const r = this.chart.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      this.sim.t = this.sim.span.t0 + f * (this.sim.span.t1 - this.sim.span.t0);
      this.sim.live = false;
      this.sim.playing = false;
      this._playIcon();
    };
    this.chart.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { this.chart.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      scrubTo(e.clientX);
    });
    this.chart.addEventListener('pointermove', (e) => { if (dragging) scrubTo(e.clientX); });
    this.chart.addEventListener('pointerup', () => { dragging = false; });

    // wheel over the timeline scrolls through time
    this.chart.addEventListener('wheel', (e) => {
      e.preventDefault();
      let d = e.deltaY + e.deltaX;
      if (e.deltaMode === 1) d *= 33; // line-mode wheels
      const step = d * 60e3 * 4;

      this.sim.t = Math.max(this.sim.span.t0, Math.min(this.sim.span.t1, this.sim.t + step));
      this.sim.live = false;
      this.sim.playing = false;
      this._playIcon();
    }, { passive: false });

    $('foghorn').addEventListener('click', () => foghorn());
  }

  _playIcon() {
    $('play-icon').classList.toggle('off', this.sim.playing);
    $('pause-icon').classList.toggle('off', !this.sim.playing);
  }

  _resizeChart() {
    const r = this.chart.getBoundingClientRect();
    this.chart.width = Math.floor(r.width * this.dpr);
    this.chart.height = Math.floor(r.height * this.dpr);
    this._sunMarks = null; // recompute
  }

  _sunMarkers() {
    if (this._sunMarks) return this._sunMarks;
    const marks = [];
    const { t0, t1 } = this.sim.span;
    let prev = sunPosition(new Date(t0)).elev;
    for (let t = t0 + 600e3; t <= t1; t += 600e3) {
      const e = sunPosition(new Date(t)).elev;
      if (prev < 0 && e >= 0) marks.push({ t, rise: true });
      if (prev >= 0 && e < 0) marks.push({ t, rise: false });
      prev = e;
    }
    this._sunMarks = marks;
    return marks;
  }

  // called every frame
  update(nowMs) {
    this._drawChart(nowMs);

    // text readouts at ~5 Hz is plenty
    const wall = performance.now();
    if (wall - this._lastText < 200) return;
    this._lastText = wall;

    const t = this.sim.t;
    const w = this.weather;
    const d = new Date(t);

    $('tl-clock').textContent = FMT_TIME.format(d);
    $('tl-day').textContent = FMT_DAY.format(d);

    const ahead = t - nowMs;
    const tag = $('tl-tag');
    if (ahead > 5 * 60e3) {
      tag.classList.remove('off');
      tag.textContent = '+' + (ahead / 3600e3).toFixed(1) + 'h forecast';
    } else if (ahead < -5 * 60e3) {
      tag.classList.remove('off');
      tag.textContent = (ahead / 3600e3).toFixed(1) + 'h ago';
    } else {
      tag.classList.add('off');
    }

    const I = w.intensityAt(t);
    $('r-fog').textContent = Math.round(I * 100);
    const visMi = w.visAt(t) / 1609;
    $('r-vis').textContent = visMi >= 10 ? '10+' : visMi >= 2 ? visMi.toFixed(0) : visMi.toFixed(1);
    const windK = w.windAt(t);
    $('r-wind').textContent = windK == null ? '--' : Math.round(windK * 0.621);
    const wd = w.windDirAt(t);
    if (wd != null) {
      const dirs = ['N','NE','E','SE','S','SW','W','NW'];
      $('r-wind-dir').textContent = dirs[Math.round(((wd % 360) / 45)) % 8];
    }
    const tc = w.tempAt(t);
    $('r-temp').textContent = tc == null ? '--' : Math.round(tc * 9 / 5 + 32);

    const cap = w.narrative(t);
    if (cap !== this._caption) {
      this._caption = cap;
      const el = $('caption-text');
      el.style.opacity = 0;
      setTimeout(() => { el.textContent = cap; el.style.opacity = 1; }, 250);
    }

    document.title = `🌁 ${Math.round(I * 100)}% — Karl, the SF Fog`;
  }

  _drawChart(nowMs) {
    const ctx = this.ctx;
    const W = this.chart.width, H = this.chart.height;
    const dpr = this.dpr;
    const { t0, t1 } = this.sim.span;
    const X = (t) => ((t - t0) / (t1 - t0)) * W;

    ctx.clearRect(0, 0, W, H);
    const padB = 14 * dpr;
    const plotH = H - padB;

    // hour grid + labels
    ctx.font = `${8.5 * dpr}px "Spline Sans Mono", monospace`;
    ctx.fillStyle = 'rgba(22,34,44,0.45)';
    ctx.strokeStyle = 'rgba(22,34,44,0.12)';
    ctx.lineWidth = 1;
    const firstHour = Math.ceil(t0 / 3600e3) * 3600e3;
    for (let t = firstHour; t <= t1; t += 3600e3) {
      const h = new Date(t).getHours();
      const x = X(t);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      if (h % 3 === 0) {
        ctx.fillText(FMT_HOUR.format(new Date(t)).toLowerCase().replace(' ', ''), x + 3 * dpr, H - 4 * dpr);
      }
    }

    // sunrise / sunset ticks
    ctx.fillStyle = 'rgba(232,80,15,0.85)';
    for (const m of this._sunMarkers()) {
      const x = X(m.t);
      ctx.beginPath();
      if (m.rise) { ctx.moveTo(x - 4 * dpr, plotH); ctx.lineTo(x + 4 * dpr, plotH); ctx.lineTo(x, plotH - 6 * dpr); }
      else { ctx.moveTo(x - 4 * dpr, plotH - 6 * dpr); ctx.lineTo(x + 4 * dpr, plotH - 6 * dpr); ctx.lineTo(x, plotH); }
      ctx.closePath();
      ctx.fill();
    }

    // fog intensity area
    ctx.beginPath();
    ctx.moveTo(0, plotH);
    const steps = 140;
    for (let s = 0; s <= steps; s++) {
      const t = t0 + (s / steps) * (t1 - t0);
      const i = this.weather.intensityAt(t);
      ctx.lineTo((s / steps) * W, plotH - i * (plotH - 8 * dpr));
    }
    ctx.lineTo(W, plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(22,34,44,0.13)';
    ctx.fill();

    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const t = t0 + (s / steps) * (t1 - t0);
      const i = this.weather.intensityAt(t);
      const x = (s / steps) * W, y = plotH - i * (plotH - 8 * dpr);
      s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(22,34,44,0.7)';
    ctx.lineWidth = 1.4 * dpr;
    ctx.stroke();

    // "now" marker
    if (nowMs >= t0 && nowMs <= t1) {
      const x = X(nowMs);
      ctx.strokeStyle = 'rgba(22,34,44,0.5)';
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

    // playhead
    const px = X(this.sim.t);
    ctx.strokeStyle = '#e8500f';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, plotH); ctx.stroke();
    ctx.fillStyle = '#e8500f';
    ctx.beginPath(); ctx.arc(px, 5 * dpr, 3.5 * dpr, 0, Math.PI * 2); ctx.fill();
  }
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

  // the real horn blows two tones a third apart
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
