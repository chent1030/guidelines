"use strict";

function textFromModelChunk(chunk) {
  const content = chunk?.content ?? chunk;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content
    .filter(part => part?.type === "text")
    .map(part => part.text || "").join("");
  return "";
}

async function* accumulateModelText(stream) {
  let output = "";
  for await (const chunk of stream) {
    const text = textFromModelChunk(chunk);
    if (!text) continue;
    output += text;
    yield { text, output };
  }
}

// Decode only complete characters: a transport chunk can end in a JSON
// escape, a Unicode escape or the first half of a surrogate pair.
function readString(source, start) {
  if (source[start] !== '"') return { value: "", end: start, closed: false };
  let index = start + 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === '"') break;
  }
  const closed = index < source.length;
  let encoded = source.slice(start + 1, Math.min(index, source.length));
  if (!closed) {
    // Try the full prefix first so a complete escaped backslash stays intact.
    for (let trim = 0; trim <= Math.min(6, encoded.length); trim += 1) {
      try {
        const value = JSON.parse(`"${encoded.slice(0, encoded.length - trim)}"`);
        return { value: value.replace(/[\uD800-\uDBFF]$/, ""), end: source.length, closed };
      } catch { /* Wait for the rest of an incomplete escape. */ }
    }
    return { value: "", end: source.length, closed };
  }
  try {
    return { value: JSON.parse(`"${encoded}"`), end: index + 1, closed };
  } catch {
    return { value: "", end: index + 1, closed };
  }
}

function partialField(source, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*`).exec(source);
  if (!match) return "";
  return readString(source, match.index + match[0].length).value;
}

function partialList(source, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*\\[\\s*`).exec(source);
  if (!match) return [];
  const values = [];
  let index = match.index + match[0].length;
  while (source[index] === '"') {
    const item = readString(source, index);
    if (item.value) values.push(item.value);
    if (!item.closed) break;
    index = item.end;
    while (/[\s,]/.test(source[index] || "x")) index += 1;
  }
  return values;
}

function structuredDetail(payload) {
  const labels = { conclusion: "结论", sceneTitle: "场景", reason: "推荐理由", prompt: "探索提纲", practicePrompt: "探索提纲", description: "建议任务", reply: "导引" };
  const lines = Object.entries(labels).flatMap(([field, label]) => {
    const value = partialField(payload, field);
    return value ? [`${label}：${value}`] : [];
  });
  const steps = partialList(payload, "steps").concat(partialList(payload, "practiceSteps"));
  const reasons = partialList(payload, "keyReasons");
  const options = partialList(payload, "explorationOptions");
  const question = partialField(payload, "question");
  return [...lines, ...reasons.map(reason => `依据：${reason}`), ...options.map(option => `探索方向：${option}`),
    ...steps.map((step, index) => `${index + 1}. ${step}`), question ? `下一步：${question}` : ""].filter(Boolean).join("\n");
}

function guideDetail(payload) {
  const value = payload.replace(/^\s*```(?:json)?\s*/i, "").trimStart();
  return value.startsWith("{") ? structuredDetail(value) : value;
}

module.exports = { accumulateModelText, textFromModelChunk, partialField, structuredDetail, guideDetail };
