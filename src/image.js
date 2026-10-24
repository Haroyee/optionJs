/**
 * 纯 JS 图像处理（RGBA Buffer）。
 * 只做桌面自动化真正需要的几件事：裁剪、缩放、画网格、画标记。
 * 不引入 canvas / sharp，保证零编译依赖。
 */

/** 裁剪一块区域，返回新的 RGBA Buffer。 */
export function crop({ data, width, height }, x, y, w, h) {
  const cx = Math.max(0, Math.min(width, Math.round(x)));
  const cy = Math.max(0, Math.min(height, Math.round(y)));
  const cw = Math.max(1, Math.min(width - cx, Math.round(w)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(h)));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((cy + row) * width + cx) * 4;
    data.copy(out, row * cw * 4, srcStart, srcStart + cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

/**
 * 面积平均缩放（缩小时不会出现锯齿丢失细节），用于把截图压小以节省 token。
 * 放大时退化为最近邻。
 */
export function resize({ data, width, height }, newWidth, newHeight) {
  const nw = Math.max(1, Math.round(newWidth));
  const nh = Math.max(1, Math.round(newHeight));
  if (nw === width && nh === height) return { data, width, height };

  const out = Buffer.alloc(nw * nh * 4);
  const scaleX = width / nw;
  const scaleY = height / nh;

  if (nw < width || nh < height) {
    // 逐目标像素做箱式平均
    for (let y = 0; y < nh; y++) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) * scaleY)));
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) * scaleX)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let idx = (sy * width + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++) {
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            idx += 4;
            count++;
          }
        }
        const o = (y * nw + x) * 4;
        out[o] = r / count;
        out[o + 1] = g / count;
        out[o + 2] = b / count;
        out[o + 3] = a / count;
      }
    }
  } else {
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(width - 1, Math.floor(x * scaleX));
        const src = (sy * width + sx) * 4;
        const o = (y * nw + x) * 4;
        out[o] = data[src];
        out[o + 1] = data[src + 1];
        out[o + 2] = data[src + 2];
        out[o + 3] = data[src + 3];
      }
    }
  }
  return { data: out, width: nw, height: nh };
}

function setPixel(img, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}

/** 画实心矩形边框（线宽 1）。 */
export function drawRect(img, x, y, w, h, color = [255, 0, 0]) {
  const x2 = x + w - 1;
  const y2 = y + h - 1;
  for (let i = x; i <= x2; i++) {
    setPixel(img, i, y, color);
    setPixel(img, i, y2, color);
  }
  for (let j = y; j <= y2; j++) {
    setPixel(img, x, j, color);
    setPixel(img, x2, j, color);
  }
  return img;
}

/** 画十字准星，用于标注点击位置，方便排查坐标偏移。 */
export function drawCrosshair(img, x, y, { size = 12, color = [255, 0, 0] } = {}) {
  for (let i = -size; i <= size; i++) {
    setPixel(img, x + i, y, color);
    setPixel(img, x, y + i, color);
  }
  drawRect(img, x - 3, y - 3, 7, 7, color);
  return img;
}

/**
 * 叠加坐标网格。
 * AI 通过视觉定位坐标时，网格能显著提升它对画面尺度的判断。
 */
export function drawGrid(img, { step = 100, color = [255, 0, 0], alpha = 0.45 } = {}) {
  const blend = (x, y) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = Math.round(img.data[i] * (1 - alpha) + color[0] * alpha);
    img.data[i + 1] = Math.round(img.data[i + 1] * (1 - alpha) + color[1] * alpha);
    img.data[i + 2] = Math.round(img.data[i + 2] * (1 - alpha) + color[2] * alpha);
    img.data[i + 3] = 255;
  };
  for (let x = 0; x < img.width; x += step) {
    for (let y = 0; y < img.height; y++) {
      blend(x, y);
      if (step >= 40) blend(x + 1, y);
    }
  }
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x++) {
      blend(x, y);
      if (step >= 40) blend(x, y + 1);
    }
  }
  return img;
}

/** 统计有多少比例像素接近纯黑（用于判断 PrintWindow 是否抓到黑图）。 */
export function blackRatio(img) {
  const { data } = img;
  const total = img.width * img.height;
  let black = 0;
  const step = Math.max(4, Math.floor(total / 20000) * 4);
  let sampled = 0;
  for (let i = 0; i < total * 4; i += step) {
    sampled++;
    if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black++;
  }
  return sampled ? black / sampled : 1;
}

/** 克隆一份图像数据，避免原地绘制污染原图。 */
export function clone(img) {
  return { data: Buffer.from(img.data), width: img.width, height: img.height };
}

/**
 * 两张同尺寸图像的差异比例（0~1）。用于判断界面是否还在变化。
 * 采样计算，4K 图也能在 1ms 内出结果。
 */
export function diffRatio(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const total = a.width * a.height * 4;
  const stride = Math.max(4, Math.floor(total / 100000 / 4) * 4);
  let diff = 0;
  let sampled = 0;
  for (let i = 0; i < total; i += stride) {
    sampled++;
    if (
      Math.abs(a.data[i] - b.data[i]) > 6 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 6 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 6
    ) {
      diff++;
    }
  }
  return sampled ? diff / sampled : 0;
}
