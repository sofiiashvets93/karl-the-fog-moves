"""Extract Overture Maps features (buildings, roads, land, water, land use,
infrastructure) inside the bake bounds to tools/.cache/*.parquet.
Reads only the row groups whose bbox statistics overlap, straight from the
public S3 bucket (anonymous)."""
import os, sys, time, json, concurrent.futures as cf
import pyarrow as pa, pyarrow.fs as pafs, pyarrow.parquet as pq, pyarrow.compute as pc

REL = 'overturemaps-us-west-2/release/2026-09-23.1'
from common import NEAR, CACHE as OUT
BB = dict(xmin=NEAR['lonW'], xmax=NEAR['lonE'], ymin=NEAR['latS'], ymax=NEAR['latN'])
fs = pafs.S3FileSystem(anonymous=True, region='us-west-2', proxy_options=os.environ.get('HTTPS_PROXY'))

COLS = {
  'buildings/building': ['id', 'height', 'min_height', 'num_floors', 'class', 'subtype', 'is_underground',
                         'facade_color', 'facade_material', 'roof_material', 'roof_shape', 'roof_color', 'roof_height',
                         'has_parts', 'names', 'geometry', 'bbox'],
  'buildings/building_part': ['id', 'building_id', 'height', 'min_height', 'num_floors', 'min_floor', 'is_underground',
                         'facade_color', 'facade_material', 'roof_material', 'roof_shape', 'roof_color', 'roof_height', 'geometry', 'bbox'],
  'base/land_cover': ['id', 'subtype', 'geometry', 'bbox'],
  'base/land_use': ['id', 'subtype', 'class', 'names', 'geometry', 'bbox'],
  'base/water': ['id', 'subtype', 'class', 'names', 'is_salt', 'is_intermittent', 'geometry', 'bbox'],
  'base/land': ['id', 'subtype', 'class', 'names', 'elevation', 'geometry', 'bbox'],
  'base/infrastructure': ['id', 'subtype', 'class', 'names', 'height', 'geometry', 'bbox'],
  'transportation/segment': ['id', 'subtype', 'class', 'subclass', 'names', 'road_flags', 'road_surface', 'width_rules', 'level_rules', 'geometry', 'bbox'],
}

def overlaps(st):
    return not (st['xmax'] < BB['xmin'] or st['xmin'] > BB['xmax'] or st['ymax'] < BB['ymin'] or st['ymin'] > BB['ymax'])

def rg_stats(md, i, name_to_idx):
    rg = md.row_group(i)
    out = {}
    for k in ('xmin', 'xmax', 'ymin', 'ymax'):
        c = rg.column(name_to_idx['bbox.' + k])
        s = c.statistics
        if s is None or not s.has_min_max: return None
        out[k + '_min'] = s.min; out[k + '_max'] = s.max
    # envelope of the row group: smallest xmin .. largest xmax
    return dict(xmin=out['xmin_min'], xmax=out['xmax_max'], ymin=out['ymin_min'], ymax=out['ymax_max'])

def scan_file(path, cols):
    f = fs.open_input_file(path)
    pf = pq.ParquetFile(f)
    md = pf.metadata
    name_to_idx = {md.schema.column(j).path: j for j in range(md.num_columns)}
    groups = []
    for i in range(md.num_row_groups):
        st = rg_stats(md, i, name_to_idx)
        if st is None or overlaps(st): groups.append(i)
    if not groups: return None
    avail = [c for c in cols if c in pf.schema_arrow.names]
    t = pf.read_row_groups(groups, columns=avail)
    b = t['bbox']
    m = pc.and_(pc.and_(pc.less_equal(pc.struct_field(b, 'xmin'), BB['xmax']), pc.greater_equal(pc.struct_field(b, 'xmax'), BB['xmin'])),
                pc.and_(pc.less_equal(pc.struct_field(b, 'ymin'), BB['ymax']), pc.greater_equal(pc.struct_field(b, 'ymax'), BB['ymin'])))
    t = t.filter(m)
    return t if t.num_rows else None

def extract(key):
    theme, typ = key.split('/')
    base = f'{REL}/theme={theme}/type={typ}/'
    files = [i.path for i in fs.get_file_info(pafs.FileSelector(base)) if i.path.endswith('.parquet')]
    t0 = time.time()
    parts = []
    with cf.ThreadPoolExecutor(24) as ex:
        for r in ex.map(lambda p: scan_file(p, COLS[key]), files):
            if r is not None: parts.append(r)
    if not parts:
        print(key, 'nothing'); return
    t = pa.concat_tables(parts, promote_options='permissive')
    out = f'{OUT}/{theme}-{typ}.parquet'
    pq.write_table(t, out)
    print(f'{key}: {t.num_rows} rows from {len(files)} files in {time.time()-t0:.0f}s -> {os.path.getsize(out)/1e6:.1f} MB', flush=True)

for k in (sys.argv[1:] or COLS.keys()):
    extract(k)
