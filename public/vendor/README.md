# Browser dependencies

Vendored ESM builds, served locally and available offline. No runtime CDN requests.

## Three-tier pose analysis

- `mediapipe/`: `@mediapipe/tasks-vision` 0.10.32 and Pose Landmarker **Lite / Full / Heavy** float16 v1. Apache-2.0; see `mediapipe/LICENSE.txt` and `NOTICE.txt`. Runtime, SIMD/non-SIMD WASM and the selected model are loaded on demand from this server. `manifest.json` pins npm integrity, source URLs and SHA-256 hashes. Restore with `node scripts/setup-motion-assets.mjs`; verify with `--verify`. All tiers use the same adapter, 33-point image/world output and 17-point body evidence. Full is the default; Lite favors speed and Heavy favors accuracy.

## Local video decoding

- `ffmpeg/`: official `@ffmpeg/core` 0.12.10 single-thread UMD and WebAssembly, loaded only when the browser cannot read a video picture. See `ffmpeg/NOTICE.txt` and its bundled license files. The original video is mounted read-only in a disposable local worker and decoded into frames for synchronous pose inference, sampled JPEG replay and AI evidence. No intermediate MP4, video upload or runtime CDN is used. Asset restoration and integrity verification: `node scripts/setup-motion-codec.mjs` / `node scripts/setup-motion-codec.mjs --verify`.

- marked 18.0.14: https://registry.npmjs.org/marked/-/marked-18.0.14.tgz (`package/lib/marked.esm.js`). MIT license in marked-LICENSE.md.
- DOMPurify 3.4.16: https://registry.npmjs.org/dompurify/-/dompurify-3.4.16.tgz (`package/dist/purify.es.mjs`). Apache-2.0 or MPL-2.0 license in DOMPurify-LICENSE.

Upstream documentation: https://marked.js.org/ and https://github.com/cure53/DOMPurify

To update, replace each ESM build and license from the pinned package archive, then run the chat rendering and browser regression checks. Keep the parser and sanitizer together: Marked does not sanitize HTML.

## Landing page motion

- GSAP and ScrollTrigger 3.15.0: unmodified `package/dist/gsap.min.js` and `package/dist/ScrollTrigger.min.js` from https://registry.npmjs.org/gsap/-/gsap-3.15.0.tgz. Copyright and license notices are retained in both files. License: https://gsap.com/standard-license.
- Cabinet Grotesk 400 and 700: WOFF2 files in `public/assets/fonts`, retrieved from Fontshare's CSS API on 2026-10-02. Source: https://www.fontshare.com/fonts/cabinet-grotesk. License: https://www.fontshare.com/licenses/itf-ffl. Chinese text uses the device's Chinese font fallback.

These files are served locally and included in the offline shell. Landing page animations use a scoped GSAP matchMedia context, reverted on pause, reduced motion, and authentication. Run `scripts/qa-landing.mjs` after updates.
