# MediaPipe 三档骨架分析

视频动作评估和聊天动作工具统一使用 MediaPipe Pose Landmarker。三个档位只改变权重，推理适配器、目标跟踪、测量、17 点证据、AI 识别及确认后的评价共用同一套流程。

| 档位 ID | 中文名称 | 权重 | 使用场景 |
| --- | --- | --- | --- |
| `mediapipe-lite` | 快速 | Pose Landmarker Lite | 低性能设备、快速分析 |
| `mediapipe-full` | 标准（默认） | Pose Landmarker Full | 日常视频分析 |
| `mediapipe-heavy` | 高精度 | Pose Landmarker Heavy | 上传视频后的精细分析；提示“精度更高，但分析时间更长” |

高精度是产品档位名称，具体视频上的提升与设备耗时仍需实测。更换档位清除本次骨架、测量、截图与结果；仅修改动作名称复用同模型数据。聊天缓存和服务端幂等键也包含档位 ID，不能跨档复用。

## 共用推理与三维数据

注册表位于 `public/motion-models.js`，唯一适配器为 `public/motion-mediapipe.js`。`createMediaPipe({model,delegate})` 按注册表选择 `.task` 文件；Worker 默认优先 GPU，失败后新建同档位 CPU 推理环境，不切换权重。WebCodecs、HTMLVideo 和 FFmpeg 三条视频解码路径均调用这一入口。

每个候选人物原生具有 33 个 `landmarks` 与对应 `worldLandmarks`，最多处理 4 人。跟踪器选择一个目标，两组坐标取自同一人物。世界坐标为米制 `[x,y,z,visibility]`，以髋中点为原点；图像坐标 `[x,y,visibility]` 用于定位、跟踪和回放。

三档均提取同一组 17 个身体点：鼻，以及双侧肩、肘、腕、髋、膝、踝、脚跟、前脚掌。原生下标为 `[0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]`，不发送面部细节和手指。保留 33 槽位中的原始索引，未使用槽位为 `null`。

统一传输协议为 `schemaVersion:6 / mediapipe-world17-full`；测量为 `motion-observations-3d-v1`、`coordinateSpace:'mediapipe-world-3d'`。模型版本区分 Lite、Full、Heavy，并带 `/ world3d-v1`。服务端核验所选档位与实际版本一致，不接受旧二维协议、其他引擎点表或错档报告。完整分包使用 `mediapipe-tables-f32-v1`，保留世界坐标的可还原编码。

角度使用三维向量，缺失深度、低置信度或画面不可见时保持 `null`，不补零、不退回二维角度。单目三维位置是模型估计，未进行相机和重力标定；数据语义详见 [MediaPipe 三维接入](MediaPipe三维接入.md)。

## 模型与运行库资产

固定使用 Tasks Vision 0.10.32、官方 float16 v1 权重。模型、JS 和 SIMD / 非 SIMD WASM 均从本服务同源按需加载，资源来源和 SHA-256 见 [manifest.json](../public/vendor/mediapipe/manifest.json)。各档不依赖其他档的模型文件。

| 文件 | 大小（字节） |
| --- | ---: |
| `pose_landmarker_lite.task` | 5,777,746 |
| `pose_landmarker_full.task` | 9,398,198 |
| `pose_landmarker_heavy.task` | 30,664,242 |

以上不包含共享运行库、WASM 或按需视频解码器。资源恢复与校验：

```powershell
node scripts/setup-motion-assets.mjs
node scripts/setup-motion-assets.mjs --verify
npm run motion:assets
```

运行时无需 Python、额外模型服务或服务器 GPU。模型缓存按需写入浏览器，更新需同步部署模块、Worker、资源清单及 Service Worker。

## 验证入口

`npm run qa:motion:mediapipe` 使用真实三档权重与视频、临时账号和本地受控 AI，核对 17 点三维数据、独立重算膝角、AI 上下文、单档资产请求、确认、修改、保存与取消；Full 额外验证共享解码路径及 GPU。

```powershell
# 三档各跑一次核心 CPU 路径，Full 同时验证页面确认流程
$env:QA_TIERS_ONLY='1'
node scripts/qa-motion-mediapipe.mjs
Remove-Item Env:QA_TIERS_ONLY

# 聊天入口（可设 QA_POSE_MODEL 为任一档位）
node scripts/qa-chat-motion.mjs
```

QA 不读取用户真实密钥、不调用收费 AI。通过表示模型、协议和交互链路可运行，不等于纠正准确率已验证；设备性能应在目标设备上测试。

2026-10-07 的三档 CPU 核心路径结果位于 `.qa/motion-mediapipe-VsuKqF/results.json`，三档均输出 8 / 8 帧世界坐标并通过三维角度重算；Heavy 聊天 GPU 路径位于 `.qa/chat-motion-W91yUU/results.json`。更多范围与本地受控 AI 的说明见 [浏览器验证](浏览器验证.md)。
