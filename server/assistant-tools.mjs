import {isBusyDate,busyDatesInRange} from '../public/busy-rules.js';
import { createHash, randomUUID } from 'node:crypto';
import { planTools, executePlanTool, getPlanToolReceipt } from './plan-tools.mjs';
import { calendarState, recordById, writeRecord, validDate, resolveLocalToday } from './calendar-data.mjs';
import { addDays, validateCalendarTask, trainingDayType } from '../public/schedule.js';
import { parseMealEstimate } from '../public/meal-contract.js';
import { sumFoods } from '../public/domain.js';
import { recordFromRow } from './storage.mjs';
import { chatContextTool, readChatContext } from './chat-context.mjs';
import {chatVisualTool,setChatVisuals} from './chat-visuals.mjs';

const initialized = new WeakSet();
const expectedVersion = { type: 'integer', minimum: 1, description: '读取工具返回的记录 version。' };
const idSchema = { type: 'string', description: '读取工具返回的记录 id，不能填写其他账号 ID。' };
const calendarVersion = { type: 'string', description: '刚读取 read_calendar 返回的 calendarVersion；训练日历或计划改变时重新读取。' };
const taskSchema = { type: 'object', additionalProperties: false, required: ['title', 'date'], properties: {
  allowBusyDate: {type:'boolean',description:'默认 false。仅用户明确要求在 task.date 这个繁忙日期训练时设 true；不能从普通排期要求或旧备注推定授权。仅对此任务的该日期有效。'},
  taskType: { type: 'string', enum: ['training'], description: '只能是训练任务，省略时默认为 training。' }, title: { type: 'string', minLength: 1, maxLength: 80 },
  date: { type: 'string', description: 'YYYY-MM-DD，今天或未来日期；按日期安排，不指定时刻。' },
  notes: { type: 'string', maxLength: 2000 }, dayId: { type: 'string', description: '新增训练须指定固定计划中非休息训练日 ID。移动原训练且内容不变时可以保留原值。' }, completed: { type: 'boolean' },
} };
const mealSchema = { type: 'object', additionalProperties: false, required: ['items'], properties: {
  title: { type: 'string', maxLength: 80 }, notes: { type: 'string', maxLength: 2000, description: '估算依据、食物生熟状态和不确定性。' },
  items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, grams: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
    category: { type: 'string', enum: ['正餐','加餐','零食'], description: '按用户描述与食用场景分类，同一正餐的米饭和菜都标正餐。' },
    kcal: { type: 'number', minimum: 0, maximum: 1000, description: '每 100 克热量，非整份总量。' }, protein: { type: 'number', minimum: 0, maximum: 100 }, carbs: { type: 'number', minimum: 0, maximum: 100 }, fat: { type: 'number', minimum: 0, maximum: 100 },
  } } },
} };
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });

export const assistantTools = [
  chatContextTool,
  chatVisualTool,
  ...planTools,
  tool('read_calendar', '读取真实训练日历及 calendarVersion。默认今天起 7 天，最长 31 天。只包含按日期安排的训练；dayTypes 按该日是否存在实际训练自动计算，有训练为 training，无训练为 rest。', { startDate: { type: 'string' }, endDate: { type: 'string' } }),
  tool('create_calendar_task', '用户明确要求在某日期新增训练时使用，同日可有多项训练。训练内容从固定计划取值，不设置时刻或日常任务。创建完整计划请用 create_training_plan 自动按日期排期。', { task: taskSchema, calendarVersion }, ['task', 'calendarVersion']),
  tool('update_calendar_task', '用户明确要求改动或移动一个未完成训练到其他日期时使用。先读取真实训练日历，保留没有要求修改的内容。只移动日期时保留原训练动作快照。不能修改过去或已完成训练。', { id: idSchema, expectedVersion, calendarVersion, task: taskSchema }, ['id', 'expectedVersion', 'calendarVersion', 'task']),
  tool('delete_calendar_task', '用户明确要求删除一个今天或未来未完成训练时使用；保留历史及完成记录。', { id: idSchema, expectedVersion }, ['id', 'expectedVersion']),
  tool('get_today_meals', '读取当前账号今天已计入的饮食、记录版本与按份量计算的营养合计。今天以经服务器校验的客户端本地日期为准。'),
  tool('create_meal', '用户明确要求记录今天实际吃下的食物时直接保存，建议或未吃食谱不能入账。数量不明时先询问；估算必须在 notes 和回复说明不确定性。营养数值一律每 100 克。', { meal: mealSchema }, ['meal']),
  tool('update_meal', '用户明确要求修订今天一餐时使用。先读 get_today_meals，提交完整食物记录；服务端保留照片与修订历史。不能改历史日期。', { id: idSchema, expectedVersion, meal: mealSchema }, ['id', 'expectedVersion', 'meal']),
  tool('delete_meal', '用户明确要求删除今天一餐时使用，先读取真实 id 与 version；不删除附件及其他日期餐食。', { id: idSchema, expectedVersion }, ['id', 'expectedVersion']),
];

class ToolError extends Error { constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; } }
const fail = (code, message, details) => { throw new ToolError(code, message, details); };
function assertObject(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_ARGUMENTS', '工具参数必须是对象。'); }
function cleanText(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('INVALID_ARGUMENTS', `文本必须不超过 ${max} 个字符。`);
  return value.trim();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function ensureLedger(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_assistant_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, target_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    argument_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, request_id, target_id)
  )`);
  initialized.add(db);
}
function receiptResult(db, userId, row) {
  const receipt = JSON.parse(row.result), record = recordById(db, userId, row.target_id);
  return { ...receipt, replayed: true, record, records: record ? [record] : [], message: `此请求此前已完成：${receipt.message} 不会重复写入，现返回当前记录。` };
}
export function getAssistantToolReceipts({ db, userId, requestId }) {
  if (typeof userId !== 'string' || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(requestId)) return [];
  ensureLedger(db);
  const planReceipt = getPlanToolReceipt({ db, userId, requestId });
  return [...(planReceipt ? [planReceipt] : []), ...db.prepare('SELECT * FROM ai_assistant_operations WHERE user_id = ? AND request_id = ? ORDER BY created_at,target_id').all(userId, requestId).map(row => receiptResult(db, userId, row))];
}

function readMeals(db, userId, today) {
  const records = db.prepare("SELECT * FROM records WHERE user_id = ? AND kind = 'meal' AND deleted = 0 ORDER BY id").all(userId).map(recordFromRow).filter(record => record.data?.date === today && record.data.confirmed);
  const totals = records.reduce((sum, record) => { const meal = sumFoods(record.data.items || []); for (const key of Object.keys(sum)) sum[key] += meal[key]; return sum; }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { today, records, totals };
}
function checkedMeal(value, oldData, today) {
  assertObject(value);
  const parsed = parseMealEstimate(JSON.stringify({ items: value.items }));
  for (const item of parsed.items) if (/[\x00-\x1f\x7f]/.test(item.name)) fail('INVALID_ARGUMENTS', '食物名称不能包含控制字符。');
  const notes = cleanText(value.notes, 2000, oldData?.notes || '');
  const {type: _legacyType,...previous}=oldData||{};
  return { ...previous, date: today, createdAt: oldData?.createdAt || new Date().toISOString(), title: cleanText(value.title, 80, oldData?.title || parsed.items.map(item=>item.name).join('、').slice(0,80)), notes, items: parsed.items, confirmed: true,
    attachments: oldData?.attachments || [], history: [...(Array.isArray(oldData?.history) ? oldData.history : []), { notes, result: '按用户明确要求通过 AI 对话保存；营养与份量如为估算，请结合标签或称重核对。', createdAt: new Date().toISOString() }].slice(-8), source: 'ai-chat' };
}
function checkedTask(db, userId, value, existing, today) {
  assertObject(value);
  if (value.taskType !== undefined && value.taskType !== 'training') fail('INVALID_ARGUMENTS', '日历只支持训练任务。');
  const task = validateCalendarTask({ ...value, taskType: 'training' });
  if(value.allowBusyDate!==undefined&&typeof value.allowBusyDate!=='boolean')fail('INVALID_ARGUMENTS','繁忙日例外必须为布尔值。');
  if(existing){existing=structuredClone(existing);delete existing.data.busyDateOverride;if(task.date!==existing.data.date)delete existing.data.busyBaseDate;}
  if(isBusyDate(task.date,calendarState(db,userId).busySettings)&&value.allowBusyDate!==true)fail('BUSY_DATE','这一天已设为繁忙，请根据已读取的空闲日期重新排期；仅用户明确要求此繁忙日期训练才可传 allowBusyDate=true。');
  if(value.allowBusyDate===true)task.busyDateOverride=task.date;
  if (task.date < today) fail('HISTORICAL_TASK', '不能通过 AI 改写过去的训练记录。');
  const plan = recordById(db, userId, 'active-plan');
  const dayId = value.dayId || existing?.data?.dayId;
  if (dayId === existing?.data?.dayId && existing?.data?.daySnapshot) return { ...dateOnlyData(existing.data), ...task, dayId, daySnapshot: structuredClone(existing.data.daySnapshot), planVersion: existing.data.planVersion, source: 'ai-chat' };
  const day = !plan?.deleted && plan?.data?.days?.find(day => day.id === dayId && !day.rest);
  if (!day) fail('TRAINING_DAY_NOT_FOUND', '训练日不在当前固定计划中，请读取计划选择训练日。');
  return { ...task, dayId, daySnapshot: structuredClone(day), planVersion: plan.data.planVersion, source: 'ai-chat' };
}

function dateOnlyData(data) {
  const { startTime, endTime, period, durationMinutes, preferredPeriod, preferredTime, needsTimeReview, rest, ...training } = data;
  return training;
}

export function executeAssistantTool({ db, userId, name, args = {}, requestId, localToday }) {
  if(name==='set_chat_visuals')return setChatVisuals(args);
  if (name === 'read_chat_context') return readChatContext({ db, userId, args, localToday: localToday || resolveLocalToday() });
  // executePlanTool is also independently used by legacy tests and callers.
  if (planTools.some(tool => tool.function.name === name) || name === 'read_training_plan') return executePlanTool({ db, userId, name, args, requestId, localToday });
  let transaction = false;
  try {
    if (!assistantTools.some(tool => tool.function.name === name)) fail('UNKNOWN_TOOL', '不支持此操作。');
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) fail('USER_NOT_FOUND', '当前账户不存在。');
    assertObject(args);
    const today = localToday || resolveLocalToday();
    if (!validDate(today)) fail('INVALID_ARGUMENTS', '今日日期无效。');
    if (name === 'get_today_meals') return { name, ok: true, message: '已读取今日饮食。', ...readMeals(db, userId, today) };
    if (name === 'read_calendar') {
      const startDate = args.startDate ?? today, endDate = args.endDate ?? addDays(startDate, 6);
      if (!validDate(startDate) || !validDate(endDate) || endDate < startDate || Date.parse(endDate) - Date.parse(startDate) > 30 * 86400000) fail('INVALID_ARGUMENTS', '日程读取范围须为 1–31 天。');
      const current = calendarState(db, userId);
      const records = current.records.filter(record => record.data.date >= startDate && record.data.date <= endDate).map(record => ({ ...record, data: dateOnlyData(record.data) }));
      const dayTypes = [];
      for (let date = startDate; date <= endDate; date = addDays(date, 1)) { const dayType = trainingDayType(date, records); dayTypes.push({ date, dayType, rest: dayType === 'rest' }); }
      const busyDates=busyDatesInRange(current.busySettings,startDate,endDate);
      return { name, ok: true, message: '已读取训练日历。', today, startDate, endDate, calendarVersion: current.calendarVersion, records, dayTypes, busyDates, busySettings:current.busySettings,
        availableDates:dayTypes.map(day=>day.date).filter(date=>!busyDates.includes(date)),
        schedulingPolicy:'繁忙日默认禁止安排训练，无需再次询问繁忙日是否能练。明确要求制定或调整计划时，依据已有资料直接执行；未指定训练星期时选空闲日。已有计划备注中的星期不优先于繁忙规则。仅用户明确要求在具体繁忙日期训练时使用日期例外，不能取消全局繁忙设置。' };
    }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(requestId)) fail('INVALID_ARGUMENTS', '写入需要有效的请求 ID。');
    const isMeal = name.endsWith('_meal'), creating = name.startsWith('create_'), deleting = name.startsWith('delete_');
    if (!creating && (typeof args.id !== 'string' || !/^[\w:-]{1,100}$/.test(args.id) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1)) fail('INVALID_ARGUMENTS', '请使用读取结果中的记录 id 和 version。');
    let hashArgs = args;
    if (isMeal && creating) {
      assertObject(args.meal);
      const parsed = parseMealEstimate(JSON.stringify({ items: args.meal.items }));
      hashArgs = { meal: { ...(args.meal.type ? { type: args.meal.type } : {}), title: cleanText(args.meal.title, 80, args.meal.type || ''), notes: cleanText(args.meal.notes, 2000), items: parsed.items } };
    }
    const hash = createHash('sha256').update(JSON.stringify(canonical({ name, args: hashArgs, today }))).digest('hex');
    ensureLedger(db); db.exec('BEGIN IMMEDIATE'); transaction = true;
    const previous = creating
      ? db.prepare('SELECT * FROM ai_assistant_operations WHERE user_id = ? AND request_id = ? AND tool_name = ? AND argument_hash = ?').get(userId, requestId, name, hash)
      : db.prepare('SELECT * FROM ai_assistant_operations WHERE user_id = ? AND request_id = ? AND target_id = ?').get(userId, requestId, args.id);
    if (previous) {
      if (previous.tool_name !== name || previous.argument_hash !== hash) fail('REQUEST_ALREADY_MUTATED', '此请求已经修改过这条记录，未再次修改。后续修改请发送新请求。');
      const result = receiptResult(db, userId, previous); db.exec('COMMIT'); transaction = false; return result;
    }
    const existing = creating ? null : recordById(db, userId, args.id);
    if (!creating) {
      if (!existing || existing.deleted || (isMeal ? existing.kind !== 'meal' : !['calendar-task', 'schedule'].includes(existing.kind))) fail('RECORD_NOT_FOUND', '当前账号不存在这条有效记录。');
      if (!isMeal && !calendarState(db, userId).records.some(record => record.id === existing.id)) fail('RECORD_NOT_FOUND', '当前账号不存在这条有效训练记录。');
      if (existing.version !== args.expectedVersion) fail('VERSION_CONFLICT', '记录已被其他操作更新，请重新读取再修改。', { record: existing });
      if (isMeal && existing.data?.date !== today) fail('NOT_TODAY', '只能通过这些工具修改今日饮食，其他日期保持不变。');
      if (!isMeal && (existing.data?.date < today || existing.data?.completed)) fail('HISTORICAL_TASK', '过去或已完成的任务不能由 AI 改写。');
    }
    let data;
    if (!deleting) {
      data = isMeal ? checkedMeal(args.meal, existing?.data, today) : checkedTask(db, userId, args.task, existing, today);
      if (!isMeal) {
        const current = calendarState(db, userId);
        if (args.calendarVersion !== current.calendarVersion) fail('CALENDAR_CONFLICT', '训练日历或计划已改变，请重新读取后再修改。', { calendarVersion: current.calendarVersion });
      }
    }
    const record = writeRecord(db, userId, { id: existing?.id || `${isMeal ? 'meal' : 'task'}:${randomUUID()}`, kind: existing?.kind || (isMeal ? 'meal' : 'calendar-task'), data, version: existing?.version || 0, deleted: deleting });
    const message = `已${deleting ? '删除' : creating ? '新增' : '更新'}${isMeal ? '今日餐食' : '训练任务'}。`;
    const receipt = { name, ok: true, message, originalVersion: record.version };
    db.prepare('INSERT INTO ai_assistant_operations(user_id,request_id,target_id,tool_name,argument_hash,result,created_at) VALUES(?,?,?,?,?,?,?)').run(userId, requestId, record.id, name, hash, JSON.stringify(receipt), record.updatedAt);
    const result = { ...receipt, record, records: [record], ...(isMeal ? { totals: readMeals(db, userId, today).totals, today } : { calendarVersion: calendarState(db, userId).calendarVersion }) };
    db.exec('COMMIT'); transaction = false;
    return result;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (error instanceof ToolError) return { name, ok: false, code: error.code, message: error.message, ...error.details };
    // Domain validation errors are useful to the model; SQLite/programming failures
    // still surface to the HTTP error boundary and never consume an operation ID.
    if (!(error.code || /sqlite|database|constraint|trigger/i.test(error.message))) return { name, ok: false, code: 'INVALID_ARGUMENTS', message: error.message };
    throw error;
  }
}
