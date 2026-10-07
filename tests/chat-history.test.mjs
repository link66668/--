import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/storage.mjs';
import {writeRecord} from '../server/calendar-data.mjs';
import {prepareChatHistory} from '../server/chat-history.mjs';
import {modelCapabilities} from '../public/model-capabilities.js';
import {animatedExercises,supportedExercises} from '../精细模型与动作开发/exercise-catalog.js';
import {assistantTools} from '../server/assistant-tools.mjs';
import {initialChatTools,expandChatTools} from '../server/chat-tool-policy.mjs';

function fixture(t){const path=mkdtempSync(join(tmpdir(),'fitness-history-')),{db}=openStore(path);for(const id of ['a','b'])db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,id+'@test.com',id,'fixture',new Date().toISOString());t.after(()=>{db.close();rmSync(path,{recursive:true,force:true});});return db;}
test('model capability data matches every standalone animation',()=>{
  assert.deepEqual(Object.keys(modelCapabilities).sort(),[...supportedExercises].sort());
  assert.deepEqual(Object.keys(modelCapabilities).filter(id=>modelCapabilities[id].motion).sort(),[...animatedExercises].sort());
  assert.deepEqual(Object.keys(modelCapabilities).filter(id=>modelCapabilities[id].isometric),['plank']);
});
test('large write schemas are introduced only after the corresponding read',()=>{
  const initial=initialChatTools(assistantTools);
  assert.equal(initial.some(t=>t.function.name.startsWith('create_')),false);
  const reads=new Set();
  const beforeCalendar=expandChatTools(assistantTools,initial,'get_training_plan',reads);
  assert(!beforeCalendar.some(t=>t.function.name==='create_training_plan'));
  const plan=expandChatTools(assistantTools,beforeCalendar,'read_calendar',reads);
  assert(plan.some(t=>t.function.name==='create_training_plan'));
  assert(!plan.some(t=>t.function.name==='create_meal'));
  assert(expandChatTools(assistantTools,plan,'get_today_meals',reads).some(t=>t.function.name==='create_meal'));
  assert(JSON.stringify(initial).length<JSON.stringify(assistantTools).length*.4);
});
test('large context is bounded without destroying original history or retries',t=>{
  const db=fixture(t),saved=Array.from({length:90},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:'原文'+i+' '+('x'.repeat(1000))}));
  writeRecord(db,'a',{id:'conversation',kind:'conversation',data:{messages:saved}});
  const body={task:'chat',stream:true,conversationId:'conversation',messages:saved.slice(10,89)};
  const result=prepareChatHistory({db,userId:'a',body,maxCharacters:5000});
  assert(result.body.messages.length<8);
  assert.equal(result.body.messages.at(-1).id,'m88');
  const first=result.execute('read_conversation_history',{offset:0,limit:2});
  assert.equal(first.records[0].content,saved[0].content);
  assert.equal(first.total,89); // Excludes the stale answer during regeneration.
  assert.equal(first.nextOffset,2);
  assert.equal(result.execute('read_conversation_history',{query:'原文44 '}).records[0].index,44);
  assert.throws(()=>prepareChatHistory({db,userId:'b',body}),/无权访问/);
  assert.equal(result.execute('read_conversation_history',{limit:100}).ok,false);
});
test('historical files are attached only on demand and cannot read another account or unrelated upload',t=>{
  const db=fixture(t);
  for(const [id,user]of [['old','a'],['new','a'],['unrelated','a'],['foreign','b']])db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(id,user,id+'.txt','text/plain',Buffer.from('original'),8,'2026-10-01');
  const messages=[{role:'user',content:'旧照片说明',attachments:[{id:'old'}]},{role:'assistant',content:'之前的回复'},{role:'user',content:'新问题',attachments:[{id:'new'}]}];
  const result=prepareChatHistory({db,userId:'a',body:{messages}});
  assert.deepEqual(result.body.messages[0].attachments,[]);
  assert.match(result.body.messages[0].content,/old.txt/);
  assert.deepEqual(result.body.messages[2].attachments,[{id:'new'}]);
  const read=result.execute('read_chat_attachment',{id:'old'});
  assert(read.ok);assert.match(JSON.stringify(read.modelMessages[0].content),/original/);
  assert.equal(result.execute('read_chat_attachment',{id:'unrelated'}).ok,false);
  assert.equal(result.execute('read_chat_attachment',{id:'foreign'}).ok,false);
  assert.throws(()=>prepareChatHistory({db,userId:'b',body:{messages}}),/无权访问/);
  messages[0].content='长'.repeat(32000);
  assert.equal(prepareChatHistory({db,userId:'a',body:{messages}}).body.messages[0].content.length,32000);
});
