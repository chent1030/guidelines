"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normaliseAgentResponse } = require("../server");
const { resolveGuidance } = require("../guidance-policy");

const readyGuidance = {
  conclusion: "可以比较管理思路。", keyReasons: ["探索目标已明确。"],
  explorationOptions: ["比较方向", "评估风险"], goal: "分析管理思路", goalEvidence: "我想分析管理思路",
  nextAction: "recommend", recommendationReady: true, question: ""
};

const raw = {
  phase: "recommend",
  reply: "推荐 ChatGPT，它可以帮你分析管理思路。",
  recommendedTool: "chatgpt",
  reason: "ChatGPT 适合分析。",
  practicePrompt: "使用 ChatGPT 分析虚构案例。",
  practiceSteps: ["打开 ChatGPT", "比较管理思路"]
};

for (const [message, expected] of [
  ["我现在接到了一个任务需要发布文化工作墙", "jimeng"],
  ["我想整理一份会议纪要", "workbuddy"],
  ["我想做一个自动化报表脚本", "codex"]
]) {
  test(`正文、理由与探索提纲跟随最终推荐：${message}`, () => {
    const result = normaliseAgentResponse(raw, { message, intent: { type: "direct_scenario" } });
    assert.equal(result.recommendation.toolId, expected);
    assert.doesNotMatch(JSON.stringify(result), /chatgpt/i);
    assert.match(result.reply, new RegExp(result.recommendation.name));
    assert.equal(result.selectionAdjusted, true);
  });
}

test("一致的管理分析推荐保留模型原文", () => {
  const result = normaliseAgentResponse({ ...raw, guidance: readyGuidance }, { message: "我想分析生产计划排程的决策质量" });
  assert.equal(result.recommendation.toolId, "chatgpt");
  assert.equal(result.reply, raw.reply);
  assert.equal(result.recommendation.practicePrompt, raw.practicePrompt);
});

test("模型正文提到海报不能把会议纪要纠偏成视觉工具", () => {
  const result = normaliseAgentResponse({ ...raw, reply: "可以做海报或自动化脚本。" }, { message: "我想整理会议纪要" });
  assert.equal(result.recommendation.toolId, "workbuddy");
  assert.doesNotMatch(result.reply, /海报|脚本/);
});

test("用户原话优先于模型场景标题", () => {
  const result = normaliseAgentResponse({ ...raw, sceneTitle: "海报制作" }, { message: "我想整理会议纪要" });
  assert.equal(result.recommendation.toolId, "workbuddy");
});

test("模型字段正确但正文和步骤推荐其他工具时重建一致文案", () => {
  const result = normaliseAgentResponse({ ...raw, recommendedTool: "jimeng", reply: "推荐即梦，也可以试试 Work Buddy。" }, { message: "设计文化墙" });
  assert.equal(result.recommendation.toolId, "jimeng");
  assert.doesNotMatch(JSON.stringify(result), /chatgpt|work\s*buddy/i);
});

test("用户指定工具时同步理由、提纲，避免把旧工具能力改名移植", () => {
  const result = normaliseAgentResponse({ ...raw, guidance: readyGuidance, reply: "ChatGPT 可以写代码。" }, { message: "探索视觉表达", preferredToolId: "jimeng" });
  assert.equal(result.recommendation.toolId, "jimeng");
  assert.doesNotMatch(JSON.stringify(result), /chatgpt|写代码/i);
});

test("澄清轮次展示建议结论和探索方向", () => {
  const guidance = resolveGuidance(null);
  const result = normaliseAgentResponse({ phase: "clarify", guidance }, { message: "了解一下" });
  assert.equal(result.recommendation, null);
  assert.ok(result.reply.startsWith(guidance.conclusion));
  assert.deepEqual(result.questionOptions, guidance.explorationOptions);
});

test("完成场景后允许推荐其他工具，不能继续显示本轮推荐正文", () => {
  const result = normaliseAgentResponse(raw, { message: "完成文化墙", intent: { type: "complete_current_scene" }, currentToolId: "jimeng" });
  assert.equal(result.recommendation, null);
  assert.match(result.reply, /当前场景已完成/);
  assert.equal(result.nextToolSuggestions.length, 3);
});

test("只选领域不能提前推荐工具", () => {
  const result = normaliseAgentResponse(raw, { message: "生产运营", interestArea: "生产运营", intent: { type: "select_interest_area" } });
  assert.equal(result.recommendation, null);
  assert.equal(result.phase, "clarify");
  assert.ok(result.questionOptions.length);
});
