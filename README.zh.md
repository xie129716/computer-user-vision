# computer-user-vision（computer-user-vision 分支）

> **这是非官方分支。** 原始插件由 [jing-hy](https://github.com/jing-hy/computer-user) 开发（MIT）。
> 本分支修复了两件事：
>
> 1. **上游 0.3.6 在 DSH ≥ 0.1.2 上根本无法加载**（具名导入 `settingsNamespace` 已不存在，
>    整个模块加载即失败，且**没有任何报错**：工具、设置卡、`/computer` 命令全部静默消失）。
> 2. **截图不再只回传文件路径**：模型声明图像输入能力时，截图作为真正的图片块直接返回，
>    并附带权威的「图片像素 → 屏幕像素」换算倍率 `screen_per_pixel`，无需 picturereader。
>
> 英文说明（含安装、`tools/` 自愈脚本、`verify/` 回归套件、隐私边界）见 [README.md](README.md)，
> 技术细节见 [docs/adaptation-notes.md](docs/adaptation-notes.md)。

---

# computer-user-vision

给 DeepSeek Harness（DSH，含 EAC 桌面客户端）的 **Codex 式电脑操作**插件：读屏幕并操作
鼠标键盘 —— 截图 → 看图 → click/type/keypress/scroll/drag → 验证。**仅支持 Windows。**

- `computer_screenshot` 把整个虚拟屏（多显示器、DPI 感知）截成 PNG。**模型具备视觉能力时
  （如 DeepSeek-V41-Flash / `deepseek-flash`）截图会作为图片直接附加在工具结果里**，模型
  直接看图即可；只有纯文本模型才退回「返回路径 + 外部图像工具」的方式。
- 另外 8 个 `computer_*` 工具，通过内置 PowerShell + Win32 `SendInput` 操作鼠标键盘
  （零原生模块、无需编译，可在 DSH/EAC 宿主进程内运行）。
- 设置卡（「电脑操作」）顶部是**模式下拉框** —— 禁用 / 只读 / 手动批准（`/computer`）/
  自动，其余收进默认折叠的 **高级设置**。
- **截图与输入全程本地**：截图（PowerShell）、操作（Win32 SendInput）都不出本机。
  视觉模式下图片会随对话请求发给模型服务（使用视觉能力的必然代价）；纯文本模型走
  picturereader 本地 OCR 时才真正全程不出本机。操作流程见
  [skills/computer-use.md](skills/computer-use.md)（先定位目标窗口，确认后一击即中并
  截图验证）。
- 已验证兼容 **DeepSeek Harness EAC** 桌面端（与 Web 同一 DSH 宿主内核）。

> English: [README.md](README.md)。

## 看屏的两种模式

**1）视觉模式（推荐，默认）** —— 当前路由声明了图像输入能力时自动启用：

```text
computer_screenshot → 截图作为图片直接返回     # 看（无需任何外部工具）
computer_click / type / ...                    # 做
computer_screenshot                            # 验证
```

截图随工具结果一起附加，模型直接观察画面。插件会把截图自动压到 `vision_max_pixels`
（默认 640000，与 DeepSeek 视觉投影预算一致）以内，并按**实际图片尺寸**算出
`screen_per_pixel` 倍率，保证「图片像素 → 屏幕物理像素」换算精确：

```text
screen_x = virtual_offset[0] + image_x * screen_per_pixel[0]
screen_y = virtual_offset[1] + image_y * screen_per_pixel[1]
```

要读小字或定位小按钮时用 `region` 只截目标窗口——同样预算下，截得越小越清晰。

**2）路径模式（降级）** —— 模型不支持图像输入时自动退回：

```text
computer_screenshot → path
picturereader image_scan / image_ocr <path>   # 看（本地 OCR）
computer_click / type / ...                   # 做
computer_screenshot → image_compare           # 验证
```

这条路线**不需要多模态模型，也不需要外部视觉 API**：`picturereader` 把 PNG 转成纯文本
模型能读的结构化描述（`image_scan` 布局/颜色/regions、`image_ocr` 真实文字、`image_sample`
纹理），全程只有文本 token、零外部请求。

模式由插件读取当前路由的 `inputModalities` 自动判断，也可用设置项 `vision_feedback`
强制关闭视觉直返。详见 [skills/computer-use.md](skills/computer-use.md)。

## 工具

| 工具 | 作用 |
|---|---|
| `computer_screenshot` | 截取整虚拟屏（可选 region/scale）。视觉模式下**直接返回图片**并附 `screen_per_pixel` 换算倍率；否则只返回 `{path,…}` |
| `computer_click` | 在 `[x,y]` 点击（click / right_click / double_click） |
| `computer_type` | 输入任意 UTF-16 文本（含中文），走 `SendInput` Unicode |
| `computer_keypress` | 组合键，如 `["ctrl","c"]`、`["alt","tab"]`；字母/数字走虚拟键以触发快捷键 |
| `computer_scroll` | 在 `[x,y]` 滚轮：up / down / left / right，`clicks` 格 |
| `computer_drag` | 按下 → 分步移动 → 释放，可选 `hold_keys` |
| `computer_move_mouse` | 移动光标但不点击 |
| `computer_wait` | 等待 `ms`（让 UI 稳定） |
| `computer_get_cursor_position` | 读取当前光标位置 `[x,y]` |

坐标为「相对**虚拟屏原点**（所有显示器合并区域左上角）」的像素；`computer_screenshot`
返回的 `virtual_offset` 即该原点。执行器已把进程提升到 **PerMonitorV2** DPI 感知，高分屏缩放下坐标仍与物理像素一致。

## 安装

```bash
npm install computer-user-vision
```

或在 DSH profile 里：

```bash
dsh plugin --profile web add computer-user-vision
```

然后重启 DSH（或到 EAC「设置 → 插件 → 管理」启用）。工具对所有会话生效；设置卡在「设置 →
电脑操作」。

### 闭环一览

视觉模式（模型支持图像输入，默认）：

```text
computer_screenshot → image                     # 看
computer_click / type / ...                     # 做
computer_screenshot                             # 验证
```

路径模式（纯文本模型，配合 picturereader）：

```text
computer_screenshot → path
picturereader image_scan / image_ocr <path>     # 看
computer_click / type / ...                     # 做
computer_screenshot → image_compare             # 验证
```

## 设置卡

设置卡（「电脑操作」）采用 DSH settings-panel 设计语言：卡片分组 + 胶囊按钮 + 32px
输入框 + chevron 下拉 + 折叠箭头；`scope.load()` 兼容无 load 宿主（EAC 桌面壳）。

- **模式下拉框**（卡片顶部）：
  - `disabled` 禁用 —— 所有 `computer_*` 工具一律拒绝。
  - `readonly` 只读 —— 仅截图 / 读光标 / 等待可用。
  - `manual` 手动批准 —— 有副作用工具需先在本会话输入 `/computer` 批准（一次批准，
    后续轮次持续有效）。
  - `auto` 自动 —— LLM 自由调用所有工具。
- **「AI 可自行修改运行模式」开关**（下拉框下方，不在高级设置里）：默认关闭；开启后
  AI 可用 `computer_set_mode` 切换模式，写入同一设置命名空间，**设置卡下拉框双向同步**。
- **高级设置**（默认折叠）：截图输出目录、默认缩放、**视觉直返（`vision_feedback`，默认开）**、
  **视觉截图像素上限（`vision_max_pixels`，默认 640000）**、逐字输入间隔、滚动刻度、
  **代码输出打回（output guard，默认开）**、调试日志。

**代码输出打回**：host 侧对 LLM 输出流的过滤器——若模型把伪工具调用/伪 XML 当**对话
文本**输出（比如把 `computer_click({…})`、`<invoke …>` 直接打成了字而不是真正调用），
该段会被剔除并替换为一句一次性提示；**同一内容第二次原样输出时放行不拦截**。需要故意
在回复里展示代码片段时可到高级设置关掉。

## 安全

- **先定位目标窗口**（DPI 感知 GetWindowRect，见 skills/computer-use.md）——
  桌面图标/壁纸会干扰判断与点击；只在目标窗口内工作。
- 动手前务必 `computer_screenshot` 并**真正看图**（视觉模式）或交给图像工具分析
  （路径模式），不要盲点盲输。
- 确认坐标后一击即中，点完截图验证，不要盲目连点（很多 UI 是点击开关）。
- 手动批准模式配合 `/computer` 命令，让人在环。

## 验证与已知限制

- `node --test` 单测 39/39 通过（工具注册、门禁、参数校验、output guard）。
- 实机安全窗口冒烟（一次性窗口 + cmd.exe，绝不碰用户应用）：截图 PNG 正确；光标读/移
  往返精确；`hello 中文 123!` 逐字回读一致；keypress Home/End 导航+插入验证
  （`HEADzzzTAIL`）；双击选词、单击取消、拖拽选区均通过控件状态断言。
- headless 集成：`dsh --profile headless` 真实会话中，模型成功调用 `computer_screenshot`
  与 `computer_get_cursor_position`。
- headless 真实场景：模型在 `dsh --profile headless` 中自主完成 5 步任务
  （screenshot → image_scan → type "hello" → screenshot → image_ocr），协调 picturereader
  与 computer-user-vision 工具，OCR 确认输入文字出现在屏幕上。
- 滚轮**端到端验证通过**：滚动条位置变化 + MouseWheel 事件触发均正常。注意：鼠标若落在
  搜狗输入法等置顶悬浮窗上，滚轮事件会被悬浮窗吸收——把光标移到空白处再滚（与任何基于
  光标的输入同理）。
- EAC 兼容：与 picturereader 在同一宿主内可并存加载（视觉模式下不再依赖它）；对全部内置
  插件静态扫描，`computer_*` 工具名 / `computer-user-vision` 命名空间零冲突。
- 视觉直返实测：`deepseek-flash`（DeepSeek-V41-Flash）路由下 `computer_screenshot` 返回
  图片块 + `screen_per_pixel`，模型可直接读屏并换算坐标；纯文本路由自动退回路径模式。

## 开发

```text
src/act.ps1         唯一执行器：截图 / 元素枚举（UIA）/ 鼠标键盘 / 窗口与前台 / 激活
src/ps.js           PowerShell 运行器（base64 JSON、超时、取消）
src/tools.js        13 个 computer_* 工具定义 + 模式门禁 + 元素引用解析 + 视觉直返
src/overlay.ps1     控制指示器（渐变光框 / 光标光晕 / 顶部横幅 + 停止按钮 + 全局热键）
src/overlay.js      指示器生命周期（心跳 / 截图暂停 / 停止标记）
src/approvals.js    /computer 授权落盘（跨宿主重启保持）
src/output-guard.js 把写成对话文本的伪工具调用打回
src/config.js       设置命名空间 schema
src/index.js        插件入口（注册工具 + 设置热载 + 控制路由 + 用户消息重新授权）
client.js           Web 设置卡（ModuleLoader bundle，中英）
skills/             面向模型的技能文档（computer-use.md）
tools/              健康检查 doctor 与 profile 安装器 install.mjs
verify/             可移植验证脚本（纯 node，不需要浏览器）
docs/               适配说明
```

## 许可

MIT
