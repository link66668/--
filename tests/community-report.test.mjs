import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityController} from '../public/community.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const expectedReasons=[['sexual','色情低俗'],['political','政治敏感'],['fraud','诈骗信息'],['racism','种族歧视'],['offsite','站外导流'],['illegal','违法违规'],['spam','低差广告'],['unfriendly','不友善、引战'],['engagement','诱导关注点赞'],['minors','涉未成年人'],['cyberbullying','网络暴力'],['self_harm','疑似自残自杀'],['irrelevant','笔记不相关'],['other','其他']];

function reportHarness() {
  const value=new CommunityController({getUser:()=>({id:'reader'}),api:()=>{},toast:()=>{}}),errors=[];value.error=error=>errors.push(error);let closeCount=0;
  value.closeAux=()=>{if(value.aux){value.aux.form.isConnected=false;value.aux.button.isConnected=false;value.aux=null;closeCount++;}};
  value.showAux=(title,html,extra)=>{
    value.closeAux();const other={hidden:true,scrolls:[],scrollIntoView(options){this.scrolls.push(options);}},fieldset={disabled:false},button={disabled:true,isConnected:true,textContent:'提交'},dialog={title,html,extra,button,footer:'',insertAdjacentHTML(position,markup){assert.equal(position,'beforeend');this.footer=markup;}},form={isConnected:true,dataset:{cmForm:'report',type:/data-type="([^"]*)"/.exec(html)[1],id:/data-id="([^"]*)"/.exec(html)[1]},elements:{reason:{value:''},description:{value:'',disabled:true},namedItem:name=>name==='submitReport'?button:null},closest:selector=>selector==='.cm-report-dialog'?dialog:form,querySelector:selector=>selector==='.cm-report-other'?other:selector==='.cm-report-reasons'?fieldset:null};
    dialog.form=form;dialog.other=other;dialog.fieldset=fieldset;value.aux=dialog;return dialog;
  };
  const select=async(reason)=>{const form=value.aux.form;form.elements.reason.value=reason;await value.change({target:{name:'reason',closest:()=>form}});};
  return {value,errors,select,closeCount:()=>closeCount};
}

test('report dialog has all fourteen ordered radio reasons, an optional hidden explanation, and an associated disabled footer button',()=>{
  const {value}=reportHarness(),dialog=value.showReport('note','note-id');assert.equal(dialog.title,'举报笔记');assert.equal(dialog.extra,'cm-report-dialog');
  const rows=[...dialog.html.matchAll(/<label class="cm-report-option"><span>([^<]*)<\/span><input type="radio" name="reason" value="([^"]*)" required><\/label>/g)].map(([,label,id])=>[id,label]);assert.deepEqual(rows,expectedReasons);
  assert.match(dialog.html,/<form id="cm-report-form" data-cm-form="report"/);assert.match(dialog.html,/<fieldset class="cm-report-reasons"><legend class="cm-sr">/);assert.doesNotMatch(dialog.html,/<select|\bchecked\b/);
  assert.match(dialog.html,/<label class="cm-report-other" hidden>/);assert.match(dialog.html,/<textarea name="description" maxlength="500"[^>]* disabled>/);assert.doesNotMatch(dialog.html,/<textarea[^>]*required/);
  assert.match(dialog.footer,/<footer class="cm-report-footer"><button type="submit" name="submitReport" form="cm-report-form"[^>]* disabled>提交<\/button>/);
  const comment=value.showReport('comment','reply-id');assert.equal(comment.title,'举报评论');assert.match(comment.html,/data-type="comment" data-id="reply-id"/);
});

test('selecting other reveals its explanation without focusing, while switching reasons retains but disables its draft',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame');Object.defineProperty(globalThis,'requestAnimationFrame',{value:callback=>callback(),configurable:true});t.after(()=>{if(previous)Object.defineProperty(globalThis,'requestAnimationFrame',previous);else delete globalThis.requestAnimationFrame;});
  const {value,select}=reportHarness(),dialog=value.showReport('note','note');await select('other');assert.equal(dialog.other.hidden,false);assert.equal(dialog.form.elements.description.disabled,false);assert.equal(dialog.button.disabled,false);assert.deepEqual(dialog.other.scrolls,[{block:'nearest'}]);
  dialog.form.elements.description.value='仅本次举报的说明';await select('spam');assert.equal(dialog.other.hidden,true);assert.equal(dialog.form.elements.description.disabled,true);assert.equal(dialog.button.disabled,false);assert.equal(dialog.form.elements.description.value,'仅本次举报的说明');
  await select('other');assert.equal(dialog.form.elements.description.value,'仅本次举报的说明');assert.equal(dialog.other.hidden,false);assert.equal(dialog.form.elements.description.disabled,false);assert.equal(dialog.other.scrolls.length,2);
});

test('delegated report submission uses the associated footer button and never sends a hidden explanation',async()=>{
  const {value,select}=reportHarness(),dialog=value.showReport('comment','reply'),requests=[];value.api.write=async(path,method,body)=>{requests.push({path,method,body});};
  dialog.form.elements.description.value='已隐藏的旧说明';await select('unfriendly');let prevented=false;await value.submit({target:dialog.form,preventDefault(){prevented=true;},stopPropagation(){}});
  assert(prevented);assert.equal(requests.length,1);assert.equal(requests[0].path,'/reports');assert.equal(requests[0].method,'POST');assert.deepEqual({...requests[0].body,clientMutationId:undefined},{targetType:'comment',targetId:'reply',reason:'unfriendly',description:'',clientMutationId:undefined});assert(requests[0].body.clientMutationId);assert.equal(value.aux,null);
});

test('submitting without a selected reason does nothing, while other permits an empty explanation',async()=>{
  const {value}=reportHarness(),dialog=value.showReport('note','note'),requests=[];value.api.write=async(path,method,body)=>requests.push(body);
  await value.submitReport(dialog.form);assert.equal(requests.length,0);assert.equal(dialog.button.disabled,true);dialog.form.elements.reason.value='other';value.updateReportForm(dialog.form);await value.submitReport(dialog.form);assert.equal(requests.length,1);assert.equal(requests[0].reason,'other');assert.equal(requests[0].description,'');
});

test('failed report retries reuse a mutation id, but changing reason or explanation creates a new id',async()=>{
  const {value,errors}=reportHarness(),dialog=value.showReport('note','note'),requests=[];value.api.write=async(path,method,body)=>{requests.push(body);throw new Error('离线');};
  dialog.form.elements.reason.value='spam';await value.submitReport(dialog.form);assert.equal(dialog.button.disabled,false);assert.equal(dialog.fieldset.disabled,false);assert.equal(dialog.form.elements.description.disabled,true);
  await value.submitReport(dialog.form);assert.equal(requests[0].clientMutationId,requests[1].clientMutationId);dialog.form.elements.reason.value='other';await value.submitReport(dialog.form);assert.notEqual(requests[2].clientMutationId,requests[1].clientMutationId);assert.equal(dialog.form.elements.description.disabled,false);
  dialog.form.elements.description.value='补充了说明';await value.submitReport(dialog.form);assert.notEqual(requests[3].clientMutationId,requests[2].clientMutationId);await value.submitReport(dialog.form);assert.equal(requests[4].clientMutationId,requests[3].clientMutationId);assert.equal(errors.length,5);assert.equal(value.aux,dialog);
});

test('an in-flight report disables reasons and explanation and prevents duplicate submissions until failure settles',async()=>{
  const {value}=reportHarness(),dialog=value.showReport('comment','parent'),response=deferred();let requests=0;value.api.write=()=>{requests++;return response.promise;};dialog.form.elements.reason.value='other';
  const sending=value.submitReport(dialog.form);assert.equal(dialog.button.disabled,true);assert.equal(dialog.button.textContent,'提交中…');assert.equal(dialog.fieldset.disabled,true);assert.equal(dialog.form.elements.description.disabled,true);await value.submitReport(dialog.form);assert.equal(requests,1);
  response.reject(new Error('连接中断'));await sending;assert.equal(dialog.button.disabled,false);assert.equal(dialog.button.textContent,'提交');assert.equal(dialog.fieldset.disabled,false);assert.equal(dialog.form.elements.description.disabled,false);
});

test('closing and reopening resets the report, and a late success cannot close the newer dialog',async()=>{
  const {value,closeCount}=reportHarness(),first=value.showReport('note','first'),response=deferred();value.api.write=()=>response.promise;first.form.elements.reason.value='other';first.form.elements.description.value='旧说明';const sending=value.submitReport(first.form);
  value.closeAux();const current=value.showReport('comment','second');assert.equal(current.form.elements.reason.value,'');assert.equal(current.form.elements.description.value,'');assert.equal(current.form.elements.description.disabled,true);assert.equal(current.other.hidden,true);assert.equal(current.button.disabled,true);
  response.resolve({});await sending;assert.equal(value.aux,current);assert.equal(closeCount(),1);assert.equal(current.button.disabled,true);
});

test('moderation report labels use the shared vocabulary and still describe legacy copyright reports',()=>{
  const {value}=reportHarness(),list={innerHTML:''};value.page=()=>({querySelector:()=>list});value.moderationState={items:expectedReasons.map(([reason],i)=>({id:String(i),reason,status:'open',target:{note:{title:'笔记'}}})).concat({id:'legacy',reason:'copyright',status:'open'})};value.renderReports();
  for(const [,label]of expectedReasons)assert(list.innerHTML.includes('<strong>'+label+'</strong>'));assert.match(list.innerHTML,/<strong>侵权<\/strong>/);assert.doesNotMatch(list.innerHTML,/垃圾广告|不友善内容/);
});
