/**
 * AI 工具层：把会话能力描述成 LLM 可以直接调用的 function tools。
 *
 * 使用方式（OpenAI / Anthropic / 任意支持 function calling 的模型都一样）：
 *   const toolkit = createToolkit({ session });
 *   const res = await toolkit.call('click', { x: 420, y: 310 });
 *   // res.result 是执行结果，res.screenshot.dataURL 是动作后的新画面
 *
 * 坐标语义：所有 x/y 都是「最近一次 screenshot 返回的图片里的像素坐标」，
 * 与视觉模型看到的图完全一致，模型不需要知道 DPI 和窗口位置。
 */
import { AppSession } from './session.js';
import { listWindows as listAllWindows } from './window.js';

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */
const xy = {
  x: { type: 'number', description: '目标点横坐标（最近一次截图的图像像素）' },
  y: { type: 'number', description: '目标点纵坐标（最近一次截图的图像像素）' },
};

export const toolDefinitions = [
  {
    name: 'list_windows',
    description: '列出当前所有可见的顶层窗口（含进程名、标题、窗口句柄）。用于确认目标应用是否在运行。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'attach_window',
    description:
      '按进程名或标题匹配并绑定目标窗口，后续所有操作都作用于该窗口。当目标应用有多个窗口时，优先用较完整的标题匹配。',
    parameters: {
      type: 'object',
      properties: {
        process: { type: 'string', description: '进程名，如 notepad、chrome（不必带 .exe）' },
        title: { type: 'string', description: '窗口标题，支持部分匹配' },
        hwnd: { type: 'string', description: '窗口句柄（十六进制，如 0xa071a），精确指定时优先使用' },
      },
      required: [],
    },
  },
  {
    name: 'launch_app',
    description: '启动一个应用程序并自动绑定其主窗口。适合任务开始阶段。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可执行文件路径或命令，如 notepad.exe 或 C:\\Program Files\\App\\app.exe' },
        args: { type: 'array', items: { type: 'string' }, description: '启动参数' },
        timeout: { type: 'number', description: '等待窗口出现的超时毫秒数，默认 20000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_window_info',
    description: '获取当前绑定窗口的信息：标题、进程、位置、尺寸、是否聚焦、DPI 缩放。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screenshot',
    description:
      '截取当前窗口画面。返回图片及其尺寸和缩放比例；图片左上角对应窗口左上角。可选叠加坐标网格辅助定位。',
    parameters: {
      type: 'object',
      properties: {
        max_width: { type: 'number', description: '限制图片最大宽度（越小越省 token，但定位精度下降）' },
        grid: { type: 'number', description: '叠加坐标网格的间距（图片像素），如 100' },
        method: {
          type: 'string',
          enum: ['auto', 'screen', 'print'],
          description: 'auto=窗口在前台抓屏幕，否则让窗口自绘；一般不用改',
        },
      },
      required: [],
    },
  },
  {
    name: 'click',
    description: '在指定坐标点击鼠标左键。坐标取自最近一次截图的图像像素。',
    parameters: {
      type: 'object',
      properties: {
        ...xy,
        clicks: { type: 'number', description: '连击次数，默认 1；2 表示双击' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'right_click',
    description: '在指定坐标点击鼠标右键（打开右键菜单）。',
    parameters: { type: 'object', properties: { ...xy }, required: ['x', 'y'] },
  },
  {
    name: 'move_mouse',
    description: '把鼠标移动到指定坐标（不点击），用于触发悬停提示。',
    parameters: { type: 'object', properties: { ...xy }, required: ['x', 'y'] },
  },
  {
    name: 'drag',
    description: '从起点拖拽到终点，用于拖动滑块、滚动条、移动文件、框选文本。',
    parameters: {
      type: 'object',
      properties: {
        from_x: { type: 'number', description: '起点横坐标' },
        from_y: { type: 'number', description: '起点纵坐标' },
        to_x: { type: 'number', description: '终点横坐标' },
        to_y: { type: 'number', description: '终点纵坐标' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'scroll',
    description: '滚轮滚动。正数向上、负数向下。可指定滚动位置，默认在窗口中心滚动。',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '滚动格数，如 -3 表示向下滚 3 格' },
        x: { type: 'number', description: '可选的滚轮位置横坐标' },
        y: { type: 'number', description: '可选的滚轮位置纵坐标' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'type_text',
    description:
      '输入文本到当前焦点位置。支持中文、emoji、多行（\\n 会自动回车）。输入前请先用 click 点击目标输入框。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        interval: { type: 'number', description: '每字符间隔毫秒，默认 12；长文本可设为 0 加速' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: '按一次键或重复按键，如 enter / tab / esc / backspace / delete / up / down / f5。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '键名' },
        times: { type: 'number', description: '重复次数，默认 1' },
      },
      required: ['key'],
    },
  },
  {
    name: 'hotkey',
    description: '组合键，如 ctrl+s、ctrl+shift+t、alt+f4、win+r。',
    parameters: {
      type: 'object',
      properties: { combo: { type: 'string', description: '用 + 连接，如 ctrl+s' } },
      required: ['combo'],
    },
  },
  {
    name: 'wait',
    description: '等待若干毫秒，用于等待界面动画或加载完成。',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'number', description: '等待毫秒数' } },
      required: ['ms'],
    },
  },
  {
    name: 'wait_for_stable',
    description: '等待界面不再变化（连续两张截图差异极小），比固定 wait 更可靠。',
    parameters: {
      type: 'object',
      properties: {
        timeout: { type: 'number', description: '最长等待毫秒，默认 8000' },
        threshold: { type: 'number', description: '差异阈值，默认 0.002' },
      },
      required: [],
    },
  },
  {
    name: 'window_control',
    description: '控制窗口状态：聚焦、最大化、最小化、还原、关闭、调整尺寸。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['focus', 'maximize', 'minimize', 'restore', 'close', 'resize'],
          description: '要执行的动作',
        },
        width: { type: 'number', description: 'resize 时的宽度' },
        height: { type: 'number', description: 'resize 时的高度' },
        x: { type: 'number', description: 'resize 时的屏幕横坐标' },
        y: { type: 'number', description: 'resize 时的屏幕纵坐标' },
      },
      required: ['action'],
    },
  },
];

/** OpenAI tools 格式。 */
export function toOpenAITools(definitions = toolDefinitions) {
  return definitions.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/** Anthropic tools 格式。 */
export function toAnthropicTools(definitions = toolDefinitions) {
  return definitions.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

/* ------------------------------------------------------------------ *
 * 系统提示词
 * ------------------------------------------------------------------ */
export function buildSystemPrompt({ session, task } = {}) {
  const lines = [
    '你是一个可以操作 Windows 桌面应用的智能体。你只能通过提供的工具与界面交互，不能直接修改文件系统。',
    '',
    '工作方式：',
    '1. 先调用 screenshot 观察当前界面，再根据画面内容决定下一步动作。',
    '2. 所有坐标都使用「最近一次截图里的图像像素坐标」，左上角是 (0,0)。',
    '3. 点击输入框之后才能 type_text 输入文字；输入完可以用 hotkey("ctrl+a") 配合截图确认内容。',
    '4. 每个动作执行后都会返回新的截图，务必先看图再决定下一步，不要凭想象连续操作。',
    '5. 界面在加载时用 wait_for_stable，不要用固定长等待。',
    '6. 目标达成后，用一句话总结你做了什么，并停止调用工具。',
    '',
    '注意事项：',
    '- 不要点击关闭、删除、卸载、支付等不可逆的按钮，除非任务明确要求。',
    '- 连续两次操作没有任何界面变化时，换一种方式（例如先点击输入框、或用键盘快捷键）。',
  ];
  if (session?.info) {
    lines.push('', `当前已绑定窗口：「${session.info.title}」（进程 ${session.info.processName}）。`);
  }
  if (task) lines.push('', `本次任务：${task}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 执行器
 * ------------------------------------------------------------------ */
const MUTATING = new Set([
  'click',
  'right_click',
  'drag',
  'scroll',
  'type_text',
  'press_key',
  'hotkey',
  'window_control',
  'attach_window',
  'launch_app',
  'wait_for_stable',
]);

/**
 * 创建工具集。
 *
 * @param {object} options
 * @param {AppSession} [options.session] 初始会话（可后续通过 attach_window 切换）
 * @param {boolean} [options.autoScreenshot=true] 动作后自动返回新截图
 * @param {number} [options.maxWidth=1600] 自动截图的默认最大宽度
 * @param {boolean} [options.throwOnError=false] true 时错误直接抛出而不是返回 {ok:false}
 */
export function createToolkit(options = {}) {
  const { autoScreenshot = true, maxWidth = 1600, throwOnError = false } = options;
  const state = { session: options.session || null };

  function requireSession() {
    if (!state.session) throw new Error('尚未绑定窗口，请先调用 attach_window 或 launch_app');
    return state.session;
  }

  const handlers = {
    async list_windows() {
      const windows = listAllWindows().map((w) => ({
        handle: w.handle,
        title: w.title,
        process: w.processName,
        pid: w.pid,
        size: `${w.rect.width}x${w.rect.height}`,
        focused: w.focused,
      }));
      return { count: windows.length, windows };
    },

    async attach_window({ process, title, hwnd }) {
      const session = AppSession.attach({ process, title, hwnd }, options.sessionOptions || {});
      state.session = session;
      const info = session.info;
      return {
        bound: true,
        title: info.title,
        process: info.processName,
        handle: info.handle,
        size: `${info.rect.width}x${info.rect.height}`,
        scaleFactor: info.scaleFactor,
      };
    },

    async launch_app({ path, args = [], timeout = 20000 }) {
      const session = await AppSession.launch(path, { args, timeout, ...(options.sessionOptions || {}) });
      state.session = session;
      const info = session.info;
      return { launched: true, title: info.title, process: info.processName, handle: info.handle };
    },

    async get_window_info() {
      const info = requireSession().info;
      return {
        title: info.title,
        process: info.processName,
        handle: info.handle,
        rect: info.rect,
        clientRect: info.clientRect,
        state: info.state,
        focused: info.focused,
        scaleFactor: info.scaleFactor,
      };
    },

    async screenshot({ max_width, grid, method = 'auto' } = {}) {
      const session = requireSession();
      const shot = await session.screenshot({
        maxWidth: max_width ?? maxWidth,
        grid,
        method,
        format: 'base64',
      });
      return {
        width: shot.width,
        height: shot.height,
        nativeWidth: shot.nativeWidth,
        nativeHeight: shot.nativeHeight,
        scale: shot.scale,
        note: '坐标请按此图片的像素来给，左上角是 (0,0)',
        _image: { base64: shot.base64, width: shot.width, height: shot.height },
      };
    },

    async click({ x, y, clicks = 1 }) {
      const res = await requireSession().click(x, y, { clicks });
      return { clicked: true, at: { x: res.x, y: res.y }, clicks };
    },

    async right_click({ x, y }) {
      const res = await requireSession().rightClick(x, y);
      return { clicked: true, button: 'right', at: { x: res.x, y: res.y } };
    },

    async move_mouse({ x, y }) {
      const pt = await requireSession().moveMouse(x, y);
      return { moved: true, at: pt };
    },

    async drag({ from_x, from_y, to_x, to_y }) {
      const res = await requireSession().drag({ x: from_x, y: from_y }, { x: to_x, y: to_y });
      return { dragged: true, from: res.from, to: res.to };
    },

    async scroll({ amount, x, y }) {
      const res = await requireSession().scroll({ deltaY: amount, x, y });
      return { scrolled: true, deltaY: res.deltaY, at: res.at };
    },

    async type_text({ text, interval = 12 }) {
      await requireSession().type(text, { interval });
      return { typed: true, length: text.length };
    },

    async press_key({ key, times = 1 }) {
      await requireSession().press(key, { times });
      return { pressed: key, times };
    },

    async hotkey({ combo }) {
      await requireSession().hotkey(combo);
      return { combo };
    },

    async wait({ ms }) {
      await new Promise((r) => setTimeout(r, Math.min(60000, Math.max(0, ms))));
      return { waited: ms };
    },

    async wait_for_stable({ timeout = 8000, threshold = 0.002 } = {}) {
      const res = await requireSession().waitForStable({ timeout, threshold });
      return res;
    },

    async window_control({ action, width, height, x, y }) {
      const session = requireSession();
      switch (action) {
        case 'focus':
          await session.activate();
          return { focused: true };
        case 'maximize':
          session.maximize();
          return { maximized: true };
        case 'minimize':
          session.minimize();
          return { minimized: true };
        case 'restore':
          session.restore();
          return { restored: true };
        case 'close': {
          const res = await session.close();
          return res;
        }
        case 'resize': {
          const info = session.setBounds({ x, y, width, height });
          return { rect: info.rect };
        }
        default:
          throw new Error(`未知的窗口动作：${action}`);
      }
    },
  };

  /**
   * 执行一个工具调用。
   * @returns {Promise<{ok:boolean, result?:object, error?:string, screenshot?:object}>}
   */
  async function call(name, args = {}) {
    const handler = handlers[name];
    if (!handler) {
      const payload = { ok: false, error: `未知工具：${name}` };
      if (throwOnError) throw new Error(payload.error);
      return payload;
    }

    try {
      const result = await handler(args);
      const payload = { ok: true, tool: name, result };

      // 把内嵌图片拆到 screenshot 字段，方便上层直接塞进消息
      if (result && result._image) {
        payload.screenshot = result._image;
        delete result._image;
      }

      if (autoScreenshot && MUTATING.has(name) && state.session?.alive) {
        try {
          // wait_for_stable 已经等过了，不必再截
          if (name !== 'wait_for_stable') {
            const shot = await state.session.screenshot({ maxWidth, format: 'base64' });
            payload.screenshot = { base64: shot.base64, width: shot.width, height: shot.height, scale: shot.scale };
          }
        } catch (err) {
          payload.screenshotError = err.message;
        }
      }
      return payload;
    } catch (err) {
      if (throwOnError) throw err;
      return { ok: false, tool: name, error: err.message };
    }
  }

  return {
    tools: toolDefinitions,
    openaiTools: toOpenAITools(),
    anthropicTools: toAnthropicTools(),
    call,
    get session() {
      return state.session;
    },
    set session(value) {
      state.session = value;
    },
  };
}
