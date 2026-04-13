// api/prices.js — Vercel Serverless Function
// Architecture: Finnhub (primary) → FMP (fallback) → Yahoo (macro fallback) → Binance (crypto)
// All fetches are server-side — no CORS issues

// ─── Environment ─────────────────────────────────────────────────
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FMP_KEY     = process.env.FMP_API_KEY     || "";

// ─── In-memory last-known-good cache (warm invocations) ──────────
const _lastValid = {};

// ─── Standardized response shape ─────────────────────────────────
// Every asset returns exactly this shape — no exceptions
// { symbol, price, change, percentChange, timestamp, source, status, marketState, prevClose }
function normalize(symbol, raw, source) {
  const timestamp = new Date().toISOString();
  return {
    symbol,
    price:        parseFloat((raw.price        ?? 0).toFixed(2)),
    change:       parseFloat((raw.change       ?? 0).toFixed(2)),   // dollar change (if available)
    percentChange:parseFloat((raw.percentChange?? 0).toFixed(2)),   // % change — always populated
    prevClose:    parseFloat((raw.prevClose    ?? raw.price ?? 0).toFixed(2)),
    marketState:  raw.marketState ?? "CLOSED",
    source,
    timestamp,
    status:       "valid",
  };
}

// ─── Market hours helper (ET) ────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// ─── FETCHER: Finnhub ────────────────────────────────────────────
// Docs: https://finnhub.io/docs/api/quote
// Free tier: 60 calls/min, covers all equities + FX + crypto
async function fetchFromFinnhub(symbol) {
  if (!FINNHUB_KEY) throw new Error("No Finnhub key");

  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`Finnhub ${res.status} for ${symbol}`);

  const d = await res.json();

  // Finnhub returns { c: current, d: change, dp: %change, h, l, o, pc: prevClose, t: timestamp }
  if (!d.c || d.c === 0) throw new Error(`Finnhub zero price for ${symbol}`);

  const price        = parseFloat(d.c.toFixed(2));
  const percentChange= parseFloat((d.dp ?? 0).toFixed(2));
  const change       = parseFloat((d.d  ?? 0).toFixed(2));
  const prevClose    = parseFloat((d.pc ?? d.c).toFixed(2));
  const marketState  = isMarketOpen() ? "REGULAR" : "CLOSED";

  console.log(`[Finnhub] ${symbol} | price=${price} | ${percentChange}% | state=${marketState}`);
  return { price, change, percentChange, prevClose, marketState };
}

// ─── FETCHER: FMP (fallback + VIX) ───────────────────────────────
// Docs: https://financialmodelingprep.com/developer/docs
// Free tier: 250 calls/day — use sparingly, VIX + fallbacks only
async function fetchFromFMP(symbol) {
  if (!FMP_KEY) throw new Error("No FMP key");

  const encoded = encodeURIComponent(symbol);
  const res = await fetch(
    `https://financialmodelingprep.com/stable/quote?symbol=${encoded}&apikey=${FMP_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);

  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error(`FMP empty for ${symbol}`);

  const d = data[0];
  if (!d.price || d.price === 0) throw new Error(`FMP zero price for ${symbol}`);

  const price        = parseFloat((d.price            ?? 0).toFixed(2));
  const percentChange= parseFloat((d.changePercentage ?? 0).toFixed(2));
  const change       = parseFloat((d.change           ?? 0).toFixed(2));
  const prevClose    = parseFloat((d.previousClose    ?? d.price ?? 0).toFixed(2));
  const marketState  = isMarketOpen() ? "REGULAR" : "CLOSED";

  console.log(`[FMP] ${symbol} | price=${price} | ${percentChange}% | state=${marketState}`);
  return { price, change, percentChange, prevClose, marketState };
}

// ─── FETCHER: Yahoo Finance (macro/index fallback) ────────────────
// Used for: DXY, TNX, WTI when Finnhub lacks the symbol
// Free, no key — but can be rate-limited
async function fetchFromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);

  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo no meta for ${symbol}`);

  const price        = parseFloat((meta.regularMarketPrice          ?? 0).toFixed(2));
  const percentChange= parseFloat((meta.regularMarketChangePercent  ?? 0).toFixed(2));
  const prevClose    = parseFloat((meta.chartPreviousClose          ?? meta.regularMarketPrice ?? 0).toFixed(2));
  const change       = parseFloat((price - prevClose).toFixed(2));
  const marketState  = meta.marketState ?? "CLOSED";

  if (!price || price === 0) throw new Error(`Yahoo zero price for ${symbol}`);

  console.log(`[Yahoo] ${symbol} | price=${price} | ${percentChange}% | state=${marketState}`);
  return { price, change, percentChange, prevClose, marketState };
}

// ─── FETCHER: Binance (crypto only) ──────────────────────────────
// Crypto trades 24/7 — always REGULAR, no key needed
async function fetchFromBinance(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);

  const d = await res.json();
  const price        = parseFloat(parseFloat(d.lastPrice).toFixed(2));
  const percentChange= parseFloat(parseFloat(d.priceChangePercent).toFixed(2));
  const change       = parseFloat(parseFloat(d.priceChange).toFixed(2));
  const prevClose    = parseFloat(parseFloat(d.prevClosePrice).toFixed(2));

  if (!price || price === 0) throw new Error(`Binance zero price for ${symbol}`);

  console.log(`[Binance] ${symbol} | price=${price} | ${percentChange}%`);
  return { price, change, percentChange, prevClose, marketState: "REGULAR" };
}

// ─── UNIFIED: getAssetPrice ───────────────────────────────────────
// Tries sources in priority order, returns standardized shape
// Priority per asset type:
//   Crypto  → Binance only (most accurate, no quota)
//   Equities → Finnhub → FMP → Yahoo
//   VIX     → FMP → Finnhub (Finnhub has VIX as CBOE:VIX)
//   Macro   → Finnhub (has FX/rates) → Yahoo → FMP
async function getAssetPrice(id) {
  const ASSET_CONFIG = {
    // symbol, ordered list of fetch strategies
    BTC: { fn: () => fetchFromBinance("BTCUSDT") },
    ETH: { fn: () => fetchFromBinance("ETHUSDT") },
    SPY: { fn: () => tryInOrder(id, [
      () => fetchFromFinnhub("SPY"),
      () => fetchFromFMP("SPY"),
      () => fetchFromYahoo("SPY"),
    ])},
    QQQ: { fn: () => tryInOrder(id, [
      () => fetchFromFinnhub("QQQ"),
      () => fetchFromFMP("QQQ"),
      () => fetchFromYahoo("QQQ"),
    ])},
    WTI: { fn: () => tryInOrder(id, [
      () => fetchFromFinnhub("USOIL"),  // Finnhub symbol for WTI
      () => fetchFromYahoo("CL=F"),
      () => fetchFromFMP("USOIL"),
    ])},
    TNX: { fn: () => tryInOrder(id, [
      () => fetchFromFinnhub("US10Y"),  // Finnhub symbol for 10Y yield
      () => fetchFromYahoo("^TNX"),
    ])},
    DXY: { fn: () => tryInOrder(id, [
      () => fetchFromFinnhub("DXY"),    // Finnhub has DXY
      () => fetchFromYahoo("DX-Y.NYB"),
    ])},
    VIX: { fn: () => tryInOrder(id, [
      () => fetchFromFMP("^VIX"),
      () => fetchFromFinnhub("CBOE:VIX"),
    ])},
  };

  const config = ASSET_CONFIG[id];
  if (!config) throw new Error(`Unknown asset: ${id}`);

  const raw = await config.fn();
  return normalize(id, raw, raw._source ?? "unknown");
}

// Helper: try each fetcher in order, stop on first success
// Tags the result with which source worked
async function tryInOrder(id, fns) {
  const sourceNames = ["Finnhub", "Yahoo", "FMP", "Yahoo", "FMP"];
  for (let i = 0; i < fns.length; i++) {
    try {
      const result = await fns[i]();
      result._source = sourceNames[i] ?? "unknown";
      return result;
    } catch (e) {
      console.warn(`[FALLBACK] ${id} source ${i} failed: ${e.message}`);
    }
  }
  throw new Error(`All sources failed for ${id}`);
}

// ─── Validation ───────────────────────────────────────────────────
function validate(id, incoming) {
  const { price, timestamp } = incoming;

  if (!price || price <= 0 || isNaN(price)) {
    console.warn(`[VALIDATE] ${id}: REJECTED — price=${price}`);
    return "error";
  }

  if (timestamp) {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    if (ageMs > 2 * 60 * 1000) {
      console.warn(`[VALIDATE] ${id}: STALE — age=${Math.round(ageMs / 1000)}s`);
      return "stale";
    }
  }

  const prev = _lastValid[id]?.price;
  if (prev && prev > 0) {
    const deviation = Math.abs((price - prev) / prev);
    if (deviation > 0.10) {
      console.warn(`[VALIDATE] ${id}: SUSPICIOUS — ${price} vs ${prev} (${(deviation * 100).toFixed(1)}% deviation)`);
      return "error";
    }
  }

  return "valid";
}

// ─── Fallback prices (last known good, updated periodically) ──────
const FALLBACK = {
  BTC: { symbol:"BTC", price:84320,  change:0,     percentChange:0,     marketState:"REGULAR", prevClose:84320,  source:"fallback", timestamp:null, status:"error" },
  ETH: { symbol:"ETH", price:1580,   change:0,     percentChange:0,     marketState:"REGULAR", prevClose:1580,   source:"fallback", timestamp:null, status:"error" },
  VIX: { symbol:"VIX", price:17.04,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:17.04,  source:"fallback", timestamp:null, status:"error" },
  SPY: { symbol:"SPY", price:679.46, change:-0.30, percentChange:-0.07, marketState:"CLOSED",  prevClose:679.91, source:"fallback", timestamp:null, status:"error" },
  QQQ: { symbol:"QQQ", price:578.32, change:-0.70, percentChange:-0.12, marketState:"CLOSED",  prevClose:578.50, source:"fallback", timestamp:null, status:"error" },
  WTI: { symbol:"WTI", price:96.57,  change:-1.30, percentChange:-1.33, marketState:"CLOSED",  prevClose:97.87,  source:"fallback", timestamp:null, status:"error" },
  TNX: { symbol:"TNX", price:4.34,   change:-0.04, percentChange:-0.09, marketState:"CLOSED",  prevClose:4.38,   source:"fallback", timestamp:null, status:"error" },
  DXY: { symbol:"DXY", price:98.87,  change:-0.15, percentChange:-0.15, marketState:"CLOSED",  prevClose:99.02,  source:"fallback", timestamp:null, status:"error" },
};

// ─── Handler ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const fetchedAt = new Date().toISOString();
  const skipVIX   = req.query?.skipVIX === "1" && !isMarketOpen();
  console.log(`[/api/prices] ${fetchedAt} | skipVIX=${skipVIX}`);

  const ids = ["BTC", "ETH", "SPY", "QQQ", "WTI", "TNX", "DXY", "VIX"];
  const assets = {};

  // Fetch all in parallel — no duplicate fetches, each id fetched exactly once
  await Promise.all(
    ids
      .filter(id => !(id === "VIX" && skipVIX))
      .map(id =>
        getAssetPrice(id)
          .then(result => {
            const status = validate(id, result);

            if (status === "valid") {
              _lastValid[id] = result;
              assets[id] = { ...result, status: "valid" };
            } else if (status === "stale") {
              assets[id] = { ...result, status: "stale", statusReason: "timestamp_old" };
            } else {
              // Use last valid or fallback — never show bad data
              const saved = _lastValid[id] ?? FALLBACK[id];
              assets[id] = { ...saved, status: "error", statusReason: "validation_failed", rejectedPrice: result.price };
              console.warn(`[STATUS] ${id}: error — rejected=${result.price}, using=${saved.price}`);
            }

            console.log(`[RESULT] ${id}: $${assets[id].price} (${assets[id].percentChange}%) src=${assets[id].source} status=${assets[id].status}`);
          })
          .catch(e => {
            console.error(`[FAIL] ${id}: ${e.message}`);
            const saved = _lastValid[id] ?? FALLBACK[id];
            assets[id] = { ...saved, status: "error", statusReason: "fetch_failed" };
          })
      )
  );

  // Fill in any skipped assets (VIX when market closed) with last valid
  for (const id of ids) {
    if (!assets[id]) {
      const saved = _lastValid[id] ?? FALLBACK[id];
      assets[id] = { ...saved, status: "stale", statusReason: "skipped" };
    }
  }

  res.status(200).json({ fetchedAt, assets });
}