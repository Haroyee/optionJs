/**
 * 基础示例：启动记事本，截图、点击、输入、再截图。
 *
 *   node examples/basic.js
 *
 * 截图会保存到 examples/output/ 目录，可以直接打开看效果。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSession } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = (name) => path.join(here, 'output', name);

const session = await AppSession.launch('notepad.exe', { timeout: 20000 });
console.log(`已启动并绑定窗口：「${session.title}」(${session.handle})`);

try {
  // 1) 新建空白文档，避免影响已有内容
  await session.hotkey('ctrl+n');
  await session.wait(500);

  // 2) 先看一眼当前界面（缩放 1400 宽，省流量）
  const before = await session.screenshot({ maxWidth: 1400 });
  console.log(`截图 ${before.width}x${before.height}（原生 ${before.nativeWidth}x${before.nativeHeight}）`);
  await session.snapshot(output('1-before.png'));
  console.log('已保存 examples/output/1-before.png');

  // 3) 点击文本区。坐标用「截图图像坐标」，左上角是 (0,0)
  const clickX = Math.round(before.width * 0.4);
  const clickY = Math.round(before.height * 0.25);
  await session.click(clickX, clickY);
  console.log(`已点击图像坐标 (${clickX}, ${clickY})`);

  // 4) 输入中英文混排文本
  await session.type('optionjs 示例：这一行是用 API 敲进去的 🚀\n支持中文、emoji 与多行。');
  await session.wait(300);

  // 5) 用快捷键全选复制，验证输入内容（不改动剪贴板内容的话可跳过）
  await session.hotkey('ctrl+a');
  await session.wait(150);

  // 6) 再截一张，光标位置画个红色十字方便核对
  const after = await session.screenshot({ mark: { x: clickX, y: clickY } });
  await session.snapshot(output('2-after.png'));
  console.log('已保存 examples/output/2-after.png');

  // 7) 界面稳定检测：等界面不再变化
  const stable = await session.waitForStable({ timeout: 3000 });
  console.log(`界面稳定: ${stable.stable}（差异 ${(stable.diff * 100).toFixed(3)}%）`);

  console.log('\n窗口信息:', JSON.stringify({
    title: session.title,
    位置尺寸: session.info.rect,
    缩放: `${session.info.scaleFactor}x`,
  }, null, 2));
} finally {
  // 先礼貌地请求关闭；如果弹出「是否保存」对话框，就直接结束进程，避免留下脏窗口
  await session.close({ waitMs: 1200 }).catch(() => {});
  if (session.alive && session.child) {
    session.child.kill();
    console.log('\n已结束记事本进程（放弃保存）');
  } else {
    console.log('\n记事本已关闭');
  }
}
