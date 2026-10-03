import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const classes=()=>{const names=new Set();return {add:name=>names.add(name),remove:name=>names.delete(name),toggle(name,active){active?names.add(name):names.delete(name);},contains:name=>names.has(name)};};
function globals(t,values) {
  for(const [name,value]of Object.entries(values)){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});}
}
function controller() {
  const value=new CommunityController({getUser:()=>({id:'reader'}),api:()=>{},toast:()=>{}});
  value.error=()=>{};return value;
}
function commentFixture() {
  const value=controller(),button={disabled:false,isConnected:true},limit={hidden:true},target={hidden:true,innerHTML:''};
  const form={dataset:{cmForm:'comment'},elements:{body:{name:'body',value:'',focus(){},closest:()=>form}},classList:classes(),querySelector:selector=>selector==='[type=submit]'?button:selector==='.cm-comment-limit'?limit:null};
  value.detail={id:'note',note:{id:'note',author:{id:'author'},commentCount:2},comments:[{id:'a',author:{nickname:'甲'},replies:[],replyCount:0},{id:'b',author:{nickname:'乙'},replies:[],replyCount:0}],hasMore:false};
  value.dialog={querySelector:selector=>selector==='.cm-reply-target'?target:selector==='#cm-comment-input'?form.elements.body:null};
  value.renderComments=()=>{};value.commentStatus=()=>{};value.updateNote=(id,patch)=>Object.assign(value.detail.note,patch);
  const type=body=>{form.elements.body.value=body;value.input({target:form.elements.body});};
  return {value,form,button,type};
}

test('comment acknowledgement inserts under its sent parent and preserves newer text and reply target',async()=>{
  const {value,form,button,type}=commentFixture(),response=deferred();let request;
  value.api.write=async(path,method,body)=>{request=body;return response.promise;};
  value.setReply('a','a');type('发给甲的回复');const sending=value.submitComment(form);assert(button.disabled);
  type('下一条发给乙');value.setReply('b','b');response.resolve({comment:{id:'reply',parentId:'a',body:request.body},commentCount:3});await sending;
  assert.equal(request.parentId,'a');assert.equal(value.detail.comments[0].replies[0].id,'reply');assert.equal(value.detail.comments[1].replies.length,0);
  assert.equal(form.elements.body.value,'下一条发给乙');assert.equal(value.commentDrafts.get('note'),'下一条发给乙');assert.equal(value.detail.replyTarget.id,'b');assert.equal(button.disabled,false);
});

test('editing a pending comment and restoring the same text still preserves the new composer revision',async()=>{
  const {value,form,type}=commentFixture(),response=deferred();value.api.write=()=>response.promise;
  type('原文');const sending=value.submitComment(form);type('临时修改');type('原文');response.resolve({comment:{id:'posted',body:'原文'},commentCount:3});await sending;
  assert.equal(form.elements.body.value,'原文');assert.equal(value.commentDrafts.get('note'),'原文');assert.equal(value.detail.comments[0].id,'posted');
});

test('an unchanged failed comment retries its mutation id; changing the reply target gets a new id',async()=>{
  const {value,form,type}=commentFixture(),requests=[];value.api.write=async(path,method,body)=>{requests.push(body);throw new Error('network');};
  value.setReply('a','a');type('保留同一段文字');await value.submitComment(form);await value.submitComment(form);
  assert.equal(requests[0].clientMutationId,requests[1].clientMutationId);assert.equal(form.elements.body.value,'保留同一段文字');
  value.setReply('b','b');await value.submitComment(form);assert.notEqual(requests[1].clientMutationId,requests[2].clientMutationId);assert.equal(requests[2].parentId,'b');
  value.clearReply();await value.submitComment(form);assert.notEqual(requests[2].clientMutationId,requests[3].clientMutationId);assert.equal(requests[3].parentId,undefined);
});

test('a successful unchanged comment clears only its submitted composer and can send the same text anew',async()=>{
  const {value,form,type}=commentFixture(),requests=[];value.api.write=async(path,method,body)=>{requests.push(body);return {comment:{id:'reply'+requests.length,parentId:body.parentId,body:body.body},commentCount:2+requests.length};};
  value.setReply('a','a');type('同一段文字');await value.submitComment(form);assert.equal(form.elements.body.value,'');assert.equal(value.detail.replyTarget,null);assert.equal(value.commentDrafts.has('note'),false);
  value.setReply('a','a');type('同一段文字');await value.submitComment(form);assert.notEqual(requests[0].clientMutationId,requests[1].clientMutationId);assert.equal(value.detail.comments[0].replies.length,2);
});

test('following and unfollowing invalidate every category cache while retaining its saved scroll position',async t=>{
  globals(t,{document:{querySelectorAll:()=>[]},CSS:{escape:String}});
  const value=controller(),following={items:[],loaded:true,scrollTop:520},training={items:[{id:'old',author:{id:'author'}}],loaded:true,scrollTop:880},recommend={items:[],loaded:true,scrollTop:120};
  value.views=new Map([['#community/following',following],['#community/following?category=training',training],['#community',recommend]]);value.api.write=async(path,method,body)=>({followed:body.active});
  await value.toggleFollow('author',true);for(const view of [following,training]){assert.equal(view.loaded,false);assert.equal(view.invalidated,true);}assert.equal(recommend.loaded,true);assert.equal(training.scrollTop,880);
  following.loaded=training.loaded=true;await value.toggleFollow('author',false);assert.equal(training.items.length,0);assert.equal(training.loaded,false);assert.equal(following.loaded,false);assert.equal(following.scrollTop,520);
});

test('adding a collection invalidates only the account owner caches and a rejected write leaves them usable',async()=>{
  const value=controller(),own={items:[],loaded:true,collectionOwnerId:'reader',scrollTop:720},other={items:[],loaded:true,collectionOwnerId:'other'};
  value.views=new Map([['#settings?tab=collections',own],['#community/user/other?tab=collections',other]]);value.detail={id:'note',note:{id:'note',collected:false,collectionCount:0}};
  value.updateNote=(id,patch)=>Object.assign(value.detail.note,patch);value.api.write=async()=>({collected:true,collectionCount:1});await value.toggleNote('note','collection');
  assert.equal(own.loaded,false);assert.equal(own.invalidated,true);assert.equal(own.scrollTop,720);assert.equal(other.loaded,true);
  own.loaded=true;own.invalidated=false;value.api.write=async()=>{throw new Error('network');};await value.toggleNote('note','collection');assert.equal(own.loaded,true);assert.equal(own.invalidated,false);assert.equal(value.detail.note.collected,true);
});

test('an invalidated feed restores its saved scroll after fetching fresh notes',async t=>{
  const scrolled=[];globals(t,{window:{scrollTo:options=>scrolled.push(options.top)},requestAnimationFrame:callback=>callback(),IntersectionObserver:class {observe(){} disconnect(){}}});
  const value=controller(),route={hash:'#community/following',parts:['community','following'],params:new URLSearchParams()},view={items:[],loaded:false,invalidated:true,hasMore:false,scrollTop:670};
  const status={},page={dataset:{},querySelector:selector=>selector==='.cm-list-status'?status:null};value.container={isConnected:true};value.page=()=>page;value.views.set(route.hash,view);value.routeToken=4;value.activeRoute=route;
  value.setProfilePage=()=>{};value.canReuseProfile=()=>false;value.cancelProfileMotion=()=>{};value.loadList=async()=>{view.loaded=true;view.invalidated=false;};
  await value.renderList(route,4);assert.deepEqual(scrolled,[670]);
});

test('refreshing an invalidated multi-page feed refills the browsed range before restoring scroll and card focus',async t=>{
  const events=[];globals(t,{window:{scrollTo:options=>events.push(['scroll',options.top])},requestAnimationFrame:callback=>callback(),IntersectionObserver:class {observe(){} disconnect(){}}});
  const value=controller(),route={hash:'#community/following',parts:['community','following'],params:new URLSearchParams()},view={items:Array.from({length:40},(_,i)=>({id:String(i)})),loaded:true,hasMore:true,scrollTop:1700};
  value.view=view;value.detail={opener:{dataset:{cm:'open-note',id:'35'},classList:{contains:()=>true}}};value.invalidateView(view);value.detail=null;
  const status={},page={dataset:{},querySelector:selector=>selector==='.cm-list-status'?status:null};value.container={isConnected:true};value.page=()=>page;value.views.set(route.hash,view);value.routeToken=4;value.activeRoute=route;
  value.setProfilePage=()=>{};value.canReuseProfile=()=>false;value.cancelProfileMotion=()=>{};value.noteElements.set('35',{querySelector:selector=>({focus:()=>events.push(['focus',selector])})});
  value.loadList=async first=>{events.push(['fetch',!!first]);if(first)view.items=[];view.items.push(...Array.from({length:20},()=>({id:'fresh'})));view.loaded=true;view.invalidated=false;};
  await value.renderList(route,4);assert.deepEqual(events,[['fetch',true],['fetch',false],['focus','.cm-note-title'],['scroll',1700]]);assert.equal(view.refreshCount,undefined);
});

test('returning to the same invalidated feed rerenders instead of taking the cached route shortcut',async t=>{
  globals(t,{window:{scrollTo(){}}});
  const value=controller(),hash='#community/following',view={loaded:false,invalidated:true};let renders=0;
  value.container={isConnected:true,querySelector:()=>null};value.baseRoute=value.viewKey=hash;value.view=view;value.views.set(hash,view);value.page=()=>({children:[{}],querySelector:()=>null});
  for(const method of ['closeDetail','closeAux','leaveChat','captureScroll','updateTabs','setProfilePage','setMessagesPage'])value[method]=()=>{};
  value.canReuseProfile=()=>false;value.renderList=async()=>{renders++;};await value.handleRoute(hash);assert.equal(renders,1);
});

function loadingFeedFixture() {
  const value=controller(),grid={innerHTML:''},view={items:[],loaded:false,hasMore:true,scrollTop:0};
  value.view=view;value.views.set('#community/following',view);value.activeRoute={parts:['community','following'],params:new URLSearchParams()};value.routeToken=1;value.container={isConnected:false};value.page=()=>({querySelector:()=>grid});
  value.listStatus=()=>{};value.showSkeletons=()=>{};value.appendCard=()=>{};return {value,view};
}

test('a list response from before a follow acknowledgement is rejected even when the route token is unchanged',async t=>{
  globals(t,{requestAnimationFrame:callback=>callback()});const {value,view}=loadingFeedFixture(),old=deferred(),queries=[];
  value.api.get=async(path,params)=>{queries.push(params);return queries.length===1?old.promise:{items:[{id:'fresh'}],hasMore:false};};
  const loading=value.loadList(true);value.invalidateView(view);old.resolve({items:[{id:'stale'}],hasMore:false});await loading;
  assert.equal(queries.length,2);assert.equal(queries[1].cursor,null);assert.deepEqual(view.items,[{id:'fresh'}]);assert.equal(view.loaded,true);assert.equal(view.invalidated,false);assert.equal(view.revision,1);
});

test('invalidating an in-flight next page restarts its snapshot and refills the original browsed range',async t=>{
  const scrolled=[];globals(t,{requestAnimationFrame:callback=>callback(),window:{scrollTo:options=>scrolled.push(options.top)}});
  const {value,view}=loadingFeedFixture(),old=deferred(),queries=[];view.items=Array.from({length:40},(_,i)=>({id:'old'+i}));view.loaded=true;view.nextCursor='old-cursor';view.scrollTop=1850;value.container.isConnected=true;
  value.api.get=async(path,params)=>{queries.push(params);if(queries.length===1)return old.promise;return {items:Array.from({length:20},(_,i)=>({id:'fresh'+(i+(queries.length-2)*20)})),hasMore:queries.length===2,nextCursor:'fresh-cursor'};};
  const loading=value.loadList();value.invalidateView(view);old.resolve({items:[{id:'stale-next-page'}],hasMore:false});await loading;
  assert.deepEqual(queries.map(query=>query.cursor),['old-cursor',null,'fresh-cursor']);assert.equal(view.items.length,40);assert(view.items.every(row=>row.id.startsWith('fresh')));assert.equal(view.refreshCount,undefined);assert.deepEqual(scrolled,[1850]);
});

test('opening a detail while the invalidated feed request is pending leaves refresh for the return route',async()=>{
  const {value,view}=loadingFeedFixture(),old=deferred();let requests=0;value.api.get=()=>{requests++;return old.promise;};
  const loading=value.loadList(true);value.invalidateView(view);value.routeToken++;value.detail={id:'opened-note'};old.resolve({items:[{id:'stale'}],hasMore:false});await loading;
  assert.equal(requests,1);assert.equal(view.invalidated,true);assert.equal(view.loaded,false);assert.deepEqual(view.items,[]);assert.equal(value.detail.id,'opened-note');
});

test('a background feed refetch preserves modal focus and closing returns focus to the recreated source card',async t=>{
  const events=[];globals(t,{requestAnimationFrame:callback=>callback(),window:{scrollTo:options=>events.push(['scroll',options.top])},location:{hash:'#community/following'},document:{body:{classList:{remove(){}}}}});
  const {value,view}=loadingFeedFixture(),old=deferred(),replacement={focus:()=>events.push(['focus','new-cover'])};let calls=0;value.container.isConnected=true;value.viewKey='#community/following';view.scrollTop=900;
  value.detail={id:'note',returnHash:'#community/following',scrollTop:900,opener:{isConnected:false,dataset:{cm:'open-note',id:'note'},classList:{contains:()=>false}}};
  value.api.get=()=>++calls===1?old.promise:Promise.resolve({items:[{id:'note'}],hasMore:false});value.appendCard=note=>value.noteElements.set(note.id,{querySelector:()=>replacement});
  const loading=value.loadList(true);value.invalidateView(view);old.resolve({items:[{id:'stale'}],hasMore:false});await loading;assert.deepEqual(events,[]);assert.equal(view.restoreOpener.id,'note');
  value.closeDetail(false);assert.deepEqual(events,[['focus','new-cover'],['scroll',900]]);assert.equal(view.restoreOpener,undefined);
});

function notificationFixture() {
  const value=controller(),list={},status={isConnected:true,innerHTML:''},dot={hidden:true,parentElement:{setAttribute(){}}};
  value.page=()=>({querySelector:selector=>selector==='.cm-notification-list'?list:selector==='.cm-notification-status'?status:null});value.container={querySelector:selector=>selector==='.cm-unread-dot'?dot:null};
  value.notificationState={items:[],nextCursor:null,hasMore:true,loading:false,type:'all'};value.renderNotificationRows=()=>{};
  return {value,dot};
}

test('a notification list overtaken by reading refetches that page and keeps genuinely new notifications unread',async()=>{
  const {value,dot}=notificationFixture(),old=deferred(),queries=[];
  value.api.get=async(path,params)=>{queries.push(params);return queries.length===1?old.promise:{items:[{id:'old',read:true},{id:'new',read:false}],unreadCount:1,hasMore:false};};value.api.write=async()=>({unreadCount:0});
  const loading=value.loadNotifications();await value.readNotifications();old.resolve({items:[{id:'old',read:false}],unreadCount:1,hasMore:false});await loading;
  assert.equal(queries.length,2);assert.equal(queries[0].cursor,queries[1].cursor);assert.deepEqual(value.notificationState.items,[{id:'old',read:true},{id:'new',read:false}]);assert.equal(value.unreadCount,1);assert.equal(dot.hidden,false);
});

test('old unread refreshes cannot replace a newer response or a successful read acknowledgement',async()=>{
  const {value,dot}=notificationFixture(),first=deferred(),second=deferred(),third=deferred(),responses=[first,second,third];value.api.get=()=>responses.shift().promise;value.api.write=async()=>({unreadCount:0});
  const a=value.refreshUnread();await Promise.resolve();const b=value.loadNotifications();second.resolve({items:[],unreadCount:2,hasMore:false});await b;first.resolve({unreadCount:9});await a;assert.equal(value.unreadCount,2);
  const c=value.refreshUnread();await Promise.resolve();await value.readNotifications();third.resolve({unreadCount:2});await c;assert.equal(value.unreadCount,0);assert.equal(dot.hidden,true);
});

test('notification responses arriving before a delayed read acknowledgement wait and then refresh real read states',async()=>{
  const {value}=notificationFixture(),acknowledgement=deferred();let gets=0;value.api.write=()=>acknowledgement.promise;
  value.api.get=async()=>++gets===1?{items:[{id:'new',read:false}],unreadCount:1,hasMore:false}:{items:[{id:'new',read:false}],unreadCount:1,hasMore:false};
  const reading=value.readNotifications(),loading=value.loadNotifications();await Promise.resolve();assert.equal(value.notificationState.items.length,0);
  acknowledgement.resolve({unreadCount:0});await reading;await loading;assert.equal(gets,2);assert.equal(value.notificationState.items[0].read,false);assert.equal(value.unreadCount,1);
});

test('out-of-order read acknowledgements mark their rows without restoring an old unread count',async()=>{
  const {value}=notificationFixture(),first=deferred();value.notificationState.items=[{id:'a',read:false},{id:'b',read:false}];let calls=0;value.api.write=()=>++calls===1?first.promise:Promise.resolve({unreadCount:0});
  const a=value.readNotifications(['a']);await value.readNotifications(['b']);first.resolve({unreadCount:1});await a;
  assert(value.notificationState.items.every(row=>row.read));assert.equal(value.unreadCount,0);
});

test('overlapping reads reconcile unread counts when the server commits in reverse request order',async()=>{
  const {value}=notificationFixture(),first=deferred();value.notificationState.items=[{id:'a',read:false},{id:'b',read:false}];value.unreadCount=2;let writes=0,refreshes=0,serverUnread=2;
  value.api.write=()=>{if(++writes===1)return first.promise;serverUnread=1;return Promise.resolve({unreadCount:serverUnread});};value.api.get=async()=>{refreshes++;return {unreadCount:serverUnread};};
  const a=value.readNotifications(['a']);await value.readNotifications(['b']);assert.equal(value.unreadCount,1);assert.equal(refreshes,0);
  serverUnread=0;first.resolve({unreadCount:serverUnread});await a;assert.equal(refreshes,1);assert(value.notificationState.items.every(row=>row.read));assert.equal(value.unreadCount,0);
});

test('a later failed read does not suppress an earlier successful acknowledgement',async()=>{
  const {value}=notificationFixture(),first=deferred();value.unreadCount=2;let calls=0;value.api.write=()=>++calls===1?first.promise:Promise.reject(new Error('network'));
  const a=value.readNotifications();await value.readNotifications();first.resolve({unreadCount:0});await a;assert.equal(value.unreadCount,0);
});
