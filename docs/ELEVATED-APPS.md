# 操作"以管理员身份运行"的应用

有些应用（WeGame、游戏启动器、部分安全软件控制台）会以管理员权限运行。
此时普通权限的脚本对它们做模拟点击，会遇到一个非常迷惑的现象：

**命令全部成功、截图正常、但界面纹丝不动。**

原因不是坐标错了，而是 Windows 的 **UIPI（User Interface Privilege Isolation）**：

> 低完整性级别的进程，不允许把模拟输入（`SendInput`）和大部分窗口消息（`PostMessage`）
> 投递给高完整性级别的窗口。这个拦截是**静默的**——API 返回成功，输入被丢弃。

## 怎么确认是这个原因

```js
import { isElevated } from './src/native/win32.js';
console.log(isElevated());   // false → 你自己不是管理员
```

三个快速判据：

| 现象 | 说明 |
| --- | --- |
| `PostMessageW` 返回 `false` | 消息被 UIPI 拦了，目标窗口 Integrity 更高 |
| `SetCursorPos` 返回 `false`，或光标不动 | 提权窗口在前台时，输入注入被整段拦截 |
| 把目标窗口切到后台后鼠标立刻恢复正常 | 说明拦截只发生在"高权限窗口在前台"时 |

最后一条是最有说服力的实验：`Win+D` 回到桌面，再 `SetCursorPos` 就成功了。

## 解决办法：提权输入桥

用管理员身份跑一个常驻进程，把能力暴露成本机 HTTP 接口；普通权限的脚本通过它操作提权应用。

```bash
# ① 以管理员身份打开一个终端（右键 → 以管理员身份运行），然后：
cd optionJs
node bridge.js --port 8791 --token mytoken

# 输出里会显示：权限: 管理员（可操作提权应用）
```

```js
// ② 普通权限的脚本照常用，只是把调用换成桥
import { createBridgeClient } from './src/bridge-client.js';

const pc = createBridgeClient({ port: 8791, token: 'mytoken' });

console.log(await pc.health());            // { ok: true, elevated: true, ... }
await pc.attach({ process: 'wegame' });
const shot = await pc.screenshot({ maxWidth: 1200 });   // 返回 base64
await pc.screenshotFile('before.png', { maxWidth: 1200 });
await pc.click({ x: 600, y: 566 });                      // 坐标 = 截图图像坐标
await pc.type('要输入的文字');
await pc.hotkey('ctrl+s');
```

命令行也能直接打：

```bash
curl -X POST http://127.0.0.1:8791/attach -H "X-OptionJS-Token: mytoken" -d "{\"process\":\"wegame\"}"
curl "http://127.0.0.1:8791/screenshot?maxWidth=1200&format=base64" -H "X-OptionJS-Token: mytoken"
curl -X POST http://127.0.0.1:8791/click -H "X-OptionJS-Token: mytoken" -d "{\"x\":600,\"y\":566}"
```

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 桥状态，含 `elevated` 是否管理员 |
| GET | `/windows?process=&title=` | 列出窗口 |
| POST | `/attach` | `{process|title|hwnd}` 绑定窗口 |
| GET | `/info` | 当前窗口信息 |
| GET | `/screenshot?maxWidth=&grid=&format=base64` | 截图，返回 base64 |
| POST | `/click` | `{x,y,clicks,button,space}` |
| POST | `/move` | `{x,y}` |
| POST | `/drag` | `{from_x,from_y,to_x,to_y}` |
| POST | `/scroll` | `{amount,x?,y?}` |
| POST | `/type` | `{text,interval}` |
| POST | `/key` | `{combo}` 或 `{key,times}` |
| POST | `/activate` | 激活窗口 |
| POST | `/wait_stable` | `{timeout,threshold}` |
| POST | `/close` | 发 `WM_CLOSE` |

坐标语义和 SDK 完全一致：**最近一次 `/screenshot` 的图像像素坐标**，桥内部自动换算。

## 安全

- 只监听 `127.0.0.1`，不对外网开放
- 建议设置 `--token`，否则同一台机器上任何进程都能通过它输入（等于接管键鼠）
- 桥进程本身是管理员权限，**用完记得关掉**

## 另外两种绕过方式（各有代价）

1. **让目标应用以普通权限运行** —— 从根上避免 UIPI，但很多启动器强制要求管理员，做不到
2. **整条链路都以管理员运行** —— 把自动化脚本本身提权，效果等同桥，但每次都要 UAC，也不方便长驻

## 还有一种情况：反作弊驱动

如果以管理员运行后仍然点不动，很可能是反作弊（如 TenProtect / ACE）在内核层拦截注入输入。
这类拦截连管理员也绕不过，属于设计目标，只能改用官方提供的启动能力
（命令行参数、`wegame://` 之类的协议链接），或者让人工完成那一步。
