// Weather engine. Pulls the real hourly marine-layer forecast from Open-Meteo
// and converts it into a single "Karl intensity" (0..1) per hour. Falls back to
// a climatological model of a typical fog-season day if the network is out.

const API =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=37.7749&longitude=-122.4694' + // out by Ocean Beach, where Karl lives
  '&hourly=cloud_cover_low,visibility,wind_speed_10m,wind_direction_10m,temperature_2m,dew_point_2m' +
  '&forecast_days=3&past_hours=6&timezone=America%2FLos_Angeles';

// a typical June day in the life of Karl (hour -> intensity)
function climatology(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 9) return 0.82 - 0.06 * Math.sin(h);             // socked in overnight
  if (h < 13) return 0.82 - 0.72 * smooth((h - 9) / 4);    // late-morning burn-off
  if (h < 17) return 0.12;                                  // clear afternoon
  if (h < 22) return 0.12 + 0.68 * smooth((h - 17) / 5);   // evening surge
  return 0.8;
}

function smooth(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

function scoreHour(lowCloud, visM, dewSpread) {
  // low cloud share is the backbone of the score
  let s = (lowCloud / 100) * 0.62;
  // poor visibility means fog at the surface, not just a deck overhead
  if (visM != null) {
    if (visM < 1000) s += 0.38;
    else if (visM < 5000) s += 0.38 * (1 - (visM - 1000) / 4000);
    else if (visM < 16000) s += 0.08 * (1 - (visM - 5000) / 11000);
  }
  // tiny dew-point spread = saturated air
  if (dewSpread != null && dewSpread < 2.5) s += 0.12 * (1 - dewSpread / 2.5);
  return Math.max(0, Math.min(1, s));
}

export class Weather {
  constructor() {
    this.live = false;
    this.classic = false; // true = ignore the forecast, play a textbook Karl day
    this.hours = [];   // [{ t:ms, i, tempC, windK, windDir, visM }]
  }

  async load() {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(API, { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const H = data.hourly;
      this.hours = H.time.map((iso, k) => {
        const dew = H.temperature_2m[k] != null && H.dew_point_2m[k] != null
          ? H.temperature_2m[k] - H.dew_point_2m[k] : null;
        // blend in a slice of climatology so the diurnal rhythm always reads
        const t = new Date(iso);
        const hr = t.getHours() + t.getMinutes() / 60;
        const raw = scoreHour(H.cloud_cover_low[k] ?? 0, H.visibility?.[k], dew);
        return {
          t: t.getTime(),
          i: raw * 0.8 + climatology(hr) * 0.2,
          tempC: H.temperature_2m[k],
          windK: H.wind_speed_10m[k],
          windDir: H.wind_direction_10m[k],
          visM: H.visibility?.[k],
        };
      });
      this.live = true;
    } catch (e) {
      console.warn('Karl is offline; using the climatological model.', e);
      this._buildModel();
      this.live = false;
    }
    return this;
  }

  _buildModel() {
    const now = Date.now();
    const start = now - 6 * 3600e3;
    this.hours = [];
    for (let k = 0; k < 54; k++) {
      const t = start + k * 3600e3;
      const d = new Date(t);
      const hr = d.getHours() + d.getMinutes() / 60;
      const wobble = 0.06 * Math.sin(k * 1.7) + 0.04 * Math.sin(k * 0.61 + 2);
      this.hours.push({
        t,
        i: Math.max(0.03, Math.min(1, climatology(hr) + wobble)),
        tempC: 14 + 4 * Math.sin(((hr - 6) / 24) * Math.PI * 2),
        windK: 18 + 10 * smooth((hr - 10) / 8),
        windDir: 285,
        visM: null,
      });
    }
  }

  // linear blend between hourly samples
  _at(ms, key) {
    const hs = this.hours;
    if (!hs.length) return null;
    if (ms <= hs[0].t) return hs[0][key];
    if (ms >= hs[hs.length - 1].t) return hs[hs.length - 1][key];
    let k = Math.floor((ms - hs[0].t) / 3600e3);
    k = Math.max(0, Math.min(hs.length - 2, k));
    const a = hs[k], b = hs[k + 1];
    const f = (ms - a.t) / (b.t - a.t);
    const va = a[key], vb = b[key];
    if (va == null || vb == null) return va ?? vb;
    return va + (vb - va) * Math.max(0, Math.min(1, f));
  }

  intensityAt(ms) {
    if (this.classic) {
      const d = new Date(ms);
      const hr = d.getHours() + d.getMinutes() / 60;
      const wob = 0.05 * Math.sin(ms / 3600e3 * 1.7) + 0.04 * Math.sin(ms / 3600e3 * 0.61);
      return Math.max(0.03, Math.min(1, climatology(hr) + wob));
    }
    const v = this._at(ms, 'i');
    return v == null ? 0.5 : v;
  }
  tempAt(ms) {
    if (this.classic) {
      const hr = new Date(ms).getHours();
      return 12.5 + 4.5 * Math.sin(((hr - 8) / 24) * Math.PI * 2) - 2 * this.intensityAt(ms);
    }
    return this._at(ms, 'tempC');
  }
  windAt(ms) {
    if (this.classic) return 14 + 16 * this.intensityAt(ms); // onshore push
    return this._at(ms, 'windK');
  }
  windDirAt(ms) { return this.classic ? 285 : this._at(ms, 'windDir'); }
  visAt(ms) {
    const v = this.classic ? null : this._at(ms, 'visM');
    if (v != null) return v;
    const i = this.intensityAt(ms);
    return 16000 * Math.pow(1 - i, 2.2) + 150; // model visibility from intensity
  }

  // what is Karl up to?
  narrative(ms) {
    const i = this.intensityAt(ms);
    const trend = this.intensityAt(ms + 3600e3) - i;
    const hr = new Date(ms).getHours();

    if (i < 0.12) {
      if (trend > 0.08) return 'Rare blue sky — but Karl is already stirring offshore.';
      return hr >= 11 && hr <= 17
        ? 'Clear skies. Karl is way offshore, sulking.'
        : 'A clear night in San Francisco. Karl rests.';
    }
    if (i < 0.3) {
      if (trend > 0.06) return 'Karl is on the move — first fingers reach for the Gate.';
      if (trend < -0.06) return 'Burn-off nearly done. Karl retreats to the sea.';
      return 'Karl is lurking off Ocean Beach, biding his time.';
    }
    if (i < 0.55) {
      if (trend < -0.06) return 'Burn-off underway — downtown emerges first.';
      return 'Karl is pouring through the Golden Gate.';
    }
    if (i < 0.78) {
      if (trend < -0.05) return 'Karl is loosening his grip; the hills reappear.';
      return 'The Sunset has vanished. Karl spills over Twin Peaks.';
    }
    return hr >= 21 || hr < 7
      ? 'Full Karl. The city sleeps inside a cloud.'
      : 'Full Karl. Only Sutro Tower swims above the white.';
  }
}
