// api/prices.js — Vercel Serverless Function
// Includes: source, timestamp, status validation, sanity checks

const FMP_KEY = process.env.FMP_API_KEY || "";

// In-memory last-known-good prices (persists across warm invocations)
const _lastValid = {};

// ─── Validation rules ────────────────────────────────────────────
// Returns "valid", "stale", or "error"
function validate(id, incoming) {
  const { price, timestamp } = incoming;

  // Rule 1: price must be a real positive number
  if (!price || price <= 0 || isNaN(price)) {
    console.warn(`[VALIDATE] ${id}: REJECTED — price=${price}`);
    return "error";
  }

  // Rule 2: timestamp must be within the last 2 minutes
  if (timestamp) {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    if (ageMs > 2 * 60 * 1000) {
      console.warn(`[VALIDATE] ${id}: STALE — age=${Math.round(ageMs/1000)}s`);
      return "stale";
    }
  }

  // Rule 3: price must not deviate >10% from last known good value
  const prev = _lastValid[id]?.price;
  if (prev && prev > 0) {
    const deviation = Math.abs((price - prev) / prev);
    if (deviation > 0.10) {
      console.warn(`[VALIDATE] ${id}: SUSPICIOUS — price=${price} vs lastValid=${prev} (${(deviation*100).toFixed(1)}% deviation)`);
      return "error";
    }
  }

  return "valid";
}

// ─── Fetchers ────────────────────────────────────────────────────
async function fetchYahoo(symbol) {
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
  if (!meta) throw new Error(`No meta for ${symbol}`);
  const price       = parseFloat((meta.regularMarketPrice ?? 0).toFixed(2));
  const change      = parseFloat((meta.regularMarketChangePercent ?? 0).toFixed(2));
  const marketState = meta.marketState ?? "CLOSED";
  const prevClose   = parseFloat((meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0).toFixed(2));
  const timestamp   = new Date().toISOString();
  console.log(`[Yahoo] ${symbol} | price=${price} | change=${change}% | state=${marketState}`);
  return { price, change, marketState, prevClose, source: "Yahoo", timestamp };
}

async function fetchBinance(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const d = await res.json();
  const price     = parseFloat(parseFloat(d.lastPrice).toFixed(2));
  const change    = parseFloat(parseFloat(d.priceChangePercent).toFixed(2));
  const prevClose = parseFloat(parseFloat(d.prevClosePrice).toFixed(2));
  const timestamp = new Date().toISOString();
  console.log(`[Binance] ${symbol} | price=${price} | change=${change}%`);
  return { price, change, marketState: "REGULAR", prevClose, source: "Binance", timestamp };
}

async function fetchVIX() {
  if (!FMP_KEY) throw new Error("No FMP key");
  const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${FMP_KEY}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error("VIX empty");
  const price       = parseFloat((data[0].price ?? 0).toFixed(2));
  const change      = parseFloat((data[0].changePercentage ?? 0).toFixed(2));
  const prevClose   = parseFloat((data[0].previousClose ?? data[0].price ?? 0).toFixed(2));
  const marketState = isMarketOpen() ? "REGULAR" : "CLOSED";
  const timestamp   = new Date().toISOString();
  console.log(`[FMP] VIX | price=${price} | change=${change}% | state=${marketState}`);
  return { price, change, marketState, prevClose, source: "FMP", timestamp };
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// ─── Fallback prices ─────────────────────────────────────────────
const FALLBACK = {
  BTC: { price: 84320,  change: 0,     marketState: "REGULAR", prevClose: 84320,  source: "fallback", timestamp: null },
  ETH: { price: 1580,   change: 0,     marketState: "REGULAR", prevClose: 1580,   source: "fallback", timestamp: null },
  VIX: { price: 17.04,  change: 0,     marketState: "CLOSED",  prevClose: 17.04,  source: "fallback", timestamp: null },
  SPY: { price: 679.46, change: -0.07, marketState: "CLOSED",  prevClose: 679.91, source: "fallback", timestamp: null },
  QQQ: { price: 578.32, change: -0.12, marketState: "CLOSED",  prevClose: 578.50, source: "fallback", timestamp: null },
  WTI: { price: 96.57,  change: -1.33, marketState: "CLOSED",  prevClose: 97.87,  source: "fallback", timestamp: null },
  TNX: { price: 4.34,   change: -0.09, marketState: "CLOSED",  prevClose: 4.38,   source: "fallback", timestamp: null },
  DXY: { price: 98.87,  change: -0.15, marketState: "CLOSED",  prevClose: 99.02,  source: "fallback", timestamp: null },
};

// ─── Handler ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const raw = {};   // raw fetch results
  const fetchedAt = new Date().toISOString();
  console.log(`[/api/prices] request at ${fetchedAt}`);

  // Fetch all in parallel — failures go to raw as undefined
  await Promise.all([
    fetchBinance("BTCUSDT").then(r => { raw.BTC = r; }).catch(e => console.error("[FAIL] BTC:", e.message)),
    fetchBinance("ETHUSDT").then(r => { raw.ETH = r; }).catch(e => console.error("[FAIL] ETH:", e.message)),
    fetchYahoo("SPY").then(r       => { raw.SPY = r; }).catch(e => console.error("[FAIL] SPY:", e.message)),
    fetchYahoo("QQQ").then(r       => { raw.QQQ = r; }).catch(e => console.error("[FAIL] QQQ:", e.message)),
    fetchYahoo("CL=F").then(r      => { raw.WTI = r; }).catch(e => console.error("[FAIL] WTI:", e.message)),
    fetchYahoo("^TNX").then(r      => { raw.TNX = r; }).catch(e => console.error("[FAIL] TNX:", e.message)),
    fetchYahoo("DX-Y.NYB").then(r  => { raw.DXY = r; }).catch(e => console.error("[FAIL] DXY:", e.message)),
    fetchVIX().then(r              => { raw.VIX = r; }).catch(e => console.error("[FAIL] VIX:", e.message)),
  ]);

  // Validate each asset and build final response
  const assets = {};
  const ids = ["BTC", "ETH", "SPY", "QQQ", "WTI", "TNX", "DXY", "VIX"];

  for (const id of ids) {
    const fetched = raw[id];

    if (!fetched) {
      // Fetch failed entirely — use last valid or fallback
      const saved = _lastValid[id] ?? FALLBACK[id];
      assets[id] = { ...saved, status: "error", statusReason: "fetch_failed" };
      console.warn(`[STATUS] ${id}: error (fetch_failed) — using ${_lastValid[id] ? "lastValid" : "fallback"}`);
      continue;
    }

    const status = validate(id, fetched);

    if (status === "valid") {
      // Store as last known good
      _lastValid[id] = fetched;
      assets[id] = { ...fetched, status: "valid" };
    } else if (status === "stale") {
      // Keep the data but flag it
      assets[id] = { ...fetched, status: "stale", statusReason: "timestamp_old" };
    } else {
      // error — use last valid if available
      const saved = _lastValid[id] ?? FALLBACK[id];
      assets[id] = { ...saved, status: "error", statusReason: "validation_failed", rejectedPrice: fetched.price };
      console.warn(`[STATUS] ${id}: error — rejected price=${fetched.price}, using lastValid=${saved.price}`);
    }

    console.log(`[STATUS] ${id}: ${assets[id].status} | $${assets[id].price}`);
  }

  res.status(200).json({ fetchedAt, assets });
}