import { analyzeVideo, validateVideoFile, scaledVideoSize, MOTION_VIDEO_LIMITS } from './motion-video.js';
import { MOTION_POSE_MODEL, MOTION_POSE_MODELS, getMotionPoseModel } from './motion-models.js';
import { analyzeMotion } from './motion-analysis.js';
import { motionExercises, motionFamilies, getMotionExercise } from './motion-catalog.js';
import { buildMotionEvidence } from './motion-evidence.js';
import { mergeCoachAssessment } from './motion-contract.js';
import { buildMotionPoseData, buildFullMotionAnalysis } from './motion-pose-data.js';
import { readMotionVerdict } from './motion-verdict.js';
import { MOTION_VIDEO_ACCEPT, prepareMotionVideo, releasePreparedMotionVideo, validateVideoMetadata } from './motion-media.js';
import { createMotionFramePlayer } from './motion-frame-player.js';
import { drawMotionOverlay } from './motion-overlay.js';
import { buildSmoothedMotionFrames } from './motion-smoothing.js';
import { animateViewEntry } from './view-transitions.js?v=1';
import { buildMotionAssessmentReport } from './motion-report.js';
export { buildMotionAssessmentReport, validateMotionAssessmentSize, MAX_MOTION_ASSESSMENT_BYTES } from './motion-report.js';

const exerciseNames = Object.fromEntries(motionExercises.map(item=>[item.id,item.name]));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits=0) => finite(value) ? value.toFixed(digits) : '—';
const clock = value => { const seconds=Math.max(0,Math.floor(Number(value)||0)); return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`; };
const preciseClock = value => {const ticks=Math.round(Math.max(0,Number(value)||0)*10);return `${Math.floor(ticks/600)}:${((ticks%600)/10).toFixed(1).padStart(4,'0')}`;};
const verdictLabels = {standard:'暂时找不出问题','needs-improvement':'动作需要调整',uncertain:'暂时找不出问题',pending:'AI 尚未评价'};
const cleanText = value => typeof value==='string'?value.trim():'';
const aiFailedChecks = coach => Array.isArray(coach?.feedback)?[]:(Array.isArray(coach?.checks)?coach.checks:[]).filter(item=>item?.status==='fail'&&item.source==='visual'&&(cleanText(item.evidence)||cleanText(item.message))&&cleanText(item.correction)&&(finite(item.time)||item.evidenceTimes?.some(finite)));

/** Old reports never acquire a positive verdict from a score or local rules. */
export function motionVerdict(report={}) {
  const coach=report.coach;
  if(!coach)return {status:'pending',label:verdictLabels.pending,summary:'本机已准备好动作数据。请运行 AI 评价，查看动作是否标准和具体纠正建议。'};
  const verdict=readMotionVerdict(report);
  return {...verdict,label:verdictLabels[verdict.status]};
}

export function motionFeedback(report={}) {
  const coach=report.coach;if(!coach)return [];
  const verdict=motionVerdict(report),items=(Array.isArray(coach.feedback)?coach.feedback:[]).filter(item=>item&&cleanText(item.title)&&cleanText(item.evidence));
  if((coach.mode==='guided'||coach.action?.source==='user')&&coach.selectionCheck?.status!=='consistent')return [];
  const feedback=verdict.status==='needs-improvement'?items.filter(item=>item.status==='improve'):[];
  if(!feedback.some(item=>item.status==='improve')&&verdict.status==='needs-improvement')for(const check of aiFailedChecks(coach))feedback.push({status:'improve',title:check.label||'需要调整的动作细节',evidence:cleanText(check.evidence)||cleanText(check.message),correction:cleanText(check.correction),evidenceTimes:Array.isArray(check.evidenceTimes)?check.evidenceTimes:finite(check.time)?[check.time]:[]});
  return feedback.sort((a,b)=>(a.status==='improve'?0:1)-(b.status==='improve'?0:1)).slice(0,3);
}

export function motionCoachProgress(value={}) {
  const elapsed=finite(value.elapsedMs)?Math.floor(value.elapsedMs/1000):null;
  const suffix=elapsed>=5?`（已用时 ${elapsed} 秒）`:'';
  if(cleanText(value.message))return cleanText(value.message)+suffix;
  if(value.stage==='synthesis')return 'AI 正在汇总动作评价和纠正建议…'+suffix;
  if(value.stage==='retry')return 'AI 正在重试当前片段，请稍候…'+suffix;
  if(finite(value.total)&&value.total>0&&finite(value.completed))return `AI 正在核对动作数据：已完成 ${Math.min(value.total,Math.max(0,value.completed))} / ${value.total} 段…`+suffix;
  return 'AI 正在核对动作过程与关键画面，请保持页面打开…'+suffix;
}
function dateLabel(value) { const date=new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '已保存'; }
function normalizedReport(value) { return value?.data && typeof value.data==='object' ? {...value.data,id:value.id} : value; }
function reportName(report) {
  if(report.recognitionSource==='user'||report.coach?.action?.source==='user')return getMotionExercise(report.coach?.action?.exerciseId||report.exerciseId)?.name||cleanText(report.exerciseName)||cleanText(report.coach?.action?.name)||'所选动作';
  if(report.recognitionConflict)return '动作名称待确认';
  if(report.recognitionSource==='visual'&&typeof report.exerciseName==='string'&&report.exerciseName.trim())return report.exerciseName;
  const family=motionFamilies[report.exerciseFamily];
  return report.requiresVisualConfirmation&&family?`${family}（变式待确认）`:exerciseNames[report.exerciseId]||report.exerciseFamilyName||family||'动作评估';
}
export function motionSelectionNotice(report={}) {
  if(report.recognitionSource!=='user'&&report.coach?.action?.source!=='user')return null;
  const check=report.coach?.selectionCheck,status=['consistent','mismatch','uncertain'].includes(check?.status)?check.status:'uncertain';
  return {name:reportName(report),status,evidence:cleanText(check?.evidence),evidenceTimes:Array.isArray(check?.evidenceTimes)?check.evidenceTimes.filter(time=>finite(time)&&time>=0):[],
    message:status==='mismatch'?'所选动作与画面可能不符，请核对动作类型后重新评价。':status==='uncertain'?'暂时无法确认画面与所选动作一致，请核对选择或补充完整画面。':'已结合骨架和画面核对你选择的动作。'};
}

function exerciseOptions() {
  return '<option value="">请选择本段视频中的动作</option>'+Object.entries(motionFamilies).map(([family,name])=>{
    const entries=motionExercises.filter(item=>item.family===family);
    return entries.length?`<optgroup label="${escapeHtml(name)}">${entries.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</optgroup>`:'';
  }).join('');
}

/** Local video analysis owns its media, abort controller and render loop. */
export function mountMotionView(container,{saveAssessment,listAssessments,deleteAssessment,openExercise,getCoachConfiguration=()=>({configured:false,vision:false}),reviewAssessment,openCoachSettings,notify=()=>{}}={}) {
  let destroyed=false, suspended=false, file=null, objectUrl=null, pipeline=null, displayFrames=null, observations=null, result=null, controller=null;
  let running=false, saved=false, saving=false, selectedHistory=null, history=[], historyRevision=0, reportOpenRevision=0, animationId=0, analysisRevision=0;
  let metadata=null, lastAnnouncement=0, deletionId=null, historyRead=null;
  let coachController=null, coachRunning=false, awaitingCoach=false, coachMessage='', coachError='', coachRevision=0;
  let selectedExerciseId='', recognition=null, reviewCache=null;
  let selectedPoseModel=MOTION_POSE_MODEL.id;
  let targetPoint=null, selectingTarget=false, selectionCursor={x:.5,y:.4};
  let preparing=false, preparationController=null, selectionRevision=0;
  let mediaMode='native', preparedPoster=null, framePlayerDisabled=null;
  let coachConfig=getCoachConfiguration()||{};
  let coachReady=coachConfig.configured&&coachConfig.vision===true&&typeof reviewAssessment==='function';
  function coachDescription(){return coachReady?`${coachConfig.provider||''} · ${coachConfig.model||''}。AI 先结合骨架和关键画面识别动作。你确认或修改动作后，再评价动作并给出纠正建议。`:coachConfig.configured?'当前动作点评模型不支持图片或暂不可用。请配置支持图片的 AI 模型后开始评估。':'请先配置支持图片的 AI 模型，再开始动作评估。';}
  const listeners=new AbortController();
  container.innerHTML=`<section class="motion-page" aria-label="视频动作评估">
    <header class="motion-heading"><div><span class="eyebrow">MOVEMENT CHECK</span><h1>看清动作，练得更稳。</h1><p>选择一段训练视频，了解动作是否标准，以及应该怎样调整。</p></div><span class="motion-local-badge"><span aria-hidden="true">●</span> 原视频留在本机</span></header>
    <div class="motion-workspace">
      <section class="motion-input card" aria-labelledby="motion-upload-title">
        <div class="motion-section-head"><div><span class="motion-step">01 / 选择视频</span><h2 id="motion-upload-title">从一组动作开始</h2></div><span class="badge neutral">先识别，再确认</span></div>
        <div class="motion-exercise-field"><label for="motion-pose-model">骨架分析模型</label><select id="motion-pose-model" data-motion-pose-model aria-describedby="motion-pose-model-help">${MOTION_POSE_MODELS.map(model=>`<option value="${model.id}"${model.id===selectedPoseModel?' selected':''}>${model.tier} · ${model.label}</option>`).join('')}</select><p id="motion-pose-model-help">三档均使用三维骨架和 17 个关键点分析。默认标准 MediaPipe Full；快速适合低性能设备；高精度 MediaPipe Heavy 精度更高，但分析时间更长。更换模型后需重新分析视频。</p></div>
        <input type="file" data-motion-file accept="${MOTION_VIDEO_ACCEPT}" hidden aria-label="选择训练视频">
        <button type="button" class="motion-dropzone" data-motion-action="choose"><span class="motion-upload-mark" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><rect x="6" y="10" width="36" height="28" rx="8" stroke="currentColor" stroke-width="1.8"/><path d="m21 18 10 6-10 6V18Z" fill="currentColor"/><path d="M12 5v5m24-5v5M12 38v5m24-5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><strong>选择或拖入训练视频</strong><span>支持手机视频 · MP4、MOV、WebM 等格式</span><small>最长 ${MOTION_VIDEO_LIMITS.maxDuration/60} 分钟 · 最大 ${MOTION_VIDEO_LIMITS.maxBytes/1024/1024} MB</small><span class="motion-choose-label">选择视频 <span aria-hidden="true">↗</span></span></button>
        <div class="motion-file-details" data-motion-metadata hidden></div>
        <div class="motion-player" data-motion-player hidden><video data-motion-video controls playsinline preload="metadata" aria-label="训练视频回放"></video><canvas class="motion-frame-surface" data-motion-frame-surface tabindex="0" role="img" aria-label="训练视频的分析画面" hidden></canvas><canvas data-motion-canvas aria-hidden="true"></canvas><div class="motion-target-picker" data-motion-target-picker role="button" tabindex="0" aria-label="点选第一帧中的训练者上半身，或用方向键移动标记并按回车确认" hidden><span data-motion-target-marker aria-hidden="true">＋</span></div></div>
        <div class="motion-frame-controls" data-motion-frame-controls hidden><div><button type="button" class="button small" data-motion-frame-play disabled>播放回放</button><input type="range" data-motion-frame-seek min="0" max="0" value="0" step="0.01" aria-label="分析画面回放位置" disabled><output data-motion-frame-time>0:00.0 / 0:00.0</output></div><small data-motion-frame-caption>已读取首帧，开始评估后可回看动作画面。</small></div>
        <div class="motion-target-controls" data-motion-target-controls hidden><div><strong data-motion-target-label>自动选择训练者</strong><small data-motion-target-help>多人入镜时，可点选第一帧中的自己。分析后请确认目标框始终是自己。</small></div><button type="button" class="button small" data-motion-action="pick-target">点选训练者</button><button type="button" class="link-button" data-motion-action="reset-target" hidden>恢复默认</button></div>
        <div class="motion-playback-note" data-motion-playback hidden><label><input type="checkbox" data-motion-overlay checked> 显示目标与骨架</label><span>目标与骨架随回放显示</span></div>
        <section class="motion-coach-mode" aria-label="评估方式"><strong>视频分析 → AI 识别 → 确认动作 → AI 评价</strong><p data-motion-coach-description>${escapeHtml(coachDescription())}</p><small>视频在你的设备上分析，首次需下载分析模型。AI 接收关键骨架时序与统计、最多 6 张关键画面及对应时间；能指出的问题会给出纠正建议，未找到可指出的问题时显示“暂时找不出问题”，可随时取消。</small>${typeof openCoachSettings==='function'?'<button type="button" class="link-button" data-motion-action="coach-settings">配置 AI 模型</button>':''}</section>
        <div class="motion-run-controls" data-motion-controls hidden><button type="button" class="button primary" data-motion-action="analyze" disabled>开始评估</button><button type="button" class="button" data-motion-action="choose">换一段视频</button></div>
        <section class="motion-progress" data-motion-progress hidden aria-label="分析进度"><div><strong data-motion-progress-title>正在准备</strong><span data-motion-percent>0%</span></div><progress max="1" value="0" aria-label="视频分析进度"></progress><p data-motion-progress-message role="status" aria-live="polite">正在载入姿态模型…</p><button type="button" class="button small" data-motion-action="cancel">取消分析</button></section>
        <section class="motion-review-wait" data-motion-review-wait aria-label="AI 核对进度" hidden><p class="motion-coach-status" data-motion-coach-status role="status" aria-live="polite" hidden></p><p class="motion-coach-error" data-motion-coach-error role="alert" hidden></p><div class="motion-coach-actions"><button type="button" class="button small" data-motion-action="cancel-coach" hidden>取消 AI 核对</button><button type="button" class="button" data-motion-action="retry-coach" data-motion-coach-retry hidden>评价所选动作</button></div></section>
        <section class="motion-confirmation motion-coach-mode" data-motion-confirmation aria-labelledby="motion-confirm-title" hidden><span class="motion-step">02 / 确认动作</span><h2 id="motion-confirm-title">先核对这段视频练什么</h2><p data-motion-recognition role="status" aria-live="polite"></p><div class="motion-exercise-field"><label for="motion-exercise">动作类型<span>可修改 AI 的选择</span></label><select id="motion-exercise" data-motion-exercise required aria-describedby="motion-exercise-help">${exerciseOptions()}</select><p id="motion-exercise-help">请按实际动作和器械核对。确认后，AI 才会评价动作并给出纠正建议。</p></div><button type="button" class="button primary" data-motion-action="confirm-exercise" disabled>确认动作，开始评价</button></section>
        <div class="motion-error" data-motion-error role="alert" hidden></div>
        <p class="motion-privacy">原视频留在你的设备。身体骨架、客观测量和截图交给项目服务器临时处理；你选择的动作、关键骨架时序与统计、选定截图和对应时间会发送到配置的 AI 服务。保存的报告只保留评价与证据时间。站内切换页面会保留当前视频与评估进度；刷新或关闭浏览器前请保存报告，原视频之后需重新选择。</p>
      </section>
      <aside class="motion-guide" aria-labelledby="motion-guide-title"><span class="motion-step">拍摄建议</span><h2 id="motion-guide-title">动作是否标准，<br>下一组怎样调整。</h2><ol><li><span>01</span><div><strong>拍清全身和器械</strong><p>肩、髋、手脚都尽量入镜，让 AI 看清动作过程和器械位置。</p></div></li><li><span>02</span><div><strong>固定手机，减少遮挡</strong><p>多人入镜时可在第一帧点选自己，避免其他人和镜面干扰。</p></div></li><li><span>03</span><div><strong>保留完整动作过程</strong><p>建议录下 3–8 次，包含开始、转折和回程，便于给出具体纠正建议。</p></div></li></ol><p class="motion-guide-foot">AI 先识别动作，由你确认后再评价。能指出的问题会给出建议，否则显示“暂时找不出问题”。</p></aside>
    </div>
    <section class="motion-results" data-motion-results aria-labelledby="motion-result-title" hidden></section>
    <section class="motion-history" aria-labelledby="motion-history-title"><div class="motion-section-head"><div><span class="motion-step">你的记录</span><h2 id="motion-history-title">动作评估记录</h2></div><span data-motion-history-count></span></div><div data-motion-history><p class="motion-empty">正在读取已保存的报告…</p></div></section>
  </section>`;
  const root=container.querySelector('.motion-page');
  const find=selector=>root.querySelector(selector);
  const video=find('[data-motion-video]'), canvas=find('[data-motion-canvas]'), fileInput=find('[data-motion-file]'),exerciseSelect=find('[data-motion-exercise]');
  const poseModelSelect=find('[data-motion-pose-model]');
  const frameSurface=find('[data-motion-frame-surface]');
  const context=canvas.getContext('2d');
  const listen=(target,type,handler,options={})=>target.addEventListener(type,handler,{...options,signal:listeners.signal});
  function error(message) { const element=find('[data-motion-error]'); element.hidden=!message; element.textContent=message||''; }
  function announce(message,isError=false){if(!destroyed&&!suspended)notify(message,isError);}
  function scrollTo(selector,options){if(!destroyed&&!suspended)find(selector).scrollIntoView(options);}
  const framePlayer=createMotionFramePlayer({canvas:frameSurface,button:find('[data-motion-frame-play]'),range:find('[data-motion-frame-seek]'),time:find('[data-motion-frame-time]'),onFrame:()=>{if(!destroyed){controls();drawOverlay();}},onError:cause=>{if(!destroyed)error(cause?.message||'分析画面读取失败，请重新评估。');}});
  const mediaReady=()=>mediaMode==='software'?framePlayer.ready:video.readyState>=2;
  const mediaSeeking=()=>mediaMode==='software'?framePlayer.seeking:video.seeking;
  const mediaTime=()=>mediaMode==='software'?framePlayer.currentTime:video.currentTime;
  const mediaSurface=()=>mediaMode==='software'?frameSurface:video;
  function pauseMedia(){video.pause();framePlayer.pause();}
  function suspend(){
    if(destroyed||suspended)return;
    suspended=true;video.pause();cancelAnimationFrame(animationId);animationId=0;
    // A disabled player cannot be playing. Repeated pause would instead cancel
    // an in-flight setSource bitmap and make video preparation return false.
    if(!framePlayerDisabled)framePlayer.pause();
    controls();
  }
  function refreshConfiguration(){
    if(destroyed)return;
    coachConfig=getCoachConfiguration()||{};
    coachReady=coachConfig.configured&&coachConfig.vision===true&&typeof reviewAssessment==='function';
    find('[data-motion-coach-description]').textContent=coachDescription();
    if(coachReady&&coachError==='请先配置支持图片的动作点评 AI 模型。')coachError='';
    controls();
    const activeHistory=selectedHistory&&history.find(report=>report.id===selectedHistory);
    if(activeHistory)renderResult(activeHistory,true);else renderLiveResult();
  }
  function resume(){
    if(destroyed)return;
    const wasSuspended=suspended;
    suspended=false;refreshConfiguration();drawOverlay();
    if(selectingTarget)positionPicker();
    if(wasSuspended){
      animateViewEntry(find('.motion-workspace'));
      animateViewEntry(find('.motion-history'));
    }
  }
  function seekMedia(time){pauseMedia();if(mediaMode==='software')return framePlayer.seek(time);video.currentTime=Math.max(0,Math.min(metadata?.duration||0,time));return Promise.resolve();}
  function releaseMedia() {
    releasePreparedMotionVideo(file);
    framePlayer.clear();preparedPoster=null;
    video.pause(); video.removeAttribute('src'); video.load();
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=null; pipeline=null; displayFrames=null; observations=null; reviewCache=null; recognition=null;selectedExerciseId='';exerciseSelect.value='';metadata=null;mediaMode='native';
    video.hidden=false;frameSurface.hidden=true;find('[data-motion-frame-controls]').hidden=true;
    context?.clearRect(0,0,canvas.width,canvas.height);
  }
  function updateCoachStatus() {
    const waiting=awaitingCoach&&!!pipeline;
    const confirming=waiting&&!!recognition&&!coachRunning;
    find('[data-motion-confirmation]').hidden=!confirming;
    find('[data-motion-recognition]').textContent=recognition?.action?.status==='identified'&&getMotionExercise(recognition.action.exerciseId)?`AI 识别为：${getMotionExercise(recognition.action.exerciseId).name}。请核对，识别有误时可修改。`:'请选择视频中的动作类型，再确认评价。';
    find('[data-motion-action="confirm-exercise"]').disabled=!confirming||!selectedExerciseId||saving||!coachReady;
    find('[data-motion-review-wait]').hidden=!waiting||(!coachRunning&&!coachError&&!!recognition);
    find('[data-motion-coach-status]').hidden=!waiting;
    find('[data-motion-coach-status]').textContent=coachRunning?coachMessage:coachError?'AI 处理尚未完成，可重试或稍后继续。':'已保留本视频的分析数据，可继续识别动作。';
    find('[data-motion-coach-error]').hidden=!waiting||!coachError;
    find('[data-motion-coach-error]').textContent=coachError;
    find('[data-motion-action="cancel-coach"]').hidden=!coachRunning;
    find('[data-motion-coach-retry]').hidden=!waiting||coachRunning||!!recognition&&!recognition.failed;
    find('[data-motion-coach-retry]').disabled=saving||!coachReady;
    find('[data-motion-coach-retry]').textContent='重试动作识别';
  }
  function renderLiveResult() {updateCoachStatus();if(!selectedHistory&&result)renderResult(result);}
  function cancelCoach() {coachRevision++;coachController?.abort();coachController=null;coachRunning=false;coachMessage='';updateCoachStatus();}
  function cancel() { pauseMedia();if(preparing){framePlayer.clear();preparedPoster=null;releasePreparedMotionVideo(file);}selectionRevision++; preparationController?.abort(); preparationController=null; preparing=false; analysisRevision++; controller?.abort(); controller=null; running=false;awaitingCoach=false;cancelCoach(); }
  function controls() {
    find('[data-motion-controls]').hidden=!file||running||preparing;
    find('[data-motion-progress]').hidden=!(running||preparing);
    const start=find('[data-motion-action="analyze"]');
    start.disabled=!!recognition&&awaitingCoach||!metadata||!mediaReady()||running||preparing||coachRunning||selectingTarget||saving||!coachReady;
    start.textContent=result?.coach?'重新确认动作':recognition?'请确认下方动作':pipeline?'继续识别动作':'分析视频并识别动作';
    exerciseSelect.disabled=saving||coachRunning||!recognition;
    poseModelSelect.disabled=running||preparing||coachRunning||saving;
    find('.motion-input').setAttribute('aria-busy',String(running||preparing||coachRunning));
    find('[data-motion-playback]').hidden=!pipeline;
    find('[data-motion-target-controls]').hidden=!metadata;
    find('[data-motion-action="pick-target"]').disabled=running||preparing||coachRunning||!mediaReady();
    find('[data-motion-action="reset-target"]').disabled=running||coachRunning;
    find('[data-motion-action="reset-target"]').hidden=!targetPoint||selectingTarget;
    find('[data-motion-action="pick-target"]').textContent=selectingTarget?'取消点选':'点选训练者';
    find('[data-motion-target-label]').textContent=selectingTarget?'在第一帧中点选训练者上半身':targetPoint?'已指定训练者位置，将持续跟踪该目标':'自动选择训练者';
    find('[data-motion-target-help]').textContent=selectingTarget?'点击画面确认；也可用方向键移动标记，按回车确认。':'多人入镜时，可点选第一帧中的自己。分析后请确认目标框始终是自己。';
    const disabled=suspended||running||preparing||selectingTarget;
    if(framePlayerDisabled!==disabled){framePlayerDisabled=disabled;framePlayer.setDisabled(disabled);}
    video.controls=!suspended&&!selectingTarget;
    find('[data-motion-frame-caption]').textContent=pipeline?.previewFrames?.length?'分析画面回放 · 采样画面，无声音':'已读取首帧，开始评估后可回看动作画面。';
    updateCoachStatus();
  }
  function pickerGeometry() {
    if(!metadata)return null;
    const rect=mediaSurface().getBoundingClientRect(),scale=Math.min(rect.width/metadata.width,rect.height/metadata.height);
    const width=metadata.width*scale,height=metadata.height*scale;
    return {left:(rect.width-width)/2,top:(rect.height-height)/2,width,height,screenLeft:rect.left+(rect.width-width)/2,screenTop:rect.top+(rect.height-height)/2};
  }
  function positionPicker() {
    if(suspended||destroyed)return;
    const box=pickerGeometry();if(!box)return;
    Object.assign(find('[data-motion-target-picker]').style,{left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px'});
    Object.assign(find('[data-motion-target-marker]').style,{left:(selectionCursor.x*100)+'%',top:(selectionCursor.y*100)+'%'});
  }
  function stopTargetSelection() {selectingTarget=false;video.controls=true;find('[data-motion-target-picker]').hidden=true;controls();}
  async function beginTargetSelection() {
    if(!metadata||running||coachRunning)return;
    if(selectingTarget){stopTargetSelection();drawOverlay();return;}
    selectingTarget=true;selectionCursor=targetPoint?{...targetPoint}:{x:.5,y:.4};video.controls=false;
    const activeFile=file;controls();
    try{await seekMedia(0);}catch{if(!destroyed&&file===activeFile)stopTargetSelection();return;}
    if(destroyed||file!==activeFile||!selectingTarget)return;
    find('[data-motion-target-picker]').hidden=false;positionPicker();controls();if(!suspended)find('[data-motion-target-picker]').focus({preventScroll:true});
  }
  function clearAnalysis() {
    cancel();
    pipeline=null;displayFrames=null;observations=null;reviewCache=null;recognition=null;selectedExerciseId='';exerciseSelect.value='';result=null;saved=false;saving=false;selectedHistory=null;coachError='';
    if(mediaMode==='software'&&preparedPoster)void framePlayer.setSource({poster:preparedPoster,metadata}).catch(()=>{});
    find('[data-motion-results]').hidden=true;stopTargetSelection();drawOverlay();error('');
  }
  function chooseTarget(point) {
    if(!metadata||running||coachRunning||mediaSeeking())return;
    targetPoint=point?{x:Math.max(0,Math.min(1,point.x)),y:Math.max(0,Math.min(1,point.y))}:null;
    clearAnalysis();
  }
  function chooseExercise(value) {
    if(saving||!recognition){exerciseSelect.value=selectedExerciseId;return;}
    const next=getMotionExercise(value)?.id||'';
    if(next===selectedExerciseId)return;
    reportOpenRevision++;selectedExerciseId=next;exerciseSelect.value=next;cancelCoach();
    result=observations?{...observations,targetTracking:pipeline?.targetTracking}:null;
    saved=false;selectedHistory=null;coachError='';awaitingCoach=!!pipeline;
    find('[data-motion-results]').hidden=true;find('[data-motion-results]').replaceChildren();error('');controls();
  }
  async function selectFile(chosen) {
    if(destroyed||!chosen)return;
    try {validateVideoFile(chosen);} catch(cause) {error(cause.message);return;}
    reportOpenRevision++;
    cancel();selectingTarget=false;targetPoint=null;find('[data-motion-target-picker]').hidden=true;video.controls=true;releaseMedia();file=chosen;result=null;saved=false;selectedHistory=null;saving=false;coachError='';error('');
    find('[data-motion-results]').hidden=true;
    find('.motion-dropzone').hidden=true;
    find('[data-motion-player]').hidden=true;
    const details=find('[data-motion-metadata]');details.hidden=false;details.innerHTML=`<div><strong>${escapeHtml(file.name)}</strong><small>正在读取视频信息…</small></div><span>${number(file.size/1024/1024,1)} MB</span>`;
    const revision=selectionRevision;
    preparationController=new AbortController();const signal=preparationController.signal;
    preparing=true;controls();updateProgress({stage:'decoding',progress:0,message:'正在读取本地视频…'});
    try {
      const prepared=await prepareMotionVideo(chosen,{signal,onProgress:value=>{if(!destroyed&&revision===selectionRevision)updateProgress(value);}});
      if(destroyed||signal.aborted||revision!==selectionRevision)return;
      mediaMode=prepared.mode||'native';
      video.hidden=mediaMode==='software';frameSurface.hidden=mediaMode!=='software';
      find('[data-motion-frame-controls]').hidden=mediaMode!=='software';
      if(mediaMode==='software'){
        preparedPoster=prepared.poster;
        if(!await framePlayer.setSource({poster:preparedPoster,metadata:prepared.metadata}))return;
        if(destroyed||signal.aborted||revision!==selectionRevision)return;
        setMetadata(prepared.metadata);
      }else{objectUrl=URL.createObjectURL(prepared.file);video.src=objectUrl;video.load();}
      find('[data-motion-player]').hidden=false;
    } catch(cause) {
      if(destroyed||revision!==selectionRevision)return;
      metadata=null;details.querySelector('small').textContent='视频尚未准备好';
      error(cause?.name==='AbortError'?'视频准备已取消，可以重新选择视频。':cause?.message||'无法准备视频，请重新选择。');
    } finally {
      if(!destroyed&&revision===selectionRevision){preparing=false;preparationController=null;controls();}
    }
  }
  function metadataReady() {
    if(mediaMode!=='native'||!file||!finite(video.duration)||video.duration<=0)return;
    setMetadata({width:video.videoWidth,height:video.videoHeight,duration:video.duration});
  }
  function setMetadata(value) {
    try {validateVideoMetadata(value);}
    catch(cause){metadata=null;error(cause.message);controls();return;}
    metadata={width:value.width,height:value.height,duration:value.duration};
    const details=find('[data-motion-metadata]');
    details.innerHTML=`<div><strong>${escapeHtml(file.name)}</strong><small>${clock(metadata.duration)} · ${metadata.width} × ${metadata.height}</small></div><span>${number(file.size/1024/1024,1)} MB</span>`;
    const overlaySize=scaledVideoSize(metadata.width,metadata.height);
    canvas.width=overlaySize.width;canvas.height=overlaySize.height;
    controls();drawOverlay();
  }
  function updateProgress(value={}) {
    const progress=Math.max(0,Math.min(1,Number(value.progress)||0));
    const stage=value.stage||value.phase;
    find('progress').value=progress;find('[data-motion-percent]').textContent=`${Math.round(progress*100)}%`;
    find('[data-motion-progress-title]').textContent=stage==='loading'?'正在载入姿态模型':stage==='decoding'?(preparing?'正在读取视频':'正在读取并分析视频'):'正在识别动作轨迹';
    const now=performance.now();
    if(now-lastAnnouncement>900||progress===1) {
      lastAnnouncement=now;
      const processed=value.processedFrames??value.processed,total=value.totalFrames??value.total;
      find('[data-motion-progress-message]').textContent=value.message||(total?`已分析 ${processed||0} / ${total} 帧，可切换站内页面，请勿刷新或关闭标签页。`:'正在准备本机分析，请稍候。');
    }
  }
  async function run() {
    refreshConfiguration();
    if(!file||!metadata||running||preparing||coachRunning||saving||selectingTarget||destroyed||!coachReady)return;
    if(pipeline&&observations){if(recognition){showConfirmation();return;}await runCoach('recognize');return;}
    cancel();const revision=analysisRevision, activeFile=file;
    controller=new AbortController();const signal=controller.signal;
    running=true;awaitingCoach=true;result=null;pipeline=null;displayFrames=null;observations=null;reviewCache=null;saved=false;saving=false;selectedHistory=null;coachError='';
    pauseMedia();context?.clearRect(0,0,canvas.width,canvas.height);
    error('');find('[data-motion-results]').hidden=true;controls();updateProgress({stage:'loading',progress:0,message:'首次使用需要下载姿态模型，可切换站内页面，请勿刷新或关闭标签页。'});
    try {
      if(mediaMode==='software'&&preparedPoster){
        await framePlayer.setSource({poster:preparedPoster,metadata});
        if(destroyed||signal.aborted||revision!==analysisRevision)return;
      }
      const output=await analyzeVideo(activeFile,{signal,sampleFps:7.5,model:selectedPoseModel,targetPoint:targetPoint?{...targetPoint}:null,onProgress:value=>{if(!destroyed&&revision===analysisRevision)updateProgress(value);}});
      if(destroyed||signal.aborted||revision!==analysisRevision)return;
      const assessment=analyzeMotion(output.frames,{width:output.width,height:output.height,duration:output.duration,sourceFps:output.sourceFps,modelVersion:output.modelVersion});
      if(mediaMode==='software'){
        await framePlayer.setFrames(output.previewFrames);
        if(destroyed||signal.aborted||revision!==analysisRevision)return;
      }
      // Stabilize replay only; measurements, screenshots and AI use pipeline.
      displayFrames=buildSmoothedMotionFrames(output.frames,output);
      pipeline=output;observations=assessment;result=assessment;awaitingCoach=true;
      result.targetTracking=output.targetTracking;
      const activeHistory=selectedHistory&&history.find(report=>report.id===selectedHistory);
      if(activeHistory)renderResult(activeHistory,true);
      running=false;controller=null;controls();renderLiveResult();drawOverlay();
      await runCoach('recognize');
    } catch(cause) {
      if(destroyed||revision!==analysisRevision)return;
      running=false;controller=null;controls();
      if(cause?.name==='AbortError')error('分析已取消，可以重新开始。');
      else error(cause?.message||'视频分析失败，请检查视频格式后重试。');
    }
  }
  function showConfirmation() {
    if(!recognition||!pipeline||coachRunning||saving)return;
    reportOpenRevision++;selectedHistory=null;result={...observations,targetTracking:pipeline.targetTracking};
    awaitingCoach=true;saved=false;coachError='';controls();renderLiveResult();
    scrollTo('[data-motion-confirmation]',{behavior:'smooth',block:'nearest'});
  }
  async function runCoach(reviewMode='guided') {
    refreshConfiguration();
    if(destroyed||!file||!pipeline||!observations||!result||coachRunning||saving||(reviewMode==='guided'&&(!recognition||!selectedExerciseId)))return;
    if(!coachReady){
      awaitingCoach=true;coachError='请先配置支持图片的动作点评 AI 模型。';
      controls();renderLiveResult();return;
    }
    cancelCoach();const revision=coachRevision,analysisToken=analysisRevision,activeFile=file,activePipeline=pipeline,activeExerciseId=selectedExerciseId;
    const abort=new AbortController();coachController=abort;coachRunning=true;awaitingCoach=true;coachError='';
    coachMessage='正在选择动作关键画面…';controls();renderLiveResult();
    const current=()=>!destroyed&&!abort.signal.aborted&&revision===coachRevision&&analysisToken===analysisRevision&&activeFile===file&&activePipeline===pipeline&&activeExerciseId===selectedExerciseId;
    try{
      const base=observations;
      const evidence=reviewCache?.file===activeFile&&reviewCache.pipeline===activePipeline?reviewCache.evidence:await buildMotionEvidence(activeFile,activePipeline,base,{signal:abort.signal,onProgress:value=>{if(current()){coachMessage=value.message||'正在提取动作关键画面…';renderLiveResult();}}});
      if(!current())return;
      if(!evidence.images.length)throw new Error('未能提取训练者的关键画面，请调整拍摄或点选训练者后重新评估。');
      reviewCache={file:activeFile,pipeline:activePipeline,evidence};
      const analysis=evidence.summary;
      const poseData=buildMotionPoseData(activePipeline),fullAnalysis=buildFullMotionAnalysis(base,activePipeline);
      const keyframes=evidence.images.map(({time,mimeType,dataUrl,imageTime})=>({time,mimeType,data:dataUrl.slice(dataUrl.indexOf(',')+1),imageTime}));
      coachMessage=reviewMode==='recognize'?'AI 正在结合骨架和关键画面识别动作…':`AI 正在结合骨架和 ${keyframes.length} 张关键画面评价${getMotionExercise(activeExerciseId).name}…`;renderLiveResult();
      const response=await reviewAssessment({duration:activePipeline.duration,analysis,keyframes,poseData,fullAnalysis,reviewMode,...(reviewMode==='guided'?{selectedExerciseId:activeExerciseId}:{})},{signal:abort.signal,onProgress:value=>{if(current()){coachMessage=motionCoachProgress(value);renderLiveResult();}}});
      if(!current())return;
      if(reviewMode==='recognize'){
        if(response?.mode!=='recognize'||!['identified','unknown'].includes(response.action?.status))throw new Error('动作识别结果未完成，请重试。');
        recognition=response;selectedExerciseId=response.action.status==='identified'?(getMotionExercise(response.action.exerciseId)?.id||''):'';exerciseSelect.value=selectedExerciseId;
        coachRunning=false;coachController=null;coachMessage='';coachError='';awaitingCoach=true;
        controls();renderLiveResult();scrollTo('[data-motion-confirmation]',{behavior:'smooth',block:'nearest'});return;
      }
      const coach=response;
      if(coach?.mode!=='guided'||coach.action?.source!=='user'||coach.action?.exerciseId!==activeExerciseId)throw new Error('AI 返回的评价与所选动作不一致，请重试。');
      result=mergeCoachAssessment(base,coach);
      result.targetTracking=pipeline.targetTracking;
      result.coachEvidence={frameTimes:keyframes.map(({time})=>time),includesImages:keyframes.length>0,fullPoseFrameCount:poseData.frameCount};
      saved=false;saving=false;awaitingCoach=false;coachMessage='';coachRunning=false;coachController=null;
      controls();renderLiveResult();announce('AI 动作点评已完成。');
    }catch(cause){
      if(!current())return;
      coachRunning=false;coachController=null;coachMessage='';coachError=cause?.message||'AI 处理失败，请重试。';
      if(reviewMode==='recognize'){recognition={mode:'recognize',failed:true,action:{status:'unknown',exerciseId:null}};selectedExerciseId='';exerciseSelect.value='';}
      controls();renderLiveResult();announce(coachError,true);
    }
  }
  function nearestFrame(time) {
    const frames=displayFrames;if(!frames?.length)return null;
    let low=0,high=frames.length-1;
    while(low<high){const middle=Math.floor((low+high)/2);if(frames[middle].time<time)low=middle+1;else high=middle;}
    const after=frames[low],before=frames[Math.max(0,low-1)],frame=Math.abs(after.time-time)<Math.abs(before.time-time)?after:before;
    return Math.abs(frame.time-time)<=Math.max(.18,1.5/(pipeline.sampleFps||15))?frame:null;
  }
  function drawOverlay() {
    if(!context||destroyed||suspended)return;
    context.clearRect(0,0,canvas.width,canvas.height);
    if(mediaSeeking())return;
    if(!find('[data-motion-overlay]').checked)return;
    const frame=nearestFrame(mediaTime()),box=frame?.subjectTracking?.status==='locked'?frame.subjectTracking.bbox:null;
    if(box&&[box.xMin,box.yMin,box.xMax,box.yMax].every(finite)) {
      context.strokeStyle='#bfccff';context.fillStyle='#bfccff';context.lineWidth=2;
      context.strokeRect(box.xMin*canvas.width,box.yMin*canvas.height,(box.xMax-box.xMin)*canvas.width,(box.yMax-box.yMin)*canvas.height);
      context.font=`${Math.max(12,Math.round(canvas.width/45))}px sans-serif`;context.fillText('评估对象',Math.max(3,box.xMin*canvas.width),Math.max(18,box.yMin*canvas.height-6));
    } else if(!pipeline&&targetPoint&&!selectingTarget) {
      context.strokeStyle='#c4ceff';context.lineWidth=3;context.beginPath();context.arc(targetPoint.x*canvas.width,targetPoint.y*canvas.height,12,0,Math.PI*2);context.stroke();
    }
    drawMotionOverlay(context,frame?.landmarks,canvas.width,canvas.height);
  }
  function playbackLoop() { if(destroyed||suspended)return;drawOverlay();if(!video.paused&&!video.ended)animationId=requestAnimationFrame(playbackLoop); }
  function timestampButton(time,label,canSeek) {return canSeek&&finite(time)?`<button type="button" class="motion-time" data-motion-action="seek" data-time="${time}" aria-label="跳转到 ${escapeHtml(preciseClock(time))} 查看${escapeHtml(label)}">${preciseClock(time)} <span aria-hidden="true">↗</span></button>`:`<span class="motion-time">${preciseClock(time)}</span>`;}
  function feedbackHtml(report,canSeek) {
    const items=motionFeedback(report);if(!items.length)return '';
    const verdict=motionVerdict(report);
    const duration=report.video?.duration??pipeline?.duration??120;
    return `<section class="motion-ai-feedback" aria-label="动作评价与纠正建议"><h3>${verdict.status==='standard'?'下一组继续保持':'如何调整'}</h3><div class="motion-feedback-list">${items.map(item=>`<article class="motion-feedback-item"><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.evidence)}</p>${item.correction?`<p class="motion-feedback-correction"><strong>${item.status==='good'?'继续保持':'建议这样做'}</strong>${escapeHtml(item.correction)}</p>`:''}${Array.isArray(item.evidenceTimes)&&item.evidenceTimes.some(time=>finite(time)&&time>=0&&time<=duration)?`<div class="motion-feedback-times">${[...new Set(item.evidenceTimes)].filter(time=>finite(time)&&time>=0&&time<=duration).map(time=>timestampButton(time,'这一段动作',canSeek)).join(' ')}</div>`:''}</article>`).join('')}</div></section>`;
  }
  function coachHtml(report,fromHistory,canSeek) {
    const coach=report.coach,verdict=motionVerdict(report),available=!fromHistory&&!!pipeline;
    const selection=motionSelectionNotice(report),duration=report.video?.duration??pipeline?.duration??120;
    return `<section class="motion-coach" aria-label="AI 动作评价">${selection&&verdict.status==='needs-improvement'?`<div class="motion-selection-notice is-${selection.status}" data-motion-selection-check="${selection.status}"><strong>你选择的动作：${escapeHtml(selection.name)}</strong><p>${escapeHtml(selection.message)}</p>${selection.evidence?`<p>${escapeHtml(selection.evidence)}</p>`:''}${selection.evidenceTimes.some(time=>time<=duration)?`<div class="motion-feedback-times">${[...new Set(selection.evidenceTimes)].filter(time=>time<=duration).map(time=>timestampButton(time,'动作选择核对',canSeek)).join(' ')}</div>`:''}</div>`:''}<div class="motion-verdict is-${verdict.status}" data-motion-verdict="${verdict.status}"><span class="motion-step">动作评价</span><h3>${verdict.label}</h3><p class="${coach?'motion-coach-evaluation':'motion-coach-pending'}">${escapeHtml(verdict.summary)}</p></div>
      ${feedbackHtml(report,canSeek)}

      ${available&&!coachRunning?`<div class="motion-coach-actions">${coachReady?`<button type="button" class="button${coach?'':' primary'}" data-motion-action="coach" ${!selectedExerciseId||saving?'disabled':''}>${coach?'重新确认动作':'确认动作后评价'}</button>`:typeof openCoachSettings==='function'?'<button type="button" class="button primary" data-motion-action="coach-settings">配置动作点评模型</button>':''}</div>`:''}
    </section>`;
  }
  function renderResult(report,fromHistory=false) {
    updateCoachStatus();
    const section=find('[data-motion-results]');
    if(!fromHistory&&(!report.coach||awaitingCoach)){section.hidden=true;section.replaceChildren();return;}
    section.hidden=false;
    const canSeek=!fromHistory&&!!pipeline,name=reportName(report);
    section.innerHTML=`<div class="motion-section-head"><div><span class="motion-step">${fromHistory?'已保存的评价':'03 / 评估结果'}</span><h2 id="motion-result-title">${escapeHtml(name)}</h2></div>${fromHistory&&result?'<button type="button" class="button small" data-motion-action="live-result">返回本次结果</button>':''}</div>
      ${fromHistory?'<p class="motion-history-notice">这是已保存的评价。重新选择视频并分析后可查看对应片段。</p>':''}
      ${coachHtml(report,fromHistory,canSeek)}
      ${report.coach?`<div class="motion-result-actions">${pipeline&&!fromHistory&&typeof saveAssessment==='function'?`<button type="button" class="button primary" data-motion-action="save" ${saved||saving||coachRunning?'disabled':''}>${saved?'已保存报告':saving?'正在保存…':'保存报告'}</button>`:''}${getMotionExercise(report.exerciseId)?.hasTeaching&&typeof openExercise==='function'?`<button type="button" class="button" data-motion-action="exercise" data-exercise="${escapeHtml(report.exerciseId)}">查看动作示范 <span aria-hidden="true">↗</span></button>`:''}</div>`:''}`;
  }
  function refreshHistory() {
    const revision=++historyRevision;
    historyRead=(async()=>{
      try {
        const values=typeof listAssessments==='function'?await listAssessments():[];
        if(destroyed||revision!==historyRevision)return null;
        history=(Array.isArray(values)?values:[]).map(normalizedReport).filter(item=>item&&typeof item.id==='string').sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
        renderHistory();
        return history;
      } catch(cause) {if(!destroyed&&revision===historyRevision)find('[data-motion-history]').innerHTML='<p class="motion-empty">读取记录失败，可刷新页面重试。</p>';}
      return null;
    })();
    return historyRead;
  }
  async function openReport(id) {
    if(destroyed)return false;
    const revision=++reportOpenRevision;
    let read=refreshHistory(),values;
    for(;;){
      values=await read;
      if(destroyed||revision!==reportOpenRevision)return false;
      if(read===historyRead)break;
      // Store synchronization may start a newer history read while this jump
      // is waiting. Join that read without losing the requested report ID.
      read=historyRead;
    }
    const report=values?.find(item=>item.id===id);
    if(!report){
      selectedHistory=null;
      if(result)renderLiveResult();else{find('[data-motion-results]').hidden=true;find('[data-motion-results]').replaceChildren();}
      const message=values?'这份动作评估报告已删除或不存在。':'读取动作评估报告失败，请重试。';
      error(message);announce(message,true);return false;
    }
    const changed=selectedHistory!==report.id;
    error('');selectedHistory=report.id;renderResult(report,true);
    if(changed)animateViewEntry(find('[data-motion-results]'));
    scrollTo('[data-motion-results]',{behavior:'smooth',block:'start'});
    return true;
  }
  function renderHistory() {
    find('[data-motion-history-count]').textContent=history.length?`${history.length} 份报告`:'';
    find('[data-motion-history]').innerHTML=history.length?`<div class="motion-history-list">${history.map((report,index)=>{const verdict=motionVerdict(report);return `<article class="motion-history-item"><div><strong>${escapeHtml(reportName(report))}</strong><span class="motion-history-verdict is-${verdict.status}">${verdict.label}</span><p>${escapeHtml(dateLabel(report.createdAt))} · ${clock(report.video?.duration)}</p></div><button type="button" class="button small" data-motion-action="history" data-history="${index}">查看报告</button>${typeof deleteAssessment==='function'?`<button type="button" class="motion-delete" data-motion-action="delete" data-history="${index}" ${deletionId===report.id?'disabled':''} aria-label="删除 ${escapeHtml(dateLabel(report.createdAt))} 的${escapeHtml(reportName(report))}报告">${deletionId===report.id?'删除中…':'删除'}</button>`:''}</article>`;}).join('')}</div>`:'<p class="motion-empty">还没有保存的报告。完成一次评估后，可以在这里回看。</p>';
  }
  async function save() {
    if(!result?.coach||!pipeline||awaitingCoach||coachRunning||saved||saving||typeof saveAssessment!=='function')return;
    error('');saving=true;controls();renderResult(result);
    const currentResult=result;
    const summary=buildMotionAssessmentReport(result,{file,pipeline});
    try {
      await saveAssessment(summary);
      if(destroyed)return;
      if(currentResult===result){saved=true;saving=false;if(!selectedHistory)renderResult(result);}
      announce('报告已保存，原视频未上传。');await refreshHistory();
    } catch(cause) {if(!destroyed&&currentResult===result){saving=false;if(!selectedHistory)renderResult(result);const message=cause?.message||'报告保存失败，请重试。';error(message);announce(message,true);}}
    finally{if(!destroyed)controls();}
  }
  async function removeReport(index) {
    const report=history[index];if(!report||deletionId||typeof deleteAssessment!=='function')return;
    deletionId=report.id;renderHistory();
    try {await deleteAssessment(report.id);if(destroyed)return;if(selectedHistory===report.id){selectedHistory=null;if(result)renderResult(result);else find('[data-motion-results]').hidden=true;}announce('报告已删除。');await refreshHistory();}
    catch(cause){if(!destroyed){const message=cause?.message||'删除报告失败，请重试。';error(message);announce(message,true);}}
    finally{deletionId=null;if(!destroyed)renderHistory();}
  }
  listen(root,'click',event=>{
    const button=event.target.closest('[data-motion-action]');if(!button||button.disabled)return;
    const action=button.dataset.motionAction;
    if(action==='choose')fileInput.click();
    else if(action==='analyze')void run();
    else if(action==='cancel'){const wasPreparing=preparing;cancel();controls();if(wasPreparing)find('[data-motion-metadata] small').textContent='视频准备已取消';error(wasPreparing?'视频准备已取消，可以重新选择视频。':'分析已取消，可以重新开始。');}
    else if(action==='save')void save();
    else if(action==='coach')showConfirmation();
    else if(action==='retry-coach')void runCoach('recognize');
    else if(action==='confirm-exercise')void runCoach('guided');
    else if(action==='cancel-coach'){cancelCoach();coachError='AI 评价已取消，可以重试或稍后继续。';controls();renderLiveResult();}
    else if(action==='coach-settings')openCoachSettings?.();
    else if(action==='pick-target')void beginTargetSelection();
    else if(action==='reset-target')chooseTarget(null);
    else if(action==='exercise')openExercise?.(button.dataset.exercise);
    else if(action==='history'){const report=history[Number(button.dataset.history)];if(report){const changed=selectedHistory!==report.id;reportOpenRevision++;selectedHistory=report.id;renderResult(report,true);if(changed)animateViewEntry(find('[data-motion-results]'));scrollTo('[data-motion-results]',{behavior:'smooth',block:'start'});}}
    else if(action==='live-result'){const changed=selectedHistory!==null;reportOpenRevision++;selectedHistory=null;if(result){renderResult(result);const section=find('[data-motion-results]');if(changed&&!section.hidden)animateViewEntry(section);}}
    else if(action==='delete')void removeReport(Number(button.dataset.history));
    else if(action==='seek'&&pipeline){context?.clearRect(0,0,canvas.width,canvas.height);void seekMedia(Number(button.dataset.time)||0).catch(()=>{});if(!suspended)mediaSurface().focus({preventScroll:true});scrollTo('[data-motion-player]',{behavior:'smooth',block:'center'});}
  });
  listen(fileInput,'change',()=>{selectFile(fileInput.files?.[0]);fileInput.value='';});
  listen(exerciseSelect,'change',()=>chooseExercise(exerciseSelect.value));
  listen(poseModelSelect,'change',()=>{
    if(running||preparing||coachRunning||saving){poseModelSelect.value=selectedPoseModel;return;}
    const next=getMotionPoseModel(poseModelSelect.value).id;
    if(next===selectedPoseModel)return;
    reportOpenRevision++;selectedPoseModel=next;clearAnalysis();controls();
  });
  listen(find('.motion-input'),'dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';find('.motion-input').classList.add('is-dragover');}});
  listen(find('.motion-input'),'dragleave',event=>{if(!find('.motion-input').contains(event.relatedTarget))find('.motion-input').classList.remove('is-dragover');});
  listen(find('.motion-input'),'drop',event=>{event.preventDefault();find('.motion-input').classList.remove('is-dragover');const files=event.dataTransfer?.files;if(files?.length>1)announce('一次评估一段视频，已选择第一个文件。');selectFile(files?.[0]);});
  listen(video,'loadedmetadata',metadataReady);
  listen(video,'loadeddata',metadataReady);
  listen(video,'error',()=>{if(mediaMode==='native'&&file&&objectUrl){metadata=null;controls();error('视频画面读取失败，请重新选择视频。');}});
  listen(video,'play',()=>{cancelAnimationFrame(animationId);if(suspended){video.pause();return;}playbackLoop();});
  listen(video,'pause',()=>{cancelAnimationFrame(animationId);drawOverlay();});
  listen(video,'seeking',()=>context?.clearRect(0,0,canvas.width,canvas.height));
  listen(video,'seeked',drawOverlay);listen(video,'timeupdate',drawOverlay);
  listen(find('[data-motion-overlay]'),'change',drawOverlay);
  listen(find('[data-motion-target-picker]'),'click',event=>{const box=pickerGeometry();if(selectingTarget&&box&&box.width>0&&box.height>0)chooseTarget({x:(event.clientX-box.screenLeft)/box.width,y:(event.clientY-box.screenTop)/box.height});});
  listen(find('[data-motion-target-picker]'),'keydown',event=>{
    if(!selectingTarget)return;
    if(event.key==='Escape'){event.preventDefault();stopTargetSelection();return;}
    if(event.key==='Enter'||event.key===' '){event.preventDefault();chooseTarget(selectionCursor);return;}
    const delta={ArrowLeft:[-.025,0],ArrowRight:[.025,0],ArrowUp:[0,-.025],ArrowDown:[0,.025]}[event.key];
    if(delta){event.preventDefault();selectionCursor={x:Math.max(0,Math.min(1,selectionCursor.x+delta[0])),y:Math.max(0,Math.min(1,selectionCursor.y+delta[1]))};positionPicker();}
  });
  listen(window,'resize',()=>{if(selectingTarget)positionPicker();});
  controls();void refreshHistory();
  animateViewEntry(find('.motion-workspace'));
  animateViewEntry(find('.motion-history'));
  return {refreshHistory,openReport,suspend,resume,refreshConfiguration,hasUnsavedWork:()=>!destroyed&&!!file&&!saved,destroy(){if(destroyed)return;destroyed=true;cancel();listeners.abort();cancelAnimationFrame(animationId);releaseMedia();framePlayer.destroy();file=null;result=null;history=[];}};
}
