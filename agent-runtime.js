"use strict";

const { createDeepAgent } = require("deepagents");
const { ChatOpenAI } = require("@langchain/openai");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");

const MODEL = process.env.QWEN_MODEL || "qwen-plus";
const QWEN_API_KEY = process.env.QWEN_API_KEY || "";
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ENABLE_THINKING = /^(1|true|yes)$/i.test(process.env.QWEN_ENABLE_THINKING || "false");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ALLOWED_TOOL_IDS = ["chatgpt", "codex", "workbuddy", "jimeng"];
const INTEREST_AREAS = ["质量管理", "人力资源", "生产运营", "设备领域", "采购与供应链", "经营管理"];

// Qwen3 rejects forced tool_choice values while thinking is enabled. Keep
// thinking off for this tool-using Agent unless a compatible model is selected.
const MODEL_KWARGS = /^qwen3(?:[-.]|$)/i.test(MODEL)
  ? { extra_body: { enable_thinking: ENABLE_THINKING } }
  : {};

const NEXT_STEP_ADVISOR_INSTRUCTIONS = [
  "你是导引 Agent 内部的下一步建议 Agent，不直接与用户对话，也不负责最终措辞。",
  "根据主 Agent 提供的关注领域、用户原话和已有会话，判断当前最关键的信息缺口。",
  "每次只建议一个下一步：给出一个具体追问、2 到 4 个贴合当前业务领域的可选答案，并说明为什么此时应问这个问题。",
  "当业务场景、目标、使用对象、已有材料、限制条件和期望产出已经足以匹配工具时，明确建议进入工具推荐，不要继续机械追问。",
  "不要把用户刚选择领域或刚描述痛点视为信息充分；不要直接宣布场景完成。"
].join("\n");

const GUIDE_INSTRUCTIONS = [
  "你是面向集团公司经理的 AI 实验室导引 Agent。用户可以先选择关注领域，也可以直接描述明确的业务场景。对于领域选择，你要通过多轮对话理解业务问题；对于明确场景，你要直接推荐工具并生成练习提示词。",
  "关注领域包括：质量管理、人力资源、生产运营、设备领域、采购与供应链、经营管理。领域选择本身不是具体任务。",
  "用户真正可以体验的工具只有 ChatGPT、Codex、WorkBuddy、即梦AI。豆包、catlgpt、opencode、大头虾只能作为不可体验的对标参考，绝不能推荐用户去使用。",
  "用户刚选择关注领域时，信息绝对不足：先询问该领域中最想改善的业务环节或管理问题，再逐步追问目标、对象、已有材料、限制条件和期望产出；这一轮不得推荐工具、生成练习提示词或判定完成。",
  "当体验流程控制明确标注为“直接处理明确场景”时，先自行判断它最可能归属的关注领域，不要让用户重新选择领域；检查是否缺少影响交付的关键条件。条件足够时调用 recommend_tool，再调用 create_practice_prompt；若确实缺少关键条件，只追问一个最必要的问题，不要退回领域选择。可以在回复中简短说明合理假设。",
  "系统会在消息中提供“建议 Agent 输出”。澄清需求时应结合该建议，每轮只推进一个问题；不要原样照搬内部分析，也不要向用户提及建议 Agent。",
  "每轮只推进一个澄清步骤，只问一个关键问题；不要一次性把场景、对象、材料和输出要求全部问完。选择关注领域后的第一轮必须提供 2 到 4 个具体业务环节的 questionOptions，其他澄清轮次也应尽量提供选项。question 已由界面单独展示，reply 不要重复 question 的完整内容。",
  "只有用户明确表示已完成练习（例如‘我已完成练习’）时，才允许调用 complete_scene；绝不能根据用户刚描述任务、模型生成提示词或用户点击快捷任务来推断完成。完成当前场景后，必须在 JSON 中返回 nextToolSuggestions：从尚未体验的工具中选择 1 到 3 个，说明适合的下一类场景和推荐理由，帮助用户继续体验。",
  "信息足够后必须调用 recommend_tool 记录唯一推荐，再调用 create_practice_prompt 生成脱敏练习。",
  "敏感信息必须提醒用户替换为虚构或脱敏内容，不要复述敏感内容。用户完成一个场景后，允许继续描述下一个场景。",
  "最终回复必须是合法 JSON，字段为 phase、reply、question、questionOptions、sceneTitle、recommendedTool、reason、practicePrompt、practiceSteps、nextToolSuggestions。nextToolSuggestions 是数组，每项包含 toolId、title、reason、suggestedScenario；toolId 只能是 chatgpt、codex、workbuddy、jimeng。非完成场景可返回空数组。recommendedTool 只能是 chatgpt、codex、workbuddy、jimeng 或 null。phase 只能是 clarify、recommend、teach。reply 可以使用 Markdown。"
].join("\n");

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
let advisorModel;
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
  const model = new ChatOpenAI({ apiKey: QWEN_API_KEY, model: MODEL, temperature: 0.25, maxTokens: 1400, modelKwargs: MODEL_KWARGS, configuration: { baseURL: QWEN_BASE_URL } });
  advisorModel = new ChatOpenAI({ apiKey: QWEN_API_KEY, model: MODEL, temperature: 0.15, maxTokens: 500, modelKwargs: MODEL_KWARGS, configuration: { baseURL: QWEN_BASE_URL } });
  agent = createDeepAgent({
    model,
    systemPrompt: GUIDE_INSTRUCTIONS,
    tools: [recommendTool, createPracticePrompt, completeScene],
    checkpointer: await getCheckpointer()
  });
  return agent;
}

async function runNextStepAdvisor({ message, activeScene = "", interestArea = "", intent }) {
  await getAgent();
  const response = await advisorModel.invoke([
    { role: "system", content: NEXT_STEP_ADVISOR_INSTRUCTIONS },
    {
      role: "user",
      content: [
        `关注领域：${interestArea || "未选择"}`,
        `当前场景：${activeScene || "尚未建立"}`,
        `用户意图：${intent?.type || "unknown"}`,
        `用户本轮输入：${message}`,
        "请按“建议动作 / 建议追问 / 建议选项 / 判断依据”四行输出。"
      ].join("\n")
    }
  ]);
  const content = response?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(part => part?.text || "").join("").trim();
  return "建议动作：继续当前流程\n判断依据：结合用户本轮输入推进一个关键步骤。";
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
  if (!interestArea && !activeScene && isExplicitScenario(normalized)) {
    return { type: "direct_scenario", confidence: "high" };
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

function inferInterestArea(message) {
  const normalized = String(message || "");
  if (/(招聘|培训|绩效|员工|企业文化|文化墙|文化工作墙|组织|人事)/.test(normalized)) return "人力资源";
  if (/(质量|缺陷|检验|审核|客诉|纠正预防)/.test(normalized)) return "质量管理";
  if (/(排产|产能|车间|产线|生产计划|交付)/.test(normalized)) return "生产运营";
  if (/(设备|故障|点检|维修|备件|保养)/.test(normalized)) return "设备领域";
  if (/(采购|供应商|比价|交付风险|库存)/.test(normalized)) return "采购与供应链";
  if (/(经营|预算|汇报|会议|决策|经营分析)/.test(normalized)) return "经营管理";
  return "";
}

function isExplicitScenario(message) {
  if (message.length < 8) return false;
  const taskVerb = /(分析|整理|生成|制作|撰写|写|汇总|评估|排查|定位|优化|改进|翻译|计划|报告|方案|PPT|文档|代码|海报|视频|培训|审核|复盘|预测|发布|设计|策划|搭建|运营|处理|完成|做|编制|制定|安排|落地|上线|推进|开展|建立|通知|回复|提报|申报|盘点|核对|跟进|改善)/;
  const scenarioSignal = /(需要|想要|请|帮我|我们|目前|正在|负责|希望|准备|要|任务|场景|问题|痛点|需求|不合理|异常|瓶颈|闲置)/;
  return taskVerb.test(message) && scenarioSignal.test(message);
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

function prepareMessage(message, { initialTurn = false, activeScene = "", interestArea = "", intent, advice = "", completedScenes = [], preferredToolId = "", currentToolId = "" } = {}) {
  const intentContext = {
    direct_scenario: "直接处理明确场景：先自行判断归属领域，不要要求用户重新选择领域。若缺少影响交付的关键条件，只追问一个必要问题；条件足够时立即调用 recommend_tool 和 create_practice_prompt，并以脱敏练习方式交付。",
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
    intent?.type === "direct_scenario" && !interestArea ? `[系统推断关注领域] ${inferInterestArea(message) || "待根据场景判断"}` : "",
    `[已完成工具] ${completedScenes.length ? completedScenes.map(scene => scene.toolName || scene.toolId || scene.title).join("、") : "暂无"}`,
    currentToolId ? `[当前推荐工具] ${currentToolId}` : "",
    preferredToolId ? `[用户选择的目标工具] ${preferredToolId}。如进入新场景，请优先围绕该工具引导。` : "",
    intentContext,
    advice ? `[建议 Agent 输出]\n${advice}` : "",
    "[用户原话]",
    message
  ].filter(Boolean).join("\n");
}

async function runGuide({ sessionId, message, initialTurn = false, activeScene = "", interestArea = "", intent, completedScenes = [], preferredToolId = "", currentToolId = "" }) {
  if (intent?.type === "request_next_scene") return nextSceneSelection();
  if (intent?.type === "choose_interest_area") {
    return { ...nextSceneSelection(), reply: "我们先从你关心的领域开始。请选择一个方向，我会继续带你梳理具体需求。" };
  }
  if (intent?.type === "complete_current_scene") {
    return { phase: "clarify", reply: "当前场景已完成。接下来可以从下面的工具中选择一个继续体验。", sceneTitle: activeScene, nextToolSuggestions: [] };
  }
  const currentAgent = await getAgent();
  const result = await currentAgent.invoke({ messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, interestArea, intent, completedScenes, preferredToolId, currentToolId }) }] }, { configurable: { thread_id: sessionId } });
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

function toolTrace(toolName, status, output) {
  const definitions = {
    task: { id: "advisor", agent: "建议 Agent", running: "正在分析下一步建议...", completed: "建议分析已完成" },
    recommend_tool: { id: "recommendation", agent: "推荐工具", running: "正在匹配适合的工具...", completed: "工具匹配已完成" },
    create_practice_prompt: { id: "practice", agent: "练习生成工具", running: "正在生成脱敏练习...", completed: "脱敏练习已生成" },
    complete_scene: { id: "completion", agent: "场景记录工具", running: "正在记录场景结果...", completed: "场景结果已记录" }
  };
  const definition = definitions[toolName];
  if (!definition) return null;
  const content = output?.content ?? output;
  const detail = typeof content === "string"
    ? content.slice(0, 2000)
    : (content && status === "completed" ? JSON.stringify(content).slice(0, 2000) : "");
  return {
    id: definition.id,
    agent: definition.agent,
    status,
    message: definition[status],
    detail
  };
}

async function* streamGuide({ sessionId, message, initialTurn = false, activeScene = "", interestArea = "", intent, completedScenes = [], preferredToolId = "", currentToolId = "" }) {
  if (intent?.type === "request_next_scene") {
    const result = nextSceneSelection();
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "running", message: "正在整理场景列表...", detail: "" } };
    yield { type: "chunk", text: result.reply };
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "场景列表已准备", detail: "" } };
    yield { type: "done", raw: result };
    return;
  }
  if (intent?.type === "choose_interest_area") {
    const result = { ...nextSceneSelection(), reply: "我们先从你关心的领域开始。请选择一个方向，我会继续带你梳理具体需求。" };
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "running", message: "正在整理场景列表...", detail: "" } };
    yield { type: "chunk", text: result.reply };
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "场景列表已准备", detail: "" } };
    yield { type: "done", raw: result };
    return;
  }
  if (intent?.type === "complete_current_scene") {
    yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "running", message: "正在确认场景完成并整理下一步建议...", detail: "" } };
    yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "completed", message: "下一步建议已生成", detail: "当前场景已完成，建议从尚未体验的工具中选择一个继续。" } };
    yield { type: "agent_trace", step: { id: "completion", agent: "场景记录工具", status: "running", message: "正在记录场景结果...", detail: "" } };
    yield { type: "agent_trace", step: { id: "completion", agent: "场景记录工具", status: "completed", message: "场景结果已记录", detail: JSON.stringify({ completed: true, sceneTitle: activeScene, toolId: currentToolId }) } };
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "已整理下一步工具建议", detail: "" } };
    yield { type: "done", raw: { phase: "clarify", reply: "当前场景已完成。接下来可以从下面的工具中选择一个继续体验。", sceneTitle: activeScene, nextToolSuggestions: [] } };
    return;
  }
  yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "running", message: "正在分析并输出下一步建议...", detail: "" } };
  let advice = "";
  try {
    advice = await runNextStepAdvisor({ message, activeScene, interestArea, intent });
    yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "completed", message: "下一步建议已生成", detail: advice } };
  } catch (error) {
    advice = "建议动作：结合当前上下文继续推进一个关键步骤。";
    yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "completed", message: "已使用基础建议继续处理", detail: advice } };
  }
  yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "running", message: "正在结合建议组织回复...", detail: "" } };
  const currentAgent = await getAgent();
  const stream = await currentAgent.streamEvents(
    { messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, interestArea, intent, advice, completedScenes, preferredToolId, currentToolId }) }] },
    { version: "v2", configurable: { thread_id: sessionId } }
  );
  const streamedPayloads = new Map();
  let emittedReply = "";
  let finalOutput;
  try {
    for await (const event of stream) {
      if (event.event === "on_tool_start") {
        const trace = toolTrace(event.name, "running");
        if (trace) yield { type: "agent_trace", step: trace };
      }
      if (event.event === "on_tool_end") {
        const trace = toolTrace(event.name, "completed", event.data?.output);
        if (trace) yield { type: "agent_trace", step: trace };
        // A completion tool call is the terminal action for this turn. Some
        // Qwen models keep generating after the tool result, so close the SSE
        // response here instead of waiting for an unnecessary follow-up turn.
        if (event.name === "complete_scene" && intent?.type === "complete_current_scene") {
          yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "完成结果已整理", detail: "" } };
          yield {
            type: "done",
            raw: {
              phase: "clarify",
              reply: "当前场景已完成。接下来可以从下面的工具中选择一个继续体验。",
              sceneTitle: activeScene,
              nextToolSuggestions: []
            }
          };
          return;
        }
      }
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
    const raw = parseStreamResult(finalOutput);
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "回复已生成", detail: "" } };
    yield { type: "done", raw };
  } catch (error) {
    if (!emittedReply) throw error;
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "已使用流式内容完成回复", detail: "" } };
    yield { type: "done", raw: fallbackStreamResult(emittedReply) };
  }
}

module.exports = { MODEL, runGuide, streamGuide, classifyUserIntent, inferInterestArea, ALLOWED_TOOL_IDS };
