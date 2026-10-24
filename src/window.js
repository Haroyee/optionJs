/**
 * 窗口识别与控制。
 *
 * 核心能力：
 * - 枚举所有顶层窗口，并附带进程名、客户区、DPI、状态等信息
 * - 用「标题 / 进程名 / 窗口类名 / PID / 句柄」任意组合匹配，返回打分排序的候选
 * - 激活前置、移动缩放、最大化最小化、关闭
 */
import path from 'node:path';
import koffi from 'koffi';
import {
  CONST,
  EnumWindows,
  EnumWindowsProc,
  IsIconic,
  IsWindow,
  IsWindowVisible,
  IsZoomed,
  GetForegroundWindow,
  ShowWindow,
  SetForegroundWindow,
  BringWindowToTop,
  SetWindowPos,
  PostMessageW,
  AttachThreadInput,
  GetCurrentThreadId,
  GetWindowThreadProcessId,
  ClientToScreen as Win32ClientToScreen,
  ScreenToClient as Win32ScreenToClient,
  toHwnd,
  hwndToHex,
  windowRect,
  extendedFrameBounds,
  clientRect,
  windowTitle,
  windowClass,
  windowPid,
  processPath,
  isCloaked,
  getStyle,
  getExStyle,
  windowDpi,
  lastError,
  virtualScreen,
  sleep,
} from './native/win32.js';

const processPathCache = new Map();

function processInfo(pid) {
  if (processPathCache.has(pid)) return processPathCache.get(pid);
  const full = processPath(pid);
  const info = full
    ? {
        processPath: full,
        processName: path.basename(full),
        processNameShort: path.basename(full, path.extname(full)).toLowerCase(),
      }
    : { processPath: null, processName: null, processNameShort: null };
  processPathCache.set(pid, info);
  return info;
}

/** 清空进程路径缓存（进程重启后 PID 可能复用）。 */
export function clearProcessCache() {
  processPathCache.clear();
}

/**
 * 读取单个窗口的完整信息。
 * @param {bigint|number|string} hwndOrHandle
 */
export function windowInfo(hwndOrHandle) {
  const hwnd = toHwnd(hwndOrHandle);
  if (!IsWindow(hwnd)) return null;

  const pid = windowPid(hwnd);
  const proc = processInfo(pid);
  const dpi = windowDpi(hwnd);

  // DWM 边框更贴近肉眼所见；失败时退回 GetWindowRect
  const rect = extendedFrameBounds(hwnd) || windowRect(hwnd);
  const client = clientRect(hwnd);
  const minimized = IsIconic(hwnd);
  const maximized = IsZoomed(hwnd);
  const foreground = GetForegroundWindow() === hwnd;

  return {
    hwnd,
    handle: hwndToHex(hwnd),
    title: windowTitle(hwnd),
    className: windowClass(hwnd),
    pid,
    processName: proc.processName,
    processShortName: proc.processNameShort,
    processPath: proc.processPath,
    rect,
    clientRect: client,
    visible: IsWindowVisible(hwnd),
    minimized,
    maximized,
    focused: foreground,
    state: minimized ? 'minimized' : maximized ? 'maximized' : 'normal',
    dpi,
    scaleFactor: dpi / 96,
    area: rect ? rect.width * rect.height : 0,
  };
}

/**
 * 枚举顶层窗口。
 * @param {object} [options]
 * @param {boolean} [options.includeHidden=false] 包含不可见窗口
 * @param {boolean} [options.includeCloaked=false] 包含被 DWM 隐藏的窗口（UWP 挂起态）
 * @param {boolean} [options.includeUntitled=false] 包含无标题窗口
 * @param {boolean} [options.includeToolWindows=false] 包含工具窗口（托盘溢出、输入法等）
 * @param {boolean} [options.includeMinimized=true] 包含最小化窗口
 * @param {boolean} [options.skipOffscreen=true] 过滤掉停在屏幕外（-32000,-32000）的窗口
 */
export function listWindows(options = {}) {
  const {
    includeHidden = false,
    includeCloaked = false,
    includeUntitled = false,
    includeToolWindows = false,
    includeMinimized = true,
    skipOffscreen = true,
  } = options;

  const virtual = skipOffscreen ? virtualScreen() : null;

  const handles = [];
  const callback = koffi.register((hwnd) => {
    handles.push(hwnd);
    return true;
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }

  const result = [];
  for (const hwnd of handles) {
    const visible = IsWindowVisible(hwnd);
    if (!visible && !includeHidden) continue;
    if (!includeCloaked && isCloaked(hwnd)) continue;

    if (!includeToolWindows && getExStyle(hwnd) & CONST.WS_EX_TOOLWINDOW) continue;

    const info = windowInfo(hwnd);
    if (!info) continue;
    if (!info.title && !includeUntitled) continue;
    if (!info.rect || info.area < 100) continue;
    if (!includeMinimized && info.minimized) continue;

    // 有些应用（浏览器、输入法）会留一个停在 -32000,-32000 的隐藏辅助窗口，
    // 最小化窗口也会被系统停在那里，所以只过滤"非最小化且完全在屏幕外"的
    if (virtual && !info.minimized) {
      const r = info.rect;
      const offscreen =
        r.x + r.width <= virtual.x ||
        r.y + r.height <= virtual.y ||
        r.x >= virtual.x + virtual.width ||
        r.y >= virtual.y + virtual.height;
      if (offscreen) continue;
    }

    result.push(info);
  }

  // 可见且聚焦的排前面，其次按面积从大到小
  result.sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return b.area - a.area;
  });
  return result;
}

/**
 * 把查询条件归一化。
 * 支持字符串简写：'notepad' 等价于 { process: 'notepad' } 或标题包含。
 */
function normalizeQuery(query) {
  if (query == null) return {};
  if (typeof query === 'string' || query instanceof RegExp) {
    return { title: query };
  }
  if (typeof query === 'bigint' || typeof query === 'number') {
    return { hwnd: query };
  }
  return { ...query };
}

function matchText(actual, expected, weights, exactFlag = false) {
  if (expected == null) return null;
  if (expected instanceof RegExp) {
    return expected.test(actual || '') ? weights.regex : -Infinity;
  }
  const a = (actual || '').toLowerCase();
  const e = String(expected).toLowerCase();
  if (a === e) return weights.exact;
  if (exactFlag) return -Infinity;
  if (a.startsWith(e)) return weights.prefix;
  if (a.includes(e)) return weights.contains;
  return -Infinity;
}

/**
 * 按条件给窗口打分。返回 -Infinity 表示不匹配。
 */
export function scoreWindow(info, rawQuery) {
  const query = normalizeQuery(rawQuery);
  const { title, process: proc, class: cls, className, pid, hwnd, exact = false } = query;

  if (hwnd != null) {
    const target = toHwnd(hwnd);
    return info.hwnd === target ? 10000 : -Infinity;
  }
  if (pid != null && info.pid !== Number(pid)) return -Infinity;

  let score = 0;
  let matchedSomething = false;

  if (proc != null) {
    const procScore = Math.max(
      matchText(info.processName, proc, { exact: 600, prefix: 520, contains: 420, regex: 500 }, exact) ?? -Infinity,
      matchText(info.processShortName, proc, { exact: 600, prefix: 520, contains: 420, regex: 500 }, exact) ?? -Infinity
    );
    if (procScore === -Infinity) return -Infinity;
    score += procScore;
    matchedSomething = true;
  }

  if (title != null) {
    const titleScore = matchText(info.title, title, { exact: 700, prefix: 600, contains: 480, regex: 550 }, exact);
    if (titleScore === -Infinity) return -Infinity;
    score += titleScore;
    matchedSomething = true;
  }

  const classQuery = cls ?? className;
  if (classQuery != null) {
    const classScore = matchText(info.className, classQuery, { exact: 300, prefix: 250, contains: 200, regex: 220 }, exact);
    if (classScore === -Infinity) return -Infinity;
    score += classScore;
    matchedSomething = true;
  }

  if (!matchedSomething) {
    // 无条件时，只把有标题的可见窗口当作候选
    score = info.visible ? 100 : 0;
  }

  // 同等匹配下优先可见、非最小化、面积大的窗口
  if (info.visible) score += 20;
  if (info.minimized) score -= 30;
  if (info.focused) score += 15;
  score += Math.min(20, info.area / 100000);

  return score;
}

/**
 * 查找所有匹配窗口，按分数降序。
 */
export function findWindows(query, options = {}) {
  const all = listWindows({ includeHidden: false, ...options });
  return all
    .map((info) => ({ info, score: scoreWindow(info, query) }))
    .filter((item) => item.score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((item) => ({ ...item.info, score: Math.round(item.score) }));
}

/**
 * 查找单个窗口；找不到时返回 null，多个时返回分数最高者。
 */
export function findWindow(query, options = {}) {
  const matches = findWindows(query, options);
  return matches.length ? matches[0] : null;
}

/**
 * 查找窗口，找不到直接抛错（错误信息里带上当前可用窗口提示）。
 */
export function requireWindow(query, options = {}) {
  const found = findWindow(query, options);
  if (found) return found;
  const sample = listWindows(options)
    .slice(0, 8)
    .map((w) => `${w.processName || '?'} | ${w.title || '(无标题)'}`)
    .join('\n  ');
  throw new Error(
    `未找到匹配窗口：${JSON.stringify(typeof query === 'object' && !(query instanceof RegExp) ? { ...query, hwnd: query.hwnd ? String(query.hwnd) : undefined } : String(query))}\n` +
      `当前可用窗口（前 8 个）：\n  ${sample || '(无)'}`
  );
}

/* ------------------------------------------------------------------ *
 * 窗口控制
 * ------------------------------------------------------------------ */

/**
 * 激活窗口并置前。
 * SetForegroundWindow 在 Windows 上有前台锁限制，这里做三级兜底：
 * 1. 直接调用
 * 2. 最小化则先 restore
 * 3. AttachThreadInput 到当前前台线程再抢焦点
 */
export async function activate(hwndOrHandle, { settle = 120 } = {}) {
  const hwnd = toHwnd(hwndOrHandle);
  if (!IsWindow(hwnd)) {
    throw new Error(`无效窗口句柄：${hwndToHex(hwnd)}（窗口可能已关闭）`);
  }

  if (IsIconic(hwnd)) {
    ShowWindow(hwnd, CONST.SW_RESTORE);
    await sleep(160);
  }

  if (GetForegroundWindow() === hwnd) {
    BringWindowToTop(hwnd);
    if (settle) await sleep(settle);
    return { ok: true, method: 'already-foreground' };
  }

  let method = null;
  if (SetForegroundWindow(hwnd)) method = 'SetForegroundWindow';

  if (GetForegroundWindow() !== hwnd) {
    // 把当前线程的输入队列挂到目标线程上，绕过前台锁
    const fg = GetForegroundWindow();
    const pidBuf = Buffer.alloc(4);
    const fgThread = fg ? GetWindowThreadProcessId(fg, pidBuf) : 0;
    const selfThread = GetCurrentThreadId();
    if (fgThread && fgThread !== selfThread) {
      AttachThreadInput(selfThread, fgThread, true);
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      AttachThreadInput(selfThread, fgThread, false);
      method = 'AttachThreadInput';
    }
    // 最小化后恢复也能带来焦点，作为最后手段
    if (GetForegroundWindow() !== hwnd) {
      ShowWindow(hwnd, CONST.SW_MINIMIZE);
      await sleep(60);
      ShowWindow(hwnd, CONST.SW_RESTORE);
      method = 'minimize-restore';
    }
  }

  const ok = GetForegroundWindow() === hwnd;
  if (settle) await sleep(settle);
  if (!ok) {
    const err = lastError();
    throw new Error(
      `无法激活窗口 ${hwndToHex(hwnd)}：${err.message}。` +
        '若目标以管理员权限运行，请以管理员身份启动本程序。'
    );
  }
  return { ok, method };
}

/** 最大化。 */
export function maximize(hwnd) {
  ShowWindow(toHwnd(hwnd), CONST.SW_SHOWMAXIMIZED);
  return windowInfo(hwnd);
}

/** 最小化。 */
export function minimize(hwnd) {
  ShowWindow(toHwnd(hwnd), CONST.SW_MINIMIZE);
  return windowInfo(hwnd);
}

/** 还原为普通状态。 */
export function restore(hwnd) {
  ShowWindow(toHwnd(hwnd), CONST.SW_RESTORE);
  return windowInfo(hwnd);
}

/** 隐藏窗口。 */
export function hide(hwnd) {
  ShowWindow(toHwnd(hwnd), CONST.SW_HIDE);
}

/** 显示窗口（不激活）。 */
export function show(hwnd) {
  ShowWindow(toHwnd(hwnd), CONST.SW_SHOWNOACTIVATE);
}

/**
 * 移动 / 调整窗口位置尺寸。
 * @param {object} box {x,y,width,height}，缺省的字段保持不变
 */
export function setBounds(hwndOrHandle, box = {}) {
  const hwnd = toHwnd(hwndOrHandle);
  const info = windowInfo(hwnd);
  if (!info) throw new Error('无效窗口句柄');
  const cur = info.rect;
  const x = box.x ?? cur.x;
  const y = box.y ?? cur.y;
  const width = box.width ?? cur.width;
  const height = box.height ?? cur.height;

  if (IsIconic(hwnd) || IsZoomed(hwnd)) {
    ShowWindow(hwnd, CONST.SW_RESTORE);
  }

  const flags = CONST.SWP_NOZORDER | CONST.SWP_NOACTIVATE;
  if (!SetWindowPos(hwnd, 0, x, y, width, height, flags)) {
    const err = lastError();
    throw new Error(`调整窗口失败：${err.message}`);
  }
  return windowInfo(hwnd);
}

/** 置顶 / 取消置顶。 */
export function setAlwaysOnTop(hwnd, onTop = true) {
  const flags = CONST.SWP_NOMOVE | CONST.SWP_NOSIZE | CONST.SWP_NOACTIVATE;
  SetWindowPos(toHwnd(hwnd), onTop ? -1 : -2, 0, 0, 0, 0, flags);
  return windowInfo(hwnd);
}

/** 请求关闭窗口（发送 WM_CLOSE，等同用户点右上角 ×）。 */
export async function close(hwnd, { waitMs = 3000 } = {}) {
  const h = toHwnd(hwnd);
  if (!PostMessageW(h, CONST.WM_CLOSE, 0, 0)) {
    const err = lastError();
    throw new Error(`关闭窗口失败：${err.message}`);
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!IsWindow(h)) return { closed: true };
    await sleep(100);
  }
  return { closed: !IsWindow(h), note: '窗口仍在，可能有未保存内容弹窗拦截' };
}

/** 等待窗口出现。 */
export async function waitForWindow(query, { timeout = 15000, interval = 250, options = {} } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      clearProcessCache();
      const found = findWindow(query, options);
      if (found) return found;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `等待窗口超时（${timeout}ms）：${typeof query === 'string' ? query : JSON.stringify(query)}` +
      (lastError ? `\n最后一次错误：${lastError.message}` : '')
  );
}

/**
 * 等待「新出现」的窗口。
 *
 * 启动应用后用它，能避免"同类应用已经开着，结果绑到了旧窗口"的经典事故。
 *
 * @param {object|string} query 窗口匹配条件
 * @param {Set<string>|string[]} existingHandles 启动前已存在的窗口句柄
 * @param {object} [options]
 * @param {number} [options.timeout=20000]
 * @param {number} [options.interval=250]
 * @param {number} [options.pid] 新进程 PID，用于窗口标题还没出来时的兜底匹配
 */
export async function waitForNewWindow(query, existingHandles = new Set(), options = {}) {
  const { timeout = 20000, interval = 250, pid } = options;
  const before = existingHandles instanceof Set ? existingHandles : new Set(existingHandles);
  const deadline = Date.now() + timeout;
  let samePid = null;

  while (Date.now() < deadline) {
    let matches = [];
    try {
      matches = findWindows(query);
    } catch {
      matches = [];
    }
    const fresh = matches.find((m) => !before.has(m.handle));
    if (fresh) return fresh;
    if (pid && !samePid) samePid = matches.find((m) => m.pid === pid) || null;
    await sleep(interval);
  }

  // 新进程起来了但窗口还没被枚举到（标题为空等），或者应用把内容开进了已有窗口
  if (samePid) return samePid;

  const fallback = findWindow(query);
  if (fallback) {
    fallback.bindingWarning = '没有检测到新窗口，已回退到已存在的最佳匹配窗口，它可能不是刚启动的那个';
    return fallback;
  }

  throw new Error(
    `启动后 ${timeout}ms 内没有出现匹配窗口：${typeof query === 'string' ? query : JSON.stringify(query)}。` +
      '可能是应用启动较慢，或主窗口标题与进程名不匹配（可传 match 自定义匹配条件）'
  );
}

/** 等待窗口消失。 */
export async function waitForWindowClose(query, { timeout = 15000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!findWindow(query)) return true;
    await sleep(interval);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 坐标系换算
 *
 * 本库对外统一使用「屏幕上沿左上角的绝对屏幕坐标（物理像素）」：
 * - 截图返回的窗口图，左上角对应 clientRect 的左上角
 * - 鼠标点击传的坐标也是屏幕坐标
 * 这样 AI 从截图里读到的像素位置可以直接当成屏幕坐标用，
 * 不需要再做任何隐式换算。
 * ------------------------------------------------------------------ */

/** 客户区坐标 → 屏幕坐标。 */
export function clientToScreen(hwndOrHandle, point) {
  const buf = Buffer.alloc(8);
  buf.writeInt32LE(Math.round(point.x), 0);
  buf.writeInt32LE(Math.round(point.y), 4);
  if (!Win32ClientToScreen(toHwnd(hwndOrHandle), buf)) {
    throw new Error('坐标换算失败：窗口句柄可能已失效');
  }
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

/** 屏幕坐标 → 客户区坐标。 */
export function screenToClient(hwndOrHandle, point) {
  const buf = Buffer.alloc(8);
  buf.writeInt32LE(Math.round(point.x), 0);
  buf.writeInt32LE(Math.round(point.y), 4);
  if (!Win32ScreenToClient(toHwnd(hwndOrHandle), buf)) {
    throw new Error('坐标换算失败：窗口句柄可能已失效');
  }
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

export { sleep };
