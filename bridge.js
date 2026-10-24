#!/usr/bin/env node
/**
 * 提权输入桥（elevated input bridge）
 *
 * 解决的问题：
 *   有些应用（WeGame、游戏启动器、部分杀软控制台）以管理员权限运行，
 *   普通权限的进程对它们做 SendInput / PostMessage 会被 UIPI 直接丢弃，
 *   表现是"点了没反应、截图正常、命令不报错"。
 *
 * 做法：
 *   用管理员身份跑一个常驻进程，把 SDK 的截图/点击/输入能力暴露成本机 HTTP 接口，
 *   普通权限的脚本（或 AI Agent）通过 127.0.0.1 调用，由桥进程完成真正的注入。
 *
 * 启动：
 *   node bridge.js --port 8791 [--token <随机串>]
 *   （必须由管理员终端启动，或由管理员进程拉起；否则对提权应用无效）
 *
 * 调用：
 *   curl http://127.0.0.1:8791/health
 *   curl -X POST http://127.0.0.1:8791/attach -d '{"process":"wegame"}'
 *   curl "http://127.0.0.1:8791/screenshot?maxWidth=1200&format=base64"
 *   curl -X POST http://127.0.0.1:8791/click -d '{"x":600,"y":566}'
 *
 * 安全：只监听 127.0.0.1；建议加 --token，加了这个头才能调用：
 *   X-OptionJS-Token: <token>
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { AppSession } from './src/session.js';
import { listWindows, findWindows } from './src/window.js';
import { isElevated } from './src/native/win32.js';

const { values: flags } = parseArgs({
  strict: false,
  options: {
    port: { type: 'string' },
    token: { type: 'string' },
    host: { type: 'string' },
  },
});

const PORT = Number(flags.port || process.env.OPTIONJS_BRIDGE_PORT || 8791);
const HOST = flags.host || '127.0.0.1';
const TOKEN = flags.token || process.env.OPTIONJS_BRIDGE_TOKEN || '';

const state = { session: null };

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

function requireSession() {
  if (!state.session) throw new Error('尚未绑定窗口，请先调用 /attach 或 /launch');
  return state.session;
}

/* ---------------- 路由 ---------------- */
const routes = {
  'GET /health': () => ({
    ok: true,
    pid: process.pid,
    elevated: isElevated(),
    session: state.session ? { handle: state.session.handle, title: state.session.title } : null,
    uptime: Math.round(process.uptime()),
  }),

  'GET /windows': (query) => {
    const windows = listWindows();
    const filt = query.process || query.title;
    const list = filt ? findWindows(query.process ? { process: query.process } : { title: query.title }) : windows;
    return {
      count: list.length,
      windows: list.map((w) => ({
        handle: w.handle,
        title: w.title,
        process: w.processName,
        pid: w.pid,
        rect: w.rect,
        focused: w.focused,
        state: w.state,
      })),
    };
  },

  'POST /attach': (query, body) => {
    const session = AppSession.attach({ process: body.process, title: body.title, hwnd: body.hwnd });
    state.session = session;
    const info = session.info;
    return { attached: true, handle: info.handle, title: info.title, process: info.processName, rect: info.rect };
  },

  'GET /info': () => {
    const info = requireSession().info;
    return {
      handle: info.handle,
      title: info.title,
      process: info.processName,
      rect: info.rect,
      clientRect: info.clientRect,
      focused: info.focused,
      state: info.state,
      scaleFactor: info.scaleFactor,
    };
  },

  'GET /screenshot': async (query) => {
    const session = requireSession();
    const format = query.format || 'base64';
    const shot = await session.screenshot({
      maxWidth: query.maxWidth ? Number(query.maxWidth) : 1200,
      grid: query.grid ? Number(query.grid) : undefined,
      method: query.method || 'auto',
      format,
    });
    return {
      width: shot.width,
      height: shot.height,
      nativeWidth: shot.nativeWidth,
      nativeHeight: shot.nativeHeight,
      scale: shot.scale,
      screenX: shot.screenX,
      screenY: shot.screenY,
      method: shot.method,
      base64: shot.base64 || undefined,
    };
  },

  'POST /click': async (q, body) => {
    const res = await requireSession().click(body.x, body.y, {
      space: body.space || 'image',
      button: body.button || 'left',
      clicks: body.clicks || 1,
      moveDuration: body.moveDuration || 0,
    });
    return { clicked: true, at: { x: res.x, y: res.y }, clicks: res.clicks };
  },

  'POST /move': async (q, body) => {
    const pt = await requireSession().moveMouse(body.x, body.y, { space: body.space || 'image' });
    return { moved: true, at: pt };
  },

  'POST /drag': async (q, body) => {
    const res = await requireSession().drag({ x: body.from_x, y: body.from_y }, { x: body.to_x, y: body.to_y });
    return { dragged: true, from: res.from, to: res.to };
  },

  'POST /scroll': async (q, body) => {
    const res = await requireSession().scroll({ deltaY: body.amount, x: body.x, y: body.y });
    return { scrolled: true, deltaY: res.deltaY };
  },

  'POST /type': async (q, body) => {
    await requireSession().type(body.text, { interval: body.interval ?? 12 });
    return { typed: String(body.text).length };
  },

  'POST /key': async (q, body) => {
    if (body.combo) {
      await requireSession().hotkey(body.combo);
      return { combo: body.combo };
    }
    await requireSession().press(body.key, { times: body.times || 1 });
    return { key: body.key, times: body.times || 1 };
  },

  'POST /activate': async () => {
    await requireSession().activate();
    return { activated: true };
  },

  'POST /wait_stable': async (q, body) => {
    const res = await requireSession().waitForStable({ timeout: body.timeout || 8000, threshold: body.threshold || 0.002 });
    return res;
  },

  'POST /close': async () => {
    const res = await requireSession().close({ waitMs: 3000 });
    return res;
  },
};

/* ---------------- HTTP ---------------- */
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (TOKEN && req.headers['x-optionjs-token'] !== TOKEN) {
    return send(res, 401, { ok: false, error: '缺少或错误的 X-OptionJS-Token' });
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = Object.fromEntries(url.searchParams);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { ok: false, error: `未知接口：${key}` });

  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
    }
  }

  try {
    const result = await handler(query, body);
    log(key, '→ ok');
    send(res, 200, { ok: true, ...result });
  } catch (err) {
    log(key, '→ 失败:', err.message);
    send(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const elevated = isElevated();
  console.log('────────────────────────────────────────────');
  console.log(` optionjs 提权输入桥  http://${HOST}:${PORT}`);
  console.log(` 进程 PID: ${process.pid}`);
  console.log(` 权限: ${elevated ? '管理员（可操作提权应用）' : '普通权限（无法操作提权应用，请用管理员终端启动）'}`);
  console.log(` Token: ${TOKEN || '(未设置)'}`);
  console.log('────────────────────────────────────────────');
  if (!elevated) {
    console.log('提示：当前不是管理员权限。若目标应用以管理员运行，输入仍会被 UIPI 拦截。');
  }
});
