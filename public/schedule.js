import {busyPredicate,normalizeBusySettings} from './busy-rules.js';
/** Shared training calendar rules. Dates are local wall-clock values. */
export function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error('日期无效。');
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期。');
  const d = new Date(value + 'T12:00:00');
  if (!Number.isFinite(d.getTime()) || localDate(d) !== value || Number(value.slice(0,4)) < 1900 || Number(value.slice(0,4)) > 2199) throw new Error('日期须在 1900–2199 年之间且实际存在。');
  return value;
}
export function addDays(date, amount) {
  validateDate(date);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 36600) throw new Error('日期间隔无效。');
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + amount);
  return validateDate(localDate(d));
}
export function weekDates(date) {
  validateDate(date);
  const start = addDays(date, -((new Date(date+'T12:00:00').getDay()+6)%7));
  return Array.from({length:7}, (_, index) => addDays(start,index));
}
export function validateCalendarTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练任务格式无效。');
  if (value.taskType !== undefined && value.taskType !== 'training') throw new Error('日程表仅支持训练任务。');
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('任务名称须为 1–80 个字符。');
  const date = validateDate(value.date), notes = value.notes ?? '';
  if (typeof notes !== 'string' || notes.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes)) throw new Error('任务备注须为 2000 字以内的文本。');
  if (value.completed !== undefined && typeof value.completed !== 'boolean') throw new Error('任务完成状态无效。');
  return {taskType:'training',title,date,notes,completed:value.completed ?? false};
}

/** Place one complete cycle on the calendar, leaving recovery dates empty. */
export function planCalendarTasks(plan, startDate) {
  validateDate(startDate);
  if (!plan?.planVersion || !Array.isArray(plan.days) || !plan.days.some(day=>!day.rest)) throw new Error('请先确认训练计划。');
  return plan.days.flatMap((day,index)=>{
    const date=addDays(startDate,index);
    if(day.rest)return [];
    if(!day.id||!day.exercises?.length)throw new Error('每个训练日需要至少一个动作。');
    const data={...validateCalendarTask({title:day.name,date}),dayId:day.id,daySnapshot:structuredClone(day),planVersion:plan.planVersion,rest:false};
    return [{id:`task:plan:${plan.planVersion}:${startDate}:${index}`,kind:'calendar-task',data}];
  });
}

/** Project any date window from the original start, including rest days. */
export function recurringCalendarTasks(cycle, fromDate, toDate, busyDates = []) {
  if(cycle.endDate){validateDate(cycle.endDate);if(toDate>cycle.endDate)toDate=cycle.endDate;}
  if(fromDate>toDate)return [];
  const tasks=projectRecurringTasks(cycle,fromDate,toDate,cycleBusySettings(cycle,busyDates));
  for(const task of tasks)if(cycle.allowBusyDates?.includes(task.data.date))task.data.busyDateOverride=task.data.date;
  return tasks.filter(task=>!cycle.excludedDates?.includes(task.data.date));
}

// Exceptions belong to exact dates in this cycle, never to global busy settings.
function cycleBusySettings(cycle, settings) {
  if(!cycle.allowBusyDates?.length)return settings;
  if(Array.isArray(settings))return settings.filter(date=>!cycle.allowBusyDates.includes(date));
  const result=normalizeBusySettings(settings);
  for(const date of cycle.allowBusyDates)result.overrides[validateDate(date)]=false;
  return result;
}

function projectRecurringTasks(cycle, fromDate, toDate, busyDates = []) {
  validateDate(cycle.startDate);validateDate(fromDate);validateDate(toDate);
  const plan=cycle.plan;
  if(!cycle.id||!plan?.planVersion||!Array.isArray(plan.days)||!plan.days.length||!plan.days.some(day=>!day.rest))throw new Error('循环训练计划无效。');
  if(cycle.weekdays)return weeklyTasks(cycle,fromDate,toDate,busyDates);
  const ordinal=date=>Date.parse(date+'T00:00:00Z')/86400000;
  if(!Array.isArray(busyDates))return recurringWithRules(cycle,fromDate,toDate,busyDates);
  const busy=normalizeBusyDates(busyDates);
  const first=Math.max(0,ordinal(fromDate)-ordinal(cycle.startDate)-busy.length),last=ordinal(toDate)-ordinal(cycle.startDate);
  if(ordinal(toDate)-ordinal(fromDate)>366)throw new Error('一次最多补齐一年的训练。');
  const tasks=[];
  for(let offset=first;offset<=last;offset++){
    const day=plan.days[offset%plan.days.length];if(day.rest)continue;
    if(!day.id||!day.exercises?.length)throw new Error('每个训练日需要至少一个动作。');
    const projected=cycleTaskOrdinal(cycle,offset,busy);
    if(projected>ordinal(toDate))break;
    const date=new Date(projected*86400000).toISOString().slice(0,10);
    if(date<fromDate)continue;
    if(date>toDate)break;
    tasks.push({id:`task:cycle:${cycle.id}:${offset}`,kind:'calendar-task',data:{...validateCalendarTask({title:day.name,date}),dayId:day.id,daySnapshot:structuredClone(day),planVersion:plan.planVersion,cycleId:cycle.id,rest:false}});
  }
  return tasks;
}

// Weekdays are ISO weekdays (Monday=1, Sunday=7). Busy slots postpone the
// next workout to the next selected weekday without shifting the weekly rule.
function weeklyTasks(cycle,from,to,settings) {
  if((Date.parse(to)-Date.parse(from))/86400000>366)throw new Error('一次最多补齐一年的训练。');
  const days=cycle.plan.days.filter(day=>!day.rest),tasks=[];
  for(const {date,offset}of weeklySlots(cycle,settings,to)){
    if(date<from)continue;
    const day=days[offset%days.length];
    tasks.push({id:`task:cycle:${cycle.id}:${offset}`,kind:'calendar-task',data:{...validateCalendarTask({title:day.name,date}),dayId:day.id,daySnapshot:structuredClone(day),planVersion:cycle.plan.planVersion,cycleId:cycle.id,rest:false}});
  }
  return tasks;
}
function* weeklySlots(cycle,settings,to='2199-12-31') {
  if(!Array.isArray(cycle.weekdays)||!cycle.weekdays.length||cycle.weekdays.some(day=>!Number.isInteger(day)||day<1||day>7))throw new Error('每周训练日须为周一至周日。');
  const busy=busyPredicate(settings);let offset=0;
  for(let time=Date.parse(cycle.startDate);time<=Date.parse(to);time+=86400000){
    const date=new Date(time).toISOString().slice(0,10),weekday=new Date(time).getUTCDay()||7;
    if(cycle.weekdays.includes(weekday)&&!busy(date))yield {date,offset:offset++};
  }
}

function recurringWithRules(cycle,from,to,settings) {
  if((Date.parse(to)-Date.parse(from))/86400000>366)throw new Error('一次最多补齐一年的训练。');
  const busy=busyPredicate(settings),tasks=[];let offset=0;
  for(let time=Date.parse(cycle.startDate);time<=Date.parse(to);time+=86400000){
    const date=new Date(time).toISOString().slice(0,10),day=cycle.plan.days[offset%cycle.plan.days.length];
    if(!day.rest&&busy(date))continue;
    if(!day.rest&&date>=from){
      if(!day.id||!day.exercises?.length)throw new Error('每个训练日需要至少一个动作。');
      tasks.push({id:`task:cycle:${cycle.id}:${offset}`,kind:'calendar-task',data:{...validateCalendarTask({title:day.name,date}),dayId:day.id,daySnapshot:structuredClone(day),planVersion:cycle.plan.planVersion,cycleId:cycle.id,rest:false}});
    }
    offset++;
  }
  return tasks;
}

function cycleDateLookup(cycle,settings) {
  settings=cycleBusySettings(cycle,settings);
  if(cycle.weekdays){
    const slots=weeklySlots(cycle,settings),dates=[];
    return offset=>{
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error('循环训练日期无效。');
      while(dates.length<=offset){const next=slots.next();if(next.done)throw new Error('没有足够的空闲日期安排训练。');dates.push(next.value.date);}
      return dates[offset];
    };
  }
  if(Array.isArray(settings))return offset=>cycleTaskDate(cycle,offset,settings);
  const busy=busyPredicate(settings),dates=[];let time=Date.parse(cycle.startDate),stalled=0;
  return offset=>{
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('循环训练日期无效。');
    while(dates.length<=offset){
      if(time>Date.parse('2199-12-31')||stalled>366)throw new Error('没有足够的空闲日期安排训练，请减少默认繁忙日或手动留出空闲日期。');
      const date=new Date(time).toISOString().slice(0,10),day=cycle.plan.days[dates.length%cycle.plan.days.length];time+=86400000;
      if(!day.rest&&busy(date)){stalled++;continue;}
      stalled=0;dates.push(date);
    }
    return dates[offset];
  };
}

export function calendarResetChanges(records) {
  return records.filter(record=>!record.deleted&&(['calendar-task','schedule','training-cycle'].includes(record.kind)||record.id==='calendar-busy-days')).map(record=>({id:record.id,kind:record.kind,deleted:true}));
}

export function normalizeBusyDates(dates = []) {
  if(!Array.isArray(dates))throw new Error('繁忙日期格式无效。');
  return [...new Set(dates.map(validateDate))].sort();
}

/** Busy training slots pause the cycle; a planned rest slot still consumes a day. */
export function cycleTaskDate(cycle, offset, busyDates = []) {
  busyDates=cycleBusySettings(cycle,busyDates);
  if(cycle.weekdays)return cycleDateLookup(cycle,busyDates)(offset);
  if(!Array.isArray(busyDates))return cycleDateLookup(cycle,busyDates)(offset);
  return validateDate(new Date(cycleTaskOrdinal(cycle,offset,busyDates)*86400000).toISOString().slice(0,10));
}

function cycleTaskOrdinal(cycle, offset, busyDates) {
  validateDate(cycle.startDate);
  if(!Number.isSafeInteger(offset)||offset<0||!cycle.plan?.days?.length)throw new Error('循环训练日期无效。');
  const start=Date.parse(cycle.startDate+'T00:00:00Z')/86400000;
  let delay=0;
  for(const date of busyDates) {
    const logical=Date.parse(date+'T00:00:00Z')/86400000-start-delay;
    if(logical>offset)break;
    if(logical>=0&&!cycle.plan.days[logical%cycle.plan.days.length].rest)delay++;
  }
  return start+offset+delay;
}

function finishedTraining(record) {
  const items=record.data.daySnapshot?.exercises||[];
  return record.data.completed===true||(items.length>0&&items.every(item=>item.completed===true));
}

/** Recalculate pending occurrences without replacing their content or resurrecting deletions. */
export function rescheduleBusyTasks(records, cycle, previousDates, nextDates, today) {
  validateDate(today);
  const previous=Array.isArray(previousDates)?normalizeBusyDates(previousDates):normalizeBusySettings(previousDates),next=Array.isArray(nextDates)?normalizeBusyDates(nextDates):normalizeBusySettings(nextDates),busy=busyPredicate(next);
  const previousDate=cycle&&cycleDateLookup(cycle,previous),nextDate=cycle&&cycleDateLookup(cycle,next);
  const changes=[],manual=[],occupied=new Set(),oldOccupied=new Set();
  const prefix=cycle?`task:cycle:${cycle.id}:`:null;
  for(const record of records) {
    if(!isTrainingRecord(record))continue;
    if(record.data.busyDateOverride===record.data.date){occupied.add(record.data.date);oldOccupied.add(record.data.date);continue;}
    if(record.data.date<today||finishedTraining(record)){occupied.add(record.data.date);oldOccupied.add(record.data.date);continue;}
    const suffix=prefix&&record.id.startsWith(prefix)?record.id.slice(prefix.length):'';
    const offset=/^\d+$/.test(suffix)?Number(suffix):null;
    if(offset!==null&&!record.data.busyBaseDate&&record.data.date===previousDate(offset)) {
      const date=nextDate(offset);
      oldOccupied.add(record.data.date);occupied.add(date);
      if(date>=today&&date!==record.data.date)changes.push({id:record.id,kind:record.kind,data:{...structuredClone(record.data),date}});
    } else manual.push(record);
  }
  const groups=new Map();
  for(const record of manual){const base=record.data.busyBaseDate||record.data.date;validateDate(base);if(!groups.has(base))groups.set(base,[]);groups.get(base).push(record);}
  let delay=0;
  for(const [base,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    let date=addDays(base,delay);if(date<today)date=today;
    let attempts=0;
    while(busy(date)||(occupied.has(date)&&(date!==base||!oldOccupied.has(base)))){if(++attempts>366)throw new Error('没有足够的空闲日期安排训练，请减少默认繁忙日或手动留出空闲日期。');date=addDays(date,1);}
    delay=Math.round((Date.parse(date)-Date.parse(base))/86400000);occupied.add(date);
    for(const record of items) {
      if(date===record.data.date)continue;
      const data={...structuredClone(record.data),date};
      if(date!==base)data.busyBaseDate=base;else delete data.busyBaseDate;
      changes.push({id:record.id,kind:record.kind,data});
    }
  }
  return changes;
}

function isTrainingRecord(record) {
  if (!record || record.deleted || !record.data) return false;
  const data = record.data;
  if (data.daySnapshot?.rest === true) return false;
  if (record.kind === 'schedule') return data.taskType !== 'daily' && Boolean(data.dayId || data.daySnapshot);
  return record.kind === 'calendar-task' && data.taskType === 'training';
}

/** Old daily-task and manual day-type records stay stored, but do not participate
 * in the training calendar. Date and snapshot history are never rewritten here. */
export function calendarTasks(taskRecords = [], legacyScheduleRecords = [], activePlan = null) {
  const output = [];
  for (const record of [...taskRecords,...legacyScheduleRecords]) {
    if (!isTrainingRecord(record)) continue;
    const raw = record.data;
    try { validateDate(raw.date); } catch { continue; }
    const snapshot = raw.daySnapshot || activePlan?.days?.find(day => day.id === raw.dayId);
    if (snapshot?.rest) continue;
    output.push({...structuredClone(record),data:{...structuredClone(raw),taskType:'training',
      title:raw.title || snapshot?.name || '训练任务',notes:raw.notes || '',completed:Boolean(raw.completed),
      ...(snapshot?{daySnapshot:structuredClone(snapshot)}:{})}});
  }
  return output.sort((a,b)=>a.data.date.localeCompare(b.data.date) || String(a.id).localeCompare(String(b.id)));
}

/** A day's nutrition type depends only on its live training tasks. Completed
 * training still counts; moving/deleting the last task makes the old date rest. */
export function trainingDayType(date, records = []) {
  validateDate(date);
  return records.some(record=>isTrainingRecord(record) && record.data.date===date) ? 'training' : 'rest';
}
