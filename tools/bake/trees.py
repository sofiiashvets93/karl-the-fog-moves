"""Place individual trees for data/trees.bin.gz.

Sources: OpenStreetMap tree points (via Overture), plus canopy inferred from
Sentinel-2 at 10 m: dense, dark vegetation (high NDVI, low visible
reflectance) outside mapped lawns, golf courses, roofs and roads. Tall
forest (Monterey cypress, pine and eucalyptus in the Presidio, Golden Gate
Park, Sutro Forest) is told apart from street trees by OSM wood/forest areas.

Record (planar arrays, little-endian):
  header 'KTRE' u16 version, u32 count, f32 unit
  x, z   i16[count] each (meters * 2 from the region center)
  h      u8[count]  height, 0.25 m units
  r      u8[count]  crown radius, 0.1 m units
  kind   u8[count]  0 broadleaf, 1 conifer, 2 eucalyptus
  tone   u8[count]  color variation
"""
import gzip, os, struct
import numpy as np
from PIL import Image
from common import NEAR, CACHE, DATA, to_xz, region_m
from vectors import load, col
from ground import poly_mask, N, SIZE

def main():
    rng = np.random.default_rng(11)
    x0m, x1m, z0m, z1m = region_m(NEAR)
    land = np.load(os.path.join(CACHE, 'land-near.npy')).astype(np.float32)      # N×N
    ndvi = np.load(os.path.join(CACHE, 'ndvi-near.npy')).astype(np.float32)
    roof = np.load(os.path.join(CACHE, 'roofmask-near.npy')).astype(np.float32)
    roads = np.load(os.path.join(CACHE, 'roadmask-near.npy')).astype(np.float32)
    tci = np.load(os.path.join(CACHE, 's2-near-tci.npy')).astype(np.float32)
    bright = np.asarray(Image.fromarray(tci.mean(0)).resize((N, N), Image.Resampling.BILINEAR))

    def down(im):
        return np.asarray(im.resize((N, N), Image.Resampling.BOX), np.float32) / 255

    lu_t, lu_g = load('base-land_use')
    lucls = col(lu_t, 'class')
    open_ground = down(poly_mask([g for g, c in zip(lu_g, lucls) if c in (
        'pitch', 'grass', 'green', 'fairway', 'tee', 'bunker', 'playground', 'track', 'meadow', 'village_green', 'dog_park')]))
    land_t, land_g = load('base-land')
    lcls = col(land_t, 'class')
    forest = down(poly_mask([g for g, c in zip(land_g, lcls) if c in ('wood', 'forest', 'tree_row')]))
    parks = down(poly_mask([g for g, c in zip(lu_g, lucls) if c in ('park', 'nature_reserve', 'recreation_ground', 'cemetery')]))

    xs, zs, hs, rs, ks = [], [], [], [], []

    # ——— mapped trees ———
    pts = [(g.x, g.y) for g, s in zip(land_g, col(land_t, 'subtype')) if s == 'tree' and g.geom_type == 'Point']
    for lon, lat in pts:
        x, z = to_xz(lon, lat)
        xs.append(x); zs.append(z)
        hs.append(rng.uniform(6, 13)); rs.append(rng.uniform(2.2, 4.0)); ks.append(0)
    n_osm = len(xs)

    # ——— canopy from the satellite: one candidate per 5 m pixel ———
    canopy = (ndvi > 0.52) & (bright < 75) & (land > 0.9) & (roof < 0.2) & (roads < 0.3) & (open_ground < 0.3)
    dens = np.clip((ndvi - 0.52) / 0.22, 0, 1) * np.clip((75 - bright) / 30, 0, 1)
    tall = np.maximum(forest, parks * (bright < 55))
    iy, ix = np.nonzero(canopy)
    # forest gets a tree every ~6 m, streets and yards sparser
    keep_p = np.where(tall[iy, ix] > 0.5, 0.42, 0.16) * (0.4 + 0.6 * dens[iy, ix])
    keep = rng.random(len(iy)) < keep_p
    iy, ix = iy[keep], ix[keep]
    # the region is not square: rows and columns have different sizes in meters
    px_x, px_z = (x1m - x0m) / N, (z1m - z0m) / N
    x = x0m + (ix + rng.random(len(ix))) * px_x
    z = z0m + (iy + rng.random(len(iy))) * px_z
    is_tall = tall[iy, ix] > 0.5
    h = np.where(is_tall, rng.uniform(14, 32, len(ix)), rng.uniform(5, 12, len(ix)))
    r = np.where(is_tall, rng.uniform(3.2, 6.0, len(ix)), rng.uniform(2.0, 3.8, len(ix)))
    k = np.where(is_tall, rng.choice([1, 1, 2], len(ix)), 0)
    xs += list(x); zs += list(z); hs += list(h); rs += list(r); ks += list(k)

    xs, zs = np.asarray(xs), np.asarray(zs)
    cx, cz = (x0m + x1m) / 2, (z0m + z1m) / 2
    n = len(xs)
    order = np.lexsort(((zs // 640).astype(int), (xs // 640).astype(int)))   # rough spatial order
    xq = np.round((xs - cx) * 2).astype(np.int16)[order]
    zq = np.round((zs - cz) * 2).astype(np.int16)[order]
    hq = np.clip(np.round(np.asarray(hs) * 4), 1, 255).astype(np.uint8)[order]
    rq = np.clip(np.round(np.asarray(rs) * 10), 1, 255).astype(np.uint8)[order]
    kq = np.asarray(ks, np.uint8)[order]
    tq = rng.integers(0, 256, n).astype(np.uint8)
    blob = b'KTRE' + struct.pack('<HIf', 1, n, 0.5) + xq.tobytes() + zq.tobytes() + hq.tobytes() + rq.tobytes() + kq.tobytes() + tq.tobytes()
    with gzip.open(os.path.join(DATA, 'trees.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(blob)
    print(f'trees.bin.gz: {n} trees ({n_osm} mapped, {int(is_tall.sum())} forest), '
          f'{os.path.getsize(os.path.join(DATA, "trees.bin.gz"))/1e6:.2f} MB')

if __name__ == '__main__':
    main()
