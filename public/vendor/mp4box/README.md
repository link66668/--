# MP4Box.js 2.4.1

Unmodified browser ESM assets from the official `mp4box@2.4.1` npm tarball. Copyright Telecom ParisTech/TSI/MM/GPAC Cyril Concolato; distributed under BSD-3-Clause. See `LICENSE`.

`manifest.json` pins the official npm URL, SHA-512 package integrity and SHA-256 of each shipped asset. `node scripts/setup-motion-assets.mjs --verify` verifies MP4Box without network access. Omit `--verify` to restore missing or corrupt assets; upstream hash changes fail rather than silently updating a dependency.

MP4 parsing runs in the existing pose worker. Supported MP4 tracks use native WebCodecs sequential decoding. Encoded chunks are submitted in decode order; output is selected by presentation timestamps (PTS), with the single edit-list time offset applied. For each 15 Hz target, the source frame covering that time is used; lower-rate source frames may therefore serve multiple targets. `sourceFps` reports unique original presentation frames per second and must be used separately from the output sampling rate.

The decoder input queue is bounded. Each output VideoFrame is drawn to a bounded canvas and closed; sampling waits for the selected MediaPipe Pose Landmarker tier to finish inference before reusing the canvas. Decoder submissions pause while inference is active, so the app does not accumulate a full decoded video. MP4 input is read in 4 MiB chunks; the parser's buffers are discarded after preparation, and compressed sample bytes are released as they are submitted. Browser codec-internal reordering buffers are managed by WebCodecs.

Unavailable codecs, complex edit lists, rotated tracks, non-MP4 containers, and sequential decode errors use the existing HTMLVideo seek path. MP4/M4V/MOV metadata extraction still reports original source FPS for supported simple timelines even when the sequential path is unavailable or rotated. For WebM, complex edit lists, or failed parsing, `sourceFps` is `null`; no original-frame-rate measurement is claimed. The fallback restarts from the beginning after a decode error rather than returning partial coverage. Cancelling terminates the worker and its native decoder. WebCodecs requires a supported browser and a secure context (HTTPS or localhost).

Sources:

- https://github.com/gpac/mp4box.js
- https://raw.githubusercontent.com/w3c/webcodecs/main/samples/video-decode-display/demuxer_mp4.js
- https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder

The implementation uses the pinned package's `Endianness.BIG_ENDIAN` API and registers extraction during `onReady`; older examples use different APIs.
