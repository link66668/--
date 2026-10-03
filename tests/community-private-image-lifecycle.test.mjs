import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityController} from '../public/community.js';
import {CommunityImageComposer} from '../public/community-images.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const image=id=>({id,type:'image/png',url:'/api/community/media/'+id});

function harness() {
  let user={id:'reader'};const requests=[],storage=new Map(),saves=[],button={},count={},error={hidden:true},list={scrollHeight:100,clientHeight:100,scrollTop:0};
  const form={dataset:{cmForm:'message'},elements:{body:{name:'body',value:''}},querySelector:selector=>selector==='[type=submit]'?button:selector==='.cm-message-input-count'?count:error};
  const controller=new CommunityController({getUser:()=>user,api:()=>{},toast:()=>{}});controller.isMounted=()=>true;controller.rememberInbox=()=>{};controller.renderChatMessages=()=>{};controller.markChatRead=async()=>{};
  controller.saveLocal=(key,value)=>{storage.set(key,structuredClone(value));saves.push({key,value:structuredClone(value)});};controller.readLocal=(key,fallback={})=>structuredClone(storage.get(key)??fallback);controller.page=()=>({querySelector:selector=>selector==='[data-cm-form="message"]'?form:list});
  controller.api.write=(path,method,body)=>{const pending=deferred();requests.push({path,method,body,pending});return pending.promise;};
  function open(id,body,images) {
    const draft=controller.readLocal('message:'+id,{}),state={id,token:controller.routeToken,conversation:{peer:{id:'friend'}},items:[],outbox:(draft.outbox||[]).map(row=>({...row,status:'failed'})),draftBody:body??draft.body??'',draftImages:images??draft.images??[],composerRevision:draft.composerRevision||0};
    controller.chat=state;controller.chatStates.set(id,state);form.elements.body.value=state.draftBody;
    state.imageComposer=new CommunityImageComposer({api:controller.api,images:state.draftImages,isAlive:()=>controller.chatAlive(state),onChange:()=>{if(!state.clearingSentImages)state.composerRevision=(state.composerRevision||0)+1;controller.updateMessageComposer();}});controller.updateMessageComposer();return state;
  }
  const type=body=>{form.elements.body.value=body;controller.input({target:{name:'body',value:body,closest:()=>form}});};
  const addImage=(state,id)=>{state.imageComposer.assets.push({key:id,media:image(id),status:'ready'});state.imageComposer.changed();};
  const ack=request=>({message:{id:'message-'+request.body.clientMutationId,senderId:'reader',body:request.body.body,images:request.body.imageIds.map(image),clientMutationId:request.body.clientMutationId,sequence:requests.length}});
  return {controller,requests,storage,saves,form,open,type,addImage,ack,switchAccount:()=>{user={id:'other'};}};
}

test('editing private text and changing it back while sending preserves that new draft after the image receipt',async()=>{
  const h=harness(),state=h.open('a','原文',[image('sent')]),sending=h.controller.sendMessage();h.type('临时修改');h.type('原文');const revision=state.composerRevision;
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;
  assert.equal(h.form.elements.body.value,'原文');assert.equal(state.draftBody,'原文');assert.equal(state.composerRevision,revision);assert.equal(state.outbox.length,0);assert.deepEqual(h.controller.chatImages(state),[]);assert.equal(h.storage.get('message:a').body,'原文');assert.equal(h.storage.get('message:a').composerRevision,revision);
});

test('adding a new picture preserves unchanged text while only the previously sent picture is cleared',async()=>{
  const h=harness(),state=h.open('a','图片说明',[image('sent')]),sending=h.controller.sendMessage();h.addImage(state,'next');const revision=state.composerRevision;
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;
  assert.equal(state.draftBody,'图片说明');assert.equal(h.form.elements.body.value,'图片说明');assert.deepEqual(h.controller.chatImages(state).map(row=>row.id),['next']);assert.equal(state.composerRevision,revision);assert.deepEqual(h.storage.get('message:a').images.map(row=>row.id),['next']);
});

test('unchanged private sends clear text and pictures without advancing the user input revision',async()=>{
  const h=harness(),state=h.open('a','完整发送',[image('sent')]);h.type('完整发送');const revision=state.composerRevision,sending=h.controller.sendMessage();h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;
  assert.equal(state.draftBody,'');assert.equal(h.form.elements.body.value,'');assert.equal(state.composerRevision,revision);assert.deepEqual(h.storage.get('message:a').images,[]);
});

test('a retired private receipt after reopening A and leaving for B cannot replace the newer A draft',async()=>{
  const h=harness(),old=h.open('a','旧发送',[image('sent')]),sending=h.controller.sendMessage();h.controller.leaveChat();const latest=h.open('a');h.type('新A草稿');h.addImage(latest,'next');latest.outbox.push({body:'其他待发',images:[image('other')],mutationId:'other',status:'failed'});h.controller.persistChat();const revision=latest.composerRevision;h.controller.leaveChat();h.open('b','B草稿',[image('b')]);
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;
  const saved=h.storage.get('message:a');assert.equal(saved.body,'新A草稿');assert.equal(saved.composerRevision,revision);assert.deepEqual(saved.images.map(row=>row.id),['next']);assert.deepEqual(saved.outbox.map(row=>row.mutationId),['other']);assert.equal(h.controller.chat.draftBody,'B草稿');assert.equal(old.imageComposer,null);
});

test('a failure from the old A state cannot persist over a newly edited A draft after it is left',async()=>{
  const h=harness();h.open('a','旧发送',[image('sent')]);const sending=h.controller.sendMessage();h.controller.leaveChat();h.open('a');h.type('新草稿');h.controller.leaveChat();h.open('b','B草稿');const saved=structuredClone(h.storage.get('message:a')),count=h.saves.length;
  h.requests[0].pending.reject(new Error('旧请求超时'));await sending;assert.deepEqual(h.storage.get('message:a'),saved);assert.equal(h.saves.length,count);assert.equal(h.controller.chat.draftBody,'B草稿');
});

test('retired receipts with no state map entry merge only their own IDs into the current saved draft',async()=>{
  const h=harness();h.open('a','旧发送',[image('sent')]);const sending=h.controller.sendMessage(),mutation=h.requests[0].body.clientMutationId;h.controller.leaveChat();h.controller.chatStates.delete('a');h.storage.set('message:a',{body:'另存的新稿',images:[image('sent'),image('next')],composerRevision:7,outbox:[{body:'旧发送',images:[image('sent')],mutationId:mutation},{body:'另一条',images:[],mutationId:'other'}]});h.open('b','B草稿');
  h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;
  const saved=h.storage.get('message:a');assert.equal(saved.body,'另存的新稿');assert.equal(saved.composerRevision,7);assert.deepEqual(saved.images.map(row=>row.id),['next']);assert.deepEqual(saved.outbox.map(row=>row.mutationId),['other']);
});

test('restored draft revisions stop a poll confirmation from erasing text edited before reopening',async()=>{
  const h=harness();h.open('a','原文',[image('sent')]);const sending=h.controller.sendMessage();h.type('改过');h.type('原文');h.controller.leaveChat();const restored=h.open('a');h.controller.mergeMessages(restored,[h.ack(h.requests[0]).message]);
  assert.equal(restored.draftBody,'原文');assert.equal(h.form.elements.body.value,'原文');assert.deepEqual(h.controller.chatImages(restored),[]);assert.equal(restored.outbox.length,0);h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;assert.equal(h.storage.get('message:a').body,'原文');
});

test('failed image-only private retries retain the same payload and mutation while a new body is being drafted',async()=>{
  const h=harness(),state=h.open('a','',[image('sent')]);let sending=h.controller.sendMessage();h.requests[0].pending.reject(new Error('网络中断'));await sending;assert.equal(state.outbox[0].status,'failed');h.type('下一条文字');sending=h.controller.sendMessage(h.requests[0].body.clientMutationId);
  assert.equal(h.requests[1].body.body,'');assert.deepEqual(h.requests[1].body.imageIds,['sent']);assert.equal(h.requests[1].body.clientMutationId,h.requests[0].body.clientMutationId);h.requests[1].pending.resolve(h.ack(h.requests[1]));await sending;assert.equal(state.draftBody,'下一条文字');assert.deepEqual(h.controller.chatImages(state),[]);
});

test('a late private image receipt after switching accounts cannot write any old account cache',async()=>{
  const h=harness(),state=h.open('a','旧账号',[image('sent')]),sending=h.controller.sendMessage();h.switchAccount();const count=h.saves.length;h.requests[0].pending.resolve(h.ack(h.requests[0]));await sending;assert.equal(h.saves.length,count);assert.equal(state.items.length,0);
});

test('explicitly retrying an older picture preserves the same text attached to a different new picture',async()=>{
  const h=harness(),state=h.open('a','图片说明',[image('old')]);let sending=h.controller.sendMessage();h.requests[0].pending.reject(new Error('网络中断'));await sending;state.imageComposer.remove('old');h.addImage(state,'new');sending=h.controller.sendMessage(h.requests[0].body.clientMutationId);
  assert.deepEqual(h.requests[1].body.imageIds,['old']);h.requests[1].pending.resolve(h.ack(h.requests[1]));await sending;assert.equal(state.draftBody,'图片说明');assert.equal(h.form.elements.body.value,'图片说明');assert.deepEqual(h.controller.chatImages(state).map(row=>row.id),['new']);
});
