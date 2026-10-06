"""Load the Overture extracts (see overture.py) as shapely geometries."""
import os
import numpy as np
import pyarrow.parquet as pq
import shapely
from common import CACHE

def load(name, columns=None):
    t = pq.read_table(os.path.join(CACHE, f'{name}.parquet'), columns=columns)
    geoms = shapely.from_wkb(t['geometry'].to_numpy(zero_copy_only=False))
    return t, geoms

def col(t, name):
    if name not in t.column_names:
        return [None] * t.num_rows
    return t[name].to_pylist()

def primary_names(t):
    out = []
    for n in col(t, 'names'):
        out.append(n.get('primary') if n else None)
    return out
