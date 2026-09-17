"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normaliseAgentResponse } = require("../server");

const readyGuidance = {
  conclusion: "可以围绕这个管理目标进入实践。",
  keyReasons: ["目标和判断重点已经清楚。"],
  explorationOptions: ["比较方向", "评估风险"],
  goal: "分析管理思路",
  goalEvidence: "我想分析管理思路",
  nextAction: "recommend",
  recommendationReady: true,
  question: ""
};

test("信息未收敛时只展示金字塔建议，不生成题目", () => {
  const result = normaliseAgentResponse({ guidance: { ...readyGuidance, recommendationReady: false, nextAction: "clarify", question: "你想先关注什么？" } }, { message: "生产计划有瓶颈" });
  assert.equal(result.recommendation, null);
  assert.equal(result.challengeCards, undefined);
  assert.match(result.reply, /管理目标/);
  assert.ok(result.questionOptions.length);
});

test("信息收敛后生成两道实践题，不生成工具推荐", () => {
  const result = normaliseAgentResponse({ guidance: readyGuidance, recommendedTool: "chatgpt" }, { message: "希望缩短客诉闭环", interestArea: "质量管理" });
  assert.equal(result.recommendation, null);
  assert.equal(result.challengeCards.length, 2);
  assert.match(result.challengeCards[0].context, /分析管理思路/);
  assert.match(result.challengeCards[0].steps.join(""), /ChatGPT/);
  assert.match(result.challengeCards[1].steps.join(""), /WorkBuddy/);
});

test("完成实践题后回到领域选择，不推荐下一个工具", () => {
  const result = normaliseAgentResponse({ guidance: readyGuidance }, { message: "我已完成练习", intent: { type: "complete_current_scene" }, currentToolId: "codex" });
  assert.equal(result.recommendation, null);
  assert.deepEqual(result.nextToolSuggestions, []);
  assert.match(result.reply, /重新选择一个关注领域/);
  assert.equal(result.interestSelection, true);
  assert.equal(result.challengeCards, undefined);
});

test("只选领域不能提前出题", () => {
  const result = normaliseAgentResponse({ guidance: readyGuidance }, { message: "生产运营", interestArea: "生产运营", intent: { type: "select_interest_area" } });
  assert.equal(result.recommendation, null);
  assert.equal(result.challengeCards, undefined);
  assert.equal(result.phase, "clarify");
  assert.ok(result.questionOptions.length);
});
