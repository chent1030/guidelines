"use strict";

require("dotenv").config({ quiet: true });

const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const { MODEL, runGuide, streamGuide, classifyUserIntent, inferInterestArea } = require("./agent-runtime");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PAGE_FILE = "AI体验中心指引页面 index.html（更新版）.html";
const DIST_DIR = path.join(__dirname, "dist");
const MAX_CONCURRENT_CALLS = Number.parseInt(process.env.MAX_CONCURRENT_CALLS || "12", 10);
let inFlightCalls = 0;
const ALLOWED_TOOLS = {
  chatgpt: {
    name: "ChatGPT",
    tag: "通用 AI 对话助手",
    benchmarks: ["豆包", "公司内 catlgpt"],
    focus: "写作、翻译、润色、总结、头脑风暴和通用问答"
  },
  codex: {
    name: "Codex",
    tag: "AI 编程 Agent",
    benchmarks: ["公司内 opencode"],
    focus: "代码生成、调试、重构、脚本、自动化和数据处理"
  },
  workbuddy: {
    name: "WorkBuddy",
    tag: "全场景 AI 办公工作台",
    benchmarks: ["公司内大头虾"],
    focus: "会议纪要、办公文档、PPT、日程、知识库与办公协同"
  },
  jimeng: {
    name: "即梦AI",
    tag: "AI 创意生成（图片 / 视频）",
    benchmarks: [],
    focus: "海报、配图、产品图、图片编辑和创意短视频素材"
  }
};

const INTEREST_STARTER_OPTIONS = {
  "质量管理": ["质量问题分析与根因定位", "质量数据与报表分析", "纠正预防措施与改善闭环", "检查、审核与质量文档"],
  "人力资源": ["招聘与人才筛选", "培训与能力发展", "绩效沟通与反馈", "员工信息与制度文档"],
  "生产运营": ["排产计划与交付协调", "现场异常分析", "效率与产能改善", "标准作业与现场文档"],
  "设备领域": ["设备运行状态分析", "预防性维护与点检", "故障诊断与维修记录", "备件与设备文档管理"],
  "采购与供应链": ["供应商评估与管理", "采购成本与比价分析", "交付风险与进度跟踪", "采购文档与合同要点整理"],
  "经营管理": ["经营数据与趋势分析", "预算与计划编制", "经营会议材料整理", "管理决策信息汇总"]
};

const auditPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.DB_POOL_MAX || "20", 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 })
  : null;
let auditReady = false;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use("/videos", express.static(path.join(__dirname, "videos"), { fallthrough: false, maxAge: 0 }));
app.use(express.static(DIST_DIR, { fallthrough: true, maxAge: 0 }));

app.get("/api/health", (_request, response) => {
  response.set("Cache-Control", "no-store").json({
    ok: true,
    model: MODEL,
    configured: Boolean(process.env.QWEN_API_KEY && auditReady),
    agentConfigured: Boolean(process.env.QWEN_API_KEY),
    databaseConfigured: auditReady,
    maxConcurrentCalls: MAX_CONCURRENT_CALLS,
    inFlightCalls
  });
});

app.post("/api/guide/chat/stream", async (request, response, next) => {
  const startedAt = Date.now();
  let auditId = null;
  let slotAcquired = false;
  let heartbeat = null;
  try {
    const message = text(request.body?.message, 2000);
    const sessionId = normaliseSessionId(request.body?.sessionId);
    const userName = normaliseUserName(request.body?.userName);
    const activeScene = text(request.body?.activeScene, 300);
    const interestArea = text(request.body?.interestArea, 100);
    const currentToolId = text(request.body?.currentToolId, 40);
    const completedScenes = Array.isArray(request.body?.completedScenes) ? request.body.completedScenes : [];
    const preferredToolId = text(request.body?.preferredToolId, 40);
    const interestSelection = request.body?.interestSelection === true;
    const initialTurn = request.body?.initialTurn === true;
    if (!message) {
      response.status(400).json({ error: { code: "invalid_message", message: "请描述您想完成的工作。" } });
      return;
    }
    if (!sessionId) {
      response.status(400).json({ error: { code: "invalid_session", message: "会话标识无效，请刷新页面后重试。" } });
      return;
    }
    if (!userName) {
      response.status(400).json({ error: { code: "invalid_user_name", message: "请输入 2 至 30 个字符的姓名。" } });
      return;
    }
    if (!auditReady) {
      response.status(503).json({ error: { code: "database_not_configured", message: "尚未配置 PostgreSQL 数据库，暂时无法记录本次调用。" } });
      return;
    }
    if (inFlightCalls >= MAX_CONCURRENT_CALLS) {
      response.set("Retry-After", "5").status(429).json({ error: { code: "concurrency_limit", message: "当前体验人数较多，请 5 秒后重试。" } });
      return;
    }
    inFlightCalls += 1;
    slotAcquired = true;
    const intent = classifyUserIntent({ message, activeScene, interestArea, interestSelection, initialTurn });
    auditId = await startAudit({ request, message, sessionId, startedAt, activeScene, interestArea, intent });
    response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(": keep-alive\n\n");
    }, 15000);
    writeSse(response, { type: "agent_trace", step: { id: "intent", agent: "意图判断 Agent", status: "running", message: "正在分析用户意图...", detail: "" } });
    writeSse(response, { type: "agent_trace", step: { id: "intent", agent: "意图判断 Agent", status: "completed", message: intentTraceMessage(intent), detail: `意图类型：${intent.type}` } });
    for await (const event of streamGuide({ sessionId, message, initialTurn, activeScene, interestArea, intent, completedScenes, preferredToolId, currentToolId })) {
      if (event.type === "chunk" || event.type === "agent_trace") writeSse(response, event);
      if (event.type === "done") {
        const result = normaliseAgentResponse(event.raw, { intent, message, interestArea, completedScenes, currentToolId, preferredToolId });
        await finishAudit(auditId, { status: "succeeded", response: result, latencyMs: Date.now() - startedAt });
        writeSse(response, { type: "done", result });
      }
    }
    response.end();
  } catch (error) {
    console.error("Guide stream failed:", error);
    if (auditId) {
      try { await finishAudit(auditId, { status: "failed", error, latencyMs: Date.now() - startedAt }); }
      catch (auditError) { console.error("调用失败记录更新失败:", auditError.message); }
    }
    if (response.headersSent) {
      writeSse(response, { type: "error", message: "对话服务暂时不可用，请稍后重试。" });
      response.end();
    } else next(error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (slotAcquired) inFlightCalls = Math.max(0, inFlightCalls - 1);
  }
});

app.post("/api/guide/chat", async (request, response, next) => {
  const startedAt = Date.now();
  let auditId = null;
  let slotAcquired = false;
  try {
    const message = text(request.body?.message, 2000);
    const sessionId = normaliseSessionId(request.body?.sessionId);
    const userName = normaliseUserName(request.body?.userName);
    const activeScene = text(request.body?.activeScene, 300);
    const interestArea = text(request.body?.interestArea, 100);
    const currentToolId = text(request.body?.currentToolId, 40);
    const completedScenes = Array.isArray(request.body?.completedScenes) ? request.body.completedScenes : [];
    const preferredToolId = text(request.body?.preferredToolId, 40);
    const interestSelection = request.body?.interestSelection === true;
    const initialTurn = request.body?.initialTurn === true;
    if (!message) {
      response.status(400).json({ error: { code: "invalid_message", message: "请描述您想完成的工作。" } });
      return;
    }
    if (!sessionId) {
      response.status(400).json({ error: { code: "invalid_session", message: "会话标识无效，请刷新页面后重试。" } });
      return;
    }
    if (!userName) {
      response.status(400).json({ error: { code: "invalid_user_name", message: "请输入 2 至 30 个字符的姓名。" } });
      return;
    }
    if (!auditReady) {
      response.status(503).json({
        error: { code: "database_not_configured", message: "尚未配置 PostgreSQL 数据库，暂时无法记录本次调用。" }
      });
      return;
    }
    if (inFlightCalls >= MAX_CONCURRENT_CALLS) {
      response.set("Retry-After", "5").status(429).json({ error: { code: "concurrency_limit", message: "当前体验人数较多，请 5 秒后重试。" } });
      return;
    }
    inFlightCalls += 1;
    slotAcquired = true;
    const intent = classifyUserIntent({ message, activeScene, interestArea, interestSelection, initialTurn });
    auditId = await startAudit({ request, message, sessionId, startedAt, activeScene, interestArea, intent });

    const raw = await runGuide({ sessionId, message, initialTurn, activeScene, interestArea, intent, completedScenes, preferredToolId, currentToolId });
    const result = normaliseAgentResponse(typeof raw === "string" ? parseModelJson(raw) : raw, { intent, message, interestArea, completedScenes, currentToolId, preferredToolId });
    await finishAudit(auditId, { status: "succeeded", response: result, latencyMs: Date.now() - startedAt });
    response.set("Cache-Control", "no-store").json(result);
  } catch (error) {
    if (auditId) {
      try {
        await finishAudit(auditId, { status: "failed", error, latencyMs: Date.now() - startedAt });
      } catch (auditError) {
        console.error("调用失败记录更新失败:", auditError.message);
      }
    }
    next(error);
  } finally {
    if (slotAcquired) inFlightCalls = Math.max(0, inFlightCalls - 1);
  }
});

app.get("/", (_request, response) => {
  const page = path.join(DIST_DIR, "index.html");
  response.sendFile(fs.existsSync(page) ? page : path.join(__dirname, PAGE_FILE));
});

app.use((error, _request, response, _next) => {
  if (error?.type === "entity.too.large") {
    response.status(413).json({ error: { code: "request_too_large", message: "输入内容过长，请缩短后再试。" } });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: { code: "invalid_json", message: "请求格式不正确。" } });
    return;
  }
  if (error?.code === "agent_not_configured") {
    response.status(503).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error?.code === "database_not_configured") {
    response.status(503).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error("Guide agent failed:", error);
  response.status(502).json({ error: { code: "agent_error", message: "对话服务暂时不可用，请稍后重试。" } });
});

function text(value, maxLength = 1600) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function intentTraceMessage(intent) {
  const labels = {
    choose_interest_area: "已判断：请选择关注领域",
    select_interest_area: "已判断：进入所选领域",
    direct_scenario: "已判断：直接处理明确场景",
    continue_current_scene: "已判断：继续梳理当前场景",
    start_new_scene: "已判断：开始新的场景",
    complete_current_scene: "已判断：完成当前场景",
    complete_without_active_scene: "已判断：当前没有进行中的场景",
    request_next_scene: "已判断：返回场景选择"
  };
  return labels[intent?.type] || "用户意图分析已完成";
}

async function startAudit({ request, message, sessionId, startedAt, activeScene, interestArea, intent }) {
  const userName = normaliseUserName(request.body?.userName);
  const payload = { sessionId, activeScene, interestArea, intent, completedScenes: request.body?.completedScenes || [] };
  const result = await auditPool.query(
    "INSERT INTO agent_call_logs (model, status, message, session_id, user_name, request_payload, started_at) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0)) RETURNING id",
    [MODEL, "started", message, sessionId, userName, payload, startedAt]
  );
  return result.rows[0].id;
}

async function finishAudit(id, { status, response, error, latencyMs }) {
  await auditPool.query(
    "UPDATE agent_call_logs SET status = $1, response_payload = $2, error_code = $3, error_message = $4, latency_ms = $5, finished_at = NOW() WHERE id = $6",
    [status, response || null, error?.code || null, error?.message || null, latencyMs, id]
  );
}

async function initAuditStore() {
  if (!auditPool) return;
  await auditPool.query(`CREATE TABLE IF NOT EXISTS agent_call_logs (
    id BIGSERIAL PRIMARY KEY,
    model VARCHAR(120) NOT NULL,
    status VARCHAR(24) NOT NULL,
    message TEXT NOT NULL,
    session_id VARCHAR(120) NOT NULL,
    user_name VARCHAR(50),
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload JSONB,
    error_code VARCHAR(120),
    error_message TEXT,
    latency_ms INTEGER,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  )`);
  await auditPool.query("ALTER TABLE agent_call_logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(120)");
  await auditPool.query("ALTER TABLE agent_call_logs ADD COLUMN IF NOT EXISTS user_name VARCHAR(50)");
  await auditPool.query("CREATE INDEX IF NOT EXISTS agent_call_logs_user_name_idx ON agent_call_logs (user_name)");
  auditReady = true;
}

function normaliseSessionId(value) {
  const sessionId = text(value, 120);
  return /^[A-Za-z0-9_-]{12,120}$/.test(sessionId) ? sessionId : null;
}

function normaliseUserName(value) {
  const userName = text(value, 50).replace(/\s+/g, " ");
  const length = Array.from(userName).length;
  return length >= 2 && length <= 30 && !/[\u0000-\u001f\u007f]/.test(userName) ? userName : null;
}

function parseModelJson(content) {
  const cleaned = text(content, 12000)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const candidates = [];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(cleaned);

  // Find balanced JSON objects so explanatory text and braces inside quoted
  // strings do not make the extraction depend on the first/last brace.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(cleaned.slice(start, index + 1));
        start = -1;
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next extraction candidate.
    }
  }
  const error = new Error("Qwen did not return valid JSON.");
  error.code = "invalid_model_json";
  throw error;
}

function removeTrailingQuestion(reply, question) {
  const value = text(reply, 1800);
  const target = text(question, 400);
  if (!value || !target) return value;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`(?:\\s*\\*{0,2})${escaped}(?:\\*{0,2})\\s*$`), "").trim();
}

const NEXT_TOOL_SCENARIOS = {
  chatgpt: "撰写汇报材料、制度说明或管理沟通稿",
  codex: "自动化处理台账、报表或重复性数据工作",
  workbuddy: "整理会议纪要、办公文档或汇报材料",
  jimeng: "制作宣传海报、培训配图或短视频素材"
};

function nextToolSuggestions(rawSuggestions, { completedScenes = [], currentToolId = "" } = {}) {
  const completedToolIds = new Set(
    completedScenes
      .map(scene => scene?.toolId || Object.entries(ALLOWED_TOOLS).find(([, tool]) => tool.name === scene?.toolName)?.[0])
      .filter(Boolean)
  );
  if (currentToolId) completedToolIds.add(currentToolId);
  const seen = new Set();
  const suggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.map(item => {
      const toolId = item?.toolId;
      if (!ALLOWED_TOOLS[toolId] || completedToolIds.has(toolId) || seen.has(toolId)) return null;
      seen.add(toolId);
      return {
        toolId,
        title: text(item.title, 100) || ALLOWED_TOOLS[toolId].name,
        reason: text(item.reason, 400) || `适合${ALLOWED_TOOLS[toolId].focus}。`,
        suggestedScenario: text(item.suggestedScenario, 220) || NEXT_TOOL_SCENARIOS[toolId]
      };
    }).filter(Boolean)
    : [];
  if (suggestions.length) return suggestions.slice(0, 3);
  return Object.entries(ALLOWED_TOOLS)
    .filter(([toolId]) => !completedToolIds.has(toolId))
    .slice(0, 3)
    .map(([toolId, tool]) => ({
      toolId,
      title: tool.name,
      reason: `适合${tool.focus}，可以作为下一个练习方向。`,
      suggestedScenario: NEXT_TOOL_SCENARIOS[toolId]
    }));
}

function normaliseAgentResponse(raw, { intent, message = "", interestArea = "", completedScenes = [], currentToolId = "", preferredToolId = "" } = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  if (intent?.type === "request_next_scene" || intent?.type === "choose_interest_area") {
    return {
      phase: "clarify",
      reply: text(raw.reply, 1800) || "我们先从你关心的领域开始。请选择一个方向，我会继续带你梳理具体需求。",
      question: text(raw.question, 400) || "你想先从哪个领域开始？",
      questionOptions: Array.isArray(raw.questionOptions) ? raw.questionOptions.map(option => text(option, 120)).filter(Boolean).slice(0, 6) : [],
      sceneTitle: "",
      recommendation: null,
      interestSelection: true
    };
  }
  const toolId = ALLOWED_TOOLS[preferredToolId]
    ? preferredToolId
    : (typeof raw.recommendedTool === "string" && ALLOWED_TOOLS[raw.recommendedTool]
      ? raw.recommendedTool
      : null);
  const steps = Array.isArray(raw.practiceSteps)
    ? raw.practiceSteps.map(step => text(step, 220)).filter(Boolean).slice(0, 4)
    : [];
  const questionOptions = Array.isArray(raw.questionOptions)
    ? raw.questionOptions.map(option => text(option, 120)).filter(Boolean).slice(0, 4)
    : [];
  const question = text(raw.question, 400);
  const inferredInterestArea = text(interestArea, 100) || (intent?.type === "direct_scenario" ? inferInterestArea(message) : "");
  const phase = ["clarify", "recommend", "teach"].includes(raw.phase)
    ? raw.phase
    : (toolId ? "recommend" : "clarify");
  const recommendation = toolId ? {
    toolId,
    name: ALLOWED_TOOLS[toolId].name,
    tag: ALLOWED_TOOLS[toolId].tag,
    benchmarks: ALLOWED_TOOLS[toolId].benchmarks,
    reason: text(raw.reason, 600) || `该工具更适合${ALLOWED_TOOLS[toolId].focus}。`,
    practicePrompt: text(raw.practicePrompt, 1800),
    practiceSteps: steps
  } : null;
  const result = {
    phase,
    reply: removeTrailingQuestion(text(raw.reply, 1800) || (toolId ? "我已为你匹配到合适的体验工具。" : "请再补充一点你希望完成的任务。"), question),
    question,
    questionOptions,
    sceneTitle: text(raw.sceneTitle, 100) || "当前体验场景",
    recommendation,
    sceneSelection: Boolean(raw.sceneSelection),
    nextToolSuggestions: [],
    inferredInterestArea,
    scenarioStarted: intent?.type === "direct_scenario"
  };
  if (intent?.type === "complete_current_scene") {
    if (!text(raw.reply, 1800)) result.reply = "当前场景已完成。接下来可以从下面的工具中选择一个继续体验。";
    result.nextToolSuggestions = nextToolSuggestions(raw.nextToolSuggestions, { completedScenes, currentToolId });
    result.interestSelection = true;
    result.question = "也可以继续选择一个关注领域，开始下一个场景。";
    result.questionOptions = ["质量管理", "人力资源", "生产运营", "设备领域", "采购与供应链", "经营管理"];
    result.recommendation = null;
    result.phase = "clarify";
  }
  if (intent?.type === "select_interest_area") {
    const area = text(interestArea || message, 100);
    const starterQuestion = result.question || "在这个领域里，你最想改善哪一类业务环节或管理问题？";
    const starterOptions = result.questionOptions.length
      ? result.questionOptions
      : (INTEREST_STARTER_OPTIONS[area] || ["提升工作效率", "辅助经营决策", "优化团队协作", "还不确定，先看看方向"]);
    const starterReply = removeTrailingQuestion(result.reply, starterQuestion);
    if (result.phase !== "clarify" || result.recommendation) {
      return {
        phase: "clarify",
        reply: `好的，我们先从“${area}”开始。`,
        question: starterQuestion,
        questionOptions: starterOptions,
        sceneTitle: "",
        recommendation: null
      };
    }
    return {
      ...result,
      phase: "clarify",
      reply: starterReply || `好的，我们先从“${area}”开始。`,
      question: starterQuestion,
      questionOptions: starterOptions,
      sceneTitle: "",
      recommendation: null
    };
  }
  if (intent?.type === "start_new_scene" && (result.phase !== "clarify" || result.recommendation)) {
    return {
      phase: "clarify",
      reply: `先了解“${text(message, 120)}”的具体要求，再为你匹配合适的工具。`,
      question: "请补充这个任务的具体使用场景、面向对象、已有材料，以及你希望的输出要求。",
      questionOptions: ["先说明使用场景", "先说明面向对象", "先说明已有材料", "先说明输出要求"],
      sceneTitle: result.sceneTitle,
      recommendation: null
    };
  }
  if (intent?.type === "complete_without_active_scene") {
    return {
      phase: "clarify",
      reply: "当前还没有进行中的场景。请先选择你关心的领域。",
      question: "你想先从哪个领域开始？",
      questionOptions: ["质量管理", "人力资源", "生产运营", "设备领域", "采购与供应链", "经营管理"],
      sceneTitle: "",
      recommendation: null,
      interestSelection: true
    };
  }
  return result;
}

initAuditStore().catch(error => console.error("PostgreSQL 初始化失败:", error.message));
app.listen(PORT, () => {
  console.log(`AI 实验室已启动：http://localhost:${PORT}`);
});
