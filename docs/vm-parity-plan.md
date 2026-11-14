# Vector Magic 1.15 → 本网站 功能对齐方案

生成时间：2026-11-14　依据：D:\Vector Magic\vmde.exe 内嵌帮助文档（已解出 243 篇 HTML，含中/英/德/法/西/意）、
Samples/Sample Output（4 套官方输出：SVG / AI / EPS / PDF / EMF / DXF）、release_notes.txt（1.0 → 1.15 全部功能演进）。

参考语料（本次解出，仅本地标定用，不要提交到站点仓库）：
- `D:\hermes\cache\scratch\vm-help\` — 243 篇内嵌帮助 HTML，官方功能语义的唯一权威文本
- `D:\Vector Magic\Samples\Sample Output\` — 官方输出 ground truth

---

## 一、目标软件的真实功能面（证据：内嵌帮助 + release notes）

向导流程（Basic / Advanced 两套模式）：

| 步骤 | 功能 | 参数细节（来自帮助原文） |
|---|---|---|
| Load Image | 打开/MRU/剪贴板粘贴/拖放、批量添加 | 批量：Add Images → Batch Settings → Batch Summary |
| Transparency | 保留透明 / 扁平化到指定背景色；悬停即预览 | 1-bit alpha（GIF）须按抗锯齿底色扁平化，否则边缘出杂色 |
| Image Type | Photograph / Artwork with Blended Edges / Artwork without Blended Edges；载入时自动分类并预选 | — |
| Detail / Input Quality | Photograph：High/Medium/Low **输出**细节；AA-Artwork：High/Medium/Low **输入**质量（边界混合 ≤1px / ≤2px / >2px）；Aliased-Artwork：High/Medium/Low | 描述输入质量，不是输出 |
| Color Mode | Two Colors / Fixed Palette / Flexible（默认） | Fixed：2–24 色；12 个 Quick Palettes 预置，箭头标记推荐档；自定义色板可增/删/改色，吸管取色，Ctrl+吸管取区域均值 |
| Image Segmentation（高级） | Complexity 滑块、Minimum Pixels、Anti-Aliasing Artifact Rejection、Color Clustering | AA 伪影剔除被官方推荐用来替代最小像素 |
| Edit Segmentation（高级） | 工具：Drag / **Adapt（点一下把碎片并入邻居）** / Fill / Pencil / Color(吸管)；Undo / Redo / Revert | 修复断线、抗锯齿残留、错色区域 |
| Path Smoothing（高级） | Smoothness、Detect Sharp Corners、Number of Nodes | 官方建议：先大节点数调平滑度，再压节点数 |
| Review Result | 结果复核 + 故障排查入口 + 可跳过 | — |
| Export | SVG / PDF / EPS / AI / EMF / DXF（+ 结果位图导出）；Save As、拖放导出、Quick Save | 高级导出选项：是否描边形状边界（stroke）、形状叠放顺序、是否按颜色分组、DXF 是否用样条 |
| 其它 | 背景移除（1.13）、保存/复用高级设置、i18n 6 语言、批处理 | — |

输入格式：ImageMagick 全量（BMP/JPG/PNG/GIF/TIF/PBM/PPM/XPM…），CMYK 图像可读。

## 二、现有网站已具备（index.html 2654 行 + vendor/vm-tracer.js 34KB）

引擎：VMTracer（覆盖率反解 + marching squares + 贝塞尔拟合，已按官方 4 张 SVG 标定）+ ImageTracer 经典引擎
已有：4 档线条拟合、主色数 2–64、最小面积、降噪/平滑/锐化、CMYK 微调、描边宽度、颜色面板、图层面板、
编辑器（选择/绘制/填充/套索/吸管/撤销/还原）、路径简化、AI 放大（ESRGAN 2×/4×）、缩放、导出 SVG / 印刷 PDF(DeviceCMYK)

## 三、差距矩阵（缺什么）

| # | Vector Magic 功能 | 现状 | 缺口性质 |
|---|---|---|---|
| 1 | 三种图像类型 + 输入质量三档 + 自动分类 | 无（只有 4 档"线条拟合"） | 引擎参数映射 + UI |
| 2 | 颜色模式三分支（双色/固定/灵活） | 只有"主色数 N" | 算法：双色模式、固定色板强制映射 |
| 3 | Quick Palettes ×12 + 自定义色板增删改 + Ctrl 均值吸管 | 只有结果色板的展示/替换 | UI + 采样算法 |
| 4 | 透明度：保留 / 扁平化到指定底色 | 无（透明被当白色） | 引擎：alpha 参与覆盖率反解 |
| 5 | 分割编辑 Adapt（并入邻居） | 无 | 引擎：label 重写 + 邻接合并 |
| 6 | 平滑度 / 尖角检测 / 节点数 三独立参数 | 合并成 1 个"线条拟合" | 引擎参数拆分 |
| 7 | AA 伪影剔除、Color Clustering、最小像素 | 部分（最小面积） | 引擎 |
| 8 | 导出 EPS / AI / EMF / DXF + 描边/叠放/分组/样条选项 | 只有 SVG + PDF | 纯前端写文件（可完全离线实现） |
| 9 | 批处理 | 无 | UI + 队列 |
| 10 | 保存/复用设置、Review 页、背景移除 | 无 | UI + 简单算法 |

## 四、执行阶段（按可验证性排序）

**S0 基线（已完成）**：内嵌帮助解包、官方输出清点、现状通读。
**S1 导出格式补齐**（纯 JS，零算法风险，立竿见影）：EPS / AI(PostScript+PDF 兼容) / EMF / DXF 写出器 + 4 个导出选项；用官方 Sample Output 做逐字段对照（同一路径数据，比结构不比字节）。
**S2 向导式 UI 对齐**：图像类型 / 输入质量 / 颜色模式 / 固定色板+Quick Palettes / 透明度三态；参数映射到现有 vm-tracer 选项。
**S3 引擎参数拆分**：smoothness / corner / nodes 三项独立；双色模式；固定色板强制映射；alpha 反解；AA 伪影剔除 + color clustering。
**S4 ground truth 标定**：用 Vector Magic 自身的批处理功能，把 20–30 张测试图（logo 类 / 照片类 / 抗锯齿 / 硬边缘 / 透明 / 低质 JPEG）自动出 SVG，建立标定集；对 JS 引擎跑栅格化差异（SSIM + 边界偏移）+ 节点数/形状数对比，逐参数回归。
**S5 剩余功能**：分割编辑 Adapt、批处理、保存设置、背景移除、Review 页。
**S6 回归与验收**：一份 tests/ 脚本，对每阶段产物做可重复检查；站点保持单文件 + vendor 结构不变。

## 六、执行进度

### S0 基线 —— 已完成
- 内嵌帮助解包到 `D:\hermes\cache\scratch\vm-help\`（86 篇去重后的多语言 HTML）
- 官方输出清点：`D:\Vector Magic\Samples\Sample Output\` 27 个文件，4 组样例 × 6 格式
- craft-anything 实证：vmde.exe 为 PE / x86 32-bit / Qt4 / 已 strip，导入 QtCore4+QtGui4+QtNetwork4、
  MSVCP71、**lapack_win32**（说明核心数学走 LAPACK，与 Diebel 2008 的最小二乘/贝叶斯拟合路线一致）

### S1 导出格式补齐 —— 已完成（2026-11-14）
新增 `vendor/vm-export.js`（约 900 行，零依赖，浏览器/Node 通用）+ 站点 `操作` 面板里的导出栏。

| 格式 | 实现 | 验证 |
|---|---|---|
| SVG（可分组重排） | 模型重排后重写 | 8 个 path 保真，viewBox 保持 |
| EPS | PS Level 2，`translate+scale(1,-1)` 翻 y，自包含 prolog | 用官方样例：M15/C92/L4 与源 SVG **逐条相等**，`%%BoundingBox 0 0 250 250`，`%%EOF` 收尾 |
| AI | PDF 1.4 内核（Illustrator/CorelDRAW/Inkscape 通用） | xref 偏移全对，MediaBox 250×250，stream /Length 自洽 |
| PDF（RGB） | 同上，独立 DeviceRGB 写出器（与既有 CMYK 印刷 PDF 并存） | 同上；Chrome 渲染截图确认图形/曲线/镂空正确 |
| EMF | 手写二进制记录链（HEADER/POLYBEZIERTO16/POLYLINETO16/FILLPATH/STROKEPATH/EOF） | 记录链自校验：89 条记录累计字节数 = 文件长度 = 头 nBytes，末记录 EOF，签名 0x464D4520 |
| DXF | R2000/AC1015，LAYER 表 + 每形状一图层，曲线离散成 LINE；可选 3 阶 SPLINE | 1610 段 LINE / 15 条样条，SECTION/ENDSEC 平衡，EOF 收尾 |

导出选项（对齐 VM 的高级导出选项）：描边形状边界、叠放顺序（描摹序/大→小/小→大）、按颜色分组、DXF 用样条。
站内端到端测试：合成测试图 → 5 形状 → 六种格式全部导出成功，按钮文案与状态栏联动正常。

### S2 向导式 UI 对齐 —— 待做
### S3 描摹质量对齐（第一轮标定，2026-11-14）—— 已完成
参照物：`C:\Users\Administrator\Desktop\ScreenShot_2026-10-24_173722_035.pdf`（Vector Magic 输出的官方 PDF，
MediaBox 507×258、10 个形状、10 色）＋同源 PNG。量化工具：`tools/vm-diff.py`。

三个真实缺陷（都是量出来的，不是猜的）：

| 缺陷 | 后果（对源位图的 MAE / >32 像素占比） |
|---|---|
| 旧量化器把「面积 <0.6% 的色」和「落在两主色连线上的过渡色」并掉 → 2px 深色外框（0.78%）、红白过渡带（0.56%）整层消失 | 0.0168 / 4.26%（官方 0.0087 / 1.87%） |
| 引擎自适应降噪（blurIters 2–3）把 1–2px 结构糊掉 | blur=2 时 0.0153，blur=0 时 0.0112 |
| `toPDF` 用 `0 0 0 rg` 铺满版黑底，且用 `cm` 做 y 翻转（第三方解析器读到的几何被二次翻转） | PDF 实测 0.0645 / 13.22%，与 SVG 严重不一致 |

修复：
1. `quantizeToColors` 换成**贪心新颖度选取**：每次取 `sqrt(面积) × 到已选色最小距离` 最大的色箱，
   距离 <8 自动并（近白不再被拆成六层），小面积高对比色（外框、混色带）得以保留 → 自动得到
   与官方一致的 `红(223,24,26) / 白(254,254,254) / 深灰(42,42,42) / 混色(187,127,131)`。
2. 引擎默认参数按实测重标：`blurIters=[0,0,1,2]`、`level=[0.44,0.44,0.46,0.48]`、
   `cornerThresh=[0.8,0.9,1.0,1.2]`、`bezierTol=[0.10,0.15,0.25,0.50]`。
3. `toPDF` 底色改正白、坐标预先翻转成 PDF 的 y-up（与官方内容流同构，第三方工具可直接读）。

第一轮标定（同一张图，同一栅格化器 ss=2，与源位图比）：

| 来源 | 形状数 | MAE | >8/255 | >16/255 | >32/255 |
|---|---|---|---|---|---|
| 改前 | 3 | 0.0168 | 9.31% | — | 4.26% |
| 改后 SVG（第一轮） | 6 | 0.0099 | 6.26% | 3.40% | 1.30% |
| 改后 PDF（第一轮，含黑底 bug） | 6 | 0.0645 | 17.09% | 15.00% | 13.22% |
| 官方 PDF（参照） | 10 | 0.0087 | 7.60% | 5.03% | 1.87% |

第二轮（2026-11-14，调色板判据改为「扁平色 + 非混合的薄结构色」）最终结果：

| 案例 | 本站 MAE | 本站 >32 | 官方 MAE | 官方 >32 |
|---|---|---|---|---|
| 用户验收图（红底新月五星截图） | **0.0092** | **1.62%** | 0.0087 | 1.87% |
| 官方样本 Logo With Blending（抗锯齿图稿） | **0.0071** | 2.34% | 0.0027 | 1.09% |

结论：简单图形（大色块 + 少量抗锯齿边）已到官方水平；复杂抗锯齿图稿仍有 2.6 倍 MAE 差距，
表现为形状轮廓上一圈 1px 宽的亚像素偏移，几何形状与配色分解一致。

### S4 二轮标定（候选，未做）
- 共享边界几何：同一条轮廓只算一次，供两侧颜色共用，消除「洞」与「白形状」两条独立曲线之间的亚像素缝
- AA 伪影剔除（官方 Image Segmentation 页同名功能）：混色带被当作独立色层时清理碎片
- 逐边界最优化 iso-level，而不是全局 0.44

### S5 剩余功能 —— 待做

## 七、引擎（两个 skill 的真实运行环境）

| 组件 | 位置 | 状态 |
|---|---|---|
| craft-anything-cli 0.6.1（portable，含 GUI） | `D:\hermes\tools\craft-anything\` | 已验证：`triage` 通、`mcp` 子命令 stdio 握手成功；MCP 已写进 config.yaml |
| REA MCP 6.8.0 | `D:\hermes\tools\rea\` | 已验证 stdio 握手 + tools/list；`mcp_servers.rea.enabled: true` |
| Ghidra / IDA / JADX / adb / frida | — | 均未安装（两者都缺原生死代码反编译能力） |

两个 MCP server 需要重启桌面端才会出现在工具列表里。github.com:443 在无代理时不通，
craft-anything 的安装包是走 `api.github.com/repos/.../releases/assets/<id>` + `Accept: application/octet-stream`
拿到的（objects.githubusercontent.com 可直连）。


| Skill | 状态 | 能干什么 |
|---|---|---|
| craft-anything（已装 `D:\hermes\skills\craft-anything`） | 只有指令，**引擎未安装**：`craft-anything-cli` 不存在 | 装上后可用 MCP/CLI 打开 vmde.exe 做 PE/Qt 静态勘察（导入表、字符串、资源、结构），用于确认功能边界与常量 |
| reverse-engineer-anything（v49，已装） | 只有指令，**REA MCP 未注册**；CLI 回退需 Ghidra/IDA 才有原生反编译 | 可做 JS/资源/清单类分析；vmde.exe 是 Qt4 x86 原生程序，无反编译器只能到字符串/资源层 |

结论：**不能指望把 x86 SIMD 描摹核心反编译成 JS**。真正的可用路径是
（a）官方帮助文档 = 功能语义权威；（b）官方 Samples = 输出格式 ground truth；（c）VM 自身批处理 = 大规模标定数据源；
（d）算法本身有公开论文原型（Diebel 2008 贝叶斯矢量化的博士论文，vm-tracer.js 已按此实现）。
反编译只在 S3 需要确认某个常量/顺序时作为旁证使用。

合规提示：功能复刻可以，VM 的样例输出、图标、帮助文本不进站点产物；样例仅本地标定。
