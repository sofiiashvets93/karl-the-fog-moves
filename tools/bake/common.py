"""Shared settings for the Karl geodata bake. Keep in sync with js/geo.js."""
import math, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'tools', '.cache')
DATA = os.path.join(ROOT, 'data')
os.makedirs(CACHE, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

# Detailed region: San Francisco, the Golden Gate, the Marin Headlands, Angel Island.
NEAR = dict(lonW=-122.56, lonE=-122.32, latS=37.69, latN=37.875)
# Backdrop: the coast, Mt Tamalpais, the East Bay hills, Mt Diablo.
FAR = dict(lonW=-122.95, lonE=-121.85, latS=37.45, latN=37.95)

# Local tangent-plane projection centered on the detailed region (meters).
C_LON = (NEAR['lonW'] + NEAR['lonE']) / 2
C_LAT = (NEAR['latS'] + NEAR['latN']) / 2
M_LAT = 111132.954 - 559.822 * math.cos(2 * math.radians(C_LAT)) + 1.175 * math.cos(4 * math.radians(C_LAT))
M_LON = 111412.84 * math.cos(math.radians(C_LAT)) - 93.5 * math.cos(3 * math.radians(C_LAT))

def to_xz(lon, lat):
    """lon/lat -> local meters (+x east, +z south)."""
    return (lon - C_LON) * M_LON, -(lat - C_LAT) * M_LAT

def region_m(r):
    x0, z0 = to_xz(r['lonW'], r['latN'])
    x1, z1 = to_xz(r['lonE'], r['latS'])
    return x0, x1, z0, z1

HEIGHT_SCALE = 10     # stored value = meters * 10 + HEIGHT_OFF  (0.1 m steps)
HEIGHT_OFF = 16384
