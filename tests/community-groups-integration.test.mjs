import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fitness-group-integration-'));
  const server = createServer({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  async function api(client, path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { ...(client ? { Cookie: client.cookie, 'X-Fitness-User': client.id } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(name) {
    const { value, cookie } = await api(null, '/auth/register', 'POST', {
      name, email: `${name}@group-integration.example.test`, password: 'isolated-group-test-password'
    });
    return { id: value.user.id, cookie };
  }
  const alice = await register('alice'), bob = await register('bob'), outsider = await register('outsider');
  const community = async (client, path, method, body) => (await api(client, '/community' + path, method, body)).value;
  return { api, community, alice, bob, outsider };
}

test('private and group messages contribute to one toolbar unread count without clearing each other', async t => {
  const { community, alice, bob } = await fixture(t);
  const { group } = await community(alice, '/groups', 'POST', {
    name: 'Unread integration', clientMutationId: crypto.randomUUID()
  });
  await community(alice, `/groups/${group.id}/invitations`, 'POST', { userIds: [bob.id] });
  const invitations = await community(bob, '/groups/invitations');
  const invitation = invitations.items.find(row => row.group.id === group.id);
  assert(invitation);
  await community(bob, `/groups/invitations/${invitation.id}`, 'PATCH', { action: 'accept' });
  const { conversation } = await community(alice, '/messages/conversations', 'POST', { userId: bob.id });
  const privateMessage = (await community(alice, `/messages/conversations/${conversation.id}/messages`, 'POST', {
    body: 'Private unread', clientMutationId: crypto.randomUUID()
  })).message;
  const groupMessage = (await community(alice, `/groups/${group.id}/messages`, 'POST', {
    body: '@bob Group unread', mentionUserIds: [bob.id], mentionAll: false, clientMutationId: crypto.randomUUID()
  })).message;
  assert.equal((await community(bob, '/messages/unread')).unreadCount, 2);
  const conversations = await community(bob, '/messages/conversations');
  assert.equal(conversations.unreadCount, 2);
  assert.equal(conversations.items[0].unreadCount, 1);
  const groupUnread = await community(bob, '/groups/unread');
  assert.equal(groupUnread.unreadCount, 1);
  assert.equal(groupUnread.mentionUnreadCount, 1);
  const privateRead = await community(bob, `/messages/conversations/${conversation.id}/read`, 'PUT', {
    lastMessageId: privateMessage.id
  });
  assert.equal(privateRead.unreadCount, 1);
  assert.equal(privateRead.conversationUnreadCount, 0);
  assert.equal((await community(bob, '/groups/unread')).mentionUnreadCount, 1);
  await community(bob, `/groups/${group.id}/messages`);
  await community(bob, `/groups/${group.id}/read`, 'PUT', { lastMessageId: groupMessage.id });
  assert.equal((await community(bob, '/messages/unread')).unreadCount, 0);
  assert.equal((await community(bob, '/groups/unread')).mentionUnreadCount, 0);
  const groups = await community(bob, '/groups');
  assert.equal(groups.items.find(row => row.id === group.id).unreadCount, 0);
});

test('group mentions never notify a non-member, and removing a member removes their unread contribution', async t => {
  const { community, alice, bob, outsider } = await fixture(t);
  const { group } = await community(alice, '/groups', 'POST', {
    name: 'Membership integration', clientMutationId: crypto.randomUUID()
  });
  await community(alice, `/groups/${group.id}/invitations`, 'POST', { userIds: [bob.id] });
  const invitations = await community(bob, '/groups/invitations');
  await community(bob, `/groups/invitations/${invitations.items[0].id}`, 'PATCH', { action: 'accept' });
  await community(alice, `/groups/${group.id}/messages`, 'POST', {
    body: '@全体成员 Membership notice', mentionAll: true, clientMutationId: crypto.randomUUID()
  });
  assert.equal((await community(bob, '/messages/unread')).unreadCount, 1);
  assert.equal((await community(bob, '/groups/unread')).mentionUnreadCount, 1);
  assert.equal((await community(outsider, '/messages/unread')).unreadCount, 0);
  assert.equal((await community(outsider, '/groups/unread')).mentionUnreadCount, 0);
  await community(alice, `/groups/${group.id}/members/${bob.id}`, 'DELETE', {});
  assert.equal((await community(bob, '/messages/unread')).unreadCount, 0);
  assert.equal((await community(bob, '/groups/unread')).mentionUnreadCount, 0);
  assert.equal((await community(bob, '/groups')).items.some(row => row.id === group.id), false);
});
