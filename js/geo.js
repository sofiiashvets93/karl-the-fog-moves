// Geography shared by every module. World units are meters in a local tangent
// plane centered on San Francisco: +x east, +z south, +y up, true vertical scale.
// Must match tools/bake/common.py.

export const NEAR = { lonW: -122.56, lonE: -122.32, latS: 37.69, latN: 37.875 };  // detailed region
export const FAR = { lonW: -122.95, lonE: -121.85, latS: 37.45, latN: 37.95 };    // backdrop

export const C_LON = (NEAR.lonW + NEAR.lonE) / 2;
export const C_LAT = (NEAR.latS + NEAR.latN) / 2;
const cr = (C_LAT * Math.PI) / 180;
export const M_LAT = 111132.954 - 559.822 * Math.cos(2 * cr) + 1.175 * Math.cos(4 * cr);
export const M_LON = 111412.84 * Math.cos(cr) - 93.5 * Math.cos(3 * cr);

// lon/lat -> [x, z] meters
export function W(lon, lat) {
  return [(lon - C_LON) * M_LON, -(lat - C_LAT) * M_LAT];
}

// [x, z] meters -> [lon, lat]
export function LL(x, z) {
  return [x / M_LON + C_LON, -z / M_LAT + C_LAT];
}

export function regionM(r) {
  const [x0, z0] = W(r.lonW, r.latN);
  const [x1, z1] = W(r.lonE, r.latS);
  return { x0, x1, z0, z1, w: x1 - x0, d: z1 - z0 };
}

export const NEAR_M = regionM(NEAR);
export const FAR_M = regionM(FAR);

// Height grids are baked lon/lat-aligned, which is linear in x/z here.
export const HEIGHT_SCALE = 10;
export const HEIGHT_OFF = 16384;

export class Heightfield {
  constructor(data, w, h, rect) {
    this.data = data;   // Float32Array, row 0 = north, meters
    this.w = w;
    this.h = h;
    this.rect = rect;   // { x0, x1, z0, z1 }
  }

  // bilinear elevation in meters at world (x, z); null outside the grid
  at(x, z) {
    const r = this.rect;
    const gx = ((x - r.x0) / (r.x1 - r.x0)) * this.w - 0.5;
    const gz = ((z - r.z0) / (r.z1 - r.z0)) * this.h - 0.5;
    if (gx < -0.5 || gz < -0.5 || gx > this.w - 0.5 || gz > this.h - 0.5) return null;
    const cx = Math.min(this.w - 1.001, Math.max(0, gx));
    const cz = Math.min(this.h - 1.001, Math.max(0, gz));
    const ix = cx | 0, iz = cz | 0;
    const fx = cx - ix, fz = cz - iz;
    const d = this.data, w = this.w, i = iz * w + ix;
    const a = d[i] + (d[i + 1] - d[i]) * fx;
    const b = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
    return a + (b - a) * fz;
  }

  // max elevation inside an axis-aligned world rectangle (coarse, for culling)
  maxIn(x0, z0, x1, z1) {
    const r = this.rect;
    const gx0 = Math.max(0, Math.floor(((x0 - r.x0) / (r.x1 - r.x0)) * this.w));
    const gx1 = Math.min(this.w - 1, Math.ceil(((x1 - r.x0) / (r.x1 - r.x0)) * this.w));
    const gz0 = Math.max(0, Math.floor(((z0 - r.z0) / (r.z1 - r.z0)) * this.h));
    const gz1 = Math.min(this.h - 1, Math.ceil(((z1 - r.z0) / (r.z1 - r.z0)) * this.h));
    let lo = Infinity, hi = -Infinity;
    for (let z = gz0; z <= gz1; z++) {
      for (let x = gx0; x <= gx1; x++) {
        const v = this.data[z * this.w + x];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  }
}

// near grid first, backdrop second, sea level beyond
export function makeGround(near, far) {
  return (x, z) => {
    const a = near && near.at(x, z);
    if (a != null) return a;
    const b = far && far.at(x, z);
    return b != null ? b : -30;
  };
}
