"""Bake building footprints (Overture Maps: OpenStreetMap, incl. San Francisco's
LiDAR-derived heights) into data/buildings.bin.gz.

Layout (little-endian, struct-of-arrays so gzip does well):
  header   'KBLD' u16 version, u16 tilesX, u16 tilesZ, u32 count, u32 nVerts,
           f32 originX, f32 originZ, f32 tileW, f32 tileD, f32 unit (m per coord step)
  tiles    u32 first[tilesX*tilesZ], u32 count[tilesX*tilesZ]  (row-major, z then x)
  nverts   u8[count]
  z0, z1   u16[count] each: bottom / top elevation, (m + 100) * 10
  kind     u8[count]
  rgb      u8[count*3]  roof tone sampled from the satellite image
  dx, dz   i16[nVerts] each (x plane, then z plane). Per building: first
           vertex relative to its tile origin, then deltas, in `unit` meters.
           Rings are open and counter-clockwise seen from above (north up).
Buildings inside a tile are sorted tallest first.
"""
import gzip, json, os, struct, sys
import numpy as np
import shapely
from shapely.geometry import Polygon
from common import NEAR, CACHE, DATA, to_xz, region_m
from vectors import load, col, primary_names

TILES = 16
SIMPLIFY_M = 0.75   # footprint simplification tolerance
Q = 5              # coordinate quantization: 1/Q m (0.2 m)
RECT_FILL = 0.9    # footprint/rectangle area ratio above which we use the rectangle
KIND = dict(generic=0, residential=1, commercial=2, industrial=3, civic=4, pier=5)

CLASS_KIND = {
    'house': 'residential', 'detached': 'residential', 'terrace': 'residential', 'residential': 'residential',
    'apartments': 'residential', 'semidetached_house': 'residential', 'houseboat': 'residential', 'bungalow': 'residential',
    'commercial': 'commercial', 'retail': 'commercial', 'office': 'commercial', 'hotel': 'commercial', 'supermarket': 'commercial',
    'industrial': 'industrial', 'warehouse': 'industrial', 'manufacture': 'industrial', 'hangar': 'industrial', 'service': 'industrial',
    'church': 'civic', 'cathedral': 'civic', 'school': 'civic', 'university': 'civic', 'college': 'civic', 'hospital': 'civic',
    'civic': 'civic', 'government': 'civic', 'public': 'civic', 'museum': 'civic', 'religious': 'civic', 'stadium': 'civic',
}
SUBTYPE_KIND = {'residential': 'residential', 'commercial': 'commercial', 'industrial': 'industrial',
                'civic': 'civic', 'religious': 'civic', 'education': 'civic', 'medical': 'civic', 'entertainment': 'commercial'}
DEFAULT_H = {'residential': 8.5, 'commercial': 11, 'industrial': 8, 'civic': 12, 'generic': 7}
SMALL = {'shed', 'garage', 'garages', 'carport', 'roof', 'kiosk', 'hut', 'cabin', 'toilets', 'container'}

# structures modeled by hand (js/landmarks.js) or not buildings at all
SKIP_NAMES = {'Sutro Tower', 'Salesforce Tower', 'Transamerica Pyramid'}
LANDMARKS = {'Salesforce Tower': 'salesforce', 'Transamerica Pyramid': 'transamerica'}

def main():
    dem = np.load(os.path.join(CACHE, 'terrain-near-conformed.npy'))
    G = dem.shape[0]
    x0m, x1m, z0m, z1m = region_m(NEAR)
    def ground(x, z):
        gx = np.clip((x - x0m) / (x1m - x0m) * G - 0.5, 0, G - 1.001)
        gz = np.clip((z - z0m) / (z1m - z0m) * G - 0.5, 0, G - 1.001)
        ix, iz = gx.astype(int), gz.astype(int)
        fx, fz = gx - ix, gz - iz
        a = dem[iz, ix] * (1 - fx) + dem[iz, ix + 1] * fx
        b = dem[iz + 1, ix] * (1 - fx) + dem[iz + 1, ix + 1] * fx
        return a * (1 - fz) + b * fz

    tci = np.load(os.path.join(CACHE, 's2-near-tci.npy')).astype(np.float32)
    S = tci.shape[1]
    def roof_rgb(x, z):
        gx = int(np.clip((x - x0m) / (x1m - x0m) * S, 1, S - 2))
        gz = int(np.clip((z - z0m) / (z1m - z0m) * S, 1, S - 2))
        return tci[:, gz - 1:gz + 2, gx - 1:gx + 2].reshape(3, -1).mean(1)

    t, geoms = load('buildings-building')
    names = primary_names(t)
    heights = col(t, 'height'); floors = col(t, 'num_floors'); classes = col(t, 'class'); subs = col(t, 'subtype')
    under = col(t, 'is_underground'); has_parts = col(t, 'has_parts'); ids = col(t, 'id')

    pt, pgeoms = load('buildings-building_part')
    parts_by_bid = {}
    for i, bid in enumerate(col(pt, 'building_id')):
        parts_by_bid.setdefault(bid, []).append(i)
    p_h = col(pt, 'height'); p_minh = col(pt, 'min_height'); p_fl = col(pt, 'num_floors'); p_minfl = col(pt, 'min_floor')
    p_under = col(pt, 'is_underground')

    rng = np.random.default_rng(7)
    items = []  # (ring_xz Nx2, bottom, top, kind, rgb)

    def add(poly_ll, h, minh, kind, ground_override=None):
        c = np.asarray(poly_ll.exterior.coords)[:-1]
        if len(c) < 3:
            return
        x, z = to_xz(c[:, 0], c[:, 1])
        ring = Polygon(np.stack([x, -z], 1))  # -z: back to a y-up plane so CCW keeps meaning
        if not ring.is_valid:
            ring = ring.buffer(0)
            if ring.geom_type != 'Polygon':
                return
        if ring.area < 12:
            return
        ring = ring.simplify(SIMPLIFY_M, preserve_topology=True)
        if ring.geom_type != 'Polygon' or ring.is_empty or ring.area < 10:
            return
        # rowhouses with light wells and bay windows read as boxes from the air:
        # snap near-rectangular footprints to their oriented rectangle
        if len(ring.exterior.coords) > 5:
            rect = ring.minimum_rotated_rectangle
            if rect.geom_type == 'Polygon' and ring.area / rect.area > RECT_FILL:
                ring = rect
        ring = shapely.geometry.polygon.orient(ring, 1.0)
        pts = np.asarray(ring.exterior.coords)[:-1]
        tol = SIMPLIFY_M
        while len(pts) > 255:
            tol *= 1.6
            ring2 = ring.simplify(tol, preserve_topology=True)
            pts = np.asarray(ring2.exterior.coords)[:-1]
        xs, zs = pts[:, 0], -pts[:, 1]
        gr = ground(xs, zs)
        g_min, g_mean = float(gr.min()), float(gr.mean())
        if ground_override is not None:
            g_min = g_mean = ground_override
        if g_mean < 0.5:   # sits over water: a pier shed or a pier itself
            g_min = g_mean = max(g_mean, 3.0) if kind != KIND['pier'] else g_mean
        bottom = g_min - 0.6 if minh <= 0 else g_mean + minh
        top = g_mean + h
        if top - bottom < 1.0:
            return
        cx, cz = xs.mean(), zs.mean()
        items.append((np.stack([xs, zs], 1), bottom, top, kind, roof_rgb(cx, cz)))

    def height_for(h, fl, cls, sub):
        kind_name = CLASS_KIND.get(cls) or SUBTYPE_KIND.get(sub) or 'generic'
        if h is not None and h > 0:
            hh = h
        elif fl:
            hh = fl * 3.4 + 1.0
        elif cls in SMALL:
            hh = 3.0
        else:
            hh = DEFAULT_H[kind_name] * (0.85 + 0.3 * rng.random())
        return float(np.clip(hh, 2.5, 420)), kind_name

    # iconic towers are modeled by hand from their real footprints (js/landmarks.js)
    landmarks = {}
    for i, g in enumerate(geoms):
        key = LANDMARKS.get(names[i])
        if key and g is not None and key not in landmarks:
            poly = max(list(g.geoms), key=lambda q: q.area) if g.geom_type == 'MultiPolygon' else g
            ring = np.asarray(poly.exterior.coords)[:-1]
            x, z = to_xz(ring[:, 0], ring[:, 1])
            landmarks[key] = {'ring': [[round(float(a), 2), round(float(b), 2)] for a, b in zip(x, z)],
                              'height': float(heights[i] or 0), 'ground': float(ground(x, z).min())}
    with open(os.path.join(DATA, 'landmarks.json'), 'w') as f:
        json.dump(landmarks, f)
    print('landmarks:', {k: (len(v['ring']), v['height']) for k, v in landmarks.items()})

    n_parts = 0
    for i, g in enumerate(geoms):
        if under[i] or names[i] in SKIP_NAMES or g is None:
            continue
        hh, kind_name = height_for(heights[i], floors[i], classes[i], subs[i])
        polys = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
        pidx = parts_by_bid.get(ids[i]) if has_parts[i] else None
        if pidx:
            # render the detailed parts; keep the outline only as a podium if the parts start above ground
            lowest = min((p_minh[j] or 0) for j in pidx)
            for j in pidx:
                if p_under[j]:
                    continue
                ph, _ = height_for(p_h[j], p_fl[j], classes[i], subs[i])
                pm = p_minh[j] or ((p_minfl[j] or 0) * 3.4)
                pg = pgeoms[j]
                for pp in (list(pg.geoms) if pg.geom_type == 'MultiPolygon' else [pg]):
                    add(pp, ph, pm, KIND[kind_name]); n_parts += 1
            if lowest > 2:
                for p in polys:
                    add(p, min(hh, lowest), 0, KIND[kind_name])
            continue
        for p in polys:
            add(p, hh, 0, KIND[kind_name])

    # piers: platforms ~3 m above mean sea level
    it, igeoms = load('base-infrastructure')
    isub = col(it, 'subtype'); icls = col(it, 'class')
    n_piers = 0
    for g, s, c in zip(igeoms, isub, icls):
        if s != 'pier' or g is None:
            continue
        if g.geom_type in ('LineString', 'MultiLineString'):
            # narrow docks: buffer the centerline (≈ 2.5 m wide)
            g = g.buffer(1.25 / 111000 * 1.15, cap_style=2, join_style=2)
        for p in (list(g.geoms) if g.geom_type == 'MultiPolygon' else [g] if g.geom_type == 'Polygon' else []):
            add(p, 3.0, 0, KIND['pier'], ground_override=0.0); n_piers += 1

    print(f'{len(items)} footprints ({n_parts} parts, {n_piers} piers)')

    # ——— tiles ———
    tw, td = (x1m - x0m) / TILES, (z1m - z0m) / TILES
    def tile_of(ring):
        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
        return int(np.clip((cz - z0m) // td, 0, TILES - 1)) * TILES + int(np.clip((cx - x0m) // tw, 0, TILES - 1))
    buckets = [[] for _ in range(TILES * TILES)]
    for it_ in items:
        buckets[tile_of(it_[0])].append(it_)
    order = []
    first = np.zeros(TILES * TILES, np.uint32); count = np.zeros(TILES * TILES, np.uint32)
    for k, b in enumerate(buckets):
        b.sort(key=lambda r: -(r[2] - r[1]))
        first[k] = len(order); count[k] = len(b)
        order += [(k, r) for r in b]

    n = len(order)
    nverts = np.zeros(n, np.uint8); z0 = np.zeros(n, np.uint16); z1 = np.zeros(n, np.uint16)
    kind = np.zeros(n, np.uint8); rgb = np.zeros((n, 3), np.uint8)
    coords = []
    for i, (k, (ring, bottom, top, kd, c)) in enumerate(order):
        ox = x0m + (k % TILES) * tw; oz = z0m + (k // TILES) * td
        q = np.round((ring - [ox, oz]) * Q).astype(np.int32)
        d = q.copy(); d[1:] = q[1:] - q[:-1]
        assert np.abs(d).max() < 32767, 'coordinate overflow'
        coords.append(d.astype(np.int16))
        nverts[i] = len(ring)
        z0[i] = int(round((bottom + 100) * 10)); z1[i] = int(round((top + 100) * 10))
        kind[i] = kd; rgb[i] = np.clip(c, 0, 255)
    coords = np.concatenate(coords)
    hdr = b'KBLD' + struct.pack('<HHHII5f', 2, TILES, TILES, n, len(coords), x0m, z0m, tw, td, 1.0 / Q)
    # planar: all x deltas, then all z deltas
    blob = (hdr + first.tobytes() + count.tobytes() + nverts.tobytes() + z0.tobytes() + z1.tobytes() + kind.tobytes()
            + rgb.tobytes() + np.ascontiguousarray(coords[:, 0]).tobytes() + np.ascontiguousarray(coords[:, 1]).tobytes())
    with gzip.open(os.path.join(DATA, 'buildings.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(blob)
    hs = (z1.astype(float) - z0) / 10
    print(f'buildings.bin.gz: {n} buildings, {len(coords)} vertices, raw {len(blob)/1e6:.1f} MB, '
          f'gz {os.path.getsize(os.path.join(DATA, "buildings.bin.gz"))/1e6:.2f} MB; '
          f'height p50 {np.percentile(hs,50):.1f} p99 {np.percentile(hs,99):.1f} max {hs.max():.0f}')

if __name__ == '__main__':
    main()
