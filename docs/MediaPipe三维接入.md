# MediaPipe 三维坐标接入

快速 Lite、标准 Full（默认）和高精度 Heavy 均使用 MediaPipe Pose Landmarker 原生 `worldLandmarks`，每个采样画面只运行用户选定档位的一次姿态推理。独立动作评估页与对话中的 `assess_motion_video` 使用同一流程，档位与模型资源见 [MediaPipe 三档接入](MediaPipe三档接入.md)。

## 坐标与测量

- `landmarks` 保留图像归一化 `x、y、visibility`，用于人物跟踪、骨架回放与截图定位。
- `worldLandmarks` 保留原生 `x、y、z、visibility`，坐标单位为米、原点为髋中点；不是把图像坐标的 `z` 当作米制深度。
- 两组点按同一人物索引配对。目标丢失或该人物没有三维结果时，三维数组为空；不借用旁人的坐标或补零。
- 原模型输出 33 点；发送给服务器和 AI 的身体子集为 17 点，包括鼻、肩、肘、腕、髋、膝、踝、脚跟及前脚掌，不发送面部细节和手指。
- 肘、肩、髋、膝与身体对齐角使用三维向量计算。相关图像点必须在画面内且可信，三维值也必须完整且可信；未知角度保持 `null`，不退回二维角度。
- `torsoLean` 是肩髋连线相对模型相机 Y 轴的无符号三维倾角（0–90°），没有相机或重力标定。

单目三维坐标仍是模型估计值，不能当作精准的物理测量。髋中点逐帧作为原点，不适合据此推算人物在房间中的整体位移、速度或受力。语义依据 [MediaPipe 官方 Pose Landmarker 文档](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)。

## 数据协议与 AI

模型版本追加 `/ world3d-v1`。完整采样协议为 `schemaVersion:6 / mediapipe-world17-full`，保留 MediaPipe 原生索引的 33 个槽位，其中未使用的槽位为 `null`：

```js
pointFields: ['x', 'y', 'visibility']
worldPointFields: ['x', 'y', 'z', 'visibility']
// frames[i].landmarks：二维位置
// frames[i].worldLandmarks：三维米制位置
```

三维点可为 `[x,y,z,visibility,missingMask]`，可选掩码的位 0–3 分别表示四个字段不存在；显式 `null` 与不存在字段、零值保持区分。负坐标和超出 `[0,1]` 的米制坐标合法。没有三维观测的帧也保留空数组。

测量使用 `motion-observations-3d-v1`，声明 `coordinateSpace:'mediapipe-world-3d'`。服务端拒绝三维骨架搭配二维测量，或新版模型使用旧二维协议。仅接受这套三维协议，不保留旧二维骨架协议。

默认 guided 模式将选定代表帧的二维与三维点一并发送给视觉 AI，`poseSchema.measurementCoordinateSpace`、`worldPointFields`、单位和原点明确解释各字段。置信度为第四项，不能把第三项深度误作置信度。全部测量仍参与时序统计；默认 24,000 字符骨架证据预算内可能减少代表帧。完整 full 模式按批发送全部采样数据。

报告保存实际模型版本与 `analysis.coordinateSpace`，不持久保存原始骨架或视频。Service Worker 缓存版本同步升级，避免新旧模块混用。

## 验证

相关专项测试包含三维角度与二维投影不同、缺失深度、置信度门槛、多人对应、协议一致性、长短视频预算及供应商请求数据测试。

`npm run qa:motion:mediapipe` 使用真实 Lite / Full / Heavy 权重和视频，检查三个档位的统一三维数据，使用 Full 覆盖共享的 WebCodecs、HTMLVideo、FFmpeg 解码及 CPU/GPU，验证 AI 实际请求中的非零深度、独立重算的三维膝角、页面切换与报告保存。`npm run qa:chat:motion` 验证对话入口。QA 使用本地受控视觉回复，流程通过不表示 AI 纠正准确率已验证。
