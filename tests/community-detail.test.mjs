import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const reply=index=>({id:'r'+index,parentId:'parent',body:'回复正文 '+index,author:{id:'author'+index,nickname:'回复者 '+index},createdAt:index*1000});
const visibleReplies=html=>(html.match(/class="cm-comment cm-reply"/g)||[]).length;
function globals(t,values) {for(const [name,value]of Object.entries(values)){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});}}
function controller() {const value=new CommunityController({getUser:()=>({id:'reader'}),api:()=>{},toast:()=>{}});value.error=()=>{};return value;}
function repliesFixture(total=5) {
  const value=controller(),parent={id:'parent',body:'顶层评论',author:{id:'writer',nickname:'作者'},replyCount:total,replies:[reply(1),reply(2)].slice(0,total)};
  value.detail={id:'note',note:{id:'note',author:{id:'writer'},commentCount:total+1},comments:[parent],replyPages:new Map(),replyStates:new Map(),hasMore:false};value.renderComments=()=>{};value.commentStatus=()=>{};value.updateNote=()=>{};
  return {value,parent};
}

test('a thread initially shows one reply with the remaining count and accessible expansion controls',()=>{
  const {value,parent}=repliesFixture(5),html=value.commentMarkup(parent);
  assert.equal(visibleReplies(html),1);assert.match(html,/展开 4 条回复/);assert.match(html,/id="cm-replies-parent"/);assert.match(html,/data-cm="replies-expand"[^>]*aria-controls="cm-replies-parent"[^>]*aria-expanded="false"/);
  assert.match(html,/<div class="cm-comment-main"><button class="cm-comment-more cm-icon-button"/);assert.doesNotMatch(html.split('class="cm-comment-controls"')[1].split('</div>')[0],/comment-more/);
  assert.match(html,/aria-label="回复更多操作" aria-haspopup="menu"/);
});

test('expanding and collapsing a fully cached thread never requests its replies again',async()=>{
  const {value,parent}=repliesFixture(2);let requests=0;value.api.get=async()=>{requests++;throw new Error('cache should be sufficient');};
  await value.expandReplies('parent');assert.equal(visibleReplies(value.commentMarkup(parent)),2);assert.match(value.commentMarkup(parent),/收起回复/);
  value.collapseReplies('parent');assert.equal(visibleReplies(value.commentMarkup(parent)),1);await value.expandReplies('parent');assert.equal(visibleReplies(value.commentMarkup(parent)),2);assert.equal(requests,0);
});

test('reply pagination merges previews without duplicates, keeps its cursor, and re-expansion preserves the loaded range',async()=>{
  const {value,parent}=repliesFixture(5),queries=[];value.api.get=async(path,params)=>{queries.push(params);return queries.length===1?{items:[reply(1),reply(2),reply(3)],nextCursor:'page-2',hasMore:true}:{items:[reply(4),reply(5)],hasMore:false};};
  await value.expandReplies('parent');assert.equal(visibleReplies(value.commentMarkup(parent)),3);assert.match(value.commentMarkup(parent),/展开剩余 2 条回复/);
  value.collapseReplies('parent');await value.expandReplies('parent');assert.equal(queries.length,1);assert.equal(visibleReplies(value.commentMarkup(parent)),3);
  await value.loadReplies('parent');assert.equal(queries[1].cursor,'page-2');assert.deepEqual(parent.replies.map(row=>row.id),['r1','r2','r3','r4','r5']);assert.equal(visibleReplies(value.commentMarkup(parent)),5);assert.doesNotMatch(value.commentMarkup(parent),/data-cm="replies-more"/);
});

test('collapsing a thread during loading keeps it collapsed when that response arrives',async()=>{
  const {value,parent}=repliesFixture(5),response=deferred();value.api.get=()=>response.promise;
  const loading=value.expandReplies('parent');assert.match(value.commentMarkup(parent),/data-cm="replies-more"[^>]*disabled aria-busy="true"/);value.collapseReplies('parent');response.resolve({items:[reply(1),reply(2),reply(3),reply(4),reply(5)],hasMore:false});await loading;
  assert.equal(value.replyState('parent').expanded,false);assert.equal(parent.replies.length,5);assert.equal(visibleReplies(value.commentMarkup(parent)),1);
});

test('reopening a detail does not inherit the busy state or response of an old reply request',async()=>{
  const {value}=repliesFixture(3),old=deferred(),queries=[];value.api.get=async(path,params)=>{queries.push(params);return queries.length===1?old.promise:{items:[reply(1),reply(2),reply(3)],hasMore:false};};
  const oldDetail=value.detail,loadingOld=value.expandReplies('parent');assert.equal(oldDetail.replyStates.get('parent').loading,true);
  const parent={id:'parent',body:'重新打开',author:{id:'writer'},replyCount:3,replies:[reply(1),reply(2)]};value.detail={...oldDetail,comments:[parent],replyPages:new Map(),replyStates:new Map()};await value.expandReplies('parent');
  assert.equal(queries.length,2);assert.equal(parent.replies.length,3);assert.equal(value.replyState('parent').loading,false);assert.doesNotMatch(value.commentMarkup(parent),/正在加载回复/);
  old.resolve({items:[reply(99)],hasMore:false});await loadingOld;assert.equal(parent.replies.length,3);assert.equal(oldDetail.replyStates.get('parent').loading,false);assert.doesNotMatch(value.commentMarkup(parent),/回复正文 99/);
});

test('failed reply loading retains the preview and retries the same page',async()=>{
  const {value,parent}=repliesFixture(3),queries=[];value.api.get=async(path,params)=>{queries.push(params);if(queries.length===1)throw new Error('网络中断');return {items:[reply(1),reply(2),reply(3)],hasMore:false};};
  await value.expandReplies('parent');assert.equal(parent.replies.length,2);assert.match(value.commentMarkup(parent),/重新加载回复/);assert.match(value.commentMarkup(parent),/网络中断/);
  await value.loadReplies('parent');assert.equal(queries[0].cursor,queries[1].cursor);assert.equal(parent.replies.length,3);assert.doesNotMatch(value.commentMarkup(parent),/网络中断/);
});

test('reloading comment sort keeps a thread cache and its chosen expanded state',async()=>{
  const {value,parent}=repliesFixture(5);value.mergeReplies(parent,[reply(3),reply(4),reply(5)]);value.replyState('parent').expanded=true;
  value.api.get=async()=>({items:[{...parent,replies:[reply(1),reply(2)]}],hasMore:false});await value.loadComments(true);
  const refreshed=value.detail.comments[0];assert.equal(refreshed.replies.length,5);assert.equal(value.replyState('parent').expanded,true);assert.equal(visibleReplies(value.commentMarkup(refreshed)),5);
});

test('a completed reply cache reopens pagination when a refreshed comment has new replies beyond its preview',async()=>{
  const {value,parent}=repliesFixture(3);value.mergeReplies(parent,[reply(3)]);value.replyState('parent').expandedOnce=true;value.detail.replyPages.set('parent',{hasMore:false});const queries=[];
  value.api.get=async(path,params)=>{queries.push({path,...params});if(path.endsWith('/comments'))return {items:[{...parent,replyCount:5,replies:[reply(1),reply(2)]}],hasMore:false};return params.cursor?{items:[reply(3),reply(4),reply(5)],hasMore:false}:{items:[reply(1),reply(2)],nextCursor:'fresh-page-2',hasMore:true};};
  await value.loadComments(true);const refreshed=value.detail.comments[0];assert.equal(refreshed.replies.length,3);assert.equal(value.detail.replyPages.has('parent'),false);assert.equal(value.hasMoreReplies(refreshed),true);
  await value.expandReplies('parent');assert.deepEqual(refreshed.replies.map(row=>row.id),['r1','r2','r3','r4','r5']);assert.equal(queries[1].cursor,undefined);assert.equal(queries[2].cursor,'fresh-page-2');assert.equal(value.replyState('parent').loading,false);
});

test('a reply page that reports newer unseen replies keeps loading available even when the comment count is stale',async()=>{
  const {value,parent}=repliesFixture(3),queries=[];value.api.get=async(path,params)=>{queries.push(params);return queries.length===1?{items:Array.from({length:20},(_,i)=>reply(i+1)),nextCursor:'newer-page',hasMore:true}:{items:[reply(21),reply(22)],hasMore:false};};
  await value.expandReplies('parent');assert.equal(parent.replyCount,3);assert.equal(parent.replies.length,20);assert.equal(value.hasMoreReplies(parent),true);assert.match(value.commentMarkup(parent),/展开更多回复/);assert.doesNotMatch(value.commentMarkup(parent),/剩余 0 条/);
  await value.loadReplies('parent');assert.equal(queries[1].cursor,'newer-page');assert.equal(parent.replies.length,22);assert.equal(value.hasMoreReplies(parent),false);
});

test('a late completed reply page cannot hide new replies counted by a newer comment refresh',async()=>{
  const {value,parent}=repliesFixture(3),old=deferred(),queries=[];value.api.get=async(path,params)=>{queries.push({path,...params});if(queries.length===1)return old.promise;if(path.endsWith('/comments'))return {items:[{...parent,replyCount:4,replies:[reply(1),reply(2)]}],hasMore:false};return {items:[reply(1),reply(2),reply(3),reply(4)],hasMore:false};};
  const loading=value.expandReplies('parent');await value.loadComments(true);old.resolve({items:[reply(1),reply(2),reply(3)],hasMore:false,nextCursor:'expired-completed-cursor'});await loading;
  const current=value.detail.comments[0];assert.match(value.commentMarkup(current),/展开剩余 1 条回复/);assert.equal(value.hasMoreReplies(current),true);await value.loadReplies('parent');assert.equal(queries[2].cursor,undefined);assert.equal(current.replies.length,4);assert.equal(value.hasMoreReplies(current),false);
});

test('locating a hidden notification reply merges its context and expands that parent automatically',async t=>{
  globals(t,{requestAnimationFrame:callback=>callback()});const {value,parent}=repliesFixture(5);value.mergeReplies(parent,[reply(3)]);value.dialog={isConnected:false};
  value.api.get=async()=>({topLevelComment:{...parent,replies:[reply(1),reply(2)]},replies:[reply(4),reply(5)],targetComment:reply(5)});await value.locateComment('r5');
  const current=value.detail.comments[0];assert.equal(value.replyState('parent').expanded,true);assert.equal(current.replies.length,5);assert.match(value.commentMarkup(current),/回复正文 5/);assert.equal(visibleReplies(value.commentMarkup(current)),5);
});

test('sending a reply to a collapsed thread makes the acknowledged reply visible',async()=>{
  const {value,parent}=repliesFixture(2),button={isConnected:true},form={elements:{body:{value:'新发送的回复'}},querySelector:selector=>selector==='[type=submit]'?button:null,classList:{remove(){},toggle(){}}};value.detail.replyTarget={id:'r1',parentId:'parent'};
  value.api.write=async()=>({comment:{...reply(3),body:'新发送的回复'},commentCount:4});await value.submitComment(form);
  assert.equal(value.replyState('parent').expanded,true);assert.equal(visibleReplies(value.commentMarkup(parent)),3);assert.match(value.commentMarkup(parent),/新发送的回复/);assert.equal(form.elements.body.value,'');
});

test('a single reply does not show a collapse control that would leave the same reply visible',async()=>{
  const {value,parent}=repliesFixture(1);value.replyState('parent').expanded=true;assert.equal(visibleReplies(value.commentMarkup(parent)),1);assert.doesNotMatch(value.commentMarkup(parent),/data-cm="replies-(?:expand|collapse)"/);
});

function eventTarget(extra={}) {
  const listeners=new Map();return {listeners,addEventListener(name,listener,capture=false){listeners.set(name+':'+!!capture,listener);},removeEventListener(name,listener,capture=false){if(listeners.get(name+':'+!!capture)===listener)listeners.delete(name+':'+!!capture);},emit(name,event={},capture=false){listeners.get(name+':'+!!capture)?.(event);},...extra};
}
function menuFixture(t) {
  let anchor={left:950,top:200,right:994,bottom:244,width:44,height:44};const scroll={getBoundingClientRect:()=>({left:600,top:100,right:1100,bottom:880})};
  const document=eventTarget({activeElement:null}),viewport=eventTarget({offsetLeft:0,offsetTop:0,width:1200,height:1000}),window=eventTarget({innerWidth:1200,innerHeight:1000,visualViewport:viewport});
  const attributeTarget=extra=>({attributes:new Map(),setAttribute(name,value){this.attributes.set(name,String(value));},removeAttribute(name){this.attributes.delete(name);},...extra});
  const trigger=attributeTarget({isConnected:true,getBoundingClientRect:()=>anchor,contains:target=>target===trigger,closest:selector=>selector==='.cm-detail-scroll'?scroll:null,focus(){document.activeElement=this;}});
  const dialog=eventTarget({isConnected:true,children:[],clientLeft:0,clientTop:0,scrollLeft:0,scrollTop:0,getBoundingClientRect:()=>({left:100,top:80,right:1100,bottom:900,width:1000,height:820}),append(node){node.parent=this;this.children.push(node);}});
  document.createElement=()=>{
    const actions=Array.from({length:2},()=>({focus(){document.activeElement=this;}})),node=attributeTarget({isConnected:true,style:{},dataset:{},innerHTML:'',getBoundingClientRect(){return {width:108,height:(this.innerHTML.match(/role="menuitem"/g)||[]).length*48};},querySelector:()=>actions[0],querySelectorAll(){return actions.slice(0,(this.innerHTML.match(/role="menuitem"/g)||[]).length);},contains(target){return target===this||actions.includes(target);},remove(){this.isConnected=false;this.parent.children=this.parent.children.filter(child=>child!==this);}});return node;
  };
  globals(t,{document,window});const value=controller();value.dialog=dialog;value.detail={id:'note',note:{id:'note',author:{id:'writer'}},comments:[{id:'parent',canDelete:false},{id:'reply',parentId:'parent',canDelete:false}]};
  return {value,trigger,dialog,document,window,viewport,setAnchor:bounds=>{anchor={...anchor,...bounds};}};
}

test('note and reply report menus open inside the detail with the correct target and leave the report form workflow intact',t=>{
  const {value,trigger,dialog}=menuFixture(t);value.noteMore(trigger);let menu=value.contextMenu.menu;
  assert.equal(dialog.children[0],menu);assert.equal(menu.attributes.get('role'),'menu');assert.match(menu.innerHTML,/data-cm="report-note" data-id="note"/);assert.match(menu.innerHTML,/<span>举报<\/span>/);assert.doesNotMatch(menu.innerHTML,/<svg/);
  value.closeContextMenu();value.commentMore('reply',trigger);menu=value.contextMenu.menu;assert.equal(menu.attributes.get('aria-label'),'回复操作');assert.match(menu.innerHTML,/data-cm="report-comment" data-id="reply"/);
  let reportForm;value.showAux=(title,content)=>{reportForm=content;return {insertAdjacentHTML(){}};};value.showReport('comment','reply');assert.match(reportForm,/data-cm-form="report" data-type="comment" data-id="reply"/);
  value.closeContextMenu();
});

test('own note editing and permitted comment deletion remain available from the anchored menu',t=>{
  const {value,trigger}=menuFixture(t);value.detail.note.author.id='reader';value.noteMore(trigger);assert.match(value.contextMenu.menu.innerHTML,/href="#community\/edit\/note"/);assert.match(value.contextMenu.menu.innerHTML,/data-cm="note-delete"/);assert.doesNotMatch(value.contextMenu.menu.innerHTML,/report-note/);
  value.closeContextMenu();value.detail.comments[0].canDelete=true;value.commentMore('parent',trigger);assert.match(value.contextMenu.menu.innerHTML,/data-cm="comment-delete"/);assert.match(value.contextMenu.menu.innerHTML,/data-cm="report-comment"/);value.closeContextMenu();
});

test('context menu placement flips above an anchor near the bottom and stays within the dialog viewport',t=>{
  const {value,trigger,setAnchor}=menuFixture(t);setAnchor({top:820,bottom:864});value.noteMore(trigger);const menu=value.contextMenu.menu,x=Number.parseFloat(menu.style.left)+100,y=Number.parseFloat(menu.style.top)+80;
  assert.equal(menu.dataset.placement,'top');assert(x>=108&&x+108<=1092);assert(y>=88&&y+48<=892);value.closeContextMenu();
});

test('outside dismissal cleans up all menu listeners and clicking the same trigger toggles it closed',t=>{
  const {value,trigger,dialog,document,window,viewport}=menuFixture(t);value.noteMore(trigger);assert.equal(trigger.attributes.get('aria-expanded'),'true');assert.equal(trigger.attributes.get('aria-controls'),value.contextMenu.menu.id);
  document.emit('pointerdown',{target:{}},true);assert.equal(value.contextMenu,null);for(const target of [dialog,document,window,viewport])assert.equal(target.listeners.size,0);assert.equal(trigger.attributes.get('aria-expanded'),'false');assert.equal(trigger.attributes.has('aria-controls'),false);
  value.noteMore(trigger);value.noteMore(trigger);assert.equal(value.contextMenu,null);assert.equal(document.activeElement,trigger);
});

test('Escape closes only the context menu and returns focus to its trigger',t=>{
  const {value,trigger,document}=menuFixture(t);value.noteMore(trigger);let prevented=false;value.closeDetail=()=>{throw new Error('Escape must not close the detail while its menu is open');};
  value.keydown({key:'Escape',target:document.activeElement,preventDefault(){prevented=true;},stopPropagation(){}});assert(prevented);assert.equal(value.contextMenu,null);assert.equal(document.activeElement,trigger);assert.equal(value.detail.id,'note');
});

test('menu arrow navigation stops the detail image keyboard handler and wraps between actions',t=>{
  const {value,trigger,document}=menuFixture(t);value.detail.note.author.id='reader';value.noteMore(trigger);const actions=value.contextMenu.menu.querySelectorAll('[role="menuitem"]');let stopped=0;
  const event=key=>({key,target:document.activeElement,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){stopped++;}});
  value.keydown(event('ArrowDown'));assert.equal(document.activeElement,actions[1]);value.keydown(event('ArrowDown'));assert.equal(document.activeElement,actions[0]);value.keydown(event('ArrowRight'));assert.equal(document.activeElement,actions[0]);assert.equal(stopped,3);value.closeContextMenu();
});

test('resize repositions the menu and scrolling its anchor out of the visible detail closes it',t=>{
  const {value,trigger,window,dialog,setAnchor}=menuFixture(t);value.noteMore(trigger);const before=value.contextMenu.menu.style.left;setAnchor({left:700,right:744});window.emit('resize');assert.notEqual(value.contextMenu.menu.style.left,before);
  setAnchor({top:20,bottom:64});dialog.emit('scroll',{},true);assert.equal(value.contextMenu,null);assert.equal(window.listeners.size,0);
});
