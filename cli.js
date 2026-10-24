#!/usr/bin/env node
/**
 * optionjs 命令行工具 —— 用一条条命令驱动整个 SDK，不写代码也能操作应用。
 *
 * 设计要点：
 * 1. 命令与 API 一一对应，覆盖窗口识别、截图、鼠标、键盘、窗口控制、批处理。
 * 2. 跨进程保持坐标映射：`shot` 会把「这张图对应屏幕哪里、缩放多少」
 *    写进系统临时目录，之后的 `click` 就能直接用截图里的像素坐标。
 * 3. 所有命令都支持 `--json`，方便被 shell 脚本或其它语言的智能体解析。
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppSession } from './src/session.js';
import { listWindows, findWindows } from './src/window.js';
import { savePNG, toPNG } from './src/capture.js';
import { createToolkit, toOpenAITools, toAnthropicTools, toolDefinitions } from './src/tools.js';
import { dpiAwareness, virtualScreen, primaryScreen } from './src/native/win32.js';

/* ------------------------------------------------------------------ *
 * 截图坐标状态（跨进程）
 * ------------------------------------------------------------------ */
const STATE_FILE = path.join(os.tmpdir(), 'optionjs-lastshot.json');

function readStateAll() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStateAll(all) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch {
    /* 临时目录不可写时静默失败，不影响主流程 */
  }
}

function getShotState(handle) {
  return readStateAll()[handle] || null;
}

function setShotState(handle, state) {
  const all = readStateAll();
  all[handle] = state;
  writeStateAll(all);
}

/* ------------------------------------------------------------------ *
 * 帮助
 * ------------------------------------------------------------------ */
const HELP = `
optionjs —— 用命令行操作 Windows 桌面应用

窗口定位（所有命令通用）
  --app <名字>        进程名（可省 .exe）或标题的一部分
  --title <文本>      按标题匹配
  --hwnd <十六进制>   直接指定句柄，如 0xa071a
  --json              以 JSON 输出，便于脚本解析

观察
  list [--all]                        列出可见窗口（--all 含隐藏/工具窗口）
  find  [定位参数]                    查找匹配窗口并显示分数
  info  [定位参数]                    窗口标题/进程/位置/客户区/DPI
  shot  [定位参数] [--out a.png]      截图（落盘 + 记录坐标映射）
        [--max-width 1400] [--grid 100] [--method auto|screen|print]
        [--base64]                    只输出 base64，便于管道传递

鼠标（坐标默认 = 最近一次 shot 的图像像素）
  click  <x> <y> [--button left|right|middle] [--clicks 2] [--space screen|image|client]
  dclick <x> <y>                      双击
  rclick <x> <y>                      右键
  move   <x> <y> [--duration 300]     移动鼠标
  drag   <x1> <y1> <x2> <y2> [--duration 500]
  scroll <格数> [--x 100 --y 200]     正数向上，负数向下

键盘
  type  <文本> [--interval 12]        输入文本（支持中文/emoji/多行）
  press <键名> [--times 1]            按单键：enter / tab / esc / f5 / down ...
  key   <组合键>                      组合键：ctrl+s / alt+f4 / win+r

窗口控制
  activate [定位参数]                 激活并置前
  win <focus|maximize|minimize|restore|close|resize>
      resize 时可加 --width --height --x --y

其它
  stable [--timeout 4000] [--threshold 0.002]   等界面稳定
  wait <毫秒>
  launch <exe> [--args "a b"] [--timeout 20000] [-- 参数...]
  run <文件.json|->                   批量执行工具调用
  state [--clear]                     查看/清除截图坐标映射
  tools [--openai|--anthropic]        输出 AI 工具 schema
  dpi                                 查看 DPI 感知与屏幕信息

示例
  node cli.js list
  node cli.js launch notepad.exe
  node cli.js shot --app notepad --out a.png --grid 100
  node cli.js click --app notepad 400 300        # 用 a.png 里的像素坐标
  node cli.js type --app notepad "你好世界"
  node cli.js key --app notepad ctrl+s
  node cli.js win maximize --app notepad
  node cli.js shot --app notepad --base64 > b64.txt
`;

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */
const OPTION_DEFS = {
  app: { type: 'string' },
  title: { type: 'string' },
  hwnd: { type: 'string' },
  out: { type: 'string' },
  'out-dir': { type: 'string' },
  'max-width': { type: 'string' },
  grid: { type: 'string' },
  method: { type: 'string' },
  space: { type: 'string' },
  button: { type: 'string' },
  clicks: { type: 'string' },
  duration: { type: 'string' },
  interval: { type: 'string' },
  times: { type: 'string' },
  threshold: { type: 'string' },
  timeout: { type: 'string' },
  amount: { type: 'string' },
  x: { type: 'string' },
  y: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  args: { type: 'string' },
  base64: { type: 'boolean' },
  json: { type: 'boolean' },
  all: { type: 'boolean' },
  clear: { type: 'boolean' },
  openai: { type: 'boolean' },
  anthropic: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const VALUE_OPTIONS = new Set(
  Object.entries(OPTION_DEFS)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => `--${name}`)
);

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true, // 允许 --x -100 这类负值（多显示器坐标）
  strict: false,
  options: OPTION_DEFS,
});

const command = positionals[0];

const num = (v, fallback) => {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数不是数字：${v}`);
  return n;
};

function out(data) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else console.log(data);
}

/* ------------------------------------------------------------------ *
 * 会话与坐标
 * ------------------------------------------------------------------ */
function resolveSession() {
  if (flags.hwnd) return AppSession.attach({ hwnd: flags.hwnd });
  const query = {};
  if (flags.app) query.process = flags.app;
  if (flags.title) query.title = flags.title;
  if (!Object.keys(query).length) {
    throw new Error('请用 --app / --title / --hwnd 指定目标窗口（可先跑 node cli.js list 看看有什么）');
  }
  return AppSession.attach(query);
}

/**
 * 把命令行给的坐标解析成屏幕坐标。
 * space=auto 时：有该窗口的截图记录就按图像坐标算，否则按屏幕坐标。
 */
function resolvePoint(session, x, y) {
  const space = flags.space || 'auto';
  if (space === 'client') return session.clientToScreen(x, y);
  if (space === 'screen') return { x: Math.round(x), y: Math.round(y) };

  const st = getShotState(session.handle);
  if (!st) {
    if (space === 'image') {
      throw new Error('该窗口还没有截图记录，无法使用图像坐标。请先执行 shot，或加 --space screen');
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  const rect = session.info.rect;
  if (
    Math.abs(rect.x - st.winX) > 1 ||
    Math.abs(rect.y - st.winY) > 1 ||
    Math.abs(rect.width - st.winW) > 1 ||
    Math.abs(rect.height - st.winH) > 1
  ) {
    console.error('⚠️  窗口在截图后移动或缩放过，图像坐标可能偏移，建议重新执行 shot');
  }

  const nx = Math.max(0, Math.min(st.nativeWidth - 1, x / st.scale));
  const ny = Math.max(0, Math.min(st.nativeHeight - 1, y / st.scale));
  return { x: Math.round(st.screenX + nx), y: Math.round(st.screenY + ny) };
}

function pointArgs() {
  const [x, y] = numericArgs(2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要两个数字参数：<x> <y>');
  return { x, y };
}

/**
 * 取命令后面的若干数字参数。
 * 负数（如 `scroll -2`、负坐标）会被 parseArgs 当成未知选项吞掉，
 * 所以解析结果不够时，回退到原始 argv 里按位置扫描。
 */
function numericArgs(count) {
  const parsed = positionals.slice(1).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (parsed.length >= count) return parsed.slice(0, count);

  const raw = process.argv.slice(2);
  const from = raw.indexOf(command) + 1;
  const found = [];
  for (let i = from; i < raw.length; i++) {
    const token = raw[i];
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const name = token.split('=')[0];
      if (VALUE_OPTIONS.has(name) && !token.includes('=')) i++; // 跳过该选项的值
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      i++;
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) found.push(Number(token));
  }
  return found.slice(0, count);
}

/* ------------------------------------------------------------------ *
 * 各命令实现
 * ------------------------------------------------------------------ */
const commands = {
  async list() {
    const windows = listWindows(flags.all ? { includeHidden: true, includeToolWindows: true } : {});
    if (flags.json) {
      out(
        windows.map((w) => ({
          handle: w.handle,
          title: w.title,
          process: w.processName,
          pid: w.pid,
          rect: w.rect,
          focused: w.focused,
          state: w.state,
          dpi: w.dpi,
        }))
      );
      return;
    }
    console.log(`共 ${windows.length} 个窗口（DPI 感知: ${dpiAwareness}）\n`);
    for (const w of windows) {
      console.log(
        `${w.focused ? '▶' : ' '} ${String(w.handle).padEnd(9)} ${String(w.processName || '?').padEnd(22)} ` +
          `${String(w.rect.width).padStart(5)}x${String(w.rect.height).padEnd(5)} @${w.rect.x},${w.rect.y}  ${w.title}`
      );
    }
  },

  async find() {
    const query = {};
    if (flags.app) query.process = flags.app;
    if (flags.title) query.title = flags.title;
    if (!Object.keys(query).length) throw new Error('请用 --app 或 --title 指定匹配条件');
    const matches = findWindows(query);
    if (!matches.length) {
      out(flags.json ? { matches: [] } : '没有匹配的窗口');
      return;
    }
    if (flags.json) {
      out(matches.map(({ hwnd, ...rest }) => rest));
      return;
    }
    console.log(`匹配到 ${matches.length} 个窗口：`);
    for (const m of matches) {
      console.log(`  分数 ${String(m.score).padStart(5)}  ${m.handle.padEnd(9)} ${m.processName} | ${m.title}`);
    }
  },

  async info() {
    const info = resolveSession().info;
    if (flags.json) {
      out(info);
      return;
    }
    console.log(
      [
        `标题:   ${info.title}`,
        `进程:   ${info.processName} (PID ${info.pid})`,
        `句柄:   ${info.handle}`,
        `窗口:   ${info.rect.width}x${info.rect.height} @ ${info.rect.x},${info.rect.y}`,
        `客户区: ${info.clientRect.width}x${info.clientRect.height} @ ${info.clientRect.x},${info.clientRect.y}`,
        `状态:   ${info.state} | 聚焦: ${info.focused} | DPI: ${info.dpi} (${info.scaleFactor}x)`,
      ].join('\n')
    );
  },

  async shot() {
    const session = resolveSession();
    const shot = await session.screenshot({
      maxWidth: num(flags['max-width'], undefined),
      grid: num(flags.grid, undefined),
      method: flags.method || 'auto',
      format: 'raw',
    });

    const file = flags.out || `shot-${Date.now()}.png`;
    let abs = null;
    if (!flags.base64) abs = savePNG(shot.image, file);

    // 不管是否落盘，都记住这张图与屏幕的映射，后续命令才能用图像坐标
    const rect = session.info.rect;
    setShotState(session.handle, {
      handle: session.handle,
      title: shot.window.title,
      screenX: shot.screenX,
      screenY: shot.screenY,
      scale: shot.scale,
      width: shot.width,
      height: shot.height,
      nativeWidth: shot.nativeWidth,
      nativeHeight: shot.nativeHeight,
      winX: rect.x,
      winY: rect.y,
      winW: rect.width,
      winH: rect.height,
      at: Date.now(),
    });

    if (flags.base64) {
      process.stdout.write(toPNG(shot.image).toString('base64'));
      return;
    }
    if (flags.json) {
      out({
        path: abs,
        width: shot.width,
        height: shot.height,
        scale: shot.scale,
        method: shot.method,
        screenX: shot.screenX,
        screenY: shot.screenY,
      });
      return;
    }
    console.log(`已保存: ${abs}`);
    console.log(`图像: ${shot.width}x${shot.height}（原生 ${shot.nativeWidth}x${shot.nativeHeight}，缩放 ${shot.scale.toFixed(3)}，方式 ${shot.method}）`);
    console.log(`下一步可用这张图的像素坐标操作，例如: node cli.js click --app <名字> <x> <y>`);
  },

  async click() {
    const session = resolveSession();
    const { x, y } = pointArgs();
    const pt = resolvePoint(session, x, y);
    const res = await session.click(pt.x, pt.y, {
      space: 'screen',
      button: flags.button || 'left',
      clicks: num(flags.clicks, 1),
      moveDuration: num(flags.duration, 0),
    });
    out(flags.json ? res : `已点击屏幕坐标 (${res.x}, ${res.y})，按键 ${res.button}×${res.clicks}`);
  },

  async dclick() {
    flags.clicks = '2';
    return commands.click();
  },

  async rclick() {
    flags.button = 'right';
    return commands.click();
  },

  async move() {
    const session = resolveSession();
    const { x, y } = pointArgs();
    const pt = resolvePoint(session, x, y);
    const res = await session.moveMouse(pt.x, pt.y, { space: 'screen', duration: num(flags.duration, 300) });
    out(flags.json ? res : `鼠标已移动到屏幕坐标 (${pt.x}, ${pt.y})`);
  },

  async drag() {
    const session = resolveSession();
    const vals = numericArgs(4);
    if (vals.length < 4 || vals.some((v) => !Number.isFinite(v))) {
      throw new Error('用法: drag <x1> <y1> <x2> <y2>');
    }
    const from = resolvePoint(session, vals[0], vals[1]);
    const to = resolvePoint(session, vals[2], vals[3]);
    const res = await session.drag(
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
      { space: 'screen', duration: num(flags.duration, 500) }
    );
    out(flags.json ? res : `已从 (${res.from.x}, ${res.from.y}) 拖到 (${res.to.x}, ${res.to.y})`);
  },

  async scroll() {
    const session = resolveSession();
    const amount = flags.amount != null ? num(flags.amount, 0) : numericArgs(1)[0];
    if (!amount) throw new Error('用法: scroll <格数> 或 scroll --amount -2（正数向上，负数向下）');
    let at;
    if (flags.x != null && flags.y != null) {
      at = resolvePoint(session, num(flags.x, 0), num(flags.y, 0));
    }
    const res = await session.scroll({ deltaY: amount, x: at?.x, y: at?.y, space: 'screen' });
    out(flags.json ? res : `已滚动 ${amount} 格`);
  },

  async type() {
    const session = resolveSession();
    const text = positionals.slice(1).join(' ');
    if (!text) throw new Error('用法: type <文本>');
    await session.type(text, { interval: num(flags.interval, 12) });
    out(flags.json ? { typed: text.length } : `已输入 ${text.length} 个字符`);
  },

  async press() {
    const session = resolveSession();
    const key = positionals[1];
    if (!key) throw new Error('用法: press <键名>，如 enter / tab / f5');
    if (key.includes('+')) {
      // 顺手支持 ctrl+s 这种写法，用户不用记两个命令
      await session.hotkey(key);
      out(flags.json ? { combo: key } : `已按下 ${key}`);
      return;
    }
    const times = num(flags.times, 1);
    await session.press(key, { times });
    out(flags.json ? { key, times } : `已按键 ${key} × ${times}`);
  },

  async key() {
    const session = resolveSession();
    const combo = positionals[1];
    if (!combo) throw new Error('用法: key <组合键>，如 ctrl+s');
    await session.hotkey(combo);
    out(flags.json ? { combo } : `已按下 ${combo}`);
  },

  async activate() {
    const session = resolveSession();
    const res = await session.activate();
    out(flags.json ? res : `已激活窗口「${session.title}」`);
  },

  async win() {
    const session = resolveSession();
    const action = positionals[1];
    switch (action) {
      case 'focus':
        await session.activate();
        out(flags.json ? { focused: true } : '已聚焦');
        break;
      case 'maximize':
        session.maximize();
        out(flags.json ? session.info.rect : '已最大化');
        break;
      case 'minimize':
        session.minimize();
        out(flags.json ? { minimized: true } : '已最小化');
        break;
      case 'restore':
        session.restore();
        out(flags.json ? session.info.rect : '已还原');
        break;
      case 'close': {
        const res = await session.close({ waitMs: num(flags.timeout, 3000) });
        out(flags.json ? res : res.closed ? '窗口已关闭' : '窗口未关闭（可能有未保存提示）');
        break;
      }
      case 'resize': {
        const info = session.setBounds({
          x: num(flags.x, undefined),
          y: num(flags.y, undefined),
          width: num(flags.width, undefined),
          height: num(flags.height, undefined),
        });
        out(flags.json ? info.rect : `已调整为 ${info.rect.width}x${info.rect.height} @ ${info.rect.x},${info.rect.y}`);
        break;
      }
      default:
        throw new Error('用法: win <focus|maximize|minimize|restore|close|resize>');
    }
  },

  async stable() {
    const session = resolveSession();
    const res = await session.waitForStable({
      timeout: num(flags.timeout, 8000),
      threshold: num(flags.threshold, 0.002),
    });
    out(flags.json ? res : res.stable ? `界面已稳定（差异 ${(res.diff * 100).toFixed(3)}%）` : `超时仍未稳定（差异 ${(res.diff * 100).toFixed(3)}%）`);
  },

  async wait() {
    const ms = num(positionals[1], 500);
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
    out(flags.json ? { waited: ms } : `已等待 ${ms} 毫秒`);
  },

  async launch() {
    const exe = positionals[1];
    if (!exe) throw new Error('用法: launch <exe> [--args "a b"] [-- 参数...]');
    const extra = flags.args ? String(flags.args).split(/\s+/).filter(Boolean) : [];
    const rest = positionals.slice(2);
    const session = await AppSession.launch(exe, {
      args: [...extra, ...rest],
      timeout: num(flags.timeout, 20000),
    });
    const info = session.info;
    out(
      flags.json
        ? { handle: info.handle, title: info.title, process: info.processName, rect: info.rect }
        : `已启动「${info.title}」\n句柄: ${info.handle}\n窗口: ${info.rect.width}x${info.rect.height} @ ${info.rect.x},${info.rect.y}`
    );
  },

  /**
   * 批量执行：按顺序跑一串工具调用。
   * 文件格式：[{"tool":"attach_window","args":{"process":"notepad"}}, {"tool":"click","args":{"x":400,"y":300}}]
   */
  async run() {
    const file = positionals[1];
    if (!file) throw new Error('用法: run <steps.json|-> （- 表示从 stdin 读）');
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const steps = Array.isArray(parsed) ? parsed : parsed.steps || [];
    if (!steps.length) throw new Error('步骤列表为空');

    const outDir = flags['out-dir'] || `run-${Date.now()}`;
    const baseSession = flags.app || flags.title || flags.hwnd ? resolveSession() : null;
    const kit = createToolkit({
      session: baseSession,
      maxWidth: num(flags['max-width'], 1400),
      autoScreenshot: true,
    });

    const log = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const name = step.tool || step.cmd;
      const args = step.args || {};
      const res = await kit.call(name, args);

      // 需要留档的截图存到 out-dir
      if (res.screenshot?.base64 && (step.save || step.tool === 'screenshot')) {
        fs.mkdirSync(outDir, { recursive: true });
        const file2 = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${name}.png`);
        fs.writeFileSync(file2, Buffer.from(res.screenshot.base64, 'base64'));
        res.savedTo = file2;
      }

      log.push({
        step: i + 1,
        tool: name,
        ok: res.ok,
        error: res.error,
        result: res.result,
        savedTo: res.savedTo,
      });
      if (!flags.json) {
        console.log(`${String(i + 1).padStart(2, '0')}. ${name.padEnd(14)} ${res.ok ? '✅' : '❌'} ${res.error || ''}${res.savedTo ? ` → ${res.savedTo}` : ''}`);
      }
      if (!res.ok && step.stopOnError !== false) {
        if (flags.json) out(log);
        throw new Error(`第 ${i + 1} 步失败，已中止：${res.error}`);
      }
    }

    if (flags.json) out(log);
    else console.log(`\n共 ${log.length} 步，成功 ${log.filter((l) => l.ok).length} 步`);
  },

  async state() {
    const all = readStateAll();
    if (flags.clear) {
      if (flags.hwnd || flags.app || flags.title) {
        const handle = resolveSession().handle;
        delete all[handle];
        writeStateAll(all);
        out(flags.json ? { cleared: handle } : `已清除 ${handle} 的截图坐标映射`);
      } else {
        writeStateAll({});
        out(flags.json ? { cleared: 'all' } : '已清除全部截图坐标映射');
      }
      return;
    }
    const entries = Object.entries(all);
    if (!entries.length) {
      out(flags.json ? {} : '暂无截图坐标映射（先执行一次 shot）');
      return;
    }
    if (flags.json) {
      out(all);
      return;
    }
    console.log('已记录的截图坐标映射：');
    for (const [handle, s] of entries) {
      console.log(
        `  ${handle}  图像 ${s.width}x${s.height} 缩放 ${s.scale.toFixed(3)} 原点 (${s.screenX},${s.screenY})  ${new Date(s.at).toLocaleString()}  「${s.title}」`
      );
    }
  },

  async tools() {
    const defs = flags.openai ? toOpenAITools() : flags.anthropic ? toAnthropicTools() : toolDefinitions;
    console.log(JSON.stringify(defs, null, 2));
  },

  async dpi() {
    const vs = virtualScreen();
    const ps = primaryScreen();
    out(
      flags.json
        ? { dpiAwareness, virtualScreen: vs, primaryScreen: ps }
        : [`DPI 感知模式: ${dpiAwareness}`, `主屏分辨率: ${ps.width}x${ps.height}`, `虚拟桌面: ${vs.width}x${vs.height} @ ${vs.x},${vs.y}`].join('\n')
    );
  },
};

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
async function main() {
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }
  const handler = commands[command];
  if (!handler) {
    console.error(`未知命令: ${command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  await handler();
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
});
