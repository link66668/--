import { createHash, randomUUID } from 'node:crypto';
import { exercises, MAX_TRAINING_EXERCISES } from '../public/domain.js';
import { recordFromRow } from './storage.mjs';
import { arrangePlan, validateSchedule, recordById } from './calendar-data.mjs';

const PLAN_ID = 'active-plan';
const exerciseIds = new Set(exercises.map(exercise => exercise.id));
const initialized = new WeakSet();
const readNames = new Set(['get_training_plan', 'read_training_plan']);
const mutationNames = new Set(['create_training_plan', 'update_training_plan', 'delete_training_plan']);
const exerciseSchema = {
  type: 'object', additionalProperties: false,
  required: ['exerciseId', 'sets', 'reps', 'restSeconds'],
  properties: {
    exerciseId: { type: 'string', enum: [...exerciseIds], description: '使用 get_training_plan 返回的动作目录中的 ID。' },
    sets: { type: 'integer', minimum: 1, maximum: 12 },
    reps: { type: 'string', maxLength: 30, description: '次数 1–100，或秒数 1–600。格式例如 8–12、20–40秒、8–12次/侧。' },
    restSeconds: { type: 'integer', minimum: 15, maximum: 600 },
  },
};
const planSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'days'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    split: { type: 'integer', minimum: 1, maximum: 7, description: '训练分化数量；可省略，由训练日数量推定，最多 7。' },
    variant: { type: 'string', maxLength: 40, description: '可选方案标签，例如 custom、home、standard。' },
    notes: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
    days: {
      description: '完整的 1–14 个训练/休息模板日，不是日历日期列表。更新也必须包含全部模板日；仅调整排期时沿用 get_training_plan 返回的 record.data.days。实际排期长度放在 schedule.days。',
      type: 'array', minItems: 1, maxItems: 14,
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'rest', 'exercises'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '已有训练日尽量保留 ID；新增训练日可省略，服务器按顺序生成。' },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          rest: { type: 'boolean' },
          exercises: { type: 'array', maxItems: MAX_TRAINING_EXERCISES, items: exerciseSchema, description: '休息日必须为空，训练日至少一个动作。' },
        },
      },
    },
  },
};
const expectedVersionSchema = { type: 'integer', minimum: 1, description: '必须使用刚刚 get_training_plan 返回的 currentVersion；版本不符时重新读取并按用户要求调整。' };
const scheduleSchema = { type: 'object', additionalProperties: false, properties: {
  allowBusyDates: {type:'array',maxItems:366,uniqueItems:true,items:{type:'string'},description:'默认不传，所有繁忙日禁止训练。仅用户明确要求在某些繁忙日期训练时填写这些 YYYY-MM-DD 日期；只对列出的本次排期范围内日期生效。普通排期要求、旧计划备注不构成繁忙日例外授权。'},
  startDate: { type: 'string', description: '排期开始日期 YYYY-MM-DD，默认今天，不能早于今天。' },
  days: { type: 'integer', minimum: 1, maximum: 366, description: '首次生成的日期范围，默认 84 天；持续循环不以此为截止日。仅 repeat=false 时代表计划总天数。' },
  repeat:{type:'boolean',description:'默认 true，保存与手动计划相同的持续循环。仅用户明确要求只排某个有限日期范围时设 false。'},
  weekdays:{type:'array',minItems:0,maxItems:7,uniqueItems:true,items:{type:'integer',minimum:1,maximum:7},description:'固定每周训练日：1=周一，7=周日。例如每周一三五传 [1,3,5]，训练日按 plan.days 中非休息日的顺序轮换，不能以今天作为周一。省略时按计划训练/休息循环；更新时保留已有每周规则；传 [] 明确恢复按训练/休息顺序循环。'},
} };

export const planTools = [
  {
    type: 'function', function: {
      name: 'get_training_plan', description: '读取当前用户的固定训练计划、服务器版本及可用动作目录。创建、修改或删除之前先读取；历史实际训练记录不会被这些工具改动。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function', function: {
      name: 'create_training_plan', description: '用户明确要求创建并保存训练计划时调用。先读取计划与训练日历。默认保存持续循环，与手动计划一致，日历浏览未来日期时继续补齐。固定每周几使用 schedule.weekdays；仅有限排期使用 repeat=false。已有计划使用 update_training_plan。每次请求最多一次计划变更。',
      parameters: { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: planSchema, schedule: scheduleSchema } },
    },
  },
  {
    type: 'function', function: {
      name: 'update_training_plan', description: '用户明确要求修改固定计划时调用。先读取计划与训练日历，将全部修改应用到完整计划，保留未要求修改的内容。按日期重新安排范围内关联的未完成训练，保留其他训练、过去与完成记录。expectedVersion 防止覆盖并发计划修改。',
      parameters: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'plan'], properties: { expectedVersion: expectedVersionSchema, plan: planSchema, schedule: scheduleSchema } },
    },
  },
  {
    type: 'function', function: {
      name: 'delete_training_plan', description: '仅当用户明确要求删除当前固定训练计划时调用；先读取 currentVersion。同时移除今天起关联的未完成训练；保留过去和已完成训练。',
      parameters: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: expectedVersionSchema } },
    },
  },
];

class PlanToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function invalid(message) { throw new PlanToolError('INVALID_ARGUMENTS', message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label}必须是对象。`);
  return value;
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label}必须是 1–${max} 字符的文本，不能包含控制字符。`);
  return value.trim();
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}必须是 ${min}–${max} 的整数。`);
  return value;
}
function repetitions(value) {
  const result = text(value, '动作次数或秒数', 30);
  const match = /^(\d+)(?:\s*[-–—~～至]\s*(\d+))?\s*(次|秒|s|sec|seconds)?(?:\s*\/\s*(?:侧|边))?$/i.exec(result);
  if (!match) invalid('动作次数格式错误，请使用 8–12、20–40秒、8–12次/侧等格式。');
  const limit = match[3] && match[3] !== '次' ? 600 : 100;
  const low = Number(match[1]);
  const high = Number(match[2] || match[1]);
  if (low < 1 || high < low || high > limit) invalid(`动作次数范围必须递增且介于 1–${limit} 之间。`);
  return result;
}

// Construct a new object at every level: the model cannot supply storage IDs,
// user IDs, completion snapshots, confirmation times, or other trusted fields.
export function validatePlan(value) {
  const input = object(value, '训练计划');
  if (!Array.isArray(input.days) || input.days.length < 1 || input.days.length > 14) invalid('计划必须包含 1–14 个循环日。');
  const dayIds = new Set();
  const days = input.days.map((value, index) => {
    const day = object(value, `第 ${index + 1} 天`);
    const id = day.id === undefined ? `day-${index + 1}` : text(day.id, '训练日 ID', 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || dayIds.has(id)) invalid('训练日 ID 必须唯一且仅含英文字母、数字、下划线或短横线。');
    dayIds.add(id);
    if (typeof day.rest !== 'boolean') invalid('训练日 rest 必须为布尔值。');
    if (!Array.isArray(day.exercises) || day.exercises.length > MAX_TRAINING_EXERCISES || (day.rest ? day.exercises.length !== 0 : day.exercises.length === 0)) invalid(`休息日动作必须为空；训练日必须包含 1–${MAX_TRAINING_EXERCISES} 个动作。`);
    return {
      id, name: text(day.name, '训练日名称', 80), rest: day.rest,
      exercises: day.exercises.map(value => {
        const exercise = object(value, '训练动作');
        if (!exerciseIds.has(exercise.exerciseId)) invalid(`动作 ID 不在目录中：${String(exercise.exerciseId).slice(0, 80)}。请先读取可用动作目录。`);
        return {
          exerciseId: exercise.exerciseId,
          sets: integer(exercise.sets, '组数', 1, 12),
          reps: repetitions(exercise.reps),
          restSeconds: integer(exercise.restSeconds, '组间休息秒数', 15, 600),
        };
      }),
    };
  });
  const trainingDays = days.filter(day => !day.rest).length;
  if (!trainingDays) invalid('训练计划至少需要一个训练日。');
  const notes = input.notes === undefined ? [] : input.notes;
  if (!Array.isArray(notes) || notes.length > 12) invalid('计划备注必须是最多 12 条的文本列表。');
  return {
    name: text(input.name, '计划名称', 80),
    split: input.split === undefined ? Math.min(trainingDays, 7) : integer(input.split, '训练分化数', 1, 7),
    variant: input.variant === undefined ? 'custom' : text(input.variant, '方案标签', 40),
    days, notes: notes.map(note => text(note, '计划备注', 500)),
  };
}

function ensureLedger(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_plan_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    argument_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, request_id)
  )`);
  initialized.add(db);
}
function state(db, userId) {
  const record = recordFromRow(db.prepare('SELECT * FROM records WHERE user_id = ? AND id = ?').get(userId, PLAN_ID)) ?? null;
  return { record, currentVersion: record?.version ?? 0, exists: Boolean(record && !record.deleted && record.kind === 'plan') };
}
function replay(receipt, current) {
  return {
    ...receipt, ...current, replayed: true,
    message: `此请求此前已完成操作：${receipt.message} 不会重复修改，现返回当前服务器计划状态。`,
  };
}

/** Recover a committed mutation after a response stream was interrupted. Only
 * metadata is retained in the ledger; deleted plan contents are not duplicated. */
export function getPlanToolReceipt({ db, userId, requestId }) {
  if (typeof userId !== 'string' || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(requestId)) return null;
  ensureLedger(db);
  const previous = db.prepare('SELECT result FROM ai_plan_operations WHERE user_id = ? AND request_id = ?').get(userId, requestId);
  if (!previous) return null;
  const receipt = JSON.parse(previous.result);
  return replay(receipt, { ...state(db, userId), ...(receipt.recordIds ? { records: receipt.recordIds.map(id => recordById(db, userId, id)).filter(Boolean) } : {}) });
}

/** Execute one authenticated, fully parsed tool call. The caller owns authorization,
 * request cancellation and conversation persistence. All writes are account scoped.
 * Only a successful mutation consumes a request ID; validation/conflict errors can
 * be corrected within the same AI turn. */
export function executePlanTool({ db, userId, name, args = {}, requestId, localToday }) {
  let inTransaction = false;
  try {
    if (!readNames.has(name) && !mutationNames.has(name)) throw new PlanToolError('UNKNOWN_TOOL', '不支持这个训练计划操作。');
    if (typeof userId !== 'string' || !db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new PlanToolError('USER_NOT_FOUND', '当前账户不存在。');
    object(args, '工具参数');
    if (readNames.has(name)) return {
      name, ok: true, message: '已读取当前训练计划。', ...state(db, userId),
      recurrence:(()=>{const cycle=recordById(db,userId,'calendar-cycle'),current=state(db,userId);return current.exists&&cycle&&!cycle.deleted&&cycle.data.plan?.planVersion===current.record.data.planVersion?{startDate:cycle.data.startDate,weekdays:cycle.data.weekdays||null,repeat:!cycle.data.endDate,endDate:cycle.data.endDate||null,allowBusyDates:cycle.data.allowBusyDates||[]}:null;})(),
      availableExercises: exercises.map(({ id, name, equipment }) => ({ id, name, equipment })),
    };
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(requestId)) invalid('写入训练计划需要有效的请求 ID。');
    const expectedVersion = name === 'create_training_plan' ? undefined : integer(args.expectedVersion, '预期版本', 1, Number.MAX_SAFE_INTEGER);
    const plan = name === 'delete_training_plan' ? undefined : validatePlan(args.plan);
    let schedule;
    try { if (localToday) schedule = validateSchedule(name === 'delete_training_plan' ? undefined : args.schedule, localToday); }
    catch (error) { invalid(error.message); }
    const hash = createHash('sha256').update(JSON.stringify({ name, expectedVersion, plan, schedule })).digest('hex');
    ensureLedger(db);
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const previous = db.prepare('SELECT tool_name,argument_hash,result FROM ai_plan_operations WHERE user_id = ? AND request_id = ?').get(userId, requestId);
    const current = state(db, userId);
    let result;
    if (previous) {
      const receipt = JSON.parse(previous.result);
      result = previous.tool_name === name && previous.argument_hash === hash
        ? replay(receipt, { ...current, ...(receipt.recordIds ? { records: receipt.recordIds.map(id => recordById(db, userId, id)).filter(Boolean) } : {}) })
        : { name, ok: false, code: 'REQUEST_ALREADY_MUTATED', message: '此请求已完成一次计划修改，不会再次改动。新的修改请由用户发送新请求。', ...current, previousOperation: { name: receipt.name, message: receipt.message, version: receipt.originalVersion } };
    } else if (current.record && current.record.kind !== 'plan') {
      result = { name, ok: false, code: 'RECORD_KIND_CONFLICT', message: '当前计划记录类型不正确，未执行修改。', ...current };
    } else if (name === 'create_training_plan' && current.exists) {
      result = { name, ok: false, code: 'PLAN_EXISTS', message: '已有固定训练计划。请先读取当前内容，再使用 update_training_plan 修改。', ...current };
    } else if (name !== 'create_training_plan' && !current.exists) {
      result = { name, ok: false, code: 'PLAN_NOT_FOUND', message: '当前没有有效训练计划，未执行修改。需要新增时使用 create_training_plan。', ...current };
    } else if (expectedVersion !== undefined && expectedVersion !== current.currentVersion) {
      result = { name, ok: false, code: 'VERSION_CONFLICT', message: '训练计划已被其他操作更新。请重新读取，依据最新内容调整后再提交。', ...current };
    } else {
      const updatedAt = new Date().toISOString();
      const deleted = name === 'delete_training_plan';
      const data = deleted ? null : { ...plan, planVersion: randomUUID(), confirmedAt: updatedAt, source: '由 AI 对话按用户要求保存的训练计划。' };
      const record = { id: PLAN_ID, kind: 'plan', data, version: current.currentVersion + 1, deleted, updatedAt };
      db.prepare(`INSERT INTO records(user_id,id,kind,data,version,deleted,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data,version=excluded.version,deleted=excluded.deleted,updated_at=excluded.updated_at`)
        .run(userId, PLAN_ID, 'plan', JSON.stringify(data), record.version, deleted ? 1 : 0, updatedAt);
      result = {
        name, ok: true, message: deleted ? '已删除固定训练计划，历史训练记录已保留。' : name === 'create_training_plan' ? '已创建并保存固定训练计划。' : '已更新固定训练计划，历史训练记录已保留。',
        record, currentVersion: record.version, exists: !deleted,
      };
      if (schedule) {
        const arranged = arrangePlan(db, userId, current.exists ? current.record.data : null, record, schedule, localToday, updatedAt);
        Object.assign(result, arranged);
        result.message += deleted ? '已移除未来未完成的关联训练，历史记录已保留。' : `${arranged.recurrence.repeat?'已保存持续循环规则，后续日期会继续补齐。':'已保存限定日期范围。'}已生成 ${arranged.scheduled.length} 次训练。`;
      }
      const receipt = { name, ok: true, message: result.message, originalVersion: record.version, ...(result.recurrence?{recurrence:result.recurrence}:{}), ...(result.records ? { recordIds: result.records.map(item => item.id) } : {}) };
      db.prepare('INSERT INTO ai_plan_operations(user_id,request_id,tool_name,argument_hash,result,created_at) VALUES(?,?,?,?,?,?)').run(userId, requestId, name, hash, JSON.stringify(receipt), updatedAt);
    }
    db.exec('COMMIT');
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) db.exec('ROLLBACK');
    if (error instanceof PlanToolError) return { name, ok: false, code: error.code, message: error.message };
    throw error;
  }
}
