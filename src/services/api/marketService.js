// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET MONITOR — API Service Layer
// services/api/marketService.js
//
// Each function returns a normalized object. If the real API is unavailable
// or the key is missing, it falls back to mock data automatically.
// Swap USE_REAL_API flags in /config/apis.js to enable live data.
// ─────────────────────────────────────────────────────────────────────────────

import { API_KEYS, USE_REAL_API } from "../../config/apis.js";

// ─────────────────────────────────────────────
// ASSET METADATA (non-price, never changes)
// ─────────────────────────────────────────────
export const ASSET_META = [
  { id: "VIX", label: "VIX",        category: "fear",      unit: "",  icon: "⚡", vol: 0.04  },
  { id: "SPY", label: "S&P 500",    category: "equity",    unit: "$", icon: "📈", vol: 0.008 },
  { id: "QQQ", label: "Nasdaq",     category: "equity",    unit: "$", icon: "💻", vol: 0.01  },
  { id: "BTC", label: "Bitcoin",    category: "crypto",    unit: "$", icon: "₿",  vol: 0.025 },
  { id: "ETH", label: "Ethereum",   category: "crypto",    unit: "$", icon: "Ξ",  vol: 0.03  },
  { id: "WTI", label: "Crude Oil",  category: "commodity", unit: "$", icon: "🛢", vol: 0.015 },
  { id: "DXY", label: "USD Index",  category: "currency",  unit: "",  icon: "💵", vol: 0.005 },
  { id: "TNX", label: "10Y Yield",  category: "bonds",     unit: "%", icon: "🏛", vol: 0.008 },
];

// ─────────────────────────────────────────────
// MOCK FALLBACKS
// ─────────────────────────────────────────────
const MOCK_PRICES = {
  VIX: { price: 18.43, change: 4.21  },
  SPY: { price: 5234.18, change: -0.83 },
  QQQ: { price: 449.22, change: -1.12 },
  BTC: { price: 84320.00, change: 2.44 },
  ETH: { price: 3210.55, change: 1.87 },
  WTI: { price: 78.42, change: -2.11 },
  DXY: { price: 104.23, change: 0.34 },
  TNX: { price: 4.38, change: -0.06 },
};

export const getMockPrices = () =>
  ASSET_META.map(meta => ({ ...meta, ...MOCK_PRICES[meta.id] }));

// ─────────────────────────────────────────────
// STOCKS — Financial Modeling Prep
// Docs: https://financialmodelingprep.com/developer/docs
// Endpoint: /v3/quote/SPY,QQQ,VIX,DXY,TNX
// ─────────────────────────────────────────────
const fetchFMPQuotes = async (symbols) => {
  const url = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${API_KEYS.FMP}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const data = await res.json();
  // data: [{ symbol, price, changesPercentage, ... }]
  return data.reduce((acc, q) => {
    acc[q.symbol] = { price: q.price, change: q.changesPercentage };
    return acc;
  }, {});
};

// Fallback: TwelveData
// Docs: https://twelvedata.com/docs
const fetchTwelveDataQuotes = async (symbols) => {
  const url = `https://api.twelvedata.com/price?symbol=${symbols.join(",")}&apikey=${API_KEYS.TWELVE_DATA}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const data = await res.json();
  // Normalize — TwelveData returns { SYMBOL: { price } } for multi
  const result = {};
  for (const sym of symbols) {
    if (data[sym]?.price) result[sym] = { price: parseFloat(data[sym].price), change: 0 };
  }
  return result;
};

// ─────────────────────────────────────────────
// CRYPTO — CoinGecko (no key required)
// Docs: https://www.coingecko.com/api/documentation
// ─────────────────────────────────────────────
const fetchCoinGeckoPrices = async () => {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();
  return {
    BTC: { price: data.bitcoin.usd, change: data.bitcoin.usd_24h_change ?? 0 },
    ETH: { price: data.ethereum.usd, change: data.ethereum.usd_24h_change ?? 0 },
  };
};

// ─────────────────────────────────────────────
// OIL — EIA Open Data (free, no key for basic)
// Docs: https://www.eia.gov/opendata/
// Series: PET.RWTC.D — WTI Crude Daily
// Note: EIA has CORS restrictions; use a proxy in production
// ─────────────────────────────────────────────
const fetchEIAOilPrice = async () => {
  // EIA v2 API — returns last two daily prices so we can compute change
  const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${API_KEYS.EIA}&frequency=daily&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2&facets[product][]=EPCWTI`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EIA ${res.status}`);
  const json = await res.json();
  const rows = json?.response?.data;
  if (!rows || rows.length < 2) throw new Error("EIA: insufficient data");
  const today = parseFloat(rows[0].value);
  const yesterday = parseFloat(rows[1].value);
  const change = ((today - yesterday) / yesterday) * 100;
  return { WTI: { price: today, change: parseFloat(change.toFixed(2)) } };
};

// ─────────────────────────────────────────────
// MAIN FETCH — orchestrates all sources
// ─────────────────────────────────────────────
export const fetchAllPrices = async () => {
  const stockSymbols = ["SPY", "QQQ", "VIX", "DXY", "TNX"];
  const result = { ...MOCK_PRICES }; // start with mock as baseline

  // Crypto
  if (USE_REAL_API.CRYPTO) {
    try {
      const crypto = await fetchCoinGeckoPrices();
      Object.assign(result, crypto);
    } catch (e) {
      console.warn("[MarketMonitor] CoinGecko failed, using mock:", e.message);
    }
  }

  // Stocks — try FMP first, fall back to TwelveData
  if (USE_REAL_API.STOCKS) {
    try {
      const stocks = API_KEYS.FMP
        ? await fetchFMPQuotes(stockSymbols)
        : await fetchTwelveDataQuotes(stockSymbols);
      Object.assign(result, stocks);
    } catch (e) {
      console.warn("[MarketMonitor] Stock API failed, using mock:", e.message);
    }
  }

  // Oil
  if (USE_REAL_API.OIL && API_KEYS.EIA) {
    try {
      const oil = await fetchEIAOilPrice();
      Object.assign(result, oil);
    } catch (e) {
      console.warn("[MarketMonitor] EIA failed, using mock:", e.message);
    }
  }

  return ASSET_META.map(meta => ({
    ...meta,
    price: parseFloat((result[meta.id]?.price ?? MOCK_PRICES[meta.id].price).toFixed(2)),
    change: parseFloat((result[meta.id]?.change ?? MOCK_PRICES[meta.id].change).toFixed(2)),
  }));
};

// ─────────────────────────────────────────────
// NEWS — NewsAPI
// Docs: https://newsapi.org/docs
// Note: NewsAPI free tier blocks CORS in browser.
//       Run via a backend proxy or use a CORS-anywhere service in dev.
//       Proxy example: /api/news -> your server -> newsapi.org
// ─────────────────────────────────────────────
const NEWS_QUERIES = [
  "federal reserve OR interest rates OR inflation OR CPI",
  "geopolitical crisis OR war OR sanctions OR NATO",
  "oil price OR OPEC OR crude OR energy",
  "stock market OR S&P 500 OR nasdaq OR earnings",
  "bitcoin OR ethereum OR crypto",
];

const SENTIMENT_KEYWORDS = {
  bullish:  ["surge", "rally", "gain", "beat", "jump", "record", "boom", "soar", "rise", "high"],
  bearish:  ["crash", "fall", "drop", "miss", "plunge", "collapse", "sink", "decline", "low", "recession"],
  "risk-off": ["war", "crisis", "panic", "fear", "risk", "threat", "sanction", "missile", "emergency", "default"],
};

const classifySentiment = (text) => {
  const t = text.toLowerCase();
  for (const [label, words] of Object.entries(SENTIMENT_KEYWORDS)) {
    if (words.some(w => t.includes(w))) return label;
  }
  return "neutral";
};

const fmtRelativeTime = (isoString) => {
  const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const MOCK_NEWS = [
  { id: 1, headline: "Fed signals potential rate pause as inflation data cools", source: "Reuters", time: "2m ago", sentiment: "neutral", category: "macro" },
  { id: 2, headline: "OPEC+ considers surprise output cut ahead of winter demand", source: "Bloomberg", time: "8m ago", sentiment: "bearish", category: "commodities" },
  { id: 3, headline: "Bitcoin ETF sees record $840M inflows as institutional demand surges", source: "CoinDesk", time: "12m ago", sentiment: "bullish", category: "crypto" },
  { id: 4, headline: "Treasury yields spike as debt ceiling negotiations stall in Congress", source: "WSJ", time: "19m ago", sentiment: "risk-off", category: "bonds" },
  { id: 5, headline: "Tech earnings beat estimates; NVDA surges 7% in after-hours trading", source: "CNBC", time: "24m ago", sentiment: "bullish", category: "equities" },
  { id: 6, headline: "Geopolitical tensions escalate: NATO emergency session called", source: "FT", time: "31m ago", sentiment: "risk-off", category: "geopolitical" },
  { id: 7, headline: "China GDP misses expectations; Yuan weakens to 3-month low", source: "Reuters", time: "45m ago", sentiment: "bearish", category: "macro" },
  { id: 8, headline: "Dollar weakens as safe-haven flows shift to gold and yen", source: "Bloomberg", time: "52m ago", sentiment: "risk-off", category: "currency" },
];

export const fetchNews = async () => {
  if (!USE_REAL_API.NEWS || !API_KEYS.NEWS_API) return MOCK_NEWS;

  try {
    // In production: route through /api/news proxy to avoid CORS
    // const proxyUrl = `/api/news?q=${encodeURIComponent(NEWS_QUERIES[0])}&pageSize=20`;
    const q = encodeURIComponent(NEWS_QUERIES.join(" OR "));
    const url = `https://newsapi.org/v2/everything?q=${q}&pageSize=20&sortBy=publishedAt&language=en&apiKey=${API_KEYS.NEWS_API}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NewsAPI ${res.status}`);
    const data = await res.json();

    return (data.articles || []).map((a, i) => ({
      id: i + 1,
      headline: a.title,
      source: a.source?.name ?? "Unknown",
      time: fmtRelativeTime(a.publishedAt),
      sentiment: classifySentiment(`${a.title} ${a.description ?? ""}`),
      category: "macro",
      url: a.url,
    }));
  } catch (e) {
    console.warn("[MarketMonitor] NewsAPI failed, using mock:", e.message);
    return MOCK_NEWS;
  }
};

// ─────────────────────────────────────────────
// SOCIAL FEED
// Twitter/X API requires OAuth 2.0 Bearer token — must go through your backend.
// Truth Social has no official API — requires scraping or RSS feeds.
//
// Architecture:
//   Browser → your backend (/api/social) → Twitter API / Truth Social RSS
//
// To enable: set USE_REAL_API.SOCIAL = true and implement /api/social
// returning the normalized shape below.
// ─────────────────────────────────────────────
const MOCK_SOCIAL = [
  { id: 1, handle: "@realDonaldTrump", name: "Donald Trump", avatar: "DT", platform: "Truth Social", time: "4m ago", text: "The Fed is DESTROYING our economy with high interest rates. CUT RATES NOW! The stock market is being held hostage. SAD!", tags: ["rates", "fed"] },
  { id: 2, handle: "@elonmusk", name: "Elon Musk", avatar: "EM", platform: "X", time: "11m ago", text: "The national debt is the real crisis. $34 trillion and climbing. This is unsustainable. At some point, the music stops.", tags: ["crash", "inflation"] },
  { id: 3, handle: "@federalreserve", name: "Federal Reserve", avatar: "FR", platform: "X", time: "1h ago", text: "FOMC Statement: The Committee decided to maintain the target range for the federal funds rate at 5.25-5.5%. Inflation remains elevated.", tags: ["rates", "fed", "inflation"] },
  { id: 4, handle: "@LynAldenContact", name: "Lyn Alden", avatar: "LA", platform: "X", time: "1h ago", text: "Oil supply tightness combined with dollar strength divergence is historically a precursor to volatility. Watch the spread.", tags: ["oil", "inflation"] },
  { id: 5, handle: "@zerohedge", name: "ZeroHedge", avatar: "ZH", platform: "X", time: "2h ago", text: "BREAKING: Credit default swaps on regional banks surging to highest levels since March 2023. Something is happening under the surface.", tags: ["crash", "bank", "crisis"] },
  { id: 6, handle: "@RaoulGMI", name: "Raoul Pal", avatar: "RP", platform: "X", time: "2h ago", text: "The liquidity cycle is turning. Global M2 is starting to expand again. Historically this is THE signal for risk assets. $BTC leading.", tags: ["rates", "inflation"] },
];

export const fetchSocialFeed = async () => {
  if (!USE_REAL_API.SOCIAL) return MOCK_SOCIAL;

  try {
    // Replace with your backend endpoint
    // GET /api/social returns array of { id, handle, name, avatar, platform, time, text, tags }
    const res = await fetch("/api/social");
    if (!res.ok) throw new Error(`Social proxy ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("[MarketMonitor] Social API failed, using mock:", e.message);
    return MOCK_SOCIAL;
  }
};

// ─────────────────────────────────────────────
// SPARKLINE HELPER (used by hook, not fetched)
// ─────────────────────────────────────────────
export const generateSparkline = (base, volatility = 0.02, points = 24) => {
  const data = [];
  let val = base;
  for (let i = 0; i < points; i++) {
    val = val * (1 + (Math.random() - 0.5) * volatility);
    data.push({ v: parseFloat(val.toFixed(2)), t: i });
  }
  return data;
};
