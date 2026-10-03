import {communityId} from './community-api.js?v=10';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const imageIcon='<svg class="cm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M15 7h.01"/></svg>';
const imageUrl=media=>'/api/community/media/'+encodeURIComponent(media.id);
const validImages=images=>Array.isArray(images)?images.filter(media=>media&&typeof media.id==='string'&&/^image\/(jpeg|png|webp)$/.test(media.type||'')).slice(0,9):[];

export function communityImagesMarkup(images) {
  const rows=validImages(images);if(!rows.length)return '';
  const data=escape(JSON.stringify(rows));
  return `<div class="cm-inline-images cm-inline-images-${rows.length}" aria-label="图片附件">${rows.map((media,index)=>`<button type="button" data-cm="images-view" data-images="${data}" data-index="${index}" aria-label="查看第 ${index+1} 张图片"><img src="${escape(imageUrl(media))}" alt="图片附件 ${index+1}" loading="lazy" decoding="async"></button>`).join('')}</div>`;
}

export function openCommunityImageViewer(images,start=0) {
  const rows=validImages(images);if(!rows.length)return null;
  const opener=document.activeElement,dialog=document.createElement('dialog');dialog.className='cm-image-viewer';dialog.setAttribute('aria-label','查看图片');
  let index=Math.max(0,Math.min(rows.length-1,Number(start)||0));
  const close=()=>{dialog.close();dialog.remove();if(opener?.isConnected)opener.focus({preventScroll:true});};
  const render=()=>{dialog.innerHTML=`<header><span>${index+1} / ${rows.length}</span><button type="button" data-image-action="close" aria-label="关闭大图">×</button></header><div class="cm-image-viewer-stage"><img src="${escape(imageUrl(rows[index]))}" alt="第 ${index+1} 张图片">${rows.length>1?'<button type="button" data-image-action="prev" aria-label="上一张图片">‹</button><button type="button" data-image-action="next" aria-label="下一张图片">›</button>':''}</div><p class="cm-image-viewer-error" role="status" hidden>图片暂时无法查看，请关闭后重试。</p>`;dialog.querySelector('img').addEventListener('error',()=>{dialog.querySelector('.cm-image-viewer-error').hidden=false;});};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){close();return;}const action=event.target.closest('[data-image-action]')?.dataset.imageAction;if(action==='close')close();else if(action){index=(index+(action==='next'?1:-1)+rows.length)%rows.length;render();dialog.querySelector(`[data-image-action="${action}"]`)?.focus();}});
  dialog.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)&&rows.length>1){event.preventDefault();index=(index+(event.key==='ArrowRight'?1:-1)+rows.length)%rows.length;render();}});
  render();document.body.append(dialog);dialog.showModal();return {dialog,close};
}

export class CommunityImageComposer {
  constructor({api,isAlive=()=>true,onChange=()=>{},onError=()=>{},images=[]}) {
    this.api=api;this.isAlive=isAlive;this.onChange=onChange;this.onError=onError;this.assets=validImages(images).map(media=>({key:communityId(),media:{...media},status:'ready',name:media.originalName||'已上传图片'}));this.disabled=false;
  }
  get images(){return this.assets.filter(asset=>asset.status==='ready').map(asset=>({...asset.media}));}
  get hasImages(){return this.assets.length>0;}
  get busy(){return this.assets.some(asset=>['pending','uploading'].includes(asset.status));}
  get failed(){return this.assets.some(asset=>asset.status==='failed');}
  snapshot(){return this.images;}
  mount(slot) {
    this.form?.removeEventListener('paste',this.pasteHandler);this.slot?.removeEventListener('change',this.changeHandler);this.slot?.removeEventListener('click',this.clickHandler);
    this.slot=slot;this.slot.classList.add('cm-image-composer');
    this.changeHandler=event=>{if(event.target.matches('input[type=file]')){this.add(event.target.files);event.target.value='';}};this.slot.addEventListener('change',this.changeHandler);
    this.clickHandler=event=>{const button=event.target.closest('[data-image-compose-action]');if(!button)return;event.preventDefault();const key=button.dataset.key;if(button.dataset.imageComposeAction==='remove')this.remove(key);else this.upload(key);};this.slot.addEventListener('click',this.clickHandler);
    this.form=slot.closest('form');this.pasteHandler=event=>{const files=[...(event.clipboardData?.files||[])].filter(file=>file.type.startsWith('image/'));if(files.length&&!this.disabled){event.preventDefault();this.add(files);}};this.form?.addEventListener('paste',this.pasteHandler);this.render();
  }
  changed(){if(this.disposed||!this.isAlive())return;this.render();this.onChange();}
  setDisabled(disabled){this.disabled=!!disabled;this.render();}
  add(files) {
    if(this.disposed||this.disabled||!this.isAlive())return;
    for(const file of [...files]){
      if(this.assets.length>=9){this.onError(new Error('每次最多发送 9 张图片'));break;}
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024||!file.size){this.onError(new Error('请选择 10 MB 以内的 JPEG、PNG 或静态 WebP 图片'));continue;}
      const asset={key:communityId(),file,name:file.name,status:'pending',progress:0,localUrl:URL.createObjectURL(file)};this.assets.push(asset);this.changed();this.upload(asset.key);
    }
  }
  async upload(key) {
    const asset=this.assets.find(row=>row.key===key);if(!asset?.file||asset.status==='uploading'||this.disposed||this.disabled||!this.isAlive())return;
    asset.status='uploading';asset.error='';asset.progress=0;const controller=asset.controller=new AbortController();this.changed();
    try{const media=await this.api.upload(asset.file,{purpose:'attachment',signal:controller.signal,onProgress:progress=>{if(this.disposed||!this.isAlive()||!this.assets.includes(asset))return;asset.progress=progress;const item=this.slot?.querySelector(`[data-image-key="${CSS.escape(key)}"]`);const bar=item?.querySelector('progress');if(bar)bar.value=progress;const label=item?.querySelector('.cm-image-upload-status');if(label)label.textContent=`上传中 ${progress}%`;}});if(this.disposed||!this.isAlive()||!this.assets.includes(asset))return;asset.media=media;asset.status='ready';asset.error='';}
    catch(error){if(this.disposed||!this.isAlive()||!this.assets.includes(asset))return;asset.status='failed';asset.error=error.name==='AbortError'?'上传已暂停，可重试':error.message||'上传失败';if(error.status===401)this.onError(error);}
    finally{delete asset.controller;this.changed();}
  }
  remove(id) {
    const index=this.assets.findIndex(asset=>asset.key===id||asset.media?.id===id);if(index<0)return;const [asset]=this.assets.splice(index,1);asset.controller?.abort();if(asset.localUrl)URL.revokeObjectURL(asset.localUrl);this.changed();
  }
  clear(){for(const asset of [...this.assets])this.remove(asset.key);}
  render() {
    if(this.disposed||!this.slot?.isConnected)return;
    const pickerId=this.pickerId||=communityId();
    this.slot.innerHTML=`<div class="cm-image-compose-tools"><label class="cm-image-pick cm-text-button ${this.disabled?'cm-image-pick-disabled':''}" for="${pickerId}" title="添加图片 · JPEG、PNG、静态 WebP · 每张最大 10 MB">${imageIcon}<span>添加图片</span></label><input class="cm-sr" id="${pickerId}" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="添加图片" ${this.disabled||this.assets.length>=9?'disabled':''}><span class="cm-image-compose-hint">${this.assets.length?this.assets.length+' / 9 张':'最多 9 张 · 每张 10 MB'}</span></div><div class="cm-image-tray" ${this.assets.length?'':'hidden'} aria-label="待发送图片">${this.assets.map((asset,index)=>`<article class="cm-image-draft ${asset.status==='failed'?'cm-image-draft-failed':''}" data-image-key="${escape(asset.key)}"><div><img src="${escape(asset.localUrl||imageUrl(asset.media))}" alt="待发送图片 ${index+1}"><button type="button" data-image-compose-action="remove" data-key="${escape(asset.key)}" aria-label="移除图片 ${index+1}" ${this.disabled?'disabled':''}>×</button></div><span class="cm-image-upload-status" role="status">${asset.status==='ready'?'已上传':asset.status==='failed'?'上传失败':'上传中 '+asset.progress+'%'}</span>${asset.status==='uploading'?`<progress max="100" value="${asset.progress}" aria-label="图片上传进度"></progress>`:''}${asset.status==='failed'?`<button type="button" data-image-compose-action="retry" data-key="${escape(asset.key)}" ${this.disabled?'disabled':''}>重试上传</button><small>${escape(asset.error)}</small>`:''}</article>`).join('')}</div>`;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.form?.removeEventListener('paste',this.pasteHandler);this.slot?.removeEventListener('change',this.changeHandler);this.slot?.removeEventListener('click',this.clickHandler);for(const asset of this.assets){asset.controller?.abort();if(asset.localUrl)URL.revokeObjectURL(asset.localUrl);}this.slot=null;}
}
