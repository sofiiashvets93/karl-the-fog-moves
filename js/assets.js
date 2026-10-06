// Loads the baked data in data/ with byte-level progress.

import { HEIGHT_SCALE, HEIGHT_OFF } from './geo.js';

const BASE = new URL('../data/', import.meta.url);

export class AssetLoader {
  constructor(onProgress) {
    this.onProgress = onProgress || (() => {});
    this.expected = new Map(); // url -> bytes (estimated until headers arrive)
    this.loaded = new Map();
  }

  _report() {
    let e = 0, l = 0;
    for (const v of this.expected.values()) e += v;
    for (const v of this.loaded.values()) l += v;
    this.onProgress(e ? Math.min(1, l / e) : 0);
  }

  async buffer(name, estimate = 1e6) {
    const url = new URL(name, BASE).href;
    this.expected.set(url, estimate);
    this.loaded.set(url, 0);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length')) || estimate;
    this.expected.set(url, len);
    if (!res.body || !res.body.getReader) {
      const b = await res.arrayBuffer();
      this.loaded.set(url, len);
      this._report();
      return b;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      this.loaded.set(url, Math.min(got, len));
      this._report();
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    this.loaded.set(url, len);
    this._report();
    return out.buffer;
  }

  async gz(name, estimate) {
    const buf = await this.buffer(name, estimate);
    // some hosts decompress .gz transparently: only inflate real gzip data
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }

  async json(name, estimate) {
    return JSON.parse(new TextDecoder().decode(await this.buffer(name, estimate)));
  }

  async bitmap(name, estimate) {
    const buf = await this.buffer(name, estimate);
    const type = name.endsWith('.webp') ? 'image/webp' : 'image/png';
    return createImageBitmap(new Blob([buf], { type }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      imageOrientation: 'none',
    });
  }

  // 16-bit elevation PNG (R = high byte, G = low byte) -> Float32Array meters
  async heights(name, estimate) {
    const bmp = await this.bitmap(name, estimate);
    const { width: w, height: h } = bmp;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    bmp.close?.();
    const data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      data[i] = (px[i * 4] * 256 + px[i * 4 + 1] - HEIGHT_OFF) / HEIGHT_SCALE;
    }
    return { data, w, h };
  }
}
