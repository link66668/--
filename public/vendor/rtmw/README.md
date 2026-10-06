# RTMW-L 浏览器模型资源

此目录保留 OpenMMLab 发布的原始 FP32 ONNX 权重，没有重新训练、量化或改动网络。

| 用途 | 模型 | 输入 | 权重大小 |
|---|---|---|---|
| 人体检测 | YOLOX-tiny HumanArt | 416 × 416 BGR | 20,283,006 字节 |
| 全身关键点 | RTMW-L cocktail14 | 384 × 288 RGB | 229,320,930 字节 |

来源、ZIP 内原文件路径和 SHA-256 见 `manifest.json`。运行 `node scripts/setup-motion-onnx.mjs --verify` 校验本地资源，去掉 `--verify` 可从官方地址恢复。两份 ONNX 源于 [OpenMMLab RTMPose 模型库](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose)；代码许可证见本目录 `LICENSE`。

## 接口与数据含义

`public/motion-rtmw.js` 在 Worker 内加载本地 ONNX Runtime Web 1.30.0。优先 WebGPU，部分算子使用 WASM；WebGPU 初始化失败由视频流程新建 Worker 回退 WASM。WASM 单线程，无需跨源隔离或第三方 CDN。每个不同的采样画面运行人体检测，最多处理分数最高的 4 人，随后由空间连续性跟踪器选择训练者。产品使用 7.5 Hz 分析；底层 `analyzeVideo({sampleFps})` 保留默认 15 Hz 兼容。WebCodecs 将同一解码画面分配到多个采样位置时，仅在 canvas 对象和源时间戳都相同的情况下复用模型结果；采样位置、源时间和跟踪状态仍逐项保留。HTMLVideo 与 FFmpeg 路径没有这种源帧身份保证，仍逐次推理。FFmpeg 预览每三个采样取一个画面，实际时间对应 7.5 Hz 下的 2.5 Hz 预览或 15 Hz 下的 5 Hz 预览。

默认 `auto` 目标选择综合位置、检测支持的身体面积和关节完整度；手动点选保持优先，历史 `center` 元数据兼容。空间跟踪保留 3 秒短暂失锁恢复窗口，拒绝从完整目标突然接入尺寸显著增大且身体支持不足的近镜头遮挡者；无法区分的真实交叉仍停止跟踪。

RTMW 原始 133 点保持 COCO WholeBody 顺序，输出归一化图像坐标 `x/y` 和原始 SimCC `score`。没有深度、世界坐标和可见性概率。置信分数按 [MMPose SimCC 解码](https://github.com/open-mmlab/mmpose/blob/main/mmpose/codecs/utils/post_processing.py) 取两轴最大响应中的较小值。**分数可能大于 1，不是概率**。映射到现有 33 点接口时，`visibility` 仅为截断到 `[0,1]` 的兼容过滤值，不是经过标定的可见性概率；原始分数仍保存在 133 点数据里。眼角和嘴角等未建立一致解剖对应关系的点置为 `null`，不补造 `z/presence/worldLandmarks`。

检测图像使用 BGR、右下补 114；姿态裁剪按检测框扩大 1.25 倍并保持 288:384 比例，边界补黑，使用 RGB 与官方 mean/std。SimCC split ratio 为 2，开启官方 `flip-test`：直接水平反转已归一化的 NCHW 张量，按官方 133 点左右对应关系交换关节，仅还原 X 方向；先平均两次原始 SimCC 响应再解码，不加热图偏移。WebGPU 用动态 `batch=2` 合并原图与翻转图，CPU 保留两次顺序推理。初始化预热实际使用的批大小，GPU 批推理不兼容会触发现有 CPU 回退。浏览器 Canvas 插值可能与训练/桌面 OpenCV 插值有少量数值差异。

模型内部仍输出完整 133 点。产品默认回放和上传采用 `fitness-body17` 主要身体点（鼻与双侧肩、肘、腕、髋、膝、踝、脚跟、前足），上传格式为 `schemaVersion:3 / rtmw-body17-full`；显示平滑不改变原始推理数据。绘图的 `detail: 'wholebody'` 和旧版 133 点传输保留完整细节兼容。界面先用 `reviewMode: 'recognize'` 将代表骨架时序、全段测量统计和最多 6 张关键图片交给动作 AI 识别动作；用户确认或修改后，复用同一份本机证据，以 `reviewMode: 'guided'` 评价确认的动作，确认前不评价、不保存报告。`efficient`、`temporal` 和 `full` 保留兼容，分别用于关键图片、时序摘要和完整数据审阅。节点显示简化不代表模型本身变为 17 点或网络推理计算量减少。

上游 ZIP 的 `rtmw-pipeline.json` / `rtmw-detail.json` 中部分输入尺寸仍写为 192 × 256，属于上游附带元数据；本项目核验了 ONNX 图的实际输入为 `[batch,3,384,288]`，输出为 `[batch,133,576]` 与 `[batch,133,768]`，按实际网络尺寸运行。

## 已验证范围

在开发机 Edge 的真实 ONNX Runtime 上，对深蹲视频抽取的同一帧测试：WASM 与 WebGPU 均检测到 1 人，输出 133 点，身体点坐标基本一致。真实 Classic Worker 和项目 CSP 也已验证。

2026-10-04 同一真实裁剪上的 GPU 数值与速度复核：顺序两次推理和动态 `batch=2` 的全部 SimCC 响应最大差为 0；5 次运行去掉首次后的姿态网络中位耗时为 75.7 ms 和 46.8 ms（降低约 38.2%）。这不包括人体检测、模型加载、全片解码或 AI 耗时，也不是其他设备的速度承诺。1 秒、5 FPS 的真实视频另验证了重复源帧复用：实际推理 5 次，保留 15 个采样结果并全部锁定目标。模型数值一致及人体可检测不能证明当前验证范围内 5 类主流动作的识别、标准评价或纠正建议准确率达标。

另外用相同 1080 × 1920 图像、相同检测框，与 OpenCV 官方裁剪公式和 Python ONNX Runtime 比较。适配 Canvas/OpenCV 像素中心差异后，身体 17 点平均坐标差为 0.351 像素，最大 2.982 像素；133 点平均差为 0.233 像素。完全相同输入张量下，两套 ONNX Runtime 的最大输出差为 `1.72e-5`。此结果只覆盖该测试帧，验证预处理与推理连通，不能证明项目健身数据集上的准确率提高。

运行 `node scripts/qa-motion-rtmw.mjs` 复现浏览器和 Worker 检查；将环境变量 `QA_PYTHON` 指向已具备 numpy、opencv-python、onnxruntime 的开发 Python，可同时运行数值对比。脚本不安装依赖，不调用付费 AI，不上传视频。完整帧、张量和对比结果存入忽略提交的 `.qa/motion-rtmw-*` 目录。

RTMW-L 权重大且逐帧耗时明显，手机和低性能设备的内存、速度与兼容性需要真机验证。
