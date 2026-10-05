"""Bake elevation grids from AWS Terrain Tiles (terrarium; USGS 3DEP on land,
NOAA bathymetry offshore) into 16-bit PNGs: R = high byte, G = low byte of
(meters * 10 + 16384)."""
import io, math, os, sys, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image
from common import NEAR, FAR, CACHE, DATA, HEIGHT_SCALE, HEIGHT_OFF

URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

def lon2tx(lon, z): return (lon + 180) / 360 * 2 ** z
def lat2ty(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z

def fetch(z, x, y):
    p = os.path.join(CACHE, 'terrarium', str(z), f'{x}_{y}.png')
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = urllib.request.urlopen(URL.format(z=z, x=x, y=y), timeout=60).read()
        with open(p, 'wb') as f: f.write(data)
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

def bake(r, z, gw, gh, name):
    x0, x1 = int(lon2tx(r['lonW'], z)) - 1, int(lon2tx(r['lonE'], z)) + 1
    y0, y1 = int(lat2ty(r['latN'], z)) - 1, int(lat2ty(r['latS'], z)) + 1
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    with cf.ThreadPoolExecutor(16) as ex:
        tiles = dict(zip(jobs, ex.map(lambda j: fetch(z, *j), jobs)))
    mosaic = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256))
    for (x, y), t in tiles.items():
        mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = t
    # sample a lon/lat-aligned grid with bicubic-ish (Catmull-Rom) interpolation
    lons = r['lonW'] + (r['lonE'] - r['lonW']) * (np.arange(gw) + 0.5) / gw
    lats = r['latN'] + (r['latS'] - r['latN']) * (np.arange(gh) + 0.5) / gh
    px = (lon2tx(lons, z) - x0) * 256 - 0.5
    py = (np.array([lat2ty(l, z) for l in lats]) - y0) * 256 - 0.5
    out = sample_cubic(mosaic, px[None, :].repeat(gh, 0), py[:, None].repeat(gw, 1))
    v = np.clip(np.round(out * HEIGHT_SCALE + HEIGHT_OFF), 0, 65535).astype(np.uint32)
    rgb = np.zeros((gh, gw, 3), np.uint8)
    rgb[..., 0] = v >> 8; rgb[..., 1] = v & 255
    Image.fromarray(rgb).save(os.path.join(DATA, name), optimize=True)
    np.save(os.path.join(CACHE, name.replace('.png', '.npy')), out.astype(np.float32))
    print(f'{name}: {gw}x{gh}, {os.path.getsize(os.path.join(DATA, name)) / 1e6:.2f} MB, '
          f'elev {out.min():.0f}..{out.max():.0f} m')

def sample_cubic(img, x, y):
    def w(t):  # Catmull-Rom weights
        t2, t3 = t * t, t * t * t
        return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - ix, y - iy
    wx, wy = w(fx), w(fy)
    H, W = img.shape
    acc = np.zeros_like(x)
    for j in range(4):
        yy = np.clip(iy + j - 1, 0, H - 1)
        row = np.zeros_like(x)
        for i in range(4):
            xx = np.clip(ix + i - 1, 0, W - 1)
            row += wx[i] * img[yy, xx]
        acc += wy[j] * row
    return acc

if __name__ == '__main__':
    bake(NEAR, 15, 2048, 2048, 'terrain-near.png')
    bake(FAR, 12, 1536, 880, 'terrain-far.png')
