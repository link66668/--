import {createId} from './store.js?v=10';

/** Community requests always carry the account that started the request. */
export class CommunityApi {
  constructor({api, getUser}) { this.api=api; this.getUser=getUser; }
  request(path,options={}) {
    const user=this.getUser();
    if(!user?.id) return Promise.reject(Object.assign(new Error('请重新登录后继续'),{status:401}));
    if(options.method && options.method!=='GET' && globalThis.navigator?.onLine===false) return Promise.reject(new Error('当前离线，联网后再试。文字和素材可以先保存为本机草稿。'));
    return this.api('/community'+path,{...options,headers:{...options.headers,'X-Fitness-User':user.id}});
  }
  get(path,params={},signal) { const query=new URLSearchParams(Object.entries(params).filter(([,value])=>value!==undefined&&value!==null&&value!=='')).toString();return this.request(path+(query?'?'+query:''),{signal}); }
  write(path,method,body={},signal) { return this.request(path,{method,body,signal}); }
  upload(file,{purpose='note',signal,onProgress=()=>{}}={}) {
    const user=this.getUser();
    if(!user?.id) return Promise.reject(Object.assign(new Error('请重新登录后继续'),{status:401}));
    if(globalThis.navigator?.onLine===false) return Promise.reject(new Error('当前离线，联网后可重试上传'));
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>xhr.abort();
      xhr.open('POST','/api/community/media?purpose='+encodeURIComponent(purpose));xhr.withCredentials=true;
      xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');xhr.setRequestHeader('X-Fitness-User',user.id);xhr.setRequestHeader('X-Filename',encodeURIComponent(file.name||'素材'));
      xhr.upload.onprogress=event=>onProgress(event.lengthComputable?Math.round(event.loaded/event.total*100):0);
      xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300){onProgress(100);finish(null,data.media||data);}else finish(Object.assign(new Error(data.error||data.message||'素材上传失败，请重试'),{status:xhr.status}));};
      xhr.onerror=()=>finish(new Error('网络中断，素材仍保存在草稿中，可重试上传'));xhr.onabort=()=>finish(new DOMException('已取消上传','AbortError'));
      if(signal?.aborted){finish(new DOMException('已取消上传','AbortError'));return;}signal?.addEventListener('abort',abort,{once:true});xhr.send(file);
    });
  }
}
export const communityId=createId;
export const unwrapNote=data=>data.note||data;
export const unwrapUser=data=>data.user||data.profile||data;
export const communityMediaUrl=(media,managed=false)=>managed&&media?.id?`/api/community/me/media/${encodeURIComponent(media.id)}`:media?.url||(media?.id?`/api/community/media/${encodeURIComponent(media.id)}`:'');
