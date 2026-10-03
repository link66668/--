import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityGroups } from '../public/community-groups.js';

const attrs = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));

function harness() {
  let user = { id: 'self' };
  const members = [
    { id: 'self', nickname: '群主', accountNumber: '1111111111', role: 'owner' },
    { id: 'first-member', nickname: '普通成员', accountNumber: '2222222222', role: 'member' },
    { id: 'target-member', nickname: 'Strength Runner', accountNumber: '3333333333', role: 'member' },
    { id: 'other-member', nickname: '晚些搜索的人', accountNumber: '4444444444', role: 'member' }
  ];
  const writes = [], events = [], errors = [];
  const owner = {
    accountId: 'self', alive: () => true, getUser: () => user, error: error => errors.push(error), toast() {},
    api: {
      async get(path) {
        if (path.endsWith('/members')) return { items: structuredClone(members), hasMore: false, nextCursor: null };
        if (path.endsWith('/requests')) return { items: [], hasMore: false, nextCursor: null };
        const id = path.split('/').at(-1);
        return { group: { id, name: '测试群', groupNumber: '12345678', description: '', announcement: '', role: 'owner', canManage: true, memberCount: members.length } };
      },
      write(path, method, body) {
        let resolve;
        const result = new Promise(done => { resolve = done; });
        writes.push({ path, method, body, reply: () => { Object.assign(members.find(member => path.endsWith('/' + member.id)) || {}, body); resolve({ ok: true }); } });
        return result;
      }
    },
    closeAux() {
      const dialog = this.aux;
      if (!dialog) return;
      this.aux = null; dialog.isConnected = false; events.push(['close']);
      for (const listener of dialog.closeListeners) listener();
    },
    navigate(hash) { events.push(['navigate', hash]); },
    showAux() {
      this.closeAux();
      const dialog = { isConnected: true, closeListeners: [],
        addEventListener(type, listener) { assert.equal(type, 'close'); this.closeListeners.push(listener); } };
      const content = { generation: 0, nodes: new Map(), _html: '' };
      function node(extra = {}) {
        const generation = content.generation;
        return { dialog, generation, dataset: {}, hidden: false, disabled: false, textContent: '',
          get isConnected() { return dialog.isConnected && generation === content.generation; }, ...extra };
      }
      Object.defineProperty(content, 'innerHTML', {
        get() { return this._html; },
        set(markup) {
          this._html = markup; this.generation++; this.nodes = new Map();
          if (!markup.includes('data-cm-form="group-member-search"')) return;
          const form = node({ dataset: { cmForm: 'group-member-search' }, elements: {} });
          const inputAttrs = attrs(/<input\b[^>]*\bname="q"[^>]*>/.exec(markup)[0]);
          const input = node({ name: 'q', value: inputAttrs.value, selectionStart: 0, selectionEnd: 0,
            closest: () => form, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
          form.elements.q = input;
          const list = node({ actions: [], _html: '' });
          Object.defineProperty(list, 'innerHTML', {
            get() { return this._html; },
            set(html) {
              this._html = html;
              this.actions = [...html.matchAll(/<(?:button|a)\b[^>]*\bdata-cm="[^>]*>/g)].map(([tag]) => {
                const attributes = attrs(tag);
                return node({ dataset: Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value])) });
              });
            }
          });
          this.nodes.set('[data-cm-form="group-member-search"]', form);
          this.nodes.set('.cm-group-member-search-input', input);
          this.nodes.set('.cm-group-member-list', list);
          this.nodes.set('.cm-group-member-match-status', node());
          this.nodes.set('[data-cm="group-member-search-clear"]', node({ dataset: { cm: 'group-member-search-clear' } }));
        }
      });
      dialog.content = content;
      dialog.querySelector = selector => selector === '.cm-group-info-content' ? content : content.nodes.get(selector) || null;
      dialog.contains = element => element?.dialog === dialog && element.isConnected;
      this.aux = dialog;
      return dialog;
    }
  };
  const groups = new CommunityGroups(owner);
  async function open(id = 'group-a') { await groups.showInfo(id, 'members'); return groups.auxContext; }
  const click = element => groups.click(element.dataset.cm, element, { preventDefault() {}, stopPropagation() {} });
  const action = (context, kind, id) => {
    const element = context.dialog.querySelector('.cm-group-member-list').actions.find(row => row.dataset.cm === kind && row.dataset.id === id);
    assert.ok(element, `Missing visible ${kind} for ${id}`);
    return element;
  };
  function search(context, value) {
    const input = context.dialog.querySelector('.cm-group-member-search-input');
    input.value = value; groups.input(input); return input;
  }
  return { groups, owner, writes, events, errors, open, click, action, search, switchAccount: () => { user = { id: 'other-account' }; } };
}

test('filtered member management writes the displayed real ID and refreshes with a query edited while the write is pending', async () => {
  for (const [kind, expectedBody] of [['group-member-role', { role: 'admin' }], ['group-member-mute', { muted: true }]]) {
    const h = harness(), context = await h.open();
    const input = h.search(context, 'strength');
    input.selectionStart = 3; input.selectionEnd = 3;
    assert.deepEqual(h.groups.filteredMembers(context).map(row => row.id), ['target-member']);
    const writing = h.click(h.action(context, kind, 'target-member'));
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].path, '/groups/group-a/members/target-member');
    assert.equal(h.writes[0].method, 'PATCH'); assert.deepEqual(h.writes[0].body, expectedBody);
    h.search(context, '晚些');
    assert.equal(context.dialog.querySelector('.cm-group-member-search-input'), input);
    assert.equal(input.selectionStart, 3);
    h.writes[0].reply(); await writing;
    const refreshed = h.groups.auxContext;
    assert.notEqual(refreshed, context);
    assert.equal(refreshed.memberQuery, '晚些');
    assert.equal(refreshed.dialog.querySelector('.cm-group-member-search-input').value, '晚些');
    assert.deepEqual(h.groups.filteredMembers(refreshed).map(row => row.id), ['other-member']);
    assert.deepEqual(h.errors, []);
  }
});

test('member search survives tab changes and reopening, while clearing affects only that group query', async () => {
  const h = harness(), context = await h.open();
  h.groups.current = { id: 'group-a', draftBody: '保留群消息输入', mentions: [], outbox: [] };
  h.search(context, '3333');
  assert.deepEqual(h.groups.filteredMembers(context).map(row => row.id), ['target-member']);
  await h.groups.click('group-info-tab', { dataset: { tab: 'about' } });
  await h.groups.click('group-info-tab', { dataset: { tab: 'members' } });
  assert.equal(context.dialog.querySelector('.cm-group-member-search-input').value, '3333');
  const reopened = await h.open();
  assert.equal(reopened.memberQuery, '3333');
  const other = await h.open('group-b');
  assert.equal(other.memberQuery, '');
  const restored = await h.open('group-a');
  const input = restored.dialog.querySelector('.cm-group-member-search-input');
  await h.click(restored.dialog.querySelector('[data-cm="group-member-search-clear"]'));
  assert.equal(restored.memberQuery, ''); assert.equal(h.groups.memberQueries.get('group-a'), '');
  assert.equal(input.value, ''); assert.equal(input.focused, true);
  assert.equal(h.groups.filteredMembers(restored).length, 4);
  assert.equal(h.groups.current.draftBody, '保留群消息输入');
  const unrelatedForm = { dataset: { cmForm: 'group-invite-search' } };
  h.groups.input({ name: 'q', value: '仅邀请搜索词', closest: () => unrelatedForm });
  assert.equal(restored.memberQuery, ''); assert.equal(h.groups.current.draftBody, '保留群消息输入');
});

test('member avatars close the active dialog before navigating and reject old dialogs, invalid members and account changes', async () => {
  const h = harness(), first = await h.open(), staleAvatar = h.action(first, 'group-member-profile', 'target-member');
  const current = await h.open(); h.events.length = 0;
  await h.click(staleAvatar);
  assert.deepEqual(h.events, []); assert.equal(h.owner.aux, current.dialog);
  const foreign = { dialog: current.dialog, isConnected: true, dataset: { cm: 'group-member-profile', id: 'not-a-member' } };
  await h.click(foreign); assert.deepEqual(h.events, []);
  await h.click(h.action(current, 'group-member-profile', 'target-member'));
  assert.deepEqual(h.events, [['close'], ['navigate', '#community/user/target-member']]);
  const own = await h.open(); h.events.length = 0;
  await h.click(h.action(own, 'group-member-profile', 'self'));
  assert.deepEqual(h.events, [['close'], ['navigate', '#community/user/self']]);
  const switched = await h.open(); h.events.length = 0; h.switchAccount();
  await h.click(h.action(switched, 'group-member-profile', 'target-member'));
  assert.deepEqual(h.events, []); assert.equal(h.owner.aux, switched.dialog);
});
