import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityImageComposer,communityImagesMarkup} from '../public/community-images.js';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const image=id=>({id,type:'image/png',width:10,height:10,url:'https://example.invalid/ignored'});
const file=()=>new File(['bytes'],'photo.png',{type:'image/png'});

test('image upload uses the private attachment purpose and a late result after disposal cannot revive the draft',async()=>{
  const response=deferred();let options,changes=0;const composer=new CommunityImageComposer({api:{upload:(value,config)=>{options=config;return response.promise;}},onChange:()=>changes++});
  composer.add([file()]);assert.equal(options.purpose,'attachment');assert(composer.busy);const before=changes;composer.dispose();assert(options.signal.aborted);response.resolve(image('late'));await tick();assert.deepEqual(composer.snapshot(),[]);assert.equal(changes,before);
});

test('failed uploads remain in the composer and retry the same file before becoming sendable',async()=>{
  let attempts=0;const composer=new CommunityImageComposer({api:{upload:async()=>{if(++attempts===1)throw Error('offline');return image('ready');}}});
  composer.add([file()]);await tick();assert(composer.failed);assert(composer.hasImages);assert.deepEqual(composer.images,[]);await composer.upload(composer.assets[0].key);assert(!composer.failed);assert.equal(composer.snapshot()[0].id,'ready');composer.dispose();
});

test('removed or stale account uploads never attach their late response to another draft',async()=>{
  const first=deferred(),second=deferred();let alive=true,index=0;const composer=new CommunityImageComposer({api:{upload:()=>++index===1?first.promise:second.promise},isAlive:()=>alive});
  composer.add([file(),file()]);composer.remove(composer.assets[0].key);first.resolve(image('removed'));alive=false;second.resolve(image('old-account'));await tick();assert.deepEqual(composer.snapshot(),[]);composer.dispose();
});

test('selection enforces image type, nonempty size, per-file size and the nine-image limit',async()=>{
  const errors=[];const composer=new CommunityImageComposer({api:{upload:async()=>image(crypto.randomUUID())},onError:error=>errors.push(error.message)});
  composer.add([new File(['x'],'bad.gif',{type:'image/gif'}),new File([],'empty.png',{type:'image/png'}),new File([new Uint8Array(10*1024*1024+1)],'large.png',{type:'image/png'})]);assert.equal(composer.assets.length,0);assert.equal(errors.length,3);
  composer.add(Array.from({length:10},file));await tick();assert.equal(composer.images.length,9);assert.match(errors.at(-1),/9/);composer.dispose();
});

test('acknowledgements remove only submitted images and snapshots cannot mutate the composer',()=>{
  const composer=new CommunityImageComposer({api:{},images:[image('sent'),image('new')]});const saved=composer.snapshot();saved[0].id='tampered';composer.remove('sent');assert.deepEqual(composer.images.map(row=>row.id),['new']);composer.setDisabled(true);composer.add([file()]);assert.equal(composer.assets.length,1);composer.dispose();
});

test('attachment thumbnails escape metadata and always use the authorized same-origin media route',()=>{
  const markup=communityImagesMarkup([image('id"<script>')]);assert(!markup.includes('src="https://'));assert(!markup.includes('<script>'));assert(markup.includes('/api/community/media/id%22%3Cscript%3E'));assert(markup.includes('data-cm="images-view"'));assert.equal(communityImagesMarkup([{id:'video',type:'video/mp4'}]),'');
});

function commentFixture(images) {
  const controller=new CommunityController({getUser:()=>({id:'self'}),api:()=>{},toast:()=>{}}),button={disabled:false},form={elements:{body:{value:''}},classList:{toggle(){},remove(){}},querySelector:selector=>selector==='[type=submit]'?button:null};
  controller.detail={id:'note',note:{id:'note',commentCount:0},comments:[],imageComposer:{snapshot:()=>images.map(row=>({...row})),hasImages:!!images.length,busy:false,failed:false,remove:id=>{images.splice(images.findIndex(row=>row.id===id),1);controller.reviseCommentComposer();}}};
  controller.dialog={querySelector:()=>null};controller.renderComments=()=>{};controller.commentStatus=()=>{};controller.updateNote=()=>{};controller.error=error=>{throw error;};return {controller,form,button};
}

test('an image-only comment is sent and confirmed without requiring body text',async()=>{
  const images=[image('picture')],{controller,form}=commentFixture(images);let sent;controller.api.write=async(path,method,body)=>{sent=body;return {comment:{id:'comment',body:'',images:[image('picture')]},commentCount:1};};await controller.submitComment(form);assert.deepEqual(sent.imageIds,['picture']);assert.equal(sent.body,'');assert.equal(controller.detail.comments[0].images[0].id,'picture');assert.deepEqual(images,[]);
});

test('a comment confirmation preserves newly selected images and newly typed text',async()=>{
  const images=[image('first')],{controller,form}=commentFixture(images),response=deferred();form.elements.body.value='first body';controller.api.write=()=>response.promise;const sending=controller.submitComment(form);form.elements.body.value='next body';images.push(image('next'));controller.reviseCommentComposer();response.resolve({comment:{id:'posted'},commentCount:1});await sending;assert.equal(form.elements.body.value,'next body');assert.deepEqual(images.map(row=>row.id),['next']);
});

test('file input events cannot replace a comment text draft with a fake filesystem path',()=>{
  const {controller,form}=commentFixture([]);controller.commentDrafts.set('note','kept');controller.input({target:{name:'',value:'C:\\fakepath\\picture.png',closest:()=>({...form,dataset:{cmForm:'comment'}})}});assert.equal(controller.commentDrafts.get('note'),'kept');
});
