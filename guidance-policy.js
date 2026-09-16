"use strict";

const { z } = require("zod");

const guidanceSchema = z.object({
  conclusion: z.string().trim().min(1).max(300),
  keyReasons: z.array(z.string().trim().min(1).max(220)).min(1).max(3),
  explorationOptions: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
  nextAction: z.enum(["explore", "clarify", "recommend"]),
  recommendationReady: z.boolean(),
  goal: z.string().max(300),
  goalEvidence: z.string().max(500),
  question: z.string().max(300)
});

// This fast path covers an explicit deliverable, not merely a topic keyword.
// More nuanced requests are judged by the advisor using conversation history.
function explicitDeliverableTool(message) {
  const value = String(message || "");
  if (/(不|没|先别|暂缓|了解|什么|是否|还是|或者|或是|哪[个种些]|有用|价值|适合|用处)/.test(value)) return null;
  if (!/(整理|制作|生成|发布|设计|开发|编写|写|做|准备|需要|想要)/.test(value)) return null;
  const matches = [
    ["jimeng", /文化工作墙|文化墙|海报|展板|配图|产品图|短视频|宣传片|插画/],
    ["codex", /代码|脚本|程序开发|接口开发|爬虫|VBA|宏程序|自动化报表/],
    ["workbuddy", /会议纪要|会议记录|PPT|演示文稿|办公文档|会议材料|日程安排/]
  ].filter(([, pattern]) => pattern.test(value));
  return matches.length === 1 ? matches[0][0] : null;
}

function fallbackGuidance(interestArea = "") {
  return {
    conclusion: `可以先从${interestArea || "你关心的领域"}中选择一个值得探索的管理方向。`,
    keyReasons: ["不同的管理目标需要不同的 AI 能力，先明确希望获得的帮助。"],
    explorationOptions: ["发现应用机会", "比较决策思路", "改善团队协同", "了解 AI 能力边界"],
    nextAction: "explore",
    recommendationReady: false,
    goal: "",
    goalEvidence: "",
    question: "你希望先从哪个方向探索？"
  };
}

function resolveGuidance(raw, { message = "", interestArea = "", intent } = {}) {
  const parsed = guidanceSchema.safeParse(raw);
  const guidance = parsed.success ? parsed.data : fallbackGuidance(interestArea);
  const fieldOnly = intent?.type === "select_interest_area";
  const deliverable = fieldOnly ? null : explicitDeliverableTool(message);
  if (deliverable) {
    return {
      ...guidance,
      conclusion: parsed.success && guidance.recommendationReady ? guidance.conclusion : "你的目标已经明确，可以直接体验与成果匹配的 AI 工具。",
      goal: message.slice(0, 300),
      goalEvidence: message.slice(0, 500),
      nextAction: "recommend",
      recommendationReady: true,
      question: ""
    };
  }
  const ready = !fieldOnly && guidance.recommendationReady === true
    && guidance.nextAction === "recommend" && Boolean(guidance.goal.trim() && guidance.goalEvidence.trim());
  return {
    ...guidance,
    nextAction: ready ? "recommend" : (guidance.nextAction === "explore" ? "explore" : "clarify"),
    recommendationReady: ready,
    question: ready ? "" : (guidance.question || "你更希望借助 AI 获得哪一方面的帮助？")
  };
}

function parseGuidance(content, context) {
  try {
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return resolveGuidance(JSON.parse(cleaned), context);
  } catch {
    return resolveGuidance(null, context);
  }
}

function pyramidReply(guidance) {
  return [guidance.conclusion, ...guidance.keyReasons.map(reason => `- ${reason}`)].join("\n\n");
}

module.exports = { explicitDeliverableTool, resolveGuidance, parseGuidance, pyramidReply };
