import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.mjs';

const password = 'isolated-config-version-password';
const provider = (id, name = id) => ({ id, name, presetId: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: `synthetic-${id}-key`, model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-b' }] });
const configuration = () => ({ providers: [provider('first'), provider('second')], tasks: { chat: 'first', meal: 'first', planning: 'second' }, taskModels: { chat: 'model-a', meal: 'model-a', planning: 'model-b' } });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fitness-config-version-'));
  let server, base;
  async function start() {
    server = createServer({ dataDir: directory, communityModeratorIds: [], communityModeratorEmails: [], fetchImpl: async () => { throw new Error('Configuration tests must not call an upstream'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function api(client, path, method = 'GET', body, extraHeaders = {}) {
    const response = await fetch(base + path, { method, headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(client.id ? { 'X-Fitness-User': client.id } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  async function register(email) {
    const client = { cookie: '' };
    const registered = await api(client, '/api/auth/register', 'POST', { email, name: 'Configuration fixture', password });
    assert.equal(registered.status, 201); client.id = registered.body.user.id; client.email = email;
    return client;
  }
  async function deviceFor(client) {
    const device = { cookie: '' };
    const loggedIn = await api(device, '/api/auth/login', 'POST', { email: client.email, password });
    assert.equal(loggedIn.status, 200); device.id = loggedIn.body.user.id;
    return device;
  }
  return { directory, api, register, deviceFor, stop, start };
}

test('initial compatibility save is allowed once, while missing, stale and invalid revisions never overwrite settings', async t => {
  const { api, register } = await fixture(t), alice = await register('initial-config@example.test');
  assert.equal((await api(alice, '/api/providers')).body.version, 0);
  const saved = await api(alice, '/api/providers', 'PUT', configuration());
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 1);
  const baseline = (await api(alice, '/api/providers')).body;
  assert(!JSON.stringify(baseline).includes('synthetic-first-key'));
  for (const rejected of [configuration(), { ...configuration(), version: 0 }]) {
    rejected.providers[0].name = 'Must not overwrite';
    const response = await api(alice, '/api/providers', 'PUT', rejected);
    assert.equal(response.status, 409); assert.match(response.body.error, /重新加载/);
    assert.deepEqual((await api(alice, '/api/providers')).body, baseline);
  }
  for (const version of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await api(alice, '/api/providers', 'PUT', { ...configuration(), version })).status, 400);
    assert.deepEqual((await api(alice, '/api/providers')).body, baseline);
  }
  const invalidModel = structuredClone(baseline); invalidModel.taskModels.meal = 'unavailable';
  assert.equal((await api(alice, '/api/providers', 'PUT', invalidModel)).status, 400);
  assert.deepEqual((await api(alice, '/api/providers')).body, baseline);
  const cleared = await api(alice, '/api/providers', 'PUT', { providers: [], version: baseline.version });
  assert.equal(cleared.status, 200); assert.equal(cleared.body.version, 2); assert.deepEqual(cleared.body.providers, []);
  assert.equal((await api(alice, '/api/providers', 'PUT', configuration())).status, 409);
  assert.equal((await api(alice, '/api/providers', 'PUT', { ...configuration(), version: 0 })).status, 409);
  const reconfigured = await api(alice, '/api/providers', 'PUT', { ...configuration(), version: 2 });
  assert.equal(reconfigured.status, 200); assert.equal(reconfigured.body.version, 3);
});

test('two real HTTP sessions editing different providers from the same snapshot cannot silently lose the first save', async t => {
  const { api, register, deviceFor } = await fixture(t), alice = await register('two-devices-config@example.test'), secondDevice = await deviceFor(alice);
  assert.equal((await api(alice, '/api/providers', 'PUT', { ...configuration(), version: 0 })).status, 200);
  const first = (await api(alice, '/api/providers')).body, second = (await api(secondDevice, '/api/providers')).body;
  first.providers[0].name = 'Saved on device A'; second.providers[1].name = 'Unsaved on device B';
  const saved = await api(alice, '/api/providers', 'PUT', first);
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 2);
  const stale = await api(secondDevice, '/api/providers', 'PUT', second);
  assert.equal(stale.status, 409);
  const actual = (await api(secondDevice, '/api/providers')).body;
  assert.deepEqual(actual, saved.body); assert.equal(actual.providers[0].name, 'Saved on device A'); assert.equal(actual.providers[1].name, 'second');
  assert(actual.providers.every(item => item.hasKey));
  actual.providers[1].name = 'Saved after loading latest';
  const refreshed = await api(secondDevice, '/api/providers', 'PUT', actual);
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.version, 3); assert.equal(refreshed.body.providers[0].name, 'Saved on device A');
});

test('simultaneous saves admit exactly one complete settings snapshot and increment its version once', async t => {
  const { api, register, deviceFor } = await fixture(t), alice = await register('simultaneous-config@example.test'), secondDevice = await deviceFor(alice);
  await api(alice, '/api/providers', 'PUT', configuration());
  const first = (await api(alice, '/api/providers')).body, second = (await api(secondDevice, '/api/providers')).body;
  first.providers[0].name = 'Device A'; first.taskModels.chat = 'model-b';
  second.providers[1].name = 'Device B'; second.taskModels.meal = 'model-b';
  const results = await Promise.all([api(alice, '/api/providers', 'PUT', first), api(secondDevice, '/api/providers', 'PUT', second)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const winner = results.find(item => item.status === 200).body, actual = (await api(alice, '/api/providers')).body;
  assert.equal(actual.version, 2); assert.deepEqual(actual, winner);
  const expected = results[0].status === 200 ? first : second;
  assert.deepEqual(actual.providers.map(item => item.name), expected.providers.map(item => item.name));
  assert.deepEqual(actual.taskModels, expected.taskModels);
});

test('task-model updates share the providers revision and stale edits cannot undo task selection or remove new providers', async t => {
  const { api, register, deviceFor } = await fixture(t), alice = await register('task-config@example.test'), secondDevice = await deviceFor(alice);
  await api(alice, '/api/providers', 'PUT', configuration());
  const taskEdit = (await api(alice, '/api/providers')).body, oldProviderEdit = (await api(secondDevice, '/api/providers')).body;
  taskEdit.tasks.meal = 'second'; taskEdit.taskModels.meal = 'model-b'; taskEdit.providers.push(provider('added'));
  assert.equal((await api(alice, '/api/providers', 'PUT', taskEdit)).status, 200);
  oldProviderEdit.providers[0].name = 'Stale provider name';
  assert.equal((await api(secondDevice, '/api/providers', 'PUT', oldProviderEdit)).status, 409);
  const actual = (await api(secondDevice, '/api/providers')).body;
  assert.equal(actual.version, 2); assert.equal(actual.tasks.meal, 'second'); assert.equal(actual.taskModels.meal, 'model-b');
  assert.equal(actual.providers[0].name, 'first'); assert(actual.providers.some(item => item.id === 'added' && item.hasKey));
  const tasksOnlyFromOldSnapshot = { ...oldProviderEdit, taskModels: { ...oldProviderEdit.taskModels, chat: 'model-b' } };
  assert.equal((await api(secondDevice, '/api/providers', 'PUT', tasksOnlyFromOldSnapshot)).status, 409);
  assert.deepEqual((await api(alice, '/api/providers')).body, actual);
});

test('configuration versions survive restart and remain isolated by the authenticated account', async t => {
  const { api, register, stop, start } = await fixture(t), alice = await register('persist-config@example.test'), bob = await register('other-config@example.test');
  const saved = await api(alice, '/api/providers', 'PUT', configuration());
  assert.equal((await api(bob, '/api/providers')).body.version, 0);
  assert.equal((await api(bob, '/api/providers', 'PUT', { ...configuration(), version: saved.body.version })).status, 409);
  assert.equal((await api(bob, '/api/providers', 'PUT', { ...configuration(), version: 0 }, { 'X-Fitness-User': alice.id })).status, 409);
  assert.deepEqual((await api(alice, '/api/providers')).body, saved.body);
  await stop(); await start();
  assert.deepEqual((await api(alice, '/api/providers')).body, saved.body); assert.equal((await api(bob, '/api/providers')).body.version, 0);
  assert.equal((await api(alice, '/api/providers', 'PUT', configuration())).status, 409);
});

test('motion task settings share configuration versions and survive stale saves, three-task clients and restart', async t => {
  const { api, register, stop, start } = await fixture(t), alice = await register('motion-config-version@example.test');
  const initial = configuration(); initial.tasks.motion = 'first'; initial.taskModels.motion = 'model-a'; initial.version = 0;
  const saved = await api(alice, '/api/providers', 'PUT', initial);
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 1);
  assert.deepEqual(saved.body.tasks, initial.tasks); assert.deepEqual(saved.body.taskModels, initial.taskModels);
  assert.deepEqual((await api(alice, '/api/providers')).body, saved.body);

  const stale = structuredClone(saved.body), motionEdit = structuredClone(saved.body);
  motionEdit.taskModels.motion = 'model-b';
  const updated = await api(alice, '/api/providers', 'PUT', motionEdit);
  assert.equal(updated.status, 200); assert.equal(updated.body.version, 2);
  assert.equal(updated.body.tasks.motion, 'first'); assert.equal(updated.body.taskModels.motion, 'model-b');
  stale.tasks.motion = 'second'; stale.taskModels.motion = 'model-a'; stale.providers[0].name = 'Stale overwrite';
  assert.equal((await api(alice, '/api/providers', 'PUT', stale)).status, 409);
  assert.deepEqual((await api(alice, '/api/providers')).body, updated.body);

  const legacyEdit = structuredClone(updated.body);
  delete legacyEdit.tasks.motion; delete legacyEdit.taskModels.motion;
  legacyEdit.providers[0].name = 'Edited by three-task client'; legacyEdit.taskModels.meal = 'model-b';
  const legacySaved = await api(alice, '/api/providers', 'PUT', legacyEdit);
  assert.equal(legacySaved.status, 200); assert.equal(legacySaved.body.version, 3);
  assert.equal(legacySaved.body.providers[0].name, 'Edited by three-task client');
  assert.equal(legacySaved.body.taskModels.meal, 'model-b');
  assert.equal(legacySaved.body.tasks.motion, 'first'); assert.equal(legacySaved.body.taskModels.motion, 'model-b');
  await stop(); await start();
  assert.deepEqual((await api(alice, '/api/providers')).body, legacySaved.body);
});

test('pre-version databases migrate existing preferences and provider-only accounts without losing encrypted keys or resetting on reopen', async t => {
  const { directory, api, register, stop, start } = await fixture(t);
  const alice = await register('legacy-config@example.test'), orphan = await register('legacy-provider-only@example.test'), fresh = await register('legacy-unconfigured@example.test');
  const aliceBefore = (await api(alice, '/api/providers', 'PUT', configuration())).body;
  const orphanBefore = (await api(orphan, '/api/providers', 'PUT', { providers: [provider('standalone')] })).body;
  await stop();
  const legacy = new DatabaseSync(join(directory, 'fitness.sqlite'));
  const keys = legacy.prepare('SELECT user_id,id,api_key FROM providers ORDER BY user_id,id').all();
  legacy.exec('ALTER TABLE preferences DROP COLUMN version');
  legacy.prepare('DELETE FROM preferences WHERE user_id = ?').run(orphan.id);
  legacy.close();
  await start();
  assert.deepEqual((await api(alice, '/api/providers')).body, aliceBefore);
  const migratedOrphan = (await api(orphan, '/api/providers')).body;
  assert.equal(migratedOrphan.version, 1); assert.deepEqual(migratedOrphan.providers, orphanBefore.providers);
  assert.equal((await api(fresh, '/api/providers')).body.version, 0);
  assert.equal((await api(alice, '/api/providers', 'PUT', configuration())).status, 409);
  assert.equal((await api(orphan, '/api/providers', 'PUT', { providers: [] })).status, 409);
  const inspect = new DatabaseSync(join(directory, 'fitness.sqlite'));
  assert.deepEqual(inspect.prepare('SELECT user_id,id,api_key FROM providers ORDER BY user_id,id').all(), keys); inspect.close();
  const updated = await api(alice, '/api/providers', 'PUT', { ...aliceBefore, providers: aliceBefore.providers.map(item => ({ ...item, name: `${item.name} updated` })) });
  assert.equal(updated.status, 200); assert.equal(updated.body.version, 2);
  await stop(); await start();
  assert.deepEqual((await api(alice, '/api/providers')).body, updated.body); assert.equal((await api(orphan, '/api/providers')).body.version, 1);
});
