import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,getRecords} from '../server/storage.mjs';
import {executeAssistantTool} from '../server/assistant-tools.mjs';
import {recordById,writeRecord} from '../server/calendar-data.mjs';
import {recurringCalendarTasks,rescheduleBusyTasks} from '../public/schedule.js';
import {isBusyDate} from '../public/busy-rules.js';

const today='2026-10-01'; // Thursday: must not treat the start as Monday.
const plan={name:'三分化',days:['胸日','背日','腿日'].map((name,i)=>({id:'day-'+i,name,rest:false,exercises:[{exerciseId:['bench','row','squat'][i],sets:3,reps:'8–12',restSeconds:90}]}))};
function fixture(t){
  const path=mkdtempSync(join(tmpdir(),'fitness-recurring-')),{db}=openStore(path);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('a','a@test','a','test',today);
  t.after(()=>{db.close();rmSync(path,{recursive:true,force:true});});let index=0;
  return {db,call:(name,args={},requestId=`recurring-${++index}`)=>executeAssistantTool({db,userId:'a',name,args,requestId,localToday:today}),cycle:()=>recordById(db,'a','calendar-cycle')};
}
test('AI weekly plans persist the same cycle as manual plans and continue across months and years',t=>{
  const {db,call,cycle}=fixture(t);
  const created=call('create_training_plan',{plan,schedule:{weekdays:[1,3,5],days:7}},'weekly-create');
  assert(created.ok);assert.equal(created.recurrence.repeat,true);
  assert.deepEqual(created.scheduled.map(task=>task.date),['2026-10-02','2026-10-05','2026-10-07']);
  const saved=cycle().data;
  assert.deepEqual(created.records.map(task=>task.id),recurringCalendarTasks(saved,today,'2026-10-07').map(task=>task.id));
  for(const [from,to]of [['2026-11-01','2026-11-30'],['2027-01-01','2027-01-31']]){
    const tasks=recurringCalendarTasks(saved,from,to);assert(tasks.length>=12);
    assert(tasks.every(task=>[1,3,5].includes(new Date(task.data.date).getUTCDay())));
  }
  const before=getRecords(db,'a');assert(call('create_training_plan',{plan,schedule:{weekdays:[1,3,5],days:7}},'weekly-create').replayed);assert.deepEqual(getRecords(db,'a'),before);
  assert.deepEqual(call('get_training_plan').recurrence.weekdays,[1,3,5]);
});
test('updates remove obsolete future occurrences, retain completed history, inherit weekdays and delete the cycle',t=>{
  const {db,call,cycle}=fixture(t);
  const created=call('create_training_plan',{plan,schedule:{weekdays:[1,3,5]}});
  const first=created.records[0];writeRecord(db,'a',{...first,data:{...first.data,completed:true}});
  const done=recordById(db,'a',first.id);
  const updated=call('update_training_plan',{expectedVersion:1,plan:{...plan,name:'调整组数'},schedule:{days:7}});
  assert(updated.ok);assert.deepEqual(cycle().data.weekdays,[1,3,5]);
  assert.equal(recordById(db,'a',created.records.at(-1).id).deleted,true);
  assert.deepEqual(recordById(db,'a',first.id),done);
  assert(!recurringCalendarTasks(cycle().data,today,'2026-11-01').some(task=>task.data.date===done.data.date));
  assert(call('delete_training_plan',{expectedVersion:2}).ok);assert(cycle().deleted);assert.deepEqual(recordById(db,'a',first.id),done);
});
test('finite schedules stop; busy weekdays preserve the selected weekdays and workout order',t=>{
  const {call,cycle}=fixture(t);
  assert(call('create_training_plan',{plan,schedule:{weekdays:[1,3,5],days:7,repeat:false}}).ok);
  assert.deepEqual(recurringCalendarTasks(cycle().data,'2026-11-01','2026-11-30'),[]);
  const rule={...cycle().data};delete rule.endDate;
  const normal=recurringCalendarTasks(rule,today,'2026-10-16');
  const busy=['2026-10-02'],moved=recurringCalendarTasks(rule,today,'2026-10-16',busy);
  assert.equal(moved[0].data.date,'2026-10-05');assert.equal(moved[0].id,normal[0].id);assert.equal(moved[0].data.title,'胸日');
  const changes=rescheduleBusyTasks(normal,rule,[],busy,today);
  assert.equal(changes[0].data.date,'2026-10-05');
  assert(changes.every(task=>[1,3,5].includes(new Date(task.data.date).getUTCDay())));
  assert(call('update_training_plan',{expectedVersion:1,plan,schedule:{weekdays:[]}}).ok);
  assert.equal(cycle().data.weekdays,undefined);
});

test('AI reads full busy rules and both initial and future weekly schedules exclude busy dates',t=>{
  const {db,call,cycle}=fixture(t);
  const settings={weeklyRules:[{from:today,weekdays:[1,4,7]}],overrides:{'2026-10-02':true}};
  writeRecord(db,'a',{id:'calendar-busy-days',kind:'calendar-settings',data:settings});
  const read=call('read_calendar');
  assert.deepEqual(read.busySettings,settings);
  assert(read.availableDates.every(date=>!isBusyDate(date,settings)));
  const created=call('create_training_plan',{plan,schedule:{weekdays:[1,3,5],days:31}});
  assert(created.ok);assert(created.scheduled.length>0);
  assert(created.scheduled.every(task=>!isBusyDate(task.date,settings)));
  const future=recurringCalendarTasks(cycle().data,'2026-11-01','2026-11-30',settings);
  assert(future.length>0);assert(future.every(task=>!isBusyDate(task.data.date,settings)));
  assert.deepEqual(call('read_calendar').busySettings,settings);
});

test('explicit plan exceptions apply only to listed dates and are not inherited by a new plan request',t=>{
  const {db,call,cycle}=fixture(t);
  const settings={weeklyRules:[],overrides:{'2026-10-02':true,'2026-10-05':true}};
  writeRecord(db,'a',{id:'calendar-busy-days',kind:'calendar-settings',data:settings});
  const created=call('create_training_plan',{plan,schedule:{weekdays:[1,3,5],days:14,allowBusyDates:['2026-10-02']}});
  assert(created.ok);assert.equal(created.scheduled[0].date,'2026-10-02');
  assert(!created.scheduled.some(task=>task.date==='2026-10-05'));
  const tasks=recurringCalendarTasks(cycle().data,today,'2026-10-14',settings);
  assert.equal(tasks[0].data.busyDateOverride,'2026-10-02');
  assert.deepEqual(rescheduleBusyTasks(tasks,cycle().data,settings,settings,today),[]);
  assert.deepEqual(call('get_training_plan').recurrence.allowBusyDates,['2026-10-02']);
  assert(call('update_training_plan',{expectedVersion:1,plan,schedule:{days:14}}).ok);
  assert(!recurringCalendarTasks(cycle().data,today,'2026-10-14',settings).some(task=>isBusyDate(task.data.date,settings)));
  assert.deepEqual(call('read_calendar').busySettings,settings);
  assert.equal(call('update_training_plan',{expectedVersion:2,plan,schedule:{days:7,allowBusyDates:['2026-11-01']}}).ok,false);
});
