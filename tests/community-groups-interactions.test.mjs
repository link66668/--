import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityGroups } from '../public/community-groups.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function globals(t) {
  for (const [key, value] of Object.entries({ document: { hidden: false }, CSS: { escape: String } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}
function fixture() {
  const writes = [], unavailable = [], owner = {
    accountId: 'reader', routeToken: 1, alive: () => true, isMounted: () => true,
    getUser: () => ({ id: 'reader' }), readLocal: () => ({}), saveLocal() {},
    refreshMessageUnread: async () => {}, api: { get: async () => ({}), write: async (path, method, body) => { writes.push({ path, method, body }); return { groupUnreadCount: 0, groupMentionUnreadCount: 0 }; } }
  };
  const groups = new CommunityGroups(owner);
  groups.layout = { isConnected: true }; groups.token = 1;
  const state = groups.state('group-a'); state.renderedEpoch = groups.epoch; state.group = { id: state.id, role: 'member', canSend: true }; state.initialLoaded = true; state.fetchAfter = 'known-message'; groups.current = state;
  groups.list = { items: [{ id: state.id, unreadCount: 2, mentionUnreadCount: 1 }] };
  groups.renderList = () => {}; groups.loadList = async () => {}; groups.updateChat = () => {}; groups.unread = async () => ({});
  groups.unavailable = (value, message) => { value.unavailable = true; unavailable.push({ id: value.id, message }); };
  const list = { getBoundingClientRect: () => ({ top: 0, bottom: 300 }), querySelector: () => ({ getBoundingClientRect: () => ({ top: 30, bottom: 60 }) }) };
  owner.page = () => ({ querySelector: () => list });
  return { groups, owner, state, writes, unavailable };
}

test('the final visible own message does not stop reading earlier received mention messages', async t => {
  globals(t); const { groups, state, writes } = fixture();
  state.items = [{ id: 'received', senderId: 'peer', sequence: 1, mentionedMe: true }, { id: 'own-last', senderId: 'reader', sequence: 2 }];
  await groups.markRead(state);
  assert.deepEqual(writes, [{ path: '/groups/group-a/read', method: 'PUT', body: { lastMessageId: 'received' } }]);
  assert.equal(state.readId, 'received'); assert.equal(groups.list.items[0].unreadCount, 0); assert.equal(groups.list.items[0].mentionUnreadCount, 0);
  state.items = [{ id: 'another-own', senderId: 'reader', sequence: 3 }];
  await groups.markRead(state); assert.equal(writes.length, 1, 'A chat with only own messages never submits an invalid read marker');
});

test('a delayed forbidden response from group A cannot disable the newly opened group B', async t => {
  globals(t); const { groups, owner, state, unavailable } = fixture(), response = deferred(), started = deferred();
  groups.refreshGroup = async () => {};
  owner.api.get = (path) => { assert.equal(path, '/groups/group-a/messages'); started.resolve(); return response.promise; };
  const polling = groups.poll(); await started.promise;
  const next = groups.state('group-b'); next.group = { id: next.id, canSend: true }; next.initialLoaded = true;
  groups.current = next; groups.epoch++; owner.routeToken++; groups.token = owner.routeToken;
  next.renderedEpoch = groups.epoch;
  response.reject(Object.assign(new Error('No longer in group A'), { status: 403 })); await polling;
  assert.equal(next.unavailable, undefined); assert.equal(state.unavailable, undefined); assert.deepEqual(unavailable, []);
});

test('an old forbidden metadata response cannot replace a newer successful role refresh', async t => {
  globals(t); const { groups, owner, state, unavailable } = fixture(), old = deferred(); let requests = 0;
  owner.api.get = () => ++requests === 1 ? old.promise : Promise.resolve({ group: { id: state.id, role: 'admin', canSend: true } });
  const earlier = groups.refreshGroup(state); await groups.refreshGroup(state);
  old.reject(Object.assign(new Error('Stale forbidden response'), { status: 403 })); await earlier;
  assert.equal(state.group.role, 'admin'); assert.equal(state.unavailable, false); assert.deepEqual(unavailable, []);
});

test('a current forbidden response still disables the matching group', async t => {
  globals(t); const { groups, owner, state, unavailable } = fixture();
  owner.api.get = async () => { throw Object.assign(new Error('Membership revoked'), { status: 404 }); };
  await groups.refreshGroup(state);
  assert.equal(state.unavailable, true); assert.equal(unavailable.length, 1); assert.equal(unavailable[0].id, state.id);
});
