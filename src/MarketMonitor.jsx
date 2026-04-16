import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { LineChart, Line, ResponsiveContainer, Tooltip, AreaChart, Area } from "recharts";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const INTERVALS = {
  PRICES_OPEN:   12 * 1000,   // 12s during market hours — faster than 5s TTL on backend
  PRICES_CLOSED: 60 * 1000,   // 60s when market is closed — save quota
  NEWS:          60 * 1000,
  SOCIAL:       120 * 1000,
  MOMENTUM_OPEN:  45 * 1000,  // 45s for stock momentum during session
  MOMENTUM_CLOSED: 5 * 60 * 1000, // 5min when closed
};

// ─────────────────────────────────────────────
// CENTRAL MARKET DATA STORE
// ─────────────────────────────────────────────
// _priceCache is the single source of truth for all asset data.
//
// Shape per asset id:
//   { price, change (% 24h), percentChange, prevClose, openPrice,
//     source, confidence, status, cached, isFallback, timestamp,
//     marketState, klines? }
//
// Write path (in order of authority):
//   1. useMarketData init — Binance REST 24hr + klines (BTC/ETH)
//   2. useMarketData WS handler — Binance real-time ticks (BTC/ETH)
//   3. fetchAndUpdate polling — Vercel /api/prices (all assets, 35s)
//
// Read path:
//   useMarketData returns `assets[]` derived from this cache.
//   All components receive assets as props — NO component fetches directly.
//   Exceptions: useFearGreed, useLeveragedAssets, useStockMomentum
//   (these are non-market auxiliary data sources, not price data)
//
// NEVER write to _priceCache from inside a component.
const _priceCache = {};

// ─────────────────────────────────────────────
// ALERT THRESHOLDS
// ─────────────────────────────────────────────
const ALERT_THRESHOLDS = {
  VIX_WARNING: 20, VIX_DANGER: 25, VIX_EXTREME: 30,
  OIL_MOVE_PCT: 3, CRYPTO_MOVE_PCT: 5, VOLUME_SPIKE_MULTIPLIER: 2.5,
};

const ALERT_COOLDOWNS = {
  VIX_EXTREME: 5 * 60 * 1000, VIX_DANGER: 5 * 60 * 1000,
  OIL_SPIKE: 3 * 60 * 1000,   CRYPTO_MOVE: 2 * 60 * 1000,
};

// ─────────────────────────────────────────────
// TRADE JOURNAL SNAPSHOT
// ─────────────────────────────────────────────

const JOURNAL_KEY    = "trade_journal_snapshots";
const JOURNAL_MAX    = 50; // keep last 50 entries

/**
 * captureSnapshot({ assets, regime, lagSignals })
 * Pure function — builds a complete market conditions object.
 * Caller stores the result; no side effects here.
 */
function captureSnapshot({ assets, regime, lagSignals = [] }) {
  const btc = assets.find(a => a.id === "BTC");
  const spy = assets.find(a => a.id === "SPY");
  const vix = assets.find(a => a.id === "VIX");
  const eth = assets.find(a => a.id === "ETH");
  const wti = assets.find(a => a.id === "WTI");
  const gold= assets.find(a => a.id === "GOLD");

  const leverageRisk = calculateLeverageRisk({
    btcChange:    btc?.change    ?? 0,
    btcSparkline: btc?.sparkline ?? [],
    vixPrice:     vix?.price     ?? 15,
  });

  const setup = detectSetup({
    regime,
    btcChange:  btc?.change  ?? 0,
    vixPrice:   vix?.price   ?? 15,
    vixChange:  vix?.change  ?? 0,
    lagSignals: lagSignals.map(s => s.signal ?? s),
  });

  const anyLag = lagSignals.find(s => (s.signal?.status ?? s.status) !== "IN_SYNC");

  return {
    id:        `snap_${Date.now()}`,
    timestamp:  new Date().toISOString(),
    regime,
    prices: {
      BTC:  btc?.price,  SPY:  spy?.price,
      VIX:  vix?.price,  ETH:  eth?.price,
      WTI:  wti?.price,  GOLD: gold?.price,
    },
    changes: {
      BTC:  btc?.change, SPY:  spy?.change,
      VIX:  vix?.change, ETH:  eth?.change,
    },
    leverageRisk: {
      level: leverageRisk.level,
      score: leverageRisk.score,
    },
    setup: setup.type ? {
      type:       setup.type,
      confidence: setup.confidence,
      message:    setup.message,
    } : null,
    lagSignal: anyLag ? {
      asset:  anyLag.id,
      status: anyLag.signal?.status ?? anyLag.status,
    } : null,
    notes: "",   // user can add notes later (future feature)
  };
}

function loadJournal() {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || "[]");
  } catch { return []; }
}

function saveJournal(entries) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries.slice(0, JOURNAL_MAX)));
  } catch {}
}

function addJournalEntry(snapshot) {
  const entries = [snapshot, ...loadJournal()];
  saveJournal(entries);
  return entries;
}

// ─────────────────────────────────────────────
// MARKET REGIME ENGINE
// ─────────────────────────────────────────────

/**
 * getMarketRegime(data) — pure function, no side effects
 *
 * Inputs:
 *   vixPrice  : current VIX level
 *   vixChange : VIX 24h % change
 *   spyChange : SPY 24h % change
 *   btcChange : BTC 24h % change
 *
 * Rules:
 *   RISK ON  — VIX < 18 AND SPY rising AND BTC rising
 *   RISK OFF — VIX > 25 OR (VIX rising sharply AND SPY falling)
 *   NEUTRAL  — everything else
 *
 * Confidence:
 *   HIGH   — all signals agree strongly
 *   MEDIUM — majority of signals agree
 *   LOW    — mixed signals
 */
function getMarketRegime({ vixPrice, vixChange, spyChange, btcChange }) {
  // Guard: if data is missing, return neutral with low confidence
  if (vixPrice == null || spyChange == null) {
    return { regime: "NEUTRAL", confidence: "LOW", signals: [], reason: "Insufficient data" };
  }

  const signals = [];

  // ── VIX signals ──────────────────────────────────────────────
  if (vixPrice < 16)       signals.push({ name: "VIX",    direction: "RISK_ON",  weight: 2, detail: `VIX ${vixPrice} (very low)` });
  else if (vixPrice < 20)  signals.push({ name: "VIX",    direction: "RISK_ON",  weight: 1, detail: `VIX ${vixPrice} (low)` });
  else if (vixPrice > 30)  signals.push({ name: "VIX",    direction: "RISK_OFF", weight: 2, detail: `VIX ${vixPrice} (extreme fear)` });
  else if (vixPrice > 25)  signals.push({ name: "VIX",    direction: "RISK_OFF", weight: 2, detail: `VIX ${vixPrice} (elevated)` });
  else                     signals.push({ name: "VIX",    direction: "NEUTRAL",  weight: 1, detail: `VIX ${vixPrice} (neutral zone)` });

  // VIX momentum — spike is an early warning
  if (vixChange > 10)      signals.push({ name: "VIX MOM", direction: "RISK_OFF", weight: 1, detail: `VIX +${vixChange.toFixed(1)}% (spiking)` });
  else if (vixChange < -5) signals.push({ name: "VIX MOM", direction: "RISK_ON",  weight: 1, detail: `VIX ${vixChange.toFixed(1)}% (falling)` });

  // ── SPY signals ──────────────────────────────────────────────
  if (spyChange > 1)       signals.push({ name: "SPY",    direction: "RISK_ON",  weight: 2, detail: `SPY +${spyChange.toFixed(2)}% (rising)` });
  else if (spyChange > 0)  signals.push({ name: "SPY",    direction: "RISK_ON",  weight: 1, detail: `SPY +${spyChange.toFixed(2)}% (slightly up)` });
  else if (spyChange < -1) signals.push({ name: "SPY",    direction: "RISK_OFF", weight: 2, detail: `SPY ${spyChange.toFixed(2)}% (falling)` });
  else                     signals.push({ name: "SPY",    direction: "NEUTRAL",  weight: 1, detail: `SPY ${spyChange.toFixed(2)}% (flat)` });

  // ── BTC signals (risk appetite proxy) ────────────────────────
  if (btcChange != null) {
    if (btcChange > 3)     signals.push({ name: "BTC",    direction: "RISK_ON",  weight: 1, detail: `BTC +${btcChange.toFixed(2)}% (leading)` });
    else if (btcChange < -3) signals.push({ name: "BTC",  direction: "RISK_OFF", weight: 1, detail: `BTC ${btcChange.toFixed(2)}% (selling)` });
  }

  // ── Score signals ─────────────────────────────────────────────
  let riskOnScore  = 0;
  let riskOffScore = 0;
  let totalWeight  = 0;

  for (const s of signals) {
    totalWeight += s.weight;
    if (s.direction === "RISK_ON")  riskOnScore  += s.weight;
    if (s.direction === "RISK_OFF") riskOffScore += s.weight;
  }

  // Hard override: extreme VIX always = RISK OFF
  if (vixPrice > 30) {
    return {
      regime: "RISK OFF", confidence: "HIGH", signals,
      reason: `VIX at ${vixPrice} — extreme fear`,
    };
  }

  // Determine regime
  let regime;
  const riskOnPct  = totalWeight > 0 ? riskOnScore  / totalWeight : 0;
  const riskOffPct = totalWeight > 0 ? riskOffScore / totalWeight : 0;

  if (riskOnPct >= 0.55 && vixPrice < 20)       regime = "RISK ON";
  else if (riskOffPct >= 0.55 || vixPrice > 25) regime = "RISK OFF";
  else                                           regime = "NEUTRAL";

  // Determine confidence
  const dominance = Math.max(riskOnPct, riskOffPct);
  const confidence = dominance >= 0.75 ? "HIGH" : dominance >= 0.55 ? "MEDIUM" : "LOW";

  // Build reason string from top signals
  const topSignals = signals
    .filter(s => s.direction === regime.replace(" ", "_"))
    .map(s => s.detail)
    .slice(0, 2)
    .join(". ");

  return { regime, confidence, signals, reason: topSignals || "Mixed signals" };
}

// ─────────────────────────────────────────────
// MARKET REGIME CARD component
// ─────────────────────────────────────────────
const REGIME_CONFIG = {
  "RISK ON":  { color: "#00ff88", bg: "rgba(0,255,136,0.06)",  border: "rgba(0,255,136,0.2)",  glow: "#00ff88" },
  "NEUTRAL":  { color: "#ffd700", bg: "rgba(255,215,0,0.06)",  border: "rgba(255,215,0,0.2)",  glow: "#ffd700" },
  "RISK OFF": { color: "#ff4466", bg: "rgba(255,68,102,0.06)", border: "rgba(255,68,102,0.2)", glow: "#ff4466" },
};

const MarketRegimeCard = memo(({ assets, onRegimeChange }) => {
  const spy = assets.find(a => a.id === "SPY");
  const vix = assets.find(a => a.id === "VIX");
  const btc = assets.find(a => a.id === "BTC");

  const result = getMarketRegime({
    vixPrice:  vix?.price  ?? null,
    vixChange: vix?.change ?? null,
    spyChange: spy?.change ?? null,
    btcChange: btc?.change ?? null,
  });

  const cfg = REGIME_CONFIG[result.regime] ?? REGIME_CONFIG["NEUTRAL"];

  // Sync riskMode toggle to regime — notify parent
  useEffect(() => {
    if (result.regime === "RISK ON")  onRegimeChange?.("on");
    if (result.regime === "RISK OFF") onRegimeChange?.("off");
  }, [result.regime]);

  const confidenceColor = result.confidence === "HIGH" ? cfg.color : result.confidence === "MEDIUM" ? "#ffd700" : "#555";

  return (
    <div style={{
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 8, padding: "14px 16px",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
            background: cfg.color, boxShadow: `0 0 10px ${cfg.glow}`,
            animation: result.regime === "RISK OFF" ? "pulse 1s infinite" : "none",
          }} />
          <div>
            <div style={{ fontSize: 9, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Market Regime</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: cfg.color, fontFamily: "'Space Mono', monospace", letterSpacing: 1, lineHeight: 1.2 }}>
              {result.regime}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "#555", letterSpacing: 1, fontFamily: "'Space Mono', monospace" }}>CONFIDENCE</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: confidenceColor, fontFamily: "'Space Mono', monospace" }}>{result.confidence}</div>
        </div>
      </div>

      {/* Reason */}
      <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>{result.reason}</div>

      {/* Signal pills */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {result.signals.map((s, i) => {
          const sc = s.direction === "RISK_ON" ? "#00ff88" : s.direction === "RISK_OFF" ? "#ff4466" : "#ffd700";
          return (
            <span key={i} style={{
              fontSize: 9, padding: "2px 7px", borderRadius: 3,
              background: `rgba(${sc === "#00ff88" ? "0,255,136" : sc === "#ff4466" ? "255,68,102" : "255,215,0"},0.1)`,
              color: sc, border: `1px solid ${sc}33`,
              fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
            }}>{s.name}: {s.direction.replace("_", " ")}</span>
          );
        })}
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────
// SOUND
// ─────────────────────────────────────────────
let _audioCtx = null;
const getAudioCtx = () => {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
};
const playBeep = (freq = 880, duration = 0.15, volume = 0.3) => {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = "sine";
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
  } catch (_) {}
};
const ALERT_SOUNDS = {
  critical: () => { playBeep(440, 0.2, 0.4); setTimeout(() => playBeep(330, 0.3, 0.4), 250); },
  danger:   () => playBeep(660, 0.2, 0.3),
  warning:  () => playBeep(880, 0.12, 0.25),
  info:     () => playBeep(1100, 0.08, 0.2),
};

// ─────────────────────────────────────────────
// ASSET META + MOCK DATA
// ─────────────────────────────────────────────
const ASSET_META = [
  { id: "VIX",  label: "VIX",        category: "fear",      unit: "",  vol: 0.04,  changePeriod: "TODAY" },
  { id: "SPY",  label: "S&P 500",    category: "equity",    unit: "$", vol: 0.008, changePeriod: "TODAY" },
  { id: "QQQ",  label: "Nasdaq",     category: "equity",    unit: "$", vol: 0.01,  changePeriod: "TODAY" },
  { id: "BTC",  label: "Bitcoin",    category: "crypto",    unit: "$", vol: 0.025, changePeriod: "24H"   },
  { id: "ETH",  label: "Ethereum",   category: "crypto",    unit: "$", vol: 0.03,  changePeriod: "24H"   },
  { id: "WTI",  label: "Crude Oil",  category: "commodity", unit: "$", vol: 0.015, changePeriod: "TODAY" },
  { id: "GOLD", label: "Gold",       category: "commodity", unit: "$", vol: 0.008, changePeriod: "TODAY" },
  { id: "DXY",  label: "USD Index",  category: "currency",  unit: "",  vol: 0.005, changePeriod: "TODAY" },
  { id: "TNX",  label: "10Y Yield",  category: "bonds",     unit: "%", vol: 0.008, changePeriod: "TODAY" },
];

const MOCK_PRICES = {
  VIX:  { price: 17.04,   change: 0.00  },
  SPY:  { price: 679.46,  change: -0.07 },
  QQQ:  { price: 578.32,  change: -0.12 },
  BTC:  { price: 84320.00,change: 0.00  },
  ETH:  { price: 1580.00, change: 0.00  },
  WTI:  { price: 96.57,   change: -1.33 },
  GOLD: { price: 3230.00, change: 0.16  },
  DXY:  { price: 98.87,   change: -0.15 },
  TNX:  { price: 4.34,    change: -0.09 },
};

const MOCK_NEWS = [
  { id: 1, headline: "Fed signals potential rate pause as inflation data cools", source: "Reuters", time: "2m ago", sentiment: "neutral" },
  { id: 2, headline: "OPEC+ considers surprise output cut ahead of winter demand", source: "Bloomberg", time: "8m ago", sentiment: "bearish" },
  { id: 3, headline: "Bitcoin ETF sees record $840M inflows as institutional demand surges", source: "CoinDesk", time: "12m ago", sentiment: "bullish" },
  { id: 4, headline: "Treasury yields spike as debt ceiling negotiations stall in Congress", source: "WSJ", time: "19m ago", sentiment: "risk-off" },
  { id: 5, headline: "Tech earnings beat estimates; NVDA surges 7% in after-hours trading", source: "CNBC", time: "24m ago", sentiment: "bullish" },
  { id: 6, headline: "Geopolitical tensions escalate: NATO emergency session called", source: "FT", time: "31m ago", sentiment: "risk-off" },
  { id: 7, headline: "China GDP misses expectations; Yuan weakens to 3-month low", source: "Reuters", time: "45m ago", sentiment: "bearish" },
  { id: 8, headline: "Dollar weakens as safe-haven flows shift to gold and yen", source: "Bloomberg", time: "52m ago", sentiment: "risk-off" },
];

const MOCK_SOCIAL = [
  { id: 1, handle: "@realDonaldTrump", name: "Donald Trump", avatar: "DT", platform: "Truth Social", time: "4m ago", text: "The Fed is DESTROYING our economy with high interest rates. CUT RATES NOW! The stock market is being held hostage. SAD!", tags: ["rates", "fed"] },
  { id: 2, handle: "@elonmusk", name: "Elon Musk", avatar: "EM", platform: "X", time: "11m ago", text: "The national debt is the real crisis. $34 trillion and climbing. This is unsustainable. At some point, the music stops.", tags: ["crash", "inflation"] },
  { id: 3, handle: "@federalreserve", name: "Federal Reserve", avatar: "FR", platform: "X", time: "1h ago", text: "FOMC Statement: The Committee decided to maintain the target range for the federal funds rate at 5.25-5.5%. Inflation remains elevated.", tags: ["rates", "fed", "inflation"] },
  { id: 4, handle: "@LynAldenContact", name: "Lyn Alden", avatar: "LA", platform: "X", time: "1h ago", text: "Oil supply tightness combined with dollar strength divergence is historically a precursor to volatility. Watch the spread.", tags: ["oil", "inflation"] },
  { id: 5, handle: "@zerohedge", name: "ZeroHedge", avatar: "ZH", platform: "X", time: "2h ago", text: "BREAKING: Credit default swaps on regional banks surging to highest levels since March 2023. Something is happening under the surface.", tags: ["crash", "bank", "crisis"] },
  { id: 6, handle: "@RaoulGMI", name: "Raoul Pal", avatar: "RP", platform: "X", time: "2h ago", text: "The liquidity cycle is turning. Global M2 is starting to expand again. Historically this is THE signal for risk assets. $BTC leading.", tags: ["rates", "inflation"] },
];

// ─────────────────────────────────────────────
// MARKET HOURS HELPER (ET timezone)
// ─────────────────────────────────────────────
const getMarketStatus = () => {
  const now = new Date();
  // Convert to ET (UTC-4 EDT / UTC-5 EST)
  const etOffset = -5 * 60; // EST base
  const isDST = (() => {
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    return now.getTimezoneOffset() < Math.max(jan, jul);
  })();
  const etMs = now.getTime() + (now.getTimezoneOffset() + etOffset + (isDST ? 60 : 0)) * 60000;
  const et = new Date(etMs);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const mins = et.getHours() * 60 + et.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = mins >= 9 * 60 + 30 && mins < 16 * 60;
  return { isOpen: isWeekday && isMarketHours, et };
};
const generateSparkline = (base, volatility = 0.02, points = 24) => {
  const data = []; let val = base;
  for (let i = 0; i < points; i++) {
    val = val * (1 + (Math.random() - 0.5) * volatility);
    data.push({ v: parseFloat(val.toFixed(2)), t: i });
  }
  return data;
};

// ─────────────────────────────────────────────
// API FETCHERS
// ─────────────────────────────────────────────

// All prices now fetched server-side via Vercel function — no CORS issues
const fetchAllPrices = async ({ skipVIX = false } = {}) => {
  try {
    const url = skipVIX ? "/api/prices?skipVIX=1" : "/api/prices";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`/api/prices ${res.status}`);
    const json = await res.json();

    const data = json.assets ?? json;

    // Persist systemStatus and marketOpen on cache so hooks can read it
    if (json.systemStatus) _priceCache._systemStatus = json.systemStatus;
    if (typeof json.marketOpen === "boolean") _priceCache._marketOpen = json.marketOpen;

    // ── Frontend validation guard ──────────────────────────────────
    // Catches any bad data before it reaches _priceCache and poisons the UI.
    // The backend runs scoreAndValidate() already, but defensive checks here
    // catch edge cases like 0-prices from cold-start fallbacks.
    //
    // Thresholds:
    //   Crypto  (category="crypto")  : extreme move = >25% (volatile asset)
    //   Equities/Macro               : extreme move = >15%
    //   VIX                          : exempt from extreme-move check (VIX can spike 30%+ in a day)
    const EXTREME_MOVE_CRYPTO  = 25;
    const EXTREME_MOVE_EQUITY  = 15;
    const EXEMPT_EXTREME       = new Set(["VIX"]);  // VIX can legitimately spike >15% in a day

    Object.entries(data).forEach(([id, val]) => {
      const price = val?.price;
      const pct   = Math.abs(val?.percentChange ?? val?.change ?? 0);
      const meta  = ASSET_META.find(m => m.id === id);

      // Rule 1: reject null / zero price
      if (!price || price === 0) {
        console.warn(`[VALIDATE FE] ${id}: REJECTED — null/zero price (${price})`);
        return;  // skip write to _priceCache
      }

      // Rule 2: reject extreme moves (unless VIX or already flagged as error/fallback)
      if (!EXEMPT_EXTREME.has(id) && val?.status !== "error") {
        const threshold = meta?.category === "crypto" ? EXTREME_MOVE_CRYPTO : EXTREME_MOVE_EQUITY;
        if (pct > threshold) {
          console.warn(`[VALIDATE FE] ${id}: REJECTED — extreme move ${pct.toFixed(1)}% > ${threshold}% threshold`);
          // Don't write — keep last valid value in cache
          return;
        }
      }

      // Rule 3: mark as stale if price hasn't changed in >2 minutes during market hours
      // (catches frozen feeds that return the same price repeatedly)
      const prev      = _priceCache[id];
      const isMktOpen = _priceCache._marketOpen ?? false;
      let staleFrozen = false;
      if (isMktOpen && prev?.price === price && prev?.frozenSince) {
        const frozenMs = Date.now() - prev.frozenSince;
        if (frozenMs > 2 * 60 * 1000) {
          staleFrozen = true;
          console.warn(`[VALIDATE FE] ${id}: FROZEN — price unchanged for ${Math.round(frozenMs/1000)}s during market hours`);
        }
      }
      const frozenSince = (prev?.price === price) ? (prev?.frozenSince ?? Date.now()) : undefined;

      const change = val.percentChange ?? val.change ?? 0;
      _priceCache[id] = {
        ...val,
        change,
        frozenSince,
        stale: val.stale || staleFrozen,
      };
      console.log(`[Price] ${id}: $${price} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%) | src=${val.source ?? "?"} | stale=${val.stale ?? staleFrozen} | fallback=${val.isFallback ?? false}`);
    });
  } catch (e) {
    console.warn("[fetchAllPrices]", e.message);
  }

  return ASSET_META.map(meta => {
    const c = _priceCache[meta.id];
    // Hardened: always resolve to percentChange (%) — never dollar change
    // percentChange is explicitly set by all sources (Binance/Finnhub/FMP/Yahoo)
    const pct = parseFloat((c?.percentChange ?? c?.change ?? MOCK_PRICES[meta.id].change).toFixed(2));
    return {
      ...meta,
      price:        parseFloat((c?.price    ?? MOCK_PRICES[meta.id].price).toFixed(2)),
      change:       pct,          // % — this is what the UI renders everywhere
      percentChange:pct,          // explicit alias for clarity
      marketState:  c?.marketState ?? "CLOSED",
      prevClose:    c?.prevClose   ?? null,
      source:       c?.source      ?? "fallback",
      timestamp:    c?.timestamp   ?? null,
      status:       c?.status      ?? "valid",
      confidence:   c?.confidence  ?? "low",
      cached:       c?.cached      ?? false,
      isFallback:   c?.isFallback  ?? false,
      stale:        c?.stale       ?? false,
      dataAge:      c?.dataAge     ?? null,
      frozenSince:  c?.frozenSince ?? undefined,  // set when price unchanged during market hours
    };
  });
};

// Fear & Greed: Alternative.me (small payload, no CORS issues)
const fetchFearGreed = async () => {
  const res = await fetch("https://api.alternative.me/fng/?limit=1");
  if (!res.ok) throw new Error(`FearGreed ${res.status}`);
  const data = await res.json();
  return { value: parseInt(data.data[0].value), label: data.data[0].value_classification };
};

const fetchNews = async () => {
  // NewsAPI requires a key — returns mock news if unavailable (CORS blocks browser use anyway)
  const NEWS_API_KEY = "";  // paste newsapi.org key here to enable live news
  if (!NEWS_API_KEY) return MOCK_NEWS;
  try {
    const q = encodeURIComponent("federal reserve OR inflation OR oil OR geopolitical OR bitcoin");
    const res = await fetch(`https://newsapi.org/v2/everything?q=${q}&pageSize=20&sortBy=publishedAt&language=en&apiKey=${NEWS_API_KEY}`);
    const data = await res.json();
    return (data.articles || []).map((a, i) => ({
      id: i + 1, headline: a.title, source: a.source?.name ?? "Unknown",
      time: `${Math.floor((Date.now() - new Date(a.publishedAt)) / 60000)}m ago`,
      sentiment: ["crash","fall","drop"].some(w => a.title?.toLowerCase().includes(w)) ? "bearish"
               : ["surge","rally","gain"].some(w => a.title?.toLowerCase().includes(w)) ? "bullish" : "neutral",
    }));
  } catch (e) { console.warn("[NewsAPI]", e.message); return MOCK_NEWS; }
};

const fetchSocialFeed = async () => {
  // Social feed via /api/social endpoint (Vercel function) — returns MOCK_SOCIAL if unavailable
  try {
    const res = await fetch("/api/social");
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) { return MOCK_SOCIAL; }
};

// ─────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────

// Binance WebSocket — works on deployed sites, blocked on localhost
const BINANCE_STREAMS  = "btcusdt@ticker/ethusdt@ticker";
const BINANCE_WS_URL = `wss://data-stream.binance.vision/stream?streams=${BINANCE_STREAMS}`;
const BINANCE_ID_MAP   = { BTCUSDT: "BTC", ETHUSDT: "ETH" };
const IS_LOCALHOST     = typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

// ─────────────────────────────────────────────
// CRYPTO BASELINE CACHE
// Stores 24h open price per symbol so WS % change
// is always calculated from a real reference point.
// Persisted to localStorage to eliminate cold-start flicker.
// ─────────────────────────────────────────────
const BASELINE_KEY = "mm_crypto_baseline_v1";
const BASELINE_TTL = 60 * 60 * 1000; // 1 hour — openPrice resets each UTC day anyway

const BINANCE_INIT_SYMBOLS = [
  { id: "BTC", symbol: "BTCUSDT" },
  { id: "ETH", symbol: "ETHUSDT" },
];

function loadBaselines() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (!raw) return {};
    const { ts, data } = JSON.parse(raw);
    // Discard if older than TTL — openPrice would have rolled to a new UTC day
    if (Date.now() - ts > BASELINE_TTL) return {};
    return data;
  } catch { return {}; }
}

function saveBaselines(data) {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

// Fetches 24hr stats from Binance for BTC + ETH.
// Returns { BTC: { price, change, percentChange, prevClose, openPrice }, ETH: ... }
async function fetchCryptoBaselines() {
  const results = {};
  await Promise.all(BINANCE_INIT_SYMBOLS.map(async ({ id, symbol }) => {
    try {
      const res  = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const d    = await res.json();
      const price        = parseFloat(parseFloat(d.lastPrice).toFixed(2));
      const openPrice    = parseFloat(parseFloat(d.openPrice).toFixed(2));
      const percentChange= parseFloat(parseFloat(d.priceChangePercent).toFixed(2));
      const dollarChange = parseFloat(parseFloat(d.priceChange).toFixed(2));
      const prevClose    = parseFloat(parseFloat(d.prevClosePrice).toFixed(2));
      if (!price || !openPrice) throw new Error("zero price");
      results[id] = { price, openPrice, percentChange, dollarChange, prevClose,
        change: percentChange,  // `change` = % everywhere in this codebase
        source: "Binance", confidence: "high", status: "valid",
        marketState: "REGULAR", cached: false,
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      console.warn(`[baseline] ${id}: ${e.message}`);
    }
  }));
  return results;
}

/**
 * fetchCryptoKlines(symbol, limit = 24)
 * Fetches real 1h candles from Binance klines endpoint.
 * Returns array of { v: closePrice, t: openTime } — matches sparkline format.
 * Falls back to null on any error so caller can use generated sparkline instead.
 */
async function fetchCryptoKlines(symbol, interval = "1h", limit = 24) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status}`);
    const candles = await res.json();
    return candles.map(c => ({
      v: parseFloat(parseFloat(c[4]).toFixed(2)),
      t: c[0],
    }));
  } catch (e) {
    console.warn(`[klines] ${symbol} ${interval}: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// TIMEFRAME CONFIG
// Maps label → Binance interval + candle count
// ─────────────────────────────────────────────
const TIMEFRAMES = {
  "1H":  { interval: "5m",  limit: 12, label: "1H",  desc: "5-min candles, 1 hour"  },
  "4H":  { interval: "15m", limit: 16, label: "4H",  desc: "15-min candles, 4 hours" },
  "24H": { interval: "1h",  limit: 24, label: "24H", desc: "1-hour candles, 24 hours" },
};
const DEFAULT_TIMEFRAME = "24H";

// Fetches klines for a given timeframe for both BTC and ETH.
// Returns { BTC: [...], ETH: [...] } — null entries on fetch failure.
async function fetchKlinesForTimeframe(tf) {
  const cfg = TIMEFRAMES[tf];
  if (!cfg) return {};
  const [btc, eth] = await Promise.all([
    fetchCryptoKlines("BTCUSDT", cfg.interval, cfg.limit).catch(() => null),
    fetchCryptoKlines("ETHUSDT", cfg.interval, cfg.limit).catch(() => null),
  ]);
  return { BTC: btc, ETH: eth };
}

const useMarketData = (isPaused = false) => {
  // Seed from localStorage cache so crypto shows real values + sparklines instantly on reload
  const [assets, setAssets] = useState(() => {
    const saved = loadBaselines();
    return ASSET_META.map(meta => {
      const base = saved[meta.id];
      // Restore real sparkline from cached klines if available,
      // otherwise fall back to generated sparkline (will be replaced on first fetch)
      let sparkline;
      if (base?.klines?.length >= 2) {
        sparkline = base.klines.map(k => ({ ...k }));
      } else {
        sparkline = generateSparkline(base?.price ?? MOCK_PRICES[meta.id].price, meta.vol);
      }
      return {
        ...meta,
        price:     base?.price    ?? MOCK_PRICES[meta.id].price,
        change:    base?.change   ?? MOCK_PRICES[meta.id].change,
        prevClose: base?.prevClose ?? null,
        source:    base?.source   ?? null,
        sparkline,
        loading: !base,
      };
    });
  });
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [error, setError]               = useState(null);
  const [wsConnected, setWsConnected]   = useState(false);
  const [timeframe, setTimeframe]       = useState(DEFAULT_TIMEFRAME);
  const abortRef       = useRef(null);
  const wsRef          = useRef(null);
  const wsReconnectRef = useRef(null);
  // Cache fetched klines per timeframe so switching back is instant
  const klinesCache    = useRef({});  // { "1H": { BTC: [...], ETH: [...] }, ... }

  // Apply a klines result set to asset sparklines in state
  const applyKlines = useCallback((klinesMap, livePrice) => {
    setAssets(prev => prev.map(asset => {
      const klines = klinesMap[asset.id];
      if (!klines?.length) return asset;
      const sparkline = klines.map(k => ({ ...k }));
      // Pin last point to current live price so sparkline tail matches price card
      const live = livePrice?.[asset.id] ?? asset.price;
      sparkline[sparkline.length - 1] = { v: live, t: Date.now() };
      return { ...asset, sparkline };
    }));
  }, []);

  // ── update one asset in state + cache ───────────────────────────────
  const updateAsset = useCallback((id, normalized) => {
    // Sanity guard: reject any update where % change is implausibly large.
    // Binance 24h rolling window should never exceed ~50% for BTC/ETH.
    // This catches any future field-mapping bugs before they corrupt the UI.
    const pct = Math.abs(normalized.change ?? 0);
    if (pct > 50) {
      console.warn(`[updateAsset] REJECTED ${id}: change=${normalized.change}% exceeds 50% sanity limit`);
      return;
    }
    _priceCache[id] = normalized;
    setAssets(prev => prev.map(asset => {
      if (asset.id !== id) return asset;
      // For WS ticks, update the LAST sparkline point with the new price
      // rather than rolling the entire array. Rolling would exhaust a 12-point
      // 1H sparkline in minutes. The array only rolls when fetchAndUpdate
      // adds a genuinely new candle period.
      const spark = asset.sparkline;
      const newSparkline = spark.length > 0
        ? [...spark.slice(0, -1), { v: normalized.price, t: Date.now() }]
        : [{ v: normalized.price, t: Date.now() }];
      return {
        ...asset,
        price:       normalized.price,
        change:      normalized.change,
        source:      normalized.source,
        confidence:  normalized.confidence,
        status:      normalized.status,
        timestamp:   normalized.timestamp,
        cached:      normalized.cached,
        sparkline:   newSparkline,
        flash:       normalized.price > asset.price ? "up" : normalized.price < asset.price ? "down" : null,
        loading:     false,
      };
    }));
    setLastUpdated(new Date());
  }, []);

  // ── Binance WebSocket (deployed only) ───────────────────────────────
  const connectWS = useCallback(() => {
    if (IS_LOCALHOST) return; // skip on localhost — Binance blocks it
    if (wsRef.current) wsRef.current.close();
    const ws = new WebSocket(BINANCE_WS_URL);
    wsRef.current = ws;
    ws.onopen  = () => { setWsConnected(true); setError(null); };
    ws.onmessage = (e) => {
      try {
        const tick = JSON.parse(e.data).data;
        if (!tick?.s) return;
        const id = BINANCE_ID_MAP[tick.s];
        if (!id) return;

        // Normalize Binance tick to match backend standardized shape.
        // IMPORTANT: `change` in our system = 24h % change (used everywhere as %).
        // tick.P = 24h priceChangePercent (%), tick.p = 24h priceChange ($).
        // tick.o = 24h open price — the authoritative baseline for % calculation.
        const price        = parseFloat(parseFloat(tick.c).toFixed(2));
        const openPrice    = parseFloat(parseFloat(tick.o).toFixed(2));
        const dollarChange = parseFloat(parseFloat(tick.p).toFixed(2));
        const cachedPrev   = _priceCache[id]?.prevClose;
        const prevClose    = cachedPrev ?? openPrice;

        // Recalculate % from openPrice baseline (most accurate).
        // tick.P is already this calculation but we verify with our own baseline.
        // Guard: skip if openPrice is zero or missing (prevents divide-by-zero).
        let percentChange;
        if (openPrice > 0) {
          percentChange = parseFloat(((price - openPrice) / openPrice * 100).toFixed(2));
        } else {
          // Fallback to Binance's own value if we can't derive it
          percentChange = parseFloat(parseFloat(tick.P).toFixed(2));
        }

        // Final sanity check — Binance 24h shouldn't exceed ±50% for BTC/ETH
        if (Math.abs(percentChange) > 50) {
          console.warn(`[WS] ${id}: percentChange=${percentChange}% out of range, using tick.P`);
          percentChange = parseFloat(parseFloat(tick.P).toFixed(2));
        }

        updateAsset(id, {
          symbol:       id,
          price,
          change:       percentChange,  // % is what the UI renders everywhere
          percentChange,
          dollarChange,                 // stored for reference, not used in UI % display
          prevClose,
          marketState:  "REGULAR",
          source:       "Binance",
          confidence:   "high",
          status:       "valid",
          cached:       false,
          timestamp:    new Date().toISOString(),
        });
      } catch (_) {}
    };
    ws.onerror = () => { setWsConnected(false); };
    ws.onclose = () => { setWsConnected(false); wsReconnectRef.current = setTimeout(connectWS, 3000); };
  }, [updateAsset]);

  // ── Polling — always runs, handles all non-WS assets ────────────────
  const fetchAndUpdate = useCallback(async () => {
    if (isPaused) return; // paused — skip this cycle
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    try {
      const fresh = await fetchAllPrices({ skipVIX: !getMarketStatus().isOpen });
      setAssets(prev => fresh.map(asset => {
        if (!IS_LOCALHOST && (asset.id === "BTC" || asset.id === "ETH")) {
          return prev.find(p => p.id === asset.id) ?? asset;
        }
        const existing = prev.find(p => p.id === asset.id);
        const newSparkline = existing
          ? [...existing.sparkline.slice(1), { v: asset.price, t: Date.now() }]
          : generateSparkline(asset.price, asset.vol);
        return { ...asset, sparkline: newSparkline, loading: false,
          flash: existing ? (asset.price > existing.price ? "up" : asset.price < existing.price ? "down" : null) : null };
      }));
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      if (e.name !== "AbortError") { console.error("[useMarketData]", e); setError(e.message); }
    }
  }, [isPaused]);

  useEffect(() => {
    // Step 1: fetch baselines + klines in parallel from Binance — fast, CORS-open.
    // Baselines give us accurate prices and % change.
    // Klines give us 24 real hourly candle closes for the sparkline.
    // Both save to localStorage so next reload is instant with no flicker.
    Promise.all([
      fetchCryptoBaselines(),
      fetchCryptoKlines("BTCUSDT", TIMEFRAMES[DEFAULT_TIMEFRAME].interval, TIMEFRAMES[DEFAULT_TIMEFRAME].limit),
      fetchCryptoKlines("ETHUSDT", TIMEFRAMES[DEFAULT_TIMEFRAME].interval, TIMEFRAMES[DEFAULT_TIMEFRAME].limit),
    ]).then(([baselines, btcKlines, ethKlines]) => {
      if (Object.keys(baselines).length === 0) return;

      // Attach klines to each baseline entry
      if (btcKlines?.length) baselines.BTC = { ...baselines.BTC, klines: btcKlines };
      if (ethKlines?.length) baselines.ETH = { ...baselines.ETH, klines: ethKlines };

      saveBaselines(baselines);

      setAssets(prev => prev.map(asset => {
        const b = baselines[asset.id];
        if (!b) return asset;

        // Use real candle closes if available, otherwise fall back to generated sparkline.
        // Ensure last point reflects current live price (klines close ~1min ago).
        let sparkline;
        if (b.klines?.length >= 2) {
          sparkline = b.klines.map(k => ({ ...k }));  // copy to avoid mutation
          // Replace the last candle's close with the live price so the
          // sparkline tail connects to the current price card value.
          sparkline[sparkline.length - 1] = { v: b.price, t: Date.now() };
        } else {
          sparkline = generateSparkline(b.openPrice, asset.vol);
          sparkline[sparkline.length - 1] = { v: b.price, t: Date.now() };
        }

        return {
          ...asset,
          price:      b.price,
          change:     b.change,
          prevClose:  b.prevClose,
          source:     b.source,
          confidence: b.confidence,
          status:     b.status,
          sparkline,
          loading:    false,
        };
      }));

      // Prime _priceCache with klines so WS knows the real sparkline history
      Object.entries(baselines).forEach(([id, b]) => { _priceCache[id] = b; });

      // Seed klinesCache so the timeframe effect doesn't refetch what we just loaded
      if (btcKlines || ethKlines) {
        klinesCache.current[DEFAULT_TIMEFRAME] = { BTC: btcKlines, ETH: ethKlines };
      }
    });

    // Step 2: WS + adaptive polling start
    // Poll faster during market hours (12s) — server TTL is 5s so data is always fresh
    // Poll slower when closed (60s) — saves Finnhub quota, nothing changes anyway
    connectWS();
    fetchAndUpdate();

    const schedulePoll = () => {
      const interval = getMarketStatus().isOpen
        ? INTERVALS.PRICES_OPEN
        : INTERVALS.PRICES_CLOSED;
      return setInterval(fetchAndUpdate, interval);
    };

    let pollInterval = schedulePoll();

    // Re-evaluate interval every 5 minutes (handles market open/close transitions)
    const intervalCheck = setInterval(() => {
      clearInterval(pollInterval);
      pollInterval = schedulePoll();
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(pollInterval);
      clearInterval(intervalCheck);
      clearTimeout(wsReconnectRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWS, fetchAndUpdate]);

  // Refetch klines whenever timeframe changes.
  // Cache results so switching back to a previously viewed timeframe is instant.
  useEffect(() => {
    const cached = klinesCache.current[timeframe];
    if (cached) {
      // Already have this timeframe — apply immediately from cache
      const livePrice = { BTC: _priceCache.BTC?.price, ETH: _priceCache.ETH?.price };
      applyKlines(cached, livePrice);
      return;
    }
    // Fetch fresh klines for this timeframe
    fetchKlinesForTimeframe(timeframe).then(klinesMap => {
      klinesCache.current[timeframe] = klinesMap;
      const livePrice = { BTC: _priceCache.BTC?.price, ETH: _priceCache.ETH?.price };
      applyKlines(klinesMap, livePrice);
    });
  }, [timeframe, applyKlines]);

  const systemStatus = _priceCache._systemStatus ?? { status: "LIVE", errorCount: 0 };
  return { assets, lastUpdated, error, wsConnected, systemStatus, timeframe, setTimeframe };
};

// ─────────────────────────────────────────────
// ALERT RULES — declarative multi-condition system
// Each rule: { key, name, severity, cooldown, condition(snap), message(snap) }
// snap = { assets, prev } — current and previous asset snapshots
// ─────────────────────────────────────────────

const ALERT_RULES = [
  // ── Single-asset rules (existing logic, now declarative) ──────
  {
    key:      "VIX_EXTREME",
    name:     "VIX Extreme",
    severity: "critical",
    cooldown: 5 * 60 * 1000,
    condition: ({ assets, prev }) => {
      const v = assets.VIX, p = prev.VIX;
      return v && p && v.price >= ALERT_THRESHOLDS.VIX_EXTREME && p.price < ALERT_THRESHOLDS.VIX_EXTREME;
    },
    message: ({ assets }) => `VIX at ${assets.VIX?.price?.toFixed(2)} — Panic levels`,
    triggers: () => ["VIX > 30"],
  },
  {
    key:      "VIX_DANGER",
    name:     "VIX Danger",
    severity: "danger",
    cooldown: 5 * 60 * 1000,
    condition: ({ assets, prev }) => {
      const v = assets.VIX, p = prev.VIX;
      return v && p && v.price >= ALERT_THRESHOLDS.VIX_DANGER && v.price < ALERT_THRESHOLDS.VIX_EXTREME && p.price < ALERT_THRESHOLDS.VIX_DANGER;
    },
    message: ({ assets }) => `VIX at ${assets.VIX?.price?.toFixed(2)} — Elevated volatility`,
    triggers: () => ["VIX > 25"],
  },
  {
    key:      "OIL_SPIKE",
    name:     "Oil Spike",
    severity: "warning",
    cooldown: 3 * 60 * 1000,
    condition: ({ assets, prev }) => {
      const w = assets.WTI, p = prev.WTI;
      return w && p && Math.abs(w.change) > ALERT_THRESHOLDS.OIL_MOVE_PCT && Math.abs(p.change) <= ALERT_THRESHOLDS.OIL_MOVE_PCT;
    },
    message: ({ assets }) => `WTI ${assets.WTI?.change >= 0 ? "+" : ""}${assets.WTI?.change?.toFixed(2)}% — Macro risk`,
    triggers: ({ assets }) => [`WTI ${assets.WTI?.change >= 0 ? "+" : ""}${assets.WTI?.change?.toFixed(2)}%`],
  },
  {
    key:      "CRYPTO_MOVE_BTC",
    name:     "BTC Move",
    severity: "info",
    cooldown: 2 * 60 * 1000,
    condition: ({ assets, prev }) => {
      const b = assets.BTC, p = prev.BTC;
      return b && p && Math.abs(b.change) > ALERT_THRESHOLDS.CRYPTO_MOVE_PCT && Math.abs(p.change) <= ALERT_THRESHOLDS.CRYPTO_MOVE_PCT;
    },
    message: ({ assets }) => `BTC ${assets.BTC?.change >= 0 ? "+" : ""}${assets.BTC?.change?.toFixed(2)}%`,
    triggers: ({ assets }) => [`BTC ${assets.BTC?.change >= 0 ? "+" : ""}${assets.BTC?.change?.toFixed(2)}%`],
  },
  {
    key:      "CRYPTO_MOVE_ETH",
    name:     "ETH Move",
    severity: "info",
    cooldown: 2 * 60 * 1000,
    condition: ({ assets, prev }) => {
      const e = assets.ETH, p = prev.ETH;
      return e && p && Math.abs(e.change) > ALERT_THRESHOLDS.CRYPTO_MOVE_PCT && Math.abs(p.change) <= ALERT_THRESHOLDS.CRYPTO_MOVE_PCT;
    },
    message: ({ assets }) => `ETH ${assets.ETH?.change >= 0 ? "+" : ""}${assets.ETH?.change?.toFixed(2)}%`,
    triggers: ({ assets }) => [`ETH ${assets.ETH?.change >= 0 ? "+" : ""}${assets.ETH?.change?.toFixed(2)}%`],
  },

  // ── Multi-condition rules ─────────────────────────────────────
  {
    key:      "VIX_AND_BTC_CRASH",
    name:     "Fear + Crypto Selling",
    severity: "danger",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const vix = assets.VIX, btc = assets.BTC;
      return vix && btc && vix.price > 25 && btc.change < -3;
    },
    message: ({ assets }) => `VIX ${assets.VIX?.price?.toFixed(1)} + BTC ${assets.BTC?.change?.toFixed(2)}% — Risk-off across the board`,
    triggers: ({ assets }) => [`VIX ${assets.VIX?.price?.toFixed(1)} > 25`, `BTC ${assets.BTC?.change?.toFixed(2)}% < -3%`],
  },
  {
    key:      "SPY_DOWN_OIL_UP",
    name:     "Stagflation Signal",
    severity: "warning",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const spy = assets.SPY, oil = assets.WTI;
      return spy && oil && spy.change < -1 && oil.change > 3;
    },
    message: ({ assets }) => `SPY ${assets.SPY?.change?.toFixed(2)}% + Oil +${assets.WTI?.change?.toFixed(2)}% — Stagflation pressure`,
    triggers: ({ assets }) => [`SPY ${assets.SPY?.change?.toFixed(2)}%`, `WTI +${assets.WTI?.change?.toFixed(2)}%`],
  },
  {
    key:      "VIX_SPIKE_SPY_SELL",
    name:     "Panic Selloff",
    severity: "critical",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const vix = assets.VIX, spy = assets.SPY;
      return vix && spy && vix.change > 15 && spy.change < -1.5;
    },
    message: ({ assets }) => `VIX +${assets.VIX?.change?.toFixed(1)}% + SPY ${assets.SPY?.change?.toFixed(2)}% — Panic conditions`,
    triggers: ({ assets }) => [`VIX +${assets.VIX?.change?.toFixed(1)}%`, `SPY ${assets.SPY?.change?.toFixed(2)}%`],
  },
  {
    key:      "CRYPTO_AND_EQUITY_RALLY",
    name:     "Broad Risk-On",
    severity: "info",
    isMulti:  true,
    cooldown: 15 * 60 * 1000,
    condition: ({ assets }) => {
      const spy = assets.SPY, btc = assets.BTC, vix = assets.VIX;
      return spy && btc && vix && spy.change > 1 && btc.change > 3 && vix.price < 18;
    },
    message: ({ assets }) => `SPY +${assets.SPY?.change?.toFixed(2)}% + BTC +${assets.BTC?.change?.toFixed(2)}% + VIX low — Strong risk-on`,
    triggers: ({ assets }) => [`SPY +${assets.SPY?.change?.toFixed(2)}%`, `BTC +${assets.BTC?.change?.toFixed(2)}%`, `VIX < 18`],
  },
  {
    key:      "DOLLAR_SURGE_SPY_DROP",
    name:     "Dollar Squeeze",
    severity: "warning",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const dxy = assets.DXY, spy = assets.SPY;
      return dxy && spy && dxy.change > 0.8 && spy.change < -0.8;
    },
    message: ({ assets }) => `DXY +${assets.DXY?.change?.toFixed(2)}% + SPY ${assets.SPY?.change?.toFixed(2)}% — Dollar strength crushing equities`,
    triggers: ({ assets }) => [`DXY +${assets.DXY?.change?.toFixed(2)}%`, `SPY ${assets.SPY?.change?.toFixed(2)}%`],
  },
  {
    key:      "TNX_SPIKE_EQUITY_SELL",
    name:     "Rates Shock",
    severity: "danger",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const tnx = assets.TNX, spy = assets.SPY, qqq = assets.QQQ;
      return tnx && spy && qqq && tnx.change > 3 && spy.change < -0.5 && qqq.change < -1;
    },
    message: ({ assets }) => `10Y +${assets.TNX?.change?.toFixed(2)}% + SPY ${assets.SPY?.change?.toFixed(2)}% + QQQ ${assets.QQQ?.change?.toFixed(2)}% — Rising rates hitting growth`,
    triggers: ({ assets }) => [`TNX +${assets.TNX?.change?.toFixed(2)}%`, `SPY ${assets.SPY?.change?.toFixed(2)}%`, `QQQ ${assets.QQQ?.change?.toFixed(2)}%`],
  },
  {
    key:      "OIL_VIX_MACRO_STRESS",
    name:     "Macro Stress",
    severity: "danger",
    isMulti:  true,
    cooldown: 10 * 60 * 1000,
    condition: ({ assets }) => {
      const wti = assets.WTI, vix = assets.VIX, spy = assets.SPY;
      return wti && vix && spy && wti.change > 4 && vix.price > 22 && spy.change < -0.5;
    },
    message: ({ assets }) => `Oil +${assets.WTI?.change?.toFixed(2)}% + VIX ${assets.VIX?.price?.toFixed(1)} + SPY weak — Macro stress building`,
    triggers: ({ assets }) => [`WTI +${assets.WTI?.change?.toFixed(2)}%`, `VIX ${assets.VIX?.price?.toFixed(1)}`, `SPY ${assets.SPY?.change?.toFixed(2)}%`],
  },

  // ── Regime Shift (special — uses regime param) ─────────────────
  {
    key:      "REGIME_SHIFT",
    name:     "Regime Shift",
    severity: "danger",
    cooldown: 5 * 60 * 1000,
    condition: ({ regime, prevRegime }) => {
      return regime && prevRegime && regime !== prevRegime && prevRegime !== null;
    },
    message: ({ regime, prevRegime }) => `Regime changed: ${prevRegime} → ${regime}`,
    triggers: ({ regime, prevRegime }) => [`${prevRegime} → ${regime}`],
  },
];

// ─────────────────────────────────────────────
// useAlerts — multi-condition, regime-aware
// ─────────────────────────────────────────────
const useAlerts = (assets, regime = null) => {
  const [alerts, setAlerts]           = useState([]);
  const [notifications, setNotifications] = useState([]);
  const prevAssetsRef  = useRef({});         // id → last asset snapshot
  const prevRegimeRef  = useRef(null);       // last known regime
  const cooldownsRef   = useRef({});         // rule key → last fired timestamp
  const seenKeysRef    = useRef(new Set());  // dedup within session

  const canFire = useCallback((key, cooldownMs) => {
    const now = Date.now();
    const last = cooldownsRef.current[key] ?? 0;
    if (now - last < cooldownMs) return false;
    cooldownsRef.current[key] = now;
    return true;
  }, []);

  useEffect(() => {
    // Build asset snapshot map
    const snap = {};
    assets.forEach(a => { snap[a.id] = a; });
    const prevSnap = prevAssetsRef.current;

    const newAlerts = [];

    for (const rule of ALERT_RULES) {
      // Skip regime rule here — handled separately below
      if (rule.key === "REGIME_SHIFT") continue;

      const ctx = { assets: snap, prev: prevSnap, regime, prevRegime: prevRegimeRef.current };

      try {
        if (!rule.condition(ctx)) continue;
      } catch { continue; }

      // Deduplicate with date-scoped key
      const dedupKey = `${rule.key}_${new Date().toDateString()}`;
      if (seenKeysRef.current.has(dedupKey)) continue;
      if (!canFire(rule.key, rule.cooldown)) continue;

      seenKeysRef.current.add(dedupKey);

      const triggerList = rule.triggers ? rule.triggers(ctx) : [];
      const msg = rule.message(ctx);

      newAlerts.push({
        id:       `${rule.key}_${Date.now()}`,
        level:    rule.severity,
        name:     rule.name,
        isMulti:  rule.isMulti ?? false,
        msg,
        triggers: triggerList,
        time:     new Date(),
      });

      // Play sound
      const sound = { critical: ALERT_SOUNDS.critical, danger: ALERT_SOUNDS.danger, warning: ALERT_SOUNDS.warning, info: ALERT_SOUNDS.info };
      sound[rule.severity]?.();
    }

    // ── Regime shift alert ────────────────────────────────────────
    const regimeRule = ALERT_RULES.find(r => r.key === "REGIME_SHIFT");
    if (regimeRule && regime && prevRegimeRef.current && regime !== prevRegimeRef.current) {
      const ctx = { regime, prevRegime: prevRegimeRef.current };
      const dedupKey = `REGIME_SHIFT_${prevRegimeRef.current}_${regime}_${new Date().toDateString()}`;
      if (!seenKeysRef.current.has(dedupKey) && canFire("REGIME_SHIFT", regimeRule.cooldown)) {
        seenKeysRef.current.add(dedupKey);
        newAlerts.push({
          id:       `REGIME_SHIFT_${Date.now()}`,
          level:    "danger",
          name:     "Regime Shift",
          msg:      regimeRule.message(ctx),
          triggers: regimeRule.triggers(ctx),
          time:     new Date(),
        });
        ALERT_SOUNDS.danger();
      }
    }

    // Update refs
    assets.forEach(a => { prevAssetsRef.current[a.id] = a; });
    if (regime) prevRegimeRef.current = regime;

    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 50));
      setNotifications(prev => [...newAlerts, ...prev].slice(0, 3));
      setTimeout(() => setNotifications(prev => prev.slice(newAlerts.length)), 5000);
    }
  }, [assets, regime, canFire]);

  return { alerts, notifications };
};

const useNews = () => {
  const [news, setNews] = useState([]);
  const seenHeadlines = useRef(new Set());
  const fetchAndMerge = useCallback(async () => {
    try {
      const fresh = await fetchNews();
      setNews(prev => {
        const incoming = fresh.filter(n => !seenHeadlines.current.has(n.headline));
        incoming.forEach(n => seenHeadlines.current.add(n.headline));
        return [...incoming, ...prev].slice(0, 40);
      });
    } catch (e) { console.error("[useNews]", e); }
  }, []);
  useEffect(() => { fetchAndMerge(); const i = setInterval(fetchAndMerge, INTERVALS.NEWS); return () => clearInterval(i); }, [fetchAndMerge]);
  return { news };
};

const useSocialFeed = () => {
  const [feed, setFeed] = useState([]);
  const seenIds = useRef(new Set());
  const fetchAndMerge = useCallback(async () => {
    try {
      const fresh = await fetchSocialFeed();
      setFeed(prev => {
        const incoming = fresh.filter(p => !seenIds.current.has(p.id));
        incoming.forEach(p => seenIds.current.add(p.id));
        return [...incoming, ...prev].slice(0, 30);
      });
    } catch (e) { console.error("[useSocialFeed]", e); }
  }, []);
  useEffect(() => { fetchAndMerge(); const i = setInterval(fetchAndMerge, INTERVALS.SOCIAL); return () => clearInterval(i); }, [fetchAndMerge]);
  return { feed };
};

const useClock = () => {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  return time;
};

const useFearGreed = () => {
  const [data, setData] = useState({ value: null, label: "Loading..." });
  const [refreshing, setRefreshing] = useState(false);

  const fetch_ = useCallback(async () => {
    try {
      const result = await fetchFearGreed();
      setData(result);
    } catch (e) { console.warn("[FearGreed]", e.message); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await fetch_();
    setTimeout(() => setRefreshing(false), 600);
  }, [fetch_]);

  useEffect(() => {
    fetch_();
    const i = setInterval(fetch_, 5 * 60 * 1000);
    return () => clearInterval(i);
  }, [fetch_]);

  return { ...data, refresh, refreshing };
};

// Fetches BTC dominance + 24h global volume from CoinGecko global endpoint
// Free, no key, no CORS issues. Updates every 5 minutes.
const useCryptoGlobal = () => {
  const [data, setData] = useState({ btcDominance: null, totalVol24h: null });

  useEffect(() => {
    const fetch_ = async () => {
      try {
        const res = await fetch("https://api.coingecko.com/api/v3/global", { cache: "no-store" });
        if (!res.ok) throw new Error(`CoinGecko global ${res.status}`);
        const json = await res.json();
        const d = json.data;
        setData({
          btcDominance: parseFloat((d.market_cap_percentage?.btc ?? 0).toFixed(1)),
          totalVol24h:  d.total_volume?.usd ?? null,
        });
      } catch (e) { console.warn("[CryptoGlobal]", e.message); }
    };
    fetch_();
    const i = setInterval(fetch_, 5 * 60 * 1000);
    return () => clearInterval(i);
  }, []);

  return data;
};

const HIGHLIGHT_KEYWORDS = [
  "war", "crash", "rates", "inflation", "oil", "fed", "rate hike",
  "default", "recession", "tariff", "sanctions", "missile", "yield",
  "collapse", "surge", "spike", "cut", "pivot", "bank", "crisis"
];

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
const fmtPrice = (price, unit) => {
  if (price >= 1000) return `${unit}${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${unit}${price.toFixed(2)}`;
};

const fmtChange = (change) => `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

const sentimentColor = (change) => change >= 0 ? "#00ff88" : "#ff4466";

const highlightText = (text, keywords) => {
  const parts = text.split(new RegExp(`(${keywords.join("|")})`, "gi"));
  return parts.map((part, i) =>
    keywords.some(k => k.toLowerCase() === part.toLowerCase())
      ? <span key={i} style={{ color: "#ffd700", fontWeight: 700, textShadow: "0 0 8px rgba(255,215,0,0.4)" }}>{part}</span>
      : part
  );
};

// Hooks are imported from ./hooks/useMarketData.js

// ─────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────

const Sparkline = ({ data, change }) => {
  const color = change >= 0 ? "#00ff88" : "#ff4466";
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={`g${change >= 0 ? "up" : "dn"}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#g${change >= 0 ? "up" : "dn"})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
};

const AssetCard = memo(({ asset, debugMode, timeframe }) => {
  const [flashing, setFlashing] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  const prevPrice = useRef(asset.price);

  useEffect(() => {
    if (asset.price !== prevPrice.current) {
      setFlashing(true);
      setJustUpdated(true);
      const t1 = setTimeout(() => setFlashing(false), 400);
      const t2 = setTimeout(() => setJustUpdated(false), 3000);
      prevPrice.current = asset.price;
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [asset.price]);

  const isPos = asset.change >= 0;
  const color = sentimentColor(asset.change);
  const isLive = asset.marketState === "REGULAR";
  const isClosed = asset.marketState === "CLOSED" || !asset.marketState;
  const showClosed = isClosed && asset.category !== "crypto";

  // Status — stale or error override normal display
  const dataStatus  = asset.status ?? "valid";
  const isStale     = dataStatus === "stale" || asset.stale === true;
  const isDataError = dataStatus === "error";
  const isFallback  = asset.isFallback === true;
  // Frozen: price hasn't changed during market hours for >2min (detected in fetchAllPrices)
  const isFrozen    = asset.stale === true && asset.frozenSince != null;

  // Confidence — dims card and source label when low
  const confidence    = asset.confidence ?? "high";
  const isLowConf     = confidence === "low";
  const isMediumConf  = confidence === "medium";

  // Source label — per-source style + tooltip text
  // null = don't render badge at all
  const SOURCE_CONFIG = {
    Binance: { label: "BN",  title: "Real-time (WebSocket)", color: "#00ff88", bg: "rgba(0,255,136,0.12)", border: "rgba(0,255,136,0.25)" },
    binance: { label: "BN",  title: "Real-time (WebSocket)", color: "#00ff88", bg: "rgba(0,255,136,0.12)", border: "rgba(0,255,136,0.25)" },
    Finnhub: { label: "FH",  title: "Primary API",           color: "#aaaaaa", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)" },
    finnhub: { label: "FH",  title: "Primary API",           color: "#aaaaaa", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)" },
    FMP:     { label: "FMP", title: "Fallback API",          color: "#666666", bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)" },
    fmp:     { label: "FMP", title: "Fallback API",          color: "#666666", bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)" },
    Yahoo:   { label: "YH",  title: "Fallback API",          color: "#666666", bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)" },
    yahoo:   { label: "YH",  title: "Fallback API",          color: "#666666", bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)" },
  };
  const sourceCfg   = SOURCE_CONFIG[asset.source] ?? null;
  const sourceLabel = sourceCfg?.label ?? null;
  const isCached    = asset.cached === true;

  // Dollar change: use prevClose from API (accurate) with sparkline as fallback
  // Do NOT use sparkline[0] — the simulated sparkline starts at the mock price,
  // not the real previous close, producing a fake massive drop on first load.
  const sparkFirst = asset.prevClose ?? asset.sparkline?.[0]?.v ?? asset.price;
  const dollarChange = asset.price - sparkFirst;
  const dollarStr = `${dollarChange >= 0 ? "+" : "-"}${asset.unit}${Math.abs(dollarChange).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // 24h high/low badge from sparkline
  const prices = asset.sparkline?.map(p => p.v) ?? [];
  const high24 = Math.max(...prices);
  const low24  = Math.min(...prices);
  const isNearHigh = prices.length > 1 && asset.price >= high24 * 0.998;
  const isNearLow  = prices.length > 1 && asset.price <= low24  * 1.002;

  return (
    <div className="asset-card" style={{
      background: flashing
        ? `rgba(${isPos ? "0,255,136" : "255,68,102"},0.10)`
        : isDataError ? "rgba(255,68,102,0.05)"
        : isStale     ? "rgba(255,215,0,0.03)"
        : isPos ? "rgba(0,255,136,0.03)" : "rgba(255,68,102,0.03)",
      border: isDataError ? "1px solid rgba(255,68,102,0.25)"
            : isStale     ? "1px solid rgba(255,215,0,0.2)"
            : `1px solid ${isPos ? "rgba(0,255,136,0.12)" : "rgba(255,68,102,0.12)"}`,
      borderRadius: 8,
      padding: "10px 12px 10px 14px",
      transition: "background 0.4s ease, border 0.4s ease",
      cursor: "pointer",
      position: "relative",
      overflow: "hidden",
      opacity: isDataError ? 0.7 : isLowConf ? 0.6 : 1,
    }}>
      {/* colored left accent bar */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
        background: isDataError ? "#ff4466" : isStale ? "#ffd700" : color,
        borderRadius: "8px 0 0 8px", opacity: 0.8,
      }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 11, color: "#999", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
              {asset.id}
            </span>
            {/* Status badges — priority: error > stale > closed > live dot */}
            {isDataError ? (
              <span style={{
                fontSize: 8, padding: "1px 5px", borderRadius: 2,
                background: "rgba(255,68,102,0.15)", color: "#ff4466",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border: "1px solid rgba(255,68,102,0.3)", whiteSpace: "nowrap",
              }}>DATA ERR</span>
            ) : isStale ? (
              <span style={{
                fontSize: 8, padding: "1px 5px", borderRadius: 2,
                background: "rgba(255,215,0,0.12)", color: "#ffd700",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border: "1px solid rgba(255,215,0,0.25)", whiteSpace: "nowrap",
              }} title={isFrozen ? "Price unchanged during market hours" : "Data may be stale"}>
                {isFrozen ? "FROZEN" : "STALE"}
              </span>
            ) : showClosed ? (
              <span style={{
                fontSize: 8, padding: "1px 5px", borderRadius: 2,
                background: "rgba(255,255,255,0.05)", color: "#555",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border: "1px solid rgba(255,255,255,0.08)", whiteSpace: "nowrap",
              }}>LAST CLOSE</span>
            ) : (
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: justUpdated ? "#00ff88" : "#2a2a2a",
                boxShadow: justUpdated ? "0 0 6px #00ff88" : "none",
                transition: "background 0.3s, box-shadow 0.3s",
                flexShrink: 0,
              }} />
            )}
            {/* Fallback badge — shown when all APIs failed, serving last known price */}
            {isFallback && (
              <span style={{
                fontSize: 8, padding: "1px 5px", borderRadius: 2,
                background: "rgba(255,140,0,0.1)", color: "#ff8c00",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border: "1px solid rgba(255,140,0,0.2)", whiteSpace: "nowrap",
              }} title="All APIs failed — showing last known price">FALLBACK</span>
            )}
            {!showClosed && !isStale && !isDataError && isNearHigh && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: "rgba(0,255,136,0.15)", color: "#00ff88", fontFamily: "'Space Mono', monospace" }}>24H HI</span>}
            {!showClosed && !isStale && !isDataError && isNearLow  && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: "rgba(255,68,102,0.15)", color: "#ff4466", fontFamily: "'Space Mono', monospace" }}>24H LO</span>}
          </div>
          <div style={{ fontSize: 12, color: "#888" }}>{asset.label}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: isDataError ? "#ff4466" : showClosed || isStale ? "#888" : "#f0f0f0", fontFamily: "'Space Mono', monospace", letterSpacing: -0.5 }}>
            {fmtPrice(asset.price, asset.unit)}
          </div>
          <div style={{ fontSize: 11, color: isDataError || isStale ? "#555" : color, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>
            {fmtChange(asset.change)}
            {/* Period label — 24H for crypto (rolling window), TODAY for equities (vs prev close) */}
            {!isDataError && !isStale && !showClosed && asset.changePeriod && (
              <span style={{
                fontSize: 7, marginLeft: 4, color: "#444",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                verticalAlign: "middle",
              }}>{asset.changePeriod}</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: isDataError || isStale ? "#444" : color, opacity: 0.65, fontFamily: "'Space Mono', monospace" }}>
            {dollarStr}
          </div>
        </div>
      </div>
      <div style={{ position: "relative" }}>
        <Sparkline data={asset.sparkline} change={asset.change} />
        {/* Timeframe label — only on crypto, only when real klines are available */}
        {timeframe && (asset.id === "BTC" || asset.id === "ETH") && (
          <span style={{
            position: "absolute", bottom: 2, right: 2,
            fontSize: 7, color: "#333", fontFamily: "'Space Mono', monospace",
            letterSpacing: 0.5, pointerEvents: "none",
          }}>{timeframe}</span>
        )}
      </div>

      {/* Source label + cache indicator — always visible, small */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Source badge — per-source color + hover tooltip */}
          {sourceCfg && (
            <span
              title={sourceCfg.title}
              style={{
                fontSize: 8, padding: "1px 4px", borderRadius: 2,
                background: sourceCfg.bg,
                color:      sourceCfg.color,
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border:     `1px solid ${sourceCfg.border}`,
                cursor:     "default",
              }}
            >{sourceCfg.label}</span>
          )}
          {/* Cache indicator — only show when serving cached data */}
          {isCached && (
            <span style={{
              fontSize: 8, padding: "1px 4px", borderRadius: 2,
              background: "rgba(255,255,255,0.04)", color: "#444",
              fontFamily: "'Space Mono', monospace",
              border: "1px solid rgba(255,255,255,0.07)",
            }}>CACHED</span>
          )}
        </div>
        {/* Confidence dot */}
        <div style={{
          width: 4, height: 4, borderRadius: "50%",
          background: isLowConf ? "#ff4466" : isMediumConf ? "#ffd700" : "#00ff88",
          opacity: 0.6,
          flexShrink: 0,
        }} />
      </div>
      {debugMode && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid rgba(0,170,255,0.15)" }}>
          <div style={{ fontSize: 9, color: "#00aaff", fontFamily: "'Space Mono', monospace", lineHeight: 1.6 }}>
            <span style={{ color: "#555" }}>src:</span> {asset.source ?? "?"} &nbsp;
            <span style={{ color: "#555" }}>state:</span> {asset.marketState ?? "?"} &nbsp;
            <span style={{ color: dataStatus === "valid" ? "#00ff88" : dataStatus === "stale" ? "#ffd700" : "#ff4466" }}>
              {dataStatus.toUpperCase()}
            </span><br />
            <span style={{ color: "#555" }}>conf:</span>{" "}
            <span style={{ color: isLowConf ? "#ff4466" : isMediumConf ? "#ffd700" : "#00ff88" }}>
              {confidence}
            </span> &nbsp;
            <span style={{ color: "#555" }}>cached:</span>{" "}
            <span style={{ color: isCached ? "#ffd700" : "#555" }}>{isCached ? "yes" : "no"}</span> &nbsp;
            <span style={{ color: "#555" }}>stale:</span>{" "}
            <span style={{ color: asset.stale ? "#ff4466" : "#555" }}>{asset.stale ? "yes" : "no"}</span><br />
            <span style={{ color: "#555" }}>age:</span> {asset.dataAge != null ? `${(asset.dataAge/1000).toFixed(0)}s` : "—"} &nbsp;
            <span style={{ color: "#555" }}>frozen:</span>{" "}
            <span style={{ color: isFrozen ? "#ffd700" : "#555" }}>{isFrozen ? `${Math.round((Date.now() - asset.frozenSince)/1000)}s` : "no"}</span> &nbsp;
            <span style={{ color: "#555" }}>ts:</span> {asset.timestamp ? new Date(asset.timestamp).toLocaleTimeString() : "fallback"}
          </div>
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────
// NEWS REACTION TRACKER
// Detects major moves and logs them as "events"
// No external API — derives context from existing asset state
// ─────────────────────────────────────────────

const REACTION_THRESHOLDS = {
  BTC:  { move: 1.5, label: "Bitcoin"   },
  SPY:  { move: 0.8, label: "S&P 500"   },
  ETH:  { move: 2.0, label: "Ethereum"  },
  VIX:  { move: 8.0, label: "VIX"       }, // VIX moves in % change, 8% = meaningful
  WTI:  { move: 2.0, label: "Crude Oil" },
  GOLD: { move: 1.0, label: "Gold"      },
};

const MAX_EVENTS = 8;

// Generates a plain-English reaction summary from the full assets snapshot
function describeReaction(triggerAsset, assets) {
  const btc = assets.find(a => a.id === "BTC")?.change ?? 0;
  const spy = assets.find(a => a.id === "SPY")?.change ?? 0;
  const vix = assets.find(a => a.id === "VIX");
  const vixChange = vix?.change ?? 0;
  const vixLevel  = vix?.price  ?? 15;

  const up   = triggerAsset.change > 0;
  const risk = spy > 0.5 && btc > 0 && vixChange < 0;
  const fear = vixLevel > 25 || (vixChange > 8 && spy < 0);
  const mixed= Math.abs(spy - btc / 10) > 2; // crypto and equities diverging

  if (triggerAsset.id === "VIX") {
    if (up)  return vixLevel > 25 ? "Fear spike — risk-off conditions" : "Volatility rising — caution warranted";
    return "Volatility falling — risk appetite improving";
  }

  if (fear)  return "Fear regime — broad risk-off across assets";
  if (risk)  return "Strong risk-on — equities + crypto confirming";
  if (mixed) return "Divergence detected — crypto/equity decoupling";
  if (up)    return `${triggerAsset.id} leading — watch for follow-through`;
  return `${triggerAsset.id} selling — monitor correlated assets`;
}

// Hook — monitors assets for threshold crosses, stores event log in state
const useNewsReactionTracker = (assets) => {
  const [events, setEvents] = useState([]);
  const prevRef = useRef({});   // id → last known change value
  const seenRef = useRef(new Set()); // dedup: id + direction + minute bucket

  useEffect(() => {
    if (!assets?.length) return;

    const newEvents = [];
    const now  = Date.now();
    const tick = Math.floor(now / 60_000); // 1-minute bucket for dedup

    for (const [id, cfg] of Object.entries(REACTION_THRESHOLDS)) {
      const asset = assets.find(a => a.id === id);
      if (!asset) continue;

      const change    = asset.change ?? 0;
      const prevChange= prevRef.current[id] ?? null;  // null = not initialized yet
      const direction = change > 0 ? "up" : "down";
      // Only fire after first real data arrives (prevChange !== null)
      // This prevents false threshold-cross events on every page load
      const crossed   = prevChange !== null && Math.abs(change) >= cfg.move && Math.abs(prevChange) < cfg.move;
      const dedupKey  = `${id}_${direction}_${tick}`;

      if (crossed && !seenRef.current.has(dedupKey)) {
        seenRef.current.add(dedupKey);
        newEvents.push({
          id:        `${id}_${now}`,
          asset:     id,
          label:     cfg.label,
          change,
          direction,
          reaction:  describeReaction(asset, assets),
          time:      new Date(now),
          severity:  Math.abs(change) >= cfg.move * 2 ? "high" : "medium",
        });
      }

      prevRef.current[id] = change;
    }

    if (newEvents.length > 0) {
      setEvents(prev => [...newEvents, ...prev].slice(0, MAX_EVENTS));
    }
  }, [assets]);

  return events;
};

// ── UI component ──────────────────────────────────────────────────
const NewsReactionPanel = memo(({ assets }) => {
  const events = useNewsReactionTracker(assets);

  if (events.length === 0) return null; // invisible when nothing happening

  return (
    <div style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 8, padding: "12px 14px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#ffd700", boxShadow: "0 0 8px #ffd700",
            animation: "pulse 1.5s infinite", flexShrink: 0,
          }} />
          <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
            Market Reactions
          </span>
        </div>
        <span style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Event list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {events.map((evt, i) => {
          const isUp     = evt.direction === "up";
          const color    = evt.asset === "VIX"
            ? (isUp ? "#ff4466" : "#00ff88")   // VIX up = bad, down = good
            : (isUp ? "#00ff88" : "#ff4466");
          const isHigh   = evt.severity === "high";

          return (
            <div key={evt.id} style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              padding: "7px 10px", borderRadius: 5,
              background: i === 0 ? `${color}0d` : "rgba(255,255,255,0.02)",
              border: `1px solid ${i === 0 ? `${color}25` : "rgba(255,255,255,0.05)"}`,
              borderLeft: `2px solid ${color}`,
              animation: i === 0 ? "fadeIn 0.4s ease" : "none",
              opacity: 1 - i * 0.1,   // fade older events
            }}>
              {/* Time */}
              <span style={{ fontSize: 10, color: "#444", fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap", flexShrink: 0, marginTop: 1 }}>
                {evt.time.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
              </span>

              {/* Content */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  {/* Asset + move */}
                  <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'Space Mono', monospace" }}>
                    {evt.label} {evt.change >= 0 ? "+" : ""}{evt.change.toFixed(1)}%
                  </span>
                  {isHigh && (
                    <span style={{
                      fontSize: 8, padding: "1px 4px", borderRadius: 2,
                      background: `${color}18`, color,
                      fontFamily: "'Space Mono', monospace",
                      border: `1px solid ${color}33`,
                    }}>MAJOR</span>
                  )}
                </div>
                {/* Reaction */}
                <span style={{ fontSize: 11, color: "#888" }}>
                  {evt.reaction}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────
// MOBILE HOOKS + COMPONENTS
// ─────────────────────────────────────────────

// Lightweight hook — only re-renders on threshold cross, not every resize
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
};

// Collapsible section hook — one state key per section id
const useCollapsible = (sections) => {
  const [open, setOpen] = useState(() =>
    Object.fromEntries(sections.map(s => [s, false]))  // start closed — user opens what they need
  );
  const toggle = (id) => setOpen(prev => ({ ...prev, [id]: !prev[id] }));
  return { open, toggle };
};

/**
// ─────────────────────────────────────────────
// ONE GLANCE MODE — mobile daily driver
// ─────────────────────────────────────────────

/**
 * getActionTag({ regime, riskLevel, setup, btcChange })
 * Derives a single actionable label from system state.
 * One output, no ambiguity.
 */
function getActionTag({ regime, riskLevel, setup, btcChange }) {
  // REDUCE RISK — any danger signal
  if (regime === "RISK OFF" || riskLevel === "HIGH") {
    return { tag: "REDUCE RISK", color: "#ff4466", bg: "rgba(255,68,102,0.12)", border: "rgba(255,68,102,0.3)" };
  }
  // BUILD POSITION — all green
  if (regime === "RISK ON" && riskLevel === "LOW" && setup?.type === "LONG") {
    return { tag: "BUILD POSITION", color: "#00ff88", bg: "rgba(0,255,136,0.12)", border: "rgba(0,255,136,0.3)" };
  }
  // SCALE IN — good regime, medium risk or setup
  if (regime === "RISK ON" && riskLevel !== "HIGH") {
    return { tag: "SCALE IN", color: "#00ff88", bg: "rgba(0,255,136,0.08)", border: "rgba(0,255,136,0.2)" };
  }
  // WAIT — everything else
  return { tag: "WAIT", color: "#ffd700", bg: "rgba(255,215,0,0.08)", border: "rgba(255,215,0,0.2)" };
}

/**
 * useWhatChanged(assets, regime)
 * Tracks the last 6 notable changes — regime shifts, BTC moves,
 * VIX crossings, setup fires. Stored in a ref so no extra renders.
 */
const useWhatChanged = (assets, regime) => {
  const [changes, setChanges] = useState([]);
  // null sentinel = "not initialized yet" — prevents false events on first data arrival
  const prevRef = useRef({ regime: null, btcChange: null, vixPrice: null, setupType: null });

  useEffect(() => {
    if (!assets?.length) return;
    const btc = assets.find(a => a.id === "BTC");
    const vix = assets.find(a => a.id === "VIX");
    const now = Date.now();
    const events = [];

    const btcChange = btc?.change ?? 0;
    const vixPrice  = vix?.price  ?? 0;
    const prev      = prevRef.current;

    // Skip the very first render — prev values are null (not real data yet)
    // This prevents false "BTC moved" events on every page load
    const initialized = prev.btcChange !== null;

    if (initialized) {
      // BTC move > 1.5%
      if (Math.abs(btcChange) >= 1.5 && Math.abs(prev.btcChange) < 1.5) {
        events.push({
          id: `btc_${now}`, time: now,
          text: `BTC ${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(1)}%`,
          color: btcChange >= 0 ? "#00ff88" : "#ff4466",
        });
      }

      // VIX crossing 20 or 25
      if (prev.vixPrice > 0) {
        if (vixPrice >= 25 && prev.vixPrice < 25)
          events.push({ id: `vix25_${now}`, time: now, text: "VIX crossed 25", color: "#ff4466" });
        else if (vixPrice < 25 && prev.vixPrice >= 25)
          events.push({ id: `vix25d_${now}`, time: now, text: "VIX fell below 25", color: "#00ff88" });
        else if (vixPrice >= 20 && prev.vixPrice < 20)
          events.push({ id: `vix20_${now}`, time: now, text: "VIX crossed 20", color: "#ffd700" });
        else if (vixPrice < 20 && prev.vixPrice >= 20)
          events.push({ id: `vix20d_${now}`, time: now, text: "VIX fell below 20", color: "#00ff88" });
      }

      // Regime change
      if (prev.regime && regime !== prev.regime)
        events.push({ id: `reg_${now}`, time: now, text: `Regime → ${regime}`,
          color: regime === "RISK ON" ? "#00ff88" : regime === "RISK OFF" ? "#ff4466" : "#ffd700" });
    }

    if (events.length > 0) {
      setChanges(prev => [...events, ...prev].slice(0, 6));
    }

    prevRef.current = { regime, btcChange, vixPrice, setupType: prev.setupType };
  }, [assets, regime]);

  return changes;
};

/**
 * OneGlanceMode — the entire mobile "above the fold" experience.
 * Readable in under 2 seconds. Replaces MobileCoreSignalCard.
 */
const OneGlanceMode = memo(({ assets, regime, lagSignals }) => {
  const btc = assets.find(a => a.id === "BTC");
  const vix = assets.find(a => a.id === "VIX");

  const { level: riskLevel, score: riskScore } = calculateLeverageRisk({
    btcChange:    btc?.change    ?? 0,
    btcSparkline: btc?.sparkline ?? [],
    vixPrice:     vix?.price     ?? 15,
  });

  const setup = detectSetup({
    regime,
    btcChange:  btc?.change  ?? 0,
    vixPrice:   vix?.price   ?? 15,
    vixChange:  vix?.change  ?? 0,
    lagSignals: lagSignals.map(s => s.signal ?? s),
  });

  const action = getActionTag({ regime, riskLevel, setup, btcChange: btc?.change ?? 0 });
  const changes = useWhatChanged(assets, regime);

  const REGIME_COLORS = {
    "RISK ON":  { color: "#00ff88", bg: "rgba(0,255,136,0.06)",  border: "rgba(0,255,136,0.18)"  },
    "NEUTRAL":  { color: "#ffd700", bg: "rgba(255,215,0,0.06)",  border: "rgba(255,215,0,0.18)"  },
    "RISK OFF": { color: "#ff4466", bg: "rgba(255,68,102,0.06)", border: "rgba(255,68,102,0.18)" },
  };
  const RISK_COLORS  = { LOW: "#00ff88", MEDIUM: "#ffd700", HIGH: "#ff4466" };
  const cfg          = REGIME_COLORS[regime] ?? REGIME_COLORS["NEUTRAL"];
  const riskColor    = RISK_COLORS[riskLevel];
  const btcUp        = (btc?.change ?? 0) >= 0;
  const btcColor     = btcUp ? "#00ff88" : "#ff4466";
  const setupColor   = setup.type === "LONG" ? "#00ff88" : setup.type === "SHORT" ? "#ff4466" : "#444";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

      {/* ── BLOCK 1: Primary signal row ─────────────────────────── */}
      <div style={{
        background: cfg.bg, border: `1px solid ${cfg.border}`,
        borderRadius: 14, padding: "16px 16px 14px",
      }}>
        {/* Row 1: Regime + BTC */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 8, color: "#555", letterSpacing: 2, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>REGIME</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: cfg.color, fontFamily: "'Space Mono', monospace", lineHeight: 1 }}>
              {regime}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, color: "#555", letterSpacing: 2, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>BTC 24H</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: btcColor, fontFamily: "'Space Mono', monospace", lineHeight: 1 }}>
              {btcUp ? "▲" : "▼"} {Math.abs(btc?.change ?? 0).toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Row 2: 3 metric pills */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {/* VIX */}
          <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "8px 8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>VIX</div>
            <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "'Space Mono', monospace",
              color: (vix?.price ?? 0) > 25 ? "#ff4466" : (vix?.price ?? 0) > 18 ? "#ffd700" : "#00ff88" }}>
              {vix?.price?.toFixed(0) ?? "—"}
            </div>
          </div>
          {/* Leverage Risk */}
          <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "8px 8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>LEV RISK</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: riskColor, fontFamily: "'Space Mono', monospace" }}>
              {riskLevel}
            </div>
            <div style={{ marginTop: 4, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${riskScore}%`, background: riskColor, transition: "width 1s ease" }} />
            </div>
          </div>
          {/* Setup */}
          <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "8px 8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>SETUP</div>
            <div style={{ fontSize: setup.type ? 16 : 13, fontWeight: 800, color: setupColor, fontFamily: "'Space Mono', monospace" }}>
              {setup.type ? (setup.type === "LONG" ? "▲ LONG" : "▼ SHORT") : "NONE"}
            </div>
            {setup.type && (
              <div style={{ fontSize: 8, color: setupColor, fontFamily: "'Space Mono', monospace", marginTop: 2 }}>
                {setup.confidence}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── BLOCK 2: Action Tag ──────────────────────────────────── */}
      <div style={{
        background: action.bg,
        border: `1px solid ${action.border}`,
        borderRadius: 12, padding: "14px 16px",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 7, color: "#555", letterSpacing: 2, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>RECOMMENDED ACTION</div>
        <div style={{ fontSize: 22, fontWeight: 900, color: action.color, fontFamily: "'Space Mono', monospace", letterSpacing: 2 }}>
          {action.tag}
        </div>
      </div>

      {/* ── BLOCK 3: What Changed ────────────────────────────────── */}
      {changes.length > 0 && (
        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 10, padding: "10px 12px",
        }}>
          <div style={{ fontSize: 8, color: "#444", letterSpacing: 2, fontFamily: "'Space Mono', monospace", marginBottom: 8 }}>WHAT CHANGED</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {changes.map((c, i) => (
              <div key={c.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                opacity: 1 - i * 0.12,
              }}>
                <span style={{ color: c.color, fontSize: 11, flexShrink: 0 }}>⚡</span>
                <span style={{ fontSize: 12, color: c.color, fontFamily: "'Space Mono', monospace", fontWeight: i === 0 ? 700 : 400 }}>
                  {c.text}
                </span>
                <span style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace", marginLeft: "auto" }}>
                  {new Date(c.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
});

// Keep the old name as an alias so the mobile layout reference still works
const MobileCoreSignalCard = OneGlanceMode;

const SentimentGauge = ({ assets }) => {
  const score = assets.reduce((acc, a) => {
    const weight = a.id === "VIX" ? -2 : a.id === "BTC" || a.id === "SPY" ? 2 : 1;
    return acc + (a.change >= 0 ? weight : -weight);
  }, 0);
  const normalized = Math.max(-10, Math.min(10, score));
  const pct = ((normalized + 10) / 20) * 100;
  const label = normalized > 4 ? "RISK ON" : normalized < -4 ? "RISK OFF" : "NEUTRAL";
  const labelColor = normalized > 4 ? "#00ff88" : normalized < -4 ? "#ff4466" : "#ffd700";

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Market Sentiment</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: labelColor, letterSpacing: 2, fontFamily: "'Space Mono', monospace" }}>{label}</span>
      </div>
      <div style={{ position: "relative", height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${pct}%`,
          background: `linear-gradient(90deg, #ff4466, #ffd700, #00ff88)`,
          borderRadius: 4,
          transition: "width 0.8s ease",
        }} />
        <div style={{
          position: "absolute", top: -3, left: `calc(${pct}% - 7px)`,
          width: 14, height: 14, background: labelColor, borderRadius: "50%",
          border: "2px solid #0a0a0f", transition: "left 0.8s ease", boxShadow: `0 0 10px ${labelColor}`,
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ fontSize: 9, color: "#ff4466", fontFamily: "'Space Mono', monospace" }}>RISK OFF</span>
        <span style={{ fontSize: 9, color: "#ffd700", fontFamily: "'Space Mono', monospace" }}>NEUTRAL</span>
        <span style={{ fontSize: 9, color: "#00ff88", fontFamily: "'Space Mono', monospace" }}>RISK ON</span>
      </div>
    </div>
  );
};

const Heatmap = ({ assets }) => (
  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: 16 }}>
    <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 10 }}>Asset Heatmap</div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
      {assets.map(asset => {
        const intensity = Math.min(Math.abs(asset.change) / 5, 1);
        const isPos = asset.change >= 0;
        const bg = isPos
          ? `rgba(0,255,136,${0.07 + intensity * 0.4})`
          : `rgba(255,68,102,${0.07 + intensity * 0.4})`;
        const border = isPos ? "rgba(0,255,136,0.2)" : "rgba(255,68,102,0.2)";
        const color = isPos ? "#00ff88" : "#ff4466";
        return (
          <div key={asset.id} style={{
            background: bg, borderRadius: 6, padding: "10px 8px", textAlign: "center",
            border: `1px solid ${border}`, transition: "background 0.5s ease",
          }}>
            <div style={{ fontSize: 9, color: "#888", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 3 }}>{asset.id}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace", marginBottom: 2 }}>
              {fmtPrice(asset.price, asset.unit)}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color, fontFamily: "'Space Mono', monospace" }}>
              {fmtChange(asset.change)}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const sentimentStyle = (s) => {
  if (s === "bullish") return { color: "#00ff88", bg: "rgba(0,255,136,0.1)", border: "rgba(0,255,136,0.3)" };
  if (s === "bearish") return { color: "#ff4466", bg: "rgba(255,68,102,0.1)", border: "rgba(255,68,102,0.3)" };
  return { color: "#ffd700", bg: "rgba(255,215,0,0.1)", border: "rgba(255,215,0,0.3)" };
};

const NewsItem = memo(({ item }) => {
  const style = sentimentStyle(item.sentiment);
  return (
    <div style={{
      padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)",
      animation: "fadeIn 0.4s ease",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{
          fontSize: 9, padding: "2px 6px", borderRadius: 3,
          background: style.bg, color: style.color, border: `1px solid ${style.border}`,
          fontFamily: "'Space Mono', monospace", letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0, marginTop: 2,
        }}>
          {item.sentiment.toUpperCase()}
        </span>
        <div>
          <div style={{ fontSize: 13, color: "#e8e8e8", lineHeight: 1.5, marginBottom: 4 }}>
            {highlightText(item.headline, HIGHLIGHT_KEYWORDS)}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#00aaff", fontFamily: "'Space Mono', monospace" }}>{item.source}</span>
            <span style={{ fontSize: 11, color: "#666" }}>{item.time}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

const SocialItem = memo(({ item }) => {
  const colors = { DT: "#ff6b35", EM: "#1da1f2", FR: "#5865f2", LA: "#00ff88", ZH: "#ff4466", RP: "#ffd700" };
  const bgColor = colors[item.avatar] || "#888";
  return (
    <div style={{
      padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,0.05)",
      animation: "fadeIn 0.4s ease",
    }}>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%", background: bgColor,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 800, color: "#0a0a0f", flexShrink: 0, fontFamily: "'Space Mono', monospace",
        }}>{item.avatar}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#e8e8e8" }}>{item.name}</span>
            <span style={{ fontSize: 10, color: "#555" }}>{item.handle}</span>
            <span style={{ fontSize: 10, color: "#555", marginLeft: "auto" }}>{item.time}</span>
          </div>
          <p style={{ fontSize: 13, color: "#ccc", lineHeight: 1.5, margin: 0 }}>
            {highlightText(item.text, HIGHLIGHT_KEYWORDS)}
          </p>
          <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
            {item.tags.map(tag => (
              <span key={tag} style={{
                fontSize: 9, padding: "1px 6px", borderRadius: 3,
                background: "rgba(255,215,0,0.1)", color: "#ffd700",
                border: "1px solid rgba(255,215,0,0.2)", fontFamily: "'Space Mono', monospace",
              }}>#{tag}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

const AlertItem = memo(({ alert }) => {
  const colors = { critical: "#ff0044", danger: "#ff4466", warning: "#ffd700", info: "#00aaff" };
  const color = colors[alert.level] || "#888";
  const rgba = color === "#ff0044" ? "255,0,68" : color === "#ff4466" ? "255,68,102" : color === "#ffd700" ? "255,215,0" : "0,170,255";
  return (
    <div style={{
      padding: "6px 10px", borderRadius: 4,
      background: `rgba(${rgba},0.07)`,
      borderLeft: `2px solid ${color}`, marginBottom: 4, animation: "fadeIn 0.3s ease",
    }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ fontSize: 11, color: "#666", fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap", flexShrink: 0, marginTop: 1 }}>
          {alert.time.toLocaleTimeString("en-US", { hour12: false })}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
            {alert.name && (
              <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: "'Space Mono', monospace" }}>
                [{alert.name}]
              </span>
            )}
            {alert.isMulti && (
              <span style={{
                fontSize: 8, padding: "1px 4px", borderRadius: 2,
                background: "rgba(255,255,255,0.08)", color: "#888",
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                border: "1px solid rgba(255,255,255,0.12)",
              }}>MULTI</span>
            )}
          </div>
          <span style={{ fontSize: 12, color: "#eee" }}>{alert.msg}</span>
          {alert.triggers?.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
              {alert.triggers.map((t, i) => (
                <span key={i} style={{
                  fontSize: 9, padding: "1px 5px", borderRadius: 2,
                  background: `rgba(${rgba},0.15)`,
                  color, border: `1px solid ${color}33`,
                  fontFamily: "'Space Mono', monospace",
                }}>{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const NotificationToast = ({ notification }) => {
  const colors = { critical: "#ff0044", danger: "#ff4466", warning: "#ffd700", info: "#00aaff" };
  const color = colors[notification.level] || "#888";
  const rgba = color === "#ff0044" ? "255,0,68" : color === "#ff4466" ? "255,68,102" : color === "#ffd700" ? "255,215,0" : "0,170,255";
  return (
    <div style={{
      background: "#13131a", border: `1px solid ${color}`,
      borderRadius: 8, padding: "12px 16px", minWidth: 280, maxWidth: 360,
      boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 20px ${color}22`,
      animation: "slideIn 0.3s ease",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>
          {notification.name ? notification.name.toUpperCase() : `ALERT — ${notification.level.toUpperCase()}`}
        </span>
        {notification.isMulti && (
          <span style={{
            fontSize: 8, padding: "1px 5px", borderRadius: 2,
            background: `rgba(${rgba},0.15)`, color,
            fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
            border: `1px solid ${color}44`,
          }}>MULTI</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#d4d4d4", marginBottom: notification.triggers?.length ? 8 : 0 }}>
        {notification.msg}
      </div>
      {notification.triggers?.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {notification.triggers.map((t, i) => (
            <span key={i} style={{
              fontSize: 9, padding: "2px 6px", borderRadius: 3,
              background: `rgba(${rgba},0.15)`,
              color, border: `1px solid ${color}44`,
              fontFamily: "'Space Mono', monospace",
            }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// YOUTUBE LIVE STREAM PANEL
// ─────────────────────────────────────────────

// Add your YouTube API key here to detect live status automatically
// Get one free at: https://console.cloud.google.com → YouTube Data API v3
const YOUTUBE_API_KEY = "";

const CREATORS = [
  {
    id: "amit",
    name: "Amit",
    fullName: "Amit | Stock Market",
    channelId: "UCeESFmkAzQiMVCCBc1FUZGQ",
    channelUrl: "https://www.youtube.com/@amitinvesting",
    color: "#ff4466",
    initials: "AM",
  },
  {
    id: "steven",
    name: "Steven Fiorillo",
    fullName: "Steven Fiorillo",
    channelId: "UCp6twpVzCq-sYMZwvr5IBJQ",
    channelUrl: "https://www.youtube.com/@StevenFiorillo",
    color: "#00aaff",
    initials: "SF",
  },
  {
    id: "future",
    name: "Future Investing",
    fullName: "Future Investing",
    channelId: "UCnMn36GT_H0X-w5_ckLtlgQ",
    channelUrl: "https://www.youtube.com/@FutureInvesting",
    color: "#00ff88",
    initials: "FI",
  },
  {
    id: "tevis",
    name: "Tevis",
    fullName: "Tevis Howard",
    channelId: "UCsaVtHJHJDzFTWdMBIGsmKg",
    channelUrl: "https://www.youtube.com/@tevishoward",
    color: "#ffd700",
    initials: "TH",
  },
];

// Hook: checks YouTube API for live status, falls back to null if no key
const useYoutubeLive = () => {
  const [liveData, setLiveData] = useState({});
  const [loading, setLoading] = useState(true);

  const checkLive = useCallback(async () => {
    if (!YOUTUBE_API_KEY) {
      setLoading(false);
      return;
    }
    try {
      const results = await Promise.all(
        CREATORS.map(async (creator) => {
          const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${creator.channelId}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`;
          const res = await fetch(url);
          const data = await res.json();
          const liveItem = data.items?.[0];
          return {
            id: creator.id,
            isLive: !!liveItem,
            videoId: liveItem?.id?.videoId ?? null,
            title: liveItem?.snippet?.title ?? null,
            viewers: null,
          };
        })
      );
      const map = {};
      results.forEach(r => { map[r.id] = r; });
      setLiveData(map);
    } catch (e) {
      console.warn("[YouTube]", e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    checkLive();
    const interval = setInterval(checkLive, 3 * 60 * 1000); // check every 3 min
    return () => clearInterval(interval);
  }, [checkLive]);

  return { liveData, loading };
};

const LiveStreamPanel = memo(() => {
  const { liveData, loading } = useYoutubeLive();
  const [activeCreator, setActiveCreator] = useState(null);
  const noApiKey = !YOUTUBE_API_KEY;

  // Auto-select first live creator
  useEffect(() => {
    if (!activeCreator) {
      const firstLive = CREATORS.find(c => liveData[c.id]?.isLive);
      if (firstLive) setActiveCreator(firstLive.id);
    }
  }, [liveData, activeCreator]);

  const selected = CREATORS.find(c => c.id === activeCreator);
  const selectedData = liveData[activeCreator];
  const liveCount = CREATORS.filter(c => liveData[c.id]?.isLive).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>

      {/* Header bar */}
      <div style={{ padding: "8px 12px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
            Market Creators
          </span>
          {!noApiKey && (
            <span style={{
              fontSize: 9, padding: "2px 7px", borderRadius: 3,
              background: liveCount > 0 ? "rgba(255,68,102,0.15)" : "rgba(255,255,255,0.05)",
              color: liveCount > 0 ? "#ff4466" : "#444",
              border: `1px solid ${liveCount > 0 ? "rgba(255,68,102,0.3)" : "rgba(255,255,255,0.08)"}`,
              fontFamily: "'Space Mono', monospace", letterSpacing: 1,
            }}>
              {liveCount > 0 ? `${liveCount} LIVE` : "NO LIVE"}
            </span>
          )}
        </div>
      </div>

      {/* Creator selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "8px 12px", flexShrink: 0 }}>
        {CREATORS.map(creator => {
          const data = liveData[creator.id];
          const isLive = data?.isLive;
          const isSelected = activeCreator === creator.id;
          return (
            <button
              key={creator.id}
              onClick={() => setActiveCreator(creator.id)}
              style={{
                background: isSelected
                  ? `rgba(${creator.color === "#ff4466" ? "255,68,102" : creator.color === "#00aaff" ? "0,170,255" : creator.color === "#00ff88" ? "0,255,136" : "255,215,0"},0.12)`
                  : "rgba(255,255,255,0.03)",
                border: `1px solid ${isSelected ? creator.color + "44" : "rgba(255,255,255,0.07)"}`,
                borderRadius: 8, padding: "8px 10px", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
                transition: "all 0.2s", textAlign: "left",
              }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                background: creator.color,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 800, color: "#0a0a0f",
                fontFamily: "'Space Mono', monospace", flexShrink: 0,
                position: "relative",
              }}>
                {creator.initials}
                {isLive && (
                  <div style={{
                    position: "absolute", top: -2, right: -2,
                    width: 8, height: 8, borderRadius: "50%",
                    background: "#ff4466", border: "1.5px solid #0a0a0f",
                    animation: "pulse 1.5s infinite",
                  }} />
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: isSelected ? "#e8e8e8" : "#aaa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {creator.name}
                </div>
                <div style={{ fontSize: 9, fontFamily: "'Space Mono', monospace", marginTop: 1,
                  color: isLive ? "#ff4466" : "#444",
                }}>
                  {noApiKey ? "NO API KEY" : isLive ? "LIVE NOW" : loading ? "CHECKING..." : "OFFLINE"}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Video player / placeholder */}
      <div style={{ flex: 1, padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
        {activeCreator && (
          <>
            {noApiKey ? (
              // No API key — show direct channel links
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 8, padding: 14,
                }}>
                  <div style={{ fontSize: 11, color: "#888", lineHeight: 1.6, marginBottom: 12 }}>
                    Add a free YouTube Data API v3 key to auto-detect live streams. Until then, click below to open each creator's channel directly.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {CREATORS.map(creator => (
                      <a key={creator.id} href={creator.channelUrl} target="_blank" rel="noopener noreferrer"
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.08)`,
                          borderRadius: 6, padding: "8px 12px", textDecoration: "none",
                          borderLeft: `3px solid ${creator.color}`,
                          transition: "background 0.2s",
                        }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: "50%", background: creator.color,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 8, fontWeight: 800, color: "#0a0a0f", fontFamily: "'Space Mono', monospace", flexShrink: 0,
                        }}>{creator.initials}</div>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#e8e8e8" }}>{creator.fullName}</div>
                          <div style={{ fontSize: 10, color: "#555" }}>Open YouTube Channel</div>
                        </div>
                        <span style={{ marginLeft: "auto", fontSize: 10, color: "#444" }}>↗</span>
                      </a>
                    ))}
                  </div>
                </div>
                <div style={{
                  background: "rgba(0,170,255,0.06)", border: "1px solid rgba(0,170,255,0.15)",
                  borderRadius: 8, padding: "10px 12px",
                }}>
                  <div style={{ fontSize: 10, color: "#00aaff", fontFamily: "'Space Mono', monospace", letterSpacing: 1, marginBottom: 4 }}>TO ENABLE AUTO LIVE DETECTION</div>
                  <div style={{ fontSize: 11, color: "#777", lineHeight: 1.6 }}>
                    1. Go to console.cloud.google.com<br />
                    2. Create project → Enable YouTube Data API v3<br />
                    3. Create API key → paste into YOUTUBE_API_KEY at top of MarketMonitor.jsx
                  </div>
                </div>
              </div>
            ) : selectedData?.isLive && selectedData?.videoId ? (
              // Live — embed the stream
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff4466", animation: "pulse 1.5s infinite" }} />
                  <span style={{ fontSize: 11, color: "#ff4466", fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>LIVE</span>
                  <span style={{ fontSize: 11, color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedData.title}
                  </span>
                </div>
                <div style={{ position: "relative", paddingBottom: "56.25%", height: 0, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,68,102,0.3)" }}>
                  <iframe
                    src={`https://www.youtube.com/embed/${selectedData.videoId}?autoplay=1&mute=0`}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              </div>
            ) : (
              // Not live — show channel link
              <div style={{
                background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 8, padding: 20, textAlign: "center",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: "50%",
                  background: selected?.color, margin: "0 auto 12px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 800, color: "#0a0a0f", fontFamily: "'Space Mono', monospace",
                }}>{selected?.initials}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e8e8", marginBottom: 4 }}>{selected?.fullName}</div>
                <div style={{ fontSize: 11, color: "#555", marginBottom: 16 }}>Not currently live</div>
                <a href={selected?.channelUrl} target="_blank" rel="noopener noreferrer"
                  style={{
                    display: "inline-block", padding: "8px 20px", borderRadius: 6,
                    background: `${selected?.color}22`, border: `1px solid ${selected?.color}44`,
                    color: selected?.color, fontSize: 11, textDecoration: "none",
                    fontFamily: "'Space Mono', monospace", letterSpacing: 1,
                  }}>
                  OPEN CHANNEL
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────
// PORTFOLIO — v1
// Edit PORTFOLIO_POSITIONS to match your real holdings
// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
// PORTFOLIO SYSTEM — v3
// Data model, cloud sync, trade logging, metrics
// ─────────────────────────────────────────────

// ── Default seed positions (used on first load only) ──────────────
const PORTFOLIO_POSITIONS = [
  { symbol: "PLTR", shares: 150,  avgCost: 18.42 },
  { symbol: "SOFI", shares: 200,  avgCost: 7.85  },
  { symbol: "ARCC", shares: 80,   avgCost: 19.50 },
  { symbol: "BTC",  shares: 0.05, avgCost: 62000 },
  { symbol: "ETH",  shares: 1.2,  avgCost: 2800  },
];

// ── Portfolio data model ──────────────────────────────────────────
// {
//   id: string,
//   name: string,
//   initialInvestment: number,   // user-supplied starting capital
//   createdAt: ISO string,
//   positions: [{ symbol, shares, avgCost }],
//   trades:    [{ id, symbol, type:"BUY"|"SELL", shares, price, timestamp }]
// }
// PRICES ARE NEVER STORED HERE.

function newPortfolio(name, positions = [], initialInvestment = 0) {
  return {
    id:                `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name,
    initialInvestment: Number(initialInvestment) || 0,
    createdAt:         new Date().toISOString(),
    positions,
    trades: [],
  };
}

// ── localStorage keys (fallback + cache) ─────────────────────────
const LS_PORTFOLIOS = "mm_portfolios_v3";
const LS_ACTIVE_ID  = "mm_active_portfolio";

function lsLoadPortfolios() {
  try {
    const v3 = localStorage.getItem(LS_PORTFOLIOS);
    if (v3) return JSON.parse(v3);
    // Migrate v2
    const v2 = localStorage.getItem("mm_portfolios_v2");
    if (v2) {
      const old = JSON.parse(v2);
      return old.map(p => ({
        ...newPortfolio(p.name, (p.positions || []).map(pos => ({
          symbol:  pos.id || pos.symbol,
          shares:  pos.shares,
          avgCost: pos.avgCost,
        }))),
        id: p.id,
        createdAt: p.createdAt || new Date().toISOString(),
        trades: p.trades || [],
        initialInvestment: p.initialInvestment || 0,
      }));
    }
    // Fresh start
    return [newPortfolio("Main Portfolio", PORTFOLIO_POSITIONS)];
  } catch { return [newPortfolio("Main Portfolio", PORTFOLIO_POSITIONS)]; }
}

function lsSavePortfolios(portfolios) {
  try { localStorage.setItem(LS_PORTFOLIOS, JSON.stringify(portfolios)); } catch {}
}

function lsLoadActiveId(portfolios) {
  try {
    const saved = localStorage.getItem(LS_ACTIVE_ID);
    return portfolios.find(p => p.id === saved) ? saved : (portfolios[0]?.id ?? null);
  } catch { return portfolios[0]?.id ?? null; }
}

function lsSaveActiveId(id) {
  try { localStorage.setItem(LS_ACTIVE_ID, id); } catch {}
}

// ── Trade logic (pure functions) ─────────────────────────────────
// Apply a trade to the positions array — returns new positions.
// BUY  → find or create position, recalc weighted avgCost
// SELL → reduce shares (remove row when shares reach 0)
function applyTrade(positions, trade) {
  const { symbol, type, shares, price } = trade;
  const existing = positions.find(p => p.symbol === symbol);

  if (type === "BUY") {
    if (existing) {
      const totalShares = existing.shares + shares;
      const newAvg = ((existing.shares * existing.avgCost) + (shares * price)) / totalShares;
      return positions.map(p =>
        p.symbol === symbol
          ? { ...p, shares: parseFloat(totalShares.toFixed(8)), avgCost: parseFloat(newAvg.toFixed(4)) }
          : p
      );
    }
    return [...positions, { symbol, shares: parseFloat(shares.toFixed(8)), avgCost: parseFloat(price.toFixed(4)) }];
  }

  if (type === "SELL") {
    return positions
      .map(p => p.symbol === symbol ? { ...p, shares: parseFloat((p.shares - shares).toFixed(8)) } : p)
      .filter(p => p.shares > 0.000001);
  }

  return positions;
}

// ── Portfolio metric calculation (pure, no price fetching) ────────
// liveAssets: the assets[] from useMarketData — the ONLY price source
// auxData:    { TICKER: { price, change, source, ... } } from hooks
const MAIN_ASSET_SYMBOLS = ["BTC","ETH","SPY","QQQ","VIX","WTI","DXY","TNX","GOLD"];

function calcPortfolio(positions, liveAssets, auxData = {}) {
  const rows = positions.map(pos => {
    // Price priority: main asset panel → auxData → null (never hardcoded)
    const liveAsset = liveAssets.find(a => a.id === pos.symbol || a.id === (pos.id ?? pos.symbol));
    const aux       = auxData[pos.symbol] ?? auxData[pos.id ?? ""];

    const currentPrice = liveAsset?.price ?? aux?.price ?? null;
    const priceLoading = currentPrice === null;
    const displayPrice = currentPrice ?? pos.avgCost;

    const priceSource  = liveAsset ? (liveAsset.source ?? "live") : aux ? (aux.source ?? "aux") : "cost basis";
    const priceChange  = liveAsset?.change ?? aux?.change ?? null;
    const priceTs      = liveAsset?.timestamp ?? aux?.timestamp ?? null;
    const priceConf    = liveAsset?.confidence ?? aux?.confidence ?? "low";
    const priceStale   = liveAsset?.stale ?? false;

    const costBasis     = pos.shares * pos.avgCost;
    const currentValue  = pos.shares * displayPrice;
    const unrealizedPnL = priceLoading ? null : currentValue - costBasis;
    const unrealizedPct = priceLoading ? null : (costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0);

    return {
      ...pos,
      symbol: pos.symbol ?? pos.id,
      currentPrice: displayPrice, costBasis, currentValue,
      unrealizedPnL, unrealizedPct, priceLoading,
      priceSource, priceChange, priceTs, priceConf, priceStale,
    };
  });

  const liveRows    = rows.filter(r => !r.priceLoading);
  const totalValue  = rows.reduce((s, r) => s + r.currentValue, 0);
  const totalCost   = rows.reduce((s, r) => s + r.costBasis, 0);
  const totalPnL    = liveRows.length ? totalValue - totalCost : null;
  const totalPnLPct = (totalPnL !== null && totalCost > 0) ? (totalPnL / totalCost) * 100 : null;

  return {
    rows: rows.map(r => ({
      ...r,
      allocation: totalValue > 0 ? (r.currentValue / totalValue) * 100 : 0,
    })),
    totalValue, totalCost, totalPnL, totalPnLPct,
    anyLoading: rows.some(r => r.priceLoading),
  };
}

// ── usePortfolioStore — central state + cloud sync hook ───────────
// Manages all portfolios, syncs to Firestore when configured,
// falls back to localStorage when offline or unconfigured.
function usePortfolioStore() {
  const [portfolios, setPortfoliosState] = useState(() => lsLoadPortfolios());
  const [activeId,   setActiveIdState]   = useState(() => lsLoadActiveId(lsLoadPortfolios()));
  const [userId,     setUserId]          = useState(() => localStorage.getItem("mm_user_id") || null);
  const [syncing,    setSyncing]         = useState(false);

  // ── Cloud init (runs once) ─────────────────────────────────────
  // Dynamically imports firebase.js so the app works without a config
  const cloudRef = useRef(null);  // { savePortfolioCloud, deletePortfolioCloud }
  const unsubRef = useRef(null);

  useEffect(() => {
    // Only attempt cloud sync if env vars are present
    const projectId = typeof import.meta !== "undefined"
      ? (import.meta.env?.VITE_FIREBASE_PROJECT_ID ?? "")
      : "";
    if (!projectId) return;  // no Firebase config → stay on localStorage

    setSyncing(true);
    import("./firebase.js").then(async fb => {
      if (!fb.CLOUD_ENABLED) { setSyncing(false); return; }
      cloudRef.current = fb;

      // Sign in and subscribe
      const uid = await fb.ensureSignedIn();
      if (!uid) { setSyncing(false); return; }
      setUserId(uid);

      // Subscribe to Firestore — this is the source of truth when online
      unsubRef.current = fb.subscribePortfolios(uid, (remotePortfolios) => {
        if (remotePortfolios.length === 0) {
          // First time on this device — push local portfolios to cloud
          const local = lsLoadPortfolios();
          local.forEach(p => fb.savePortfolioCloud(uid, p));
        } else {
          setPortfoliosState(remotePortfolios);
          lsSavePortfolios(remotePortfolios);
        }
        setSyncing(false);
      });
    }).catch(e => {
      console.warn("[Portfolio] Firebase import failed:", e.message);
      setSyncing(false);
    });

    return () => { unsubRef.current?.(); };
  }, []);

  // ── Write helper — localStorage + optional cloud ───────────────
  const persist = useCallback((updated, newActiveId) => {
    lsSavePortfolios(updated);
    setPortfoliosState(updated);
    if (newActiveId !== undefined) {
      lsSaveActiveId(newActiveId);
      setActiveIdState(newActiveId);
    }
    // Cloud write (fire-and-forget)
    if (cloudRef.current && userId) {
      // We diff vs current to find what changed — simpler: just write all
      updated.forEach(p => cloudRef.current.savePortfolioCloud(userId, p));
    }
  }, [userId]);

  // ── CRUD operations ───────────────────────────────────────────
  const createPortfolio = useCallback((name, initialInvestment = 0) => {
    const p = newPortfolio(name, [], initialInvestment);
    persist([...portfolios, p], p.id);
    return p.id;
  }, [portfolios, persist]);

  const deletePortfolio = useCallback((id) => {
    if (portfolios.length <= 1) return;
    const updated = portfolios.filter(p => p.id !== id);
    const newActive = updated.find(p => p.id === activeId)?.id ?? updated[0].id;
    persist(updated, newActive);
    if (cloudRef.current && userId) cloudRef.current.deletePortfolioCloud(userId, id);
  }, [portfolios, activeId, persist, userId]);

  const renamePortfolio = useCallback((id, name) => {
    persist(portfolios.map(p => p.id === id ? { ...p, name } : p));
  }, [portfolios, persist]);

  const setInitialInvestment = useCallback((id, amount) => {
    persist(portfolios.map(p => p.id === id ? { ...p, initialInvestment: Number(amount) || 0 } : p));
  }, [portfolios, persist]);

  const switchPortfolio = useCallback((id) => {
    lsSaveActiveId(id);
    setActiveIdState(id);
  }, []);

  // ── Position CRUD (scoped to one portfolio) ───────────────────
  const updatePositions = useCallback((portfolioId, newPositions) => {
    persist(portfolios.map(p => p.id === portfolioId ? { ...p, positions: newPositions } : p));
  }, [portfolios, persist]);

  // ── Trade logging ─────────────────────────────────────────────
  // Logs a trade, updates positions via applyTrade, appends to trades[]
  const logTrade = useCallback((portfolioId, tradeData) => {
    const trade = {
      id:        `t_${Date.now()}`,
      symbol:    tradeData.symbol.toUpperCase(),
      type:      tradeData.type,     // "BUY" | "SELL"
      shares:    parseFloat(tradeData.shares),
      price:     parseFloat(tradeData.price),
      timestamp: tradeData.timestamp || new Date().toISOString(),
      note:      tradeData.note || "",
    };

    const updated = portfolios.map(p => {
      if (p.id !== portfolioId) return p;
      const newPositions = applyTrade(p.positions, trade);
      const newTrades    = [trade, ...(p.trades || [])].slice(0, 500); // cap at 500
      return { ...p, positions: newPositions, trades: newTrades };
    });

    persist(updated);
    return trade;
  }, [portfolios, persist]);

  const deleteTrade = useCallback((portfolioId, tradeId) => {
    persist(portfolios.map(p =>
      p.id === portfolioId
        ? { ...p, trades: (p.trades || []).filter(t => t.id !== tradeId) }
        : p
    ));
  }, [portfolios, persist]);

  const activePortfolio = portfolios.find(p => p.id === activeId) ?? portfolios[0] ?? null;

  return {
    portfolios, activePortfolio, activeId, userId, syncing,
    createPortfolio, deletePortfolio, renamePortfolio,
    setInitialInvestment, switchPortfolio,
    updatePositions, logTrade, deleteTrade,
  };
}

// ── Form constants ────────────────────────────────────────────────
const EMPTY_POS_FORM   = { symbol: "", shares: "", avgCost: "" };
const EMPTY_TRADE_FORM = { symbol: "", type: "BUY", shares: "", price: "", note: "" };
const LIVE_ASSET_IDS   = ["BTC","ETH","SPY","QQQ","VIX","WTI","DXY","TNX","GOLD"];

// ── Portfolio Selector ─────────────────────────────────────────────
const PortfolioSelector = ({ portfolios, activeId, syncing, onSwitch, onCreate, onRename, onDelete }) => {
  const [renaming,  setRenaming]  = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const [creating,  setCreating]  = useState(false);
  const [newName,   setNewName]   = useState("");
  const [newInvest, setNewInvest] = useState("");

  const commitRename = () => {
    if (renameVal.trim()) onRename(renaming, renameVal.trim());
    setRenaming(null); setRenameVal("");
  };
  const commitCreate = () => {
    if (newName.trim()) onCreate(newName.trim(), newInvest);
    setCreating(false); setNewName(""); setNewInvest("");
  };

  const base = { background:"none", border:"none", cursor:"pointer", fontFamily:"'Space Mono',monospace", fontSize:11, padding:"6px 10px", transition:"all 0.15s" };
  const inp  = { background:"rgba(255,255,255,0.07)", border:"1px solid rgba(0,170,255,0.3)", borderRadius:4, color:"#e8e8e8", fontSize:11, fontFamily:"'Space Mono',monospace", padding:"4px 8px", outline:"none" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:2, overflowX:"auto", borderBottom:"1px solid rgba(255,255,255,0.07)", paddingBottom:0 }}>
        {portfolios.map(p => {
          const isActive = p.id === activeId;
          return (
            <div key={p.id} style={{ display:"flex", alignItems:"center", flexShrink:0 }}>
              {renaming === p.id ? (
                <div style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 6px" }}>
                  <input autoFocus style={{ ...inp, width:110 }} value={renameVal}
                    onChange={e=>setRenameVal(e.target.value)}
                    onKeyDown={e=>{ if(e.key==="Enter") commitRename(); if(e.key==="Escape") setRenaming(null); }} />
                  <button onClick={commitRename} style={{ ...base, color:"#00ff88", fontSize:10, padding:"2px 6px" }}>✓</button>
                  <button onClick={()=>setRenaming(null)} style={{ ...base, color:"#555", fontSize:10, padding:"2px 6px" }}>✕</button>
                </div>
              ) : (
                <button onClick={()=>onSwitch(p.id)} onDoubleClick={()=>{ setRenaming(p.id); setRenameVal(p.name); }}
                  style={{ ...base, color:isActive?"#00aaff":"#555", borderBottom:isActive?"2px solid #00aaff":"2px solid transparent", background:isActive?"rgba(0,170,255,0.06)":"none", letterSpacing:0.5, textTransform:"uppercase", paddingBottom:8 }}
                  title="Double-click to rename">
                  {p.name}
                </button>
              )}
              {isActive && portfolios.length > 1 && renaming !== p.id && (
                <button onClick={()=>onDelete(p.id)} style={{ ...base, color:"#333", fontSize:9, padding:"0 4px 8px 0" }} title="Delete portfolio">×</button>
              )}
            </div>
          );
        })}

        {creating ? (
          <div style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 6px", flexShrink:0 }}>
            <input autoFocus placeholder="Portfolio name" style={{ ...inp, width:120 }} value={newName}
              onChange={e=>setNewName(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") commitCreate(); if(e.key==="Escape") setCreating(false); }} />
            <input placeholder="Initial $" style={{ ...inp, width:72 }} value={newInvest}
              onChange={e=>setNewInvest(e.target.value)} type="number" min="0" />
            <button onClick={commitCreate} style={{ ...base, color:"#00ff88", fontSize:10, padding:"2px 6px" }}>✓</button>
            <button onClick={()=>setCreating(false)} style={{ ...base, color:"#555", fontSize:10, padding:"2px 6px" }}>✕</button>
          </div>
        ) : (
          <button onClick={()=>setCreating(true)} style={{ ...base, color:"#333", fontSize:14, padding:"0 8px 8px", letterSpacing:0 }} title="New portfolio">+</button>
        )}

        {/* Sync indicator */}
        {syncing && (
          <span style={{ fontSize:8, color:"#00aaff", fontFamily:"'Space Mono',monospace", padding:"0 8px", opacity:0.7 }}>↻ sync</span>
        )}
      </div>
      {portfolios.length > 1 && (
        <div style={{ fontSize:8, color:"#333", fontFamily:"'Space Mono',monospace", padding:"3px 2px 0" }}>
          Double-click tab to rename
        </div>
      )}
    </div>
  );
};

// ── Trade Form ────────────────────────────────────────────────────
const TradeForm = ({ onSubmit, onCancel, assets, auxData, defaultSymbol="" }) => {
  const [form,  setForm]  = useState({ ...EMPTY_TRADE_FORM, symbol: defaultSymbol });
  const [error, setError] = useState("");

  // Auto-fill price from marketData when symbol + type are set
  const livePriceForSymbol = (sym) => {
    const s = sym.toUpperCase();
    const a = assets.find(x => x.id === s);
    if (a?.price) return a.price;
    return auxData[s]?.price ?? "";
  };

  const handleSymbolBlur = () => {
    if (!form.price) {
      const p = livePriceForSymbol(form.symbol);
      if (p) setForm(f => ({ ...f, price: String(p) }));
    }
  };

  const submit = () => {
    const symbol = form.symbol.trim().toUpperCase();
    const shares = parseFloat(form.shares);
    const price  = parseFloat(form.price);
    if (!symbol)              return setError("Symbol required");
    if (isNaN(shares) || shares <= 0) return setError("Shares must be > 0");
    if (isNaN(price)  || price  <= 0) return setError("Price must be > 0");
    onSubmit({ symbol, type: form.type, shares, price, note: form.note, timestamp: new Date().toISOString() });
  };

  const inp = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:4, padding:"6px 8px", color:"#e8e8e8", fontSize:11, fontFamily:"'Space Mono',monospace", outline:"none", width:"100%", boxSizing:"border-box" };
  const typeBtn = (t) => ({
    padding:"5px 14px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"'Space Mono',monospace", letterSpacing:0.5,
    border: form.type === t ? `1px solid ${t==="BUY"?"rgba(0,255,136,0.4)":"rgba(255,68,102,0.4)"}` : "1px solid rgba(255,255,255,0.08)",
    background: form.type === t ? (t==="BUY"?"rgba(0,255,136,0.12)":"rgba(255,68,102,0.12)") : "none",
    color: form.type === t ? (t==="BUY"?"#00ff88":"#ff4466") : "#555",
  });

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(0,170,255,0.2)", borderRadius:8, padding:14 }}>
      <div style={{ fontSize:11, color:"#00aaff", fontFamily:"'Space Mono',monospace", letterSpacing:1, marginBottom:12 }}>LOG TRADE</div>

      {/* BUY / SELL toggle */}
      <div style={{ display:"flex", gap:6, marginBottom:10 }}>
        <button onClick={()=>setForm(f=>({...f,type:"BUY"}))}  style={typeBtn("BUY")}>BUY</button>
        <button onClick={()=>setForm(f=>({...f,type:"SELL"}))} style={typeBtn("SELL")}>SELL</button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:8 }}>
        <div>
          <div style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>SYMBOL *</div>
          <input style={{ ...inp, textTransform:"uppercase" }} value={form.symbol}
            onChange={e=>setForm(f=>({...f,symbol:e.target.value}))}
            onBlur={handleSymbolBlur} placeholder="PLTR" />
        </div>
        <div>
          <div style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>SHARES *</div>
          <input style={inp} type="number" step="any" min="0" value={form.shares}
            onChange={e=>setForm(f=>({...f,shares:e.target.value}))} placeholder="100" />
        </div>
        <div>
          <div style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>PRICE *</div>
          <input style={inp} type="number" step="any" min="0" value={form.price}
            onChange={e=>setForm(f=>({...f,price:e.target.value}))} placeholder="auto" />
        </div>
      </div>

      <div style={{ marginBottom:8 }}>
        <div style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>NOTE (optional)</div>
        <input style={inp} value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="e.g. earnings play, DCA" />
      </div>

      {error && <div style={{ fontSize:10, color:"#ff4466", fontFamily:"'Space Mono',monospace", marginBottom:8 }}>{error}</div>}

      <div style={{ display:"flex", gap:8 }}>
        <button onClick={submit} style={{ background:"rgba(0,170,255,0.15)", border:"1px solid rgba(0,170,255,0.3)", color:"#00aaff", borderRadius:4, padding:"6px 16px", cursor:"pointer", fontSize:11, fontFamily:"'Space Mono',monospace" }}>
          LOG
        </button>
        <button onClick={onCancel} style={{ background:"none", border:"1px solid rgba(255,255,255,0.08)", color:"#555", borderRadius:4, padding:"6px 12px", cursor:"pointer", fontSize:11, fontFamily:"'Space Mono',monospace" }}>
          CANCEL
        </button>
      </div>
    </div>
  );
};

// ── Trade History ─────────────────────────────────────────────────
const TradeHistory = ({ trades = [], onDelete }) => {
  const [open, setOpen] = useState(false);
  if (trades.length === 0) return null;

  return (
    <div>
      <button onClick={()=>setOpen(o=>!o)} style={{ background:"none", border:"none", cursor:"pointer", color:"#444", fontSize:10, fontFamily:"'Space Mono',monospace", letterSpacing:1, padding:"4px 0", display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ fontSize:8 }}>{open?"▼":"▶"}</span>
        TRADE HISTORY ({trades.length})
      </button>
      {open && (
        <div style={{ display:"flex", flexDirection:"column", gap:4, marginTop:6 }}>
          {/* Headers */}
          <div style={{ display:"grid", gridTemplateColumns:"0.5fr 0.8fr 0.6fr 0.7fr 0.7fr 1.5fr 0.4fr", gap:6, padding:"0 8px" }}>
            {["TYPE","SYMBOL","SHARES","PRICE","DATE","NOTE",""].map(h=>(
              <span key={h} style={{ fontSize:8, color:"#333", letterSpacing:1, fontFamily:"'Space Mono',monospace" }}>{h}</span>
            ))}
          </div>
          {trades.map(t => {
            const isBuy = t.type === "BUY";
            return (
              <div key={t.id} style={{ display:"grid", gridTemplateColumns:"0.5fr 0.8fr 0.6fr 0.7fr 0.7fr 1.5fr 0.4fr", gap:6, padding:"6px 8px", background:"rgba(255,255,255,0.01)", borderRadius:4, alignItems:"center", borderLeft:`2px solid ${isBuy?"#00ff88":"#ff4466"}` }}>
                <span style={{ fontSize:10, fontWeight:700, color:isBuy?"#00ff88":"#ff4466", fontFamily:"'Space Mono',monospace" }}>{t.type}</span>
                <span style={{ fontSize:10, color:"#ccc", fontFamily:"'Space Mono',monospace" }}>{t.symbol}</span>
                <span style={{ fontSize:10, color:"#888", fontFamily:"'Space Mono',monospace" }}>{t.shares}</span>
                <span style={{ fontSize:10, color:"#888", fontFamily:"'Space Mono',monospace" }}>${t.price?.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                <span style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace" }}>
                  {t.timestamp ? new Date(t.timestamp).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "—"}
                </span>
                <span style={{ fontSize:9, color:"#444", fontFamily:"'Space Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.note||""}</span>
                <button onClick={()=>onDelete(t.id)} style={{ background:"none", border:"none", color:"#333", cursor:"pointer", fontSize:11, padding:"0 2px" }} title="Remove">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── PortfolioPanel ────────────────────────────────────────────────
const PortfolioPanel = ({ assets, momentumStocks = {}, bdcPrices = {}, debugMode = false }) => {

  const store = usePortfolioStore();
  const {
    portfolios, activePortfolio, activeId, syncing,
    createPortfolio, deletePortfolio, renamePortfolio,
    setInitialInvestment, switchPortfolio,
    updatePositions, logTrade, deleteTrade,
  } = store;

  const positions = activePortfolio?.positions ?? [];
  const trades    = activePortfolio?.trades ?? [];

  // ── Dynamic price fetcher for uncovered tickers ───────────────
  const [portfolioPrices, setPortfolioPrices] = useState({});
  useEffect(() => {
    const covered = new Set([
      ...LIVE_ASSET_IDS,
      ...Object.keys(momentumStocks).filter(k => momentumStocks[k]?.price),
      ...Object.keys(bdcPrices).filter(k => bdcPrices[k]?.price),
    ]);
    const unknown = [...new Set(positions.map(p=>p.symbol).filter(s=>s&&!covered.has(s)))];
    if (unknown.length === 0) { setPortfolioPrices({}); return; }
    let cancelled = false;
    const go = async () => {
      try {
        const res = await fetch(`/api/stocks?symbols=${unknown.join(",")}`, { cache:"no-store" });
        if (!res.ok) throw new Error(`/api/stocks ${res.status}`);
        const { stocks } = await res.json();
        if (cancelled) return;
        const result = {};
        unknown.forEach(id => {
          const d = stocks[id];
          if (d?.price) result[id] = { price:d.price, change:d.percentChange??d.change??0, source:d.source??"api/stocks", timestamp:d.timestamp??null, confidence:d.confidence??"medium" };
        });
        setPortfolioPrices(result);
      } catch (e) { console.warn("[portfolioPrices]", e.message); }
    };
    go();
    const iv = setInterval(go, getMarketStatus().isOpen ? 60_000 : 5*60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [positions, Object.keys(momentumStocks).join(","), Object.keys(bdcPrices).join(",")]);

  // ── Build auxData ─────────────────────────────────────────────
  const auxData = {
    ...Object.fromEntries(Object.entries(momentumStocks).filter(([,d])=>d?.price).map(([id,d])=>[id,{price:d.price,change:d.change??null,source:d.source??"api/stocks",timestamp:null,confidence:"medium"}])),
    ...Object.fromEntries(Object.entries(bdcPrices).filter(([,d])=>d?.price).map(([id,d])=>[id,{price:d.price,change:d.change??null,source:d.source??"api/stocks",timestamp:null,confidence:"medium"}])),
    ...portfolioPrices,
  };

  const { rows, totalValue, totalCost, totalPnL, totalPnLPct, anyLoading } = calcPortfolio(positions, assets, auxData);
  const liveRows = rows.filter(r=>!r.priceLoading);

  // Vs initialInvestment (if set)
  const initInvest = activePortfolio?.initialInvestment ?? 0;
  const vsInitial  = (initInvest > 0 && totalValue > 0) ? ((totalValue - initInvest) / initInvest * 100) : null;

  // ── UI state ──────────────────────────────────────────────────
  const [showAddPos,  setShowAddPos]  = useState(false);
  const [showTrade,   setShowTrade]   = useState(false);
  const [editingPos,  setEditingPos]  = useState(null);
  const [posForm,     setPosForm]     = useState(EMPTY_POS_FORM);
  const [posError,    setPosError]    = useState("");
  const [showInitInv, setShowInitInv] = useState(false);
  const [initInvInput,setInitInvInput]= useState("");

  const handleSwitchPortfolio = (id) => {
    switchPortfolio(id);
    setShowAddPos(false); setShowTrade(false); setEditingPos(null);
    setPosForm(EMPTY_POS_FORM); setPosError("");
  };

  // ── Position form handlers ────────────────────────────────────
  const openAddPos  = () => { setPosForm(EMPTY_POS_FORM); setEditingPos(null); setPosError(""); setShowAddPos(true); setShowTrade(false); };
  const openEditPos = (pos) => { setPosForm({ symbol:pos.symbol, shares:String(pos.shares), avgCost:String(pos.avgCost) }); setEditingPos(pos.symbol); setPosError(""); setShowAddPos(true); setShowTrade(false); };
  const closePos    = () => { setShowAddPos(false); setEditingPos(null); setPosForm(EMPTY_POS_FORM); setPosError(""); };

  const submitPos = () => {
    const symbol  = posForm.symbol.trim().toUpperCase();
    const shares  = parseFloat(posForm.shares);
    const avgCost = parseFloat(posForm.avgCost);
    if (!symbol)            return setPosError("Symbol required");
    if (isNaN(shares)||shares<=0)  return setPosError("Shares must be > 0");
    if (isNaN(avgCost)||avgCost<=0)return setPosError("Avg cost must be > 0");
    if (!editingPos && positions.find(p=>p.symbol===symbol)) return setPosError(`${symbol} already in this portfolio`);
    const entry = { symbol, shares, avgCost };
    const updated = editingPos
      ? positions.map(p=>p.symbol===editingPos?entry:p)
      : [...positions, entry];
    updatePositions(activeId, updated);
    closePos();
  };

  const deletePos = (symbol) => updatePositions(activeId, positions.filter(p=>p.symbol!==symbol));

  const handleLogTrade = (tradeData) => {
    logTrade(activeId, tradeData);
    setShowTrade(false);
  };

  const fmt$ = (n) => `$${Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const fmtPct = (n) => `${n>=0?"+":""}${n.toFixed(2)}%`;
  const pnlColor = (n) => n===null?"#555":n>=0?"#00ff88":"#ff4466";

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:4, padding:"6px 8px", color:"#e8e8e8", fontSize:11, fontFamily:"'Space Mono',monospace", width:"100%", outline:"none", boxSizing:"border-box" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

      {/* ── Selector ─────────────────────────────────────────── */}
      <PortfolioSelector
        portfolios={portfolios} activeId={activeId} syncing={syncing}
        onSwitch={handleSwitchPortfolio} onCreate={createPortfolio}
        onRename={renamePortfolio} onDelete={deletePortfolio}
      />

      {/* ── Summary cards ────────────────────────────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
        {[
          { label:"Portfolio Value", value: liveRows.length ? fmt$(totalValue) : "—",  sub: anyLoading&&liveRows.length?"partial":"", color:"#f0f0f0" },
          { label:"Total P&L",       value: totalPnL!==null ? `${totalPnL>=0?"+":"-"}${fmt$(totalPnL)}` : "—", sub:"vs cost basis", color:pnlColor(totalPnL) },
          {
            label: initInvest > 0 ? "Return vs Initial" : "Return",
            value: (initInvest>0&&vsInitial!==null) ? fmtPct(vsInitial) : (totalPnLPct!==null?fmtPct(totalPnLPct):"—"),
            sub:   initInvest>0 ? `$${initInvest.toLocaleString()} invested` : "vs cost basis",
            color: pnlColor(initInvest>0?vsInitial:totalPnLPct),
          },
        ].map(stat => (
          <div key={stat.label} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:8, padding:"10px 14px" }}>
            <div style={{ fontSize:9, color:"#555", letterSpacing:1.5, textTransform:"uppercase", fontFamily:"'Space Mono',monospace", marginBottom:4 }}>
              {stat.label}{stat.sub ? <span style={{ color:"#333", marginLeft:4, fontWeight:400 }}>{stat.sub}</span> : ""}
            </div>
            <div style={{ fontSize:18, fontWeight:800, color:stat.color, fontFamily:"'Space Mono',monospace", lineHeight:1.1 }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* ── Initial investment editor ─────────────────────────── */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        {showInitInv ? (
          <>
            <span style={{ fontSize:10, color:"#555", fontFamily:"'Space Mono',monospace" }}>Initial $</span>
            <input type="number" min="0" style={{ ...inputStyle, width:120 }} value={initInvInput}
              onChange={e=>setInitInvInput(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter"){ setInitialInvestment(activeId,initInvInput); setShowInitInv(false); } if(e.key==="Escape") setShowInitInv(false); }}
              placeholder={String(initInvest||"")} autoFocus />
            <button onClick={()=>{ setInitialInvestment(activeId,initInvInput); setShowInitInv(false); }} style={{ background:"none", border:"1px solid rgba(0,255,136,0.3)", color:"#00ff88", borderRadius:3, padding:"3px 8px", cursor:"pointer", fontSize:10, fontFamily:"'Space Mono',monospace" }}>SET</button>
            <button onClick={()=>setShowInitInv(false)} style={{ background:"none", border:"none", color:"#444", cursor:"pointer", fontSize:10 }}>✕</button>
          </>
        ) : (
          <button onClick={()=>{ setInitInvInput(String(initInvest||"")); setShowInitInv(true); }} style={{ background:"none", border:"none", color:"#333", cursor:"pointer", fontSize:9, fontFamily:"'Space Mono',monospace", letterSpacing:1 }}>
            {initInvest>0 ? `INITIAL: $${initInvest.toLocaleString()} ✎` : "+ SET INITIAL INVESTMENT"}
          </button>
        )}
      </div>

      {/* ── Add position / Log trade forms ───────────────────── */}
      {showAddPos && (
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(0,170,255,0.2)", borderRadius:8, padding:14 }}>
          <div style={{ fontSize:11, color:"#00aaff", fontFamily:"'Space Mono',monospace", letterSpacing:1, marginBottom:10 }}>
            {editingPos ? `EDIT — ${editingPos}` : "ADD POSITION"}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:8 }}>
            {[["SYMBOL *","symbol","text","PLTR"],["SHARES *","shares","number","100"],["AVG COST *","avgCost","number","18.42"]].map(([lbl,key,type,ph])=>(
              <div key={key}>
                <div style={{ fontSize:9, color:"#555", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>{lbl}</div>
                <input style={{ ...inputStyle, textTransform:key==="symbol"?"uppercase":"none" }} type={type} step="any" min="0"
                  value={posForm[key]} onChange={e=>setPosForm(f=>({...f,[key]:e.target.value}))}
                  placeholder={ph} disabled={key==="symbol"&&!!editingPos} />
              </div>
            ))}
          </div>
          {posError && <div style={{ fontSize:10, color:"#ff4466", fontFamily:"'Space Mono',monospace", marginBottom:8 }}>{posError}</div>}
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={submitPos} style={{ background:"rgba(0,170,255,0.15)", border:"1px solid rgba(0,170,255,0.3)", color:"#00aaff", borderRadius:4, padding:"6px 16px", cursor:"pointer", fontSize:11, fontFamily:"'Space Mono',monospace" }}>{editingPos?"SAVE":"ADD"}</button>
            <button onClick={closePos}  style={{ background:"none", border:"1px solid rgba(255,255,255,0.08)", color:"#555", borderRadius:4, padding:"6px 12px", cursor:"pointer", fontSize:11, fontFamily:"'Space Mono',monospace" }}>CANCEL</button>
          </div>
        </div>
      )}

      {showTrade && (
        <TradeForm onSubmit={handleLogTrade} onCancel={()=>setShowTrade(false)} assets={assets} auxData={auxData} />
      )}

      {/* ── Column header + action bar ────────────────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"0.9fr 0.7fr 0.85fr 0.85fr 1fr 0.6fr 0.5fr", gap:8, padding:"0 8px" }}>
        {["POSITION","PRICE","VALUE","COST","P&L","ALLOC",""].map((h,i)=>(
          <span key={i} className={i>=3&&i<=4?"portfolio-col-hide":""} style={{ fontSize:9, color:"#444", letterSpacing:1, textTransform:"uppercase", fontFamily:"'Space Mono',monospace" }}>{h}</span>
        ))}
        <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
          {!showAddPos && !showTrade && (<>
            <button onClick={()=>{ setShowTrade(true); setShowAddPos(false); }} style={{ background:"rgba(0,255,136,0.08)", border:"1px solid rgba(0,255,136,0.2)", color:"#00ff88", borderRadius:4, padding:"3px 8px", cursor:"pointer", fontSize:9, fontFamily:"'Space Mono',monospace" }}>+ TRADE</button>
            <button onClick={openAddPos}                                        style={{ background:"rgba(0,170,255,0.08)", border:"1px solid rgba(0,170,255,0.2)", color:"#00aaff", borderRadius:4, padding:"3px 8px", cursor:"pointer", fontSize:9, fontFamily:"'Space Mono',monospace" }}>+ POS</button>
          </>)}
        </div>
      </div>

      {/* ── Position rows ─────────────────────────────────────── */}
      {rows.map(row => {
        const hasLive = !row.priceLoading;
        const isGain  = hasLive ? (row.unrealizedPnL??0) >= 0 : true;
        const c       = hasLive ? pnlColor(row.unrealizedPnL) : "#444";
        return (
          <div key={row.symbol} className="portfolio-row" style={{ display:"grid", gridTemplateColumns:"0.9fr 0.7fr 0.85fr 0.85fr 1fr 0.6fr 0.5fr", gap:8, padding:"9px 8px", background:hasLive?(isGain?"rgba(0,255,136,0.02)":"rgba(255,68,102,0.02)"):"rgba(255,255,255,0.01)", border:`1px solid ${hasLive?(isGain?"rgba(0,255,136,0.07)":"rgba(255,68,102,0.07)"):"rgba(255,255,255,0.04)"}`, borderRadius:6, alignItems:"center", borderLeft:`3px solid ${c}`, opacity:row.priceLoading?0.65:1, transition:"opacity 0.4s" }}>

            {/* Symbol + shares */}
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:"#e8e8e8", fontFamily:"'Space Mono',monospace" }}>{row.symbol}</div>
              <div style={{ fontSize:9, color:"#555", marginTop:1 }}>{row.shares} shares</div>
            </div>

            {/* Price + daily change */}
            <div>
              <div style={{ fontSize:11, fontFamily:"'Space Mono',monospace", color:row.priceLoading?"#555":row.priceStale?"#888":"#ccc" }}>
                {row.priceLoading ? <span style={{ color:"#444" }}>—</span> : `$${row.currentPrice.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`}
              </div>
              <div style={{ display:"flex", gap:3, marginTop:2, alignItems:"center" }}>
                {hasLive && row.priceChange!=null && (
                  <span style={{ fontSize:8, color:row.priceChange>=0?"#00ff88":"#ff4466", fontFamily:"'Space Mono',monospace" }}>
                    {row.priceChange>=0?"+":""}{row.priceChange.toFixed(2)}%
                  </span>
                )}
                {row.priceLoading && <span style={{ fontSize:8, color:"#444", fontFamily:"'Space Mono',monospace" }}>loading</span>}
                {!row.priceLoading && row.priceStale && <span style={{ fontSize:7, padding:"1px 3px", borderRadius:2, background:"rgba(255,215,0,0.1)", color:"#ffd700", fontFamily:"'Space Mono',monospace", border:"1px solid rgba(255,215,0,0.2)" }}>STALE</span>}
              </div>
              {debugMode && <div style={{ fontSize:7, color:"#00aaff", fontFamily:"'Space Mono',monospace", marginTop:1 }}>{row.priceSource}{row.priceTs?` · ${new Date(row.priceTs).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:false})}`:""}</div>}
            </div>

            {/* Current value */}
            <div style={{ fontSize:11, fontWeight:600, color:hasLive?"#e8e8e8":"#444", fontFamily:"'Space Mono',monospace" }}>
              {hasLive?fmt$(row.currentValue):"—"}
            </div>

            {/* Cost basis */}
            <div className="portfolio-col-hide" style={{ fontSize:11, color:"#666", fontFamily:"'Space Mono',monospace" }}>{fmt$(row.costBasis)}</div>

            {/* P&L */}
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:c, fontFamily:"'Space Mono',monospace" }}>
                {hasLive && row.unrealizedPnL!=null ? `${row.unrealizedPnL>=0?"+":"-"}${fmt$(row.unrealizedPnL)}` : <span style={{ color:"#333" }}>—</span>}
              </div>
              <div style={{ fontSize:9, color:c, opacity:0.8, fontFamily:"'Space Mono',monospace" }}>
                {hasLive && row.unrealizedPct!=null ? fmtPct(row.unrealizedPct) : ""}
              </div>
            </div>

            {/* Allocation bar */}
            <div className="portfolio-col-hide">
              <div style={{ fontSize:9, color:"#888", fontFamily:"'Space Mono',monospace", marginBottom:3 }}>{row.allocation.toFixed(1)}%</div>
              <div style={{ height:3, background:"rgba(255,255,255,0.05)", borderRadius:2 }}>
                <div style={{ height:"100%", width:`${Math.min(row.allocation,100)}%`, background:c, borderRadius:2, transition:"width 0.8s ease" }} />
              </div>
            </div>

            {/* Edit / delete */}
            <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
              <button onClick={()=>openEditPos(positions.find(p=>p.symbol===row.symbol))} style={{ background:"none", border:"1px solid rgba(255,255,255,0.08)", color:"#555", borderRadius:3, padding:"2px 5px", cursor:"pointer", fontSize:10, fontFamily:"'Space Mono',monospace" }} title="Edit">✎</button>
              <button onClick={()=>deletePos(row.symbol)} style={{ background:"none", border:"1px solid rgba(255,68,102,0.15)", color:"#ff4466", borderRadius:3, padding:"2px 5px", cursor:"pointer", fontSize:10 }} title="Remove">×</button>
            </div>
          </div>
        );
      })}

      {positions.length === 0 && (
        <div style={{ textAlign:"center", padding:"28px 0", color:"#444", fontFamily:"'Space Mono',monospace", fontSize:11 }}>
          No positions yet. Click + TRADE to log a buy, or + POS to add manually.
        </div>
      )}

      {/* ── Trade history ─────────────────────────────────────── */}
      <TradeHistory trades={trades} onDelete={(tid)=>deleteTrade(activeId,tid)} />

      {/* ── Footer ───────────────────────────────────────────── */}
      <div style={{ fontSize:9, color:"#2a2a2a", fontFamily:"'Space Mono',monospace", padding:"2px 4px" }}>
        Prices from Dashboard feed · /api/stocks · Enable DEBUG for source details
        {syncing ? " · ↻ syncing..." : " · ✓ saved"}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// LEVERAGE RISK ENGINE
// ─────────────────────────────────────────────

/**
 * calculateLeverageRisk({ btcChange, btcSparkline, vixPrice })
 *
 * Inputs:
 *   btcChange    : BTC 24h % change (already in assets)
 *   btcSparkline : array of { v, t } — last 24 price points
 *   vixPrice     : current VIX level
 *
 * Volatility proxy: (max - min) / avg across sparkline points
 * This approximates realized volatility without needing a separate API call.
 *
 * Returns: { level: "LOW"|"MEDIUM"|"HIGH", score: 0–100, reasons: string[] }
 */
function calculateLeverageRisk({ btcChange = 0, btcSparkline = [], vixPrice = 15 }) {
  let score = 0;
  const reasons = [];

  // ── Component 1: BTC realized volatility from sparkline (0–40 pts) ──
  // Uses price range / average as a normalized volatility proxy
  let btcVolScore = 0;
  if (btcSparkline.length >= 4) {
    const prices = btcSparkline.map(p => p.v).filter(v => v > 0);
    const hi  = Math.max(...prices);
    const lo  = Math.min(...prices);
    const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
    const rangePct = avg > 0 ? ((hi - lo) / avg) * 100 : 0;

    // rangePct interpretation: <2% calm, 2–5% moderate, >5% elevated, >8% extreme
    if (rangePct > 8)      { btcVolScore = 40; reasons.push(`BTC range ${rangePct.toFixed(1)}% (extreme)`); }
    else if (rangePct > 5) { btcVolScore = 28; reasons.push(`BTC range ${rangePct.toFixed(1)}% (elevated)`); }
    else if (rangePct > 2) { btcVolScore = 15; reasons.push(`BTC range ${rangePct.toFixed(1)}% (moderate)`); }
    else                   { btcVolScore = 5;  }
  }
  score += btcVolScore;

  // ── Component 2: BTC directional move magnitude (0–30 pts) ──
  const absBtcChange = Math.abs(btcChange);
  let btcMoveScore = 0;
  if (absBtcChange > 8)      { btcMoveScore = 30; reasons.push(`BTC ${btcChange > 0 ? "+" : ""}${btcChange.toFixed(1)}% move`); }
  else if (absBtcChange > 4) { btcMoveScore = 18; reasons.push(`BTC ${btcChange > 0 ? "+" : ""}${btcChange.toFixed(1)}% move`); }
  else if (absBtcChange > 2) { btcMoveScore = 10; }
  else                       { btcMoveScore = 3;  }
  score += btcMoveScore;

  // ── Component 3: VIX level (0–30 pts) ──
  let vixScore = 0;
  if (vixPrice > 30)      { vixScore = 30; reasons.push(`VIX ${vixPrice.toFixed(1)} (extreme fear)`); }
  else if (vixPrice > 25) { vixScore = 22; reasons.push(`VIX ${vixPrice.toFixed(1)} (elevated)`); }
  else if (vixPrice > 18) { vixScore = 12; reasons.push(`VIX ${vixPrice.toFixed(1)} (cautious)`); }
  else                    { vixScore = 3;  }
  score += vixScore;

  // Clamp to 0–100
  score = Math.min(100, Math.max(0, Math.round(score)));

  // Classify
  let level;
  if (score >= 60)      level = "HIGH";
  else if (score >= 30) level = "MEDIUM";
  else                  level = "LOW";

  return { level, score, reasons };
}

// ─────────────────────────────────────────────
// LEVERAGE RISK GAUGE component
// ─────────────────────────────────────────────
const RISK_COLORS = {
  LOW:    { bar: "#00ff88", text: "#00ff88", bg: "rgba(0,255,136,0.06)",  border: "rgba(0,255,136,0.15)"  },
  MEDIUM: { bar: "#ffd700", text: "#ffd700", bg: "rgba(255,215,0,0.06)",  border: "rgba(255,215,0,0.15)"  },
  HIGH:   { bar: "#ff4466", text: "#ff4466", bg: "rgba(255,68,102,0.06)", border: "rgba(255,68,102,0.15)" },
};

const LeverageRiskGauge = memo(({ assets }) => {
  const btc = assets.find(a => a.id === "BTC");
  const vix = assets.find(a => a.id === "VIX");

  const { level, score, reasons } = calculateLeverageRisk({
    btcChange:    btc?.change      ?? 0,
    btcSparkline: btc?.sparkline   ?? [],
    vixPrice:     vix?.price       ?? 15,
  });

  const cfg = RISK_COLORS[level];

  return (
    <div style={{
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 8, padding: "12px 14px",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
          Leverage Risk
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Score number */}
          <span style={{ fontSize: 11, color: "#444", fontFamily: "'Space Mono', monospace" }}>{score}/100</span>
          {/* Level badge */}
          <span style={{
            fontSize: 11, fontWeight: 800, color: cfg.text,
            fontFamily: "'Space Mono', monospace", letterSpacing: 2,
          }}>{level}</span>
        </div>
      </div>

      {/* Animated bar */}
      <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
        <div style={{
          height: "100%",
          width: `${score}%`,
          background: score >= 60
            ? `linear-gradient(90deg, #ffd700, #ff4466)`
            : score >= 30
            ? `linear-gradient(90deg, #00ff88, #ffd700)`
            : cfg.bar,
          borderRadius: 3,
          transition: "width 1.2s cubic-bezier(0.4, 0, 0.2, 1)",
          boxShadow: `0 0 8px ${cfg.bar}66`,
        }} />
      </div>

      {/* Tick marks */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        {["LOW", "", "MEDIUM", "", "HIGH"].map((t, i) => (
          <span key={i} style={{ fontSize: 7, color: "#333", fontFamily: "'Space Mono', monospace" }}>{t}</span>
        ))}
      </div>

      {/* Reason pills — only show when not LOW */}
      {reasons.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {reasons.map((r, i) => (
            <span key={i} style={{
              fontSize: 9, padding: "1px 6px", borderRadius: 2,
              background: `${cfg.bar}18`, color: cfg.text,
              fontFamily: "'Space Mono', monospace",
              border: `1px solid ${cfg.bar}33`,
            }}>{r}</span>
          ))}
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────
// BTC LEAD / LAG SIGNAL SYSTEM
// ─────────────────────────────────────────────

/**
 * detectLeadLag(btcChange, assetChange)
 *
 * Detects when BTC is leading and a correlated asset hasn't moved yet.
 * This signals a potential catch-up move in the lagging asset.
 *
 * Returns: { status, strength }
 */
function detectLeadLag(btcChange, assetChange) {
  const btcUp    = btcChange > 1;
  const btcDown  = btcChange < -1;
  const assetLow = assetChange < 0.5;
  const assetHigh = assetChange > -0.5;

  let status;
  if (btcUp && assetLow)   status = "LAGGING_BULLISH";  // BTC ripping, asset hasn't followed
  else if (btcDown && assetHigh) status = "LAGGING_BEARISH"; // BTC dumping, asset still elevated
  else                     status = "IN_SYNC";

  if (status === "IN_SYNC") return { status, strength: null };

  // Strength = how wide the gap is
  const gap = Math.abs(btcChange - assetChange);
  const strength = gap > 6 ? "STRONG" : gap > 3 ? "MODERATE" : "WEAK";

  return { status, strength };
}

/**
 * detectSetup({ regime, btcChange, vixPrice, vixChange, lagSignals })
 *
 * Identifies high-probability long or short setups by combining
 * regime, BTC trend, VIX, and lead/lag signals.
 *
 * Confidence scoring:
 *   +1 each condition met → LOW (1), MEDIUM (2), HIGH (3–4)
 *
 * Returns: { type: "LONG"|"SHORT"|null, confidence, conditions[], message }
 */
function detectSetup({ regime, btcChange = 0, vixPrice = 15, vixChange = 0, lagSignals = [] }) {
  const btcTrendingUp   = btcChange > 1;
  const btcTrendingDown = btcChange < -1;
  const vixFallingOrLow = vixChange < 0 || vixPrice < 20;
  const vixRisingOrHigh = vixChange > 5  || vixPrice > 20;
  const vixExtreme      = vixPrice > 25;
  const anyBullishLag   = lagSignals.some(s => s.status === "LAGGING_BULLISH");
  const anyBearishLag   = lagSignals.some(s => s.status === "LAGGING_BEARISH");

  // ── LONG setup ───────────────────────────────────────────────────
  if (regime === "RISK ON" || regime === "NEUTRAL") {
    const longConditions = [
      { met: regime === "RISK ON",   label: `Regime: ${regime}`,          weight: 1 },
      { met: btcTrendingUp,          label: `BTC +${btcChange.toFixed(1)}%`, weight: 1 },
      { met: vixFallingOrLow,        label: `VIX ${vixPrice.toFixed(1)} (${vixChange < 0 ? "falling" : "low"})`, weight: 1 },
      { met: anyBullishLag,          label: "Bullish lag detected",         weight: 1 },
    ];
    const score = longConditions.filter(c => c.met).length;
    if (score >= 2) {
      const confidence = score === 4 ? "HIGH" : score === 3 ? "HIGH" : "MEDIUM";
      const met = longConditions.filter(c => c.met).map(c => c.label);
      return {
        type: "LONG",
        confidence,
        conditions: met,
        message: `${confidence} probability long. ${met.slice(0, 2).join(" · ")}`,
      };
    }
  }

  // ── SHORT setup ───────────────────────────────────────────────────
  if (regime === "RISK OFF" || regime === "NEUTRAL") {
    const shortConditions = [
      { met: regime === "RISK OFF",  label: `Regime: ${regime}`,           weight: 1 },
      { met: btcTrendingDown,        label: `BTC ${btcChange.toFixed(1)}%`, weight: 1 },
      { met: vixRisingOrHigh,        label: `VIX ${vixPrice.toFixed(1)} (${vixExtreme ? "extreme" : "rising"})`, weight: 1 },
      { met: anyBearishLag,          label: "Bearish lag detected",          weight: 1 },
    ];
    const score = shortConditions.filter(c => c.met).length;
    if (score >= 2) {
      const confidence = score === 4 ? "HIGH" : score === 3 ? "HIGH" : "MEDIUM";
      const met = shortConditions.filter(c => c.met).map(c => c.label);
      return {
        type: "SHORT",
        confidence,
        conditions: met,
        message: `${confidence} probability short. ${met.slice(0, 2).join(" · ")}`,
      };
    }
  }

  return { type: null, confidence: null, conditions: [], message: "" };
}

// Tracked leveraged assets — fetched client-side via Yahoo (no backend changes)
const LEVERAGED_ASSETS = [
  { id: "BMNR", label: "BitMine",   desc: "Bitcoin miner"          },
  { id: "BMNU", label: "BMNU 2x",   desc: "2x Long BMNR"           },
  { id: "BMNG", label: "BMNG 2x",   desc: "Leverage Shares 2x BMNR"},
];

// Fetches leveraged asset prices client-side every 60s (slow — they move with BTC)
const useLeveragedAssets = () => {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const symbols = LEVERAGED_ASSETS.map(a => a.id).join(",");
        const res = await fetch(`/api/stocks?symbols=${symbols}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/stocks ${res.status}`);
        const { stocks } = await res.json();
        // Normalise to the shape the rest of the app expects
        const results = {};
        LEVERAGED_ASSETS.forEach(({ id }) => {
          const d = stocks[id];
          results[id] = d ? {
            price:       d.price,
            change:      d.percentChange ?? d.change ?? 0,
            marketState: d.marketState ?? "CLOSED",
            source:      d.source,
            confidence:  d.confidence,
          } : null;
        });
        setPrices(results);
      } catch (e) {
        console.warn("[useLeveragedAssets]", e.message);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
    const interval = setInterval(fetchAll, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return { prices, loading };
};

const LAG_CONFIG = {
  LAGGING_BULLISH: { color: "#00ff88", bg: "rgba(0,255,136,0.1)",  border: "rgba(0,255,136,0.25)", label: "LAG ↑" },
  LAGGING_BEARISH: { color: "#ff4466", bg: "rgba(255,68,102,0.1)", border: "rgba(255,68,102,0.25)", label: "LAG ↓" },
  IN_SYNC:         { color: "#444",    bg: "transparent",           border: "transparent",           label: null    },
};

const BtcLeadLagPanel = memo(({ assets, signals = [], loading = false }) => {
  const btc = assets.find(a => a.id === "BTC");
  const btcChange = btc?.change ?? 0;
  const lagCount = signals.filter(s => s.signal?.status !== "IN_SYNC").length;

  return (
    <div style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 8, padding: "12px 14px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
            BTC Lead Signal
          </span>
          {lagCount > 0 && (
            <span style={{
              marginLeft: 8, fontSize: 9, padding: "1px 6px", borderRadius: 2,
              background: "rgba(0,255,136,0.1)", color: "#00ff88",
              fontFamily: "'Space Mono', monospace", border: "1px solid rgba(0,255,136,0.2)",
            }}>LAG DETECTED</span>
          )}
        </div>
        <span style={{ fontSize: 10, color: "#555", fontFamily: "'Space Mono', monospace" }}>
          BTC {btcChange >= 0 ? "+" : ""}{btcChange.toFixed(2)}%
        </span>
      </div>

      {/* Asset rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {signals.map(({ id, label, desc, price, change, signal }) => {
          const cfg = LAG_CONFIG[signal.status];
          const hasData = change !== null;
          return (
            <div key={id} style={{
              display: "grid", gridTemplateColumns: "1fr auto auto auto",
              alignItems: "center", gap: 8,
              padding: "6px 8px", borderRadius: 5,
              background: signal.status !== "IN_SYNC" ? cfg.bg : "rgba(255,255,255,0.02)",
              border: `1px solid ${signal.status !== "IN_SYNC" ? cfg.border : "rgba(255,255,255,0.05)"}`,
              transition: "background 0.4s ease",
            }}>
              {/* Name */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#ccc", fontFamily: "'Space Mono', monospace" }}>{label}</div>
                <div style={{ fontSize: 9, color: "#444" }}>{desc}</div>
              </div>
              {/* Price */}
              <div style={{ fontSize: 11, color: hasData ? "#888" : "#333", fontFamily: "'Space Mono', monospace", textAlign: "right" }}>
                {loading ? "..." : hasData ? `$${price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              </div>
              {/* Change */}
              <div style={{
                fontSize: 11, fontFamily: "'Space Mono', monospace", textAlign: "right",
                color: !hasData ? "#333" : change >= 0 ? "#00ff88" : "#ff4466",
              }}>
                {loading ? "..." : hasData ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—"}
              </div>
              {/* Lag badge */}
              <div style={{ minWidth: 48, textAlign: "right" }}>
                {cfg.label && signal.strength && (
                  <span style={{
                    fontSize: 8, padding: "2px 5px", borderRadius: 2,
                    background: cfg.bg, color: cfg.color,
                    fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
                    border: `1px solid ${cfg.border}`,
                    whiteSpace: "nowrap",
                  }} title={`${signal.strength} lag vs BTC`}>
                    {cfg.label} {signal.strength === "STRONG" ? "●●●" : signal.strength === "MODERATE" ? "●●" : "●"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 8, fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>
        Lag = asset hasn't followed BTC move yet · Updates every 60s
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────
// SETUP DETECTOR PANEL
// ─────────────────────────────────────────────
const SETUP_CONFIG = {
  LONG:  { color: "#00ff88", bg: "rgba(0,255,136,0.07)",  border: "rgba(0,255,136,0.2)",  glow: "#00ff88" },
  SHORT: { color: "#ff4466", bg: "rgba(255,68,102,0.07)", border: "rgba(255,68,102,0.2)", glow: "#ff4466" },
};

const SetupDetectorPanel = memo(({ assets, regime, lagSignals }) => {
  const btc = assets.find(a => a.id === "BTC");
  const vix = assets.find(a => a.id === "VIX");

  const setup = detectSetup({
    regime,
    btcChange: btc?.change  ?? 0,
    vixPrice:  vix?.price   ?? 15,
    vixChange: vix?.change  ?? 0,
    lagSignals,
  });

  // Only render when there's an active setup
  if (!setup.type) return null;

  const cfg = SETUP_CONFIG[setup.type];
  const confColor = setup.confidence === "HIGH" ? cfg.color : "#ffd700";

  return (
    <div style={{
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 8, padding: "12px 14px",
      boxShadow: `0 0 20px ${cfg.glow}18`,
      animation: "fadeIn 0.4s ease",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Pulse dot */}
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: cfg.color, flexShrink: 0,
            boxShadow: `0 0 10px ${cfg.glow}`,
            animation: "pulse 1.5s infinite",
          }} />
          <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
            Setup Detected
          </span>
        </div>
        {/* Confidence */}
        <span style={{ fontSize: 10, color: confColor, fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
          {setup.confidence} CONF
        </span>
      </div>

      {/* Type badge + message */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{
          fontSize: 18, fontWeight: 800, color: cfg.color,
          fontFamily: "'Space Mono', monospace", letterSpacing: 2,
        }}>
          {setup.type === "LONG" ? "▲ LONG" : "▼ SHORT"}
        </span>
        <span style={{ fontSize: 11, color: "#aaa", lineHeight: 1.4 }}>
          {setup.message}
        </span>
      </div>

      {/* Condition pills */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {setup.conditions.map((c, i) => (
          <span key={i} style={{
            fontSize: 9, padding: "2px 7px", borderRadius: 3,
            background: `${cfg.color}18`, color: cfg.color,
            fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
            border: `1px solid ${cfg.color}33`,
          }}>{c}</span>
        ))}
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────
// STOCK MOMENTUM PANEL
// ─────────────────────────────────────────────

/**
 * analyzeMomentum({ price, ma20, ma50, dailyChange, volumeRatio })
 *
 * Inputs:
 *   price        : current price
 *   ma20         : 20-day simple moving average
 *   ma50         : 50-day simple moving average
 *   dailyChange  : today's % change
 *   volumeRatio  : today's volume / 20-day avg volume (>1.5 = spike)
 *
 * Returns: { trend, strength, signal }
 */
function analyzeMomentum({ price, ma20, ma50, dailyChange, volumeRatio = 1 }) {
  const aboveMA20 = price > ma20;
  const aboveMA50 = price > ma50;
  const ma20AboveMA50 = ma20 > ma50;   // golden/death cross proxy
  const positiveDay = dailyChange > 0;
  const volumeSpike = volumeRatio >= 1.5;

  // ── Trend ─────────────────────────────────────────────────────────
  let trend;
  if (aboveMA20 && aboveMA50 && ma20AboveMA50) trend = "UP";
  else if (!aboveMA20 && !aboveMA50 && !ma20AboveMA50) trend = "DOWN";
  else trend = "SIDEWAYS";

  // ── Strength ──────────────────────────────────────────────────────
  const bullishSignals = [aboveMA20, aboveMA50, ma20AboveMA50, positiveDay].filter(Boolean).length;
  let strength;
  if (bullishSignals === 4) strength = "STRONG";
  else if (bullishSignals === 0) strength = "STRONG";  // strongly bearish
  else if (bullishSignals >= 3 || bullishSignals <= 1) strength = "MEDIUM";
  else strength = "WEAK";

  // ── Signal ────────────────────────────────────────────────────────
  let signal;
  if (trend === "UP" && volumeSpike && positiveDay) signal = "BREAKOUT";
  else if (trend === "UP" || trend === "DOWN") signal = "TREND";
  else signal = "WAIT";

  return { trend, strength, signal };
}

// Stocks to track + their Yahoo tickers
const MOMENTUM_STOCKS = [
  { id: "SOFI", label: "SoFi",     desc: "Fintech / neo-bank" },
  { id: "PLTR", label: "Palantir", desc: "AI data analytics"  },
  { id: "ZETA", label: "Zeta",     desc: "Marketing AI"       },
];

// Fetches 3mo daily OHLCV from Yahoo via /api/stocks?history=true, computes MA20/MA50
const useStockMomentum = () => {
  const [stocks, setStocks]   = useState({});
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const symbols = MOMENTUM_STOCKS.map(s => s.id).join(",");
        const res = await fetch(`/api/stocks?symbols=${symbols}&history=true`, { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/stocks ${res.status}`);
        const { stocks: raw } = await res.json();

        const results = {};
        MOMENTUM_STOCKS.forEach(({ id }) => {
          const d = raw[id];
          if (!d?.price) { results[id] = null; return; }

          const momentum = (d.ma20 && d.ma50)
            ? analyzeMomentum({ price: d.price, ma20: d.ma20, ma50: d.ma50, dailyChange: d.percentChange ?? 0, volumeRatio: d.volumeRatio ?? 1 })
            : null;

          results[id] = {
            price:       d.price,
            change:      d.percentChange ?? d.change ?? 0,
            prevClose:   d.prevClose,
            ma20:        d.ma20,
            ma50:        d.ma50,
            volumeRatio: d.volumeRatio ?? 1,
            momentum,
            marketState: d.marketState ?? "CLOSED",
            source:      d.source ?? "api/stocks",
            confidence:  d.confidence,
          };
        });

        setStocks(results);
        setLastFetch(new Date());
      } catch (e) {
        console.warn("[useStockMomentum]", e.message);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
    const interval = setInterval(fetchAll,
      getMarketStatus().isOpen ? INTERVALS.MOMENTUM_OPEN : INTERVALS.MOMENTUM_CLOSED
    );
    return () => clearInterval(interval);
  }, []);

  return { stocks, loading, lastFetch };
};

// ── Momentum color helpers ────────────────────────────────────────
const MOMENTUM_COLORS = {
  trend: {
    UP:       "#00ff88",
    DOWN:     "#ff4466",
    SIDEWAYS: "#ffd700",
  },
  strength: {
    STRONG: { UP: "#00ff88", DOWN: "#ff4466", SIDEWAYS: "#ffd700" },
    MEDIUM: { UP: "#aaffcc", DOWN: "#ff8899", SIDEWAYS: "#ffd700" },
    WEAK:   { UP: "#ffd700", DOWN: "#ffd700", SIDEWAYS: "#555"    },
  },
  signal: {
    BREAKOUT: "#00ff88",
    TREND:    "#aaa",
    WAIT:     "#555",
  },
};

const StockMomentumPanel = memo(({ stocks = {}, loading = true, lastFetch = null }) => {

  const fmt$ = (n) => n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const fmtPct = (n) => n != null ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
          Stock Momentum
        </span>
        <span style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>
          {loading ? "Loading..." : lastFetch ? `UPD ${lastFetch.toLocaleTimeString("en-US", { hour12: false })}` : ""}
        </span>
      </div>

      {/* Column headers */}
      <div style={{
        display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr",
        gap: 8, padding: "0 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 6,
      }}>
        {["Stock", "Price", "Chg", "Trend", "Strength", "Signal"].map(h => (
          <span key={h} style={{ fontSize: 9, color: "#444", letterSpacing: 1, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>{h}</span>
        ))}
      </div>

      {/* Stock rows */}
      {MOMENTUM_STOCKS.map(({ id, label, desc }) => {
        const d = stocks[id];
        const m = d?.momentum;
        const isClosed = d?.marketState === "CLOSED";
        const trendColor  = m ? MOMENTUM_COLORS.trend[m.trend]    : "#444";
        const sigColor    = m ? MOMENTUM_COLORS.signal[m.signal]  : "#444";
        const chgColor    = d?.change >= 0 ? "#00ff88" : "#ff4466";

        return (
          <div key={id} style={{
            display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr",
            gap: 8, padding: "10px 10px",
            background: !m ? "rgba(255,255,255,0.01)"
              : m.trend === "UP"   ? "rgba(0,255,136,0.02)"
              : m.trend === "DOWN" ? "rgba(255,68,102,0.02)"
              : "rgba(255,215,0,0.02)",
            border: `1px solid ${!m ? "rgba(255,255,255,0.05)" : m.trend === "UP" ? "rgba(0,255,136,0.08)" : m.trend === "DOWN" ? "rgba(255,68,102,0.08)" : "rgba(255,215,0,0.06)"}`,
            borderRadius: 6, alignItems: "center",
            borderLeft: `3px solid ${trendColor}`,
            opacity: loading ? 0.5 : 1,
            transition: "opacity 0.3s",
          }}>
            {/* Stock name */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>{label}</div>
              <div style={{ fontSize: 9, color: "#444", marginTop: 1 }}>{desc}</div>
            </div>

            {/* Price */}
            <div style={{ fontSize: 11, color: isClosed ? "#666" : "#ccc", fontFamily: "'Space Mono', monospace" }}>
              {loading ? "..." : fmt$(d?.price)}
            </div>

            {/* Daily change */}
            <div style={{ fontSize: 11, fontWeight: 700, color: loading || !d ? "#444" : chgColor, fontFamily: "'Space Mono', monospace" }}>
              {loading ? "..." : fmtPct(d?.change)}
            </div>

            {/* Trend */}
            <div>
              {m ? (
                <span style={{
                  fontSize: 10, fontWeight: 700, color: trendColor,
                  fontFamily: "'Space Mono', monospace",
                }}>
                  {m.trend === "UP" ? "▲ UP" : m.trend === "DOWN" ? "▼ DOWN" : "— SIDE"}
                </span>
              ) : (
                <span style={{ fontSize: 10, color: "#333", fontFamily: "'Space Mono', monospace" }}>—</span>
              )}
            </div>

            {/* Strength */}
            <div>
              {m ? (
                <span style={{
                  fontSize: 9, padding: "2px 5px", borderRadius: 2,
                  background: `${trendColor}18`, color: trendColor,
                  fontFamily: "'Space Mono', monospace",
                  border: `1px solid ${trendColor}33`,
                }}>{m.strength}</span>
              ) : (
                <span style={{ fontSize: 10, color: "#333", fontFamily: "'Space Mono', monospace" }}>—</span>
              )}
            </div>

            {/* Signal */}
            <div>
              {m ? (
                <span style={{
                  fontSize: 9, padding: "2px 5px", borderRadius: 2,
                  background: m.signal === "BREAKOUT" ? "rgba(0,255,136,0.12)" : "rgba(255,255,255,0.04)",
                  color: sigColor,
                  fontFamily: "'Space Mono', monospace",
                  border: `1px solid ${sigColor}44`,
                  fontWeight: m.signal === "BREAKOUT" ? 700 : 400,
                }}>{m.signal}</span>
              ) : (
                <span style={{ fontSize: 10, color: "#333", fontFamily: "'Space Mono', monospace" }}>—</span>
              )}
            </div>
          </div>
        );
      })}

      {/* MA reference */}
      <div style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "'Space Mono', monospace", padding: "2px 4px" }}>
        MA20 / MA50 computed from 3mo daily closes · Refreshes every 5 min
      </div>

    </div>
  );
});

// ─────────────────────────────────────────────
// TRADE JOURNAL PANEL
// ─────────────────────────────────────────────
const TradeJournalPanel = memo(({ entries, onDelete }) => {
  const [expanded, setExpanded] = useState(null);

  const fmt$ = (n) => n != null ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const fmtPct = (n) => n != null ? `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%` : "—";
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  };

  const REGIME_COLOR = { "RISK ON": "#00ff88", "NEUTRAL": "#ffd700", "RISK OFF": "#ff4466" };
  const RISK_COLOR   = { LOW: "#00ff88", MEDIUM: "#ffd700", HIGH: "#ff4466" };
  const SETUP_COLOR  = { LONG: "#00ff88", SHORT: "#ff4466" };

  if (entries.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "32px 0", color: "#333", fontFamily: "'Space Mono', monospace", fontSize: 11 }}>
        No snapshots yet. Click LOG TRADE in the top bar.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {entries.map((snap) => {
        const isOpen   = expanded === snap.id;
        const rc       = REGIME_COLOR[snap.regime]  ?? "#666";
        const rlColor  = RISK_COLOR[snap.leverageRisk?.level] ?? "#666";
        const sc       = snap.setup ? SETUP_COLOR[snap.setup.type] ?? "#aaa" : null;

        return (
          <div key={snap.id} style={{
            border: "1px solid rgba(255,255,255,0.07)", borderRadius: 7,
            background: "rgba(255,255,255,0.02)", overflow: "hidden",
          }}>
            {/* Row header — always visible, click to expand */}
            <div
              onClick={() => setExpanded(isOpen ? null : snap.id)}
              style={{
                display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.6fr 0.7fr auto",
                gap: 8, padding: "9px 12px", cursor: "pointer", alignItems: "center",
              }}
            >
              {/* Timestamp */}
              <span style={{ fontSize: 10, color: "#888", fontFamily: "'Space Mono', monospace" }}>
                {fmtTime(snap.timestamp)}
              </span>

              {/* Regime */}
              <span style={{ fontSize: 10, fontWeight: 700, color: rc, fontFamily: "'Space Mono', monospace" }}>
                {snap.regime}
              </span>

              {/* Leverage risk */}
              <span style={{ fontSize: 10, color: rlColor, fontFamily: "'Space Mono', monospace" }}>
                {snap.leverageRisk?.level ?? "—"}
              </span>

              {/* Setup */}
              <span style={{
                fontSize: 10, fontWeight: 700,
                color: sc ?? "#444", fontFamily: "'Space Mono', monospace",
              }}>
                {snap.setup ? `${snap.setup.type} ${snap.setup.confidence}` : "NO SETUP"}
              </span>

              {/* Expand + delete */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#444", fontFamily: "'Space Mono', monospace" }}>
                  {isOpen ? "▲" : "▼"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(snap.id); }}
                  style={{
                    background: "none", border: "1px solid rgba(255,68,102,0.15)",
                    color: "#ff4466", borderRadius: 3, padding: "1px 5px",
                    cursor: "pointer", fontSize: 9,
                  }} title="Delete"
                >×</button>
              </div>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{
                borderTop: "1px solid rgba(255,255,255,0.06)",
                padding: "10px 12px",
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
              }}>
                {/* Prices at snapshot */}
                <div>
                  <div style={{ fontSize: 9, color: "#444", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 6 }}>PRICES AT SNAPSHOT</div>
                  {Object.entries(snap.prices).map(([id, price]) => (
                    <div key={id} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 10, color: "#666", fontFamily: "'Space Mono', monospace" }}>{id}</span>
                      <span style={{ fontSize: 10, color: "#ccc", fontFamily: "'Space Mono', monospace" }}>
                        {fmt$(price)}
                        {snap.changes?.[id] != null && (
                          <span style={{ color: snap.changes[id] >= 0 ? "#00ff88" : "#ff4466", marginLeft: 6 }}>
                            {fmtPct(snap.changes[id])}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Conditions */}
                <div>
                  <div style={{ fontSize: 9, color: "#444", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 6 }}>CONDITIONS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 10, color: "#888", fontFamily: "'Space Mono', monospace" }}>
                      <span style={{ color: "#555" }}>Regime: </span>
                      <span style={{ color: rc }}>{snap.regime}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#888", fontFamily: "'Space Mono', monospace" }}>
                      <span style={{ color: "#555" }}>Lev. Risk: </span>
                      <span style={{ color: rlColor }}>{snap.leverageRisk?.level} ({snap.leverageRisk?.score}/100)</span>
                    </div>
                    {snap.setup && (
                      <div style={{ fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                        <span style={{ color: "#555" }}>Setup: </span>
                        <span style={{ color: sc }}>{snap.setup.type} · {snap.setup.confidence}</span>
                        <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{snap.setup.message}</div>
                      </div>
                    )}
                    {snap.lagSignal && (
                      <div style={{ fontSize: 10, color: "#888", fontFamily: "'Space Mono', monospace" }}>
                        <span style={{ color: "#555" }}>Lag: </span>
                        {snap.lagSignal.asset} {snap.lagSignal.status}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const BDC_DATA = [
  { ticker: "ARCC",   name: "Ares Capital",     price: 21.34, change: 0.42,  nav: 19.77, yield: 9.8,  nonAccrual: 1.2, manager: "Ares" },
  { ticker: "OBDC",   name: "Blue Owl Capital",  price: 15.62, change: -0.18, nav: 15.41, yield: 10.4, nonAccrual: 0.8, manager: "Blue Owl" },
  { ticker: "FSKKR",  name: "FS KKR Capital",    price: 19.88, change: -0.61, nav: 23.12, yield: 13.1, nonAccrual: 2.1, manager: "KKR" },
  { ticker: "GBDC",   name: "Golub Capital BDC",  price: 14.44, change: 0.21,  nav: 15.02, yield: 8.6,  nonAccrual: 0.4, manager: "Golub" },
  { ticker: "PCMM",   name: "WisdomTree Priv Crd", price: 24.91, change: 0.08, nav: 24.88, yield: 7.2, nonAccrual: null, manager: "ETF" },
];

const STRESS_METRICS = [
  { label: "Avg Non-Accrual Rate", value: 1.1, benchmark: 2.0, unit: "%", description: "% of portfolio at cost on non-accrual. >2% signals stress.", color: "#00ff88" },
  { label: "PIK Toggle Frequency", value: 12, benchmark: 20, unit: "%", description: "% of deals using PIK. Rising trend = borrower cash stress.", color: "#ffd700" },
  { label: "Spread vs. Lev Loans", value: 185, benchmark: 150, unit: "bps", description: "Private credit spread premium over public leveraged loans.", color: "#00aaff" },
  { label: "Amend & Extend Activity", value: 8, benchmark: 15, unit: "%", description: "% of maturing loans extended. Elevated = refinancing stress.", color: "#ff9944" },
];

// Earnings dates — daysAway computed at render time so it's always accurate
const EARNINGS_CALENDAR = [
  { company: "Ares Capital (ARCC)",  date: "2026-05-07", type: "Earnings" },
  { company: "Blue Owl (OBDC)",      date: "2026-05-09", type: "Earnings" },
  { company: "Apollo Global",        date: "2026-05-06", type: "Earnings" },
  { company: "FS KKR Capital",       date: "2026-05-13", type: "Earnings" },
  { company: "Golub Capital BDC",    date: "2026-05-21", type: "Earnings" },
].map(ev => {
  const msPerDay = 24 * 60 * 60 * 1000;
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const evDate   = new Date(ev.date); evDate.setHours(0, 0, 0, 0);
  const daysAway = Math.round((evDate - today) / msPerDay);
  const label    = daysAway < 0  ? `${Math.abs(daysAway)}d ago`
                 : daysAway === 0 ? "Today"
                 : daysAway === 1 ? "Tomorrow"
                 : `${daysAway}d`;
  return { ...ev, daysAway, label };
});

const PC_NEWS = [
  { id: 1, headline: "Ares Capital reports Q1 non-accrual rate steady at 1.2%, beats dividend coverage estimates", source: "Bloomberg", time: "3h ago", sentiment: "bullish" },
  { id: 2, headline: "Direct lending spreads tighten to 18-month lows as deal flow surges in mid-market", source: "LCD", time: "6h ago", sentiment: "neutral" },
  { id: 3, headline: "PIK loan usage climbs to 14% of new issuance — highest since 2020, Moody's warns", source: "Moody's", time: "1d ago", sentiment: "bearish" },
  { id: 4, headline: "Blue Owl raises $12B for latest direct lending fund, eyes software buyout deals", source: "FT", time: "1d ago", sentiment: "bullish" },
  { id: 5, headline: "Amend-and-extend wave hits private credit as 2026 maturity wall approaches", source: "CreditSights", time: "2d ago", sentiment: "risk-off" },
  { id: 6, headline: "S&P: Private credit default rates remain below 2% but covenant-lite structures raise concern", source: "S&P", time: "2d ago", sentiment: "neutral" },
];

// Live BDC price hook — fetches current price + daily change for BDC tickers.
// Runs every 90s during market hours, 10min when closed.
// NAV/yield/nonAccrual stay from BDC_DATA (quarterly fundamentals).
const BDC_TICKERS = ["ARCC", "OBDC", "FSKKR", "GBDC", "PCMM"];

const useBDCPrices = () => {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const symbols = BDC_TICKERS.join(",");
        const res = await fetch(`/api/stocks?symbols=${symbols}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/stocks ${res.status}`);
        const { stocks } = await res.json();

        // Normalise — keep the shape the BDC panel expects
        const results = {};
        BDC_TICKERS.forEach(ticker => {
          const d = stocks[ticker];
          results[ticker] = d ? {
            price:       d.price,
            change:      d.percentChange ?? d.change ?? 0,
            marketState: d.marketState ?? "CLOSED",
            source:      d.source,
            confidence:  d.confidence,
          } : undefined;
        });
        setPrices(results);
      } catch (e) {
        console.warn("[useBDCPrices]", e.message);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
    const interval = setInterval(
      fetchAll,
      getMarketStatus().isOpen ? 90 * 1000 : 10 * 60 * 1000
    );
    return () => clearInterval(interval);
  }, []);

  return { prices, loading };
};

const PrivateCreditPanel = memo(({ bdcPrices = {}, bdcLoading = false }) => {
  const [pcTab, setPcTab] = useState("bdc");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Header */}
      <div style={{
        background: "rgba(0,170,255,0.06)", border: "1px solid rgba(0,170,255,0.15)",
        borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10,
      }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00aaff", boxShadow: "0 0 8px #00aaff", flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 10, color: "#00aaff", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 2 }}>Private Credit Monitor</div>
          <div style={{ fontSize: 12, color: "#aaa" }}>Tracking BDCs, stress indicators, and direct lending signals. Data is indicative — verify with primary sources.</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 0 }}>
        {[
          { id: "bdc",     label: "BDC Tracker" },
          { id: "stress",  label: "Stress Indicators" },
          { id: "news",    label: "Credit News" },
          { id: "calendar",label: "Earnings" },
        ].map(t => (
          <button key={t.id}
            onClick={() => setPcTab(t.id)}
            style={{
              background: pcTab === t.id ? "rgba(0,170,255,0.12)" : "none",
              border: "none", borderBottom: pcTab === t.id ? "2px solid #00aaff" : "2px solid transparent",
              color: pcTab === t.id ? "#00aaff" : "#555",
              padding: "6px 14px 8px", cursor: "pointer",
              fontSize: 11, fontFamily: "'Space Mono', monospace", letterSpacing: 1,
              textTransform: "uppercase", transition: "all 0.2s",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* BDC TRACKER */}
      {pcTab === "bdc" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Table header */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr", gap: 8, padding: "4px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            {["Ticker", "Name", "Price", "NAV Prem", "Yield", "Non-Accrual"].map(h => (
              <span key={h} style={{ fontSize: 9, color: "#444", letterSpacing: 1, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>{h}</span>
            ))}
          </div>
          {BDC_DATA.map(bdc => {
            // Merge live price/change if fetched; fall back to static BDC_DATA
            const live     = bdcPrices[bdc.ticker];
            const price    = live?.price  ?? bdc.price;
            const change   = live?.change ?? bdc.change;
            const isClosed = live?.marketState === "CLOSED" || !live;
            const navPrem  = ((price - bdc.nav) / bdc.nav * 100);
            const isPos    = change >= 0;
            const navColor = navPrem >= 0 ? "#00ff88" : "#ff4466";
            return (
              <div key={bdc.ticker} style={{
                display: "grid", gridTemplateColumns: "1fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr",
                gap: 8, padding: "10px 10px",
                background: isPos ? "rgba(0,255,136,0.02)" : "rgba(255,68,102,0.02)",
                border: `1px solid ${isPos ? "rgba(0,255,136,0.08)" : "rgba(255,68,102,0.08)"}`,
                borderRadius: 6, alignItems: "center",
                borderLeft: `3px solid ${isPos ? "#00ff88" : "#ff4466"}`,
                opacity: bdcLoading && !live ? 0.6 : 1,
                transition: "opacity 0.3s",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>{bdc.ticker}</div>
                  <div style={{ fontSize: 9, color: "#555", marginTop: 1 }}>{bdc.manager}</div>
                </div>
                <div style={{ fontSize: 11, color: "#aaa" }}>{bdc.name}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: isClosed ? "#888" : "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>
                    {bdcLoading && !live ? "..." : `$${price.toFixed(2)}`}
                  </div>
                  <div style={{ fontSize: 10, color: isPos ? "#00ff88" : "#ff4466", fontFamily: "'Space Mono', monospace" }}>
                    {bdcLoading && !live ? "" : fmtChange(change)}
                    {isClosed && live && <span style={{ color: "#555", marginLeft: 4, fontSize: 9 }}>LAST</span>}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: navColor, fontFamily: "'Space Mono', monospace" }}>
                    {navPrem >= 0 ? "+" : ""}{navPrem.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 9, color: "#444" }}>vs ${bdc.nav}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#ffd700", fontFamily: "'Space Mono', monospace" }}>
                  {bdc.yield}%
                </div>
                <div>
                  {bdc.nonAccrual !== null ? (
                    <span style={{
                      fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                      color: bdc.nonAccrual > 1.5 ? "#ff4466" : bdc.nonAccrual > 0.8 ? "#ffd700" : "#00ff88",
                    }}>
                      {bdc.nonAccrual}%
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: "#444", fontFamily: "'Space Mono', monospace" }}>N/A</span>
                  )}
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: "#333", fontFamily: "'Space Mono', monospace", padding: "4px 4px", marginTop: 2 }}>
            NAV Premium = (Price − NAV) / NAV. Negative = trading at discount. Non-accrual &gt;2% = elevated stress.
          </div>
        </div>
      )}

      {/* STRESS INDICATORS */}
      {pcTab === "stress" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {STRESS_METRICS.map(metric => {
            const pct = Math.min((metric.value / metric.benchmark) * 100, 100);
            const isStressed = metric.value >= metric.benchmark * 0.8;
            return (
              <div key={metric.label} style={{
                background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 8, padding: "12px 14px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#d4d4d4", marginBottom: 3 }}>{metric.label}</div>
                    <div style={{ fontSize: 11, color: "#555", lineHeight: 1.4 }}>{metric.description}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: metric.color, fontFamily: "'Space Mono', monospace" }}>
                      {metric.value}<span style={{ fontSize: 12 }}>{metric.unit}</span>
                    </div>
                    <div style={{ fontSize: 9, color: "#444", fontFamily: "'Space Mono', monospace" }}>
                      WARN AT {metric.benchmark}{metric.unit}
                    </div>
                  </div>
                </div>
                <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${pct}%`,
                    background: isStressed
                      ? `linear-gradient(90deg, ${metric.color}, #ff4466)`
                      : metric.color,
                    borderRadius: 3, transition: "width 1s ease",
                    boxShadow: `0 0 8px ${metric.color}66`,
                  }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>0</span>
                  <span style={{
                    fontSize: 9, fontFamily: "'Space Mono', monospace",
                    color: isStressed ? "#ff4466" : "#444",
                    fontWeight: isStressed ? 700 : 400,
                  }}>
                    {isStressed ? "ELEVATED" : "NORMAL"} — {pct.toFixed(0)}% of warning threshold
                  </span>
                  <span style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>{metric.benchmark}{metric.unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CREDIT NEWS */}
      {pcTab === "news" && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 10, color: "#444", fontFamily: "'Space Mono', monospace", letterSpacing: 1, marginBottom: 8 }}>
            SOURCES: MOODYS · S&P · CREDITSIGHTS · LCD · PITCHBOOK
          </div>
          {PC_NEWS.map(item => <NewsItem key={item.id} item={item} />)}
        </div>
      )}

      {/* EARNINGS CALENDAR */}
      {pcTab === "calendar" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, color: "#444", fontFamily: "'Space Mono', monospace", letterSpacing: 1, marginBottom: 4 }}>
            UPCOMING EARNINGS — MAJOR PRIVATE CREDIT MANAGERS
          </div>
          {EARNINGS_CALENDAR.map((ev, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 6, padding: "10px 14px",
              opacity: ev.daysAway < 0 ? 0.45 : 1,   // dim past events
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 2 }}>{ev.company}</div>
                <div style={{ fontSize: 10, color: "#555", fontFamily: "'Space Mono', monospace" }}>{ev.type}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono', monospace" }}>
                  {new Date(ev.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
                <div style={{
                  fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                  color: ev.daysAway < 0  ? "#444"
                       : ev.daysAway <= 3  ? "#ff4466"
                       : ev.daysAway <= 7  ? "#ffd700"
                       : "#555",
                  marginTop: 2,
                }}>
                  {ev.label}
                </div>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 10, color: "#333", fontFamily: "'Space Mono', monospace", marginTop: 4 }}>
            KEY METRICS TO WATCH: Non-accrual rates · PIK toggle frequency · NAV per share · Dividend coverage ratio
          </div>
        </div>
      )}
    </div>
  );
});
export default function MarketMonitor() {
  const [isPaused, setIsPaused] = useState(false);
  const { assets, lastUpdated, error, wsConnected, systemStatus, timeframe, setTimeframe } = useMarketData(isPaused);

  // Compute regime here so both useAlerts and MarketRegimeCard share it
  const currentRegime = useMemo(() => {
    const spy = assets.find(a => a.id === "SPY");
    const vix = assets.find(a => a.id === "VIX");
    const btc = assets.find(a => a.id === "BTC");
    return getMarketRegime({
      vixPrice:  vix?.price  ?? null,
      vixChange: vix?.change ?? null,
      spyChange: spy?.change ?? null,
      btcChange: btc?.change ?? null,
    }).regime;
  }, [assets]);

  const { alerts, notifications } = useAlerts(assets, currentRegime);
  const time = useClock();
  const fearGreed = useFearGreed();
  const cryptoGlobal = useCryptoGlobal();
  const { refresh: refreshFearGreed, refreshing: fgRefreshing } = fearGreed;
  const [centerTab, setCenterTab] = useState("market");
  const [riskMode, setRiskMode] = useState("on");
  const [showSidebar, setShowSidebar] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [journal, setJournal] = useState(() => loadJournal());
  const alertsFeedRef = useRef(null);

  // Mobile detection + collapsible section state (start closed for clean One Glance view)
  const isMobile = useIsMobile(768);
  const { open: sectionOpen, toggle: toggleSection } = useCollapsible(
    ["signals", "heatmap", "chart", "quicklinks"]
  );

  // Leveraged asset prices + lag signals — still via useLeveragedAssets (Binance ETFs, not in backend)
  const { prices: leveragedPrices, loading: leveragedLoading } = useLeveragedAssets();
  const btcChangeForLag = assets.find(a => a.id === "BTC")?.change ?? 0;
  const lagSignals = LEVERAGED_ASSETS.map(a => {
    const p = leveragedPrices[a.id];
    if (!p) return { ...a, change: null, signal: { status: "IN_SYNC", strength: null } };
    return { ...a, price: p.price, change: p.change, signal: detectLeadLag(btcChangeForLag, p.change) };
  });

  // Momentum stocks + BDC prices now come from the central assets array (fetched server-side)
  // useBDCPrices and useStockMomentum hooks are retained only for the Stocks tab MA20/MA50 calculations
  // which require 3mo OHLCV — not just current price. Portfolio and BDC panel use assets directly.
  const { stocks: momentumStocks, loading: momentumLoading, lastFetch: momentumLastFetch } = useStockMomentum();
  const { prices: bdcPrices, loading: bdcLoading } = useBDCPrices();

  // Build auxData for portfolio from BOTH assets array AND hook fallbacks
  // Assets array (from backend) is the primary source; hooks are fallback only
  const assetMap = Object.fromEntries(assets.map(a => [a.id, a]));
  const portfolioAuxData = {
    // From central assets (backend, most reliable)
    ...Object.fromEntries(
      ["PLTR","SOFI","ZETA","ARCC","OBDC","FSKKR","GBDC","PCMM"]
        .filter(id => assetMap[id]?.price)
        .map(id => [id, {
          price:      assetMap[id].price,
          change:     assetMap[id].change,
          source:     assetMap[id].source,
          timestamp:  assetMap[id].timestamp,
          confidence: assetMap[id].confidence,
          stale:      assetMap[id].stale,
        }])
    ),
    // Hook fallbacks (for tickers not yet in backend)
    ...Object.fromEntries(
      Object.entries(momentumStocks)
        .filter(([id, d]) => d?.price && !assetMap[id]?.price)
        .map(([id, d]) => [id, { price: d.price, change: d.change, source: "Yahoo", confidence: "medium" }])
    ),
    ...Object.fromEntries(
      Object.entries(bdcPrices)
        .filter(([id, d]) => d?.price && !assetMap[id]?.price)
        .map(([id, d]) => [id, { price: d.price, change: d.change, source: "Yahoo", confidence: "medium" }])
    ),
  };

  // BDC prices for Private Credit panel — prefer backend assets, fallback to hook
  const liveBdcPrices = {
    ...bdcPrices,
    ...Object.fromEntries(
      ["ARCC","OBDC","FSKKR","GBDC","PCMM"]
        .filter(id => assetMap[id]?.price)
        .map(id => [id, { price: assetMap[id].price, change: assetMap[id].change, marketState: assetMap[id].marketState }])
    ),
  };

  const isMarketOpen = () => getMarketStatus().isOpen;

  const sentimentScore = assets.reduce((acc, a) => {
    return acc + (a.change >= 0 ? 1 : -1) * Math.abs(a.change);
  }, 0);

  return (
    <div data-app-root style={{
      minHeight: "100dvh",           /* dvh = dynamic viewport height — excludes mobile browser chrome */
      background: "#0a0a0f",
      fontFamily: "'Outfit', sans-serif", color: "#f0f0f0",
      display: "flex", flexDirection: "column",
      userSelect: "none",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700;800;900&display=swap');

        /* ── GLOBAL RESETS ───────────────────────────────────────── */
        /* html/body/root sizing lives in index.html so it runs before React.
           We only need component-level resets here. */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { -webkit-text-size-adjust: 100%; }

        /* ── SCROLLBAR ──────────────────────────────────────────── */
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes scan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100dvh); } }
        body { font-size: 14px; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 6px 14px; border-radius: 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; font-family: 'Space Mono', monospace; transition: all 0.2s; color: #888; }
        .tab-btn:hover { background: rgba(255,255,255,0.05); color: #ccc; }
        .tab-active { background: rgba(255,255,255,0.08) !important; color: #00ff88 !important; }
        .asset-grid { display: flex; flex-direction: column; gap: 6px; }

        /* ── MOBILE LAYOUT (≤768px) ───────────────────────────── */
        @media (max-width: 768px) {

          /* ── Viewport + safe area ──────────────────────────────
           * index.html owns html/body/#root sizing and viewport-fit=cover.
           * viewport-fit=cover is what makes env(safe-area-inset-*) non-zero.
           * Here we only handle the app-level wrapper and inner panels.
           */

          /* Prevent rubber-band scroll bounce revealing background */
          html, body { overscroll-behavior: none; overflow-x: hidden; }

          /* App wrapper — fill #root, no horizontal escape */
          div[data-app-root] {
            width: 100% !important;
            max-width: 100% !important;           /* never use 100vw — includes scrollbar */
            overflow-x: hidden !important;
            /* Safe-area padding at the outermost app layer.
               Works because index.html sets viewport-fit=cover. */
            padding-top: env(safe-area-inset-top, 0px) !important;
            padding-bottom: env(safe-area-inset-bottom, 0px) !important;
            padding-left: env(safe-area-inset-left, 0px) !important;
            padding-right: env(safe-area-inset-right, 0px) !important;
          }

          /* Top bar — compact, keep only essentials */
          .topbar-logo-subtitle { display: none !important; }
          .topbar-ticker        { display: none !important; }
          .topbar-debug         { display: none !important; }
          .topbar-clock-detail  { display: none !important; }
          header {
            height: 48px !important;
            padding: 0 12px !important;
          }

          /* Main grid → single column, let root wrapper scroll */
          .main-grid {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: visible !important;
            overflow-x: hidden !important;   /* prevent any child from causing horiz scroll */
            height: auto !important;
            flex: 1 !important;
            width: 100% !important;
            max-width: 100% !important;
          }

          /* Left panel → horizontal scroll strip, compact */
          .left-panel {
            padding: 10px 10px 6px !important;
            overflow-x: auto !important;
            overflow-y: hidden !important;
            max-height: none !important;
            border-bottom: 1px solid rgba(255,255,255,0.07) !important;
            flex-shrink: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
          }
          .left-panel-headers { display: none !important; }
          .asset-grid {
            flex-direction: row !important;
            gap: 8px !important;
            padding-bottom: 4px !important;
          }
          .asset-card {
            min-width: 138px !important;
            flex-shrink: 0 !important;
            padding: 10px 12px !important;
          }

          /* Center panel — width constrained, safe area bottom padding */
          .center-panel {
            overflow-y: visible !important;
            overflow-x: hidden !important;
            min-height: 0 !important;
            padding: 12px !important;
            padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important;
            flex: 1 !important;
            width: 100% !important;
            max-width: 100% !important;
          }

          /* Flex children must not overflow their container */
          .main-grid > *, .center-panel > * { min-width: 0; max-width: 100%; }

          /* Center tab bar — scrollable row, bigger tap targets */
          .tab-btn {
            padding: 10px 14px !important;
            font-size: 10px !important;
            white-space: nowrap !important;
          }

          /* Right sidebar → bottom drawer with home indicator clearance */
          .right-sidebar {
            position: fixed !important;
            bottom: 0 !important; left: 0 !important; right: 0 !important;
            top: auto !important;
            height: 72dvh !important;
            z-index: 200 !important;
            border-top: 1px solid rgba(255,255,255,0.12) !important;
            border-radius: 16px 16px 0 0 !important;
            animation: slideUp 0.25s ease !important;
            overflow-y: auto !important;
            padding-bottom: env(safe-area-inset-bottom, 0px) !important;
          }

          /* Alerts bar → compact strip */
          .alerts-bar {
            max-height: 90px !important;
            font-size: 11px !important;
          }

          /* Charts — shorter on mobile */
          .recharts-wrapper { max-height: 130px !important; }

          /* Heatmap → 2 columns */
          .heatmap-grid { grid-template-columns: repeat(2, 1fr) !important; }

          /* Portfolio → drop cost + alloc columns */
          .portfolio-row       { grid-template-columns: 1fr 0.8fr 0.8fr 0.8fr !important; }
          .portfolio-col-hide  { display: none !important; }

          /* Notification toasts → full width */
          .toast-container { left: 10px !important; right: 10px !important; top: 56px !important; }

          /* ALL buttons — minimum 44px tap target (Apple HIG) */
          button { min-height: 44px !important; }

          /* Regime card / setup card — larger text on mobile */
          .mobile-regime-label { font-size: 26px !important; }
          .mobile-risk-label   { font-size: 18px !important; }

          /* Collapsible sections */
          .mobile-collapsible-hidden { display: none !important; }
          .mobile-collapsible-toggle {
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            padding: 12px 14px !important;
            min-height: 44px !important;
            cursor: pointer !important;
            border-radius: 8px !important;
            background: rgba(255,255,255,0.03) !important;
            border: 1px solid rgba(255,255,255,0.07) !important;
            color: #666 !important;
            font-size: 10px !important;
            letter-spacing: 1.5px !important;
            text-transform: uppercase !important;
            font-family: 'Space Mono', monospace !important;
            margin-bottom: 4px !important;
          }
        }

        /* ── SMALL MOBILE (≤480px) ────────────────────────────── */
        @media (max-width: 480px) {
          .asset-card          { min-width: 118px !important; }
          .center-panel        { padding: 8px !important; padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important; }
          .topbar-risk         { font-size: 9px !important; padding: 4px 8px !important; }
          .mobile-regime-label { font-size: 22px !important; }
          /* Extra insurance against horizontal overflow on very small screens */
          div[data-app-root], .main-grid, .center-panel, .left-panel {
            max-width: 100% !important;
            overflow-x: hidden !important;
          }
        }
      `}</style>

      {/* Scan line effect */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
      }} />

      {/* Notifications */}
      <div className="toast-container" style={{ position: "fixed", top: 64, right: 16, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8 }}>
        {notifications.map(n => <NotificationToast key={n.id} notification={n} />)}
      </div>

      {/* TOP BAR */}
      <header style={{
        height: 52, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        background: "rgba(10,10,15,0.95)", backdropFilter: "blur(10px)",
        position: "sticky", top: 0, zIndex: 100, flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 28, height: 28, background: "linear-gradient(135deg, #00ff88, #00aaff)",
            borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#0a0a0f" }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2, color: "#f0f0f0", fontFamily: "'Space Mono', monospace" }}>
              THE MARKET MONITOR
            </div>
            <div className="topbar-logo-subtitle" style={{ fontSize: 9, color: "#666", letterSpacing: 1 }}>FINANCIAL INTELLIGENCE TERMINAL</div>
          </div>
        </div>

        {/* Center — ticker */}
        <div className="topbar-ticker" style={{ display: "flex", gap: 20, alignItems: "center", overflow: "hidden" }}>
          {assets.slice(0, 5).map(a => (
            <div key={a.id} style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 10, color: "#666", fontFamily: "'Space Mono', monospace" }}>{a.id}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#d4d4d4", fontFamily: "'Space Mono', monospace" }}>{fmtPrice(a.price, a.unit)}</span>
              <span style={{ fontSize: 10, color: sentimentColor(a.change), fontFamily: "'Space Mono', monospace" }}>{fmtChange(a.change)}</span>
            </div>
          ))}
        </div>

        {/* Right */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            className="topbar-risk"
            onClick={() => setRiskMode(m => m === "on" ? "off" : "on")}
            style={{
              background: riskMode === "on" ? "rgba(0,255,136,0.15)" : "rgba(255,68,102,0.15)",
              border: `1px solid ${riskMode === "on" ? "rgba(0,255,136,0.4)" : "rgba(255,68,102,0.4)"}`,
              color: riskMode === "on" ? "#00ff88" : "#ff4466",
              padding: "4px 12px", borderRadius: 4, cursor: "pointer",
              fontSize: 10, fontFamily: "'Space Mono', monospace", letterSpacing: 1,
            }}>
            RISK {riskMode.toUpperCase()}
          </button>
          {/* LOG TRADE — captures full market snapshot to journal */}
          <button
            onClick={() => {
              const snap    = captureSnapshot({ assets, regime: currentRegime, lagSignals });
              const updated = addJournalEntry(snap);
              setJournal(updated);
              setCenterTab("journal");   // jump to journal tab after logging
            }}
            title="Log current market conditions as a trade snapshot"
            style={{
              background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.3)",
              color: "#ffd700", padding: "4px 10px", borderRadius: 4, cursor: "pointer",
              fontSize: 9, fontFamily: "'Space Mono', monospace", letterSpacing: 1,
            }}>
            LOG TRADE
          </button>
          <button
            onClick={() => setIsPaused(p => !p)}
            title={isPaused ? "Resume live data" : "Pause live data"}
            style={{
              background: isPaused ? "rgba(255,215,0,0.15)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${isPaused ? "rgba(255,215,0,0.4)" : "rgba(255,255,255,0.12)"}`,
              color: isPaused ? "#ffd700" : "#555",
              padding: "4px 10px", borderRadius: 4, cursor: "pointer",
              fontSize: 12, lineHeight: 1,
            }}>
            {isPaused ? "▶" : "⏸"}
          </button>
          <button
            className="topbar-debug"
            onClick={() => setDebugMode(d => !d)}
            title="Toggle debug mode"
            style={{
              background: debugMode ? "rgba(0,170,255,0.15)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${debugMode ? "rgba(0,170,255,0.4)" : "rgba(255,255,255,0.12)"}`,
              color: debugMode ? "#00aaff" : "#555",
              padding: "4px 10px", borderRadius: 4, cursor: "pointer",
              fontSize: 9, fontFamily: "'Space Mono', monospace", letterSpacing: 1,
            }}>
            DEBUG
          </button>
          <button
            onClick={() => setShowSidebar(s => !s)}
            title="Toggle news/social panel"
            style={{
              background: showSidebar ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: showSidebar ? "#e8e8e8" : "#555",
              padding: "4px 10px", borderRadius: 4, cursor: "pointer",
              fontSize: 13, lineHeight: 1, letterSpacing: 0,
            }}>
            {showSidebar ? "▶" : "◀"}
          </button>
          {/* STATUS STACK — right-aligned terminal style */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, minWidth: 110 }}>

            {/* Clock */}
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
              {time.toLocaleTimeString("en-US", { hour12: false })}
            </div>

            {/* Divider */}
            <div style={{ width: "100%", height: 1, background: "rgba(255,255,255,0.06)" }} />

            {/* Market Status */}
            {(() => {
              const open   = isMarketOpen();
              const color  = error ? "#ffd700" : open ? "#00ff88" : "#ff4466";
              const label  = error ? "API ERR" : open ? "MARKET OPEN" : "MARKET CLOSED";
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                  <span style={{ fontSize: 9, color, fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>{label}</span>
                  <div style={{
                    width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                    background: color,
                    boxShadow: open && !error ? `0 0 6px ${color}` : "none",
                    animation: open && !error ? "pulse 2s infinite" : "none",
                  }} />
                </div>
              );
            })()}

            {/* System Status — single line, priority: OFFLINE > DEGRADED > LIVE */}
            {(() => {
              const raw    = systemStatus?.status ?? "LIVE";
              // isPaused overrides to show PAUSED instead of system status
              const s      = isPaused ? "PAUSED" : raw;
              const color  = s === "PAUSED"   ? "#ffd700"
                           : s === "LIVE"     ? "#00ff88"
                           : s === "DEGRADED" ? "#ffd700"
                           :                   "#ff4466";
              // WS dot: green=active, gray=localhost polling, yellow=off
              const wsColor = wsConnected ? "#00ff88" : IS_LOCALHOST ? "#444" : "#ffd700";
              const wsTitle = wsConnected ? "WebSocket active" : IS_LOCALHOST ? "Polling mode" : "WebSocket off";
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                  <span style={{ fontSize: 9, color, fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
                    {s === "PAUSED"   ? "PAUSED"
                   : s === "LIVE"    ? "LIVE"
                   : s === "DEGRADED"? "DEGRADED"
                   :                  "OFFLINE"}
                  </span>
                  {/* WS dot replaces "WS LIVE" text */}
                  <div
                    title={wsTitle}
                    style={{
                      width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                      background: wsColor,
                      boxShadow: wsConnected ? "0 0 5px #00ff88" : "none",
                      animation: wsConnected ? "pulse 2s infinite" : "none",
                    }}
                  />
                </div>
              );
            })()}

            {/* Last updated — subtle, only when available */}
            {lastUpdated && (
              <div style={{ fontSize: 8, color: "#333", fontFamily: "'Space Mono', monospace" }}>
                {lastUpdated.toLocaleTimeString("en-US", { hour12: false })}
              </div>
            )}

          </div>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <div className="main-grid" style={{ flex: 1, display: "grid", gridTemplateColumns: showSidebar ? "240px 1fr 320px" : "240px 1fr", gridTemplateRows: "1fr auto", gap: 1, background: "rgba(255,255,255,0.04)", minHeight: 0, transition: "grid-template-columns 0.3s ease" }}>

        {/* LEFT — Asset Panel */}
        <div className="left-panel" style={{ background: "#0a0a0f", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Column headers + timeframe toggle */}
          <div className="left-panel-headers" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 14px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 8 }}>
            <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Asset</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* Timeframe selector — crypto sparklines only */}
              <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                {Object.keys(TIMEFRAMES).map(tf => (
                  <button
                    key={tf}
                    onClick={() => setTimeframe(tf)}
                    title={TIMEFRAMES[tf].desc}
                    style={{
                      background: timeframe === tf ? "rgba(0,255,136,0.12)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${timeframe === tf ? "rgba(0,255,136,0.3)" : "rgba(255,255,255,0.08)"}`,
                      color: timeframe === tf ? "#00ff88" : "#444",
                      padding: "2px 6px", borderRadius: 3, cursor: "pointer",
                      fontSize: 8, fontFamily: "'Space Mono', monospace",
                      letterSpacing: 0.5, minHeight: "unset",
                      transition: "all 0.15s",
                    }}
                  >{tf}</button>
                ))}
              </div>
              <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Price</span>
              <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Chg</span>
            </div>
          </div>
          {/* Grouped by category */}
          {[
            { label: "Equities",    ids: ["SPY", "QQQ"] },
            { label: "Volatility",  ids: ["VIX"] },
            { label: "Crypto",      ids: ["BTC", "ETH"] },
            { label: "Commodities", ids: ["WTI", "GOLD"] },
            { label: "Macro",       ids: ["DXY", "TNX"] },
          ].map(group => {
            const groupAssets = assets.filter(a => group.ids.includes(a.id));
            if (!groupAssets.length) return null;
            return (
              <div key={group.label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", padding: "2px 4px 6px", borderLeft: "2px solid #333", paddingLeft: 8 }}>
                  {group.label}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {groupAssets.map(asset => <AssetCard key={asset.id} asset={asset} debugMode={debugMode} timeframe={timeframe} />)}
                </div>
              </div>
            );
          })}
        </div>

        {/* CENTER — Charts & Metrics */}
        <div className="center-panel" style={{ background: "#0a0a0f", padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Center tab bar */}
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
            {[
              { id: "market",    label: "Markets" },
              { id: "stocks",    label: "Stocks" },
              { id: "credit",    label: "Private Credit" },
              { id: "portfolio", label: "Portfolio" },
              { id: "journal",   label: `Journal${journal.length > 0 ? ` (${journal.length})` : ""}` },
            ].map(t => (
              <button key={t.id}
                onClick={() => setCenterTab(t.id)}
                style={{
                  background: centerTab === t.id ? "rgba(255,255,255,0.06)" : "none",
                  border: "none", borderBottom: centerTab === t.id ? "2px solid #00ff88" : "2px solid transparent",
                  color: centerTab === t.id ? "#00ff88" : "#555",
                  padding: "6px 16px 8px", cursor: "pointer",
                  fontSize: 11, fontFamily: "'Space Mono', monospace", letterSpacing: 1,
                  textTransform: "uppercase", transition: "all 0.2s",
                }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* PRIVATE CREDIT TAB */}
          {centerTab === "credit" && (
            <PrivateCreditPanel bdcPrices={bdcPrices} bdcLoading={bdcLoading} />
          )}

          {/* STOCKS TAB */}
          {centerTab === "stocks" && (
            <StockMomentumPanel
              stocks={momentumStocks}
              loading={momentumLoading}
              lastFetch={momentumLastFetch}
            />
          )}

          {/* PORTFOLIO TAB */}
          {centerTab === "portfolio" && (
            <PortfolioPanel
              assets={assets}
              momentumStocks={momentumStocks}
              bdcPrices={bdcPrices}
              debugMode={debugMode}
            />
          )}

          {/* JOURNAL TAB */}
          {centerTab === "journal" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
                  Trade Journal — {journal.length} snapshot{journal.length !== 1 ? "s" : ""}
                </span>
                {journal.length > 0 && (
                  <button onClick={() => {
                    if (window.confirm("Clear all journal entries?")) {
                      saveJournal([]);
                      setJournal([]);
                    }
                  }} style={{
                    background: "none", border: "1px solid rgba(255,68,102,0.2)",
                    color: "#ff4466", padding: "3px 10px", borderRadius: 4,
                    cursor: "pointer", fontSize: 9, fontFamily: "'Space Mono', monospace",
                  }}>CLEAR ALL</button>
                )}
              </div>
              <TradeJournalPanel
                entries={journal}
                onDelete={(id) => {
                  const updated = journal.filter(e => e.id !== id);
                  saveJournal(updated);
                  setJournal(updated);
                }}
              />
            </div>
          )}

          {/* MARKETS TAB */}
          {centerTab === "market" && (<>

          {/* ── MOBILE-FIRST LAYOUT ────────────────────────────── */}
          {isMobile ? (<>

            {/* ONE GLANCE MODE — regime + BTC + risk + setup + action + what changed */}
            <MobileCoreSignalCard
              assets={assets}
              regime={currentRegime}
              lagSignals={lagSignals}
            />

            {/* Priority assets strip is handled by the left panel horizontal scroll above */}

            {/* Quick Signals — collapsible, collapsed by default on mobile */}
            <div>
              <div className="mobile-collapsible-toggle" onClick={() => toggleSection("signals")}>
                <span>Quick Signals</span>
                <span>{sectionOpen.signals ? "▲ HIDE" : "▼ SHOW"}</span>
              </div>
              {sectionOpen.signals && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                  <LeverageRiskGauge assets={assets} />
                  <BtcLeadLagPanel assets={assets} signals={lagSignals} loading={leveragedLoading} />
                  <NewsReactionPanel assets={assets} />
                </div>
              )}
            </div>

            {/* Heatmap — collapsible */}
            <div>
              <div className="mobile-collapsible-toggle" onClick={() => toggleSection("heatmap")}>
                <span>Asset Heatmap</span>
                <span>{sectionOpen.heatmap ? "▲ HIDE" : "▼ SHOW"}</span>
              </div>
              {sectionOpen.heatmap && (
                <div style={{ marginTop: 8 }}>
                  <Heatmap assets={assets} />
                </div>
              )}
            </div>

            {/* Full Detail — everything else, collapsed */}
            <div>
              <div className="mobile-collapsible-toggle" onClick={() => toggleSection("chart")}>
                <span>Full Detail</span>
                <span>{sectionOpen.chart ? "▲ HIDE" : "▼ SHOW"}</span>
              </div>
              {sectionOpen.chart && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                  <MarketRegimeCard assets={assets} onRegimeChange={setRiskMode} />
                  <SetupDetectorPanel assets={assets} regime={currentRegime} lagSignals={lagSignals.map(s => s.signal)} />
                  <SentimentGauge assets={assets} />
                </div>
              )}
            </div>

          </>) : (<>

          {/* ── DESKTOP LAYOUT (unchanged) ─────────────────────── */}

          {/* Market Regime Engine — replaces old summary banner */}
          <MarketRegimeCard assets={assets} onRegimeChange={setRiskMode} />

          {/* Setup Detector — only renders when a setup exists */}
          <SetupDetectorPanel assets={assets} regime={currentRegime} lagSignals={lagSignals.map(s => s.signal)} />

          {/* Leverage Risk + BTC Lead Lag — side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <LeverageRiskGauge assets={assets} />
            <BtcLeadLagPanel assets={assets} signals={lagSignals} loading={leveragedLoading} />
          </div>

          {/* Sentiment + Aggregate Signal */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SentimentGauge assets={assets} />
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 10 }}>
                Aggregate Signal
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { label: "Equities",   val: assets.find(a => a.id === "SPY")?.change ?? 0, max: 3 },
                  { label: "Crypto",     val: ((assets.find(a => a.id === "BTC")?.change ?? 0) + (assets.find(a => a.id === "ETH")?.change ?? 0)) / 2, max: 6 },
                  { label: "Volatility", val: -(assets.find(a => a.id === "VIX")?.change ?? 0), max: 5 },
                  { label: "Oil",        val: assets.find(a => a.id === "WTI")?.change ?? 0, max: 3 },
                  { label: "Gold",       val: assets.find(a => a.id === "GOLD")?.change ?? 0, max: 2 },
                ].map(({ label, val, max }) => {
                  const clampedPct = Math.min(Math.abs(val) / max * 100, 100);
                  const barColor = val >= 0 ? "#00ff88" : "#ff4466";
                  return (
                    <div key={label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ fontSize: 10, color: "#777", letterSpacing: 1, fontFamily: "'Space Mono', monospace" }}>{label}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: barColor, fontFamily: "'Space Mono', monospace" }}>{val >= 0 ? "+" : ""}{val.toFixed(2)}%</span>
                      </div>
                      <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${clampedPct}%`,
                          background: barColor, borderRadius: 2,
                          transition: "width 0.8s ease",
                          boxShadow: `0 0 6px ${barColor}88`,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <Heatmap assets={assets} />

          {/* News Reaction Tracker — only visible when events detected */}
          <NewsReactionPanel assets={assets} />

          {/* Main chart — BTC + SPY */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: 16 }}>
            <div style={{ display: "flex", gap: 16, marginBottom: 12, alignItems: "center" }}>
              <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
                Price Action — 24h
              </div>
              <div style={{ display: "flex", gap: 12, marginLeft: "auto" }}>
                {[
                  { label: "BTC", color: "#f7931a" },
                  { label: "SPY", color: "#00aaff" },
                  { label: "VIX", color: "#ff4466" },
                ].map(l => (
                  <div key={l.label} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <div style={{ width: 16, height: 2, background: l.color, borderRadius: 1 }} />
                    <span style={{ fontSize: 9, color: "#666", fontFamily: "'Space Mono', monospace" }}>{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                <Tooltip
                  contentStyle={{ background: "#13131a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
                  labelStyle={{ color: "#888" }}
                />
                {["BTC", "SPY", "VIX"].map((id, idx) => {
                  const asset = assets.find(a => a.id === id);
                  const color = id === "BTC" ? "#f7931a" : id === "SPY" ? "#00aaff" : "#ff4466";
                  if (!asset) return null;
                  const normalized = asset.sparkline.map(p => ({
                    ...p,
                    [id]: ((p.v - asset.sparkline[0].v) / asset.sparkline[0].v * 100).toFixed(3)
                  }));
                  return (
                    <Line key={id} data={normalized} type="monotone" dataKey={id}
                      stroke={color} strokeWidth={1.5} dot={false} connectNulls />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Stats row */}
          {(() => {
            const fgVal = fearGreed.value;
            const fgColor = fgVal === null ? "#555"
              : fgVal >= 75 ? "#00ff88"
              : fgVal >= 55 ? "#aaff44"
              : fgVal >= 45 ? "#ffd700"
              : fgVal >= 25 ? "#ff9944"
              : "#ff4466";
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>

                {/* Fear & Greed — with refresh button */}
                <div style={{
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 8, padding: "10px 12px", textAlign: "center", position: "relative",
                }}>
                  <div style={{ fontSize: 9, color: "#666", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>Fear & Greed</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: fgColor, fontFamily: "'Space Mono', monospace", lineHeight: 1.1 }}>
                    {fgVal !== null ? fgVal : "--"}<span style={{ fontSize: 11 }}>/100</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#666", marginTop: 3 }}>{fearGreed.label}</div>
                  <button
                    onClick={refreshFearGreed}
                    title="Refresh Fear & Greed"
                    style={{
                      position: "absolute", top: 6, right: 6,
                      background: "none", border: "none", cursor: "pointer",
                      color: fgRefreshing ? fgColor : "#444",
                      fontSize: 13, lineHeight: 1, padding: 2,
                      transition: "color 0.2s, transform 0.4s",
                      transform: fgRefreshing ? "rotate(360deg)" : "rotate(0deg)",
                    }}>
                    ↻
                  </button>
                </div>

                {/* Other stats — live from CoinGecko global endpoint */}
                {[
                  {
                    label: "BTC Dominance",
                    val:   cryptoGlobal.btcDominance != null ? cryptoGlobal.btcDominance.toFixed(1) : "—",
                    unit:  "%",
                    sub:   "of total crypto mkt cap",
                    color: "#f7931a",
                  },
                  {
                    label: "Put/Call Ratio",
                    val:   "1.24",
                    unit:  "",
                    sub:   "options sentiment · static",
                    color: "#ff4466",
                  },
                  {
                    label: "24H Global Vol",
                    val:   cryptoGlobal.totalVol24h != null
                      ? `$${(cryptoGlobal.totalVol24h / 1e9).toFixed(0)}B`
                      : "—",
                    unit:  "",
                    sub:   "total crypto volume",
                    color: "#00aaff",
                  },
                ].map(stat => (
                  <div key={stat.label} style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 8, padding: "10px 12px", textAlign: "center",
                  }}>
                    <div style={{ fontSize: 9, color: "#666", letterSpacing: 1, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>{stat.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: stat.color, fontFamily: "'Space Mono', monospace", lineHeight: 1.1 }}>
                      {stat.val}<span style={{ fontSize: 11 }}>{stat.unit}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#666", marginTop: 3 }}>{stat.sub}</div>
                  </div>
                ))}
              </div>
            );
          })()}
          </>)}
          {/* END desktop layout branch */}
          </>)}
        </div>
        {showSidebar && (
        <div className="right-sidebar" style={{ background: "#0a0a0f", display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px 8px", borderBottom: "1px solid rgba(255,255,255,0.07)", flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Quick Links</span>
            <span style={{ fontSize: 10, color: "#444" }}>Click to open in new tab</span>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>

            {/* News Sources */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 8, paddingLeft: 4, borderLeft: "2px solid #333" }}>
                Financial News
              </div>
              {[
                { name: "Reuters Markets",     url: "https://www.reuters.com/markets/",              desc: "Global markets coverage" },
                { name: "Bloomberg Markets",   url: "https://www.bloomberg.com/markets",              desc: "Live market data & news" },
                { name: "CNBC Markets",        url: "https://www.cnbc.com/markets/",                  desc: "US market news" },
                { name: "Wall Street Journal", url: "https://www.wsj.com/news/markets",               desc: "Market & business news" },
                { name: "Financial Times",     url: "https://www.ft.com/markets",                     desc: "Global financial news" },
                { name: "MarketWatch",         url: "https://www.marketwatch.com/",                   desc: "Real-time quotes & news" },
                { name: "Seeking Alpha",       url: "https://seekingalpha.com/market-news/all",       desc: "Analysis & market news" },
                { name: "ZeroHedge",           url: "https://www.zerohedge.com/",                     desc: "Alternative finance news" },
              ].map(link => (
                <a key={link.name} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 10px", marginBottom: 4, borderRadius: 6, textDecoration: "none",
                  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                  transition: "background 0.15s, border-color 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,255,136,0.06)"; e.currentTarget.style.borderColor = "rgba(0,255,136,0.2)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#d4d4d4" }}>{link.name}</div>
                    <div style={{ fontSize: 10, color: "#555", marginTop: 1 }}>{link.desc}</div>
                  </div>
                  <span style={{ fontSize: 12, color: "#444" }}>↗</span>
                </a>
              ))}
            </div>

            {/* Social / Political */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 8, paddingLeft: 4, borderLeft: "2px solid #333" }}>
                Social Signals
              </div>
              {[
                { name: "Trump — Truth Social",  url: "https://truthsocial.com/@realDonaldTrump",  desc: "Market-moving posts", color: "#ff6b35" },
                { name: "Elon Musk — X",          url: "https://x.com/elonmusk",                    desc: "Market commentary",   color: "#1da1f2" },
                { name: "Federal Reserve",         url: "https://x.com/federalreserve",              desc: "Official Fed updates", color: "#5865f2" },
                { name: "Lyn Alden",               url: "https://x.com/LynAldenContact",             desc: "Macro analysis",      color: "#00ff88" },
                { name: "ZeroHedge",               url: "https://x.com/zerohedge",                   desc: "Breaking market news", color: "#ff4466" },
                { name: "Raoul Pal",               url: "https://x.com/RaoulGMI",                    desc: "Macro & crypto",      color: "#ffd700" },
              ].map(link => (
                <a key={link.name} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", marginBottom: 4, borderRadius: 6, textDecoration: "none",
                  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = `rgba(${link.color === "#ff6b35" ? "255,107,53" : link.color === "#1da1f2" ? "29,161,242" : link.color === "#00ff88" ? "0,255,136" : link.color === "#ff4466" ? "255,68,102" : link.color === "#ffd700" ? "255,215,0" : "88,101,242"},0.08)`; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", background: link.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800, color: "#0a0a0f", flexShrink: 0, fontFamily: "'Space Mono', monospace",
                  }}>{link.name.slice(0,2).toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#d4d4d4" }}>{link.name}</div>
                    <div style={{ fontSize: 10, color: "#555", marginTop: 1 }}>{link.desc}</div>
                  </div>
                  <span style={{ fontSize: 12, color: "#444" }}>↗</span>
                </a>
              ))}
            </div>

            {/* YouTube Creators */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 8, paddingLeft: 4, borderLeft: "2px solid #333" }}>
                YouTube Creators
              </div>
              {[
                { name: "Amit",            url: "https://www.youtube.com/@amitinvesting",  color: "#ff4466" },
                { name: "Steven Fiorillo", url: "https://www.youtube.com/@StevenFiorillo", color: "#00aaff" },
                { name: "Future Investing",url: "https://www.youtube.com/@FutureInvesting", color: "#00ff88" },
                { name: "Tevis Howard",    url: "https://www.youtube.com/@tevishoward",    color: "#ffd700" },
              ].map(link => (
                <a key={link.name} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", marginBottom: 4, borderRadius: 6, textDecoration: "none",
                  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,68,102,0.06)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", background: link.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800, color: "#0a0a0f", flexShrink: 0, fontFamily: "'Space Mono', monospace",
                  }}>{link.name.slice(0,2).toUpperCase()}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#d4d4d4", flex: 1 }}>{link.name}</div>
                  <span style={{ fontSize: 12, color: "#444" }}>↗</span>
                </a>
              ))}
            </div>

          </div>
        </div>
        )}

        {/* BOTTOM — Alerts Log */}
        <div className="alerts-bar" style={{
          gridColumn: "1 / -1", background: "#0a0a0f",
          borderTop: "1px solid rgba(255,255,255,0.07)",
          padding: "8px 16px",
          paddingBottom: "calc(80px + env(safe-area-inset-bottom, 0px))",  /* clear Safari bottom bar */
          maxHeight: 140, overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
              Alerts Feed
            </span>
            <span style={{
              fontSize: 9, padding: "1px 6px", borderRadius: 3,
              background: "rgba(255,68,102,0.15)", color: "#ff4466",
              border: "1px solid rgba(255,68,102,0.3)", fontFamily: "'Space Mono', monospace",
            }}>{alerts.length}</span>
            <span style={{ fontSize: 10, color: "#333", marginLeft: "auto", fontFamily: "'Space Mono', monospace" }}>
              VIX WARN:{ALERT_THRESHOLDS.VIX_WARNING} · VIX DANGER:{ALERT_THRESHOLDS.VIX_DANGER} · OIL:{ALERT_THRESHOLDS.OIL_MOVE_PCT}% · CRYPTO:{ALERT_THRESHOLDS.CRYPTO_MOVE_PCT}%
            </span>
          </div>
          <div ref={alertsFeedRef} style={{ overflowY: "auto", flex: 1 }}>
            {alerts.length === 0
              ? <div style={{ fontSize: 11, color: "#444", fontFamily: "'Space Mono', monospace", padding: "4px 0" }}>
              No alerts triggered — monitoring active...
                </div>
              : alerts.map(alert => <AlertItem key={alert.id} alert={alert} />)
            }
          </div>
        </div>
      </div>
    </div>
  );
}
