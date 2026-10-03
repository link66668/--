import { readFileSync } from 'node:fs';

// Pinned Playwright/libwebp WASM; its ABI, source and licenses live beside it.
// Compile once, but use a fresh heap for every file. A failed decode cannot
// poison later uploads or leave a large decoded image resident in a singleton.
const codec = new WebAssembly.Module(readFileSync(new URL('./vendor/libwebp/webp_codec.wasm', import.meta.url)));
const PAGE = 65536;
const MAX_HEAP = 512 * 1024 * 1024;

export function decodeCommunityWebpDimensions(data) {
  let api;
  const fail = () => { throw new Error('WebP decoder aborted'); };
  const instance = new WebAssembly.Instance(codec, { a: {
    // These Emscripten timer/exit imports are unused by the synchronous,
    // threadless decoder. Fail closed if an unexpected runtime path invokes one.
    a: fail, c: fail, d: () => {}, e: fail,
    b: requested => {
      const size = requested >>> 0, current = api.f.buffer.byteLength;
      if (size > MAX_HEAP) return 0;
      if (size <= current) return 1;
      try { api.f.grow(Math.ceil((size - current) / PAGE)); return 1; }
      catch { return 0; }
    },
  } });
  api = instance.exports;
  // g: constructors, f: memory, i: WebPDecodeRGBA wrapper, j: WebPFree,
  // k/l: malloc/free. The pinned binary's exported names are minified.
  api.g();
  let input = 0, dimensions = 0, pixels = 0;
  try {
    input = api.k(data.length); dimensions = api.k(8);
    if (!input || !dimensions) throw new Error('WebP decoder allocation failed');
    new Uint8Array(api.f.buffer).set(data, input);
    pixels = api.i(input, data.length, dimensions, dimensions + 4);
    if (!pixels) throw new Error('WebP image data is invalid');
    // Decoding, rather than only parsing a header, verifies the entire payload.
    // Keep the pixels in WASM; validation only needs the decoded dimensions.
    const view = new DataView(api.f.buffer);
    return { width: view.getUint32(dimensions, true), height: view.getUint32(dimensions + 4, true) };
  } finally {
    if (pixels) api.j(pixels);
    if (dimensions) api.l(dimensions);
    if (input) api.l(input);
  }
}
