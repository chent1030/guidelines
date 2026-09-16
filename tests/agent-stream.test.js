"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { accumulateModelText, textFromModelChunk, partialField, structuredDetail, guideDetail } = require("../agent-stream");

test("模型未完成前就能读取建议增量，结束后内容不重复", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  async function* source() {
    yield { content: "建议动作：" };
    await gate;
    yield { content: [{ type: "text", text: "直接推荐工具" }] };
    yield { content: "" };
  }
  const output = accumulateModelText(source());
  assert.deepEqual(await output.next(), { done: false, value: { text: "建议动作：", output: "建议动作：" } });
  release();
  assert.deepEqual(await output.next(), { done: false, value: { text: "直接推荐工具", output: "建议动作：直接推荐工具" } });
  assert.equal((await output.next()).done, true);
});

test("建议输出中断时已收到的分片可用，错误交给调用方降级", async () => {
  async function* source() {
    yield { content: "已收到的建议" };
    throw new Error("stream interrupted");
  }
  const output = accumulateModelText(source());
  assert.equal((await output.next()).value.output, "已收到的建议");
  await assert.rejects(output.next(), /stream interrupted/);
});

test("只显示模型正文内容块，不输出推理或其他数据块", () => {
  assert.equal(textFromModelChunk({ content: [
    { type: "reasoning", text: "不显示的内容" },
    { type: "text", text: "建议正文" }
  ] }), "建议正文");
});

test("JSON 在任意字符处分片都不会造成回复漏字或转义残留", () => {
  const source = String.raw`{"reply":"文化墙\n建议：\"视觉\" C:\\demo \u4f60\u597d \ud83d\ude00","reason":"不应附加的内容"}`;
  let previous = "";
  for (let length = 1; length <= source.length; length += 1) {
    const value = partialField(source.slice(0, length), "reply");
    assert.ok(value.startsWith(previous), `非追加分片：${length}`);
    previous = value;
  }
  assert.equal(previous, JSON.parse(source).reply);
});

test("推荐理由在工具参数 JSON 尚未闭合时就可展示", () => {
  assert.equal(structuredDetail('{"toolId":"jimeng","reason":"视觉方向'), "推荐理由：视觉方向");
});

test("提纲及步骤渐进展示，步骤中的方括号不会截断输出", () => {
  const partial = '{"prompt":"分析[虚构背景]","steps":["比较[方向]","评估风险';
  assert.equal(structuredDetail(partial), "探索提纲：分析[虚构背景]\n1. 比较[方向]\n2. 评估风险");
  assert.equal(structuredDetail(partial + '"]}'), structuredDetail(partial));
});

test("导引同时支持纯文本和 Markdown 包裹的 JSON", () => {
  assert.equal(guideDetail("正在梳理管理方向"), "正在梳理管理方向");
  assert.equal(guideDetail('```json\n{"reply":"先看应用机会'), "导引：先看应用机会");
});
