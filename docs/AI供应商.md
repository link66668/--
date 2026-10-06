# AI 供应商与模型配置

## 使用方法

1. 登录后打开「个人设置 → AI 服务」。
2. 选择供应商，粘贴该供应商开放平台的 API Key。
3. 点击「获取模型」，搜索并选择需要的模型，然后保存。每个模型可设置「支持图片」「仅文本」或「图片能力待确认」。如果接口未返回能力信息，请按模型实际能力确认后保存。
4. 为 AI 对话、餐食分析、计划复盘和动作点评分别选择模型。动作点评必须使用已确认支持图片的模型，同时接收所选骨架模型（标准 MediaPipe Full、高精度 RTMW-L 或 YOLO26s-Pose）的数据与视频关键截图；未配置或仅支持文本时无法开始评估。骨架模型默认使用标准 MediaPipe Full，其原生三维点用于角度计算和 AI 证据；RTMW-L 与 YOLO26s-Pose 保持二维。

四类任务分别保存供应商与模型选择。`chat` 对话模型负责理解请求和调用工具；`motion` 动作点评模型负责根据视频证据先识别动作，用户确认或修改后，再评价该动作。两次动作请求均使用 `motion` 配置，可以与对话模型相同，也可以不同；不会因为聊天调起动作评估就自动改用 `chat` 模型。对话入口要求对话模型支持工具调用，动作点评本身不向视觉模型提供业务工具。模型配置与骨架档位是两项不同设置。

联网搜索由应用作为工具提供，未保存搜索设置时默认启用 Exa MCP 免密钥搜索；模型供应商密钥不会被用作搜索密钥。对话、餐食和规划任务可按需联网，具体模型接口仍需支持工具调用。详见[联网搜索](联网搜索.md)。动作识别与评价仅使用用户视频的骨架、测量和截图证据，不挂载联网工具。

常用供应商已预填接口地址与协议。使用本地模型、代理或其他供应商时，选择「自定义供应商」，在高级设置填写接口地址。供应商网站的聊天会员与开放平台 API Key 通常属于不同产品，请从配置页的密钥入口创建 API Key。

模型名称从供应商接口实时读取，没有内置容易过期的模型清单。模型列表可能含有其他用途的模型；接口提供明确的能力信息时会据此筛选或标注，缺少信息时保留“未知”。列表获取成功表示模型查询接口可用，实际对话还取决于该模型的接口支持、权限和额度。

## 预设与官方依据

核对日期：2026-09-28。以下为官方文档确认的请求配置；尚未使用用户的真实密钥逐家进行付费推理验证。

除 Anthropic、Gemini 外，下表均使用 `Authorization: Bearer <API Key>`。对话接口采用 OpenAI Chat Completions 格式。

| 供应商 | 对话基础地址 | 模型查询 | 官方文档 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `GET /models` | [List Models](https://api-docs.deepseek.com/api/list-models/) |
| 硅基流动（中国） | `https://api.siliconflow.cn/v1` | `GET /models?sub_type=chat` | [List Models](https://docs.siliconflow.cn/docs/api/models-get) |
| Kimi / 月之暗面（中国） | `https://api.moonshot.cn/v1` | `GET /models` | [列出模型](https://platform.kimi.com/docs/api/list-models) |
| 阿里云百炼（国际，新加坡） | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `GET https://dashscope-intl.aliyuncs.com/api/v1/models` | [查询模型列表](https://help.aliyun.com/zh/model-studio/list-models)、[地域与接入点](https://www.alibabacloud.com/help/en/model-studio/regions) |
| OpenAI | `https://api.openai.com/v1` | `GET /models` | [Models · OpenAI API Reference](https://developers.openai.com/api/reference/resources/models) |
| Anthropic / Claude | `https://api.anthropic.com/v1` | `GET /models` | [List Models](https://platform.claude.com/docs/en/api/models/list) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `GET /models` | [Models](https://ai.google.dev/api/models) |
| OpenRouter | `https://openrouter.ai/api/v1` | `GET /models` | [List all models and their properties](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) |
| Groq | `https://api.groq.com/openai/v1` | `GET /models` | [Supported Models](https://console.groq.com/docs/models) |
| xAI / Grok | `https://api.x.ai/v1` | `GET /language-models` | [Models](https://docs.x.ai/developers/rest-api-reference/inference/models) |
| Mistral AI | `https://api.mistral.ai/v1` | `GET /models` | [Models Endpoints](https://docs.mistral.ai/api/endpoint/models) |
| Cerebras | `https://api.cerebras.ai/v1` | `GET /models` | [List models](https://inference-docs.cerebras.ai/api-reference/models/list-models) |

### 原生协议

- **Anthropic**：发送 `x-api-key` 和 `anthropic-version: 2023-06-01`。对话请求发往 `/messages`；系统指令单独放在 `system`，图片与 PDF 转换成 Anthropic 内容块。[官方 API 文档](https://platform.claude.com/docs/en/api/messages/create)
- **Gemini**：发送 `x-goog-api-key`。对话请求发往 `/models/{模型 ID}:generateContent`；系统指令用 `systemInstruction`，消息用 `contents`。模型列表只保留声明支持 `generateContent` 的条目。[官方模型接口](https://ai.google.dev/api/models)、[内容生成接口](https://ai.google.dev/api/generate-content)

### 地域与账号

- 百炼国际预设使用新加坡地域。中国地域、国际地域、Coding Plan 等密钥和端点必须匹配。中国北京地域的当前模型查询文档需要业务空间专属域名，因此没有把它列为“只填写密钥”的固定预设。[模型查询](https://help.aliyun.com/zh/model-studio/list-models)、[地域与接入点](https://www.alibabacloud.com/help/en/model-studio/regions)
- Kimi 中国预设使用 `platform.kimi.com` 的开放平台密钥。国际平台 `platform.kimi.ai` 的密钥不可与中国端点混用。[官方说明](https://platform.kimi.com/docs/api/list-models)
- 没有公开、已核对模型发现接口的服务仍可通过自定义配置接入，并手动填写模型 ID。未把网页上的产品型号冒充该账号实时可用的模型。

## 模型能力与开发约定

连接事实统一维护在 `public/provider-presets.js`，前后端共用 `providerPresets` 与 `getProviderPreset(id)`。`baseUrl` 包含接口需要的版本路径；DeepSeek 官方允许直接使用根地址。可选 `modelsUrl` 指定模型发现的专用端点，不能把这个地址当作对话地址。

模型响应包括以下常见结构：

| API | 模型数组 / 分页 | 图片能力的明确依据 |
| --- | --- | --- |
| OpenAI 兼容格式 | `data[]` | 仅在响应提供能力字段时使用；标准 OpenAI Models 响应未给出视觉能力 |
| Anthropic | `data[]`，`has_more`、`last_id` → `after_id` | `capabilities.image_input.supported` |
| Gemini | `models[]`，`nextPageToken` → `pageToken` | `supportedGenerationMethods` 只说明调用方式，不能单独证明支持图片 |
| DeepSeek | `data[]` | `input_modalities` 包含 `image` |
| Kimi | `data[]` | `supports_image_in` |
| OpenRouter | `data[]` | `architecture.input_modalities` 包含 `image` |
| xAI 语言模型接口 | `models[]` | `input_modalities` 包含 `image` |
| Mistral | `data[]` | `capabilities.vision`；`capabilities.completion_chat` 标明对话能力 |
| 百炼模型接口 | `output.models[]`；递增 `page_no` 直到达到 `output.total` | `inference_metadata.request_modality` 包含 `Image` |

自动能力标注来自返回字段，不因为模型名包含 `vision`、`VL`、`GPT`、`Claude`、`Gemini` 等词就推断支持图片。未知能力保留未知，不能把“没有该字段”当作明确不支持。用户可以在管理模型中手动确认真实能力，保存后仍保留该选择，适用于自建服务或未返回能力的兼容接口。

保存供应商时，若动作点评尚未配置，只会从已启用且明确支持图片的模型中选择；供应商默认模型仅支持文本或能力未知时不会直接用于动作点评。已有任务选择保持不变，用户可在任务模型设置中调整。

这些预设参考了本地 Cherry Studio 的供应商注册表和适配器结构，并逐项查阅供应商官方接口资料。本次没有修改 Cherry Studio 项目。

- 本地参考：`cherry-studio/packages/provider-registry/data/providers.json`
- 本地参考：`cherry-studio/src/main/ai/provider/custom/`
