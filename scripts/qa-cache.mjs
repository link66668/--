// Real Edge regression: upgrade a fresh legacy HTTP/SW cache, then work offline.
// The browser profile, server files and SQLite database are isolated from user data.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT || join(root, '精细模型与动作开发/node_modules/playwright/index.mjs'))).href);
const work = await mkdtemp(join(tmpdir(), 'fitness-cache-qa-'));
const publicDir = join(work, 'public');
await cp(join(root, 'public'), publicDir, { recursive: true });
const current = Object.fromEntries(await Promise.all(['index.html', 'app.js', 'provider-ui.js', 'sw.js'].map(async name => [name, await readFile(join(publicDir, name), 'utf8')])));
const currentCache = /const CACHE\s*=\s*['"]([^'"]+)/.exec(current['sw.js'])[1];
const shell = ['/', '/index.html', '/app.css', '/providers.css', '/app.js', '/store.js', '/domain.js', '/meal-contract.js', '/knowledge.js', '/provider-presets.js', '/provider-ui.js', '/icon.svg', '/manifest.webmanifest'];
// Preserve the prior v2 worker's cache behavior to exercise a real upgrade.
const legacyWorker = `const CACHE='fitness-shell-v2'; const SHELL=${JSON.stringify(shell)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { const url=new URL(event.request.url); if(event.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return; event.respondWith(fetch(event.request).then(response => {if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache => cache.put(event.request,copy));}return response;}).catch(() => caches.match(event.request).then(response => response || caches.match('/index.html')))); });`;
const marked = (source, version, property) => `${source}\nglobalThis.${property} = ${JSON.stringify(version)};\n`;
await writeFile(join(publicDir, 'index.html'), current['index.html'].replace(/\?v=\d+/g, ''));
await writeFile(join(publicDir, 'app.js'), marked(current['app.js'].replace(/\?v=\d+/g, ''), 'legacy', 'qaAppVersion'));
await writeFile(join(publicDir, 'provider-ui.js'), marked(current['provider-ui.js'], 'legacy', 'qaDependencyVersion'));
await writeFile(join(publicDir, 'sw.js'), legacyWorker);
let legacyHeaders = true;
const requests = [];
const server = createServer({ publicDir, dataDir: join(work, 'data') });
server.prependListener('request', (req, res) => {
  requests.push(req.url);
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (legacyHeaders && name.toLowerCase() === 'cache-control' && /\.(?:js|css)(?:\?|$)/.test(req.url) && !req.url.startsWith('/sw.js')) value = 'public, max-age=3600, must-revalidate';
    return setHeader.call(this, name, value);
  };
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
const failures = [];
page.on('pageerror', error => errors.push(error.message));
context.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
let stage = 'start';
async function bounded(operation, label, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Cache QA timed out during ${label} after ${timeout} ms`)), timeout); })]);
  } finally { clearTimeout(timer); }
}
function progress(label) { stage = label; console.log(`[cache QA] ${label}`); }
try {
  progress('load legacy app and activate v2 worker');
  await page.goto(base);
  await page.waitForFunction(() => globalThis.qaAppVersion === 'legacy' && globalThis.qaDependencyVersion === 'legacy');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  assert((await page.evaluate(() => caches.keys())).includes('fitness-shell-v2'));
  const before = requests.filter(url => url === '/provider-ui.js').length;
  progress('verify fresh legacy HTTP cache');
  await bounded(() => page.evaluate(async () => {
    const response = await fetch('/provider-ui.js');
    if (!(await response.text()).includes('qaDependencyVersion = "legacy"')) throw new Error('Legacy cache was not seeded');
    await caches.open('qa-unrelated-cache').then(cache => cache.put('/keep-me', new Response('preserve')));
  }), stage);
  assert.equal(requests.filter(url => url === '/provider-ui.js').length, before, 'Legacy module should be fresh in the HTTP cache');

  progress('deploy current shell and reload');
  await writeFile(join(publicDir, 'app.js'), marked(current['app.js'], 'updated', 'qaAppVersion'));
  await writeFile(join(publicDir, 'provider-ui.js'), marked(current['provider-ui.js'], 'updated', 'qaDependencyVersion'));
  await writeFile(join(publicDir, 'index.html'), current['index.html']);
  await writeFile(join(publicDir, 'sw.js'), current['sw.js']);
  legacyHeaders = false;
  await page.reload();
  await page.waitForFunction(() => globalThis.qaAppVersion === 'updated' && globalThis.qaDependencyVersion === 'updated');
  progress('wait for current worker to replace v2');
  // This local Playwright build stops polling when an async predicate returns
  // a Promise, before its boolean result is known. Await each browser query
  // here so the legacy worker cannot still control the offline reload.
  await bounded(async () => {
    while (!await page.evaluate(async name => {
      const names = await caches.keys();
      const registration = await navigator.serviceWorker.getRegistration();
      return names.includes(name) && !names.includes('fitness-shell-v2') &&
        registration?.active?.state === 'activated' &&
        navigator.serviceWorker.controller === registration.active &&
        !registration.installing && !registration.waiting;
    }, currentCache)) await new Promise(resolve => setTimeout(resolve, 100));
  }, stage, 15000);
  // The new worker takes over existing clients; a regular refresh uses its policy.
  progress('reload under current worker');
  await page.reload();
  await page.waitForFunction(() => globalThis.qaAppVersion === 'updated' && globalThis.qaDependencyVersion === 'updated');
  assert((await page.evaluate(() => caches.keys())).includes('qa-unrelated-cache'), 'Upgrade should preserve unrelated application caches');
  await page.locator('#auth-form').waitFor({ state: 'attached' });

  progress('stop isolated origin and reload cached shell');
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  assert.equal(server.listening, false);
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(2000) }), 'Origin must be unreachable before checking the cached shell');
  await context.setOffline(true);
  await page.reload();
  progress('wait for offline app modules');
  await page.waitForFunction(() => globalThis.qaAppVersion === 'updated' && globalThis.qaDependencyVersion === 'updated');
  await page.locator('#auth-form').waitFor({ state: 'attached' });
  progress('fetch an uncached versioned module offline');
  const offlineModule = await bounded(() => page.evaluate(async () => {
    const response = await fetch('/provider-ui.js?v=offline-never-requested');
    return { type: response.headers.get('content-type'), body: await response.text() };
  }), stage);
  assert.match(offlineModule.type, /javascript/);
  assert.match(offlineModule.body, /qaDependencyVersion = "updated"/);
  const groupAssets = await bounded(() => page.evaluate(async () => {
    const results = await Promise.all(['/community-groups.js?v=offline-never-requested', '/community-groups.css?v=offline-never-requested', '/community-images.js?v=offline-never-requested'].map(async path => {
      const response = await fetch(path);
      return { ok: response.ok, type: response.headers.get('content-type'), body: await response.text() };
    }));
    return results;
  }), 'offline group assets');
  assert(groupAssets.every(asset => asset.ok));
  assert.match(groupAssets[0].type, /javascript/);
  assert.match(groupAssets[0].body, /export class CommunityGroups/);
  assert.match(groupAssets[1].type, /css/);
  assert.match(groupAssets[1].body, /\.cm-groups-layout/);
  assert.match(groupAssets[2].type, /javascript/);
  assert.match(groupAssets[2].body, /export class CommunityImageComposer/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: 'Microsoft Edge', checks: ['fresh legacy HTTP cache', `v2 to ${currentCache} worker upgrade`, 'updated entry and dependency modules', 'unrelated cache preserved', 'origin confirmed unreachable', 'offline shell', 'offline versioned module', 'offline versioned group module and styles', 'offline versioned community image composer'] }));
} catch (error) {
  console.error(JSON.stringify({ stage, errors, failures, requests: requests.slice(-60), state: await bounded(() => page.evaluate(async () => ({ app: globalThis.qaAppVersion, dependency: globalThis.qaDependencyVersion, caches: await caches.keys() })), 'failure diagnostics', 3000).catch(() => null) }));
  throw error;
} finally {
  progress('close isolated browser and test server');
  await bounded(() => browser.close(), 'browser cleanup', 10000);
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(work, { recursive: true, force: true });
}
