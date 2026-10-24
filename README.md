# optionjs

让程序（或 AI）像人一样操作 Windows 桌面应用：**识别窗口 → 看懂画面 → 动鼠标键盘**。

这是一个纯 Node.js 的 RPA / GUI Agent 工具箱，只依赖一个 `koffi`（Win32 FFI，预编译二进制，不需要装 Visual Studio 编译环境）。

```js
import { AppSession } from 'optionjs';

const app = await AppSession.launch('notepad.exe');   // 启动并绑定窗口
await app.click(560, 184);                            // 坐标 = 截图里的像素
await app.type('你好，世界 🚀');                        // 中文、emoji 都能打
```

---

## 为什么需要它

传统自动化靠「控件句柄」定位，遇到 Qt、Electron、Flutter、canvas 应用就失效。  
本项目的思路是**视觉优先**：拿到窗口截图，用像素坐标操作，任何能看见的界面都能操作——这也是当前 GUI Agent（视觉大模型操作电脑）的主流方案。

它替你处理掉三个最容易出错的地方：

| 坑                                | 本项目的处理                                   |
| -------------------------------- | ---------------------------------------- |
| 系统缩放 150%/200% 导致截图坐标和点击坐标错位     | 进程启动即设 `PER_MONITOR_AWARE_V2`，全链路统一物理像素  |
| 窗口有阴影边框，`GetWindowRect` 比肉眼所见大一圈 | 用 DWM `EXTENDED_FRAME_BOUNDS` 校正，截图时裁掉阴影 |
| 截图缩小后模型给的坐标偏小                    | 会话层记住缩放比例，`click()` 自动换算回屏幕坐标            |

## 特性

- **窗口识别**：按进程名 / 标题 / 窗口类名 / 句柄匹配，支持正则与打分排序（同时开多个记事本也能选中对的那个）
- **两种截图**：前台抓屏（像素级精准）/ `PrintWindow` 后台绘制（被遮挡也能抓），自动降级
- **完整输入**：移动、单击、双击、右键、拖拽、滚轮；组合键、按键序列；`KEYEVENTF_UNICODE` 直接投递字符，**不受输入法影响，中文/emoji 一次成功**
- **界面稳定检测**：`waitForStable()` 比较连续截图差异，比写死 `sleep` 可靠
- **AI 就绪**：内置 16 个 LLM function tools（OpenAI/Anthropic 两种格式）+ 系统提示词 + 完整 agent 循环示例
- **零编译依赖**：PNG 编码、图像缩放、网格叠加全部用 JS 实现

## 安装

```bash
npm install          # 只装 koffi
node test/smoke.js   # 端到端自测（打开记事本跑一遍，10 项断言）
```

要求：Windows 10/11 + Node.js 18+。

## 快速上手

```js
import { AppSession } from './src/index.js';

// 方式一：启动新应用
const app = await AppSession.launch('notepad.exe');

// 方式二：接管已有窗口（进程名 / 标题 / 句柄任选）
const chrome = AppSession.attach({ process: 'chrome' });
const exact  = AppSession.attach({ title: '百度一下，你就知道' });

// 截图：maxWidth 缩小省流量，grid 叠加坐标网格
const shot = await app.screenshot({ maxWidth: 1400, grid: 100 });
console.log(shot.width, shot.height, shot.scale);

// 点击：坐标就是 shot 这张图里的像素位置
await app.click(400, 300);

// 输入中文
await app.type('这是一段中文 🚀');

// 组合键
await app.hotkey('ctrl+s');

// 拖拽 / 滚动
await app.drag({ x: 100, y: 300 }, { x: 600, y: 300 });
await app.scroll({ deltaY: -3 });

// 等界面加载完（比 sleep 可靠）
await app.waitForStable({ timeout: 5000 });

// 窗口控制
app.maximize();
app.setBounds({ width: 1200, height: 800 });
await app.close();
```

### 命令行

**不写代码也能用完整 API**：窗口识别、截图、鼠标、键盘、窗口控制、批量执行都有对应命令，
坐标状态会跨进程保留，所以 `shot` 之后可以直接用截图里的像素坐标 `click`。

```bash
node cli.js launch notepad.exe                                  # 启动应用
node cli.js shot  --app notepad --out a.png --grid 100          # 截图（记录坐标映射）
node cli.js click --app notepad 480 200                         # 用 a.png 的像素坐标点击
node cli.js type  --app notepad "你好，命令行输入 ✅"              # 输入中文
node cli.js key   --app notepad ctrl+s                          # 组合键
node cli.js win   maximize --app notepad                        # 窗口控制
node cli.js run   steps.json --out-dir run1                     # 批量执行一串动作
```

全部命令：`list` `find` `info` `shot` `state` `click` `dclick` `rclick` `move` `drag` `scroll`
`type` `press` `key` `activate` `win` `stable` `wait` `launch` `run` `tools` `dpi`。

`node cli.js --help` 看用法，完整手册见 [docs/CLI.md](./docs/CLI.md)（含 Bash/Python 调用示例与 AI 接入方式）。

## 给 AI 用（GUI Agent）

```js
import { AppSession } from './src/session.js';
import { createToolkit, toOpenAITools, buildSystemPrompt } from './src/tools.js';

const app = AppSession.attach({ process: 'excel' });
const kit = createToolkit({ session: app, maxWidth: 1400 });

// 直接交给模型
const tools = toOpenAITools();
const system = buildSystemPrompt({ session: app, task: '把 A1 改成 100' });

// 执行模型返回的 tool_call
const result = await kit.call('click', { x: 320, y: 210 });
// result.result     → 执行结果
// result.screenshot → 动作后的新截图（base64），直接回传给模型
```

完整可运行的循环见 [`examples/ai-agent.js`](./examples/ai-agent.js)：

```bash
set LLM_API_KEY=sk-xxx
set LLM_MODEL=gpt-4o
node examples/ai-agent.js "在记事本里写一首关于秋天的四行诗"
```

细节（坐标语义、提示词设计、token 优化、失败恢复）见 [docs/AI-INTEGRATION.md](./docs/AI-INTEGRATION.md)。

## 架构

```
┌──────────────────────────────────────────────┐
│ 你的代码 / AI Agent                          │
├──────────────────────────────────────────────┤
│ tools.js     16 个 function tools + 分发器    │  ← LLM 调用这一层
├──────────────────────────────────────────────┤
│ session.js   会话层：坐标自动换算、自动激活   │  ← 推荐日常使用
├───────────────┬──────────────┬───────────────┤
│ window.js     │ capture.js   │ input.js      │  ← 能力层
│ 枚举/匹配/控制 │ 截图/裁剪/缩放│ 鼠标/键盘     │
├───────────────┴──────────────┴───────────────┤
│ native/win32.js  user32 / gdi32 / dwmapi FFI │  ← 物理层
│ native/png.js    零依赖 PNG 编码              │
└──────────────────────────────────────────────┘
```

## 坐标体系（最容易搞混的地方）

| 坐标系       | 原点              | 用在哪                                |
| --------- | --------------- | ---------------------------------- |
| **图像坐标**  | 最近一次截图的左上角      | `click/type` 默认、AI 模型给的坐标          |
| **屏幕坐标**  | 整个虚拟桌面左上角，物理像素  | `click(x, y, { space: 'screen' })` |
| **客户区坐标** | 窗口内容区左上角（不含标题栏） | `click(x, y, { space: 'client' })` |

`session.toScreen(x, y)` / `toImage(x, y)` / `clientToScreen(x, y)` 可以随时互转。  
越界坐标会被收敛到窗口内，避免误点到别的应用上。

## 已知限制

- **管理员权限窗口**：目标进程以管理员身份运行时，Windows 的 UIPI 会静默丢弃低权限进程的模拟输入（命令成功但界面不动）。
  解决办法是用 [提权输入桥](./docs/ELEVATED-APPS.md)：管理员身份跑 `node bridge.js`，普通脚本通过本机 HTTP 调用。
- **反作弊保护的应用**：TenProtect / ACE 这类内核级反作弊会拦截注入输入，提权也无法绕过，属于其设计目标
- **DirectX / 独占全屏游戏**：`PrintWindow` 抓不到，抓屏只在前台有效
- **部分 Electron/Chromium 应用**：后台 `PrintWindow` 可能返回黑图，此时会自动回退到抓屏（需窗口在前台）
- **UWP 部分应用**：窗口被 DWM cloak 时会被过滤掉，UWP 需要专用接口，本项目未覆盖
- **没有 OCR / 控件树**：完全靠视觉模型看图。要读文本请让模型识别，或接入系统 UIAutomation

## 安全与伦理

本库能操作你电脑上的任何窗口。默认的 `close()` 走 `WM_CLOSE`（等价于用户点 ×），不会强杀进程。  
给 AI 使用时，务必在业务层限制它可操作的应用白名单，并对「删除/支付/卸载」这类不可逆操作加人工确认。

## 目录

```
src/
  native/win32.js   Win32 FFI 封装（DPI、GDI、SendInput、窗口 API）
  native/png.js     零依赖 PNG 编码
  window.js         窗口枚举/匹配/控制/坐标换算
  capture.js        截图与图像后处理
  image.js          裁剪/缩放/网格/差异比较
  input.js          鼠标与键盘
  session.js        会话层（推荐入口）
  tools.js          AI function tools
  index.js          统一导出
cli.js              命令行工具（list/find/info/shot/click/type/key/tools/dpi）
examples/
  basic.js          记事本自动化示例
  ai-agent.js       视觉模型驱动的 agent 循环
docs/
  API.md            完整 API 参考
  CLI.md            命令行手册（含脚本与 AI 调用示例）
  AI-INTEGRATION.md AI 接入指南
  ELEVATED-APPS.md  操作管理员权限应用（UIPI 与提权输入桥）
test/smoke.js       端到端冒烟测试（10 项断言）
```

## License

MIT
