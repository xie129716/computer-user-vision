# Computer Use（电脑操作）—— 读屏 + 操作鼠标键盘（纯本地，不调用外部 API）

computer-user 插件提供 10 个 `computer_*` 工具，让模型像人手一样操作本机 Windows
桌面：读屏 → 定位目标 → 点击/输入/按键/滚动/拖拽 → 截图验证。

> **看屏有两种模式，先确认自己属于哪一种**：
>
> - **视觉模式（当前主流）**：模型声明了图像输入能力（如 `deepseek-flash` /
>   DeepSeek-V41-Flash）时，`computer_screenshot` 会把截图**作为图片直接附加在工具
>   结果里**。你**直接看这张图**即可，**不需要**任何外部图像识别工具。
> - **路径模式（降级）**：模型不支持图像输入时，`computer_screenshot` 只返回 PNG
>   文件路径，需要把路径交给外部图像分析工具（如 picturereader 的 `image_scan` /
>   `image_ocr`）才能"看"到屏幕。
>
> 判断方法：看 `computer_screenshot` 的返回。出现 `screenshot attached as an image
> below` 就是视觉模式；出现 `screenshot saved to a PNG file` 就是路径模式。

> **本地性**：截图由本地 PowerShell 生成，输入由本地 Win32 SendInput 完成。视觉模式下
> 图片会随对话请求发给模型服务（这是使用视觉能力的必然代价）；路径模式下图像分析
> 若使用本地 OCR 引擎则可全程不出本机。不要把与任务无关的屏幕内容截进来。

---

## 标准闭环（每步都按这个顺序）

1. **看**：`computer_screenshot` 截屏。视觉模式直接观察附加的图片；路径模式拿 `path`。
2. **换算坐标（视觉模式必做）**：图片像素 ≠ 屏幕像素。按返回里的 `screen_mapping`
   换算：
   ```
   screen_x = virtual_offset[0] + image_x * screen_per_pixel[0]
   screen_y = virtual_offset[1] + image_y * screen_per_pixel[1]
   ```
   换算结果就是 `computer_click` 等工具要填的**虚拟屏物理像素**坐标。
3. **定位目标区域**：优先只截目标窗口（见下），画面越小越清晰、坐标越准。
4. **做**：`computer_click` / `computer_type` / `computer_keypress` /
   `computer_scroll` / `computer_drag` / `computer_move_mouse`。
5. **验**：再 `computer_screenshot`（同一 region），确认达到预期后再进行下一步。
6. 等动画/加载用 `computer_wait`；看当前鼠标位置用 `computer_get_cursor_position`。

**一次多读、少点几次**：需要看多个位置时，先截大图定位大致区域，再对可疑区域单独
`computer_screenshot({region:[…]})` 看清细节；不要「点一下截一次」无谓循环。

---

## 截图清晰度：预算与 region（视觉模式的关键技巧）

视觉模式下插件会把截图自动压到 `vision_max_pixels`（默认 **640000** 像素，与
DeepSeek 视觉投影预算一致）以内，避免服务端再次降采样而让坐标倍率失真。

代价是：整屏 1920×1080 会被压到约 1066×600，**界面小字可能看不清**。所以：

- **要读小字 / 定位小按钮时，用 `region` 只截目标窗口或目标区域**，例如
  `computer_screenshot({region:[0.25,0.3,0.75,0.7]})`（比例 0..1）。
  同样 64 万像素预算下，截得越小，局部越清晰。
- 想提速也可以在设置里调大 `vision_max_pixels`，但**超过服务端预算会被再次降采样**，
  此时 `screen_mapping` 仍以返回的 `image` 尺寸为准（插件已按实际图片尺寸算好倍率），
  只是你看到的画面更糊，不划算。
- `path` 参数仅在需要把截图留档时使用。

---

## 定位窗口（提高清晰度与准确率）

整屏截图会把桌面图标/壁纸一起拍进来，干扰判断。条件允许时先定位目标窗口矩形，
之后截图就只截这个 region：

Windows 下标准做法（纯本地 PowerShell）：

1. 找到目标进程（如 `Get-Process -Name "*Deepseek Harness*"`），确定主窗口句柄。
2. **必须用 DPI 感知的 `GetWindowRect`** 拿物理像素边界：
   ```
   Add-Type 'public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
   [DpiAware]::SetProcessDPIAware() | Out-Null
   GetWindowRect(hwnd) → (left, top, right, bottom)   # 物理像素
   ```
   > 注意：**不调用 `SetProcessDPIAware()` 时拿到的是逻辑坐标**（150% 缩放下会被
   > 缩小），与截图/点击的物理像素不一致，会把窗口定位到错误位置。
3. 把窗口矩形换算成屏幕比例，截图时只截这个 region：
   `region: [left/W, top/H, right/W, bottom/H]`。
4. 窗口移动/缩放后要重新定位。

视觉模式下这一步是**可选优化**（你能直接看到画面，不会把桌面图标误当按钮）；但
`region` 对**看清细节**帮助很大。

---

## 一击即中：点击纪律

- **确认坐标后再点**：目标元素的中心点最好；元素中心未必是按钮可点区，必要时在
  附近小范围试探一次。
- **不要连续多点**：许多 UI（设置页/浮层）是**点击开关**——点一次打开，再点一次又
  关掉。点一次 → 截图验证 → 按结果决定下一步，绝不盲目连点。
- **点击后必验证**：每次 `computer_click` 后 `computer_screenshot`（同 region）确认
  是否达到预期；没达到再调整一小步（如 ±10px）。
- **坐标基准要核实**：视觉模式下务必用 `screen_mapping` 换算，别把图片坐标直接当屏幕
  坐标填进去——`screen_per_pixel` 通常明显大于 1（例如整屏被压到 55% 时约为 1.8）。

---

## 运行模式（设置 → 电脑操作）

| 模式 | 行为 |
|---|---|
| `disabled` 禁用 | 所有 computer_* 工具一律拒绝 |
| `readonly` 只读 | 仅 `computer_screenshot` / `computer_get_cursor_position` / `computer_wait` 可用 |
| `manual` 手动批准 | 有副作用工具需当前会话先 `/computer` 批准（一次批准后续轮次有效） |
| `auto` 自动 | LLM 自由调用所有工具 |

「手动批准」模式：当工具返回「需要批准：请在对话框输入 /computer」时，告知用户
输入 `/computer` 解锁当前会话；批准后本会话后续轮次全部可用。

**AI 自行修改运行模式**：
- 默认**不允许**（设置项「AI 可自行修改运行模式」默认关闭）。
- 开启后可用 `computer_set_mode(mode)` 切换模式（disabled/readonly/manual/auto）。
- `computer_set_mode` 写的是**同一个设置命名空间**，因此**设置卡的运行模式下拉框会自动
  同步显示 AI 修改后的值**；反过来用户在设置卡手动改模式也立即可见（热载）。
- `disabled` 模式下 `computer_set_mode` 也被拒绝（防止 AI 自我解锁）。

---

## 相关设置（设置 → 插件 → 插件配置 → computer-user）

| 设置项 | 默认 | 说明 |
|---|---|---|
| `vision_feedback` | `true` | 视觉直返：模型支持图像时截图直接以图片返回。关闭则一律只返回文件路径 |
| `vision_max_pixels` | `640000` | 视觉模式下截图最大像素数，超出则自动降采样，与服务端视觉预算对齐 |
| `default_scale` | `1` | 截图默认缩放；视觉模式下会按 `vision_max_pixels` 自动下调 |
| `screenshot_dir` | 空 | 截图保存目录，空 = 系统临时目录 |
| `mode` | `manual` | 运行模式 |

---

## 输出规范（重要：这是给模型本人的纪律）

0. **能用其它手段就别用 computer use**：computer use 是**最后手段**——凡是能用
   非 GUI 自动化方式完成的（如直接调用 API / 读写文件 / pwsh 命令 / fetch 等），
   **一律优先使用这些方式**，不要为了「演示」或「顺手」去操作鼠标键盘。仅当
   **用户明确要求操作 GUI**，或**处于 plan 模式且必须真实点击/输入来验证界面**时，
   才使用 `computer_*` 工具。用之前先在回复里说明「这里必须用 computer use，
   因为……」，用之后回归非 GUI 手段继续。
1. **绝不在正文输出任何调用语法/伪标签**（这是最高优先级纪律，曾反复违反）：
   回复正文**严禁出现**任何尖括号标签（如 `<invoke>`、`<使用…>` 等）、伪 XML、
   残缺的 `computer_*` 调用片段，或把工具调用当代码块贴出来。要调用某能力就
   **直接发起一次真正有效的工具调用**，正文只写自然语言。写完回复后自查正文：
   若发现任何 `<…>` 或 `computer_xxx({…})` 文本出现在正文里，一律视为违规，必须
   改成真实调用或删除。
1.5 **容忍少量噪声，继续推进，别停摆**：即使正文里混入了极少量脏字符或残缺标签，
   **也不要中断流程、不要反复道歉、不要停留在「清理格式」上**——直接继续用真实
   工具调用把当前任务做完。
2. **读屏用工具，不要用感觉**：找元素必须先 `computer_screenshot` 并**真正看图**
   （视觉模式）或把路径交给图像分析工具（路径模式）；坐标必须来自实测画面，
   不是猜测。
3. **分清目标窗口与背景**：桌面图标/壁纸不是应用元素，别点错。
4. **坐标换算不能省**：视觉模式下图片像素必须经 `screen_mapping` 换算成虚拟屏
   物理像素再操作。
5. **回到可验证的中间态**：任何不确定时，先截图说明当前屏幕是什么，再决定下一步；
   不猜、不赌。
6. **隐私边界**：不要把与任务无关的屏幕内容截进来；不要把截图内容或坐标拼进任何
   外部请求。

---

## 坐标系与精度

- 坐标 = **相对多屏虚拟屏原点的物理像素**（`computer_screenshot` 的
  `virtual_offset` 即该原点；capture.ps1 已 `SetProcessDPIAware`，与物理像素一致）。
- 视觉模式换算：`screen = virtual_offset + image_pixel * screen_per_pixel`。
- 高分屏缩放：截图/输入都按物理像素，无系统缩放偏移；**窗口定位脚本同样要
  DPI 感知**才能对齐（见上文）。
- 多显示器：`virtual_offset` 可能是非零（副屏在原点左侧/上方时为负）。

---

## 安全规范

- 动手前务必**先截图确认目标**，不盲点。
- 只操作任务相关窗口；**不要操作 DSH 客户端自身的浮层按钮**除非任务就是配置它。
- 输入含中文等任意文本都可靠（SendInput Unicode）。
- 每步小操作后 `computer_wait`（300–800ms）等 UI 响应。
- 破坏性操作（删除/覆盖/保存到重要位置）在「手动批准」模式下让用户先 `/computer`
  再执行；自动模式下也要先截图确认目标再操作。
