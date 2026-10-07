const groups={
  get_training_plan:['create_training_plan','update_training_plan','delete_training_plan'],
  read_calendar:['create_calendar_task','update_calendar_task','delete_calendar_task'],
  get_today_meals:['create_meal','update_meal','delete_meal'],
};
const mutations=new Set(Object.values(groups).flat());
export const initialChatTools=tools=>tools.filter(tool=>!mutations.has(tool.function.name));
export function expandChatTools(all,enabled,name,reads=new Set()){
  reads.add(name);
  const names=new Set([...enabled.map(t=>t.function.name),...(groups[name]||[])]);
  if(reads.has('get_training_plan')&&reads.has('read_calendar'))for(const tool of groups.get_training_plan)names.add(tool);
  else for(const tool of groups.get_training_plan)names.delete(tool);
  return all.filter(tool=>names.has(tool.function.name));
}
export const planningExecutionGuide = `用户说“帮我制定/安排/调整训练计划”就是执行要求，读取必要资料后直接保存并排期，不要重复请求确认。先读取档案、当前计划和日历；已有目标、器械和偏好应复用，只追问真正无法合理确定且影响执行的信息。用户明确提出减脂等计划目标时按该目标制定，不因档案旧目标不同而搁置，也不擅自改动档案目标。
繁忙日默认禁止安排训练。read_calendar 返回 busySettings、busyDates 和 availableDates；busyDates 仅覆盖读取范围，持续排期由完整 busySettings 约束。不要把日类型 rest 当作繁忙，也不要因没有训练记录而认为没有繁忙设置。无需询问繁忙日是否真的不能练。用户未指定星期时，依据空闲日选择与训练频率匹配的星期；旧计划备注中的一三五等规则不能覆盖繁忙限制。固定星期遇到繁忙日期由排期工具跳过并继续轮换动作，不得声称被跳过的日期已排训练。只有用户明确要求在具体繁忙日期训练才可填写 schedule.allowBusyDates 或 task.allowBusyDate；仅提到星期、要求制定计划或历史助手建议都不构成例外授权，不得通过清除繁忙设置绕过限制。
创建或更新训练计划须提交完整 plan（含 name 和 1–14 个 days 模板日）；days 不是实际日历日期列表，排期天数使用 schedule.days。只改排期时沿用读取到的完整计划，不能只传名称或备注。失败的校验不算一次成功变更，应修正后再执行，成功后不要重复提交。回复只说明真实保存结果、实际训练日期和必要建议，不罗列读取步骤、内部字段、版本或已修正的错误。`;
export const toolStatus=name=>({web_search:'正在联网搜索…',read_web_page:'正在读取公开网页…',assess_motion_video:'正在准备本机视频动作分析…',set_chat_visuals:'正在准备模型展示…',get_training_plan:'正在读取训练计划…',read_calendar:'正在读取训练日程…',get_today_meals:'正在读取今日饮食…',read_chat_context:'正在读取相关资料…',read_conversation_history:'正在查阅之前的对话…',read_chat_attachment:'正在查看之前的附件…'}[name]||(/^delete_/.test(name)?'正在删除记录…':/^create_|^update_/.test(name)?'正在保存记录…':'正在处理…'));
