import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadMotionReferencePack, buildMotionReferenceRequest, normalizeMotionReferenceResponse, createMotionReferenceFetch} from '../scripts/motion-dataset-reference.mjs';
import {completeMotionCoach, validateMotionCoachRequest} from '../server/motion-coach.mjs';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = 'a'.repeat(64);
const source = {subject: '01', split: 'train', datasetPage: 'https://data.mendeley.com/datasets/w5prmmxyt9/1',
  author: 'Ivan Conanta; Gloria Virginia', dataset: 'MyDeadlift', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', videoSha256: hash};
// Synthetic JPEG envelopes keep protocol tests independent of .qa and sources.
function packFixture() {
  const references = ['REFERENCE_HINGE', 'REFERENCE_ROUND'].map((id, index) => {
    const bytes = Buffer.from([0xff, 0xd8, index, 0xff, 0xd9]);
    return {id, path: `${index}.jpg`, mimeType: 'image/jpeg', sha256: sha256(bytes), data: bytes.toString('base64'), caption: '仅供独立视觉教学，不属于待评视频。', source};
  });
  return {audit: {manifestSha256: hash}, references};
}
function request() {
  return {model: 'deepseek-flash', thinking: {type: 'disabled'}, temperature: 0, max_tokens: 2400, stream: false,
    response_format: {type: 'json_object'}, messages: [{role: 'system', content: '只输出JSON。action和feedback引用imageIndices，来自imageIndex。'},
      {role: 'user', content: [{type: 'text', text: JSON.stringify({stage: 'visual-keyframes', duration: 4, frames: [{imageIndex: 0, time: .3}, {imageIndex: 1, time: 3.7}]})},
        {type: 'text', text: '图片 imageIndex=0'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AA=='}},
        {type: 'text', text: '图片 imageIndex=1'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AQ=='}}]}]};
}
function report() {
  return {action: {name: '杠铃硬拉', family: null, status: 'identified', confidence: 'high', videoImageIds: ['VIDEO_0', 'VIDEO_1'], evidence: '待评两图显示手握杠铃且身体由髋部折叠到站立。'},
    verdict: {status: 'standard', summary: '当前可见姿势相对标准。'}, feedback: [{title: '可见背部轮廓', status: 'good', source: 'visual',
      videoImageIds: ['VIDEO_0', 'VIDEO_1'], evidence: '待评图中的背部轮廓没有明显拱起。', correction: '继续保持可控的髋部折叠。', priority: 1}], limitations: []};
}

test('QA reference request isolates reference IDs and retains full system text without target truth', () => {
  const original = request(), before = structuredClone(original), pack = packFixture();
  const prepared = buildMotionReferenceRequest(original, pack), {body, videoIds} = prepared;
  assert.deepEqual(original, before);
  assert.deepEqual(videoIds, ['VIDEO_0', 'VIDEO_1']);
  const parts = body.messages[1].content, context = JSON.parse(parts[0].text);
  assert.deepEqual(context.frames, [{time: .3, videoImageId: 'VIDEO_0'}, {time: 3.7, videoImageId: 'VIDEO_1'}]);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 4);
  assert.equal(body.thinking.type, 'disabled'); assert.equal(body.temperature, 0);
  assert.match(body.messages[0].content, /只输出JSON/);
  assert.match(body.messages[0].content, /VIDEO_0/);
  assert.match(body.messages[0].content, /REFERENCE_HINGE/);
  assert.match(JSON.stringify(body), /CC BY 4.0/);
  assert(!JSON.stringify(body).includes('sourceLabel'));
  assert(!JSON.stringify(body).includes('videoSha256'));
});

test('QA pack loader verifies image hashes and records development provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'motion-reference-'));
  try {
    const references = packFixture().references;
    for (const reference of references) await writeFile(join(dir, reference.path), Buffer.from(reference.data, 'base64'));
    const manifest = {version: 1, id: 'mydeadlift-development-hinge-v1', selectedFrom: 'development-subject-01-only', references: references.map(({data, ...reference}) => reference)};
    const path = join(dir, 'pack.json'); await writeFile(path, JSON.stringify(manifest));
    const loaded = await loadMotionReferencePack(path);
    assert.equal(loaded.audit.manifestSha256, sha256(await readFile(path)));
    assert.equal(loaded.audit.references[0].source.subject, '01');
    assert.equal(loaded.references[0].data, references[0].data);
    assert.match(loaded.audit.referenceInstruction, /仅用于QA/);
    await writeFile(join(dir, references[0].path), Buffer.from([0xff, 0xd8, 8, 0xff, 0xd9]));
    await assert.rejects(loadMotionReferencePack(path), /frozen JPEG hash/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('QA reference normalization rejects foreign, mixed, positional and hidden reference evidence', () => {
  const valid = report();
  const normalized = normalizeMotionReferenceResponse(valid, ['VIDEO_0', 'VIDEO_1']);
  assert.deepEqual(normalized.action.imageIndices, [0, 1]);
  assert.deepEqual(normalized.feedback[0].imageIndices, [0, 1]);
  assert.equal(normalized.feedback[0].evidence, valid.feedback[0].evidence);
  assert(!Object.hasOwn(normalized.action, 'videoImageIds'));
  const changes = [
    value => value.action.videoImageIds = ['REFERENCE_HINGE'],
    value => value.feedback[0].videoImageIds = ['VIDEO_0', 'REFERENCE_ROUND'],
    value => value.feedback[0].videoImageIds = ['VIDEO_2'],
    value => value.feedback[0].videoImageIds = [0],
    value => value.feedback[0].imageIndices = [0],
    value => value.feedback[0].evidenceTimes = [.3],
    value => value.feedback[0].referenceIds = ['REFERENCE_ROUND'],
    value => value.feedback[0].evidence = '参考图可见圆背，所以待评也有此问题。',
    value => value.action.evidence = '与 REFERENCE_HINGE 一致。',
    value => value.feedback[0].source = 'combined',
    value => delete value.feedback[0].videoImageIds,
  ];
  for (const change of changes) {
    const invalid = report(); change(invalid);
    assert.throws(() => normalizeMotionReferenceResponse(invalid, ['VIDEO_0', 'VIDEO_1']), error => error.code === 'QA_REFERENCE_EVIDENCE');
  }
});

test('QA wrapper lets inner trace capture real augmented request and raw reply before mapping', async () => {
  let actual, raw; const original = report();
  const wrapped = createMotionReferenceFetch({pack: packFixture(), fetchImpl: async (_url, options) => {
    actual = JSON.parse(options.body);
    raw = {choices: [{message: {content: JSON.stringify(original)}, finish_reason: 'stop'}], usage: {prompt_tokens: 321, completion_tokens: 45}};
    return Response.json(raw);
  }});
  const endpoint = 'https://api.deepseek.com/chat/completions', options = {body: JSON.stringify(request()), headers: {Authorization: 'never-record-this'}};
  const response = await wrapped(endpoint, options), result = await response.json();
  assert.equal(actual.messages[1].content.filter(part => part.type === 'image_url').length, 4);
  assert(JSON.parse(raw.choices[0].message.content).action.videoImageIds);
  assert.deepEqual(JSON.parse(result.choices[0].message.content).action.imageIndices, [0, 1]);
  assert.deepEqual(result.usage, raw.usage);
  await assert.rejects(wrapped(endpoint, options), /one provider attempt/);
});

test('QA experiment rejects changed model settings, modified reference bytes and nonvisual inputs', () => {
  for (const change of [value => value.temperature = .2, value => value.thinking.type = 'enabled', value => value.model = 'another',
    value => value.max_tokens = 4096, value => value.messages[1].content[0].text = JSON.stringify({stage: 'full-data'})]) {
    const input = request(); change(input);
    assert.throws(() => buildMotionReferenceRequest(input, packFixture()), error => error.code === 'QA_REFERENCE_EVIDENCE');
  }
  const pack = packFixture(); pack.references[0].data = 'AAA=';
  assert.throws(() => buildMotionReferenceRequest(request(), pack), /reference changed/);
});

test('QA rejection callback records the exact protocol reason and preserves its error', async () => {
  const notices = [], invalid = report(); invalid.feedback[0].videoImageIds = ['VIDEO_0', 'REFERENCE_ROUND'];
  const wrapped = createMotionReferenceFetch({pack: packFixture(), onRejected: async notice => {notices.push(notice);},
    fetchImpl: async () => Response.json({choices: [{message: {content: JSON.stringify(invalid)}, finish_reason: 'stop'}]})});
  let rejected;
  try { await wrapped('https://api.deepseek.com/chat/completions', {body: JSON.stringify(request())}); } catch (error) { rejected = error; }
  assert.equal(rejected.code, 'QA_REFERENCE_EVIDENCE');
  assert.deepEqual(notices, [{code: rejected.code, message: rejected.message}]);
  assert(!JSON.stringify(notices).includes('videoImageIds'));

  const callbackFails = createMotionReferenceFetch({pack: packFixture(), onRejected: () => {throw new Error('audit callback unavailable');}, fetchImpl: async () => {throw new Error('must not call');}});
  await assert.rejects(callbackFails('https://unapproved.invalid/chat/completions', {body: JSON.stringify(request())}),
    error => error.code === 'QA_REFERENCE_EVIDENCE' && /official DeepSeek/.test(error.message));
});

test('upstream transport errors are not mislabeled as reference-evidence rejection', async () => {
  const notices = [], upstream = new Error('offline');
  const wrapped = createMotionReferenceFetch({pack: packFixture(), onRejected: notice => notices.push(notice), fetchImpl: async () => {throw upstream;}});
  await assert.rejects(wrapped('https://api.deepseek.com/chat/completions', {body: JSON.stringify(request())}), error => error === upstream);
  assert.deepEqual(notices, []);
});

test('reference wrapper through the production coach counts only target images as reviewed evidence', async () => {
  const pipeline = toMediaPipePipeline({duration: 4, width: 1280, height: 720, sampleFps: 15, sourceFps: 30,
    frames: Array.from({length: 60}, (_, index) => ({time: index / 15, personCount: 1,
      landmarks: Array.from({length: 33}, (_, joint) => ({x: .2 + joint / 100, y: .2 + joint / 100, visibility: .97}))}))});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
  const input = validateMotionCoachRequest({reviewMode: 'efficient', duration: 4, analysis: {}, poseData: buildMotionPoseData(pipeline),
    fullAnalysis: buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline), keyframes: [.3, 3.7].map(time => ({time, mimeType: 'image/png', data: png}))});
  let sent;
  const fetchImpl = createMotionReferenceFetch({pack: packFixture(), fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({choices: [{message: {content: JSON.stringify(report())}, finish_reason: 'stop'}]});
  }});
  const provider = {name: 'Mock authorized provider', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', models: [{id: 'deepseek-flash', vision: true}]};
  const result = await completeMotionCoach({provider, input, fetchImpl});
  assert.equal(sent.messages[1].content.filter(part => part.type === 'image_url').length, 4);
  assert.equal(result.coverage.imageCount, 2);
  assert.equal(result.coverage.reviewedImageCount, 2);
  assert.equal(result.coverage.reviewedFrameCount, 0);
  assert.equal(result.coverage.modelCalls, 1);
  assert.equal(result.verdict.status, 'standard');
  assert.equal(result.action.exerciseId, 'barbell-deadlift');
  assert.deepEqual(result.feedback[0].evidenceTimes, [.3, 3.7]);
});
