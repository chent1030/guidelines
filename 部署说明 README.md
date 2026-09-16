# AI 实验室 · 智能工具指引

面向部门经理的 Qwen 对话式 AI 工具推荐、演示与实践引导页面。模型调用通过 DeepAgents JavaScript SDK 完成。

## 目录结构
```
guidelines/
├── index.html                                  # React/Vite 前端入口
├── src/main.jsx                                # React 页面与交互
├── src/styles.css                              # 前端样式
├── AI体验中心指引页面 index.html（更新版）.html  # 对话式体验页面
├── server.js                                  # Express 会话网关与调用审计
├── agent-runtime.js                           # DeepAgents JS Agent
├── package.json                               # Node.js 依赖与启动脚本
├── .env.example                               # Agent Runtime 与 PostgreSQL 配置模板
├── node_modules/                              # npm install 后生成
└── videos/         # 放置首页介绍和工具演示视频的目录
    ├── overview.mp4
    ├── chatgpt.mp4
    ├── codex.mp4
    ├── workbuddy.mp4
    └── jimeng.mp4
```

## 使用方法
1. 安装 Node.js 18 或更高版本和 PostgreSQL；
2. 在本目录执行 `npm install`；
3. 将 `.env.example` 复制为 `.env`，填写 `DATABASE_URL` 和 `QWEN_API_KEY`；
5. 把首页综合介绍视频命名为 `overview.mp4`，再把 4 个工具演示视频放入 `videos/` 目录；
6. 执行 `npm start`，Vite 会先构建 React 前端，再启动服务，在浏览器打开 `http://localhost:3000`。

开发前端时可执行 `npm run dev` 预览 React 页面；生产启动仍使用 `npm start`。

每次有效对话调用都会写入 PostgreSQL 的 `agent_call_logs` 表，包含会话 ID、状态、耗时、请求上下文和响应结果。DeepAgents 使用同一个 PostgreSQL 实例的 LangGraph `PostgresSaver` 保存每个 `sessionId` 的多轮消息状态；服务端最多允许 12 个并发模型调用，超出时返回 429。

## 技术说明
- 服务端：Node.js、Express、dotenv。
- Agent：通过 DeepAgents JS 的 `createDeepAgent` 编排，使用 LangChain `ChatOpenAI` 适配 Qwen，默认模型为 `qwen-plus`。如果使用 Qwen3（例如 `qwen3.8-max`），请保持 `QWEN_ENABLE_THINKING=false`；Qwen3 的 thinking 模式不支持导引 Agent 结构化输出所需的强制工具调用。
- 测试：使用 Playwright 进行页面交互与响应式检查。
- 安全：`.env`、视频素材和依赖目录均已加入 `.gitignore`。

## 流程设计
- **自由对话入口**：点击“开始指引”后直接进入空白输入框，用户可用自然语言描述任务。
- **Qwen Agent**：DeepAgents 负责调用 Qwen 和编排逻辑。建议 Agent 结合会话历史按“结论、依据、探索方向”组织建议，并评估推荐就绪度；每轮最多追问一个关键问题，不限制引导轮次。明确成果或已收敛的管理目标才进入唯一工具推荐，未就绪时工具调用和 API 响应都会拦截提前推荐。建议与导引内容继续使用 SSE 流式输出。
- **限定体验范围**：Agent 仅推荐和教学 ChatGPT、Codex、WorkBuddy、即梦AI。豆包、公司内 catlgpt、公司内 opencode、公司内大头虾只作为不可点击的静态对标参考。
- **带练模式**：推荐后提供脱敏练习提示词、步骤和对应演示视频；用户标记完成后可继续描述下一个场景。
- **连续体验**：浏览器内存保留当前会话的完成记录；每个完成场景后生成新的 `sessionId`，新的任务使用独立的 Agent thread，避免场景上下文串线。

## 字号说明
页面已针对管理层（年长人群）调大全局字号：正文 15~16px、标题 26~31px、按钮 18px，正文行距加大。如需再放大，打开 `index.html`，在顶部 `<style>` 中找到各 `font-size` 统一上调即可。

## 信息安全提醒（内置文案，可按公司制度修改）
严禁上传涉密/商业秘密/核心工艺/客户及员工敏感信息；真实数据必须脱敏后使用；AI 输入输出视为对外数据，数据不能外发；AI 结果需人工复核。
