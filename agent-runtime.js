"use strict";

const { createDeepAgent } = require("deepagents");
const { ChatOpenAI } = require("@langchain/openai");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
const { accumulateModelText, textFromModelChunk, partialField, structuredDetail, guideDetail } = require("./agent-stream");
const { parseGuidance } = require("./guidance-policy");

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
  "服务对象是集团公司经理，目标是帮助他们形成 AI 应用想法并认识工具边界，不是替一线人员收集交付需求或设计执行方案。",
  "采用金字塔原理：先给一句当前判断结论，再用 1 至 3 个简洁依据支撑，最后给出 2 至 4 个同层级、尽量不重叠的探索方向。内容必须贴合用户议题。",
  "conclusion 和 keyReasons 会直接展示给经理：应讲管理价值和判断依据，不写‘不能推荐’‘推荐就绪’‘信息不足’等内部流程说明。比如‘先分清瓶颈是来自排程策略还是资源协调，更容易找到值得尝试的 AI 方向。’探索选项保持简短，不收集一线执行材料。",
  "根据用户原话和前文评估推荐就绪度，绝不根据对话轮次决定推荐。只选领域、泛泛痛点或模糊兴趣不等于探索目标已明确。比如‘生产计划有瓶颈’应先区分识别成因、比较策略、协调资源等管理目标；‘比较不同排程策略对交付风险的影响’已明确分析目标，可以推荐，无须索取业务材料。",
  "用户明确要会议纪要、文化墙、海报或自动化脚本等成果时应直接推荐。管理议题已有明确的探索目标且能匹配一种主要 AI 能力时也可推荐，不要求制作规格、预算或实施计划。",
  "同时有多个目标且主次不明时，用一个关键问题确认主目标；用户只想了解 AI 时提供能力方向；只有场景和管理目标已经匹配，才设置 recommendationReady=true。不要为延长对话重复问已经回答的问题，也不要替用户选择目标。",
  "仅返回 JSON，按顺序包含 conclusion（结论）、keyReasons（1至3个依据）、explorationOptions（2至4个方向）、goal（当前探索目标，未明确时为空）、goalEvidence（用户确认目标的原话，可引用前文）、question（最多一个关键问题）、nextAction（explore/clarify/recommend）、recommendationReady（布尔值）。推荐就绪时 nextAction= recommend、question 为空。正文不要提前写工具名。",
  "不要把用户刚描述场景视为场景完成；不要询问用户的已有材料、格式、制作规格、具体使用对象或限制条件。"
].join("\n");

const GUIDE_INSTRUCTIONS = [
  "你是面向集团公司经理的 AI 实验室导引 Agent。AI 实验室的目标是启发管理者发现 AI 在工作中的应用可能，并认识不同工具适合解决什么问题，不是承接实际项目的需求调研或执行交付。",
  "用户可以先选择关注领域，也可以直接描述管理议题或明确成果。推荐时机由建议 Agent 的推荐就绪度决定，不由对话轮次决定。不要把描述痛点本身视为目标已经明确。",
  "关注领域包括：质量管理、人力资源、生产运营、设备领域、采购与供应链、经营管理。领域选择本身不是具体任务。",
  "用户真正可以体验的工具只有 ChatGPT、Codex、WorkBuddy、即梦AI。豆包、catlgpt、opencode、大头虾只能作为不可体验的对标参考，绝不能推荐用户去使用。",
  "推荐必须以用户最终要交付的成果为准，而不是以任务所属领域为准。每次推荐前都要比较四个工具，优先选择能直接产出最终成果的专业工具；不要因为 ChatGPT 也能讨论或提供思路就默认推荐 ChatGPT。",
  "工具边界必须严格遵守：即梦AI用于海报、文化墙、展板、配图、产品图、图片编辑和创意短视频等视觉成果；Codex用于代码、脚本、程序、接口、数据清洗、批量处理和可执行自动化；WorkBuddy用于会议纪要、PPT、办公文档、日程、知识库和办公协同；ChatGPT用于不依赖上述专业能力的纯文本写作、语言处理、通用分析、推理和头脑风暴。",
  "当任务同时包含策划和制作时，按最终成果选择：例如文化工作墙、海报或短视频应推荐即梦AI，不要因为前期需要文案而推荐 ChatGPT；自动化报表或批处理应推荐 Codex；会议纪要或正式 PPT 应推荐 WorkBuddy。只有主要成果确实是纯文本或通用推理时才推荐 ChatGPT。",
  "推荐理由只能引用上述已声明能力，禁止声称工具内置工业知识图谱、FMEA、鱼骨图、语音转写、自动导出或其他未明确提供的专有功能。",
  "用户刚选择关注领域时，信息不足：先询问该领域中最想关注的管理议题、决策机会或团队挑战，并提供 2 到 4 个方向。这一轮不得推荐工具、生成练习提示词或判定完成。",
  "直接进入场景只代表无需重新选择领域，不代表必须推荐。严格遵守系统提供的 guidance.recommendationReady：false 时不得调用 recommend_tool、create_practice_prompt，recommendedTool 必须为 null；true 时直接推荐唯一工具并生成探索提纲，不再收集落地细节。",
  "对明确场景的回复必须以管理者视角组织：先点出值得探索的管理机会，再解释推荐工具能帮助看到什么或验证什么，最后给出 2 到 3 个可讨论的探索方向。避免输出制作步骤、操作清单、字段模板、详细排期或具体文件要求。",
  "每轮用金字塔结构组织卡片：reply 先一句结论，再列 1 至 3 条关键依据；question 是一个关键问题；questionOptions 给 2 至 4 个同层级探索方向。根据建议 Agent 的结论、依据和目标推进，不在界面展示就绪度布尔值、内部字段名或调用协议。就绪后在探索提纲中保留 2 至 3 个探索方向。",
  "每轮只推进一个澄清步骤，只问一个关键问题；不要一次性把场景、对象、材料和输出要求全部问完。选择关注领域后的第一轮必须提供 2 到 4 个具体业务环节的 questionOptions，其他澄清轮次也应尽量提供选项。question 已由界面单独展示，reply 不要重复 question 的完整内容。",
  "只有用户明确表示已完成练习（例如‘我已完成练习’）时，才允许调用 complete_scene；绝不能根据用户刚描述任务、模型生成提示词或用户点击快捷任务来推断完成。完成当前场景后，必须在 JSON 中返回 nextToolSuggestions：从尚未体验的工具中选择 1 到 3 个，说明适合的下一类场景和推荐理由，帮助用户继续体验。",
  "只有系统提供的 recommendationReady=true 时才调用 recommend_tool 记录唯一推荐，再调用 create_practice_prompt 生成脱敏探索提纲。探索提纲应帮助经理与工具讨论方向、风险、选择或机会，不能写成一线执行说明书。",
  "最终推荐必须保持一致：recommendedTool 与本轮 recommend_tool、create_practice_prompt 的 toolId 相同。reply 只描述管理机会，工具名称和推荐理由统一放在 recommendedTool、reason 中，不要在正文另列工具推荐。practicePrompt、practiceSteps 只围绕本轮唯一工具展开，不要推荐切换其他工具。只有用户完成当前场景后才提供 nextToolSuggestions。",
  "敏感信息必须提醒用户替换为虚构或脱敏内容，不要复述敏感内容。用户完成一个场景后，允许继续描述下一个场景。",
  "最终回复必须是合法 JSON，字段为 phase、reply、question、questionOptions、sceneTitle、recommendedTool、reason、practicePrompt、practiceSteps、nextToolSuggestions。nextToolSuggestions 是数组，每项包含 toolId、title、reason、suggestedScenario；toolId 只能是 chatgpt、codex、workbuddy、jimeng。非完成场景可返回空数组。recommendedTool 只能是 chatgpt、codex、workbuddy、jimeng 或 null。phase 只能是 clarify、recommend、teach。reply 可以使用 Markdown。"
].join("\n");

const recommendTool = tool(async ({ toolId, reason, sceneTitle }, config) => config?.configurable?.recommendationReady === true
  ? { toolId, sceneTitle, reason }
  : { error: "探索目标尚未收敛，请继续提供方向选择，不要推荐工具。" }, {
  name: "recommend_tool",
  description: "按最终交付物为当前场景记录唯一工具：视觉成果选 jimeng，代码或自动化选 codex，办公文档/PPT/会议协同选 workbuddy，纯文本或通用推理才选 chatgpt。",
  schema: z.object({ toolId: z.enum(ALLOWED_TOOL_IDS), sceneTitle: z.string().min(1).max(100), reason: z.string().min(1).max(600) })
});

const createPracticePrompt = tool(async ({ toolId, prompt, steps }, config) => config?.configurable?.recommendationReady === true
  ? { toolId, practicePrompt: prompt, practiceSteps: steps.slice(0, 4) }
  : { error: "探索目标尚未收敛，暂不生成提纲。" }, {
  name: "create_practice_prompt",
  description: "为已推荐工具生成带占位符的脱敏探索提纲和步骤，面向经理的思考、讨论与判断，不生成一线执行说明。",
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
  advisorModel = new ChatOpenAI({ apiKey: QWEN_API_KEY, model: MODEL, temperature: 0.15, maxTokens: 1000, modelKwargs: MODEL_KWARGS, configuration: { baseURL: QWEN_BASE_URL } });
  agent = createDeepAgent({
    model,
    systemPrompt: GUIDE_INSTRUCTIONS,
    tools: [recommendTool, createPracticePrompt, completeScene],
    checkpointer: await getCheckpointer()
  });
  return agent;
}

async function* streamNextStepAdvisor({ sessionId, message, activeScene = "", interestArea = "", intent, currentToolId = "" }) {
  const currentAgent = await getAgent();
  const state = sessionId ? await currentAgent.getState({ configurable: { thread_id: sessionId } }) : null;
  const history = (state?.values?.messages || []).filter(item => ["human", "ai"].includes(item._getType?.()))
    .slice(-12).map(item => {
      const content = textFromModelChunk(item);
      return item._getType() === "human"
        ? `用户：${content.split("[用户原话]\n").at(-1).slice(0, 2000)}`
        : `导引：${content.slice(0, 2400)}`;
    }).join("\n");
  const stream = await advisorModel.stream([
    { role: "system", content: NEXT_STEP_ADVISOR_INSTRUCTIONS },
    {
      role: "user",
      content: [
        `关注领域：${interestArea || "未选择"}`,
        `当前场景：${activeScene || "尚未建立"}`,
        `用户意图：${intent?.type || "unknown"}`,
        `当前工具：${currentToolId || "未推荐"}`,
        `此前对话（用于理解选项、指代和已确认目标，不按轮次判断）：\n${history || "无"}`,
        `用户本轮输入：${message}`,
        "若用户换了领域或任务，以最新输入为准，不能沿用旧目标的就绪度。按约定 JSON 输出金字塔式建议。"
      ].join("\n")
    }
  ]);
  let output = "";
  for await (const part of accumulateModelText(stream)) {
    output = part.output;
    yield part;
  }
  if (!output.trim()) throw new Error("建议 Agent 未返回内容。");
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
  const asksForNewTask = /(我还想|另外|再做|下一个|新场景|请帮我|帮我)(写|做|制作|整理|生成|处理|开始)|我想(写|做|制作|整理|生成|处理|开始)/.test(normalized);
  if (isExplicitScenario(normalized) && (!activeScene || asksForNewTask)) {
    return { type: "direct_scenario", confidence: "high" };
  }
  if (!interestArea && (initialTurn || !activeScene)) {
    if (/(了解|看看|能做什么|应用|兴趣|方向|机会)/.test(normalized)) {
      return { type: "start_new_scene", confidence: "medium" };
    }
    return { type: "choose_interest_area", confidence: "high" };
  }
  if (interestArea && !activeScene) {
    return { type: "continue_current_scene", confidence: "high" };
  }
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
  if (message.length < 6) return false;
  const taskVerb = /(分析|整理|生成|制作|撰写|写|汇总|评估|排查|定位|优化|改进|翻译|计划|报告|方案|PPT|文档|代码|海报|视频|培训|审核|复盘|预测|发布|设计|策划|搭建|运营|处理|完成|做|编制|制定|安排|落地|上线|推进|开展|建立|通知|回复|提报|申报|盘点|核对|跟进|改善)/;
  const scenarioSignal = /(需要|想要|我想|想看看|想了解|如何|请|帮我|我们|目前|正在|负责|希望|准备|要|任务|场景|问题|痛点|需求|不合理|异常|瓶颈|闲置)/;
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
    direct_scenario: "直接进入用户描述的议题，自行判断领域，不退回领域选择。按建议 Agent 的就绪度决定继续引导还是推荐，不能仅因用户描述了痛点就强制推荐。",
    start_new_scene: "开始一个新场景，重新判断探索目标是否清楚，不沿用旧场景就绪度，不收集执行细节。",
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
    advice ? `[本轮建议 Agent 判定 guidance；以本轮为准]\n${advice}` : "",
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
  const context = { sessionId, message, initialTurn, activeScene, interestArea, intent, completedScenes, preferredToolId, currentToolId };
  let advice = "";
  try {
    for await (const part of streamNextStepAdvisor(context)) advice = part.output;
  } catch { /* Resolve conservatively when the advisor is unavailable. */ }
  const guidance = parseGuidance(advice, context);
  const result = await currentAgent.invoke({ messages: [{ role: "user", content: prepareMessage(message, { ...context, advice: JSON.stringify(guidance) }) }] }, { configurable: { thread_id: sessionId, recommendationReady: guidance.recommendationReady } });
  try {
    return { ...parseStreamResult(result), guidance };
  } catch (error) {
    if (guidance.recommendationReady) throw error;
    return { ...fallbackStreamResult(""), guidance };
  }
}

function partialReply(jsonText) {
  return partialField(jsonText, "reply");
}

function parseStreamResult(output) {
  if (output?.structuredResponse && typeof output.structuredResponse === "object") return output.structuredResponse;
  if (output?.phase && typeof output === "object") return output;
  const content = output?.messages?.at(-1)?.content;
  if (typeof content === "object" && content !== null && !Array.isArray(content)) return content;
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
    create_practice_prompt: { id: "practice", agent: "探索提纲工具", running: "正在生成探索提纲...", completed: "探索提纲已生成" },
    complete_scene: { id: "completion", agent: "场景记录工具", running: "正在记录场景结果...", completed: "场景结果已记录" }
  };
  const definition = definitions[toolName];
  if (!definition) return null;
  const content = output?.content ?? output;
  const serialized = typeof content === "string" ? content : JSON.stringify(content || {});
  const detail = (structuredDetail(serialized) || (status === "completed" ? serialized : "")).slice(0, 4000);
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
  const guidanceContext = { sessionId, message, activeScene, interestArea, intent, currentToolId };
  try {
    for await (const part of streamNextStepAdvisor(guidanceContext)) {
      advice = part.output;
      yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "running", message: "正在梳理结论、依据与探索方向...", detail: structuredDetail(advice) } };
    }
  } catch (error) {
    advice = "";
  }
  const guidance = parseGuidance(advice, guidanceContext);
  advice = JSON.stringify(guidance);
  yield { type: "agent_trace", step: { id: "advisor", agent: "建议 Agent", status: "completed", message: guidance.recommendationReady ? "探索目标已明确，进入工具匹配" : "继续梳理管理方向", detail: structuredDetail(advice) } };
  yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "running", message: "正在结合建议组织回复...", detail: "" } };
  const currentAgent = await getAgent();
  const stream = await currentAgent.streamEvents(
    { messages: [{ role: "user", content: prepareMessage(message, { initialTurn, activeScene, interestArea, intent, advice, completedScenes, preferredToolId, currentToolId }) }] },
    { version: "v2", configurable: { thread_id: sessionId, recommendationReady: guidance.recommendationReady } }
  );
  const streamedPayloads = new Map();
  const streamedToolNames = new Map();
  const traceDetails = new Map();
  let emittedReply = "";
  let finalOutput;
  try {
    for await (const event of stream) {
      if (event.event === "on_tool_start") {
        const trace = toolTrace(event.name, "running", event.data?.input);
        if (trace && (guidance.recommendationReady || !["recommendation", "practice"].includes(trace.id))) yield { type: "agent_trace", step: trace };
      }
      if (event.event === "on_tool_end") {
        const trace = toolTrace(event.name, "completed", event.data?.output);
        if (trace && (guidance.recommendationReady || !["recommendation", "practice"].includes(trace.id))) yield { type: "agent_trace", step: trace };
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
        const content = textFromModelChunk(chunk);
        if (content) {
          const key = `${event.run_id || "content"}:content`;
          const payload = (streamedPayloads.get(key) || "") + content;
          streamedPayloads.set(key, payload);
          const detail = guideDetail(payload);
          if (detail && detail !== traceDetails.get(key)) {
            traceDetails.set(key, detail);
            yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "running", message: "正在输出导引内容...", detail } };
          }
          const reply = partialReply(payload);
          if (reply.length > emittedReply.length && reply.startsWith(emittedReply)) {
            const text = reply.slice(emittedReply.length);
            emittedReply = reply;
            yield { type: "chunk", text };
          }
        }
        for (const toolChunk of chunk?.tool_call_chunks || []) {
          const key = `${event.run_id || "tool"}:${toolChunk.index || 0}`;
          if (toolChunk.name) streamedToolNames.set(key, toolChunk.name);
          const payload = (streamedPayloads.get(key) || "") + (typeof toolChunk.args === "string" ? toolChunk.args : "");
          streamedPayloads.set(key, payload);
          const trace = toolTrace(streamedToolNames.get(key), "running", payload);
          if (trace) {
            if (!guidance.recommendationReady && ["recommendation", "practice"].includes(trace.id)) continue;
            if (!traceDetails.has(key) || trace.detail !== traceDetails.get(key)) {
              traceDetails.set(key, trace.detail);
              yield { type: "agent_trace", step: trace };
            }
            continue;
          }
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
    if (!emittedReply && guidance.recommendationReady) throw error;
    yield { type: "done", raw: { ...fallbackStreamResult(emittedReply), guidance } };
    return;
  }
  try {
    const raw = parseStreamResult(finalOutput);
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "回复已生成", detail: raw.reply || emittedReply } };
    yield { type: "done", raw: { ...raw, guidance } };
  } catch (error) {
    if (!emittedReply && guidance.recommendationReady) throw error;
    yield { type: "agent_trace", step: { id: "guide", agent: "导引 Agent", status: "completed", message: "已使用流式内容完成回复", detail: "" } };
    yield { type: "done", raw: { ...fallbackStreamResult(emittedReply), guidance } };
  }
}

module.exports = { MODEL, runGuide, streamGuide, streamNextStepAdvisor, classifyUserIntent, inferInterestArea, ALLOWED_TOOL_IDS };
