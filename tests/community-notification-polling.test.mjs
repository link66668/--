import assert from 'node:assert/strict';
import test from 'node:test';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
function setup(){let user={id:'reader'};const value=new CommunityController({getUser:()=>user,api:()=>{},toast:()=>{}});value.container={isConnected:true,querySelector:()=>null};value.renderNotificationRows=()=>{};return {value,account:id=>{user={id};}};}
function globals(t,values){for(const [name,value]of Object.entries(values)){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});}}

test('simultaneous notification polling and foreground refresh share one outstanding request',async()=>{
  const {value}=setup(),pending=deferred();let gets=0;value.api.get=()=>{gets++;return pending.promise;};
  const first=value.refreshUnread();await Promise.resolve();const foreground=value.refreshUnread(),nextPoll=value.refreshUnread();assert.equal(gets,1);
  pending.resolve({unreadCount:3});await Promise.all([first,foreground,nextPoll]);assert.equal(gets,1);assert.equal(value.unreadCount,3);assert.equal(value.controllers.size,0);
});

test('a refresh requested after reading discards its old response and fetches the current count serially',async()=>{
  const {value}=setup(),old=deferred();let gets=0;value.api.get=()=>++gets===1?old.promise:Promise.resolve({unreadCount:1});value.api.write=async()=>({unreadCount:0});
  const polling=value.refreshUnread();await Promise.resolve();await value.readNotifications();assert.equal(value.unreadCount,0);
  const foreground=value.refreshUnread();assert.equal(gets,1);old.resolve({unreadCount:8});await Promise.all([polling,foreground]);assert.equal(gets,2);assert.equal(value.unreadCount,1);
});

test('polling during a pending read waits for its acknowledgement before refreshing real new notifications',async()=>{
  const {value}=setup(),read=deferred();let gets=0;value.api.write=()=>read.promise;value.api.get=async()=>{gets++;return {unreadCount:1};};
  const reading=value.readNotifications();await value.refreshUnread();assert.equal(gets,0);read.resolve({unreadCount:0});await reading;assert.equal(gets,1);assert.equal(value.unreadCount,1);
});

test('late notification responses cannot change an account after switching users',async()=>{
  const {value,account}=setup(),old=deferred();value.unreadCount=2;value.api.get=()=>old.promise;const request=value.refreshUnread();await Promise.resolve();account('other');old.resolve({unreadCount:19});await request;assert.equal(value.unreadCount,2);await value.refreshUnread();assert.equal(value.notificationUnreadRefresh,null);
});

test('remounting cancels the retired refresh and rejects its response after the new container updates',async()=>{
  const {value}=setup(),old=deferred(),fresh=deferred(),signals=[];value.api.get=(path,params,signal)=>{signals.push(signal);return signals.length===1?old.promise:fresh.promise;};
  const retired=value.refreshUnread();await Promise.resolve();value.container={isConnected:true,querySelector:()=>null};const mounted=value.refreshUnread();await Promise.resolve();assert.equal(signals.length,2);assert(signals[0].aborted);
  fresh.resolve({unreadCount:1});await mounted;old.resolve({unreadCount:20});await retired;assert.equal(value.unreadCount,1);
});

test('social polling and restoring visibility refresh notifications; a failed GET does not stop message polling',async t=>{
  const doc={hidden:false},timers=[];globals(t,{document:doc,setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},clearTimeout:()=>{}});
  const {value}=setup();let notifications=0,messages=0,groups=0,chat=0;value.api.get=async()=>{notifications++;throw new Error('temporary unavailable');};value.refreshMessageUnread=async()=>{messages++;};value.groups={unread:async()=>{},poll:async()=>{groups++;}};value.markChatRead=async()=>{chat++;};
  value.startSocialPolling();await value.notificationUnreadRefresh.promise;assert.equal(notifications,1);assert.equal(timers[0].delay,5000);
  await timers[0].callback();await value.notificationUnreadRefresh.promise;assert.equal(notifications,2);assert.equal(messages,2);assert.equal(groups,1);assert.equal(timers.length,2);
  doc.hidden=true;value.boundVisibility();assert.equal(value.socialTimer,null);doc.hidden=false;value.boundVisibility();await value.notificationUnreadRefresh.promise;assert.equal(notifications,3);assert.equal(messages,3);assert.equal(chat,1);
});

test('a slow notification response never stalls subsequent message and group polling or duplicates its GET',async t=>{
  const timers=[];globals(t,{document:{hidden:false},setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout:()=>{}});
  const {value}=setup(),pending=deferred();let gets=0,messages=0,groups=0;value.api.get=()=>{gets++;return pending.promise;};value.refreshMessageUnread=async()=>{messages++;};value.groups={unread:async()=>{},poll:async()=>{groups++;}};
  value.startSocialPolling();await Promise.resolve();await timers[0]();await timers[1]();assert.equal(gets,1);assert.equal(messages,3);assert.equal(groups,2);pending.resolve({unreadCount:1});await value.notificationUnreadRefresh.promise;assert.equal(value.unreadCount,1);
});

test('a retired polling callback and an unmounted refresh cannot start new account requests',async t=>{
  const timers=[];globals(t,{document:{hidden:false},setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout:()=>{}});
  const {value}=setup();let gets=0,messages=0;value.api.get=async()=>{gets++;return {unreadCount:0};};value.refreshMessageUnread=async()=>{messages++;};value.groups={unread:async()=>{},poll:async()=>{throw new Error('Retired group poll ran');}};
  value.startSocialPolling();await value.notificationUnreadRefresh.promise;value.stopSocialPolling();value.container=null;await timers[0]();await value.refreshUnread();assert.equal(gets,1);assert.equal(messages,1);assert.equal(timers.length,1);
});
