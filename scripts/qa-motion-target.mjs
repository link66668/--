// Real MediaPipe Full target-selection QA; requires local videos from the fixture scripts.
// QA_PLAYWRIGHT=/path/to/playwright/index.mjs QA_BROWSER=/path/to/browser node scripts/qa-motion-target.mjs
// Coordinate GPU use with other browser QA jobs. Images/frames stay under .qa.
// QA_TARGET_REPLAY=/path/to/prior/output reruns semantic checks without browser/GPU inference.
// QA_TARGET_SCENARIOS=baseline-squat,baseline-pushup selects scenario IDs; default runs all six.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeMotion } from '../public/motion-analysis.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), fixtureRoot = resolve(process.env.QA_MOTION_FIXTURES || join(root, '.qa/motion-fixtures'));
await mkdir(join(root, '.qa'), { recursive: true });
const output = await mkdtemp(join(root, '.qa/motion-target-'));
// Print before imports/startup/assertions, including when browser setup fails.
console.log(`Target QA artifacts: ${output}`);
const replayRoot = process.env.QA_TARGET_REPLAY ? resolve(process.env.QA_TARGET_REPLAY) : null;
const errors = [], external = [], results = [];
let browser, server, page;
const scenarios = [
  { id: 'baseline-squat', filename: 'squat.mp4', kind: 'single-person-baseline' },
  { id: 'baseline-pushup', filename: 'pushup.mp4', kind: 'single-person-baseline' },
  { id: 'composite-center-row', filename: 'composite-row-and-curl.mp4', kind: 'synthetic-composite', expectedPanel: 'left' },
  { id: 'composite-point-curl', filename: 'composite-row-and-curl.mp4', kind: 'synthetic-composite', point: { x: 0.88, y: 0.52 }, expectedPanel: 'right' },
  { id: 'composite-target-disappears', filename: 'composite-row-target-disappears.mp4', kind: 'synthetic-composite', expectedPanel: 'left', disappears: true },
  { id: 'natural-gym-pushup', filename: 'subject_002_push_up_good_side-h264.mp4', kind: 'naturally-recorded-gym', visualReviewRequired: true },
];
try {
  const requested = process.env.QA_TARGET_SCENARIOS?.split(',').map(id => id.trim()).filter(Boolean);
  if (requested) assert(requested.length && requested.every(id => scenarios.some(scenario => scenario.id === id)), `Unknown QA_TARGET_SCENARIOS; choose from: ${scenarios.map(scenario => scenario.id).join(',')}`);
  const selectedScenarios = requested ? scenarios.filter(scenario => requested.includes(scenario.id)) : scenarios;
  if (!replayRoot) {
    const { chromium } = process.env.QA_PLAYWRIGHT ? await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT)).href) : await import('playwright');
    const { startServer } = await import('../server.mjs');
    server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(output, 'data') });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER ? { executablePath: process.env.QA_BROWSER } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    page = await context.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url()); });
    await page.goto(base);
    await page.evaluate(() => { document.body.innerHTML = '<input id="target-fixture" type="file"><div id="target-contact" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;background:white;color:black;font:14px sans-serif"></div>'; });
  }
  for (const scenario of selectedScenarios) {
    let pipeline;
    const framesFile = join(replayRoot || output, scenario.id + '.frames.json');
    if (replayRoot) pipeline = JSON.parse(await readFile(framesFile, 'utf8'));
    else {
      await page.locator('#target-fixture').setInputFiles(join(fixtureRoot, scenario.filename));
      pipeline = await page.evaluate(async ({ point }) => {
        const { analyzeVideo } = await import('/motion-video.js');
        return analyzeVideo(document.querySelector('#target-fixture').files[0], point ? { targetPoint: point } : {});
      }, scenario);
      await writeFile(framesFile, JSON.stringify(pipeline));
    }
    const analysis = analyzeMotion(pipeline.frames, pipeline);
    await writeFile(join(output, scenario.id + '.analysis.json'), JSON.stringify(analysis, null, 2));
    const isLocked = frame => frame.subjectTracking?.status === 'locked' && Number.isFinite(frame.subjectTracking.confidence) && frame.subjectTracking.confidence >= 0.65 && frame.subjectTracking.confidence <= 1 && typeof frame.subjectTracking.trackId === 'string' && frame.subjectTracking.trackId.trim().length > 0 && frame.personCount !== 0;
    const frames = pipeline.frames, locked = frames.filter(isLocked);
    const ids = [...new Set(locked.map(frame => frame.subjectTracking.trackId))];
    const multipleFrames = frames.filter(frame => frame.personCount > 1).length;
    const panelMismatchFrames = scenario.expectedPanel ? locked.filter(frame => {
      const box = frame.subjectTracking.bbox; if (!box) return true;
      const center = (box.xMin + box.xMax) / 2;
      return scenario.expectedPanel === 'left' ? center >= 0.75 : center <= 0.75;
    }).length : null;
    const violations = [];
    if (!locked.length) violations.push('No locked training subject');
    if (ids.length !== 1) violations.push('Track identity changed');
    if (panelMismatchFrames) violations.push(`Selected the wrong panel in ${panelMismatchFrames} frames`);
    if (scenario.kind !== 'single-person-baseline' && multipleFrames === 0) violations.push('Detector never observed the visibly present second person; multi-person selection test is inconclusive');
    if (scenario.disappears && frames.filter(frame => frame.time >= 5).some(frame => frame.subjectTracking?.status === 'locked' || frame.landmarks.length)) violations.push('Target was reported after disappearance; possible identity switch');
    if (!scenario.disappears && locked.length / frames.length < 0.7) violations.push('Less than 70% target lock coverage');
    const expectedTopKeys = ['measurements', 'quality', 'version'];
    if (JSON.stringify(Object.keys(analysis).sort()) !== JSON.stringify(expectedTopKeys)) violations.push('Analysis includes fields outside objective observations');
    if (JSON.stringify(Object.keys(analysis.quality).sort()) !== JSON.stringify(['reasons', 'sourceFps', 'targetCoverage', 'totalFrames', 'usableRatio', 'validFrames'])) violations.push('Data quality includes non-observation fields');
    if (analysis.version !== 'motion-observations-3d-v1' || analysis.coordinateSpace !== 'mediapipe-world-3d') violations.push('Unexpected observation schema or coordinate space');
    if (analysis.measurements.length !== frames.length || analysis.quality.totalFrames !== frames.length) violations.push('Not every input frame has a measurement row');
    const angleKeys = ['bodyAlignmentAngle', 'elbowAngle', 'hipAngle', 'kneeAngle', 'shoulderAngle', 'torsoLean'];
    let measuredFrames = 0;
    for (const [index, observation] of analysis.measurements.entries()) {
      const sample = frames[index];
      if (!sample || observation.frameIndex !== index || observation.time !== sample.time) violations.push(`Measurement ${index} does not match the original frame index/time`);
      if (JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify(['frameIndex', 'left', 'right', 'time'])) violations.push(`Measurement ${index} contains non-observation fields`);
      const values = [...Object.values(observation.left), ...Object.values(observation.right)];
      if (values.some(Number.isFinite)) measuredFrames++;
      if ((!sample || !isLocked(sample) || !Array.isArray(sample.landmarks) || !sample.landmarks.length) && values.some(value => value !== null)) violations.push(`Measurement ${index} uses an unlocked or missing target`);
      for (const side of [observation.left, observation.right]) {
        if (JSON.stringify(Object.keys(side).sort()) !== JSON.stringify(angleKeys)) violations.push(`Measurement ${index} has unexpected angle fields`);
        if (Object.entries(side).some(([key, value]) => value !== null && (!Number.isFinite(value) || value < 0 || value > (key === 'torsoLean' ? 90 : 180)))) violations.push(`Measurement ${index} has invalid angle values`);
      }
    }
    if (analysis.quality.validFrames !== measuredFrames || analysis.quality.usableRatio !== measuredFrames / frames.length) violations.push('Measured-frame coverage does not match retained observations');
    if (ids.length === 1 && analysis.quality.targetCoverage !== locked.length / frames.length) violations.push('Target coverage differs from reliable locked-frame coverage');
    if (scenario.disappears) {
      const presentFrames = frames.filter(frame => frame.time < 4);
      if (presentFrames.filter(isLocked).length / presentFrames.length < 0.7) violations.push('Less than 70% target lock coverage before the target disappears');
      if (!analysis.quality.reasons.includes('TARGET_NOT_LOCKED')) violations.push('Lost target coverage is missing from data quality');
      if (analysis.measurements.filter(row => row.time >= 5).some(row => [...Object.values(row.left), ...Object.values(row.right)].some(value => value !== null))) violations.push('Measurements continued after the target disappeared');
    }
    // Save six independent whole-scene views with the selected person's box.
    // These expose wrong locks, missing bystanders and target-loss behavior.
    if (page) await page.evaluate(async ({ frames, duration }) => {
      const { browserSeekTime } = await import('/motion-video.js');
      const container = document.querySelector('#target-contact'); container.innerHTML = '';
      const video = document.createElement('video'), src = URL.createObjectURL(document.querySelector('#target-fixture').files[0]); video.muted = true;
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; video.src = src; });
        for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 0.98]) {
          const time = duration * fraction, frame = frames.reduce((best, item) => Math.abs(item.time - time) < Math.abs(best.time - time) ? item : best, frames[0]);
          await new Promise(resolve => { video.onseeked = resolve; video.currentTime = browserSeekTime(frame.time, duration); });
          const canvas = document.createElement('canvas'); canvas.width = 380; canvas.height = Math.round(380 * video.videoHeight / video.videoWidth);
          const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const box = frame.subjectTracking?.bbox;
          if (box) { ctx.strokeStyle = '#ffdf00'; ctx.lineWidth = 3; ctx.strokeRect(box.xMin * canvas.width, box.yMin * canvas.height, (box.xMax - box.xMin) * canvas.width, (box.yMax - box.yMin) * canvas.height); }
          const tile = document.createElement('div'); tile.append(canvas, `${frame.time.toFixed(2)}s / ${frame.subjectTracking?.status || 'no tracking'} / detected ${frame.personCount ?? '?'} people`); container.append(tile);
        }
      } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(src); }
    }, pipeline);
    if (page) await page.locator('#target-contact').screenshot({ path: join(output, scenario.id + '.png') });
    const targetTracking = Object.fromEntries(['mode', 'point', 'trackId', 'coverage', 'lockedFrames', 'ambiguousFrames', 'lostFrames', 'totalFrames', 'maxPeople'].map(key => [key, pipeline.targetTracking?.[key]]));
    const result = { ...scenario, replay: !!replayRoot, framesFile, duration: pipeline.duration, elapsedMs: pipeline.elapsedMs, decoder: pipeline.decoder, frames: frames.length, lockedFrames: locked.length, multipleFrames, trackIds: ids, panelMismatchFrames, targetTracking, observations: {version: analysis.version, quality: analysis.quality, measurementRows: analysis.measurements.length}, violations,
      limitation: 'This checks target tracking and objective measurements, not AI action or form accuracy. ' + (scenario.kind === 'single-person-baseline' ? 'Fixed real-video regression; not a multi-person accuracy estimate.' : scenario.kind === 'synthetic-composite' ? 'Explicit composite functional test, not a natural interaction.' : 'Natural scene needs visual inspection. A constant track ID does not prove identity correctness. Missing bystanders do not count as successful multi-person detection.') };
    results.push(result); console.log(JSON.stringify(result));
    await writeFile(join(output, 'results.json'), JSON.stringify({ output, results, errors, external }, null, 2));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert(results.every(result => result.violations.length === 0), 'Target QA has failures; inspect results.json and contact images.');
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ output, replayRoot, error: error?.stack || String(error), results, errors, external }, null, 2));
  throw error;
} finally {
  console.log(`Target QA artifacts: ${output}`);
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
