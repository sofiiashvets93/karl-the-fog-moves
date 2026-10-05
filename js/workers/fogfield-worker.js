// Modeled marine-layer extent, one 2D field per forecast hour.
//
// For each hour, fog spreads from the open Pacific through a cost field: it can only occupy cells where the marine layer is
// deeper than the ground, moves more easily downwind and over water, and
// burns off faster over sunlit land. The forecast low-cloud cover at the
// sample points scales both how far it reaches and how dense it is locally.
//
// Output per cell (RGBA8): coverage, cloud base (m/4), layer top (m/4),
// density scale.

self.onmessage = (e) => {
  const { elev, nx, nz, cell, x0, z0, hours, points, gateX } = e.data;
  const N = nx * nz;
  // the open Pacific: water connected to the west edge without passing east
  // through the Golden Gate. Fog is born there; the bay only gets it via the strait.
  const pacific = new Uint8Array(N);
  {
    const iGate = Math.floor((gateX - 200 - x0) / cell);
    const stack = [];
    for (let j = 0; j < nz; j++) if (elev[j * nx] < 0) { pacific[j * nx] = 1; stack.push(j * nx); }
    while (stack.length) {
      const k = stack.pop();
      const i = k % nx, j = (k / nx) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + dx, jj = j + dz;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || ii > iGate) continue;
        const kk = jj * nx + ii;
        if (!pacific[kk] && elev[kk] < 0) { pacific[kk] = 1; stack.push(kk); }
      }
    }
  }
  const out = new Uint8Array(N * 4 * hours.length);
  const cost = new Float64Array(N);
  const done = new Uint8Array(N);
  const heap = new MinHeap(N * 2);
  const DIRS = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dz) DIRS.push([dx, dz, Math.hypot(dx, dz)]);

  // precompute IDW weights of the sample points per cell (coarse: every cell)
  const P = points.length;
  const wts = new Float32Array(N * P);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      let s = 0;
      for (let p = 0; p < P; p++) {
        const d2 = (x - points[p].x) ** 2 + (z - points[p].z) ** 2 + 1.5e6;
        const w = 1 / (d2 * Math.sqrt(d2) / 1e3);
        wts[(j * nx + i) * P + p] = w; s += w;
      }
      for (let p = 0; p < P; p++) wts[(j * nx + i) * P + p] /= s;
    }
  }

  hours.forEach((h, hi) => {
    const top = h.top, base = h.base;
    const wl = Math.hypot(h.windX, h.windZ) || 1;
    const wdx = h.windX / wl, wdz = h.windZ / wl;   // direction the air moves toward
    const windK = Math.min(1, wl / 6);
    // Dijkstra from the open ocean along the west edge
    cost.fill(Infinity);
    done.fill(0);
    heap.clear();
    for (let k = 0; k < N; k++) if (pacific[k]) { cost[k] = 0; heap.push(k, 0); }
    while (heap.size) {
      const k = heap.pop(), c = heap.last;
      if (done[k]) continue;   // settled already: skip stale duplicates
      done[k] = 1;
      const i = k % nx, j = (k / nx) | 0;
      for (const [dx, dz, dl] of DIRS) {
        const ii = i + dx, jj = j + dz;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const kk = jj * nx + ii;
        const depth = top - elev[kk];
        if (depth < 25) continue;                                   // ridge above the inversion
        const depthF = Math.min(1, depth / 120);
        const land = elev[kk] > 0.5 ? 1 + 2.2 * h.heat : 1;
        const along = (dx * wdx + dz * wdz) / dl;
        const windF = 1 - 0.5 * windK * along;
        const step = dl * cell * land * windF / (0.2 + 0.8 * depthF);
        const nc = c + step;
        if (!done[kk] && nc < cost[kk]) { cost[kk] = nc; heap.push(kk, nc); }
      }
    }
    const reach = h.reach;
    const o = hi * N * 4;
    for (let k = 0; k < N; k++) {
      let p = 0;
      for (let q = 0; q < P; q++) p += wts[k * P + q] * h.low[q];
      p /= 100;
      const c = cost[k];
      const conn = c === Infinity ? 0 : 1 - smooth(reach * 0.55, reach, c);
      const depthF = Math.max(0, Math.min(1, (top - elev[k] - 20) / 90));
      const cov = Math.min(1, conn * Math.pow(Math.min(1, p * 1.25), 0.7) * h.source * depthF);
      out[o + k * 4] = Math.round(cov * 255);
      out[o + k * 4 + 1] = Math.min(255, Math.round(base / 4));
      out[o + k * 4 + 2] = Math.min(255, Math.round(top / 4));
      out[o + k * 4 + 3] = Math.round(Math.min(1, h.dens) * 255);
    }
  });
  self.postMessage({ data: out }, [out.buffer]);
};

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

class MinHeap {
  constructor(cap) { this.k = new Int32Array(cap); this.v = new Float64Array(cap); this.size = 0; }
  clear() { this.size = 0; }
  push(key, val) {
    if (this.size >= this.k.length) {
      const k2 = new Int32Array(this.k.length * 2); k2.set(this.k); this.k = k2;
      const v2 = new Float64Array(this.v.length * 2); v2.set(this.v); this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.v[p] <= val) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const rk = this.k[0], rv = this.v[0];
    const lk = this.k[--this.size], lv = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.v[c + 1] < this.v[c]) c++;
      if (this.v[c] >= lv) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    this.last = rv;
    return rk;
  }
}
