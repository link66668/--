// Views fade and rise; title copy stays in place while sharing the fade.
const activeEntries = new Map();
const pendingEntries = new WeakMap();
const fixedTitleSelector = '.page-title > div:first-child, .greeting-copy, .motion-heading > div:first-child, h1:not(.markdown-body h1, .message h1, .cm-profile-copy h1, .cm-chat-peer h1)';
const motionPreference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
motionPreference?.addEventListener('change', () => {
  if (motionPreference.matches) cancelViewEntries();
});

export function cancelViewEntries(root) {
  for (const [element, animation] of activeEntries) {
    if (!root || root.contains(element)) animation.cancel();
  }
}

export function animateViewEntry(element) {
  if (!element?.isConnected || !element.animate || motionPreference?.matches || element.closest('.motion-paused')) return;
  const dialog = element.closest('dialog');
  if (dialog && dialog !== element && dialog.getAnimations().some(animation => animation.animationName === 'energy-enter' && animation.playState === 'running')) return;
  for (const [target, animation] of activeEntries) {
    if (target !== element && target.contains(element)) return;
    if (target === element || element.contains(target)) animation.cancel();
  }
  const animation = element.animate([
    {opacity: 0, translate: '0 9px'},
    {opacity: 1, translate: '0 0'},
  ], {duration: 500, easing: 'ease'});
  const startTime = animation.timeline?.currentTime;
  if (startTime != null) animation.startTime = startTime;
  const candidates = [...element.querySelectorAll(fixedTitleSelector)];
  const titles = candidates.filter(title => !candidates.some(parent => parent !== title && parent.contains(title)));
  const titleAnimations = titles.map(title => {
    const entry = title.animate([{translate: '0 -9px'}, {translate: '0 0'}], {duration: 500, easing: 'ease'});
    entry.id = 'view-title-position';
    if (startTime != null) entry.startTime = startTime;
    return entry;
  });
  animation.id = 'view-entry';
  activeEntries.set(element, animation);
  const cleanup = () => {
    for (const entry of titleAnimations) entry.cancel();
    if (activeEntries.get(element) === animation) activeEntries.delete(element);
  };
  animation.finished.then(cleanup, cleanup);
}

// Start when the new view reaches the DOM, including renderers that await data.
// Observe the view root only so streaming, typing and list updates do not replay it.
export function transitionView(element, update) {
  if (!element || !element.animate || motionPreference?.matches || element.closest('.motion-paused')) return update();
  pendingEntries.get(element)?.();
  const cleanup = () => {
    observer.disconnect();
    if (pendingEntries.get(element) === cleanup) pendingEntries.delete(element);
  };
  const begin = () => {
    if (pendingEntries.get(element) !== cleanup) return;
    cleanup();
    animateViewEntry(element);
  };
  const observer = new MutationObserver(begin);
  pendingEntries.set(element, cleanup);
  observer.observe(element, {childList: true});
  try {
    const result = update();
    if (observer.takeRecords().length) begin();
    if (result?.then) return Promise.resolve(result).finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
