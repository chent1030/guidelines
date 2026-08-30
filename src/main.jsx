import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUp,
  Check,
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
  ["BP & IT", "业务支持、数字化、系统与流程"],
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
        aria-label={overview ? "AI 体验中心综合介绍视频" : "工具演示视频"}
      />
      {overview && <div className="video-overlay"><Play size={15} fill="currentColor" /> 综合介绍 · 自动播放</div>}
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
          <h1>AI 体验中心</h1>
          <p>对话式工具指引 · 溧阳基地数字工具站</p>
        </div>
      </div>
      <div className="secure-badge"><ShieldCheck size={15} /> 仅使用脱敏练习材料</div>
    </header>
  );
}

function Welcome({ onStart }) {
  return (
    <section className="welcome-grid" aria-label="AI 体验中心介绍">
      <div className="welcome-media">
        <VideoPlayer src="/videos/overview.mp4" overview />
      </div>
      <div className="welcome-copy">
        <div>
          <div className="eyebrow">AI 体验中心 · 任务导览</div>
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

function MessageBubble({ message, onOption }) {
  const html = message.role === "assistant" ? renderMarkdown(message.content) : undefined;
  return (
    <div className={`message ${message.role}`}>
      <div className="avatar">{message.role === "assistant" ? "AI" : "你"}</div>
      <div className={`bubble ${message.streaming ? "is-streaming" : ""}`}>
        {message.streaming && !message.content ? <span className="typing-indicator"><i /><i /><i /></span> : html ? <div className="markdown" dangerouslySetInnerHTML={html} /> : message.content}
        {message.streaming && message.content && <span className="stream-cursor" aria-hidden="true" />}
        {message.question && <div className="question">{message.question}</div>}
        {message.questionOptions?.length > 0 && (
          <div className="question-options">
            {message.questionOptions.map(option => <button key={option} type="button" onClick={() => onOption(option)}>{option}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

function InterestSelector({ onSelect }) {
  return (
    <section className="interest-panel" aria-labelledby="interest-title">
      <div className="interest-heading">
        <div className="starter-label">还不确定从哪里开始？</div>
        <h3 id="interest-title">选择一个关注领域</h3>
        <p>也可以直接在下方描述明确任务，我会为你推荐合适的工具。</p>
      </div>
      <div className="interest-grid">
        {INTEREST_AREAS.map(([title, detail], index) => <button key={title} type="button" onClick={() => onSelect(title)}><span className="interest-index">0{index + 1}</span><span className="interest-copy"><b>{title}</b><small>{detail}</small></span><ArrowRight size={16} /></button>)}
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
    <section className="recommendation">
      <div className="recommendation-top"><div className="recommendation-title">推荐使用：{recommendation.name}</div><span className="tool-tag">{recommendation.tag}</span></div>
      <p>{recommendation.reason}</p>
      <div className="benchmarks"><b>对标参考（不可体验）：</b>{recommendation.benchmarks.length ? recommendation.benchmarks.map(name => <span key={name}>{name}</span>) : <em>暂无对标产品</em>}</div>
      <div className="recommendation-actions">
        <button className="small-button primary" type="button" onClick={() => setShowPractice(true)}>生成练习提示词</button>
        <button className="small-button" type="button" onClick={() => setShowDemo(true)}>观看演示</button>
      </div>
      {showDemo && <VideoPlayer src={TOOLS[recommendation.toolId]?.video} />}
      {showPractice && <Practice recommendation={recommendation} active={active} onComplete={onComplete} />}
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
      <h3>脱敏练习</h3>
      <p>将下方内容复制到 {recommendation.name}，再用虚构或脱敏材料替换方括号中的内容。</p>
      <pre>{prompt}</pre>
      <button className="small-button" type="button" onClick={copyPrompt}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "已复制" : "复制提示词"}</button>
      {copyError && <p className="copy-error" role="alert">{copyError}</p>}
      {recommendation.practiceSteps.length > 0 && <ol>{recommendation.practiceSteps.map(step => <li key={step}>{step}</li>)}</ol>}
      <button className="small-button primary complete-button" type="button" disabled={!active} onClick={onComplete}>我已完成本场景</button>
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
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [input, setInput] = useState("");
  const messagesRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { addWelcomeMessage(); }, []);

  function addWelcomeMessage() {
    setMessages([{ role: "assistant", content: "你好。你可以选择关注领域，我会逐步帮你梳理需求；如果已有明确任务，也可以直接输入，我会推荐合适的工具并生成练习提示词。" }]);
  }

  async function submitMessage(value, { interestSelection = false, selectedArea = "" } = {}) {
    const message = value.trim();
    if (!message || sending) return;
    const initialTurn = messages.length === 1;
    const requestArea = selectedArea || interestArea;
    const streamId = `stream-${Date.now()}`;
    setInput("");
    setSending(true);
    setMessages(previous => [...previous, { role: "user", content: message }, { id: streamId, role: "assistant", content: "", streaming: true }]);
    try {
      const response = await fetch("/api/guide/chat/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ message, sessionId, userName, activeScene, completedScenes, initialTurn, interestArea: requestArea, interestSelection }) });
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
          if (event.type === "status") {
            setStatusMessage(event.message || "正在分析你的任务");
          }
          if (event.type === "chunk" && event.text) {
            setMessages(previous => previous.map(item => item.id === streamId ? { ...item, content: item.content + event.text } : item));
          }
          if (event.type === "done") {
            completed = true;
            setStatusMessage("");
            const data = event.result;
            setMessages(previous => previous.map(item => item.id === streamId ? { ...item, streaming: false, content: data.reply, question: data.question, questionOptions: data.questionOptions, recommendation: data.recommendation } : item));
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
              if (data.recommendation || data.phase === "recommend" || data.phase === "teach") {
                setActiveScene(data.sceneTitle || activeScene);
                setShowInterestSelector(false);
              }
              setActiveRecommendation(data.recommendation || null);
            }
          }
          if (event.type === "error") {
            setStatusMessage("");
            throw new Error(event.message);
          }
        }
        if (done) break;
      }
      if (!completed) throw new Error("流式响应提前结束，请重试。");
    } catch (error) {
      setStatusMessage("");
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
    finally { setStatusMessage(""); setSending(false); inputRef.current?.focus(); }
  }

  function selectInterestArea(area) {
    setInterestArea(area);
    setShowInterestSelector(false);
    submitMessage(area, { interestSelection: true, selectedArea: area });
  }

  function completeScene() {
    if (!activeRecommendation || !activeScene) return;
    setCompletedScenes(previous => previous.some(scene => scene.title === activeScene && scene.toolName === activeRecommendation.name) ? previous : [...previous, { title: activeScene, toolName: activeRecommendation.name }]);
    setMessages(previous => [...previous, { role: "assistant", content: `已记录“${activeScene}”的体验。你可以继续选择关注领域，开始下一个场景。` }]);
    setActiveScene(""); setActiveRecommendation(null); setSessionId(newSessionId());
  }

  return (
    <section className="workspace" aria-label="对话式 AI 指引">
      <section className="conversation">
        {statusMessage && <div className="status active stream-status" role="status" aria-live="polite"><i />{statusMessage}</div>}
        <div className="messages" ref={messagesRef} aria-live="polite">
          <div className="message-stack">{messages.map((message, index) => <React.Fragment key={message.id || `${message.role}-${index}`}><MessageBubble message={message} onOption={submitMessage} />{message.recommendation && <Recommendation data={message} active={activeRecommendation === message.recommendation} onComplete={completeScene} />}</React.Fragment>)}
            {showInterestSelector && <InterestSelector onSelect={selectInterestArea} />}
          </div>
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); submitMessage(input); }}><div className="composer-shell"><textarea ref={inputRef} value={input} maxLength={2000} disabled={sending} onChange={event => setInput(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submitMessage(input); } }} placeholder="补充你想解决的业务问题……" aria-label="补充你想解决的业务问题" /><div className="composer-foot"><span>仅使用虚构或脱敏材料</span><button className="send-button" aria-label="发送消息" title="发送消息" disabled={sending || !input.trim()} type="submit"><ArrowUp size={18} /></button></div></div></form>
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
