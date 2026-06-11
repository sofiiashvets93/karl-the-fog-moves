// Shared geography: maps lon/lat around San Francisco into world units.
// 1 world unit = 100 m. +x = east, +z = south, +y = up. Heights exaggerated.

export const REGION = { lonW: -122.55, lonE: -122.33, latS: 37.695, latN: 37.87 };

export const KM_LON = 87.9;   // km per degree of longitude at 37.78°N
export const KM_LAT = 111.1;  // km per degree of latitude
export const UPK = 10;        // world units per km
export const HX = 1.85;      // vertical exaggeration

export const C_LON = (REGION.lonW + REGION.lonE) / 2;
export const C_LAT = (REGION.latS + REGION.latN) / 2;

// lon/lat -> [x, z] in world units
export function W(lon, lat) {
  return [
    (lon - C_LON) * KM_LON * UPK,
    -(lat - C_LAT) * KM_LAT * UPK,
  ];
}

// lon/lat -> [x, z] in km (used by the fog shader, which works in km)
export function KMP(lon, lat) {
  return [
    (lon - C_LON) * KM_LON,
    -(lat - C_LAT) * KM_LAT,
  ];
}

// meters of real elevation -> world units (exaggerated)
export function hU(m) {
  return (m * HX) / 100;
}

export const WORLD_W = (REGION.lonE - REGION.lonW) * KM_LON * UPK; // ~193
export const WORLD_H = (REGION.latN - REGION.latS) * KM_LAT * UPK; // ~194
