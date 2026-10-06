<!-- 历史设计与验证记录；其中姿态引擎方案已被替换，当前 MediaPipe 三档流程见 docs/视频动作评估.md。 -->
# 开放动作识别实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 识别目录外动作，保留真实名称，普通引体向上不再强制映射为辅助引体向上。

**Architecture:** 视觉识别返回独立的动作名称和可选目录 ID、可选运动家族。只有精确匹配目录且满足识别条件时才提供教学映射；已有运动家族用于连续姿态重评，开放名称本身不能创造分数或次数。

**Tech Stack:** 原有浏览器 JavaScript、Node ESM、SQLite、node:test 与本地 Playwright QA。

## 约束与接口

- 保留原 32 个评估 ID、25 个教学 ID 和旧 `pullup` 的辅助引体语义。
- `action` 新增 `name`、`family`、`evidence`；目录外确认使用 `exerciseId:null`。
- 确认需视觉模式、高置信、两个实际画面时间和具体依据；无图和证据不足仍保留未知/候选。
- `confirmedMotionAction(coach)` 为共享校验入口，返回可信动作或 null；模型输出不能绕过既有卧推/划船条件。
- 引体观察包含负重器械、悬垂支撑及 `assistance`（none/machine/band/partner/unknown）。辅助名称必须有助力证据，辅助不明时保留明确的待确认表述。
- 连续骨架支持 `exerciseHint:{family}`，不借用某个教学 ID 代替开放动作。
- 已确认名称保存至报告 `exerciseName`，来源 `recognitionSource:'visual'`，历史与标题一致。
- 仅匹配目录才显示相应 3D 教学；未支持家族、质量失败或家族冲突均不评分。家族通用评估保留部分证据限制和全部原失败证据。
- 不新增依赖，初始回归不调用真实用户模型；用户随后明确要求本地五段视频实测，已使用当前配置的视觉模型，不宣称真人识别准确率。

## Task 1: 识别与评分契约

**Files:** `public/motion-catalog.js`、`public/motion-contract.js`、`tests/motion-open-recognition.test.mjs`。

- [x] 先写目录外引体/壶铃动作、普通与辅助引体互斥、缺证据、文本模式、家族未知及硬质量否决回归。
- [x] 跑 `node --test tests/motion-open-recognition.test.mjs`，确认新增行为失败。
- [x] 实现独立名称及家族清洗、共享确认函数、辅助证据条件和开放动作合并；已支持家族使用通用检查，未知家族保留视觉反馈而不沿用错误规则。
- [x] 跑新测试与 `tests/motion-recognition.test.mjs`、`tests/motion-coach.test.mjs`、`tests/motion-http.test.mjs`，确认旧证据与评分门槛保留。

## Task 2: 家族提示重评

**Files:** `public/motion-analysis.js`、`tests/motion-analysis-v2.test.mjs`。

- [x] 先测 `{family:'vertical-pull'}` 可重评且 ID 为空、未知家族无效、真正类别冲突不接受、半身单臂与质量否决不回退。
- [x] 验证失败后实现家族提示，复用既有几何兼容检查，保持原精确 ID 提示行为。
- [x] 跑 `node --test tests/motion-analysis.test.mjs tests/motion-analysis-v2.test.mjs`。

## Task 3: 模型请求、显示与保存

**Files:** `server/motion-coach.mjs`、`public/motion-view.js`、`scripts/qa-motion-coach.mjs`、提示词测试与视频评估文档、缓存版本。

- [x] 增加提示词与真实 HTTP/浏览器回归：目录外名称可保存/刷新，普通引体无辅助教学链接，旧辅助记录名称保持。
- [x] 提示词开放名称、要求可选家族和真实助力证据；界面按可信名称呈现并进行家族重评。
- [x] 跑 `node scripts/qa-motion-coach.mjs --reports-only`，检查移动端与保存后回显。
- [x] 更新资源版本、文档，跑 `npm.cmd run check` 与完整测试，分别报告既有资产哈希失败。

## Task 4: 用户追加授权的真实视频测试与衍生修复

**Input:** `D:\测试` 下五段用户提供的本地视频；原文件保持不变，产物只写入忽略目录 `.qa/`。

- [x] 真实 MediaPipe 提取五段视频，人工查看完整画面，实际生成每段六张关键帧。
- [x] 使用用户当前动作点评视觉模型 `deepseek-flash` 实测五种动作；俯卧撑观察枚举不一致时澄清提示词并重试。
- [x] 修复不可信低覆盖骨架否决可靠视觉名称的问题，保留全部质量评分限制和可靠轨迹冲突；先补失败回归。
- [x] 复现直腿坐姿划船错入提踵，扩展方向证据并禁止明显上肢动作兜底为提踵；先补失败回归。
- [x] 独立审查发现拖弯举与划船的投影重叠，补回归并保留站姿屈伸肘候选，避免新规则排斥正确弯举提示。
- [x] 用相同真实帧与模型响应重放，验证五种名称、普通引体非辅助、卧推与划船不评分；追加卧推手动目标选择对比。
- [x] 五份真实报告通过隔离 HTTP 保存、刷新、浏览器历史回显及移动端布局测试。

**Verification:** 完整测试 446 项、444 通过；剩余两项为既有 MP4Box/MediaPipe 文件 CRLF 与清单 LF 哈希差异。语法检查通过，模拟上游的 HTTP/浏览器回归通过，真实模型响应的五份报告浏览器回归通过。卧推和划船跟踪覆盖仅约 27.2%/43.4%，名称已确认但连续姿态评估仍不可用；不能宣称全部动作的识别准确率。
