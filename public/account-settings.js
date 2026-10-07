import {CommunityApi, unwrapUser} from './community-api.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avatarUrl = user => /^\/api\/community\/media\/[\w-]+$/.test(user?.avatarUrl || '') ? user.avatarUrl : '';

export function accountAvatarMarkup(user) {
  const url = avatarUrl(user);
  return url ? `<img src="${escape(url)}" alt="" decoding="async">` : escape(user?.name?.slice(0, 1) || '循');
}

export function mountAccountSettings(container, {user, api, isCurrent, onProfileChange}) {
  container.innerHTML = `<div class="account-settings-grid">
    <section class="card account-settings-card" aria-labelledby="account-avatar-heading">
      <h2 id="account-avatar-heading">个人头像</h2><p class="description">个人中心、侧边栏和社区使用同一头像。</p>
      <form id="account-avatar-form">
        <div class="account-avatar-preview" data-account-avatar-preview>${accountAvatarMarkup(user)}</div>
        <div class="account-identity"><strong>${escape(user.name)}</strong><span>${escape(user.email)}</span></div>
        <input id="account-avatar-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
        <div class="account-avatar-actions"><button type="button" class="button" data-account-choose-avatar>更换头像</button><button type="submit" class="button primary" disabled>保存头像</button></div>
        <p class="description account-field-hint">支持 JPEG、PNG、WebP 图片，最大 10 MB。</p>
        <p id="account-avatar-status" class="account-form-status" role="status" aria-live="polite"></p>
      </form>
    </section>
    <section class="card account-settings-card" aria-labelledby="account-password-heading">
      <h2 id="account-password-heading">修改密码</h2><p class="description">修改后当前设备保持登录，其他设备需要重新登录。</p>
      <form id="account-password-form">
        <input type="hidden" name="username" autocomplete="username" value="${escape(user.email)}">
        <div class="field"><label for="account-current-password">当前密码</label><input id="account-current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></div>
        <div class="field"><label for="account-new-password">新密码</label><input id="account-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" aria-describedby="account-password-hint" required><small id="account-password-hint" class="account-field-hint">使用 8–256 个字符，且与当前密码不同。</small></div>
        <div class="field"><label for="account-confirm-password">确认新密码</label><input id="account-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></div>
        <p id="account-password-status" class="account-form-status" role="status" aria-live="polite"></p>
        <div class="form-footer"><button type="submit" class="button primary">修改密码</button></div>
      </form>
    </section>
  </div>`;
  const community = new CommunityApi({api, getUser: () => isCurrent() ? user : null});
  const avatarForm = container.querySelector('#account-avatar-form'), passwordForm = container.querySelector('#account-password-form');
  const fileInput = container.querySelector('#account-avatar-file'), choose = container.querySelector('[data-account-choose-avatar]');
  const saveAvatar = avatarForm.querySelector('[type="submit"]'), savePassword = passwordForm.querySelector('[type="submit"]');
  const preview = container.querySelector('[data-account-avatar-preview]');
  const avatarStatus = container.querySelector('#account-avatar-status'), passwordStatus = container.querySelector('#account-password-status');
  const events = new AbortController(), requests = new Set();
  let destroyed = false, revision = 0, draft = null, uploading = false, avatarSaving = false, passwordSaving = false, upload, previewUrl;
  const alive = () => !destroyed && container.isConnected && isCurrent();
  const status = (element, message, error = false) => {element.textContent = message; element.classList.toggle('error', error); element.setAttribute('role', error ? 'alert' : 'status');};
  const revokePreview = () => {if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;};
  const controls = () => {choose.disabled = avatarSaving; fileInput.disabled = avatarSaving; saveAvatar.disabled = !draft || uploading || avatarSaving; saveAvatar.textContent = avatarSaving ? '保存中…' : '保存头像';};
  const request = async (path, options = {}) => {
    const controller = new AbortController(); requests.add(controller);
    try {return await api(path, {...options, signal: controller.signal, headers: {...options.headers, 'X-Fitness-User': user.id}});}
    finally {requests.delete(controller);}
  };
  const applyProfile = value => {
    const profile = unwrapUser(value);
    if (profile?.id !== user.id) throw new Error('账号已发生变化，请重新登录后再试。');
    onProfileChange(profile);
    revokePreview(); preview.innerHTML = accountAvatarMarkup({...user, avatarUrl: profile.avatarUrl});
  };
  choose.addEventListener('click', () => {if (alive()) fileInput.click();}, {signal: events.signal});
  fileInput.addEventListener('change', async event => {
    event.stopPropagation();
    const file = fileInput.files?.[0]; fileInput.value = '';
    if (!file || !alive() || avatarSaving) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) {
      status(avatarStatus, '请选择 10 MB 以内的 JPEG、PNG 或 WebP 图片。', true); return;
    }
    const token = ++revision; upload?.abort(); upload = new AbortController();
    draft = null; uploading = true; controls(); revokePreview();
    previewUrl = URL.createObjectURL(file);
    const image = document.createElement('img'); image.src = previewUrl; image.alt = '新头像预览'; preview.replaceChildren(image);
    status(avatarStatus, '正在上传头像…');
    try {
      const media = await community.upload(file, {purpose: 'avatar', signal: upload.signal});
      if (!alive() || revision !== token) return;
      draft = media; status(avatarStatus, '预览已就绪，点击“保存头像”完成修改。');
    } catch (error) {
      if (!alive() || revision !== token || error.name === 'AbortError') return;
      revokePreview(); preview.innerHTML = accountAvatarMarkup(user); status(avatarStatus, error.message || '上传失败，请重试。', true);
    } finally {if (alive() && revision === token) {uploading = false; controls();}}
  }, {signal: events.signal});
  avatarForm.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation();
    if (!alive() || !draft || uploading || avatarSaving) return;
    avatarSaving = true; controls(); status(avatarStatus, '正在保存头像…');
    try {
      const result = await request('/community/me/profile', {method: 'PATCH', body: {avatarMediaId: draft.id}});
      if (!alive()) return;
      applyProfile(result); draft = null; status(avatarStatus, '头像已更新。');
    } catch (error) {if (alive() && error.name !== 'AbortError') status(avatarStatus, error.message || '保存失败，请重试。', true);}
    finally {if (alive()) {avatarSaving = false; controls();}}
  }, {signal: events.signal});
  passwordForm.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation();
    if (!alive() || passwordSaving || !passwordForm.reportValidity()) return;
    const {currentPassword, newPassword, confirmPassword} = passwordForm.elements;
    if (newPassword.value !== confirmPassword.value) {status(passwordStatus, '两次输入的新密码不一致。', true); confirmPassword.focus(); return;}
    if (currentPassword.value === newPassword.value) {status(passwordStatus, '新密码不能与当前密码相同。', true); newPassword.focus(); return;}
    const body = {currentPassword: currentPassword.value, newPassword: newPassword.value};
    passwordSaving = true; savePassword.disabled = true; savePassword.textContent = '修改中…';
    for (const field of [currentPassword, newPassword, confirmPassword]) field.disabled = true;
    status(passwordStatus, '正在修改密码…');
    try {
      await request('/account/password', {method: 'PATCH', body});
      if (!alive()) return;
      passwordForm.reset(); status(passwordStatus, '密码已修改，其他设备需使用新密码重新登录。');
    } catch (error) {if (alive() && error.name !== 'AbortError') status(passwordStatus, error.message || '修改失败，请重试。', true);}
    finally {
      body.currentPassword = ''; body.newPassword = '';
      if (alive()) {passwordSaving = false; savePassword.disabled = false; savePassword.textContent = '修改密码'; for (const field of [currentPassword, newPassword, confirmPassword]) field.disabled = false;}
    }
  }, {signal: events.signal});
  // Refresh the shared avatar when opening settings, without replacing a local preview.
  request('/community/me/profile').then(result => {if (alive() && revision === 0 && !avatarSaving) applyProfile(result);}).catch(() => {});
  return {refreshAvatar(profile) {
    if (alive() && !draft && !uploading && !avatarSaving) preview.innerHTML = accountAvatarMarkup(profile);
  }, destroy() {
    destroyed = true; revision++; events.abort(); upload?.abort(); requests.forEach(controller => controller.abort());
    passwordForm.reset(); revokePreview(); draft = null;
  }};
}
