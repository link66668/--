// Exercise the app's actual route lifecycle with a small DOM/store boundary.
// The view's media and asynchronous work have separate motion-view UI tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {transitionView} from '../public/view-transitions.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function appFunction(name){
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert(start>=0,`Missing app function ${name}`);
  const end=source.indexOf('\n}',start);
  assert(end>=0,`Missing app function end ${name}`);
  return source.slice(start,end+2);
}
class Element {
  constructor(name){this.name=name;this.parentNode=null;this.children=[];this.content='';}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
  replaceChildren(...children){for(const child of [...this.children])child.remove();for(const child of children){child.remove();child.parentNode=this;this.children.push(child);}}
  querySelector(selector){return selector==='.motion-page'?this.children.find(child=>child.name==='motion-page')||null:null;}
  set innerHTML(value){this.replaceChildren();this.content=value;}
  get innerHTML(){return this.content;}
}
function store(id){
  return {id,records:new Map(),writes:[],removed:[],sync:async()=>{},list(){return [...this.records.values()];},
    async put(kind,key,data){this.writes.push({kind,key,data});},async remove(key){this.removed.push(key);}};
}
function setup(){
  let page=new Element('page'),mounts=[],requestCount=0;
  const app=new Element('app');
  Object.defineProperty(app,'innerHTML',{set(value){this.content=value;page.remove();page=new Element('page');this.replaceChildren(page);},get(){return this.content;}});
  app.replaceChildren(page);
  const state={page:'motion',setting:'home',user:{id:'a',name:'A'},store:store('a'),providers:[],tasks:{}};
  const noop=()=>{};
  const context=createContext({state,navigationVersion:0,transitionView,document:{},$:(selector)=>selector==='#app'?app:selector==='#page'?page:null,
    communityOnlyPage:()=>false,readyComputed:async()=>true,setWorkspaceTheme:noop,captureChatDraft:noop,
    closeAccountSettings:noop,accountAvatarMarkup:()=>'',icon:()=>'',esc:String,profile:()=>null,dateLabel:()=>'',today:()=>'',updateSidebarQuote:noop,renderSidebarHistory:noop,updateSync:noop,
    ensureRecurringSchedule:async()=>{},toast:noop,renderChat:()=>{page.innerHTML='chat';},renderNutrition:noop,renderTraining:noop,renderLibrary:noop,renderSettings:()=>{page.innerHTML='settings';},
    showExercise:noop,validateMotionAssessmentSize:noop,uid:()=>String(++requestCount),enabledModels:provider=>provider.models,currentModel:()=>state.model,
    streamMotionCoach:async()=>({ok:true}),navigate:async target=>{state.page=target;await context.render();return true;},
    mountMotionView(container,options){
      const root=new Element('motion-page');container.replaceChildren(root);
      const instance={root,options,draft:{file:{name:'unsaved.mp4'},result:{summary:'current result'}},suspends:0,resumes:0,refreshes:0,destroys:0,
        suspend(){this.suspends++;},resume(){this.resumes++;},refreshHistory(){this.refreshes++;return Promise.resolve();},
        async openReport(id){this.historyId=id;return true;},hasUnsavedWork(){return !!this.draft&&!this.saved;},destroy(){this.destroys++;this.draft=null;}};
      mounts.push(instance);return instance;
    },
  });
  const lifecycle=source.slice(source.indexOf('let motionView = null;'),source.indexOf('let landingCleanup = null;'));
  runInContext(lifecycle+'\nlet landingCleanup=null;let communityController=null;\n'+['render','renderPage','renderMotion'].map(appFunction).join('\n')+'\nglobalThis.inspectMotion=()=>({motionView,motionRoot,motionStore});',context);
  return {context,state,mounts,app,get page(){return page;}};
}

test('full page navigation retains the exact video view and result across settings and chat',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0],draft=view.draft,root=view.root,firstPage=h.page;
  assert.equal(root.parentNode,firstPage);
  for(const destination of ['settings','chat']){
    h.state.page=destination;await h.context.render();
    assert.equal(root.parentNode,null,'Motion subtree is detached before the shell is replaced');
    assert.equal(view.destroys,0);assert.equal(view.draft,draft);
    h.state.page='motion';await h.context.render();
    assert.equal(h.mounts.length,1);assert.equal(root.parentNode,h.page);assert.notEqual(h.page,firstPage);
    assert.equal(view.draft,draft);assert.equal(h.context.inspectMotion().motionView,view);
  }
  assert.equal(view.resumes,2);assert.equal(view.refreshes,2);
});

test('page-only sync redraw refreshes history without remounting and sees updated provider configuration',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0],root=view.root;
  assert.equal(view.options.getCoachConfiguration().configured,false);
  h.state.tasks.motion='new-provider';h.state.model='vision-model';
  h.state.providers=[{id:'new-provider',name:'Configured provider',models:[{id:'vision-model',name:'Configured model',vision:true}]}];
  await h.context.renderPage();await h.context.renderPage();
  assert.equal(h.mounts.length,1);assert.equal(view.resumes,2);assert.equal(view.refreshes,2);assert.equal(root.parentNode,h.page);
  assert.equal(view.options.getCoachConfiguration().configured,true);
  assert.equal(view.options.getCoachConfiguration().model,'Configured model');
  h.state.page='chat';await h.context.renderPage();assert.equal(root.parentNode,null);assert.equal(view.destroys,0);
  h.state.page='motion';await h.context.renderPage();assert.equal(root.parentNode,h.page);assert.equal(h.mounts.length,1);
});

test('a different store destroys the old draft and its callbacks cannot save, delete or assess for the new account',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0],oldStore=h.state.store;
  oldStore.records.set('motion:old',{kind:'motion-assessment'});
  h.context.suspendMotionView();h.state.user={id:'b',name:'B'};h.state.store=store('b');
  await h.context.render();
  assert.equal(h.mounts.length,2);assert.equal(view.destroys,1);assert.equal(view.draft,null);assert.equal(view.root.parentNode,null);
  assert.equal(h.context.inspectMotion().motionStore,h.state.store);
  await assert.rejects(view.options.saveAssessment({}),/账号已切换/);
  await assert.rejects(view.options.deleteAssessment('motion:old'),/账号已切换/);
  await assert.rejects(view.options.reviewAssessment({}),/账号已切换/);
  assert.equal(oldStore.writes.length,0);assert.equal(oldStore.removed.length,0);assert.equal(h.state.store.writes.length,0);
  await h.mounts[1].options.saveAssessment({summary:'new-account report'});
  assert.equal(h.state.store.writes.length,1);assert.equal(oldStore.writes.length,0);
});

test('explicit close also destroys a detached view and clears all retained references',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0];
  h.context.suspendMotionView();h.context.closeMotionView();h.context.closeMotionView();
  assert.equal(view.destroys,1);assert.equal(view.root.parentNode,null);
  const remaining=h.context.inspectMotion();
  assert.equal(remaining.motionView,null);assert.equal(remaining.motionRoot,null);assert.equal(remaining.motionStore,null);
  await h.context.render();assert.equal(h.mounts.length,2);assert.notEqual(h.mounts[1],view);
});

test('chat report navigation uses the retained instance and rejects a stale account after synchronization',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0],draft=view.draft;
  const start=source.indexOf("case 'chat-motion-detail':{"),end=source.indexOf("case 'toggle-sidebar':",start);
  assert(start>=0&&end>start);
  runInContext(`async function openChatReport(target){switch('chat-motion-detail'){${source.slice(start,end)}}}`,h.context);
  h.state.store.records.set('motion:history',{kind:'motion-assessment',data:{}});
  h.state.page='chat';await h.context.render();
  await h.context.openChatReport({dataset:{reportId:'motion:history'}});
  assert.equal(h.mounts.length,1);assert.equal(view.historyId,'motion:history');assert.equal(view.draft,draft);assert.equal(view.destroys,0);
  const previousStore=h.state.store;
  previousStore.sync=async()=>{h.state.store=store('b');h.state.user={id:'b',name:'B'};h.context.closeMotionView();};
  h.state.page='chat';await h.context.render();
  await h.context.openChatReport({dataset:{reportId:'motion:missing'}});
  assert.equal(h.state.page,'chat');assert.equal(view.historyId,'motion:history');assert.equal(view.destroys,1);
});

test('successful logout destroys a suspended draft before clearing the account',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0],oldStore=h.state.store;
  h.context.suspendMotionView();let logoutRequests=0,closed=0,authShown=0;
  oldStore.close=async()=>{closed++;};
  const noop=()=>{};
  Object.assign(h.context,{rememberCommunityReturn:noop,modelViewer:{destroy:noop},chatUploads:{clearAll:async()=>{}},stopChat:async()=>{},
    chatMotionVideos:{clear:noop},api:async path=>{assert.equal(path,'/auth/logout');logoutRequests++;},
    localStorage:{removeItem:noop},setApiUser:noop,chatDrafts:new Map(),chatScroll:new Map(),renderAuth:()=>{authShown++;}});
  runInContext(appFunction('logout'),h.context);await h.context.logout();
  assert.equal(logoutRequests,1);assert.equal(closed,1);assert.equal(authShown,1);
  assert.equal(view.destroys,1);assert.equal(view.draft,null);assert.equal(h.context.inspectMotion().motionRoot,null);
  assert.equal(h.state.user,null);assert.equal(h.state.store,null);
});

test('refresh/close warning follows unsaved work for the active store, including while detached',async()=>{
  const h=setup();await h.context.render();const view=h.mounts[0];h.context.suspendMotionView();
  let handler;
  h.context.window={addEventListener(type,fn){assert.equal(type,'beforeunload');handler=fn;}};
  const start=source.indexOf("window.addEventListener('beforeunload',"),end=source.indexOf('\n});',start);
  assert(start>=0&&end>start);runInContext(source.slice(start,end+4),h.context);
  const event=()=>({prevented:false,preventDefault(){this.prevented=true;}});
  const draft=event();handler(draft);assert.equal(draft.prevented,true);assert.equal(draft.returnValue,'');
  view.saved=true;const saved=event();handler(saved);assert.equal(saved.prevented,false);
  view.saved=false;h.state.store=store('b');const anotherAccount=event();handler(anotherAccount);assert.equal(anotherAccount.prevented,false);
  h.context.closeMotionView();const closed=event();handler(closed);assert.equal(closed.prevented,false);
});
