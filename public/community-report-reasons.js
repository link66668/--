export const COMMUNITY_REPORT_REASONS = [
  ['sexual', '色情低俗'],
  ['political', '政治敏感'],
  ['fraud', '诈骗信息'],
  ['racism', '种族歧视'],
  ['offsite', '站外导流'],
  ['illegal', '违法违规'],
  ['spam', '低差广告'],
  ['unfriendly', '不友善、引战'],
  ['engagement', '诱导关注点赞'],
  ['minors', '涉未成年人'],
  ['cyberbullying', '网络暴力'],
  ['self_harm', '疑似自残自杀'],
  ['irrelevant', '笔记不相关'],
  ['other', '其他']
];

export const COMMUNITY_REPORT_REASON_LABELS = {
  ...Object.fromEntries(COMMUNITY_REPORT_REASONS),
  copyright: '侵权'
};
