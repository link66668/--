import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, getRecords } from '../server/storage.mjs';
import { assistantTools, executeAssistantTool, getAssistantToolReceipts } from '../server/assistant-tools.mjs';
import { calendarState, recordById, resolveLocalToday, resolveLocalTime, writeRecord } from '../server/calendar-data.mjs';

const today = '2026-09-29';
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'fitness-assistant-tools-')), { db } = openStore(path);
  for (const id of ['alice', 'bob']) db.prepare('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)').run(id, `${id}@example.test`, id, 'fixture', new Date().toISOString());
  t.after(() => { db.close(); rmSync(path, { recursive: true, force: true }); });
  let count = 0;
  return { db, call: (name, args = {}, options = {}) => executeAssistantTool({ db, userId: 'alice', name, args, requestId: `request-${++count}`, localToday: today, ...options }), put: (id, kind, data, userId = 'alice') => writeRecord(db, userId, { id, kind, data }) };
}
const plan = (name = '两日循环') => ({ name, days: [{ id: 'train', name: '上肢训练', rest: false, exercises: [{ exerciseId: 'pushup', sets: 3, reps: '8–12', restSeconds: 90 }] }, { id: 'rest', name: '休息', rest: true, exercises: [] }] });
const daily = (date = today, startTime = '18:00', endTime = '20:00') => ({ taskType: 'daily', title: '上课', date, startTime, endTime, completed: false, notes: '' });
const training = (date = today) => ({ taskType: 'training', title: '上肢训练', date, dayId: 'train', completed: false, notes: '' });
const meal = (type = '午餐', grams = 150) => ({ type, title: '米饭和鸡肉', notes: '按标签和称重记录', items: [{ name: '熟米饭', grams, kcal: 120, protein: 2, carbs: 25, fat: 1 }] });

test('AI calendar operations honor busy dates and settings invalidate the calendar version',t=>{
  const {db,put,call}=fixture(t);
  const before=calendarState(db,'alice').calendarVersion;
  put('calendar-busy-days','calendar-settings',{dates:[today,'2026-09-30']});
  assert.notEqual(calendarState(db,'alice').calendarVersion,before);
  const created=call('create_training_plan',{plan:plan(),schedule:{days:5}});
  assert.equal(created.ok,true);
  assert.deepEqual(created.scheduled.map(r=>r.date),['2026-10-01','2026-10-03']);
  const read=call('read_calendar');
  assert.deepEqual(read.busyDates,[today,'2026-09-30']);
  const rejected=call('create_calendar_task',{task:training(today),calendarVersion:read.calendarVersion});
  assert.equal(rejected.ok,false);assert.match(rejected.message,/繁忙/);
  assert.deepEqual(calendarState(db,'bob').busySettings,{weeklyRules:[],overrides:{}});
});

test('calendar busy-day authorization is explicit, boolean and scoped to one task date',t=>{
  const {db,put,call}=fixture(t);
  put('calendar-busy-days','calendar-settings',{dates:[today,'2026-09-30']});
  assert(call('create_training_plan',{plan:plan(),schedule:{days:5}}).ok);
  const version=()=>call('read_calendar').calendarVersion;
  assert.equal(call('create_calendar_task',{task:{...training(today),allowBusyDate:'true'},calendarVersion:version()}).ok,false);
  const saved=call('create_calendar_task',{task:{...training(today),allowBusyDate:true},calendarVersion:version()});
  assert(saved.ok);assert.equal(saved.record.data.busyDateOverride,today);
  const args={id:saved.record.id,expectedVersion:saved.record.version,calendarVersion:version(),task:training('2026-09-30')};
  assert.equal(call('update_calendar_task',args).code,'BUSY_DATE');
  assert.equal(recordById(db,'alice',saved.record.id).data.date,today);
  const moved=call('update_calendar_task',{...args,task:training('2026-10-02')});
  assert(moved.ok);assert.equal(moved.record.data.busyDateOverride,undefined);
  assert.deepEqual(call('read_calendar').busyDates,[today,'2026-09-30']);
});

test('plan distributes training by date, ignores old daily/rest markers and creates no times', t => {
  const { db, put, call } = fixture(t);
  const work = put('task:class', 'calendar-task', daily());
  put('task:full', 'calendar-task', daily('2026-10-01', '00:00', '24:00'));
  put('legacy-rest', 'schedule', { date: '2026-10-03', rest: true });
  put('day-type:2026-09-29', 'day-type', { date: today, rest: true });
  const result = call('create_training_plan', { plan: plan(), schedule: { days: 5 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scheduled.map(record => record.date), [today, '2026-10-01', '2026-10-03']);
  assert.ok(result.scheduled.every(record => !('startTime' in record) && !('endTime' in record)));
  assert.deepEqual(result.unscheduled, []);
  assert.deepEqual(recordById(db, 'alice', work.id), work);
  assert.equal(recordById(db, 'alice', 'legacy-rest').deleted, false);
  assert.ok(result.records.every(record => record.data?.planVersion === result.record.data.planVersion));
  assert.ok(result.records.every(record => !('startTime' in record.data) && !('endTime' in record.data)));
  const read = call('read_calendar');
  assert.equal(read.records.length, 3);
  assert.deepEqual(read.dayTypes.slice(0, 3), [{ date: today, dayType: 'training', rest: false }, { date: '2026-09-30', dayType: 'rest', rest: true }, { date: '2026-10-01', dayType: 'training', rest: false }]);
  assert.equal('restDates' in read, false);
  assert.ok(!getRecords(db, 'bob').length);
});

test('today is a valid training date at any hour and only training controls computed day type', t => {
  const { db, put, call } = fixture(t);
  put('day-type:2026-09-29', 'day-type', { date: today, rest: true });
  let result = call('create_training_plan', { plan: plan(), schedule: { days: 1 } }, { localTime: '22:40' });
  assert.equal(result.scheduled.length, 1);
  assert.deepEqual(result.unscheduled, []);
  assert.equal(call('read_calendar').dayTypes[0].dayType, 'training');
  const firstId = result.scheduled[0].id;
  result = call('update_training_plan', { expectedVersion: 1, plan: plan(), schedule: { days: 1 } }, { localTime: '24:00' });
  assert.equal(result.scheduled.length, 1);
  assert.equal(recordById(db, 'alice', firstId).deleted, true);
  assert.equal(call('delete_training_plan', { expectedVersion: 2 }, { localTime: '24:00' }).ok, true);
  put('day-type:2026-09-29', 'day-type', { date: today, rest: false });
  assert.deepEqual(call('read_calendar').dayTypes[0], { date: today, dayType: 'rest', rest: true });
});

test('plan update rearranges its uncompleted training and deletion preserves past, completed, daily and unrelated tasks', t => {
  const { db, call, put } = fixture(t);
  const created = call('create_training_plan', { plan: plan(), schedule: { days: 3 } });
  const old = created.records[0];
  const history = put('task:past', 'calendar-task', { ...old.data, date: '2026-09-28' });
  const completed = put('task:completed', 'calendar-task', { ...old.data, date: '2026-10-02', completed: true, actual: [{ reps: 10 }] });
  const work = put('task:class', 'calendar-task', daily(today, '18:00', '21:00'));
  const unrelated = put('task:other', 'calendar-task', { ...old.data, date: '2026-10-05', dayId: 'unlinked-workout', planVersion: null });
  const oldVersion = put('task:old-version', 'calendar-task', { ...old.data, date: '2026-10-05', planVersion: 'previous-plan-version' });
  const updated = call('update_training_plan', { expectedVersion: 1, plan: plan('新版循环'), schedule: { days: 3 } });
  assert.equal(updated.ok, true);
  assert.equal(recordById(db, 'alice', old.id).deleted, true);
  assert.deepEqual(updated.scheduled.map(record => record.date), [today, '2026-10-01']);
  assert.equal(call('delete_training_plan', { expectedVersion: 2 }).ok, true);
  for (const record of [history, completed, work, unrelated]) assert.deepEqual(recordById(db, 'alice', record.id), record);
  assert.ok(updated.scheduled.every(record => recordById(db, 'alice', record.id).deleted));
  assert.equal(recordById(db, 'alice', oldVersion.id).deleted, true);
});

test('plan and generated schedules roll back together if its idempotence receipt cannot commit', t => {
  const { db, call, put } = fixture(t);
  call('get_training_plan');
  getAssistantToolReceipts({ db, userId: 'alice', requestId: 'ensure-ledger' });
  const task = put('task:class', 'calendar-task', daily());
  db.exec("CREATE TRIGGER fail_plan_receipt BEFORE INSERT ON ai_plan_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.throws(() => call('create_training_plan', { plan: plan() }), /fixture failure/);
  assert.equal(recordById(db, 'alice', 'active-plan'), null);
  assert.deepEqual(getRecords(db, 'alice'), [task]);
});

test('calendar CRUD permits multiple sessions per date, detects stale training edits and isolates accounts', t => {
  const { db, call, put } = fixture(t);
  call('create_training_plan', { plan: plan(), schedule: { startDate: '2026-10-10', days: 1 } });
  const initial = call('read_calendar');
  const other = put('task:other-training', 'calendar-task', { ...training(), daySnapshot: plan().days[0] });
  assert.equal(call('create_calendar_task', { task: training(), calendarVersion: initial.calendarVersion }).code, 'CALENDAR_CONFLICT');
  const version = call('read_calendar').calendarVersion;
  const created = call('create_calendar_task', { task: training(), calendarVersion: version }, { requestId: 'calendar-create' });
  assert.equal(created.ok, true);
  assert.match(created.record.id, /^task:/);
  assert.equal(call('read_calendar').records.filter(record => record.data.date === today).length, 2);
  assert.equal(call('create_calendar_task', { task: training(), calendarVersion: version }, { requestId: 'calendar-create' }).replayed, true);
  assert.equal(call('update_calendar_task', { id: created.record.id, expectedVersion: 9, calendarVersion: created.calendarVersion, task: training('2026-09-30') }).code, 'VERSION_CONFLICT');
  const updated = call('update_calendar_task', { id: created.record.id, expectedVersion: 1, calendarVersion: created.calendarVersion, task: training('2026-09-30') });
  assert.equal(updated.ok, true);
  assert.equal(updated.record.id, created.record.id);
  assert.equal(updated.record.version, 2);
  assert.equal(call('delete_calendar_task', { id: created.record.id, expectedVersion: 2 }, { userId: 'bob' }).code, 'RECORD_NOT_FOUND');
  assert.equal(call('delete_calendar_task', { id: created.record.id, expectedVersion: 2 }).ok, true);
  assert.equal(recordById(db, 'alice', created.record.id).deleted, true);
  assert.equal(call('read_calendar').dayTypes.find(item => item.date === '2026-09-30').dayType, 'rest');
  assert.equal(call('delete_calendar_task', { id: other.id, expectedVersion: 1 }).ok, true);
  assert.equal(call('read_calendar').dayTypes[0].dayType, 'rest');
});

test('calendar mutations reject historical/completed tasks and changing legacy training to daily', t => {
  const { call, put } = fixture(t);
  call('create_training_plan', { plan: plan(), schedule: { startDate: '2026-10-10', days: 1 } });
  const legacy = put('legacy:train', 'schedule', { date: today, dayId: 'train', completed: false });
  assert.equal(call('update_calendar_task', { id: legacy.id, expectedVersion: 1, calendarVersion: call('read_calendar').calendarVersion, task: daily() }).code, 'INVALID_ARGUMENTS');
  const done = put('task:done', 'calendar-task', { ...training(), completed: true });
  const past = put('task:past', 'calendar-task', training('2026-09-28'));
  for (const item of [done, past]) assert.equal(call('delete_calendar_task', { id: item.id, expectedVersion: 1 }).code, 'HISTORICAL_TASK');
  assert.equal(call('create_calendar_task', { task: daily(), calendarVersion: call('read_calendar').calendarVersion }).code, 'INVALID_ARGUMENTS');
  const oldDaily = put('task:old-daily', 'calendar-task', daily());
  assert.equal(call('delete_calendar_task', { id: oldDaily.id, expectedVersion: 1 }).code, 'RECORD_NOT_FOUND');
  assert.equal(call('update_calendar_task', { id: oldDaily.id, expectedVersion: 1, calendarVersion: call('read_calendar').calendarVersion, task: training() }).code, 'RECORD_NOT_FOUND');
  const { taskType, ...omittedType } = training();
  assert.equal(call('create_calendar_task', { task: omittedType, calendarVersion: call('read_calendar').calendarVersion }, { localTime: '24:00' }).ok, true);
});

test('calendar ignores daily and manual day-type records while legacy training uses data.date and drops clock fields', t => {
  const { db, call, put } = fixture(t);
  const initial = call('read_calendar').calendarVersion;
  put('old-daily', 'calendar-task', daily());
  put('day-type:2026-09-29', 'day-type', { date: today, rest: true });
  put('legacy-rest', 'schedule', { date: today, rest: true });
  assert.equal(call('read_calendar').calendarVersion, initial);
  assert.equal(call('read_calendar').records.length, 0);
  put('unrelated-identifier', 'schedule', { date: today, dayId: 'train', rest: true, daySnapshot: plan().days[0], startTime: '18:00', endTime: '19:00' });
  const current = call('read_calendar');
  assert.notEqual(current.calendarVersion, initial);
  assert.equal(current.records[0].data.date, today);
  assert.equal('startTime' in current.records[0].data, false);
  assert.equal('rest' in current.records[0].data, false);
  assert.equal(current.dayTypes[0].dayType, 'training');
  assert.equal(calendarState(db, 'alice').raw.length, 1);
  assert.equal(call('create_training_plan', { plan: plan(), schedule: { days: 1 } }).scheduled.length, 0);
});

test('moving a previous-plan task preserves its snapshot and active-plan edits invalidate a read calendar version', t => {
  const { db, call, put } = fixture(t);
  const created = call('create_training_plan', { plan: plan(), schedule: { startDate: '2026-10-10', days: 1 } });
  const previousSnapshot = { ...plan().days[0], name: '旧动作清单', exercises: [{ exerciseId: 'pushup', sets: 2, reps: '5', restSeconds: 60 }] };
  const previous = put('task:old-snapshot', 'calendar-task', { ...daily(today, '18:00', '19:00'), taskType: 'training', dayId: 'train', daySnapshot: previousSnapshot, planVersion: 'old-version' });
  const version = call('read_calendar').calendarVersion;
  writeRecord(db, 'alice', { ...created.record, data: { ...created.record.data, name: '另一标签页修改' } });
  const args = { id: previous.id, expectedVersion: 1, calendarVersion: version, task: training('2026-09-30') };
  assert.equal(call('update_calendar_task', args).code, 'CALENDAR_CONFLICT');
  args.calendarVersion = call('read_calendar').calendarVersion;
  const moved = call('update_calendar_task', args);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.record.data.daySnapshot, previousSnapshot);
  assert.equal(moved.record.data.planVersion, 'old-version');
  assert.equal('startTime' in moved.record.data, false);
  assert.equal('endTime' in moved.record.data, false);
});

test('published assistant task and plan schemas expose dates without daily tasks or time settings', () => {
  const properties = assistantTools.find(tool => tool.function.name === 'create_calendar_task').function.parameters.properties.task;
  assert.deepEqual(properties.properties.taskType.enum, ['training']);
  assert.deepEqual(properties.required, ['title', 'date']);
  assert.equal('startTime' in properties.properties, false);
  assert.equal('endTime' in properties.properties, false);
  const schedule = assistantTools.find(tool => tool.function.name === 'create_training_plan').function.parameters.properties.schedule;
  assert.deepEqual(Object.keys(schedule.properties), ['allowBusyDates', 'startDate', 'days', 'repeat', 'weekdays']);
});

test('today meal CRUD calculates actual portions, detects conflicts and retains photos and correction history', t => {
  const { db, call, put } = fixture(t);
  const created = call('create_meal', { meal: meal() });
  assert.equal(created.ok, true);
  assert.equal(created.record.data.date, today);
  assert.equal(created.totals.kcal, 180);
  assert.equal(created.totals.protein, 3);
  const photos = [{ id: 'photo-1', name: '餐前.png', type: 'image/png' }];
  put('meal:existing', 'meal', { ...created.record.data, attachments: photos, history: [{ notes: '餐前', result: '旧修订' }] });
  const updated = call('update_meal', { id: 'meal:existing', expectedVersion: 1, meal: meal('午餐', 200) });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.record.data.attachments, photos);
  assert.equal(updated.record.data.history[0].result, '旧修订');
  assert.equal(updated.record.data.history.length, 2);
  assert.equal(updated.totals.kcal, 420);
  assert.equal(call('update_meal', { id: 'meal:existing', expectedVersion: 1, meal: meal() }).code, 'VERSION_CONFLICT');
  const deleted = call('delete_meal', { id: created.record.id, expectedVersion: 1 });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.totals.kcal, 240);
  assert.equal(recordById(db, 'alice', created.record.id).data, null);
  assert.equal(call('get_today_meals').records.length, 1);
});

test('today meal writes isolate accounts and dates, reject invalid nutrition, and strip model-provided photos/history', t => {
  const { call, put } = fixture(t);
  const other = put('meal:private', 'meal', { ...meal(), date: today, confirmed: true }, 'bob');
  const yesterday = put('meal:past', 'meal', { ...meal(), date: '2026-09-28', confirmed: true });
  assert.equal(call('delete_meal', { id: other.id, expectedVersion: 1 }).code, 'RECORD_NOT_FOUND');
  assert.equal(call('delete_meal', { id: yesterday.id, expectedVersion: 1 }).code, 'NOT_TODAY');
  for (const grams of [0, -2, 10001, null]) assert.equal(call('create_meal', { meal: { ...meal(), items: [{ ...meal().items[0], grams }] } }).code, 'INVALID_ARGUMENTS');
  const created = call('create_meal', { meal: { ...meal(), date: '2025-01-01', attachments: [{ id: 'other-private-image' }], history: ['forged'] } });
  assert.equal(created.record.data.date, today);
  assert.deepEqual(created.record.data.attachments, []);
  assert.equal(created.record.data.history.length, 1);
  assert.equal(call('get_today_meals').records.length, 1);
});

test('one request can save plan and several meals but replay cannot duplicate or modify the same record again', t => {
  const { db, call } = fixture(t);
  const requestId = 'combined-request';
  const training = call('create_training_plan', { plan: plan(), schedule: { days: 1 } }, { requestId });
  const lunch = call('create_meal', { meal: meal() }, { requestId });
  const dinner = call('create_meal', { meal: meal('晚餐') }, { requestId });
  assert.equal(training.ok && lunch.ok && dinner.ok, true);
  const replay = call('create_meal', { meal: meal() }, { requestId });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, lunch.record.id);
  const reorderedMeal = Object.fromEntries(Object.entries(meal()).reverse());
  reorderedMeal.items = reorderedMeal.items.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal(call('create_meal', { meal: reorderedMeal }, { requestId }).replayed, true);
  assert.equal(call('update_meal', { id: lunch.record.id, expectedVersion: 1, meal: meal('午餐', 200) }, { requestId }).code, 'REQUEST_ALREADY_MUTATED');
  const receipts = getAssistantToolReceipts({ db, userId: 'alice', requestId });
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(result => result.replayed));
  assert.equal(receipts[0].records[0].id, training.records[0].id);
  assert.equal(getAssistantToolReceipts({ db, userId: 'bob', requestId }).length, 0);
  assert.equal(call('get_today_meals').records.length, 2);
  for (const row of db.prepare('SELECT * FROM ai_assistant_operations').all()) assert.equal(JSON.stringify(row).includes('米饭'), false);
});

test('meal record and receipt roll back together and invalid existing totals cannot cause success-after-error', t => {
  const { db, call, put } = fixture(t);
  getAssistantToolReceipts({ db, userId: 'alice', requestId: 'ensure-ledger' });
  db.exec("CREATE TRIGGER fail_meal_receipt BEFORE INSERT ON ai_assistant_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.throws(() => call('create_meal', { meal: meal() }), /fixture failure/);
  assert.equal(call('get_today_meals').records.length, 0);
  db.exec('DROP TRIGGER fail_meal_receipt');
  put('meal:invalid-old', 'meal', { date: today, confirmed: true, items: [{ grams: 100, kcal: -1 }] });
  const response = call('create_meal', { meal: meal() });
  assert.equal(response.ok, false);
  assert.equal(getRecords(db, 'alice').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_assistant_operations').get().count, 0);
});

test('server validates client today and computes its local clock from a bounded timezone offset', () => {
  const now = new Date('2026-09-29T16:45:22Z');
  assert.equal(resolveLocalToday('2026-09-30', now), '2026-09-30');
  assert.equal(resolveLocalTime('2026-09-30', -480, now), '00:46');
  assert.equal(resolveLocalTime('2026-09-29', 240, now), '12:46');
  assert.throws(() => resolveLocalToday('2026-09-31', now));
  assert.throws(() => resolveLocalToday('2026-09-01', now));
  assert.throws(() => resolveLocalTime('2026-09-29', -480, now));
  assert.throws(() => resolveLocalTime('2026-09-30', -1000, now));
});


test('AI scheduling shares recurring defaults, holiday exceptions and manual overrides',t=>{
 const {put,call}=fixture(t);
 put('calendar-busy-days','calendar-settings',{weeklyRules:[{from:today,weekdays:[1,3,5]}],overrides:{'2026-10-05':true,'2026-10-09':false}});
 const created=call('create_training_plan',{plan:plan(),schedule:{days:14}});assert.equal(created.ok,true);
 assert(created.scheduled.every(r=>!['2026-09-30','2026-10-05','2026-10-12'].includes(r.date)));
 const read=call('read_calendar',{startDate:'2026-10-01',endDate:'2026-10-12'});assert.equal(read.ok,true);assert.deepEqual(read.busyDates,['2026-10-05','2026-10-12']);
 const rejected=call('create_calendar_task',{task:training('2026-10-05'),calendarVersion:read.calendarVersion});assert.equal(rejected.ok,false);assert.match(rejected.message,/繁忙/);
 const free=call('create_calendar_task',{task:training('2026-10-02'),calendarVersion:read.calendarVersion});assert.equal(free.ok,true);
});
