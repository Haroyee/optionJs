/**
 * 会话层：把「一个窗口」包装成可操作的对象。
 *
 * 坐标约定（重要）：
 * - `screenshot()` 之后，`this.lastShot` 记录了这张图与屏幕的映射关系
 * - `click(x, y)` 默认按「上一次截图里的像素坐标」解释，这正是视觉模型输出坐标的方式
 * - 需要绝对屏幕坐标时传 `{ space: 'screen' }`
 * - AI 不需要知道 DPI、窗口位置、缩放比例，这些都在这一层被吸收掉
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  windowInfo,
  findWindow,
  findWindows,
  requireWindow,
  waitForWindow,
  waitForNewWindow,
  activate as activateWindow,
  maximize as maximizeWindow,
  minimize as minimizeWindow,
  restore as restoreWindow,
  setBounds,
  setAlwaysOnTop,
  close as closeWindow,
  clientToScreen,
  screenToClient,
  clearProcessCache,
  listWindows,
  sleep,
} from './window.js';
import { captureWindow, transformImage, toPNG, toDataURL, savePNG } from './capture.js';
import { diffRatio } from './image.js';
import {
  click as clickAt,
  doubleClick as doubleClickAt,
  rightClick as rightClickAt,
  moveMouse as moveMouseTo,
  drag as dragBetween,
  scroll as scrollAt,
  typeText as typeTextRaw,
  pressKey as pressKeyRaw,
  hotkey as hotkeyRaw,
  keyDown,
  keyUp,
  clearText as clearTextRaw,
  cursorPos,
} from './input.js';

export class AppSession {
  /**
   * @param {object} info windowInfo 的返回值
   * @param {object} [options]
   * @param {boolean} [options.autoActivate=true] 操作前自动把窗口带到前台
   * @param {number} [options.actionDelay=60] 每个动作后的固定等待
   */
  constructor(info, options = {}) {
    if (!info) throw new Error('AppSession 需要一个有效的窗口信息对象');
    this._info = info;
    this.options = { autoActivate: true, actionDelay: 60, ...options };
    this.lastShot = null;
  }

  /* -------------------- 创建 / 绑定 -------------------- */

  /**
   * 启动一个应用并绑定它的主窗口。
   * @param {string} exe 可执行文件路径或命令（如 'notepad.exe'）
   * @param {object} [options]
   * @param {string[]} [options.args]
   * @param {object} [options.match] 自定义窗口匹配条件，默认按进程名匹配
   * @param {number} [options.timeout=20000]
   * @param {string} [options.cwd]
   */
  static async launch(exe, options = {}) {
    const { args = [], match, timeout = 20000, cwd, detach = true } = options;
    const exeName = path.basename(String(exe), path.extname(String(exe)));
    const query = match || { process: exeName };

    clearProcessCache();
    // 记下启动前已存在的窗口，之后只认"新出现的那个"，
    // 否则同类应用已经开着窗口时，很容易绑到旧窗口上（两个记事本的经典事故）
    const existing = new Set(findWindows(query).map((w) => w.handle));

    // detach 默认开启：应用不应随脚本/命令行进程退出而关闭。
    // 需要让它跟着父进程一起结束时传 detach: false。
    const child = spawn(exe, args, {
      detached: detach,
      stdio: 'ignore',
      cwd: cwd || undefined,
      windowsHide: false,
    });
    if (detach) child.unref();
    child.on('error', (err) => {
      throw new Error(`启动 ${exe} 失败：${err.message}`);
    });

    const info = await waitForNewWindow(query, existing, { timeout, pid: child.pid });
    const session = new AppSession(info, options);
    session.child = child;
    return session;
  }

  /**
   * 绑定一个已经在运行的窗口。
   * @param {object|string} query 见 window.findWindow
   */
  static attach(query, options = {}) {
    const info = requireWindow(query);
    return new AppSession(info, options);
  }

  /** 绑定失败时返回 null，而不是抛错。 */
  static tryAttach(query, options = {}) {
    const info = findWindow(query, options);
    return info ? new AppSession(info, options) : null;
  }

  /* -------------------- 状态 -------------------- */

  get hwnd() {
    return this._info.hwnd;
  }

  get handle() {
    return this._info.handle;
  }

  get title() {
    return this._info.title;
  }

  /** 重新读取窗口信息（位置、尺寸、标题可能已变化）。 */
  refresh() {
    const fresh = windowInfo(this._info.hwnd);
    if (!fresh) throw new Error(`窗口「${this._info.title}」已关闭`);
    this._info = fresh;
    return fresh;
  }

  get info() {
    return this.refresh();
  }

  /** 窗口是否还存在。 */
  get alive() {
    return windowInfo(this._info.hwnd) !== null;
  }

  async _settle(extra = 0) {
    const delay = this.options.actionDelay + extra;
    if (delay > 0) await sleep(delay);
  }

  async _ensureForeground() {
    if (!this.options.autoActivate) return;
    const info = this.refresh();
    if (!info.focused) await activateWindow(this._info.hwnd, { settle: 120 });
  }

  /* -------------------- 窗口控制 -------------------- */

  async activate() {
    const res = await activateWindow(this._info.hwnd);
    this.refresh();
    return res;
  }

  maximize() {
    this._info = maximizeWindow(this._info.hwnd);
    return this._info;
  }

  minimize() {
    this._info = minimizeWindow(this._info.hwnd);
    return this._info;
  }

  restore() {
    this._info = restoreWindow(this._info.hwnd);
    return this._info;
  }

  setBounds(box) {
    this._info = setBounds(this._info.hwnd, box);
    return this._info;
  }

  setAlwaysOnTop(onTop = true) {
    this._info = setAlwaysOnTop(this._info.hwnd, onTop);
    return this._info;
  }

  async close(options) {
    return closeWindow(this._info.hwnd, options);
  }

  /* -------------------- 截图 -------------------- */

  /**
   * 截取窗口画面。
   *
   * @param {object} [options]
   * @param {'auto'|'screen'|'print'} [options.method='auto'] 抓取方式
   * @param {number} [options.maxWidth] 限制最大宽度，等比缩小（省 token）
   * @param {number} [options.grid] 叠加坐标网格，间距按缩放后图像计
   * @param {{x:number,y:number}} [options.mark] 在图上画十字标注
   * @param {'raw'|'png'|'base64'|'dataURL'} [options.format='raw'] 返回格式
   * @param {string} [options.save] 保存 PNG 的路径
   * @returns {Promise<object>} 含 width/height/scale/screenX/screenY 以及按 format 指定的图像数据
   */
  async screenshot(options = {}) {
    const { method = 'auto', maxWidth, grid, mark, format = 'raw', save } = options;
    const cap = captureWindow(this._info.hwnd, { method });
    const img = transformImage(cap, { maxWidth, grid, mark });

    // 窗口可能在截图过程中移动了，同步一次
    this.refresh();

    this.lastShot = {
      width: img.width,
      height: img.height,
      scale: img.scale,
      nativeWidth: cap.width,
      nativeHeight: cap.height,
      screenX: cap.screenX,
      screenY: cap.screenY,
      method: cap.method,
      capturedAt: Date.now(),
    };

    const result = {
      width: img.width,
      height: img.height,
      nativeWidth: cap.width,
      nativeHeight: cap.height,
      scale: img.scale,
      screenX: cap.screenX,
      screenY: cap.screenY,
      method: cap.method,
      window: {
        handle: this._info.handle,
        title: this._info.title,
        processName: this._info.processName,
      },
    };

    if (save) result.path = savePNG(img, save);
    if (format === 'png') result.png = toPNG(img);
    else if (format === 'base64') result.base64 = toPNG(img).toString('base64');
    else if (format === 'dataURL') result.dataURL = toDataURL(img);
    else result.image = img;

    return result;
  }

  /** 只要 base64 data URL，方便直接塞给视觉模型。 */
  async screenshotDataURL(options = {}) {
    const shot = await this.screenshot({ ...options, format: 'dataURL' });
    return shot.dataURL;
  }

  /**
   * 等待界面稳定：连续两张截图的差异小于阈值。
   * 用于「点击后等界面加载完」这类场景，比写死 sleep 可靠得多。
   */
  async waitForStable(options = {}) {
    const { timeout = 8000, interval = 250, threshold = 0.002, region } = options;
    const deadline = Date.now() + timeout;
    let prev = captureWindow(this._info.hwnd, { method: 'screen' });
    if (region) {
      const { crop } = await import('./image.js');
      prev = crop(prev, region.x, region.y, region.width, region.height);
    }
    let lastDiff = 1;

    while (Date.now() < deadline) {
      await sleep(interval);
      let cur = captureWindow(this._info.hwnd, { method: 'screen' });
      if (region) {
        const { crop } = await import('./image.js');
        cur = crop(cur, region.x, region.y, region.width, region.height);
      }
      lastDiff = diffRatio(prev, cur);
      if (lastDiff <= threshold) {
        return { stable: true, diff: lastDiff, waited: timeout - (deadline - Date.now()) };
      }
      prev = cur;
    }
    return { stable: false, diff: lastDiff, waited: timeout };
  }

  /* -------------------- 坐标换算 -------------------- */

  /**
   * 截图图像坐标 → 屏幕坐标。
   * 没有截图记录时，坐标按屏幕坐标处理（原样返回）。
   */
  toScreen(x, y) {
    if (!this.lastShot) return { x: Math.round(x), y: Math.round(y) };
    const { scale, screenX, screenY, nativeWidth, nativeHeight } = this.lastShot;
    // 图像坐标除以 scale 得到窗口内物理像素，再加窗口原点
    let nx = x / scale;
    let ny = y / scale;
    // 边界保护：越界坐标收敛到窗口内，避免点到别的应用上
    nx = Math.max(0, Math.min(nativeWidth - 1, nx));
    ny = Math.max(0, Math.min(nativeHeight - 1, ny));
    return { x: Math.round(screenX + nx), y: Math.round(screenY + ny) };
  }

  /** 屏幕坐标 → 截图图像坐标。 */
  toImage(x, y) {
    if (!this.lastShot) return { x: Math.round(x), y: Math.round(y) };
    const { scale, screenX, screenY } = this.lastShot;
    return { x: Math.round((x - screenX) * scale), y: Math.round((y - screenY) * scale) };
  }

  /** 客户区坐标（相对窗口内容区左上角）→ 屏幕坐标。 */
  clientToScreen(x, y) {
    return clientToScreen(this._info.hwnd, { x, y });
  }

  /** 屏幕坐标 → 客户区坐标。 */
  screenToClient(x, y) {
    return screenToClient(this._info.hwnd, { x, y });
  }

  _resolvePoint(x, y, space) {
    if (space === 'screen') return { x: Math.round(x), y: Math.round(y) };
    if (space === 'client') return this.clientToScreen(x, y);
    return this.toScreen(x, y);
  }

  /* -------------------- 鼠标 -------------------- */

  /**
   * 点击。
   * @param {number} x
   * @param {number} y
   * @param {object} [options]
   * @param {'image'|'screen'|'client'} [options.space] 坐标空间，默认 image
   * @param {'left'|'right'|'middle'} [options.button]
   * @param {number} [options.clicks]
   * @param {number} [options.moveDuration=0] 移动轨迹耗时
   */
  async click(x, y, options = {}) {
    const { space = 'image', button = 'left', clicks = 1, moveDuration = 0 } = options;
    const pt = this._resolvePoint(x, y, space);
    await this._ensureForeground();
    await clickAt(pt.x, pt.y, { button, clicks, moveDuration });
    await this._settle();
    return { ...pt, button, clicks, from: { x, y, space } };
  }

  async doubleClick(x, y, options = {}) {
    return this.click(x, y, { ...options, clicks: 2 });
  }

  async rightClick(x, y, options = {}) {
    return this.click(x, y, { ...options, button: 'right' });
  }

  async moveMouse(x, y, options = {}) {
    const { space = 'image', duration = 300 } = options;
    const pt = this._resolvePoint(x, y, space);
    await this._ensureForeground();
    await moveMouseTo(pt.x, pt.y, { duration });
    return pt;
  }

  /**
   * 拖拽。from / to 默认用截图图像坐标。
   */
  async drag(from, to, options = {}) {
    const { space = 'image', button = 'left', duration = 500 } = options;
    const a = this._resolvePoint(from.x, from.y, space);
    const b = this._resolvePoint(to.x, to.y, space);
    await this._ensureForeground();
    const res = await dragBetween(a, b, { button, duration });
    await this._settle();
    return res;
  }

  /**
   * 滚轮。
   * @param {object} options
   * @param {number} [options.deltaY] 正数向上、负数向下
   * @param {number} [options.deltaX]
   * @param {number} [options.x]
   * @param {number} [options.y]
   * @param {'image'|'screen'|'client'} [options.space]
   */
  async scroll(options = {}) {
    const { deltaY = 0, deltaX = 0, x, y, space = 'image' } = options;
    let at;
    if (x != null && y != null) {
      at = this._resolvePoint(x, y, space);
    } else {
      // 默认滚窗口中心
      const info = this.refresh();
      at = { x: info.clientRect.x + info.clientRect.width / 2, y: info.clientRect.y + info.clientRect.height / 2 };
    }
    await this._ensureForeground();
    await scrollAt({ deltaY, deltaX, at });
    await this._settle();
    return { deltaY, deltaX, at };
  }

  /** 当前鼠标屏幕坐标。 */
  cursor() {
    return cursorPos();
  }

  /* -------------------- 键盘 -------------------- */

  /**
   * 输入文本（支持中文、emoji、多行）。
   * @param {string} text
   * @param {object} [options]
   * @param {number} [options.interval=12] 每字符间隔
   */
  async type(text, options = {}) {
    await this._ensureForeground();
    const res = await typeTextRaw(text, options);
    await this._settle();
    return res;
  }

  async press(key, options = {}) {
    await this._ensureForeground();
    const res = await pressKeyRaw(key, options);
    await this._settle();
    return res;
  }

  async hotkey(combo, options = {}) {
    await this._ensureForeground();
    const res = await hotkeyRaw(combo, options);
    await this._settle();
    return res;
  }

  async keyDown(key) {
    await this._ensureForeground();
    return keyDown(key);
  }

  async keyUp(key) {
    return keyUp(key);
  }

  /** 全选并删除（清空输入框）。 */
  async clear(options = {}) {
    await this._ensureForeground();
    await clearTextRaw(options);
    await this._settle();
    return true;
  }

  /* -------------------- 其它 -------------------- */

  wait(ms) {
    return sleep(ms);
  }

  /** 便捷写法：截图存盘。 */
  async snapshot(filePath, options = {}) {
    const shot = await this.screenshot({ ...options, format: 'raw' });
    const abs = savePNG(shot.image, filePath);
    delete shot.image;
    return { ...shot, path: abs };
  }
}

/** 列出所有可用窗口（会话无关）。 */
export function listAllWindows(options) {
  return listWindows(options);
}

export { findWindow, findWindows, waitForWindow, sleep };
