import { useState, useEffect, useRef, useCallback, memo } from "react";
import { LineChart, Line, ResponsiveContainer, Tooltip, AreaChart, Area } from "recharts";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const INTERVALS = { PRICES: 35000, NEWS: 60000, SOCIAL: 120000 };

// Persistent price cache — never falls back to mock after first real fetch
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
  { id: "VIX", label: "VIX",        category: "fear",      unit: "",  vol: 0.04  },
  { id: "SPY", label: "S&P 500",    category: "equity",    unit: "$", vol: 0.008 },
  { id: "QQQ", label: "Nasdaq",     category: "equity",    unit: "$", vol: 0.01  },
  { id: "BTC", label: "Bitcoin",    category: "crypto",    unit: "$", vol: 0.025 },
  { id: "ETH", label: "Ethereum",   category: "crypto",    unit: "$", vol: 0.03  },
  { id: "WTI", label: "Crude Oil",  category: "commodity", unit: "$", vol: 0.015 },
  { id: "DXY", label: "USD Index",  category: "currency",  unit: "",  vol: 0.005 },
  { id: "TNX", label: "10Y Yield",  category: "bonds",     unit: "%", vol: 0.008 },
];

const MOCK_PRICES = {
  VIX: { price: 17.04, change: 0.00  },
  SPY: { price: 679.46, change: -0.07 },
  QQQ: { price: 578.32, change: -0.12 },
  BTC: { price: 84320.00, change: 0.00 },
  ETH: { price: 1580.00, change: 0.00 },
  WTI: { price: 96.57, change: -1.33  },
  DXY: { price: 98.87, change: -0.15  },
  TNX: { price: 4.34,  change: -0.09  },
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
    const data = await res.json();

    // Merge into cache
    Object.entries(data).forEach(([id, val]) => {
      if (val?.price) _priceCache[id] = val;
    });
  } catch (e) {
    console.warn("[fetchAllPrices]", e.message);
  }

  return ASSET_META.map(meta => ({
    ...meta,
    price:       parseFloat((_priceCache[meta.id]?.price       ?? MOCK_PRICES[meta.id].price).toFixed(2)),
    change:      parseFloat((_priceCache[meta.id]?.change      ?? MOCK_PRICES[meta.id].change).toFixed(2)),
    marketState: _priceCache[meta.id]?.marketState ?? "CLOSED",
    prevClose:   _priceCache[meta.id]?.prevClose   ?? null,
  }));
};

// Fear & Greed: Alternative.me (small payload, no CORS issues)
const fetchFearGreed = async () => {
  const res = await fetch("https://api.alternative.me/fng/?limit=1");
  if (!res.ok) throw new Error(`FearGreed ${res.status}`);
  const data = await res.json();
  return { value: parseInt(data.data[0].value), label: data.data[0].value_classification };
};

const fetchNews = async () => {
  if (!USE_REAL_API.NEWS || !API_KEYS.NEWS_API) return MOCK_NEWS;
  try {
    const q = encodeURIComponent("federal reserve OR inflation OR oil OR geopolitical OR bitcoin");
    const res = await fetch(`https://newsapi.org/v2/everything?q=${q}&pageSize=20&sortBy=publishedAt&language=en&apiKey=${API_KEYS.NEWS_API}`);
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
  if (!USE_REAL_API.SOCIAL) return MOCK_SOCIAL;
  try {
    const res = await fetch("/api/social");
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

const useMarketData = (isPaused = false) => {
  const [assets, setAssets] = useState(() =>
    ASSET_META.map(meta => ({
      ...meta,
      price: MOCK_PRICES[meta.id].price,
      change: MOCK_PRICES[meta.id].change,
      sparkline: generateSparkline(MOCK_PRICES[meta.id].price, meta.vol),
      loading: false,
    }))
  );
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [error, setError]               = useState(null);
  const [wsConnected, setWsConnected]   = useState(false);
  const abortRef       = useRef(null);
  const wsRef          = useRef(null);
  const wsReconnectRef = useRef(null);

  // ── update one asset in state + cache ───────────────────────────────
  const updateAsset = useCallback((id, price, change) => {
    _priceCache[id] = { price, change };
    setAssets(prev => prev.map(asset => {
      if (asset.id !== id) return asset;
      const newSparkline = [...asset.sparkline.slice(1), { v: price, t: Date.now() }];
      return { ...asset, price, change, sparkline: newSparkline,
        flash: price > asset.price ? "up" : price < asset.price ? "down" : null, loading: false };
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
        updateAsset(id, parseFloat(parseFloat(tick.c).toFixed(2)), parseFloat(parseFloat(tick.P).toFixed(2)));
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
    connectWS();
    fetchAndUpdate();
    const pollInterval = setInterval(fetchAndUpdate, INTERVALS.PRICES);
    return () => {
      clearInterval(pollInterval);
      clearTimeout(wsReconnectRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWS, fetchAndUpdate]);

  return { assets, lastUpdated, error, wsConnected };
};

const useAlerts = (assets) => {
  const [alerts, setAlerts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const prevAssetsRef = useRef({});
  const cooldownsRef = useRef({});
  const seenKeysRef = useRef(new Set());

  const canFire = useCallback((key, cooldownMs) => {
    const now = Date.now();
    const last = cooldownsRef.current[key] ?? 0;
    if (now - last < cooldownMs) return false;
    cooldownsRef.current[key] = now;
    return true;
  }, []);

  useEffect(() => {
    const newAlerts = [];
    assets.forEach(asset => {
      const prev = prevAssetsRef.current[asset.id];
      if (!prev || asset.loading) { prevAssetsRef.current[asset.id] = asset; return; }
      if (asset.id === "VIX" && asset.price >= ALERT_THRESHOLDS.VIX_EXTREME && prev.price < ALERT_THRESHOLDS.VIX_EXTREME) {
        const key = `VIX_EXTREME_${Math.floor(asset.price / 5)}`;
        if (!seenKeysRef.current.has(key) && canFire("VIX_EXTREME", ALERT_COOLDOWNS.VIX_EXTREME)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "critical", msg: `VIX EXTREME: ${asset.price.toFixed(2)} — Panic levels`, time: new Date() });
          ALERT_SOUNDS.critical();
        }
      } else if (asset.id === "VIX" && asset.price >= ALERT_THRESHOLDS.VIX_DANGER && prev.price < ALERT_THRESHOLDS.VIX_DANGER) {
        const key = `VIX_DANGER_${Math.floor(asset.price / 2)}`;
        if (!seenKeysRef.current.has(key) && canFire("VIX_DANGER", ALERT_COOLDOWNS.VIX_DANGER)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "danger", msg: `VIX DANGER: ${asset.price.toFixed(2)} — High volatility`, time: new Date() });
          ALERT_SOUNDS.danger();
        }
      }
      if (asset.id === "WTI" && Math.abs(asset.change) > ALERT_THRESHOLDS.OIL_MOVE_PCT && Math.abs(prev.change) <= ALERT_THRESHOLDS.OIL_MOVE_PCT) {
        const key = `OIL_SPIKE_${asset.change > 0 ? "up" : "dn"}_${new Date().toDateString()}`;
        if (!seenKeysRef.current.has(key) && canFire("OIL_SPIKE", ALERT_COOLDOWNS.OIL_SPIKE)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "warning", msg: `OIL SPIKE: WTI ${asset.change >= 0 ? "+" : ""}${asset.change.toFixed(2)}%`, time: new Date() });
          ALERT_SOUNDS.warning();
        }
      }
      if ((asset.id === "BTC" || asset.id === "ETH") && Math.abs(asset.change) > ALERT_THRESHOLDS.CRYPTO_MOVE_PCT && Math.abs(prev.change) <= ALERT_THRESHOLDS.CRYPTO_MOVE_PCT) {
        const key = `CRYPTO_${asset.id}_${asset.change > 0 ? "up" : "dn"}_${new Date().toDateString()}`;
        if (!seenKeysRef.current.has(key) && canFire("CRYPTO_MOVE", ALERT_COOLDOWNS.CRYPTO_MOVE)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "info", msg: `CRYPTO MOVE: ${asset.label} ${asset.change >= 0 ? "+" : ""}${asset.change.toFixed(2)}%`, time: new Date() });
          ALERT_SOUNDS.info();
        }
      }
      prevAssetsRef.current[asset.id] = asset;
    });
    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 50));
      setNotifications(prev => [...newAlerts, ...prev].slice(0, 3));
      setTimeout(() => setNotifications(prev => prev.slice(newAlerts.length)), 5000);
    }
  }, [assets, canFire]);

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

const AssetCard = memo(({ asset }) => {
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
  // Crypto is always live — never show closed
  const showClosed = isClosed && asset.category !== "crypto";

  // dollar change from sparkline start
  const sparkFirst = asset.sparkline?.[0]?.v ?? asset.price;
  const dollarChange = asset.price - sparkFirst;
  const dollarStr = `${dollarChange >= 0 ? "+" : "-"}${asset.unit}${Math.abs(dollarChange).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // 24h high/low badge from sparkline
  const prices = asset.sparkline?.map(p => p.v) ?? [];
  const high24 = Math.max(...prices);
  const low24  = Math.min(...prices);
  const isNearHigh = prices.length > 1 && asset.price >= high24 * 0.998;
  const isNearLow  = prices.length > 1 && asset.price <= low24  * 1.002;

  return (
    <div style={{
      background: flashing
        ? `rgba(${isPos ? "0,255,136" : "255,68,102"},0.10)`
        : isPos ? "rgba(0,255,136,0.03)" : "rgba(255,68,102,0.03)",
      border: `1px solid ${isPos ? "rgba(0,255,136,0.12)" : "rgba(255,68,102,0.12)"}`,
      borderRadius: 8,
      padding: "10px 12px 10px 14px",
      transition: "background 0.4s ease, border 0.4s ease",
      cursor: "pointer",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* colored left accent bar */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
        background: color, borderRadius: "8px 0 0 8px", opacity: 0.8,
      }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 11, color: "#999", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>
              {asset.id}
            </span>
            {showClosed ? (
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
            {!showClosed && isNearHigh && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: "rgba(0,255,136,0.15)", color: "#00ff88", fontFamily: "'Space Mono', monospace" }}>24H HI</span>}
            {!showClosed && isNearLow  && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 2, background: "rgba(255,68,102,0.15)", color: "#ff4466", fontFamily: "'Space Mono', monospace" }}>24H LO</span>}
          </div>
          <div style={{ fontSize: 12, color: "#888" }}>{asset.label}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: showClosed ? "#888" : "#f0f0f0", fontFamily: "'Space Mono', monospace", letterSpacing: -0.5 }}>
            {fmtPrice(asset.price, asset.unit)}
          </div>
          <div style={{ fontSize: 11, color: showClosed ? "#555" : color, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>
            {fmtChange(asset.change)}
          </div>
          <div style={{ fontSize: 10, color: showClosed ? "#444" : color, opacity: 0.65, fontFamily: "'Space Mono', monospace" }}>
            {dollarStr}
          </div>
        </div>
      </div>
      <Sparkline data={asset.sparkline} change={asset.change} />
    </div>
  );
});

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
  return (
    <div style={{
      display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4,
      background: `rgba(${color === "#ff0044" ? "255,0,68" : color === "#ff4466" ? "255,68,102" : color === "#ffd700" ? "255,215,0" : "0,170,255"},0.07)`,
      borderLeft: `2px solid ${color}`, marginBottom: 4, animation: "fadeIn 0.3s ease",
    }}>
      <span style={{ fontSize: 11, color: "#888", fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap" }}>
        {alert.time.toLocaleTimeString("en-US", { hour12: false })}
      </span>
      <span style={{ fontSize: 12, color: "#eee" }}>{alert.msg}</span>
    </div>
  );
});

const NotificationToast = ({ notification }) => {
  const colors = { critical: "#ff0044", danger: "#ff4466", warning: "#ffd700", info: "#00aaff" };
  const color = colors[notification.level] || "#888";
  return (
    <div style={{
      background: "#13131a", border: `1px solid ${color}`,
      borderRadius: 8, padding: "12px 16px", minWidth: 280, maxWidth: 360,
      boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 20px ${color}22`,
      animation: "slideIn 0.3s ease",
    }}>
      <div style={{ fontSize: 11, color, fontWeight: 700, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>
        ALERT — {notification.level.toUpperCase()}
      </div>
      <div style={{ fontSize: 12, color: "#d4d4d4" }}>{notification.msg}</div>
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
// PRIVATE CREDIT PANEL
// ─────────────────────────────────────────────

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

const EARNINGS_CALENDAR = [
  { company: "Ares Capital (ARCC)",      date: "May 7, 2026",  daysAway: 27, type: "Earnings" },
  { company: "Blue Owl (OBDC)",          date: "May 9, 2026",  daysAway: 29, type: "Earnings" },
  { company: "Apollo Global",            date: "May 6, 2026",  daysAway: 26, type: "Earnings" },
  { company: "FS KKR Capital",           date: "May 13, 2026", daysAway: 33, type: "Earnings" },
  { company: "Golub Capital BDC",        date: "May 21, 2026", daysAway: 41, type: "Earnings" },
];

const PC_NEWS = [
  { id: 1, headline: "Ares Capital reports Q1 non-accrual rate steady at 1.2%, beats dividend coverage estimates", source: "Bloomberg", time: "3h ago", sentiment: "bullish" },
  { id: 2, headline: "Direct lending spreads tighten to 18-month lows as deal flow surges in mid-market", source: "LCD", time: "6h ago", sentiment: "neutral" },
  { id: 3, headline: "PIK loan usage climbs to 14% of new issuance — highest since 2020, Moody's warns", source: "Moody's", time: "1d ago", sentiment: "bearish" },
  { id: 4, headline: "Blue Owl raises $12B for latest direct lending fund, eyes software buyout deals", source: "FT", time: "1d ago", sentiment: "bullish" },
  { id: 5, headline: "Amend-and-extend wave hits private credit as 2026 maturity wall approaches", source: "CreditSights", time: "2d ago", sentiment: "risk-off" },
  { id: 6, headline: "S&P: Private credit default rates remain below 2% but covenant-lite structures raise concern", source: "S&P", time: "2d ago", sentiment: "neutral" },
];

const PrivateCreditPanel = memo(() => {
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
            const navPrem = ((bdc.price - bdc.nav) / bdc.nav * 100);
            const isPos = bdc.change >= 0;
            const navColor = navPrem >= 0 ? "#00ff88" : "#ff4466";
            return (
              <div key={bdc.ticker} style={{
                display: "grid", gridTemplateColumns: "1fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr",
                gap: 8, padding: "10px 10px",
                background: isPos ? "rgba(0,255,136,0.02)" : "rgba(255,68,102,0.02)",
                border: `1px solid ${isPos ? "rgba(0,255,136,0.08)" : "rgba(255,68,102,0.08)"}`,
                borderRadius: 6, alignItems: "center",
                borderLeft: `3px solid ${isPos ? "#00ff88" : "#ff4466"}`,
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>{bdc.ticker}</div>
                  <div style={{ fontSize: 9, color: "#555", marginTop: 1 }}>{bdc.manager}</div>
                </div>
                <div style={{ fontSize: 11, color: "#aaa" }}>{bdc.name}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>${bdc.price.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: isPos ? "#00ff88" : "#ff4466", fontFamily: "'Space Mono', monospace" }}>{fmtChange(bdc.change)}</div>
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
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 2 }}>{ev.company}</div>
                <div style={{ fontSize: 10, color: "#555", fontFamily: "'Space Mono', monospace" }}>{ev.type}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#aaa", fontFamily: "'Space Mono', monospace" }}>{ev.date}</div>
                <div style={{
                  fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                  color: ev.daysAway <= 7 ? "#ff4466" : ev.daysAway <= 14 ? "#ffd700" : "#555",
                  marginTop: 2,
                }}>
                  {ev.daysAway}d away
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
  const { assets, lastUpdated, error, wsConnected } = useMarketData(isPaused);
  const { alerts, notifications } = useAlerts(assets);
  const { news } = useNews();
  const { feed: socialFeed } = useSocialFeed();
  const time = useClock();
  const fearGreed = useFearGreed();
  const { refresh: refreshFearGreed, refreshing: fgRefreshing } = fearGreed;
  const [activeTab, setActiveTab] = useState("news");
  const [centerTab, setCenterTab] = useState("market");
  const [riskMode, setRiskMode] = useState("on");
  const [showSidebar, setShowSidebar] = useState(true);
  const alertsFeedRef = useRef(null);
  const [marketStatus, setMarketStatus] = useState("LIVE");

  const isMarketOpen = () => getMarketStatus().isOpen;

  const sentimentScore = assets.reduce((acc, a) => {
    return acc + (a.change >= 0 ? 1 : -1) * Math.abs(a.change);
  }, 0);

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a0f",
      fontFamily: "'Outfit', sans-serif", color: "#f0f0f0",
      display: "flex", flexDirection: "column",
      userSelect: "none",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes scan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100vh); } }
        body { font-size: 14px; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 6px 14px; border-radius: 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; font-family: 'Space Mono', monospace; transition: all 0.2s; color: #888; }
        .tab-btn:hover { background: rgba(255,255,255,0.05); color: #ccc; }
        .tab-active { background: rgba(255,255,255,0.08) !important; color: #00ff88 !important; }
        .asset-grid { display: flex; flex-direction: column; gap: 6px; }
      `}</style>

      {/* Scan line effect */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
      }} />

      {/* Notifications */}
      <div style={{ position: "fixed", top: 64, right: 16, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8 }}>
        {notifications.map(n => <NotificationToast key={n.id} notification={n} />)}
      </div>

      {/* TOP BAR */}
      <header style={{
        height: 52, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", borderBottom: "1px solid rgba(255,255,255,0.07)",
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
            <div style={{ fontSize: 9, color: "#666", letterSpacing: 1 }}>FINANCIAL INTELLIGENCE TERMINAL</div>
          </div>
        </div>

        {/* Center — ticker */}
        <div style={{ display: "flex", gap: 20, alignItems: "center", overflow: "hidden" }}>
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
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e8e8e8", fontFamily: "'Space Mono', monospace" }}>
              {time.toLocaleTimeString("en-US", { hour12: false })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: error ? "#ffd700" : isMarketOpen() ? "#00ff88" : "#ff4466",
                animation: isMarketOpen() && !error ? "pulse 2s infinite" : "none",
              }} />
              <span style={{ fontSize: 9, color: error ? "#ffd700" : isMarketOpen() ? "#00ff88" : "#ff4466", fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
                {error ? "API ERR" : isMarketOpen() ? "MARKET OPEN" : "MARKET CLOSED"}
              </span>
            </div>
            {lastUpdated && (
              <div style={{ fontSize: 9, color: "#333", fontFamily: "'Space Mono', monospace" }}>
                UPD {lastUpdated.toLocaleTimeString("en-US", { hour12: false })}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 1 }}>
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: wsConnected ? "#00ff88" : "#ffd700",
                boxShadow: wsConnected ? "0 0 6px #00ff88" : "none",
                animation: wsConnected ? "pulse 2s infinite" : "none",
              }} />
              <span style={{ fontSize: 9, color: isPaused ? "#ffd700" : wsConnected ? "#00ff88" : IS_LOCALHOST ? "#555" : "#ffd700", fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
                {isPaused ? "PAUSED" : wsConnected ? "WS LIVE" : IS_LOCALHOST ? "POLLING" : "WS OFF"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: showSidebar ? "240px 1fr 320px" : "240px 1fr", gridTemplateRows: "1fr auto", gap: 1, background: "rgba(255,255,255,0.04)", minHeight: 0, transition: "grid-template-columns 0.3s ease" }}>

        {/* LEFT — Asset Panel */}
        <div style={{ background: "#0a0a0f", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Column headers */}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 14px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 8 }}>
            <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Asset</span>
            <div style={{ display: "flex", gap: 24 }}>
              <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>Price</span>
              <span style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace" }}>24h Chg</span>
            </div>
          </div>
          {/* Grouped by category */}
          {[
            { label: "Equities", ids: ["SPY", "QQQ"] },
            { label: "Volatility", ids: ["VIX"] },
            { label: "Crypto", ids: ["BTC", "ETH"] },
            { label: "Commodities", ids: ["WTI"] },
            { label: "Macro", ids: ["DXY", "TNX"] },
          ].map(group => {
            const groupAssets = assets.filter(a => group.ids.includes(a.id));
            if (!groupAssets.length) return null;
            return (
              <div key={group.label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", padding: "2px 4px 6px", borderLeft: "2px solid #333", paddingLeft: 8 }}>
                  {group.label}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {groupAssets.map(asset => <AssetCard key={asset.id} asset={asset} />)}
                </div>
              </div>
            );
          })}
        </div>

        {/* CENTER — Charts & Metrics */}
        <div style={{ background: "#0a0a0f", padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Center tab bar */}
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
            {[
              { id: "market",  label: "Markets" },
              { id: "credit",  label: "Private Credit" },
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
          {centerTab === "credit" && <PrivateCreditPanel />}

          {/* MARKETS TAB */}
          {centerTab === "market" && (<>
          {(() => {
            const vix = assets.find(a => a.id === "VIX");
            const spy = assets.find(a => a.id === "SPY");
            const btc = assets.find(a => a.id === "BTC");
            const wti = assets.find(a => a.id === "WTI");
            const upCount = assets.filter(a => a.change >= 0).length;
            const isRiskOff = (vix?.change > 5) || (spy?.change < -1) || (upCount < 3);
            const summary = isRiskOff
              ? `Risk-off session. ${vix?.change > 5 ? `VIX surging +${vix.change.toFixed(1)}%. ` : ""}${spy?.change < -1 ? `Equities under pressure. ` : ""}${wti?.change < -2 ? "Oil sliding." : ""}`
              : `Risk-on tone. ${btc?.change > 2 ? `Crypto leading gains. ` : ""}${spy?.change > 0.5 ? `Equities firm. ` : ""}${upCount} of ${assets.length} assets positive.`;
            const color = isRiskOff ? "#ff4466" : "#00ff88";
            return (
              <div style={{
                background: `rgba(${isRiskOff ? "255,68,102" : "0,255,136"},0.06)`,
                border: `1px solid ${isRiskOff ? "rgba(255,68,102,0.2)" : "rgba(0,255,136,0.2)"}`,
                borderRadius: 8, padding: "10px 14px",
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: isRiskOff ? "#ff4466" : "#00ff88",
                  boxShadow: `0 0 8px ${isRiskOff ? "#ff4466" : "#00ff88"}`,
                }} />
                <div>
                  <div style={{ fontSize: 10, color: "#555", letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 2 }}>Market Summary</div>
                  <div style={{ fontSize: 13, color: "#ddd", lineHeight: 1.5 }}>{summary}</div>
                </div>
              </div>
            );
          })()}

          {/* Sentiment + Aggregate Signal */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SentimentGauge assets={assets} />
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 10 }}>
                Aggregate Signal
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { label: "Equities", val: assets.find(a => a.id === "SPY")?.change ?? 0, max: 3 },
                  { label: "Crypto",   val: ((assets.find(a => a.id === "BTC")?.change ?? 0) + (assets.find(a => a.id === "ETH")?.change ?? 0)) / 2, max: 6 },
                  { label: "Volatility", val: -(assets.find(a => a.id === "VIX")?.change ?? 0), max: 5 },
                  { label: "Oil",      val: assets.find(a => a.id === "WTI")?.change ?? 0, max: 3 },
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

                {/* Other stats */}
                {[
                  { label: "BTC Dominance", val: "54.2", unit: "%",  sub: "of total crypto",  color: "#f7931a" },
                  { label: "Put/Call Ratio", val: "1.24", unit: "",   sub: "options sentiment", color: "#ff4466" },
                  { label: "Total Vol",      val: "$847B", unit: "",  sub: "24h global",        color: "#00aaff" },
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
        </div>
        {showSidebar && (
        <div style={{ background: "#0a0a0f", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.07)", padding: "6px 12px 0", flexShrink: 0 }}>
            {[
              { id: "news",    label: "News" },
              { id: "social",  label: "Social" },
              { id: "youtube", label: "Creators" },
            ].map(tab => (
              <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? "tab-active" : ""}`}
                style={{ color: activeTab === tab.id ? "#00ff88" : "#666" }}
                onClick={() => setActiveTab(tab.id)}>
                {tab.label}
              </button>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, paddingBottom: 6 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#00ff88", animation: "pulse 1.5s infinite" }} />
              <span style={{ fontSize: 9, color: "#00ff88", fontFamily: "'Space Mono', monospace" }}>LIVE</span>
            </div>
          </div>

          {/* Feed */}
          <div style={{ flex: 1, overflowY: "auto", padding: activeTab === "youtube" ? "0" : "0 12px" }}>
            {activeTab === "news"    && news.map(item => <NewsItem key={item.id} item={item} />)}
            {activeTab === "social"  && socialFeed.map(item => <SocialItem key={item.id} item={item} />)}
            {activeTab === "youtube" && <LiveStreamPanel />}
          </div>
        </div>
        )}

        {/* BOTTOM — Alerts Log */}
        <div style={{
          gridColumn: "1 / -1", background: "#0a0a0f",
          borderTop: "1px solid rgba(255,255,255,0.07)",
          padding: "8px 16px", maxHeight: 140, overflow: "hidden",
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