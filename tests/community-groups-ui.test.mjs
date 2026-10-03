import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityGroups} from '../public/community-groups.js';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function globals(t,values){for(const [key,value]of Object.entries(values)){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);}}
function harness(){
  let user={id:'reader',nickname:'读者'};const requests=[],saved=[],storage=new Map(),notices=[],error={hidden:true},list={scrollHeight:80,scrollTop:0},form={elements:{body:{value:'准备训练'}}};
  const owner={accountId:'reader',getUser:()=>user,alive:()=>true,readLocal:(key,fallback={})=>structuredClone(storage.get(key)??fallback),saveLocal:(key,value)=>{const copy=structuredClone(value);storage.set(key,copy);saved.push({key,value:copy});},toast:(...args)=>notices.push(args),api:{write:(path,method,body)=>{const pending=deferred();requests.push({path,method,body,pending});return pending.promise;}},page:()=>({querySelector:selector=>selector==='[data-cm-form="group-message"]'?form:selector==='.cm-group-compose-error'?error:list})};
  const groups=new CommunityGroups(owner),state=groups.state('group-a');groups.current=state;state.group={role:'member',canSend:true};state.draftBody='准备训练';
  groups.stateAlive=(candidate=groups.current)=>groups.alive()&&candidate===groups.current;groups.renderMessages=()=>{};groups.updateComposer=()=>{};groups.markRead=async()=>{};groups.refreshGroup=async()=>{};
  const ack=request=>({message:{id:'message-'+request.body.clientMutationId,body:request.body.body,senderId:'reader',clientMutationId:request.body.clientMutationId,sequence:requests.length,mentionUserIds:request.body.mentionUserIds,mentionAll:request.body.mentionAll}});
  return {groups,state,owner,requests,saved,notices,form,ack,switchAccount:()=>{user={id:'other'};}};
}

test('group send acknowledgements preserve new text and mention selections entered while sending',async()=>{
  const h=harness(),sent=h.groups.send();assert.equal(h.requests.length,1);
  h.state.draftBody='新的训练安排';h.state.mentions=[{id:'member-b',label:'朋友'}];h.state.composerRevision++;
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sent;
  assert.equal(h.state.items.length,1);assert.equal(h.state.draftBody,'新的训练安排');assert.deepEqual(h.state.mentions,[{id:'member-b',label:'朋友'}]);assert.equal(h.form.elements.body.value,'新的训练安排');
});

test('failed group sends reuse their mutation key for an unchanged retry and preserve structured mentions',async()=>{
  const h=harness();h.state.mentions=[{id:'member-b',label:'朋友'}];let sent=h.groups.send();h.requests[0].pending.reject(new Error('断网'));await sent;
  assert.equal(h.state.outbox[0].status,'failed');sent=h.groups.send();assert.equal(h.requests[1].body.clientMutationId,h.requests[0].body.clientMutationId);assert.deepEqual(h.requests[1].body.mentionUserIds,['member-b']);
  h.requests[1].pending.resolve(h.ack(h.requests[1]));await sent;assert.equal(h.state.items.length,1);assert.equal(h.state.outbox.length,0);assert.equal(h.state.draftBody,'');assert.deepEqual(h.state.mentions,[]);
});

test('editing a failed group message starts a separate mutation rather than changing the failed retry',async()=>{
  const h=harness();let sent=h.groups.send();h.requests[0].pending.reject(new Error('断网'));await sent;h.state.draftBody='新的内容';h.state.composerRevision++;
  sent=h.groups.send();assert.notEqual(h.requests[1].body.clientMutationId,h.requests[0].body.clientMutationId);h.requests[1].pending.resolve(h.ack(h.requests[1]));await sent;
  assert.equal(h.state.outbox.length,1);assert.equal(h.state.outbox[0].body,'准备训练');assert.equal(h.state.items[0].body,'新的内容');
});

test('a late group send after account switch cannot persist or render into the next account',async()=>{
  const h=harness(),sent=h.groups.send(),before=h.saved.length;h.switchAccount();h.requests[0].pending.resolve(h.ack(h.requests[0]));await sent;
  assert.equal(h.saved.length,before);assert.equal(h.state.items.length,0);assert.equal(h.state.draftBody,'准备训练');
});

test('a send committed before rejoining cannot insert its late receipt into the new membership history',async()=>{
  const h=harness(),sent=h.groups.send();h.groups.epoch++;h.state.items=[];h.state.draftBody='重新入群后的新文字';h.state.composerRevision++;
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sent;
  assert.equal(h.state.items.length,0);assert.equal(h.state.outbox.length,0);assert.equal(h.state.draftBody,'重新入群后的新文字');
});

test('a late receipt from a retired group state preserves a rejoined member draft and removes only its confirmed outbox entry',async()=>{
  const h=harness(),sent=h.groups.send(),request=h.requests[0],key='group-message:group-a';
  h.groups.states.delete(h.state.id);h.groups.epoch++;const next=h.groups.state(h.state.id);h.groups.current=next;next.group={role:'member',canSend:true};next.draftBody='重新入群后正在编辑';next.composerRevision++;
  next.outbox=[{...h.state.outbox[0],status:'failed'},{body:'另一条未确认消息',mutationId:'other-message',status:'failed'}];h.groups.persist(next);
  request.pending.resolve(h.ack(request));await sent;
  const last=h.saved.filter(row=>row.key===key).at(-1).value;
  assert.equal(next.draftBody,'重新入群后正在编辑');assert.equal(last.body,'重新入群后正在编辑');assert.deepEqual(next.outbox.map(row=>row.mutationId),['other-message']);assert.deepEqual(last.outbox.map(row=>row.mutationId),['other-message']);assert.equal(next.items.length,0);
});

test('a failed send from a retired group state cannot overwrite a newly saved group draft',async()=>{
  const h=harness(),sent=h.groups.send();h.groups.states.delete(h.state.id);h.groups.epoch++;const next=h.groups.state(h.state.id);h.groups.current=next;next.group={role:'member',canSend:true};next.draftBody='新的群草稿';next.composerRevision++;h.groups.persist(next);const savedBefore=h.saved.length;
  h.requests[0].pending.reject(new Error('旧请求失败'));await sent;
  assert.equal(h.saved.length,savedBefore);assert.equal(h.owner.readLocal('group-message:group-a').body,'新的群草稿');assert.equal(next.draftBody,'新的群草稿');
});

test('a confirmed retired send only clears its own pending entry even before a replacement group state exists',async()=>{
  const h=harness(),sent=h.groups.send(),key='group-message:group-a';h.groups.states.delete(h.state.id);h.groups.current=null;h.groups.epoch++;
  h.owner.saveLocal(key,{body:'保留的离群草稿',outbox:[{...h.state.outbox[0]},{body:'其他未发送文字',mutationId:'other-message'}]});
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sent;const stored=h.owner.readLocal(key);
  assert.equal(stored.body,'保留的离群草稿');assert.deepEqual(stored.outbox.map(row=>row.mutationId),['other-message']);
});

test('muted members and ordinary members attempting all-member reminders cannot issue a group send',async()=>{
  const h=harness();h.state.group.canSend=false;await h.groups.send();assert.equal(h.requests.length,0);
  h.state.group.canSend=true;h.state.mentionAll=true;await h.groups.send();assert.equal(h.requests.length,0);assert.match(h.notices[0][0],/只有群主和管理员/);
});

test('displaying a later own message still marks the latest visible received mention as read',async t=>{
  globals(t,{document:{hidden:false},CSS:{escape:value=>value}});const owner={accountId:'reader',getUser:()=>({id:'reader'}),alive:()=>true,refreshMessageUnread:async()=>{},api:{get:async()=>({unreadCount:0,invitationCount:0}),write:async(path,method,body)=>{requests.push(body);return {unreadCount:0,groupUnreadCount:0,groupMentionUnreadCount:0};}},page:()=>({querySelector:()=>({getBoundingClientRect:()=>({top:0,bottom:200}),querySelector:()=>({getBoundingClientRect:()=>({bottom:120})})})})},requests=[];
  const groups=new CommunityGroups(owner),state={id:'group-a',items:[{id:'received',senderId:'friend'},{id:'own',senderId:'reader'}]};groups.current=state;groups.stateAlive=candidate=>candidate===state;groups.renderInvitationBadge=()=>{};groups.renderList=()=>{};
  await groups.markRead(state);assert.deepEqual(requests,[{lastMessageId:'received'}]);assert.equal(state.readId,'received');assert.equal(owner.messageReadRevision,1);
});

test('leaving an unused group controller and non-group change events do not affect unrelated forms',()=>{
  const h=harness();h.groups.current=null;assert.doesNotThrow(()=>h.groups.leave());assert.equal(h.groups.change({closest:()=>({dataset:{cmForm:'report'}})}),false);
});

test('a delayed private read acknowledgement cannot restore a group unread count already cleared',async t=>{
  globals(t,{document:{hidden:false},CSS:{escape:value=>value}});const pending=deferred(),badgeValues=[];
  const controller=new CommunityController({getUser:()=>({id:'reader'}),api:()=>{},toast:()=>{}}),state={id:'private-a',conversation:{unreadCount:1},items:[{id:'private-message',senderId:'friend'}]};
  controller.chat=state;controller.chatAlive=candidate=>candidate===state;controller.isMounted=()=>true;controller.setMessageUnread=value=>badgeValues.push(value);
  controller.page=()=>({querySelector:()=>({getBoundingClientRect:()=>({top:0,bottom:200}),querySelector:()=>({getBoundingClientRect:()=>({bottom:120})})})});
  controller.api={write:()=>pending.promise,get:async()=>({unreadCount:0})};
  const marking=controller.markChatRead();controller.messageReadRevision++;controller.setMessageUnread(0);
  pending.resolve({unreadCount:1,conversationUnreadCount:0});await marking;
  assert.deepEqual(badgeValues,[0,0]);assert.equal(state.readMessageId,'private-message');assert.equal(state.conversation.unreadCount,0);
});
