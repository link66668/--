// Community acceptance in isolated Edge sessions and a temporary database.
// QA_PLAYWRIGHT and QA_BROWSER can select existing local testing tools.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startServer} from '../server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa','community-'));
const playwrightCandidates=[process.env.QA_PLAYWRIGHT,join(root,'精细模型与动作开发/node_modules/playwright/index.mjs'),join(root,'.qa/community-tools/node_modules/playwright/index.mjs')].filter(Boolean);
const playwrightPath=playwrightCandidates.find(path=>existsSync(path));
if(!playwrightPath)throw new Error('请设置 QA_PLAYWRIGHT 为本机 Playwright 模块路径');
const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
const emailAlice='community-qa-alice@example.test',emailBob='community-qa-bob@example.test',password='community-qa-password-123';
const server=await startServer({host:'127.0.0.1',port:0,dataDir,communityModeratorEmails:[emailAlice]});
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const aliceContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const bobContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
// LAN HTTP does not expose crypto.randomUUID; keep the established fallback usable.
await bobContext.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
const page=await bobContext.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const checks=[];
let step='setup',guestContext,firstUseContext,scrollTouchContext;
const api=async(context,path,method='GET',body)=>{
  const response=await context.request.fetch(base+'/api'+path,{method,...(body===undefined?{}:{data:body})});
  const result=await response.json();assert(response.ok(),`${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);return result;
};
const community=(context,path,method='GET',body)=>api(context,'/community'+path,method,body);
const register=async(context,email,name)=>{
  const {user}=await api(context,'/auth/register','POST',{email,password,name});
  return user;
};
const profile=async context=>api(context,'/sync','POST',{changes:[{id:'profile',kind:'profile',data:{age:25,height:172,weight:68,sex:'male',goal:'maintain',activity:1.375},baseVersion:0}]});
const upload=async(context,file,type)=>{
  const response=await context.request.post(base+'/api/community/media?purpose=note',{headers:{'Content-Type':type,'X-Filename':encodeURIComponent(file.split(/[\\/]/).at(-1))},data:await readFile(file)});
  const result=await response.json();assert(response.ok(),`Upload: ${response.status()} ${JSON.stringify(result)}`);return result.media||result;
};
const route=async(hash,target=page)=>{await target.evaluate(hash=>{location.hash=hash;},hash);};
const shot=async(name,target=page)=>target.screenshot({path:join(dataDir,name+'.png'),fullPage:true,style:'#toasts{visibility:hidden}'});
const noOverflow=async target=>{const size=await target.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth}));assert(size.body<=size.width+1,`Overflow ${JSON.stringify(size)}`);};
const touchTargets=async(target=page)=>{
  const failures=await target.evaluate(()=>[...document.querySelectorAll('.community-content button,.community-content a[data-cm],label[for="cm-files"],label[for="cm-cover-file"],label[for="cm-avatar-file"],.cm-detail-dialog button,.cm-detail-dialog a[data-cm],.cm-aux-dialog button')].filter(element=>!element.disabled&&!element.classList.contains('cm-sr')&&element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden').map(element=>{const box=element.getBoundingClientRect();return {action:element.dataset.cm||element.textContent.trim().slice(0,20),width:box.width,height:box.height};}).filter(box=>box.width<43.5||box.height<43.5));
  assert.deepEqual(failures,[],'Community controls must provide 44px touch targets');
};
const waitNotes=async target=>{await target.locator('.cm-note[data-note]').first().waitFor();await target.waitForFunction(()=>!document.querySelector('.cm-list-status .cm-spinner,.cm-skeleton.cm-note,.cm-profile-panel[aria-busy="true"]'));};
const waitPublished=async action=>{
  const responsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/community/notes');
  await action();const response=await responsePromise;const result=await response.json();assert(response.ok(),JSON.stringify(result));return result.note||result;
};
const closeDetail=async(target=page)=>{await target.locator('.cm-detail-dialog [data-cm="detail-close"]').click();await target.locator('.cm-detail-dialog').waitFor({state:'hidden'});};

try{
  const alice=await register(aliceContext,emailAlice,'循序训练记录');await profile(aliceContext);
  const bob=await register(bobContext,emailBob,'循序体验用户');await profile(bobContext);
  const covers=['squat','bench','row','lunge','rdl','plank','pullup'];
  const seeded=[];
  for(const [index,cover] of covers.entries()){
    const media=await upload(aliceContext,join(root,'public/assets/exercises',cover+'.jpg'),'image/jpeg');
    seeded.push((await community(aliceContext,'/notes','POST',{clientMutationId:crypto.randomUUID(),title:['每一次训练，都留下记录','慢慢找到自己的节奏','记录今天的背部训练','训练后的微小进步','给日常留一点运动时间','第一次坚持完整的一周','分享我的训练笔记'][index],body:'隔离验收内容：记录训练过程，分享今天的感受。\n这份笔记仅存在于临时测试数据库。',category:index%2?'experience':'training',topics:['训练记录'],type:'image',media:[{id:media.id,role:'image',isCover:true}]})).note);
  }
  for(let index=0;index<4;index++)seeded.push((await community(aliceContext,'/notes','POST',{clientMutationId:crypto.randomUUID(),title:'今天的小小进步 '+(index+1),body:'给自己留一段记录。坚持来自每一天的日常。',category:'checkin',topics:[],type:'text',media:[]})).note);

  step='desktop feed and sidebar';console.log(step);
  await page.goto(base+'/#community');await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),11);
  assert.equal(await page.locator('.nav [data-page="community"]').getAttribute('aria-current'),'page');
  for(const width of [1024,1440,1920]){await page.setViewportSize({width,height:1000});await noOverflow(page);await touchTargets();await shot('feed-'+width);}
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-action="toggle-sidebar"]').click();await noOverflow(page);await page.locator('[data-action="toggle-sidebar"]').click();
  checks.push('desktop feed, responsive columns, expanded and collapsed sidebar');

  step='detail, follow, like, collection and comments';console.log(step);
  const imageCard=page.locator('.cm-note').filter({has:page.locator('img.cm-cover-image')}).first();
  const noteId=await imageCard.getAttribute('data-note');
  await imageCard.locator('[data-cm="open-note"]').first().click();await page.locator('.cm-detail-copy h1').waitFor();
  await page.locator('.cm-detail-media img').first().waitFor();await page.waitForFunction(()=>document.querySelector('.cm-detail-media img')?.naturalWidth>0);
  await page.locator('.cm-detail-dialog [data-cm="follow"]').click();
  await page.locator('.cm-detail-dialog [data-cm="note-like"]').click();await page.waitForFunction(()=>document.querySelector('.cm-detail-dialog [data-cm="note-like"]')?.getAttribute('aria-pressed')==='true');
  await page.locator('.cm-detail-dialog [data-cm="note-collect"]').click();
  await page.locator('#cm-comment-input').fill('记录得很清楚，我也来试试！');await page.locator('.cm-comment-send').click();
  await page.locator('.cm-comment-list').getByText('记录得很清楚，我也来试试！',{exact:true}).waitFor();
  const commentList=await community(bobContext,`/notes/${noteId}/comments`);const ownComment=commentList.items.find(comment=>comment.author.id===bob.id);assert(ownComment);
  await page.locator(`[data-comment="${ownComment.id}"] [data-cm="reply"]`).first().click();
  await page.locator('#cm-comment-input').fill('补充一个回复。');await page.locator('.cm-comment-send').click();await page.locator('.cm-reply p').filter({hasText:'补充一个回复。'}).waitFor();
  const interacted=(await community(bobContext,'/notes/'+noteId)).note;assert(interacted.liked&&interacted.collected);assert.equal(interacted.commentCount,2);
  assert.equal((await community(aliceContext,'/notifications')).unreadCount,5);
  await touchTargets();await shot('desktop-detail');await closeDetail();assert.equal(await page.locator('.cm-note').count(),11);
  await route('#community/following');await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),11);
  await route('#community/mine?tab=collections');await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),1);
  await route('#community/search?q='+encodeURIComponent('小小进步'));await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),4);
  checks.push('native detail images, follow, likes, collection, threaded comments, notifications and search');

  step='local draft reload and text publishing';console.log(step);
  await route('#community/publish');await page.locator('#cm-note-title').fill('QA 本机草稿');await page.locator('#cm-note-body').fill('这段文字需要在刷新后继续保留。');await page.locator('[data-cm="draft-save"]').click();
  await route('#community/mine?tab=drafts');await page.locator('.cm-draft-card').getByText('QA 本机草稿',{exact:true}).waitFor();await page.reload();await page.locator('.cm-draft-card').getByText('QA 本机草稿',{exact:true}).waitFor();
  await page.locator('.cm-draft-card').filter({hasText:'QA 本机草稿'}).getByText('继续编辑',{exact:true}).click();
  assert.equal(await page.locator('#cm-note-body').inputValue(),'这段文字需要在刷新后继续保留。');
  const textNote=await waitPublished(()=>page.locator('.cm-submit-note').click());assert.equal(textNote.type,'text');
  await page.locator('.cm-detail-copy h1').waitFor();await closeDetail();
  checks.push('IndexedDB draft persistence and real text publishing');

  step='text detail scrolling with comments';console.log(step);
  const scrollComments=[];
  for(let index=0;index<8;index++)scrollComments.push((await community(bobContext,'/notes/'+textNote.id+'/comments','POST',{body:'滚动验收评论 '+(index+1)+'：确保长评论列表可以完整阅读。',clientMutationId:crypto.randomUUID()})).comment);
  await community(bobContext,'/notes/'+textNote.id+'/comments','POST',{body:'滚动验收回复：最后一条回复也应可见。',parentId:scrollComments[0].id,replyToCommentId:scrollComments[0].id,clientMutationId:crypto.randomUUID()});
  await page.setViewportSize({width:1440,height:680});await route('#community/note/'+textNote.id);await page.locator('.cm-comment-list .cm-comment').nth(7).waitFor();
  const scrollGeometry=await page.evaluate(()=>{const dialog=document.querySelector('.cm-detail-dialog'),layout=document.querySelector('.cm-detail-layout'),content=document.querySelector('.cm-detail-content'),scroll=document.querySelector('.cm-detail-scroll'),footer=document.querySelector('.cm-detail-footer');return {viewport:innerHeight,dialog:dialog.getBoundingClientRect().toJSON(),layout:layout.getBoundingClientRect().toJSON(),content:content.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight};});
  await writeFile(join(dataDir,'text-scroll-geometry.json'),JSON.stringify(scrollGeometry,null,2));await shot('text-detail-before-scroll');
  assert(scrollGeometry.footer.bottom<=scrollGeometry.dialog.bottom+1,'Detail footer must stay inside its dialog');
  assert(scrollGeometry.scrollHeight>scrollGeometry.clientHeight,'Comments must overflow within the detail scroll area');
  const scrollBox=await page.locator('.cm-detail-scroll').boundingBox();await page.mouse.move(scrollBox.x+scrollBox.width/2,scrollBox.y+scrollBox.height/2);await page.mouse.wheel(0,650);
  await page.waitForFunction(()=>document.querySelector('.cm-detail-scroll').scrollTop>100);await page.mouse.wheel(0,4000);
  await page.waitForFunction(()=>{const scroll=document.querySelector('.cm-detail-scroll');return scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-2;});
  await shot('text-detail-after-scroll');await closeDetail();
  scrollTouchContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',storageState:await bobContext.storageState()});
  const touchPage=await scrollTouchContext.newPage();touchPage.setDefaultTimeout(15000);touchPage.on('pageerror',error=>errors.push(error.message));await touchPage.goto(base+'/#community/note/'+textNote.id);await touchPage.locator('.cm-comment-list .cm-reply').waitFor();
  const touchSession=await scrollTouchContext.newCDPSession(touchPage);
  const swipeUp=async()=>{await touchSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:650}]});for(let y=610;y>=150;y-=30){await touchSession.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y}]});await touchPage.waitForTimeout(25);}await touchSession.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  await swipeUp();
  await touchPage.waitForFunction(()=>document.querySelector('.cm-detail-layout').scrollTop>100);
  for(let attempt=0;attempt<4;attempt++)await swipeUp();
  await touchPage.waitForFunction(()=>{const layout=document.querySelector('.cm-detail-layout');return layout.scrollTop+layout.clientHeight>=layout.scrollHeight-2;});
  const lastReplyBox=await touchPage.locator('.cm-comment-list .cm-reply').boundingBox(),mobileFooterBox=await touchPage.locator('.cm-detail-footer').boundingBox();assert(lastReplyBox.y+lastReplyBox.height<=mobileFooterBox.y+1,'The last reply must be readable above the fixed mobile footer');
  await shot('text-detail-mobile-after-swipe',touchPage);await touchSession.detach();await scrollTouchContext.close();scrollTouchContext=null;await page.setViewportSize({width:1440,height:1000});
  checks.push('long text-detail thread supports desktop wheel and mobile touch scrolling with its footer visible');

  step='image publishing';console.log(step);
  await route('#community/publish');await page.locator('#cm-note-title').fill('QA 图文发布');await page.locator('#cm-note-body').fill('从真实图片上传到正式发布。');
  await page.locator('#cm-files').setInputFiles(['squat','bench'].map(name=>join(root,'public/assets/exercises',name+'.jpg')));
  await page.waitForFunction(()=>document.querySelectorAll('.cm-asset-info').length===2&&[...document.querySelectorAll('.cm-asset-info')].every(element=>element.textContent.includes('已上传')));
  await touchTargets();
  const photoNote=await waitPublished(()=>page.locator('.cm-submit-note').click());assert.equal(photoNote.media.length,2);assert.equal(photoNote.type,'image');
  await page.locator('.cm-detail-copy h1').waitFor();await page.locator('.cm-image-next').click();assert.equal(await page.locator('.cm-image-index').textContent(),'2 / 2');
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('.cm-image-index').textContent(),'1 / 2');
  await page.locator('.cm-image-view').click();await page.locator('.cm-zoom-image img').waitFor();await page.locator('.cm-aux-dialog [data-cm="aux-close"]').click();
  await closeDetail();checks.push('binary image upload, publishing, carousel, arrow keys and image zoom');

  step='own note editing, deletion and community profile';console.log(step);
  await route('#community/edit/'+photoNote.id);await page.locator('#cm-note-title').fill('QA 图文发布（已编辑）');
  const editResponse=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/community/notes/'+photoNote.id);
  await page.locator('.cm-submit-note').click();const edited=(await (await editResponse).json()).note;assert.equal(edited.version,photoNote.version+1);assert.equal(edited.media.length,2);
  await page.locator('.cm-detail-copy h1').waitFor();await closeDetail();
  for(const [choice,label]of [['local','A'],['remote','B']]){
    await route('#community/edit/'+photoNote.id);await page.locator('#cm-note-body').fill('QA 冲突本机'+label);
    const current=(await community(bobContext,'/notes/'+photoNote.id)).note;
    await community(bobContext,'/notes/'+photoNote.id,'PATCH',{clientMutationId:crypto.randomUUID(),version:current.version,title:current.title,body:'QA 另一端修改'+label,category:current.category,topics:current.topics,type:current.type,media:current.media.map(item=>({id:item.id,role:item.role,isCover:item.isCover})),coverMediaId:current.cover.id});
    const conflictResponse=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/community/notes/'+photoNote.id);
    await page.locator('.cm-submit-note').click();assert.equal((await conflictResponse).status(),409);await page.locator('[data-cm="editor-reload"]').click();await page.locator('.cm-conflict-comparison').waitFor();
    await page.locator('[data-cm="conflict-'+choice+'"]').click();await page.locator('.cm-conflict-dialog').waitFor({state:'hidden'});
    const expectedBody=choice==='local'?'QA 冲突本机'+label:'QA 另一端修改'+label;await page.waitForFunction(body=>document.querySelector('#cm-note-body')?.value===body,expectedBody);
    assert.equal(await page.locator('#cm-note-body').inputValue(),expectedBody);
    const saveResponse=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/community/notes/'+photoNote.id);
    await page.locator('.cm-submit-note').click();assert((await saveResponse).ok());await page.locator('.cm-detail-copy h1').waitFor();await closeDetail();
  }
  await route('#community/mine?tab=drafts');const backup=page.locator('.cm-draft-card').filter({hasText:'QA 冲突本机B'});await backup.waitFor();assert((await backup.textContent()).includes('冲突备份'));
  page.once('dialog',dialog=>dialog.accept());await backup.locator('[data-cm="draft-delete"]').click();await backup.waitFor({state:'hidden'});
  await route('#community/note/'+textNote.id);await page.locator('.cm-detail-copy h1').waitFor();await page.locator('[data-cm="note-more"]').click();
  page.once('dialog',dialog=>dialog.accept());const deleteResponse=page.waitForResponse(response=>response.request().method()==='DELETE'&&new URL(response.url()).pathname==='/api/community/notes/'+textNote.id);
  await page.locator('[data-cm="note-delete"]').click();assert((await deleteResponse).ok());await page.locator('.cm-detail-dialog').waitFor({state:'hidden'});
  assert.equal((await bobContext.request.get(base+'/api/community/notes/'+textNote.id)).status(),404);
  await route('#community/mine?tab=published');await page.locator('[data-cm="profile-edit"]').click();
  const profileForm=page.locator('[data-cm-form="profile"]');await profileForm.locator('[name="nickname"]').fill('QA 社区昵称');await profileForm.locator('[name="bio"]').fill('社区资料独立于健康档案。');
  await page.locator('#cm-avatar-file').setInputFiles(join(root,'public/assets/exercises/row.jpg'));await page.locator('.cm-avatar-status').filter({hasText:'已上传'}).waitFor();
  await profileForm.locator('button[type="submit"]').click();await profileForm.waitFor({state:'hidden'});await route('#community/user/'+bob.id);
  await page.locator('.cm-profile-copy h1').filter({hasText:'QA 社区昵称'}).waitFor();await page.locator('.cm-profile-avatar img').waitFor();
  const publicProfile=await community(aliceContext,'/users/'+bob.id);assert(!('email' in (publicProfile.user||publicProfile.profile||publicProfile)));
  checks.push('versioned editing, both conflict choices with local backup, deletion, nickname, avatar and safe public profile');

  step='personal profile layout and private collections';console.log(step);
  const profileAvatarResponse=await aliceContext.request.post(base+'/api/community/media?purpose=avatar',{headers:{'Content-Type':'image/jpeg','X-Filename':encodeURIComponent('profile.jpg')},data:await readFile(join(root,'public/assets/exercises/plank.jpg'))});
  assert(profileAvatarResponse.ok());const profileAvatar=(await profileAvatarResponse.json()).media;
  await community(aliceContext,'/me/profile','PATCH',{avatarMediaId:profileAvatar.id,bio:'记录我的训练与生活。\n力量训练 · 跑步 · 坚持每日记录\n每一步，都算数。'});
  await route('#community/user/'+alice.id);await page.locator('.cm-profile-copy h1').filter({hasText:'循序训练记录'}).waitFor();await waitNotes(page);
  assert.equal((await community(bobContext,'/users/'+alice.id)).profile.receivedEngagementCount,2);
  assert((await page.locator('[data-profile-stat="receivedEngagementCount"]').textContent()).includes('2'));
  for(const width of [1024,1440,1920]){
    await page.setViewportSize({width,height:1000});await noOverflow(page);await touchTargets();
    const profileAvatarBox=await page.locator('.cm-profile-avatar').boundingBox();assert(profileAvatarBox.width>=140,'Desktop profile should use a large avatar');
    await shot('profile-other-'+width);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.cm-profile-actions [data-cm="follow"]').click();await page.waitForFunction(()=>document.querySelector('[data-profile-stat="followerCount"]')?.textContent.includes('0'));
  await page.locator('.cm-profile-actions [data-cm="follow"]').click();await page.waitForFunction(()=>document.querySelector('[data-profile-stat="followerCount"]')?.textContent.includes('1'));
  await page.locator('.cm-profile-actions [data-cm="profile-more"]').click();await page.locator('.cm-profile-share-link').waitFor();assert((await page.locator('.cm-profile-share-link').inputValue()).endsWith('#community/user/'+alice.id));await page.locator('.cm-aux-dialog [data-cm="aux-close"]').click();
  const privateProfileRequests=[];const recordPrivateProfileRequest=request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/community/'))privateProfileRequests.push(path);};page.on('request',recordPrivateProfileRequest);
  await page.locator('.cm-profile-tabs [data-profile-tab="collections"]').click();await page.locator('.cm-profile-private').waitFor();assert.equal(await page.locator('.cm-note').count(),0);
  await route('#community/user/'+alice.id+'?tab=drafts');await waitNotes(page);assert.equal(await page.locator('.cm-draft-grid').count(),0);
  page.off('request',recordPrivateProfileRequest);
  assert(!privateProfileRequests.some(path=>path.includes('/me/collections')||path.includes('/me/notes')||path.includes('/users/'+alice.id+'/collections')),'Other profiles must not request private content');
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});await noOverflow(page);await touchTargets();await shot('profile-other-mobile-'+width);}
  await route('#community/mine?tab=published');await page.locator('.cm-profile-copy h1').filter({hasText:'QA 社区昵称'}).waitFor();assert.equal(await page.locator('.cm-profile-actions [data-cm="message-open"],.cm-profile-actions [data-cm="follow"]').count(),0);
  await page.locator('.cm-profile-tabs [data-profile-tab="collections"]').click();await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),1);
  await route('#community/user/'+bob.id+'?tab=collections');await waitNotes(page);assert.equal(await page.locator('.cm-note').count(),1);
  await route('#community/mine?tab=published');await page.locator('.cm-profile-actions [data-cm="profile-edit"]').click();
  const ownProfileEdit=page.locator('[data-cm-form="profile"]');await ownProfileEdit.locator('[name="bio"]').fill('社区资料独立于健康档案。\n每天记录一点进步。');await ownProfileEdit.locator('button[type="submit"]').click();await ownProfileEdit.waitFor({state:'hidden'});
  assert((await page.locator('.cm-profile-copy p').textContent()).includes('每天记录一点进步。'));await noOverflow(page);await touchTargets();await shot('profile-own-mobile');
  await page.setViewportSize({width:1440,height:1000});await shot('profile-own-desktop');
  await route('#community');await waitNotes(page);assert.equal(await page.locator('.cm-profile-page').count(),0,'Profile styling must leave with the profile route');
  checks.push('reference profile layout across desktop and mobile, own editing and collections, other collection privacy, live follower and received engagement counts');

  step='unified personal center and owner-controlled public collections';console.log(step);
  const personalEntry=page.locator('.nav [data-page="settings"]');await personalEntry.click();await page.locator('#personal-community .cm-profile-copy h1').waitFor();
  assert.equal(await page.evaluate(()=>location.hash),'#settings');
  assert.equal(await page.locator('.nav [data-page="settings"]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('#personal-community .cm-toolbar,#personal-community .cm-primary-tabs').count(),0,'Personal center must not duplicate the community navigation');
  assert.equal(await page.locator('a[href^="#community/mine"]').count(),0,'Current personal navigation must link directly to the unified center');
  for(const section of ['profile','achievements','ai','review','data']){
    await page.locator('.settings-nav [data-tab="'+section+'"]').click();await page.waitForFunction(section=>location.hash==='#settings?section='+section,section);
    await page.locator('.settings-nav [data-tab="'+section+'"][aria-current="page"]').waitFor();
    assert.equal(await page.locator('#personal-community').count(),0);assert((await page.locator('#settings-content').textContent()).trim().length>0);await noOverflow(page);
    if(section==='profile')assert((await page.locator('#settings-content').textContent()).includes('当前体重'));
  }
  await page.locator('.settings-nav [data-tab="home"]').click();await page.locator('#personal-community .cm-profile-copy h1').waitFor();await waitNotes(page);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:width<500?844:1000});await noOverflow(page);await touchTargets();await shot('personal-center-'+width);}
  await page.locator('.personal-preview').click();await page.locator('.cm-profile-preview-banner').waitFor();await waitNotes(page);
  assert.equal(await page.locator('.settings-nav,#settings-content,[data-cm="profile-edit"],[data-cm="message-open"],[data-profile-tab="drafts"]').count(),0,'Public preview must not expose personal controls');
  assert(!(await page.locator('.cm-page').textContent()).includes(emailBob));
  await page.locator('[data-profile-tab="collections"]').click();await page.locator('.cm-profile-private').waitFor();
  await route('#settings?tab=collections');await page.locator('#personal-community .cm-profile-copy h1').waitFor();await waitNotes(page);
  const noCollectionBanner=async()=>assert.equal(await page.locator('[data-cm-form="collections-visibility"],.cm-collection-privacy').count(),0,'Collection page must not show the removed visibility banner');
  const openProfileEditor=async()=>{await page.locator('.cm-profile-actions [data-cm="profile-edit"]').click();const form=page.locator('[data-cm-form="profile"]');await form.waitFor();return form;};
  const readVisibility=async()=>{const form=await openProfileEditor();const value=await form.locator('[name="collectionsVisibility"]').inputValue();await page.locator('.cm-aux-dialog [data-cm="aux-close"]').click();await form.waitFor({state:'hidden'});return value;};
  await noCollectionBanner();
  const saveVisibility=async value=>{
    const form=await openProfileEditor();await form.locator('[name="collectionsVisibility"]').selectOption(value);
    const response=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/community/me/profile');await form.locator('button[type="submit"]').click();assert((await response).ok());await form.waitFor({state:'hidden'});await noCollectionBanner();
  };
  assert.equal(await readVisibility(),'private');
  await saveVisibility('public');assert.equal((await community(aliceContext,'/users/'+bob.id)).profile.collectionsVisibility,'public');
  await page.reload();await page.locator('#personal-community .cm-profile-copy h1').waitFor();await waitNotes(page);await noCollectionBanner();assert.equal(await readVisibility(),'public');
  const publicCollectionPage=await aliceContext.newPage();publicCollectionPage.setDefaultTimeout(15000);publicCollectionPage.on('pageerror',error=>errors.push(error.message));
  await publicCollectionPage.goto(base+'/#community/user/'+bob.id+'?tab=collections');await waitNotes(publicCollectionPage);assert.equal(await publicCollectionPage.locator('.cm-note').count(),1);assert.equal(await publicCollectionPage.locator('.settings-nav,#settings-content').count(),0);
  await community(aliceContext,'/notes/'+noteId+'/collection','PUT',{active:true});
  await publicCollectionPage.locator('.cm-note [data-cm="open-note"]').first().click();await publicCollectionPage.locator('.cm-detail-dialog [data-cm="note-collect"][aria-pressed="true"]').waitFor();
  await publicCollectionPage.locator('.cm-detail-dialog [data-cm="note-collect"]').click();await publicCollectionPage.locator('.cm-detail-dialog [data-cm="note-collect"][aria-pressed="false"]').waitFor();await closeDetail(publicCollectionPage);
  await waitNotes(publicCollectionPage);assert.equal(await publicCollectionPage.locator('.cm-note').count(),1,'Removing viewer collection must not remove another owner collection');await shot('public-collections',publicCollectionPage);
  await saveVisibility('private');assert.equal((await aliceContext.request.get(base+'/api/community/users/'+bob.id+'/collections')).status(),403);
  await route('#community/user/'+bob.id,publicCollectionPage);await publicCollectionPage.locator('.cm-profile-copy h1').waitFor();await publicCollectionPage.locator('[data-profile-tab="collections"]').click();await publicCollectionPage.locator('.cm-profile-private').waitFor();assert.equal(await publicCollectionPage.locator('.cm-note').count(),0);await publicCollectionPage.close();
  await route('#settings?tab=published');await waitNotes(page);await page.locator('.cm-note [data-cm="open-note"]').first().click();await page.locator('.cm-detail-copy h1').waitFor();await closeDetail();await page.locator('#personal-community .cm-profile-copy h1').waitFor();assert.equal(await page.evaluate(()=>location.hash),'#settings?tab=published');
  checks.push('one personal center for community and private settings, owner public preview, persisted collection visibility, public access and privacy revocation, collection ownership and detail return');

  step='account search and search interactions';console.log(step);
  await route('#community');await waitNotes(page);
  await page.locator('#cm-search-input').fill('   ');await page.locator('#cm-search-input').press('Enter');
  assert.equal(await page.evaluate(()=>location.hash),'#community','An empty search must not navigate');
  await page.locator('#cm-search-input').fill('循序训练记录');await page.locator('#cm-search-input').press('Enter');
  await page.locator('.cm-search-types a[href*="type=users"]').click();
  await page.locator('.cm-user-result').filter({hasText:'循序训练记录'}).waitFor();
  await touchTargets();await shot('search-users');
  await page.locator('.cm-user-result').filter({hasText:'循序训练记录'}).click();
  await page.locator('.cm-profile-copy h1').filter({hasText:'循序训练记录'}).waitFor();
  const alicePublic=(await community(bobContext,'/users/'+alice.id)).profile;
  assert.match(alicePublic.accountNumber,/^\d{10}$/);
  await route('#community/search?type=users&q='+alicePublic.accountNumber);
  await page.locator('.cm-user-result').waitFor();assert.equal(await page.locator('.cm-user-result').count(),1);
  assert((await page.locator('.cm-user-result').textContent()).includes(alicePublic.accountNumber));
  await route('#community/search?type=users&q='+encodeURIComponent(emailAlice));
  await page.locator('.cm-empty').waitFor();assert.equal(await page.locator('.cm-user-result').count(),0,'Email must not locate a public account');
  await route('#community/search?type=notes&q='+encodeURIComponent('小小进步')+'&sort=latest');await waitNotes(page);
  assert.equal(await page.locator('.cm-note').count(),4);await noOverflow(page);
  await page.locator('#cm-search-input').fill('');await page.locator('#cm-search-input').focus();await page.locator('.cm-search-history [data-cm="search-history-item"]').filter({hasText:'循序训练记录'}).waitFor();
  await page.locator('[data-cm="search-history-clear"]').click();assert.equal(await page.locator('[data-cm="search-history-item"]').count(),0);
  await route('#community/user/'+bob.id);await page.locator('.cm-profile-copy h1').filter({hasText:'QA 社区昵称'}).waitFor();
  assert.equal(await page.locator('.cm-profile-actions [data-cm="message-open"]').count(),0,'Own profile must not offer self messaging');
  checks.push('blank search, nickname and exact public account search, private email exclusion, note sorting and own-profile actions');

  step='two-account private messaging';console.log(step);
  await route('#community/user/'+alice.id);await page.locator('.cm-profile-actions [data-cm="message-open"]').click();
  await page.locator('#cm-message-input').waitFor();
  const conversationId=await page.evaluate(()=>location.hash.split('?')[0].split('/').at(-1));
  await page.locator('#cm-message-input').fill('你好，想交流一下训练记录。');await page.locator('#cm-message-input').press('Enter');
  await page.locator('.cm-message-list .cm-message').filter({hasText:'你好，想交流一下训练记录。'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#cm-message-input')?.value==='');
  assert.equal((await community(aliceContext,'/messages/unread')).unreadCount,1);
  const messageAlicePage=await aliceContext.newPage();messageAlicePage.setDefaultTimeout(15000);messageAlicePage.on('pageerror',error=>errors.push(error.message));
  await messageAlicePage.goto(base+'/#community/messages');
  await messageAlicePage.locator('.cm-conversation-row').filter({hasText:'你好，想交流一下训练记录。'}).waitFor();
  await shot('private-inbox',messageAlicePage);
  await messageAlicePage.locator('.cm-conversation-row').first().click();
  await messageAlicePage.locator('.cm-message-list .cm-message').filter({hasText:'你好，想交流一下训练记录。'}).waitFor();
  await messageAlicePage.locator('#cm-message-input').fill('可以呀，欢迎交流！');await messageAlicePage.locator('#cm-message-input').press('Enter');
  await page.locator('.cm-message-list .cm-message').filter({hasText:'可以呀，欢迎交流！'}).waitFor();
  const racingIncoming='对方的消息在我发送期间到达。';
  const sendWithIncoming=async intercepted=>{if(intercepted.request().method()==='POST'){await community(aliceContext,'/messages/conversations/'+conversationId+'/messages','POST',{body:racingIncoming,clientMutationId:crypto.randomUUID()});await intercepted.continue();}else await intercepted.continue();};
  await page.route('**/api/community/messages/conversations/*/messages',sendWithIncoming);
  await page.locator('#cm-message-input').fill('同时发出的一条消息');await page.locator('.cm-message-send').click();
  await page.waitForFunction(()=>document.querySelector('#cm-message-input')?.value==='');
  await page.unroute('**/api/community/messages/conversations/*/messages',sendWithIncoming);
  await page.locator('.cm-message-list .cm-message').filter({hasText:racingIncoming}).waitFor();
  await page.locator('#cm-message-input').fill('输入法组词期间不发送');
  await page.locator('#cm-message-input').evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})));
  assert.equal(await page.locator('#cm-message-input').inputValue(),'输入法组词期间不发送');
  await page.locator('#cm-message-input').press('Shift+Enter');assert((await page.locator('#cm-message-input').inputValue()).includes('\n'));
  const sentKeys=[];const failedMessage='这条消息断网后重试，应该只保存一次。';
  const interceptMessage=async intercepted=>{if(intercepted.request().method()==='POST'){sentKeys.push(intercepted.request().postDataJSON().clientMutationId);await intercepted.abort('failed');}else await intercepted.continue();};
  await page.route('**/api/community/messages/conversations/*/messages',interceptMessage);
  await page.locator('#cm-message-input').fill(failedMessage);await page.locator('.cm-message-send').click();
  await page.locator('[data-cm="message-retry"]').waitFor();
  await page.unroute('**/api/community/messages/conversations/*/messages',interceptMessage);
  const retryRequest=page.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith('/messages'));
  await page.locator('[data-cm="message-retry"]').click();sentKeys.push((await retryRequest).postDataJSON().clientMutationId);
  await page.locator('[data-cm="message-retry"]').waitFor({state:'hidden'});
  assert.equal(sentKeys[0],sentKeys[1],'Failed send retry must keep its mutation ID');
  assert.equal((await community(bobContext,'/messages/conversations/'+conversationId+'/messages')).items.filter(message=>message.body===failedMessage).length,1);
  await page.locator('#cm-message-input').fill('还没发送的会话草稿');await page.reload();
  await page.waitForFunction(()=>document.querySelector('#cm-message-input')?.value==='还没发送的会话草稿');
  await page.locator('#cm-message-input').fill('');
  for(let index=0;index<33;index++)await community(bobContext,'/messages/conversations/'+conversationId+'/messages','POST',{body:'长会话滚动验收 '+String(index+1).padStart(2,'0'),clientMutationId:crypto.randomUUID()});
  await page.reload();await page.locator('[data-cm="messages-older"]').waitFor();
  const newerCount=await page.locator('.cm-message-list .cm-message').count();
  await page.locator('[data-cm="messages-older"]').click();await page.waitForFunction(count=>document.querySelectorAll('.cm-message-list .cm-message').length>count,newerCount);
  await shot('private-chat-desktop');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await noOverflow(page);await touchTargets();
    await page.waitForFunction(()=>document.querySelector('.cm-floating-publish')?.hidden!==false);
    await page.locator('#cm-message-input').fill('手机端发送验收 '+width);
    assert(await page.locator('.cm-message-send').evaluate(button=>{const box=button.getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('.cm-message-send')===button;}),'Mobile send must not be covered by another control');
    await page.locator('.cm-message-send').click();await page.waitForFunction(()=>document.querySelector('#cm-message-input')?.value==='');
    const chatBox=await page.locator('.cm-message-list').boundingBox();await page.mouse.move(chatBox.x+chatBox.width/2,chatBox.y+chatBox.height/2);
    await page.mouse.wheel(0,-100000);await page.waitForFunction(()=>document.querySelector('.cm-message-list').scrollTop<=1);
    await page.mouse.wheel(0,400);await page.waitForFunction(()=>document.querySelector('.cm-message-list').scrollTop>100);
    await page.mouse.wheel(0,100000);await page.waitForFunction(()=>{const list=document.querySelector('.cm-message-list');return list.scrollTop+list.clientHeight>=list.scrollHeight-2;});
    const sendBox=await page.locator('.cm-message-send').boundingBox();assert(sendBox.y+sendBox.height<=844,'Mobile composer must remain in the visible viewport');
    await shot('private-chat-mobile-'+width);
  }
  await page.setViewportSize({width:1440,height:1000});await messageAlicePage.close();
  checks.push('other-profile private entry, two-account receive and reply, unread state, retry deduplication, draft reload, history pagination and mobile chat');

  step='private message loading recovery and unread race';console.log(step);
  let failInitialHistory=true;
  const abortInitialHistory=async intercepted=>{const request=intercepted.request(),url=new URL(request.url());if(failInitialHistory&&request.method()==='GET'&&!url.searchParams.has('after')){failInitialHistory=false;await intercepted.abort('failed');}else await intercepted.continue();};
  await page.route('**/api/community/messages/conversations/*/messages*',abortInitialHistory);
  await page.reload();await page.locator('[data-cm="messages-older"]').filter({hasText:'重新加载'}).waitFor();
  const recoverMessage='首次消息列表加载失败时，也保留发送和重新加载。';
  await page.locator('#cm-message-input').fill(recoverMessage);await page.locator('.cm-message-send').click();await page.waitForFunction(()=>document.querySelector('#cm-message-input')?.value==='');
  await page.locator('[data-cm="messages-older"]').filter({hasText:'重新加载'}).click();
  await page.locator('[data-cm="messages-older"]').filter({hasText:'查看更早'}).waitFor();
  assert.equal(await page.locator('.cm-message').filter({hasText:recoverMessage}).count(),1);
  await page.unroute('**/api/community/messages/conversations/*/messages*',abortInitialHistory);
  const selectedText=await page.locator('.cm-message-bubble').last().evaluate(bubble=>{window.qaSelectedChatBubble=bubble;const range=document.createRange();range.selectNodeContents(bubble);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});
  await page.waitForResponse(async response=>response.request().method()==='GET'&&new URL(response.url()).pathname.endsWith('/messages')&&new URL(response.url()).searchParams.has('after')&&(await response.json()).items.length===0);
  await page.waitForTimeout(100);
  assert(await page.evaluate(text=>window.qaSelectedChatBubble?.isConnected&&getSelection().toString()===text,selectedText),'An empty poll must preserve selected chat text');
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.locator('.cm-message-list').evaluate(list=>{list.scrollTop=0;});
  const lateUnreadText='已读之后到达的旧未读响应不能重新点亮角标。';
  let allowUnreadHold=false,unreadSnapshotHeld=false,releaseUnread,resolveUnreadHeld,resolveUnreadDelivered;
  const unreadGate=new Promise(resolve=>{releaseUnread=resolve;}),unreadHeld=new Promise(resolve=>{resolveUnreadHeld=resolve;}),unreadDelivered=new Promise(resolve=>{resolveUnreadDelivered=resolve;});
  const holdUnreadSnapshot=async intercepted=>{const snapshot=await intercepted.fetch(),data=await snapshot.json();if(allowUnreadHold&&!unreadSnapshotHeld&&data.unreadCount===1){unreadSnapshotHeld=true;resolveUnreadHeld();await unreadGate;await intercepted.fulfill({response:snapshot});resolveUnreadDelivered();}else await intercepted.fulfill({response:snapshot});};
  await page.route('**/api/community/messages/unread',holdUnreadSnapshot);
  await community(aliceContext,'/messages/conversations/'+conversationId+'/messages','POST',{body:lateUnreadText,clientMutationId:crypto.randomUUID()});
  await page.locator('.cm-message').filter({hasText:lateUnreadText}).waitFor();allowUnreadHold=true;
  await Promise.race([unreadHeld,page.waitForTimeout(15000).then(()=>{throw new Error('Unread snapshot did not arrive');})]);
  const unreadReadResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/read'));
  const unreadScrollBox=await page.locator('.cm-message-list').boundingBox();await page.mouse.move(unreadScrollBox.x+unreadScrollBox.width/2,unreadScrollBox.y+unreadScrollBox.height/2);await page.mouse.wheel(0,100000);
  assert.equal((await (await unreadReadResponse).json()).unreadCount,0);
  releaseUnread();await unreadDelivered;await page.waitForTimeout(150);
  assert(await page.locator('.cm-message-unread').evaluate(badge=>badge.hidden),'A delayed unread response must not overwrite the successful read acknowledgement');
  await page.unroute('**/api/community/messages/unread',holdUnreadSnapshot);
  checks.push('initial message loading failure recovers after sending, empty polls preserve selected text, and stale unread responses cannot undo reading');

  step='short video publishing and seeking';console.log(step);
  await route('#community/publish');await page.locator('#cm-note-title').fill('QA 短视频发布');await page.locator('#cm-note-body').fill('原生播放器与独立封面。');
  await page.locator('[data-cm="editor-type"][data-type="video"]').click();
  await page.locator('#cm-files').setInputFiles(join(root,'tests/fixtures/community-tiny.mp4'));await page.locator('#cm-cover-file').setInputFiles(join(root,'public/assets/exercises/plank.jpg'));
  await page.waitForFunction(()=>document.querySelectorAll('.cm-asset-info').length===2&&[...document.querySelectorAll('.cm-asset-info')].every(element=>element.textContent.includes('已上传')));
  const videoNote=await waitPublished(()=>page.locator('.cm-submit-note').click());assert.equal(videoNote.type,'video');
  await page.locator('.cm-detail-dialog video').waitFor();await page.waitForFunction(()=>document.querySelector('.cm-detail-dialog video')?.readyState>=1);
  await page.locator('.cm-detail-dialog video').evaluate(async video=>{window.qaCommunityVideo=video;await video.play();video.currentTime=.5;});
  await page.waitForFunction(()=>document.querySelector('.cm-detail-dialog video')?.currentTime>=.45);await shot('video-detail');
  await closeDetail();assert(await page.evaluate(()=>window.qaCommunityVideo.paused));checks.push('MP4 upload, poster, native playback, byte range seeking and stop on close');

  step='mobile search cancellation';console.log(step);
  await route('#community');await waitNotes(page);
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await page.locator('[data-cm="search-open"]').click();
    await page.locator('#cm-search-input').fill('尚未提交的搜索词');await noOverflow(page);await touchTargets();
    await page.locator('[data-cm="search-cancel"]').click();
    assert.equal(await page.locator('.cm-search').evaluate(form=>form.classList.contains('cm-search-visible')),false);
    assert.equal(await page.locator('#cm-search-input').inputValue(),'尚未提交的搜索词');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.cm),'search-open');
    assert.equal(await page.evaluate(()=>location.hash),'#community');
    await page.locator('[data-cm="search-open"]').click();assert.equal(await page.locator('#cm-search-input').inputValue(),'尚未提交的搜索词');
    await page.locator('.topbar').click({position:{x:5,y:5}});assert.equal(await page.locator('.cm-search').evaluate(form=>form.classList.contains('cm-search-visible')),false);
    await page.locator('[data-cm="search-open"]').click();await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.cm),'search-open');await shot('mobile-search-cancel-'+width);
  }
  checks.push('mobile search cancel, outside dismissal and Escape keep the current route, query and usable focus');

  step='mobile feed, detail and account isolation';console.log(step);
  await route('#community');await waitNotes(page);
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});await noOverflow(page);await touchTargets();assert.equal(await page.locator('.cm-grid').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length),2);await shot('mobile-'+width);}
  await page.setViewportSize({width:390,height:844});await page.locator('.cm-note [data-cm="open-note"]').first().click();await page.locator('.cm-detail-copy h1').waitFor();
  const mobileRect=await page.locator('.cm-detail-dialog').boundingBox();assert(mobileRect.width>=388);await touchTargets();await shot('mobile-detail');await closeDetail();
  const lastCard=page.locator('.cm-note').last();await lastCard.scrollIntoViewIfNeeded();const scrollBefore=await page.evaluate(()=>scrollY);assert(scrollBefore>0);
  await lastCard.locator('[data-cm="open-note"]').first().click();await page.locator('.cm-detail-copy h1').waitFor();await page.goBack();await page.locator('.cm-detail-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(top=>Math.abs(scrollY-top)<2,scrollBefore);assert.equal(await page.evaluate(()=>location.hash),'#community');
  await page.waitForFunction(()=>document.activeElement?.dataset.cm==='open-note');
  await route('#settings');await page.locator('.nav [data-page="settings"][aria-current="page"]').waitFor();await route('#community');await waitNotes(page);await page.waitForFunction(top=>Math.abs(scrollY-top)<2,scrollBefore);
  await route('#community/mine?tab=drafts');assert.equal(await page.locator('.cm-draft-card').count(),0);
  checks.push('320/390/430px two-column feed, 44px controls, full-screen detail, scroll/focus restoration and isolated drafts');

  step='notification reading and moderation';console.log(step);
  const alicePage=await aliceContext.newPage();alicePage.setDefaultTimeout(15000);alicePage.on('pageerror',error=>errors.push(error.message));
  await alicePage.goto(base+'/#community/notifications');await alicePage.locator('.cm-notification').first().waitFor();
  const unreadBefore=(await community(aliceContext,'/notifications')).unreadCount;assert(unreadBefore>0);
  await route('#community/note/'+noteId);await page.locator('.cm-detail-copy h1').waitFor();await page.locator('[data-cm="note-more"]').click();await page.locator('[data-cm="report-note"]').click();
  const reportForm=page.locator('[data-cm-form="report"]');await reportForm.locator('input[type="radio"][name="reason"][value="other"]').check();await reportForm.locator('[name="description"]').fill('隔离验收举报');
  const reportResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/community/reports');await page.locator('.cm-report-dialog .cm-report-footer [type="submit"]').click();const report=(await (await reportResponse).json()).report;
  await reportForm.waitFor({state:'hidden'});await closeDetail();
  await route('#community/moderation',alicePage);await alicePage.locator('.cm-report-row').first().waitFor();
  await shot('moderation',alicePage);assert(report.id);
  await alicePage.locator('[data-cm="report-review"]').first().click();let moderationForm=alicePage.locator('[data-cm-form="moderation"]');
  await moderationForm.locator('[name="action"]').selectOption('hide');await moderationForm.locator('[name="reason"]').fill('隔离验收下架');await moderationForm.locator('[type="submit"]').click();await moderationForm.waitFor({state:'hidden'});
  assert.equal((await bobContext.request.get(base+'/api/community/notes/'+noteId)).status(),404);
  await route('#community/edit/'+noteId,alicePage);await alicePage.locator('.cm-warning').waitFor();await alicePage.locator('#cm-note-body').fill('修改后的内容，等待管理员恢复。');await alicePage.locator('.cm-submit-note').click();await alicePage.locator('.cm-hidden-badge').waitFor();
  assert.equal((await bobContext.request.get(base+'/api/community/notes/'+noteId)).status(),404);
  await route('#community/moderation?status=resolved',alicePage);await alicePage.locator('[data-cm="report-review"]').first().click();moderationForm=alicePage.locator('[data-cm-form="moderation"]');
  await moderationForm.locator('[name="action"]').selectOption('restore');await moderationForm.locator('[name="reason"]').fill('修改完成，隔离验收恢复');await moderationForm.locator('[type="submit"]').click();await moderationForm.waitFor({state:'hidden'});
  assert.equal((await community(bobContext,'/notes/'+noteId)).note.status,'published');
  await route('#community/notifications?type=comment',alicePage);await alicePage.locator('.cm-notification').first().waitFor();await alicePage.locator('.cm-notification').first().click();await alicePage.locator('[data-comment="'+ownComment.id+'"] .cm-comment-main p').filter({hasText:'记录得很清楚'}).waitFor();await closeDetail(alicePage);
  await alicePage.locator('[data-cm="notifications-read"]').click();await alicePage.waitForFunction(()=>!document.querySelector('.cm-notification.unread'));
  assert.equal((await community(aliceContext,'/notifications')).unreadCount,0);
  checks.push('report submission, moderator hide, owner hidden edit, moderator restore, notification context and explicit reading');

  step='login return and first-use profile';console.log(step);
  guestContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});const guest=await guestContext.newPage();guest.setDefaultTimeout(15000);guest.on('pageerror',error=>errors.push(error.message));
  await guest.goto(base+'/#community/note/'+photoNote.id);await guest.locator('.landing').waitFor();await route('#auth-entry',guest);await guest.locator('#auth-form').waitFor();
  await guest.locator('#email').fill(emailBob);await guest.locator('#password').fill(password);await guest.locator('#auth-form button[type="submit"]').click();
  await guest.locator('.cm-detail-copy h1').waitFor();assert.equal(await guest.locator('.cm-detail-copy h1').textContent(),'QA 图文发布（已编辑）');await closeDetail(guest);
  firstUseContext=await browser.newContext({reducedMotion:'reduce'});await register(firstUseContext,'community-qa-first@example.test','首次使用');const first=await firstUseContext.newPage();
  await first.goto(base+'/#community/note/'+photoNote.id);await first.locator('#profile-form').waitFor();assert.equal(await first.locator('.cm-detail-dialog').count(),0);
  await first.locator('#profile-form button[type="submit"]').click();await first.locator('.cm-detail-copy h1').waitFor();
  checks.push('shared-link login return and required profile before detail');

  step='offline draft';console.log(step);
  await route('#community/publish');await page.locator('#cm-note-title').fill('QA 离线草稿');
  await page.waitForFunction(()=>!!navigator.serviceWorker?.controller);
  // Snapshot inputs include the current minute. Force a new key so a cached
  // business snapshot cannot conceal an offline community navigation failure.
  await page.evaluate(()=>{
    const OriginalDate=Date,advance=2*60*1000;
    globalThis.Date=class extends OriginalDate {
      constructor(...args){super(...(args.length?args:[OriginalDate.now()+advance]));}
      static now(){return OriginalDate.now()+advance;}
    };
  });
  const offlineComputeRequests=[],trackOfflineCompute=request=>{if(new URL(request.url()).pathname==='/api/compute')offlineComputeRequests.push(request.method());};
  page.on('request',trackOfflineCompute);
  await bobContext.setOffline(true);await page.locator('#cm-note-body').fill('离线时保存文字。');await page.locator('[data-cm="draft-save"]').click();
  await route('#community/mine?tab=drafts');await page.locator('.cm-draft-card').getByText('QA 离线草稿',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>location.hash),'#settings?tab=drafts');
  await page.reload();await page.locator('.cm-draft-card').getByText('QA 离线草稿',{exact:true}).waitFor();
  await page.locator('.cm-draft-card').filter({hasText:'QA 离线草稿'}).locator('a').click();await page.locator('#cm-note-title').waitFor();
  assert.equal(await page.locator('#cm-note-title').inputValue(),'QA 离线草稿');assert.equal(await page.locator('#cm-note-body').inputValue(),'离线时保存文字。');
  await page.reload();await page.locator('#cm-note-title').waitFor();
  assert.equal(await page.locator('#cm-note-title').inputValue(),'QA 离线草稿');assert.equal(await page.locator('#cm-note-body').inputValue(),'离线时保存文字。');
  await route('#settings?tab=drafts');await page.locator('.cm-draft-card').getByText('QA 离线草稿',{exact:true}).waitFor();
  assert.deepEqual(offlineComputeRequests,[],'Offline community boot, personal draft navigation and editing must not depend on business calculations');
  page.off('request',trackOfflineCompute);await bobContext.setOffline(false);
  checks.push('offline draft editing, fresh snapshot minute, community/personal navigation and cached draft/editor reload without calculation requests or silent publishing');

  step='existing application navigation';console.log(step);await page.setViewportSize({width:1440,height:1000});
  for(const name of ['chat','nutrition','training','library','settings']){
    await page.locator('.nav [data-page="'+name+'"]').click();await page.waitForFunction(name=>document.querySelector('.nav [data-page="'+name+'"]')?.getAttribute('aria-current')==='page',name);await noOverflow(page);
  }
  await page.locator('.nav [data-page="community"]').click();await page.locator('.cm-primary-tabs').waitFor();await route('#community/mine?tab=drafts');await page.locator('.cm-draft-card').getByText('QA 离线草稿',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
  checks.push('original navigation, community draft on return, and publishing without crypto.randomUUID');

  assert.deepEqual(errors,[],'Unexpected browser errors');
  const result={passed:true,dataDir,checks,errors};await writeFile(join(dataDir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await shot('failure').catch(()=>{});await writeFile(join(dataDir,'failure.json'),JSON.stringify({step,message:error.message,errors},null,2));console.error('FAILED STEP:',step,'Artifacts:',dataDir);throw error;}
finally{await scrollTouchContext?.close();await guestContext?.close();await firstUseContext?.close();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
