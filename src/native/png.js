/**
 * 零依赖 PNG 编码器。
 * 输入 BGRA/RGBA 原始像素，输出 PNG Buffer。
 * 之所以自己写：避免引入 sharp/canvas 等需要本地编译的重依赖，
 * 让整个库保持 `npm install` 秒装、无需 MSVC。
 */
import zlib from 'node:zlib';

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = -1;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(out, 4, 8 + len);
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

/**
 * @param {object} opt
 * @param {number} opt.width
 * @param {number} opt.height
 * @param {Buffer} opt.data 每像素 4 字节的 RGBA（顺序为 R,G,B,A）
 * @param {boolean} [opt.stripAlpha=false] 若像素完全不透明则输出 RGB，体积小约 25%
 * @param {number} [opt.level=6] zlib 压缩等级
 * @returns {Buffer} PNG
 */
export function encodePNG({ width, height, data, stripAlpha = true, level = 6 }) {
  const expected = width * height * 4;
  if (data.length < expected) {
    throw new Error(`PNG 编码失败：像素数据不足，需要 ${expected} 字节，实际 ${data.length} 字节`);
  }

  let opaque = true;
  if (stripAlpha) {
    for (let i = 3; i < expected; i += 4) {
      if (data[i] !== 255) {
        opaque = false;
        break;
      }
    }
  } else {
    opaque = false;
  }

  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y++) {
    raw[dst++] = 0; // 滤波器类型 None
    if (channels === 4) {
      data.copy(raw, dst, src, src + width * 4);
      dst += width * 4;
      src += width * 4;
    } else {
      for (let x = 0; x < width; x++) {
        raw[dst++] = data[src];
        raw[dst++] = data[src + 1];
        raw[dst++] = data[src + 2];
        src += 4;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // color type: 2=RGB, 6=RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export { crc32 };
