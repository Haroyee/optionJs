# 命令行手册

不写一行代码，只用 `node cli.js <命令>` 就能完成「找窗口 → 看画面 → 点鼠标 → 敲键盘」的完整流程。
也可以被 Bash / Python / 任意语言的脚本直接调用，或者作为 AI 智能体唯一需要的工具入口。

```bash
node cli.js --help          # 查看全部命令
```

> 想让命令更短：`npm link` 之后可以直接用 `optionjs list`。

---

## 1. 一个完整流程

```bash
# ① 启动应用（进程独立存活，关掉终端也不影响它）
node cli.js launch notepad.exe

# ② 截图，同时把这"张图对应屏幕哪里、缩放多少"记下来
node cli.js shot --app notepad --out step1.png --max-width 1200 --grid 100

# ③ 用 step1.png 里的像素坐标点击（左上角是 0,0）
node cli.js click --app notepad 480 200

# ④ 输入文字、按回车
node cli.js type  --app notepad "你好，这是命令行输入的"
node cli.js press --app notepad enter
node cli.js type  --app notepad "第二行"

# ⑤ 再截一张确认结果
node cli.js shot --app notepad --out step2.png --max-width 1200

# ⑥ 快捷键保存、最大化窗口
node cli.js key --app notepad ctrl+s
node cli.js win maximize --app notepad
```

关键点：**第 ③ 步用的是第 ② 步图片里的像素坐标**。CLI 会把截图与屏幕的映射关系写进系统临时目录（`%TEMP%\optionjs-lastshot.json`），所以每条命令是独立进程也能正确换算。

```bash
node cli.js state            # 看看当前记了哪些窗口的坐标映射
node cli.js state --clear    # 清掉（截图后窗口位置变了，建议重截）
```

如果窗口在截图之后被拖动或缩放过，CLI 会在 stderr 打印提醒。

## 2. 窗口怎么定位

所有需要目标窗口的命令都支持这三个参数，可组合使用：

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `--app <名字>` | 进程名（可省 `.exe`）或标题片段 | `--app notepad` |
| `--title <文本>` | 标题匹配（支持部分匹配） | `--title "README.txt"` |
| `--hwnd <十六进制>` | 直接指定句柄，最精确 | `--hwnd 0x707dc` |

匹配是**打分制**：完全相等 > 前缀 > 包含；同名多窗口时优先可见、非最小化、面积大、当前聚焦的那个。
不确定匹配到哪个时，先跑：

```bash
node cli.js find --app notepad     # 显示所有候选和分数
```

### 命中多个窗口时

同名进程开多个窗口很常见（两个记事本、多个 Chrome 窗口）。此时 CLI 会在 stderr 提示：

```
⚠️  有 2 个窗口匹配度相同，正在操作「无标题 - Notepad」(0x30806)
   要精确指定：--title <标题片段> / --hwnd <句柄>，node cli.js find 可查看全部候选
```

消除歧义的三步：

```bash
# ① 加标题片段（最常用）
node cli.js click --app notepad --title "README" 480 200

# ② 标题会变（记事本标题随内容变、浏览器标题随页面变）→ 用句柄
node cli.js find --app notepad                      # 先看句柄
node cli.js click --hwnd 0x5079a 480 200            # 之后一直用它，最稳

# ③ 自己启动的窗口，launch 已经把正确的句柄绑好了，不用再选
node cli.js launch notepad.exe
```

**一个坑**：标题匹配默认是"包含"关系，`--title README` 会同时命中 `README.txt - Notepad` 和 `README.md - Notepad`。
要唯一命中，用 `--hwnd`，或者用 API 的 `exact: true` / 正则。

### 选择顺序建议

| 场景 | 用什么 |
| --- | --- |
| 常规单窗口应用 | `--app 进程名` |
| 同类应用开了多个窗口 | `--app` + `--title 片段` |
| 标题动态变化 | `--hwnd` 句柄 |
| 自己启动的应用 | `launch`（自动绑定新窗口） |
| 需要复现的脚本 | 先用 `find` 拿到句柄，脚本里写死句柄最稳定 |

## 3. 三种坐标

| `--space` | 含义 | 什么时候用 |
| --- | --- | --- |
| 不传（默认 `auto`） | 有该窗口的截图记录 → 按**图像坐标**；没有 → 按屏幕坐标 | 日常使用，跟着 `shot` 走 |
| `image` | 强制图像坐标 | 要求必须基于截图定位 |
| `screen` | 屏幕物理像素 | 从别的工具拿到的绝对坐标 |
| `client` | 窗口客户区坐标（不含标题栏） | 不关心标题栏高度的布局计算 |

```bash
node cli.js click --app notepad 480 200                 # 图像坐标（默认）
node cli.js click --app notepad 1448 771 --space screen  # 屏幕坐标
node cli.js click --app notepad 200 150 --space client   # 客户区坐标
```

越界坐标会被自动收敛到窗口内，不会误点到别的应用上。

## 4. 命令参考

### 观察

| 命令 | 说明 |
| --- | --- |
| `list [--all]` | 列出可见窗口；`--all` 含隐藏窗口与工具窗口 |
| `find [定位参数]` | 显示所有匹配窗口及匹配分数 |
| `info [定位参数]` | 标题、进程、位置、客户区、状态、DPI |
| `shot [定位参数]` | 截图并保存，同时记录坐标映射 |
| `state [--clear]` | 查看/清除已记录的坐标映射 |
| `dpi` | DPI 感知模式与屏幕分辨率（坐标全错时先查这个） |

`shot` 选项：

| 选项 | 说明 |
| --- | --- |
| `--out <文件>` | 保存路径，默认 `shot-<时间戳>.png` |
| `--max-width <n>` | 限制宽度，等比缩小（省流量，视觉模型推荐 1200~1600） |
| `--grid <n>` | 叠加坐标网格，间距 n 像素（模型定位更准） |
| `--method auto\|screen\|print` | 抓取方式：前台抓屏最准，后台 `print` 可抓被遮挡窗口 |
| `--base64` | 不落盘，只把 base64 写到 stdout（方便管道传给别的工具） |

### 鼠标

坐标参数按 `--space` 解释，默认图像坐标。

```bash
node cli.js click  <x> <y> [--button left|right|middle] [--clicks 2] [--duration 0]
node cli.js dclick <x> <y>            # 双击
node cli.js rclick <x> <y>            # 右键
node cli.js move   <x> <y> [--duration 300]   # 只移动，触发悬停
node cli.js drag   <x1> <y1> <x2> <y2> [--duration 500]
node cli.js scroll <格数> [--x <x> --y <y>]   # 正数向上，负数向下
```

### 键盘

```bash
node cli.js type  <文本> [--interval 12]   # 支持中文、emoji、多行
node cli.js press <键名> [--times 1]       # enter / tab / esc / f5 / down / delete ...
node cli.js key   <组合键>                 # ctrl+s / alt+f4 / win+r / ctrl+shift+t
```

`type` 走 Unicode 直接投递，**不受输入法影响**，中文和 emoji 一次到位。
`press` 如果收到带 `+` 的键名会自动当组合键处理，写 `press ctrl+s` 也能用。

### 窗口控制

```bash
node cli.js activate                 # 激活并置前
node cli.js win focus                # 同上
node cli.js win maximize
node cli.js win minimize
node cli.js win restore
node cli.js win close                # 发 WM_CLOSE，等价用户点 ×
node cli.js win resize --width 1200 --height 800 [--x 100 --y 100]
```

### 其它

```bash
node cli.js stable [--timeout 4000] [--threshold 0.002]   # 等界面不再变化
node cli.js wait 500                                      # 固定等待毫秒
node cli.js launch <exe> [--args "a b"] [-- 参数...] [--timeout 20000]
node cli.js tools [--openai|--anthropic]                   # 导出 AI 工具 schema
node cli.js run <steps.json|->                             # 批量执行
```

## 5. 批量模式

一条条敲命令太碎？把步骤写成 JSON，一次跑完：

```json
[
  { "tool": "launch_app", "args": { "path": "notepad.exe" } },
  { "tool": "window_control", "args": { "action": "maximize" } },
  { "tool": "screenshot", "args": { "max_width": 1200 }, "save": true },
  { "tool": "click", "args": { "x": 420, "y": 160 } },
  { "tool": "type_text", "args": { "text": "一行 JSON 就能驱动一串操作" } },
  { "tool": "press_key", "args": { "key": "enter" } },
  { "tool": "screenshot", "args": { "max_width": 1200 }, "save": true }
]
```

```bash
node cli.js run steps.json --out-dir run1
```

```
01. launch_app     ✅
02. window_control ✅
03. screenshot     ✅  → run1\03-screenshot.png
04. click          ✅
05. type_text      ✅
06. press_key      ✅
07. screenshot     ✅  → run1\09-screenshot.png

共 7 步，成功 7 步
```

- `tool` 名与 [API 工具清单](./API.md#51-工具清单) 一致
- `save: true` 会把该步截图存到 `--out-dir`
- 某步失败默认中止；该步加 `"stopOnError": false` 可跳过继续
- `--json` 输出结构化日志，便于上层程序解析
- 也可以从 stdin 读：`cat steps.json | node cli.js run -`

`run` 模式下坐标语义与 API 完全一致（工具内部自带截图映射），不需要关心 `--space`。

## 6. 在脚本里调用

### Bash

```bash
#!/bin/bash
set -euo pipefail

node cli.js launch notepad.exe >/dev/null
node cli.js shot --app notepad --out /tmp/s.png --max-width 1200 >/dev/null
node cli.js click --app notepad 480 200
node cli.js type  --app notepad "由 shell 脚本写入"
node cli.js shot --app notepad --out /tmp/s2.png --max-width 1200 >/dev/null

# 拿 JSON 结果做判断
FOCUSED=$(node cli.js info --app notepad --json | node -pe "JSON.parse(require('fs').readFileSync(0)).focused")
echo "窗口是否聚焦: $FOCUSED"
```

### Python

```python
import json, subprocess

def oj(*args, **kw):
    r = subprocess.run(["node", "cli.js", *args], capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()

oj("launch", "notepad.exe")
oj("shot", "--app", "notepad", "--out", "s.png", "--max-width", "1200")
oj("click", "--app", "notepad", "480", "200")
oj("type", "--app", "notepad", "来自 Python 的输入")

info = json.loads(oj("info", "--app", "notepad", "--json"))
print(info["title"], info["rect"])
```

### 让大模型通过命令行操作

两个思路：

1. **直接暴露 CLI 给 agent 的 shell 工具**。把 `node cli.js --help` 作为工具说明，模型自己拼命令。简单，但坐标要模型自己记（`shot` 写了状态文件，所以 `click` 能直接用图像坐标，这点已经解决了）。
2. **用 `run` 一次下发整条动作序列**。模型只输出一份 JSON 计划，本地一次性执行并回传截图：

```bash
node cli.js shot --app excel --base64 | some-vision-api   # 看看现在的界面
node cli.js run actions.json --json                        # 执行计划
```

第二种更省往返、更好审计。工具的完整 schema 可以用 `node cli.js tools --openai` 导出。

## 7. 退出码与输出

| 情况 | 退出码 | 输出 |
| --- | --- | --- |
| 成功 | `0` | 人类可读文本；加 `--json` 则是 JSON |
| 参数错误 / 找不到窗口 / 操作失败 | `1` | `错误: <原因>` 打到 stderr |
| 未知命令 | `1` | 提示未知命令并打印帮助 |

- 正常信息走 **stdout**，警告和错误走 **stderr**，方便 `>` 重定向与管道
- `--json` 下 stdout 只有 JSON，不会有别的杂音

## 8. 常见问题

**报「请用 --app / --title / --hwnd 指定目标窗口」**
先 `node cli.js list` 看看窗口标题，用 `--app 进程名` 或 `--title 片段`。

**点击位置偏了**
① 确认用的是最新一次 `shot` 的图（窗口动过就重截）；② `node cli.js dpi` 确认 `per-monitor-v2`；③ 截图加 `--grid 100` 辅助定位。

**所有命令都找不到窗口 / 截图全黑**
以管理员权限运行的目标程序需要同样提权的终端；独占全屏游戏抓不到，改为窗口模式。

**`type` 输入没进去**
先用 `click` 点中输入框，看到光标再输入；输入法候选框不会干扰（走 Unicode 通道）。

**窗口被别的程序挡住了截图是黑的**
加 `--method screen` 前先把窗口激活（`node cli.js activate`），或保持默认 `auto` 让它走后台绘制。

**发 `win close` 后窗口还在**
说明弹了「是否保存更改」对话框——`WM_CLOSE` 只是请问一句，没有替你决定。处理方式：

```bash
node cli.js shot --app notepad --out d.png --max-width 900   # 看一眼对话框
node cli.js click --app notepad 446 269                      # 点"不保存"（按截图定位）
```

批量关闭时写个循环：截图 → 判断对话框是否还在 → 点"不保存" → 直到窗口消失。
多标签页的记事本会给**每个未保存标签**各弹一次，所以必须循环，不能只点一次。

> Windows 11 记事本关闭时会把标签页记到下一次启动，所以即使点了"不保存"，
> 下次打开仍可能恢复这些标签——想彻底清掉，请在记事本里手动关闭对应标签。
