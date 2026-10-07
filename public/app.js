import {accountAvatarMarkup, mountAccountSettings} from './account-settings.js';
import {landingMarkup, mountLanding} from './landing.js?v=18';
import {animateViewEntry, transitionView} from './view-transitions.js?v=5';
import {webSearchSettingsView,renderWebResult,updateWebSearchProviderFields} from './web-search.js';
import {nutritionFeedbackView} from './nutrition-feedback-view.js';
import {dailyMealAdvicePrompt} from './meal-advice-prompt.js?v=2';
import {getDailyQuote} from './daily-quotes.js?v=1';
import {holidayYear,holidayInfo,installHolidayYear} from './holidays.js';
import {CommunityController, clearCommunityDrafts, clearCommunityLocalData} from './community.js?v=35';
import {api, streamChat, streamMotionCoach, RecordStore, setApiUser, createId} from './store.js?v=11';
import {renderMarkdown,renderMarkdownInto} from './chat-markdown.js?v=10';
import {AttachmentManager, filesFromTransfer} from './chat-attachments.js?v=10';
import {ChatMotionVideos} from './chat-motion.js';
import {confirmChatMotionAction} from './chat-motion-confirm.js';
import {compactChatMotionResult, renderChatMotionResult} from './chat-motion-result.js';
import {MOTION_VIDEO_ACCEPT} from './motion-media.js';
import {patchHTML, copyMessageText, copyImage} from './chat-view.js?v=9';
import {addDays, weekDates} from './schedule.js?v=12';
import {formatMealNotes} from './meal-display.js';
import {calculate,createComputedState} from './compute.js';
import {exercises,foods,trainingParts,MAX_TRAINING_EXERCISES,defaultExercises,formulaCards,foodPortions,rmPresets,rmConversionReference,mealCategoryInstruction,mealDishInstruction} from './compute-catalog.js';
const exerciseUsesSeconds = id => id === 'plank';
const defaultTrainingExercise = id => structuredClone(defaultExercises[id]);
import {knowledgeCards, findKnowledge} from './knowledge.js?v=9';
import {muscleCatalog, chatVisuals, modelUrl} from './visuals.js?v=11';
import {ModelViewer} from './model-viewer.js?v=9';
import {mountMotionView,validateMotionAssessmentSize} from './motion-view.js?v=19';
import {providerPresets} from './provider-presets.js?v=9';
import {enabledModels, taskSelection, reconcileTasks} from './provider-ui.js?v=11';
import {createProviderSettings} from './provider-settings.js?v=1';
import {coverUrl} from './exercise-covers.js?v=9';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = createId;
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dateLabel = value => new Date(value+'T12:00:00').toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
const numeric = value => Math.round(Number(value)||0);
const goalLabel = goal => ({lose:'减脂',gain:'增肌',maintain:'保持健康'}[goal] || goal);
const paths = {
 sunrise:'M3 17h18M5 21h14M7 17a5 5 0 0 1 10 0M12 3v3M4 9l2 2M20 9l-2 2',
 sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
 moon:'M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z',
 snack:'M4 9h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9ZM16 10h2a3 3 0 0 1 0 6h-2M7 3v3M12 2v4',
 egg:'M19 14c0 4-3 7-7 7s-7-3-7-7S9 3 12 3s7 7 7 11ZM8 14c0 2 1 3 3 3',
 bowl:'M3 11h18a9 9 0 0 1-18 0ZM8 21h8M8 3v4M12 2v5M16 3v4',
 protein:'M9 7c3-3 7-3 9-1s2 6-1 9-6 3-8 1l-3 3a2 2 0 1 1-3-3l3-3c-1-2 0-4 3-6ZM12 8l3 3',
 milk:'M8 3h8v4l3 4v10H5V11l3-4V3ZM8 7h8M5 12h14M9 16h6',
 fruit:'M12 7c-3-3-8-1-8 4s3 10 6 10l2-1 2 1c3 0 6-5 6-10s-5-7-8-4ZM12 7V4M12 4c1-3 4-3 5-2-1 3-3 3-5 2',
 folder:'M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h10v2', pencil:'m15 4 5 5M4 16l-1 5 5-1L21 7l-5-5Z',
 chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5',
 food:'M6 3v6a3 3 0 0 0 6 0V3M9 3v18M19 3v18M19 3c-4 4-4 9 0 9',
 dumbbell:'m6 5 13 13M3 8l5-5M2 5l3-3M16 21l5-5M19 22l3-3M5 10l5-5M14 19l5-5',
 grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
 community:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
 plus:'M12 5v14M5 12h14', arrow:'M7 17 17 7M7 7h10v10', send:'M12 19V5M5 12l7-7 7 7',
 clip:'m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5',
 image:'M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M8 7h.01', close:'m6 6 12 12M6 18 18 6',
 leaf:'M20 3C7 2 2 9 6 15s15 4 14-12M5 21 16 9', check:'m5 12 4 4L19 6',
 history:'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2', logout:'M9 3H4v18h5M10 12h11M17 8l4 4-4 4',
 menu:'M4 6h16M4 12h16M4 18h16', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
 spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3',
 calendar:'M3 5h18v16H3zM7 3v4M17 3v4M3 10h18', download:'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
 body:'M12 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4M5 8l7 2 7-2M12 10v6M12 16l-5 6M12 16l5 6'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.spark}"/></svg>`;
const button = (text,action,extra='',type='') => `<button type="button" class="button ${type}" data-action="${action}" ${extra}>${text}</button>`;
const empty = (text,name='leaf') => `<div class="empty">${icon(name)}${text}</div>`;
const state = {page:'chat',setting:'home',date:today(),conversation:null,user:null,store:null,providers:[],tasks:{},taskModels:{},providerDraft:null,files:[],busy:false,filter:'',muscle:'',equipment:'',knowledgeTab:'nutrition',mealDraft:null,authMode:'register'};
try { state.sidebarCollapsed = localStorage.getItem('fitness:sidebar-collapsed') === 'true'; } catch { state.sidebarCollapsed = false; }
const knowledgeDrafts = {};
const modelViewer = new ModelViewer();
let motionView = null;
let motionRoot = null;
let motionStore = null;
// Route rendering replaces #page. Keep the same account's media and analysis
// instance outside that DOM subtree until the user returns to the motion page.
function suspendMotionView() { motionView?.suspend(); motionRoot?.remove(); }
function closeMotionView() { motionView?.destroy(); motionRoot?.remove(); motionView=null; motionRoot=null; motionStore=null; }
let landingCleanup = null;
let communityController = null;
let accountSettingsView = null;
function closeAccountSettings() {accountSettingsView?.destroy(); accountSettingsView=null;}
function updateAccountProfile(profile) {
  if(!state.user||profile?.id!==state.user.id)return;
  const changed=state.user.avatarUrl!==(profile.avatarUrl||null);
  state.user.avatarUrl=profile.avatarUrl||null;
  if(state.store?.user)state.store.user.avatarUrl=state.user.avatarUrl;
  try{localStorage.setItem('fitness:last-user',JSON.stringify(state.user));}catch{}
  document.querySelectorAll('[data-account-avatar]').forEach(element=>{element.innerHTML=accountAvatarMarkup(state.user);});
  accountSettingsView?.refreshAvatar(state.user);
  if(communityController?.accountId===state.user.id){
    communityController.ownProfile=profile;
    if(changed)for(const view of communityController.views.values())view.loaded=false;
    if(communityController.currentProfile?.id===profile.id)communityController.currentProfile=profile;
  }
}
let navigationVersion = 0;
let providerSettings = null;
state.providersVersion = null;
state.providersConflict = false;
const personalSections = [['home','我的主页'],['profile','健康档案'],['achievements','成就墙'],['ai','AI 服务']];
const personalSectionGroup = section => ({account:'home',data:'home',review:'profile'}[section]||section);
function personalRoute(hash=location.hash) {
  const [path,query='']=String(hash).split('?'),params=new URLSearchParams(query);
  return {active:path==='#settings',section:personalSections.some(([id])=>id===personalSectionGroup(params.get('section')))?params.get('section'):'home',tab:['collections','drafts'].includes(params.get('tab'))?params.get('tab'):'published'};
}
const personalHash = section => section==='home'?'#settings':'#settings?section='+encodeURIComponent(section);
const communityOnlyPage = () => state.page==='community'||state.page==='settings'&&personalSectionGroup(state.setting)==='home';
function canonicalProfileHash(hash) {
  const [path,query='']=String(hash).split('?'),params=new URLSearchParams(query),parts=path.split('/');
  if(path==='#community/mine'||parts[0]==='#community'&&parts[1]==='user'&&String(parts[2])===String(state.user?.id)&&params.get('preview')!=='public'){
    const tab=['collections','drafts'].includes(params.get('tab'))?params.get('tab'):'published';
    return tab==='published'?'#settings':'#settings?tab='+tab;
  }
  return hash;
}
const chatDrafts = new Map();
const chatScroll = new Map();
const chatMotionVideos = new ChatMotionVideos();
let chatRun = null;
let composerObserver = null;
const attachmentOwner = (conversation=state.conversation,userId=state.user?.id) => `${userId}:${conversation||'new'}`;
const chatUploads = new AttachmentManager({
 upload:async(file,{signal,ownerKey,metadata})=>{
   if(metadata.type.startsWith('video/')){signal.throwIfAborted();return {...await chatMotionVideos.add(file,metadata),localVideo:true};}
   if(!navigator.onLine)throw new Error('当前离线，联网后可重试上传。');
   const data=await new Promise((resolve,reject)=>{
     const reader=new FileReader(),abort=()=>{reader.abort();reject(new DOMException('已取消上传','AbortError'));};
     signal.addEventListener('abort',abort,{once:true});
     reader.onload=()=>{signal.removeEventListener('abort',abort);resolve(String(reader.result).split(',')[1]);};
     reader.onerror=()=>{signal.removeEventListener('abort',abort);reject(reader.error);};
     if(signal.aborted)abort();else reader.readAsDataURL(file);
   });
   return api('/attachments',{method:'POST',signal,headers:{'X-Fitness-User':ownerKey.split(':')[0]},body:{name:metadata.name,type:metadata.type,data}});
 },
 removeRemote:async(attachment,{ownerKey})=>{if(attachment.localVideo){chatMotionVideos.remove(attachment.id);return;}return api('/attachments/'+attachment.id,{method:'DELETE',headers:{'X-Fitness-User':ownerKey.split(':')[0]},body:{}});},
 onChange:owner=>{if(state.user&&owner===attachmentOwner())renderChatFiles();}
});
const profile = () => state.store?.get('profile');
const records = kind => state.store?.list(kind) || [];
const plan = () => state.store?.get('active-plan');
const emptyTotals = {kcal:0,protein:0,carbs:0,fat:0};
let computed = {tasks:[],nutrition:{},totals:{},mealTotals:{},dayTypes:{},advice:{},busyDates:[],completed:[],achievements:{}};
const computeRecords = () => [...(state.store?.records.values()||[])].filter(r=>['profile','phase','nutrition-feedback-settings','meal','nutrition-advice','plan','draft','calendar-task','schedule','training-cycle','calendar-settings','achievement','achievement-summary','training-template','library-settings','preferences'].includes(r.kind));
const computedState = createComputedState(()=>({records:computeRecords(),dates:[state.date],today:today(),now:new Date().toISOString().slice(0,16)+':00.000Z',timezoneOffset:new Date().getTimezoneOffset(),userId:state.user?.id}));
async function refreshComputed() {if(!state.user)return;computed=await computedState.refresh();}
async function readyComputed() {const store=state.store,page=state.page,setting=state.setting;try{await refreshComputed();return state.store===store&&state.page===page&&state.setting===setting;}catch(error){if(state.store===store)toast(error.message,true);return false;}}
const allCalendarTasks = () => computed.tasks;
const scheduledRecord = date => allCalendarTasks().find(r=>r.data.date===date&&r.data.taskType==='training');
const scheduled = date => scheduledRecord(date)?.data;
const dayType = date => computed.dayTypes[date] || 'rest';
const totals = date => computed.totals[date] || emptyTotals;
const mealTotals = items => computed.mealTotals[JSON.stringify(items||[])] || emptyTotals;
function nutrition(date=state.date) {return computed.nutritionByDate?.[date]?.[dayType(date)]||computed.nutrition[dayType(date)]||{...emptyTotals,bmr:0,tdee:0,error:'等待服务器计算营养目标。'};}
const isBusyDate = date => computed.busyDates.includes(date);
const beijingDate = () => computed.beijingDate;
const foodCategory = (item,description='') => item.category||computed.mealCategories?.[JSON.stringify([item,description])]||'正餐';
function toast(message,error=false) { const el=document.createElement('div'); el.className='toast'+(error?' error':''); el.textContent=message; $('#toasts').append(el); while($('#toasts').children.length>2)$('#toasts').firstElementChild.remove();setTimeout(()=>el.remove(),5000); }
function modal(title,html,wide=false,required=false) {
 const el=$('#modal'),changed=el.open&&$('.modal-head h2',el)?.innerHTML!==String(title);
 el.className=wide?'modal-wide':'';
 el.innerHTML=`<div class="modal-head"><h2>${title}</h2>${required?'':`<button class="icon-button" aria-label="关闭" data-action="close-modal">${icon('close')}</button>`}</div><div class="modal-content">${html}</div>`;
 el.oncancel=required?e=>e.preventDefault():null;
 if(!el.open)el.showModal();else if(changed)animateViewEntry($('.modal-content',el));
}
function clearProviderDraft() {if(state.providerDraft)state.providerDraft.apiKey='';state.providerDraft=null;const key=$('#provider-key');if(key)key.value='';}
function closeModal() {clearProviderDraft();state.busyEditor=null;$('#modal').close(); }
function formData(form) { return Object.fromEntries(new FormData(form)); }
function options(list,selected) { return list.map(([value,label])=>`<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`).join(''); }

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
  try { const {user}=await api('/auth/me'); await enter(user); }
  catch(error) {
    const cached=JSON.parse(localStorage.getItem('fitness:last-user') || 'null');
    if(!error.status && cached) { await enter(cached,true); toast('当前离线，记录会先保存在这台设备'); }
    else renderAuth();
  }
}
async function enter(user,offline=false) {
  closeAccountSettings();
  if(state.user?.id!==user.id){closeMotionView();await communityController?.destroy();communityController=null;modelViewer.destroy();for(const key of Object.keys(knowledgeDrafts))delete knowledgeDrafts[key];await chatUploads.clearAll({removeUploaded:true});chatMotionVideos.clear();chatDrafts.clear();chatScroll.clear();state.conversation=null;state.chatScene='';state.files=[];state.weekCelebration=null;state.celebratedWeeks=new Set();state.achievementPage=0;state.achievementCategory='all';state.librarySelected=null;state.libraryDate=null;state.libraryEditing=null;}
  state.providersVersion=null;state.providersConflict=false;
  setApiUser(user.id);
  state.user=user; state.store=await new RecordStore(user).open(); localStorage.setItem('fitness:last-user',JSON.stringify(user));
  providerSettings=createSessionProviderSettings(user,state.store);
  let derivedPending=false;for(const [id,change] of state.store.pending){if(['achievement','achievement-summary'].includes(change.kind)){state.store.pending.delete(id);state.store.records.delete(id);state.store.conflicts=state.store.conflicts.filter(item=>item.id!==id);derivedPending=true;}}
  if(derivedPending){state.store.cursor=null;await state.store.persist();}
  const communityReturn=readCommunityReturn();
  if(communityReturn)history.replaceState(null,'',communityReturn);
  const initialHash=canonicalProfileHash(location.hash);
  if(initialHash!==location.hash)history.replaceState(null,'',initialHash);
  const personal=personalRoute(initialHash);
  if(personal.active){state.page='settings';state.setting=personal.section;}
  else state.page=initialHash.startsWith('#community')?'community':(['chat','nutrition','training','library','motion'].includes(initialHash.slice(1))?initialHash.slice(1):state.page);
  let computeReady=false;
  if(offline){state.store.status='offline';if(!communityOnlyPage()){showComputeUnavailable();return;}}
  else try{await refreshComputed();computeReady=true;}catch(error){if(!communityOnlyPage()){showComputeUnavailable(error.message);return;}}
  const store=state.store;state.scheduleFingerprint=scheduleFingerprint();state.scheduleRefreshPending=false;
  store.addEventListener('change',()=>{if(state.store!==store)return;updateSync();renderSidebarHistory();void refreshComputed().then(()=>{if(state.store===store)refreshScheduleViews();}).catch(error=>{if(state.store===store)toast(error.message,true);});});
  if(!offline) { await state.store.sync().catch(e=>toast(e.message,true)); await loadProviders(); }
  if(computeReady)await ensurePlanLibrary();
  render(); if(!profile()) showProfile(true);
}
function applyProviders(result) {
  if(state.providersVersion!==null&&result.version<state.providersVersion)return;
  state.providers=result.providers;state.tasks=result.tasks;state.taskModels=result.taskModels||{};
  state.providersVersion=result.version;state.providersConflict=false;
}
function createSessionProviderSettings(user,store) {
  return createProviderSettings({
    getUserId:()=>state.user?.id,
    request:(path,options={})=>{
      if(state.user!==user||state.store!==store)throw new Error('账号已切换，请重新保存模型配置。');
      return api(path,{...options,headers:{...options.headers,'X-Fitness-User':user.id}});
    },
    onUpdate:result=>{if(state.user===user&&state.store===store)applyProviders(result);},
  });
}
async function loadProviders() {
  const user=state.user,store=state.store,settings=providerSettings;if(!user||!settings)return false;
  try {
    await settings.load();
    return state.user===user&&state.store===store&&providerSettings===settings;
  } catch {return false;}
}
function providerConflictMarkup() {
  return `<div class="error-box"><p>AI 服务配置已更新，当前修改尚未保存。加载最新配置后，请重新修改。</p>${button('加载最新配置','reload-providers')}<small style="display:block;margin-top:8px">加载后会清除当前未保存的配置修改。</small></div>`;
}
async function saveProviderConfiguration(payload,version,form) {
  const user=state.user,store=state.store,settings=providerSettings;if(!user||!settings)return false;
  try {
    if(!Number.isSafeInteger(version)||version<0)throw Object.assign(new Error('AI 服务配置尚未加载，请加载最新配置后再保存。'),{status:409});
    await settings.save({...payload,version});
    if(state.user!==user||state.store!==store)return false;
    return true;
  } catch(error) {
    if(state.user!==user||state.store!==store)return false;
    if(error.status===409&&error.message.includes('AI 服务配置')) {
      state.providersConflict=true;
      const feedback=form?.isConnected&&form.id==='provider-form'?$('#provider-feedback'):$('#provider-settings-feedback');
      if(feedback)feedback.innerHTML=providerConflictMarkup();
      if(form?.isConnected&&form.id!=='provider-form'&&form.closest('#modal')) {
        let notice=form.querySelector('[data-provider-conflict]');
        if(!notice){notice=document.createElement('div');notice.dataset.providerConflict='';form.prepend(notice);}notice.innerHTML=providerConflictMarkup();
      }
    }
    throw error;
  }
}
function showComputeUnavailable(message='无法连接计算服务器。请恢复网络后重试。') {
  suspendMotionView();
  $('#app').innerHTML=`<main class="content"><section class="card"><h1>等待计算服务器</h1><p>${esc(message)}</p><p>浏览器中的已保存记录仍保留，恢复连接后可以继续使用。</p><button type="button" class="button primary" id="retry-local-service">重新连接</button></section></main>`;
  $('#retry-local-service').addEventListener('click',()=>location.reload());
}
// Decorative movement rings use CSS only, with reduced-motion support.
function energyVisual() {
 return `<div class="energy-visual" aria-hidden="true"><div class="energy-orbit orbit-one"></div><div class="energy-orbit orbit-two"></div><div class="energy-orbit orbit-three"></div><div class="energy-core">${icon('spark')}</div><span class="energy-satellite satellite-lime">${icon('dumbbell')}</span><span class="energy-satellite satellite-coral">${icon('food')}</span><span class="energy-satellite satellite-white">${icon('body')}</span><span class="energy-caption">FIND YOUR FLOW</span></div>`;
}
function authFormMarkup() {
  const register=state.authMode==='register';
  return `<div class="auth-form"><div class="auth-welcome"><span></span> 你的循序空间</div><h2 id="landing-auth-heading" tabindex="-1">${register?'创建账号，开始记录':'欢迎回到循序'}</h2><p>保存你的训练计划、餐食记录和阶段变化。</p><div class="auth-tabs"><button data-action="auth-mode" data-mode="register" class="${register?'active':''}">创建账号</button><button data-action="auth-mode" data-mode="login" class="${!register?'active':''}">登录账号</button></div><form id="auth-form">${register?'<div class="field"><label for="name">怎么称呼你</label><input id="name" name="name" autocomplete="name" placeholder="你的名字" required maxlength="40"></div>':''}<div class="field"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="${register?'new-password':'current-password'}" placeholder="至少 8 位密码" minlength="8" maxlength="128" required></div><div id="auth-error"></div><button class="button primary" type="submit">${register?'创建账号，开始使用':'登录我的空间'} ${icon('arrow')}</button></form><p class="auth-hint">使用同一服务地址，可在电脑与手机间同步记录。</p></div>`;
}
function setWorkspaceTheme(active) {
  document.documentElement.dataset.theme=active?'workspace':'landing';
  document.querySelector('meta[name="theme-color"]').content=active?'#e4e6fa':'#5368ee';
}
function renderAuth() {
  closeMotionView();
  rememberCommunityReturn();
  setWorkspaceTheme(false);
  const panel=$('[data-auth-panel]');
  if(panel){
    const email=$('#email')?.value||'';
    const tabFocused=document.activeElement?.matches('.auth-tabs button');
    transitionView(panel,()=>{panel.innerHTML=authFormMarkup();});
    $('#email').value=email;
    if(tabFocused)$(`.auth-tabs [data-mode="${state.authMode}"]`).focus({preventScroll:true});
    return;
  }
  landingCleanup?.();
  $('#app').innerHTML=landingMarkup(authFormMarkup(),icon);
  landingCleanup=mountLanding($('.landing'),{onAuthRoute:mode=>{state.authMode=mode;renderAuth();}});
}

async function render() {
 closeAccountSettings();
 const version=navigationVersion;
 if(!communityOnlyPage()&&!await readyComputed())return;
 if(version!==navigationVersion)return;
  suspendMotionView();
  setWorkspaceTheme(true);
  if(landingCleanup){landingCleanup();landingCleanup=null;if(['#auth-entry','#auth-register'].includes(location.hash))history.replaceState(null,'',location.pathname+location.search);window.scrollTo(0,0);}
  captureChatDraft();
  const labels={chat:'AI 对话',nutrition:'今日饮食',training:'训练计划',library:'知识大全',motion:'动作评估',community:'社区',settings:'个人中心'};
  $('#app').innerHTML=`<div class="layout${state.sidebarCollapsed?' sidebar-collapsed':''}${state.page==='community'?' community-active':''}"><aside class="sidebar" id="sidebar"><div class="sidebar-header"><button type="button" class="sidebar-toggle icon-button" data-action="toggle-sidebar" aria-controls="sidebar" aria-expanded="${!state.sidebarCollapsed}" aria-label="${state.sidebarCollapsed?'展开侧边栏':'收起侧边栏'}" title="${state.sidebarCollapsed?'展开侧边栏':'收起侧边栏'}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM9 4v16m6-12-4 4 4 4"/></svg><span class="toggle-brand brand-symbol" aria-hidden="true"><img src="/assets/logo.svg" alt="" width="39" height="43"></span></button><button class="mobile-close icon-button" data-action="menu" aria-label="关闭导航">${icon('close')}</button><a class="brand" aria-label="循序 · AI 对话" title="循序 · AI 对话" href="#chat" data-action="nav" data-page="chat"><span class="brand-symbol" aria-hidden="true"><img src="/assets/logo.svg" alt="" width="39" height="43"></span><div><span class="brand-name">循序</span><small>AI FITNESS COMPANION</small></div></a></div><nav class="nav" aria-label="主导航">${[['chat','chat','AI 对话'],['nutrition','food','今日饮食'],['training','dumbbell','训练计划'],['library','grid','知识大全'],['motion','body','动作评估'],['community','community','社区'],['settings','settings','个人中心']].map(([id,i,label])=>`<button data-action="nav" data-page="${id}" aria-label="${label}" title="${label}" class="${state.page===id?'active':''}" ${state.page===id?'aria-current="page"':''}>${icon(i)}<span>${label}</span>${state.page===id?'<i class="nav-dot"></i>':''}</button>`).join('')}</nav><section class="history"><div class="section-label">最近对话<button class="link-button" data-action="new-chat" aria-label="新建对话">＋</button></div><div id="history-list"></div></section><div class="side-note"><span class="side-note-kicker">今日寄语 ${icon("spark")}</span><strong data-daily-quote-title></strong><span data-daily-quote-line="0"></span><br><span data-daily-quote-line="1"></span><div class="side-note-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="account"><a class="avatar account-settings-link" href="#settings?section=account" data-action="account-settings" data-account-avatar aria-label="修改头像和账号密码" title="账号与安全">${accountAvatarMarkup(state.user)}</a><a class="account-info account-settings-link" href="#settings?section=account" data-action="account-settings" aria-label="账号与安全"><strong>${esc(state.user.name||'我的空间')}</strong><small>${profile()?goalLabel(profile().goal)+'进行中':'开启健康生活'}</small></a><button class="icon-button" data-action="logout" aria-label="退出登录">${icon('logout')}</button></div></aside><main class="main"><header class="topbar"><div class="row"><button class="icon-button mobile-menu" data-action="menu" aria-label="打开导航">${icon('menu')}</button><div class="breadcrumb">我的健康空间<span>/</span><strong>${labels[state.page]}</strong></div></div><div class="top-right"><span class="date-label muted">${dateLabel(today())}</span><button id="sync-status" class="status" data-action="sync">已同步</button></div></header><div id="page" class="content"></div></main></div>`;
  updateSidebarQuote(); renderSidebarHistory(); updateSync(); await renderPage();
}
function updateSidebarQuote() {
  const card=$('.side-note'),now=new Date(),date=today(now);
  if(!card||card.dataset.quoteDate===date)return;
  const quote=getDailyQuote(now);
  $('[data-daily-quote-title]',card).textContent=quote.title;
  quote.lines.forEach((line,index)=>{$(`[data-daily-quote-line="${index}"]`,card).textContent=line;});
  card.dataset.quoteDate=date;
}
function updateSync() {
  const el=$('#sync-status'); if(!el||!state.store)return;
  const s=state.store; const labels={syncing:'正在同步',synced:s.pending.size?`${s.pending.size} 条待同步`:'已同步',offline:`离线 · ${s.pending.size} 条待同步`,expired:'登录已过期',conflict:`${s.conflicts.length} 项冲突`,idle:'本地已保存',error:'同步失败 · 点击重试'};
  el.textContent=labels[s.status]; el.classList.toggle('warn',['offline','expired','conflict','error'].includes(s.status));
}
function renderSidebarHistory() {
  const el=$('#history-list');if(!el)return;
  const html=state.store.conversationHeaders().slice(0,30).map(r=>`<div class="history-item ${r.id===state.conversation?'current':''}"><button data-action="open-chat" data-id="${esc(r.id)}">${esc(r.data.title)}</button><button class="delete" aria-label="删除对话 ${esc(r.data.title)}" data-action="delete-chat" data-id="${esc(r.id)}">×</button></div>`).join('') || '<div style="padding:5px 12px"><small>新的对话，从这里开始</small></div>';
  if(el._renderedMarkup!==html){el.innerHTML=html;el._renderedMarkup=html;}
}
async function renderPage({transition=true}={}) {
 const version=navigationVersion;
 if(!communityOnlyPage()&&!await readyComputed())return;
 if(version!==navigationVersion)return;
 const renderView=()=>{
 if(state.page!=='motion')suspendMotionView();
  if(state.page==='community'){
    if(!profile()){$('#page').innerHTML='<div class="empty" role="status">完成基本资料后，即可进入循序社区。</div>';return;}
    communityController ||= new CommunityController({getUser:()=>state.user,api,toast,navigate:communityNavigate,onProfileChange:updateAccountProfile,onProfileSettings:mountPersonalSettings});
    return communityController.mount($('#page')).catch(error=>toast(error.message,true));
  }
 if(!communityOnlyPage())ensureRecurringSchedule().catch(error=>toast(error.message,true));
  return ({chat:renderChat,nutrition:renderNutrition,training:renderTraining,library:renderLibrary,motion:renderMotion,settings:renderSettings}[state.page])();
 };
 return transition&&state.page!=='motion'?transitionView($('#page'),renderView):renderView();
}
function renderMotion() {
 const container=$('#page');
 if(motionView&&motionStore===state.store){
   if(motionRoot.parentNode!==container)container.replaceChildren(motionRoot);
   motionView.resume();void motionView.refreshHistory();return;
 }
 closeMotionView();motionStore=state.store;
 const store=state.store;
 motionView=mountMotionView(container,{
   saveAssessment:async data=>{
     if(state.store!==store)throw new Error('账号已切换，请重新分析视频。');
     validateMotionAssessmentSize(data);
     const id='motion:'+uid();await store.put('motion-assessment',id,data);return {id,data};
   },
   listAssessments:()=>store.list('motion-assessment'),
   deleteAssessment:async id=>{if(state.store!==store)throw new Error('账号已切换。');if(store.records.get(id)?.kind==='motion-assessment')await store.remove(id);},
   openExercise:showExercise,
   getCoachConfiguration:()=>{
     const provider=state.providers.find(item=>item.id===state.tasks.motion);
     const model=provider&&enabledModels(provider).find(item=>item.id===currentModel('motion'));
     return {configured:!!model,vision:model?.vision===true,model:model?.name||model?.id||'',provider:provider?.name||''};
   },
   reviewAssessment:async(payload,{signal,onProgress}={})=>{
     if(state.store!==store)throw new Error('账号已切换，请重新分析视频。');
     return streamMotionCoach(payload,{signal,onProgress});
   },
   openCoachSettings:()=>{state.setting='ai';void navigate('settings');},
   notify:toast,
 });
 motionRoot=container.querySelector('.motion-page');
}
function title(name,desc,actions='') { return `<div class="page-title"><div><h1>${name}</h1><p>${desc}</p></div>${actions}</div>`; }
function macros(current,target,compact=false) {
  return `<div class="macro-row">${[['protein','蛋白质',''],['carbs','碳水','carbs'],['fat','脂肪','fat']].map(([key,label,c])=>`<div><strong>${numeric(current[key])}<small> / ${numeric(target[key])} g</small></strong><div class="bar ${c}"><i style="width:${Math.min(100,(current[key]/target[key]||0)*100)}%"></i></div><small>${label}</small></div>`).join('')}</div>`;
}
function contextCards() {
 const t=totals(today()),n=nutrition(today()),s=scheduled(today()),p=plan(),d=s?.daySnapshot||p?.days.find(x=>x.id===s?.dayId);
 return `<aside class="chat-aside"><section class="card"><div class="context-date"><span class="live-dot"></span> TODAY’S BALANCE</div><div class="today-title"><h3>今日营养</h3><span class="badge">${dayType(today())==='rest'?'休息日':'训练日'}</span></div><div class="ring" style="--percent:${Math.min(100,(t.kcal/n.kcal||0)*100)}"><div><strong>${numeric(t.kcal)}</strong><small>/ ${numeric(n.kcal)} kcal</small></div></div>${n.error?`<div class="error-box">${esc(n.error)}</div>`:macros(t,n)}</section><section class="card today-training"><div class="context-date">MAKE YOUR MOVE</div><div class="card-head"><h3>今天怎么练</h3>${icon('dumbbell')}</div><div class="training-mini"><div class="mini-icon">${icon('dumbbell')}</div><div><strong>${esc(d?.name||'休息与恢复')}</strong><small>${s?.completed?'已完成今日训练':d?`${d.exercises.length} 个动作 · 按自己的节奏`:'当天没有训练安排'}</small></div></div><button class="link-button" data-action="nav" data-page="training">查看训练计划 ${icon('arrow')}</button></section><section class="tip-card"><strong>${icon('leaf')} 给今天的一点提醒</strong><p>先把动作做稳，再慢慢增加重量。每一组有质量的练习，都值得被记录。</p></section></aside>`;
}
function captureChatDraft() {
 const input=$('#chat-input');if(!input)return;
 const key=input.dataset.conversation||'';
 chatDrafts.set(key,{text:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,scrollTop:input.scrollTop,focused:document.activeElement===input});
 const body=$('.chat-body');if(body)chatScroll.set(key,{top:body.scrollTop,follow:body.dataset.follow!=='false'});
}
function selectConversation(id) {captureChatDraft();state.conversation=id;state.files=[];state.chatScene=state.store.get(id)?.scene||'';}
async function openMealChat() {
 selectConversation(null);state.chatScene='meal';
 await navigate('chat');
 $('#chat-input')?.focus({preventScroll:true});
}
function updateChatScene() {
 const input=$('#chat-input');if(!input)return;
 const meal=state.chatScene==='meal';
 input.placeholder=meal?'描述这一餐吃了什么、吃了多少，或上传餐食照片，我会分析营养和热量并记录…':'发送训练视频，AI 识别动作后由你确认并评价…';
 const scene=$('#chat-scene');
 if(scene){scene.hidden=!meal;scene.innerHTML=meal?`${icon('food')}<span>记录餐食 · 支持照片或文字</span><button type="button" class="icon-button" data-action="exit-meal-scene" aria-label="退出餐食记录模式">×</button>`:'';}
}
function resizeComposer(input=$('#chat-input')) {
 if(!input)return;input.style.height='auto';input.style.height=Math.min(168,Math.max(48,input.scrollHeight))+'px';input.style.overflowY=input.scrollHeight>168?'auto':'hidden';
}
let conversationCache;
function chatConversation() { if(chatRun?.id===state.conversation)return chatRun.conv;const record=state.store.records.get(state.conversation);if(conversationCache?.record!==record)conversationCache={record,value:state.store.get(state.conversation)};return conversationCache?.value; }
function chatGreeting() {
 return `<div class="greeting"><div class="greeting-copy"><div class="eyebrow"><span class="live-dot"></span> YOUR EVERYDAY UPGRADE</div><p class="greeting-hello">${esc(state.user.name||'你好')}，很高兴见到你。</p><h1>今天的你，<br><span>再进步一点。</span></h1><p>训练有方向，饮食有答案。<br>你的 AI 健身搭子，陪你找到自己的节奏。</p><div class="greeting-tags"><span>${icon('spark')} AI 随行</span><span>训练 · 饮食 · 成长</span></div></div>${energyVisual()}</div><div class="quick-heading"><div><span class="eyebrow">LET’S MAKE IT HAPPEN</span><h2>从这一刻开始</h2></div><span>选择一件今天想做的事 ${icon('arrow')}</span></div><div class="prompts">${[['dumbbell','帮我安排训练','量身规划，练出自己的节奏','training','01'],['image','拍照记录这一餐','拍一下，了解这一餐的营养','meal','02'],['body','看看动作怎么做','3D 动作演示，找到正确发力','library','03'],['leaf','回顾最近的进步','每一次坚持，都有迹可循','review','04']].map(([i,t,s,a,n])=>`<button class="prompt-card" data-action="quick" data-target="${a}"><span class="prompt-icon">${icon(i)}</span><span class="prompt-number" aria-hidden="true">${n}</span><strong>${t}</strong><small>${s}</small><span class="arrow">↗</span></button>`).join('')}</div>`;
}
function updateChatScroll(body=$('.chat-body')) {
 if(!body)return;
 body.dataset.lastTop=String(body.scrollTop);
 const latest=$('[data-action="chat-latest"]');if(latest)latest.hidden=!$('.messages',body)||body.scrollHeight-body.scrollTop-body.clientHeight<=2;
 chatScroll.set(state.conversation||'',{top:body.scrollTop,follow:body.dataset.follow!=='false'});
}
function chatFollows(body) {
 if(body.dataset.follow==='false')return false;
 // Scroll events arrive later than the actual offset, including scrollbar drags.
 if(body.scrollTop<Number(body.dataset.lastTop??body.scrollTop)-2){body.dataset.follow='false';return false;}
 return true;
}
function followChat(body=$('.chat-body')) {if(body&&$('.messages',body)){body.dataset.follow='true';body.scrollTop=body.scrollHeight;updateChatScroll(body);}}
function renderChatBody() {
 const body=$('.chat-body');if(!body)return;
 const follow=chatFollows(body),oldScroll=body.scrollTop;
 const conversation=chatConversation(),messages=conversation?.messages||[];
 if(!messages.length){if(!$('.greeting',body))body.innerHTML=chatGreeting();return;}
 let list=$('.messages',body);
 if(!list){body.innerHTML=`<div class="row spread chat-history-head"><span class="muted chat-title"></span>${button('新对话','new-chat','','small')}</div><div class="messages" role="log" aria-live="off" aria-label="对话消息"></div>`;list=$('.messages',body);}
 $('.chat-title',body).textContent=conversation.title;
 const keep=new Set(messages.map(message=>message.id)),nodes=new Map([...list.children].map(node=>[node.dataset.messageId,node]));
 for(const node of [...list.children])if(!keep.has(node.dataset.messageId))node.remove();
 for(const message of messages){
   let node=nodes.get(message.id);
   if(!node){list.insertAdjacentHTML('beforeend',renderMessage(message));}
   else patchHTML($('.bubble',node),messageBubble(message));
 }
 body.scrollTop=follow?body.scrollHeight:oldScroll;updateChatScroll(body);
}
function updateChatControls() {
 const actions=$('#chat-send-actions');if(!actions)return;
 const entries=chatUploads.list(attachmentOwner()),blocked=entries.some(entry=>entry.status!=='ready'),hasContent=$('#chat-input')?.value.trim()||entries.length;
 patchHTML(actions,chatRun?`${chatRun.id!==state.conversation?'<small class="muted">另一段对话正在回复</small>':''}<button type="button" class="button small stop-generation" data-action="stop-chat" aria-label="停止生成">■ 停止生成</button>`:`<button type="submit" class="send" aria-label="发送消息" ${blocked||!hasContent?'disabled':''} title="${blocked?'请等待上传完成，或重试 / 移除失败附件':'发送消息'}">${icon('send')}</button>`);
 const feedback=$('#chat-upload-status');if(feedback)feedback.textContent=entries.some(entry=>entry.status==='uploading')?'附件正在准备，完成后即可发送。':blocked?'附件准备失败，请重试或移除后再发送。':entries.some(entry=>entry.type.startsWith('video/'))?'原视频留在本机，AI 接收骨架与关键画面。刷新后重新评估需再添加视频，已保存报告可继续查看。':'';
}
function addChatFiles(files,owner=attachmentOwner()) {
 if(!files.length||!state.user||!owner.startsWith(state.user.id+':'))return;
 const result=chatUploads.add(owner,files);for(const error of result.errors)toast(error,true);
}
function renderChatFiles() {
 const list=$('#chat-files');if(!list||!state.user)return;
 const entries=chatUploads.list(attachmentOwner());
 patchHTML(list,entries.map(entry=>{
   const image=entry.type.startsWith('image/'),localVideo=entry.type.startsWith('video/'),url=entry.previewUrl||entry.attachment?.url;
   return `<div class="chat-file-card ${image?'image-file':''}" data-upload-id="${esc(entry.id)}" data-status="${entry.status}">${image&&url?`<button type="button" class="chat-file-thumb" data-action="preview-image" data-url="${esc(url)}" data-name="${esc(entry.name)}" aria-label="预览 ${esc(entry.name)}"><img src="${esc(url)}" alt="${esc(entry.name)}"></button>`:`<span class="chat-file-symbol">${icon('clip')}</span>`}<div class="chat-file-info"><strong title="${esc(entry.name)}">${esc(entry.name)}</strong><small>${formatFileSize(entry.size)} · ${entry.status==='uploading'?'上传中…':entry.status==='error'?'准备失败':localVideo?'本机视频 · 已就绪':'已就绪'}</small>${entry.error?`<span class="chat-file-error">${esc(entry.error)}</span>`:''}<div class="chat-file-actions">${entry.status==='error'?button('重试','retry-upload',`data-id="${esc(entry.id)}"`,'small'):''}${image&&url?button('复制图片','copy-image',`data-url="${esc(url)}"`,'small'):''}</div></div><button class="chat-file-remove" type="button" data-action="remove-file" data-id="${esc(entry.id)}" aria-label="移除 ${esc(entry.name)}">×</button></div>`;
 }).join(''));
 updateChatControls();
}
function bindChatInteractions() {
 const input=$('#chat-input'),main=$('.chat-main'),body=$('.chat-body'),form=$('#chat-form');
 composerObserver?.disconnect();composerObserver=new ResizeObserver(()=>{if(!main.isConnected)return;main.style.setProperty('--composer-height',form.offsetHeight+'px');if(chatFollows(body))followChat(body);});composerObserver.observe(form);
 input.addEventListener('paste',event=>{
   const files=filesFromTransfer(event.clipboardData);if(!files.length)return;
   event.preventDefault();addChatFiles(files);
   const text=event.clipboardData.getData('text/plain');
   if(text){const available=Math.max(0,input.maxLength-input.value.length+input.selectionEnd-input.selectionStart);input.setRangeText(text.slice(0,available),input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));if(text.length>available)toast('文字已达到 16000 字上限，超出的部分未粘贴。',true);}
 });
 let dragDepth=0;
 const hasFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
 main.addEventListener('dragenter',event=>{if(!hasFiles(event))return;event.preventDefault();dragDepth++;main.classList.add('is-dragging');});
 main.addEventListener('dragover',event=>{if(hasFiles(event)){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
 main.addEventListener('dragleave',event=>{if(!hasFiles(event))return;if(--dragDepth<=0){dragDepth=0;main.classList.remove('is-dragging');}});
 main.addEventListener('drop',event=>{if(!hasFiles(event))return;event.preventDefault();dragDepth=0;main.classList.remove('is-dragging');addChatFiles(filesFromTransfer(event.dataTransfer));});
 body.addEventListener('scroll',()=>{body.dataset.follow=String(body.scrollHeight-body.scrollTop-body.clientHeight<=2);updateChatScroll(body);},{passive:true});
 body.addEventListener('wheel',event=>{if(event.deltaY<0)body.dataset.follow='false';},{passive:true});
 body.addEventListener('keydown',event=>{if(['PageUp','Home','ArrowUp'].includes(event.key))body.dataset.follow='false';});
 body.addEventListener('touchmove',()=>{body.dataset.follow='false';},{passive:true});
 body.addEventListener('load',()=>{if(chatFollows(body))followChat(body);},true);
}
function renderChat() {
 const key=state.conversation||'';
 const existing=$('#chat-input');
 if(existing&&existing.dataset.conversation===key) {
   renderChatBody();renderChatFiles();updateChatScene();const aside=$('.chat-aside');if(aside)aside.outerHTML=contextCards();return;
 }
 captureChatDraft();
 $('#page').innerHTML=`<div class="chat-layout"><section class="chat-main"><div class="chat-body" tabindex="0" aria-label="对话记录"></div><button type="button" class="chat-latest" data-action="chat-latest" hidden>↓ 回到最新</button><div class="chat-drop-overlay" aria-hidden="true">${icon('clip')}松开以添加图片、视频或文件</div><form id="chat-form" class="composer"><div class="composer-box"><div id="chat-scene" class="chat-scene" hidden></div><div class="attachments" id="chat-files"></div><label class="sr-only" for="chat-input">给健身助手发送消息</label><textarea id="chat-input" data-conversation="${esc(key)}" name="message" placeholder="发送训练视频，AI 识别动作后由你确认并评价…" rows="2" maxlength="16000"></textarea><div class="composer-tools"><div class="row"><button class="icon-button" type="button" data-action="attach" aria-label="上传图片、视频或文件">${icon('clip')}</button><button class="icon-button" type="button" data-action="camera" aria-label="拍照上传">${icon('image')}</button><span class="composer-model">${esc(currentModel('chat')||'在设置中连接 AI 模型')}</span></div><div id="chat-send-actions" class="row"></div></div><div id="chat-upload-status" class="chat-upload-status" role="status"></div></div><p class="composer-note">支持图片、训练视频和文件 · 最多 6 个；视频 200 MB / 2 分钟，其他附件 8 MB。AI 先识别动作，由你确认后再评价。</p></form></section>${contextCards()}</div>`;
 const input=$('#chat-input'),draft=chatDrafts.get(key);input.value=draft?.text||'';resizeComposer(input);
 if(draft){input.setSelectionRange(draft.start,draft.end,draft.direction);input.scrollTop=draft.scrollTop;if(draft.focused&&!$('#modal').open)input.focus({preventScroll:true});}
 let composing=false;
 input.addEventListener('compositionstart',()=>{composing=true;});
 input.addEventListener('compositionend',()=>{composing=false;captureChatDraft();resizeComposer(input);updateChatControls();});
 input.addEventListener('input',()=>{captureChatDraft();resizeComposer(input);updateChatControls();});
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();if(!chatRun)$('#chat-form').requestSubmit();}});
 const body=$('.chat-body'),position=chatScroll.get(key);body.dataset.follow=String(position?.follow!==false);
 renderChatBody();if(position?.follow===false)body.scrollTop=position.top;
 bindChatInteractions();renderChatFiles();updateChatScroll();updateChatScene();
}
function currentModel(task) { return state.taskModels[task] ?? state.providers.find(p=>p.id===state.tasks[task])?.model; }
function formatFileSize(size) {return size>=1024*1024?`${(size/1024/1024).toFixed(1)} MB`:size>=1024?`${Math.ceil(size/1024)} KB`:`${size||0} B`;}
function renderAttachments(files,removable=false,scope='chat') {
 if(scope==='meal')return files.map((f,i)=>`<span class="attachment">${icon(f.type?.startsWith('image/')?'image':'clip')}${f.url?`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`:esc(f.name)}${removable?`<button data-action="remove-meal-file" data-index="${i}" type="button" aria-label="移除 ${esc(f.name)}">×</button>`:''}</span>`).join('');
 return files.map(f=>f.type?.startsWith('image/')&&f.url?`<div class="message-attachment-image"><button type="button" data-action="preview-image" data-url="${esc(f.url)}" data-name="${esc(f.name)}" aria-label="预览 ${esc(f.name)}"><img class="message-image" src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></button><div><small>${esc(f.name)}${f.size?' · '+formatFileSize(f.size):''}</small>${button('复制图片','copy-image',`data-url="${esc(f.url)}"`,'small')}</div></div>`:`<span class="attachment">${icon('clip')}${f.url?`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`:esc(f.name)}${f.size?`<small>${formatFileSize(f.size)}</small>`:''}</span>`).join('');
}
function messageVisuals(message) {
 return chatVisuals(message);
}
function renderVisualCard(visual,preview=true) {
 return `<article class="visual-card" data-visual-type="${esc(visual.type)}" data-visual-id="${esc(visual.id)}"><header><span>${icon('body')}${visual.type==='muscle'?'肌肉位置':'3D 动作'}</span><strong>${esc(visual.title)}</strong></header>${preview?`<iframe class="chat-model-frame" src="${esc(modelUrl(visual.type,visual.id,{compact:true}))}" title="${esc(visual.title)}3D 示意" loading="lazy" allow="fullscreen"></iframe>`:'<div class="visual-placeholder">'+icon('body')+'<span>打开 3D 查看位置与动作</span></div>'}<footer>${button('打开完整 3D ↗','open-visual',`data-type="${esc(visual.type)}" data-id="${esc(visual.id)}"`,'small')}</footer></article>`;
}
function messageBubble(m,skipText=false) {
 const text=String(m.content||''),assistant=m.role==='assistant',streaming=assistant&&m.streaming&&chatRun?.message.id===m.id;
 const visuals=assistant?messageVisuals(m):[],preview=assistant&&(chatConversation()?.messages||[]).filter(message=>message.role==='assistant').slice(-2).some(message=>message.id===m.id);
 const references=assistant&&!streaming?findKnowledge(text):[];
 const incomplete=assistant&&m.streaming&&!streaming,last=chatConversation()?.messages.at(-1)?.id===m.id;
 return `<div class="message-text ${assistant?'markdown-body':''}">${skipText?'':assistant?renderMarkdown(text):esc(text)}</div><div class="message-progress">${streaming?`<div class="stream-status" role="status">${esc(chatRun?.message===m&&chatRun.progress?chatRun.progress:text?'正在生成…':'正在思考你的问题…')}</div>`:''}</div><div class="message-attachments">${(m.attachments?.length||m.motionVideos?.length)?renderAttachments([...(m.attachments||[]),...(m.motionVideos||[])]):''}</div><div class="tool-results">${(m.toolResults||[]).map(result=>result.name==='assess_motion_video'?renderChatMotionResult(result):['web_search','read_web_page'].includes(result.name)?renderWebResult(result):`<div class="tool-result ${result.ok?'success':'failed'}" role="status"><strong>${result.presentation?(result.ok?'✓ 展示已更新':'展示未完成'):result.readOnly?(result.ok?'✓ 已读取':'读取未完成'):(result.ok?'✓ 已执行':'操作未完成')}</strong><span>${esc(result.message||result.name||'训练计划操作')}</span></div>`).join('')}</div><div class="message-visuals">${visuals.map(visual=>renderVisualCard(visual,preview)).join('')}</div><div class="message-references">${references.length?`<div class="message-meta">${references.map(k=>button(icon('leaf')+' '+esc(k.title),'knowledge',`data-id="${k.id}"`,'small')).join('')}</div>`:''}</div><div class="message-errors">${m.error||m.stopped||incomplete?`<div class="${m.error?'error-box':'notice'} chat-message-status">${esc(m.error|| (m.stopped?'已停止生成，已保留收到的内容。':'上次回复未完成，已保留收到的内容。'))} ${last&&!chatRun?button('重试回答','retry-chat',`data-id="${esc(m.id)}"`,'small'):''}</div>`:''}</div><div class="message-footer"><small>${m.model?esc(m.model)+' · ':''}${new Date(m.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</small><div class="message-actions">${text?button('复制','copy-message',`data-id="${esc(m.id)}" aria-label="复制消息"`,'small'):''}${assistant&&last&&!chatRun&&!m.error&&!m.stopped&&!incomplete?button('重新生成','retry-chat',`data-id="${esc(m.id)}"`,'small'):''}</div></div>`;
}
function renderMessage(m) {return `<div class="message ${m.role==='user'?'user':'assistant'}" data-message-id="${esc(m.id)}"><div class="message-icon">${m.role==='user'?esc(state.user.name?.slice(0,1)||'我'):'<img class="assistant-logo" src="/assets/logo.svg" alt="循序 AI" width="30" height="30">'}</div><div class="bubble">${messageBubble(m)}</div></div>`;}
function paintChatRun(run) {
 if(state.store!==run.store||state.page!=='chat'||state.conversation!==run.id)return;
 const body=$('.chat-body'),node=$(`[data-message-id="${run.message.id}"] .bubble`);if(!body||!node)return;
 const follow=chatFollows(body),oldScroll=body.scrollTop;
 const template=document.createElement('template');template.innerHTML=messageBubble(run.message,true);
 for(const incoming of template.content.children){if(incoming.classList.contains('message-text'))continue;const current=node.querySelector('.'+incoming.classList[0]);if(current)patchHTML(current,incoming.innerHTML);}
 renderMarkdownInto(node.querySelector('.message-text'),run.message.content||'');body.scrollTop=follow?body.scrollHeight:oldScroll;updateChatScroll(body);
}
function scheduleChatPaint(run) {
 if(run.paint)return;run.paint=setTimeout(()=>{run.paint=null;paintChatRun(run);},60);
}
async function saveChatRun(run) {
 if(run.store.closed||run.discard)return;
 // A deleted conversation must never be resurrected by a late network event.
 if(!run.store.get(run.id))return;
 await run.store.put('conversation',run.id,run.conv,false,{sync:!run.message.streaming});
}
function queueChatSave(run) {
 if(run.saveTimer)return;run.saveTimer=setTimeout(()=>{run.saveTimer=null;saveChatRun(run).catch(()=>{});},800);
}
async function stopChat({discard=false}={}) {
 const run=chatRun;if(!run)return;run.discard=discard;run.message.stopped=true;run.controller.abort();await run.finished;
}
function mealChatInstruction(intent) {
 if(!intent)return '';
 return `【餐食记录场景】用户通过“记录餐食”入口提交下方文字或照片，意图是分析本次实际吃下的食物并保存饮食记录。不划分早餐、午餐、晚餐或加餐，只保存记录时间。先读取 get_today_meals，识别食物、份量与营养后调用 create_meal 保存；若是在补充或更正同一餐，使用 update_meal 避免重复入账。数量或食物身份不清时先追问。仅在工具成功后说明已记录，并展示热量和营养估算；如果用户是在咨询、表示尚未吃或取消记录，则按其明确意思回答，不入账。\n用户描述：\n`;
}
async function prepareChatMotion(run, data) {
 const signal=run.controller.signal;
 if(!data||typeof data.jobId!=='string'||!/^[\w-]{16,100}$/.test(data.jobId))throw new Error('动作评估任务编号无效，请重试。');
 const current=()=>state.store===run.store&&!run.discard&&!signal.aborted;
 if(!current())return;
 run.motionJobs ||= new Set();
 if(run.motionJobs.has(data.jobId))return;
 run.motionJobs.add(data.jobId);
 const submit=body=>api('/chat/motion/'+data.jobId,{method:'POST',headers:{'X-Fitness-User':run.userId},signal,body});
 let input;
 try {
   if(!run.motionVideoIds.has(data.videoId))throw new Error('这段视频不在当前对话中，请重新添加视频。');
   input=await chatMotionVideos.prepare(data.videoId,null,{signal,poseModel:data.poseModel,onProgress:progress=>{
     if(current()){run.progress=progress.message||'正在分析训练视频…';scheduleChatPaint(run);}
   }});
   if(!current())return;
   run.progress='AI 正在识别视频中的动作…';scheduleChatPaint(run);
   let recognition;
   try {
     recognition=await streamMotionCoach(input,{userId:run.userId,signal,onProgress:progress=>{
       if(current()){run.progress=progress.message||'AI 正在识别动作…';scheduleChatPaint(run);}
     }});
   } catch(error) { if(signal.aborted)throw error; recognition=null; }
   if(!current())return;
   run.progress='请确认视频中的动作，确认后开始评价。';scheduleChatPaint(run);
   const selectedExerciseId=await confirmChatMotionAction(recognition,{signal,videoName:chatMotionVideos.get(data.videoId)?.name||'',
     canShow:()=>current()&&state.page==='chat'&&state.conversation===run.id});
   input={...input,reviewMode:'guided',selectedExerciseId,actionConfirmed:true};
 } catch(error) {
   if(!current())return;
   await submit({error:String(error.message||'无法读取训练视频，请重新添加。').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,500)});
   return;
 }
 if(!current())return;
 run.progress='正在将动作数据交给 AI 评价…';scheduleChatPaint(run);
 await submit({input});
}
async function sendChat(text,retryId=null) {
 if(!await readyComputed())return;
 if(chatRun)return;
 const store=state.store,user=state.user;
 const owner=attachmentOwner(),attachments=retryId?[]:chatUploads.ready(owner);
 const id=state.conversation||uid(),conv=structuredClone(store.get(id)||{title:text.slice(0,22)||'图片与文件提问',messages:[]});
 let message=retryId?conv.messages.find(m=>m.id===retryId):null;
 if(retryId&&(!message||message.role!=='assistant'))return;
 if(retryId&&conv.messages.at(-1)?.id!==retryId)throw new Error('只能重试最近一条回答，请在当前对话继续提问。');
 const outgoing=retryId?conv.messages.slice(0,conv.messages.indexOf(message)):[...conv.messages];
 if(!retryId&&state.chatScene==='meal')conv.scene='meal';
 if(!retryId){const userMessage={id:uid(),role:'user',content:text||'请帮我分析附件。',attachments:attachments.filter(file=>!file.localVideo),motionVideos:attachments.filter(file=>file.localVideo).map(({id,name,type,size})=>({id,name,type,size})),createdAt:new Date().toISOString()};if(state.chatScene==='meal')userMessage.mealIntent={createdAt:userMessage.createdAt};outgoing.push(userMessage);conv.messages.push(userMessage);}
 const requestId=message?.requestId||uid();
 message=message||{id:uid(),role:'assistant',content:'',createdAt:new Date().toISOString()};
 Object.assign(message,{content:'',requestId,streaming:true,error:null,stopped:false,toolResults:(message.toolResults||[]).filter(result=>!['set_chat_visuals','web_search','read_web_page'].includes(result.name))});
 if(!retryId)conv.messages.push(message);
 const controller=new AbortController(),run={id,conv,message,store,userId:user.id,controller,discard:false,motionTasks:new Set(),motionVideoIds:new Set(outgoing.flatMap(m=>m.motionVideos||[]).map(video=>video.id))};
 let finish;run.finished=new Promise(resolve=>{finish=resolve;});chatRun=run;state.busy=true;
 if(!retryId){captureChatDraft();chatDrafts.delete(state.conversation||'');chatUploads.takeReady(owner);state.files=[];const input=$('#chat-input');if(input){input.value='';input.dataset.conversation=id;resizeComposer(input);}state.conversation=id;}
 try {
   await store.put('conversation',id,conv);if(state.store!==store||controller.signal.aborted)return;
   if(state.page==='chat'&&state.conversation===id){renderChat();followChat();}
   await store.sync();controller.signal.throwIfAborted();
   const aiRelevant=record=>record&&(['plan','calendar-task','schedule','training-cycle','calendar-settings','meal','phase','nutrition-feedback-settings'].includes(record.kind)||['active-plan','profile','preferences'].includes(record.id));
   if([...store.pending.values()].some(aiRelevant)||store.conflicts.some(c=>aiRelevant(store.records.get(c.id))||aiRelevant(c.server)||aiRelevant(c.local)))throw new Error('个人资料、日程、训练计划或饮食还有待同步或冲突的本机修改。请先在「个人中心 → 我的主页 → 设置」处理后重试。');
   if(store.status==='offline')throw new Error('当前离线，消息已保存在本机。联网后可以重试。');
   const response=await streamChat({requestId,conversationId:id,messages:outgoing.filter(m=>!m.error&&!m.stopped).slice(-80).map(({id,role,content,attachments,motionVideos,reasoningContent,toolResults,mealIntent})=>({id,role,content:mealChatInstruction(mealIntent)+(mealIntent?mealDishInstruction+'\n'+mealCategoryInstruction+'\n':'')+content+(role==='assistant'&&toolResults?.some(r=>r.name==='set_chat_visuals'&&r.ok)?'\n[本条回答的3D展示] '+JSON.stringify(chatVisuals({toolResults}).map(({type,id})=>({type,id}))):'')+(role==='assistant'&&toolResults?.some(r=>r.name==='assess_motion_video'&&r.ok)?'\n[已完成的动作评估] '+JSON.stringify(toolResults.filter(r=>r.name==='assess_motion_video'&&r.ok).map(compactChatMotionResult)):'')+(role==='assistant'&&toolResults?.some(r=>!r.readOnly)?'\n[已执行操作回执]\n'+toolResults.filter(r=>!r.readOnly).map(r=>r.message||r.name).join('\n'):''),attachments,motionVideos,reasoningContent})),context:{date:state.date,localToday:today(),timezoneOffset:new Date().getTimezoneOffset()}}, {
     userId:user.id,signal:controller.signal,onEvent:async(type,data)=>{
       if(state.store!==store||run.discard||controller.signal.aborted)return;
       if(type==='meta'){message.model=data.model;message.provider=data.provider;}
       if(type==='delta'){message.content+=data.text||'';run.progress='';}
       if(type==='tool_start')run.progress=data.message||'正在处理…';
       if(type==='motion_request'){
         // Keep consuming the stream while local inference runs, so a server
         // error or disconnect can immediately cancel video decoding as well.
         const task=prepareChatMotion(run,data).catch(error=>{if(!controller.signal.aborted){run.motionError=error;controller.abort();}}).finally(()=>run.motionTasks.delete(task));
         run.motionTasks.add(task);return;
       }
       if(type==='motion_progress')run.progress=data.message||'AI 正在评价动作…';
       if(type==='tool_result'){
         run.progress='正在整理回答…';
         data=compactChatMotionResult(data);
         const motionIndex=data.name==='assess_motion_video'&&data.reportId?message.toolResults.findIndex(r=>r.name===data.name&&r.reportId===data.reportId):-1;
         if(motionIndex>=0)message.toolResults[motionIndex]=data;
         else if(data.presentation||!message.toolResults.some(r=>JSON.stringify(r)===JSON.stringify(data)))message.toolResults.push(data);
         if(!data.readOnly||data.name==='assess_motion_video'&&data.ok)run.toolSync=(run.toolSync||Promise.resolve()).then(()=>store.sync()).then(()=>{
           if(state.store!==store)return;
           if(state.page==='training'&&!$('#modal').open)renderTraining();
           if(state.page==='nutrition'&&!$('#modal').open)renderNutrition();
           if(state.page==='chat'){const aside=$('.chat-aside');if(aside)aside.outerHTML=contextCards();}
         }).catch(error=>{run.syncError=error.message;});
       }
       scheduleChatPaint(run);queueChatSave(run);
     }
   });
   message.content=response.content??message.content;message.model=response.model||message.model;message.provider=response.provider||message.provider;
   if(response.reasoningContent)message.reasoningContent=response.reasoningContent;
   if(response.toolResults?.length)message.toolResults=response.toolResults.map(compactChatMotionResult);
   if(message.toolResults.some(r=>!r.readOnly||r.name==='assess_motion_video'&&r.ok))await store.sync().catch(error=>{run.syncError=error.message;});
   await run.toolSync;
   if(run.syncError)message.error='回答已完成，但记录同步暂未完成：'+run.syncError+'。请点击顶部同步状态重试。';
 } catch(error) {
   if(run.motionError)message.error=run.motionError.message;else if(controller.signal.aborted)message.stopped=true;else message.error=error.message;
 } finally {
   if(run.motionTasks.size){controller.abort();await Promise.allSettled([...run.motionTasks]);}
   message.streaming=false;clearTimeout(run.saveTimer);clearTimeout(run.paint);
   await saveChatRun(run).catch(error=>{if(state.store===store)toast('回复暂未保存：'+error.message,true);});
   if(chatRun===run){chatRun=null;state.busy=false;}
   if(state.store===store){paintChatRun(run);updateChatControls();renderSidebarHistory();}
   finish();
 }
}

function aiContext() {
 const all=allCalendarTasks(),now=today(),end=addDays(now,28),visibleDates=new Set(weekDates(state.date));
 const relevant=date=>date>=now&&date<=end||visibleDates.has(date);
 const nearby=all.filter(r=>relevant(r.data.date));
 const calendar=nearby.slice(0,200).map(({id,version,data})=>({id,version,data:Object.fromEntries(['taskType','title','date','completed','dayId','planVersion'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]]))}));
 return {knowledge:knowledgeCards,profile:profile(),plan:plan(),nutrition:nutrition(now),date:state.date,localToday:now,timezoneOffset:new Date().getTimezoneOffset(),calendar,busyDates:getBusyDates(now,addDays(now,28)),calendarTruncated:nearby.length>calendar.length,meals:records('meal').slice(0,35).map(r=>({...r.data,id:r.id,version:r.version})),training:all.filter(r=>r.data.date<=now).sort((a,b)=>b.data.date.localeCompare(a.data.date)).slice(0,20).map(({id,version,data})=>({id,version,...Object.fromEntries(['taskType','title','date','completed','dayId','daySnapshot','planVersion','actual','notes','completedAt'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]]))})),phases:records('phase').slice(0,10).map(r=>r.data),exerciseCatalog:exercises.map(({id,name,muscle,cues,source})=>({id,name,muscle,cues,source}))};
}

function nutritionStats(n,t) {return `${[['kcal','能量','kcal'],['protein','蛋白质','g'],['carbs','碳水化合物','g'],['fat','脂肪','g']].map(([k,l,u])=>`<div class="stat"><small>${l}</small><strong>${numeric(t[k])}<em>/ ${numeric(n[k])} ${u}</em></strong><div class="bar ${k}"><i style="width:${Math.min(100,t[k]/n[k]*100||0)}%"></i></div><p>${t[k]>n[k]?'已超出':'还可摄入'} ${numeric(Math.abs(n[k]-t[k]))} ${u}</p></div>`).join('')}`;}
const adviceCache = new Map();
const adviceInFlight = new Map();
let adviceMode = 'brief';
function adviceMealFingerprint(date,store=state.store) {
 return JSON.stringify(store.list('meal').filter(r=>r.data.date===date&&r.data.confirmed).map(r=>r.id).sort());
}
function adviceSnapshot() {
 const n=nutrition(),date=state.date;
 const context=computed.advice[date];
 const fingerprint=adviceMealFingerprint(date);
 return {context,fingerprint,recordId:'nutrition-advice:'+date,key:JSON.stringify({user:state.user.id,date}),error:n.error};
}
function savedNutritionAdvice(snapshot) {
 const cached=adviceCache.get(snapshot.key);if(cached)return cached;
 const saved=computed.savedAdvice?.[snapshot.recordId];
 if(saved&&['ready','error'].includes(saved.status))return saved;
 return null;
}
function nutritionAdvice(n) {
 const snapshot=adviceSnapshot(),entry=savedNutritionAdvice(snapshot);
 const configured=!!state.tasks.planning;
 return `<div class="card-head"><div><span class="eyebrow">DAILY BALANCE</span><h3>这一天的营养建议</h3></div>${icon('leaf')}</div><div class="nutrition-panel-scroll" tabindex="0" role="region" aria-label="营养建议，可上下滚动"><div class="advice-tabs" role="group" aria-label="营养建议分类">${[['brief','用餐建议'],['detailed','饮食分析']].map(([mode,label])=>`<button type="button" data-action="advice-mode" data-mode="${mode}" aria-pressed="${adviceMode===mode}" class="${adviceMode===mode?'active':''}">${label}</button>`).join('')}</div>${n.error?'':adviceBalanceCards(snapshot.context.balance)}<div class="advice-result" aria-live="polite">${n.error?`<div class="error-box">${esc(n.error)}</div>`:!configured?`<p class="muted">连接规划建议模型后，即可生成营养建议。</p>${button('配置 AI 模型','advice-settings','','small')}`:entry?.data?`${adviceContentCards(entry.data[adviceMode],adviceMode,entry.timing)}<small class="advice-estimate-label">根据上次生成时的饮食记录估算</small>${entry.balance?.kcal?.target!==snapshot.context.balance.kcal.target?'<p class="muted">营养目标已改变，请点击“更新建议”重新生成。</p>':''}`:entry?.status==='error'?`<div class="error-box">${esc(entry.error)}</div>`:`<p class="muted" role="status">${entry?.status==='loading'?'正在结合这一天的饮食生成建议…':'点击“更新建议”生成用餐建议。'}</p>`}</div>${entry?.data&&entry.status==='error'?`<p class="error-box">${esc(entry.error)}<br>\u5df2\u4fdd\u7559\u4e0a\u6b21\u5efa\u8bae\u3002</p>`:''}${configured&&!n.error?`<div class="form-footer">${button(entry?.status==='loading'?'更新中…':'更新建议','advice-refresh',entry?.status==='loading'?'disabled':'','small subtle')}</div>`:''}<details class="advice-basis"><summary>查看营养目标依据</summary><p>基础代谢 ${numeric(n.bmr)} kcal · 预计每日总消耗 ${numeric(n.tdee)} kcal</p><small>${esc(n.explanation||'结合个人资料与当天训练估算。')}</small></details></div>`;
}
async function paintNutritionAdvice() {
 if(!await readyComputed())return;
 const el=$('#nutrition-advice');if(el&&state.page==='nutrition')patchHTML(el,nutritionAdvice(nutrition()));
}
async function loadNutritionAdvice() {
 if(!await readyComputed())return;
 if(state.page!=='nutrition'||!state.tasks.planning)return;
 const snapshot=adviceSnapshot(),{key,context,error,fingerprint,recordId}=snapshot;if(error)return;
 const existing=savedNutritionAdvice(snapshot);if(existing?.status==='loading')return;
 const store=state.store;
 const userId=state.user.id;
 const flightKey=JSON.stringify([userId,context.date]);
 if(adviceInFlight.has(flightKey))return;
 adviceInFlight.set(flightKey,true);
 const startedAt=performance.now();
 adviceCache.set(key,{...existing,status:'loading',error:null});paintNutritionAdvice();
 try {
   const prompt=dailyMealAdvicePrompt;
   const response=await api('/ai',{method:'POST',body:{task:'planning',messages:[{role:'user',content:prompt}],context}});
   if(state.store!==store)return;
   const entry={status:'ready',data:await calculate('parseNutritionAdvice',response.content,context.mealTiming),fingerprint,balance:context.balance,timing:context.mealTiming,generatedAt:new Date().toISOString(),generationMs:Math.round(performance.now()-startedAt),providerTiming:response.timing};
   await store.put('nutrition-advice',recordId,entry);
   adviceCache.set(key,entry);
 }catch(error){
   if(state.store===store){
     const entry={...existing,status:'error',error:error.message,fingerprint};
     adviceCache.set(key,entry);
     if(!existing?.data)await store.put('nutrition-advice',recordId,entry).catch(()=>{});
   }
 }
 finally{
   adviceInFlight.delete(flightKey);
   if(adviceCache.get(key)?.status==='loading')adviceCache.delete(key);
   if(state.user?.id===userId){
     paintNutritionAdvice();
   }
 }
}

async function refreshNutritionSummary() {
 if(!await readyComputed())return;
 const badge=$('#day-type');if(!badge)return;
 const type=dayType(state.date),n=nutrition(),t=totals(state.date);
 badge.dataset.type=type;badge.classList.toggle('neutral',type==='rest');badge.textContent=type==='training'?'训练日':'休息日';
 const stats=$('.stats'),advice=$('#nutrition-advice');
 if(stats)patchHTML(stats,nutritionStats(n,t));
 if(advice)patchHTML(advice,nutritionAdvice(n));
 const feedback=$('#nutrition-feedback');if(feedback)patchHTML(feedback,nutritionFeedbackView(computed.nutritionFeedbackByDate?.[state.date],n,state.date<today()));
}
function scheduleFingerprint() {return JSON.stringify({tasks:allCalendarTasks().map(({id,data})=>({id,data})),plan:plan(),cycle:state.store?.get('calendar-cycle'),busy:state.store?.get('calendar-busy-days'),profile:profile(),phases:records('phase'),feedbackSettings:records('nutrition-feedback-settings'),meals:records('meal').map(({id,data})=>({id,data})),preferences:state.store?.get('preferences'),achievements:records('achievement'),templates:records('training-template')});}
function refreshScheduleViews() {
 if(!$('#page'))return;
 ensureRecurringSchedule().catch(error=>toast(error.message,true));
 const fingerprint=scheduleFingerprint();if(fingerprint===state.scheduleFingerprint)return;
 state.scheduleFingerprint=fingerprint;
 const libraryCount=$('.plan-library-entry .plan-library-count');if(libraryCount)libraryCount.textContent=records('training-template').length;
 // Update only dependent nutrition panels, including while a meal form is open.
 if(state.page==='nutrition')refreshNutritionSummary();
 if(state.page==='training'){
   if($('#modal').open)state.scheduleRefreshPending=true;
   else renderTraining();
 }
 if(state.page==='settings'&&state.setting==='achievements')renderAchievements();
 if(state.page==='chat'){const aside=$('.chat-aside');if(aside)aside.outerHTML=contextCards();}
}

function selectNutritionDate(date) {
 if(date===state.date)return;
 const oldDate=state.date;
 state.date=date;
 renderNutrition();
 const strip=$('.nutrition-date-strip'),buttons=[...strip.querySelectorAll('.nutrition-day')];
 const days=Math.round((new Date(date+'T12:00:00')-new Date(oldDate+'T12:00:00'))/86400000);
 const pitch=buttons[1].offsetLeft-buttons[0].offsetLeft;
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
   buttons.forEach(button=>button.animate([{transform:`translateX(${Math.max(-3,Math.min(3,days))*pitch}px)`},{transform:'translateX(0)'}],{duration:220,easing:'cubic-bezier(.22,.68,.3,1)'}));
 }
 strip.querySelector('.is-selected')?.focus({preventScroll:true});
}
function bindNutritionDateSwipe() {
 const strip=$('.nutrition-date-strip');
 let start=null,suppressClick=false;
 strip.addEventListener('pointerdown',event=>{
   if(!event.isPrimary||event.button!==0)return;
   start={x:event.clientX,y:event.clientY,id:event.pointerId};
   suppressClick=false;
 });
 strip.addEventListener('pointermove',event=>{
   if(!start||event.pointerId!==start.id)return;
   const dx=event.clientX-start.x,dy=event.clientY-start.y;
   if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)){
     suppressClick=true;
     strip.classList.add('is-dragging');
     strip.setPointerCapture(event.pointerId);
   }
 });
 strip.addEventListener('pointerup',event=>{
   if(!start||event.pointerId!==start.id)return;
   const dx=event.clientX-start.x,dy=event.clientY-start.y;
   start=null;
   strip.classList.remove('is-dragging');
   if(Math.abs(dx)>=36&&Math.abs(dx)>Math.abs(dy)){
     suppressClick=true;
     selectNutritionDate(addDays(state.date,dx<0?1:-1));
   }
 });
 strip.addEventListener('pointercancel',()=>{start=null;strip.classList.remove('is-dragging');});
 strip.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
}
function nutritionDateStrip() {
 return `<nav class="nutrition-date-strip" aria-label="饮食日期快捷选择">${Array.from({length:9},(_,index)=>{
   const offset=index-4,date=addDays(state.date,offset),day=new Date(date+'T12:00:00');
   return `<button type="button" class="nutrition-day distance-${Math.abs(offset)} ${offset===0?'is-selected':''}" data-action="nutrition-day" data-date="${date}" aria-label="${dateLabel(date)}${date===today()?'，今天':''}" aria-pressed="${offset===0}"><small>${day.getMonth()+1}月</small><strong>${day.getDate()}</strong><span>${date===today()?'今天':['周日','周一','周二','周三','周四','周五','周六'][day.getDay()]}</span></button>`;
 }).join('')}</nav>`;
}
async function renderNutrition() {
 if(!await readyComputed())return;
 const n=nutrition(),t=totals(state.date),meals=records('meal').filter(r=>r.data.date===state.date&&r.data.confirmed);
 $('#page').innerHTML=title('吃得明白，练得有底气。','认真吃好每一餐，比追求完美更重要。',button(icon('plus')+' 记录餐食','new-meal','','primary'))+`<div class="nutrition-date-toolbar"><div class="nutrition-date-meta"><input aria-label="饮食日期" id="nutrition-date" type="date" value="${state.date}"><div class="nutrition-day-type"><output id="day-type" class="badge ${dayType(state.date)==='rest'?'neutral':''}" data-type="${dayType(state.date)}" aria-label="日类型" aria-live="polite">${dayType(state.date)==='training'?'训练日':'休息日'}</output></div></div>${nutritionDateStrip()}</div><div class="stats">${nutritionStats(n,t)}</div><section id="nutrition-feedback" class="card nutrition-feedback">${nutritionFeedbackView(computed.nutritionFeedbackByDate?.[state.date],n,state.date<today())}</section><div class="grid-2 nutrition-layout"><section class="card nutrition-scroll-card"><div class="card-head"><div><span class="eyebrow">FOOD DIARY</span><h2>这一天的每一餐</h2></div><span class="badge neutral">${meals.length} 餐已记录</span></div><div class="meal-list nutrition-panel-scroll" tabindex="0" role="region" aria-label="饮食记录，可上下滚动">${meals.length?renderMealGroups(meals):empty('还没有记录餐食<br>拍张照，或用文字描述今天的第一餐。','food')}</div></section><div class="card nutrition-scroll-card" id="nutrition-advice">${nutritionAdvice(n)}</div></div>`;
 bindNutritionDateSwipe();
 $('#page').removeEventListener('wheel',handleNutritionBoundaryWheel);
 $('#page').addEventListener('wheel',handleNutritionBoundaryWheel,{passive:false});
}
function mealRecordTime(meal) {
 const date=new Date(meal.createdAt);
 return meal.createdAt&&Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'时间未记录';
}
function mealRecordTitle(meal) {
 return [...new Set(meal.items.map(item=>(item.name||'').replace(/\uff08[^\uff08\uff09]*\uff09|\([^()]*\)/g,'').trim()).filter(Boolean))].join('\u3001')||'\u996e\u98df\u8bb0\u5f55';
}
function renderMealGroups(meals) { return [...meals].sort((a,b)=>(Date.parse(a.data.createdAt)||0)-(Date.parse(b.data.createdAt)||0)).map(renderMeal).join(''); }
function foodSymbol(name='') {
 if(/蛋/.test(name))return icon('egg');
 if(/米饭|面|粥|饭|云吞|馄饨|饺|燕麦|面包/.test(name))return icon('bowl');
 if(/鸡|鸭|肉|鱼|虾|牛|猪/.test(name))return icon('protein');
 if(/奶|酸奶/.test(name))return icon('milk');
 if(/果|橘|橙|蕉|莓|桃|梨|瓜/.test(name))return icon('fruit');
 if(/菜|笋|菇|西兰花|豆/.test(name))return icon('leaf');
 return icon('food');
}
// Empty panels use native scrolling. Only bridge a full panel's boundary,
// accumulating rapid wheel events so smooth scrolling keeps their full distance.
let nutritionPageScrollTarget=null,nutritionPageScrollTime=0;
function handleNutritionBoundaryWheel(event){
 if(event.ctrlKey||event.defaultPrevented||!event.deltaY)return;
 const panel=event.target instanceof Element?event.target.closest('.nutrition-panel-scroll'):null;
 if(!panel)return;
 const max=panel.scrollHeight-panel.clientHeight;
 if(max<=1)return;
 if(event.deltaY<0?panel.scrollTop>1:panel.scrollTop<max-1){nutritionPageScrollTarget=null;return;}
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?window.innerHeight:1);
 const now=performance.now(),limit=document.documentElement.scrollHeight-window.innerHeight;
 const previous=nutritionPageScrollTarget;
 if(previous===null||now-nutritionPageScrollTime>200||(previous-window.scrollY)*delta<0)nutritionPageScrollTarget=window.scrollY;
 nutritionPageScrollTarget=Math.max(0,Math.min(limit,nutritionPageScrollTarget+delta));
 nutritionPageScrollTime=now;
 event.preventDefault();
 window.scrollTo({top:nutritionPageScrollTarget,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function adviceBalanceCards(balance) {
 return `<div class="advice-balance">${[['kcal','热量','kcal'],['protein','蛋白质','g'],['carbs','碳水','g'],['fat','脂肪','g']].map(([key,label,unit])=>{const value=balance[key];return `<div class="balance-tile ${key} ${value.excess?'is-excess':''}"><span>${label}</span><strong>${value.excess||value.remaining}<small>${unit}</small></strong><em>${value.excess?'已超出目标':value.remaining?'还可摄入':'已达目标'}</em></div>`;}).join('')}</div>`;
}
function renderRemainingMealAdvice(content,timing) {
 const meals=content.displayMeals||[];
 if(!meals.length)return `<p class="muted">${timing?.scenario==='review'?'历史饮食的分析可在“饮食分析”中查看。':'今天暂无待安排的正餐，无需为补齐数值额外进食。'}</p>`;
 return `<div class="advice-brief-view markdown-body"><div class="advice-daily-meals">${meals.map(meal=>`<section class="advice-meal-plan planned"><div class="advice-meal-heading"><h4>${icon({'早餐':'sunrise','午餐':'sun','晚餐':'moon'}[meal.name])}${esc(meal.name)}</h4></div>${meal.foods.length?`<div class="advice-food-grid">${meal.foods.map(food=>`<article class="advice-food-card"><span class="food-symbol">${foodSymbol(food.name)}</span><div><strong>${esc(food.name)}</strong><p class="advice-portion">${esc(food.portion)}</p></div></article>`).join('')}</div>`:'<p>按饥饿感和实际摄入按需安排，无需刻意补足差额。</p>'}</section>`).join('')}</div></div>`;
}
function adviceContentCards(content,mode,timing) {
 if(content&&typeof content==='object'){
   if(mode==='detailed'&&Array.isArray(content.findings)){
     content={...content,findings:content.findings.map(item=>{
       const evidence=String(item.evidence||'');
       const internalField=/\b(?:recentWeek|frequentFoods|recordedDays|mealTiming)\b/i.test(evidence);
       const missing=/为空|为\s*0|[=:：]\s*0|无记录|没有记录|缺少|不足|\[\s*\]|\b(?:null|undefined|empty)\b/i.test(evidence);
       return internalField&&missing?{...item,evidence:'无明确依据'}:item;
     })};
   }
   if(mode==='brief'&&Array.isArray(content.meals))return renderRemainingMealAdvice(content,timing);

   if(mode==='brief')return `<div class="advice-brief-view markdown-body"><div class="advice-overview"><span>${icon('food')}</span><div><h4>${esc(timing?.title||'饮食安排')}</h4><p>${esc(content.summary)}</p></div></div><div class="advice-food-grid">${content.foods.map(food=>`<article class="advice-food-card"><span class="food-symbol">${foodSymbol(food.name)}</span><div><strong>${esc(food.name)}</strong><p class="advice-portion">${esc(food.portion)}</p></div></article>`).join('')}</div><div class="advice-practical-tip">${icon('leaf')}<p>${esc(content.tip)}</p></div></div>`;
   return `<div class="advice-detailed-view markdown-body"><div class="advice-overview"><span>${icon('grid')}</span><div><h4>今日饮食分析</h4><p>${esc(content.overview)}</p></div></div><div class="advice-findings">${content.findings.map(item=>`<article class="advice-finding"><h4>${esc(item.title)}</h4><dl><div><dt>记录依据</dt><dd>${esc(item.evidence)}</dd></div><div><dt>分析判断</dt><dd>${esc(item.interpretation)}</dd></div><div class="finding-action"><dt>调整方法</dt><dd>${esc(item.action)}</dd></div></dl></article>`).join('')}</div><section class="advice-next-step"><h4>${icon('calendar')} ${timing?.scenario==='review'?'可以改进的地方':'接下来怎么安排'}</h4><p>${esc(content.nextStep)}</p></section><section class="advice-uncertainty"><h4>还需核实的信息</h4><p>${esc(content.uncertainty)}</p></section></div>`;
 }
 // Saved advice stays readable until a meal changes or the user refreshes it.
 if(mode==='detailed')return `<div class="advice-legacy-detail markdown-body">${renderMarkdown(content)}</div>`;
 const html=renderMarkdown(content),template=document.createElement('template');template.innerHTML=html;
 const items=[...template.content.children].filter(el=>['UL','OL'].includes(el.tagName)).flatMap(el=>[...el.children]);
 if(items.length){
   return `<div class="advice-plan-heading"><span class="advice-plan-mark">${icon(mode==='brief'?'food':'leaf')}</span><div><h4>${mode==='brief'?'下一餐，可以这样搭配':'你的营养补充建议'}</h4><small>${mode==='brief'?'以下食物搭配为一套组合':'结合今日摄入，按需调整'}</small></div></div><div class="advice-food-grid markdown-body">${items.map((item,index)=>`<article class="advice-food-card"><span class="food-symbol" aria-hidden="true">${mode==='brief'?foodSymbol(item.textContent):icon('leaf')}</span><div><span class="food-card-index">${String(index+1).padStart(2,'0')}</span><div>${item.innerHTML}</div></div></article>`).join('')}</div>`;
 }
 return `<div class="advice-text-cards markdown-body">${[...template.content.children].map(el=>`<div class="advice-text-card">${el.outerHTML}</div>`).join('')||html}</div>`;
}
function renderMealNotes(note) {
 return `<div class="meal-notes-layout">${formatMealNotes(note).split(/\n\s*\n/).filter(part=>part && !/^(?:假设与依据|依据与假设)[：:]?$/.test(part.trim())).map(part=>{
   const match=part.match(/^(\d{1,2}[)）]|[一二三四五六七八九十]+、)\s*([\s\S]*)$/);
   if(match)return `<div class="meal-note-item"><span class="meal-note-number">${esc(match[1].replace(/[)）、]/g,''))}</span><p>${esc(match[2])}</p></div>`;
   return /^[^\n]{2,12}[：:]$/.test(part)?`<h4>${esc(part.replace(/[：:]$/,''))}</h4>`:`<p class="meal-note-paragraph">${esc(part)}</p>`;
 }).join('')}</div>`;
}
function renderMeal(r) {
 const m=r.data,t=mealTotals(m.items),note=m.estimateNote||m.notes;
 const photo=m.attachments?.find(file=>file.type?.startsWith('image/')&&file.url);
 return `<article class="meal-card meal-visual-card"><div class="meal-visual-head"><span class="meal-cover">${photo?`<img src="${esc(photo.url)}" alt="${esc(mealRecordTitle(m))}照片" loading="lazy">`:`<span aria-hidden="true">${icon('food')}</span>`}</span><div class="meal-heading"><small>${esc(mealRecordTime(m))} <span class="meal-recorded">已记录</span></small><h3 class="meal-names">${mealNamesWithTags(r)}</h3></div><button class="button small" data-action="edit-meal" data-id="${esc(r.id)}">修改</button></div><div class="meal-macro-grid">${[['kcal','热量','kcal'],['protein','蛋白质','g'],['carbs','碳水','g'],['fat','脂肪','g']].map(([key,label,unit])=>`<div class="meal-macro ${key}"><label for="meal-${esc(r.id)}-${key}">${label}</label><div class="meal-macro-control"><input id="meal-${esc(r.id)}-${key}" type="number" min="0" step="1" data-meal-nutrient="${key}" data-id="${esc(r.id)}" value="${t[key]}" aria-label="${label}"><em>${unit}</em><span class="meal-macro-steppers"><button type="button" data-action="meal-nutrient-step" data-key="${key}" data-id="${esc(r.id)}" data-step="1" aria-label="\u589e\u52a0${label}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button><button type="button" data-action="meal-nutrient-step" data-key="${key}" data-id="${esc(r.id)}" data-step="-1" aria-label="\u51cf\u5c11${label}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></span></div>${key==='kcal'?'<small class="meal-inline-calorie-hint">直接修改热量可能造成估算误差。</small>':''}</div>`).join('')}</div>${note?`<button type="button" class="meal-estimate-button" data-action="meal-estimate" data-id="${esc(r.id)}">${icon('spark')} 详细说明</button>`:''}</article>`;
}
function mealNamesWithTags(record) {
 const meal=record.data;
 return meal.items.map((item,index)=>`<span class="meal-name-tag"><span>${esc(item.name.replace(/（[^（）]*）|\([^()]*\)/g,'').trim())}</span><select class="food-category-tag" data-meal-category="${index}" data-id="${esc(record.id)}" aria-label="${esc(item.name)}的食物标签">${options(['正餐','加餐','零食'].map(category=>[category,category]),foodCategory(item,meal.userPrompt??meal.notes))}</select></span>`).join('');
}

const mealNutrientWrites=new Map();
function updateMealNutrient(id,key,value) {
 const store=state.store;
 const write=(mealNutrientWrites.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const meal=store.get(id);if(!meal)throw new Error('这条饮食记录已不存在。');
   const items=await calculate('adjustMealNutrient',meal.items,key,value);
   await store.put('meal',id,{...meal,items,updatedAt:new Date().toISOString()});
   if(state.store!==store)return;
   const values=await calculate('sumFoods',items);
   document.querySelectorAll('[data-meal-nutrient]').forEach(input=>{
     if(input.dataset.id===id&&input!==document.activeElement)input.value=values[input.dataset.mealNutrient];
   });
   if(state.page==='nutrition')refreshNutritionSummary();
 });
 mealNutrientWrites.set(id,write);
 return write.finally(()=>{if(mealNutrientWrites.get(id)===write)mealNutrientWrites.delete(id);});
}
function openMeal(id=null) {
 const saved=id?state.store.get(id):null;
 const createdAt=new Date().toISOString();
 state.mealDraft=structuredClone(saved||{date:today(),createdAt,title:'',items:[],notes:'',attachments:[],history:[]});
 state.mealDraft.attachments ||= [];
 state.mealDraft.notes ||= '';
 state.mealDraft._revision=saved?(saved.userPrompt??saved.originalPrompt??saved.notes??''):'';state.mealDraft._originalAttachmentCount=0;
 state.mealDraft._id=id||uid();state.mealDraft._editing=!!saved;renderMealEditor();
}
function mealComposer(m) {
 const photos=m.attachments.slice(m._originalAttachmentCount);
 return `<div class="meal-composer">${photos.length?`<div class="meal-photo-preview">${photos.map((file,index)=>`<div><img src="${esc(file.url)}" alt="${esc(file.name)}"><button type="button" class="icon-button" data-action="remove-meal-file" data-index="${index+m._originalAttachmentCount}" aria-label="移除 ${esc(file.name)}">×</button></div>`).join('')}</div>`:''}<textarea id="meal-notes" name="revision" maxlength="4000" placeholder="${m._editing?'描述需要修改的内容，或粘贴图片…':'描述吃了什么、吃了多少，或粘贴餐食图片…'}">${esc(m._revision)}</textarea><div class="meal-composer-tools"><button type="button" class="icon-button" data-action="meal-photo" aria-label="添加照片" title="添加照片">${icon('image')}</button>${button('拍照','meal-camera','','small')}</div></div>`;
}
function bindMealPaste() {
 const input=$('#meal-notes');
 input.addEventListener('paste',event=>{
   const images=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
   if(!images.length)return;
   event.preventDefault();
   if(state.mealDraft?._busy)return;
   const text=event.clipboardData.getData('text/plain');
   if(text)input.setRangeText(text.slice(0,Math.max(0,input.maxLength-input.value.length+input.selectionEnd-input.selectionStart)),input.selectionStart,input.selectionEnd,'end');
   uploadMealFiles(images,state.mealDraft);
 });
}
function renderMealEditor() {
 const m=state.mealDraft;
 if(!m._editing){
   modal('记录餐食',`<div class="meal-auto-meta"><span class="badge">${esc(mealRecordTime(m))}</span><small>${esc(m.date)}</small></div><form id="meal-form"><p class="description">上传餐食照片，或描述吃了什么、吃了多少。AI 分析后，核对确认再计入饮食记录。</p><label for="meal-notes">餐食描述</label>${mealComposer(m)}<div id="meal-ai-error" role="alert"></div><div class="form-footer">${button('取消','close-modal')}<button type="button" class="button primary" data-action="meal-ai">${icon('spark')} AI 分析</button></div></form>`);
   bindMealPaste();
   return;
 }
 modal('修改这一餐',`<div class="meal-auto-meta"><span class="badge">${esc(mealRecordTime(m))}</span><small>${esc(m.date)}</small></div><form id="meal-form" class="meal-revision-form"><label for="meal-notes">修改内容</label>${mealComposer(m)}<div id="meal-ai-error" role="alert"></div><div class="form-footer">${button('删除此餐','delete-meal',`data-id="${m._id}"`,'danger')}<button type="button" class="button primary" data-action="meal-ai">${icon('spark')} AI 分析</button></div></form>`,true);
 bindMealPaste();
}

function readMealForm() {
 const input=$('#meal-notes');if(input)state.mealDraft._revision=input.value;
}
async function saveMeal() {
 readMealForm();const m=state.mealDraft;
 if(!m.items.length)throw new Error('未识别到食物，请补充照片或说明后重试。');
 await calculate('sumFoods',m.items);
 const {_id,_editing,_busy,_revision,_originalAttachmentCount,...data}=m;delete data.type;data.confirmed=true;data.updatedAt=new Date().toISOString();
 await state.store.put('meal',_editing?_id:'meal:'+_id,data);
 closeModal();state.date=m.date;state.page='nutrition';render();toast(_editing?'这一餐已更新':'这一餐已计入饮食记录');
}

async function renderMealConfirmation() {
 const m=state.mealDraft;let portions;try{portions=await calculate('mealPortions',m.items,m.userPrompt??m.notes);}catch(error){toast(error.message,true);return;}if(state.mealDraft!==m)return;
 modal('确认餐食',`<form id="meal-confirm-form"><p class="description">核对后再计入饮食。可直接修改，最终以你的输入为准。</p><div class="form-grid"><div><label for="confirm-meal-date">日期</label><input id="confirm-meal-date" type="date" required value="${esc(m.date)}"></div><div><label>记录时间</label><input readonly value="${esc(mealRecordTime(m))}"></div></div><div class="meal-confirm-items">${portions.map((item,index)=>{return `<section class="meal-confirm-item" data-index="${index}" data-grams="${item.grams}"><label>食物名称<input data-field="name" required maxlength="100" value="${esc(item.name)}"></label><label class="meal-confirm-category">食物标签<select data-field="category">${options(['正餐','加餐','零食'].map(category=>[category,category]),foodCategory(item,m.userPrompt??m.notes))}</select></label><div class="meal-confirm-fields">${[['grams','实际份量（g）',10000],['protein','蛋白质（g）',10000],['carbs','碳水（g）',10000],['fat','脂肪（g）',10000],['kcal','热量（kcal）',100000]].map(([key,label,max])=>`<label>${label}<input type="number" data-field="${key}" min="${key==='grams'?'0.01':'0'}" max="${max}" step="any" required value="${item[key]}"></label>`).join('')}</div></section>`;}).join('')}</div><p class="description">修改蛋白质、碳水或脂肪后，热量按 4 × 蛋白质 + 4 × 碳水 + 9 × 脂肪重新计算；也可直接填写包装标注的热量。以上均为这份食物的实际摄入，下方直接合计。修改份量时营养数值按比例调整。</p><div id="meal-confirm-totals" class="meal-totals" aria-live="polite"></div><details class="meal-confirm-analysis"><summary>查看 AI 估算说明</summary>${renderMealNotes(m.estimateNote)}</details><div id="meal-confirm-error" role="alert"></div><div class="form-footer">${button('返回修改描述','meal-review-back')}<button type="submit" class="button primary">${m._editing?'确认更新':'确认计入饮食'}</button></div></form>`,true);
 const form=$('#meal-confirm-form');
 form.querySelectorAll('[data-field="kcal"]').forEach((input,index)=>{
   const hint=document.createElement('small');
   hint.id=`meal-calorie-hint-${index}`;hint.className='meal-calorie-hint';
   hint.textContent='直接修改热量可能与营养素计算结果不一致，造成估算误差。';
   input.setAttribute('aria-describedby',hint.id);
   input.parentElement.classList.add('meal-calorie-field');
   input.after(hint);
 });
 form.addEventListener('input',event=>{
   const row=event.target.closest('.meal-confirm-item'),field=event.target.dataset.field;
   if(!row||!['grams','protein','carbs','fat','kcal'].includes(field)){void updateMealConfirmationTotals();return;}
   const revision=(row._revision||0)+1;row._revision=revision;
   const edited=event.target.value===''?null:Number(event.target.value);
   row._calculated??=structuredClone(portions[Number(row.dataset.index)]);
   row._pending=(row._pending||Promise.resolve()).then(async()=>{
     const previous=row._calculated, value=await calculate('updateMealPortion',{...previous,[field]:edited},field,previous.grams);
     row._calculated=value;
     if(row._revision!==revision||!row.isConnected)return;
     row._computeError=null;$('#meal-confirm-error').textContent='';
     for(const key of ['protein','carbs','fat','kcal'])if(key!==field)row.querySelector(`[data-field="${key}"]`).value=value[key];
     row.dataset.grams=value.grams;
     return updateMealConfirmationTotals();
   }).catch(error=>{row._computeError=error;if(row._revision===revision&&row.isConnected)$('#meal-confirm-error').textContent=error.message;});
 });
 updateMealConfirmationTotals();
}
function readMealPortionRow(row) {return Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,['name','category'].includes(input.dataset.field)?input.value:input.value===''?null:Number(input.value)]));}
async function readMealConfirmationItems() {
 return calculate('mealItems',[...document.querySelectorAll('.meal-confirm-item')].map(readMealPortionRow));
}
async function updateMealConfirmationTotals() {
 const output=$('#meal-confirm-totals');if(!output)return;const revision=(output._revision||0)+1;output._revision=revision;
 try{
   const items=await readMealConfirmationItems(),t=await calculate('sumFoods',items);
   if(output._revision!==revision||!output.isConnected)return;output.textContent=`本餐合计：${t.kcal} kcal · 蛋白质 ${t.protein} g · 碳水 ${t.carbs} g · 脂肪 ${t.fat} g`;
 }catch{if(output._revision===revision&&output.isConnected)output.textContent='请填写有效的份量和营养数值。';}
}
async function confirmMeal() {
 const m=state.mealDraft;
 if(!m||m._busy)return;
 const form=$('#meal-confirm-form');if(!form?.reportValidity())return;
 m._busy=true;lockMealEditor(true);
 try{
   const rows=[...form.querySelectorAll('.meal-confirm-item')];await Promise.all(rows.map(row=>row._pending));
   if(!form.isConnected||state.mealDraft!==m)return;
   const failed=rows.find(row=>row._computeError);if(failed)throw failed._computeError;
   const items=await readMealConfirmationItems();
   m.items=items;m.date=$('#confirm-meal-date').value;
   await saveMeal();
 }catch(error){if($('#meal-confirm-error'))$('#meal-confirm-error').textContent=error.message;}
 finally{m._busy=false;if($('#meal-confirm-form'))lockMealEditor(false);}
}

function lockMealEditor(locked,message='') {
 const modalEl=$('#modal');
 modalEl.oncancel=locked?event=>event.preventDefault():null;
 modalEl.querySelectorAll('button,input,textarea,select').forEach(el=>{el.disabled=locked;});
 const action=$('[data-action="meal-ai"]');
 if(action)action.innerHTML=locked?esc(message):icon('spark')+(state.mealDraft?._editing?' AI 分析':' AI 分析');
}
async function estimateMeal() {
 if(state.mealDraft?._busy)return;
 readMealForm();const m=state.mealDraft;
 if(!m._revision.trim()&&m.attachments.length<=m._originalAttachmentCount)throw new Error(m._editing?'请填写本次修改说明，或添加新照片。':'请上传餐食照片，或填写餐食描述。');
 m._busy=true;lockMealEditor(true,'正在分析营养与热量…');$('#meal-ai-error').innerHTML='';
 const userId=state.user.id;
 try {
 const instruction=mealDishInstruction+'\n'+mealCategoryInstruction+'\n'+'请估算这同一餐实际吃下的食物；区分餐前餐后及营养标签，结合原估算修订。只返回 JSON {"items":[{"name":"食物名称（注明生熟）","grams":实际克数,"kcal":每100克热量,"protein":每100克蛋白质,"carbs":每100克碳水,"fat":每100克脂肪}],"note":"依据和不确定性"}。不划分餐次，记录时间由应用保存。所有数值非负。份量不明确时按常见份量估算并说明假设，无法识别食物时返回空 items。不要执行账户写入，由应用在校验成功后保存。';
 const response=await api('/ai',{method:'POST',body:{task:'meal',messages:[{role:'user',content:instruction+(m._editing?'':'\n这是新餐食记录，下面的用户修改是本餐描述，所有附件均属于本餐。')+'\n原餐食说明：'+m.notes+'\n本次用户修改（以本次为准）：'+m._revision+'\n附件顺序：前'+m._originalAttachmentCount+'张是原照片，其余为本次补充照片，用于修订同一餐，不要重复累加。'+'\n已有估算：'+JSON.stringify(m.items)+'\n之前修订：'+JSON.stringify(m.history||[]),attachments:m.attachments}],context:aiContext()}});
 if(state.user?.id!==userId||state.mealDraft!==m)return;
 const parsed=await calculate('parseMealEstimate',response.content);
 m.items=parsed.items.map(item=>({...item,category:foodCategory(item,m._revision),kcal:Number((item.protein*4+item.carbs*4+item.fat*9).toFixed(2))}));m.estimateNote=parsed.note;

 m.originalPrompt ??= m._editing?(m.notes||m._revision):m._revision;
 m.userPrompt=m._revision;m.notes=m._revision.trim();
 m.history=[...(m.history||[]),{notes:m._revision,result:parsed.note,createdAt:new Date().toISOString()}].slice(-8);
 renderMealConfirmation();
 }catch(error){if(state.mealDraft===m&&$('#meal-ai-error'))$('#meal-ai-error').innerHTML=`<div class="error-box">${esc(error.message)}<br>本次分析未保存，可保留照片和说明重试。</div>`;}
 finally{m._busy=false;if(state.mealDraft===m&&$('#meal-form'))lockMealEditor(false);}
}


function calendarTask(id) {return allCalendarTasks().find(r=>r.id===id);}
function taskDay(task) {return task?.data.daySnapshot||plan()?.days.find(day=>day.id===task?.data.dayId);}
function assertTaskCurrent(snapshot) {
 const current=calendarTask(snapshot?.id);
 if(!current||JSON.stringify(current.data)!==JSON.stringify(snapshot.data))throw new Error('这项任务已在其他位置更新，请关闭窗口后重新打开。');
 return current;
}
function trainingTaskCompleted(record) {
 return computed.completed.includes(record.id);
}

function renderCalendarCard(record) {
 const task=record.data,items=taskDay(record)?.exercises||[],completed=trainingTaskCompleted(record);
 const sets=items.reduce((total,item)=>total+(Number(item.sets)||0),0);
 return `<article class="calendar-task training-task ${completed?'task-completed':''}" data-task-id="${esc(record.id)}" data-action="calendar-detail" data-id="${esc(record.id)}" draggable="${!task.completed}">
  <div class="task-card-top"><button type="button" class="task-open" data-action="calendar-detail" data-id="${esc(record.id)}" aria-label="查看 ${esc(task.title)}"><strong>${esc(task.title)}</strong></button><details class="task-card-menu" draggable="false"><summary aria-label="${esc(task.title)}的操作"><span class="task-menu-dots" aria-hidden="true">${'<i></i>'.repeat(6)}</span></summary><div class="task-card-menu-panel">${button(icon('trash')+' 删除','calendar-delete',`data-id="${esc(record.id)}" aria-label="删除 ${esc(task.title)}"`,'calendar-card-delete')}</div></details></div>
  <small class="task-meta">${items.length} 个动作 · ${sets} 组</small>
  <div class="task-card-bottom"><span class="task-state ${completed?'is-completed':''}"><span class="task-state-mark" aria-hidden="true">${completed?icon('check'):''}</span>${completed?'已完成':'待完成'}</span></div>
 </article>`;
}
async function renderTraining() {
 if(!await readyComputed())return;
 ensureRecurringSchedule().catch(error=>toast(error.message,true));
 const busy=new Set(getBusyDates()),days=weekDates(state.date),weekTasks=allCalendarTasks().filter(r=>days.includes(r.data.date));
 const completed=weekTasks.filter(trainingTaskCompleted).length,monthLabel=`${state.date.slice(0,4)}年${Number(state.date.slice(5,7))}月`;
 const achieved=weekTasks.length>0&&completed===weekTasks.length;
 const rangeLabel=days.map(date=>`${Number(date.slice(5,7))}月${Number(date.slice(8))}日`);
 $('#page').innerHTML=title('把训练，变成自己的节奏。','按天安排训练，记录每一次认真完成的练习。',`<div class="training-page-actions">${button(icon('body')+' 评估动作','motion-open')}${button(icon('calendar')+' 繁忙日','busy-days','','busy-days-button')}${button(icon('plus')+' 添加训练','calendar-add',`data-date="${state.date}"`,'primary')}</div>`)+`<section class="timetable-shell">
  <div class="timetable-toolbar">
   <div class="week-navigation"><div class="calendar-period"><details class="calendar-popover calendar-date-picker"><summary aria-label="选择日期，当前${monthLabel}"><strong>${monthLabel}</strong><span aria-hidden="true">⌄</span></summary><div class="calendar-popover-panel"><label for="training-date">跳转到日期</label><input type="date" id="training-date" value="${state.date}"></div></details><small>${rangeLabel[0]} — ${rangeLabel[6]}${days[0].slice(0,4)!==days[6].slice(0,4)?' · 跨年':''}</small></div><div class="calendar-week-controls"><div class="calendar-week-arrows">${button('‹','calendar-week','data-offset="-7" aria-label="上一周"','small')}${button('›','calendar-week','data-offset="7" aria-label="下一周"','small')}</div>${button('本周','calendar-today','','small')}</div></div>
   <div class="calendar-toolbar-actions">${achieved?`<div class="weekly-achievement" role="status"><img class="weekly-seal" src="/assets/logo.svg" alt=""><div class="calendar-progress"><span><strong>${days.includes(beijingDate())?'本周计划已完成':'该周计划已完成'}</strong> ${icon('check')}</span><small>完成 ${completed} 次训练</small><progress value="1" max="1" aria-label="本周训练已全部完成"></progress></div></div>`:`<div class="calendar-progress" role="status" aria-live="polite"><span>本周完成 <strong>${completed} / ${weekTasks.length}</strong></span><progress value="${completed}" max="${weekTasks.length||1}" aria-label="本周训练完成进度"></progress></div>`}<details class="calendar-popover calendar-options"><summary aria-label="日历更多操作"><span aria-hidden="true">···</span></summary><div class="calendar-popover-panel">${button(icon('history')+' 重置日历','calendar-reset','','calendar-reset')}</div></details></div>
  </div>
  ${achieved?`<div class="weekly-complete-note">${icon('check')}<strong>这一周，认真练过了。</strong><small>每一次坚持，都算数</small></div>`:''}
  <div class="timetable-scroll" tabindex="0" aria-label="每周训练表，可横向滚动"><div class="timetable" role="table" aria-label="本周训练计划"><div class="timetable-heading" role="row">${days.map((date,i)=>`<div class="timetable-date ${date===today()?'is-today':''} ${date===state.date?'is-selected':''}" role="columnheader"><button type="button" data-action="training-day" data-date="${date}" aria-label="${dateLabel(date)}${date===today()?'，今天':''}" aria-pressed="${date===state.date}" ${date===today()?'aria-current="date"':''}><span>${['周一','周二','周三','周四','周五','周六','周日'][i]}</span><strong>${Number(date.slice(-2))}</strong></button></div>`).join('')}</div><div class="timetable-days" role="row">${days.map(date=>{const items=weekTasks.filter(r=>r.data.date===date);return `<div class="timetable-cell ${date===today()?'is-today':''} ${busy.has(date)?'is-busy':''}" data-date="${date}" role="cell" aria-label="${dateLabel(date)}训练">${items.length?items.map(renderCalendarCard).join(''):`<div class="calendar-rest">${busy.has(date)?'繁忙':'休息'}</div>`}${busy.has(date)?'':`<button type="button" class="calendar-cell-add" data-action="calendar-add" data-date="${date}" aria-label="添加 ${dateLabel(date)}训练">${icon('plus')}</button>`}</div>`;}).join('')}</div></div></div>
 </section><div class="plan-library-entry">${button(icon('folder')+' 方案库 <span class="plan-library-count">'+records('training-template').length+'</span>','plan-library','','plan-library-button')}</div>`;
 bindCalendarDrag();
 playWeeklyCelebration();
}
function playWeeklyCelebration() {
 const pending=state.weekCelebration;
 if(!pending)return;
 if(pending.userId!==state.user?.id||Date.now()>pending.expiresAt){state.weekCelebration=null;return;}
 if(state.page!=='training'||$('#modal').open||weekDates(state.date)[0]!==pending.weekStart||!$('.weekly-achievement'))return;
 state.weekCelebration=null;
 if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const layer=document.createElement('div');layer.className='weekly-confetti';layer.setAttribute('aria-hidden','true');
 layer.innerHTML=Array.from({length:22},(_,i)=>`<i style="--x:${12+(i*37)%80}%;--drift:${(i%2?1:-1)*(15+i%5*10)}px;--turn:${(i%2?1:-1)*(120+i*17)}deg;--delay:${i%5*55}ms;--color:${['#73916b','#b5c995','#c2ac73'][i%3]}"></i>`).join('');
 $('.timetable-shell').append(layer);setTimeout(()=>layer.remove(),1900);
}
function bindCalendarDrag() {
 const table=$('.timetable');if(!table)return;let dragRecord=null;
 table.addEventListener('dragstart',event=>{if(event.target.closest('.task-card-menu')){event.preventDefault();return;}document.querySelectorAll('.task-card-menu[open]').forEach(menu=>menu.open=false);const card=event.target.closest('.calendar-task'),record=card&&calendarTask(card.dataset.taskId);if(!record||record.data.completed){event.preventDefault();return;}dragRecord=structuredClone(record);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-fitness-task',record.id);card.classList.add('dragging');});
 table.addEventListener('dragend',()=>{dragRecord=null;table.querySelectorAll('.drop-target,.dragging').forEach(node=>node.classList.remove('drop-target','dragging'));});
 table.addEventListener('dragover',event=>{const cell=event.target.closest('.timetable-cell');if(!cell||!dragRecord||isBusyDate(cell.dataset.date,getBusySettings()))return;event.preventDefault();event.dataTransfer.dropEffect='move';table.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));cell.classList.add('drop-target');});
 table.addEventListener('dragleave',event=>{const cell=event.target.closest('.timetable-cell');if(cell&&!cell.contains(event.relatedTarget))cell.classList.remove('drop-target');});
 table.addEventListener('drop',async event=>{const cell=event.target.closest('.timetable-cell');if(!cell||!dragRecord)return;event.preventDefault();const snapshot=dragRecord;dragRecord=null;try{const record=assertTaskCurrent(snapshot);if(record.data.completed)throw new Error('已完成的训练保留原日期，不能移动。');const date=cell.dataset.date;if(isBusyDate(date,getBusySettings())){table.querySelectorAll('.drop-target,.dragging').forEach(node=>node.classList.remove('drop-target','dragging'));return;}if(date===record.data.date){table.querySelectorAll('.drop-target,.dragging').forEach(node=>node.classList.remove('drop-target','dragging'));return;}const data={...record.data,date};delete data.busyBaseDate;await state.store.put(record.kind,record.id,data);renderTraining();}catch(error){table.querySelectorAll('.drop-target,.dragging').forEach(node=>node.classList.remove('drop-target','dragging'));toast(error.message,true);}});
}
const holidayRequests=new Map();
async function ensureHolidayData(year) {
 if(holidayYear(year))return;
 try{const cached=JSON.parse(localStorage.getItem('fitness:holidays:'+year)||'null');if(cached){installHolidayYear(cached);return;}}catch{}
 if(!holidayRequests.has(year))holidayRequests.set(year,api('/holidays?year='+year).then(data=>{if(data.available){const saved=installHolidayYear(data);try{localStorage.setItem('fitness:holidays:'+year,JSON.stringify(saved));}catch{}}}).catch(()=>{}));
 await holidayRequests.get(year);
}
async function loadCalendarHolidayData(from,to) {
 const years=[];for(let year=Math.max(2007,Number(from.slice(0,4)));year<=Math.min(Number(to.slice(0,4)),new Date().getFullYear()+1);year++)if(!holidayYear(year))years.push(year);
 await Promise.all(years.map(ensureHolidayData));
}
async function openBusyDays() {
 await ensureRecurringSchedule();await ensureHolidayData(Number(state.date.slice(0,4)));
 const settings=await calculate('normalizeBusySettings',getBusySettings());
 state.busyEditor={month:state.date.slice(0,7),settings,weekdays:await calculate('defaultWeekdays',settings,today()),expanded:false,fingerprint:scheduleFingerprint()};
 renderBusyDays();
}
async function busyEditorSettings() {
 const editor=state.busyEditor;
 return JSON.stringify(await calculate('defaultWeekdays',editor.settings,today()))===JSON.stringify(editor.weekdays)?await calculate('normalizeBusySettings',editor.settings):await calculate('setDefaultWeekdays',editor.settings,editor.weekdays,today());
}
async function renderBusyDays(focusDate) {
 const editor=state.busyEditor;if(!editor)return;const revision=(editor.renderRevision||0)+1;editor.renderRevision=revision;
 try {
 const first=editor.month+'-01',year=Number(first.slice(0,4)),month=Number(first.slice(5,7));
 const count=new Date(year,month,0).getDate(),leading=(new Date(first+'T12:00:00').getDay()+6)%7;
 const slots=Array.from({length:Math.ceil((leading+count)/7)*7},(_,index)=>{const n=index-leading+1;return n<1||n>count?null:`${editor.month}-${String(n).padStart(2,'0')}`;});
 const planned=new Set(allCalendarTasks().map(record=>record.data.date)),now=today(),busyDates=await calculate('busyDatesInRange',await busyEditorSettings(),first,`${editor.month}-${String(count).padStart(2,'0')}`),busy=date=>busyDates.includes(date),labels=['周一','周二','周三','周四','周五','周六','周日'];
 if(state.busyEditor!==editor||editor.renderRevision!==revision)return;
 modal('繁忙日设置',`<details class="busy-defaults" id="busy-defaults" ${editor.expanded?'open':''}><summary>${icon('calendar')}<strong>默认繁忙日</strong><span class="busy-defaults-summary">${editor.weekdays.length===7?'每天':editor.weekdays.map(day=>labels[day-1]).join(' · ')||'未设置'}</span><span class="busy-defaults-chevron" aria-hidden="true">⌄</span></summary><div class="busy-defaults-content"><div class="busy-default-weekdays" role="group" aria-label="每周默认繁忙日">${labels.map((label,index)=>`<button type="button" data-action="busy-weekday" data-weekday="${index+1}" aria-pressed="${editor.weekdays.includes(index+1)}">${label}</button>`).join('')}</div><p>${icon('leaf')} 节假日自动空闲，手动设置优先</p></div></details><div class="busy-month-toolbar"><strong>${year}年${month}月</strong><div class="row">${button('‹','busy-month',`data-offset="-1" aria-label="上个月" ${editor.month==='1900-01'?'disabled':''}`,'small')}${button('本月','busy-current','','small')}${button('›','busy-month',`data-offset="1" aria-label="下个月" ${editor.month==='2199-12'?'disabled':''}`,'small')}</div></div>${!holidayYear(year)?'<p class="busy-holiday-unavailable">该年节假日数据暂不可用，按每周设置安排。</p>':''}<div class="busy-weekdays" aria-hidden="true">${['一','二','三','四','五','六','日'].map(day=>`<span>${day}</span>`).join('')}</div><div class="busy-date-grid" role="group" aria-label="${year}年${month}月繁忙日期">${slots.map(date=>{if(!date)return '<span aria-hidden="true"></span>';const selected=busy(date),holiday=holidayInfo(date);return `<button type="button" class="busy-date ${selected?'is-busy':''} ${date===now?'is-today':''}" data-action="busy-toggle" data-date="${date}" aria-pressed="${selected}" aria-label="${dateLabel(date)}，${selected?'繁忙':planned.has(date)?'有训练':'空闲'}${holiday?'，'+esc(holiday.isOffDay?holiday.name+'放假':'调休上班'):''}" ${date<now?'disabled':''} ${date===now?'aria-current="date"':''}><strong>${Number(date.slice(-2))}</strong><span>${selected?'繁忙':holiday?.isOffDay?esc(holiday.name):planned.has(date)?'训练':''}</span>${holiday?`<i class="busy-holiday-badge ${holiday.isOffDay?'is-off':'is-work'}" aria-hidden="true">${holiday.isOffDay?'休':'班'}</i>`:''}</button>`;}).join('')}</div><div class="busy-days-footer"><div class="row">${button('取消','close-modal')}${button('保存设置','busy-save','','primary')}</div></div><div id="busy-days-error" role="alert"></div>`);
 $('#modal').classList.add('busy-days-modal');
 const disclosure=$('#busy-defaults');disclosure.addEventListener('toggle',()=>{if(disclosure.isConnected)editor.expanded=disclosure.open;});
 if(focusDate)$(`.busy-date[data-date="${focusDate}"]`)?.focus({preventScroll:true});
 }catch(error){if(state.busyEditor===editor&&editor.renderRevision===revision)toast(error.message,true);}
}
async function changeBusyMonth(offset,current=false) {
 const editor=state.busyEditor,d=new Date(editor.month+'-01T12:00:00');d.setMonth(d.getMonth()+offset);
 editor.month=current?today().slice(0,7):`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
 await ensureHolidayData(Number(editor.month.slice(0,4)));if(state.busyEditor===editor&&$('#modal').open)renderBusyDays();
}
async function saveBusyDays() {
 const editor=state.busyEditor,store=state.store;
 if(editor.fingerprint!==scheduleFingerprint())throw new Error('日程已更新，请重新打开繁忙日设置。');
 const previous=await calculate('normalizeBusySettings',getBusySettings()),settings=await busyEditorSettings();
 if(JSON.stringify(previous)===JSON.stringify(settings)){closeModal();return;}
 const cycle=store.get('calendar-cycle');
 const changes=await calculate('rescheduleBusyTasks',allCalendarTasks(),cycle,previous,settings,today());
 await store.putMany([{id:'calendar-busy-days',kind:'calendar-settings',data:settings},...changes]);
 closeModal();state.busyEditor=null;renderTraining();
}
function cycleWindow(date) {
 const from=weekDates(date)[0],limit='2199-12-31';
 const remaining=Math.round((Date.parse(limit+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);
 return {from,to:addDays(from,Math.min(83,remaining))};
}
function getBusySettings() {return state.store?.get('calendar-busy-days')||{dates:[]};}
function getBusyDates(from=weekDates(state.date)[0],to=addDays(from,6)) {return computed.busyDates.filter(date=>date>=from&&date<=to);}
async function ensureRecurringSchedule(date=state.date) {
 const store=state.store,cycle=store?.get('calendar-cycle');
 if(!cycle||cycle.plan.planVersion!==plan()?.planVersion)return;
 await loadCalendarHolidayData(cycle.startDate,cycleWindow(date>today()?date:today()).to);
 if(state.store!==store||JSON.stringify(store.get('calendar-cycle'))!==JSON.stringify(cycle))return;
 const missing=new Map();
 for(const anchor of new Set([date,today()])) {
   const {from,to}=cycleWindow(anchor);
   for(const task of await calculate('recurringCalendarTasks',cycle,from,to,getBusySettings()))if(!store.records.has(task.id))missing.set(task.id,task);
 }
 // Tombstones count as existing records: deleted occurrences must stay deleted.
 if(missing.size)await store.putMany([...missing.values()]);
}
async function addPlanToCalendar(trainingPlan,date,{activate=false}={}) {
 const store=state.store,previous=store.get('calendar-cycle');
 if(previous?.plan.planVersion===trainingPlan?.planVersion&&previous.startDate===date){if(activate&&store.get('active-plan')?.planVersion!==trainingPlan.planVersion)await store.putMany([{id:'active-plan',kind:'plan',data:structuredClone(trainingPlan)}]);await ensureRecurringSchedule(date);return;}
 await calculate('planCalendarTasks',trainingPlan,date);
 await loadCalendarHolidayData(date,cycleWindow(date).to);
 if(state.store!==store||JSON.stringify(store.get('calendar-cycle'))!==JSON.stringify(previous))throw new Error('日程已更新，请重新导入方案。');
 const cycle={id:uid(),startDate:date,plan:structuredClone(trainingPlan)},changes=activate?[{id:'active-plan',kind:'plan',data:structuredClone(trainingPlan)}]:[];
 if(previous)for(const record of store.list('calendar-task')){
   const items=record.data.daySnapshot?.exercises||[],finished=record.data.completed||(items.length>0&&items.every(item=>item.completed===true));
   if(record.data.cycleId===previous.id&&!finished&&record.data.date>=date&&record.data.date>=today())changes.push({id:record.id,kind:record.kind,deleted:true});
 }
 const {to}=cycleWindow(date);
 changes.push({id:'calendar-cycle',kind:'training-cycle',data:cycle},...(await calculate('recurringCalendarTasks',cycle,date,to,getBusySettings())));
 await store.putMany(changes);
}
async function resetTrainingCalendar() {
 const store=state.store;
 await syncBeforeArchiving();
 await store.putMany(await calculate('calendarResetChanges',computeRecords()));
 state.date=today();state.calendarDelete=null;state.calendarDetail=null;state.trainingContentEditor=null;
 closeModal();renderTraining();toast('日历已重置');
}
function openCalendarTask(id) {
 const record=calendarTask(id);if(!record)throw new Error('这项训练已被删除，请刷新训练表。');if(record?.data.completed){showCalendarTask(id);return;}
 const data=record.data;
 state.calendarEditor={record:record&&structuredClone(record)};
 modal('调整训练',`<form id="calendar-task-form" data-id="${esc(id||'')}" data-version="${record?.version||0}"><input type="hidden" name="taskType" value="training"><div class="form-grid"><div class="full"><label for="task-date">训练日期</label><input id="task-date" name="date" type="date" value="${esc(data.date)}" required></div><div class="full"><label for="task-day">训练内容</label><select id="task-day" name="dayId" required>${options([['','选择已创建的训练内容'],...(plan()?.days.filter(d=>!d.rest)||[]).map(d=>[d.id,d.name]),...(data.dayId&&!plan()?.days.some(d=>d.id===data.dayId)?[[data.dayId,data.daySnapshot?.name||data.title+'（原计划）']]:[])],data.dayId||'')}</select>${!plan()?`<p class="description">先创建训练内容，再添加训练任务。${button('创建训练计划','plan-builder','','small')}</p>`:''}</div><div class="full"><label for="task-title">训练名称</label><input id="task-title" name="title" value="${esc(data.title)}" placeholder="例如：胸肩训练" maxlength="80" required></div><div class="full"><label for="task-notes">备注</label><textarea id="task-notes" name="notes" maxlength="2000" placeholder="地点、准备事项或其他提醒">${esc(data.notes||'')}</textarea></div></div><div id="calendar-task-error" role="alert"></div><div class="form-footer">${button('取消','close-modal')}<button type="submit" class="button primary">保存训练</button></div></form>`);
}
async function saveCalendarTask(values) {
 const original=state.calendarEditor?.record,record=original?assertTaskCurrent(original):null;
 if(record?.data.completed)throw new Error('已完成的训练不能修改日期或内容。');
 if(isBusyDate(values.date,getBusySettings()))throw new Error('这一天已设为繁忙，请选择其他日期。');
 const data={...(record?.data||{}),...await calculate('validateCalendarTask',{...values,taskType:'training',completed:false}),completed:false};
 if(data.date!==record?.data.date)delete data.busyBaseDate;
 const selected=plan()?.days.find(day=>day.id===values.dayId&&!day.rest),preserved=record?.data.dayId===values.dayId&&record.data.daySnapshot;
 if(!selected&&!preserved)throw new Error('请先选择有效的训练内容。');
 Object.assign(data,{dayId:values.dayId,daySnapshot:structuredClone(preserved||selected),planVersion:preserved?record.data.planVersion:plan().planVersion,rest:false});
 await state.store.put(record?.kind||'calendar-task',record?.id||'task:'+uid(),data);state.date=data.date;closeModal();renderTraining();toast(record?'训练已更新':'已添加到训练表');
}
function trainingExerciseSummary(exercise) {
 const timed=exerciseUsesSeconds(exercise.exerciseId)||/秒$/.test(String(exercise.reps));
 const reps=String(exercise.reps??'').replace(/(?:秒|次)$/,'').trim();
 return `${exercise.sets} 组 × ${reps} ${timed?'秒':'次'}`;
}
function trainingContentHeader(record,action=null) {
 const head=$('#modal .modal-head');
 $('h2',head).outerHTML=`<div class="training-content-title"><h2>${esc(record.data.title)}</h2><p>${dateLabel(record.data.date)}${trainingTaskCompleted(record)?' · 已完成':''}</p></div>`;
 if(action)$('[data-action="close-modal"]',head).insertAdjacentHTML('beforebegin',button('编辑',action,`data-id="${esc(record.id)}"`,'small training-content-edit'));
 $('#modal').classList.add('training-content-modal');
}
function showCalendarTask(id) {
 const record=calendarTask(id);if(!record)throw new Error('这项训练已被删除。');
 const data=record.data,day=taskDay(record),items=data.completed?(data.actual||[]):(day?.exercises||[]);
 state.calendarDetail=structuredClone(record);
 modal(esc(data.title),`<div class="training-content-list">${items.length?items.map((exercise,i)=>{
  const name=exercises.find(item=>item.id===exercise.exerciseId)?.name||exercise.exerciseId,done=data.completed?Number(exercise.sets)>0:exercise.completed===true;
  return `<div class="training-content-exercise${done?' is-completed':''}"><button type="button" class="training-exercise-toggle" data-action="training-exercise-toggle" data-id="${esc(id)}" data-index="${i}" aria-pressed="${done}" aria-label="${done?'取消完成':'标记完成'}：${esc(name)}" ${data.completed||(data.date>beijingDate()&&!done)?'disabled':''}><span aria-hidden="true"></span></button><strong>${esc(name)}</strong><div class="training-content-amount"><span>${esc(trainingExerciseSummary(exercise))}</span>${data.completed&&Number(exercise.weight)>0?`<small>${esc(exercise.weight)} kg</small>`:''}</div></div>`;
 }).join(''):`<p class="description">${data.completed?'暂无实际训练记录':'暂无训练动作'}</p>`}</div>${data.notes?`<p class="training-content-notes">${esc(data.notes)}</p>`:''}${day?`<div class="form-footer">${data.completed?button('撤销完成','training-reopen',`data-id="${esc(id)}"`):button('记录训练','log-training',`data-id="${esc(id)}" ${data.date>beijingDate()?'disabled':''}`,'primary')}</div>`:''}`);
 trainingContentHeader(record,day?(data.completed?'log-training':'training-content-edit'):null);
}
async function saveTrainingProgress(record,data) {
 const updated={id:record.id,kind:record.kind,data};
 const store=state.store,{finished,days}=await calculate('trainingProgress',updated,allCalendarTasks());
 await store.put(record.kind,record.id,data);
 state.celebratedWeeks??=new Set();
 if(finished&&days.includes(data.date)&&!state.celebratedWeeks.has(days[0])){state.celebratedWeeks.add(days[0]);state.weekCelebration={userId:state.user?.id,weekStart:days[0],expiresAt:Date.now()+120000};}
}
async function syncBeforeArchiving() {
 await state.store.sync();
 if(state.store.pending.size||state.store.conflicts.length)throw new Error('请先联网同步并处理记录冲突，再清空日程。已完成历史会保留。');
}

async function toggleTrainingExercise(id,index) {
 const record=assertTaskCurrent(state.calendarDetail);
 if(record.id!==id)throw new Error('请重新打开这项训练。');
 if(record.data.completed)throw new Error('已完成的训练请编辑实际记录。');
 const day=structuredClone(taskDay(record));
 if(!Number.isInteger(index)||index<0||!day?.exercises?.[index])throw new Error('这项动作已改变，请重新打开训练。');
 day.exercises[index].completed=day.exercises[index].completed!==true;
 await saveTrainingProgress(record,{...record.data,daySnapshot:day});
}
function openTrainingContentEditor(id) {
 const record=calendarTask(id);if(!record)throw new Error('这项训练已被删除。');
 if(record.data.completed){logTraining(id);return;}
 const day=taskDay(record);if(!day)throw new Error('这项训练没有可编辑的动作。');
 state.trainingContentEditor={record:structuredClone(record),day:structuredClone(day)};
 renderTrainingContentEditor();
}
function renderTrainingContentEditor() {
 const {record,day}=state.trainingContentEditor;
 modal(esc(record.data.title),`<form id="training-content-form"><div class="training-content-editor"><div class="draft-exercises">${day.exercises.map((exercise,index)=>`<div class="draft-exercise"><div class="draft-exercise-heading"><span class="draft-exercise-number">${String(index+1).padStart(2,'0')}</span><select name="exercise-${index}" data-exercise-index="${index}" aria-label="动作 ${index+1}">${options(exercises.map(item=>[item.id,item.name]),exercise.exerciseId)}</select>${button(icon('close'),'training-content-remove',`data-index="${index}" aria-label="删除动作 ${index+1}"`,'draft-remove')}</div><div class="draft-exercise-fields"><label for="content-sets-${index}">组数</label><input id="content-sets-${index}" name="sets-${index}" type="number" min="1" max="12" step="1" value="${esc(exercise.sets)}" required><label for="content-reps-${index}">${exerciseUsesSeconds(exercise.exerciseId)?'秒':'次数'}</label><input id="content-reps-${index}" name="reps-${index}" value="${esc(exerciseUsesSeconds(exercise.exerciseId)?String(exercise.reps).replace(/秒$/,'').trim():exercise.reps)}" maxlength="30" required></div></div>`).join('')}</div>${button(icon('plus')+' 添加动作','training-content-add',day.exercises.length>=MAX_TRAINING_EXERCISES?'disabled':'','draft-add')}</div><div id="training-content-error" role="alert"></div><div class="form-footer">${button('取消','calendar-detail',`data-id="${esc(record.id)}"`)}<button type="submit" class="button primary">保存</button></div></form>`);
 trainingContentHeader(record);
}
function readTrainingContentForm() {
 const editor=state.trainingContentEditor,values=formData($('#training-content-form'));
 editor.day.exercises=editor.day.exercises.map((exercise,index)=>{
   const exerciseId=values[`exercise-${index}`],value=values[`reps-${index}`].trim();
   const updated={...exercise,exerciseId,sets:values[`sets-${index}`]===''?'':Number(values[`sets-${index}`]),reps:exerciseUsesSeconds(exerciseId)&&value?value.replace(/秒$/,'').trim()+'秒':value};
   if(updated.exerciseId!==exercise.exerciseId||updated.sets!==exercise.sets||updated.reps!==exercise.reps)delete updated.completed;
   return updated;
 });
 return editor.day;
}
function changeTrainingContentExercise(target,remove=false) {
 const day=readTrainingContentForm(),index=Number(target.dataset.index);
 if(remove)day.exercises.splice(index,1);
 else {
   if(day.exercises.length>=MAX_TRAINING_EXERCISES)throw new Error(`每次训练最多添加 ${MAX_TRAINING_EXERCISES} 个动作。`);
   const muscle={chest:'胸',back:'背',shoulders:'三角肌',legs:'股',arms:'肱'}[day.part]||'';
   const candidates=exercises.filter(exercise=>exercise.muscle.includes(muscle));
   const next=candidates.find(exercise=>!day.exercises.some(item=>item.exerciseId===exercise.id))||candidates[0]||exercises[0];
   day.exercises.push(defaultTrainingExercise(next.id));
 }
 const scroll=$('#modal').scrollTop;renderTrainingContentEditor();$('#modal').scrollTop=scroll;
 (remove?$('[data-action="training-content-add"]'):$('#training-content-form .draft-exercise:last-child select'))?.focus({preventScroll:remove});
}
function trainingContentData(record,day) {
 if(record.data.completed)throw new Error('已完成的训练请编辑实际记录。');
 if(!day.exercises.length||day.exercises.length>MAX_TRAINING_EXERCISES)throw new Error(`请保留 1–${MAX_TRAINING_EXERCISES} 个动作。`);
 for(const exercise of day.exercises) {
   if(!exercises.some(item=>item.id===exercise.exerciseId)||!Number.isInteger(exercise.sets)||exercise.sets<1||exercise.sets>12||!exercise.reps.trim()||exercise.reps.length>30)throw new Error('请检查动作、组数和次数。');
 }
 return {...structuredClone(record.data),daySnapshot:structuredClone(day)};
}
async function saveTrainingContent() {
 const day=readTrainingContentForm(),record=assertTaskCurrent(state.trainingContentEditor.record);
 await state.store.put(record.kind,record.id,trainingContentData(record,day));
 renderTraining();showCalendarTask(record.id);toast('训练内容已保存');
}
function exerciseLine(e,i) {const x=exercises.find(x=>x.id===e.exerciseId);return `<div class="exercise-line"><span class="number">${String(i+1).padStart(2,'0')}</span><div class="grow"><button class="link-button" style="padding:0;text-align:left" data-action="exercise" data-id="${esc(e.exerciseId)}"><strong>${esc(x?.name||e.exerciseId)}</strong></button><small>${esc(x?.muscle||'')} · 休息 ${e.restSeconds}s</small></div><span class="rep">${e.sets} × ${esc(e.reps)}</span></div>`;}
async function ensurePlanLibrary() {
 const store=state.store;if(!store)return;
 const changes=await calculate('libraryMigration',computeRecords(),new Date().toISOString());
 if(changes.length)await store.putMany(changes);
}
function libraryTemplates() {
 return records('training-template').sort((a,b)=>(a.data.libraryNumber||0)-(b.data.libraryNumber||0)||a.id.localeCompare(b.id));
}
function assertLibraryCurrent(snapshot) {
 const current=state.store.records.get(snapshot?.id);
 if(!current||current.deleted||JSON.stringify(current.data)!==JSON.stringify(snapshot.data))throw new Error('这份方案已更新，请返回方案库后重新选择。');
 return structuredClone(current);
}
async function openPlanLibrary(selected=null,keepDate=false) {
 await ensurePlanLibrary();
 if(!keepDate||!state.libraryDate)state.libraryDate=state.date<today()?today():state.date;
 state.librarySelected=selected||state.librarySelected;
 renderPlanLibrary();
}
function renderPlanLibrary() {
 const templates=libraryTemplates();
 if(!templates.some(record=>record.id===state.librarySelected))state.librarySelected=templates[0]?.id||null;
 state.librarySnapshots=new Map(templates.map(record=>[record.id,structuredClone(record)]));
 modal('方案库',`<form id="plan-library-form"><div class="plan-library-tools"><small>${templates.length} 个方案</small>${button(icon('plus')+' 新建方案','library-new','','small')}</div><div class="plan-library-list">${templates.length?templates.map(record=>{
  const data=record.data,selected=record.id===state.librarySelected,days=data.days||[],training=days.filter(day=>!day.rest),variant={standard:'标准模板',home:'居家训练',shoulders:'肩部单练',arms:'手臂单练'}[data.variant]||'自定义';
  return `<article class="library-template${selected?' is-selected':''}"><div class="library-template-head"><label class="library-template-choice"><input type="radio" name="library-template" value="${esc(record.id)}" ${selected?'checked':''}><strong>${esc(data.name)}</strong></label>${button(icon('pencil'),'library-rename',`data-id="${esc(record.id)}" aria-label="重命名 ${esc(data.name)}"`,'library-rename')}<details class="library-template-menu"><summary aria-label="${esc(data.name)}的操作">···</summary><div>${button(icon('trash')+' 删除方案','library-delete',`data-id="${esc(record.id)}"`,'small')}</div></details></div><div class="library-template-body"><p>${training.length} 分化 · ${variant}</p><small>${days.length} 天循环 · ${training.reduce((total,day)=>total+(day.exercises?.length||0),0)} 个动作</small><div class="library-template-bottom"><div class="library-template-days">${days.map(day=>`<span class="${day.rest?'is-rest':''}" title="${esc(day.name)}">${esc(day.rest?'休':trainingParts.find(part=>part.id===day.part)?.name||day.name)}</span>`).join('')}</div>${button('编辑动作','library-edit',`data-id="${esc(record.id)}"`,'library-edit')}</div></div></article>`;
 }).join(''):`<div class="plan-library-empty">${icon('folder')}<h3>把喜欢的训练安排存下来</h3><p>新建方案后，会自动保存在这里。</p></div>`}</div><div id="plan-library-error" role="alert"></div><footer class="plan-library-footer"><div><label for="library-start-date">开始日期</label><input type="date" id="library-start-date" name="startDate" min="${today()}" max="2199-12-31" value="${esc(state.libraryDate)}" required ${templates.length?'':'disabled'}></div><div class="library-import-action"><button type="submit" class="button primary" ${templates.length?'':'disabled'}>循环导入日历 ${icon('arrow')}</button><small>自动避开繁忙日</small></div></footer></form>`);
 $('#modal').classList.add('plan-library-modal');
}
function editLibraryTemplate(id) {
 const record=assertLibraryCurrent(state.librarySnapshots.get(id));
 state.librarySelected=id;state.libraryEditing=record;viewDraft();
}
function renameLibraryTemplate(id) {
 const record=assertLibraryCurrent(state.librarySnapshots.get(id));state.libraryRenaming=record;
 modal('重命名方案',`<form id="library-rename-form"><label for="library-name">方案名称</label><input id="library-name" name="name" value="${esc(record.data.name)}" maxlength="80" required><div class="form-footer">${button('取消','plan-library-return')}<button type="submit" class="button primary">保存名称</button></div></form>`);
 $('#library-name').focus();$('#library-name').select();
}
function deleteLibraryTemplate(id) {
 const record=assertLibraryCurrent(state.librarySnapshots.get(id));state.libraryDeleting=record;
 modal('删除方案',`<p class="description">删除「${esc(record.data.name)}」？已经排进日历的训练会保留。</p><div class="form-footer">${button('取消','plan-library-return')}${button('删除方案','library-delete-confirm','','danger')}</div>`);
}
async function saveLibraryDraft(draft) {
 const record=assertLibraryCurrent(state.libraryEditing),data={...structuredClone(draft),libraryRevision:uid()};
 state.libraryEditing={...record,data};state.draftEditor=structuredClone(data);
 await state.store.put(record.kind,record.id,data);
}
async function importLibraryTemplate(values) {
 const record=assertLibraryCurrent(state.librarySnapshots.get(values['library-template'])),date=values.startDate;
 if(date<today())throw new Error('请选择今天或之后的开始日期。');
 const trainingPlan=await calculate('libraryPlan',record);trainingPlan.confirmedAt=new Date().toISOString();
 await addPlanToCalendar(trainingPlan,date,{activate:true});
 state.date=date;state.libraryDate=date;closeModal();renderTraining();toast('方案已循环安排到日历');
}
function planBuilder(date=state.date) {
 state.planStartDate=date;state.planSplit=3;state.planGroups=Array.from({length:5},()=>[]);state.partPicker=null;
 modal('创建训练循环',`<form id="plan-form"><fieldset class="plan-split-fieldset"><legend>训练分化</legend><div class="plan-split-options">${['一','二','三','四','五'].map((name,index)=>`<label><input type="radio" name="split" value="${index+1}" ${index===2?'checked':''}><span>${name}分化</span></label>`).join('')}</div></fieldset><div class="plan-groups-heading"><strong>训练安排</strong><small id="plan-day-count" aria-live="polite"></small></div><div id="plan-groups" class="plan-groups"></div><div class="plan-template-row"><div><label for="variant">模板样式</label><small id="variant-description"></small></div><select id="variant" name="variant">${options([['standard','标准模板'],['home','居家训练']],'standard')}</select></div><div class="form-footer">${button('取消','close-modal')}<button class="button primary" type="submit">生成草案 ${icon('arrow')}</button></div></form>`);
 $('#modal').classList.add('plan-builder-modal');updatePlanGroups();
}
function updatePlanGroups(focusSelector) {
 $('#plan-day-count').textContent=`${state.planSplit} 个训练日`;
 $('#plan-groups').innerHTML=state.planGroups.slice(0,state.planSplit).map((parts,index)=>`<section class="plan-group" aria-labelledby="plan-group-title-${index}"><h3 id="plan-group-title-${index}"><span class="step-badge">${index+1}</span>训练日 ${index+1}</h3><div class="plan-part-chips">${parts.map(id=>`<button type="button" class="plan-part-chip" data-action="toggle-training-part" data-day="${index}" data-part="${id}" aria-label="移除训练日 ${index+1} 的${trainingParts.find(part=>part.id===id).name}">${trainingParts.find(part=>part.id===id).name}${icon('close')}</button>`).join('')}${button(icon('plus')+' 部位','plan-parts-picker',`data-day="${index}" aria-label="选择训练日 ${index+1} 的部位" aria-expanded="${state.partPicker===index}" aria-controls="plan-part-picker-${index}"`,'plan-part-add')}</div>${state.partPicker===index?`<div id="plan-part-picker-${index}" class="plan-part-picker" role="group" aria-label="训练日 ${index+1} 的部位">${trainingParts.map(part=>`<button type="button" data-action="toggle-training-part" data-day="${index}" data-part="${part.id}" aria-pressed="${parts.includes(part.id)}">${part.name}${parts.includes(part.id)?icon('check'):''}</button>`).join('')}${button('完成','plan-parts-picker',`data-day="${index}"`,'plan-parts-done')}</div>`:''}</section>`).join('');
 $('#plan-form button[type="submit"]').disabled=state.planGroups.slice(0,state.planSplit).some(parts=>!parts.length);
 if(focusSelector)$(focusSelector)?.focus({preventScroll:true});
}
function updateVariantDescription() {
 $('#variant-description').textContent=$('#variant').value==='home'?'需要哑铃和可调训练凳':'';
}
function updateDraftExerciseUnit(target) {
 if(!target.name?.startsWith('e-'))return;
 const [,i,j]=target.name.split('-'),previous=state.draftEditor?.days[i]?.exercises[j];
 const timed=exerciseUsesSeconds(target.value),input=$(`#draft-r-${i}-${j}`);
 if(previous&&exerciseUsesSeconds(previous.exerciseId)!==timed)input.value=defaultTrainingExercise(target.value).reps.replace(/秒$/,'');
 $(`label[for="draft-r-${i}-${j}"]`).textContent=timed?'秒':'次数';
}
function readDraftForm() {
 const draft=structuredClone(state.draftEditor),form=$('#draft-form');if(!draft||!form)return draft;
 const values=formData(form);draft.name=values.name;
 draft.days.forEach((day,i)=>day.exercises.forEach((exercise,j)=>{exercise.exerciseId=values[`e-${i}-${j}`];exercise.sets=values[`s-${i}-${j}`]===''?'':Number(values[`s-${i}-${j}`]);const reps=values[`r-${i}-${j}`].trim();exercise.reps=exerciseUsesSeconds(exercise.exerciseId)&&reps?reps.replace(/秒$/,'').trim()+'秒':reps;}));
 return draft;
}
function viewDraft(openDays) {
 const d=state.store.get(state.libraryEditing?.id);if(!d)return;state.draftEditor=d;
 let trainingIndex=0;
 modal('调整训练草案',`<form id="draft-form" class="training-draft-form grouped-draft"><div class="draft-name-row"><div class="field"><label for="plan-name">方案名称</label><input name="name" id="plan-name" value="${esc(d.name)}" maxlength="80" required></div><span class="badge neutral">${d.days.filter(day=>!day.rest).length} 分化</span></div><div class="draft-days">${d.days.map((day,i)=>day.rest?`<div class="draft-rest"><span>${icon('leaf')} ${esc(day.name)}</span><small>第 ${i+1} 天</small></div>`:renderDraftDay(day,i,++trainingIndex,openDays?openDays.includes(i):trainingIndex===1)).join('')}</div><div class="form-footer draft-footer">${button('返回方案库','plan-library-return')}<button class="button primary" type="submit">保存到方案库 ${icon('check')}</button></div></form>`,true);
 $('#modal').classList.add('training-draft-modal');
}
function renderDraftDay(day,i,number,open) {
 const parts=(day.parts||[day.part]).filter(id=>trainingParts.some(part=>part.id===id));
 const groupFor=exercise=>parts.includes(exercise.part)?exercise.part:parts.length===1?parts[0]:'';
 const groups=[...parts];if(!parts.length||day.exercises.some(exercise=>!groupFor(exercise)))groups.push('');
 return `<details class="draft-day" data-draft-day="${i}" ${open?'open':''}><summary class="draft-day-heading"><h3><span class="step-badge">${number}</span>${esc(day.name)}</h3><span>${day.exercises.length} 个动作</span><span class="draft-chevron" aria-hidden="true">⌄</span></summary><div class="draft-day-body">${groups.map(part=>`<section class="draft-part" data-draft-part="${part}"><div class="draft-part-heading"><h4>${esc(trainingParts.find(item=>item.id===part)?.name||'动作')}</h4>${button(icon('plus')+' 添加动作','draft-add-exercise',`data-day="${i}" data-part="${part}" ${day.exercises.length>=MAX_TRAINING_EXERCISES?'disabled':''}`,'draft-part-add')}</div><div class="draft-exercises">${day.exercises.map((exercise,j)=>groupFor(exercise)===part?renderDraftExercise(exercise,i,j):'').join('')}</div></section>`).join('')}${!day.exercises.length?'<p class="description">至少添加 1 个动作</p>':''}</div></details>`;
}
function renderDraftExercise(e,i,j) {
 return `<div class="draft-exercise"><div class="draft-exercise-choice"><label class="sr-only" for="draft-e-${i}-${j}">第${i+1}天动作${j+1}</label><select id="draft-e-${i}-${j}" name="e-${i}-${j}">${options(exercises.map(x=>[x.id,x.name]),e.exerciseId)}</select></div><div class="draft-value"><label for="draft-s-${i}-${j}">组数</label><input id="draft-s-${i}-${j}" name="s-${i}-${j}" type="number" min="1" max="12" step="1" value="${esc(e.sets)}" required></div><div class="draft-value"><label for="draft-r-${i}-${j}">${exerciseUsesSeconds(e.exerciseId)?'秒':'次数'}</label><input id="draft-r-${i}-${j}" name="r-${i}-${j}" value="${esc(exerciseUsesSeconds(e.exerciseId)?String(e.reps).replace(/秒$/,'').trim():e.reps)}" maxlength="30" required></div>${button(icon('trash'),'draft-remove-exercise',`data-day="${i}" data-index="${j}" aria-label="删除第${i+1}天动作${j+1}"`,'draft-remove')}</div>`;
}
async function changeDraftExercise(target,remove=false) {
 if(state.draftSaving)return;
 const draft=readDraftForm(),index=Number(target.dataset.day),day=draft?.days[index];if(!day||day.rest)return;
 if(remove)day.exercises.splice(Number(target.dataset.index),1);
 else {
   if(day.exercises.length>=MAX_TRAINING_EXERCISES)throw new Error(`每个训练日最多添加 ${MAX_TRAINING_EXERCISES} 个动作。`);
   const part=target.dataset.part||day.part||'',muscle={chest:'胸',back:'背',shoulders:'三角肌',legs:'股',arms:'肱'}[part]||'';
   const candidates=exercises.filter(exercise=>exercise.muscle.includes(muscle));
   const next=candidates.find(exercise=>!day.exercises.some(item=>item.exerciseId===exercise.id))||candidates[0]||exercises[0];
   day.exercises.push({...defaultTrainingExercise(next.id),...(part?{part}:{})});
 }
 const form=$('#draft-form'),scroll=$('.draft-days').scrollTop,openDays=[...form.querySelectorAll('.draft-day[open]')].map(node=>Number(node.dataset.draftDay));
 state.draftSaving=true;
 try {
   await saveLibraryDraft(draft);
   if(!form.isConnected||!$('#modal').open)return;
   viewDraft(openDays);$('.draft-days').scrollTop=scroll;
   const section=$(`[data-draft-day="${index}"]`);(remove?section.querySelector(`[data-action="draft-add-exercise"][data-part="${target.dataset.part||''}"]`)||$('[data-action="draft-add-exercise"]',section):$(`#draft-e-${index}-${day.exercises.length-1}`))?.focus({preventScroll:true});
 } finally {state.draftSaving=false;}
}
function logTraining(id) {
 const record=id?calendarTask(id):scheduledRecord(state.date),s=record?.data,day=taskDay(record);if(!day)throw new Error('这项任务没有可记录的训练内容。');state.trainingLog=structuredClone(record);
 modal(s.completed?'修改实际训练':'记录实际训练',`<p class="description">${s.date} · ${esc(day.name)}。按实际完成情况填写。</p><form id="training-log" data-task-id="${esc(record.id)}"><div class="food-table-wrap"><table class="food-table"><thead><tr><th>动作</th><th>完成组数</th><th>每组次数 / 秒</th><th>重量 kg</th></tr></thead><tbody>${day.exercises.map((e,i)=>{const actual=s.actual?.[i]||e;return `<tr><td>${esc(exercises.find(x=>x.id===e.exerciseId)?.name)}</td><td><input name="sets-${i}" aria-label="完成组数" type="number" min="0" max="30" value="${actual.sets}" required></td><td><input name="reps-${i}" aria-label="实际次数" value="${esc(actual.reps)}" maxlength="40" required></td><td><input name="weight-${i}" aria-label="实际重量" type="number" min="0" max="1000" step="0.5" value="${actual.weight||0}" required></td></tr>`;}).join('')}</tbody></table></div><div class="field" style="margin-top:20px"><label for="training-notes">体感与备注</label><textarea name="notes" id="training-notes" maxlength="2000" placeholder="例如：最后两次比较吃力，下次保持重量。">${esc(s.notes||'')}</textarea></div><div class="form-footer"><button class="button primary" type="submit">保存完成记录</button></div></form>`,true);
}
function strengthTool() {modal('最大力量估算',`<p class="description">用最近完成的一组记录，查看 Epley 与 Brzycki 的参考估算。</p><form id="strength-form"><div class="form-grid"><div><label for="strength-weight">使用重量（kg）</label><input id="strength-weight" name="weight" type="number" min="0.5" max="1000" step="0.5" value="40" required></div><div><label for="strength-reps">完成次数</label><input id="strength-reps" name="reps" type="number" min="1" max="15" value="8" required></div></div><div class="form-footer"><button class="button primary">计算参考结果</button></div></form><div id="strength-result"></div>`);}

function sourceLink(name,url) {return url?`<a class="knowledge-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name||'查看来源')} ↗</a>`:`<small class="knowledge-source">${esc(name||'')}</small>`;}
function knowledgeSources() {return `<details class="knowledge-sources"><summary>知识来源与说明</summary><div class="source-grid">${knowledgeCards.map(card=>`<article><strong>${esc(card.title)}</strong><p>${esc(card.summary)}</p>${sourceLink(card.sourceName,card.sourceUrl)}</article>`).join('')}</div></details>`;}
function renderLibrary({transition=false}={}) {
 const tabs=[['nutrition','营养计算','营养公式与工具'],['portions','食物份量','日常份量换算'],['weights','RM 换算','估算单次最大重量'],['exercises','3D 动作','动作示意与要领'],['muscles','肌肉图谱','找到目标肌群']];
 $('#page').innerHTML=title('看懂原理，练得更有把握。','从营养计算到动作与肌肉，把知识用在每一天。',button(icon('body')+' 视频动作评估','motion-open'))+`<nav class="knowledge-tabs" role="tablist" aria-label="知识类别">${tabs.map(([id,label,desc])=>`<button id="knowledge-tab-${id}" type="button" role="tab" tabindex="${state.knowledgeTab===id?0:-1}" aria-selected="${state.knowledgeTab===id}" aria-controls="knowledge-panel" data-action="knowledge-tab" data-tab="${id}" class="${state.knowledgeTab===id?'active':''}"><strong>${label}</strong><small>${desc}</small></button>`).join('')}</nav><section id="knowledge-panel" role="tabpanel" aria-labelledby="knowledge-tab-${state.knowledgeTab}"></section>${knowledgeSources()}`;
 const renderPanel={nutrition:renderNutritionTools,portions:renderPortionTools,weights:renderWeightTools,exercises:renderExerciseLibrary,muscles:renderMuscleLibrary};
 (renderPanel[state.knowledgeTab]||renderNutritionTools)();
 if(transition)animateViewEntry($('#knowledge-panel'));
}
function toolField(id,label,name,value,attributes='') {return `<div><label for="${id}">${label}</label><input id="${id}" name="${name}" type="number" value="${esc(value)}" ${attributes} required></div>`;}
function renderNutritionTools() {
 const p=profile()||{},m=knowledgeDrafts.metabolism||{sex:p.sex||'male',age:p.age||28,height:p.height||175,weight:p.weight||70,activity:p.activity||1.375},macro=knowledgeDrafts.macro||{protein:120,carbs:250,fat:60};
 $('#knowledge-panel').innerHTML=`<div class="knowledge-tool-grid"><section class="card tool-card"><div class="card-head"><div><span class="eyebrow">ENERGY ESTIMATE</span><h2>基础代谢与每日消耗</h2></div>${icon('body')}</div><p class="tool-intro">输入身体数据与活动水平，查看静息能量消耗和全天消耗的估算。</p><form id="metabolism-form" novalidate><div class="form-grid"><div><label for="calc-sex">公式性别参数</label><select id="calc-sex" name="sex">${options([['male','男'],['female','女']],m.sex)}</select></div>${toolField('calc-age','年龄（岁）','age',m.age,'min="18" max="100" step="1"')}${toolField('calc-height','身高（cm）','height',m.height,'min="130" max="230" step="0.1"')}${toolField('calc-weight','体重（kg）','weight',m.weight,'min="35" max="300" step="0.1"')}<div class="full"><label for="calc-activity">活动系数</label><select id="calc-activity" name="activity">${options([[1.2,'1.2 · 久坐为主'],[1.375,'1.375 · 轻度活动'],[1.55,'1.55 · 中等活动'],[1.725,'1.725 · 较高活动'],[1.9,'1.9 · 很高活动']],m.activity)}</select></div></div><div id="metabolism-error" class="tool-error" role="alert"></div><div class="form-footer"><button class="button primary" type="submit">计算消耗</button></div></form><div id="metabolism-result" class="tool-result-panel" aria-live="polite"></div><small class="tool-footnote">在这里试算，不会更改个人资料或今日饮食目标。</small></section><section class="card tool-card"><div class="card-head"><div><span class="eyebrow">MACRO ENERGY</span><h2>三大营养素与热量</h2></div>${icon('food')}</div><p class="tool-intro">输入蛋白质、碳水与脂肪的克数，查看热量合计和能量占比。</p><form id="macro-energy-form" novalidate><div class="form-grid">${toolField('calc-protein','蛋白质（g）','protein',macro.protein,'min="0" max="1000" step="0.1"')}${toolField('calc-carbs','碳水化合物（g）','carbs',macro.carbs,'min="0" max="2000" step="0.1"')}${toolField('calc-fat','脂肪（g）','fat',macro.fat,'min="0" max="1000" step="0.1"')}</div><div id="macro-energy-error" class="tool-error" role="alert"></div><div class="form-footer"><button class="button primary" type="submit">计算热量</button></div></form><div id="macro-energy-result" class="tool-result-panel" aria-live="polite"></div></section></div><div class="knowledge-formulas">${formulaCards.map(card=>`<article class="formula-card"><span class="eyebrow">FORMULA</span><h3>${esc(card.title)}</h3><p class="formula-expression">${esc(card.formula)}</p><p>${esc(card.description)}</p>${sourceLink(card.sourceName,card.sourceUrl)}</article>`).join('')}</div>`;
 updateKnowledgeTool($('#metabolism-form'));updateKnowledgeTool($('#macro-energy-form'));
}
function renderPortionTools() {
 const d=knowledgeDrafts.portion||{foodId:foodPortions[0]?.id,count:1,grams:foodPortions[0]?.grams};
 $('#knowledge-panel').innerHTML=`<div class="portion-layout"><section class="card tool-card"><div class="card-head"><div><span class="eyebrow">EVERYDAY PORTIONS</span><h2>一份食物，含有多少营养？</h2></div>${icon('food')}</div><p class="tool-intro">盒、个、杯的大小各有不同。选择常见份量，也可以按实际可食重量调整。</p><form id="portion-form" novalidate><div class="form-grid"><div class="full"><label for="portion-food">选择食物份量</label><select id="portion-food" name="foodId">${options(foodPortions.map(item=>[item.id,item.label]),d.foodId)}</select></div>${toolField('portion-count','份数','count',d.count,'min="0.1" max="100" step="0.1"')}${toolField('portion-grams','每份可食重量（g）','grams',d.grams,'min="1" max="5000" step="1"')}</div><div id="portion-error" class="tool-error" role="alert"></div><div class="form-footer"><button class="button primary" type="submit">换算营养</button></div></form><div id="portion-result" class="tool-result-panel" aria-live="polite"></div></section><section class="portion-reference"><h3>常见份量参考</h3><div class="portion-grid">${foodPortions.map(item=>`<button class="portion-preset" type="button" data-action="portion-preset" data-id="${esc(item.id)}"><span>${icon('food')}</span><strong>${esc(item.label)}</strong><small>每份 ${item.grams} g 可食部分</small></button>`).join('')}</div><p>熟饭按熟重计算；鸡蛋按去壳后的重量计算。包装食品优先核对实际营养标签。</p></section></div>`;
 updateKnowledgeTool($('#portion-form'));
}
function rmPresetButtons(side,reps) {
 return `<div class="weight-presets" role="group" aria-label="${side==='current'?'已完成次数':'目标 RM'}快捷选择">${rmPresets.map(count=>`<button type="button" data-action="rm-preset" data-side="${side}" data-reps="${count}" aria-pressed="${Number(reps)===count}">${side==='current'?`${count} 次`:`${count}RM`}</button>`).join('')}</div>`;
}
function renderWeightTools() {
 const d=knowledgeDrafts.weights||{weight:'',currentReps:12,targetReps:1,method:'epley'};
 $('#knowledge-panel').innerHTML=`<div class="weight-layout">
  <section class="card tool-card">
   <div class="card-head"><div><span class="eyebrow">ONE REP MAX</span><h2>估算你的单次最大重量</h2></div>${icon('dumbbell')}</div>
   <p class="tool-intro">输入动作标准、接近力竭的一组重量与次数，估算 1RM。若平时练 4 × 12，填写单组重量与 12 次即可。</p>
   <form id="weight-conversion-form" novalidate>
    <input id="weight-method" type="hidden" name="method" value="${esc(d.method)}">
    <div class="form-grid">${toolField('weight-known','已知重量（kg）','weight',d.weight,'min="0.1" max="1000" step="0.1" placeholder="例如 40"')}${toolField('weight-current-reps','已完成次数（次）','currentReps',d.currentReps,'min="1" max="15" step="1"')}</div>
    ${rmPresetButtons('current',d.currentReps)}
    <p class="tool-footnote">组数不参与 RM 估算；如果做完仍能轻松继续，结果会低估你的能力。</p>
    <fieldset class="weight-scheme-fields"><legend>目标 RM 换算</legend><div class="form-grid">${toolField('weight-target-reps','目标 RM 次数','targetReps',d.targetReps,'min="1" max="15" step="1"')}</div>${rmPresetButtons('target',d.targetReps)}</fieldset>
    <div id="weights-error" class="tool-error" role="alert"></div><div class="form-footer"><button class="button primary" type="submit">估算与换算</button></div>
   </form>
   <div id="rm-target-result" class="tool-result-panel rm-target-result" aria-live="polite" hidden></div>
  </section>
  <section class="card tool-card weight-table-card">
   <div class="card-head"><div><span class="eyebrow">RM CONVERSION</span><h2>1RM 估算与重量换算表</h2></div><span class="badge neutral">1–15RM</span></div>
   <div id="weights-result" aria-live="polite"><div class="weight-empty">${icon('dumbbell')}<strong>填写重量，查看你的 1RM</strong><p>1RM 是标准完成一次的最大重量。也可以查看 5RM、8RM、12RM 等次数对应的重量。</p></div></div>
   <details class="weight-method"><summary>RM 是什么？如何估算？</summary><p class="formula-expression">${esc(rmConversionReference.formula)}</p><p>${esc(rmConversionReference.description)}</p><p>超过 10 次的估算误差可能更大。表内百分比由所选公式计算，这些预测值不能代替实测最大重量。</p>${sourceLink(rmConversionReference.sourceName,rmConversionReference.sourceUrl)}</details>
  </section>
 </div>`;
 if(knowledgeDrafts.weights)updateKnowledgeTool($('#weight-conversion-form'));
}
function renderWeightResult(result) {
 const target=result.target,method=result.method==='epley'?'Epley':'Brzycki';
 return `<p class="weight-basis">根据已完成 ${result.weight} kg × ${result.currentReps} 次估算</p>
  <div class="tool-result-panel rm-estimate"><div class="row spread wrap"><div class="tool-total"><small>估算 1RM · 单次最大重量</small><strong data-rm-max>${result.estimatedMax}<em> kg</em></strong></div><span class="badge neutral">${method}</span></div><p>${esc(result.note)}</p></div>
  <div class="rm-formula-comparison" role="group" aria-label="选择估算公式">${[['epley','Epley'],['brzycki','Brzycki']].map(([key,name])=>`<button type="button" data-action="rm-method" data-method="${key}" aria-label="使用 ${name} 公式估算" aria-pressed="${key===result.method}"><small>${name} 估算</small><strong>${result.estimates[key]}<em> kg</em></strong></button>`).join('')}</div><small class="tool-footnote">点击对应公式切换估算结果。两种公式的差异不是你的最大重量上下限。</small>
  <div class="weight-table-wrap"><table class="weight-conversion-table"><caption>${method} · 点击 RM 可设为目标</caption><thead><tr><th scope="col">RM 次数</th><th scope="col">估算重量</th><th scope="col">占 1RM</th></tr></thead><tbody>${result.rows.map(row=>`<tr ${row.reps===target.reps?'class="selected"':''}><th scope="row"><button type="button" data-action="rm-preset" data-side="target" data-reps="${row.reps}" aria-label="查看 ${row.label} 对应重量" aria-pressed="${row.reps===target.reps}">${row.label}${row.reps===1?' · 最大重量':''}</button></th><td>${row.weight} kg</td><td>${row.percent}%</td></tr>`).join('')}</tbody></table></div><small class="tool-footnote">同一动作、同一器械的单组重量参考。11–15RM 仅作粗略估算，多组训练还需考虑累积疲劳。</small>`;
}
function chooseRMMethod(method) {
 if(!['epley','brzycki'].includes(method))return;
 $('#weight-method').value=method;updateKnowledgeTool($('#weight-conversion-form'));
}
function chooseRMPreset(reps,side) {
 const count=Number(reps);if(!Number.isInteger(count)||count<1||count>15||!['current','target'].includes(side))return;
 $(`#weight-${side}-reps`).value=count;
 updateKnowledgeTool($('#weight-conversion-form'));
}
async function updateKnowledgeTool(form) {
 if(!form)return;
 const revision=(form._computeRevision||0)+1;form._computeRevision=revision;form.dataset.computing='true';
 const values=formData(form),id=form.id,kind=id==='metabolism-form'?'metabolism':id==='macro-energy-form'?'macro':id==='weight-conversion-form'?'weights':'portion',prefix=kind==='macro'?'macro-energy':kind;
 knowledgeDrafts[kind]=values;
 if(kind==='weights')form.querySelectorAll('[data-action="rm-preset"]').forEach(button=>button.setAttribute('aria-pressed',String(Number(values[button.dataset.side+'Reps'])===Number(button.dataset.reps))));
 const output=$('#'+prefix+'-result'),errorBox=$('#'+prefix+'-error'),targetOutput=kind==='weights'?$('#rm-target-result'):null;if(!output||!errorBox)return;
 try {
   let html='';
   if(kind==='weights'){
     const result=await calculate('calculateRMConversion',values);if(form._computeRevision!==revision||!form.isConnected)return;const method=result.method==='epley'?'Epley':'Brzycki';
     html=renderWeightResult(result);
     patchHTML(targetOutput,`<div class="row spread wrap"><div class="tool-total"><small>目标 ${result.target.label} · 估算重量</small><strong data-rm-target>${result.target.weight}<em> kg</em></strong></div><span class="badge neutral">${method}</span></div>`);targetOutput.hidden=false;
   }else if(kind==='metabolism'){
     const result=await calculate('calculateMetabolism',values);if(form._computeRevision!==revision||!form.isConnected)return;
     html=`<div class="tool-numbers"><div><small>静息能量消耗</small><strong>${numeric(result.ree)}<em> kcal / 天</em></strong></div><div><small>全天总消耗估算</small><strong>${numeric(result.tdee)}<em> kcal / 天</em></strong></div></div><p>${esc(result.note)}</p>`;
   }else if(kind==='macro'){
     const result=await calculate('calculateMacroEnergy',values);if(form._computeRevision!==revision||!form.isConnected)return;
     html=`<div class="tool-total"><small>热量合计</small><strong>${numeric(result.kcal)}<em> kcal</em></strong></div><div class="macro-energy-breakdown">${[['protein','蛋白质'],['carbs','碳水'],['fat','脂肪']].map(([key,label])=>`<div><span>${label}</span><strong>${numeric(result[key+'Kcal'])} kcal</strong><small>${Math.round(result[key+'Share']*10)/10}% 能量占比</small></div>`).join('')}</div>`;
   }else{
     const result=await calculate('calculateFoodPortion',values.foodId,{count:values.count,grams:values.grams});if(form._computeRevision!==revision||!form.isConnected)return;
     html=`<div class="row spread wrap"><strong>${esc(result.label)}</strong><span class="badge">共 ${result.grams} g</span></div><div class="portion-totals">${[['kcal','热量','kcal'],['protein','蛋白质','g'],['carbs','碳水','g'],['fat','脂肪','g']].map(([key,label,unit])=>`<div><small>${label}</small><strong>${Math.round(result[key]*10)/10}<em> ${unit}</em></strong></div>`).join('')}</div><p>${esc(result.note)}</p>${sourceLink(result.source)}`;
   }
   form.dataset.computing='false';errorBox.innerHTML='';patchHTML(output,html);output.hidden=false;
 }catch(error){if(form._computeRevision!==revision||!form.isConnected)return;form.dataset.computing='false';output.hidden=true;if(targetOutput)targetOutput.hidden=true;errorBox.innerHTML=`<div class="error-box">${esc(error.message)}</div>`;}
}
function choosePortion(id) {
 const item=foodPortions.find(item=>item.id===id);if(!item)return;
 $('#portion-food').value=id;$('#portion-grams').value=item.grams;updateKnowledgeTool($('#portion-form'));
}
function renderExerciseLibrary() {
 const filtered=exercises.filter(x=>(x.name+x.muscle+x.equipment).includes(state.filter)&&(!state.muscle||x.muscle.includes(state.muscle))&&(!state.equipment||x.equipment.includes(state.equipment)));
 // 只要目录里任何一个动作收录了真人封面，整个网格就统一按 3:2 排布，否则同一行里封面卡和矢量卡高低不齐。
 const hasCovers=exercises.some(x=>coverUrl(x.id));
 $('#knowledge-panel').innerHTML=`<div class="search-row"><input id="exercise-search" type="search" placeholder="搜索动作、肌肉或器械…" aria-label="搜索动作" value="${esc(state.filter)}"><select id="muscle-filter" aria-label="按肌肉筛选">${options([['','全部肌群'],['胸','胸部'],['背','背部'],['三角','肩部'],['二头','肱二头肌'],['三头','肱三头肌'],['股','腿部'],['臀','臀部'],['腹','核心']],state.muscle)}</select><select id="equipment-filter" aria-label="按器械筛选">${options([['','全部器械'],['徒手','徒手'],['哑铃','哑铃'],['器','固定器械']],state.equipment)}</select></div><div class="row spread wrap" style="margin-bottom:18px"><small>${filtered.length} 个动作</small><span class="badge neutral">3D 姿态 · 目标肌群 · 动作要领</span></div><div class="exercise-grid"${hasCovers?' data-covers="1"':''}>${filtered.map((x,i)=>{const cover=coverUrl(x.id);return `<button class="exercise-card" data-action="exercise" data-id="${x.id}"><div class="exercise-visual"${cover?' data-cover="1"':''}>${icon('body')}${cover?`<img class="exercise-cover" src="${cover}" alt="" loading="${i<3?'eager':'lazy'}" decoding="async">`:''}<span class="letter">${String(i+1).padStart(2,'0')}</span><span class="badge">${x.isometric?'◉ 持续支撑演示':x.demo?'◉ 3D 动作演示':'◉ 3D 姿态示意'}</span></div><div class="exercise-info"><h3>${esc(x.name)} <span style="float:right;color:#9eab93">↗</span></h3><p>${esc(x.muscle)}</p><p style="margin-top:9px">${esc(x.equipment)} · ${esc(x.level)}</p></div></button>`}).join('')}</div>${!filtered.length?empty('没有找到相关动作，试试其他关键词。','grid'):''}`;
}
function renderMuscleLibrary() {
 $('#knowledge-panel').innerHTML=`<div class="atlas-intro"><div><span class="eyebrow">MUSCLE ATLAS</span><h2>找到你正在训练的肌肉。</h2><p>旋转模型查看位置。选择肌群，可以打开对应的高亮图谱。</p><div class="row wrap"><span class="badge">${muscleCatalog.length} 个肌群与肌肉</span><span class="badge neutral">可旋转 / 缩放</span></div></div><iframe class="knowledge-atlas-frame" src="${esc(modelUrl('muscle','chest',{compact:true}))}" title="胸部肌群3D图谱预览" loading="lazy" allow="fullscreen"></iframe></div><div class="muscle-grid">${muscleCatalog.map(muscle=>`<button class="muscle-card" type="button" data-action="muscle-model" data-id="${esc(muscle.id)}"><span class="muscle-icon">${icon('body')}</span><div><strong>${esc(muscle.name)}</strong><p>${esc(muscle.description)}</p><small>查看 3D 高亮 ↗</small></div></button>`).join('')}</div>`;
}
function showMuscle(id) {
 const muscle=muscleCatalog.find(item=>item.id===id);if(!muscle)return;
 modelViewer.open({type:muscle.structure?'structure':'muscle',id:muscle.structure||muscle.id,title:muscle.name,url:modelUrl('muscle',id),detailsHtml:`<p class="model-caption">${esc(muscle.description)}</p>`});
}
function showExercise(id) {
 const x=exercises.find(x=>x.id===id);if(!x)return;
 modelViewer.open({type:'exercise',id,title:x.name,url:modelUrl('exercise',id),detailsHtml:`<details class="model-guidance"><summary>动作要领与来源</summary><div class="model-details"><div class="row wrap"><span class="badge">${esc(x.muscle)}</span><span class="badge neutral">${esc(x.equipment)}</span></div><p class="description">${esc(x.description)}</p><ol>${x.cues.map(c=>`<li>${esc(c)}</li>`).join('')}</ol><small>${esc(x.source)}</small></div></details>`});
}

async function renderSettings() {
 closeAccountSettings();
 if(!personalSections.some(([id])=>id===personalSectionGroup(state.setting)))state.setting='home';
 const section=personalSectionGroup(state.setting);
 $('#page').classList.add('personal-center-content');
 $('.layout').classList.add('personal-center-active');
 const actions=section==='home'?`<div class="personal-head-actions"><a class="button personal-preview" href="#community/user/${encodeURIComponent(state.user.id)}?preview=public">他人视角 ${icon('arrow')}</a><a class="button primary" href="#community/publish">${icon('plus')} 发布笔记</a></div>`:'';
 $('#page').innerHTML=title('个人中心','管理你的主页、健康档案与偏好。',actions)+`<nav class="settings-nav" aria-label="个人中心栏目">${personalSections.map(([id,label])=>`<button data-action="settings-tab" data-tab="${id}" class="${section===id?'active':''}" ${section===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav><div id="settings-content" data-setting="${state.setting}"></div>`;
 if(section==='home'){
   $('#settings-content').innerHTML='<div id="personal-community"></div>';
   communityController ||= new CommunityController({getUser:()=>state.user,api,toast,navigate:communityNavigate,onProfileChange:updateAccountProfile,onProfileSettings:mountPersonalSettings});
   const container=$('#personal-community');
   await communityController.mountPersonal(container,personalRoute().active?location.hash:'#settings').catch(error=>toast(error.message,true));
   if(container.isConnected&&['account','data'].includes(state.setting)){
     const dialog=await communityController.editProfile();
     if(state.setting==='data')dialog?.querySelector('#personal-data-heading')?.scrollIntoView({block:'start'});
   }
 }else return ({profile:renderProfile,achievements:renderAchievements,ai:renderAISettings}[section])();
}
function mountPersonalSettings(dialog) {
 closeAccountSettings();
 const user=state.user,store=state.store;
 dialog.classList.add('personal-settings-dialog');
 const form=dialog.querySelector('[data-cm-form=profile]');
 form.querySelector('.cm-profile-edit-avatar')?.remove();
 form.classList.add('personal-settings-profile');
 form.insertAdjacentHTML('afterbegin','<h3>个人资料</h3>');
 form.insertAdjacentHTML('beforebegin','<div id="personal-account"></div>');
 form.insertAdjacentHTML('afterend','<section class="personal-settings-data" aria-labelledby="personal-data-heading"><h3 id="personal-data-heading">数据管理</h3><div id="personal-data"></div></section>');
 const view=accountSettingsView=mountAccountSettings($('#personal-account'),{user,api,isCurrent:()=>state.user===user&&state.store===store,onProfileChange:profile=>{
   updateAccountProfile(profile);
   const draft=communityController?.profileDraft;
   if(draft?.dialog===dialog){draft.avatarMediaId=profile.avatarMediaId;draft.avatarUrl=profile.avatarUrl;}
   communityController?.refreshProfileHeading();
 }});
 const grid=dialog.querySelector('.account-settings-grid'),password=dialog.querySelector('[aria-labelledby=account-password-heading]');
 grid.after(password);
 grid.append(form);
 form.classList.add('card');
 renderData();
 return ()=>{view.destroy();if(accountSettingsView===view)accountSettingsView=null;};
}

async function renderAchievements() {
 if(!await readyComputed())return;
 const all=computeRecords(),pageSize=matchMedia('(max-width:700px)').matches?2:4;
 const model=computed.achievements[state.achievementCategory||'all'];
 state.achievementPage=Math.max(0,Math.min(state.achievementPage||0,Math.ceil(model.cards.length/pageSize)-1));
 $('#settings-content').innerHTML=await calculate('renderAchievementWall',all,{category:state.achievementCategory||'all',page:state.achievementPage,pageSize});
 const carousel=$('.achievement-carousel');if(!carousel)return;
 let touch=null;
 carousel.addEventListener('touchstart',event=>{const p=event.touches[0];touch={x:p.clientX,y:p.clientY};},{passive:true});
 carousel.addEventListener('touchend',event=>{const p=event.changedTouches[0];if(touch&&Math.abs(p.clientX-touch.x)>60&&Math.abs(p.clientY-touch.y)<45){state.achievementPage+=p.clientX<touch.x?1:-1;renderAchievements();}touch=null;},{passive:true});
}
async function showAchievement(id) {
 if(!await readyComputed())return;
 const all=computeRecords();
 const card=computed.achievements.all.cards.find(item=>item.id===id)||computed.achievements.milestone.cards.find(item=>item.id===id);if(!card)return;
 modal(card.name,await calculate('renderAchievementDetails',computeRecords(),id));
 $('#modal').classList.add('achievement-detail-modal');
}

async function renderProfile() {
 if(!await readyComputed())return;
 const p=profile(),history=records('phase');
 $('#settings-content').innerHTML=`<div class="grid-2"><div class="card"><div class="profile-head"><span class="avatar" data-account-avatar>${accountAvatarMarkup(state.user)}</span><div><h2>${esc(state.user.name)}</h2><small>${esc(state.user.email)}</small></div></div><div class="stats" style="grid-template-columns:1fr 1fr;margin-bottom:20px"><div class="stat"><small>当前体重</small><strong>${p?.weight||'—'}<em>kg</em></strong></div><div class="stat"><small>当前目标</small><strong style="font-size:23px">${goalLabel(p?.goal)||'待设置'}</strong></div></div><div class="row spread"><small>年龄 / 性别</small><span>${p?.age||'—'} 岁 · ${p?.sex==='female'?'女':'男'}</span></div><div class="divider"></div><div class="row spread"><small>身高</small><span>${p?.height||'—'} cm</span></div><div class="divider"></div>${button('更新阶段资料','profile','','primary')}<p class="description" style="font-size:11px;margin:18px 0 0">每次更新会保留带日期的历史，并重新估算营养建议。</p></div><div class="card"><div class="card-head"><h2>阶段记录</h2><span class="badge neutral">${history.length} 条</span></div>${history.length?`<table class="history-table"><thead><tr><th>日期</th><th>体重</th><th>目标</th><th></th></tr></thead><tbody>${history.map(r=>`<tr><td>${esc(r.data.date)}</td><td>${r.data.weight} kg</td><td>${goalLabel(r.data.goal)}</td><td><button class="link-button" data-action="delete-phase" data-id="${r.id}">删除</button></td></tr>`).join('')}</tbody></table>`:empty('更新资料后，会在这里留下一条记录。')}</div></div>`;
 const review=document.createElement('section');review.id='personal-review';review.className='personal-review';review.setAttribute('aria-label','阶段复盘');
 $('#settings-content').append(review);
 await renderReview(review);
}
function showProfile(first=false) {
 const p=profile()||{age:28,sex:'male',height:175,weight:70,goal:'maintain'};
 modal(first?'先认识一下你':'更新阶段资料',`<p class="description">${first?'填写这五项，就可以开始使用。':'尽量在相同条件下记录体重。满两周后自动校准下一周期热量；修改目标或活动水平会重新开始观察。'}</p><form id="profile-form" data-first="${first}"><div class="form-grid"><div><label for="profile-age">年龄</label><input name="age" id="profile-age" type="number" min="18" max="100" value="${p.age}" required></div><div><label for="profile-sex">性别（用于代谢公式）</label><select name="sex" id="profile-sex">${options([['male','男'],['female','女']],p.sex)}</select></div><div><label for="profile-height">身高 cm</label><input name="height" id="profile-height" type="number" min="130" max="230" step="0.1" value="${p.height}" required></div><div><label for="profile-weight">当前体重 kg</label><input name="weight" id="profile-weight" type="number" min="35" max="300" step="0.1" value="${p.weight}" required></div><div class="full"><label for="profile-goal">这一阶段的目标</label><select name="goal" id="profile-goal">${options([['lose','减脂 · 逐渐降低体脂'],['gain','增肌 · 提升力量与肌肉'],['maintain','保持 · 建立规律习惯']],p.goal)}</select></div>${first?'':`<div><label for="phase-date">记录日期</label><input name="date" id="phase-date" type="date" value="${today()}" max="${today()}" required></div><div><label for="activity">日常活动水平</label><select id="activity" name="activity">${options([[1.2,'久坐为主'],[1.375,'轻度活动'],[1.55,'中等活动'],[1.725,'较高活动']],p.activity||1.375)}</select></div>`}</div><p style="font-size:10px;color:#94a08d;margin-top:17px">首次按轻度日常活动估算，可在阶段资料中调整。自动营养估算适用于普通成年人；孕期、哺乳期与特殊医疗饮食请遵循专业建议。</p><div id="profile-error"></div><div class="form-footer"><button class="button primary" type="submit">${first?'建立档案，开始使用':'保存阶段资料'}</button></div></form>`,false,first);
}
function presetFor(id) { return providerPresets.find(p=>p.id===id)||providerPresets.find(p=>p.id==='custom'); }
function providerLogo(preset) { return `<span class="provider-logo" style="--provider-color:${esc(preset.color||'#527b68')}">${esc(preset.logo||preset.name.slice(0,1))}</span>`; }
function renderAISettings() {
 const taskOptions=task=>'<option value="">选择供应商与模型</option>'+state.providers.filter(p=>enabledModels(p).length).map(p=>`<optgroup label="${esc(p.name)}">${options(enabledModels(p).map(m=>[JSON.stringify({providerId:p.id,modelId:m.id}),`${p.name} · ${m.name||m.id}${m.vision===true?' · 支持图片':''}`]),taskSelection(task,state.providers,state.tasks,state.taskModels))}</optgroup>`).join('');
 $('#settings-content').innerHTML=`<div id="provider-settings-feedback" role="status" aria-live="polite">${state.providersConflict?providerConflictMarkup():''}</div><div class="provider-intro"><div><div class="eyebrow">CONNECT YOUR AI</div><h2>选择服务，填入密钥，就可以开始。</h2><p>地址已为你准备好。获取模型后，勾选常用模型，再分配给不同任务。</p></div><span class="badge">${providerPresets.filter(p=>p.id!=='custom').length} 种供应商预设</span></div><div class="provider-settings-grid"><section class="card"><div class="card-head"><h2>我的供应商</h2>${button('+ 添加供应商','provider','','small')}</div>${state.providers.length?state.providers.map(p=>{const preset=presetFor(p.presetId);return `<article class="provider-card"><div class="row">${providerLogo(preset)}<div class="grow"><strong>${esc(p.name)}</strong><small>${enabledModels(p).length} 个已启用模型</small></div><span class="badge ${p.hasKey?'':'neutral'}">${p.hasKey?'已配置':'无密钥'}</span></div><div class="provider-model-tags">${enabledModels(p).slice(0,4).map(m=>`<span title="${esc(m.id)}">${esc(m.name||m.id)}</span>`).join('')}${enabledModels(p).length>4?`<small>+${enabledModels(p).length-4}</small>`:''}</div><div class="row wrap">${button('管理模型','provider',`data-id="${esc(p.id)}"`,'small')}${button('测试连接','test-provider',`data-id="${esc(p.id)}" ${p.model?'':'disabled'}`,'small')}${button('删除','delete-provider',`data-id="${esc(p.id)}"`,'small')}</div></article>`;}).join(''):empty('还没有连接 AI 服务<br>从下面选择你使用的供应商。','spark')}<div class="divider"></div><div class="card-head"><h3>添加常用服务</h3><small>自动填写接口地址</small></div><div class="provider-presets">${providerPresets.map(p=>`<button class="preset-tile" data-action="provider-preset" data-preset="${p.id}">${providerLogo(p)}<span>${esc(p.name)}</span></button>`).join('')}</div><p class="provider-footnote">密钥在服务端加密保存，个人导出与浏览器缓存不包含密钥。</p></section><section class="card task-card"><div class="card-head"><h2>任务使用的模型</h2>${icon('settings')}</div><p class="description">同一份密钥下的多个模型，可以分别承担不同任务。</p><form id="tasks-form" data-version="${state.providersVersion??''}">${[['chat','日常对话','连续追问、知识问答与阶段分析','chat'],['meal','餐食识别','请选择支持图片输入的模型','image'],['planning','规划建议','训练安排、食谱与阶段规划','leaf'],['motion','动作点评','请选择支持图片的模型，结合骨架与关键截图评价动作','body']].map(([id,label,desc,i])=>`<div class="task-model-field"><label for="task-${id}">${icon(i)} ${label}</label><select id="task-${id}" name="${id}">${taskOptions(id)}</select><small>${desc}</small></div>`).join('')}<div id="tasks-error" role="alert"></div><div class="form-footer"><button type="submit" class="button primary">保存任务模型</button></div></form><div class="notice" style="margin-top:24px">图片能力“待确认”的模型，可在“管理模型”中根据供应商说明设置为“支持图片”，再用于动作点评。</div></section></div>`;
 $('#settings-content').insertAdjacentHTML('beforeend','<section id="web-search-settings" class="card web-search-settings"><p class="muted">正在加载联网设置…</p></section>');
 void loadWebSearchSettings();
}
async function loadWebSearchSettings() {
 const owner=state.store,element=$('#web-search-settings');if(!element)return;
 try{const settings=await api('/web-search');if(state.store===owner&&element.isConnected)element.innerHTML=webSearchSettingsView(settings);}
 catch(error){if(state.store===owner&&element.isConnected)element.textContent=error.message;}
}
function providerEditor(id,presetId='deepseek') {
 const existing=state.providers.find(x=>x.id===id),preset=presetFor(existing?.presetId||presetId);
 state.providerDraft={version:state.providersVersion,id:existing?.id||uid(),presetId:preset.id,protocol:existing?.protocol||preset.protocol,name:existing?.name||preset.name,baseUrl:existing?.baseUrl||preset.baseUrl,apiKey:'',hasKey:existing?.hasKey||false,models:structuredClone(existing?enabledModels(existing):[]),model:existing?.model||'',availableModels:structuredClone(existing?enabledModels(existing):[]),search:'',fetched:false,fetching:false,existing:!!existing};
 renderProviderEditor();
}
function renderProviderEditor() {
 const d=state.providerDraft,preset=presetFor(d.presetId),custom=d.presetId==='custom';
 modal(d.existing?'管理供应商与模型':'连接 AI 供应商',`<form id="provider-form" data-id="${d.id}" autocomplete="off"><div class="provider-editor-top"><div><label for="provider-preset">选择供应商</label><select id="provider-preset" name="presetId">${options(providerPresets.map(p=>[p.id,p.name]),d.presetId)}</select></div>${providerLogo(preset)}</div><p class="description">${esc(preset.description)}</p><div class="field"><div class="row spread"><label for="provider-key">API Key ${d.hasKey?'<span class="badge">已保存</span>':''}</label>${preset.keyUrl?`<a class="link-button" href="${esc(preset.keyUrl)}" target="_blank" rel="noopener noreferrer">获取 API Key ↗</a>`:''}</div><input name="apiKey" id="provider-key" type="password" autocomplete="new-password" value="${esc(d.apiKey)}" placeholder="${d.hasKey?'留空继续使用已保存的密钥':'粘贴此供应商的 API Key'}" maxlength="4096"><small style="display:block;margin-top:8px">${custom?'无鉴权的本地服务可以留空。':'只需填写密钥，接口地址会自动设置。'}</small></div><details class="provider-advanced" ${custom?'open':''}><summary>高级设置 <small>显示名称、接口地址与协议</small></summary><div class="form-grid"><div><label for="provider-name">显示名称</label><input id="provider-name" name="name" value="${esc(d.name)}" required maxlength="100"></div><div><label for="provider-protocol">接口协议</label><select id="provider-protocol" name="protocol">${options([['openai','OpenAI 兼容'],['anthropic','Anthropic / Claude'],['gemini','Google Gemini']],d.protocol)}</select></div><div class="full"><label for="provider-url">接口地址</label><input id="provider-url" type="url" name="baseUrl" value="${esc(d.baseUrl)}" placeholder="https://你的服务地址/v1" required></div></div><p class="provider-footnote">修改接口地址或协议后，需要重新填写密钥。自定义本地服务可使用无密钥连接。</p>${d.existing?`<label class="row" style="margin-top:14px"><input id="provider-clear-key" name="clearKey" type="checkbox" ${d.clearKey?'checked':''}>清除已保存的密钥</label>`:''}</details><div class="divider"></div><div class="card-head"><div><h3 style="margin-bottom:6px">可用模型</h3><small id="provider-model-count">${d.availableModels.length} 个模型 · 已启用 ${d.models.length} 个</small></div>${button(icon('download')+' '+(d.fetched?'刷新模型':'获取模型'),'fetch-models','','subtle')}</div><div id="provider-feedback" role="status" aria-live="polite"></div><div class="model-list-tools"><input type="search" id="provider-model-search" placeholder="搜索模型名称或 ID…" aria-label="搜索供应商模型" value="${esc(d.search)}"><button type="button" class="link-button" data-action="select-visible-models">启用搜索结果</button></div><div class="provider-model-list" id="provider-model-list"></div><details class="manual-model"><summary>找不到模型？手动添加 ID</summary><div class="row"><input id="provider-manual-model" placeholder="供应商提供的完整模型 ID" aria-label="手动模型 ID" maxlength="200">${button('添加','manual-model','','small')}</div><small>用于未提供列表的私有部署或模型别名。</small></details><div class="field" style="margin-top:20px"><label for="provider-model">默认模型（用于测试连接）</label><select id="provider-model" name="model"></select></div><div class="provider-editor-footer"><small>勾选模型后，保存并在任务设置中选择。</small><button class="button primary" type="submit">保存供应商</button></div></form>`,true);
 renderProviderModels();updateProviderSelection();
}
function renderProviderModels() {
 const d=state.providerDraft,el=$('#provider-model-list');if(!d||!el)return;
 const query=d.search.trim().toLocaleLowerCase(),visible=d.availableModels.filter(m=>(m.id+' '+m.name).toLocaleLowerCase().includes(query));
 el.innerHTML=visible.length?visible.map(m=>`<div class="model-option"><label class="model-enable"><input type="checkbox" name="enabled-model" value="${esc(m.id)}" ${d.models.some(x=>x.id===m.id)?'checked':''}><span class="grow"><strong>${esc(m.name||m.id)}</strong>${m.name&&m.name!==m.id?`<small>${esc(m.id)}</small>`:''}</span></label><select class="model-vision" data-model-vision="${esc(m.id)}" aria-label="${esc(m.name||m.id)} 的图片输入能力">${options([['unknown','图片能力待确认'],['true','支持图片'],['false','仅文本']],typeof m.vision==='boolean'?String(m.vision):'unknown')}</select></div>`).join(''):empty(d.availableModels.length?'没有找到匹配模型，试试其他关键词。':d.fetched?'此服务没有返回可用模型，可查看账户权限或手动添加。':'填入 API Key 后，点击“获取模型”。','grid');
}
function updateProviderSelection() {
 const d=state.providerDraft;if(!d||!$('#provider-model'))return;
 if(!d.models.some(m=>m.id===d.model))d.model=d.models[0]?.id||'';
 $('#provider-model').innerHTML=options(d.models.length?d.models.map(m=>[m.id,m.name||m.id]):[['','先勾选要启用的模型']],d.model);
 $('#provider-model-count').textContent=`${d.availableModels.length} 个模型 · 已启用 ${d.models.length} 个`;
}
function readProviderForm() {
 const form=$('#provider-form'),d=state.providerDraft;if(!form||!d)return;
 const values=formData(form);d.clearKey=values.clearKey==='on';for(const key of ['name','apiKey','baseUrl','protocol','model'])if(values[key]!==undefined)d[key]=values[key].trim();
}
function providerPayload(d) {return {id:d.id,presetId:d.presetId,name:d.name,baseUrl:d.baseUrl,protocol:d.protocol,apiKey:d.apiKey,clearKey:!!d.clearKey,models:d.models,model:d.model};}
async function fetchProviderModels() {
 readProviderForm();const d=state.providerDraft;if(!d||d.fetching)return;
 if(!d.baseUrl){$('.provider-advanced').open=true;$('#provider-url').focus();throw new Error('请填写自定义接口地址。');}
 if(!d.apiKey&&(!d.hasKey||d.clearKey)&&presetFor(d.presetId).requiresKey){$('#provider-key').focus();throw new Error('请先填写此供应商的 API Key。');}
 d.fetching=true;const requestId=uid();d.requestId=requestId;
 const connectionInputs=['#provider-preset','#provider-key','#provider-url','#provider-protocol','#provider-clear-key'].map(id=>$(id)).filter(Boolean);connectionInputs.forEach(input=>input.disabled=true);
 const target=$('[data-action="fetch-models"]');target.disabled=true;target.innerHTML='正在获取模型…';$('#provider-feedback').innerHTML='';
 try {
  const response=await api('/providers/models',{method:'POST',body:{provider:providerPayload(d)}});
  if(state.providerDraft!==d||d.requestId!==requestId||!$('#provider-form'))return;
  if(!Array.isArray(response.models))throw new Error('服务没有返回有效的模型列表。');
  const configured=new Map(d.models.map(m=>[m.id,m]));
  const available=new Map(response.models.map(m=>[m.id,{id:m.id,name:m.name||m.id,vision:m.vision??configured.get(m.id)?.vision??null}]));
  for(const model of d.models)if(!available.has(model.id))available.set(model.id,model);
  d.availableModels=[...available.values()];d.models=d.models.map(m=>available.get(m.id));d.fetched=true;
  renderProviderModels();updateProviderSelection();
  $('#provider-feedback').innerHTML=`<div class="notice" style="margin-bottom:14px">已获取 ${response.models.length} 个模型，请勾选要使用的模型。${response.truncated?'模型列表较长，当前仅显示部分结果；其他模型可手动添加。':''}${response.warning?' '+esc(response.warning):''}</div>`;
 }catch(error){if(state.providerDraft===d&&$('#provider-feedback'))$('#provider-feedback').innerHTML=`<div class="error-box" style="margin-bottom:14px">${esc(error.message)}</div>`;}
 finally{d.fetching=false;connectionInputs.forEach(input=>input.disabled=false);if(state.providerDraft===d&&d.requestId===requestId&&$('[data-action="fetch-models"]')){const b=$('[data-action="fetch-models"]');b.disabled=false;b.innerHTML=icon('download')+' '+(d.fetched?'刷新模型':'获取模型');}}
}
async function saveProvider() {
 const d=state.providerDraft;if(!d)return;
 if(d.fetching)throw new Error('模型列表仍在获取，请稍后保存。');
 readProviderForm();
 if(!d.apiKey&&(!d.hasKey||d.clearKey)&&presetFor(d.presetId).requiresKey)throw new Error('请填写此供应商的 API Key。');
 const providers=state.providers.filter(p=>p.id!==d.id).map(p=>({...p}));providers.push(providerPayload(d));
 const selection=reconcileTasks(providers,state.tasks,state.taskModels,d.id,{defaultTasks:state.providers.some(p=>enabledModels(p).length)?['motion']:undefined});
 const saved=await saveProviderConfiguration({providers,...selection},d.version,$('#provider-form'));
 if(!saved||state.providerDraft!==d||!$('#provider-form'))return;
 $('#provider-form').reset();d.apiKey='';state.providerDraft=null;closeModal();renderAISettings();toast('供应商与模型已保存');
}
async function renderReview(container=$('#personal-review')) {
 if(!await readyComputed())return;
 if(!container?.isConnected)return;
 const phases=records('phase').map(r=>r.data).sort((a,b)=>a.date.localeCompare(b.date));const first=phases[0],last=phases.at(-1),delta=first&&last?Number(computed.phaseWeightChange.toFixed(1)):0;
 const done=allCalendarTasks().filter(r=>r.data.taskType==='training'&&r.data.completed),meals=records('meal').filter(r=>r.data.confirmed),dates=new Set(meals.map(r=>r.data.date));
 const mean=computed.meanKcal;
 container.innerHTML=`<h2 class="personal-section-heading">阶段复盘</h2><div class="stats"><div class="stat"><small>已记录体重变化</small><strong>${delta>0?'+':''}${delta}<em>kg</em></strong><p>${first?`${first.date} 至 ${last.date}`:'等待至少两次体重记录'}</p></div><div class="stat"><small>完成训练</small><strong>${done.length}<em>次</em></strong><p>实际完成记录</p></div><div class="stat"><small>饮食记录天数</small><strong>${dates.size}<em>天</em></strong><p>${meals.length} 餐已确认</p></div><div class="stat"><small>有记录日平均摄入</small><strong>${numeric(mean)}<em>kcal</em></strong><p>缺少餐次会低估全天摄入</p></div></div><div class="grid-2"><section class="card"><h2>体重趋势</h2>${phases.length>1?`<div class="trend" role="img" aria-label="体重历史：${esc(phases.map(p=>p.date+' '+p.weight+'kg').join('，'))}">${phases.slice(-12).map(p=>`<div class="trend-column"><span>${p.weight}</span><i style="height:${Math.max(15,(p.weight-Math.min(...phases.map(x=>x.weight))+1)/(Math.max(...phases.map(x=>x.weight))-Math.min(...phases.map(x=>x.weight))+2)*75)}px"></i><span>${p.date.slice(5)}</span></div>`).join('')}</div>`:empty('连续记录几次体重，就能看到趋势。')}<p class="review-summary">${phases.length>1?`这段记录中，体重${delta>0?'上升':delta<0?'下降':'保持'} ${Math.abs(delta)} kg。`:'目前的体重记录还不足以判断趋势。'}体重会受饮水、食物和测量时间影响，建议在相近条件下观察多次记录。</p>${button('更新阶段参数','profile','','small')}</section><section class="card"><h2>把记录放在一起看</h2><p class="review-summary">你已记录 ${done.length} 次训练和 ${meals.length} 餐饮食。${dates.size<7?'继续积累完整记录，有助于判断计划是否适合当前生活节奏。':'复盘时可以结合体重变化、训练表现与饥饿感调整阶段目标。'}</p>${button(icon('spark')+' 请 AI 结合记录复盘','ai-review','','primary')}<p class="description" style="font-size:11px;margin-top:17px">更新阶段参数后会重新计算营养建议；训练计划须主动修改并再次确认。</p></section></div>`;
}
function renderData() {
 const s=state.store;
 $('#personal-data').innerHTML=`<div class="grid-2"><section class="card"><h2>数据与同步</h2><p class="description" style="font-size:12px">同一服务地址下登录同一账号，即可同步电脑与手机的资料、会话、计划、餐食和图片。离线更改保存在当前设备，联网后继续同步。</p><div class="row spread"><small>本地记录</small><span>${[...s.records.values()].filter(r=>!r.deleted).length} 条</span></div><div class="divider"></div><div class="row spread"><small>等待同步</small><span>${s.pending.size} 条</span></div><div class="form-footer">${button('立即同步','sync','','primary')}${button(icon('download')+' 导出我的数据','export')}</div>${s.conflicts.length?`<div class="divider"></div><h3>需要选择保留的版本</h3>${s.conflicts.map(c=>`<div class="notice" style="margin:12px 0"><strong>${esc(s.records.get(c.id)?.kind)} · ${esc(c.id)}</strong><details><summary>查看双方内容</summary><pre style="white-space:pre-wrap;max-height:200px;overflow:auto">本机：${esc(JSON.stringify(s.get(c.id),null,2))}\n服务端：${esc(JSON.stringify(c.server?.data,null,2))}</pre></details><div class="row wrap" style="margin-top:10px">${button('保留本机更改','resolve-conflict',`data-id="${esc(c.id)}" data-local="true"`,'small')}${button('使用服务端版本','resolve-conflict',`data-id="${esc(c.id)}" data-local="false"`,'small')}</div></div>`).join('')}`:''}</section><section class="card"><h2>管理自己的记录</h2><p class="description" style="font-size:12px">会话可在左侧逐条删除；餐食可在编辑页删除；阶段历史可在资料页管理。</p><div class="notice">个人导出包含档案、历史、会话、计划、餐食、图片与设置，不含 API 密钥。导出前会尝试同步本机修改。</div><div class="divider"></div><h3>删除账号及全部数据</h3><p class="description" style="font-size:12px">将删除当前账号的服务端记录、图片、模型密钥和当前设备缓存，其他已登录设备联网后会退出账号。</p>${button('删除全部个人数据','delete-account','','danger')}</section></div>`;
}

function recipeTool() {
 const pref=state.store.get('preferences')||{};
 modal('安排一份合适的食谱',`<p class="description">结合当前目标、训练时间和偏好生成草案。食谱不会自动记入饮食记录。</p><form id="recipe-form"><div class="form-grid"><div><label for="recipe-days">安排几天</label><select name="days" id="recipe-days">${options([[1,'1 天'],[3,'3 天'],[7,'7 天']],1)}</select></div><div><label for="recipe-meal">餐次范围</label><select name="meal" id="recipe-meal">${options([['day','全天'],['breakfast','早餐'],['lunch','午餐'],['dinner','晚餐'],['snack','加餐']],'day')}</select></div><div class="full"><label for="recipe-prefs">饮食偏好</label><input name="preferences" id="recipe-prefs" placeholder="例如：偏爱米饭、素食" value="${esc(pref.preferences||'')}"></div><div class="full"><label for="recipe-restrictions">饮食限制与忌口</label><input name="restrictions" id="recipe-restrictions" placeholder="例如：牛奶、坚果、鱼" value="${esc(pref.restrictions||'')}"></div><div class="full"><label for="recipe-time">训练时间</label><input name="trainingTime" id="recipe-time" type="time" value="${esc(pref.trainingTime||'18:00')}"></div></div><div class="form-footer"><button class="button primary">生成食谱草案</button></div></form><div id="recipe-result"></div>`,true);
}
function recipeResult(recipe) {
 return `<div class="divider"></div><div class="card-head"><h2>${esc(recipe.title)}</h2>${button('让规划模型进一步调整','recipe-ai','','small subtle')}</div>${recipe.days.map(day=>`<section class="plan-day" style="margin-bottom:15px"><h3>第 ${day.day} 天 <small style="float:right">${numeric(day.totals.kcal)} kcal</small></h3>${day.meals.map(meal=>`<div class="exercise-line"><div class="grow"><strong>${esc(meal.name)}</strong><small>${meal.items.map(i=>`${esc(i.name)} ${i.grams}g（${esc(i.state)}）`).join(' · ')}</small><small>${esc(meal.timing||'')}</small></div><span class="rep">${numeric(meal.totals.kcal)} kcal</span></div>`).join('')}</section>`).join('')}<div class="notice">${recipe.notes.map(esc).join('<br>')}</div>`;
}
function foodSwap() {
 modal('食物查询与替换',`<form id="food-swap-form"><div class="form-grid"><div class="full"><label for="food-from">查找食物</label><select id="food-from" name="from">${options(foods.map(f=>[f.id,`${f.name} · ${f.state}`]),foods[0].id)}</select></div><div><label for="food-grams">当前份量 g</label><input id="food-grams" name="grams" type="number" value="100" min="1" max="10000" required></div><div><label for="food-basis">按什么等量替换</label><select id="food-basis" name="basis">${options([['kcal','热量'],['protein','蛋白质'],['carbs','碳水'],['fat','脂肪']],'kcal')}</select></div><div class="full"><label for="food-to">换成</label><select id="food-to" name="to">${options(foods.map(f=>[f.id,`${f.name} · ${f.state}`]),foods[1].id)}</select></div></div><div class="form-footer"><button class="button primary">查看营养与替换结果</button></div></form><div id="swap-result"></div><div class="divider"></div><h3>按实测比例换算生熟重量</h3><form id="cooked-form"><div class="form-grid"><div><label for="batch-raw">整批生重 g</label><input name="raw" id="batch-raw" type="number" value="100" min="1" max="100000" required></div><div><label for="batch-cooked">整批烹调后重量 g</label><input name="cooked" id="batch-cooked" type="number" value="250" min="1" max="100000" required></div><div><label for="portion-raw">要换算的生重 g</label><input name="grams" id="portion-raw" type="number" value="50" min="1" max="100000" required></div></div><div class="form-footer"><button class="button">换算对应熟重</button></div></form><div id="cooked-result"></div>`,true);
}
async function uploadMealFiles(chosen,draft) {
   if(state.mealDraft!==draft||draft._busy||!$('#meal-form'))return;
   readMealForm();
   const destination=draft.attachments;
   if(chosen.length+destination.length>6){toast('每次最多保留 6 个附件',true);return;}
   draft._busy=true;lockMealEditor(true,'正在上传照片…');
   for(const file of chosen){
     try{
       if(file.size>8*1024*1024)throw new Error('单个附件不能超过 8 MB');
       if(!navigator.onLine)throw new Error('上传附件需要联网；离线时仍可手动记录餐食。');
       const ext=file.name.split('.').at(-1).toLowerCase();const type=file.type||({md:'text/markdown',csv:'text/csv',json:'application/json',txt:'text/plain'}[ext]);
       const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
       const saved=await api('/attachments',{method:'POST',body:{name:file.name,type,data:base64}});destination.push(saved);toast(`${file.name} 已上传`);
     }catch(error){toast(error.message,true);}
   }
   draft._busy=false;
   if(state.mealDraft===draft&&$('#meal-form')){renderMealEditor();lockMealEditor(false);const input=$('#meal-notes');input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);}
}
async function chooseFiles({camera=false,meal=false}={}) {
 const owner=attachmentOwner();
 const draft=meal?state.mealDraft:null;
 if(draft?._busy)return;
 const input=document.createElement('input');input.type='file';input.accept=meal||camera?'image/jpeg,image/png,image/webp,image/gif':'.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.md,.csv,.json,'+MOTION_VIDEO_ACCEPT;input.multiple=!camera;if(camera)input.setAttribute('capture','environment');
 input.onchange=async()=>{
   if(!input.files?.length)return;
   if(!meal){addChatFiles(Array.from(input.files),owner);return;}
   await uploadMealFiles(Array.from(input.files),draft);
 };input.click();
}
async function exportData() {
 let data;
 if(navigator.onLine) {await state.store.sync();data=await api('/export');}
 else data={user:state.user,records:[...state.store.records.values()],offline:true,note:'离线导出只包含本机记录；图片原文件请联网后完整导出。'};
 if(state.store.pending.size)data.localPending=[...state.store.pending.values()].map(({token,...rest})=>rest);
 const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`循序健身-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast(data.offline?'已导出本机记录；图片需联网完整导出':'个人数据已导出');
}
function confirmDialog(title,message,action,id='') {modal(title,`<p class="description">${esc(message)}</p><div class="form-footer">${button('取消','close-modal')}${button('确认删除',action,`data-id="${esc(id)}"`,'danger')}</div>`);}
function rememberCommunityReturn() {
  if(!location.hash.startsWith('#community')&&!personalRoute().active)return;
  try{sessionStorage.setItem('fitness:community-return',location.hash);}catch{}
}
function readCommunityReturn() {
  try{
    const value=sessionStorage.getItem('fitness:community-return');
    sessionStorage.removeItem('fitness:community-return');
    return value?.startsWith('#community')||personalRoute(value).active?value:null;
  }catch{return null;}
}
async function communityNavigate(hash) {
  if(hash==='#auth-entry'){
    rememberCommunityReturn();
    await logout();
    location.hash='#auth-entry';
    return;
  }
  hash=canonicalProfileHash(hash);
  if(!String(hash).startsWith('#community')&&!personalRoute(hash).active)return;
  if(location.hash===hash){
    if(personalRoute(hash).active)await navigate('settings',{fromHash:true});
    else if(state.page==='community'&&communityController?.isMounted($('#page')))await communityController.handleRoute(hash);
    else await navigate('community',{fromHash:true});
  }else location.hash=hash;
}
async function navigate(page,{fromHash=false}={}) {
  if(!['chat','nutrition','training','library','motion','community','settings'].includes(page))return;
  const version=++navigationVersion;
  if(page==='community'&&!fromHash&&!location.hash.startsWith('#community'))history.pushState(null,'','#community');
  if(page==='community'){
    const canonical=canonicalProfileHash(location.hash);
    if(canonical!==location.hash){history.replaceState(null,'',canonical);page='settings';fromHash=true;}
  }
  if(page==='settings'&&fromHash)state.setting=personalRoute().section;
  if(page!=='community'&&!fromHash){const hash=page==='settings'?personalHash(state.setting):'#'+page;if(location.hash!==hash)history.pushState(null,'',hash);}
  if(page==='community'&&state.page==='community'&&communityController?.isMounted($('#page'))){
    $('#sidebar')?.classList.remove('open');
    await communityController.handleRoute(location.hash);
    return;
  }
  if(page==='settings'&&state.page==='settings'&&state.setting==='home'&&$('#settings-content')?.dataset.setting==='home'&&communityController?.isMounted($('#personal-community'))){
    $('#sidebar')?.classList.remove('open');
    await communityController.handlePersonalRoute(location.hash);
    return;
  }
  if(communityController?.isMounted())await communityController.unmount();
  if(version!==navigationVersion)return;
  state.page=page;
  if(page==='settings'&&state.setting==='ai')await loadProviders();
  if(version!==navigationVersion)return;
  await render();if(version!==navigationVersion)return;
  if(page==='settings'&&state.setting==='review')$('#personal-review')?.scrollIntoView({block:'start'});
  else window.scrollTo(0,0);return true;
}
window.addEventListener('hashchange',()=>{
  if(!state.user){rememberCommunityReturn();return;}
  const hash=location.hash;
  if(hash.startsWith('#community')){
    navigate('community',{fromHash:true}).catch(error=>toast(error.message,true));
  }else if(personalRoute(hash).active){
    navigate('settings',{fromHash:true}).catch(error=>toast(error.message,true));
  }else{
    const page=hash.slice(1);
    if(['chat','nutrition','training','library','motion'].includes(page)&&page!==state.page)
      navigate(page,{fromHash:true}).catch(error=>toast(error.message,true));
  }
});

// 真人封面加载失败（文件缺失、离线、清单过期）时移除图片并撤掉遮罩，露出底下的矢量图示。
// closest 必须在 remove 之前取：图片一旦脱离文档，closest 只会返回 null。
document.addEventListener('error',event=>{
 const image=event.target;
 if(!(image instanceof HTMLImageElement)||!image.classList.contains('exercise-cover'))return;
 const visual=image.closest('.exercise-visual');image.remove();visual?.removeAttribute('data-cover');
},true);

document.addEventListener('click',async event=>{
 document.querySelectorAll('.task-card-menu[open],.calendar-popover[open]').forEach(menu=>{if(!menu.contains(event.target)||event.target.closest('button[data-action],a[data-action]'))menu.open=false;});
 const target=event.target.closest('[data-action]');if(!target)return;if(target.matches('.calendar-task')&&event.target.closest('.task-card-menu'))return;
 const {action,id}=target.dataset;if(target.tagName==='A')event.preventDefault();
 try {
 switch(action){
 case 'test-web-search':{const owner=state.store,feedback=$('#web-search-status');target.disabled=true;try{if(feedback)feedback.textContent='正在测试搜索连接…';const result=await api('/web-search/test',{method:'POST',body:{}});if(owner===state.store&&feedback?.isConnected)feedback.innerHTML=renderWebResult(result);}finally{if(target.isConnected)target.disabled=false;}break;}
 case 'auth-mode':state.authMode=target.dataset.mode;history.replaceState(null,'',state.authMode==='login'?'#auth-entry':'#auth-register');renderAuth();break;
 case 'auth-jump':{
   const hash=target.dataset.mode==='login'?'#auth-entry':'#auth-register';
   if(location.hash!==hash)location.hash=hash;
   else {$('#auth-entry').scrollIntoView({behavior:'instant'});$('#landing-auth-heading').focus({preventScroll:true});}
   break;
 }
 case 'account-settings':state.setting='account';await navigate('settings');break;
 case 'nav':if(target.dataset.page==='settings')state.setting='home';await navigate(target.dataset.page);break;
 case 'motion-open':modelViewer.close();closeModal();await navigate('motion');break;
 case 'chat-motion-detail':{
   const store=state.store,reportId=target.dataset.reportId;
   if(!reportId?.startsWith('motion:'))throw new Error('动作报告编号无效。');
   if(!store.records.get(reportId)||store.records.get(reportId).deleted)await store.sync();
   if(state.store!==store)break;
   const report=store.records.get(reportId);
   if(!report||report.deleted||report.kind!=='motion-assessment')throw new Error('这份动作报告已删除或尚未同步，请同步后重试。');
   const opened=await navigate('motion');
   if(opened&&state.store===store&&state.page==='motion')await motionView?.openReport(reportId);
   break;
 }
 case 'toggle-sidebar': {
   state.sidebarCollapsed = !state.sidebarCollapsed;
   $('.layout').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
   target.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
   const label = state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏';
   target.setAttribute('aria-label', label); target.title = label;
   try { localStorage.setItem('fitness:sidebar-collapsed', String(state.sidebarCollapsed)); } catch {}
   break;
 }
 case 'menu':$('#sidebar').classList.toggle('open');break;
 case 'close-modal':closeModal();break;
 case 'new-chat':selectConversation(null);await navigate('chat');break;
 case 'open-chat':selectConversation(id);await navigate('chat');break;
 case 'delete-chat':confirmDialog('删除这段对话','删除后，这段会话及消息将从账号记录中移除。','confirm-delete-chat',id);break;
 case 'confirm-delete-chat':if(chatRun?.id===id)await stopChat({discard:true});for(const message of state.store.get(id)?.messages||[])for(const video of message.motionVideos||[])chatMotionVideos.remove(video.id);await state.store.remove(id);chatUploads.clear(attachmentOwner(id),{removeUploaded:true});if(state.conversation===id)selectConversation(null);chatDrafts.delete(id);chatScroll.delete(id);closeModal();render();break;
 case 'attach':await chooseFiles();break;
 case 'camera':await chooseFiles({camera:true});break;
 case 'remove-file':await chatUploads.remove(attachmentOwner(),id);break;
 case 'retry-upload':chatUploads.retry(attachmentOwner(),id);break;
 case 'remove-meal-file':{readMealForm();const [f]=state.mealDraft.attachments.splice(Number(target.dataset.index),1);renderMealEditor();if(f?.id&&!state.store.get(state.mealDraft._id))await api('/attachments/'+f.id,{method:'DELETE',body:{}});break;}
 case 'retry-chat':await sendChat('',id);break;
 case 'stop-chat':await stopChat();break;
 case 'chat-latest':followChat();break;
 case 'preview-image':modal(esc(target.dataset.name||'图片预览'),`<div class="image-preview"><img src="${esc(target.dataset.url)}" alt="${esc(target.dataset.name||'图片')}"></div><div class="form-footer">${button('复制图片','copy-image',`data-url="${esc(target.dataset.url)}"`)}<a class="button" href="${esc(target.dataset.url)}" target="_blank" rel="noopener">打开原图</a></div>`,true);break;
 case 'copy-image':await copyImage(target.dataset.url);toast('图片已复制，可粘贴到输入框');break;
 case 'copy-message':{const message=chatConversation()?.messages.find(message=>message.id===id);if(message){await copyMessageText(message.content||'',message.role==='assistant'?renderMarkdown(message.content):`<p>${esc(message.content)}</p>`);toast('消息已复制');}break;}
 case 'copy-code':{const code=target.closest('.code-block')?.querySelector('code')?.textContent;if(code!==undefined){await navigator.clipboard.writeText(code);target.textContent='已复制';setTimeout(()=>{if(target.isConnected)target.textContent='复制代码';},1500);}break;}
 case 'quick':if(target.dataset.target==='meal')await openMealChat();else if(target.dataset.target==='review'){state.setting='review';await navigate('settings');}else {if(target.dataset.target==='library')state.knowledgeTab='exercises';await navigate(target.dataset.target);}break;
 case 'advice-mode':adviceMode=target.dataset.mode;paintNutritionAdvice();break;
 case 'advice-refresh':await loadNutritionAdvice();break;
 case 'advice-settings':state.setting='ai';await loadProviders();await navigate('settings');break;
 case 'nutrition-day':selectNutritionDate(target.dataset.date);break;
 case 'new-meal':openMeal();break;
 case 'exit-meal-scene':state.chatScene='';updateChatScene();break;
 case 'edit-meal':openMeal(id);break;
 case 'meal-photo':await chooseFiles({meal:true});break;
 case 'meal-camera':await chooseFiles({meal:true,camera:true});break;
 case 'meal-ai':await estimateMeal();break;
 case 'meal-estimate':{const meal=state.store.get(id);if(meal)modal('详细说明',renderMealNotes(meal.estimateNote||meal.notes||'暂无估算说明'),true);break;}
 case 'meal-nutrient-step':{const input=document.getElementById(`meal-${id}-${target.dataset.key}`);const value=Math.max(0,Number(input.value)+Number(target.dataset.step));input.value=Number(value.toFixed(2));await updateMealNutrient(id,target.dataset.key,value);break;}
 case 'meal-review-back':{const m=state.mealDraft;if(m._busy)break;if(!$('#meal-confirm-form').reportValidity())break;m.items=await readMealConfirmationItems();m.date=$('#confirm-meal-date').value;renderMealEditor();break;}
 case 'delete-meal':confirmDialog('删除这餐记录','删除后将从当天摄入总量中扣除。','confirm-delete-meal',id);break;
 case 'confirm-delete-meal':await state.store.remove(id);closeModal();renderNutrition();toast('已删除餐食记录');break;
 case 'plan-builder':planBuilder();break;
 case 'plan-library':await openPlanLibrary();break;
 case 'plan-library-return':await openPlanLibrary(state.librarySelected,true);break;
 case 'library-new':planBuilder(state.libraryDate||state.date);break;
 case 'library-edit':editLibraryTemplate(id);break;
 case 'library-rename':renameLibraryTemplate(id);break;
 case 'library-delete':deleteLibraryTemplate(id);break;
 case 'library-delete-confirm':{assertLibraryCurrent(state.libraryDeleting);await state.store.remove(state.libraryDeleting.id);await openPlanLibrary(null,true);break;}
 case 'view-draft':await openPlanLibrary();break;
 case 'plan-parts-picker':{const index=Number(target.dataset.day);state.partPicker=state.partPicker===index?null:index;updatePlanGroups(`[data-action="plan-parts-picker"][data-day="${index}"]`);break;}
 case 'toggle-training-part':{const index=Number(target.dataset.day),part=target.dataset.part,parts=state.planGroups[index];state.planGroups[index]=parts.includes(part)?parts.filter(id=>id!==part):[...parts,part];updatePlanGroups(state.partPicker===index?`.plan-part-picker [data-day="${index}"][data-part="${part}"]`:`[data-action="plan-parts-picker"][data-day="${index}"]`);break;}
 case 'draft-add-exercise':await changeDraftExercise(target);break;
 case 'draft-remove-exercise':await changeDraftExercise(target,true);break;

 case 'training-day':state.date=target.dataset.date;renderTraining();break;
 case 'training-reopen':{const record=assertTaskCurrent(state.calendarDetail);if(record.id!==id)throw new Error('请重新打开训练。');const data=structuredClone(record.data);data.completed=false;delete data.actual;delete data.completedAt;data.daySnapshot.exercises.forEach(exercise=>exercise.completed=false);await saveTrainingProgress(record,data);renderTraining();showCalendarTask(id);break;}
 case 'log-training':logTraining(id);break;
 case 'busy-days':await openBusyDays();break;
 case 'busy-month':await changeBusyMonth(Number(target.dataset.offset));break;
 case 'busy-current':await changeBusyMonth(0,true);break;
 case 'busy-weekday':{const editor=state.busyEditor,day=Number(target.dataset.weekday);editor.expanded=true;editor.weekdays=editor.weekdays.includes(day)?editor.weekdays.filter(item=>item!==day):[...editor.weekdays,day].sort((a,b)=>a-b);renderBusyDays();$(`[data-action="busy-weekday"][data-weekday="${day}"]`).focus({preventScroll:true});break;}
 case 'busy-toggle':{const date=target.dataset.date;if(date<today())break;state.busyEditor.settings.overrides[date]=!await calculate('isBusyDate',date,await busyEditorSettings());renderBusyDays(date);break;}
 case 'busy-save':{const controls=[...$('#modal').querySelectorAll('button')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);try{await saveBusyDays();}catch(error){$('#busy-days-error').innerHTML=`<div class="error-box">${esc(error.message)}</div>`;}finally{controls.forEach(({node,disabled})=>node.disabled=disabled);}break;}
 case 'calendar-week':state.date=addDays(state.date,Number(target.dataset.offset));renderTraining();break;
 case 'calendar-today':state.date=today();renderTraining();break;
 case 'calendar-reset':modal('重置日历',`<p class="description">清空日程并停止循环排期。已确认的训练历史、成就和方案库会保留。</p><div class="form-footer">${button('取消','close-modal')}${button('确认重置','calendar-reset-confirm','','danger')}</div>`);break;
 case 'calendar-reset-confirm':target.disabled=true;try{await resetTrainingCalendar();}finally{target.disabled=false;}break;
 case 'calendar-add':planBuilder(target.dataset.date||state.date);break;
 case 'calendar-schedule':target.disabled=true;try{await addPlanToCalendar(plan(),state.date);renderTraining();toast('已添加循环训练');}finally{target.disabled=false;}break;
 case 'calendar-edit':openCalendarTask(id);break;
 case 'calendar-detail':showCalendarTask(id);break;
 case 'training-exercise-toggle':{
  const detail=state.calendarDetail,dialog=$('#modal'),scroll=dialog.scrollTop,index=Number(target.dataset.index);
  const toggles=[...dialog.querySelectorAll('.training-exercise-toggle')];toggles.forEach(node=>node.disabled=true);
  try{
   await toggleTrainingExercise(id,index);
   if(state.page==='training')renderTraining();
   if(dialog.open&&dialog.classList.contains('training-content-modal')&&state.calendarDetail===detail&&dialog.contains(target)){
    showCalendarTask(id);dialog.scrollTop=scroll;
    $(`.training-exercise-toggle[data-index="${index}"]`,dialog)?.focus({preventScroll:true});
   }
  }finally{toggles.forEach(node=>node.disabled=false);}
  break;
 }
 case 'training-content-edit':openTrainingContentEditor(id);break;
 case 'training-content-add':changeTrainingContentExercise(target);break;
 case 'training-content-remove':changeTrainingContentExercise(target,true);break;
 case 'calendar-delete':{const record=calendarTask(id);if(!record)throw new Error('这项训练已被删除。');state.calendarDelete=structuredClone(record);confirmDialog('删除训练',trainingTaskCompleted(record)?`从日程中移除「${record.data.title}」？已确认的训练历史与成就会保留。`:`从日程中删除「${record.data.title}」？`,'calendar-delete-confirm',id);break;}
 case 'calendar-delete-confirm':{const record=assertTaskCurrent(state.calendarDelete);if(record.id!==id)throw new Error('这项任务不能删除。');target.disabled=true;try{await syncBeforeArchiving();assertTaskCurrent(record);await state.store.remove(record.id);state.calendarDelete=null;closeModal();renderTraining();toast('已从日程中删除');}finally{target.disabled=false;}break;}
 case 'strength':strengthTool();break;
 case 'exercise':showExercise(id);break;
 case 'knowledge-tab':if(state.knowledgeTab!==target.dataset.tab){state.knowledgeTab=target.dataset.tab;renderLibrary({transition:true});}break;
 case 'portion-preset':choosePortion(id);break;
 case 'rm-preset':chooseRMPreset(target.dataset.reps,target.dataset.side);break;
 case 'rm-method':chooseRMMethod(target.dataset.method);break;
 case 'muscle-model':showMuscle(id);break;
 case 'open-visual':target.dataset.type==='muscle'?showMuscle(id):showExercise(id);break;
 case 'knowledge':{const k=knowledgeCards.find(x=>x.id===id);if(k)modal(esc(k.title),`<span class="badge neutral">${esc(k.review.note)}</span><p class="description" style="margin-top:18px">${esc(k.summary)}</p><a class="link-button" href="${esc(k.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(k.sourceName)} ↗</a><p style="font-size:10px;color:#8b9981;margin-top:15px">来源核对日期：${esc(k.review.date)}</p>`);break;}
 case 'profile':showProfile();break;
 case 'delete-phase':confirmDialog('删除阶段历史','只删除这条历史记录，当前个人资料保持不变。','confirm-delete-phase',id);break;
 case 'confirm-delete-phase':await state.store.remove(id);closeModal();renderProfile();break;
 case 'achievement-filter':state.achievementCategory=target.dataset.category;state.achievementPage=0;renderAchievements();break;
 case 'achievement-page':state.achievementPage=Number(target.dataset.page);renderAchievements();break;
 case 'achievement-detail':showAchievement(id);break;
 case 'settings-tab':if(personalSections.some(([section])=>section===target.dataset.tab)){state.setting=target.dataset.tab;await navigate('settings');}break;
 case 'provider':providerEditor(id);break;
 case 'provider-preset':providerEditor(null,target.dataset.preset);break;
 case 'fetch-models':await fetchProviderModels();break;
 case 'reload-providers':{
   const user=state.user,store=state.store;target.disabled=true;
   try {
     const loaded=await loadProviders();if(state.user!==user||state.store!==store||!target.isConnected)break;
     if(!loaded)throw new Error('暂时无法加载最新配置，请稍后重试。');
     if(target.closest('#modal'))closeModal();
     if($('#settings-content')&&state.setting==='ai')renderAISettings();
     toast('已加载最新配置，请重新修改后保存');
   } finally {target.disabled=false;}
   break;
 }
 case 'select-visible-models':{const d=state.providerDraft,q=d.search.trim().toLowerCase();const selected=new Map(d.models.map(m=>[m.id,m]));for(const m of d.availableModels)if((m.id+' '+m.name).toLowerCase().includes(q))selected.set(m.id,m);d.models=[...selected.values()];renderProviderModels();updateProviderSelection();break;}
 case 'manual-model':{const d=state.providerDraft,value=$('#provider-manual-model').value.trim();if(!value)throw new Error('请填写模型 ID。');if(!d.availableModels.some(m=>m.id===value))d.availableModels.push({id:value,name:value,vision:null});if(!d.models.some(m=>m.id===value))d.models.push(d.availableModels.find(m=>m.id===value));d.search='';$('#provider-model-search').value='';$('#provider-manual-model').value='';renderProviderModels();updateProviderSelection();break;}
 case 'test-provider':target.disabled=true;try{const r=await api('/providers/test',{method:'POST',body:{id}});toast(r.message||'连接成功');}finally{target.disabled=false;}break;
 case 'delete-provider':state.providerDeleteVersion=state.providersVersion;confirmDialog('删除 AI 服务','使用此服务的任务将需要重新选择模型。','confirm-delete-provider',id);break;
 case 'confirm-delete-provider':{const providers=state.providers.filter(p=>p.id!==id);const selection=reconcileTasks(providers,state.tasks,state.taskModels),scope=$('#modal .modal-content');const saved=await saveProviderConfiguration({providers,...selection},state.providerDeleteVersion,scope);if(saved&&target.isConnected){closeModal();if($('#settings-content')&&state.setting==='ai')renderAISettings();}break;}
 case 'ai-review':state.conversation=null;closeModal();await navigate('chat');await sendChat('请结合我的阶段体重、饮食和实际训练记录复盘。指出记录不足和趋势的不确定性，并建议下一阶段可调整的参数。不要改写我的固定训练计划。');break;
 case 'recipe':recipeTool();break;
 case 'recipe-ai':{if(!state.recipe)return;target.disabled=true;try{const response=await api('/ai',{method:'POST',body:{task:'planning',messages:[{role:'user',content:'请结合我的训练时间、偏好与忌口，对以下食谱草案给出可操作的调整说明和单餐替换，避免忽略任何饮食限制。不要自动记账。'+JSON.stringify({recipe:state.recipe,preferences:state.store.get('preferences')})}],context:aiContext()}});$('#recipe-result').insertAdjacentHTML('beforeend',`<div class="notice" style="margin-top:18px;white-space:pre-wrap">${esc(response.content)}</div>`);}finally{target.disabled=false;}break;}
 case 'food-swap':foodSwap();break;
 case 'sync':if(state.store.status==='expired'){await logout();break;}await state.store.sync();if($('#personal-data')){renderData();toast(state.store.conflicts.length?'请选择需要保留的数据版本':'同步完成');}else if(state.store.conflicts.length){state.setting='data';await navigate('settings');}else{renderPage({transition:false});toast('同步完成');}break;
 case 'resolve-conflict':await state.store.resolve(id,target.dataset.local==='true');renderData();break;
 case 'export':target.disabled=true;try{await exportData();}finally{target.disabled=false;}break;
 case 'delete-account':modal('删除全部个人数据',`<div class="error-box">此操作会删除账号与全部记录，无法恢复。可先导出个人数据。</div><form id="delete-account-form" style="margin-top:20px"><div class="field"><label for="delete-password">输入当前密码确认</label><input id="delete-password" name="password" type="password" autocomplete="current-password" required></div><div class="form-footer">${button('取消','close-modal')}<button class="button danger">删除账号及全部数据</button></div></form>`);break;
 case 'logout':await logout();break;
 }
 }catch(error){toast(error.message,true);}
});

document.addEventListener('invalid',event=>{
 const day=event.target.closest('#draft-form .draft-day');if(day)day.open=true;
},true);

document.addEventListener('submit',async event=>{
 const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();const values=formData(form);const submit=form.querySelector('button[type="submit"],button:not([type])');if(submit)submit.disabled=true;
 if(form.id==='tasks-form')$('#tasks-error').textContent='';
 try {
 switch(form.id){
 case 'web-search-form':{const owner=state.store;const settings=await api('/web-search',{method:'PUT',body:{version:Number(form.dataset.version),provider:values.provider,enabled:form.elements.enabled.checked,clearKey:form.elements.clearKey.checked,...(values.apiKey?{apiKey:values.apiKey}:{})}});form.reset();if(owner===state.store&&$('#web-search-settings')){$('#web-search-settings').innerHTML=webSearchSettingsView(settings);toast('联网设置已保存');}break;}
 case 'auth-form':{const {user}=await api('/auth/'+state.authMode,{method:'POST',body:values});await enter(user);break;}
 case 'nutrition-feedback-form':{const setting=await calculate('validateNutritionFeedbackSettings',{date:today(),enabled:form.elements.enabled.checked,manualAdjustmentKcal:Number(values.manualAdjustmentKcal)});await state.store.put('nutrition-feedback-settings','nutrition-feedback-settings:'+today(),setting);await renderNutrition();toast('热量校准设置已保存，从今天起生效');break;}
 case 'profile-form':{const p=await calculate('validateProfile',{...profile(),...values,activity:values.activity?Number(values.activity):profile()?.activity||1.375});await calculate('calculateNutrition',p);const date=values.date||today();delete p.date;await state.store.putMany([{kind:'profile',id:'profile',data:p},{kind:'phase',id:uid(),data:{...p,date}}]);closeModal();render();toast('阶段资料已保存，营养建议已更新');break;}
 case 'chat-form':if(values.message.length>16000)throw new Error('单条消息请控制在 16000 字以内。');if(values.message.trim()||chatUploads.list(attachmentOwner()).length)await sendChat(values.message.trim());break;
 case 'meal-form':await estimateMeal();break;
 case 'meal-confirm-form':await confirmMeal();break;
 case 'metabolism-form':case 'macro-energy-form':case 'portion-form':case 'weight-conversion-form':updateKnowledgeTool(form);break;
 case 'plan-form':{await ensurePlanLibrary();const draft=await calculate('generateGroupedPlan',{split:state.planSplit,groups:state.planGroups.slice(0,state.planSplit),variant:values.variant},profile()),id='template:'+uid();if(state.planStartDate)draft.scheduleDate=state.planStartDate;await state.store.putMany(await calculate('createLibraryTemplate',computeRecords(),draft,id,new Date().toISOString()));state.libraryDate=state.planStartDate<today()?today():state.planStartDate;state.librarySelected=id;state.libraryEditing=structuredClone(state.store.records.get(id));viewDraft();break;}
 case 'draft-form':{const draft=readDraftForm();draft.name=draft.name.trim();await calculate('libraryPlan',{id:state.libraryEditing.id,kind:'training-template',data:draft});await saveLibraryDraft(draft);await openPlanLibrary(state.libraryEditing.id,true);break;}
 case 'plan-library-form':await importLibraryTemplate(values);break;
 case 'library-rename-form':{const record=assertLibraryCurrent(state.libraryRenaming),name=values.name.trim();if(!name||name.length>80)throw new Error('方案名称需为 1–80 个字。');await state.store.put(record.kind,record.id,{...record.data,name,libraryRevision:uid()});await openPlanLibrary(record.id,true);break;}
 case 'calendar-task-form':await saveCalendarTask(values);break;
 case 'training-content-form':await saveTrainingContent();break;
 case 'training-log':{const record=assertTaskCurrent(state.trainingLog),s=record.data,day=taskDay(record);await saveTrainingProgress(record,{...s,daySnapshot:structuredClone(day),completed:true,notes:values.notes,actual:day.exercises.map((e,i)=>({exerciseId:e.exerciseId,sets:Number(values['sets-'+i]),reps:values['reps-'+i],weight:Number(values['weight-'+i])})),completedAt:s.completedAt||new Date().toISOString()});renderTraining();showCalendarTask(record.id);toast('训练已记录');break;}
 case 'strength-form':{const r=await calculate('estimate1RM',Number(values.weight),Number(values.reps));$('#strength-result').innerHTML=`<div class="divider"></div><div class="grid-2"><div class="stat"><small>Epley 参考</small><strong>${r.epley}<em>kg</em></strong></div><div class="stat"><small>Brzycki 参考</small><strong>${r.brzycki}<em>kg</em></strong></div></div><p class="description" style="margin-top:18px">${esc(r.note)}</p>`;break;}
 case 'provider-form':await saveProvider();break;
 case 'tasks-form':{const tasks={},taskModels={};for(const task of ['chat','meal','planning','motion']){const selected=values[task]?JSON.parse(values[task]):{};tasks[task]=selected.providerId||'';taskModels[task]=selected.modelId||'';}const version=form.dataset.version===''?null:Number(form.dataset.version);const saved=await saveProviderConfiguration({providers:state.providers,tasks,taskModels},version,form);if(saved&&form.isConnected){form.dataset.version=String(state.providersVersion);toast('任务模型已保存');}break;}
 case 'recipe-form':{if(!await readyComputed())break;const pref={preferences:values.preferences,restrictions:values.restrictions,trainingTime:values.trainingTime};const result=await calculate('suggestRecipe',{...values,days:Number(values.days),profile:profile(),adjustmentKcal:computed.nutritionFeedback?.adjustmentKcal||0});await state.store.put('preferences','preferences',pref);state.recipe=result;$('#recipe-result').innerHTML=recipeResult(result);break;}
 case 'food-swap-form':{const r=await calculate('substituteFood',values.from,Number(values.grams),values.to,values.basis),from=foods.find(f=>f.id===values.from),to=foods.find(f=>f.id===values.to);$('#swap-result').innerHTML=`<div class="divider"></div><h3>${esc(from.name)} ${values.grams}g → ${esc(to.name)} ${r.grams}g</h3><table class="history-table"><thead><tr><th>营养</th><th>替换前</th><th>替换后</th><th>变化</th></tr></thead><tbody>${[['kcal','能量 kcal'],['protein','蛋白质 g'],['carbs','碳水 g'],['fat','脂肪 g']].map(([k,n])=>`<tr><td>${n}</td><td>${r.before[k]}</td><td>${r.after[k]}</td><td>${r.delta[k]>0?'+':''}${r.delta[k]}</td></tr>`).join('')}</tbody></table><p class="description">${esc(r.note)}</p><small>${esc(from.source)}<br>${esc(to.source)}</small>`;break;}
 case 'cooked-form':{const r=await calculate('convertFoodWeight',Number(values.grams),Number(values.raw),Number(values.cooked));$('#cooked-result').innerHTML=`<div class="notice">对应熟重约 <strong>${r.grams} g</strong><br>${esc(r.note)}</div>`;break;}
 case 'delete-account-form':await deleteAccount(values.password);break;
 }
 }catch(error){const errorBox=form.id==='auth-form'?$('#auth-error'):form.id==='profile-form'?$('#profile-error'):form.id==='tasks-form'?$('#tasks-error'):form.id==='calendar-task-form'?$('#calendar-task-error'):form.id==='training-content-form'?$('#training-content-error'):form.id==='plan-library-form'?$('#plan-library-error'):null;if(errorBox)errorBox.innerHTML=`<div class="error-box" style="margin:12px 0">${esc(error.message)}</div>`;else toast(error.message,true);}
 finally {if(submit)submit.disabled=false;if(form.id==='chat-form')updateChatControls();}
});

document.addEventListener('change',async event=>{
 if(event.target.id==='web-search-provider'){updateWebSearchProviderFields(event.target.form);return;}
 const target=event.target;
 if(target.matches('[data-meal-category]')){
   try{
     await (mealNutrientWrites.get(target.dataset.id)||Promise.resolve());
     const meal=state.store.get(target.dataset.id),index=Number(target.dataset.mealCategory),category=target.value;
     if(!meal||!['正餐','加餐','零食'].includes(category))return;
     await state.store.put('meal',target.dataset.id,{...meal,items:meal.items.map((item,i)=>i===index?{...item,category}:item),updatedAt:new Date().toISOString()});
   }catch(error){toast(error.message,true);}
   return;
 }
 if(target.matches('[data-meal-nutrient]')){
   try{if(target.value===''||!target.reportValidity())throw new Error('请填写不小于 0 的营养数值。');await updateMealNutrient(target.dataset.id,target.dataset.mealNutrient,Number(target.value));}
   catch(error){const meal=state.store.get(target.dataset.id);if(meal)target.value=mealTotals(meal.items)[target.dataset.mealNutrient];toast(error.message,true);}
   return;
 }
 if(target.closest('#plan-form')&&target.name==='split'){state.planSplit=Number(target.value);state.partPicker=null;updatePlanGroups();return;}
 if(target.closest('#training-content-form')){
   try {
     if(target.dataset.exerciseIndex!==undefined){
       const index=Number(target.dataset.exerciseIndex),previous=state.trainingContentEditor.day.exercises[index],timed=exerciseUsesSeconds(target.value);
       if(exerciseUsesSeconds(previous.exerciseId)!==timed)$(`#content-reps-${index}`).value=defaultTrainingExercise(target.value).reps.replace(/秒$/,'');
       $(`label[for="content-reps-${index}"]`).textContent=timed?'秒':'次数';
     }
     readTrainingContentForm();
   }catch(error){toast(error.message,true);}
   return;
 }
 if(target.closest('#draft-form')){try{updateDraftExerciseUnit(target);const draft=readDraftForm();state.draftEditor=draft;await saveLibraryDraft(draft);}catch(error){toast(error.message,true);}return;}
 if(target.name==='library-template'){const scroll=$('.plan-library-list').scrollTop;state.librarySelected=target.value;renderPlanLibrary();$('.plan-library-list').scrollTop=scroll;$('input[name="library-template"]:checked').focus({preventScroll:true});return;}
 if(target.id==='library-start-date'){state.libraryDate=target.value;return;}
 if(target.name==='enabled-model'&&state.providerDraft){const d=state.providerDraft;if(target.checked){const m=d.availableModels.find(m=>m.id===target.value);if(m&&!d.models.some(x=>x.id===m.id))d.models.push(m);}else d.models=d.models.filter(m=>m.id!==target.value);updateProviderSelection();return;}
 if(target.matches('[data-model-vision]')&&state.providerDraft){const d=state.providerDraft,id=target.dataset.modelVision,vision=target.value==='true'?true:target.value==='false'?false:null;for(const model of [...d.availableModels,...d.models])if(model.id===id)model.vision=vision;return;}
 try {
 switch(target.id){
 case 'provider-preset':{const d=state.providerDraft,preset=presetFor(target.value);Object.assign(d,{presetId:preset.id,name:preset.name,protocol:preset.protocol,baseUrl:preset.baseUrl,apiKey:'',hasKey:false,models:[],availableModels:[],model:'',search:'',fetched:false,fetching:false,requestId:uid()});renderProviderEditor();break;}
 case 'provider-clear-key':if(state.providerDraft)state.providerDraft.clearKey=target.checked;break;
 case 'provider-model':if(state.providerDraft)state.providerDraft.model=target.value;break;
 case 'provider-url':case 'provider-protocol':{readProviderForm();const d=state.providerDraft,old=state.providers.find(p=>p.id===d?.id);if(old&&(d.baseUrl!==old.baseUrl||d.protocol!==old.protocol)){d.hasKey=false;$('#provider-key').placeholder='目标已改变，请重新填写 API Key';$('#provider-feedback').innerHTML='<div class="notice" style="margin-bottom:14px">接口地址或协议已改变，请重新填写密钥后获取模型。</div>';}break;}
 case 'nutrition-date':case 'training-date':if(target.value){state.date=target.value;renderPage();}break;
 case 'task-day':{const day=plan()?.days.find(d=>d.id===target.value);if(day)$('#task-title').value=day.name;break;}
 case 'portion-food':choosePortion(target.value);break;
 case 'calc-sex':case 'calc-activity':updateKnowledgeTool(target.closest('form'));break;
 case 'variant':if(target.closest('#plan-form'))updateVariantDescription();break;

 case 'muscle-filter':state.muscle=target.value;renderLibrary();break;
 case 'equipment-filter':state.equipment=target.value;renderLibrary();break;
 }
 }catch(error){toast(error.message,true);}
});
$('#modal').addEventListener('close',()=>{if(state.scheduleRefreshPending){state.scheduleRefreshPending=false;if(state.user&&state.page==='training'&&$('#page'))renderTraining();}playWeeklyCelebration();});

document.addEventListener('focusin',event=>{
 document.querySelectorAll('.task-card-menu[open],.calendar-popover[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});
});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){const menu=$('.task-card-menu[open],.calendar-popover[open]');if(menu){event.preventDefault();menu.open=false;$('summary',menu).focus();return;}}
 const tab=event.target.closest('.knowledge-tabs [role="tab"]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const tabs=['nutrition','portions','weights','exercises','muscles'],index=tabs.indexOf(state.knowledgeTab);
 state.knowledgeTab=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
 renderLibrary({transition:true});$('#knowledge-tab-'+state.knowledgeTab)?.focus();
});

document.addEventListener('input',event=>{
 if(event.target.closest('#metabolism-form,#macro-energy-form,#portion-form,#weight-conversion-form'))updateKnowledgeTool(event.target.closest('form'));
 if(event.target.id==='provider-model-search'&&state.providerDraft){state.providerDraft.search=event.target.value;renderProviderModels();}
 if(event.target.id==='exercise-search'){const start=event.target.selectionStart;state.filter=event.target.value;renderLibrary();$('#exercise-search').focus();$('#exercise-search').setSelectionRange(start,start);}
});
async function deleteAccount(password) {
  closeAccountSettings();
  const user=state.user,store=state.store,community=communityController;if(!user||!store)return;
  const current=()=>state.user===user&&state.store===store;
  await stopChat();if(!current())return;
  try {await api('/account',{method:'DELETE',headers:{'X-Fitness-User':user.id},body:{password}});}
  catch(error){if(!current())return;throw error;}
  if(current())closeMotionView();
  // Cleanup always belongs to the account that sent DELETE, including after logout.
  if(community){await community.clearAccountData();await community.destroy();if(communityController===community)communityController=null;}
  else await clearCommunityDrafts(user.id);
  clearCommunityLocalData(user.id);
  await Promise.all([...chatUploads.owners.keys()].filter(owner=>owner.startsWith(user.id+':')).map(owner=>chatUploads.clear(owner)));
  const deletedStore=store.closed?await new RecordStore(user).open():store;
  try {await deletedStore.clear();}finally {await deletedStore.close();}
  // A newer login can occur during any of the cleanup awaits above.
  if(!current())return;
  chatMotionVideos.clear();modelViewer.destroy();localStorage.removeItem('fitness:last-user');setApiUser(null);
  state.user=null;state.store=null;state.providers=[];state.providersVersion=null;state.providersConflict=false;providerSettings=null;
  state.tasks={};state.taskModels={};state.providerDraft=null;state.files=[];state.conversation=null;state.authMode='login';
  chatDrafts.clear();chatScroll.clear();closeModal();renderAuth();toast('账号、个人记录与社区数据已删除');
}
async function logout() {
  closeAccountSettings();
  const user=state.user,store=state.store,community=communityController;if(!user)return;
  const current=()=>state.user===user&&state.store===store;
  closeMotionView();
  rememberCommunityReturn();
  await community?.destroy();if(communityController===community)communityController=null;
  if(!current())return;
  modelViewer.destroy();
  await chatUploads.clearAll({removeUploaded:true});if(!current())return;
  await stopChat();if(!current())return;chatMotionVideos.clear();
  if(store?.status!=='expired')try{await api('/auth/logout',{method:'POST',headers:{'X-Fitness-User':user.id},body:{}});}catch(error){if(!current())return;if(![401,409].includes(error.status)){if(state.page==='motion')renderMotion();throw error;}}
  await store?.close?.();if(!current())return;
  localStorage.removeItem('fitness:last-user');setApiUser(null);state.user=null;state.store=null;state.providers=[];state.providersVersion=null;state.providersConflict=false;providerSettings=null;state.tasks={};state.taskModels={};state.providerDraft=null;state.files=[];state.conversation=null;state.authMode='login';chatDrafts.clear();chatScroll.clear();renderAuth();
}
$('#modal').addEventListener('cancel',()=>{if($('#provider-form'))clearProviderDraft();});
window.addEventListener('online',()=>state.store?.sync().then(()=>{toast('已恢复网络，记录已同步');}).catch(e=>toast(e.message,true)));
matchMedia('(max-width:700px)').addEventListener('change',()=>{if(state.user&&state.page==='settings'&&state.setting==='achievements'){state.achievementPage=0;renderAchievements();}});
window.addEventListener('offline',()=>{if(state.store){state.store.status='offline';updateSync();}});
window.addEventListener('beforeunload',event=>{
 if(motionStore===state.store&&motionView?.hasUnsavedWork()){
   event.preventDefault();event.returnValue='';
 }
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateSidebarQuote();if(state.store&&navigator.onLine)state.store.sync().catch(()=>{});}});
setInterval(()=>{if(!document.hidden){updateSidebarQuote();if(state.store&&navigator.onLine)state.store.sync().catch(()=>{});}},30000);
boot().catch(error=>{$('#app').innerHTML=`<div class="boot"><h2>暂时无法打开健身空间</h2><p>${esc(error.message)}</p><a class="button primary" href="/">重新加载</a></div>`;});
