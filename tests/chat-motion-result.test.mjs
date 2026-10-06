import test from 'node:test';
import assert from 'node:assert/strict';
import {compactChatMotionResult,renderChatMotionResult} from '../public/chat-motion-result.js';

test('chat motion receipts retain the detail link without duplicating the saved report',()=>{
 const result={name:'assess_motion_video',ok:true,readOnly:true,reportId:'motion:123',exerciseName:'深蹲',verdict:{status:'needs-improvement',summary:'起身时需要调整'},feedback:[{status:'improve',title:'膝部控制',evidence:'画面中膝盖向内移动',correction:'起身时保持膝盖沿脚尖方向移动'}],record:{data:{private:'full report'}},records:[{}]};
 const receipt=compactChatMotionResult(result);
 assert.equal(receipt.record,undefined);assert.equal(receipt.records,undefined);
 const html=renderChatMotionResult(receipt);
 assert.match(html,/查看详细结果/);assert.match(html,/data-report-id="motion:123"/);assert.match(html,/膝盖沿脚尖方向/);assert.doesNotMatch(html,/full report/);
 assert.doesNotMatch(renderChatMotionResult({...receipt,ok:false}),/data-action="chat-motion-detail"/);
});

test('model text and report IDs cannot inject active markup into motion result cards',()=>{
 const html=renderChatMotionResult({ok:true,reportId:'motion:" onclick="alert(1)',exerciseName:'<img src=x onerror=alert(1)>',verdict:{status:'<script>',summary:'<script>alert(1)</script>'},feedback:[{title:'<b>x</b>',correction:'<iframe src=x>'}]});
 assert.doesNotMatch(html,/<script|<img|<iframe| onclick="/);
 assert.match(html,/&lt;img/);assert.match(html,/is-uncertain/);
 assert.match(html,/暂时找不出问题/);
});

test('chat cards show the actual selected skeleton model while old receipts stay readable',()=>{
 for(const [poseModel,label] of [['mediapipe-lite','快速 · MediaPipe Lite'],['mediapipe-full','标准 · MediaPipe Full'],['mediapipe-heavy','高精度 · MediaPipe Heavy']]){
  const receipt=compactChatMotionResult({name:'assess_motion_video',ok:true,poseModel,reportId:'motion:123',record:{}});
  assert.equal(receipt.poseModel,poseModel);assert(renderChatMotionResult(receipt).includes(label));
 }
 assert(!renderChatMotionResult({ok:true,reportId:'motion:old'}).includes('chat-motion-model'));
});

test('successful cards show only concrete issues or the shared no-finding message',()=>{
 for(const status of ['standard','uncertain','needs-improvement']){
  const html=renderChatMotionResult({ok:true,verdict:{status,summary:'无法评估动作，请重新拍摄。'},feedback:[
   {status:'good',title:'动作完全标准',evidence:'上半身稳定。',correction:'继续保持。'},
   {status:'uncertain',title:'无法识别',evidence:'被遮挡。',correction:'重新拍摄。'},
   {status:'improve',title:'没有纠正依据',evidence:'',correction:'增加幅度。'},
  ]});
  assert.match(html,/暂时找不出问题。/);
  assert.doesNotMatch(html,/无法评估|无法识别|重新拍摄|动作完全标准|没有纠正依据|建议调整/);
 }
 const failed=renderChatMotionResult({ok:false,message:'网络连接失败，请重试。'});
 assert.match(failed,/评估未完成|网络连接失败/);
 assert.doesNotMatch(failed,/暂时找不出问题/);
});
