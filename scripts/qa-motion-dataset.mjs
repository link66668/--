// Real dataset QA. No provider mock, implicit credentials, or truth labels in model inputs.
// node scripts/qa-motion-dataset.mjs --mode inventory --verify-hashes
// node scripts/qa-motion-dataset.mjs --mode sparse --one-per-exercise
// node scripts/qa-motion-dataset.mjs --mode coach --limit 12
// Coach requires QA_MOTION_BASE_URL, QA_MOTION_MODEL and (if needed) QA_MOTION_API_KEY.
// These explicit QA credentials are never printed or saved. Sparse mode measures
// individual-frame pose availability, not full video decoding/tracking or coaching accuracy.
import {access, copyFile, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startServer} from '../server.mjs';
import {completeMotionCoach, validateMotionCoachRequest} from '../server/motion-coach.mjs';
import {buildMotionPoseData} from '../public/motion-pose-data.js';
import {BENCHMARK_VERSION, datasetVideoPath, hashFile, inspectDataset, scoreMotionPrediction, selectDatasetItems, summarizeDatasetResults} from './motion-dataset-benchmark.mjs';
import {redactMotionProviderPayload} from './motion-dataset-logging.mjs';
import {forceMotionDatasetCpu} from './motion-dataset-instrumentation.mjs';
import {guidedRequestFields,requireGuidedSelection} from './motion-dataset-guided.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executeFile = promisify(execFile);
const args = process.argv.slice(2), flags = new Set(['--help', '--verify-hashes', '--one-per-exercise', '--rebuild-images', '--short-first']);
const names = new Set(['--mode', '--dataset', '--manifest', '--output', '--limit', '--seed', '--exercise', '--subject', '--id', '--minimum-accuracy', '--timeout-ms', '--delegate', '--review-mode', '--stored-provider', '--budget-cny', '--replay', '--reference-review', '--acceptance', '--sample-fps', '--visual-reference-pack', '--protocol']);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (flags.has(key)) options[key] = true;
  else if (names.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
  else throw new Error(`Unknown option or missing argument: ${key}`);
}
if (options['--help']) {
  console.log('Guided evaluation: --review-mode guided requires each manifest item.selectedExerciseId. Optional --protocol JSON freezes actual system/model/config and code hashes. --short-first changes processing order only. User-selected actions never count as recognition accuracy.');
  console.log('Usage: node scripts/qa-motion-dataset.mjs --mode inventory|sparse|extract|coach [--dataset 测试集] [--manifest JSON] [--sample-fps 7.5|15] [--one-per-exercise] [--limit N] [--exercise ID,ID] [--subject ID,ID] [--id ID,ID] [--seed VALUE] [--verify-hashes] [--output PATH] [--minimum-accuracy 0.85] [--timeout-ms 900000] [--delegate CPU|GPU] [--review-mode efficient|full] [--stored-provider ID --budget-cny 50] [--replay EXTRACT_OUTPUT --rebuild-images] [--reference-review JSON] [--acceptance rate|each-exercise] [--visual-reference-pack JSON]\nSparse: 6 true frames per clip, shared MediaPipe Full model, no action/form claims. Extract/coach: complete production video pipeline. Coach: explicit QA_MOTION_BASE_URL, QA_MOTION_MODEL, QA_MOTION_API_KEY or --stored-provider for an authorized saved DeepSeek provider; no implicit configuration lookup. Visual references are an explicit QA-only experiment, recorded separately; targets must be disjoint from reference source videos. QA_PLAYWRIGHT, QA_BROWSER and QA_FFMPEG can override local runtimes.');
  process.exit(0);
}
const mode = options['--mode'] || 'inventory';
if (!['inventory', 'sparse', 'extract', 'coach'].includes(mode)) throw new Error('Invalid mode.');
if (options['--visual-reference-pack'] && mode !== 'coach') throw new Error('--visual-reference-pack is only supported in explicit real coach mode.');
const limit = options['--limit'] ? Number(options['--limit']) : Infinity;
if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0)) throw new Error('Limit must be a positive integer.');
const timeoutMs = Number(options['--timeout-ms'] || 900000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid timeout.');
const minimumAccuracy = Number(options['--minimum-accuracy'] || .85);
if (!Number.isFinite(minimumAccuracy) || minimumAccuracy <= 0 || minimumAccuracy > 1) throw new Error('Invalid accuracy gate.');
const reviewMode = options['--review-mode'] || 'efficient';
if (!['efficient', 'full', 'guided'].includes(reviewMode)) throw new Error('Invalid review mode.');
if(reviewMode==='guided'&&options['--visual-reference-pack'])throw new Error('Guided production evaluation does not accept the QA visual-reference protocol.');
const acceptance = options['--acceptance'] || 'rate';
if (!['rate', 'each-exercise'].includes(acceptance)) throw new Error('Invalid acceptance mode.');
const sampleFps = Number(options['--sample-fps'] || 15);
if (![7.5, 15].includes(sampleFps)) throw new Error('Sample FPS must be 7.5 or 15.');
const delegate = options['--delegate'] || (mode === 'sparse' ? 'CPU' : 'GPU');
if (!['CPU', 'GPU'].includes(delegate)) throw new Error('Invalid delegate.');
const datasetRoot = resolve(root, options['--dataset'] || '测试集');
await mkdir(join(root, '.qa'), {recursive: true});
const output = options['--output'] ? resolve(options['--output']) : await mkdtemp(join(root, '.qa', 'motion-dataset-'));
await mkdir(output, {recursive: true});
if (mode !== 'inventory' && await access(join(output, 'results.json')).then(() => true, () => false)) throw new Error('Output already contains a benchmark attempt. Choose a new directory so failures and retries are retained.');
const inspected = await inspectDataset(datasetRoot, {verifyHashes: !!options['--verify-hashes'], manifestPath: options['--manifest']});
await writeFile(join(output, 'inventory.json'), JSON.stringify({version: BENCHMARK_VERSION, generatedAt: new Date().toISOString(), ...inspected.inventory, audit: inspected.audit}, null, 2));
console.log(JSON.stringify({output, mode, clips: inspected.inventory.clips, exerciseCount: Object.keys(inspected.inventory.exercises).length, labeledClips: inspected.inventory.labeledClips, invalidFiles: inspected.inventory.errors.length,
  unlistedVideoCount: inspected.inventory.unlistedVideos.length, unlistedVideoExamples: inspected.inventory.unlistedVideos.slice(0, 5)}));
if (mode === 'inventory') { if (inspected.inventory.errors.length) process.exitCode = 1; }
else await run();

async function run() {
  const split = name => (options[name] || '').split(',').filter(Boolean);
  let items = selectDatasetItems(inspected.manifest.items, {seed: options['--seed'], exercises: split('--exercise'), subjects: split('--subject'), ids: split('--id')});
  if(options['--short-first'])items.sort((a,b)=>(a.duration||a.sourceDurationSeconds||5)-(b.duration||b.sourceDurationSeconds||5)||a.id.localeCompare(b.id));
  if (options['--one-per-exercise']) items = [...new Map(items.toReversed().map(item => [item.exercise, item])).values()].sort((a, b) => a.exercise.localeCompare(b.exercise));
  items = items.slice(0, limit);
  if (!items.length) throw new Error('No matching dataset items.');
  if(reviewMode==='guided')items.forEach(requireGuidedSelection);
  let referenceMetadata = null;
  if (options['--reference-review']) {
    const reference = JSON.parse(await readFile(resolve(options['--reference-review']), 'utf8'));
    if (!Array.isArray(reference.items)) throw new Error('Reference review must contain items.');
    const refs = new Map();
    for (const item of reference.items) {
      if (!item.id || refs.has(item.id) || !['standard', 'needs-improvement', 'uncertain'].includes(item.verdict) || !item.reviewer || !item.basis) throw new Error('Each unique independent reference needs id, verdict, reviewer and basis.');
      refs.set(item.id, item);
    }
    items = items.map(item => ({...item, ...(refs.has(item.id) ? {independentReview: refs.get(item.id)} : {})}));
    referenceMetadata = {path: resolve(options['--reference-review']), reviewType: reference.reviewType || 'explicit-independent-reference', professionalGroundTruth: reference.professionalGroundTruth === true, scope: reference.scope || 'Explicit independent visual reference'};
  }
  const safeExpected = item => Object.fromEntries(['id', 'exercise', 'selectedExerciseId', 'exerciseNameZh', 'qualityLabel', 'sourceLabel', 'sourceGroup', 'subject', 'view', 'specificFault', 'labelProvenance', 'relativePath', 'independentReview'].map(key => [key, item[key] ?? null]));
  const rows = items.map(item => ({id: item.id, expected: safeExpected(item), status: 'pending'}));
  const frozenProtocol=options['--protocol']?JSON.parse(await readFile(resolve(options['--protocol']),'utf8')):null;
  if(frozenProtocol&&frozenProtocol.reviewMode!==reviewMode)throw new Error('Frozen protocol review mode mismatch.');
  const codeFiles = ['public/motion-video.js', 'public/motion-worker.js', 'public/motion-mediapipe.js', 'public/motion-tracking.js',
    'public/motion-software-decode.js', 'public/motion-source.js', 'public/motion-evidence.js', 'public/motion-analysis.js',
    'public/motion-pose-data.js', 'public/motion-catalog.js', 'public/motion-contract.js', 'public/motion-feedback.js', 'public/motion-verdict.js',
    'server/motion-coach.mjs', 'server/motion-coach-full.mjs', 'server/motion-coach-temporal.mjs', 'server/motion-coach-visual.mjs', 'server/motion-coach-guided.mjs', 'server/motion-coach-context.mjs',
    'server/providers.mjs', 'scripts/motion-dataset-benchmark.mjs', 'scripts/motion-dataset-guided.mjs', 'scripts/motion-dataset-provider.mjs', 'scripts/motion-dataset-logging.mjs', 'scripts/motion-dataset-reference.mjs', 'scripts/motion-dataset-instrumentation.mjs', 'scripts/qa-motion-dataset.mjs'];
  const codeHashes = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, await hashFile(join(root, file))])));
  if(frozenProtocol?.codeHashes)for(const [file,hash]of Object.entries(frozenProtocol.codeHashes))if(codeHashes[file]!==hash)throw new Error(`Frozen protocol code changed: ${file}`);
  const replayRoot = options['--replay'] ? resolve(options['--replay']) : null;
  if (replayRoot === output) throw new Error('Replay source and output must be different directories.');
  if (replayRoot && !['extract', 'coach'].includes(mode)) throw new Error('--replay is only supported for extract or real coach mode.');
  if (options['--rebuild-images'] && !replayRoot) throw new Error('--rebuild-images requires --replay pointing to a real extracted pipeline.');
  const replayReport = replayRoot ? JSON.parse(await readFile(join(replayRoot, 'results.json'), 'utf8')) : null;
  const report = {version: BENCHMARK_VERSION, generatedAt: new Date().toISOString(), mode, reviewMode, codeHashes, runtime: {node: process.version}, partition: inspected.manifest.partition || null, referenceReview: referenceMetadata, selection: {seed: options['--seed'] || 'motion-benchmark-1', totalManifestClips: inspected.manifest.items.length, selectedClips: items.length, fullDataset: items.length === inspected.manifest.items.length},
    inference: {metadataLabelsExcluded: true, embeddedVideoTextUnmodified: true, neutralFilename: true, mock: false, replay: replayRoot, requestedSampleFps: sampleFps, sampleStrategy: mode === 'sparse' ? 'Six independent frames at 10%, 26%, 42%, 58%, 74%, 90%; real MediaPipe Full, no production temporal tracking.' : 'Unmodified analyzeVideo + buildMotionEvidence pipeline at explicitly recorded sampleFps.'}, rows};
  const persist = async () => {
    report.inference.actualSampleRates = [...new Set(rows.map(row => row.pose?.sampleFps).filter(Number.isFinite))];
    report.summary = summarizeDatasetResults(rows, {minimumAccuracy, mode, acceptance, reviewMode});
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  };
  if(frozenProtocol)report.inference.frozenProtocol={path:resolve(options['--protocol']),sha256:await hashFile(resolve(options['--protocol'])),...frozenProtocol};
  report.inference.userSelectedAction=reviewMode==='guided';
  await persist();
  let provider, fetchImpl, visualPack, referenceFetchFactory;
  if (options['--visual-reference-pack']) {
    const {loadMotionReferencePack, createMotionReferenceFetch} = await import('./motion-dataset-reference.mjs');
    visualPack = await loadMotionReferencePack(resolve(options['--visual-reference-pack']));
    referenceFetchFactory = createMotionReferenceFetch;
    report.inference.visualReferences = visualPack.audit;
    if (items.some(item => visualPack.references.some(reference => reference.source.videoId === item.id))) throw new Error('Visual-reference target overlaps a reference source video ID. Use the disjoint calibration partition.');
  }
  if (mode === 'coach') {
    if (options['--stored-provider']) {
      const {loadDatasetProvider, createBudgetedFetch} = await import('./motion-dataset-provider.mjs');
      provider = loadDatasetProvider({providerId: options['--stored-provider']});
      fetchImpl = createBudgetedFetch({ledgerPath: join(root, '.qa/motion-dataset-budget.json'), budgetCny: Number(options['--budget-cny'] || 50)});
    } else {
      if (!process.env.QA_MOTION_BASE_URL || !process.env.QA_MOTION_MODEL) throw new Error('Real coach QA needs explicit QA_MOTION_BASE_URL and QA_MOTION_MODEL or an authorized --stored-provider ID. No user configuration or key was read.');
      provider = {id: 'motion-dataset-qa', name: 'Explicit QA provider', protocol: process.env.QA_MOTION_PROTOCOL || 'openai',
      baseUrl: process.env.QA_MOTION_BASE_URL, model: process.env.QA_MOTION_MODEL, apiKey: process.env.QA_MOTION_API_KEY || '',
      models: [{id: process.env.QA_MOTION_MODEL, vision: true}]};
    }
    report.inference.provider = {model: provider.model, protocol: provider.protocol};
  }
  const playwright = process.env.QA_PLAYWRIGHT || join(root, '.qa/browser-tools/node_modules/playwright/index.mjs');
  const {chromium} = await import(pathToFileURL(resolve(playwright)).href);
  const serverDir = await mkdtemp(join(output, 'server-'));
  const server = await startServer({host: '127.0.0.1', port: 0, dataDir: serverDir});
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page, activeRow;
  try {
    browser = await chromium.launch({executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true});
    report.runtime.browser = browser.version();
    const context = await browser.newContext({serviceWorkers: 'block'});
    // Browser inference is local-only. Only the explicit server-side coach call may reach a provider.
    await context.route('**/*', route => /^https?:/.test(route.request().url()) && !route.request().url().startsWith(origin + '/') ? route.abort() : route.continue());
    if (delegate === 'CPU' && mode !== 'sparse' && !replayRoot) {
      const instrumented = forceMotionDatasetCpu(await readFile(join(root, 'public/motion-video.js'), 'utf8'));
      if (instrumented.audit.originalSha256 !== codeHashes['public/motion-video.js']) throw new Error('Production video module changed after the run was frozen.');
      report.inference.instrumentation = instrumented.audit;
      await context.route(origin + '/motion-video.js', route => route.fulfill({status: 200, contentType: 'text/javascript; charset=utf-8', body: instrumented.body}));
    }
    page = await context.newPage();
    await page.exposeFunction('qaDatasetProgress', async progress => {
      if (!activeRow) return;
      const allowed = ['stage', 'progress', 'processedFrames', 'totalFrames', 'time', 'delegate', 'message'];
      activeRow.progress = Object.fromEntries(allowed.filter(key => ['string', 'number'].includes(typeof progress?.[key])).map(key => [key, progress[key]]));
      activeRow.progress.recordedAt = new Date().toISOString();
      console.log(JSON.stringify({id: activeRow.id, pipelineProgress: activeRow.progress}));
      await persist();
    });
    await page.goto(origin + '/vendor/README.md');
    await page.evaluate(() => {document.body.innerHTML = '<input id="qa-dataset-file" type="file">';});
    if (mode === 'sparse') {
      const started = performance.now();
      await page.evaluate(async delegate => {const {createMediaPipe} = await import('/motion-mediapipe.js'); window.qaPose = await createMediaPipe({model:'mediapipe-full',delegate});window.qaPoseTimestamp=0;}, delegate);
      report.inference.initializationMs = Math.round(performance.now() - started);
    }
    for (let index = 0; index < items.length; index++) {
      const item = items[index], row = rows[index], started = performance.now();
      activeRow = row;
      const artifactId = String(index + 1).padStart(3, '0');
      console.log(JSON.stringify({progress: `${index + 1}/${items.length}`, id: item.id, mode}));
      try {
        const path = await datasetVideoPath(datasetRoot, item.relativePath);
        row.sha256 = await hashFile(path);
        if (visualPack?.references.some(reference => reference.source.videoSha256 === row.sha256)) throw new Error('Visual-reference target duplicates a reference source video SHA256.');
        const audit = inspected.audit.find(entry => entry.id === item.id);
        if (audit.errors.length) throw new Error('Dataset integrity failure: ' + audit.errors.join(', '));
        if (mode === 'sparse') {
          const sparse = await extractSparse(page, path, artifactId);
          Object.assign(row, {status: 'ok', duration: sparse.duration, pose: sparse.stats, timing: sparse.timing, contactSheet: `${artifactId}-contact.jpg`, framesFile: `${artifactId}-frames.json`});
          await writeFile(join(output, row.framesFile), JSON.stringify({...sparse, contactSheet: undefined}));
          await writeFile(join(output, row.contactSheet), Buffer.from(sparse.contactSheet, 'base64'));
        } else {
          let body;
          if (replayReport) {
            const cached = replayReport.rows?.find(entry => entry.id === item.id);
            if (cached?.status === 'error' && !cached.requestFile) {
              row.extractionFailure = {sourceCache: replayRoot, error: cached.error, pose: cached.pose || null};
              throw new Error('Original extraction failure: ' + (cached.error || 'No usable request was produced.'));
            }
            if (!cached?.requestFile || cached.sha256 !== row.sha256 || replayReport.inference?.mock !== false) throw new Error('Replay requires a genuine extracted request with the same video SHA256.');
            row.poseSource = cached.poseSource || {cacheRoot: replayRoot, generatedAt: replayReport.generatedAt, codeHashes: replayReport.codeHashes,
              runtime: replayReport.runtime, instrumentation: replayReport.inference.instrumentation || null};
            let cachedBody = JSON.parse(await readFile(await datasetVideoPath(replayRoot, cached.requestFile), 'utf8'));
            let realPipeline;
            if (cached.framesFile) {
              realPipeline = JSON.parse(await readFile(await datasetVideoPath(replayRoot, cached.framesFile), 'utf8'));
              cachedBody.poseData = buildMotionPoseData(realPipeline);
              row.framesFile = `${artifactId}-frames.json`;
              await writeFile(join(output, row.framesFile), JSON.stringify(realPipeline));
            }
            let evidenceMs = cached.timing?.evidence, rebuiltQuality;
            if (options['--rebuild-images']) {
              if (!realPipeline) throw new Error('Rebuilding evidence requires the complete cached pipeline.');
              await stageBlindedInput(page, path, artifactId, row.sha256);
              const rebuilt = await page.evaluate(async ({pipeline, timeoutMs}) => {
                const {analyzeMotion} = await import('/motion-analysis.js');
                const {buildMotionPoseData, buildFullMotionAnalysis} = await import('/motion-pose-data.js');
                const {buildMotionEvidence} = await import('/motion-evidence.js');
                const file = document.querySelector('#qa-dataset-file').files[0], signal = AbortSignal.timeout(timeoutMs);
                const observations = analyzeMotion(pipeline.frames, pipeline), started = performance.now();
                const evidence = await buildMotionEvidence(file, pipeline, observations, {signal});
                return {evidenceMs: performance.now() - started, quality: observations.quality,
                  body: {duration: pipeline.duration, analysis: evidence.summary, poseData: buildMotionPoseData(pipeline), fullAnalysis: buildFullMotionAnalysis(observations, pipeline),
                    keyframes: evidence.images.map(({time, mimeType, dataUrl, imageTime}) => ({time, mimeType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), imageTime}))}};
              }, {pipeline: realPipeline, timeoutMs});
              cachedBody = rebuilt.body;
              evidenceMs = rebuilt.evidenceMs;
              rebuiltQuality = rebuilt.quality;
              row.rebuiltEvidence = true;
            }
            delete cachedBody.selectedExerciseId;
            body = validateMotionCoachRequest({...cachedBody, reviewMode, ...(reviewMode==='guided'?guidedRequestFields(item):{})});
            row.duration = cached.duration;
            row.pose = {...cached.pose, sampleFps: realPipeline?.sampleFps || cached.pose?.sampleFps || cachedBody.poseData?.sampleFps, ...(rebuiltQuality ? {quality: rebuiltQuality} : {})};
            row.timing = {pose: cached.timing?.pose, evidence: Math.round(evidenceMs || 0)};
            row.replayedPose = true;
            row.requestFile = `${artifactId}-request.json`;
            await writeFile(join(output, row.requestFile), JSON.stringify(body));
          } else {
          await stageBlindedInput(page, path, artifactId, row.sha256);
          const result = await page.evaluate(async ({timeoutMs, sampleFps, enforcedDelegate}) => {
            const {analyzeVideo} = await import('/motion-video.js');
            const {analyzeMotion} = await import('/motion-analysis.js');
            const {buildMotionPoseData, buildFullMotionAnalysis} = await import('/motion-pose-data.js');
            const {buildMotionEvidence} = await import('/motion-evidence.js');
            const file = document.querySelector('#qa-dataset-file').files[0], signal = AbortSignal.timeout(timeoutMs);
            let lastStage, lastProgressAt = -Infinity;
            const onProgress = progress => {
              const now = performance.now();
              if (progress.stage !== lastStage || now - lastProgressAt >= 15000) {
                lastStage = progress.stage; lastProgressAt = now;
                window.qaDatasetProgress(progress).catch(() => {});
              }
            };
            const started = performance.now(), pipeline = await analyzeVideo(file, {signal, sampleFps, onProgress});
            if (Math.abs(pipeline.sampleFps - sampleFps) > .00001) throw new Error('Production pipeline did not honor requested sample FPS.');
            if (enforcedDelegate && pipeline.delegate !== enforcedDelegate) throw new Error('CPU QA instrumentation did not honor the requested delegate.');
            const poseMs = performance.now() - started, observations = analyzeMotion(pipeline.frames, pipeline), evidenceStarted = performance.now();
            const evidence = await buildMotionEvidence(file, pipeline, observations, {signal});
            return {pipeline, observations, evidenceMs: performance.now() - evidenceStarted, poseMs,
              body: {duration: pipeline.duration, analysis: evidence.summary, poseData: buildMotionPoseData(pipeline), fullAnalysis: buildFullMotionAnalysis(observations, pipeline),
                keyframes: evidence.images.map(({time, mimeType, dataUrl, imageTime}) => ({time, mimeType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), imageTime}))}};
          }, {timeoutMs, sampleFps, enforcedDelegate: delegate === 'CPU' ? 'CPU' : null});
          row.duration = result.pipeline.duration;
          row.timing = {pose: Math.round(result.poseMs), evidence: Math.round(result.evidenceMs)};
          row.pose = {frames: result.pipeline.frames.length, sampleFps: result.pipeline.sampleFps, quality: result.observations.quality, delegate: result.pipeline.delegate, decoder: result.pipeline.decoder, model: result.pipeline.modelVersion};
          await writeFile(join(output, `${artifactId}-frames.json`), JSON.stringify(result.pipeline));
          row.framesFile = `${artifactId}-frames.json`;
          body = validateMotionCoachRequest({...result.body, reviewMode, ...(reviewMode==='guided'?guidedRequestFields(item):{})});
          row.requestFile = `${artifactId}-request.json`;
          await writeFile(join(output, row.requestFile), JSON.stringify(body));
          }
          row.requestSha256 = await hashFile(join(output, row.requestFile));
          row.keyframeFiles = [];
          for (const [imageIndex, frame] of body.keyframes.entries()) {
            const filename = `${artifactId}-keyframe-${imageIndex + 1}.${frame.mimeType === 'image/png' ? 'png' : 'jpg'}`;
            await writeFile(join(output, filename), Buffer.from(frame.data, 'base64'));
            row.keyframeFiles.push({filename, time: frame.time});
          }
          if (mode === 'coach') {
            const coachStarted = performance.now();
            // Observe the actual augmented request and raw response, before the
            // optional reference protocol maps VIDEO IDs to production indices.
            // Never retain request headers, bearer credentials or private data.
            let responseIndex = 0;
            const observedFetch = async (...args) => {
              if ((report.partition === 'holdout'||reviewMode==='guided') && responseIndex) {
                row.automaticRetryBlocked = true;
                throw new Error('Frozen holdout permits one provider attempt per video; automatic timeout retry was blocked.');
              }
              const callIndex = ++responseIndex;
              const requestFile = `${artifactId}-provider-request-${callIndex}.json`;
              const payload = JSON.parse(args[1].body);
              if(frozenProtocol){
                const {createHash}=await import('node:crypto');
                const systemSha256=createHash('sha256').update(payload.messages[0].content).digest('hex');
                if(systemSha256!==frozenProtocol.systemSha256||payload.model!==frozenProtocol.model||payload.thinking?.type!==frozenProtocol.thinking||payload.temperature!==frozenProtocol.temperature||payload.max_tokens!==frozenProtocol.maxTokens)throw new Error('Actual provider payload violates the frozen protocol.');
              }
              if(reviewMode==='guided'){
                const serialized=JSON.stringify(payload),context=JSON.parse(payload.messages[1].content[0].text);
                if(context.stage!=='guided-evidence'||context.selectedExercise?.id!==item.selectedExerciseId)throw new Error('Guided actual input lost the declared user selection.');
                for(const value of [item.id,item.relativePath,'qualityLabel','sourceLabel','specificFault','labelProvenance'])if(value&&serialized.includes(value))throw new Error('Ground-truth metadata leaked into actual provider input.');
                row.inputAudit={stage:context.stage,selectedExerciseId:context.selectedExercise.id,groundTruthFieldsAbsent:true,actualPoseFrames:context.evidence.frames.length,actualImages:payload.messages[1].content.filter(p=>p.type==='image_url').length};
              }
              const safePayload = redactMotionProviderPayload(payload, provider.apiKey);
              await writeFile(join(output, requestFile), JSON.stringify({recordedAt: new Date().toISOString(), credentialsOmitted: true, imagesReplacedByHashes: true,
                localInput: {duration: body.duration, sampleFps: body.poseData.sampleFps, frameCount: body.poseData.frameCount, poseSchemaVersion: body.poseData.schemaVersion, requestSha256: row.requestSha256}, body: safePayload}, null, 2));
              (row.providerRequestFiles ||= []).push(requestFile);
              const response = await (fetchImpl || fetch)(...args);
              const responseFile = `${artifactId}-provider-response-${callIndex}.json`;
              const raw = await response.clone().text();
              const safeRaw = provider.apiKey ? raw.split(provider.apiKey).join('[redacted]') : raw;
              await writeFile(join(output, responseFile), safeRaw);
              (row.providerResponseFiles ||= []).push(responseFile);
              return response;
            };
            const coachFetch = visualPack ? referenceFetchFactory({pack: visualPack, fetchImpl: observedFetch,
              onRejected: rejection => {row.referenceRejection = rejection;}}) : observedFetch;
            row.coach = await completeMotionCoach({provider, input: body, signal: AbortSignal.timeout(timeoutMs), timeoutMs, fetchImpl: coachFetch});
            row.timing.coach = Math.round(performance.now() - coachStarted);
            row.score = scoreMotionPrediction(item, row.coach);
          }
          row.status = 'ok';
        }
      } catch (error) {
        row.status = 'error';
        const secret = provider?.apiKey;
        row.error = String(error.message).split(secret || '\u0000').join(secret ? '[redacted]' : '\u0000').slice(0, 1200);
      }
      row.timing = {...row.timing, total: Math.round(performance.now() - started)};
      if (row.replayedPose) {
        row.timing.currentRun = row.timing.total;
        row.timing.total += Math.round((row.timing.pose || 0) + (row.rebuiltEvidence ? 0 : row.timing.evidence || 0));
      }
      await persist();
      console.log(JSON.stringify({completed: `${index + 1}/${items.length}`, id: item.id, status: row.status, error: row.error, timing: row.timing, score: row.score, pose: row.pose}));
    }
    if (mode === 'sparse') await writeGallery(rows);
    if (rows.some(row => row.status === 'error') || mode === 'coach' && report.summary.gate.passed === false) process.exitCode = 1;
  } finally {
    if (mode === 'sparse') await page?.evaluate(() => window.qaPose?.close()).catch(() => {});
    await browser?.close();
    await new Promise(resolveClose => {server.close(resolveClose); server.closeAllConnections();});
    await persist();
    console.log(`Dataset QA artifacts: ${output}`);
  }
}

async function stageBlindedInput(page, originalPath, artifactId, sourceSha256) {
  // Playwright's in-memory upload caps buffers at 50 MB, below the product's
  // supported video size. A byte-identical neutral copy avoids a QA-only failure.
  const inputDirectory = join(output, '.inputs');
  await mkdir(inputDirectory, {recursive: true});
  const stagedPath = join(inputDirectory, `clip-${artifactId}${extname(originalPath).toLowerCase()}`);
  await copyFile(originalPath, stagedPath);
  if (await hashFile(stagedPath) !== sourceSha256) throw new Error('Neutral input copy did not preserve video bytes.');
  await page.locator('#qa-dataset-file').setInputFiles(stagedPath);
}

async function extractSparse(page, path, artifactId) {
  const ffmpeg = process.env.QA_FFMPEG || join(root, '.qa/motion-fixtures/qa-codecs/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
  await access(ffmpeg);
  const began = performance.now();
  let probe;
  try {probe = await executeFile(ffmpeg, ['-hide_banner', '-i', path], {windowsHide: true, maxBuffer: 8 * 1024 * 1024});}
  catch (error) {probe = {stderr: error.stderr};}
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe?.stderr || '');
  if (!match) throw new Error('FFmpeg could not read video duration.');
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const samples = [];
  for (const fraction of [.1, .26, .42, .58, .74, .9]) {
    const time = Math.round(duration * fraction * 1000) / 1000;
    const {stdout} = await executeFile(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', path, '-frames:v', '1', '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'], {windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024});
    if (!stdout.length) throw new Error('Empty decoded video frame.');
    samples.push({time, image: stdout.toString('base64')});
  }
  const decodeMs = performance.now() - began;
  const result = await page.evaluate(async samples => {
    const frames = [], contact = document.createElement('canvas'); contact.width = 960; contact.height = 720;
    const contactContext = contact.getContext('2d'); contactContext.fillStyle = '#101820'; contactContext.fillRect(0, 0, 960, 720);
    let poseMs = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index], bytes = Uint8Array.from(atob(sample.image), char => char.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
      const started = performance.now(), pose = await window.qaPose.detect(bitmap,window.qaPoseTimestamp+=1000/30), inferenceMs = performance.now() - started;
      poseMs += inferenceMs;
      frames.push({time: sample.time, width: bitmap.width, height: bitmap.height, inferenceMs, people: pose.landmarks.length, landmarks: pose.landmarks, worldLandmarks: pose.worldLandmarks});
      const x = (index % 3) * 320, y = Math.floor(index / 3) * 360, scale = Math.min(310 / bitmap.width, 325 / bitmap.height), width = bitmap.width * scale, height = bitmap.height * scale;
      const left = x + (320 - width) / 2, top = y + 26 + (328 - height) / 2;
      contactContext.drawImage(bitmap, left, top, width, height);
      contactContext.font = '13px sans-serif'; contactContext.fillStyle = '#fff'; contactContext.fillText(`${sample.time.toFixed(2)} s / people: ${pose.landmarks.length}`, x + 7, y + 17);
      contactContext.fillStyle = '#22ffe1';
      for (const person of pose.landmarks) for (const index of [0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]) { const point=person[index]; if (!point || point.visibility <= .25) continue;
        contactContext.beginPath(); contactContext.arc(left + point.x * width, top + point.y * height, 2, 0, 2 * Math.PI); contactContext.fill();
      }
      bitmap.close();
    }
    return {frames, poseMs, contactSheet: contact.toDataURL('image/jpeg', .88).split(',')[1]};
  }, samples);
  return {duration, sampleStrategy: 'six-independent-video-frames', frames: result.frames, contactSheet: result.contactSheet,
    timing: {decode: Math.round(decodeMs), pose: Math.round(result.poseMs)}, stats: {sampledFrames: result.frames.length, detectedFrames: result.frames.filter(frame => frame.people > 0).length,
      singlePersonFrames: result.frames.filter(frame => frame.people === 1).length, multiplePersonFrames: result.frames.filter(frame => frame.people > 1).length,
      worldPeople: result.frames.flatMap(frame => frame.worldLandmarks).filter(person => person.length === 33).length}};
}

async function writeGallery(rows) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>真实视频 MediaPipe Full 抽样核验</title><style>body{margin:24px;font:16px system-ui;background:#eef2f6;color:#16232b}article{background:white;padding:18px;margin:18px 0;border-radius:12px}img{width:min(960px,100%)}p{max-width:960px;line-height:1.6}code{word-break:break-all}</style><h1>真实视频 MediaPipe Full 抽样核验</h1><p>每段原视频在 10%、26%、42%、58%、74%、90% 处解码，由项目原版 MediaPipe Full 推理。青色点为身体关键点。只检查独立图像能否提取人体，不能证明动作识别、标准评价或纠错准确率；不代表生产全片跟踪和耗时。</p>${rows.map(row => `<article><h2>${escape(row.expected.exerciseNameZh || row.expected.exercise)}</h2><p><code>${escape(row.id)}</code> · ${escape(row.expected.qualityLabel)} · ${escape(row.expected.view || '未标注视角')}</p>${row.contactSheet ? `<img src="${escape(row.contactSheet)}" loading="lazy"><p>有人体 ${row.pose.detectedFrames}/6 · 单人 ${row.pose.singlePersonFrames}/6 · 推理 ${row.timing.pose} ms</p>` : `<p>失败：${escape(row.error || '')}</p>`}</article>`).join('')}`);
}
