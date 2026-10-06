// Builds building geometry off the main thread from data/buildings.bin.gz
// (format documented in tools/bake/buildings.py).
//
// Per vertex: position i16×3 in 1/20 m relative to the tile origin (the mesh
// scale undoes it), wall coordinates i16×2 (u = distance along the footprint
// perimeter, v = height above the base, both 1/20 m), info u8×4 (kind,
// variant, roof luminance, building height in m/2), and an i8 outward normal
// used only for shadow normal bias. Walls and roofs share the top ring of
// vertices; the shader shades faces from screen-space derivatives.

import earcut from '../lib/earcut.js';

const Q = 20; // vertex quantization: 1/20 m

self.onmessage = (e) => {
  const buf = e.data.buffer;
  const dv = new DataView(buf);
  let o = 0;
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'KBLD') { self.postMessage({ error: 'bad buildings file' }); return; }
  o = 4;
  const version = dv.getUint16(o, true); o += 2;
  const TX = dv.getUint16(o, true); o += 2;
  const TZ = dv.getUint16(o, true); o += 2;
  const count = dv.getUint32(o, true); o += 4;
  const nVerts = dv.getUint32(o, true); o += 4;
  const originX = dv.getFloat32(o, true); o += 4;
  const originZ = dv.getFloat32(o, true); o += 4;
  const tileW = dv.getFloat32(o, true); o += 4;
  const tileD = dv.getFloat32(o, true); o += 4;
  const unit = version >= 2 ? dv.getFloat32(o, true) : 0.1; if (version >= 2) o += 4;
  const nT = TX * TZ;
  const first = new Uint32Array(buf.slice(o, o + nT * 4)); o += nT * 4;
  const cnt = new Uint32Array(buf.slice(o, o + nT * 4)); o += nT * 4;
  const nv = new Uint8Array(buf, o, count); o += count;
  const z0 = new Uint16Array(buf.slice(o, o + count * 2)); o += count * 2;
  const z1 = new Uint16Array(buf.slice(o, o + count * 2)); o += count * 2;
  const kind = new Uint8Array(buf, o, count); o += count;
  const rgb = new Uint8Array(buf, o, count * 3); o += count * 3;
  const dx = new Int16Array(buf.slice(o, o + nVerts * 2)); o += nVerts * 2;
  const dz = new Int16Array(buf.slice(o, o + nVerts * 2)); o += nVerts * 2;

  // vertex offset of each building
  const vstart = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) vstart[i + 1] = vstart[i] + nv[i];

  const LOD_H = [0, 10, 24, 60]; // index-count cutoffs: buildings at least this tall
  // coarse max roof elevation grid for camera collision
  const HG = 256;
  const hgrid = new Float32Array(HG * HG).fill(-1000);
  const gx0 = originX, gz0 = originZ, gw = tileW * TX, gd = tileD * TZ;
  const tiles = [];
  const transfer = [];
  const ring = new Float64Array(512);

  for (let t = 0; t < nT; t++) {
    const n0 = first[t], n = cnt[t];
    if (!n) continue;
    const tx = t % TX, tz = (t / TX) | 0;
    const ox = originX + tx * tileW, oz = originZ + tz * tileD;
    let V = 0, I = 0;
    for (let b = n0; b < n0 + n; b++) { V += 2 * (nv[b] + 1); I += 6 * nv[b] + 3 * (nv[b] - 2); }
    const pos = new Int16Array(V * 3);
    const wall = new Int16Array(V * 2);
    const info = new Uint8Array(V * 4);
    const nrm = new Int8Array(V * 4);
    const idx = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
    const lodCounts = [0, 0, 0, 0];
    let v = 0, ii = 0;
    let minY = Infinity, maxY = -Infinity;

    for (let b = n0; b < n0 + n; b++) {
      const m = nv[b];
      // decode the ring (meters, tile-relative)
      let x = 0, z = 0;
      for (let k = 0; k < m; k++) {
        const s = vstart[b] + k;
        if (k === 0) { x = dx[s]; z = dz[s]; } else { x += dx[s]; z += dz[s]; }
        ring[k * 2] = x * unit; ring[k * 2 + 1] = z * unit;
      }
      // make sure the ring runs counter-clockwise seen from above (north up)
      let area2 = 0;
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        area2 += ring[k * 2] * (-ring[k2 * 2 + 1]) - ring[k2 * 2] * (-ring[k * 2 + 1]);
      }
      if (area2 < 0) {
        for (let k = 0; k < m >> 1; k++) {
          const j = m - 1 - k;
          const tx0 = ring[k * 2], tz0 = ring[k * 2 + 1];
          ring[k * 2] = ring[j * 2]; ring[k * 2 + 1] = ring[j * 2 + 1];
          ring[j * 2] = tx0; ring[j * 2 + 1] = tz0;
        }
      }
      const yb = z0[b] / 10 - 100, yt = z1[b] / 10 - 100;
      const height = yt - yb;
      for (let k = 0; k < m; k++) {
        const gi = Math.floor(((ox + ring[k * 2]) - gx0) / gw * HG), gj = Math.floor(((oz + ring[k * 2 + 1]) - gz0) / gd * HG);
        if (gi >= 0 && gj >= 0 && gi < HG && gj < HG && yt > hgrid[gj * HG + gi]) hgrid[gj * HG + gi] = yt;
      }
      minY = Math.min(minY, yb); maxY = Math.max(maxY, yt);
      const r = rgb[b * 3], g = rgb[b * 3 + 1], bl = rgb[b * 3 + 2];
      const lum = Math.min(255, (r * 0.3 + g * 0.55 + bl * 0.15) * 1.0);
      const variant = (Math.imul(b + 0x9e37, 0x85ebca6b) >>> 24) & 255;
      const kb = kind[b];
      const hq = Math.min(255, Math.round(height / 2));
      const base = v;
      // walls: bottom row then top row, n+1 columns (seam duplicated)
      let per = 0;
      for (let k = 0; k <= m; k++) {
        const kk = k % m;
        const px = ring[kk * 2], pz = ring[kk * 2 + 1];
        if (k > 0) {
          const qx = ring[((k - 1) % m) * 2], qz = ring[((k - 1) % m) * 2 + 1];
          per += Math.hypot(px - qx, pz - qz);
        }
        // outward normal: average of the two adjacent edges' normals
        const pk = ring[((kk - 1 + m) % m) * 2], pkz = ring[((kk - 1 + m) % m) * 2 + 1];
        const nk = ring[((kk + 1) % m) * 2], nkz = ring[((kk + 1) % m) * 2 + 1];
        let ex = nk - pk, ez = nkz - pkz;
        const el = Math.hypot(ex, ez) || 1;
        // CCW from above with z pointing south: outward is (-ez, ex)
        const onx = -ez / el, onz = ex / el;
        for (let row = 0; row < 2; row++) {
          const vi = base + row * (m + 1) + k;
          const up = row ? 0.7 : 0;
          const L = Math.hypot(onx, up, onz) || 1;
          nrm[vi * 4] = Math.round((onx / L) * 127);
          nrm[vi * 4 + 1] = Math.round((up / L) * 127);
          nrm[vi * 4 + 2] = Math.round((onz / L) * 127);
          pos[vi * 3] = Math.round(px * Q);
          pos[vi * 3 + 1] = Math.round((row ? yt : yb) * Q);
          pos[vi * 3 + 2] = Math.round(pz * Q);
          wall[vi * 2] = Math.round((per % 1600) * Q);
          wall[vi * 2 + 1] = Math.round((row ? height : 0) * Q);
          info[vi * 4] = kb; info[vi * 4 + 1] = variant; info[vi * 4 + 2] = lum; info[vi * 4 + 3] = hq;
        }
      }
      v += 2 * (m + 1);
      // wall quads; footprint rings are CCW seen from above with north up,
      // which is clockwise in x/z (z points south) — wind outward faces CCW
      for (let k = 0; k < m; k++) {
        const a = base + k, bb = base + k + 1, c = base + (m + 1) + k, d = base + (m + 1) + k + 1;
        idx[ii++] = a; idx[ii++] = bb; idx[ii++] = c;
        idx[ii++] = bb; idx[ii++] = d; idx[ii++] = c;
      }
      // roof over the top row
      const flat = new Float64Array(m * 2);
      for (let k = 0; k < m; k++) { flat[k * 2] = ring[k * 2]; flat[k * 2 + 1] = ring[k * 2 + 1]; }
      const tri = earcut(flat);
      for (let k = 0; k < tri.length; k += 3) {
        const A = tri[k], B = tri[k + 1], C = tri[k + 2];
        // face up (+y): (B-A)×(C-A) must have positive y
        const ny = (ring[B * 2 + 1] - ring[A * 2 + 1]) * (ring[C * 2] - ring[A * 2])
          - (ring[B * 2] - ring[A * 2]) * (ring[C * 2 + 1] - ring[A * 2 + 1]);
        const top = base + (m + 1);
        if (ny >= 0) { idx[ii++] = top + A; idx[ii++] = top + B; idx[ii++] = top + C; }
        else { idx[ii++] = top + A; idx[ii++] = top + C; idx[ii++] = top + B; }
      }
      for (let L = 0; L < 4; L++) if (height >= LOD_H[L]) lodCounts[L] = ii;
    }
    const idxOut = ii < idx.length ? idx.slice(0, ii) : idx;
    tiles.push({ t, ox, oz, minY, maxY, w: tileW, d: tileD, pos, wall, info, nrm, idx: idxOut, lodCounts, count: n });
    transfer.push(pos.buffer, wall.buffer, info.buffer, nrm.buffer, idxOut.buffer);
  }
  transfer.push(hgrid.buffer);
  self.postMessage({ tiles, Q, LOD_H, count, hgrid: { data: hgrid, n: HG, x0: gx0, z0: gz0, w: gw, d: gd } }, transfer);
};
