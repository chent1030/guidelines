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
const INTEREST_AREAS = ["质量管理", "人力资源", "生产运营", "BP & IT", "采购与供应链", "经营管理"];

const NEXT_STEP_ADVISOR_INSTRUCTIONS = [
  "你是导引 Agent 内部的下一步建议 Agent，不直接与用户对话，也不负责最终措辞。",
  "根据主 Agent 提供的关注领域、用户原话和已有会话，判断当前最关键的信息缺口。",
  "每次只建议一个下一步：给出一个具体追问、2 到 4 个贴合当前业务领域的可选答案，并说明为什么此时应问这个问题。",
  "当业务场景、目标、使用对象、已有材料、限制条件和期望产出已经足以匹配工具时，明确建议进入工具推荐，不要继续机械追问。",
  "不要把用户刚选择领域或刚描述痛点视为信息充分；不要直接宣布场景完成。"
].join("\n");

const GUIDE_INSTRUCTIONS = [
  "你是面向集团公司经理的 AI 体验中心导引 Agent。用户进入会话后先选择关注领域，你要围绕该领域通过多轮对话理解业务问题，逐步引导用户形成一个可实践的具体需求，最后再推荐工具。",
  "关注领域包括：质量管理、人力资源、生产运营、BP & IT、采购与供应链、经营管理。领域选择本身不是具体任务。",
  "用户真正可以体验的工具只有 ChatGPT、Codex、WorkBuddy、即梦AI。豆包、catlgpt、opencode、大头虾只能作为不可体验的对标参考，绝不能推荐用户去使用。",
  "用户刚选择关注领域时，信息绝对不足：先询问该领域中最想改善的业务环节或管理问题，再逐步追问目标、对象、已有材料、限制条件和期望产出；这一轮不得推荐工具、生成练习提示词或判定完成。",
  "在澄清需求时，必须先调用 next-step-advisor 子 Agent，让它分析当前最关键的信息缺口。结合它的建议，每轮只推进一个问题；不要原样照搬内部分析，也不要向用户提及子 Agent。",
  "每轮只推进一个澄清步骤，只问一个关键问题；不要一次性把场景、对象、材料和输出要求全部问完。可以为当前问题提供 2 到 4 个 questionOptions，用户可以直接点击选项继续。",
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
    subagents: [{
      name: "next-step-advisor",
      description: "分析当前业务需求的信息缺口，为导引 Agent 提出一个有针对性的下一步问题、可选答案或进入工具推荐的建议。澄清阶段必须使用。",
      systemPrompt: NEXT_STEP_ADVISOR_INSTRUCTIONS,
      model,
      tools: []
    }],
    responseFormat: GUIDE_RESPONSE_SCHEMA,
    checkpointer: await getCheckpointer()
  });
  return agent;
}

function classifyUserIntent({ message, activeScene = "", interestArea = "", interestSelection = false, initialTurn = false }) {
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
  if (interestSelection) {
    return { type: "select_interest_area", confidence: "high" };
  }
  if (!interestArea && (initialTurn || !activeScene)) {
    return { type: "choose_interest_area", confidence: "high" };
  }
  if (interestArea && !activeScene) {
    return { type: "continue_current_scene", confidence: "high" };
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
    reply: "好的，进入下一个关注领域选择。请选择你想继续体验的方向。",
    question: "你想先从哪个领域开始？",
    questionOptions: INTEREST_AREAS,
    sceneTitle: "",
    recommendation: null,
    interestSelection: true
  };
}

function prepareMessage(message, { initialTurn = false, activeScene = "", interestArea = "", intent } = {}) {
  const intentContext = {
    start_new_scene: "开始一个新场景。当前任务名称不等于完整需求，先追问具体场景、面向对象、已有材料和输出要求，再考虑推荐工具。",
    continue_current_scene: `继续当前场景“${activeScene || "当前场景"}”。结合上下文补充需求或指导练习，不要把普通补充信息当成完成。`,
    complete_current_scene: `用户明确表示完成当前场景“${activeScene || "当前场景"}”。可以确认并调用 complete_scene，但不要凭空生成新的完成结论。`,
    complete_without_active_scene: "用户表达了完成意图，但当前没有已开始的场景。请说明需要先选择关注领域，不能调用 complete_scene。",
    choose_interest_area: "用户还没有选择关注领域。请先引导用户从领域选项中选择，不要直接处理具体任务。",
    select_interest_area: `用户刚选择了关注领域“${interestArea || message}”。先询问这个领域中最想改善的业务环节或管理问题，逐步澄清后再推荐工具。`,
    request_next_scene: "用户希望进入下一个场景，请让用户先选择下一个关注领域。"
  }[intent?.type] || (initialTurn ? "开始一个新场景，先澄清具体场景和要求。" : "根据当前会话上下文继续处理。");
  return [
    "[体验流程控制]",
    `用户意图：${intent?.type || "unknown"}`,
    `[关注领域] ${interestArea || "尚未选择"}`,
    intentContext,
    "[用户原话]",
    message
  ].join("\n");
}

async function runGuide({ sessionId, message, initialTurn = false, activeScene = "", interestArea = "", intent }) {
  if (intent?.type === "request_next_scene") return nextSceneSelection();
  if (intent?.type === "choose_interest_area") {
    return { ...nextSceneSelection(), reply: "我们先从你关心的领域开始。请选择一个方向，我会继续带你梳理具体需求。" };
  }
  const currentAgent = await getAgent();
  const result = await currentAgent.invoke({ messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, interestArea, intent }) }] }, { configurable: { thread_id: sessionId } });
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

function fallbackStreamResult(reply) {
  const questions = String(reply || "").match(/[^。！？\n]{4,}[？?]/g) || [];
  const question = (questions.at(-1) || "")
    .replace(/[\n*_`#>]/g, "")
    .trim();
  return {
    phase: "clarify",
    reply,
    question,
    questionOptions: [],
    sceneTitle: "",
    recommendedTool: null,
    reason: "",
    practicePrompt: "",
    practiceSteps: []
  };
}

async function* streamGuide({ sessionId, message, initialTurn = false, activeScene = "", interestArea = "", intent }) {
  if (intent?.type === "request_next_scene") {
    const result = nextSceneSelection();
    yield { type: "chunk", text: result.reply };
    yield { type: "done", raw: result };
    return;
  }
  if (intent?.type === "choose_interest_area") {
    const result = { ...nextSceneSelection(), reply: "我们先从你关心的领域开始。请选择一个方向，我会继续带你梳理具体需求。" };
    yield { type: "chunk", text: result.reply };
    yield { type: "done", raw: result };
    return;
  }
  const currentAgent = await getAgent();
  const stream = await currentAgent.streamEvents(
    { messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, interestArea, intent }) }] },
    { version: "v2", configurable: { thread_id: sessionId } }
  );
  const streamedPayloads = new Map();
  let emittedReply = "";
  let finalOutput;
  try {
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
  } catch (error) {
    if (!emittedReply) throw error;
    yield { type: "done", raw: fallbackStreamResult(emittedReply) };
    return;
  }
  try {
    yield { type: "done", raw: parseStreamResult(finalOutput) };
  } catch (error) {
    if (!emittedReply) throw error;
    yield { type: "done", raw: fallbackStreamResult(emittedReply) };
  }
}

module.exports = { MODEL, runGuide, streamGuide, classifyUserIntent, ALLOWED_TOOL_IDS };
