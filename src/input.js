/**
 * 鼠标 / 键盘输入。
 *
 * 全部走 SendInput（比 mouse_event/keybd_event 更可靠，且多条事件可原子投递）。
 * 坐标一律是「屏幕物理像素」，与截图 image 的 screenX/screenY 直接相加即可。
 */
import {
  CONST,
  makeMouseInput,
  makeKeyInput,
  sendInputs,
  sleep,
  virtualScreen,
  cursorPos,
  MapVirtualKeyW,
} from './native/win32.js';

/* ------------------------------------------------------------------ *
 * 虚拟键码表
 * ------------------------------------------------------------------ */
const VK = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  menu: 0x12,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  end: 0x23,
  home: 0x24,
  arrowleft: 0x25,
  left: 0x25,
  arrowup: 0x26,
  up: 0x26,
  arrowright: 0x27,
  right: 0x27,
  arrowdown: 0x28,
  down: 0x28,
  printscreen: 0x2c,
  prtsc: 0x2c,
  insert: 0x2d,
  ins: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  lwin: 0x5b,
  rwin: 0x5c,
  meta: 0x5b,
  cmd: 0x5b,
  apps: 0x5d,
  numlock: 0x90,
  scrolllock: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
};

for (let i = 0; i < 24; i++) VK[`f${i + 1}`] = 0x70 + i;

// 需要用扩展键标志的键
const EXTENDED = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x90, 0xa3, 0xa5,
]);

/** 把 'a' / 'A' / '1' / 'ctrl' / 'F5' 解析成虚拟键码。 */
export function resolveKey(key) {
  if (typeof key === 'number') return key;
  const raw = String(key).trim();
  const lower = raw.toLowerCase();
  if (lower in VK) return VK[lower];
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code >= 97 && code <= 122) return code - 32; // a-z → A-Z
    if (code >= 65 && code <= 90) return code;
    if (code >= 48 && code <= 57) return code;
    const shifted = MapVirtualKeyW(code, 3); // VkKeyScanW 简化：退回字符映射
    if (shifted) return shifted & 0xff;
  }
  throw new Error(`无法识别的按键："${key}"。支持字母数字、F1-F24、enter/tab/esc/space/方向键等`);
}

/* ------------------------------------------------------------------ *
 * 鼠标
 * ------------------------------------------------------------------ */

/** 屏幕坐标 → SendInput 的 0~65535 归一化坐标（兼容多显示器）。 */
function toAbsolute(x, y) {
  const vs = virtualScreen();
  const nx = Math.round(((x - vs.x) * 65535) / Math.max(1, vs.width - 1));
  const ny = Math.round(((y - vs.y) * 65535) / Math.max(1, vs.height - 1));
  return {
    dx: Math.max(0, Math.min(65535, nx)),
    dy: Math.max(0, Math.min(65535, ny)),
  };
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * 移动鼠标到屏幕坐标。
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @param {number} [options.duration=0] 移动耗时（毫秒）；0 表示瞬间到位
 * @param {number} [options.steps] 插值步数，默认按距离自动计算
 */
export async function moveMouse(x, y, options = {}) {
  const { duration = 0 } = options;
  const target = { x: Math.round(x), y: Math.round(y) };

  if (!duration) {
    const { dx, dy } = toAbsolute(target.x, target.y);
    sendInputs([makeMouseInput({ dx, dy, flags: CONST.MOUSEEVENTF_MOVE | CONST.MOUSEEVENTF_ABSOLUTE | CONST.MOUSEEVENTF_VIRTUALDESK })]);
    return { ...target };
  }

  const start = cursorPos();
  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  const steps = Math.max(2, options.steps ?? Math.min(60, Math.round(distance / 18) + 2));
  const frameDelay = Math.max(1, Math.round(duration / steps));

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const px = Math.round(start.x + (target.x - start.x) * t);
    const py = Math.round(start.y + (target.y - start.y) * t);
    const { dx, dy } = toAbsolute(px, py);
    sendInputs([makeMouseInput({ dx, dy, flags: CONST.MOUSEEVENTF_MOVE | CONST.MOUSEEVENTF_ABSOLUTE | CONST.MOUSEEVENTF_VIRTUALDESK })]);
    if (i < steps) await sleep(frameDelay);
  }
  return { ...target };
}

const BUTTON_FLAGS = {
  left: [CONST.MOUSEEVENTF_LEFTDOWN, CONST.MOUSEEVENTF_LEFTUP],
  right: [CONST.MOUSEEVENTF_RIGHTDOWN, CONST.MOUSEEVENTF_RIGHTUP],
  middle: [CONST.MOUSEEVENTF_MIDDLEDOWN, CONST.MOUSEEVENTF_MIDDLEUP],
  x1: [CONST.MOUSEEVENTF_XDOWN, CONST.MOUSEEVENTF_XUP],
  x2: [CONST.MOUSEEVENTF_XDOWN, CONST.MOUSEEVENTF_XUP],
};

function buttonFlags(button = 'left') {
  const key = String(button).toLowerCase();
  const flags = BUTTON_FLAGS[key];
  if (!flags) throw new Error(`不支持的鼠标按键："${button}"（可用 left/right/middle/x1/x2）`);
  return { flags, mouseData: key === 'x1' ? CONST.XBUTTON1 : key === 'x2' ? CONST.XBUTTON2 : 0 };
}

/** 按下鼠标（不松开）。 */
export async function mouseDown(button = 'left', at) {
  if (at) await moveMouse(at.x, at.y);
  const { flags, mouseData } = buttonFlags(button);
  sendInputs([makeMouseInput({ flags: flags[0], mouseData })]);
}

/** 松开鼠标。 */
export async function mouseUp(button = 'left', at) {
  if (at) await moveMouse(at.x, at.y);
  const { flags, mouseData } = buttonFlags(button);
  sendInputs([makeMouseInput({ flags: flags[1], mouseData })]);
}

/**
 * 点击屏幕坐标。
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @param {'left'|'right'|'middle'} [options.button='left']
 * @param {number} [options.clicks=1] 连击次数（2 = 双击）
 * @param {number} [options.interval=60] 连击间隔（毫秒）
 * @param {number} [options.moveDuration=0] 移动耗时
 * @param {boolean} [options.hold] 只按下不松开（配合 mouseUp 做拖拽）
 */
export async function click(x, y, options = {}) {
  const { button = 'left', clicks = 1, interval = 60, moveDuration = 0 } = options;
  await moveMouse(x, y, { duration: moveDuration });
  const { flags, mouseData } = buttonFlags(button);

  for (let i = 0; i < clicks; i++) {
    sendInputs([makeMouseInput({ flags: flags[0], mouseData }), makeMouseInput({ flags: flags[1], mouseData })]);
    if (i < clicks - 1) await sleep(interval);
  }
  return { x: Math.round(x), y: Math.round(y), button, clicks };
}

/** 双击。 */
export async function doubleClick(x, y, options = {}) {
  return click(x, y, { ...options, clicks: 2 });
}

/** 右键点击。 */
export async function rightClick(x, y, options = {}) {
  return click(x, y, { ...options, button: 'right' });
}

/**
 * 拖拽：从 from 拖到 to。
 * 默认走 500ms 的平滑轨迹，避免目标应用的拖拽识别失败。
 */
export async function drag(from, to, options = {}) {
  const { button = 'left', duration = 500, settle = 120 } = options;
  await moveMouse(from.x, from.y, { duration: 0 });
  await sleep(30);
  await mouseDown(button);
  await sleep(80);

  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const end = { x: Math.round(to.x), y: Math.round(to.y) };
  const steps = Math.max(6, Math.round(duration / 16));
  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    const px = Math.round(start.x + (end.x - start.x) * t);
    const py = Math.round(start.y + (end.y - start.y) * t);
    const { dx, dy } = toAbsolute(px, py);
    sendInputs([makeMouseInput({ dx, dy, flags: CONST.MOUSEEVENTF_MOVE | CONST.MOUSEEVENTF_ABSOLUTE | CONST.MOUSEEVENTF_VIRTUALDESK })]);
    await sleep(Math.max(1, Math.round(duration / steps)));
  }
  await sleep(40);
  await mouseUp(button);
  if (settle) await sleep(settle);
  return { from: start, to: end };
}

/**
 * 滚轮滚动。
 * @param {object} [options]
 * @param {number} [options.deltaY] 正数向上滚，负数向下滚（单位：格，1 格 = 120）
 * @param {number} [options.deltaX] 横向滚动
 * @param {{x:number,y:number}} [options.at] 先把鼠标移到这个位置再滚
 */
export async function scroll(options = {}) {
  const { deltaY = 0, deltaX = 0, at, steps = 1 } = options;
  if (at) await moveMouse(at.x, at.y);

  const inputs = [];
  if (deltaY !== 0) {
    const perStep = Math.round((deltaY * 120) / steps);
    for (let i = 0; i < steps; i++) {
      inputs.push(makeMouseInput({ flags: CONST.MOUSEEVENTF_WHEEL, mouseData: perStep >>> 0 }));
    }
  }
  if (deltaX !== 0) {
    const perStep = Math.round((deltaX * 120) / steps);
    for (let i = 0; i < steps; i++) {
      inputs.push(makeMouseInput({ flags: CONST.MOUSEEVENTF_HWHEEL, mouseData: perStep >>> 0 }));
    }
  }
  sendInputs(inputs);
  return { deltaY, deltaX };
}

/* ------------------------------------------------------------------ *
 * 键盘
 * ------------------------------------------------------------------ */

function keyEvent(vk, isUp) {
  const scan = MapVirtualKeyW(vk, 0);
  const flags = (isUp ? CONST.KEYEVENTF_KEYUP : 0) | (EXTENDED.has(vk) ? CONST.KEYEVENTF_EXTENDEDKEY : 0);
  return makeKeyInput({ vk, scan, flags });
}

/** 按下某个键（不松开）。 */
export async function keyDown(key) {
  sendInputs([keyEvent(resolveKey(key), false)]);
}

/** 松开某个键。 */
export async function keyUp(key) {
  sendInputs([keyEvent(resolveKey(key), true)]);
}

/**
 * 按一次键，或重复多次。
 * @param {string|number} key
 * @param {object} [options]
 * @param {number} [options.times=1]
 * @param {number} [options.interval=50]
 */
export async function pressKey(key, options = {}) {
  const { times = 1, interval = 50 } = options;
  const vk = resolveKey(key);
  for (let i = 0; i < times; i++) {
    sendInputs([keyEvent(vk, false), keyEvent(vk, true)]);
    if (i < times - 1) await sleep(interval);
  }
  return { key: String(key), times };
}

/**
 * 组合键，例如 'ctrl+shift+s'、'alt+f4'、'win+r'。
 * @param {string} combo
 */
export async function hotkey(combo) {
  const parts = String(combo)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('组合键不能为空');

  const vks = parts.map(resolveKey);
  // 依次按下，再逆序松开
  sendInputs(vks.map((vk) => keyEvent(vk, false)));
  await sleep(20);
  sendInputs([...vks].reverse().map((vk) => keyEvent(vk, true)));
  return { combo, keys: parts };
}

/**
 * 输入文本。
 *
 * 采用 KEYEVENTF_UNICODE 直接投递字符，因此：
 * - 不依赖当前键盘布局，中文、日文、emoji、特殊符号都能输入
 * - 不受输入法状态影响（不会弹出候选框）
 * - 换行和制表符会被转换成 Enter / Tab 键，兼容文本框的多行输入
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.interval=12] 每字符间隔（毫秒），0 表示一次性投递
 * @param {boolean} [options.chunked=true] 长文本分批投递，避免卡顿
 */
export async function typeText(text, options = {}) {
  const { interval = 12 } = options;
  const str = String(text);
  if (!str) return { length: 0 };

  const inputs = [];
  for (const ch of str) {
    if (ch === '\n' || ch === '\r') {
      inputs.push(keyEvent(0x0d, false), keyEvent(0x0d, true));
      continue;
    }
    if (ch === '\t') {
      inputs.push(keyEvent(0x09, false), keyEvent(0x09, true));
      continue;
    }
    // 按 UTF-16 码元投递，代理对（emoji）会被拆成两条，系统会自动合成
    for (let i = 0; i < ch.length; i++) {
      const unit = ch.charCodeAt(i);
      inputs.push(makeKeyInput({ vk: 0, scan: unit, flags: CONST.KEYEVENTF_UNICODE }));
      inputs.push(makeKeyInput({ vk: 0, scan: unit, flags: CONST.KEYEVENTF_UNICODE | CONST.KEYEVENTF_KEYUP }));
    }
  }

  if (interval <= 0) {
    // SendInput 单次上限较大，但仍分批以防个别应用丢字
    for (let i = 0; i < inputs.length; i += 400) {
      sendInputs(inputs.slice(i, i + 400));
      await sleep(4);
    }
    return { length: str.length };
  }

  // 带节奏输入：每字符一组，模拟真人打字
  for (let i = 0; i < inputs.length; i += 2) {
    sendInputs(inputs.slice(i, i + 2));
    await sleep(interval);
  }
  return { length: str.length };
}

/** 清空文本（全选后删除），适用于可编辑输入框。 */
export async function clearText(options = {}) {
  await hotkey('ctrl+a');
  await sleep(30);
  await pressKey('delete');
  if (options.settle) await sleep(options.settle);
  return true;
}

export { sleep, cursorPos };
