import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createCommunityGroups} from '../server/community-groups.mjs';
import {createCommunityGroupsStore} from '../server/community-groups-storage.mjs';
import {communityTransaction} from '../server/community-storage.mjs';
import {HttpError} from '../server/providers.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'community-groups-test-')),db=new DatabaseSync(join(directory,'groups.sqlite'));
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE checks(value TEXT);");createCommunityGroupsStore(db);
  const users=Object.fromEntries(['owner','admin','member','other','outsider'].map(name=>[name,{id:randomUUID(),name}]));
  for(const user of Object.values(users))db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(user.id,user.name);
  const author=id=>{const user=db.prepare('SELECT id,name FROM users WHERE id=?').get(id);return user?{id:user.id,nickname:user.name,accountNumber:'1234567890'}:{id:null,nickname:'已注销用户'};};
  const readBody=async(req,max)=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw new HttpError(413,'Body too large');chunks.push(chunk);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};};
  const transactionFor=(user,callback)=>communityTransaction(db,()=>{if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(user.id))throw new HttpError(401,'已注销');return callback();});
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  let groups=createCommunityGroups({db,author,transactionFor,throttle:()=>{},readBody,send});
  const server=http.createServer(async(req,res)=>{const user=db.prepare('SELECT id,name FROM users WHERE id=?').get(req.headers['x-test-user']||'');if(!user)return send(res,401,{error:'未登录'});try{const url=new URL(req.url,'http://local');if(!await groups.handle(req,res,user,url.pathname,url.searchParams))send(res,404,{error:'Not found'});}catch(error){send(res,error instanceof HttpError?error.status:500,{error:error.message});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const pending=new Set();t.after(async()=>{for(const request of pending)request.destroy();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,method='GET',body,who='owner')=>{const response=await fetch(base+path,{method,headers:{...(who?{'X-Test-User':users[who]?.id||who}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  const create=async(name='训练伙伴',who='owner',extra={})=>{const result=await api('/groups','POST',{name,description:'互相鼓励',announcement:'成员公告',clientMutationId:randomUUID(),...extra},who);assert.equal(result.status,201,JSON.stringify(result.body));return result.body.group;};
  const invite=async(group,who='member',inviter='owner')=>{const response=await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users[who].id]},inviter);assert.equal(response.status,200);const invitation=response.body.items[0];const accepted=await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},who);assert.equal(accepted.status,200,JSON.stringify(accepted.body));return invitation;};
  const message=async(group,who='owner',body='一起训练',extra={})=>{const result=await api(`/groups/${group.id}/messages`,'POST',{body,clientMutationId:randomUUID(),...extra},who);assert.equal(result.status,201,JSON.stringify(result.body));return result.body.message;};
  const beginJson=(path,method,body,who='member')=>{const bytes=Buffer.from(JSON.stringify(body));let startResolve,resultResolve,resultReject;const started=new Promise(resolve=>startResolve=resolve),result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});const observe=req=>{if(req.url!==path||req.method!==method)return;server.off('request',observe);req.once('readable',startResolve);};server.on('request',observe);const request=http.request(base+path,{method,headers:{'X-Test-User':users[who].id,'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{pending.delete(request);resultResolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});});});pending.add(request);request.on('error',error=>{pending.delete(request);server.off('request',observe);resultReject(error);});request.write(bytes.subarray(0,1));return {started,finish:()=>{request.end(bytes.subarray(1));return result;}};};
  return {db,users,api,create,invite,message,beginJson,transactionFor,get groups(){return groups;},reload:()=>{groups=createCommunityGroups({db,author,transactionFor,throttle:()=>{},readBody,send});}};
}

test('groups have unique numbers, private metadata, isolated ownership and creation receipts',async t=>{
  const {api,create}=await fixture(t),group=await create('训练伙伴','owner',{clientMutationId:'group-retry'});
  assert.match(group.groupNumber,/^[1-9]\d{7}$/);assert.equal(group.role,'owner');assert.equal(group.memberCount,1);assert.equal(group.canSend,true);
  assert.equal((await api('/groups','POST',{name:'训练伙伴',description:'互相鼓励',announcement:'成员公告',clientMutationId:'group-retry'})).body.group.id,group.id);
  assert.equal((await api('/groups','POST',{name:'其他名称',clientMutationId:'group-retry'})).status,409);
  assert.equal((await api('/groups','POST',{name:'长'.repeat(31)})).status,400);
  assert.equal((await api('/groups','POST',{name:'群',description:'长'.repeat(121)})).status,400);
  assert.equal((await api('/groups','GET',undefined,'outsider')).body.items.length,0);
  assert.equal((await api(`/groups/${group.id}`,'GET',undefined,'outsider')).status,404);
  assert.equal((await api(`/groups/${group.id}/members`,'GET',undefined,'outsider')).status,404);
  const found=(await api('/groups/search?q='+group.groupNumber,'GET',undefined,'outsider')).body.items[0];assert.equal(found.id,group.id);
  for(const key of ['announcement','lastMessage','ownerId','role','members'])assert.equal(key in found,false);
  assert.equal((await api('/groups/search?q=伙伴','GET',undefined,'outsider')).status,400);
  assert.equal((await api('/groups','GET',undefined,null)).status,401);
  assert.notEqual((await create()).groupNumber,group.groupNumber);
});

test('join requests need a manager and invitations require the intended recipient to accept',async t=>{
  const {api,create,users}=await fixture(t),group=await create();
  const joined=await api(`/groups/${group.id}/join`,'POST',{},'member'),request=joined.body.request;assert.equal(joined.status,200);assert.equal(request.status,'pending');
  assert.equal((await api(`/groups/${group.id}/join`,'POST',{},'member')).body.request.id,request.id);
  assert.equal((await api(`/groups/${group.id}/messages`,'GET',undefined,'member')).status,404);
  assert.equal((await api(`/groups/${group.id}/requests`,'GET',undefined,'member')).status,404);
  assert.equal((await api(`/groups/${group.id}/requests/${request.id}`,'PATCH',{action:'approve'})).body.request.status,'approved');
  assert.equal((await api(`/groups/${group.id}/requests/${request.id}`,'PATCH',{action:'approve'})).status,200);
  assert.equal((await api(`/groups/${group.id}/requests`,'GET',undefined,'member')).status,403);
  const invitation=(await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users.other.id]},'member')).body.items[0];
  assert.equal((await api('/groups/unread','GET',undefined,'other')).body.invitationCount,1);
  assert.equal((await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'outsider')).status,404);
  assert.equal((await api(`/groups/${group.id}`,'GET',undefined,'other')).status,404);
  assert.equal((await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'other')).status,200);
  assert.equal((await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'other')).status,200);
  assert.equal((await api('/groups/unread','GET',undefined,'other')).body.invitationCount,0);
  assert.equal((await api(`/groups/${group.id}/members`)).body.items.length,3);
  const rejected=(await api(`/groups/${group.id}/join`,'POST',{},'outsider')).body.request;assert.equal((await api(`/groups/${group.id}/requests/${rejected.id}`,'PATCH',{action:'reject'})).body.request.status,'rejected');
  assert.notEqual((await api(`/groups/${group.id}/join`,'POST',{},'outsider')).body.request.id,rejected.id);
});

test('owner and admin powers, global mute and individual mute obey the stated hierarchy',async t=>{
  const {api,create,invite,message,users}=await fixture(t),group=await create();await invite(group,'admin');await invite(group,'member');await invite(group,'other');
  assert.equal((await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{role:'admin'})).status,200);
  assert.equal((await api(`/groups/${group.id}/members/${users.other.id}`,'PATCH',{role:'admin'},'admin')).status,403);
  assert.equal((await api(`/groups/${group.id}/members/${users.owner.id}`,'DELETE',{},'admin')).status,403);
  assert.equal((await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{muted:false},'admin')).status,403);
  assert.equal((await api(`/groups/${group.id}`,'PATCH',{muteAll:true},'admin')).status,200);
  assert.equal((await api(`/groups/${group.id}`,'GET',undefined,'member')).body.group.canSend,false);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'被全员禁言',clientMutationId:'mute-all'},'member')).status,403);
  await message(group,'admin');await message(group,'owner');
  assert.equal((await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{muted:true})).status,200);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'被单人禁言',clientMutationId:'mute-admin'},'admin')).status,403);
  assert.equal((await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{muted:false})).status,200);
  assert.equal((await api(`/groups/${group.id}/members/${users.member.id}`,'PATCH',{muted:true},'admin')).status,200);
  assert.equal((await api(`/groups/${group.id}/members/${users.other.id}`,'DELETE',{},'admin')).status,200);
  assert.equal((await api(`/groups/${group.id}/messages`,'GET',undefined,'other')).status,404);
  assert.equal((await api(`/groups/${group.id}`,'PATCH',{name:'越权'},'member')).status,403);
});

test('structured mentions, message receipts, unread counts and read delivery stay consistent',async t=>{
  const {api,create,invite,message,users,groups}=await fixture(t),group=await create();await invite(group,'member');await invite(group,'other');
  const sent=await message(group,'owner','@伙伴',{clientMutationId:'mention-retry',mentionUserIds:[users.member.id,users.member.id]});assert.deepEqual(sent.mentionUserIds,[users.member.id]);
  assert.deepEqual(sent.mentionUsers,[{id:users.member.id,nickname:'member',accountNumber:'1234567890'}]);
  const retry=await api(`/groups/${group.id}/messages`,'POST',{body:'@伙伴',clientMutationId:'mention-retry',mentionUserIds:[users.member.id]});assert.equal(retry.body.message.id,sent.id);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'@不同',clientMutationId:'mention-retry'})).status,409);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'@非成员',clientMutationId:'mention-outsider',mentionUserIds:[users.outsider.id]})).status,400);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'@全体',clientMutationId:'mention-all-denied',mentionAll:true},'member')).status,403);
  const all=await message(group,'owner','@全体',{mentionAll:true});assert.equal(groups.unreadCount(users.member.id),2);
  assert.equal((await api('/groups/unread','GET',undefined,'member')).body.mentionUnreadCount,2);assert.equal((await api('/groups/unread','GET',undefined,'other')).body.mentionUnreadCount,1);
  assert.equal((await api(`/groups/${group.id}/read`,'PUT',{lastMessageId:all.id},'member')).status,400,'Unfetched messages cannot be read');
  const history=(await api(`/groups/${group.id}/messages?after=0`,'GET',undefined,'member')).body.items;assert(history.every(row=>row.mentionedMe&&row.sender.id===users.owner.id));
  const read=await api(`/groups/${group.id}/read`,'PUT',{lastMessageId:all.id},'member');assert.equal(read.body.unreadCount,0);assert.equal(read.body.mentionUnreadCount,0);
  await api(`/groups/${group.id}/read`,'PUT',{lastMessageId:sent.id},'member');assert.equal((await api('/groups/unread','GET',undefined,'member')).body.unreadCount,0,'Read boundary never rolls backwards');
  const own=await message(group,'member');await api(`/groups/${group.id}/messages`,'GET',undefined,'member');assert.equal((await api(`/groups/${group.id}/read`,'PUT',{lastMessageId:own.id},'member')).status,400);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'长'.repeat(1001),clientMutationId:'too-long'})).status,400);
  assert.equal((await api(`/groups/${group.id}/messages`,'POST',{body:'缺幂等键'})).status,400);
});

test('mention public labels follow nickname changes and use the deleted account fallback',async t=>{
  const {api,create,invite,message,users,db,groups,transactionFor}=await fixture(t),group=await create();await invite(group,'member');
  const sent=await message(group,'owner','提醒成员',{mentionUserIds:[users.member.id]});db.prepare('UPDATE users SET name=? WHERE id=?').run('新昵称',users.member.id);
  let messages=(await api(`/groups/${group.id}/messages`)).body.items;assert.equal(messages.find(row=>row.id===sent.id).mentionUsers[0].nickname,'新昵称');
  transactionFor(users.member,()=>{groups.deleteUserData(users.member.id);db.prepare('DELETE FROM users WHERE id=?').run(users.member.id);});
  messages=(await api(`/groups/${group.id}/messages`)).body.items;const remaining=messages.find(row=>row.id===sent.id);assert.deepEqual(remaining.mentionUserIds,[users.member.id]);assert.deepEqual(remaining.mentionUsers,[{id:null,nickname:'已注销用户'}]);
});

test('history has joined boundaries and account, group and membership-bound signed cursors',async t=>{
  const {api,create,invite,message,users,reload}=await fixture(t),group=await create(),before=await message(group);await invite(group,'member');await invite(group,'other');
  assert.equal((await api(`/groups/${group.id}/messages`,'GET',undefined,'member')).body.items.length,0);
  const messages=[];for(let index=0;index<5;index++)messages.push(await message(group,'owner','消息'+index));
  const first=(await api(`/groups/${group.id}/messages?limit=2`,'GET',undefined,'member')).body;assert.deepEqual(first.items.map(row=>row.id),messages.slice(-2).map(row=>row.id));assert(first.hasMore);
  assert.equal((await api(`/groups/${group.id}/messages?before=${encodeURIComponent(first.nextCursor)}`,'GET',undefined,'other')).status,400);
  assert.equal((await api(`/groups/${group.id}/messages?after=${before.id}`,'GET',undefined,'member')).status,400);
  const otherGroup=await create('另一群');await invite(otherGroup,'member');assert.equal((await api(`/groups/${otherGroup.id}/messages?before=${encodeURIComponent(first.nextCursor)}`,'GET',undefined,'member')).status,400);
  reload();const older=(await api(`/groups/${group.id}/messages?before=${encodeURIComponent(first.nextCursor)}&limit=2`,'GET',undefined,'member')).body;assert.deepEqual(older.items.map(row=>row.id),messages.slice(1,3).map(row=>row.id));
  assert.equal((await api(`/groups/${group.id}/members/${users.member.id}`,'DELETE',{})).status,200);
  assert.equal((await api(`/groups/${group.id}/messages`,'GET',undefined,'member')).status,404);
  await message(group,'owner','离群期间');await invite(group,'member');assert.equal((await api(`/groups/${group.id}/messages?after=0`,'GET',undefined,'member')).body.items.length,0);
  assert.equal((await api(`/groups/${group.id}/messages?before=${encodeURIComponent(first.nextCursor)}`,'GET',undefined,'member')).status,400);
  const latest=await message(group,'owner','重入之后');assert.deepEqual((await api(`/groups/${group.id}/messages?after=0`,'GET',undefined,'member')).body.items.map(row=>row.id),[latest.id]);
});

test('membership removal and muting during a streaming write are rechecked after body read',async t=>{
  const {api,create,invite,beginJson,users}=await fixture(t),group=await create();await invite(group);
  const pending=beginJson(`/groups/${group.id}/messages`,'POST',{body:'等待请求体',clientMutationId:'slow-remove'});await pending.started;
  await api(`/groups/${group.id}/members/${users.member.id}`,'DELETE',{});assert.equal((await pending.finish()).status,404);
  await invite(group);const muted=beginJson(`/groups/${group.id}/messages`,'POST',{body:'等待禁言',clientMutationId:'slow-mute'});await muted.started;
  await api(`/groups/${group.id}/members/${users.member.id}`,'PATCH',{muted:true});assert.equal((await muted.finish()).status,403);
  assert.equal((await api(`/groups/${group.id}/messages`)).body.items.length,0);
});

test('leave, transfer, dissolution and old invitation replay cannot revive revoked membership',async t=>{
  const {api,create,invite,users}=await fixture(t),group=await create('训练伙伴','owner',{clientMutationId:'lifecycle-create'}),invitation=await invite(group);
  assert.equal((await api(`/groups/${group.id}/leave`,'POST',{})).status,409);
  assert.equal((await api(`/groups/${group.id}/leave`,'POST',{},'member')).status,200);
  assert.equal((await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'member')).status,409);
  await invite(group);await api(`/groups/${group.id}/members/${users.member.id}`,'PATCH',{muted:true});assert.equal((await api(`/groups/${group.id}/transfer`,'POST',{userId:users.member.id})).body.group.role,'member');
  const successor=(await api(`/groups/${group.id}`,'GET',undefined,'member')).body.group;assert.equal(successor.role,'owner');assert.equal(successor.muted,false);assert.equal(successor.canSend,true);
  assert.equal((await api(`/groups/${group.id}`,'DELETE',{})).status,403);
  assert.equal((await api(`/groups/${group.id}`,'DELETE',{},'member')).status,200);
  assert.equal((await api(`/groups/${group.id}/messages`,'GET',undefined,'member')).status,404);
  assert.equal((await api('/groups/search?q='+group.groupNumber,'GET',undefined,'outsider')).body.items.length,0);
  assert.equal((await api('/groups','POST',{name:'训练伙伴',description:'互相鼓励',announcement:'成员公告',clientMutationId:'lifecycle-create'})).status,404,'An old creation receipt cannot recreate a dissolved group');
});

test('manager demotion and revoked invitations are rechecked during slow request bodies',async t=>{
  const {api,create,invite,beginJson,users}=await fixture(t),group=await create();await invite(group,'admin');await invite(group,'member');
  await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{role:'admin'});
  const update=beginJson(`/groups/${group.id}`,'PATCH',{announcement:'旧管理员迟到的修改'},'admin');await update.started;
  await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{role:'member'});assert.equal((await update.finish()).status,403);assert.equal((await api(`/groups/${group.id}`)).body.group.announcement,'成员公告');
  const invitation=(await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users.other.id]},'member')).body.items[0];
  const accepting=beginJson('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'other');await accepting.started;
  await api(`/groups/${group.id}/leave`,'POST',{},'member');assert.equal((await accepting.finish()).status,409);assert.equal((await api(`/groups/${group.id}`,'GET',undefined,'other')).status,404);
});

test('membership capacity and invitation batches are atomic',async t=>{
  const {api,create,db,users}=await fixture(t),group=await create();
  assert.equal((await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users.member.id,'no-such-user']})).status,404);assert.equal((await api('/groups/invitations','GET',undefined,'member')).body.items.length,0);
  for(let index=0;index<99;index++){const id=randomUUID();db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(id,'容量测试');db.prepare("INSERT INTO community_group_members(id,group_id,user_id,joined_at) VALUES(?,?,?,?)").run(randomUUID(),group.id,id,new Date().toISOString());}
  const invitation=(await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users.member.id]})).body.items[0];assert.equal((await api('/groups/invitations/'+invitation.id,'PATCH',{action:'accept'},'member')).status,409);
  const request=(await api(`/groups/${group.id}/join`,'POST',{},'other')).body.request;assert.equal((await api(`/groups/${group.id}/requests/${request.id}`,'PATCH',{action:'approve'})).status,409);
  assert.equal((await api(`/groups/${group.id}/requests`)).body.items[0].status,'pending');assert.equal((await api(`/groups/${group.id}/members?limit=50`)).body.items.length,50);
});

test('my groups, members, invitations and requests paginate and bind their scopes',async t=>{
  const {api,create,invite,users}=await fixture(t);const groups=[];for(let index=0;index<3;index++){groups.push(await create('群'+index));await invite(groups.at(-1));}
  const first=(await api('/groups?limit=2','GET',undefined,'member')).body;assert(first.hasMore);assert.equal(first.items.length,2);const rest=(await api('/groups?limit=2&cursor='+encodeURIComponent(first.nextCursor),'GET',undefined,'member')).body;assert.equal(rest.items.length,1);
  assert.equal(new Set([...first.items,...rest.items].map(row=>row.id)).size,3);assert.equal((await api('/groups?cursor='+encodeURIComponent(first.nextCursor),'GET',undefined,'other')).status,400);
  const members=(await api(`/groups/${groups[0].id}/members?limit=1`,'GET',undefined,'member')).body;assert(members.hasMore);assert.equal((await api(`/groups/${groups[1].id}/members?cursor=${encodeURIComponent(members.nextCursor)}`,'GET',undefined,'member')).status,400);
  const memberRest=(await api(`/groups/${groups[0].id}/members?cursor=${encodeURIComponent(members.nextCursor)}`,'GET',undefined,'member')).body;assert.equal(memberRest.items.length,1);assert.equal(new Set([...members.items,...memberRest.items].map(row=>row.id)).size,2);
  for(const group of groups)await api(`/groups/${group.id}/invitations`,'POST',{userIds:[users.other.id]});const invitations=(await api('/groups/invitations?limit=1','GET',undefined,'other')).body;assert(invitations.hasMore);assert.equal((await api('/groups/invitations?cursor='+encodeURIComponent(invitations.nextCursor),'GET',undefined,'outsider')).status,400);
});

test('account removal transfers ownership and deletes only that account messages, including sole-owner dissolution',async t=>{
  const {api,create,invite,message,users,db,groups,transactionFor}=await fixture(t),group=await create();await invite(group,'admin');await invite(group,'member');await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{role:'admin'});
  await api(`/groups/${group.id}/members/${users.admin.id}`,'PATCH',{muted:true});const own=await message(group),others=await message(group,'member','成员内容');assert.equal(groups.exportUser(users.owner.id).messages[0].id,own.id);
  transactionFor(users.owner,()=>{groups.deleteUserData(users.owner.id);db.prepare('DELETE FROM users WHERE id=?').run(users.owner.id);});
  const remaining=(await api(`/groups/${group.id}`,'GET',undefined,'admin')).body.group;assert.equal(remaining.ownerId,users.admin.id);assert.equal(remaining.role,'owner');assert.equal(remaining.muted,false);assert.equal(remaining.canSend,true);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM community_group_messages WHERE id=?').get(others.id).count,1);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM community_group_messages WHERE id=?').get(own.id).count,0);
  const sole=await create('仅剩群主','other');await invite(sole,'member','other');const retained=await message(sole,'member','退群者保留自己的历史');await api(`/groups/${sole.id}/leave`,'POST',{},'member');transactionFor(users.other,()=>{groups.deleteUserData(users.other.id);db.prepare('DELETE FROM users WHERE id=?').run(users.other.id);});
  assert.equal(db.prepare('SELECT status FROM community_groups WHERE id=?').get(sole.id).status,'dissolved');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM community_group_messages WHERE id=?').get(retained.id).count,1);assert(groups.exportUser(users.member.id).messages.some(row=>row.id===retained.id));
});
