/**
 * Win32 FFI 底层：user32 / gdi32 / dwmapi / kernel32 的薄封装。
 *
 * 设计要点：
 * 1. DPI 感知在模块加载时立刻开启（PER_MONITOR_AWARE_V2），
 *    否则窗口坐标是"逻辑像素"而截图是"物理像素"，AI 算出的坐标会系统性偏移。
 * 2. 所有 out 参数用 Buffer 手工读写，不依赖结构体对齐规则，跨 Node 版本稳定。
 * 3. HWND 统一用 bigint 表示（koffi 的原生行为），序列化时转十六进制字符串。
 */
import koffi from 'koffi';

/* ------------------------------------------------------------------ *
 * 1. DPI 感知（必须最先执行）
 * ------------------------------------------------------------------ */
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');

const is64 = process.arch === 'x64' || process.arch === 'arm64';

const _SetProcessDpiAwarenessContext = (() => {
  try {
    return user32.func('bool SetProcessDpiAwarenessContext(intptr_t)');
  } catch {
    return null;
  }
})();

/** 返回实际生效的 DPI 感知模式名。 */
export const dpiAwareness = (() => {
  if (_SetProcessDpiAwarenessContext) {
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    if (_SetProcessDpiAwarenessContext(-4)) return 'per-monitor-v2';
    if (_SetProcessDpiAwarenessContext(-3)) return 'per-monitor';
    if (_SetProcessDpiAwarenessContext(-2)) return 'system';
  }
  try {
    const shcore = koffi.load('shcore.dll');
    const SetProcessDpiAwareness = shcore.func('int SetProcessDpiAwareness(int)');
    if (SetProcessDpiAwareness(2) === 0) return 'per-monitor(shcore)';
  } catch {
    /* 忽略 */
  }
  return 'none';
})();

/* ------------------------------------------------------------------ *
 * 2. 函数声明
 * ------------------------------------------------------------------ */
const api = (lib, proto) => lib.func(proto);

// ---- 窗口枚举 / 属性 ----
export const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
export const EnumWindows = api(user32, 'bool EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
export const IsWindow = api(user32, 'bool IsWindow(void *hwnd)');
export const IsWindowVisible = api(user32, 'bool IsWindowVisible(void *hwnd)');
export const IsIconic = api(user32, 'bool IsIconic(void *hwnd)');
export const IsZoomed = api(user32, 'bool IsZoomed(void *hwnd)');
export const IsWindowEnabled = api(user32, 'bool IsWindowEnabled(void *hwnd)');
export const GetForegroundWindow = api(user32, 'void *GetForegroundWindow()');
export const GetWindowTextW = api(user32, 'int GetWindowTextW(void *hwnd, void *buf, int max)');
export const GetWindowTextLengthW = api(user32, 'int GetWindowTextLengthW(void *hwnd)');
export const GetClassNameW = api(user32, 'int GetClassNameW(void *hwnd, void *buf, int max)');
export const GetWindowRect = api(user32, 'bool GetWindowRect(void *hwnd, void *rect)');
export const GetClientRect = api(user32, 'bool GetClientRect(void *hwnd, void *rect)');
export const ClientToScreen = api(user32, 'bool ClientToScreen(void *hwnd, void *point)');
export const ScreenToClient = api(user32, 'bool ScreenToClient(void *hwnd, void *point)');
export const GetWindowThreadProcessId = api(user32, 'uint32 GetWindowThreadProcessId(void *hwnd, void *pidOut)');
export const GetWindowLongPtrW = is64
  ? api(user32, 'intptr_t GetWindowLongPtrW(void *hwnd, int index)')
  : api(user32, 'int32 GetWindowLongW(void *hwnd, int index)');

// ---- 窗口控制 ----
export const ShowWindow = api(user32, 'bool ShowWindow(void *hwnd, int cmd)');
export const ShowWindowAsync = api(user32, 'bool ShowWindowAsync(void *hwnd, int cmd)');
export const SetForegroundWindow = api(user32, 'bool SetForegroundWindow(void *hwnd)');
export const BringWindowToTop = api(user32, 'bool BringWindowToTop(void *hwnd)');
export const SetWindowPos = api(user32, 'bool SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)');
export const MoveWindow = api(user32, 'bool MoveWindow(void *hwnd, int x, int y, int w, int h, bool repaint)');
export const PostMessageW = api(user32, 'bool PostMessageW(void *hwnd, uint msg, intptr_t wParam, intptr_t lParam)');
export const AttachThreadInput = api(user32, 'bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach)');
export const SetCursorPos = api(user32, 'bool SetCursorPos(int x, int y)');
export const GetCursorPos = api(user32, 'bool GetCursorPos(void *point)');

// ---- 设备上下文 / 抓屏 ----
export const GetDC = api(user32, 'void *GetDC(void *hwnd)');
export const ReleaseDC = api(user32, 'int ReleaseDC(void *hwnd, void *hdc)');
export const PrintWindow = api(user32, 'bool PrintWindow(void *hwnd, void *hdc, uint flags)');
export const GetSystemMetrics = api(user32, 'int GetSystemMetrics(int index)');
export const GetDpiForWindow = (() => {
  try {
    return api(user32, 'uint GetDpiForWindow(void *hwnd)');
  } catch {
    return () => 96;
  }
})();

export const CreateCompatibleDC = api(gdi32, 'void *CreateCompatibleDC(void *hdc)');
export const CreateCompatibleBitmap = api(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int width, int height)');
export const GetDIBits = api(
  gdi32,
  'int GetDIBits(void *hdc, void *hbm, uint start, uint lines, void *bits, void *bmi, uint usage)'
);
export const CreateDIBSection = api(
  gdi32,
  'void *CreateDIBSection(void *hdc, void *bmi, uint usage, void *bitsOut, void *section, uint offset)'
);
export const SelectObject = api(gdi32, 'void *SelectObject(void *hdc, void *obj)');
export const DeleteObject = api(gdi32, 'bool DeleteObject(void *obj)');
export const DeleteDC = api(gdi32, 'bool DeleteDC(void *hdc)');
export const BitBlt = api(gdi32, 'bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint rop)');
export const GdiFlush = api(gdi32, 'bool GdiFlush()');

// ---- DWM ----
export const DwmGetWindowAttribute = api(dwmapi, 'int DwmGetWindowAttribute(void *hwnd, uint attr, void *out, uint size)');

// ---- 进程 / 输入 ----
export const OpenProcess = api(kernel32, 'void *OpenProcess(uint access, bool inherit, uint pid)');
export const CloseHandle = api(kernel32, 'bool CloseHandle(void *h)');
export const QueryFullProcessImageNameW = api(
  kernel32,
  'bool QueryFullProcessImageNameW(void *h, uint flags, void *buf, void *size)'
);
export const GetCurrentThreadId = api(kernel32, 'uint32 GetCurrentThreadId()');
export const GetLastError = api(kernel32, 'uint32 GetLastError()');
export const SendInput = api(user32, 'uint SendInput(uint count, void *inputs, int size)');
export const MapVirtualKeyW = api(user32, 'uint MapVirtualKeyW(uint code, uint mapType)');

/* ------------------------------------------------------------------ *
 * 3. 常量
 * ------------------------------------------------------------------ */
export const CONST = {
  // 鼠标
  MOUSEEVENTF_MOVE: 0x0001,
  MOUSEEVENTF_LEFTDOWN: 0x0002,
  MOUSEEVENTF_LEFTUP: 0x0004,
  MOUSEEVENTF_RIGHTDOWN: 0x0008,
  MOUSEEVENTF_RIGHTUP: 0x0010,
  MOUSEEVENTF_MIDDLEDOWN: 0x0020,
  MOUSEEVENTF_MIDDLEUP: 0x0040,
  MOUSEEVENTF_XDOWN: 0x0080,
  MOUSEEVENTF_XUP: 0x0100,
  MOUSEEVENTF_WHEEL: 0x0800,
  MOUSEEVENTF_HWHEEL: 0x1000,
  MOUSEEVENTF_ABSOLUTE: 0x8000,
  MOUSEEVENTF_VIRTUALDESK: 0x4000,
  XBUTTON1: 0x0001,
  XBUTTON2: 0x0002,

  // 键盘
  KEYEVENTF_EXTENDEDKEY: 0x0001,
  KEYEVENTF_KEYUP: 0x0002,
  KEYEVENTF_UNICODE: 0x0004,
  KEYEVENTF_SCANCODE: 0x0008,

  // ShowWindow
  SW_HIDE: 0,
  SW_SHOWNORMAL: 1,
  SW_SHOWMINIMIZED: 2,
  SW_SHOWMAXIMIZED: 3,
  SW_SHOWNOACTIVATE: 4,
  SW_SHOW: 5,
  SW_MINIMIZE: 6,
  SW_RESTORE: 9,

  // SetWindowPos
  SWP_NOSIZE: 0x0001,
  SWP_NOMOVE: 0x0002,
  SWP_NOZORDER: 0x0004,
  SWP_NOACTIVATE: 0x0010,
  SWP_SHOWWINDOW: 0x0040,
  HWND_TOP: 0,
  HWND_TOPMOST: -1,

  // GDI
  SRCCOPY: 0x00cc0020,
  CAPTUREBLT: 0x40000000,
  DIB_RGB_COLORS: 0,

  // DWM
  DWMWA_EXTENDED_FRAME_BOUNDS: 9,
  DWMWA_CLOAKED: 14,

  // 窗口样式
  GWL_STYLE: -16,
  GWL_EXSTYLE: -20,
  WS_VISIBLE: 0x10000000,
  WS_DISABLED: 0x08000000,
  WS_CAPTION: 0x00c00000,
  WS_EX_TOOLWINDOW: 0x00000080,
  WS_EX_NOACTIVATE: 0x08000000,

  // 系统指标
  SM_CXSCREEN: 0,
  SM_CYSCREEN: 1,
  SM_XVIRTUALSCREEN: 76,
  SM_YVIRTUALSCREEN: 77,
  SM_CXVIRTUALSCREEN: 78,
  SM_CYVIRTUALSCREEN: 79,

  WM_CLOSE: 0x0010,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
};

/* ------------------------------------------------------------------ *
 * 4. 辅助函数
 * ------------------------------------------------------------------ */
export function lastError() {
  const code = GetLastError();
  const messages = {
    0: '成功',
    5: '拒绝访问（权限不足，可能需要管理员身份）',
    87: '参数错误',
    1400: '无效的窗口句柄',
  };
  return { code, message: messages[code] || `Win32 错误码 ${code}` };
}

/** 把各种来源的句柄统一成 bigint。 */
export function toHwnd(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return BigInt(trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`);
  }
  return value;
}

export function hwndToHex(hwnd) {
  return `0x${toHwnd(hwnd).toString(16)}`;
}

function readRect(buf) {
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

/** GetWindowRect（含不可见的阴影边框区）。 */
export function windowRect(hwnd) {
  const buf = Buffer.alloc(16);
  if (!GetWindowRect(toHwnd(hwnd), buf)) return null;
  const r = readRect(buf);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/**
 * DWM 扩展边框（视觉上真正可见的窗口边界）。
 * Win10+ 上 GetWindowRect 会多出约 7px 的透明阴影，直接用会导致截图偏移。
 */
export function extendedFrameBounds(hwnd) {
  const h = toHwnd(hwnd);
  const buf = Buffer.alloc(16);
  const hr = DwmGetWindowAttribute(h, CONST.DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16);
  if (hr !== 0) return null;
  const r = readRect(buf);
  const width = r.right - r.left;
  const height = r.bottom - r.top;
  if (width <= 0 || height <= 0) return null;
  return { x: r.left, y: r.top, width, height };
}

/** 客户区（不含标题栏/边框）在屏幕上的位置与尺寸。 */
export function clientRect(hwnd) {
  const h = toHwnd(hwnd);
  const buf = Buffer.alloc(16);
  if (!GetClientRect(h, buf)) return null;
  const r = readRect(buf);
  const pt = Buffer.alloc(8);
  ClientToScreen(h, pt);
  return {
    x: pt.readInt32LE(0),
    y: pt.readInt32LE(4),
    width: r.right - r.left,
    height: r.bottom - r.top,
  };
}

export function windowTitle(hwnd) {
  const h = toHwnd(hwnd);
  const len = GetWindowTextLengthW(h);
  const buf = Buffer.alloc(Math.max(2, (len + 2) * 2));
  const n = GetWindowTextW(h, buf, len + 1);
  return buf.toString('utf16le', 0, n * 2);
}

export function windowClass(hwnd) {
  const buf = Buffer.alloc(256 * 2);
  const n = GetClassNameW(toHwnd(hwnd), buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

export function windowPid(hwnd) {
  const buf = Buffer.alloc(4);
  GetWindowThreadProcessId(toHwnd(hwnd), buf);
  return buf.readUInt32LE(0);
}

/** 进程可执行文件完整路径（用于按应用名匹配）。 */
export function processPath(pid) {
  const h = OpenProcess(CONST.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return null;
  try {
    const pathBuf = Buffer.alloc(4096);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(2048);
    if (!QueryFullProcessImageNameW(h, 0, pathBuf, sizeBuf)) return null;
    return pathBuf.toString('utf16le', 0, sizeBuf.readUInt32LE(0) * 2);
  } finally {
    CloseHandle(h);
  }
}

/** 窗口是否被 DWM 隐藏（UWP 应用挂起时常见），这类窗口不该出现在列表里。 */
export function isCloaked(hwnd) {
  const buf = Buffer.alloc(4);
  const hr = DwmGetWindowAttribute(toHwnd(hwnd), CONST.DWMWA_CLOAKED, buf, 4);
  return hr === 0 && buf.readUInt32LE(0) !== 0;
}

export function getStyle(hwnd) {
  return Number(GetWindowLongPtrW(toHwnd(hwnd), CONST.GWL_STYLE));
}

export function getExStyle(hwnd) {
  return Number(GetWindowLongPtrW(toHwnd(hwnd), CONST.GWL_EXSTYLE));
}

export function cursorPos() {
  const buf = Buffer.alloc(8);
  GetCursorPos(buf);
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

/** 多显示器联合区域（物理像素，DPI 感知开启后由系统换算）。 */
export function virtualScreen() {
  return {
    x: GetSystemMetrics(CONST.SM_XVIRTUALSCREEN),
    y: GetSystemMetrics(CONST.SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(CONST.SM_CXVIRTUALSCREEN),
    height: GetSystemMetrics(CONST.SM_CYVIRTUALSCREEN),
  };
}

export function primaryScreen() {
  return { width: GetSystemMetrics(CONST.SM_CXSCREEN), height: GetSystemMetrics(CONST.SM_CYSCREEN) };
}

export function windowDpi(hwnd) {
  try {
    return GetDpiForWindow(toHwnd(hwnd)) || 96;
  } catch {
    return 96;
  }
}

/* ------------------------------------------------------------------ *
 * 5. 进程权限
 * ------------------------------------------------------------------ */
const advapi32 = koffi.load('advapi32.dll');
const OpenProcessToken = advapi32.func('bool OpenProcessToken(void *h, uint access, void *tokenOut)');
const GetTokenInformation = advapi32.func('bool GetTokenInformation(void *token, int cls, void *info, uint len, void *retLen)');
const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()');

/**
 * 当前进程是否以管理员权限运行。
 *
 * 这直接决定了能否操作"提权应用"：Windows 的 UIPI 会丢弃低权限进程
 * 发往高权限窗口的 SendInput 与大部分窗口消息，且不会报错。
 */
export function isElevated() {
  const TOKEN_QUERY = 0x0008;
  const TokenElevation = 20;
  const hProc = GetCurrentProcess();
  const tokenBuf = Buffer.alloc(8);
  if (!OpenProcessToken(hProc, TOKEN_QUERY, tokenBuf)) return false;
  const token = is64 ? tokenBuf.readBigUInt64LE(0) : BigInt(tokenBuf.readUInt32LE(0));
  try {
    const info = Buffer.alloc(4);
    const retLen = Buffer.alloc(4);
    if (!GetTokenInformation(token, TokenElevation, info, 4, retLen)) return false;
    return info.readUInt32LE(0) === 1;
  } finally {
    CloseHandle(token);
  }
}

/* ------------------------------------------------------------------ *
 * 6. SendInput 结构体打包
 *
 * x64: INPUT = 40 字节，type@0，union@8
 *      MOUSEINPUT = dx@0 dy@4 data@8 flags@12 time@16 (pad4) extra@24
 *      KEYBDINPUT = vk@0 scan@2 flags@4 time@8 (pad4) extra@16
 * x86: INPUT = 28 字节，type@0，union@4
 * ------------------------------------------------------------------ */
const INPUT_LAYOUT = is64
  ? { size: 40, union: 8, mouse: { dx: 0, dy: 4, data: 8, flags: 12, time: 16, extra: 24 }, key: { vk: 0, scan: 2, flags: 4, time: 8, extra: 16 } }
  : { size: 28, union: 4, mouse: { dx: 0, dy: 4, data: 8, flags: 12, time: 16, extra: 20 }, key: { vk: 0, scan: 2, flags: 4, time: 8, extra: 12 } };

export const INPUT_SIZE = INPUT_LAYOUT.size;

/** 构造一条鼠标事件。 */
export function makeMouseInput({ dx = 0, dy = 0, mouseData = 0, flags = 0 }) {
  const buf = Buffer.alloc(INPUT_LAYOUT.size);
  buf.writeUInt32LE(0, 0); // INPUT_MOUSE
  const base = INPUT_LAYOUT.union;
  buf.writeInt32LE(dx | 0, base + INPUT_LAYOUT.mouse.dx);
  buf.writeInt32LE(dy | 0, base + INPUT_LAYOUT.mouse.dy);
  buf.writeUInt32LE(mouseData >>> 0, base + INPUT_LAYOUT.mouse.data);
  buf.writeUInt32LE(flags >>> 0, base + INPUT_LAYOUT.mouse.flags);
  return buf;
}

/** 构造一条键盘事件。 */
export function makeKeyInput({ vk = 0, scan = 0, flags = 0 }) {
  const buf = Buffer.alloc(INPUT_LAYOUT.size);
  buf.writeUInt32LE(1, 0); // INPUT_KEYBOARD
  const base = INPUT_LAYOUT.union;
  buf.writeUInt16LE(vk & 0xffff, base + INPUT_LAYOUT.key.vk);
  buf.writeUInt16LE(scan & 0xffff, base + INPUT_LAYOUT.key.scan);
  buf.writeUInt32LE(flags >>> 0, base + INPUT_LAYOUT.key.flags);
  return buf;
}

/** 一次性投递多条输入事件（保证顺序与原子性）。 */
export function sendInputs(inputs) {
  if (!inputs.length) return 0;
  const payload = Buffer.concat(inputs);
  const sent = SendInput(inputs.length, payload, INPUT_LAYOUT.size);
  if (sent !== inputs.length) {
    const err = lastError();
    throw new Error(
      `SendInput 仅投递 ${sent}/${inputs.length} 条事件：${err.message}。` +
        '常见原因：目标进程以管理员权限运行而当前进程不是，或目标窗口被 UAC 桌面隔离。'
    );
  }
  return sent;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
