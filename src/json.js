/**
 * JSON 序列化辅助。
 *
 * 窗口句柄在底层是 bigint（koffi 的原生表示），直接 JSON.stringify 会抛
 * "Do not know how to serialize a BigInt"。这里统一转成 `0x...` 字符串，
 * 既能被 JSON 承载，又能原样传回 API（toHwnd 支持十六进制字符串）。
 */
export function bigintReplacer(key, value) {
  return typeof value === 'bigint' ? `0x${value.toString(16)}` : value;
}

/** 把可能含 bigint 的对象转成可 JSON 化的普通对象。 */
export function toJSONSafe(value) {
  return JSON.parse(JSON.stringify(value, bigintReplacer));
}
