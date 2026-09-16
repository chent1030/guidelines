import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Play,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import "./styles.css";

const TOOLS = {
  chatgpt: { video: "/videos/chatgpt.mp4" },
  codex: { video: "/videos/codex.mp4" },
  workbuddy: { video: "/videos/workbuddy.mp4" },
  jimeng: { video: "/videos/jimeng.mp4" }
};

const INTEREST_AREAS = [
  ["质量管理", "质量体系、问题分析、改善闭环"],
  ["人力资源", "招聘培训、绩效管理、组织协作"],
  ["生产运营", "排产计划、现场管理、效率改善"],
  ["设备领域", "设备运维、故障分析、预防性维护"],
  ["采购与供应链", "供应商管理、成本控制、交付协同"],
  ["经营管理", "经营分析、预算计划、管理决策"]
];

function newSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderMarkdown(content) {
  if (window.marked && window.DOMPurify) {
    return { __html: window.DOMPurify.sanitize(window.marked.parse(content || "")) };
  }
  return undefined;
}

function VideoPlayer({ src, overview = false }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`video-frame ${overview ? "overview-video" : ""}`}>
      <video
        src={src}
        controls={!overview}
        autoPlay={overview}
        loop={overview}
        muted={overview}
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        aria-label={overview ? "AI 实验室综合介绍视频" : "工具演示视频"}
      />
      {failed && <p className="video-help">视频暂不可用，请将对应文件放入 `videos/` 目录。</p>}
    </div>
  );
}

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><Sparkles size={18} /></div>
        <div>
          <h1>AI 实验室</h1>
          <p>对话式工具指引 · 溧阳基地数字工具站</p>
        </div>
      </div>
      <div className="secure-badge"><ShieldCheck size={15} /> 仅使用脱敏练习材料</div>
    </header>
  );
}

function Welcome({ onStart }) {
  return (
    <section className="welcome-grid" aria-label="AI 实验室介绍">
      <div className="welcome-media">
        <VideoPlayer src="/videos/overview.mp4" overview />
      </div>
      <div className="welcome-copy">
        <div>
          <div className="eyebrow">AI 实验室 · 任务导览</div>
          <h2>从一个任务开始。</h2>
          <p>AI 实验室帮助你理解工具、匹配真实工作场景，并通过安全的动手实践掌握使用方法。</p>
          <div className="welcome-actions">
            <button className="button" onClick={onStart}>开始指引 <ArrowRight size={17} /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Identity({ onContinue, onBack }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  function submit(event) {
    event.preventDefault();
    const userName = name.trim().replace(/\s+/g, " ");
    const length = Array.from(userName).length;
    if (length < 2 || length > 30) {
      setError("请输入 2 至 30 个字符的姓名。");
      return;
    }
    onContinue(userName);
  }
  return (
    <section className="identity-view" aria-labelledby="identity-title">
      <form className="identity-form" onSubmit={submit}>
        <div className="eyebrow">开始本次体验</div>
        <h2 id="identity-title">请先告诉我你的姓名</h2>
        <label htmlFor="userName">姓名</label>
        <input ref={inputRef} id="userName" name="name" autoComplete="name" maxLength={30} value={name} onChange={event => { setName(event.target.value); setError(""); }} aria-describedby={error ? "name-error" : "name-note"} />
        {error ? <span className="field-error" id="name-error">{error}</span> : <span className="field-note" id="name-note">请输入真实姓名，最多 30 个字符。</span>}
        <div className="identity-actions">
          <button className="button" type="submit">进入指引 <ArrowRight size={17} /></button>
          <button className="text-button" type="button" onClick={onBack}>返回首页</button>
        </div>
      </form>
    </section>
  );
}

function Completed({ userName, onHome }) {
  return (
    <section className="completed-view" aria-labelledby="completed-title">
      <div className="completed-mark"><Check size={28} /></div>
      <div className="eyebrow">体验已结束</div>
      <h2 id="completed-title">感谢参与，{userName}</h2>
      <button className="button" onClick={onHome}>返回首页 <ArrowRight size={17} /></button>
    </section>
  );
}

function TaskReceipt({ message }) {
  return (
    <div className="task-receipt">
      <span><Check size={13} /></span>
      <b>已提交</b>
      <p>{message.content}</p>
    </div>
  );
}

function guideStage(message) {
  if (message.streaming) return "正在生成指引";
  if (message.nextToolSuggestions?.length) return "下一步体验";
  if (message.recommendation) return "工具推荐";
  if (message.question) return "快速确认";
  return "任务指引";
}

function GuideCard({ message, active, interactive, position, showInterestSelector, onOption, onInterestSelect, onComplete, onToolSelect }) {
  const html = renderMarkdown(message.content);
  const hasAgentTrace = message.agentSteps?.length > 0;
  const resolved = Boolean(message.selectedOption);
  return (
    <article className={`guide-card deck-card ${message.streaming ? "is-streaming" : ""} ${resolved ? "is-resolved" : ""}`}>
      <header className="guide-card-head">
        <div className="guide-step">
          <span className="guide-stage-icon"><Sparkles size={18} /></span>
          <div><span>AI 实验室 · {position}</span><b>{guideStage(message)}</b></div>
        </div>
        <div className={`guide-state ${message.streaming ? "running" : "ready"}`}><i />{message.streaming ? "Agent 运行中" : "指引已就绪"}</div>
      </header>
      {hasAgentTrace && <AgentTrace steps={message.agentSteps} running={message.streaming} />}
      <div className="guide-card-body">
        <div className="guide-copy">
          {message.streaming && !message.content ? <span className="typing-indicator"><i /><i /><i /></span> : html ? <div className="markdown" dangerouslySetInnerHTML={html} /> : message.content}
          {message.streaming && message.content && <span className="stream-cursor" aria-hidden="true" />}
        </div>
        {message.question && <div className="guide-question"><span>需要你的选择</span><strong>{message.question}</strong></div>}
        {resolved ? <div className="selection-result"><CheckCircle2 size={16} /><span>已选择</span><b>{message.selectedOption}</b></div> : message.questionOptions?.length > 0 && (
          <div className="guide-actions">
            {message.questionOptions.map((option, index) => <button disabled={!interactive} style={{ "--delay": `${index * 45}ms` }} key={option} type="button" onClick={() => onOption(option, message.id)}><span>{String(index + 1).padStart(2, "0")}</span><b>{option}</b><ArrowRight size={15} /></button>)}
          </div>
        )}
        {showInterestSelector && <InterestSelector onSelect={onInterestSelect} disabled={!interactive} />}
        {message.recommendation && <Recommendation data={message} active={active} onComplete={onComplete} />}
        {message.nextToolSuggestions?.length > 0 && <ToolSuggestions suggestions={message.nextToolSuggestions} onSelect={onToolSelect} disabled={!interactive} />}
      </div>
    </article>
  );
}

function AgentTraceDetail({ detail, streaming }) {
  const detailRef = useRef(null);
  const followOutput = useRef(true);
  useEffect(() => {
    const element = detailRef.current;
    if (element && streaming && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [detail, streaming]);
  return <pre ref={detailRef} aria-busy={streaming} onScroll={event => {
    const element = event.currentTarget;
    followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }}>{detail}</pre>;
}

function AgentTrace({ steps, running }) {
  return (
    <details className="agent-trace" open={running || undefined}>
      <summary>
        <span className="trace-title"><span className={`trace-dot ${running ? "running" : ""}`} />Agent 执行过程</span>
        <span className="trace-summary">{running ? "处理中" : `${steps.length} 项已完成`}<ChevronDown size={15} /></span>
      </summary>
      <div className="trace-list">
        {steps.map(step => (
          <div className="trace-step" key={step.id}>
            <span className={`trace-state ${step.status}`}>{step.status === "completed" ? <CheckCircle2 size={14} /> : <i />}</span>
            <div><b>{step.agent}</b><span>{step.message}</span>{step.detail && <AgentTraceDetail detail={step.detail} streaming={running && step.status === "running"} />}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function InterestSelector({ onSelect, disabled = false }) {
  return (
    <section className="interest-panel" aria-labelledby="interest-title">
      <div className="interest-heading">
        <div className="starter-label">还不确定从哪里开始？</div>
        <h3 id="interest-title">选择一个关注领域</h3>
      </div>
      <div className="interest-grid">
        {INTEREST_AREAS.map(([title, detail], index) => <button disabled={disabled} key={title} type="button" onClick={() => onSelect(title)}><span className="interest-index">0{index + 1}</span><span className="interest-copy"><b>{title}</b><small>{detail}</small></span><ArrowRight size={16} /></button>)}
      </div>
    </section>
  );
}

function Recommendation({ data, active, onComplete }) {
  const [showPractice, setShowPractice] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
  const recommendation = data.recommendation;
  if (!recommendation) return null;
  return (
    <section className={`recommendation tool-${recommendation.toolId}`}>
      <div className="section-code">PRIMARY TOOL</div>
      <div className="recommendation-top"><div className="recommendation-title">推荐使用：{recommendation.name}</div><span className="tool-tag">{recommendation.tag}</span></div>
      <p>{recommendation.reason}</p>
      <div className="benchmarks"><b>对标参考（不可体验）：</b>{recommendation.benchmarks.length ? recommendation.benchmarks.map(name => <span key={name}>{name}</span>) : <em>暂无对标产品</em>}</div>
      <div className="recommendation-actions">
        <button className="small-button primary" type="button" onClick={() => setShowPractice(true)}>生成探索提纲</button>
        <button className="small-button" type="button" onClick={() => setShowDemo(true)}>观看演示</button>
      </div>
      {showDemo && <VideoPlayer src={TOOLS[recommendation.toolId]?.video} />}
      {showPractice && <Practice recommendation={recommendation} active={active} onComplete={onComplete} />}
    </section>
  );
}

function ToolSuggestions({ suggestions, onSelect, disabled = false }) {
  if (!suggestions?.length) return null;
  return (
    <section className="tool-suggestions" aria-label="下一步工具建议">
      <div className="tool-suggestions-heading">
        <span className="starter-label">下一步体验建议</span>
        <h3>还可以试试这些工具</h3>
        <p>选择一个方向，我会继续帮你梳理适合的业务场景。</p>
      </div>
      <div className="tool-suggestions-grid">
        {suggestions.map(suggestion => (
          <div className={`tool-suggestion tool-${suggestion.toolId}`} key={suggestion.toolId}>
            <div className="tool-suggestion-top"><b>{suggestion.title}</b><span>{suggestion.suggestedScenario}</span></div>
            <p>{suggestion.reason}</p>
            <button disabled={disabled} className="small-button" type="button" onClick={() => onSelect(suggestion)}><ArrowRight size={15} /> 体验这个工具</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Practice({ recommendation, active, onComplete }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const prompt = recommendation.practicePrompt || "请根据以下脱敏任务目标，先提出一个关键澄清问题；信息足够后，给出结构化初稿和核对清单。\n任务目标：[请填写脱敏后的任务描述]";
  async function copyPrompt() {
    setCopyError("");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt);
      else throw new Error("Clipboard API unavailable");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const succeeded = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!succeeded) {
        setCopyError("自动复制不可用，请长按提示词手动复制。");
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="practice">
      <h3>管理层探索提纲</h3>
      <p>将下方内容复制到 {recommendation.name}，用虚构或脱敏背景与 AI 讨论机会、判断和可选方向。</p>
      <pre>{prompt}</pre>
      <button className="small-button" type="button" onClick={copyPrompt}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "已复制" : "复制提示词"}</button>
      {copyError && <p className="copy-error" role="alert">{copyError}</p>}
      {recommendation.practiceSteps.length > 0 && <ol>{recommendation.practiceSteps.map(step => <li key={step}>{step}</li>)}</ol>}
      <button className="small-button primary complete-button" type="button" disabled={!active} onClick={onComplete}>我已完成本次探索</button>
    </div>
  );
}

function Journey({ completedScenes, onComplete }) {
  return (
    <aside className="journey">
      <div className="journey-kicker">体验进度</div>
      <h2>本次体验记录</h2>
      <p>完成一个场景后，会保留简要记录；新的体验从关注领域重新开始。</p>
      {!completedScenes.length ? <div className="empty-record">尚未完成场景。完成当前练习后，记录会显示在这里。</div> : completedScenes.map(scene => <div className="scene-record" key={`${scene.title}-${scene.toolName}`}><b>{scene.title}</b><span>已体验 · {scene.toolName}</span></div>)}
      <button className="reset" onClick={onComplete}><Check size={15} /> 完成本次体验</button>
    </aside>
  );
}

function Guide({ userName, onComplete }) {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [interestArea, setInterestArea] = useState("");
  const [showInterestSelector, setShowInterestSelector] = useState(true);
  const [activeScene, setActiveScene] = useState("");
  const [activeRecommendation, setActiveRecommendation] = useState(null);
  const [completedScenes, setCompletedScenes] = useState([]);
  const [messages, setMessages] = useState([]);
  const [viewedCardId, setViewedCardId] = useState(null);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const deckRef = useRef(null);
  const assistantMessages = messages.filter(message => message.role === "assistant");
  const latestIndex = assistantMessages.length - 1;
  const selectedIndex = assistantMessages.findIndex(message => message.id === viewedCardId);
  const cardIndex = selectedIndex < 0 ? latestIndex : selectedIndex;
  const activeMessage = assistantMessages[cardIndex];
  const isLatest = cardIndex === latestIndex;
  const interactive = isLatest && !sending;

  function viewCard(index) {
    if (index < 0 || index > latestIndex) return;
    setViewedCardId(index === latestIndex ? null : assistantMessages[index].id);
    deckRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.target.closest?.("input, textarea, select, video, [contenteditable]:not([contenteditable='false']), [role='slider']")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = cardIndex + (event.key === "ArrowLeft" ? -1 : 1);
      if (index >= 0 && index <= latestIndex) {
        setViewedCardId(index === latestIndex ? null : assistantMessages[index].id);
        deckRef.current?.focus({ preventScroll: true });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cardIndex, messages.length]);

  useEffect(() => {
    const container = messagesRef.current;
    const card = container?.querySelector(".guide-card:last-of-type");
    if (!container || !card) return;
    container.scrollTo({ top: Math.max(0, card.offsetTop - 24), behavior: messages.length > 1 ? "smooth" : "auto" });
  }, [activeMessage?.id]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { addWelcomeMessage(); }, []);

  function addWelcomeMessage() {
    setMessages([{ id: "guide-welcome", role: "assistant", interestSelection: true, content: "选择一个关注领域开始指引。已有明确任务时，也可以通过下方输入框直接提交。" }]);
  }

  async function submitMessage(value, { interestSelection = false, selectedArea = "", completionRequest = false, preferredToolId = "" } = {}) {
    const message = value.trim();
    if (!message || sending || !isLatest) return;
    const initialTurn = messages.length === 1;
    const requestArea = selectedArea || interestArea;
    const streamId = `stream-${Date.now()}`;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "44px";
    setSending(true);
    setViewedCardId(null);
    setMessages(previous => [...previous, { id: `task-${Date.now()}`, role: "user", content: message }, { id: streamId, role: "assistant", content: "", streaming: true, agentSteps: [] }]);
    try {
      const response = await fetch("/api/guide/chat/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ message, sessionId, userName, activeScene, currentToolId: activeRecommendation?.toolId || "", completedScenes, initialTurn, interestArea: requestArea, interestSelection, preferredToolId }) });
      if (!response.ok) {
        const body = await response.text();
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch { /* The gateway may return an empty or non-JSON error body. */ }
        throw new Error(data?.error?.message || (response.status >= 500 ? "导览服务暂时不可用，请确认服务已启动后重试。" : "请求未能完成，请稍后重试。"));
      }
      if (!response.body) throw new Error("浏览器不支持流式响应。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      while (true) {
        const { value: chunk, done } = await reader.read();
        buffer += decoder.decode(chunk || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split("\n").find(item => item.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "agent_trace" && event.step) {
            setMessages(previous => previous.map(item => {
              if (item.id !== streamId) return item;
              const existing = item.agentSteps || [];
              const index = existing.findIndex(step => step.id === event.step.id);
              const agentSteps = index >= 0
                ? existing.map((step, stepIndex) => stepIndex === index ? { ...step, ...event.step } : step)
                : [...existing, event.step];
              return { ...item, agentSteps };
            }));
          }
          if (event.type === "chunk" && event.text) {
            setMessages(previous => previous.map(item => item.id === streamId ? { ...item, content: item.content + event.text } : item));
          }
          if (event.type === "done") {
            completed = true;
            const data = event.result;
            setMessages(previous => previous.map(item => item.id === streamId ? { ...item, streaming: false, content: data.reply, question: data.question, questionOptions: data.questionOptions, recommendation: data.recommendation, nextToolSuggestions: data.nextToolSuggestions, phase: data.phase, interestSelection: Boolean(data.interestSelection || data.sceneSelection) } : item));
            if (completionRequest && activeRecommendation && activeScene) {
              setCompletedScenes(previous => previous.some(scene => scene.title === activeScene && scene.toolName === activeRecommendation.name)
                ? previous
                : [...previous, { title: activeScene, toolName: activeRecommendation.name, toolId: activeRecommendation.toolId }]);
              setSessionId(newSessionId());
            }
            if (data.inferredInterestArea && !data.interestSelection) {
              setInterestArea(data.inferredInterestArea);
            }
            if (data.interestSelection) {
              setInterestArea("");
              setShowInterestSelector(true);
              setActiveScene("");
              setActiveRecommendation(null);
            } else if (interestSelection) {
              setInterestArea(requestArea);
              setShowInterestSelector(false);
              setActiveScene("");
              setActiveRecommendation(null);
            } else if (data.sceneSelection) {
              setInterestArea("");
              setShowInterestSelector(true);
              setActiveScene("");
              setActiveRecommendation(null);
            } else {
              if (data.scenarioStarted && !data.recommendation) {
                setActiveScene(data.sceneTitle || "当前体验场景");
                setShowInterestSelector(false);
              }
              if (data.recommendation || data.phase === "recommend" || data.phase === "teach") {
                setActiveScene(data.sceneTitle || activeScene);
                setShowInterestSelector(false);
              }
              setActiveRecommendation(data.recommendation || null);
            }
          }
          if (event.type === "error") {
            throw new Error(event.message);
          }
        }
        if (done) break;
      }
      if (!completed) throw new Error("流式响应提前结束，请重试。");
    } catch (error) {
      setMessages(previous => previous.map(item => {
        if (item.id !== streamId) return item;
        const partialContent = item.content.trim();
        return {
          ...item,
          streaming: false,
          content: partialContent
            ? `${item.content}\n\n本轮连接提前结束，请重新发送刚才的回答。`
            : `暂时无法连接导览 Agent。\n${error.message}`
        };
      }));
    }
    finally { setSending(false); }
  }

  function selectInterestArea(area) {
    if (!interactive) return;
    setMessages(previous => previous.map(item => item.id === activeMessage?.id ? { ...item, selectedOption: area } : item));
    setInterestArea(area);
    setShowInterestSelector(false);
    submitMessage(area, { interestSelection: true, selectedArea: area });
  }

  function selectOption(option, cardId) {
    if (!interactive || cardId !== activeMessage?.id) return;
    setMessages(previous => previous.map(item => item.id === cardId ? { ...item, selectedOption: option } : item));
    submitMessage(option);
  }

  function completeScene() {
    if (!interactive || !activeRecommendation || !activeScene) return;
    submitMessage("我已完成本场景", { completionRequest: true });
  }

  function selectSuggestedTool(suggestion) {
    if (!interactive) return;
    const scenario = suggestion.suggestedScenario || `用${suggestion.title}处理一个新的工作场景`;
    submitMessage(`我想用${suggestion.title}体验：${scenario}`, { preferredToolId: suggestion.toolId });
  }

  const deckDepth = Math.min(Math.max(assistantMessages.length - 1, 0), 3);

  return (
    <section className="workspace" aria-label="AI 实验室指引">
      <section className="conversation">
        <div className="messages" ref={messagesRef} aria-live="polite">
          <div ref={deckRef} tabIndex={0} role="region" aria-label="指引卡组，使用左右方向键切换" className={`message-stack deck-stage deck-browsable deck-depth-${deckDepth}`}>
            {[-1, 1].map(direction => {
              const neighbor = assistantMessages[cardIndex + direction];
              if (!neighbor) return null;
              return <div key={direction} className={`deck-neighbor ${direction < 0 ? "deck-previous" : "deck-next"}`} role="button" tabIndex={0}
                aria-label={direction < 0 ? "查看上一张指引卡片" : "查看下一张指引卡片"}
                onClick={() => viewCard(cardIndex + direction)}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); viewCard(cardIndex + direction); }
                }}><span>{guideStage(neighbor)}</span></div>;
            })}
            {activeMessage && <GuideCard
              key={activeMessage.id}
              message={activeMessage}
              active={interactive && activeRecommendation === activeMessage.recommendation}
              interactive={interactive}
              position={`${cardIndex + 1} / ${assistantMessages.length}${isLatest ? "" : " · 历史指引"}`}
              showInterestSelector={activeMessage.interestSelection ?? (isLatest && showInterestSelector)}
              onOption={selectOption}
              onInterestSelect={selectInterestArea}
              onComplete={completeScene}
              onToolSelect={selectSuggestedTool}
            />}
            {assistantMessages.length > 1 && <p className="deck-hint">← → 切换指引 · 点击两侧卡片查看</p>}
          </div>
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); submitMessage(input); }}>
          <div className="composer-shell">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              maxLength={2000}
              disabled={!interactive}
              onChange={event => {
                setInput(event.target.value);
                event.currentTarget.style.height = "44px";
                event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 96)}px`;
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitMessage(input);
                }
              }}
              placeholder={isLatest ? "没有合适选项？补充你的情况" : "正在查看历史指引，切回最新卡片后继续"}
              aria-label="补充你的情况"
            />
            <button className="send-button" aria-label="发送消息" title="发送消息" disabled={!interactive || !input.trim()} type="submit"><ArrowUp size={17} /></button>
          </div>
        </form>
      </section>
      <Journey completedScenes={completedScenes} onComplete={onComplete} />
    </section>
  );
}

function App() {
  const [view, setView] = useState("welcome");
  const [userName, setUserName] = useState("");
  function start() { setView("identity"); }
  function enterGuide(name) { setUserName(name); setView("guide"); }
  function home() { setUserName(""); setView("welcome"); }
  return <><Header /><main className="page">{view === "welcome" && <Welcome onStart={start} />}{view === "identity" && <Identity onContinue={enterGuide} onBack={home} />}{view === "guide" && <Guide userName={userName} onComplete={() => setView("completed")} />}{view === "completed" && <Completed userName={userName} onHome={home} />}</main></>;
}

createRoot(document.getElementById("root")).render(<App />);
