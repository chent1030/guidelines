"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveGuidance, parseGuidance, explicitDeliverableTool } = require("../guidance-policy");
const { normaliseAgentResponse } = require("../server");
const { classifyUserIntent } = require("../agent-runtime");

const exploring = {
  conclusion: "先区分排程瓶颈对应的管理目标。",
  keyReasons: ["成因识别和策略比较需要不同的分析视角。"],
  explorationOptions: ["识别瓶颈成因", "比较排程策略", "协调资源分配"],
  nextAction: "clarify", recommendationReady: false, goal: "", goalEvidence: "",
  question: "你希望先关注哪个方向？"
};
const ready = {
  ...exploring, conclusion: "可以先比较排程策略对交付风险的影响。",
  goal: "比较排程策略对交付风险的影响", goalEvidence: "我想比较排程策略对交付风险的影响",
  nextAction: "recommend", recommendationReady: true, question: ""
};

test("多轮模糊议题不能被模型推荐、关键词或用户工具偏好强行收敛", () => {
  for (const message of ["生产", "生产计划经常有瓶颈", "还没想好", "会议材料也不太好", "继续看看"]) {
    const result = normaliseAgentResponse({ guidance: exploring, recommendedTool: "chatgpt", phase: "recommend", reply: "推荐 ChatGPT", sceneTitle: "PPT" },
      { message, intent: { type: "direct_scenario" }, preferredToolId: "workbuddy" });
    assert.equal(result.recommendation, null);
    assert.equal(result.phase, "clarify");
    assert.ok(result.reply.startsWith(exploring.conclusion));
    assert.deepEqual(result.questionOptions, exploring.explorationOptions);
    assert.doesNotMatch(result.reply, /ChatGPT/);
  }
});

test("议题和目标收敛后无需执行细节即可推荐", () => {
  const result = normaliseAgentResponse({ guidance: ready, recommendedTool: "chatgpt", reply: ready.conclusion },
    { message: "就比较这个影响", activeScene: "排程瓶颈", intent: { type: "continue_current_scene" } });
  assert.equal(result.recommendation.toolId, "chatgpt");
  assert.equal(result.question, "");
});

test("明确成果即使建议失败也直接推荐", () => {
  for (const [message, tool] of [["整理会议纪要", "workbuddy"], ["发布文化工作墙", "jimeng"], ["开发自动化脚本", "codex"]]) {
    const result = normaliseAgentResponse({ guidance: exploring }, { message });
    assert.equal(result.recommendation.toolId, tool);
  }
});

test("多个目标、否定、只问能力都必须交给建议判断，不能关键词直推", () => {
  for (const message of ["我想做海报和会议纪要", "先不要做PPT", "了解会议纪要能做什么", "制作文化墙是否有用", "需要什么样的PPT"]) {
    assert.equal(explicitDeliverableTool(message), null, message);
  }
});

test("多个目标明确主次后按主目标选工具，不按第一处关键词纠偏", () => {
  const guidance = { ...ready, goal: "整理会议纪要", goalEvidence: "先整理会议纪要" };
  const result = normaliseAgentResponse({ guidance, recommendedTool: "workbuddy" },
    { message: "我想做海报和会议纪要，先整理会议纪要" });
  assert.equal(result.recommendation.toolId, "workbuddy");
});

test("只选领域不能被就绪度误判推进", () => {
  assert.equal(resolveGuidance(ready, { intent: { type: "select_interest_area" }, message: "生产运营" }).recommendationReady, false);
});

test("无效布尔值、缺少依据、缺少目标和不一致动作均不推荐", () => {
  for (const override of [{ recommendationReady: "true" }, { goalEvidence: "" }, { goal: "" }, { nextAction: "explore" }]) {
    assert.equal(resolveGuidance({ ...ready, ...override }).recommendationReady, false);
  }
  assert.equal(parseGuidance('{"recommendationReady":true').recommendationReady, false);
  assert.equal(normaliseAgentResponse({ recommendedTool: "chatgpt" }, { message: "有点瓶颈" }).recommendation, null);
});

test("只想了解 AI 的能力时进入方向探索而非被送回领域选择", () => {
  assert.notEqual(classifyUserIntent({ message: "我想了解 AI 能做什么", initialTurn: true }).type, "choose_interest_area");
});
