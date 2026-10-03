import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityGroups } from '../public/community-groups.js';

const person = id => ({ id, nickname: '用户 ' + id, accountNumber: '1234567890', avatarUrl: null });
const page = (items, nextCursor = null) => ({ items, nextCursor, hasMore: Boolean(nextCursor) });

function harness() {
  let user = { id: 'self' }, closeCount = 0;
  const requests = [], notices = [], errors = [];
  function request(method, path, data) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = { method, path, data, settled: false,
      reply(value) { this.settled = true; resolve(value); },
      fail(error) { this.settled = true; reject(error); } };
    requests.push(pending);
    return promise;
  }
  function node(dialog, extra = {}) {
    return { innerHTML: '', hidden: false, disabled: false, dataset: {}, textContent: '', attributes: {},
      get isConnected() { return dialog.isConnected; },
      setAttribute(key, value) { this.attributes[key] = value; }, ...extra };
  }
  const owner = {
    accountId: 'self', alive: () => true, getUser: () => user,
    toast: (...args) => notices.push(args), error: error => errors.push(error),
    api: { get: (path, params) => request('GET', path, params), write: (path, method, body) => request(method, path, body) },
    closeAux() {
      const dialog = this.aux;
      if (!dialog) return;
      this.aux = null; dialog.isConnected = false; closeCount++;
      for (const listener of dialog.listeners.close || []) listener();
    },
    showAux(title, html, extra) {
      this.closeAux();
      const dialog = { title, html, extra, isConnected: true, listeners: {},
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); } };
      const form = node(dialog, { dataset: { cmForm: 'group-invite-search' }, elements: {} });
      form.elements.q = node(dialog, { name: 'q', value: '', closest: () => form });
      const send = node(dialog, { dataset: { cm: 'group-invite-send' }, disabled: true });
      const tabs = ['search', 'fans'].map(source => node(dialog, { dataset: { source } }));
      const nodes = new Map([
        ['[data-cm-form="group-invite-search"]', form], ['[data-cm="group-invite-send"]', send],
        ...['fans-help', 'member-status', 'selected', 'results', 'page-status'].map(suffix => ['.cm-group-invite-' + suffix, node(dialog)])
      ]);
      dialog.form = form; dialog.send = send; dialog.tabs = tabs; dialog.nodes = nodes;
      dialog.querySelector = selector => { assert.ok(nodes.has(selector), 'Unexpected selector: ' + selector); return nodes.get(selector); };
      dialog.querySelectorAll = selector => { assert.equal(selector, '[data-cm="group-invite-source"]'); return tabs; };
      this.aux = dialog;
      return dialog;
    }
  };
  const groups = new CommunityGroups(owner);
  const next = (method, path) => {
    const pending = [...requests].reverse().find(row => !row.settled && row.method === method && row.path === path);
    assert.ok(pending, `Missing request ${method} ${path}`);
    return pending;
  };
  const click = (action, data = {}) => {
    const element = action === 'group-invite-send' ? owner.aux.send : node(owner.aux, { dataset: data });
    return groups.click(action, element, { preventDefault() {}, stopPropagation() {} });
  };
  const beginSearch = (context, value) => {
    context.dialog.form.elements.q.value = value;
    const done = groups.searchInvite(context.dialog.form);
    return { done, pending: requests.at(-1) };
  };
  async function open(id = 'group-a', members = [person('self'), person('member')]) {
    const opening = groups.showInvite(id), context = groups.auxContext;
    next('GET', `/groups/${id}/members`).reply(page(members));
    await opening;
    return context;
  }
  async function fans(context, rows, cursor = null) {
    const loading = click('group-invite-source', { source: 'fans' });
    next('GET', '/me/followers').reply(page(rows, cursor));
    await loading;
  }
  return { groups, owner, requests, notices, errors, next, click, beginSearch, open, fans,
    closeCount: () => closeCount, switchAccount: () => { user = { id: 'other-account' }; } };
}

test('invite selection survives switching between searched users and cached followers and sends both sources', async () => {
  const h = harness(), context = await h.open();
  const search = h.beginSearch(context, '搜索朋友');
  search.pending.reply(page([person('searched'), person('member')])); await search.done;
  await h.click('group-invite-pick', { id: 'searched' });
  await h.click('group-invite-pick', { id: 'member' });
  assert.deepEqual([...context.selected.keys()], ['searched']);
  await h.fans(context, [person('fan'), person('searched')]);
  await h.click('group-invite-pick', { id: 'fan' });
  const requestCount = h.requests.length;
  await h.click('group-invite-source', { source: 'search' });
  await h.click('group-invite-source', { source: 'fans' });
  assert.equal(h.requests.length, requestCount);
  assert.deepEqual([...context.selected.keys()], ['searched', 'fan']);
  assert.equal(context.dialog.form.hidden, true);
  assert.equal(context.dialog.send.disabled, false);
  const sending = h.click('group-invite-send');
  const sent = h.next('POST', '/groups/group-a/invitations');
  assert.deepEqual(sent.data, { userIds: ['searched', 'fan'] });
  assert.equal(context.dialog.send.disabled, true);
  await h.click('group-invite-remove', { id: 'fan' });
  assert.equal(context.selected.size, 2);
  sent.reply({ items: [] }); await sending;
  assert.equal(h.owner.aux, null);
});

test('pending or failed member loading blocks candidate selection and recovers through the member retry action', async () => {
  const h = harness(), opening = h.groups.showInvite('group-a'), context = h.groups.auxContext;
  const search = h.beginSearch(context, '待邀请'); search.pending.reply(page([person('fan'), person('member')])); await search.done;
  assert.equal(context.dialog.send.disabled, true);
  await h.click('group-invite-pick', { id: 'fan' }); assert.equal(context.selected.size, 0);
  h.next('GET', '/groups/group-a/members').fail(new Error('成员暂时无法加载')); await opening;
  assert.equal(context.membersLoaded, false);
  assert.equal(context.dialog.send.disabled, true);
  await h.click('group-invite-pick', { id: 'fan' }); assert.equal(context.selected.size, 0);
  await h.click('group-invite-send'); assert.equal(h.requests.some(row => row.method === 'POST'), false);
  const retry = h.click('group-invite-members-retry');
  h.next('GET', '/groups/group-a/members').reply(page([person('self'), person('member')])); await retry;
  assert.equal(context.membersLoaded, true); assert.equal(context.memberError, null);
  await h.click('group-invite-pick', { id: 'member' }); assert.equal(context.selected.size, 0);
  await h.click('group-invite-pick', { id: 'fan' }); assert.deepEqual([...context.selected.keys()], ['fan']);
  assert.equal(context.dialog.send.disabled, false);
});

test('refreshing the member list disables sending and removes recipients who have since joined', async () => {
  const h = harness(), context = await h.open();
  const search = h.beginSearch(context, '朋友'); search.pending.reply(page([person('new-member')])); await search.done;
  await h.click('group-invite-pick', { id: 'new-member' });
  const loading = h.groups.loadInviteMembers(context);
  assert.equal(context.dialog.send.disabled, true);
  await h.click('group-invite-send'); assert.equal(h.requests.some(row => row.method === 'POST'), false);
  h.next('GET', '/groups/group-a/members').reply(page([person('self'), person('new-member')])); await loading;
  assert.equal(context.selected.size, 0);
  assert.equal(context.dialog.send.disabled, true);
});

test('follower pagination deduplicates identities, keeps selections, and does not request one page twice concurrently', async () => {
  const h = harness(), context = await h.open();
  await h.fans(context, [person('fan-a')], 'page-2');
  await h.click('group-invite-pick', { id: 'fan-a' });
  const loading = h.click('group-invite-fans-more'), second = h.next('GET', '/me/followers');
  assert.equal(second.data.cursor, 'page-2');
  const count = h.requests.length; await h.click('group-invite-fans-more'); assert.equal(h.requests.length, count);
  second.reply(page([{ ...person('fan-a'), nickname: '粉丝新昵称' }, person('fan-b')])); await loading;
  assert.deepEqual(context.fans.items.map(row => row.id), ['fan-a', 'fan-b']);
  assert.equal(context.fans.items[0].nickname, '粉丝新昵称');
  assert.deepEqual([...context.selected.keys()], ['fan-a']);
  await h.click('group-invite-pick', { id: 'fan-b' });
  assert.deepEqual([...context.selected.keys()], ['fan-a', 'fan-b']);
  await h.click('group-invite-fans-more'); assert.equal(h.requests.length, count);
});

test('initial and later follower failures retry the same position without losing previously selected people', async () => {
  const h = harness(), context = await h.open();
  const first = h.click('group-invite-source', { source: 'fans' });
  h.next('GET', '/me/followers').fail(new Error('粉丝网络失败')); await first;
  assert.equal(context.fans.loaded, false); assert.equal(context.fans.loading, false);
  const retry = h.click('group-invite-fans-retry'), request = h.next('GET', '/me/followers');
  assert.equal(request.data.cursor, undefined); request.reply(page([person('fan-a')], 'page-2')); await retry;
  await h.click('group-invite-pick', { id: 'fan-a' });
  const later = h.click('group-invite-fans-more'); h.next('GET', '/me/followers').fail(new Error('下一页失败')); await later;
  assert.deepEqual(context.fans.items.map(row => row.id), ['fan-a']);
  assert.deepEqual([...context.selected.keys()], ['fan-a']);
  const nextRetry = h.click('group-invite-fans-retry'), nextRequest = h.next('GET', '/me/followers');
  assert.equal(nextRequest.data.cursor, 'page-2'); nextRequest.reply(page([person('fan-b')])); await nextRetry;
  assert.deepEqual(context.fans.items.map(row => row.id), ['fan-a', 'fan-b']);
  assert.equal(context.fans.error, null);
});

test('an expired follower cursor restarts the list but preserves selected people from the former snapshot', async () => {
  const h = harness(), context = await h.open();
  await h.fans(context, [person('previous-fan')], 'expired-page');
  await h.click('group-invite-pick', { id: 'previous-fan' });
  const loading = h.click('group-invite-fans-more');
  h.next('GET', '/me/followers').fail(Object.assign(new Error('列表已过期'), { status: 409 })); await loading;
  const retry = h.click('group-invite-fans-retry'), restarted = h.next('GET', '/me/followers');
  assert.equal(restarted.data.cursor, undefined); restarted.reply(page([person('current-fan')])); await retry;
  assert.deepEqual(context.fans.items.map(row => row.id), ['current-fan']);
  assert.deepEqual([...context.selected.keys()], ['previous-fan']);
  await h.click('group-invite-remove', { id: 'previous-fan' }); assert.equal(context.selected.size, 0);
});

test('closing and reopening invitation dialogs isolates late member and follower responses from the new selection', async () => {
  const h = harness(), opening = h.groups.showInvite('old-group'), old = h.groups.auxContext;
  const oldMembers = h.next('GET', '/groups/old-group/members');
  const oldFansLoading = h.click('group-invite-source', { source: 'fans' }), oldFans = h.next('GET', '/me/followers');
  h.owner.closeAux(); const current = await h.open('new-group');
  await h.fans(current, [person('new-fan')]); await h.click('group-invite-pick', { id: 'new-fan' });
  oldMembers.reply(page([person('new-fan')])); oldFans.reply(page([person('old-fan')])); await Promise.all([opening, oldFansLoading]);
  assert.equal(h.groups.auxContext, current); assert.equal(h.owner.aux, current.dialog);
  assert.deepEqual(current.fans.items.map(row => row.id), ['new-fan']);
  assert.deepEqual([...current.selected.keys()], ['new-fan']);
  assert.equal(current.users.has('old-fan'), false); assert.equal(old.membersLoaded, false);
});

test('an account switch makes pending invitation member, follower and search responses inert', async () => {
  const h = harness(), opening = h.groups.showInvite('group-a'), context = h.groups.auxContext;
  const members = h.next('GET', '/groups/group-a/members');
  const loadingFans = h.click('group-invite-source', { source: 'fans' }), fans = h.next('GET', '/me/followers');
  const search = h.beginSearch(context, '旧账号搜索');
  const before = context.dialog.nodes.get('.cm-group-invite-results').innerHTML;
  h.switchAccount(); members.reply(page([person('old-member')])); fans.reply(page([person('old-fan')])); search.pending.reply(page([person('old-search')]));
  await Promise.all([opening, loadingFans, search.done]);
  assert.equal(context.membersLoaded, false); assert.deepEqual(context.fans.items, []); assert.deepEqual(context.search.items, []);
  assert.equal(context.users.size, 0); assert.equal(context.dialog.nodes.get('.cm-group-invite-results').innerHTML, before);
  assert.deepEqual(h.notices, []); assert.deepEqual(h.errors, []);
});

test('search response ordering and input edits cannot revive results or errors from an older query', async () => {
  for (const staleFailure of [false, true]) {
    const h = harness(), context = await h.open();
    const old = h.beginSearch(context, '旧关键词'), current = h.beginSearch(context, '新关键词');
    current.pending.reply(page([person('new-search')])); await current.done;
    if (staleFailure) old.pending.fail(new Error('旧搜索失败')); else old.pending.reply(page([person('old-search')]));
    await old.done;
    assert.deepEqual(context.search.items.map(row => row.id), ['new-search']);
    assert.equal(context.search.error, null); assert.equal(context.users.has('old-search'), false);
    const edited = h.beginSearch(context, '发送时关键词');
    const input = context.dialog.form.elements.q; input.value = ''; h.groups.input(input);
    edited.pending.reply(page([person('edited-old-search')])); await edited.done;
    assert.deepEqual(context.search.items, []); assert.equal(context.search.loading, false);
    assert.equal(context.users.has('edited-old-search'), false);
  }
});

test('late invitation success leaves a reopened dialog intact and account-switch success cannot show an old toast', async () => {
  for (const changedAccount of [false, true]) {
    const h = harness(), old = await h.open();
    await h.fans(old, [person('old-fan')]); await h.click('group-invite-pick', { id: 'old-fan' });
    const sending = h.click('group-invite-send'), request = h.next('POST', '/groups/group-a/invitations');
    h.owner.closeAux(); const current = await h.open('new-group');
    await h.fans(current, [person('new-fan')]); await h.click('group-invite-pick', { id: 'new-fan' });
    if (changedAccount) h.switchAccount();
    const closed = h.closeCount(); request.reply({ items: [] }); await sending;
    assert.equal(h.owner.aux, current.dialog); assert.equal(h.closeCount(), closed);
    assert.deepEqual([...current.selected.keys()], ['new-fan']);
    assert.equal(current.dialog.send.disabled, false);
    assert.equal(h.notices.length, changedAccount ? 0 : 1);
  }
});
