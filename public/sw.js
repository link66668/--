
const CACHE = 'fitness-shell-v106';

const SHELL = ['/', '/index.html', '/app.css', '/providers.css', '/app.js', '/store.js', '/domain.js', '/model-capabilities.js', '/schedule.js', '/busy-rules.js', '/holidays.js', '/achievements.js', '/plan-library.js', '/assets/weekly-achievement.svg', '/meal-advice-prompt.js', '/meal-contract.js', '/knowledge.js', '/knowledge-tools.js', '/visuals.js', '/model-viewer.js', '/provider-presets.js', '/provider-ui.js', '/exercise-covers.js', '/chat-stream.js', '/chat-markdown.js', '/chat-attachments.js', '/chat-view.js', '/vendor/marked.esm.js', '/vendor/purify.es.js', '/icon.svg', '/manifest.webmanifest'];
SHELL.push('/web-search.js','/nutrition-feedback-view.js','/nutrition-feedback.js','/meal-display.js','/compute.js','/compute-catalog.js');
SHELL.push('/view-transitions.js','/account-settings.js');
SHELL.push('/chat-motion.js','/chat-motion-confirm.js','/chat-motion-result.js','/chat-motion.css','/motion-report.js');
SHELL.push('/community.css', '/community.js', '/community-api.js', '/community-drafts.js', '/community-report-reasons.js', '/community-groups.js', '/community-groups.css', '/community-images.js');
SHELL.push('/motion-models.js', '/motion-mediapipe.js', '/motion-overlay.js', '/motion-smoothing.js');
SHELL.push('/brand.css', '/assets/logo.svg', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/apple-touch-icon.png');
SHELL.push('/motion.css', '/motion-view.js', '/motion-video.js', '/motion-worker.js', '/motion-analysis.js', '/motion-decode.js', '/motion-catalog.js', '/motion-contract.js', '/motion-evidence.js', '/motion-tracking.js');
SHELL.push('/achievement-view.js', ...['first','week','sprout','rhythm','tree','mountain','footprints','steps','summit','cycle','sunrise','seasons'].flatMap(name=>[`/assets/achievements/${name}.svg`,`/assets/achievements/${name}-pending.svg`]));
SHELL.push('/energy.css', '/landing.css', '/workspace-theme.css', '/landing.js', '/daily-quotes.js');
SHELL.push('/provider-settings.js', '/motion-pose-data.js', '/motion-feedback.js', '/motion-verdict.js');
SHELL.push('/motion-media.js', '/motion-source.js', '/motion-source-worker.js', '/motion-software-decode.js', '/motion-frame-player.js');
SHELL.push('/vendor/gsap.min.js', '/vendor/ScrollTrigger.min.js', '/assets/fonts/cabinet-grotesk-400.woff2', '/assets/fonts/cabinet-grotesk-700.woff2');
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, {cache:'reload'})))).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fitness-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/model/')) return;
  if (SHELL.includes(url.pathname)) event.respondWith(fetch(event.request, {cache:'no-cache'}).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy))); }
    return response;
  }).catch(() => caches.open(CACHE).then(cache => cache.match(url.pathname)).then(response => response || Response.error())));
  // Large, pinned pose assets are cached only when an analysis needs them.
  // A model upgrade must bump CACHE alongside the model manifest.
  if (['mp4box','ffmpeg','mediapipe'].some(directory => url.pathname.startsWith(`/vendor/${directory}/`))) event.respondWith(caches.open(CACHE).then(async cache => {
    const hit=await cache.match(event.request);if(hit)return hit;
    const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone()).catch(()=>{});return response;
  }));
  // 动作封面按需缓存：先给缓存命中，再后台更新，避免 25 张图每次都走网络。
  if (url.pathname.startsWith('/assets/exercises/')) event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname).then(hit => {
    const fresh = fetch(event.request).then(response => { if (response.ok) cache.put(url.pathname, response.clone()); return response; }).catch(() => hit || Response.error());
    return hit || fresh;
  })));
});
