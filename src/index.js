/**
 * optionjs —— Windows 桌面应用自动化 SDK
 *
 * 分层：
 *   native/  Win32 FFI 原始能力（窗口句柄、GDI 抓屏、SendInput）
 *   window   窗口枚举与匹配、窗口控制、坐标换算
 *   capture  截图与图像后处理
 *   input    鼠标键盘
 *   session  面向对象的会话层（坐标自动换算，AI 友好）
 *   tools    LLM function tools 定义与执行器
 */
export { AppSession, listAllWindows } from './session.js';

export {
  listWindows,
  findWindow,
  findWindows,
  requireWindow,
  windowInfo,
  scoreWindow,
  activate,
  maximize,
  minimize,
  restore,
  hide,
  show,
  setBounds,
  setAlwaysOnTop,
  close,
  waitForWindow,
  waitForNewWindow,
  waitForWindowClose,
  clientToScreen,
  screenToClient,
  clearProcessCache,
} from './window.js';

export {
  captureWindow,
  captureScreen,
  transformImage,
  toPNG,
  toDataURL,
  savePNG,
} from './capture.js';

export {
  moveMouse,
  click,
  doubleClick,
  rightClick,
  mouseDown,
  mouseUp,
  drag,
  scroll,
  keyDown,
  keyUp,
  pressKey,
  hotkey,
  typeText,
  clearText,
  resolveKey,
  cursorPos,
} from './input.js';

export {
  toolDefinitions,
  createToolkit,
  toOpenAITools,
  toAnthropicTools,
  buildSystemPrompt,
} from './tools.js';

export { dpiAwareness } from './native/win32.js';
export { encodePNG } from './native/png.js';
export { bigintReplacer, toJSONSafe } from './json.js';
