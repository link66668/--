import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const file={name:'avatar.png',type:'image/png',size:100};
const media=id=>({id,url:'/api/community/media/'+id});

function harness(t) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({})}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  let user={id:'self'};const uploads=[],writes=[],changes=[],errors=[],previews=[];
  const controller=new CommunityController({getUser:()=>user,api:()=>{},toast:()=>{},onProfileChange:profile=>changes.push(profile)});
  controller.error=error=>errors.push(error);controller.isOwnProfileRoute=()=>false;
  controller.api.upload=(file,options)=>{const pending=deferred();uploads.push({file,options,pending});return pending.promise;};
  controller.api.write=(path,method,body,signal)=>{const pending=deferred();writes.push({path,method,body,signal,pending});return pending.promise;};
  function open() {
    const button={disabled:false,isConnected:true},fileInput={disabled:false,isConnected:true},status={textContent:''},form={dataset:{cmForm:'profile'},elements:{nickname:{value:'  新昵称  '},bio:{value:'记录生活'},collectionsVisibility:{value:'private'}},querySelector:()=>button};
    const dialog={open:true,isConnected:true,querySelector:selector=>selector==='[data-cm-form="profile"]'?form:selector==='[type=submit]'?button:selector==='#cm-avatar-file'?fileInput:selector==='.cm-avatar-status'?status:selector==='.cm-profile-edit-avatar .cm-avatar'?{replaceWith:image=>previews.push(image.src)}:null,querySelectorAll:()=>[],removeEventListener:()=>{},close(){this.open=false;},remove(){this.isConnected=false;button.isConnected=false;fileInput.isConnected=false;}};
    const draft={id:'self',avatarMediaId:'previous',avatarUrl:media('previous').url,dialog,generation:controller.generation};
    controller.aux=dialog;controller.profileDraft=draft;return {button,fileInput,status,form,dialog,draft};
  }
  return {controller,uploads,writes,changes,errors,previews,open,switchAccount:()=>{user={id:'other'};}};
}

test('saved community profile notifies the owning account with the server-confirmed avatar',async t=>{
  const h=harness(t),state=h.open(),view={loaded:true};h.controller.views.set('mine',view);
  const saving=h.controller.saveProfile(state.form);
  assert.equal(state.button.disabled,true);assert.equal(state.fileInput.disabled,true);
  assert.deepEqual(h.writes[0].body,{nickname:'新昵称',bio:'记录生活',avatarMediaId:'previous',collectionsVisibility:'private'});
  const profile={id:'self',nickname:'新昵称',avatarUrl:media('confirmed').url};h.writes[0].pending.resolve({profile});await saving;
  assert.deepEqual(h.changes,[profile]);assert.equal(h.controller.ownProfile,profile);assert.equal(view.loaded,false);assert.equal(h.controller.aux,null);assert.equal(h.controller.controllers.size,0);
});

test('a replacement avatar upload owns progress, preview and save availability even when the old upload finishes late',async t=>{
  const h=harness(t),state=h.open(),first=h.controller.uploadAvatar(file),second=h.controller.uploadAvatar({...file,name:'new.png'});
  assert.equal(h.uploads[0].options.signal.aborted,true);assert.equal(h.uploads[1].options.purpose,'avatar');
  h.uploads[1].options.onProgress(45);h.uploads[0].options.onProgress(100);assert.equal(state.status.textContent,'上传中 45%');
  h.uploads[0].pending.resolve(media('old'));await first;assert.equal(state.button.disabled,true);assert.equal(state.draft.avatarMediaId,'previous');assert.deepEqual(h.previews,[]);
  await h.controller.saveProfile(state.form);assert.equal(h.writes.length,0);
  h.uploads[1].pending.resolve(media('latest'));await second;
  assert.equal(state.button.disabled,false);assert.equal(state.draft.avatarMediaId,'latest');assert.deepEqual(h.previews,[media('latest').url]);assert.equal(h.controller.controllers.size,0);
});

test('closing an avatar editor aborts uploads and ignores their late receipt after another editor opens',async t=>{
  const h=harness(t),old=h.open(),uploading=h.controller.uploadAvatar(file);h.controller.closeAux();const current=h.open();
  assert.equal(h.uploads[0].options.signal.aborted,true);h.uploads[0].options.onProgress(80);h.uploads[0].pending.resolve(media('retired'));await uploading;
  assert.equal(current.draft.avatarMediaId,'previous');assert.equal(current.status.textContent,'');assert.equal(old.draft.avatarMediaId,'previous');assert.deepEqual(h.previews,[]);assert.deepEqual(h.errors,[]);
});

test('saving freezes avatar replacement and duplicate submissions, then restores controls after failure',async t=>{
  const h=harness(t),state=h.open(),saving=h.controller.saveProfile(state.form);
  await h.controller.uploadAvatar(file);await h.controller.saveProfile(state.form);assert.equal(h.uploads.length,0);assert.equal(h.writes.length,1);
  h.writes[0].pending.reject(new Error('网络中断'));await saving;
  assert.equal(state.fileInput.disabled,false);assert.equal(state.button.disabled,false);assert.equal(state.draft.saving,false);assert.equal(h.changes.length,0);assert.equal(h.errors[0].message,'网络中断');
  const retry=h.controller.saveProfile(state.form);h.writes[1].pending.resolve({id:'self',avatarUrl:media('retry').url});await retry;assert.equal(h.changes.length,1);
});

for(const switchAccount of [false,true]){
  test(switchAccount?'a late profile save cannot notify another account':'a late profile save cannot close a replacement editor',async t=>{
    const h=harness(t),old=h.open(),saving=h.controller.saveProfile(old.form);let current;
    if(switchAccount)h.switchAccount();else{h.controller.closeAux();current=h.open();assert.equal(h.writes[0].signal.aborted,true);}
    h.writes[0].pending.resolve({id:'self',avatarUrl:media('retired').url});await saving;
    assert.equal(h.changes.length,0);assert.equal(h.controller.ownProfile,undefined);if(current){assert.equal(h.controller.aux,current.dialog);assert.equal(current.dialog.open,true);}
  });
}

test('a profile loaded after leaving the route cannot reopen its old editor',async t=>{
  const h=harness(t),pending=deferred();let opened=false;h.controller.api.get=()=>pending.promise;h.controller.showAux=()=>{opened=true;};
  const editing=h.controller.editProfile();h.controller.routeToken++;pending.resolve({id:'self'});await editing;assert.equal(opened,false);
});
