import z from '@deepseek-ai/schemastery';

/** Settings namespace for this plugin (written to DSH settings.yaml). */
export const NS = 'computer-user';

/** Runtime settings schema (schemastery). Top fields are the "just-opened" card; the rest go to Advanced. */
export const Config = z.object({
  mode: z
    .union([z.const('disabled'), z.const('readonly'), z.const('manual'), z.const('auto')])
    .default('manual')
    .description('运行模式：禁用=全部拒绝 | 只读=仅截图/读光标/等待 | 手动批准=需 /computer 批准后可用 | 自动=LLM自由调用'),
  ai_can_change_mode: z
    .boolean()
    .default(false)
    .description('AI 是否可自行修改运行模式（computer_set_mode 工具是否可用），默认不可。AI 修改后同步更新设置下拉框'),
  approval_scope: z
    .union([z.const('session'), z.const('profile')])
    .default('session')
    .description('批准范围（手动批准模式下生效）：session=每个会话按一次 /computer，本会话后续所有轮次持续有效；profile=按一次即对所有会话长期有效，直到再按 /computer 撤销。两种都写入磁盘，宿主重启后不丢'),
  screenshot_dir: z
    .string()
    .default('')
    .description('截图输出目录（空 = 系统临时目录）'),
  default_scale: z
    .number()
    .default(1)
    .description('截图默认缩放 0.1..1（1=原分辨率整屏）。视觉模式下会按 vision_max_pixels 自动下调'),
  vision_feedback: z
    .boolean()
    .default(true)
    .description('视觉直返：当前模型具备图像输入能力时，截图直接作为图片返回给模型（无需 picturereader）。关闭、或模型不支持图像时退回「只返回文件路径」'),
  vision_max_pixels: z
    .number()
    .default(640000)
    .description('视觉模式下单张截图的最大像素数（默认 640000，与 DeepSeek 视觉投影预算一致）。调大可提高清晰度，但超出服务端预算会被再次降采样，导致坐标倍率失真'),
  overlay: z
    .boolean()
    .default(true)
    .description('接管电脑时显示控制指示器：四边渐变呼吸边框 + 鼠标光环 + 顶部「正在控制电脑」横幅（含取消按钮与 Ctrl+Alt+Esc 全局快捷键）'),
  overlay_idle_seconds: z
    .number()
    .default(25)
    .description('无工具调用超过该秒数后指示器自动收起。用户主动按停止后会一直保持停止，直到重新授权（/computer）'),
  overlay_label: z
    .string()
    .default('')
    .description('指示器横幅文案（空 = 「DeepSeek 正在控制电脑」）'),
  verify_actions: z
    .boolean()
    .default(true)
    .description('操作后回报上下文：点击后回报前台窗口与光标下的 UI 元素（用于识别「首击仅激活窗口」和「点错控件」），关闭可省去子进程开销'),
  grid_spacing: z
    .number()
    .default(0)
    .description('截图坐标网格间距（虚拟屏像素，0 = 关闭）。缩略图看不清坐标时设为 100，会在图上叠加带刻度的网格'),
  typing_interval_ms: z
    .number()
    .default(0)
    .description('逐字输入间隔（毫秒），越大越稳但越慢'),
  scroll_units: z
    .number()
    .default(1)
    .description('滚动刻度：一次 scroll 滚动多少格（每格 120 WHEEL delta）'),
  output_guard: z
    .boolean()
    .default(true)
    .description('LLM 输出过滤器：把工具调用/伪XML写成对话文本时打回并提示，第二次同内容放行'),
  debug: z
    .boolean()
    .default(false)
    .description('调试日志'),
});
