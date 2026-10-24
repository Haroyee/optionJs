/**
 * 截图模块。
 *
 * 两种抓取方式，各有明确适用场景：
 * - screen：BitBlt 抓屏幕上的可见区域。像素与屏幕坐标严格一一对应，
 *           点击最精准，但要求窗口在最前面、没有被遮挡。
 * - print ：PrintWindow(PW_RENDERFULLCONTENT) 让目标窗口自己绘制一份。
 *           窗口被遮挡、在后台也能抓到，代价是个别应用（部分 Electron/游戏）
 *           会返回黑图，且边框有 1~8px 的偏移，需要按 DWM 边框裁掉。
 *
 * 默认 auto：窗口在前台且可见就抓屏幕（最准），否则回退 PrintWindow。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONST,
  GetDC,
  ReleaseDC,
  PrintWindow,
  CreateCompatibleDC,
  CreateCompatibleBitmap,
  SelectObject,
  DeleteObject,
  DeleteDC,
  BitBlt,
  GetDIBits,
  GdiFlush,
  IsIconic,
  ShowWindow,
  extendedFrameBounds,
  windowRect,
} from './native/win32.js';
import { windowInfo } from './window.js';
import { encodePNG } from './native/png.js';
import { blackRatio, crop, resize, drawGrid, drawCrosshair, clone } from './image.js';

const BMI_BYTES = 40;

function makeBitmapInfo(width, height) {
  const bmi = Buffer.alloc(BMI_BYTES);
  bmi.writeUInt32LE(BMI_BYTES, 0); // biSize
  bmi.writeInt32LE(width, 4); // biWidth
  bmi.writeInt32LE(-height, 8); // biHeight 负数 = 自上而下
  bmi.writeUInt16LE(1, 12); // biPlanes
  bmi.writeUInt16LE(32, 14); // biBitCount
  bmi.writeUInt32LE(0, 16); // BI_RGB
  return bmi;
}

/** BGRA → RGBA，并把 alpha 统一设为不透明（GDI 抓出来的 alpha 恒为 0）。 */
function bgraToRgba(buf, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height * 4; i += 4) {
    out[i] = buf[i + 2];
    out[i + 1] = buf[i + 1];
    out[i + 2] = buf[i];
    out[i + 3] = 255;
  }
  return out;
}

/**
 * 从设备上下文抓一块像素。
 * @param {object} opt
 * @param {bigint|null} opt.hwnd 目标窗口（null 表示整个屏幕）
 * @param {boolean} opt.usePrintWindow true 走 PrintWindow，false 走 BitBlt
 * @param {object} [opt.region] BitBlt 时的屏幕区域
 */
function grab({ hwnd, usePrintWindow, region }) {
  const hdcWindow = GetDC(usePrintWindow ? hwnd : null);
  if (!hdcWindow) throw new Error('获取设备上下文失败（GetDC 返回空）');

  let memDC = null;
  let hbm = null;
  let oldObj = null;

  try {
    memDC = CreateCompatibleDC(hdcWindow);
    hbm = CreateCompatibleBitmap(hdcWindow, region.width, region.height);
    if (!memDC || !hbm) throw new Error('创建离屏位图失败（内存不足？）');
    oldObj = SelectObject(memDC, hbm);

    let ok;
    if (usePrintWindow) {
      ok = PrintWindow(hwnd, memDC, 2); // 2 = PW_RENDERFULLCONTENT
      if (!ok) throw new Error('PrintWindow 调用失败，该窗口可能不支持后台绘制');
    } else {
      ok = BitBlt(
        memDC,
        0,
        0,
        region.width,
        region.height,
        hdcWindow,
        region.x,
        region.y,
        CONST.SRCCOPY | CONST.CAPTUREBLT
      );
      if (!ok) throw new Error('BitBlt 抓屏失败');
    }

    GdiFlush();

    const raw = Buffer.alloc(region.width * region.height * 4);
    const bmi = makeBitmapInfo(region.width, region.height);
    const lines = GetDIBits(memDC, hbm, 0, region.height, raw, bmi, CONST.DIB_RGB_COLORS);
    if (!lines) throw new Error('GetDIBits 读取像素失败');

    return bgraToRgba(raw, region.width, region.height);
  } finally {
    if (memDC && oldObj) SelectObject(memDC, oldObj);
    if (hbm) DeleteObject(hbm);
    if (memDC) DeleteDC(memDC);
    ReleaseDC(usePrintWindow ? hwnd : null, hdcWindow);
  }
}

/**
 * 抓取整个窗口。
 *
 * @param {bigint|number|string} hwndOrHandle
 * @param {object} [options]
 * @param {'auto'|'screen'|'print'} [options.method='auto']
 * @param {boolean} [options.restoreMinimized=true] 最小化时先还原再抓
 * @returns {{width:number,height:number,screenX:number,screenY:number,data:Buffer,method:string,info:object}}
 */
export function captureWindow(hwndOrHandle, options = {}) {
  const { method = 'auto', restoreMinimized = true } = options;
  const info = windowInfo(hwndOrHandle);
  if (!info) throw new Error('无效窗口句柄，无法截图');

  if (info.minimized) {
    if (!restoreMinimized) {
      throw new Error(`窗口「${info.title}」处于最小化状态，无法截图。请先 restore() 或传 restoreMinimized=true`);
    }
    ShowWindow(info.hwnd, CONST.SW_RESTORE);
    // ShowWindow 后窗口尺寸/位置会变化，重新读取
    const refreshed = windowInfo(info.hwnd);
    Object.assign(info, refreshed);
  }

  const bounds = extendedFrameBounds(info.hwnd) || info.rect;
  const wr = windowRect(info.hwnd) || bounds;

  let chosen = method;
  if (method === 'auto') {
    chosen = info.visible && info.focused ? 'screen' : 'print';
  }

  // 方式一：抓屏幕可见区，坐标绝对精准
  if (chosen === 'screen') {
    try {
      const data = grab({
        hwnd: info.hwnd,
        usePrintWindow: false,
        region: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      });
      const image = { width: bounds.width, height: bounds.height, data };
      if (blackRatio(image) > 0.995) {
        // 全黑说明窗口被完全遮挡或熄屏，改用 PrintWindow
        if (method === 'auto') return capturePrint(info, wr, bounds);
      }
      return {
        width: bounds.width,
        height: bounds.height,
        screenX: bounds.x,
        screenY: bounds.y,
        data,
        method: 'screen',
        info,
      };
    } catch (err) {
      if (method === 'auto') return capturePrint(info, wr, bounds);
      throw err;
    }
  }

  return capturePrint(info, wr, bounds);
}

/** PrintWindow 抓取，并按 DWM 边框裁掉不可见的阴影区，保证坐标对齐。 */
function capturePrint(info, wr, bounds) {
  const whole = grab({
    hwnd: info.hwnd,
    usePrintWindow: true,
    region: { width: wr.width, height: wr.height },
  });

  // GetWindowRect 含透明阴影，DWM 边框才是肉眼所见，裁掉差值
  const offX = Math.max(0, Math.min(wr.width - 1, bounds.x - wr.x));
  const offY = Math.max(0, Math.min(wr.height - 1, bounds.y - wr.y));
  const cw = Math.min(bounds.width, wr.width - offX);
  const ch = Math.min(bounds.height, wr.height - offY);

  let image = { width: wr.width, height: wr.height, data: whole };
  if (offX || offY || cw !== wr.width || ch !== wr.height) {
    image = crop(image, offX, offY, cw, ch);
  }

  return {
    width: image.width,
    height: image.height,
    screenX: bounds.x,
    screenY: bounds.y,
    data: image.data,
    method: 'print',
    info,
  };
}

/**
 * 抓取屏幕任意区域。
 * @param {{x:number,y:number,width:number,height:number}} region 屏幕坐标（物理像素）
 */
export function captureScreen(region) {
  const r = {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.max(1, Math.round(region.width)),
    height: Math.max(1, Math.round(region.height)),
  };
  const data = grab({ hwnd: null, usePrintWindow: false, region: r });
  return { ...r, screenX: r.x, screenY: r.y, data, method: 'screen' };
}

/**
 * 对截图做后处理（缩放 / 网格 / 标记），返回新图像与坐标换算比例。
 *
 * @param {object} image captureWindow/captureScreen 的返回值
 * @param {object} [options]
 * @param {number} [options.maxWidth] 最大宽度，超出则等比缩小（省 token）
 * @param {number} [options.scale] 0~1 缩放比例（优先于 maxWidth）
 * @param {number} [options.grid] 网格间距（基于缩放后的图像坐标）
 * @param {{x:number,y:number}} [options.mark] 在图上画十字准星（图像坐标）
 */
export function transformImage(image, options = {}) {
  const { maxWidth, scale, grid, mark } = options;
  let out = { width: image.width, height: image.height, data: image.data };
  let factor = 1;

  const applyScale = scale != null ? scale : maxWidth && image.width > maxWidth ? maxWidth / image.width : 1;
  if (applyScale < 1) {
    out = resize(out, Math.round(image.width * applyScale), Math.round(image.height * applyScale));
    factor = out.width / image.width;
  }

  let working = out;
  if (grid || mark) working = clone(out);
  if (grid) drawGrid(working, { step: Math.max(10, Math.round(grid)) });
  if (mark) drawCrosshair(working, Math.round(mark.x), Math.round(mark.y));

  return {
    data: working.data,
    width: working.width,
    height: working.height,
    scale: factor,
  };
}

/** 编码为 PNG。 */
export function toPNG(image, { stripAlpha = true } = {}) {
  return encodePNG({ width: image.width, height: image.height, data: image.data, stripAlpha });
}

/** 编码为 data URL，可直接塞进视觉模型的消息里。 */
export function toDataURL(image, options) {
  return `data:image/png;base64,${toPNG(image, options).toString('base64')}`;
}

/** 保存 PNG 到磁盘，返回绝对路径。 */
export function savePNG(image, filePath) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, toPNG(image));
  return abs;
}
