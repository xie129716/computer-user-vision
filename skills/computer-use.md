# Computer Use（电脑操作）—— 读屏 + 操作鼠标键盘（纯本地，不调用外部 API）

computer-user 插件提供 13 个 `computer_*` 工具，让模型像人手一样操作本机 Windows
桌面：读屏 → **按元素引用定位目标** → 点击/输入/按键/滚动/拖拽 → 验证。

> **三条铁律（都是踩过坑总结出来的）**：
>
> 1. **用 `ref` / `name` 定位，不要目测像素坐标**。`computer_screenshot` 现在会附带
>    当前前台窗口里所有可操作控件的**元素引用表**（形如 `e12 Button "保存"`）。
>    `computer_click` 可以直接接受 `{ref:"e12"}` 或 `{name:"保存"}`：引用由 UI
>    Automation 解析成控件的**精确屏幕矩形**再点，**完全不需要像素换算**。
>    在缩小过的截图上量像素是点击偏移的头号原因——1920×1080 会被压到约 1045×588，
>    1 个图像像素约等于 1.84 个屏幕像素，一个 22px 高的按钮在图上只有 12px 高。
>    只有目标**不在**元素表里时，才退回 `coordinate` 并按 `screen_mapping` 换算。
> 2. **点后台窗口前先 `computer_activate_window`**。对**非前台窗口**的第一下合成点击
>    只会激活该窗口，**不会传给控件，而且没有任何报错**。先置前再点，或者检查点击返回
>    里的 `activated_only`。
> 3. **每步都验证**。点击返回里的 `under_cursor` 告诉你光标下到底是什么控件，
>    `hit_confirmed` 直接告诉你是否命中了目标；`foreground_after` 告诉你操作落到了
>    哪个窗口。对不上就重来，不要连着点。

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
   两种模式都会返回**当前前台窗口的元素引用表**。
2. **定位**：在元素表里找目标，记下它的 `ref`（如 `e12`）或可见文字（`name`）。
   - 表太小或窗口变了 → `computer_elements` 重新枚举（不截图，更快）。
   - 目标窗口不对 → `computer_list_windows` 拿 `hwnd`，`computer_activate_window` 置前，
     再重新截图/枚举。
3. **做**：`computer_click {ref:"e12"}` 或 `{name:"保存"}`；输入用
   `computer_type`（带 `ref`/`name` 会先把焦点放进那个输入框，比先点一下更稳）；
   还有 `computer_keypress` / `computer_scroll` / `computer_drag` / `computer_move_mouse`。
4. **验**：看返回里的 `method`（`invoke`/`toggle`/`select` = 直接调用控件动作，
   `mouse` = 在控件中心合成点击）、`hit_confirmed`、`under_cursor`、`foreground_after`。
   需要重看画面就再截一次。
5. 等动画/加载用 `computer_wait`；看当前鼠标位置用 `computer_get_cursor_position`。

**什么时候才用坐标**：目标在元素表里找不到（自绘控件、游戏画面、画布内容、UIA 未暴露的
区域）时。此时用 `screen_mapping` 换算，或先给截图加 `grid` 再看刻度：

```
screen_x = virtual_offset[0] + image_x * screen_per_pixel[0]
screen_y = virtual_offset[1] + image_y * screen_per_pixel[1]
```

**一次多读、少点几次**：需要看多个位置时，先截大图定位大致区域，再对可疑区域单独
`computer_screenshot({region:[…]})` 看清细节；不要「点一下截一次」无谓循环。
`annotate:true` 会把引用编号画到图上，适合**控件稀疏**的窗口。

> **标注的几何上限（实测）**：编号芯片的高度约为 `2 × 字号`。字号会跟着被标注控件的
> **中位高度**自动调整（下限 7pt，低于此不可靠可读），但当控件之间本来就挨得很近时，
> 怎么调都放不下——22px 间距的工具栏列表在 0.5 倍缩放下需要 ≤5.5pt 才能全部标上。
> 这时结果里的 `labeled` 会小于 `element_count`，并附带 `median_element_h` 说明原因。
> **该用元素表，或者用 `region` + `scale:1` 重新截取换取像素**，不要指望缩小字号。

---

## 定位与验证工具（专治坐标不准与静默失败）

### 元素引用（`ref` / `name`）—— 默认的定位方式

`computer_screenshot` 与 `computer_elements` 都会枚举当前窗口里**可操作的控件**，
每个给一个引用：

```
elements (37): e1 Pane "T11" | e2 Pane "T12" | e3 Button "保存" {Invoke} | …
```

- `computer_click({ ref: "e3" })` —— 按引用点，**控件的精确矩形由 UI Automation 给出**。
- `computer_click({ name: "保存" })` —— 按控件可见文字点；**同名多个会拒绝并列出候选**，
  不会乱猜。
- `computer_type({ text: "hello", name: "搜索" })` —— 先把焦点放进那个输入框再输入，
  比"先点一下再打字"少一步也更稳。

引用的有效期：插件保留**最近两次**枚举结果，所以上一次截图里的 `ref` 仍然可用；点击时
会用 `automationId` / 名称 / 类型在**实时**的 UI 树上重新定位，**窗口移动了也不会点偏**。
目标已经不在屏幕上时会明确报错并提示重新截图，**不会静默点到别处**。

`{Invoke}` / `{Toggle}` / `{SelectionItem}` 表示该控件支持对应的 UIA 动作，点击会**直接
调用控件动作**（返回 `method: "invoke"`），连鼠标都不用动；否则退回在控件中心合成点击
（`method: "mouse"`）。有些框架只暴露名字和矩形、不暴露动作——例如 **WinForms 按钮在
UIA 里是 `Pane` 且没有任何 pattern**——这时仍然靠**精确矩形**保证点中，所以不要因为
"看起来不是 Button" 就放弃用引用。

### `computer_list_windows` —— 不要猜窗口在哪

返回所有可见顶层窗口，按 z 序（最上层在前），每项含：

```
{ hwnd, pid, title, class, rect:[left,top,right,bottom], window_rect, client_rect, width, height, minimized, foreground }
```

`rect` 是 DWM **可见边框**——真正显示在屏幕上的像素，**像素级精确**。拿窗口做截图
region、算窗口内相对位置，都用它。`min_width` / `min_height` 过滤小窗口，
`foreground_only` 只看前台。

> `window_rect` 是 Win32 `GetWindowRect` 的原值，**每边比可见框大 8px**（那是 Windows
> 留的不可见缩放边框），拿它算窗口内位置会**系统性偏 8px**。所以两个都给出来，但
> **瞄准一律用 `rect`**，并且优先用 `ref`。

### `computer_activate_window` —— 点之前先置前

**这是最容易踩、且毫无报错的坑**：对**非前台窗口**发出第一下点击，Windows 会把它当作
「激活窗口」消费掉，点击**不会到达控件**。表现就是「我明明点了，什么都没发生」。

```
computer_activate_window({ hwnd: 132374 })     # 或 { pid } 或 { title: "豆包" }
```

置前之后再点击才可靠。若 `computer_click` 返回 `activated_only: true`，通常是在告诉你
「刚才那一下只激活了窗口」，应当重试同一次点击。**但这是启发式判断**：如果那一下本来
就是「关闭对话框 / 关掉菜单」让下面的窗口浮上来，也会命中同样的特征。所以重试前先看
一眼 `foreground_after` 是不是你预期的那个窗口，别盲目重放。

### 操作后回报（设置 `verify_actions`，默认开）

- `computer_click` 额外返回：
  - `method`：`invoke` / `toggle` / `select` / `expand` = 直接调用了控件动作；
    `mouse` = 在控件中心合成的鼠标点击
  - `under_cursor`：光标下的 UI 元素——**直接告诉你点到了什么**
  - `hit_confirmed`：`true` 表示光标下的控件就是目标控件；`false` 说明点到了别的东西
  - `foreground_before` / `foreground_after`：前台窗口是否被改变
  - `activated_only`：是否只是激活了窗口
- `computer_type` / `computer_keypress` 额外返回 `focused_window`——输入到底送进了
  哪个窗口。以前输错窗口是完全静默的。
- **`expect_window`（前置校验，比事后回报管用得多）**：`computer_type` /
  `computer_keypress` / `computer_click` / `computer_scroll` / `computer_drag`
  都接受这个可选参数，要求「当前前台窗口标题必须包含这段文字」，不匹配就**直接拒绝，
  一个字符、一次点击都不会发出去**：

  ```
  computer_type({ text: "hello", expect_window: "记事本" })
  # 前台其实是浏览器 → { chars: 0, refused: true, expected_window: "记事本",
  #                      focused_window: { title: "... Edge" }, hint: "..." }
  ```

  事后回报只能当验尸报告：焦点在你两步之间漂走了，等你看到 `focused_window`
  时键早就按下去了（真事：一个本该打进记事本的 `Ctrl+H` 打进了浏览器）。凡是
  「这串输入必须进某个特定窗口」的场合，都该带上 `expect_window`。

### 截图坐标网格

在缩略图上无法可靠量坐标时，给截图加网格：

```
computer_screenshot({ grid: 100 })     # 每 100 屏幕像素一条线，标签直接是屏幕坐标
```

更推荐用 `region` 只截目标窗口：同样 64 万像素预算下，区域越小越清晰，小区域甚至保持
1:1 像素（倍率 = 1，无需换算）。

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

1. **直接用 `computer_list_windows`**：它已经返回每个窗口的精确 `rect`，不必自己写
   PowerShell 去枚举窗口。
2. 插件侧已经处理过 DPI：`act.ps1` 启动时会把进程提升到 **PerMonitorV2** 感知。
   这一点很关键——`powershell.exe` 默认是 DPI-**unaware**，在带缩放的显示器上
   Windows 会把所有坐标虚拟化，那是"对不齐"的另一个系统性来源。
   > 判断方法：截图返回里的 `monitor_dpi` 是 96 说明当前显示器无缩放；不是 96 时
   > **更应该用 `ref` / `name`**，而不是自己算坐标。
3. 把窗口 `rect` 换算成屏幕比例，截图时只截这个 region：
   `region: [left/W, top/H, right/W, bottom/H]`。
4. 窗口移动/缩放后要 **重新 `computer_list_windows`**，或直接重新截图拿新的引用。

视觉模式下这一步是**可选优化**（你能直接看到画面，不会把桌面图标误当按钮）；但
`region` 对**看清细节**帮助很大。

---

## 一击即中：点击纪律

- **优先 `ref` / `name`，不要自己算坐标**：引用由系统解析成控件的精确矩形，从根上消掉
  了「目测偏几像素」这个问题。能用引用就不要用 `coordinate`。
- **不要连续多点**：许多 UI（设置页/浮层）是**点击开关**——点一次打开，再点一次又
  关掉。点一次 → 看返回的 `hit_confirmed` / `under_cursor`（必要时再截图）→ 按结果
  决定下一步，绝不盲目连点。
- **点击后必验证**：`hit_confirmed: true` 基本可以放心；`false` 或 `activated_only`
  就重来一次。
- **非用坐标不可时**：务必用 `screen_mapping` 换算，别把图片坐标直接当屏幕坐标填进去
  ——`screen_per_pixel` 通常明显大于 1（整屏被压到 55% 时约为 1.84）。

---

## 控制指示器与「用户随时可停」

插件接管电脑时会显示一个指示器：**四边渐变呼吸边框 + 跟随鼠标的光环 + 顶部横幅
「DeepSeek 正在控制电脑」**。横幅上有**停止控制**按钮，全局快捷键 **Ctrl+Alt+Esc**
同样可以停止。

**用户停止后：所有 `computer_*` 工具一律拒绝**，错误信息会明确说明是被停止的。此时：

- **不要重试，也不要换工具绕开**——那是在违背用户意愿。
- 直接告知用户「控制已停止」，并说明输入 `/computer` 可以重新授权。
- 用户重新授权（`/computer`）后停止状态自动解除，可继续。

指示器在无工具调用 `overlay_idle_seconds`（默认 25 秒）后自动收起；**用户主动停止则会
一直保持停止**，直到重新授权。相关设置：`overlay`（开关）、`overlay_idle_seconds`、
`overlay_label`（横幅文案）。

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
  `virtual_offset` 即该原点）。
- 视觉模式换算：`screen = virtual_offset + image_pixel * screen_per_pixel`。
- 高分屏缩放：执行器已把进程提升到 **PerMonitorV2** DPI 感知，截图/输入都按物理像素；
  截图返回的 `monitor_dpi` 不是 96 时说明当前显示器有缩放，此时**优先用 `ref`/`name`**。
- 多显示器：`virtual_offset` 可能是非零（副屏在原点左侧/上方时为负）。

---

## 安全规范

- 动手前务必**先截图确认目标**，不盲点。
- 只操作任务相关窗口；**不要操作 DSH 客户端自身的浮层按钮**除非任务就是配置它。
- 输入含中文等任意文本都可靠（SendInput Unicode）。
- 每步小操作后 `computer_wait`（300–800ms）等 UI 响应。
- 破坏性操作（删除/覆盖/保存到重要位置）在「手动批准」模式下让用户先 `/computer`
  再执行；自动模式下也要先截图确认目标再操作。
