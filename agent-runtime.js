"use strict";

const { createDeepAgent } = require("deepagents");
const { ChatOpenAI } = require("@langchain/openai");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");

const MODEL = process.env.QWEN_MODEL || "qwen-plus";
const QWEN_API_KEY = process.env.QWEN_API_KEY || "";
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DATABASE_URL = process.env.DATABASE_URL || "";
const ALLOWED_TOOL_IDS = ["chatgpt", "codex", "workbuddy", "jimeng"];
const NEXT_SCENE_OPTIONS = ["整理一份会议纪要", "写一份工作汇报", "制作一张活动海报", "编写数据处理脚本"];

const GUIDE_INSTRUCTIONS = [
  "你是 AI 体验中心的对话式推荐与教学 Agent。你要通过多轮对话理解用户的工作任务，并带用户完成练习。",
  "用户真正可以体验的工具只有 ChatGPT、Codex、WorkBuddy、即梦AI。豆包、catlgpt、opencode、大头虾只能作为不可体验的对标参考，绝不能推荐用户去使用。",
  "用户首次只说‘整理一份会议纪要’、‘写一份汇报’、‘制作一张海报’这类任务名称时，信息绝对不足：必须先追问具体使用场景、面向对象、已有材料和输出要求，至少覆盖其中两个维度；这一轮不得推荐工具、生成练习提示词或判定完成。",
  "每轮先判断信息是否足够。信息不足时只问一个关键问题，但可以在同一条问题中列出需要补充的具体场景、对象、材料和要求，并在适合时提供 2 到 4 个 questionOptions；用户可以直接点击选项继续。",
  "只有用户明确表示已完成练习（例如‘我已完成练习’）时，才允许调用 complete_scene；绝不能根据用户刚描述任务、模型生成提示词或用户点击快捷任务来推断完成。",
  "信息足够后必须调用 recommend_tool 记录唯一推荐，再调用 create_practice_prompt 生成脱敏练习。",
  "敏感信息必须提醒用户替换为虚构或脱敏内容，不要复述敏感内容。用户完成一个场景后，允许继续描述下一个场景。",
  "最终回复必须是合法 JSON，字段为 phase、reply、question、questionOptions、sceneTitle、recommendedTool、reason、practicePrompt、practiceSteps。recommendedTool 只能是 chatgpt、codex、workbuddy、jimeng 或 null。phase 只能是 clarify、recommend、teach。reply 可以使用 Markdown。"
].join("\n");

// DeepAgents uses this schema for a second, validated final-response pass.
// Keeping it separate from the tool schemas prevents intermediate tool calls
// from being mistaken for the user-facing response.
const GUIDE_RESPONSE_SCHEMA = z.object({
  phase: z.enum(["clarify", "recommend", "teach"]),
  reply: z.string(),
  question: z.string(),
  questionOptions: z.array(z.string()),
  sceneTitle: z.string(),
  recommendedTool: z.enum(ALLOWED_TOOL_IDS).nullable(),
  reason: z.string(),
  practicePrompt: z.string(),
  practiceSteps: z.array(z.string())
});

const recommendTool = tool(async ({ toolId, reason, sceneTitle }) => ({ toolId, sceneTitle, reason }), {
  name: "recommend_tool",
  description: "为当前工作场景记录一个唯一的可体验工具推荐。只能使用四个可体验工具。",
  schema: z.object({ toolId: z.enum(ALLOWED_TOOL_IDS), sceneTitle: z.string().min(1).max(100), reason: z.string().min(1).max(600) })
});

const createPracticePrompt = tool(async ({ toolId, prompt, steps }) => ({ toolId, practicePrompt: prompt, practiceSteps: steps.slice(0, 4) }), {
  name: "create_practice_prompt",
  description: "为已推荐工具生成带占位符的脱敏练习提示词和步骤。",
  schema: z.object({ toolId: z.enum(ALLOWED_TOOL_IDS), prompt: z.string().min(1).max(1800), steps: z.array(z.string().min(1).max(220)).min(2).max(4) })
});

const completeScene = tool(async ({ sceneTitle, toolId }) => ({ completed: true, sceneTitle, toolId }), {
  name: "complete_scene",
  description: "当用户明确表示已完成当前练习时记录场景完成。",
  schema: z.object({ sceneTitle: z.string().min(1).max(100), toolId: z.enum(ALLOWED_TOOL_IDS) })
});

let agent;
let checkpointer;
let checkpointerSetup;

async function getCheckpointer() {
  if (!DATABASE_URL) {
    const error = new Error("尚未配置 DATABASE_URL，无法启用 Agent 会话记忆。");
    error.code = "database_not_configured";
    throw error;
  }
  if (!checkpointer) checkpointer = PostgresSaver.fromConnString(DATABASE_URL);
  if (!checkpointerSetup) checkpointerSetup = checkpointer.setup();
  await checkpointerSetup;
  return checkpointer;
}

async function getAgent() {
  if (agent) return agent;
  if (!QWEN_API_KEY) {
    const error = new Error("尚未配置 QWEN_API_KEY。");
    error.code = "agent_not_configured";
    throw error;
  }
  const model = new ChatOpenAI({ apiKey: QWEN_API_KEY, model: MODEL, temperature: 0.25, maxTokens: 1400, configuration: { baseURL: QWEN_BASE_URL } });
  agent = createDeepAgent({
    model,
    systemPrompt: GUIDE_INSTRUCTIONS,
    tools: [recommendTool, createPracticePrompt, completeScene],
    responseFormat: GUIDE_RESPONSE_SCHEMA,
    checkpointer: await getCheckpointer()
  });
  return agent;
}

function classifyUserIntent({ message, activeScene = "", initialTurn = false }) {
  const normalized = String(message || "").replace(/[“”‘’]/g, "").trim();
  const asksForNextScene = /(下一个场景|下个场景|开始下一个|继续下一个|下一个体验|换个场景|新的场景|再体验一个)/.test(normalized);
  if (asksForNextScene) {
    return { type: "request_next_scene", confidence: "high" };
  }
  const explicitCompletion = /(我已完成|已经完成|已完成|完成了|做完了|结束本场景|本场景完成|练习完成|体验完成)/.test(normalized);
  if (activeScene && explicitCompletion) {
    return { type: "complete_current_scene", confidence: "high" };
  }
  if (!activeScene && explicitCompletion) {
    return { type: "complete_without_active_scene", confidence: "high" };
  }
  const asksForNewTask = /(我还想|另外|再做|下一个|新场景|请帮我|帮我)(写|做|制作|整理|生成|处理|开始)|我想(写|做|制作|整理|生成|处理|开始)/.test(normalized);
  if (activeScene && asksForNewTask) {
    return { type: "start_new_scene", confidence: "medium" };
  }
  if (initialTurn || !activeScene) {
    return { type: "start_new_scene", confidence: initialTurn ? "high" : "medium" };
  }
  return { type: "continue_current_scene", confidence: "medium" };
}

function nextSceneSelection() {
  return {
    phase: "clarify",
    reply: "好的，进入下一个场景选择。请选择你想继续体验的方向。",
    question: "你想先体验哪个场景？",
    questionOptions: NEXT_SCENE_OPTIONS,
    sceneTitle: "",
    recommendation: null,
    sceneSelection: true
  };
}

function prepareMessage(message, { initialTurn = false, activeScene = "", intent } = {}) {
  const intentContext = {
    start_new_scene: "开始一个新场景。当前任务名称不等于完整需求，先追问具体场景、面向对象、已有材料和输出要求，再考虑推荐工具。",
    continue_current_scene: `继续当前场景“${activeScene || "当前场景"}”。结合上下文补充需求或指导练习，不要把普通补充信息当成完成。`,
    complete_current_scene: `用户明确表示完成当前场景“${activeScene || "当前场景"}”。可以确认并调用 complete_scene，但不要凭空生成新的完成结论。`,
    complete_without_active_scene: "用户表达了完成意图，但当前没有已开始的场景。请说明需要先描述一个任务，不能调用 complete_scene。"
  }[intent?.type] || (initialTurn ? "开始一个新场景，先澄清具体场景和要求。" : "根据当前会话上下文继续处理。");
  return [
    "[体验流程控制]",
    `用户意图：${intent?.type || "unknown"}`,
    intentContext,
    "[用户原话]",
    message
  ].join("\n");
}

async function runGuide({ sessionId, message, initialTurn = false, activeScene = "", intent }) {
  if (intent?.type === "request_next_scene") return nextSceneSelection();
  const currentAgent = await getAgent();
  const result = await currentAgent.invoke({ messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, intent }) }] }, { configurable: { thread_id: sessionId } });
  if (result?.structuredResponse && typeof result.structuredResponse === "object") {
    return result.structuredResponse;
  }
  const content = result?.messages?.at(-1)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => part?.text || "").join("");
  throw new Error("DeepAgents 未返回有效内容。");
}

function partialReply(jsonText) {
  const match = jsonText.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)/s);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function parseStreamResult(output) {
  if (output?.structuredResponse && typeof output.structuredResponse === "object") return output.structuredResponse;
  if (output?.phase && typeof output === "object") return output;
  const content = output?.messages?.at(-1)?.content;
  if (typeof content === "object" && content !== null) return content;
  const raw = Array.isArray(content) ? content.map(part => part?.text || "").join("") : content;
  if (typeof raw !== "string") throw new Error("DeepAgents 未返回有效内容。");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Qwen did not return valid JSON.");
  }
}

async function* streamGuide({ sessionId, message, initialTurn = false, activeScene = "", intent }) {
  if (intent?.type === "request_next_scene") {
    const result = nextSceneSelection();
    yield { type: "chunk", text: result.reply };
    yield { type: "done", raw: result };
    return;
  }
  const currentAgent = await getAgent();
  const stream = await currentAgent.streamEvents(
    { messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, intent }) }] },
    { version: "v2", configurable: { thread_id: sessionId } }
  );
  const streamedPayloads = new Map();
  let emittedReply = "";
  let finalOutput;
  for await (const event of stream) {
    if (event.event === "on_chat_model_stream" && event.metadata?.langgraph_node === "model_request") {
      const chunk = event.data?.chunk;
      const content = chunk?.content;
      if (typeof content === "string" && content) {
        const key = `${event.run_id || "content"}:content`;
        const payload = (streamedPayloads.get(key) || "") + content;
        streamedPayloads.set(key, payload);
        const reply = partialReply(payload);
        if (reply.length > emittedReply.length && reply.startsWith(emittedReply)) {
          const text = reply.slice(emittedReply.length);
          emittedReply = reply;
          yield { type: "chunk", text };
        }
      }
      for (const toolChunk of chunk?.tool_call_chunks || []) {
        if (typeof toolChunk.args !== "string" || !toolChunk.args) continue;
        const key = `${event.run_id || "tool"}:${toolChunk.index || 0}`;
        const payload = (streamedPayloads.get(key) || "") + toolChunk.args;
        streamedPayloads.set(key, payload);
        const reply = partialReply(payload);
        if (reply.length > emittedReply.length && reply.startsWith(emittedReply)) {
          const text = reply.slice(emittedReply.length);
          emittedReply = reply;
          yield { type: "chunk", text };
        }
      }
    }
    if (event.event === "on_chain_end" && event.data?.output && (event.data.output.messages || event.data.output.structuredResponse)) {
      finalOutput = event.data?.output;
    }
  }
  yield { type: "done", raw: parseStreamResult(finalOutput) };
}

module.exports = { MODEL, runGuide, streamGuide, classifyUserIntent, ALLOWED_TOOL_IDS };
