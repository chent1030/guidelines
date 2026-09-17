"use strict";

const CHALLENGES = [
  {
    id: "idea-to-running-project",
    title: "使用 ChatGPT + Codex 完成一个小项目",
    eyebrow: "挑战一 · 从想法到运行",
    question: "请把一个模糊的工作想法转化为清晰需求，再由 Codex 完成项目构建、运行和验证。",
    context: "可以选择一个脱敏的管理小想法，例如会议纪要整理、生产异常登记、设备点检提醒或部门信息看板。",
    steps: [
      "先使用 ChatGPT 描述你的初步想法，请它追问目标用户、核心问题、输入信息、期望结果和验收标准。",
      "继续使用 ChatGPT 把讨论结果整理成需求说明，包括功能范围、页面或流程、数据结构、异常情况和运行方式。",
      "将确认后的需求说明交给 Codex，请 Codex 创建项目、编写代码、安装依赖，并完成本地构建或运行。",
      "根据 Codex 的运行结果继续反馈报错和改进要求，让 Codex 修复问题并补充必要的测试。",
      "回看最终项目，请 ChatGPT 总结需求与实现是否一致，并记录下一步可以继续优化的方向。"
    ],
    inputs: ["一段已脱敏的管理想法", "目标用户、希望改善的结果和已知限制"],
    deliverables: ["一份需求说明", "一个可以运行的小项目", "一份验证结果与后续改进清单"],
    completionCriteria: ["需求说明能被他人复述并确认范围", "项目能在本地启动并完成至少一个核心流程", "记录实际结果、偏差和下一步改进"],
    reflectionQuestions: ["哪些判断由 AI 提供，哪些仍需要经理决策？", "如果继续投入，最值得优先验证的方向是什么？"]
  },
  {
    id: "workbuddy-knowledge-base",
    title: "使用 WorkBuddy 完成个人知识库构建",
    eyebrow: "挑战二 · 个人知识沉淀",
    question: "请围绕一个长期关注的管理主题，建立可持续补充、检索和复用的个人知识库。",
    context: "可以选择一个脱敏主题，例如质量改善方法、供应商管理经验、设备故障案例或经营分析资料。",
    steps: [
      "先确定知识库主题和使用目标，列出你希望以后快速找到的 3 至 5 类问题。",
      "准备脱敏后的资料，把制度、会议记录、案例、经验总结或网页内容按主题收集到 WorkBuddy。",
      "请 WorkBuddy 为资料提炼摘要、关键词、主题标签和来源信息，并建议一个便于长期维护的分类结构。",
      "用真实工作中的问题检索知识库，让 WorkBuddy 汇总相关内容、比较不同案例，并指出资料缺口或相互矛盾的地方。",
      "根据使用结果调整分类、标签和更新规则，形成一份知识库维护约定。"
    ],
    inputs: ["一个长期关注的管理主题", "已脱敏的制度、会议、案例或经验资料"],
    deliverables: ["一个主题清晰的个人知识库", "一套分类、标签和检索方式", "一份持续更新与维护约定"],
    completionCriteria: ["资料可以按主题和标签检索", "针对一个真实问题能找到来源并完成归纳", "明确新增资料、复核和失效内容的维护规则"],
    reflectionQuestions: ["哪些知识值得沉淀为团队共用资产？", "如何判断知识库内容仍然可靠和适用？"]
  }
];

const AREA_EXAMPLES = {
  "质量管理": ["客诉问题闭环", "来料质量异常", "质量审核问题整改"],
  "人力资源": ["培训需求管理", "绩效沟通记录", "员工能力档案"],
  "生产运营": ["生产异常登记", "排产协同看板", "现场改善记录"],
  "设备领域": ["设备点检提醒", "故障案例沉淀", "备件管理台账"],
  "采购与供应链": ["供应商评估", "采购比价分析", "交付风险跟踪"],
  "经营管理": ["经营会议材料", "预算执行跟踪", "重点事项督办"]
};

function getChallengeCards(area = "", context = "") {
  const examples = AREA_EXAMPLES[area] || ["会议纪要整理", "部门信息看板", "管理事项跟踪"];
  return CHALLENGES.map((challenge, index) => ({
    ...challenge,
    area,
    context: index === 0
      ? `已确认的管理背景：${context || `围绕“${examples[0]}”的脱敏管理想法。`} 本题把这段想法转成需求，再完成一个可运行的小项目。`
      : `已确认的管理背景：${context || `围绕“${examples[1]}”的脱敏资料需求。`} 本题把这些材料沉淀为可持续维护的个人知识库。`,
    steps: [...challenge.steps],
    deliverables: [...challenge.deliverables],
    inputs: [...challenge.inputs],
    completionCriteria: [...challenge.completionCriteria],
    reflectionQuestions: [...challenge.reflectionQuestions]
  }));
}

module.exports = { CHALLENGES, getChallengeCards };
