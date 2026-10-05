#!/bin/sh
# Rebuild everything in data/ from public sources (see tools/bake/README.md).
set -e
cd "$(dirname "$0")"
export PYTHONPATH="$PWD"
export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
python3 overture.py      # Overture Maps extracts -> tools/.cache/*.parquet
python3 dem.py           # AWS Terrain Tiles -> data/terrain-*.png
python3 imagery.py       # Sentinel-2 L2A -> tools/.cache/s2-*.npy
python3 ground.py        # albedo textures, coastline-conformed terrain
python3 buildings.py     # data/buildings.bin.gz
python3 trees.py         # data/trees.bin.gz
