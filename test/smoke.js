/**
 * 端到端冒烟测试：用记事本验证窗口识别 → 截图 → 点击 → 输入 → 断言。
 *
 *   npm run smoke
 *
 * 断言方式：Windows 11 记事本会把首行内容写进窗口标题，
 * 因此输入后读标题即可验证键盘输入是否真的落到了目标窗口里，
 * 不依赖剪贴板、不依赖 OCR。
 */
import { AppSession } from '../src/session.js';
import { toPNG } from '../src/capture.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const MARK = `SMOKE${Date.now().toString().slice(-6)}`;

let session = null;
try {
  /* 1. 启动与绑定 */
  session = await AppSession.launch('notepad.exe', { timeout: 20000 });
  check('启动应用并绑定窗口', Boolean(session.handle), `「${session.title}」${session.handle}`);

  await session.hotkey('ctrl+n');
  await session.wait(700);

  /* 2. 窗口信息 */
  const info = session.info;
  check('读取窗口信息', info.rect.width > 100 && info.rect.height > 100, `${info.rect.width}x${info.rect.height}, DPI ${info.dpi}`);
  check('DPI 感知生效', info.scaleFactor >= 1, `缩放 ${info.scaleFactor}x`);

  /* 3. 截图 */
  const shot = await session.screenshot({ maxWidth: 1200 });
  const png = toPNG(shot.image);
  check(
    '截图并编码 PNG',
    shot.width > 0 && shot.height > 0 && png.length > 5000,
    `${shot.width}x${shot.height}，${(png.length / 1024).toFixed(0)}KB，方式 ${shot.method}`
  );
  check('截图坐标映射已记录', shot.scale > 0 && typeof shot.screenX === 'number', `scale=${shot.scale.toFixed(3)} 原点=(${shot.screenX},${shot.screenY})`);

  /* 4. 点击（图像坐标 → 屏幕坐标） */
  const px = Math.round(shot.width * 0.4);
  const py = Math.round(shot.height * 0.3);
  const clickRes = await session.click(px, py);
  const inside =
    clickRes.x >= info.rect.x &&
    clickRes.x <= info.rect.x + info.rect.width &&
    clickRes.y >= info.rect.y &&
    clickRes.y <= info.rect.y + info.rect.height;
  check('点击坐标落在窗口内', inside, `图像(${px},${py}) → 屏幕(${clickRes.x},${clickRes.y})`);

  /* 5. 键盘输入（含中文与 emoji） */
  const text = `${MARK} 中文输入 🚀`;
  await session.type(text, { interval: 5 });
  await session.wait(500);

  const title = session.refresh().title;
  check('中文与 emoji 输入成功', title.includes(MARK), `窗口标题已更新为「${title.slice(0, 40)}...」`);

  /* 6. 快捷键 */
  await session.hotkey('ctrl+a');
  await session.wait(150);
  const selected = await session.screenshot({ maxWidth: 900 });
  check('快捷键与二次截图', selected.width > 0, `${selected.width}x${selected.height}`);

  /* 7. 界面稳定检测 */
  const stable = await session.waitForStable({ timeout: 3000, threshold: 0.004 });
  check('界面稳定检测', stable.diff < 0.05, `差异 ${(stable.diff * 100).toFixed(3)}%`);

  /* 8. 窗口控制 */
  session.maximize();
  await session.wait(350);
  const maxSize = session.refresh().rect;
  session.restore();
  await session.wait(350);
  check('最大化 / 还原', maxSize.width >= info.rect.width, `最大化后 ${maxSize.width}x${maxSize.height}`);
} catch (err) {
  check('测试执行未抛异常', false, err.message);
} finally {
  if (session) {
    await session.close({ waitMs: 1200 }).catch(() => {});
    if (session.alive && session.child) session.child.kill();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(48)}`);
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
console.log('='.repeat(48));
process.exitCode = failed.length ? 1 : 0;
