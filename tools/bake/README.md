# Geodata bake

Everything in `data/` is generated from public sources by these scripts.

| Output | Source | License |
| --- | --- | --- |
| `terrain-near.png`, `terrain-far.png` | AWS Terrain Tiles (USGS 3DEP on land, NOAA bathymetry offshore) | Public domain / attribution |
| `ground-near*.webp`, `ground-far.webp` | Copernicus Sentinel-2 L2A, 17 Jun 2025 (Element 84 COGs on AWS) + Overture Maps vectors | Contains modified Copernicus Sentinel data 2025; ODbL |
| `buildings.bin.gz` | Overture Maps buildings (OpenStreetMap, incl. San Francisco's LiDAR-derived heights) | ODbL |
| `trees.bin.gz` | OpenStreetMap trees + Sentinel-2 vegetation index | ODbL / Copernicus |

Requirements: Python 3.10+, `pip install numpy pillow pyarrow shapely rasterio scipy`.

```sh
tools/bake/bake_all.sh
```

Stages can be run one by one (`python3 tools/bake/<stage>.py` with
`PYTHONPATH=tools/bake`). Intermediate downloads are cached in `tools/.cache/`
(git-ignored). Region bounds live in `common.py` and must match `js/geo.js`.
