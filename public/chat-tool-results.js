// Validation details are for the model's repair loop, not conversation cards.
const recoverableCodes = new Set(['INVALID_ARGUMENTS', 'VERSION_CONFLICT', 'CALENDAR_CONFLICT', 'PLAN_EXISTS', 'PLAN_NOT_FOUND', 'TRAINING_DAY_NOT_FOUND', 'BUSY_DATE']);
export const isRecoverableToolResult = result => !result.ok && recoverableCodes.has(result.code);
export function toolOperationKey(name, args = {}) {
  if (/^(create|update|delete)_training_plan$/.test(name)) return 'training-plan';
  return `${name}:${args.id || (name === 'create_calendar_task' ? JSON.stringify([args.task?.date,args.task?.dayId,args.task?.title]) : name === 'create_meal' ? JSON.stringify(args.meal) : '')}`;
}
export function userFacingToolResult(result) {
  if (!isRecoverableToolResult(result)) return result;
  const subject = result.readOnly ? '资料暂时无法读取' : /training_plan/.test(result.name) ? '训练计划尚未保存' : /meal/.test(result.name) ? '饮食记录尚未保存' : '训练安排尚未保存';
  const message = result.code === 'BUSY_DATE' ? '所选日期为繁忙日，未安排训练。请改选空闲日期，或明确指定允许训练的繁忙日期。'
    : `${subject}，请重试。`;
  return {...result, message};
}
export function conversationToolResults(results = []) {
  return results.filter((result, index) => {
    if (result.ok && result.readOnly && !result.presentation && !['assess_motion_video','web_search','read_web_page'].includes(result.name)) return false;
    // Older conversations saved intermediate plan failures next to success.
    if (isRecoverableToolResult(result) && /training_plan/.test(result.name)) {
      return !results.slice(index + 1).some(next => next.ok && /^(create|update|delete)_training_plan$/.test(next.name));
    }
    return true;
  }).map(userFacingToolResult);
}
