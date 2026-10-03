// Detail-specific acceptance in real Edge, with temporary accounts and SQLite.
// QA_PLAYWRIGHT / QA_BROWSER select existing local tools; production data is unused.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const candidates=[process.env.QA_PLAYWRIGHT,join(root,'.qa/community-tools/node_modules/playwright/index.mjs'),join(root,'精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean);
const playwrightPath=candidates.find(path=>existsSync(path));
if(!playwrightPath)throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 的路径。');
const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa','community-detail-'));
const password='community-detail-qa-password';
const emailAlice='detail-qa-author@example.test';
const server=await startServer({host:'127.0.0.1',port:0,dataDir,communityModeratorEmails:[emailAlice]});
const base=`http://127.0.0.1:${server.address().port}`;
let browser,currentPage,step='setup';
const contexts=[],errors=[],checks=[],reports=[],geometry=[];
const json=async(name,value)=>writeFile(join(dataDir,name+'.json'),JSON.stringify(value,null,2));
const mark=label=>{step=label;console.log(label);};
const api=async(context,path,method='GET',body)=>{
  const response=await context.request.fetch(base+'/api'+path,{method,...(body===undefined?{}:{data:body})});
  const value=await response.json();assert(response.ok(),`${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);return value;
};
const community=(context,path,method='GET',body)=>api(context,'/community'+path,method,body);
const makeContext=async(options={})=>{const context=await browser.newContext({reducedMotion:'reduce',...options});contexts.push(context);return context;};
const register=async(context,email,name)=>{
  const {user}=await api(context,'/auth/register','POST',{email,password,name});
  await api(context,'/sync','POST',{changes:[{id:'profile',kind:'profile',data:{age:25,height:172,weight:68,sex:'male',goal:'maintain',activity:1.375},baseVersion:0}]});
  return user;
};
const trackedPage=async context=>{
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));return page;
};
const screenshot=async(page,name)=>page.screenshot({path:join(dataDir,name+'.png'),fullPage:true,style:'#toasts{visibility:hidden}'});
const route=async(page,hash)=>page.evaluate(hash=>{location.hash=hash;},hash);
const rootThread=(page,id)=>page.locator(`.cm-comment-list > .cm-comment[data-comment="${id}"]`);
const replyRows=(page,id)=>rootThread(page,id).locator('.cm-replies > .cm-reply');
const waitDetail=async(page,noteId,rootId)=>{
  await page.locator('.cm-detail-copy h1').waitFor();await rootThread(page,rootId).waitFor();
  assert.equal(await page.locator('.cm-detail-dialog').count(),1);
  await page.waitForFunction(id=>location.hash.includes('/note/'+id),noteId);
};
const closeDetail=async page=>{await page.locator('.cm-detail-dialog [data-cm="detail-close"]').click();await page.locator('.cm-detail-dialog').waitFor({state:'hidden'});};
const openDetail=async(page,noteId,rootId)=>{await route(page,'#community/note/'+noteId);await waitDetail(page,noteId,rootId);};
const noOverflow=async page=>{
  const result=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,dialog:document.querySelector('.cm-detail-dialog')?.getBoundingClientRect().toJSON(),layout:document.querySelector('.cm-detail-layout')?{client:document.querySelector('.cm-detail-layout').clientWidth,scroll:document.querySelector('.cm-detail-layout').scrollWidth}:null}));
  assert(result.document<=result.viewport+1,`Document overflow ${JSON.stringify(result)}`);
  if(result.dialog)assert(result.dialog.left>=-1&&result.dialog.right<=result.viewport+1,`Detail overflow ${JSON.stringify(result)}`);
  if(result.layout)assert(result.layout.scroll<=result.layout.client+1,`Detail layout overflow ${JSON.stringify(result)}`);
  return result;
};
const recordTypography=async(page,label,rootId)=>{
  await rootThread(page,rootId).scrollIntoViewIfNeeded();
  const result=await page.evaluate(rootId=>{
    const root=document.querySelector(`.cm-comment-list > [data-comment="${rootId}"]`);
    const measure=element=>{const style=getComputedStyle(element);return {box:element.getBoundingClientRect().toJSON(),fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,fontWeight:style.fontWeight,color:style.color};};
    const row=element=>({avatar:measure(element.querySelector(':scope > .cm-comment-avatar > .cm-avatar')),author:measure(element.querySelector(':scope > .cm-comment-main > .cm-comment-author')),body:measure(element.querySelector(':scope > .cm-comment-main > p')),date:measure(element.querySelector(':scope > .cm-comment-main > .cm-comment-date'))});
    return {width:innerWidth,title:measure(document.querySelector('.cm-detail-copy h1')),body:measure(document.querySelector('.cm-note-body')),topics:measure(document.querySelector('.cm-topics')),date:measure(document.querySelector('.cm-note-date')),root:row(root),reply:row(root.querySelector('.cm-reply'))};
  },rootId);
  for(const [name,row]of [['root',result.root],['reply',result.reply]])assert(Math.abs(row.avatar.box.top-row.author.box.top)<=4,`${label} ${name} avatar must align with its first author line: ${JSON.stringify(row)}`);
  assert.equal(result.root.body.fontFamily,result.reply.body.fontFamily,'Root and reply use the same font family');
  assert.equal(parseFloat(result.title.fontSize),result.width>760?20:19,'Note title follows the detail typography');
  assert.equal(result.title.fontWeight,'700');
  assert.equal(parseFloat(result.body.fontSize),result.width>760?16:15,'Note body follows the detail typography');
  assert.equal(result.body.fontWeight,'400');
  assert.equal(parseFloat(result.root.author.fontSize),14);
  assert.equal(parseFloat(result.root.body.fontSize),14);
  assert.equal(parseFloat(result.reply.body.fontSize),14);
  assert.equal(result.root.avatar.box.width,40);
  assert.equal(result.reply.avatar.box.width,28);
  geometry.push({label,...result});await screenshot(page,label+'-typography');
};
const footerGeometry=async(page,label)=>{
  const result=await page.evaluate(()=>{
    const footer=document.querySelector('.cm-detail-footer'),input=footer.querySelector('textarea'),actions=footer.querySelector('.cm-detail-actions');
    return {width:innerWidth,footer:footer.getBoundingClientRect().toJSON(),input:input.getBoundingClientRect().toJSON(),actions:actions.getBoundingClientRect().toJSON(),buttons:[...actions.querySelectorAll('button')].map(element=>({label:element.getAttribute('aria-label'),count:element.querySelector('span')?.textContent,box:element.getBoundingClientRect().toJSON()}))};
  });
  for(const button of result.buttons){assert(button.box.width>=43.5&&button.box.height>=43.5,'Detail actions retain a 44px touch target');assert(button.box.left>=-1&&button.box.right<=result.width+1,'Multi-digit action counts stay inside the viewport');}
  for(const label of ['点赞','收藏','写评论'])assert(Number(result.buttons.find(button=>button.label===label).count)>=10,'Test fixture must exercise multi-digit counts');
  assert(Math.abs((result.input.top+result.input.height/2)-(result.actions.top+result.actions.height/2))<=2,'Resting footer input and actions share one compact row');
  geometry.push({label,...result});
};
const lastReplyReadable=async(page,rootId,lastId,label)=>{
  await page.locator(`.cm-reply[data-comment="${lastId}"]`).evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const [reply,footer]=await Promise.all([page.locator(`.cm-reply[data-comment="${lastId}"]`).boundingBox(),page.locator('.cm-detail-footer').boundingBox()]);
  const visibleTop=await page.locator('.cm-detail-dialog').evaluate(element=>element.getBoundingClientRect().top+(innerWidth<=760?48:0));
  assert(reply&&footer&&reply.y>=visibleTop&&reply.y+reply.height<=footer.y+2,'The last expanded reply is visible and readable above the fixed footer');
  assert.equal(await replyRows(page,rootId).count(),5);geometry.push({label,reply,footer});await screenshot(page,label);
};
const anchoredMenu=async(page,anchor,label)=>{
  await anchor.click();const menu=page.locator('.cm-detail-dialog > .cm-context-menu[role="menu"]');await menu.waitFor();
  assert.equal(await page.locator('.cm-aux-dialog[open]').count(),0,'More actions stay beside their trigger instead of opening an auxiliary dialog');
  const [trigger,box]=await Promise.all([anchor.boundingBox(),menu.boundingBox()]);
  const viewport=page.viewportSize();assert(trigger&&box);
  const verticalGap=Math.min(Math.abs(box.y-(trigger.y+trigger.height)),Math.abs(box.y+box.height-trigger.y));
  assert(verticalGap<=24,`${label} menu must be anchored: ${JSON.stringify({trigger,box})}`);
  assert(box.x<=trigger.x+trigger.width+1&&box.x+box.width>=trigger.x-1,'Menu must overlap the anchor horizontally');
  assert(box.x>=-1&&box.x+box.width<=viewport.width+1&&box.y>=-1&&box.y+box.height<=viewport.height+1,'Menu must fit inside viewport');
  geometry.push({label,trigger,menu:box,verticalGap});return menu;
};
const reportThroughUI=async(page,anchor,type,targetId,label)=>{
  const menu=await anchoredMenu(page,anchor,label);
  await screenshot(page,label+'-menu');
  if(label==='desktop-note-report')await page.locator('.cm-detail-dialog').screenshot({path:join(dataDir,'detail-preview.png'),style:'#toasts{visibility:hidden}'});
  await menu.locator(`[role="menuitem"][data-cm="report-${type}"]`).click();
  const form=page.locator(`[data-cm-form="report"][data-type="${type}"][data-id="${targetId}"]`);await form.waitFor();
  await form.locator('input[type="radio"][name="reason"][value="other"]').check();await form.locator('textarea[name="description"]').fill(label+' isolated browser verification');
  const pending=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/community/reports');
  await page.locator('.cm-report-dialog .cm-report-footer [type="submit"]').click();const response=await pending;const value=await response.json();
  assert.equal(response.status(),201,JSON.stringify(value));
  assert.equal(value.report.targetType,type);assert.equal(value.report.targetId,targetId);assert.equal(value.report.reason,'other');
  reports.push(value.report);await form.waitFor({state:'hidden'});return value.report;
};

try{
  browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const aliceContext=await makeContext({viewport:{width:1440,height:1000}}),bobContext=await makeContext({viewport:{width:1440,height:1000}}),carolContext=await makeContext();
  const alice=await register(aliceContext,emailAlice,'循序记录作者'),bob=await register(bobContext,'detail-qa-reader@example.test','循序体验用户'),carol=await register(carolContext,'detail-qa-responder@example.test','训练伙伴');
  const upload=await aliceContext.request.post(base+'/api/community/media?purpose=note',{headers:{'Content-Type':'image/jpeg','X-Filename':encodeURIComponent('detail-qa.jpg')},data:await readFile(join(root,'public/assets/exercises/squat.jpg'))});
  assert(upload.ok());const media=(await upload.json()).media;
  const note=(await community(aliceContext,'/notes','POST',{clientMutationId:randomUUID(),type:'image',title:'在日常里慢慢进步，记录一次完整训练',body:'把每次训练留在日常里，保持自己的节奏。\n今天完成力量训练，也给恢复和饮食留了时间。\n动作质量、规律休息与坚持同样重要。',category:'training',topics:['训练记录','循序渐进'],media:[{id:media.id,role:'image',isCover:true}]})).note;
  for(let index=0;index<12;index++){
    const voter=await makeContext();await register(voter,`detail-qa-voter-${index}@example.test`,'验收计数用户'+index);
    await community(voter,`/notes/${note.id}/like`,'PUT',{active:true});await community(voter,`/notes/${note.id}/collection`,'PUT',{active:true});
  }
  const comment=async(context,body,parentId,replyToCommentId)=>(await community(context,`/notes/${note.id}/comments`,'POST',{clientMutationId:randomUUID(),body,...(parentId?{parentId,replyToCommentId:replyToCommentId||parentId}:{})})).comment;
  for(let index=0;index<8;index++)await comment(aliceContext,'用于验证两位数评论计数的临时评论 '+index);
  await comment(carolContext,'另一条顶层评论，帮助检查评论间距。');
  const rootComment=await comment(aliceContext,'把动作练熟，比一口气提高重量更重要。\n多行主评论用于检查头像是否与第一行对齐。');
  const initialReply=await comment(carolContext,'默认可见的第一条回复。\n子回复也应从头像顶部开始排版。',rootComment.id);
  const bobReply=await comment(bobContext,'用于接收另一位用户的回复通知。',rootComment.id);
  const hiddenTarget=await comment(carolContext,'通过通知定位这条默认折叠的回复。',rootComment.id,bobReply.id);
  await comment(aliceContext,'第四条回复，用于验证展开、收起与缓存。',rootComment.id);
  const notification=(await community(bobContext,'/notifications?type=comments')).items.find(item=>item.targetCommentId===hiddenTarget.id);assert(notification);
  const page=currentPage=await trackedPage(bobContext);await page.goto(base+'/#community/note/'+note.id);await waitDetail(page,note.id,rootComment.id);
  await json('seed',{noteId:note.id,rootId:rootComment.id,firstReplyId:initialReply.id,hiddenReplyId:hiddenTarget.id,notificationId:notification.id,accounts:{alice:alice.id,bob:bob.id,carol:carol.id}});

  mark('desktop 1440 typography, top-aligned avatars and default single reply');
  await page.setViewportSize({width:1440,height:1000});assert.equal(await replyRows(page,rootComment.id).count(),1);
  assert.equal(await replyRows(page,rootComment.id).first().getAttribute('data-comment'),initialReply.id);
  const expand=page.locator(`[data-cm="replies-expand"][data-id="${rootComment.id}"]`);await expand.waitFor();assert.equal(await expand.getAttribute('aria-expanded'),'false');
  await noOverflow(page);await recordTypography(page,'desktop-1440',rootComment.id);await footerGeometry(page,'desktop-1440-footer');
  checks.push('1440px detail typography, top-aligned root/reply avatars, one default reply and no horizontal overflow');

  mark('local action menu anchors, outside click and Escape focus');
  const noteMore=page.locator('.cm-note-date [data-cm="note-more"]');
  await anchoredMenu(page,noteMore,'desktop-note-outside');await page.locator('.cm-detail-copy h1').click();await page.locator('.cm-context-menu').waitFor({state:'hidden'});assert(await page.locator('.cm-detail-dialog').isVisible());
  await anchoredMenu(page,noteMore,'desktop-note-escape');await page.keyboard.press('Escape');await page.locator('.cm-context-menu').waitFor({state:'hidden'});assert(await page.locator('.cm-detail-dialog').isVisible());assert(await noteMore.evaluate(element=>element===document.activeElement));
  checks.push('Detail menus are anchored; outside click and Escape dismiss them, preserve the detail and restore focus');

  mark('note, root comment and child reply report persistence');
  await reportThroughUI(page,noteMore,'note',note.id,'desktop-note-report');
  await reportThroughUI(page,page.locator(`[data-cm="comment-more"][data-id="${rootComment.id}"]`),'comment',rootComment.id,'desktop-root-report');
  await reportThroughUI(page,page.locator(`[data-cm="comment-more"][data-id="${initialReply.id}"]`),'comment',initialReply.id,'desktop-reply-report');
  const stored=(await api(bobContext,'/export')).community.reports;for(const report of reports)assert(stored.some(item=>item.id===report.id&&item.targetId===report.targetId),'A submitted report must persist in the isolated database');
  checks.push('Note, top-level comment and child reply each submit and persist the correct report target through the real API');

  mark('expand, collapse and re-expand retain replies without repeat network reads');
  let replyReads=0;page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname===`/api/community/comments/${rootComment.id}/replies`)replyReads++;});
  await expand.click();await page.waitForFunction(id=>document.querySelector(`[data-comment="${id}"] .cm-replies`)?.querySelectorAll(':scope > .cm-reply').length===4,rootComment.id);
  const initialReads=replyReads;assert(initialReads>=1,'Expanding loads the remaining reply history');
  const collapse=page.locator(`[data-cm="replies-collapse"][data-id="${rootComment.id}"]`);await collapse.waitFor();assert.equal(await collapse.getAttribute('aria-expanded'),'true');
  const expandedIds=await replyRows(page,rootComment.id).evaluateAll(rows=>rows.map(row=>row.dataset.comment));
  await collapse.click();assert.equal(await replyRows(page,rootComment.id).count(),1);await expand.click();
  await page.waitForFunction(id=>document.querySelector(`[data-comment="${id}"] .cm-replies`)?.querySelectorAll(':scope > .cm-reply').length===4,rootComment.id);
  await page.waitForTimeout(150);assert.equal(replyReads,initialReads,'Re-expanding cached replies must not repeat GET requests');
  assert.deepEqual(await replyRows(page,rootComment.id).evaluateAll(rows=>rows.map(row=>row.dataset.comment)),expandedIds);
  await screenshot(page,'desktop-expanded-replies');checks.push('Expand/collapse/re-expand retain complete reply order and reuse the loaded cache');

  mark('sending a reply from a collapsed thread shows the new reply');
  await collapse.click();await page.locator(`[data-cm="reply"][data-id="${rootComment.id}"]`).click();await page.locator('#cm-comment-input').fill('浏览器验收新回复：发送完成后仍然可见。');
  const sendResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/community/notes/${note.id}/comments`);
  await page.locator('.cm-comment-send').click();const sent=(await (await sendResponse).json()).comment;assert.equal(sent.parentId,rootComment.id);
  await page.locator(`.cm-reply[data-comment="${sent.id}"]`).waitFor();assert.equal(await replyRows(page,rootComment.id).count(),5);await collapse.waitFor();
  await page.locator('#cm-comment-input').blur();await lastReplyReadable(page,rootComment.id,sent.id,'desktop-last-reply');
  checks.push('Sending a reply expands its parent and keeps the acknowledged new reply visible');

  mark('notification locates a reply hidden by the default fold');
  await closeDetail(page);await openDetail(page,note.id,rootComment.id);assert.equal(await replyRows(page,rootComment.id).count(),1);assert.equal(await page.locator(`[data-comment="${hiddenTarget.id}"]`).count(),0);
  await route(page,'#community/notifications?type=comments');const notificationButton=page.locator(`[data-cm="notification-open"][data-id="${notification.id}"]`);await notificationButton.waitFor();await notificationButton.click();
  await page.locator(`.cm-reply[data-comment="${hiddenTarget.id}"].cm-comment-highlight`).waitFor();await screenshot(page,'desktop-notification-reply-context');assert(await collapse.isVisible());
  const positioned=await page.locator(`.cm-reply[data-comment="${hiddenTarget.id}"]`).boundingBox(),footer=await page.locator('.cm-detail-footer').boundingBox();assert(positioned&&footer&&positioned.y+positioned.height<=footer.y+2,'Located reply must be readable above the footer');
  checks.push('A reply notification expands its collapsed parent, highlights the target and scrolls it into view');

  const state=await bobContext.storageState();
  for(const width of [390,320]){
    mark(`mobile ${width} detail geometry and anchored reply actions`);
    const context=await makeContext({viewport:{width,height:844},isMobile:true,hasTouch:true,storageState:state});const mobile=currentPage=await trackedPage(context);
    await mobile.goto(base+'/#community/note/'+note.id);await waitDetail(mobile,note.id,rootComment.id);assert.equal(await replyRows(mobile,rootComment.id).count(),1);
    await noOverflow(mobile);await recordTypography(mobile,'mobile-'+width,rootComment.id);await footerGeometry(mobile,'mobile-'+width+'-footer');
    const childMore=mobile.locator(`[data-cm="comment-more"][data-id="${initialReply.id}"]`);await anchoredMenu(mobile,childMore,'mobile-'+width+'-reply-menu');await screenshot(mobile,'mobile-'+width+'-reply-menu');await noOverflow(mobile);
    await mobile.keyboard.press('Escape');await mobile.locator('.cm-context-menu').waitFor({state:'hidden'});assert(await mobile.locator('.cm-detail-dialog').isVisible());
    await mobile.locator(`[data-cm="replies-expand"][data-id="${rootComment.id}"]`).click();await mobile.locator(`.cm-reply[data-comment="${sent.id}"]`).waitFor();assert.equal(await replyRows(mobile,rootComment.id).count(),5);
    await lastReplyReadable(mobile,rootComment.id,sent.id,'mobile-'+width+'-last-reply');
    await mobile.locator(`[data-cm="replies-collapse"][data-id="${rootComment.id}"]`).click();assert.equal(await replyRows(mobile,rootComment.id).count(),1);await noOverflow(mobile);
    checks.push(`${width}px mobile: readable aligned root/reply text, one default reply, anchored child action menu, expandable history and no horizontal overflow`);
  }
  currentPage=page;
  mark('more than 20 replies preserve pagination and the complete cache');
  const pagedRoot=await comment(aliceContext,'分页回复验收线程，和四条回复的交互验收相互独立。');
  const pagedIds=[];for(let index=0;index<22;index++)pagedIds.push((await comment(aliceContext,'分页回复 '+(index+1),pagedRoot.id)).id);
  await closeDetail(page);await openDetail(page,note.id,pagedRoot.id);assert.equal(await replyRows(page,pagedRoot.id).count(),1);
  let pagedReads=0;page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname===`/api/community/comments/${pagedRoot.id}/replies`)pagedReads++;});
  await page.locator(`[data-cm="replies-expand"][data-id="${pagedRoot.id}"]`).click();
  await page.waitForFunction(id=>document.querySelector(`[data-comment="${id}"] .cm-replies`)?.querySelectorAll(':scope > .cm-reply').length===20,pagedRoot.id);
  const more=page.locator(`[data-cm="replies-more"][data-id="${pagedRoot.id}"]`);await more.waitFor();await page.waitForFunction(id=>!document.querySelector(`[data-cm="replies-more"][data-id="${id}"]`)?.disabled,pagedRoot.id);
  assert.equal(pagedReads,1);await more.click();
  await page.waitForFunction(id=>document.querySelector(`[data-comment="${id}"] .cm-replies`)?.querySelectorAll(':scope > .cm-reply').length===22,pagedRoot.id);
  assert.equal(pagedReads,2);assert.deepEqual(await replyRows(page,pagedRoot.id).evaluateAll(rows=>rows.map(row=>row.dataset.comment)),pagedIds);assert.equal(await more.count(),0);
  await page.locator(`[data-cm="replies-collapse"][data-id="${pagedRoot.id}"]`).click();assert.equal(await replyRows(page,pagedRoot.id).count(),1);
  await page.locator(`[data-cm="replies-expand"][data-id="${pagedRoot.id}"]`).click();assert.equal(await replyRows(page,pagedRoot.id).count(),22);await page.waitForTimeout(150);assert.equal(pagedReads,2);
  await screenshot(page,'desktop-paginated-replies');checks.push('22 replies page as 20 + 2, preserve exact order and remain cached after collapse/re-expand');
  assert.deepEqual(errors,[],'Unexpected browser script errors');await json('geometry',geometry);
  const result={passed:true,dataDir,checks,reports,errors};await json('result',result);console.log(JSON.stringify(result,null,2));
}catch(error){
  await screenshot(currentPage,'failure').catch(()=>{});await json('geometry',geometry);await json('failure',{step,message:error.message,stack:error.stack,errors});console.error('FAILED STEP:',step,'Artifacts:',dataDir);throw error;
}finally{
  for(const context of contexts)await context.close().catch(()=>{});
  await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}
