const DATABASE='fitness-community-drafts-v1';
const STORE='drafts';
export function draftKey(accountId,id) { if(!accountId||!id)throw new Error('草稿必须绑定账号与草稿编号');return [String(accountId),String(id)]; }
export function prepareCommunityDraft(accountId,draft,now=Date.now()) {
  const [owner,id]=draftKey(accountId,draft.id);
  // structuredClone preserves File / Blob bytes; JSON would silently lose them.
  return structuredClone({...draft,id,accountId:owner,updatedAt:now});
}
export function createCommunityConflictBackup(draft,id) {
  if(!id||id===draft.id)throw new Error('冲突备份必须使用独立的草稿编号');
  const {publishing,...persistent}=draft;
  return structuredClone({...persistent,id,isConflictBackup:true,backupOf:draft.id});
}
class IndexedDraftStorage {
  async open() {if(this.db)return;this.db=await new Promise((resolve,reject)=>{const request=indexedDB.open(DATABASE,1);request.onupgradeneeded=()=>{const store=request.result.createObjectStore(STORE,{keyPath:['accountId','id']});store.createIndex('accountId','accountId');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('本机草稿库暂时被其他窗口占用，请关闭旧页面后重试'));});}
  async run(mode,operation) {await this.open();return new Promise((resolve,reject)=>{const tx=this.db.transaction(STORE,mode);let result;const request=operation(tx.objectStore(STORE));request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||request.error);tx.onabort=()=>reject(tx.error||new Error('本机草稿保存失败'));});}
  put(value) {return this.run('readwrite',store=>store.put(value));}
  get(key) {return this.run('readonly',store=>store.get(key));}
  delete(key) {return this.run('readwrite',store=>store.delete(key));}
  list(accountId) {return this.run('readonly',store=>store.index('accountId').getAll(accountId));}
  close() {this.db?.close();this.db=null;}
}
export class CommunityDrafts {
  constructor(accountId,{storage}={}) {if(!accountId)throw new Error('草稿必须绑定当前账号');this.accountId=String(accountId);this.storage=storage||new IndexedDraftStorage();this.serial=Promise.resolve();}
  save(draft) {const value=prepareCommunityDraft(this.accountId,draft);this.serial=this.serial.catch(()=>{}).then(()=>this.storage.put(value)).then(()=>value);return this.serial;}
  async get(id) {await this.serial.catch(()=>{});const value=await this.storage.get(draftKey(this.accountId,id));return value?.accountId===this.accountId?value:null;}
  async list() {await this.serial.catch(()=>{});return (await this.storage.list(this.accountId)).filter(row=>row.accountId===this.accountId).sort((a,b)=>b.updatedAt-a.updatedAt);}
  async remove(id) {await this.serial.catch(()=>{});await this.storage.delete(draftKey(this.accountId,id));}
  async clear() {for(const row of await this.list())await this.remove(row.id);}
  close() {this.serial.finally(()=>this.storage.close()).catch(()=>{});}
}
export async function clearCommunityDrafts(accountId) {const drafts=new CommunityDrafts(accountId);try{await drafts.clear();}finally{drafts.close();}}
