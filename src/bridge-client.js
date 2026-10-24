/**
 * 提权输入桥的客户端。
 *
 * 用于普通权限的脚本操作"以管理员运行"的应用：
 *
 *   // 先在管理员终端启动桥： node bridge.js --port 8791
 *   import { createBridgeClient } from './src/bridge-client.js';
 *   const pc = createBridgeClient({ port: 8791 });
 *   await pc.attach({ process: 'wegame' });
 *   const shot = await pc.screenshot({ maxWidth: 1200 });   // 拿到 base64
 *   await pc.click({ x: 600, y: 566 });                      // 坐标 = 截图图像坐标
 */
import fs from 'node:fs';

export function createBridgeClient({ port = 8791, host = '127.0.0.1', token, timeout = 30000 } = {}) {
  const base = `http://${host}:${port}`;

  async function call(method, path, body, query) {
    const url = new URL(path, base);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-OptionJS-Token': token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `桥返回失败（HTTP ${res.status}）`);
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`桥调用超时（${timeout}ms）：${method} ${path}`);
      if (err.code === 'ECONNREFUSED') {
        throw new Error(`连不上输入桥 ${base}。请先以管理员身份运行：node bridge.js --port ${port}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base,
    call,
    health: () => call('GET', '/health'),
    windows: (query) => call('GET', '/windows', null, query),
    attach: (query) => call('POST', '/attach', query),
    info: () => call('GET', '/info'),

    /** 截图，返回 { width, height, scale, base64, ... } */
    screenshot: (opts = {}) => call('GET', '/screenshot', null, opts),
    /** 截图并落盘，返回文件路径 */
    async screenshotFile(file, opts = {}) {
      const shot = await call('GET', '/screenshot', null, opts);
      fs.writeFileSync(file, Buffer.from(shot.base64, 'base64'));
      return { ...shot, path: file };
    },

    click: (opts) => call('POST', '/click', opts),
    move: (opts) => call('POST', '/move', opts),
    drag: (opts) => call('POST', '/drag', opts),
    scroll: (opts) => call('POST', '/scroll', opts),
    type: (text, opts = {}) => call('POST', '/type', { text, ...opts }),
    press: (key, opts = {}) => call('POST', '/key', { key, ...opts }),
    hotkey: (combo) => call('POST', '/key', { combo }),
    activate: () => call('POST', '/activate'),
    waitStable: (opts = {}) => call('POST', '/wait_stable', opts),
    close: () => call('POST', '/close'),
  };
}
