import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityGroups} from '../public/community-groups.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const image=id=>({id,type:'image/png',url:'/api/community/media/'+id,originalName:id+'.png',width:32,height:32});
const file=()=>Object.assign(new Blob(['fixture'],{type:'image/png'}),{name:'fixture.png'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness(images=[]) {
  let user={id:'reader',nickname:'读者'};const storage=new Map(),writes=[],uploads=[],saved=[],notices=[],sendButton={},atButton={},status={},chips={},error={hidden:true},list={scrollHeight:100,clientHeight:100,scrollTop:0};
  const form={dataset:{cmForm:'group-message'},elements:{body:{name:'body',value:''}},querySelector:selector=>selector==='.cm-group-send'?sendButton:selector==='.cm-group-at'?atButton:selector==='.cm-group-compose-status'?status:chips};
  const owner={accountId:'reader',getUser:()=>user,alive:()=>true,readLocal:(key,fallback={})=>structuredClone(storage.get(key)??fallback),saveLocal:(key,value)=>{storage.set(key,structuredClone(value));saved.push({key,value:structuredClone(value)});},toast:(...args)=>notices.push(args),api:{write:(path,method,body)=>{const pending=deferred();writes.push({path,method,body,pending});return pending.promise;},upload:(value,options)=>{const pending=deferred();uploads.push({file:value,options,pending});return pending.promise;}},page:()=>({querySelector:selector=>selector==='[data-cm-form="group-message"]'?form:selector==='.cm-group-compose-error'?error:list})};
  const groups=new CommunityGroups(owner),state=groups.state('group-a');groups.current=state;state.group={role:'member',canSend:true};state.draftImages=images.map(row=>({...row}));
  groups.stateAlive=(candidate=groups.current)=>groups.alive()&&candidate===groups.current;groups.renderMessages=()=>{};groups.markRead=async()=>{};groups.refreshGroup=async()=>{};groups.resize=()=>{};
  const slot={isConnected:false,classList:{add(){}},addEventListener(){},removeEventListener(){},closest:()=>({addEventListener(){},removeEventListener(){}})};
  const mount=()=>groups.mountImages(state,slot);
  const ack=request=>({message:{id:'message-'+request.body.clientMutationId,senderId:'reader',body:request.body.body,images:request.body.imageIds.map(image),clientMutationId:request.body.clientMutationId,mentionUserIds:request.body.mentionUserIds,mentionAll:request.body.mentionAll,sequence:writes.length}});
  const input=body=>{form.elements.body.value=body;groups.input({name:'body',value:body,closest:()=>form});};
  return {groups,state,owner,storage,writes,uploads,saved,notices,form,sendButton,atButton,status,slot,mount,ack,input,switchAccount:()=>{user={id:'other'};}};
}

test('an image-only group message sends ordered image IDs and clears only its confirmed draft attachments',async()=>{
  const h=harness([image('one'),image('two')]);h.mount();h.groups.updateComposer();assert.equal(h.sendButton.disabled,false);
  const sending=h.groups.send(),request=h.writes[0];assert.equal(request.body.body,'');assert.deepEqual(request.body.imageIds,['one','two']);
  request.pending.resolve(h.ack(request));await sending;
  assert.equal(h.state.items.length,1);assert.deepEqual(h.state.items[0].images.map(row=>row.id),['one','two']);assert.equal(h.state.outbox.length,0);assert.deepEqual(h.groups.images(),[]);assert.deepEqual(h.storage.get('group-message:group-a').images,[]);
  const markup=h.groups.messageMarkup(h.state.items[0]);assert.match(markup,/data-cm="images-view"/);assert.doesNotMatch(markup,/class="cm-group-bubble"/);
});

test('a send receipt preserves text and a new image that is still uploading, including its later draft save',async()=>{
  const h=harness([image('sent')]);h.mount();h.input('第一条');const sending=h.groups.send();h.input('第二条');
  h.state.imageComposer.add([file()]);assert.equal(h.uploads.length,1);assert.equal(h.state.imageComposer.busy,true);assert.equal(h.uploads[0].options.purpose,'attachment');
  h.writes[0].pending.resolve(h.ack(h.writes[0]));await sending;
  assert.equal(h.state.draftBody,'第二条');assert.equal(h.form.elements.body.value,'第二条');assert.equal(h.state.imageComposer.assets.length,1);assert.equal(h.state.imageComposer.busy,true);
  h.uploads[0].pending.resolve(image('new'));await tick();
  assert.deepEqual(h.groups.images().map(row=>row.id),['new']);assert.equal(h.storage.get('group-message:group-a').body,'第二条');assert.deepEqual(h.storage.get('group-message:group-a').images.map(row=>row.id),['new']);
  h.groups.destroy();
});

test('failed image sends retain their draft and reuse the same mutation for unchanged retries',async()=>{
  const h=harness([image('one')]);h.mount();h.input('图片说明');let sending=h.groups.send();h.writes[0].pending.reject(new Error('网络中断'));await sending;
  assert.equal(h.state.draftBody,'图片说明');assert.deepEqual(h.groups.images().map(row=>row.id),['one']);assert.equal(h.state.outbox[0].status,'failed');
  sending=h.groups.send();assert.equal(h.writes[1].body.clientMutationId,h.writes[0].body.clientMutationId);assert.deepEqual(h.writes[1].body.imageIds,['one']);h.writes[1].pending.resolve(h.ack(h.writes[1]));await sending;
  assert.equal(h.state.draftBody,'');assert.deepEqual(h.groups.images(),[]);
});

test('editing the picture selection creates a new mutation while explicit retries keep their original image-only body',async()=>{
  const h=harness([image('one')]);let sending=h.groups.send();h.writes[0].pending.reject(new Error('网络中断'));await sending;
  h.state.draftImages=[image('two')];h.state.composerRevision++;sending=h.groups.send();assert.notEqual(h.writes[1].body.clientMutationId,h.writes[0].body.clientMutationId);assert.deepEqual(h.writes[1].body.imageIds,['two']);h.writes[1].pending.reject(new Error('仍然断网'));await sending;
  h.input('另写的新文字');sending=h.groups.send(h.writes[0].body.clientMutationId);assert.equal(h.writes[2].body.body,'');assert.deepEqual(h.writes[2].body.imageIds,['one']);assert.equal(h.writes[2].body.clientMutationId,h.writes[0].body.clientMutationId);h.writes[2].pending.resolve(h.ack(h.writes[2]));await sending;
  assert.equal(h.state.draftBody,'另写的新文字');assert.deepEqual(h.groups.images().map(row=>row.id),['two']);
});

test('uploading or failed images block the normal send, while a mute disables upload controls without losing pictures',async()=>{
  const h=harness();h.mount();h.input('文字');h.state.imageComposer.add([file()]);h.groups.updateComposer();assert.equal(h.sendButton.disabled,true);await h.groups.send();assert.equal(h.writes.length,0);
  h.uploads[0].pending.reject(new Error('图片上传失败'));await tick();assert.equal(h.state.imageComposer.failed,true);assert.equal(h.sendButton.disabled,true);assert.match(h.status.textContent,/重试或移除/);await h.groups.send();assert.equal(h.writes.length,0);
  const key=h.state.imageComposer.assets[0].key;const retry=h.state.imageComposer.upload(key);h.uploads[1].pending.resolve(image('ready'));await retry;
  h.state.group.canSend=false;h.state.group.muted=true;h.groups.updateComposer();assert.equal(h.state.imageComposer.disabled,true);assert.equal(h.sendButton.disabled,true);await h.groups.send();assert.equal(h.writes.length,0);assert.deepEqual(h.groups.images().map(row=>row.id),['ready']);
  h.state.group.canSend=true;h.state.group.muted=false;h.groups.updateComposer();assert.equal(h.state.imageComposer.disabled,false);assert.equal(h.sendButton.disabled,false);h.groups.destroy();
});

test('a late upload after changing groups saves only its original group draft',async()=>{
  const h=harness();h.mount();h.input('A群草稿');h.state.imageComposer.add([file()]);const next=h.groups.state('group-b');next.group={role:'member',canSend:true};next.draftBody='B群草稿';h.groups.current=next;h.groups.persist(next);
  h.uploads[0].pending.resolve(image('a-image'));await tick();
  assert.equal(next.draftBody,'B群草稿');assert.deepEqual(h.groups.images(next),[]);assert.equal(h.storage.get('group-message:group-b').body,'B群草稿');assert.equal(h.storage.get('group-message:group-a').body,'A群草稿');assert.deepEqual(h.storage.get('group-message:group-a').images.map(row=>row.id),['a-image']);h.groups.destroy();
});

test('account destruction aborts uploads and ignores both late image and message receipts',async()=>{
  const h=harness([image('old')]);h.mount();const sending=h.groups.send();h.state.imageComposer.add([file()]);const upload=h.uploads[0];h.switchAccount();h.groups.destroy();const saves=h.saved.length;
  assert.equal(upload.options.signal.aborted,true);upload.pending.resolve(image('late'));h.writes[0].pending.resolve(h.ack(h.writes[0]));await sending;await tick();assert.equal(h.saved.length,saves);assert.equal(h.state.items.length,0);
});

test('a retired send receipt preserves a replacement draft and clears only confirmed image IDs',async()=>{
  const h=harness([image('old')]);const sending=h.groups.send();h.groups.states.delete(h.state.id);h.groups.epoch++;const next=h.groups.state(h.state.id);next.group={role:'member',canSend:true};next.draftBody='重新入群的草稿';next.draftImages=[image('old'),image('new')];next.composerRevision++;h.groups.current=next;h.groups.persist(next);
  h.writes[0].pending.resolve(h.ack(h.writes[0]));await sending;
  assert.equal(next.draftBody,'重新入群的草稿');assert.deepEqual(next.draftImages.map(row=>row.id),['new']);assert.equal(next.outbox.length,0);assert.equal(next.items.length,0);assert.deepEqual(h.storage.get('group-message:group-a').images.map(row=>row.id),['new']);
});

test('poll-confirmed messages clear accepted pictures without changing a new draft or its input revision',async()=>{
  const h=harness([image('one')]);h.mount();const sending=h.groups.send();h.input('新文字');h.state.imageComposer.assets.push({key:'new-key',media:image('two'),status:'ready'});h.state.imageComposer.changed();const revision=h.state.composerRevision;
  h.groups.merge(h.state,[h.ack(h.writes[0]).message]);assert.deepEqual(h.groups.images().map(row=>row.id),['two']);assert.equal(h.state.draftBody,'新文字');assert.equal(h.state.composerRevision,revision);
  h.writes[0].pending.reject(new Error('回执超时'));await sending;assert.equal(h.state.outbox.length,0);assert.deepEqual(h.storage.get('group-message:group-a').images.map(row=>row.id),['two']);
});

test('file input events cannot overwrite the group message body',()=>{
  const h=harness();h.input('保留这段文字');const revision=h.state.composerRevision;
  assert.equal(h.groups.input({name:'',type:'file',value:'C:\\fakepath\\photo.png',closest:()=>h.form}),true);assert.equal(h.state.draftBody,'保留这段文字');assert.equal(h.state.composerRevision,revision);
});
