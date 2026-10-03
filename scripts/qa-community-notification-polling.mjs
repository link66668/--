// Live notification polling, reads and visibility recovery in isolated Edge accounts.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const playwrightPath=[process.env.QA_PLAYWRIGHT,join(root,'.qa/community-tools/node_modules/playwright/index.mjs'),join(root,'精细模型与动作开发/node_modules/playwright/index.mjs')].find(path=>path&&existsSync(path));
if(!playwrightPath)throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 的路径。');
const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root,'.qa'),{recursive:true});const dataDir=await mkdtemp(join(root,'.qa','community-notification-polling-'));
const server=await startServer({host:'127.0.0.1',port:0,dataDir});const base=`http://127.0.0.1:${server.address().port}`;
const contexts=[],checks=[],errors=[],requests=[];let browser,page,step='setup',releaseOld,releaseSlow;
const json=(name,value)=>writeFile(join(dataDir,name+'.json'),JSON.stringify(value,null,2));
const mark=name=>{step=name;console.log(name);};
const api=async(context,path,method='GET',body)=>{const response=await context.request.fetch(base+'/api'+path,{method,...(body===undefined?{}:{data:body})});const value=await response.json();assert(response.ok(),`${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);return value;};
const community=(context,path,method='GET',body)=>api(context,'/community'+path,method,body);
const waitBadge=(count,timeout=12000)=>page.waitForFunction(count=>{const badge=document.querySelector('.cm-unread-dot');return badge&&badge.hidden===(count===0)&&badge.textContent===(count?String(count):'');},count,{timeout});
const route=hash=>page.evaluate(hash=>{location.hash=hash;},hash);
const screenshot=name=>page.screenshot({path:join(dataDir,name+'.png'),fullPage:false,style:'#toasts{visibility:hidden}'});
const isRefresh=request=>{const url=new URL(request.url());return url.pathname==='/api/community/notifications'&&url.searchParams.get('limit')==='1';};
const visibility=hidden=>page.evaluate(hidden=>{Object.defineProperty(document,'hidden',{value:hidden,configurable:true});document.dispatchEvent(new Event('visibilitychange'));},hidden);
const markAll=async()=>{const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/community/notifications/read'&&response.request().method()==='PUT');await page.locator('[data-cm="notifications-read"]').click();assert.equal((await (await response).json()).unreadCount,0);await waitBadge(0);};
try{
  browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  for(let i=0;i<2;i++)contexts.push(await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}));
  const [ownerContext,actorContext]=contexts;
  for(const [i,context]of contexts.entries()){await api(context,'/auth/register','POST',{name:i?'评论者':'通知接收者',email:`notification-poll-${i}@example.test`,password:'isolated-notification-poll-qa-password'});await api(context,'/sync','POST',{changes:[{id:'profile',kind:'profile',data:{age:25,height:172,weight:68,sex:'male',goal:'maintain',activity:1.375},baseVersion:0}]});}
  const {note}=await community(ownerContext,'/notes','POST',{type:'text',title:'实时互动通知验收',body:'本笔记仅存在于隔离测试数据库。',category:'experience',topics:[],media:[],clientMutationId:randomUUID()});
  const comment=text=>community(actorContext,`/notes/${note.id}/comments`,'POST',{body:text,clientMutationId:randomUUID()});
  page=await ownerContext.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const url=new URL(request.url());if(['/api/community/notifications','/api/community/messages/unread','/api/community/groups/unread'].includes(url.pathname))requests.push({path:url.pathname,limit:url.searchParams.get('limit'),time:Date.now()});});
  await page.goto(base+'/#community');await waitBadge(0);

  mark('new-comment-updates-the-feed-without-navigation');
  const sentAt=Date.now();await comment('用户停留推荐页时收到的新评论');await waitBadge(1);const delayMs=Date.now()-sentAt;assert.equal(await page.evaluate(()=>location.hash),'#community');assert.equal((await community(ownerContext,'/notifications')).unreadCount,1);await screenshot('live-feed-one');
  checks.push({name:'两账号真实评论在推荐页自动显示1，无刷新或导航',delayMs});

  mark('read-acknowledgement-rejects-the-delayed-old-poll-response');
  let captured;const capturedOld=new Promise(resolve=>captured=resolve),oldHeld=new Promise(resolve=>releaseOld=resolve);let holdOld=true;
  await page.route('**/api/community/notifications?*',async intercepted=>{if(!holdOld||!isRefresh(intercepted.request()))return intercepted.continue();holdOld=false;const response=await intercepted.fetch(),body=await response.text();assert.equal(JSON.parse(body).unreadCount,1);captured();await oldHeld;await intercepted.fulfill({status:response.status(),contentType:'application/json',body});});
  await capturedOld;await route('#community/notifications');await page.locator('.cm-notification').first().waitFor();await markAll();await route('#community');await waitBadge(0);
  await page.evaluate(()=>{window.notificationBadgeValues=[];const badge=document.querySelector('.cm-unread-dot');window.notificationBadgeObserver=new MutationObserver(()=>window.notificationBadgeValues.push(badge.textContent));window.notificationBadgeObserver.observe(badge,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden']});});
  releaseOld();await page.waitForTimeout(6000);await waitBadge(0);const afterRead=await page.evaluate(()=>window.notificationBadgeValues);assert(!afterRead.includes('1'),`Old unread count rebounded: ${JSON.stringify(afterRead)}`);await page.unroute('**/api/community/notifications?*');await screenshot('read-zero-no-rebound');
  checks.push({name:'真实全部已读归零后，迟到的未读1快照和下一次轮询均不反弹',afterRead});

  mark('visibility-recovery-refreshes-immediately-and-pauses-background-polling');
  await visibility(true);const beforeHidden=requests.filter(row=>row.path==='/api/community/notifications'&&row.limit==='1').length;await comment('后台期间到达的真实评论');await page.waitForTimeout(5600);assert.equal(requests.filter(row=>row.path==='/api/community/notifications'&&row.limit==='1').length,beforeHidden);await waitBadge(0);
  const resumedAt=Date.now();await visibility(false);await waitBadge(1,2500);const resumeDelayMs=Date.now()-resumedAt;await screenshot('foreground-one');
  checks.push({name:'浏览器visibilitychange信号模拟后台/前台：后台停止5秒轮询，前台立即显示新评论',resumeDelayMs,backgroundRefreshes:0});

  mark('slow-refresh-is-shared-and-does-not-block-message-or-group-polling');
  let slowCaptured;const capturedSlow=new Promise(resolve=>slowCaptured=resolve),slowHeld=new Promise(resolve=>releaseSlow=resolve);let slowGets=0,holdSlow=true;
  await page.route('**/api/community/notifications?*',async intercepted=>{if(!isRefresh(intercepted.request()))return intercepted.continue();slowGets++;if(!holdSlow)return intercepted.continue();holdSlow=false;const response=await intercepted.fetch(),body=await response.text();slowCaptured();await slowHeld;await intercepted.fulfill({status:response.status(),contentType:'application/json',body});});
  await visibility(true);await visibility(false);await capturedSlow;const messageBefore=requests.filter(row=>row.path==='/api/community/messages/unread').length,groupBefore=requests.filter(row=>row.path==='/api/community/groups/unread').length;
  await visibility(false);await visibility(false);await page.waitForTimeout(5600);assert.equal(slowGets,1);assert(requests.filter(row=>row.path==='/api/community/messages/unread').length>messageBefore);assert(requests.filter(row=>row.path==='/api/community/groups/unread').length>groupBefore);releaseSlow();await waitBadge(1);await page.waitForTimeout(100);await page.unroute('**/api/community/notifications?*');
  checks.push({name:'迟缓通知GET跨轮询/重复前台事件只发一份；私信和群聊仍继续刷新',slowGets});

  mark('failed-notification-refresh-retains-count-and-recovers-on-the-next-poll');
  let failOnce=true,failedAt,failed;const failedRefresh=new Promise(resolve=>failed=resolve);
  await page.route('**/api/community/notifications?*',async intercepted=>{if(!failOnce||!isRefresh(intercepted.request()))return intercepted.continue();failOnce=false;failedAt=Date.now();await intercepted.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离QA：通知查询暂不可用'})});failed();});
  await comment('通知查询失败后，下一次轮询应恢复');await failedRefresh;await waitBadge(1);await waitBadge(2);assert(requests.some(row=>row.path==='/api/community/messages/unread'&&row.time>=failedAt));await screenshot('retry-two');
  checks.push({name:'通知503保留现有数字，其他轮询继续；下次成功自动显示真实2'});
  await page.unroute('**/api/community/notifications?*');await page.evaluate(()=>{window.notificationBadgeObserver?.disconnect();delete document.hidden;});assert.deepEqual(errors,[]);await json('requests',requests);await json('result',{passed:checks.length,checks,errors,dataDir});console.log(JSON.stringify({passed:checks.length,dataDir},null,2));
}catch(error){await screenshot('failure').catch(()=>{});await json('requests',requests);await json('failure',{step,message:error.message,stack:error.stack,errors});console.error('FAILED STEP:',step,'Artifacts:',dataDir);throw error;}
finally{releaseOld?.();releaseSlow?.();for(const context of contexts)await context.close().catch(()=>{});await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
