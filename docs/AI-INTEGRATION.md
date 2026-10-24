# AI 接入指南：让模型自己操作应用

本文说明如何把一个视觉大模型接到 optionjs 上，形成「**看图 → 思考 → 动手 → 再看图**」的闭环。

```
┌──────────┐   ① 截图(dataURL)   ┌──────────┐
│ optionjs │ ──────────────────> │ 视觉模型 │
│          │ <────────────────── │          │
└──────────┘   ② tool_calls      └──────────┘
      │ ③ 执行鼠标/键盘
      ▼
  目标应用界面（变化了）
      │ ④ 回到 ①
      └──────────>
```

---

## 1. 坐标契约（最重要的一条）

模型看到的图片和鼠标落点必须严格对应，否则整个方案不成立。本库把这个契约固化成三条规则：

1. `screenshot()` 返回的图片，**左上角就是窗口可见区域的左上角**
2. 模型给出的 `(x, y)` 一律解释为**这张图里的像素坐标**
3. `session.click(x, y)` 内部做 `图像坐标 ÷ scale + 屏幕原点`，把坐标还原到屏幕物理像素

所以模型不需要知道 DPI、窗口位置、缩放比例，甚至连"缩放"这个概念都不需要出现。

如果换一张截图尺寸不同，映射关系会自动更新（`session.lastShot`），不需要手动同步。

> 调试技巧：`screenshot({ mark: {x, y} })` 会在图上画一个红色十字，直接肉眼确认落点。
> 注意 `mark` 的坐标是**输出图片**的坐标，如果你同时用了 `maxWidth`，要按缩放后的尺寸给。

## 2. 把工具交给模型

```js
import { AppSession } from './src/session.js';
import { createToolkit, toOpenAITools, buildSystemPrompt } from './src/tools.js';

const app = AppSession.attach({ process: 'excel' });
const kit = createToolkit({ session: app, maxWidth: 1400, autoScreenshot: false });

const tools  = toOpenAITools();                       // OpenAI 兼容
const tools2 = kit.anthropicTools;                    // Anthropic
const system = buildSystemPrompt({ session: app, task: '在 B2 单元格填入 100' });
```

OpenAI 兼容接口（DeepSeek / 通义 / Kimi / vLLM 等同样适用，只要模型支持图片输入）：

```js
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
});
```

Anthropic：

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
await client.messages.create({
  model: 'claude-sonnet-4-5',
  system,
  tools: kit.anthropicTools,
  messages,
  max_tokens: 2000,
});
```

## 3. Agent 循环

完整实现见 [`examples/ai-agent.js`](../examples/ai-agent.js)。核心骨架：

```js
// 初始：系统提示 + 任务 + 首屏截图
messages.push({ role: 'user', content: [
  { type: 'text', text: `任务：${task}` },
  { type: 'image_url', image_url: { url: dataURL } },
]});

while (step++ < MAX_STEPS) {
  const msg = (await callModel(messages, tools)).choices[0].message;
  messages.push(msg);

  if (!msg.tool_calls?.length) break;           // 模型认为任务结束

  for (const call of msg.tool_calls) {
    const { name, arguments: raw } = call.function;
    const result = await kit.call(name, JSON.parse(raw || '{}'));

    // 工具结果回填（只回文本，别把图塞进 tool 消息里）
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result.ok ? result.result : { error: result.error }),
    });
  }

  // 关键：动作执行完补一张新截图，作为独立的 user 消息
  await appendScreenshot(messages, '这是执行动作后的界面：');
}
```

两个容易踩的坑：

- **别把图片放进 `role:'tool'` 消息**，OpenAI 规范里 tool 消息只接受文本。图片要用一条新的 `user` 消息承载。
- **每一步都要重新截图**。模型很容易"凭想象"连续点三下，结果第二下已经偏离目标。`autoScreenshot: true` 时 `kit.call()` 会自动带回新图，可以省一次调用。

## 4. 提示词模板

`buildSystemPrompt()` 生成的中文提示词已经覆盖了核心约束。要更强的稳定性，可以在其基础上追加（实测有效的几条）：

```text
补充规则：
- 每次点击前，先用一句话说出你看到的目标元素长什么样、大概在图片的什么位置，再给坐标。
- 如果某个按钮的文字很小或位置难以判断，先调用 screenshot 并传 grid=100，用网格辅助定位。
- 输入文字前必须先用 click 点中输入框，看到光标后再 type_text。
- 同一个动作连续两次没有任何界面变化，说明你的假设错了，请重新截图并换一种方式。
- 需要读取界面上的文字时，直接看你收到的截图，不要猜测。
- 完成任务后不要继续操作，直接用一句话总结。
```

## 5. 图像策略与成本

一张 4K 全屏 PNG base64 大约 **1.5~4MB**，视觉模型的 token 消耗和延迟都会爆炸。实践中：

| 场景 | 建议 |
| --- | --- |
| 常规操作 | `maxWidth: 1400`（约 1400×740，压缩后 100~200KB） |
| 小控件密集（工具栏、菜单） | `maxWidth: 2000`，或先点击放大/用 `mark` 校验 |
| 只需要确认状态 | `maxWidth: 900`，配合 `waitForStable` |
| 长链路任务 | 只保留最近 2~3 张截图，更早的从 `messages` 里删掉 |

`maxWidth` 不要低于 800：坐标精度会明显下降，点 16px 高的按钮会开始出现偏移。

切图还有一个受益点：**图片越小，模型估坐标越准**——因为它见过的训练图都在这个量级。

## 6. 常见失败模式与对策

| 现象 | 原因 | 对策 |
| --- | --- | --- |
| 点偏了，落在相邻元素 | 图片缩放后模型估错 | 加 `grid: 100` 网格；`mark` 校验；提高 `maxWidth` |
| 打字没进输入框 | 没先点击输入框，或焦点在别处 | 先 `click` 再 `type_text`；必要时 `get_window_info` 确认 `focused` |
| 界面没反应 | 应用还在加载 / 弹了对话框 | `wait_for_stable`；截图看有没有模态框 |
| 坐标整体偏移固定值 | 目标进程 DPI 感知异常 | `node cli.js dpi` 确认 `per-monitor-v2`；检查窗口是否跨屏拖动过 |
| `SendInput` 报错或无效 | 目标是管理员权限窗口 | 以管理员身份启动本程序 |
| 后台窗口截图全黑 | 应用不支持 `PrintWindow` | 让窗口在前台（`activate()`）后用 `method:'screen'` |
| 中文变成乱码/拼音 | 用了模拟按键而非 Unicode | 本库默认走 `KEYEVENTF_UNICODE`，若自定义实现请确认 flag |
| 模型反复点击同一处 | 缺少"变化检测"反馈 | 提示词里加"两次无变化就换方案"，或用 `waitForStable` 的 `diff` 判断 |

## 7. 可靠性增强

### 动作后校验

```js
const before = await app.screenshot({ maxWidth: 900 });
await app.click(x, y);
const after = await app.screenshot({ maxWidth: 900 });
const changed = diffRatio(before.image, after.image) > 0.01;
if (!changed) console.warn('点击后界面无变化，可能没点中');
```

`diffRatio` 在 `src/image.js` 中导出。

### 重试与退避

```js
async function clickUntil(x, y, check, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    await app.click(x + i * 2, y + i * 2);   // 小幅抖动，绕开个别控件的边缘判定
    if (await check()) return true;
    await app.waitForStable({ timeout: 2000 });
  }
  return false;
}
```

### 结构化输出前置

对关键参数（文件名、数量、金额），让模型先把结论写成一句话再动手，能显著降低"手比脑子快"导致的误操作。

## 8. 安全护栏

给 AI 开放桌面操作能力，等同于把键盘交出去。生产环境建议：

1. **应用白名单**：只允许 `attach_window` 匹配白名单内的进程名，其余直接拒绝
2. **动作黑名单**：`click` 命中「删除 / 卸载 / 支付 / 格式化」等区域的坐标直接拦截（用固定坐标区或让模型先申报意图）
3. **不可逆操作二次确认**：涉及提交表单、发送消息、删除文件时，先截图给人看一眼，人工点确认后再执行
4. **步数上限 + 超时**：`MAX_STEPS` 和总时长都设上限，防止死循环烧钱
5. **执行日志**：把每一步的工具名、参数、截图路径落盘，出问题能复盘

```js
const ALLOW = new Set(['excel.exe', 'notepad.exe']);
const session = AppSession.attach({ process: 'excel' });
if (!ALLOW.has(session.info.processName.toLowerCase())) {
  throw new Error('不在允许操作的应用白名单内');
}
```

## 9. 评测建议

跑一批固定任务（例如 20 个：填表、重命名、导出、勾选……），记录：

- **成功率**：一次跑通 / 需要人工兜底
- **平均步数**：步数越多越容易跑偏
- **token 成本**：主要由截图张数和分辨率决定
- **失败归类**：定位错 / 焦点错 / 时序错 / 模型误判

定位错就调 `maxWidth` 和网格；时序错就加 `waitForStable`；模型误判就改提示词或换更强模型。这套循环调两三轮，成功率通常能从 50% 上到 85% 以上。
