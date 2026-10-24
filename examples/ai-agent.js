/**
 * AI 智能体示例：让视觉大模型自己看着界面完成任务。
 *
 * 运行前先设置环境变量（兼容 OpenAI 接口的服务都可以，如 DeepSeek、通义、Kimi、本地 vLLM）：
 *
 *   set LLM_API_KEY=sk-xxxx
 *   set LLM_MODEL=gpt-4o                 # 必须是支持图片输入的模型
 *   set LLM_BASE_URL=https://api.openai.com/v1   # 可选，默认 OpenAI
 *
 *   node examples/ai-agent.js "在记事本里写一首关于秋天的四行诗"
 *
 * 程序做的事：
 *   截图 → 交给模型 → 模型决定调哪个工具 → 执行 → 再截图 → 循环，直到模型说完成
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSession } from '../src/session.js';
import { createToolkit, toOpenAITools, buildSystemPrompt } from '../src/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'gpt-4o';

const task = process.argv.slice(2).join(' ') || '在记事本里写一句“你好，世界”，然后保存为桌面上的 hello.txt';

if (!API_KEY) {
  console.error('缺少 LLM_API_KEY 环境变量。用法见文件头部注释。');
  process.exit(1);
}

const runDir = path.join(here, 'output', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(runDir, { recursive: true });

/* ---------------- 1. 准备目标应用 ---------------- */
// 已有记事本窗口就复用，没有就启动一个
let session = AppSession.tryAttach({ process: 'notepad' });
if (!session) {
  session = await AppSession.launch('notepad.exe');
  await session.wait(800);
  await session.hotkey('ctrl+n');
}
console.log(`目标窗口：「${session.title}」`);

const toolkit = createToolkit({ session, maxWidth: 1400, autoScreenshot: false });

/* ---------------- 2. 组装初始消息 ---------------- */
const messages = [
  { role: 'system', content: buildSystemPrompt({ session, task }) },
  { role: 'user', content: `任务：${task}\n\n这是当前界面截图，请开始。` },
];

async function appendScreenshot(hint = '这是执行动作后的界面：') {
  const shot = await session.screenshot({ maxWidth: 1400, format: 'base64' });
  const file = path.join(runDir, `step-${String(step).padStart(2, '0')}.png`);
  fs.writeFileSync(file, Buffer.from(shot.base64, 'base64'));
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `${hint}（图片 ${shot.width}x${shot.height}，坐标按这张图的像素算）` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.base64}` } },
    ],
  });
  return shot;
}

let step = 0;
await appendScreenshot('这是当前界面：');

/* ---------------- 3. 主循环 ---------------- */
const MAX_STEPS = 20;
const tools = toOpenAITools();

while (step < MAX_STEPS) {
  step++;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型调用失败 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('模型返回为空');

  messages.push(message);

  if (!message.tool_calls?.length) {
    console.log(`\n[第 ${step} 步] 模型判断任务结束：\n${message.content || '(无文字说明)'}`);
    break;
  }

  for (const call of message.tool_calls) {
    const name = call.function.name;
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      console.warn(`参数不是合法 JSON：${call.function.arguments}`);
    }

    console.log(`\n[第 ${step} 步] 调用 ${name}(${JSON.stringify(args)})`);
    const result = await toolkit.call(name, args);
    if (toolkit.session && toolkit.session !== session) session = toolkit.session;

    console.log(`  → ${result.ok ? '成功' : '失败'} ${result.error || JSON.stringify(result.result).slice(0, 200)}`);

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result.ok ? result.result : { error: result.error }),
    });
  }

  // 动作执行完，补一张新截图给模型看
  await appendScreenshot();
}

if (step >= MAX_STEPS) {
  console.log(`\n达到最大步数 ${MAX_STEPS}，停止。`);
}

console.log(`\n截图已保存到：${runDir}`);
