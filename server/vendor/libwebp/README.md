# Bundled libwebp decoder

`webp_codec.wasm` is the unmodified binary shipped in `playwright-core` 1.63.0
(`lib/webp_codec.wasm`, 565369 bytes). It is bundled here so production only
requires Node.js 24; Playwright, a browser, npm packages, and native executables
are not runtime dependencies.

SHA-256: `164cd9583a3e4d081f767d3b41ff0a730443dc7535fcc5caff83561463384b79`

Upstream sources and build instructions:

- Playwright package: <https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz>
- Build: <https://github.com/microsoft/playwright/blob/main/utils/libwebp-wasm/build.sh>
- C wrapper: <https://github.com/microsoft/playwright/blob/main/utils/libwebp-wasm/webp_wasm.c>
- Build documentation: <https://github.com/microsoft/playwright/blob/main/utils/libwebp-wasm/README.md>
- libwebp source pinned by that build: <https://github.com/webmproject/libwebp/tree/3757b8afeb54e305eaef18502812a9a88b7ed662>

The upstream build uses Emscripten (tested version 6.0.2), SIMD, synchronous
instantiation, growing memory, no filesystem and no threads. The source pin is
a post-1.6.0 libwebp commit; the package version and checksum above identify the
exact distributed binary. Updates must review the decoder ABI, source pin and
licenses together and run the community media tests.

`../../community-webp.mjs` is a project-owned Node.js loader for this binary.
It uses only the decoder, creates a separate instance per validation, limits
its heap to 512 MiB and frees all allocated input, dimensions and decoded
pixels. Existing container and 40-million-pixel limits are checked before
decoding. The exported ABI is fixed to this checksum: `f` memory, `g` runtime
constructors, `i` RGBA decode, `j` WebPFree, `k` malloc and `l` free. No upstream
JavaScript glue or TypeScript wrapper is included.

`LICENSE.libwebp` is the original bundled license notice: libwebp BSD-3-Clause,
its patent grant, and the Emscripten runtime licenses. `LICENSE.Playwright`
preserves Apache-2.0 for the Playwright C wrapper included in the binary:
Copyright (c) Microsoft Corporation. `NOTICE.Playwright` preserves the original
package notice; the included wrapper directly calls WebPDecodeRGBA and WebPFree.

The tiny VP8/VP8L regression fixtures under `tests/fixtures` were generated
from an original 4x3 RGBA test pattern using this codec; they include alpha.
