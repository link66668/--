import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogue from '../public/motion-catalog.js';
import {compactMotionAnalysis, confirmedMotionAction, motionCoachActionCatalog, sanitizeMotionCoachResponse, mergeCoachAssessment} from '../public/motion-contract.js';

const teachingIds = ['squat','pushup','curl','bench','incline-bench','chest-press','lat-pulldown','row','dumbbell-row','pullup','shoulder-press','lateral-raise','reverse-fly','triceps','overhead-triceps','hammer-curl','goblet-squat','rdl','lunge','leg-curl','leg-extension','glute-bridge','plank','crunch','calf-raise'];
const additionalIds = ['barbell-deadlift','bodyweight-pullup','barbell-bench','incline-barbell-bench','smith-bench','incline-smith-bench','barbell-row','machine-row','chest-supported-row',
  'bilateral-dumbbell-row','alternating-dumbbell-curl','dumbbell-side-bend','barbell-curl','barbell-squat','front-squat','smith-squat','barbell-romanian-deadlift','barbell-shoulder-press',
  'standing-dumbbell-press','barbell-lunge','dumbbell-lunge','walking-lunge','lying-leg-curl','seated-leg-curl','leg-press','dumbbell-kickback','dumbbell-skullcrusher','dip','barbell-hip-thrust','face-pull','hanging-knee-raise','hanging-leg-raise','seated-calf-raise'];
const frames = [{time: 1}, {time: 2}, {time: 3}];
const action = extra => ({exerciseId: 'barbell-bench', name: '杠铃卧推', family: 'horizontal-press', status: 'identified', confidence: 'high', evidenceTimes: [1, 2], evidence: '目标仰卧于凳面，双手将同一根杠铃推离胸部。', ...extra});
const sanitize = (value, options = {}) => sanitizeMotionCoachResponse(value, {mode: 'visual', keyframes: frames, ...options});
const forbidden = new Set(['score', 'observedScore', 'scoreStatus', 'scoreCoverage', 'scoreCap', 'checks', 'requiredChecks', 'recognitionRules', 'weight', 'threshold', 'qualified', 'qualifiedRepCount', 'reps', 'issues', 'measurements', 'landmarks', 'worldLandmarks', 'frames']);
function assertNoLegacyFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, key);
    assertNoLegacyFields(item);
  }
}

test('catalogue preserves teaching names and adds identity hints without evaluation rules', () => {
  assert.equal(catalogue.motionExercises.length, teachingIds.length + additionalIds.length);
  assert.equal(new Set(catalogue.motionExercises.map(item => item.id)).size, teachingIds.length + additionalIds.length);
  assert.deepEqual(catalogue.motionExercises.filter(item => item.hasTeaching).map(item => item.id), teachingIds);
  assert.deepEqual(catalogue.motionExercises.filter(item => !item.hasTeaching).map(item => item.id), additionalIds);
  assert.equal(catalogue.getMotionExercise('bench').name, '哑铃卧推');
  assert.equal(catalogue.getMotionExercise('row').name, '坐姿绳索划船');
  assert.equal(catalogue.motionCheckDefinitions, undefined);
  assert.equal(catalogue.motionCheckCodes, undefined);
  for (const entry of catalogue.motionExercises) assert.deepEqual(Object.keys(entry).sort(), ['family', 'hasTeaching', 'id', 'name']);
  for (const entry of motionCoachActionCatalog()) assert.deepEqual(Object.keys(entry).sort(), ['family', 'id', 'name']);
});

test('every catalogue name can be confirmed from two actual pictures without a coded equipment rubric', () => {
  for (const {id, name, family} of catalogue.motionExercises) {
    const result = sanitize({action: action({exerciseId: id, name, family})});
    assert.equal(result.action.exerciseId, id);
    assert.equal(result.action.name, name);
    assert.equal(result.action.family, family);
    assert.equal(result.action.status, 'identified');
    assert.deepEqual(confirmedMotionAction(result), result.action);
    assert.equal(result.checks, undefined);
    assertNoLegacyFields(result);
  }
});

test('exact catalogue ID, name and family consistency is enforced', () => {
  for (const change of [
    {name: '哑铃卧推'}, {name: '目录外特殊卧推'}, {family: 'row'}, {family: 'invented-family'},
    {exerciseId: 'invented-id'}, {exerciseId: 1},
  ]) {
    const coach = sanitize({action: action(change)});
    assert.equal(coach.action.status, 'unknown', JSON.stringify(change));
    assert.equal(coach.action.exerciseId, null);
    assert.equal(coach.candidates.length, 0);
  }
  assert.equal(sanitize({action: action({exerciseId: null})}).action.exerciseId, 'barbell-bench');
  assert.equal(sanitize({action: action({name: undefined})}).action.name, '杠铃卧推');
});

test('confident identity needs distinct supplied picture times, evidence and explicit confidence', () => {
  for (const change of [
    {evidenceTimes: [1]}, {evidenceTimes: [1, 1, 99]}, {evidenceTimes: [1.02, 2.02]},
    {evidenceTimes: [-1, NaN, Infinity, '1']}, {evidence: ''}, {evidence: 'abc'},
    {confidence: 'medium'}, {status: 'unknown'},
  ]) assert.equal(sanitize({action: action(change)}).action.status, 'unknown', JSON.stringify(change));
  const result = sanitize({action: action({evidenceTimes: [1, 2, 99, 2], evidence: '\u0000 清楚看到双手推起杠铃。 '})});
  assert.deepEqual(result.action.evidenceTimes, [1, 2]);
  assert.equal(result.action.evidence, '清楚看到双手推起杠铃。');
  for (const options of [{mode: 'evidence-only'}, {keyframes: []}, {keyframes: [{time: 1}]}]) assert.equal(sanitize({action: action()}, options).action.status, 'unknown');
});

test('analysis navigation includes only bounded quality and picture metadata', () => {
  const bbox = {xMin: 0.1, yMin: 0.2, xMax: 0.8, yMax: 0.9};
  const result = compactMotionAnalysis({
    score: 99, checks: [{status: 'pass'}], measurements: [{raw: true}], exerciseName: '本地猜测',
    quality: {totalFrames: 30, validFrames: 24, usableRatio: 0.8, targetCoverage: null, sourceFps: 30, reasons: ['MISSING_OR_UNCERTAIN_LANDMARKS', 'SQUAT_DEPTH'], score: 100},
    evidenceFrames: [{time: 1, crop: bbox, data: 'pixels', landmarks: [1], subjectTracking: {status: 'locked', trackId: 'target', confidence: 0.9, bbox, raw: [1]}, frameMappings: [{requestedTime: 1, poseTime: 1, sourceTime: 1.01, raw: [1]}]}],
  });
  assert.deepEqual(Object.keys(result), ['quality', 'evidenceFrames']);
  assert.deepEqual(result.quality, {totalFrames: 30, validFrames: 24, usableRatio: 0.8, targetCoverage: null, sourceFps: 30, reasons: ['MISSING_OR_UNCERTAIN_LANDMARKS']});
  assert.equal(result.evidenceFrames[0].data, undefined);
  assert.equal(result.evidenceFrames[0].subjectTracking.raw, undefined);
  assert.deepEqual(result.evidenceFrames[0].frameMappings, [{requestedTime: 1, poseTime: 1, sourceTime: 1.01}]);
  assertNoLegacyFields(result);
});

test('pose source presentation timestamps retain their precision label without admitting arbitrary labels', () => {
  const evidenceFrames = ['source-pts', 'pose-source-pts', 'seek-target', 'invented'].map(timePrecision => ({time: 1, sourceTime: 1.01, poseTime: 1, timePrecision}));
  const result = compactMotionAnalysis({evidenceFrames});
  assert.deepEqual(result.evidenceFrames.map(frame => frame.timePrecision), ['source-pts', 'pose-source-pts', 'seek-target', undefined]);
  assert(result.evidenceFrames.every(frame => frame.sourceTime === 1.01));
});

test('saved reports are an allowlist and retain every validated feedback reference and coverage count', () => {
  const feedbackTimes = Array.from({length: 120}, (_, index) => index / 15);
  const coach = {
    ...sanitize({action: action(), checks: [{score: 100}]}),
    verdict: {status: 'needs-improvement', summary: '起身时肩髋不同步，需要调整。'},
    feedback: [{title: '肩髋同步', status: 'improve', source: 'analysis', frameIndices: [], evidenceTimes: feedbackTimes,
      analysisPaths: [['measurements', 17, 'left', 'bodyAlignmentAngle']], evidence: '起身时髋部先抬起，肩部随后移动。', correction: '减轻负荷，让肩髋同时起身。', priority: 1,
      checks: [1], raw: [1], score: 30}],
    coverage: {complete: true, frameCount: 120, reviewedFrameCount: 120, measurementCount: 120, reviewedMeasurementCount: 120, dataBatches: 3, modelCalls: 5, repetitionCount: 9},
    timing: {providerMs: 123, totalMs: 456, raw: 1}, model: 'model', provider: 'provider', checks: [{status: 'pass'}], raw: [1], score: 100,
  };
  const local = {version: 'motion-observations-3d-v1', coordinateSpace: 'mediapipe-world-3d', score: 69, exerciseName: '本地猜测', reps: [{score: 69}], checks: [{status: 'fail'}], measurements: [{frameIndex: 0}], quality: {totalFrames: 120, validFrames: 120, usableRatio: 1, targetCoverage: 1, reasons: []}};
  const report = mergeCoachAssessment(local, coach);
  assert.deepEqual(Object.keys(report).sort(), ['coach', 'coordinateSpace', 'exerciseFamily', 'exerciseId', 'exerciseName', 'quality', 'recognitionSource', 'version']);
  assert.equal(report.exerciseName, '杠铃卧推');
  assert.equal(report.recognitionSource, 'visual');
  assert.deepEqual(report.coach.feedback[0].evidenceTimes, feedbackTimes);
  assert.deepEqual(report.coach.feedback[0].analysisPaths, [['measurements', 17, 'left', 'bodyAlignmentAngle']]);
  assert.deepEqual(report.coach.coverage, {complete: true, frameCount: 120, reviewedFrameCount: 120, measurementCount: 120, reviewedMeasurementCount: 120, dataBatches: 3, modelCalls: 5});
  assertNoLegacyFields(report);
  assert.equal(report.coach.raw, undefined);
  assert.equal(report.coach.feedback[0].raw, undefined);
  assert.equal(report.coach.overallEvaluation, undefined);
});

test('local guesses cannot override or fabricate the AI action name', () => {
  const local = {exerciseId: 'row', exerciseName: '坐姿绳索划船', quality: {totalFrames: 30, validFrames: 4, usableRatio: 0.13, targetCoverage: 0.13, reasons: ['MISSING_OR_UNCERTAIN_LANDMARKS']}, score: 100};
  const confirmed = mergeCoachAssessment(local, sanitize({action: action()}));
  assert.equal(confirmed.exerciseId, 'barbell-bench');
  assert.equal(confirmed.exerciseName, '杠铃卧推');
  assert.equal(confirmed.coach.verdict.status, 'uncertain');
  const unknown = mergeCoachAssessment(local, sanitize({action: action({evidenceTimes: []})}));
  assert.equal(unknown.exerciseId, null);
  assert.equal(unknown.exerciseName, '');
  assert.equal(unknown.recognitionSource, 'unknown');
  assertNoLegacyFields(unknown);
});
