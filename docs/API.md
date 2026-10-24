# API 参考

所有 API 都从 `src/index.js` 导出，也可以按模块单独引入。

```js
import { AppSession, findWindow, captureWindow, click, createToolkit } from './src/index.js';
```

- [1. 会话层 AppSession](#1-会话层-appsession)
- [2. 窗口 window.js](#2-窗口-windowjs)
- [3. 截图 capture.js](#3-截图-capturejs)
- [4. 输入 input.js](#4-输入-inputjs)
- [5. AI 工具层 tools.js](#5-ai-工具层-toolsjs)
- [6. 命令行](#6-命令行)
- [7. 错误处理约定](#7-错误处理约定)

---

## 1. 会话层 AppSession

推荐入口。一个 `AppSession` 对象绑定一个窗口，所有坐标换算、窗口激活都在内部完成。

### 1.1 创建

#### `AppSession.launch(exe, options?) → Promise<AppSession>`

启动应用并等待其窗口出现后绑定。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `exe` | string | — | 可执行文件路径或命令，如 `notepad.exe`、`C:\App\app.exe` |
| `options.args` | string[] | `[]` | 启动参数 |
| `options.match` | object | `{process: 可执行名}` | 自定义窗口匹配条件，用于主窗口标题与进程名不符的情况 |
| `options.timeout` | number | `20000` | 等待窗口出现的超时（毫秒） |
| `options.cwd` | string | — | 工作目录 |
| `options.detach` | boolean | `true` | 应用脱离父进程（脚本结束不影响它） |
| `options.autoActivate` | boolean | `true` | 操作前自动把窗口带到前台 |

启动的进程句柄挂在 `session.child` 上，需要强杀时可用。

> **只绑定新窗口**：启动前会先记录该类窗口的句柄，之后只认新出现的那个。
> 所以「记事本已经开着」时再 `launch`，不会绑到旧窗口上（这是同类应用多开时最常见的 bug）。
> 如果应用把界面开进了已有窗口（如浏览器新标签），会退回到最佳匹配并给 `info.bindingWarning` 提示。

```js
const app = await AppSession.launch('notepad.exe');
const app2 = await AppSession.launch('C:\\Program Files\\App\\app.exe', {
  args: ['--file', 'demo.txt'],
  match: { title: 'App - 主窗口' },   // 主窗口标题和进程名不匹配时用 match 指定
  detach: false,                     // 脚本结束就关掉它
});
```

#### `AppSession.attach(query, options?) → AppSession`

绑定已存在的窗口，找不到时**抛错**（错误信息里会附上当前可用窗口列表）。

```js
AppSession.attach({ process: 'chrome' });
AppSession.attach({ title: /Notepad/ });
AppSession.attach({ hwnd: '0xa071a' });
```

#### `AppSession.tryAttach(query, options?) → AppSession | null`

同上，但找不到时返回 `null`，适合「有就复用，没有就启动」的写法：

```js
let app = AppSession.tryAttach({ process: 'notepad' });
if (!app) app = await AppSession.launch('notepad.exe');
```

### 1.2 状态

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `session.hwnd` | bigint | 窗口句柄 |
| `session.handle` | string | 句柄的十六进制字符串，如 `0xa071a` |
| `session.title` | string | 窗口标题（读的是快照，不实时刷新） |
| `session.info` | object | 重新读取的完整窗口信息（见 [windowInfo](#21-windowinfo)） |
| `session.alive` | boolean | 窗口是否还存在 |
| `session.lastShot` | object\|null | 最近一次截图与屏幕的映射关系 |
| `session.refresh()` | — | 强制重新读取窗口信息 |

`lastShot` 结构：

```js
{
  width, height,        // 图像尺寸（可能已缩放）
  scale,                // 图像 / 原生 比例
  nativeWidth, nativeHeight,
  screenX, screenY,     // 图像左上角对应的屏幕坐标
  method,               // 'screen' | 'print'
  capturedAt
}
```

### 1.3 截图

#### `session.screenshot(options?) → Promise<object>`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `method` | `'auto'\|'screen'\|'print'` | `'auto'` | 抓取方式，见下表 |
| `maxWidth` | number | — | 超过则等比缩小，省 token |
| `grid` | number | — | 叠加坐标网格，间距按缩放后图像计 |
| `mark` | `{x,y}` | — | 在图上画红色十字，调试坐标用 |
| `format` | `'raw'\|'png'\|'base64'\|'dataURL'` | `'raw'` | 返回的图像格式 |
| `save` | string | — | 同时保存 PNG 的路径 |

| method | 原理 | 适用 |
| --- | --- | --- |
| `screen` | `BitBlt` 抓屏幕可见区域 | 窗口在前台，像素与屏幕严格对应，**最精准** |
| `print` | `PrintWindow(PW_RENDERFULLCONTENT)` | 窗口被遮挡/在后台，但个别应用会返回黑图 |
| `auto` | 前台且可见 → `screen`，否则 `print`；抓屏幕发现全黑会回退 `print` | 默认，绝大多数情况够用 |

返回：

```js
{
  width, height,                // 图像尺寸（已按 maxWidth 缩放）
  nativeWidth, nativeHeight,    // 窗口物理像素尺寸
  scale,                        // width / nativeWidth
  screenX, screenY,             // 图像左上角对应的屏幕坐标
  method,                       // 实际使用的抓取方式
  window: { handle, title, processName },
  image | png | base64 | dataURL  // 取决于 format
}
```

```js
const shot = await app.screenshot({ maxWidth: 1400, format: 'dataURL' });
const buf  = await app.screenshot({ format: 'png' });
await app.screenshot({ save: 'out.png' });
```

#### `session.screenshotDataURL(options?) → Promise<string>`

等价于 `screenshot({format:'dataURL'})`，直接返回字符串。

#### `session.snapshot(filePath, options?) → Promise<object>`

截图存盘，返回除图像数据外的元信息。

#### `session.waitForStable(options?) → Promise<{stable, diff, waited}>`

连续两次截图差异小于阈值即认为界面稳定。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `timeout` | `8000` | 最长等待毫秒 |
| `interval` | `250` | 采样间隔 |
| `threshold` | `0.002` | 差异比例阈值（0.002 = 0.2% 像素不同） |
| `region` | — | 只比较窗口内的某块区域 `{x,y,width,height}` |

### 1.4 坐标换算

| 方法 | 说明 |
| --- | --- |
| `session.toScreen(x, y)` | 图像坐标 → 屏幕坐标（无截图记录时原样返回） |
| `session.toImage(x, y)` | 屏幕坐标 → 图像坐标 |
| `session.clientToScreen(x, y)` | 客户区坐标 → 屏幕坐标 |
| `session.screenToClient(x, y)` | 屏幕坐标 → 客户区坐标 |
| `session.cursor()` | 当前鼠标屏幕坐标 |

### 1.5 鼠标

所有鼠标方法的坐标默认按**最近一次截图的图像坐标**解释，可用 `space` 切换：

| space | 含义 |
| --- | --- |
| `'image'` | 默认，截图里的像素位置 |
| `'screen'` | 绝对屏幕坐标（物理像素） |
| `'client'` | 窗口客户区坐标（不含标题栏） |

#### `session.click(x, y, options?) → Promise<{x, y, button, clicks}>`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `space` | `'image'` | 坐标空间 |
| `button` | `'left'` | `left` / `right` / `middle` |
| `clicks` | `1` | 连击次数，2 = 双击 |
| `moveDuration` | `0` | 移动轨迹耗时（毫秒），0 = 瞬移 |

```js
await app.click(400, 300);                                   // 图像坐标
await app.click(400, 300, { clicks: 2 });                     // 双击
await app.click(1200, 500, { space: 'screen', button: 'right' });
await app.click(200, 200, { space: 'client' });                // 不管标题栏高度
```

#### 其它鼠标方法

```js
await app.doubleClick(x, y, options?);
await app.rightClick(x, y, options?);
await app.moveMouse(x, y, { space, duration: 300 });           // 只移动，触发悬停
await app.drag({x, y}, {x, y}, { space, button, duration: 500 });
await app.scroll({ deltaY: -3, deltaX: 0, x?, y?, space? });   // 正数向上
```

`scroll` 不传 `x/y` 时在窗口客户区中心滚动。

### 1.6 键盘

```js
await app.type('你好 🚀\n第二行', { interval: 12 });   // interval=0 一次性投递
await app.press('enter', { times: 2 });
await app.hotkey('ctrl+shift+s');
await app.keyDown('shift');  await app.click(...);  await app.keyUp('shift');  // 按住修饰键点击
await app.clear();                                     // ctrl+a + delete
```

`type()` 用 `KEYEVENTF_UNICODE` 直接投递字符，**不走键盘布局、不触发输入法候选框**，所以中文、emoji、全角符号都能输入。`\n` 会转成回车键，`\t` 转成 Tab。

### 1.7 窗口控制

```js
await app.activate();                      // 激活并置前（自动处理前台锁）
app.maximize(); app.minimize(); app.restore();
app.setBounds({ x, y, width, height });    // 缺省字段保持不变
app.setAlwaysOnTop(true);
await app.close({ waitMs: 3000 });         // 发 WM_CLOSE，等价用户点 ×
app.wait(500);                             // 等待毫秒
```

### 1.8 构造参数

```js
new AppSession(info, { autoActivate: true, actionDelay: 60 });
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `autoActivate` | `true` | 每次输入前自动把窗口带到前台（必须，否则键会打到别的窗口） |
| `actionDelay` | `60` | 每个动作后的固定延迟，网络慢的应用可加大 |

---

## 2. 窗口 window.js

### 2.1 `windowInfo`

#### `windowInfo(hwnd) → object | null`

```js
{
  hwnd: 658042n,
  handle: '0xa071a',
  title: 'README.txt - Notepad',
  className: 'Notepad',
  pid: 20316,
  processName: 'Notepad.exe',
  processShortName: 'notepad',
  processPath: 'C:\\Windows\\System32\\notepad.exe',
  rect: { x: 304, y: 294, width: 2860, height: 1502 },   // DWM 可见边界
  clientRect: { x: 306, y: 294, width: 2856, height: 1500 },
  visible: true,
  minimized: false,
  maximized: false,
  focused: true,
  state: 'normal' | 'minimized' | 'maximized',
  dpi: 192,
  scaleFactor: 2,
  area: 4295720
}
```

### 2.2 枚举与查找

#### `listWindows(options?) → object[]`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `includeHidden` | `false` | 包含不可见窗口 |
| `includeCloaked` | `false` | 包含被 DWM 隐藏的窗口（UWP 挂起态） |
| `includeUntitled` | `false` | 包含无标题窗口 |
| `includeToolWindows` | `false` | 包含工具窗口（输入法、托盘溢出等） |
| `includeMinimized` | `true` | 包含最小化窗口 |

结果按「聚焦优先 → 面积降序」排序。

#### `findWindows(query, options?) → object[]`

返回所有匹配项，带 `score` 字段降序排列。

#### `findWindow(query, options?) → object | null`

返回分数最高的一个。

#### `requireWindow(query, options?) → object`

找不到时抛错，错误信息包含当前可用窗口列表，便于 AI 自我纠正。

**query 支持的写法：**

| 字段 | 类型 | 说明 | 权重 |
| --- | --- | --- | --- |
| `process` | string \| RegExp | 进程名，`Notepad.exe` / `notepad` 都行 | 600 |
| `title` | string \| RegExp | 标题，默认模糊匹配（含即算） | 700 |
| `class` / `className` | string \| RegExp | 窗口类名 | 300 |
| `pid` | number | 进程 ID | 精确 |
| `hwnd` | bigint \| number \| string | 句柄，精确匹配直接返回 | 10000 |
| `exact` | boolean | `true` 时字符串必须完全相等 | — |

多个字段是 **AND** 关系。完全相等 > 前缀 > 包含匹配，同名多窗口时还会参考可见性、是否最小化、面积、是否聚焦做微调。

```js
findWindow({ process: 'notepad' });
findWindow({ process: 'chrome', title: /GitHub/ });
findWindow({ title: '百度一下，你就知道', exact: true });
findWindow({ hwnd: '0xa071a' });
```

> **命中多个窗口时**：`findWindows()` 会返回全部候选（带 `score`），`findWindow()` 只取最高分。
> 如果多个窗口分数相同，说明条件不足以区分——请加 `title` 收窄，或直接用 `hwnd` 锁定。
> 想让标题必须完全一致（避免 `README.txt` 和 `README.md` 同时命中），传 `exact: true`。

> **序列化提醒**：`windowInfo` 的 `hwnd` 是 bigint，`JSON.stringify` 会抛错。
> 需要落盘或走网络时用 `toJSONSafe(info)`，或 `JSON.stringify(info, bigintReplacer)`，
> 句柄会被转成 `"0xa071a"` 字符串（`toHwnd` 能原样解析回来）。

### 2.3 窗口控制

| 函数 | 说明 |
| --- | --- |
| `activate(hwnd, {settle=120}) → Promise<{ok, method}>` | 激活置前。三级兜底：`SetForegroundWindow` → `AttachThreadInput` 绕过前台锁 → 最小化再还原 |
| `maximize(hwnd)` / `minimize(hwnd)` / `restore(hwnd)` | 返回最新窗口信息 |
| `hide(hwnd)` / `show(hwnd)` | 隐藏 / 不激活地显示 |
| `setBounds(hwnd, {x,y,width,height})` | 移动或改尺寸，缺省字段不变 |
| `setAlwaysOnTop(hwnd, true)` | 置顶 |
| `close(hwnd, {waitMs=3000}) → Promise<{closed}>` | 发 `WM_CLOSE`（等价用户点 ×），等窗口消失 |
| `waitForWindow(query, {timeout, interval}) → Promise<info>` | 轮询等待窗口出现 |
| `waitForWindowClose(query, {timeout}) → Promise<boolean>` | 等待窗口消失 |
| `clearProcessCache()` | 清进程路径缓存（进程重启后 PID 可能复用） |

### 2.4 坐标换算

```js
clientToScreen(hwnd, {x, y});   // 客户区 → 屏幕
screenToClient(hwnd, {x, y});   // 屏幕 → 客户区
```

---

## 3. 截图 capture.js

| 函数 | 说明 |
| --- | --- |
| `captureWindow(hwnd, {method, restoreMinimized})` | 抓窗口，返回 `{width, height, screenX, screenY, data(RGBA), method, info}` |
| `captureScreen({x, y, width, height})` | 抓屏幕任意区域 |
| `transformImage(image, {maxWidth, scale, grid, mark})` | 缩放/网格/标记，返回 `{data, width, height, scale}` |
| `toPNG(image, {stripAlpha=true})` | 编码 PNG（全不透明时自动用 RGB，体积小 25%） |
| `toDataURL(image)` | `data:image/png;base64,...` |
| `savePNG(image, path)` | 保存并返回绝对路径 |

`captureWindow` 遇到最小化窗口会先还原（`restoreMinimized: true`），还原后窗口尺寸会变，内部会重新读取。

---

## 4. 输入 input.js

底层的屏幕坐标 API，不带会话状态。一般用 `AppSession` 的方法即可。

### 鼠标

```js
moveMouse(x, y, { duration: 0, steps? });     // duration>0 走缓动轨迹
click(x, y, { button: 'left', clicks: 1, interval: 60, moveDuration: 0 });
doubleClick(x, y, options?);
rightClick(x, y, options?);
mouseDown(button?, at?); mouseUp(button?, at?);   // 手动按下/松开，配合做精细拖拽
drag({x,y}, {x,y}, { button: 'left', duration: 500, settle: 120 });
scroll({ deltaY: -3, deltaX: 0, at: {x,y}, steps: 1 });  // 1 格 = 120 单位
cursorPos();                                   // {x, y}
```

坐标一律是**屏幕物理像素**，内部会按虚拟桌面归一化到 0~65535（支持多显示器、负坐标）。

### 键盘

```js
typeText('文本', { interval: 12 });      // interval=0 一次性投递
pressKey('enter', { times: 1, interval: 50 });
hotkey('ctrl+shift+s');
keyDown('shift'); keyUp('shift');
clearText();                             // ctrl+a + delete
resolveKey('f5');                        // 查虚拟键码，可用于调试
```

支持的键名：`a-z`、`0-9`、`f1`~`f24`、`enter`/`tab`/`esc`/`space`/`backspace`/`delete`/`insert`/`home`/`end`/`pageup`/`pagedown`、`up`/`down`/`left`/`right`（也接受 `arrowup` 等）、`ctrl`/`shift`/`alt`/`win`、`capslock`/`numlock`/`printscreen`/`pause`/`apps`，以及 `; , . / \ [ ] ' - = \`` 等符号。

---

## 5. AI 工具层 tools.js

### 5.1 工具清单

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `list_windows` | 列出所有可见窗口 | — |
| `attach_window` | 按进程/标题/句柄绑定窗口 | `process` / `title` / `hwnd` |
| `launch_app` | 启动应用并绑定 | `path`, `args`, `timeout` |
| `get_window_info` | 当前窗口信息 | — |
| `screenshot` | 截图 | `max_width`, `grid`, `method` |
| `click` | 左键点击 | `x`, `y`, `clicks` |
| `right_click` | 右键点击 | `x`, `y` |
| `move_mouse` | 移动鼠标 | `x`, `y` |
| `drag` | 拖拽 | `from_x`, `from_y`, `to_x`, `to_y` |
| `scroll` | 滚轮 | `amount`, `x?`, `y?` |
| `type_text` | 输入文本 | `text`, `interval` |
| `press_key` | 按键 | `key`, `times` |
| `hotkey` | 组合键 | `combo` |
| `wait` | 等待 | `ms` |
| `wait_for_stable` | 等界面稳定 | `timeout`, `threshold` |
| `window_control` | 聚焦/最大化/最小化/还原/关闭/调整尺寸 | `action`, `width?`, `height?` |

`x/y` 一律是**最近一次截图返回的图片像素坐标**。

### 5.2 创建与调用

```js
const kit = createToolkit({
  session,              // 初始会话，可为空（之后用 attach_window 绑定）
  autoScreenshot: true, // 动作后自动返回新截图
  maxWidth: 1600,       // 自动截图的最大宽度
  throwOnError: false,  // true 时错误直接抛，false 时返回 {ok:false, error}
});

kit.tools;           // 原始定义
kit.openaiTools;     // [{type:'function', function:{...}}]
kit.anthropicTools;  // [{name, description, input_schema}]

const res = await kit.call('click', { x: 400, y: 300 });
// { ok: true, tool: 'click', result: {...}, screenshot: {base64, width, height, scale} }
// { ok: false, tool: 'click', error: '...' }
```

`session` 是 getter/setter，`attach_window` / `launch_app` 成功后会自动切换。

### 5.3 提示词

```js
buildSystemPrompt({ session, task })  // 返回一段中文系统提示词
```

内容包含：先截图再行动、坐标系说明、输入前先点输入框、加载时用 `wait_for_stable`、不要点不可逆按钮等约束。可按需追加自己的规则。

---

## 6. 命令行

完整的手册（含脚本调用示例）见 [CLI.md](./CLI.md)。命令与 API 一一对应：

```
node cli.js list [--all]                       列出可见窗口
node cli.js find   [定位参数]                  显示匹配结果与分数
node cli.js info   [定位参数]                  窗口详细信息
node cli.js shot   [定位参数] [--out] [--max-width] [--grid] [--method] [--base64]
node cli.js state  [--clear]                   查看/清除截图坐标映射
node cli.js click  <x> <y> [--space] [--button] [--clicks] [--duration]
node cli.js dclick <x> <y>                     双击
node cli.js rclick <x> <y>                     右键
node cli.js move   <x> <y> [--duration]
node cli.js drag   <x1> <y1> <x2> <y2>
node cli.js scroll <格数> [--x --y]
node cli.js type   <文本> [--interval]
node cli.js press  <键名> [--times]            单键，含 + 时自动按组合键
node cli.js key    <组合键>
node cli.js activate / win <action>            聚焦/最大化/最小化/还原/关闭/resize
node cli.js stable [--timeout] [--threshold]
node cli.js wait   <毫秒>
node cli.js launch <exe> [--args] [-- 参数...]
node cli.js run    <steps.json|->              批量执行工具调用
node cli.js tools  [--openai|--anthropic]
node cli.js dpi
```

通用参数：`--app`（进程名/标题模糊匹配）、`--title`、`--hwnd`、`--json`。

**坐标状态跨进程保留**：`shot` 会把这张图对应的屏幕原点、缩放比例写入 `%TEMP%\optionjs-lastshot.json`，
之后的 `click/move/drag/scroll` 默认按该图的像素坐标换算，因此命令可以分多次执行。
`--space screen|image|client` 可强制指定坐标系（命令行下 `click` 默认 `auto`：有截图记录用图像坐标，否则用屏幕坐标）。

---

## 7. 错误处理约定

- 找不到窗口：`requireWindow` / `AppSession.attach` **抛错**，信息里含可用窗口列表
- 窗口已关闭：`refresh()` 抛 `窗口「xxx」已关闭`
- 权限不足：`SendInput` 抛错并提示「若目标以管理员权限运行，请以管理员身份启动本程序」
- 最小化无法截图：抛错并提示先 `restore()`
- `createToolkit` 默认**不抛错**，返回 `{ok:false, error}`，方便模型看到错误后自我纠正

全部错误都是标准 `Error`，`message` 为中文，可直接展示给用户或塞回模型。
