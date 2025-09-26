/* ===========================================================================
   Quantix Pro Trading AI
   Full JavaScript — Updated with:
   - Strike Pro min confidence cooled to 82%
   - Stable Market Trend (Up/Down/Consolidating) with hysteresis to prevent flip-flop
   - Market Trend shown in Strategy Metrics panel
   - Trend-based, low-friction filters added to Bolt (only) and optional guards for Z/Flip X
   - Auto Strike Pro: takes BOTH Over 1 and Under 9 (no safety skips)
   - Removed Equity/Profit trend usage and chart safe-guarded (HTML may still have it)
   =========================================================================== */
/* eslint-disable no-console */
(() => {
  "use strict";

  // Option A: pull APP_ID and ENV from the page, fallback to public demo id if missing
  const APP_ID =
    (typeof window !== "undefined" && Number(window.DERIV_APP_ID)) ||
    1089; // fallback (public demo)
  const ENV =
    (typeof window !== "undefined" && (window.DERIV_ENV || "demo")) || "demo";
  const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

  /* ===========================================================================
     0) CONFIGURATION AND CONSTANTS
     =========================================================================== */

  const CONFIG = {
    // Use the Option A dynamic WebSocket URL
    DERIV_WS_URL: WS_URL,

    // Money & thresholds
    MIN_STAKE: 0.35,
    CONFIDENCE_THRESHOLD: 85,
    MAX_LOSS_STREAK: 3,

    // Observational buffers (ticks, prices)
    DIGIT_HISTORY_LIMIT: 220,
    PRICE_HISTORY_LIMIT: 900,
    PROFIT_SERIES_LIMIT: 720,

    // Smoothing and intelligence
    MD_WINDOW: 5,

    // Digit spacing between Z trades (0 = same tick allowed)
    FAST_ENTRY_DIGITS: true,
    DIGITS_MIN_TICKS_BETWEEN_TRADES: 0,

    // Proposals caching
    PROPOSAL_CACHE_MS: 3500,

    // Flip X (Even/Odd) auto spacing
    FLIPX_AUTO_MIN_INTERVAL_MS: 3000,
    EO_AUTO_MIN_CONFIDENCE: 85,

    // Strike Pro thresholds and cooldown
    STRIKEPRO_AUTO_MIN_INTERVAL_MS: 3000,
    STRIKEPRO_MIN_CONFIDENCE: 82,   // lowered from 85 per request
    STRIKEPRO_GOOD_CONF: 85,
    STRIKEPRO_EXCELLENT_CONF: 90,
    // Fast buy from cached proposals to minimize latency
    STRIKEPRO_FAST_BUY_FROM_CACHE: true,

    // Tick movement window
    TREND_WINDOW_TICKS: 20,

    // Chart style
    CHART_PAD_PX: 6,

    // Logger
    LOG_KEEP_MAX: 500,

    // Profit chart stroke color
    CHART_COLOR: "#00ffff",

    // Load historic 20 ticks upon connecting to symbol
    INITIAL_HISTORY_TICKS: 20,

    // Reconnect
    RECONNECT_MAX_DELAY_MS: 30000
  };

  const FAST = {
    WS_PING_MS: 20000,
    POC_WATCHDOG_MS: 5000,

    // Sell retries for Bolt contract (because bid may fail transiently)
    SELL_RETRY_MS: 250,
    SELL_RETRY_MAX: 3
  };

  // If a POC stream is quiet for longer than this, re-subscribe (ms)
  const POC_HEARTBEAT_MAX = 10000;

  // Supported instruments by strategy
  const SUPPORTED = {
    ACCU: new Set(["CRASH1000", "CRASH500", "CRASH300", "BOOM1000", "BOOM500", "BOOM300"]),
    DIGITS: new Set(["R_100", "R_75", "R_50", "R_25", "R_10"])
  };

  // EMA settings
  const MA = { fast: 8, slow: 21 };

  // Burst plan live window (ms) for same-tick Z trade buys
  const BURST_EXPIRE_MS = 900;

  /* ===========================================================================
     1) DOM ELEMENTS
     =========================================================================== */

  const $ = (id) => document.getElementById(id);

  // Connection
  const tokenInput = $("token");
  const connectBtn = $("connectBtn");
  const accountTypeEl = $("accountType");
  const balanceEl = $("balance");

  // Trading and toggles
  const panelTrading = $("panelTrading");
  const symbolSelect = $("symbolSelect");
  const stakeInput = $("stake");
  const autoTradeCheckbox = $("autoTrade");
  const tradeTypeSelect = $("tradeTypeSelect");
  const activeStrategyLabel = $("activeStrategyLabel");

  // Z Trade actions
  const diffBuy1Btn = $("diffBuy1Btn");
  const diffBuy3Btn = $("diffBuy3Btn");
  const diffBuy3SeqBtn = $("diffBuy3SeqBtn");
  const diffActions = $("diffActions");

  // Bolt actions/panels
  const buyAccuBtn = $("buyAccuBtn");
  const accuActions = $("accuActions");
  const panelAccuSettings = $("panelAccuSettings");
  const panelAccuMarket = $("panelAccuMarket");
  const panelTickMovement = $("panelTickMovement");
  const tickMovementEl = $("tickMovement");

  // Flip X actions/panel
  const evenOddActions = $("evenOddActions");
  const evenOddPlaceTradeBtn = $("evenOddPlaceTradeBtn");
  const evenOddPlaceEvenBtn = $("evenOddPlaceEvenBtn");
  const evenOddPlaceOddBtn = $("evenOddPlaceOddBtn");
  const panelEvenOdd = $("panelEvenOdd");
  const flipxDelayGroup = $("flipxDelayGroup");
  const flipxDelayTicksInput = $("flipxDelayTicks");

  // Strike Pro actions
  const strikeActions = $("strikeActions");
  const strikePlaceTradeBtn = $("strikePlaceTradeBtn");
  const strikePlaceOverBtn = $("strikePlaceOverBtn");
  const strikePlaceUnderBtn = $("strikePlaceUnderBtn");

  // Strategy toggles
  const toggleAccumulator = $("toggleAccumulator");
  const toggleDiffersVsLast = $("toggleDiffersVsLast");
  const toggleEvenOdd = $("toggleEvenOdd");
  const toggleStrikePro = $("toggleStrikePro");

  // Advanced
  const confThresholdInput = $("confThreshold");
  const maxLossStreakInput = $("maxLossStreak");

  // Session / signal / best-strat
  const etTimeEl = $("etTime");
  const sessionNameEl = $("sessionName");
  const sessionNoteEl = $("sessionNote");
  const bestStrategyEl = $("bestStrategy");
  const tradeRecommendationEl = $("tradeRecommendation");
  const sessionReasonEl = $("sessionReason");
  const tradeSignalEl = $("tradeSignal");
  const confidenceFillEl = $("confidenceFill");
  const confidencePct = $("confidencePct");

  // Strategy Metrics (panelFibo)
  const fiboSubtitleEl = $("fiboSubtitle");
  const fiboPriceEl = $("fiboPrice");
  const fiboDigitEl = $("fiboDigit");
  const fiboPrevDigitEl = $("fiboPrevDigit");
  const fiboDeltaEl = $("fiboDelta");
  const fiboGaugeCard = $("fiboGaugeCard");
  const fiboGaugeTitleEl = $("fiboGaugeTitle");
  const fiboGaugeFill = $("fiboGaugeFill");
  const fiboGaugePct = $("fiboGaugePct");
  const fiboExpectedEl = $("fiboExpected");
  const fiboDirExpectedEl = $("fiboDirExpected");
  const fiboConfEl = $("fiboConf");
  const fiboStrengthEl = $("fiboStrength");
  const fiboReasonEl = $("fiboReason");
  const fiboParityStreakCard = $("fiboParityStreakCard");
  const fiboParityStreakEl = $("fiboParityStreak");
  const marketTrendEl = $("marketTrend");

  // Flip X panel internals
  const eoEvenFill = $("eoEvenFill");
  const eoOddFill = $("eoOddFill");
  const eoEvenPct = $("eoEvenPct");
  const eoOddPct = $("eoOddPct");
  const eoEvenCount = $("eoEvenCount");
  const eoOddCount = $("eoOddCount");
  const eoNextEl = $("eoNext");
  const eoConfEl = $("eoConf");
  const eoStrengthEl = $("eoStrength");
  const eoReasonEl = $("eoReason");
  const eoDigitsGrid = $("eoDigitsGrid");

  // Digits insights (Z Trade)
  const panelDigitsInsights = $("panelDigitsInsights");
  const recentOutcomesList = $("recentOutcomesList");
  const driftStatusEl = $("driftStatus");
  const driftConsecEl = $("driftConsec");
  const driftPatternEl = $("driftPattern");
  const driftStrengthTextEl = $("driftStrengthText");
  const driftBarFillEl = $("driftBarFill");
  const driftWarnEl = $("driftWarn");

  // Bolt state UI
  const accuStatusEl = $("accuStatus");
  const accuRunningPLEl = $("accuRunningPL");
  const accuGrowthInput = $("accuGrowth");
  const accuGrowthLiveEl = $("accuGrowthLive");
  const accuTakeProfitInput = $("accuTakeProfit");
  const accuStopLossInput = $("accuStopLoss");
  const accuAutoCloseCheckbox = $("accuAutoClose");
  const accuTickLimitInput = $("accuTickLimit");
  const accuTicksElapsedEl = $("accuTicksElapsed");
  const accuConsistencyEl = $("accuConsistency");
  const accuVolLevelEl = $("accuVolLevel");

  // Safe entry
  const safeAction = $("safeAction");
  const safeAnalysis = $("safeAnalysis");

  // Stats & logs
  const resultsEl = $("results");
  const netProfitEl = $("netProfit");
  const totalTradesEl = $("totalTrades");
  const winsEl = $("wins");
  const lossesEl = $("losses");
  const winRateEl = $("winRate");
  const clearHistoryBtn = $("clearHistoryBtn");
  const profitCanvas = $("profitCanvas"); // may be null/removed
  const profitCtx = profitCanvas ? profitCanvas.getContext("2d") : null;

  // Auto Trade count input
  let autoTradeCountInput = $("autoTradeCount");

  /* ===========================================================================
     2) STATE
     =========================================================================== */

  // Websocket and authorization
  let ws = null;
  let authorized = false;
  // Read-only public feed (no authorize) for live market metrics before user connects
  let wsPublic = null;
  let wsPublicOpen = false;
  let manualDisconnectRequested = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let lastUsedToken = null;

  // Current trading symbol and account currency
  let activeSymbol = symbolSelect ? symbolSelect.value : "R_100";
  let accountCurrency = "USD";

  // Rolling buffers
  const digitHistory = [];
  const priceHistory = [];
  const recentAbsDeltas = [];
  // Analysis window and ticks analyzed UI removed
  // const analysisTicksInput = $("analysisTicks");
  // const analysisTicksCountEl = $("analysisTicksCount");
  const outcomesHistory = [];
  const nextTradeCountdownEl = $("nextTradeCountdown");

  // Global auto-trade cooldown (ms)
  const GLOBAL_AUTO_COOLDOWN_MS = 6000;
  // PnL and stats
  let lastGlobalTradeTs = 0; // for global auto cooldown
  let countdownTimer = null;
  let countdownTargetTs = 0;
  let netProfit = 0;
  let totalTrades = 0;
  let wins = 0;

  function startCountdown(ms) {
    if (!nextTradeCountdownEl) return;
    countdownTargetTs = Date.now() + ms;
    if (countdownTimer) clearInterval(countdownTimer);
    const tick = () => {
      const remain = Math.max(0, countdownTargetTs - Date.now());
      const s = Math.ceil(remain / 1000);
      nextTradeCountdownEl.textContent = `Next trade in: ${s > 0 ? s + 's' : 'ready'}`;
      if (remain <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }
  // Stats, series, and runtime state
  let losses = 0;
  // Loss streak for stop condition; default 0
  let lossStreak = 0;
  const profitSeries = [0];

  // Auto trade planning counters
  let autoTradesPlanned = 1;
  let autoTradesDone = 0;

  // Strategy switches
  let useAccumulator = false;
  let useDiffersVsLast = false;
  let useEvenOdd = false;
  let useStrikePro = false;
  let autoTrade = false;

  // Bolt runtime
  let openAccuId = null;
  let openAccuBuyPrice = 0;
  let manualAccuHold = false;
  let manualAccuHoldPending = false;
  let accuTicksElapsed = 0;
  let accuLastSpotTime = null;

  // Flip X runtime
  let lastEvenOddEval = null;
  let lastFlipXAutoTs = 0;
  let flipxDelaySetting = 1;
  let flipxPendingDelay = null;

  // Strike Pro cooldown
  let lastStrikeTs = 0;

  // Trend/EMA state
  let emaFastPrice = null, emaSlowPrice = null, prevEmaFast = null, prevEmaSlow = null;
  let emaVol = 90, emaMomentum = 0, emaConsistency = 90;
  let trendAgeTicks = 0, prevTrendState = null;
  let stableTrend = "RANGING", trendCandidate = "RANGING", trendCandidateAge = 0;

  // Trading flow
  let ticksSinceLastTrade = 9999;
  let placingTrade = false;
  let pendingBuy = null; // {type, barrier, qty}
  let lastBuyContext = null; // {type,barrier,qty,retried}
  let lastTickEpoch = 0;

  // Proposals caches and in-flight guards
  const proposalCache = new Map(); // DIGITDIFF: barrier => {id, ts, stake, ask}
  const proposalInFlight = new Map();
  const eoProposalCache = new Map();
  const eoProposalInFlight = new Map();
  const strikeProposalCache = new Map();
  const strikeProposalInFlight = new Map();
  let lastRequestedType = null;
  // Global throttle/backoff for proposal requests to avoid RateLimit
  const lastProposalAt = new Map(); // key => ts
  const proposalBackoff = new Map(); // key => ms backoff

  function proposalKey(ct, barrier = "") {
    return `${ct}:${activeSymbol}:${barrier}`;
  }

  function canRequestProposalNow(ct, barrier = "") {
    const key = proposalKey(ct, barrier);
    const now = Date.now();
    const last = lastProposalAt.get(key) || 0;
    // Base min spacing per unique proposal key
    const baseCooldown = 800; // ms baseline between identical proposals
    const backoff = proposalBackoff.get(key) || 0;
    return (now - last) >= Math.max(baseCooldown, backoff);
  }

  function markProposalSent(ct, barrier = "") {
    const key = proposalKey(ct, barrier);
    lastProposalAt.set(key, Date.now());
  }

  function applyRateLimitBackoff(ct, barrier = "") {
    const key = proposalKey(ct, barrier);
    const cur = proposalBackoff.get(key) || 1000;
    // Exponential backoff with cap
    const next = Math.min(cur * 2, 8000);
    proposalBackoff.set(key, next);
    // reset after a grace period
    setTimeout(() => { if (proposalBackoff.get(key) === next) proposalBackoff.delete(key); }, next * 3);
  }

  // Intervals / heartbeats
  let wsPingInterval = null;
  let pocWatchdogInterval = null;
  let lastPOCHeartbeat = 0;
  // Tick stream heartbeat and public feed maintenance
  let lastTickTs = 0;
  let publicPingInterval = null;
  let tickWatchdogInterval = null;
  let publicReconnectAttempts = 0;

  // Misc internal
  let chartQueued = false;

  /* ===========================================================================
     3) UTILS
     =========================================================================== */

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const fmt2 = (n) => (Number(n) || 0).toFixed(2);
  const fmt5 = (n) => (Number(n) || 0).toFixed(5);
  const fmt2c = (v) => `${accountCurrency} ${fmt2(v)}`;
  const nowLocal = () => new Date().toLocaleTimeString();
  const logistic = (x, mid = 50, scale = 12) => 1 / (1 + Math.exp(-(x - mid) / scale));
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  function lastDigitFromString(str) {
    const digits = (str || "").replace(/\D/g, "");
    if (!digits) return null;
    return Number(digits[digits.length - 1]);
  }
  function log(msg, cls = "") {
    if (!resultsEl) {
      console.log("[Quantix]", msg);
      return;
    }
    const d = document.createElement("div");
    d.className = `log ${cls}`.trim();
    d.textContent = `[${nowLocal()}] ${msg}`;
    resultsEl.prepend(d);
    while (resultsEl.children.length > CONFIG.LOG_KEEP_MAX) resultsEl.removeChild(resultsEl.lastChild);
  }
  function scheduleProfitDraw() {
    if (chartQueued) return;
    chartQueued = true;
    requestAnimationFrame(() => {
      chartQueued = false;
      drawProfitChart();
    });
  }
  function updateEtClock() {
    if (etTimeEl) {
      etTimeEl.textContent = new Date().toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour12: false
      }) + " ET";
    }
  }

  /* ===========================================================================
     3.1) STABLE MARKET TREND (HYSTERESIS)
     =========================================================================== */

  function updateStableMarketTrend() {
    if (emaFastPrice == null || emaSlowPrice == null) return;

    // Use a dynamic threshold band derived from recent absolute deltas
    const medAbs = median(recentAbsDeltas) || 0;
    const band = medAbs * 1.8; // wider band reduces flip-flop

    const diff = (emaFastPrice - emaSlowPrice);
    let candidate;
    if (Math.abs(diff) <= band) candidate = "RANGING";
    else candidate = diff > 0 ? "UP" : "DOWN";

    if (candidate === trendCandidate) {
      trendCandidateAge++;
    } else {
      trendCandidate = candidate;
      trendCandidateAge = 1;
    }

    // Confirmation ticks before switching: RANGING needs longer to avoid jitter
    const confirmTicks = candidate === "RANGING" ? 16 : 12;
    if (candidate !== stableTrend && trendCandidateAge >= confirmTicks) {
      stableTrend = candidate;
    }
  }

  function getStableTrendDisplay() {
    switch (stableTrend) {
      case "UP": return { text: "Uptrend", cls: "trend-up" };
      case "DOWN": return { text: "Downtrend", cls: "trend-down" };
      default: return { text: "Consolidating", cls: "trend-range" };
    }
  }

  /* ===========================================================================
     4) SAFE ENTRY PANEL HELPERS
     =========================================================================== */

  function classifySignal(conf, goodTrade, threshold, sourceType, synergy = false) {
    if (sourceType === "STRIKEPRO") {
      if (goodTrade || conf >= CONFIG.STRIKEPRO_EXCELLENT_CONF) {
        return { key: "excellent", label: "EXCELLENT ENTRY OPPORTUNITY" };
      }
      if ((synergy && conf >= CONFIG.STRIKEPRO_MIN_CONFIDENCE) || conf >= CONFIG.STRIKEPRO_GOOD_CONF) {
        return { key: "good", label: "GOOD ENTRY OPPORTUNITY" };
      }
      if (conf >= Math.max(75, threshold * 0.85)) {
        return { key: "wait", label: "POTENTIAL SETUP - MONITOR" };
      }
      return { key: "avoid", label: "UNFAVORABLE ENTRY CONDITIONS" };
    }
    if (goodTrade || conf >= Math.max(threshold, 95)) return { key: "excellent", label: "EXCELLENT ENTRY OPPORTUNITY" };
    if (conf >= threshold + 5) return { key: "good", label: "GOOD ENTRY OPPORTUNITY" };
    if (conf >= threshold * 0.85) return { key: "wait", label: "POTENTIAL SETUP - MONITOR" };
    return { key: "avoid", label: "UNFAVORABLE ENTRY CONDITIONS" };
  }
  function updateSafeEntryScale(conf) {
    const ind = $("seScaleIndicator");
    const val = $("seScaleIndicatorValue");
    if (!ind || !val) return;
    const pct = clamp(conf, 0, 100);
    ind.style.left = pct + "%";
    val.textContent = pct + "%";
  }
  function updateSuggestedActionStrength(evalObj) {
    const threshold = CONFIG.CONFIDENCE_THRESHOLD;
    const card = $("safeEntryCard"),
      statusTextEl = $("seStatusText"),
      actionEl = $("safeAction"),
      analysisEl = $("safeAnalysis"),
      riskTextEl = $("seRiskText"),
      bottomText = $("seBottomText"),
      bottomIcon = $("seBottomIcon");

    if (!card) return;

    if (!evalObj || (evalObj.confidence === 0 && !evalObj.tradeType)) {
      card.className = "safe-entry-card state-wait";
      statusTextEl.textContent = "COLLECTING DATA…";
      actionEl.textContent = "Waiting for sufficient signal quality";
      analysisEl.textContent = evalObj?.reason || "Insufficient historical context.";
      riskTextEl.textContent = "—";
      bottomText.textContent = "Awaiting confirmation signals…";
      bottomIcon.textContent = "⌛";
      updateSafeEntryScale(0);
      return;
    }

    const conf = clamp(Math.round(evalObj.confidence || 0), 0, 100);
    const sig = classifySignal(conf, !!evalObj.goodTrade, threshold, evalObj.tradeType, !!evalObj.synergy);
    card.className = `safe-entry-card state-${sig.key}`;
    statusTextEl.textContent = sig.label;

    let action;
    switch (sig.key) {
      case "excellent":
        action = "Enter trade immediately — optimal conditions detected";
        break;
      case "good":
        action = "Entry favorable — conditions supportive";
        break;
      case "wait":
        action = "Monitor — conditions forming, not confirmed";
        break;
      default:
        action = "Stand aside — conditions not favorable";
    }

    actionEl.textContent = action;
    analysisEl.textContent = evalObj.reason || "Computing composite signal factors…";
    riskTextEl.textContent = (sig.key === "excellent" || sig.key === "good") ? "LOW RISK" : (sig.key === "wait" ? "MODERATE RISK" : "HIGH RISK");

    if (sig.key === "excellent") {
      bottomIcon.textContent = "🌟";
      bottomText.textContent = `Optimal entry — High-quality ${evalObj.tradeType || "Bolt"} setup.`;
    } else if (sig.key === "good") {
      bottomIcon.textContent = "✅";
      bottomText.textContent = "Favorable setup — confirm & proceed.";
    } else if (sig.key === "wait") {
      bottomIcon.textContent = "🕒";
      bottomText.textContent = "Setup forming — wait for stronger confirmation.";
    } else {
      bottomIcon.textContent = "⚠️";
      bottomText.textContent = "Adverse conditions — avoid new entries.";
    }

    updateSafeEntryScale(conf);
  }

  /* ===========================================================================
     5) SESSION AND BEST STRATEGY
     =========================================================================== */

  function getSessionInfo(symbol) {
    const d = new Date();
    const hour = Number(d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
    const dayName = d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = map[dayName] ?? 0;

    const synthetic = /^((CRASH|BOOM)(300|500|1000))$/.test(symbol) || SUPPORTED.DIGITS.has(symbol);

    const sessions = [];
    if (hour >= 18 || hour < 2) sessions.push("Sydney");
    if (hour >= 19 || hour < 4) sessions.push("Tokyo");
    if (hour >= 3 && hour < 12) sessions.push("London");
    if (hour >= 8 && hour < 17) sessions.push("New York");
    if (!sessions.length) sessions.push("Off-peak");

    const note = synthetic ? "Synthetic indices trade 24/7." : "Session mapping for exchange markets.";

    return { synthetic, sessions, note, hour };
  }

  function deriveBestStrategy(accuEval, diffEval, eoEval, strikeEval) {
    const candidates = [];

    if (SUPPORTED.ACCU.has(activeSymbol) && accuEval) {
      let quality = accuEval.confidence;
      if (accuEval.goodTrade) quality += 5;
      if (accuEval.volLevelPct < 50 || accuEval.volLevelPct > 96) quality -= 4;
      candidates.push({
        name: "Bolt",
        quality,
        confidence: accuEval.confidence,
        good: accuEval.goodTrade,
        detail: `Trend ${accuEval.consistencyPct?.toFixed?.(1) || "—"}% Vol ${accuEval.volLevelPct?.toFixed?.(0) || "—"}%`
      });
    }

    if (SUPPORTED.DIGITS.has(activeSymbol) && diffEval && diffEval.confidence > 0) {
      const differsProb = 100 - (diffEval.stickyPct || 0);
      let quality = diffEval.confidence;
      if (differsProb >= 60) quality += 2;
      candidates.push({
        name: "Z Trade",
        quality,
        confidence: diffEval.confidence,
        good: (differsProb >= 60 && diffEval.confidence >= 90),
        detail: `Differs≈${differsProb.toFixed(1)}%`
      });
    }

    if (SUPPORTED.DIGITS.has(activeSymbol) && eoEval && eoEval.confidence > 0) {
      let quality = eoEval.confidence;
      if (eoEval.evidenceStrength < 4) quality -= 8; else if (eoEval.evidenceStrength >= 8) quality += 3;
      if (eoEval.lastRun >= 3) quality -= 2;
      candidates.push({
        name: "Flip X",
        quality,
        confidence: eoEval.confidence,
        good: eoEval.goodTrade,
        detail: `Parity ${eoEval.parity} Streak ${eoEval.lastRun}`
      });
    }

    if (SUPPORTED.DIGITS.has(activeSymbol) && strikeEval && strikeEval.confidence > 0) {
      let quality = strikeEval.confidence;
      if (strikeEval.goodTrade) quality += 4;
      candidates.push({
        name: "Strike Pro",
        quality,
        confidence: strikeEval.confidence,
        good: strikeEval.goodTrade,
        detail: `${strikeEval.outcome} ~${strikeEval.ouProbPct?.toFixed?.(1) || "—"}% • Dir=${strikeEval.direction} ~${strikeEval.dirConfPct?.toFixed?.(1) || "—"}%`
      });
    }

    if (!candidates.length) return {
      best: "—",
      reason: "Awaiting sufficient data",
      recommendation: "Waiting",
      recClass: "rec-neutral"
    };

    candidates.sort((a, b) => b.quality - a.quality);
    const top = candidates[0];

    let recommendation = "Avoid", recClass = "rec-avoid";
    if (top.confidence >= 95 || top.good) {
      recommendation = "Excellent";
      recClass = "rec-excellent";
    } else if (top.confidence >= CONFIG.CONFIDENCE_THRESHOLD) {
      recommendation = "Proceed with Caution";
      recClass = "rec-caution";
    } else if (top.confidence >= CONFIG.CONFIDENCE_THRESHOLD * 0.8) {
      recommendation = "Waiting";
      recClass = "rec-neutral";
    }

    // Off-peak softener (kept conservative)
    if (getSessionInfo(activeSymbol).sessions.includes("Off-peak") && recClass === "rec-caution") {
      recommendation = "Waiting";
      recClass = "rec-neutral";
    }

    return {
      best: top.name,
      reason: `${top.name}: ${top.detail} | Conf=${top.confidence}%`,
      recommendation,
      recClass
    };
  }

  function updateSessionPanelFromEvals(diffEval, accuEval, eoEval, strikeEval) {
    const info = getSessionInfo(activeSymbol);
    if (sessionNameEl) sessionNameEl.textContent = info.sessions.join(" / ");
    if (sessionNoteEl) sessionNoteEl.textContent = info.note;

    const best = deriveBestStrategy(accuEval, diffEval, eoEval, strikeEval);
    if (bestStrategyEl) bestStrategyEl.textContent = best.best || "—";
    if (tradeRecommendationEl) {
      tradeRecommendationEl.textContent = best.recommendation || "—";
      tradeRecommendationEl.className = `stat-value badge ${best.recClass || "rec-neutral"}`;
    }
    if (sessionReasonEl) sessionReasonEl.textContent = best.reason || "Collecting data…";
  }

  /* ===========================================================================
     6) CONFIDENCE BAR
     =========================================================================== */

  function setConfidenceBar(val, source = "Active") {
    const v = clamp(Math.round(val || 0), 0, 100);
    if (confidenceFillEl) {
      confidenceFillEl.style.width = `${v}%`;
      confidenceFillEl.style.background = v >= CONFIG.CONFIDENCE_THRESHOLD ? "var(--good)" : "var(--bad)";
    }
    if (confidencePct) confidencePct.textContent = `${v}%`;

    const base = "signal-badge";
    if (tradeSignalEl) {
      if (v >= CONFIG.CONFIDENCE_THRESHOLD) {
        tradeSignalEl.textContent = `Trade Signal (${source}): HIGH`;
        tradeSignalEl.className = `${base} signal-trade`;
      } else {
        tradeSignalEl.textContent = `Avoid Trading (${source})`;
        tradeSignalEl.className = `${base} signal-avoid`;
      }
    }
  }

  /* ===========================================================================
     7) STRATEGY EVALUATIONS
     =========================================================================== */

  function evaluateDiffersVsLast() {
    // Use full available history; analysis window input removed
    const need = digitHistory.length;
    const have = digitHistory.length;
    if (digitHistory.length < 2) return { confidence: 0, tradeType: null, barrier: null, reason: "Waiting for digits", stickyPct: 0 };

    const lastDigit = digitHistory[digitHistory.length - 1];
    const transitions = [];
    for (let i = 1; i < digitHistory.length; i++) transitions.push(digitHistory[i] === digitHistory[i - 1] ? "M" : "D");

    if (!transitions.length) return {
      confidence: 0, tradeType: null, barrier: String(lastDigit),
      reason: "Insufficient transitions", stickyPct: 0
    };

  const windows = [6, 8, 12, 16, 24, 32, 48, 64].filter(w => w <= need);
    const alpha0 = 5, beta0 = 5;
    let blendedP = 0, weightSum = 0;

    windows.forEach((w) => {
      const slice = transitions.slice(-w);
      if (slice.length < 4) return;
      const diff = slice.filter(x => x === "D").length;
      const mean = (alpha0 + diff) / (alpha0 + beta0 + slice.length);
      const recW = Math.max(0.6, Math.min(1.4, 1.2 - (w / 128)));
      const wt = Math.sqrt(slice.length) * recW;
      blendedP += mean * wt; weightSum += wt;
    });

    if (!weightSum) {
      const diffAll = transitions.filter(x => x === "D").length;
      blendedP = diffAll / transitions.length;
    } else blendedP /= weightSum;

    let runLen = 1;
    for (let i = transitions.length - 2; i >= 0; i--) {
      if (transitions[i] === transitions[i + 1]) runLen++; else break;
    }
    const lastOutcome = transitions[transitions.length - 1];

    if (lastOutcome === "M") blendedP = Math.min(1, blendedP + Math.min((runLen - 1) * 0.025, 0.15));
    else blendedP = Math.max(0, blendedP - Math.min((runLen - 1) * 0.02, 0.10));

    const stickyPct = Math.round((transitions.filter(x => x === "M").length / transitions.length) * 100);
    const differsProb = 100 - stickyPct;

    const p = clamp(blendedP, 0.0001, 0.9999);
    const entropy = - (p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
    const entropyFactor = 1 - Math.min(0.28, entropy * 0.28);
  let confidence = clamp(Math.round(logistic(blendedP * 100, 58, 9) * 100 * entropyFactor), 0, 98);

    const drift = computeDriftMetrics();
    if (drift.pattern === "CLUSTERING" && drift.strength >= 60 && lastOutcome === "M") {
      confidence = Math.max(0, confidence - 8);
    }

  const goodTrade = (confidence >= 90) && (differsProb >= 60) && !(drift.pattern === "CLUSTERING" && drift.strength >= 75);

    return {
      confidence,
      tradeType: "DIGITDIFF",
      barrier: String(lastDigit),
      reason: `Differs≈${differsProb.toFixed(1)}% | Run=${runLen}${lastOutcome} | Entropy=${entropy.toFixed(2)} | Drift=${drift.pattern}/${drift.strength}%`,
      stickyPct,
      differsProb,
      runLen,
      goodTrade
    };
  }

  function evaluateAccumulator() {
    const minTicks = 25;
    if (priceHistory.length < minTicks)
      return {
        confidence: 0,
        reason: `Collecting data (${priceHistory.length}/${minTicks})`,
        consistencyPct: emaConsistency, volLevelPct: emaVol, goodTrade: false
      };

    const deltas = [];
    for (let i = 1; i < priceHistory.length; i++) deltas.push(priceHistory[i] - priceHistory[i - 1]);

    const absD = deltas.map(Math.abs);
    const medAbs = median(absD) || 0.0001;

    function dirCons(w) {
      if (deltas.length < w) return null;
      const s = deltas.slice(-w);
      let up = 0, dn = 0;
      s.forEach(x => { if (x > 0) up++; else if (x < 0) dn++; });
      return Math.max(up, dn) / s.length;
    }

    const parts = [dirCons(12), dirCons(30), dirCons(60)].filter(Boolean);
    const multi = parts.length ? parts.map((c, i) => c * (1 + i * 0.25)).reduce((a, b) => a + b, 0) / parts.length : 0.5;
    const normalizedConsistency = multi * 100;

    const spikesThr = medAbs * 3;
    const spikeCount = absD.slice(-50).filter(a => a >= spikesThr).length;
    const spikeRatio = spikeCount / Math.min(50, absD.length || 1);
    const stdAbs = Math.sqrt(absD.reduce((a, b) => a + (b - medAbs) * (b - medAbs), 0) / (absD.length || 1));

    let volRaw = 100 - 50 * clamp(stdAbs / (medAbs * 3), 0, 1) - 50 * clamp(spikeRatio / 0.25, 0, 1);
    emaVol = clamp(EMA(emaVol, volRaw, 0.12), 0, 100);

    if (emaFastPrice == null || emaSlowPrice == null || prevEmaFast == null || prevEmaSlow == null)
      return { confidence: 0, reason: "Initializing EMA trend components", consistencyPct: emaConsistency, volLevelPct: emaVol, goodTrade: false };

    const slopeFast = emaFastPrice - prevEmaFast;
    const slopeSlow = emaSlowPrice - prevEmaSlow;
    const coherence = (Math.sign(slopeFast) === Math.sign(slopeSlow)) ? 1 : 0;

    const momentumAvg = deltas.slice(-30).reduce((a, b) => a + b, 0) / (Math.min(30, deltas.length) || 1);
    emaMomentum = EMA(emaMomentum, momentumAvg, 0.2);
    const boundedMomentum = clamp(Math.abs(emaMomentum) / (medAbs || 1e-6) / 4, 0, 1);

    emaConsistency = EMA(emaConsistency, normalizedConsistency, 0.15);

    const trendAge = clamp(trendAgeTicks, 0, 200);

    let composite = 0;
    composite += 0.30 * (emaConsistency / 100);
    composite += 0.20 * (emaVol / 100);
    composite += 0.18 * coherence;
    composite += 0.16 * (boundedMomentum > 0.15 ? 1 : 0.6);
    composite += 0.10 * boundedMomentum;
    composite += 0.06 * clamp(trendAge / 20, 0, 1);

    if (spikeRatio > 0.30) composite -= 0.08;
    if (emaVol < 40) composite -= 0.08;
    composite = clamp(composite, 0, 1);

    let confidenceRaw = logistic(composite * 100, 58, 10) * 100;
    let confidence = clamp(Math.round(confidenceRaw), 0, 98);

    // Market trend integration: avoid consolidations with low vol; reward clear trend regimes
    if (stableTrend === "RANGING" && emaVol < 55) confidence = Math.max(0, confidence - 5);
    if (stableTrend === "UP" || stableTrend === "DOWN") confidence = Math.min(98, confidence + 2);

    const goodTrade = (emaConsistency > 92) && (emaVol > 65) && coherence === 1 && confidence >= 90 && trendAge >= 6 && stableTrend !== "RANGING";

    return {
      confidence: goodTrade ? Math.max(confidence, 99) : confidence,
      reason: `Trend=${emaConsistency.toFixed(1)}% Vol=${emaVol.toFixed(0)}% Coherent=${coherence} Mom=${boundedMomentum.toFixed(2)} Age=${trendAge} Conf=${confidence}%`,
      consistencyPct: emaConsistency,
      volLevelPct: emaVol,
      goodTrade
    };
  }

  function evaluateEvenOdd() {
    // Analysis window removed; use full history
    const need = digitHistory.length;
    const have = digitHistory.length;
    if (!SUPPORTED.DIGITS.has(activeSymbol) || digitHistory.length < 5)
      return {
        confidence: 0, tradeType: null, parity: null, reason: "Waiting for parity context",
        evenPct: 0, oddPct: 0, evenCount: 0, oddCount: 0, digitCounts: Array(10).fill(0), goodTrade: false, lastRun: 0, lastParity: "EVEN", evidenceStrength: 0
      };

    const W = Math.min(need, digitHistory.length);
    const slice = digitHistory.slice(-W);
    const paritySeq = slice.map(d => d % 2 === 0 ? "E" : "O");

    const evenCount = paritySeq.filter(p => p === "E").length;
    const oddCount = paritySeq.length - evenCount;
    const evenPct = (evenCount / paritySeq.length) * 100;
    const oddPct = 100 - evenPct;

    const digitCounts = Array(10).fill(0);
    slice.forEach(d => digitCounts[d]++);

    function markov(o) {
      if (paritySeq.length <= o) return { pE: 0.5, pO: 0.5, count: 0 };
      const key = paritySeq.slice(-o).join(",");
      let e = 0, oC = 0, count = 0;
      for (let i = 0; i <= paritySeq.length - o - 1; i++) {
        const seg = paritySeq.slice(i, i + o).join(",");
        if (seg === key) {
          count++;
          const nxt = paritySeq[i + o];
          if (nxt === "E") e++; else oC++;
        }
      }
      return { pE: count ? e / count : 0.5, pO: count ? oC / count : 0.5, count };
    }

    const m2 = markov(2), m3 = markov(3), m4 = markov(4);
    const weight = (c) => Math.pow(c, 0.9);
    const w2 = weight(m2.count), w3 = weight(m3.count), w4 = weight(m4.count * 1.15);
    const pE_markov = (m2.pE * w2 + m3.pE * w3 + m4.pE * w4) / ((w2 + w3 + w4) || 1);

    let currRun = 1, runs = [];
    for (let i = 1; i < paritySeq.length; i++) {
      if (paritySeq[i] === paritySeq[i - 1]) currRun++;
      else { runs.push(currRun); currRun = 1; }
    }
    runs.push(currRun);
    const lastRun = currRun;
    const lastParityRaw = paritySeq[paritySeq.length - 1]; // 'E' or 'O'
    const avgRun = runs.reduce((a, b) => a + b, 0) / (runs.length || 1);

    const continuationBias = avgRun > 2.4 ? 1 : 0;
    let streakComponent = 0;
    if (continuationBias) streakComponent = (lastRun > 2 ? 0.06 : 0.03);
    else { if (lastRun >= 3) streakComponent = -0.07; if (lastRun >= 4) streakComponent = -0.12; }

    let pE = pE_markov;
    if (evenPct > 55) pE += 0.05;
    else if (evenPct < 45) pE -= 0.05;
    if (lastParityRaw === "E") pE += streakComponent; else pE -= streakComponent;

    pE = clamp(pE, 0.02, 0.98);
    const pO = 1 - pE;
    const parity = (pO > pE) ? "ODD" : "EVEN";

    const maxProb = Math.max(pE, pO);
    const evidenceStrength = m2.count + m3.count + m4.count;

    const pDom = maxProb;
    const entropy = - (pDom * Math.log2(pDom) + (1 - pDom) * Math.log2(1 - pDom));
    const separation = (maxProb - 0.5) * 200;
  let confidence = logistic(separation, 15, 6) * 100;
  if (evidenceStrength < 3) confidence = Math.min(confidence, 78);
  if (evidenceStrength < 2) confidence = Math.min(confidence, 68);
    const entropyFactor = 1 - Math.min(0.30, entropy * 0.30);
    confidence = clamp(Math.round(confidence * entropyFactor), 0, 98);

  const goodTrade = (confidence >= 88) && (evidenceStrength >= 4) && (maxProb >= 0.58);
    const dominant = parity === "EVEN" ? pE : pO;

    const reason = `Parity=${parity} (${(dominant * 100).toFixed(1)}%) | Streak=${lastRun} ${lastParityRaw === "E" ? "EVEN" : "ODD"} | Dist E=${evenPct.toFixed(1)}% O=${oddPct.toFixed(1)}% | Evidence=${evidenceStrength} | Entropy=${entropy.toFixed(2)}`;

    return {
      confidence, tradeType: "EVENODD", parity, reason,
      evenPct, oddPct, evenCount, oddCount, digitCounts,
      goodTrade, lastRun, lastParity: lastParityRaw === "E" ? "EVEN" : "ODD", evidenceStrength
    };
  }

  // Strike Pro evaluation
  function evaluateStrikePro() {
    // Analysis window removed; use full history
    const need = digitHistory.length;
    const haveD = digitHistory.length, haveP = priceHistory.length;
    if (!SUPPORTED.DIGITS.has(activeSymbol) || digitHistory.length < 10 || priceHistory.length < 8) {
      return {
        confidence: 0, tradeType: null, outcome: null, direction: null,
        reason: "Waiting for OU/Direction context", ouProbPct: 0, dirConfPct: 0, goodTrade: false
      };
    }

    const W = Math.min(Math.max(need, 30), digitHistory.length);
    const slice = digitHistory.slice(-W);

    const countOver1 = slice.filter(d => d >= 2 && d <= 9).length;
    const countUnder9 = slice.filter(d => d >= 0 && d <= 8).length;
    const pOver1_emp = countOver1 / W;
    const pUnder9_emp = countUnder9 / W;

    const pOver1_base = 0.8;
    const pUnder9_base = 0.9;

    const Wshort = Math.min(30, slice.length);
    const recent = slice.slice(-Wshort);
    const pOver1_recent = recent.filter(d => d >= 2).length / Math.max(1, recent.length);
    const pUnder9_recent = recent.filter(d => d <= 8).length / Math.max(1, recent.length);

    let pOver1 = 0.3 * pOver1_base + 0.4 * pOver1_emp + 0.3 * pOver1_recent;
    let pUnder9 = 0.3 * pUnder9_base + 0.4 * pUnder9_emp + 0.3 * pUnder9_recent;

    const lastD = digitHistory[digitHistory.length - 1];
    if (lastD === 9) pUnder9 += 0.02;
    if (lastD === 0) pOver1 += 0.015;
    pOver1 = clamp(pOver1, 0.02, 0.98);
    pUnder9 = clamp(pUnder9, 0.02, 0.98);

    if (emaFastPrice == null || emaSlowPrice == null || prevEmaFast == null || prevEmaSlow == null) {
      return { confidence: 0, tradeType: null, outcome: null, direction: null, reason: "Initializing trend components", ouProbPct: 0, dirConfPct: 0, goodTrade: false };
    }
    const slopeFast = emaFastPrice - prevEmaFast;
    const slopeSlow = emaSlowPrice - prevEmaSlow;
    const coherent = Math.sign(slopeFast) === Math.sign(slopeSlow);
    const dir = coherent ? (slopeFast >= 0 ? "RISE" : "FALL") : (emaMomentum >= 0 ? "RISE" : "FALL");

    const deltas = [];
    for (let i = 1; i < priceHistory.length; i++) deltas.push(priceHistory[i] - priceHistory[i - 1]);
    const absD = deltas.map(Math.abs);
    const medAbs = median(absD) || 1e-6;
    const boundedMomentum = clamp(Math.abs(emaMomentum) / (medAbs || 1e-6) / 4, 0, 1);
    let dirConf = 0.55 * (coherent ? 1 : 0.6) + 0.45 * boundedMomentum;
    dirConf = clamp(dirConf, 0, 1);

    const outcome = pOver1 >= pUnder9 ? "OVER1" : "UNDER9";
    const ouProb = Math.max(pOver1, pUnder9);
    const ouProbPct = ouProb * 100;
    const dirConfPct = dirConf * 100;

    const sep = (ouProb - 0.5) * 200;
  let conf = logistic(sep, 14, 6) * 100;
    conf = 0.55 * conf + 0.45 * (dirConf * 100);

    const synergy = (dir === "RISE" && outcome === "OVER1") || (dir === "FALL" && outcome === "UNDER9");
    if (synergy) conf = Math.min(98, conf + 6);

    const drift = computeDriftMetrics();
    if (drift.pattern === "CLUSTERING" && drift.strength >= 70) conf = Math.max(0, conf - 6);

    // Stable market trend integration — small but meaningful adjustment
    if (outcome === "OVER1") {
      if (stableTrend === "UP") conf = Math.min(98, conf + 3);
      if (stableTrend === "DOWN") conf = Math.max(0, conf - 5);
    } else { // UNDER9
      if (stableTrend === "DOWN") conf = Math.min(98, conf + 3);
      if (stableTrend === "UP") conf = Math.max(0, conf - 5);
    }

    const goodTrade = synergy && conf >= CONFIG.STRIKEPRO_EXCELLENT_CONF;

    const reason =
      `OU=${outcome === "OVER1" ? "OVER 1" : "UNDER 9"} (${ouProbPct.toFixed(1)}%) • Dir=${dir} (${dirConfPct.toFixed(1)}%)` +
      ` | Coherent=${coherent ? 1 : 0} Mom=${boundedMomentum.toFixed(2)} | Drift=${drift.pattern}/${drift.strength}%` +
      (synergy ? " | Synergy ✓" : "") + ` | Trend=${getStableTrendDisplay().text}`;

    return {
      confidence: Math.round(clamp(conf, 0, 98)),
      tradeType: "STRIKEPRO",
      outcome,
      direction: dir,
      reason,
      ouProbPct,
      dirConfPct,
      goodTrade,
      synergy
    };
  }

  /* ===========================================================================
     8) FLIP X DELAY HELPERS
     =========================================================================== */

  function setFlipXDelaySetting() {
    const v = clamp(Number(flipxDelayTicksInput?.value || 1), 1, 10);
    if (flipxDelayTicksInput) flipxDelayTicksInput.value = String(v);
    flipxDelaySetting = v;
  }

  function cancelFlipXPending(reason) {
    if (flipxPendingDelay) {
      log(`Flip X delayed trade cancelled: ${reason}`, "loss");
      flipxPendingDelay = null;
      eoReasonEl && eoReasonEl.classList.remove("flipx-delay-pending");
    }
  }

  function executeImmediateFlipX(parity, source) {
    const key = parity === "EVEN" ? "EVEN" : "ODD";
    const cached = eoProposalCache.get(key);
    const fresh = cached && cached.id && (Date.now() - (cached.ts || 0) <= CONFIG.PROPOSAL_CACHE_MS);
    const priceToUse = Number((cached?.ask ?? Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1)).toFixed(2));
    if (fresh) {
      try {
        lastRequestedType = (key === "EVEN" ? "DIGITEVEN" : "DIGITODD");
        placingTrade = true; updateUILock();
        wsSend({ buy: cached.id, price: priceToUse });
        log(`Flip X ${source} buy (${key}) @ ${fmt2c(priceToUse)}`, "win");
      } catch (e) {
        log(`Flip X ${source} buy failed: ${e.message || e}`, "loss");
        requestFlipXProposal(key);
      }
    } else {
      requestFlipXProposal(key);
    }
  }

  function startFlipXDelayedTrade(parity, source, evalObj) {
    setFlipXDelaySetting();
    if (flipxDelaySetting <= 1) {
      executeImmediateFlipX(parity, source);
      return;
    }
    flipxPendingDelay = {
      targetParity: parity,
      remaining: flipxDelaySetting,
      source,
      confidenceAtStart: evalObj?.confidence || 0,
      evidenceAtStart: evalObj?.evidenceStrength || 0,
      createdEpoch: lastTickEpoch
    };
    eoReasonEl && eoReasonEl.classList.add("flipx-delay-pending");
    log(`Flip X delay started: ${flipxDelaySetting} ticks -> ${parity} (${source})`);
  }

  /* ===========================================================================
     9) BURST AND SEQUENTIAL Z TRADE
     =========================================================================== */

  function startSameTickBurst() {
    if (!authorized) { alert("Connect & authorize first."); return; }
    if (!useDiffersVsLast) { log("Enable Z Trade first.", "loss"); return; }
    autoAdjustSymbolForStrategy("DIGITDIFF");
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Digits not offered on symbol.", "loss"); return; }
    if (digitHistory.length < 1) { log("Need a digit first.", "loss"); return; }

    const lastDigit = digitHistory[digitHistory.length - 1];
    const barrier = String(lastDigit);
    const stakeFallback = Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1);

    burstActive = { barrier, target: 3, sent: 0, epoch: lastTickEpoch, expiresAt: Date.now() + 900, stakeFallback };
    log(`Burst armed b=${barrier} epoch=${lastTickEpoch}`);

    const cached = proposalCache.get(barrier);
    if (cached?.id) {
      const priceToUse = Number((cached.ask ?? cached.stake ?? stakeFallback).toFixed(2));
      wsSend({ buy: cached.id, price: priceToUse });
      burstActive.sent++;
      log(`Burst immediate buy #${burstActive.sent}`);
    }
    for (let i = burstActive.sent; i < burstActive.target; i++) {
      requestProposal("DIGITDIFF", { barrier, buyQty: 1, simulBurst: true });
    }
  }

  function startSequential3() {
    if (!authorized) { alert("Connect & authorize first."); return; }
    if (!useDiffersVsLast) { log("Enable Z Trade first.", "loss"); return; }
    autoAdjustSymbolForStrategy("DIGITDIFF");
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Digits not on symbol.", "loss"); return; }

    seqPlan = { remaining: 3, stopOnLoss: true, awaitingTick: false, waitEpoch: lastTickEpoch };
    log("Sequential plan (3) started.");
    placeNextSequential();
  }

  function placeNextSequential() {
    if (!seqPlan || seqPlan.remaining <= 0) return;
    const lastDigit = digitHistory[digitHistory.length - 1];
    if (lastDigit == null) { log("Awaiting digit for sequential.", "loss"); return; }
    requestProposal("DIGITDIFF", { barrier: String(lastDigit), buyQty: 1 });
  }

  /* ===========================================================================
     10) PROPOSALS, BUY/SELL, WS HELPERS
     =========================================================================== */

  function wsSend(o) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  }

  function requestProposal(contract_type, opts = {}) {
    if (contract_type === "ACCU" && !SUPPORTED.ACCU.has(activeSymbol)) { log("Bolt unsupported here.", "loss"); return; }
    if (contract_type.startsWith("DIGIT") && !SUPPORTED.DIGITS.has(activeSymbol)) { log("Digits unsupported here.", "loss"); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { log("WebSocket not open", "loss"); return; }

    const stake = Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1);
    const req = {
      proposal: 1,
      amount: Number(stake.toFixed(2)),
      basis: "stake",
      contract_type,
      currency: accountCurrency,
      ...(contract_type === "ACCU" ? {} : { duration: 1, duration_unit: "t" }),
      symbol: activeSymbol
    };
    if (opts.barrier != null) req.barrier = String(opts.barrier);

    if (contract_type === "ACCU") {
      const gPct = clamp(Number(accuGrowthInput?.value || 1), 1, 5);
      req.growth_rate = Number((gPct / 100).toFixed(4));
      setAccuGrowthLive();
    }

    if (!opts.simulBurst) {
      pendingBuy = { type: contract_type, barrier: req.barrier ?? null, qty: Math.max(1, opts.buyQty || 1) };
      placingTrade = true; updateUILock();
    }

    try {
      lastRequestedType = contract_type;
      // Throttle duplicate/frequent proposal requests for the same key
      const barrierKey = req.barrier ?? "";
      if (!canRequestProposalNow(contract_type, barrierKey)) {
        log(`Throttled proposal ${contract_type}${barrierKey ? ` b=${barrierKey}` : ""} — waiting cooldown`, "loss");
        placingTrade = false; pendingBuy = null; updateUILock();
        return;
      }
      wsSend(req);
      markProposalSent(contract_type, barrierKey);
      log(`Proposal ${contract_type}${req.barrier ? ` b=${req.barrier}` : ""} requested @ ${fmt2c(req.amount)}`);
      if (opts.simulBurst && req.barrier != null && contract_type === "DIGITDIFF") {
        const prev = proposalCache.get(req.barrier) || {};
        proposalCache.set(req.barrier, { ...prev, stake: req.amount });
      }
      if (opts.simulBurst && (contract_type === "DIGITOVER" || contract_type === "DIGITUNDER")) {
        const key = contract_type === "DIGITOVER" ? "OVER1" : "UNDER9";
        const prev = strikeProposalCache.get(key) || {};
        strikeProposalCache.set(key, { ...prev, stake: req.amount });
      }
    } catch (e) {
      if (!opts.simulBurst) { placingTrade = false; pendingBuy = null; updateUILock(); }
      log(`Proposal send error: ${e.message || e}`, "loss");
    }
  }

  function sellContract(id) {
    wsSend({ sell: id, price: 0 });
  }

  function trySellWithRetry(id, attempt = 0) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sellContract(id);
    if (attempt + 1 < FAST.SELL_RETRY_MAX)
      setTimeout(() => { if (openAccuId === id) trySellWithRetry(id, attempt + 1); }, FAST.SELL_RETRY_MS);
  }

  function subscribeTicks(sym) {
    wsSend({ forget_all: "ticks" });
    wsSend({ ticks_history: sym, count: CONFIG.INITIAL_HISTORY_TICKS, end: "latest", style: "ticks" });
    wsSend({ ticks: sym });
    log(`Subscribed ticks ${sym}`);
  }

  // Public (unauthorized) feed helpers
  function publicWsSend(o) {
    try { wsPublic && wsPublic.readyState === WebSocket.OPEN && wsPublic.send(JSON.stringify(o)); } catch {}
  }
  function publicSubscribeTicks(sym) {
    if (!wsPublicOpen) return;
    publicWsSend({ forget_all: "ticks" });
    publicWsSend({ ticks_history: sym, count: CONFIG.INITIAL_HISTORY_TICKS, end: "latest", style: "ticks" });
    publicWsSend({ ticks: sym });
    log(`(Public) Subscribed ticks ${sym}`);
  }
  function openPublicFeedIfNeeded() {
    if (authorized || wsPublicOpen) return;
    try { if (wsPublic) { try { wsPublic.close(); } catch {} } } catch {}
    wsPublic = new WebSocket(CONFIG.DERIV_WS_URL);
    wsPublic.onopen = () => {
      wsPublicOpen = true;
      publicSubscribeTicks(activeSymbol);
      log("Public market feed open (read-only)");
      publicReconnectAttempts = 0;
      // Start keepalive ping for the public socket
      if (publicPingInterval) clearInterval(publicPingInterval);
      publicPingInterval = setInterval(() => { try { publicWsSend({ ping: 1 }); } catch {} }, FAST.WS_PING_MS);
      // Watchdog to resubscribe if no ticks flow
      if (tickWatchdogInterval) clearInterval(tickWatchdogInterval);
      tickWatchdogInterval = setInterval(() => {
        if (authorized) return; // authorized feed takes over
        const gap = Date.now() - lastTickTs;
        if (gap > 10000 && wsPublicOpen) {
          try { publicSubscribeTicks(activeSymbol); log("Tick watchdog: re-subscribed public feed"); } catch {}
        }
      }, 5000);
    };
    wsPublic.onclose = () => {
      wsPublicOpen = false;
      log("Public market feed closed");
      if (publicPingInterval) { clearInterval(publicPingInterval); publicPingInterval = null; }
      // Auto-reconnect while not authorized
      if (!authorized) {
        const delay = Math.min(CONFIG.RECONNECT_MAX_DELAY_MS, Math.pow(2, publicReconnectAttempts) * 1000);
        publicReconnectAttempts++;
        setTimeout(() => { if (!authorized) openPublicFeedIfNeeded(); }, delay);
      }
    };
    wsPublic.onerror = () => { /* ignore */ };
    wsPublic.onmessage = (evt) => {
      let data; try { data = JSON.parse(evt.data); } catch { return; }
      if (data.msg_type === "history" && data.history?.prices) {
        data.history.prices.forEach(p => handleTick(Number(p)));
        return;
      }
      if (data.msg_type === "tick" && data.tick?.quote) {
        handleTick(Number(data.tick.quote), data.tick.epoch, data.tick.display_value);
        return;
      }
    };
  }
  function closePublicFeed() {
    try { if (wsPublic) wsPublic.close(); } catch {}
    wsPublicOpen = false; wsPublic = null;
    if (publicPingInterval) { clearInterval(publicPingInterval); publicPingInterval = null; }
    if (tickWatchdogInterval) { clearInterval(tickWatchdogInterval); tickWatchdogInterval = null; }
  }

  /* ===========================================================================
     11) VISUAL TICK MOVEMENT
     =========================================================================== */

  function appendTickArrow(lastDigit) {
    if (!tickMovementEl || priceHistory.length < 2) return;

    const wrap = document.createElement("div");
    wrap.className = "tick-item enter";

    const d = priceHistory[priceHistory.length - 1] - priceHistory[priceHistory.length - 2];
    const med = median(recentAbsDeltas);
    const thr = Math.max(med * 3, med ? med * 3 : 0.15);

    const bc = /^((CRASH|BOOM)(300|500|1000))$/.test(activeSymbol);
    const boom = /^BOOM/.test(activeSymbol), crash = /^CRASH/.test(activeSymbol);

    const span = document.createElement("span");
    span.className = "arrow";

    if (bc && boom) {
      const spikeUp = d >= thr; span.textContent = spikeUp ? "↑" : "↓"; span.classList.add(spikeUp ? "up" : "down"); if (spikeUp) span.classList.add("spike");
    } else if (bc && crash) {
      const spikeDown = d <= -thr; span.textContent = spikeDown ? "↓" : "↑"; span.classList.add(spikeDown ? "down" : "up"); if (spikeDown) span.classList.add("spike");
    } else {
      if (d > 0) { span.textContent = "↑"; span.classList.add("up"); }
      else if (d < 0) { span.textContent = "↓"; span.classList.add("down"); }
      else { span.textContent = "→"; span.classList.add("flat"); }
    }
    wrap.appendChild(span);

    if (SUPPORTED.DIGITS.has(activeSymbol) && Number.isInteger(lastDigit)) {
      const pill = document.createElement("span");
      pill.className = `digit-pill ${lastDigit % 2 === 0 ? "even" : "odd"}`;
      pill.textContent = String(lastDigit);
      if (useStrikePro && (lastDigit === 1 || lastDigit === 9)) {
        pill.classList.add(lastDigit === 1 ? "highlight-1" : "highlight-9");
      }
      wrap.appendChild(pill);
    }

    tickMovementEl.appendChild(wrap);
    setTimeout(() => wrap.classList.remove("enter"), 280);
    while (tickMovementEl.children.length > 20) tickMovementEl.removeChild(tickMovementEl.firstChild);
  }

  /* ===========================================================================
     12) TICK HANDLER (MAIN LOOP)
     =========================================================================== */

  function handleTick(quote, epoch, displayValue) {
    lastTickTs = Date.now();
    ticksSinceLastTrade++;
    lastTickEpoch = Number(epoch || lastTickEpoch) || lastTickEpoch;

    const price = Number(quote);
    if (Number.isNaN(price)) return;

    priceHistory.push(price);
    if (priceHistory.length > CONFIG.PRICE_HISTORY_LIMIT) priceHistory.shift();

    // EMAs
    const af = 2 / (MA.fast + 1), as = 2 / (MA.slow + 1);
    prevEmaFast = emaFastPrice; prevEmaSlow = emaSlowPrice;
    emaFastPrice = emaFastPrice == null ? price : emaFastPrice * (1 - af) + price * af;
    emaSlowPrice = emaSlowPrice == null ? price : emaSlowPrice * (1 - as) + price * as;

    // Track trend age
    if (emaFastPrice != null && emaSlowPrice != null) {
      const state = emaFastPrice >= emaSlowPrice ? 1 : 0;
      if (prevTrendState == null) {
        prevTrendState = state;
        trendAgeTicks = 0;
      } else if (state === prevTrendState) {
        trendAgeTicks++;
      } else {
        prevTrendState = state;
        trendAgeTicks = 0;
      }
    }

    if (priceHistory.length >= 2) {
      const d = price - priceHistory[priceHistory.length - 2];
      recentAbsDeltas.push(Math.abs(d));
      if (recentAbsDeltas.length > 60) recentAbsDeltas.shift();
    }

    // Maintain a stable market trend with hysteresis
    updateStableMarketTrend();

    // Extract last digit
    let lastDigit = null;
    if (displayValue != null) lastDigit = lastDigitFromString(String(displayValue));
    if (lastDigit == null && Number.isFinite(price)) lastDigit = lastDigitFromString(String(price));
    const prevDigit = digitHistory[digitHistory.length - 1];
    if (Number.isInteger(lastDigit)) {
      digitHistory.push(lastDigit);
      if (digitHistory.length > CONFIG.DIGIT_HISTORY_LIMIT) digitHistory.shift();
    }
    if (prevDigit != null && Number.isInteger(lastDigit)) {
      outcomesHistory.push({ prev: prevDigit, curr: lastDigit, outcome: prevDigit === lastDigit ? "M" : "D" });
      if (outcomesHistory.length > 10) outcomesHistory.shift();
    }

    // Pre-cache proposals for speed
    if (authorized && SUPPORTED.DIGITS.has(activeSymbol)) {
      const stake = Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1);
      const now = Date.now();

  // DIGITDIFF barrier (prefetch throttled) — only when Z Trade is enabled
  if (useDiffersVsLast && Number.isInteger(lastDigit)) {
        const barrier = String(lastDigit);
        const cached = proposalCache.get(barrier);
        const fresh = cached && now - (cached.ts || 0) <= CONFIG.PROPOSAL_CACHE_MS;
        if (!fresh && !proposalInFlight.get(barrier) && canRequestProposalNow("DIGITDIFF", "*")) {
          proposalInFlight.set(barrier, true);
          wsSend({
            proposal: 1,
            amount: Number(stake.toFixed(2)),
            basis: "stake",
            contract_type: "DIGITDIFF",
            currency: accountCurrency,
            duration: 1,
            duration_unit: "t",
            symbol: activeSymbol,
            barrier
          });
          markProposalSent("DIGITDIFF", "*");
        }
      }

      // DIGITEVEN / DIGITODD
      // EVEN/ODD proposals — only when Flip X is enabled
      [["DIGITEVEN", "EVEN"], ["DIGITODD", "ODD"]].forEach(([ct, key]) => {
        if (!useEvenOdd) return;
        const c = eoProposalCache.get(key);
        const f = c && now - (c.ts || 0) <= CONFIG.PROPOSAL_CACHE_MS;
        if (!f && !eoProposalInFlight.get(key) && canRequestProposalNow(ct, "*")) {
          eoProposalInFlight.set(key, true);
          wsSend({
            proposal: 1,
            amount: Number(stake.toFixed(2)),
            basis: "stake",
            contract_type: ct,
            currency: accountCurrency,
            duration: 1,
            duration_unit: "t",
            symbol: activeSymbol
          });
          markProposalSent(ct, "*");
        }
      });

      // DIGITOVER (1) / DIGITUNDER (9)
      // OVER/UNDER proposals — only when Strike Pro is enabled
      [
        { ct: "DIGITOVER", key: "OVER1", barrier: "1" },
        { ct: "DIGITUNDER", key: "UNDER9", barrier: "9" }
      ].forEach(({ ct, key, barrier }) => {
        if (!useStrikePro) return;
        const c = strikeProposalCache.get(key);
        const f = c && now - (c.ts || 0) <= CONFIG.PROPOSAL_CACHE_MS;
        if (!f && !strikeProposalInFlight.get(key) && canRequestProposalNow(ct, "*")) {
          strikeProposalInFlight.set(key, true);
          wsSend({
            proposal: 1,
            amount: Number(stake.toFixed(2)),
            basis: "stake",
            contract_type: ct,
            currency: accountCurrency,
            duration: 1,
            duration_unit: "t",
            symbol: activeSymbol,
            barrier
          });
          markProposalSent(ct, "*");
        }
      });
    }

  // Keep tick movement live for any enabled strategy (including Z Trade)
  if (useAccumulator || useEvenOdd || useStrikePro || useDiffersVsLast) appendTickArrow(lastDigit);

    // Evaluate strategies
    const diffEval = evaluateDiffersVsLast();
    const accuEval = evaluateAccumulator();
    const eoEval = evaluateEvenOdd();
    const strikeEval = evaluateStrikePro();
    lastEvenOddEval = eoEval;

    // Flip X delayed trade countdown with guard
    if (flipxPendingDelay) {
      const confDropTooLow =
        (eoEval.confidence < Math.min(CONFIG.CONFIDENCE_THRESHOLD - 5, flipxPendingDelay.confidenceAtStart - 10));
      const evidenceDrop = (eoEval.evidenceStrength + 2 < flipxPendingDelay.evidenceAtStart);
      if (confDropTooLow || evidenceDrop) {
        cancelFlipXPending(`signal degraded (conf ${eoEval.confidence} / evidence ${eoEval.evidenceStrength})`);
      } else {
        flipxPendingDelay.remaining--;
        if (flipxPendingDelay.remaining > 0) {
          log(`Flip X delay countdown: ${flipxPendingDelay.remaining} ticks left (${flipxPendingDelay.targetParity})`);
        } else {
          if (eoEval.parity === flipxPendingDelay.targetParity) {
            log(`Flip X delay complete: executing ${flipxPendingDelay.targetParity}.`);
            executeImmediateFlipX(flipxPendingDelay.targetParity, `${flipxPendingDelay.source}-delayed`);
          } else {
            cancelFlipXPending(`parity changed (was ${flipxPendingDelay.targetParity}, now ${eoEval.parity})`);
          }
          flipxPendingDelay = null;
          eoReasonEl && eoReasonEl.classList.remove("flipx-delay-pending");
        }
      }
    }

    // Update panels
    updateDigitsPanelsIfEnabled();
    if (useAccumulator) updateAccuConditions(accuEval.consistencyPct, accuEval.volLevelPct);

    // Confidence bar and Safe Entry
    let activeEvalForSafe = null;
    let activeConfidence = 0, activeSource = "None";
    if (useStrikePro) { activeEvalForSafe = strikeEval; activeConfidence = strikeEval.confidence; activeSource = "Strike Pro"; }
    else if (useAccumulator) { activeEvalForSafe = accuEval; activeConfidence = accuEval.confidence; activeSource = "Bolt"; }
    else if (useDiffersVsLast && diffEval.tradeType) { activeEvalForSafe = diffEval; activeConfidence = diffEval.confidence; activeSource = "Z Trade"; }
    else if (useEvenOdd && eoEval.tradeType) { activeEvalForSafe = eoEval; activeConfidence = eoEval.confidence; activeSource = "Flip X"; }

    setConfidenceBar(activeConfidence, activeSource);
    updateSuggestedActionStrength(activeEvalForSafe);
    updateSessionPanelFromEvals(diffEval, accuEval, eoEval, strikeEval);
    updateFiboPanel(diffEval, accuEval, eoEval, strikeEval);
    updateEvenOddPanel(eoEval);

    // Sequential plan next step after new tick
    if (seqPlan && seqPlan.awaitingTick && lastTickEpoch > seqPlan.waitEpoch) {
      seqPlan.awaitingTick = false;
      placeNextSequential();
    }

    // Entry spacing
    const requiredSpacing = (useDiffersVsLast && !useAccumulator)
      ? (CONFIG.FAST_ENTRY_DIGITS ? CONFIG.DIGITS_MIN_TICKS_BETWEEN_TRADES : 1)
      : 1;
    const canPlaceNow = ticksSinceLastTrade >= requiredSpacing;

    // Auto-trade guard: respect batch limit
    const canAutoMore = autoTradesDone < autoTradesPlanned;

    // Auto Bolt — only when not Consolidating or low vol
    if (useAccumulator && autoTrade && canAutoMore && authorized && accuEval.confidence >= CONFIG.CONFIDENCE_THRESHOLD) {
      if (stableTrend !== "RANGING" && (accuEval.volLevelPct || 0) >= 55) {
        autoAdjustSymbolForStrategy("ACCU");
        if (!openAccuId && canPlaceNow && SUPPORTED.ACCU.has(activeSymbol)) {
          requestProposal("ACCU", { buyQty: 1 });
          ticksSinceLastTrade = 0;
        }
      } else {
        log("Auto Bolt skipped: consolidating or low volatility.", "loss");
      }
    }

    // Auto Z Trade — avoid strong clustering
    if (useDiffersVsLast && autoTrade && canAutoMore && authorized && diffEval.tradeType === "DIGITDIFF"
      && diffEval.confidence >= CONFIG.CONFIDENCE_THRESHOLD && canPlaceNow) {
      const drift = computeDriftMetrics();
      if (drift.warn) {
        log("Auto Z Trade skipped: clustering detected.", "loss");
      } else {
        autoAdjustSymbolForStrategy("DIGITDIFF");
        const lastDigitNow = digitHistory[digitHistory.length - 1];
        if (SUPPORTED.DIGITS.has(activeSymbol) && Number.isInteger(lastDigitNow)) {
          requestProposal("DIGITDIFF", { barrier: String(lastDigitNow), buyQty: 1 });
          ticksSinceLastTrade = 0;
        }
      }
    }

    // Auto Flip X with delay — require basic evidence; avoid very long runs
    if (useEvenOdd && autoTrade && canAutoMore && authorized && eoEval.tradeType === "EVENODD" && canPlaceNow) {
      const nowTs = Date.now();
      const intervalOK = (nowTs - lastFlipXAutoTs) >= CONFIG.FLIPX_AUTO_MIN_INTERVAL_MS;
      const confidenceOK = eoEval.confidence >= CONFIG.EO_AUTO_MIN_CONFIDENCE;
      const evidenceOK = (eoEval.evidenceStrength || 0) >= 4 && (eoEval.lastRun || 0) <= 4;
      if (intervalOK && confidenceOK && evidenceOK) {
        if (!flipxPendingDelay) {
          startFlipXDelayedTrade(eoEval.parity, "auto", eoEval);
          ticksSinceLastTrade = 0;
          lastFlipXAutoTs = nowTs;
        } else {
          log("Auto Flip X signal skipped: delay already pending.", "loss");
        }
      } else if (!evidenceOK) {
        log("Auto Flip X skipped: insufficient evidence or long streak.", "loss");
      }
    }

    // Auto Strike Pro — place trades for OVER 1 or UNDER 9 (no safety skips)
    if (useStrikePro && autoTrade && canAutoMore && authorized && SUPPORTED.DIGITS.has(activeSymbol) && canPlaceNow) {
      const nowTs = Date.now();
      const cooldownOk = (nowTs - lastStrikeTs) >= CONFIG.STRIKEPRO_AUTO_MIN_INTERVAL_MS;
      if (cooldownOk && strikeEval.confidence >= CONFIG.STRIKEPRO_MIN_CONFIDENCE) {
        if (strikeEval.outcome === "OVER1") {
          autoAdjustSymbolForStrategy("DIGITOVER");
          let didFast = false;
          if (CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE) {
            didFast = strikeBuyImmediateIfCached("OVER1");
          }
          if (!didFast) {
            requestProposal("DIGITOVER", { barrier: "1", buyQty: 1 });
          }
          ticksSinceLastTrade = 0;
          lastStrikeTs = nowTs;
        } else {
          autoAdjustSymbolForStrategy("DIGITUNDER");
          let didFast = false;
          if (CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE) {
            didFast = strikeBuyImmediateIfCached("UNDER9");
          }
          if (!didFast) {
            requestProposal("DIGITUNDER", { barrier: "9", buyQty: 1 });
          }
          ticksSinceLastTrade = 0;
          lastStrikeTs = nowTs;
        }
      }
    }
  }

  /* ===========================================================================
     13) PANEL UPDATES
     =========================================================================== */

  function updateDigitsPanelsIfEnabled() {
    if (useDiffersVsLast && SUPPORTED.DIGITS.has(activeSymbol)) {
      updateOutcomesUI();
      updateDriftUI();
    } else {
      panelDigitsInsights?.classList.add("hidden");
    }
  }

  function strengthFromConf(c) {
    if (c >= 97) return { label: "EXCELLENT", cls: "excellent" };
    if (c >= 90) return { label: "STRONG", cls: "strong" };
    if (c >= CONFIG.CONFIDENCE_THRESHOLD) return { label: "MODERATE", cls: "moderate" };
    return { label: "WEAK", cls: "weak" };
  }

  function updateFiboPanel(diffEval, accuEval, eoEval, strikeEval) {
    let subtitle = "Live Analysis — " + activeSymbol;
    if (useDiffersVsLast) subtitle = "Z Trade Analysis — " + activeSymbol;
    if (useEvenOdd) subtitle = "Flip X Parity Analysis — " + activeSymbol;
    if (useStrikePro) subtitle = "Strike Pro Analysis — " + activeSymbol;
    if (fiboSubtitleEl) fiboSubtitleEl.textContent = subtitle;

    const lastPrice = priceHistory[priceHistory.length - 1];
    const prevPrice = priceHistory[priceHistory.length - 2];

    if (fiboPriceEl) fiboPriceEl.textContent = Number.isFinite(lastPrice) ? fmt5(lastPrice) : "—";

    const ld = digitHistory[digitHistory.length - 1];
    const pd = digitHistory.length >= 2 ? digitHistory[digitHistory.length - 2] : null;

    if (fiboDigitEl) fiboDigitEl.textContent = ld != null ? String(ld) : "—";
    if (fiboPrevDigitEl) fiboPrevDigitEl.textContent = pd != null ? String(pd) : "—";

    if (fiboDeltaEl) {
      if (Number.isFinite(lastPrice) && Number.isFinite(prevPrice)) {
        const d = lastPrice - prevPrice;
        fiboDeltaEl.textContent = `${d >= 0 ? "+" : ""}${fmt5(d)}`;
        fiboDeltaEl.className = `kpi-value delta ${d > 0 ? "pos" : d < 0 ? "neg" : "neutral"}`;
      } else {
        fiboDeltaEl.textContent = "—"; fiboDeltaEl.className = "kpi-value delta neutral";
      }
    }

    // stable market trend display
    if (marketTrendEl) {
      const display = getStableTrendDisplay();
      marketTrendEl.textContent = display.text;
      marketTrendEl.className = `kpi-value ${display.cls}`;
    }

    if (fiboGaugeCard) fiboGaugeCard.classList.toggle("hidden", !(useDiffersVsLast || useStrikePro));

    if (useDiffersVsLast && diffEval) {
      if (fiboGaugeTitleEl) fiboGaugeTitleEl.textContent = "Z Trade Probability Gauge";
      const differsProb = 100 - (diffEval?.stickyPct || 0);
      fiboGaugeFill.style.width = `${differsProb}%`;
      fiboGaugePct.textContent = `${differsProb.toFixed(1)}%`;
      const exp = differsProb >= 50 ? "DIFFERS" : "MATCHES";
      fiboExpectedEl.textContent = exp;
      fiboExpectedEl.className = `expected-value ${exp === "DIFFERS" ? "exp-diff" : "exp-match"}`;
      if (fiboDirExpectedEl) fiboDirExpectedEl.textContent = "—";
    }

    if (fiboParityStreakCard) {
      const show = useEvenOdd && eoEval && eoEval.lastRun != null;
      fiboParityStreakCard.classList.toggle("hidden", !show);
      if (show) {
        fiboParityStreakEl.textContent = `${eoEval.lastRun} ${eoEval.lastParity}`;
        fiboParityStreakEl.classList.remove("parity-even", "parity-odd");
        fiboParityStreakEl.classList.add(eoEval.lastParity === "EVEN" ? "parity-even" : "parity-odd");
      } else {
        fiboParityStreakEl.textContent = "—";
        fiboParityStreakEl.classList.remove("parity-even", "parity-odd");
      }
    }

    if (useStrikePro && strikeEval) {
      if (fiboGaugeTitleEl) fiboGaugeTitleEl.textContent = "Strike Pro Over/Under Probability";
      const pct = strikeEval.ouProbPct || 0;
      fiboGaugeFill.style.width = `${clamp(pct, 0, 100)}%`;
      fiboGaugePct.textContent = `${pct.toFixed(1)}%`;
      const expOU = strikeEval.outcome === "OVER1" ? "OVER 1" : "UNDER 9";
      fiboExpectedEl.textContent = expOU;
      fiboExpectedEl.className = `expected-value ${strikeEval.outcome === "OVER1" ? "exp-diff" : "exp-match"}`;
      if (fiboDirExpectedEl) fiboDirExpectedEl.textContent = strikeEval.direction || "—";
    }

    let evalObj = useStrikePro ? strikeEval : (useDiffersVsLast ? diffEval : (useAccumulator ? accuEval : (useEvenOdd ? eoEval : null)));
    const conf = clamp(Math.round(evalObj?.confidence || 0), 0, 100);
    const st = strengthFromConf(conf);
    if (fiboConfEl) fiboConfEl.textContent = evalObj ? `${conf}%` : "—";
    if (fiboStrengthEl) {
      fiboStrengthEl.textContent = st.label;
      fiboStrengthEl.className = `strength ${st.cls}`;
    }

    let reason = evalObj ? evalObj.reason : "Select a strategy…";
    if (flipxPendingDelay && useEvenOdd) reason += ` | Delay: ${flipxPendingDelay.remaining}`;
    if (fiboReasonEl) fiboReasonEl.textContent = reason;
  }

  function updateEvenOddPanel(eo) {
    panelEvenOdd?.classList.toggle("hidden", !useEvenOdd || !SUPPORTED.DIGITS.has(activeSymbol));
    if (!useEvenOdd) return;

    const evenPct = (eo?.evenPct ?? 0).toFixed(1) + "%";
    const oddPct = (eo?.oddPct ?? 0).toFixed(1) + "%";
    eoEvenFill.style.width = evenPct; eoOddFill.style.width = oddPct;
    eoEvenPct.textContent = evenPct; eoOddPct.textContent = oddPct;
    eoEvenCount.textContent = `${eo?.evenCount ?? 0} occurrences`;
    eoOddCount.textContent = `${eo?.oddCount ?? 0} occurrences`;
    eoNextEl.textContent = eo?.parity || "—";
    eoConfEl.textContent = `${Math.round(eo?.confidence || 0)}%`;

    const st = strengthFromConf(Math.round(eo?.confidence || 0));
    eoStrengthEl.textContent = st.label; eoStrengthEl.className = `strength ${st.cls}`;

    let reason = eo?.reason || "Collecting data…";
    if (flipxPendingDelay) reason += ` | Delay: ${flipxPendingDelay.remaining}`;
    eoReasonEl.textContent = reason;

    eoDigitsGrid.innerHTML = "";
    const counts = eo?.digitCounts || Array(10).fill(0);
    const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
    const frag = document.createDocumentFragment();
    for (let d = 0; d <= 9; d++) {
      const pct = (100 * counts[d] / total) || 0;
      const div = document.createElement("div");
      div.className = "eo-digit";
      div.innerHTML = `${d}<span class="pct">${pct.toFixed(1)}%</span>`;
      frag.appendChild(div);
    }
    eoDigitsGrid.appendChild(frag);
  }

  function updateOutcomesUI() {
    if (!recentOutcomesList || !panelDigitsInsights) return;
    recentOutcomesList.innerHTML = "";
    if (!(useDiffersVsLast && SUPPORTED.DIGITS.has(activeSymbol))) {
      panelDigitsInsights.classList.add("hidden");
      return;
    }
    panelDigitsInsights.classList.remove("hidden");

    const items = outcomesHistory.slice(-10).slice().reverse();
    if (!items.length) {
      recentOutcomesList.innerHTML = `<li class="outcome-li"><div class="outcome-left"><div class="outcome-icon">∅</div><div class="outcome-label">No outcomes yet</div></div><span class="badge badge-outline">—</span></li>`;
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((o, i) => {
      const li = document.createElement("li");
      li.className = "outcome-li";
      const tag = o.outcome === "M" ? '<span class="badge badge-match">MATCHES</span>' : '<span class="badge badge-diff">DIFFERS</span>';
      li.innerHTML = `<div class="outcome-left"><div class="outcome-icon">${items.length - i}</div><div class="outcome-label">${o.prev} ➜ ${o.curr}</div></div>${tag}`;
      frag.appendChild(li);
    });
    recentOutcomesList.appendChild(frag);
  }

  function computeDriftMetrics() {
    const arr = outcomesHistory.map(o => o.outcome);
    const n = arr.length;
    if (!n) return { status: "—", consecText: "—", pattern: "—", strength: 0, warn: false };

    const last = arr[n - 1];
    let consec = 1;
    for (let i = n - 2; i >= 0; i--) { if (arr[i] === last) consec++; else break; }

    let longest = 1, run = 1, switches = 0;
    for (let i = 1; i < n; i++) {
      if (arr[i] === arr[i - 1]) { run++; longest = Math.max(longest, run); }
      else { run = 1; switches++; }
    }

    let pattern = "BALANCED";
    if (longest >= 4) pattern = "CLUSTERING";
    else if (switches >= n - 2 && n >= 4) pattern = "ALTERNATING";

    const strength = Math.min(100, Math.round((longest / Math.min(10, n)) * 100 + (consec === longest ? 10 : 0)));
    return {
      status: last === "D" ? "DRIFTING" : "STICKY",
      consecText: `${consec} consecutive ${last === "D" ? "differs" : "matches"}`,
      pattern,
      strength,
      warn: pattern === "CLUSTERING" && longest >= 4
    };
  }

  function updateDriftUI() {
    const enable = useDiffersVsLast && SUPPORTED.DIGITS.has(activeSymbol);
    panelDigitsInsights?.classList.toggle("hidden", !enable);
    if (!enable) return;

    const m = computeDriftMetrics();
    driftStatusEl.textContent = m.status;
    driftConsecEl.textContent = m.consecText;
    driftPatternEl.textContent = m.pattern;
    driftStrengthTextEl.textContent = m.strength.toFixed(1) + "%";
    driftBarFillEl.style.width = `${m.strength}%`;
    driftWarnEl.classList.toggle("hidden", !m.warn);
  }

  /* ===========================================================================
     14) PROFIT, STATS, CHART
     =========================================================================== */

  function updateStatsUI() {
    if (!totalTradesEl || !winsEl || !lossesEl || !winRateEl) return;
    totalTradesEl.textContent = totalTrades;
    winsEl.textContent = wins;
    lossesEl.textContent = losses;
    winRateEl.textContent = totalTrades ? ((wins / totalTrades) * 100).toFixed(2) + "%" : "0%";
  }

  function updateProfitUI() {
    if (netProfitEl) netProfitEl.textContent = fmt2c(netProfit);
    scheduleProfitDraw(); // harmless if canvas is missing
  }

  function drawProfitChart() {
    if (!profitCtx || !profitCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    profitCanvas.width = profitCanvas.clientWidth * dpr;
    profitCanvas.height = profitCanvas.clientHeight * dpr;
    profitCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = profitCanvas.clientWidth, h = profitCanvas.clientHeight;
    profitCtx.clearRect(0, 0, w, h);

    profitCtx.strokeStyle = "#111";
    profitCtx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * h;
      profitCtx.beginPath();
      profitCtx.moveTo(0, y); profitCtx.lineTo(w, y); profitCtx.stroke();
    }

    const arr = profitSeries.slice(-CONFIG.PROFIT_SERIES_LIMIT);
    if (arr.length < 2) return;

    const maxAbs = Math.max(10, ...arr.map(v => Math.abs(v)));
    const mid = h / 2;

    profitCtx.beginPath();
    profitCtx.strokeStyle = "#222";
    profitCtx.moveTo(0, mid); profitCtx.lineTo(w, mid); profitCtx.stroke();

    profitCtx.beginPath();
    profitCtx.lineWidth = 2;
    profitCtx.strokeStyle = CONFIG.CHART_COLOR;

    arr.forEach((v, i) => {
      const x = (i / (arr.length - 1)) * (w - CONFIG.CHART_PAD_PX) + CONFIG.CHART_PAD_PX / 2;
      const y = mid - (v / maxAbs) * ((h / 2) - CONFIG.CHART_PAD_PX);
      if (i === 0) profitCtx.moveTo(x, y); else profitCtx.lineTo(x, y);
    });
    profitCtx.stroke();
  }

  /* ===========================================================================
     15) BOLT (ACCU) UI HELPERS
     =========================================================================== */

  function setAccuStatus(open) {
    if (accuStatusEl) accuStatusEl.textContent = open ? "Open" : "Closed";
    updateBuySellButton(open);
    updatePanelVisibility();
  }

  function updateBuySellButton(isOpen) {
    if (!buyAccuBtn) return;
    if (isOpen) {
      buyAccuBtn.textContent = "Sell";
      buyAccuBtn.classList.remove("btn-accu");
      buyAccuBtn.classList.add("alt-red");
    } else {
      buyAccuBtn.textContent = "Place Bolt Trade";
      buyAccuBtn.classList.remove("alt-red");
      buyAccuBtn.classList.add("btn-accu");
    }
  }

  function setAccuPL(v) {
    if (accuRunningPLEl) accuRunningPLEl.textContent = fmt2c(v);
  }

  function setAccuGrowthLive() {
    if (!accuGrowthLiveEl) return;
    const g = clamp(Number(accuGrowthInput?.value || 1), 1, 5);
    accuGrowthLiveEl.textContent = `${g.toFixed(1)}%/tick`;
  }

  function setAccuTicksElapsedUI() {
    if (!accuTicksElapsedEl) return;
    const limit = clamp(Number(accuTickLimitInput?.value || 20), 1, 85);
    accuTicksElapsedEl.textContent = `${accuTicksElapsed} / ${limit}`;
  }

  function updateAccuConditions(consistency, vol) {
    if (accuConsistencyEl) accuConsistencyEl.textContent = `${Number(consistency || 0).toFixed(1)}%`;
    if (accuVolLevelEl) accuVolLevelEl.textContent = `${Number(vol || 0).toFixed(0)}%`;
  }

  /* ===========================================================================
     16) SYMBOL AND STRATEGY STATE
     =========================================================================== */

  function setActiveSymbol(sym) {
    activeSymbol = sym;

    if (ws && ws.readyState === WebSocket.OPEN && authorized) {
      digitHistory.length = 0; priceHistory.length = 0; recentAbsDeltas.length = 0; outcomesHistory.length = 0;
      emaVol = 90; emaConsistency = 90; emaMomentum = 0;
      emaFastPrice = null; emaSlowPrice = null; prevEmaFast = null; prevEmaSlow = null;
      prevTrendState = null; trendAgeTicks = 0;

      // Reset market trend hysteresis on symbol change
      stableTrend = "RANGING"; trendCandidate = "RANGING"; trendCandidateAge = 0;

      if (tickMovementEl) tickMovementEl.innerHTML = "";
      proposalCache.clear(); eoProposalCache.clear();
      proposalInFlight.clear(); eoProposalInFlight.clear();
      strikeProposalCache.clear(); strikeProposalInFlight.clear();
      subscribeTicks(activeSymbol);
      cancelFlipXPending("symbol change");
      lastTickEpoch = 0;
      log(`Switched to ${activeSymbol}`);
      saveSettings();
    } else {
      // Resubscribe on public feed if not authorized
      if (!authorized) {
        openPublicFeedIfNeeded();
        publicSubscribeTicks(activeSymbol);
        log(`Switched to ${activeSymbol} (public feed)`);
        saveSettings();
      }
    }

    burstActive = null;
    seqPlan = null;
    updateOutcomesUI();
    updateDriftUI();
    updateEvenOddPanel(null);
    updatePanelVisibility();
  }

  function autoAdjustSymbolForStrategy(type) {
    if (type === "ACCU" && !SUPPORTED.ACCU.has(activeSymbol)) {
      log("Switching to CRASH1000 for Bolt.", "loss");
      setActiveSymbol("CRASH1000");
    } else if (type.startsWith("DIGIT") && !SUPPORTED.DIGITS.has(activeSymbol)) {
      log("Switching to R_100 for digits.", "loss");
      setActiveSymbol("R_100");
    }
  }

  function updateUILock() {
    const lock = placingTrade || !!openAccuId;
    const strategyOn = useAccumulator || useDiffersVsLast || useEvenOdd || useStrikePro;
    if (symbolSelect) symbolSelect.disabled = lock || !strategyOn;
    if (stakeInput) stakeInput.disabled = lock || !strategyOn;
    if (diffBuy1Btn) diffBuy1Btn.disabled = placingTrade || !useDiffersVsLast;
    if (diffBuy3Btn) diffBuy3Btn.disabled = placingTrade || !useDiffersVsLast;
    if (diffBuy3SeqBtn) diffBuy3SeqBtn.disabled = placingTrade || !useDiffersVsLast || !!seqPlan;
    if (evenOddPlaceTradeBtn) evenOddPlaceTradeBtn.disabled = placingTrade || !useEvenOdd;
    if (evenOddPlaceEvenBtn) evenOddPlaceEvenBtn.disabled = placingTrade || !useEvenOdd;
    if (evenOddPlaceOddBtn) evenOddPlaceOddBtn.disabled = placingTrade || !useEvenOdd;
    if (buyAccuBtn) buyAccuBtn.disabled = (!openAccuId && (!useAccumulator || placingTrade));
    if (confThresholdInput) confThresholdInput.disabled = lock;
    if (maxLossStreakInput) maxLossStreakInput.disabled = lock;
    if (autoTradeCountInput) autoTradeCountInput.disabled = lock || !strategyOn;

    if (strikePlaceTradeBtn) strikePlaceTradeBtn.disabled = placingTrade || !useStrikePro;
    if (strikePlaceOverBtn) strikePlaceOverBtn.disabled = placingTrade || !useStrikePro;
    if (strikePlaceUnderBtn) strikePlaceUnderBtn.disabled = placingTrade || !useStrikePro;
  }

  function updatePanelVisibility() {
    if (panelTrading) panelTrading.classList.toggle("hidden", !(useAccumulator || useDiffersVsLast || useEvenOdd || useStrikePro));
    const showDigitsInsights = (useDiffersVsLast && SUPPORTED.DIGITS.has(activeSymbol));
    if (panelDigitsInsights) panelDigitsInsights.classList.toggle("hidden", !showDigitsInsights);

    const showEO = useEvenOdd && SUPPORTED.DIGITS.has(activeSymbol);
    if (panelEvenOdd) panelEvenOdd.classList.toggle("hidden", !showEO);
    if (flipxDelayGroup) flipxDelayGroup.classList.toggle("hidden", !showEO);

    if (panelAccuSettings) panelAccuSettings.classList.toggle("hidden", !(useAccumulator || !!openAccuId));
    if (panelAccuMarket) panelAccuMarket.classList.toggle("hidden", !useAccumulator);
  // Show Recent Tick Movement when any strategy is on (Bolt, Z Trade, Flip X, or Strike Pro)
  if (panelTickMovement) panelTickMovement.classList.toggle("hidden", !useAccumulator && !useDiffersVsLast && !useEvenOdd && !useStrikePro);

    if (diffActions) diffActions.classList.toggle("hidden", !useDiffersVsLast);
    if (evenOddActions) evenOddActions.classList.toggle("hidden", !useEvenOdd);
    if (accuActions) accuActions.classList.toggle("hidden", !useAccumulator && !openAccuId);
    if (strikeActions) strikeActions.classList.toggle("hidden", !useStrikePro);

    updateUILock();
  }

  function setStrategyUI() {
    if (toggleAccumulator) toggleAccumulator.checked = useAccumulator;
    if (toggleDiffersVsLast) toggleDiffersVsLast.checked = useDiffersVsLast;
    if (toggleEvenOdd) toggleEvenOdd.checked = useEvenOdd;
    if (toggleStrikePro) toggleStrikePro.checked = useStrikePro;

    if (activeStrategyLabel) {
      if (useDiffersVsLast) activeStrategyLabel.textContent = "Z Trade";
      else if (useAccumulator) activeStrategyLabel.textContent = "Bolt";
      else if (useEvenOdd) activeStrategyLabel.textContent = "Flip X";
      else if (useStrikePro) activeStrategyLabel.textContent = "Strike Pro";
      else activeStrategyLabel.textContent = "—";
    }

    if (tradeTypeSelect) {
      tradeTypeSelect.innerHTML = "";
      if (useDiffersVsLast) {
        const o = document.createElement("option");
        o.value = "DIGITDIFF"; o.textContent = "Z Trade (Differs vs Last)";
        tradeTypeSelect.appendChild(o);
      } else if (useAccumulator) {
        const o = document.createElement("option");
        o.value = "ACCU"; o.textContent = "Bolt (Accumulator)";
        tradeTypeSelect.appendChild(o);
      } else if (useEvenOdd) {
        const o = document.createElement("option");
        o.value = "EVENODD"; o.textContent = "Flip X (Even/Odd)";
        tradeTypeSelect.appendChild(o);
      } else if (useStrikePro) {
        const o = document.createElement("option");
        o.value = "STRIKEPRO"; o.textContent = "Strike Pro (Over/Under + Rise/Fall)";
        tradeTypeSelect.appendChild(o);
      } else {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "Select a strategy"; o.disabled = true; o.selected = true;
        tradeTypeSelect.appendChild(o);
      }
    }

    updatePanelVisibility();
    updateOutcomesUI();
    updateDriftUI();
    updateEvenOddPanel(lastEvenOddEval);
    saveSettings();
  }

  /* ===========================================================================
     17) FLIP X HELPERS (REQUEST PROPOSALS)
     =========================================================================== */

  function requestFlipXProposal(key) {
    const ct = key === "EVEN" ? "DIGITEVEN" : "DIGITODD";
    requestProposal(ct, { buyQty: 1 });
  }

  function placeParityManual(key) {
    if (!authorized) { alert("Connect & authorize first."); return; }
    if (!useEvenOdd) { log("Enable Flip X first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Flip X unsupported on this symbol.", "loss"); return; }
    if (flipxPendingDelay) { log("Delayed trade already pending.", "loss"); return; }
    const eo = evaluateEvenOdd();
    if (!eo || !eo.parity) { log("No parity signal yet.", "loss"); return; }
    startFlipXDelayedTrade(key, "manual-specific", eo);
  }

  // Strike Pro helpers
  function strikeCooldownOk() {
    return (Date.now() - lastStrikeTs) >= CONFIG.STRIKEPRO_AUTO_MIN_INTERVAL_MS;
  }
  function strikeSchedule(ct, barrier) {
    lastStrikeTs = Date.now();
    requestProposal(ct, { barrier, buyQty: 1 });
  }
  // Fast buy from cached proposal for Strike Pro to reduce latency
  function strikeBuyImmediateIfCached(key = "OVER1") {
    const cached = strikeProposalCache.get(key);
    const fresh = cached && cached.id && (Date.now() - (cached.ts || 0) <= CONFIG.PROPOSAL_CACHE_MS);
    const priceToUse = Number((cached?.ask ?? Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1)).toFixed(2));
    if (fresh) {
      try {
        lastRequestedType = (key === "OVER1" ? "DIGITOVER" : "DIGITUNDER");
        placingTrade = true; updateUILock();
        wsSend({ buy: cached.id, price: priceToUse });
        log(`Strike Pro fast buy (${key === "OVER1" ? "OVER 1" : "UNDER 9"}) @ ${fmt2c(priceToUse)}`, "win");
        return true;
      } catch (e) {
        log(`Strike Pro fast buy failed: ${e.message || e}`, "loss");
      }
    }
    return false;
  }

  /* ===========================================================================
     18) CONNECTION MANAGEMENT
     =========================================================================== */

  function updateConnectButton() {
    if (!connectBtn) return;
    if (authorized) { connectBtn.textContent = "Disconnect"; connectBtn.className = "btn alt-red"; }
    else { connectBtn.textContent = "Connect"; connectBtn.className = "btn primary"; }
  }

  function clearIntervals() {
    wsPingInterval && clearInterval(wsPingInterval);
    pocWatchdogInterval && clearInterval(pocWatchdogInterval);
    wsPingInterval = null; pocWatchdogInterval = null;
  }

  function updateBalanceUI(b) { if (balanceEl) balanceEl.textContent = fmt2c(b); }
  function updateAccountTypeUI(isVirtual, loginid) {
    if (!accountTypeEl) return;
    const label = isVirtual ? "Demo" : "Real";
    accountTypeEl.textContent = loginid ? `${label} (${loginid})` : label;
    accountTypeEl.className = `status-value ${isVirtual ? "demo" : "real"}`;
  }
  function clearAccountTypeUI() {
    if (accountTypeEl) { accountTypeEl.textContent = "—"; accountTypeEl.className = "status-value"; }
  }

  function disconnect(reason = "User requested") {
    manualDisconnectRequested = true;
    try { ws && ws.readyState === WebSocket.OPEN && wsSend({ forget_all: "ticks" }); } catch { }
    try { ws && ws.close(); } catch { }
    clearIntervals(); authorized = false; updateConnectButton(); clearAccountTypeUI();

    openAccuId = null; openAccuBuyPrice = 0; placingTrade = false; pendingBuy = null;
    manualAccuHold = false; manualAccuHoldPending = false;
    accuTicksElapsed = 0; accuLastSpotTime = null;

    emaVol = 90; emaConsistency = 90; emaMomentum = 0;
    emaFastPrice = null; emaSlowPrice = null; prevEmaFast = null; prevEmaSlow = null;
    prevTrendState = null; trendAgeTicks = 0;

    // Reset market trend hysteresis
    stableTrend = "RANGING"; trendCandidate = "RANGING"; trendCandidateAge = 0;

    digitHistory.length = 0; priceHistory.length = 0; outcomesHistory.length = 0;
    proposalCache.clear(); eoProposalCache.clear();
    proposalInFlight.clear(); eoProposalInFlight.clear();
    strikeProposalCache.clear(); strikeProposalInFlight.clear();

    burstActive = null; seqPlan = null; lastEvenOddEval = null; flipxPendingDelay = null;

    if (tickMovementEl) tickMovementEl.innerHTML = "";
    setAccuStatus(false); setAccuPL(0); updateUILock();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    autoTradesDone = 0;
    log(`Disconnected (${reason}).`, "loss");

    // Re-open public feed so market keeps moving in UI
    openPublicFeedIfNeeded();
  }

  function connect() {
    let token = (tokenInput?.value || "").trim();
    if (!token) token = lastUsedToken || "";
    if (!token) { alert("Enter Deriv API token with Trade permission."); return; }
    lastUsedToken = token;
    manualDisconnectRequested = false;

    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(); } catch { } }

    // Helper to mask token for logs (show last 4 chars)
    const mask = (t) => {
      const s = String(t || "");
      if (s.length <= 4) return "****";
      return "****" + s.slice(-4);
    };

    // Log connection attempt with app id and masked token (no secrets in logs)
    try {
      const url = new URL(CONFIG.DERIV_WS_URL);
      const appId = url.searchParams.get("app_id") || "?";
      log(`Connecting to Deriv WS (app_id=${appId})… token=${mask(token)}`);
    } catch { log("Connecting to Deriv WS…"); }

    try {
      ws = new WebSocket(CONFIG.DERIV_WS_URL);
    } catch (e) {
      log(`Failed to create WebSocket to ${CONFIG.DERIV_WS_URL}. This can be caused by a Content Security Policy (CSP) blocking connect-src to this host. ${e?.message || e}`, "loss");
      log("If hosted on Netlify, ensure your CSP/connect-src allows wss://ws.derivws.com and the jsdelivr CDN.", "loss");
      return;
    }
    let authorizeTimer = null;

    ws.onopen = () => {
      log("WebSocket open — sending authorize…");
      wsSend({ authorize: token });
      // If authorize response never arrives, notify user
      authorizeTimer = setTimeout(() => {
        if (!authorized) {
          log("Authorization timed out. Check token validity, app_id whitelisting, and network.", "loss");
        }
      }, 12000);
    };

    ws.onerror = (e) => {
      const msg = (e && (e.message || e.reason)) ? `: ${(e.message || e.reason)}` : "";
      log(`WebSocket error${msg}`, "loss");
      try { console.error(e); } catch {}
    };

    ws.onclose = (ev) => {
      if (authorizeTimer) { clearTimeout(authorizeTimer); authorizeTimer = null; }
      clearIntervals();
      if (tickWatchdogInterval) { clearInterval(tickWatchdogInterval); tickWatchdogInterval = null; }
      authorized = false; updateConnectButton(); clearAccountTypeUI();
      openAccuId = null; placingTrade = false; pendingBuy = null; flipxPendingDelay = null;
      const code = ev?.code != null ? ev.code : "?";
      const reason = ev?.reason ? ` reason=${ev.reason}` : "";
      const clean = ev?.wasClean ? " clean" : "";
      log(`WebSocket closed (code=${code}${reason}${clean})`, "loss");

      if (!manualDisconnectRequested) {
        const delay = Math.min(CONFIG.RECONNECT_MAX_DELAY_MS, Math.pow(2, reconnectAttempts) * 1000);
        reconnectAttempts++;
        log(`Reconnecting in ${Math.round(delay / 1000)}s…`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!authorized) connect();
        }, delay);
        // Keep UI alive with public feed while reconnecting
        openPublicFeedIfNeeded();
      }
    };

    ws.onmessage = (evt) => {
      let data; try { data = JSON.parse(evt.data); } catch { return; }

      if (data.msg_type === "authorize") {
        if (authorizeTimer) { clearTimeout(authorizeTimer); authorizeTimer = null; }
        if (data.error) { log(`Authorize error: ${data.error.message} (${data.error.code || "code"})`, "loss"); return; }
        authorized = true;
        reconnectAttempts = 0;
        // Close public feed now that we have an authorized session
        closePublicFeed();
        accountCurrency = data.authorize?.currency || "USD";
        updateConnectButton();
        updateAccountTypeUI(!!data.authorize?.is_virtual, data.authorize?.loginid);
        log(`Authorized (${data.authorize?.is_virtual ? "Demo" : "Real"} ${data.authorize?.loginid || ""})`, "win");

        wsSend({ balance: 1, subscribe: 1 });
        subscribeTicks(activeSymbol);

        clearIntervals();
        wsPingInterval = setInterval(() => { try { wsSend({ ping: 1 }); } catch { } }, FAST.WS_PING_MS);
        pocWatchdogInterval = setInterval(() => {
          if (openAccuId) {
            if (Date.now() - lastPOCHeartbeat > POC_HEARTBEAT_MAX) {
              try { wsSend({ proposal_open_contract: 1, contract_id: openAccuId, subscribe: 1 }); } catch { }
              lastPOCHeartbeat = Date.now();
            }
          }
        }, FAST.POC_WATCHDOG_MS);

        // Authorized tick watchdog: resubscribe if stream stalls
        if (tickWatchdogInterval) clearInterval(tickWatchdogInterval);
        tickWatchdogInterval = setInterval(() => {
          if (!authorized) return;
          const gap = Date.now() - lastTickTs;
          if (gap > 8000) {
            try { subscribeTicks(activeSymbol); log("Tick watchdog: re-subscribed authorized feed"); } catch {}
          }
        }, 4000);

        return;
      }

      if (data.msg_type === "balance") {
        updateBalanceUI(data.balance?.balance ?? 0);
        return;
      }

      if (data.msg_type === "history" && data.history?.prices) {
        data.history.prices.forEach(p => handleTick(Number(p)));
        return;
      }

      if (data.msg_type === "tick" && data.tick?.quote) {
        handleTick(Number(data.tick.quote), data.tick.epoch, data.tick.display_value);
        return;
      }

      if (data.msg_type === "proposal") {
        if (data.error) {
          const code = data.error.code || "code";
          log(`Proposal error: ${data.error.message} (${code})`, "loss");
          // On rate limit, apply per-key backoff
          try {
            if (code === "RateLimit") {
              const ct = data.echo_req?.contract_type || "";
              const barrier = data.echo_req?.barrier != null ? String(data.echo_req.barrier) : "";
              applyRateLimitBackoff(ct, barrier);
            }
          } catch {}
          placingTrade = false; pendingBuy = null; updateUILock();
          return;
        }

        const pid = data.proposal.id;
        const ct = data.echo_req.contract_type;
        const barrier = data.echo_req.barrier != null ? String(data.echo_req.barrier) : null;
        const ask = Number(data.proposal.ask_price || 0);

        if (ct === "DIGITDIFF" && barrier != null) proposalInFlight.set(barrier, false);
        if (ct === "DIGITEVEN") eoProposalInFlight.set("EVEN", false);
        if (ct === "DIGITODD") eoProposalInFlight.set("ODD", false);
        if (ct === "DIGITOVER" && barrier === "1") strikeProposalInFlight.set("OVER1", false);
        if (ct === "DIGITUNDER" && barrier === "9") strikeProposalInFlight.set("UNDER9", false);

        if (ct === "DIGITDIFF" && barrier != null && pid) {
          const prev = proposalCache.get(barrier) || {};
          proposalCache.set(barrier, { id: pid, ts: Date.now(), stake: prev.stake, ask });
        }
        if ((ct === "DIGITEVEN" || ct === "DIGITODD") && pid) {
          const key = ct === "DIGITEVEN" ? "EVEN" : "ODD";
          const prev = eoProposalCache.get(key) || {};
          eoProposalCache.set(key, { id: pid, ts: Date.now(), stake: prev.stake, ask });
        }
        if ((ct === "DIGITOVER" || ct === "DIGITUNDER") && pid) {
          const key = ct === "DIGITOVER" ? "OVER1" : "UNDER9";
          const prev = strikeProposalCache.get(key) || {};
          strikeProposalCache.set(key, { id: pid, ts: Date.now(), stake: prev.stake, ask });
        }

        if (burstActive && ct === "DIGITDIFF" && barrier === burstActive.barrier &&
          lastTickEpoch === burstActive.epoch && Date.now() <= burstActive.expiresAt &&
          burstActive.sent < burstActive.target) {
          const cached = proposalCache.get(barrier) || {};
          const priceToUse = Number((ask ?? cached.stake ?? burstActive.stakeFallback).toFixed(2));
          try {
            wsSend({ buy: pid, price: priceToUse });
            burstActive.sent++;
            log(`Burst buy #${burstActive.sent} @ ${fmt2c(priceToUse)}`);
          } catch (e) { log("Burst buy error: " + (e.message || e), "loss"); }
          if (burstActive.sent >= burstActive.target) {
            log(`Burst complete: ${burstActive.sent}/${burstActive.target}`, "win");
            burstActive = null;
          }
        }

        if (pid && pendingBuy && ct === pendingBuy.type && (barrier ?? null) === (pendingBuy.barrier ?? null)) {
          const qty = pendingBuy.qty;
          const priceToUse = Number((ask || Math.max(CONFIG.MIN_STAKE, Number(stakeInput?.value || 1) || 1)).toFixed(2));
          try {
            lastBuyContext = { type: ct, barrier: (barrier ?? null), qty, retried: false };
            for (let i = 0; i < qty; i++) wsSend({ buy: pid, price: priceToUse });
            const tag =
              (ct === "DIGITEVEN" || ct === "DIGITODD") ? "Flip X" :
              (ct === "DIGITDIFF" ? "Z Trade" :
              (ct === "DIGITOVER" ? "Strike Pro • OVER 1" :
              (ct === "DIGITUNDER" ? "Strike Pro • UNDER 9" : ct)));
            log(`Buying ${tag}${barrier ? "/b=" + barrier : ""} x${qty} @ ${fmt2c(priceToUse)}`, "win");
          } catch (e) {
            log("Buy send error: " + (e.message || e), "loss");
          } finally {
            pendingBuy = null; placingTrade = false; updateUILock();
          }
        }
        return;
      }

      if (data.msg_type === "buy") {
        if (data.error) {
          const code = data.error.code || "code";
          log(`Buy error: ${data.error.message} (${code})`, "loss");

          const permanent = new Set(["InsufficientBalance", "AuthorizationRequired", "RateLimit", "TradingDisabled", "MarketIsClosed", "InvalidToken", "ClientInactivity", "OfferingsValidationError"]);
          if (lastBuyContext && !lastBuyContext.retried && !permanent.has(code)) {
            lastBuyContext.retried = true;
            log("Retrying buy with new proposal...");
            placingTrade = true; updateUILock();
            requestProposal(lastBuyContext.type, { barrier: lastBuyContext.barrier, buyQty: lastBuyContext.qty });
          } else {
            placingTrade = false; updateUILock();
          }
        } else {
          const cid = data.buy.contract_id;
          const type = lastRequestedType;
          placingTrade = false; updateUILock();
          if (cid) {
            wsSend({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 });
            if (type === "ACCU") {
              openAccuId = cid; openAccuBuyPrice = Number(data.buy.buy_price || 0);
              accuTicksElapsed = 0; accuLastSpotTime = null;
              if (manualAccuHoldPending) { manualAccuHold = true; manualAccuHoldPending = false; }
              else manualAccuHold = false;
              setAccuStatus(true); setAccuPL(0); setAccuGrowthLive(); setAccuTicksElapsedUI();
              log(`Bolt opened id=${cid} buy=${fmt2c(openAccuBuyPrice)}`, "win");
            } else if (type === "DIGITDIFF") log(`Z Trade contract ${cid}`, "win");
            else if (type === "DIGITEVEN" || type === "DIGITODD") log(`Flip X ${type === "DIGITEVEN" ? "EVEN" : "ODD"} contract ${cid}`, "win");
            else if (type === "DIGITOVER" || type === "DIGITUNDER") log(`Strike Pro ${type === "DIGITOVER" ? "OVER 1" : "UNDER 9"} contract ${cid}`, "win");

            // Auto batch progress
            if (autoTrade) {
              autoTradesDone++;
              if (autoTradesDone >= autoTradesPlanned) {
                autoTrade = false;
                if (autoTradeCheckbox) autoTradeCheckbox.checked = false;
                log(`Auto Trade batch complete (${autoTradesDone}/${autoTradesPlanned}). Auto Trade OFF.`, "win");
                saveSettings();
              } else {
                log(`Auto Trade progress: ${autoTradesDone}/${autoTradesPlanned}`, "win");
              }
            }
          }
        }
        return;
      }

      if (data.msg_type === "sell") {
        if (data.error) log(`Sell error: ${data.error.message}`, "loss");
        else log(`Sell confirmed for ${fmt2c(Number(data.sell?.sold_for || 0))}`);
        return;
      }

      if (data.msg_type === "proposal_open_contract") {
        const poc = data.proposal_open_contract; if (!poc) return;
        const cid = poc.contract_id; lastPOCHeartbeat = Date.now();

        if (openAccuId && cid === openAccuId && !poc.is_sold) {
          const cv = Number(poc.current_value ?? poc.bid_price ?? 0);
          const bp = Number(poc.buy_price ?? openAccuBuyPrice ?? 0);
          const running = (cv > 0 && bp > 0) ? cv - bp : 0;
          setAccuPL(running);

          const spotTime = Number(poc.current_spot_time || 0);
          if (spotTime && spotTime !== accuLastSpotTime) {
            accuLastSpotTime = spotTime; accuTicksElapsed++; setAccuTicksElapsedUI();
          }

          if (!manualAccuHold && accuAutoCloseCheckbox?.checked) {
            const tp = Math.max(0, Number(accuTakeProfitInput.value || 0));
            const sl = Math.max(0, Number(accuStopLossInput.value || 0));
            const tl = clamp(Number(accuTickLimitInput.value || 20), 1, 85);
            if (tp > 0 && running >= tp) trySellWithRetry(openAccuId);
            else if (sl > 0 && running <= -sl) trySellWithRetry(openAccuId);
            else if (accuTicksElapsed >= tl) trySellWithRetry(openAccuId);
          }
        }

        if (poc.is_sold) {
          const profit = Number(poc.profit || 0);
          if (profit > 0) { wins++; lossStreak = 0; log(`Win +${fmt2c(profit)}`, "win"); }
          else { losses++; lossStreak++; log(`Loss ${fmt2c(profit)}`, "loss"); }
          netProfit += profit; totalTrades++;
          profitSeries.push(netProfit); if (profitSeries.length > CONFIG.PROFIT_SERIES_LIMIT) profitSeries.shift();
          updateProfitUI(); updateStatsUI();

          if (openAccuId && cid === openAccuId) {
            openAccuId = null; openAccuBuyPrice = 0; manualAccuHold = false;
            accuTicksElapsed = 0; accuLastSpotTime = null;
            setAccuStatus(false); setAccuPL(0); setAccuTicksElapsedUI(); updateUILock();
          }

          if (lossStreak >= CONFIG.MAX_LOSS_STREAK) {
            autoTrade = false; if (autoTradeCheckbox) autoTradeCheckbox.checked = false;
            log(`Auto halted: loss streak ${CONFIG.MAX_LOSS_STREAK}`, "loss");
          }

          if (seqPlan) {
            if (profit <= 0 && seqPlan.stopOnLoss) {
              log("Sequential plan stopped (loss).", "loss");
              seqPlan = null; updateUILock();
            } else {
              seqPlan.remaining--;
              if (seqPlan.remaining > 0) {
                seqPlan.awaitingTick = true; seqPlan.waitEpoch = lastTickEpoch;
                log(`Sequential next pending (${seqPlan.remaining} left)…`);
              } else {
                log("Sequential plan completed.", "win");
                seqPlan = null; updateUILock();
              }
            }
          }

          const subId = poc.subscription?.id;
          if (subId) wsSend({ forget: subId });
        }
        return;
      }

      if (data.error) {
        log(`Server error: ${data.error.message} (${data.error.code || "code"})`, "loss");
      }
    };
  }

  /* ===========================================================================
     19) PERSISTENCE
     =========================================================================== */

  function saveSettings() {
    try {
      localStorage.setItem("QuantixSettings", JSON.stringify({
        symbol: activeSymbol,
        stake: stakeInput?.value || "1.00",
        auto: !!autoTradeCheckbox?.checked,
        autoCount: String(autoTradesPlanned),
        useACCU: useAccumulator,
        useDiff: useDiffersVsLast,
        useEO: useEvenOdd,
        useStrike: useStrikePro,
        conf: confThresholdInput?.value || String(CONFIG.CONFIDENCE_THRESHOLD),
        maxLS: maxLossStreakInput?.value || String(CONFIG.MAX_LOSS_STREAK),
        accuG: accuGrowthInput?.value || "1.0",
        accuTP: accuTakeProfitInput?.value || "0.50",
        accuSL: accuStopLossInput?.value || "0.00",
        accuAuto: !!accuAutoCloseCheckbox?.checked,
        accuTL: accuTickLimitInput?.value || "20",
        flipxDelay: flipxDelayTicksInput?.value || "1"
      }));
    } catch { /* ignore */ }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem("QuantixSettings");
      if (!raw) { setStrategyUI(); return; }
      const d = JSON.parse(raw);

      if (d.symbol && symbolSelect) { symbolSelect.value = d.symbol; activeSymbol = d.symbol; }
      if (stakeInput && d.stake) stakeInput.value = d.stake;
      if (autoTradeCheckbox) { autoTradeCheckbox.checked = !!d.auto; autoTrade = !!d.auto; }
      useAccumulator = !!d.useACCU;
      useDiffersVsLast = !!d.useDiff;
      useEvenOdd = !!d.useEO;
      useStrikePro = !!d.useStrike;

      if (confThresholdInput && d.conf) {
        confThresholdInput.value = d.conf;
        CONFIG.CONFIDENCE_THRESHOLD = clamp(Number(d.conf) || 85, 50, 100);
      }
      if (maxLossStreakInput && d.maxLS) {
        maxLossStreakInput.value = d.maxLS;
        CONFIG.MAX_LOSS_STREAK = Math.max(1, Number(d.maxLS) || 3);
      }
      if (accuGrowthInput && d.accuG) accuGrowthInput.value = d.accuG;
      if (accuTakeProfitInput && d.accuTP) accuTakeProfitInput.value = d.accuTP;
      if (accuStopLossInput && d.accuSL) accuStopLossInput.value = d.accuSL;
      if (accuAutoCloseCheckbox) accuAutoCloseCheckbox.checked = !!d.accuAuto;
      if (accuTickLimitInput && d.accuTL) accuTickLimitInput.value = d.accuTL;

      if (flipxDelayTicksInput && d.flipxDelay) {
        flipxDelayTicksInput.value = d.flipxDelay;
        setFlipXDelaySetting();
      }

      autoTradesPlanned = clamp(Number(d.autoCount) || 1, 1, 10);
      if (!autoTradeCountInput) {
        const grid = panelTrading?.querySelector(".trade-grid");
        if (grid) {
          const g = document.createElement("div");
          g.className = "control-group";
          g.innerHTML = `
            <label for="autoTradeCount" class="lbl">Auto Trades (1–10)</label>
            <input id="autoTradeCount" type="number" min="1" max="10" step="1" class="input" />
            <small class="hint">Number of trades to execute when Auto Trade is ON.</small>
          `;
          grid.appendChild(g);
          autoTradeCountInput = document.getElementById("autoTradeCount");
        }
      }
      if (autoTradeCountInput) autoTradeCountInput.value = String(autoTradesPlanned);
      setStrategyUI();
    } catch {
      setStrategyUI();
    }
  }

  /* ===========================================================================
     20) INIT
     =========================================================================== */

  function init() {
    loadSettings();
    updateStatsUI();
    updateProfitUI();
    drawProfitChart();
    updateConnectButton();
    clearAccountTypeUI();
    updateEtClock();
    setInterval(updateEtClock, 1000);
    updatePanelVisibility();

    // Start public market feed so Strategy Metrics/Tick Movement update before connect
    openPublicFeedIfNeeded();

    if (tickMovementEl) {
      tickMovementEl.style.justifyContent = "flex-end";
      tickMovementEl.style.alignItems = "center";
    }

    const card = $("safeEntryCard");
    if (card) card.className = "safe-entry-card state-wait";
  }

  init();

  /* ===========================================================================
     21) EVENTS
     =========================================================================== */

  // Connect/disconnect
  if (connectBtn) connectBtn.addEventListener("click", () => authorized ? disconnect("Manual") : connect());

  // Symbol change
  if (symbolSelect) symbolSelect.addEventListener("change", (e) => setActiveSymbol(e.target.value));

  // Strategy toggles
  if (toggleAccumulator) toggleAccumulator.addEventListener("change", (e) => {
    if (e.target.checked) {
      useAccumulator = true; useDiffersVsLast = false; useEvenOdd = false; useStrikePro = false; autoAdjustSymbolForStrategy("ACCU");
    } else useAccumulator = false;
    setStrategyUI(); cancelFlipXPending("strategy switch");
  });

  if (toggleDiffersVsLast) toggleDiffersVsLast.addEventListener("change", (e) => {
    if (e.target.checked) {
      useDiffersVsLast = true; useAccumulator = false; useEvenOdd = false; useStrikePro = false; autoAdjustSymbolForStrategy("DIGITDIFF");
    } else useDiffersVsLast = false;
    setStrategyUI(); cancelFlipXPending("strategy switch");
  });

  if (toggleEvenOdd) toggleEvenOdd.addEventListener("change", (e) => {
    if (e.target.checked) {
      useEvenOdd = true; useAccumulator = false; useDiffersVsLast = false; useStrikePro = false; autoAdjustSymbolForStrategy("DIGITEVEN");
    } else { useEvenOdd = false; cancelFlipXPending("strategy off"); }
    setStrategyUI();
  });

  if (toggleStrikePro) toggleStrikePro.addEventListener("change", (e) => {
    if (e.target.checked) {
      useStrikePro = true; useAccumulator = false; useDiffersVsLast = false; useEvenOdd = false; autoAdjustSymbolForStrategy("DIGITOVER");
    } else { useStrikePro = false; }
    setStrategyUI();
  });

  // Inputs & settings
  if (stakeInput) stakeInput.addEventListener("change", saveSettings);

  if (autoTradeCheckbox) autoTradeCheckbox.addEventListener("change", (e) => {
    autoTrade = !!e.target.checked;
    autoTradesDone = 0;
    if (autoTradeCountInput) autoTradesPlanned = clamp(Number(autoTradeCountInput.value) || 1, 1, 10);
    log(`AutoTrade ${autoTrade ? `ON (target ${autoTradesPlanned})` : "OFF"}`);
    saveSettings();
  });

  if (autoTradeCountInput) autoTradeCountInput.addEventListener("change", (e) => {
    autoTradesPlanned = clamp(Number(e.target.value) || 1, 1, 10);
    e.target.value = String(autoTradesPlanned);
    log(`Auto Trades planned = ${autoTradesPlanned}`);
    saveSettings();
  });

  if (confThresholdInput) confThresholdInput.addEventListener("change", (e) => {
    CONFIG.CONFIDENCE_THRESHOLD = clamp(Number(e.target.value) || 85, 50, 100);
    e.target.value = String(CONFIG.CONFIDENCE_THRESHOLD);
    log(`Confidence Threshold set ${CONFIG.CONFIDENCE_THRESHOLD}`); saveSettings();
  });

  if (maxLossStreakInput) maxLossStreakInput.addEventListener("change", (e) => {
    CONFIG.MAX_LOSS_STREAK = Math.max(1, Number(e.target.value) || 3);
    e.target.value = String(CONFIG.MAX_LOSS_STREAK);
    log(`Max Loss Streak set ${CONFIG.MAX_LOSS_STREAK}`); saveSettings();
  });

  if (accuGrowthInput) accuGrowthInput.addEventListener("change", () => { setAccuGrowthLive(); saveSettings(); });
  if (accuTakeProfitInput) accuTakeProfitInput.addEventListener("change", saveSettings);
  if (accuStopLossInput) accuStopLossInput.addEventListener("change", saveSettings);
  if (accuAutoCloseCheckbox) accuAutoCloseCheckbox.addEventListener("change", saveSettings);
  if (accuTickLimitInput) accuTickLimitInput.addEventListener("change", (e) => {
    const v = clamp(Number(e.target.value) || 20, 1, 85);
    e.target.value = v; setAccuTicksElapsedUI(); saveSettings();
  });
  if (flipxDelayTicksInput) flipxDelayTicksInput.addEventListener("change", () => {
    setFlipXDelaySetting();
    log(`Flip X tick delay = ${flipxDelaySetting}`);
    saveSettings();
  });

  // Z Trade manual buttons
  if (diffBuy1Btn) diffBuy1Btn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    if (!useDiffersVsLast) { log("Enable Z Trade first.", "loss"); return; }
    autoAdjustSymbolForStrategy("DIGITDIFF");
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Digits not offered on symbol.", "loss"); return; }
    const lastDigit = digitHistory[digitHistory.length - 1];
    if (lastDigit == null) { log("No last digit yet.", "loss"); return; }
    requestProposal("DIGITDIFF", { barrier: String(lastDigit), buyQty: 1 });
    ticksSinceLastTrade = 0;
  });

  if (diffBuy3Btn) diffBuy3Btn.addEventListener("click", startSameTickBurst);

  if (diffBuy3SeqBtn) diffBuy3SeqBtn.addEventListener("click", startSequential3);

  // Flip X buttons
  if (evenOddPlaceTradeBtn) evenOddPlaceTradeBtn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    if (!useEvenOdd) { log("Enable Flip X first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Flip X unsupported on this symbol.", "loss"); return; }
    const eo = evaluateEvenOdd();
    if (!eo || !eo.parity) { log("No parity signal yet.", "loss"); return; }
    startFlipXDelayedTrade(eo.parity, "manual", eo);
  });

  if (evenOddPlaceEvenBtn) evenOddPlaceEvenBtn.addEventListener("click", () => placeParityManual("EVEN"));
  if (evenOddPlaceOddBtn) evenOddPlaceOddBtn.addEventListener("click", () => placeParityManual("ODD"));

  // Strike Pro buttons (prefer fast buy if cached)
  if (strikePlaceTradeBtn) strikePlaceTradeBtn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    if (!useStrikePro) { log("Enable Strike Pro first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Strike Pro unsupported on this symbol.", "loss"); return; }
    if (!strikeCooldownOk()) { log("Strike Pro cooldown active. Wait a moment.", "loss"); return; }

    const sp = evaluateStrikePro();
    if (!sp || !sp.outcome) { log("No OU signal yet.", "loss"); return; }
    if (sp.confidence < CONFIG.STRIKEPRO_MIN_CONFIDENCE) {
      log(`Strike Pro confidence ${sp.confidence}% below ${CONFIG.STRIKEPRO_MIN_CONFIDENCE}%`, "loss");
      return;
    }
    if (sp.outcome === "OVER1") {
      autoAdjustSymbolForStrategy("DIGITOVER");
      const didFast = CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE && strikeBuyImmediateIfCached("OVER1");
      if (!didFast) strikeSchedule("DIGITOVER", "1");
    } else {
      autoAdjustSymbolForStrategy("DIGITUNDER");
      const didFast = CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE && strikeBuyImmediateIfCached("UNDER9");
      if (!didFast) strikeSchedule("DIGITUNDER", "9");
    }
    ticksSinceLastTrade = 0;
  });

  if (strikePlaceOverBtn) strikePlaceOverBtn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    if (!useStrikePro) { log("Enable Strike Pro first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Strike Pro unsupported on this symbol.", "loss"); return; }
    if (!strikeCooldownOk()) { log("Strike Pro cooldown active. Wait a moment.", "loss"); return; }
    autoAdjustSymbolForStrategy("DIGITOVER");
    const didFast = CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE && strikeBuyImmediateIfCached("OVER1");
    if (!didFast) strikeSchedule("DIGITOVER", "1");
    ticksSinceLastTrade = 0;
  });

  if (strikePlaceUnderBtn) strikePlaceUnderBtn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    if (!useStrikePro) { log("Enable Strike Pro first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Strike Pro unsupported on this symbol.", "loss"); return; }
    if (!strikeCooldownOk()) { log("Strike Pro cooldown active. Wait a moment.", "loss"); return; }
    autoAdjustSymbolForStrategy("DIGITUNDER");
    const didFast = CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE && strikeBuyImmediateIfCached("UNDER9");
    if (!didFast) strikeSchedule("DIGITUNDER", "9");
    ticksSinceLastTrade = 0;
  });

  // Strike Pro 3x burst buttons (same-tick burst for OU)
  function startStrikeBurst(over = true) {
    if (!authorized) { alert("Connect first"); return; }
    if (!useStrikePro) { log("Enable Strike Pro first.", "loss"); return; }
    if (!SUPPORTED.DIGITS.has(activeSymbol)) { log("Strike Pro unsupported on this symbol.", "loss"); return; }
    autoAdjustSymbolForStrategy(over ? "DIGITOVER" : "DIGITUNDER");
    const key = over ? "OVER1" : "UNDER9";
    const ct = over ? "DIGITOVER" : "DIGITUNDER";
    const barrier = over ? "1" : "9";
    let boughtFast = 0;
    if (CONFIG.STRIKEPRO_FAST_BUY_FROM_CACHE && strikeBuyImmediateIfCached(key)) {
      boughtFast = 1;
    }
    const remaining = 3 - boughtFast;
    if (remaining > 0) {
      // Request one proposal and buy the remaining quantity in one go on the same tick
      requestProposal(ct, { barrier, buyQty: remaining });
    }
    ticksSinceLastTrade = 0; lastStrikeTs = Date.now(); lastGlobalTradeTs = lastStrikeTs; startCountdown(GLOBAL_AUTO_COOLDOWN_MS);
  }
  const strikeBuy3OverBtn = $("strikeBuy3OverBtn");
  const strikeBuy3UnderBtn = $("strikeBuy3UnderBtn");
  if (strikeBuy3OverBtn) strikeBuy3OverBtn.addEventListener("click", () => startStrikeBurst(true));
  if (strikeBuy3UnderBtn) strikeBuy3UnderBtn.addEventListener("click", () => startStrikeBurst(false));

  // Bolt buy/sell
  if (buyAccuBtn) buyAccuBtn.addEventListener("click", () => {
    if (!authorized) { alert("Connect first"); return; }
    autoAdjustSymbolForStrategy("ACCU");
    if (!SUPPORTED.ACCU.has(activeSymbol)) { log("Bolt unsupported on this symbol.", "loss"); return; }

    if (openAccuId) {
      trySellWithRetry(openAccuId);
    } else {
      manualAccuHoldPending = true; // user-controlled unless auto-close triggers first
      requestProposal("ACCU", { buyQty: 1 });
    }
  });

  // Clear history and stats
  if (clearHistoryBtn) clearHistoryBtn.addEventListener("click", () => {
    totalTrades = 0; wins = 0; losses = 0; lossStreak = 0; netProfit = 0;
    profitSeries.length = 0; profitSeries.push(0);
    updateStatsUI(); updateProfitUI();
    log("Trade history cleared.");
  });

  // Before unload, clean up socket
  window.addEventListener("beforeunload", () => {
    if (authorized) {
      try { wsSend({ forget_all: "ticks" }); } catch { }
      try { ws && ws.close(); } catch { }
    }
  });

})();