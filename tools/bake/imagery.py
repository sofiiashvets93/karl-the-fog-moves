"""Pull Sentinel-2 L2A (Element 84 COGs on AWS) for the regions and reproject to
lon/lat-aligned grids. TCI for color, B04/B08 for a vegetation index."""
import os
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_bounds
from common import NEAR, FAR, CACHE

SCENE = 'sentinel-s2-l2a-cogs/10/S/EG/2025/6/S2C_10SEG_20250617_0_L2A'
BASE = f'/vsicurl/https://sentinel-cogs.s3.us-west-2.amazonaws.com/{SCENE}'
os.environ.setdefault('CURL_CA_BUNDLE', '/root/.ccr/ca-bundle.crt')

def grab(band, r, w, h, resampling=Resampling.cubic):
    dst_t = from_bounds(r['lonW'], r['latS'], r['lonE'], r['latN'], w, h)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                      GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES'):
        with rasterio.open(f'{BASE}/{band}.tif') as src:
            out = np.zeros((src.count, h, w), np.float32)
            for b in range(src.count):
                reproject(rasterio.band(src, b + 1), out[b], dst_transform=dst_t, dst_crs='EPSG:4326',
                          resampling=resampling)
    return out

if __name__ == '__main__':
    tci = grab('TCI', NEAR, 2048, 2048)
    np.save(os.path.join(CACHE, 's2-near-tci.npy'), tci.astype(np.uint8))
    for b in ('B04', 'B08', 'B02', 'B03'):
        np.save(os.path.join(CACHE, f's2-near-{b}.npy'), grab(b, NEAR, 2048, 2048)[0])
    far = grab('TCI', FAR, 2048, 1172, Resampling.average)
    np.save(os.path.join(CACHE, 's2-far-tci.npy'), far.astype(np.uint8))
    print('near tci', tci.shape, tci.reshape(3, -1).mean(1), 'far', far.shape)
