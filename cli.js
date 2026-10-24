#!/usr/bin/env node
/**
 * optionjs 命令行工具。
 *
 * 用于手动验证与快速排障，也可以被 shell 脚本 / 其它语言的智能体直接调用。
 *
 *   node cli.js list
 *   node cli.js find --app notepad
 *   node cli.js shot --app notepad --out shot.png --grid 100
 *   node cli.js click --app notepad 400 300
 *   node cli.js type --app notepad "你好"
 *   node cli.js key --app notepad ctrl+s
 *   node cli.js tools
 */
import { parseArgs } from 'node:util';
import { AppSession } from './src/session.js';
import { listWindows, findWindows } from './src/window.js';
import { savePNG } from './src/capture.js';
import { toolDefinitions } from './src/tools.js';
import { dpiAwareness } from './src/native/win32.js';

const HELP = `
optionjs —— Windows 桌面应用自动化命令行

用法：
  node cli.js <命令> [选项]

命令：
  list                        列出当前可见窗口
  find   --app <名字>         查找窗口（进程名或标题），显示匹配度排序
  info   --app <名字>         显示窗口详细信息
  shot   --app <名字>         截图并保存
  click  --app <名字> <x> <y> 点击（坐标默认为截图图像坐标）
  type   --app <名字> <文本>  输入文本
  key    --app <名字> <组合键> 按组合键，如 ctrl+s
  tools                       输出 AI 工具（function schema）JSON
  dpi                         显示 DPI 感知状态与屏幕信息

通用选项：
  --app <name>        进程名（可省略 .exe）或窗口标题的一部分
  --title <text>      用标题匹配窗口（与 --app 可同时使用）
  --hwnd <hex>        直接指定窗口句柄
  --json              以 JSON 输出结果

shot 选项：
  --out <file>        保存路径，默认 shot-<时间戳>.png
  --max-width <n>     限制图片最大宽度（缩小省流量）
  --grid <n>          叠加坐标网格，间距 n 像素
  --method <m>        auto | screen | print

click 选项：
  --space <s>         image（默认，上一次 shot 的图像坐标）| screen | client
  --button <b>        left | right | middle
  --clicks <n>        连击次数

type 选项：
  --interval <ms>     每字符间隔，默认 12
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    app: { type: 'string' },
    title: { type: 'string' },
    hwnd: { type: 'string' },
    out: { type: 'string' },
    'max-width': { type: 'string' },
    grid: { type: 'string' },
    method: { type: 'string' },
    space: { type: 'string' },
    button: { type: 'string' },
    clicks: { type: 'string' },
    interval: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];

function out(data) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function resolveSession() {
  if (flags.hwnd) return AppSession.attach({ hwnd: flags.hwnd });
  const query = {};
  if (flags.app) query.process = flags.app;
  if (flags.title) query.title = flags.title;
  if (!Object.keys(query).length) {
    throw new Error('请用 --app / --title / --hwnd 指定目标窗口');
  }
  return AppSession.attach(query);
}

async function main() {
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'list': {
      const windows = listWindows();
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
          }))
        );
      } else {
        console.log(`共 ${windows.length} 个可见窗口（DPI: ${dpiAwareness}）\n`);
        for (const w of windows) {
          console.log(
            `${w.focused ? '▶' : ' '} ${String(w.handle).padEnd(10)} ${String(w.processName || '?').padEnd(22)} ` +
              `${String(w.rect.width)}x${w.rect.height} @${w.rect.x},${w.rect.y}  ${w.title}`
          );
        }
      }
      break;
    }

    case 'find': {
      const query = {};
      if (flags.app) query.process = flags.app;
      if (flags.title) query.title = flags.title;
      if (!Object.keys(query).length) throw new Error('请用 --app 或 --title 指定匹配条件');
      const matches = findWindows(query);
      if (!matches.length) {
        console.log('没有匹配的窗口');
        break;
      }
      if (flags.json) {
        out(matches.map(({ hwnd, ...rest }) => rest));
      } else {
        console.log(`匹配到 ${matches.length} 个窗口：`);
        for (const m of matches) {
          console.log(`  分数 ${String(m.score).padStart(5)}  ${m.handle.padEnd(10)} ${m.processName} | ${m.title}`);
        }
      }
      break;
    }

    case 'info': {
      const session = resolveSession();
      const info = session.info;
      out(
        flags.json
          ? info
          : [
              `标题: ${info.title}`,
              `进程: ${info.processName} (PID ${info.pid})`,
              `句柄: ${info.handle}`,
              `窗口: ${info.rect.width}x${info.rect.height} @ ${info.rect.x},${info.rect.y}`,
              `客户区: ${info.clientRect.width}x${info.clientRect.height} @ ${info.clientRect.x},${info.clientRect.y}`,
              `状态: ${info.state} | 聚焦: ${info.focused} | DPI: ${info.dpi} (${info.scaleFactor}x)`,
            ].join('\n')
      );
      break;
    }

    case 'shot': {
      const session = resolveSession();
      const shot = await session.screenshot({
        maxWidth: flags['max-width'] ? Number(flags['max-width']) : undefined,
        grid: flags.grid ? Number(flags.grid) : undefined,
        method: flags.method || 'auto',
        format: 'raw',
      });
      const file = flags.out || `shot-${Date.now()}.png`;
      const abs = savePNG(shot.image, file);
      if (flags.json) {
        out({ path: abs, width: shot.width, height: shot.height, scale: shot.scale, method: shot.method });
      } else {
        console.log(`已保存: ${abs}`);
        console.log(`图像尺寸: ${shot.width}x${shot.height}（原生 ${shot.nativeWidth}x${shot.nativeHeight}，缩放 ${shot.scale.toFixed(3)}）`);
        console.log(`抓取方式: ${shot.method} | 图片左上角对应屏幕 (${shot.screenX}, ${shot.screenY})`);
      }
      break;
    }

    case 'click': {
      const session = resolveSession();
      const x = Number(positionals[1]);
      const y = Number(positionals[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('用法: click --app <名字> <x> <y>');
      const res = await session.click(x, y, {
        space: flags.space || 'screen',
        button: flags.button || 'left',
        clicks: flags.clicks ? Number(flags.clicks) : 1,
      });
      out(flags.json ? res : `已点击屏幕坐标 (${res.x}, ${res.y})，按键 ${res.button}`);
      break;
    }

    case 'type': {
      const session = resolveSession();
      const text = positionals.slice(1).join(' ');
      if (!text) throw new Error('用法: type --app <名字> <文本>');
      await session.type(text, { interval: flags.interval ? Number(flags.interval) : 12 });
      out(flags.json ? { typed: text.length } : `已输入 ${text.length} 个字符`);
      break;
    }

    case 'key': {
      const session = resolveSession();
      const combo = positionals[1];
      if (!combo) throw new Error('用法: key --app <名字> <组合键>，如 ctrl+s');
      await session.hotkey(combo);
      out(flags.json ? { combo } : `已按下 ${combo}`);
      break;
    }

    case 'tools': {
      console.log(JSON.stringify(flags.json ? { tools: toolDefinitions } : toolDefinitions, null, 2));
      break;
    }

    case 'dpi': {
      const { virtualScreen, primaryScreen } = await import('./src/native/win32.js');
      const vs = virtualScreen();
      const ps = primaryScreen();
      out(
        flags.json
          ? { dpiAwareness, virtualScreen: vs, primaryScreen: ps }
          : [
              `DPI 感知模式: ${dpiAwareness}`,
              `主屏分辨率: ${ps.width}x${ps.height}`,
              `虚拟桌面: ${vs.width}x${vs.height} @ ${vs.x},${vs.y}`,
            ].join('\n')
      );
      break;
    }

    default:
      console.error(`未知命令: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
});
