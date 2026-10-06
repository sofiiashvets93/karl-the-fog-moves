"""Compose the ground albedo for the detailed region and the backdrop.

Base color is Sentinel-2 L2A true color, converted to linear surface
reflectance. On top of it, OpenStreetMap-derived Overture vectors add what a
10 m satellite pixel cannot resolve: road surfaces, sidewalks, sand, lawns and
roof outlines. The land/water mask comes from the OSM coastline and is also
used to conform the elevation grid so the shore sits exactly at sea level.

Outputs (data/):
  ground-near.webp     4096² sRGB color; alpha 0 = water, 0.78..1 = land
                       (lower along roads, used for street lighting)
  ground-near-2k.webp  2048² version for small screens
  ground-far.webp      backdrop color
  terrain-near.png     re-written with the coastline conformed
"""
import os
import numpy as np
import shapely
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
from common import NEAR, FAR, CACHE, DATA, HEIGHT_SCALE, HEIGHT_OFF
from vectors import load, col

N = 4096          # output texture size
SS = 2            # supersampling for vector overlays
SIZE = N * SS

def lin2srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)

def to_px(lon, lat, size, r=NEAR):
    return ((lon - r['lonW']) / (r['lonE'] - r['lonW']) * size,
            (r['latN'] - lat) / (r['latN'] - r['latS']) * size)

def rings_px(geom, size):
    out = []
    polys = list(geom.geoms) if geom.geom_type == 'MultiPolygon' else [geom]
    for p in polys:
        if p.is_empty:
            continue
        ext = np.asarray(p.exterior.coords)
        x, y = to_px(ext[:, 0], ext[:, 1], size)
        holes = []
        for h in p.interiors:
            hh = np.asarray(h.coords)
            hx, hy = to_px(hh[:, 0], hh[:, 1], size)
            holes.append(list(zip(hx, hy)))
        out.append((list(zip(x, y)), holes))
    return out

def poly_mask(geoms, size=SIZE):
    """Rasterize polygons (with holes) into an 8-bit mask."""
    im = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(im)
    for g in geoms:
        if g is None or g.is_empty or g.geom_type not in ('Polygon', 'MultiPolygon'):
            continue
        for ext, holes in rings_px(g, size):
            if len(ext) >= 3:
                d.polygon(ext, fill=255)
            for h in holes:
                if len(h) >= 3:
                    d.polygon(h, fill=0)
    return im

def line_mask(geoms, widths_m, size=SIZE):
    """Rasterize lines with per-feature widths in meters."""
    im = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(im)
    m_per_px = (NEAR['latN'] - NEAR['latS']) * 111000 / size
    for g, w in zip(geoms, widths_m):
        if g is None or g.is_empty or w <= 0:
            continue
        lines = list(g.geoms) if g.geom_type == 'MultiLineString' else [g]
        wp = max(1, int(round(w / m_per_px)))
        for ln in lines:
            c = np.asarray(ln.coords)
            x, y = to_px(c[:, 0], c[:, 1], size)
            pts = list(zip(x, y))
            d.line(pts, fill=255, width=wp, joint='curve')
            r = wp / 2
            for px, py in (pts[0], pts[-1]):
                d.ellipse([px - r, py - r, px + r, py + r], fill=255)
    return im

def down(im):
    """Supersampled mask -> output resolution float 0..1."""
    return np.asarray(im.resize((N, N), Image.Resampling.BOX), np.float32) / 255

ROAD_W = {  # carriageway widths (m) by Overture road class
    'motorway': 22, 'trunk': 18, 'primary': 15, 'secondary': 13, 'tertiary': 11,
    'residential': 9, 'unclassified': 8, 'living_street': 7, 'service': 5,
    'pedestrian': 6, 'track': 3, 'footway': 1.8, 'path': 1.6, 'cycleway': 2.2, 'steps': 0,
}

def main():
    # ——— base color: Sentinel-2 TCI is linear in reflectance (≈ R × 1000, capped) ———
    tci = np.load(os.path.join(CACHE, 's2-near-tci.npy')).astype(np.float32)
    base = np.stack([np.asarray(Image.fromarray(tci[i].astype(np.uint8)).resize((N, N), Image.Resampling.BICUBIC),
                                np.float32) for i in range(3)], -1) / 1000.0
    base = np.clip(base, 0.004, None)
    # Sentinel-2 bands are not perfectly co-registered: roof edges get colored
    # fringes. Keep luminance sharp, low-pass the chroma.
    lum = base.mean(-1, keepdims=True)
    chroma = base / lum
    chroma = np.stack([gaussian_filter(chroma[..., i], 2.5) for i in range(3)], -1)
    base = lum * chroma
    ndvi_src = None
    b4 = np.load(os.path.join(CACHE, 's2-near-B04.npy')); b8 = np.load(os.path.join(CACHE, 's2-near-B08.npy'))
    ndvi_src = (b8 - b4) / np.maximum(b8 + b4, 1)
    ndvi = np.asarray(Image.fromarray(ndvi_src.astype(np.float32)).resize((N, N), Image.Resampling.BILINEAR))

    # ——— land / water from the OSM coastline (Overture land + water) ———
    land_t, land_g = load('base-land')
    water_t, water_g = load('base-water')
    wsub = col(water_t, 'subtype'); wcls = col(water_t, 'class')
    land_polys = [g for g, s in zip(land_g, col(land_t, 'subtype')) if s in ('land',) and g.geom_type in ('Polygon', 'MultiPolygon')]
    water_polys = [g for g, s, c in zip(water_g, wsub, wcls)
                   if g.geom_type in ('Polygon', 'MultiPolygon') and c not in ('swimming_pool', 'fountain')]
    dem = np.load(os.path.join(CACHE, 'terrain-near.npy'))
    lm = poly_mask(land_polys)
    land = down(lm)
    if land.mean() < 0.05:
        # no coastline polygons in the extract: fall back to the elevation model
        print('land polygons missing; using DEM coastline')
        land = (np.asarray(Image.fromarray(dem).resize((N, N), Image.Resampling.BILINEAR)) > 0.5).astype(np.float32)
    wm = down(poly_mask(water_polys))
    land = np.clip(land - wm, 0, 1)
    print('land fraction', land.mean().round(3))

    # ——— conform the DEM to the coastline at its own resolution ———
    G = dem.shape[0]
    land_g_res = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).resize((G, G), Image.Resampling.BOX), np.float32) / 255
    dem2 = dem.copy()
    on_land = land_g_res > 0.5
    dem2[on_land] = np.maximum(dem2[on_land], 1.2 + 1.5 * (land_g_res[on_land] - 0.5))
    in_water = ~on_land
    dem2[in_water] = np.minimum(dem2[in_water], -0.6 - 1.2 * (0.5 - land_g_res[in_water]))
    v = np.clip(np.round(dem2 * HEIGHT_SCALE + HEIGHT_OFF), 0, 65535).astype(np.uint32)
    rgb = np.zeros((G, G, 3), np.uint8); rgb[..., 0] = v >> 8; rgb[..., 1] = v & 255
    Image.fromarray(rgb).save(os.path.join(DATA, 'terrain-near.png'), optimize=True)
    np.save(os.path.join(CACHE, 'terrain-near-conformed.npy'), dem2.astype(np.float32))
    print('terrain-near.png conformed', os.path.getsize(os.path.join(DATA, 'terrain-near.png')) / 1e6, 'MB')

    col_ = base.copy()

    def blend(mask, color, k=1.0, keep_texture=0.0):
        """Mix toward `color` (linear) by mask*k, optionally keeping some local texture."""
        nonlocal col_
        m = (mask * k)[..., None]
        c = np.asarray(color, np.float32)[None, None, :]
        if keep_texture > 0:
            lum = col_.mean(-1, keepdims=True)
            lum_s = gaussian_filter(lum[..., 0], 6)[..., None]
            c = c * (1 + keep_texture * (lum / np.maximum(lum_s, 1e-3) - 1))
        col_ = col_ * (1 - m) + c * m

    # ——— natural surfaces ———
    lclass = col(land_t, 'class')
    sand = down(poly_mask([g for g, c in zip(land_g, lclass) if c in ('beach', 'sand', 'shingle')]))
    rock = down(poly_mask([g for g, c in zip(land_g, lclass) if c in ('bare_rock', 'cliff', 'rock', 'scree')]))
    blend(sand * land, (0.32, 0.28, 0.21), 0.55, keep_texture=0.6)
    blend(rock * land, (0.16, 0.14, 0.12), 0.35, keep_texture=0.8)

    lu_t, lu_g = load('base-land_use')
    lucls = col(lu_t, 'class')
    lawn = down(poly_mask([g for g, c in zip(lu_g, lucls) if c in ('pitch', 'grass', 'green', 'fairway', 'tee', 'park', 'recreation_ground', 'garden', 'dog_park', 'meadow', 'village_green', 'cemetery')]))
    # irrigated lawns: only where the satellite agrees it is green and bright enough to be grass
    green = np.clip((ndvi - 0.45) / 0.2, 0, 1)
    blend(lawn * green * land, (0.055, 0.095, 0.030), 0.35, keep_texture=1.0)
    bunker = down(poly_mask([g for g, c in zip(lu_g, lucls) if c in ('bunker',)]))
    blend(bunker * land, (0.36, 0.32, 0.25), 0.8)

    # ——— roads: sidewalks first, then the carriageway ———
    seg_t, seg_g = load('transportation-segment')
    cls = col(seg_t, 'class'); sub = col(seg_t, 'subtype'); subcls = col(seg_t, 'subclass')
    flags = col(seg_t, 'road_flags')
    def is_bridge_or_tunnel(f):
        if not f:
            return False
        for r in f:
            vals = r.get('values') or []
            if 'is_bridge' in vals or 'is_tunnel' in vals:
                return True
        return False
    road_g, road_w, walk_g, walk_w, rail_g = [], [], [], [], []
    for g, c, s, sc, f in zip(seg_g, cls, sub, subcls, flags):
        if g is None or g.geom_type not in ('LineString', 'MultiLineString'):
            continue
        if is_bridge_or_tunnel(f):
            continue
        if s == 'rail':
            if c in ('standard_gauge', 'light_rail', 'tram'):
                rail_g.append(g)
            continue
        w = ROAD_W.get(c, 0)
        if c in ('footway', 'path', 'cycleway') or sc in ('sidewalk', 'crosswalk'):
            if sc in ('crosswalk',):
                continue
            walk_g.append(g); walk_w.append(w)
        elif w > 0:
            road_g.append(g); road_w.append(w)
    curb = down(line_mask(road_g, [w + 6 for w in road_w]))
    road = down(line_mask(road_g, road_w))
    walks = down(line_mask(walk_g, walk_w))
    # SF asphalt reads mid-gray from the air; concrete sidewalks are lighter
    blend(curb * land, (0.20, 0.195, 0.185), 0.55, keep_texture=0.5)
    blend(walks * land * (1 - road), (0.21, 0.20, 0.18), 0.35, keep_texture=0.5)
    blend(road * land, (0.085, 0.087, 0.09), 0.80, keep_texture=0.35)
    rails = down(line_mask(rail_g, [3.0] * len(rail_g)))
    blend(rails * land, (0.07, 0.065, 0.06), 0.5)

    # ——— roofs: crisp footprints, colored from the satellite's local tone ———
    b_t, b_g = load('buildings-building', ['geometry', 'is_underground'])
    under = col(b_t, 'is_underground')
    roofs = [g for g, u in zip(b_g, under) if not u]
    rm = down(poly_mask(roofs))
    # building "gaps" and contact shadow: a soft dark halo outside the footprints
    halo = gaussian_filter(rm, 2.2)
    ao = np.clip(halo - rm, 0, 1)
    lum_local = gaussian_filter(col_.mean(-1), 3)
    roof_col = np.stack([lum_local * 1.05, lum_local * 1.02, lum_local * 0.97], -1)
    roof_col = 0.5 * roof_col + 0.5 * col_
    col_ = col_ * (1 - rm[..., None] * 0.6) + roof_col * (rm[..., None] * 0.6)
    col_ *= (1 - 0.30 * ao * land)[..., None]

    # ——— underwater: keep satellite tone but darken (the water shader takes over) ———
    col_ = col_ * (0.65 + 0.35 * land[..., None])

    srgb = (lin2srgb(col_) * 255 + 0.5).astype(np.uint8)
    # alpha: 0 = water; land is 0.78..1, lowered along roads (street lighting at night)
    roadmask = np.clip(np.maximum(road, curb * 0.6), 0, 1)
    alpha = (np.clip(land, 0, 1) * (1 - 0.22 * roadmask) * 255 + 0.5).astype(np.uint8)
    rgba = np.dstack([srgb, alpha])
    im = Image.fromarray(rgba, 'RGBA')
    im.save(os.path.join(DATA, 'ground-near.webp'), quality=84, method=6, alpha_quality=100)
    im.resize((2048, 2048), Image.Resampling.LANCZOS).save(os.path.join(DATA, 'ground-near-2k.webp'), quality=84, method=6)
    np.save(os.path.join(CACHE, 'land-near.npy'), land.astype(np.float16))
    np.save(os.path.join(CACHE, 'ndvi-near.npy'), ndvi.astype(np.float16))
    np.save(os.path.join(CACHE, 'roofmask-near.npy'), rm.astype(np.float16))
    np.save(os.path.join(CACHE, 'roadmask-near.npy'), np.maximum(curb, walks).astype(np.float16))
    for f in ('ground-near.webp', 'ground-near-2k.webp'):
        print(f, round(os.path.getsize(os.path.join(DATA, f)) / 1e6, 2), 'MB')

    # ——— backdrop ———
    far = np.load(os.path.join(CACHE, 's2-far-tci.npy')).astype(np.float32) / 1000.0
    far = np.moveaxis(far, 0, -1)
    demf = np.load(os.path.join(CACHE, 'terrain-far.npy'))
    landf = np.asarray(Image.fromarray(demf).resize((far.shape[1], far.shape[0]), Image.Resampling.BILINEAR)) > 0.3
    far_rgb = (lin2srgb(far * (0.65 + 0.35 * landf[..., None])) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(far_rgb).save(os.path.join(DATA, 'ground-far.webp'), quality=82, method=6)
    print('ground-far.webp', round(os.path.getsize(os.path.join(DATA, 'ground-far.webp')) / 1e6, 2), 'MB')

if __name__ == '__main__':
    main()
