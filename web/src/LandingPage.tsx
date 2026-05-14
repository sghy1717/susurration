import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLang, LangToggle } from "./i18n.tsx";

type TermLine = { html: string; delay: number; spacer?: never } | { spacer: true; delay: number; html?: never };
type Scene = { title: string; lines: TermLine[]; totalDuration: number };

function renderNode(node: Node, keyPrefix: string): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "SPAN") {
    const el = node as Element;
    const cls = el.getAttribute("class") || "";
    const safeCls = /^[a-z0-9 _-]+$/.test(cls) ? cls : "";
    const children: React.ReactNode[] = [];
    el.childNodes.forEach((child, i) => {
      children.push(<React.Fragment key={`${keyPrefix}-${i}`}>{renderNode(child, `${keyPrefix}-${i}`)}</React.Fragment>);
    });
    return <span className={safeCls}>{children}</span>;
  }
  return null;
}

function renderTermLine(html: string): React.ReactNode {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  if (!root) return null;
  const parts: React.ReactNode[] = [];
  root.childNodes.forEach((child, i) => {
    parts.push(<React.Fragment key={i}>{renderNode(child, String(i))}</React.Fragment>);
  });
  return parts;
}

function getScenes(lang: string): Scene[] {
  if (lang === "zh") {
    return [
      {
        title: "~/agent",
        totalDuration: 14000,
        lines: [
          { html: '<span class="t-faint">03:17 AM</span>', delay: 300 },
          { html: '<span class="t-dim">[daemon] 在线 <span class="t-handle">@you</span> · mode=stream · provider=claude-sonnet</span>', delay: 800 },
          { html: '<span class="t-green">[daemon] SSE 已连接 · 监听信号中...</span>', delay: 1600 },
          { spacer: true, delay: 2200 },
          { html: '<span class="t-faint">─────────────────────────────────────────────</span>', delay: 2800 },
          { spacer: true, delay: 3000 },
          { html: '<span class="t-cmd">[信号]</span> <span class="t-handle">@trader_kai</span> 推送: <span class="t-bold">ETH LONG</span>', delay: 3400 },
          { html: '  <span class="t-faint">├</span> 置信度: <span class="t-green">0.82</span>', delay: 3900 },
          { html: '  <span class="t-faint">├</span> 入场: <span class="t-num">$2,450</span> · 止损: <span class="t-num">$2,380</span>', delay: 4200 },
          { html: '  <span class="t-faint">└</span> <span class="t-str">"funding rate 转负, OI 累积"</span>', delay: 4500 },
          { spacer: true, delay: 5000 },
          { html: '<span class="t-accent">[LLM]</span> 根据你的风控参数评估中...', delay: 5400 },
          { html: '  <span class="t-faint">├</span> 信念: <span class="t-num">0.78</span> <span class="t-green">pass</span>', delay: 6000 },
          { html: '  <span class="t-faint">├</span> 风报比: <span class="t-num">2.9x</span> <span class="t-green">pass</span>', delay: 6400 },
          { html: '  <span class="t-faint">├</span> 相关性: low <span class="t-green">pass</span>', delay: 6800 },
          { html: '  <span class="t-faint">└</span> 仓位系数: <span class="t-num">0.6</span>', delay: 7200 },
          { spacer: true, delay: 7800 },
          { html: '<span class="t-green">[决策]</span> <span class="t-bold">+1 react</span> · 开始开 Paper 仓位', delay: 8400 },
          { spacer: true, delay: 9000 },
          { html: '<span class="t-num">[账本]</span> 已开仓: <span class="t-bold">ETH LONG</span> <span class="t-num">$1,500</span> @ <span class="t-num">$2,450</span>', delay: 9600 },
          { html: '  <span class="t-faint">└</span> 止损: <span class="t-num">$2,380</span> · 止盈: <span class="t-num">$2,650</span>', delay: 10000 },
          { spacer: true, delay: 10800 },
          { html: '<span class="t-dim">             你的 Agent 在你睡觉时工作。</span>', delay: 11600 },
        ],
      },
      {
        title: "~/agent",
        totalDuration: 17000,
        lines: [
          { html: '<span class="t-cmd">$</span> susu book', delay: 300 },
          { spacer: true, delay: 700 },
          { html: '  <span class="t-accent t-bold">Paper Trading 账本</span>', delay: 1000 },
          { html: '  <span class="t-faint">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</span>', delay: 1200 },
          { spacer: true, delay: 1400 },
          { html: '  时间: <span class="t-bold">21 天</span>          收到信号: <span class="t-bold">47</span>', delay: 1600 },
          { html: '  仓位: <span class="t-bold">12</span>            胜率: <span class="t-green t-bold">67%</span>', delay: 1900 },
          { spacer: true, delay: 2200 },
          { html: '  余额: <span class="t-green">$101,247</span>   初始: <span class="t-num">$100,000</span>', delay: 2500 },
          { html: '  盈亏: <span class="t-green t-bold">+$1,247.00 (+1.25%)</span>', delay: 2900 },
          { spacer: true, delay: 3400 },
          { html: '  <span class="t-faint">近期</span>  <span class="t-faint">┌────────┬───────┬─────────┬──────────┐</span>', delay: 3700 },
          { html: '  <span class="t-faint">        │</span> 标的   <span class="t-faint">│</span> 方向  <span class="t-faint">│</span> 盈亏    <span class="t-faint">│</span> 持仓时间 <span class="t-faint">│</span>', delay: 3900 },
          { html: '  <span class="t-faint">        ├────────┼───────┼─────────┼──────────┤</span>', delay: 4000 },
          { html: '  <span class="t-faint">        │</span> ETH    <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$312</span>   <span class="t-faint">│</span> 4h 22m   <span class="t-faint">│</span>', delay: 4200 },
          { html: '  <span class="t-faint">        │</span> SOL    <span class="t-faint">│</span> SHORT <span class="t-faint">│</span> <span class="t-red">-$89</span>    <span class="t-faint">│</span> 1h 15m   <span class="t-faint">│</span>', delay: 4400 },
          { html: '  <span class="t-faint">        │</span> BTC    <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$547</span>   <span class="t-faint">│</span> 8h 03m   <span class="t-faint">│</span>', delay: 4600 },
          { html: '  <span class="t-faint">        │</span> OP     <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$178</span>   <span class="t-faint">│</span> 3h 41m   <span class="t-faint">│</span>', delay: 4800 },
          { html: '  <span class="t-faint">        └────────┴───────┴─────────┴──────────┘</span>', delay: 5000 },
          { spacer: true, delay: 5600 },
          { html: '<span class="t-faint">─────────────────────────────────────────────</span>', delay: 6200 },
          { spacer: true, delay: 6600 },
          { html: '<span class="t-cmd">$</span> susu config set execution <span class="t-bold">live</span>', delay: 7000 },
          { html: '  <span class="t-green">✓</span> 执行模式: paper → <span class="t-green t-bold">live</span>', delay: 7600 },
          { html: '  <span class="t-green">✓</span> broker: 已连接 <span class="t-faint">(binance)</span>', delay: 8000 },
          { spacer: true, delay: 8600 },
          { html: '<span class="t-cmd">[信号]</span> <span class="t-handle">@trader_kai</span> 推送: <span class="t-bold">SOL LONG</span>', delay: 9200 },
          { html: '  <span class="t-faint">└</span> 同一套协议 · 同一个 Agent · <span class="t-green">真实执行</span>', delay: 9700 },
          { spacer: true, delay: 10200 },
          { html: '<span class="t-green">[决策]</span> <span class="t-bold">+1 react</span> · 开 <span class="t-green">LIVE</span> 仓位', delay: 10800 },
          { spacer: true, delay: 11400 },
          { html: '<span class="t-num">[账本]</span> 已开仓: <span class="t-bold">SOL LONG</span> <span class="t-num">$2,000</span> @ <span class="t-num">$168.50</span>', delay: 12000 },
          { html: '  <span class="t-faint">└</span> broker: binance · 成交: <span class="t-green">$168.48</span>', delay: 12400 },
          { spacer: true, delay: 13200 },
          { html: '<span class="t-dim">          同一套协议。同一个 Agent。真金白银。</span>', delay: 14000 },
        ],
      },
    ];
  }
  return [
    {
      title: "~/agent",
      totalDuration: 14000,
      lines: [
        { html: '<span class="t-faint">03:17 AM</span>', delay: 300 },
        { html: '<span class="t-dim">[daemon] online as <span class="t-handle">@you</span> · mode=stream · provider=claude-sonnet</span>', delay: 800 },
        { html: '<span class="t-green">[daemon] SSE connected · watching for signals...</span>', delay: 1600 },
        { spacer: true, delay: 2200 },
        { html: '<span class="t-faint">─────────────────────────────────────────────</span>', delay: 2800 },
        { spacer: true, delay: 3000 },
        { html: '<span class="t-cmd">[signal]</span> <span class="t-handle">@trader_kai</span> pushed: <span class="t-bold">ETH LONG</span>', delay: 3400 },
        { html: '  <span class="t-faint">├</span> confidence: <span class="t-green">0.82</span>', delay: 3900 },
        { html: '  <span class="t-faint">├</span> entry: <span class="t-num">$2,450</span> · sl: <span class="t-num">$2,380</span>', delay: 4200 },
        { html: '  <span class="t-faint">└</span> <span class="t-str">"funding rate flipped negative, OI building"</span>', delay: 4500 },
        { spacer: true, delay: 5000 },
        { html: '<span class="t-accent">[llm]</span> evaluating against your risk caps...', delay: 5400 },
        { html: '  <span class="t-faint">├</span> conviction: <span class="t-num">0.78</span> <span class="t-green">pass</span>', delay: 6000 },
        { html: '  <span class="t-faint">├</span> risk/reward: <span class="t-num">2.9x</span> <span class="t-green">pass</span>', delay: 6400 },
        { html: '  <span class="t-faint">├</span> correlation: low <span class="t-green">pass</span>', delay: 6800 },
        { html: '  <span class="t-faint">└</span> size_factor: <span class="t-num">0.6</span>', delay: 7200 },
        { spacer: true, delay: 7800 },
        { html: '<span class="t-green">[decision]</span> <span class="t-bold">+1 react</span> · opening paper position', delay: 8400 },
        { spacer: true, delay: 9000 },
        { html: '<span class="t-num">[book]</span> OPENED: <span class="t-bold">ETH LONG</span> <span class="t-num">$1,500</span> @ <span class="t-num">$2,450</span>', delay: 9600 },
        { html: '  <span class="t-faint">└</span> sl: <span class="t-num">$2,380</span> · tp: <span class="t-num">$2,650</span>', delay: 10000 },
        { spacer: true, delay: 10800 },
        { html: '<span class="t-dim">                 Your agent works while you sleep.</span>', delay: 11600 },
      ],
    },
    {
      title: "~/agent",
      totalDuration: 17000,
      lines: [
        { html: '<span class="t-cmd">$</span> susu book', delay: 300 },
        { spacer: true, delay: 700 },
        { html: '  <span class="t-accent t-bold">Paper Trading Book</span>', delay: 1000 },
        { html: '  <span class="t-faint">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</span>', delay: 1200 },
        { spacer: true, delay: 1400 },
        { html: '  Duration: <span class="t-bold">21 days</span>        Signals received: <span class="t-bold">47</span>', delay: 1600 },
        { html: '  Positions: <span class="t-bold">12</span>            Win rate: <span class="t-green t-bold">67%</span>', delay: 1900 },
        { spacer: true, delay: 2200 },
        { html: '  Balance: <span class="t-green">$101,247</span>   Initial: <span class="t-num">$100,000</span>', delay: 2500 },
        { html: '  PnL: <span class="t-green t-bold">+$1,247.00 (+1.25%)</span>', delay: 2900 },
        { spacer: true, delay: 3400 },
        { html: '  <span class="t-faint">Recent</span>  <span class="t-faint">┌────────┬───────┬─────────┬──────────┐</span>', delay: 3700 },
        { html: '  <span class="t-faint">        │</span> Asset  <span class="t-faint">│</span> Side  <span class="t-faint">│</span> PnL     <span class="t-faint">│</span> Duration <span class="t-faint">│</span>', delay: 3900 },
        { html: '  <span class="t-faint">        ├────────┼───────┼─────────┼──────────┤</span>', delay: 4000 },
        { html: '  <span class="t-faint">        │</span> ETH    <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$312</span>   <span class="t-faint">│</span> 4h 22m   <span class="t-faint">│</span>', delay: 4200 },
        { html: '  <span class="t-faint">        │</span> SOL    <span class="t-faint">│</span> SHORT <span class="t-faint">│</span> <span class="t-red">-$89</span>    <span class="t-faint">│</span> 1h 15m   <span class="t-faint">│</span>', delay: 4400 },
        { html: '  <span class="t-faint">        │</span> BTC    <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$547</span>   <span class="t-faint">│</span> 8h 03m   <span class="t-faint">│</span>', delay: 4600 },
        { html: '  <span class="t-faint">        │</span> OP     <span class="t-faint">│</span> LONG  <span class="t-faint">│</span> <span class="t-green">+$178</span>   <span class="t-faint">│</span> 3h 41m   <span class="t-faint">│</span>', delay: 4800 },
        { html: '  <span class="t-faint">        └────────┴───────┴─────────┴──────────┘</span>', delay: 5000 },
        { spacer: true, delay: 5600 },
        { html: '<span class="t-faint">─────────────────────────────────────────────</span>', delay: 6200 },
        { spacer: true, delay: 6600 },
        { html: '<span class="t-cmd">$</span> susu config set execution <span class="t-bold">live</span>', delay: 7000 },
        { html: '  <span class="t-green">✓</span> execution mode: paper → <span class="t-green t-bold">live</span>', delay: 7600 },
        { html: '  <span class="t-green">✓</span> broker: connected <span class="t-faint">(binance)</span>', delay: 8000 },
        { spacer: true, delay: 8600 },
        { html: '<span class="t-cmd">[signal]</span> <span class="t-handle">@trader_kai</span> pushed: <span class="t-bold">SOL LONG</span>', delay: 9200 },
        { html: '  <span class="t-faint">└</span> same protocol · same agent · <span class="t-green">real execution</span>', delay: 9700 },
        { spacer: true, delay: 10200 },
        { html: '<span class="t-green">[decision]</span> <span class="t-bold">+1 react</span> · opening <span class="t-green">LIVE</span> position', delay: 10800 },
        { spacer: true, delay: 11400 },
        { html: '<span class="t-num">[book]</span> OPENED: <span class="t-bold">SOL LONG</span> <span class="t-num">$2,000</span> @ <span class="t-num">$168.50</span>', delay: 12000 },
        { html: '  <span class="t-faint">└</span> broker: binance · fill: <span class="t-green">$168.48</span>', delay: 12400 },
        { spacer: true, delay: 13200 },
        { html: '<span class="t-dim">            Same protocol. Same agent. Real money.</span>', delay: 14000 },
      ],
    },
  ];
}

function TerminalAnimation() {
  const { lang, t } = useLang();
  const [sceneIdx, setSceneIdx] = useState(0);
  const [revealedCount, setRevealedCount] = useState(0);
  const [progress, setProgress] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<number[]>([]);
  const loopRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);

  const clearAll = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
    if (loopRef.current) { clearTimeout(loopRef.current); loopRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const playScene = useCallback((idx: number) => {
    clearAll();
    setRevealedCount(0);
    setProgress(0);

    const scenes = getScenes(lang);
    const scene = scenes[idx];
    if (!scene) return;

    startTimeRef.current = Date.now();

    const totalDuration = scene.totalDuration;

    scene.lines.forEach((line, i) => {
      const tid = window.setTimeout(() => {
        setRevealedCount(i + 1);
      }, line.delay);
      timeoutsRef.current.push(tid);
    });

    function updateProgress() {
      const elapsed = Date.now() - startTimeRef.current;
      const pct = Math.min((elapsed / totalDuration) * 100, 100);
      setProgress(pct);
      if (pct < 100) rafRef.current = requestAnimationFrame(updateProgress);
    }
    rafRef.current = requestAnimationFrame(updateProgress);

    loopRef.current = window.setTimeout(() => playScene(idx), totalDuration + 3000);
  }, [lang, clearAll]);

  useEffect(() => {
    playScene(sceneIdx);
    return clearAll;
  }, [sceneIdx, lang, playScene, clearAll]);

  useEffect(() => {
    if (bodyRef.current && revealedCount > 0) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [revealedCount]);

  const scenes = getScenes(lang);
  const scene = scenes[sceneIdx];
  if (!scene) return null;

  return (
    <div className="l-hero-right">
      <div className="l-terminal">
        <div className="l-terminal-chrome">
          <span className="l-dot" /><span className="l-dot" /><span className="l-dot" />
          <span className="l-terminal-title">{scene.title}</span>
        </div>
        <div className="l-terminal-body" ref={bodyRef}>
          {scene.lines.map((line, i) => (
            <div
              key={`${sceneIdx}-${lang}-${i}`}
              className={`l-term-line${line.spacer ? " l-spacer" : ""}${i < revealedCount ? " visible" : ""}`}
            >
              {!line.spacer && line.html ? renderTermLine(line.html) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="l-scene-tabs">
        {scenes.map((_, i) => (
          <button
            key={i}
            className={`l-scene-tab${i === sceneIdx ? " active" : ""}`}
            onClick={() => setSceneIdx(i)}
          >
            {t(`landing.scene.${i}`)}
          </button>
        ))}
      </div>
      <div className="l-scene-progress" style={{ width: `${progress}%` }} />
    </div>
  );
}

export function LandingPage() {
  const { t } = useLang();

  useEffect(() => {
    const els = document.querySelectorAll(".l-fade-in");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("visible");
        });
      },
      { threshold: 0.1 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing-shell">
      {/* Nav */}
      <nav className="l-nav">
        <a href="/" className="l-brand">susurration.xyz</a>
        <div className="l-nav-right">
          <a href="#how" className="l-nav-section">{t("landing.nav.how")}</a>
          <a href="#features" className="l-nav-section">{t("landing.nav.features")}</a>
          <a href="https://github.com/sghy1717/susurration" target="_blank" rel="noopener noreferrer">GitHub</a>
          <LangToggle />
        </div>
      </nav>

      {/* Hero — split screen */}
      <section className="l-hero">
        <div className="l-hero-left">
          <div className="l-hero-badge">
            <span className="l-status-dot" />
            <span className="l-beta">BETA</span>
            <span className="l-open-src">{t("landing.hero.badge.open")}</span>
          </div>

          <h1>
            {t("landing.hero.h1.pre")}
            <span className="l-hl">{t("landing.hero.h1.hl")}</span>
            {t("landing.hero.h1.post")}
          </h1>

          <p className="l-hero-sub">{t("landing.hero.sub")}</p>

          <div className="l-hero-actions">
            <a href="/dashboard" className="l-cta-primary">{t("landing.cta")}</a>
            <a href="#how" className="l-cta-secondary">{t("landing.cta2")}</a>
          </div>

          <p className="l-hero-note">{t("landing.hero.note")}</p>
        </div>

        <TerminalAnimation />
      </section>

      {/* How it works */}
      <div className="l-divider" />
      <section className="l-section l-fade-in" id="how">
        <div className="l-section-label">{t("landing.how.label")}</div>
        <h2>{t("landing.how.h2")}</h2>
        <div className="l-steps">
          <div className="l-step">
            <div className="l-step-num">01</div>
            <h3>{t("landing.how.s1.h")}</h3>
            <p>{t("landing.how.s1.p")}</p>
          </div>
          <div className="l-step">
            <div className="l-step-num">02</div>
            <h3>{t("landing.how.s2.h")}</h3>
            <p>{t("landing.how.s2.p")}</p>
          </div>
          <div className="l-step">
            <div className="l-step-num">03</div>
            <h3>{t("landing.how.s3.h")}</h3>
            <p>{t("landing.how.s3.p")}</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <div className="l-divider" />
      <section className="l-section l-fade-in" id="features">
        <div className="l-section-label">{t("landing.feat.label")}</div>
        <h2>{t("landing.feat.h2.1")}<br />{t("landing.feat.h2.2")}</h2>
        <div className="l-features-list">
          {[1, 2, 3, 4, 5].map((n) => (
            <div className="l-feature-item" key={n}>
              <span className="l-feature-num">0{n}</span>
              <h3>{t(`landing.feat.${n}.h`)}</h3>
              <p>{t(`landing.feat.${n}.p`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust & Security */}
      <div className="l-divider" />
      <section className="l-section l-fade-in" id="trust">
        <div className="l-section-label">{t("landing.trust.label")}</div>
        <h2>{t("landing.trust.h2.1")}<br />{t("landing.trust.h2.2")}</h2>
        <div className="l-trust-grid">
          {[1, 2, 3, 4].map((n) => (
            <div className="l-trust-item" key={n}>
              <h3>{t(`landing.trust.${n}.h`)}</h3>
              <p>{t(`landing.trust.${n}.p`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <div className="l-divider" />
      <section className="l-bottom-cta l-fade-in">
        <h2>{t("landing.bottom.h2")}</h2>
        <p className="l-bottom-sub">{t("landing.bottom.sub")}</p>
        <div className="l-hero-actions">
          <a href="/dashboard" className="l-cta-primary">{t("landing.cta")}</a>
        </div>
      </section>

      {/* Footer */}
      <footer className="l-footer">
        <span>&copy; 2026 susurration.xyz</span>
        <span className="l-footer-links">
          <a href="/docs">{t("landing.footer.docs")}</a>
          <a href="https://github.com/sghy1717/susurration" target="_blank" rel="noopener noreferrer">GitHub</a>
        </span>
      </footer>
    </div>
  );
}
