// api/prices.js — Vercel Serverless Function
// Smart polling + server-side cache + rate limit protection
// Architecture: cache-first → Finnhub (primary) → FMP (fallback) → Yahoo → Binance (crypto)

// ─── Environment ──────────────────────────────────────────────────
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FMP_KEY     = process.env.FMP_API_KEY     || "";

// ─────────────────────────────────────────────────────────────────
// POLLING TIERS
// Defines how fresh each asset's cache must be before re-fetching.
// Frontend can call /api/prices as often as it wants — server
// returns cached data if still fresh, only hits upstream APIs when stale.
// ─────────────────────────────────────────────────────────────────
const TIERS = {
  HIGH:   { ttl:  8 * 1000, label: "HIGH"   },  // 8s  — SPY, QQQ, BTC, ETH, VIX
  MEDIUM: { ttl: 30 * 1000, label: "MEDIUM" },  // 30s — WTI
  LOW:    { ttl: 60 * 1000, label: "LOW"    },  // 60s — TNX, DXY (slow-moving macro)
};

// Asset → tier assignment
const ASSET_TIER = {
  BTC: TIERS.HIGH,
  ETH: TIERS.HIGH,
  SPY: TIERS.HIGH,
  QQQ: TIERS.HIGH,
  VIX: TIERS.HIGH,
  WTI: TIERS.MEDIUM,
  TNX: TIERS.LOW,
  DXY: TIERS.LOW,
};

// ─────────────────────────────────────────────────────────────────
// SERVER-SIDE CACHE
// Module-level — persists across warm Vercel invocations
// Shape: { [id]: { data: {...}, fetchedAt: ms, tier: TIER } }
// ─────────────────────────────────────────────────────────────────
const _cache     = {};   // live cache
const _lastValid = {};   // last-known-good (survives bad fetches)

function isCacheFresh(id) {
  const entry = _cache[id];
  if (!entry) return false;
  const tier  = ASSET_TIER[id] ?? TIERS.MEDIUM;
  const age   = Date.now() - entry.fetchedAt;
  return age < tier.ttl;
}

function setCacheEntry(id, data) {
  _cache[id] = { data, fetchedAt: Date.now() };
}

function getCacheEntry(id) {
  return _cache[id]?.data ?? null;
}

// ─────────────────────────────────────────────────────────────────
// RATE LIMIT TRACKER
// Tracks Finnhub calls in the last 60 seconds (rolling window).
// Finnhub free tier: 60 calls/min.
// FMP free tier: 250 calls/day (~10/hr safe average).
// If near limit → skip low-priority assets, return cached/fallback.
// ─────────────────────────────────────────────────────────────────
const _rateLimiter = {
  finnhub: { calls: [], limit: 55 },  // 55/min (5-call safety margin)
  fmp:     { calls: [], limit: 8  },  // 8/hr converted to per-minute window
};

function recordCall(source) {
  const now = Date.now();
  const tracker = _rateLimiter[source];
  if (!tracker) return;
  // Keep only calls within the last 60 seconds
  tracker.calls = tracker.calls.filter(t => now - t < 60 * 1000);
  tracker.calls.push(now);
}

function isNearLimit(source) {
  const now = Date.now();
  const tracker = _rateLimiter[source];
  if (!tracker) return false;
  const recentCalls = tracker.calls.filter(t => now - t < 60 * 1000).length;
  const nearLimit = recentCalls >= tracker.limit;
  if (nearLimit) {
    console.warn(`[RATE] ${source} near limit — ${recentCalls}/${tracker.limit} calls/min`);
  }
  return nearLimit;
}

function getRateLimitStatus() {
  const now = Date.now();
  return {
    finnhub: {
      calls: _rateLimiter.finnhub.calls.filter(t => now - t < 60 * 1000).length,
      limit: _rateLimiter.finnhub.limit,
      nearLimit: isNearLimit("finnhub"),
    },
    fmp: {
      calls: _rateLimiter.fmp.calls.filter(t => now - t < 60 * 1000).length,
      limit: _rateLimiter.fmp.limit,
      nearLimit: isNearLimit("fmp"),
    },
  };
}

// ─── Market hours helper ──────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// ─── Standardized response shape ─────────────────────────────────
function normalize(symbol, raw, source) {
  return {
    symbol,
    price:         parseFloat((raw.price         ?? 0).toFixed(2)),
    change:        parseFloat((raw.change        ?? 0).toFixed(2)),
    percentChange: parseFloat((raw.percentChange ?? 0).toFixed(2)),
    prevClose:     parseFloat((raw.prevClose ?? raw.price ?? 0).toFixed(2)),
    marketState:   raw.marketState ?? "CLOSED",
    source,
    timestamp:     new Date().toISOString(),
    status:        "valid",
    cached:        false,
  };
}

// ─────────────────────────────────────────────────────────────────
// FETCHERS
// ─────────────────────────────────────────────────────────────────

async function fetchFromFinnhub(symbol) {
  if (!FINNHUB_KEY)       throw new Error("No Finnhub key");
  if (isNearLimit("finnhub")) throw new Error("Finnhub rate limit — throttling");

  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`Finnhub ${res.status} for ${symbol}`);

  const d = await res.json();
  if (!d.c || d.c === 0) throw new Error(`Finnhub zero price for ${symbol}`);

  recordCall("finnhub");
  console.log(`[Finnhub] ${symbol} | price=${d.c} | ${d.dp}%`);

  return {
    price:         parseFloat(d.c.toFixed(2)),
    percentChange: parseFloat((d.dp ?? 0).toFixed(2)),
    change:        parseFloat((d.d  ?? 0).toFixed(2)),
    prevClose:     parseFloat((d.pc ?? d.c).toFixed(2)),
    marketState:   isMarketOpen() ? "REGULAR" : "CLOSED",
    _source:       "Finnhub",
  };
}

async function fetchFromFMP(symbol) {
  if (!FMP_KEY)         throw new Error("No FMP key");
  if (isNearLimit("fmp")) throw new Error("FMP rate limit — throttling");

  const res = await fetch(
    `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);

  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error(`FMP empty for ${symbol}`);

  const d = data[0];
  if (!d.price || d.price === 0) throw new Error(`FMP zero price for ${symbol}`);

  recordCall("fmp");
  console.log(`[FMP] ${symbol} | price=${d.price} | ${d.changePercentage}%`);

  return {
    price:         parseFloat((d.price            ?? 0).toFixed(2)),
    percentChange: parseFloat((d.changePercentage ?? 0).toFixed(2)),
    change:        parseFloat((d.change           ?? 0).toFixed(2)),
    prevClose:     parseFloat((d.previousClose    ?? d.price ?? 0).toFixed(2)),
    marketState:   isMarketOpen() ? "REGULAR" : "CLOSED",
    _source:       "FMP",
  };
}

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

  const price = parseFloat((meta.regularMarketPrice ?? 0).toFixed(2));
  if (!price || price === 0) throw new Error(`Yahoo zero price for ${symbol}`);

  const prevClose = parseFloat((meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0).toFixed(2));
  console.log(`[Yahoo] ${symbol} | price=${price}`);

  return {
    price,
    percentChange: parseFloat((meta.regularMarketChangePercent ?? 0).toFixed(2)),
    change:        parseFloat((price - prevClose).toFixed(2)),
    prevClose,
    marketState:   meta.marketState ?? "CLOSED",
    _source:       "Yahoo",
  };
}

async function fetchFromBinance(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);

  const d = await res.json();
  const price = parseFloat(parseFloat(d.lastPrice).toFixed(2));
  if (!price || price === 0) throw new Error(`Binance zero price for ${symbol}`);

  console.log(`[Binance] ${symbol} | price=${price}`);

  return {
    price,
    percentChange: parseFloat(parseFloat(d.priceChangePercent).toFixed(2)),
    change:        parseFloat(parseFloat(d.priceChange).toFixed(2)),
    prevClose:     parseFloat(parseFloat(d.prevClosePrice).toFixed(2)),
    marketState:   "REGULAR",
    _source:       "Binance",
  };
}

// ─── tryInOrder: first-success wins, tags source ──────────────────
async function tryInOrder(id, fns) {
  for (let i = 0; i < fns.length; i++) {
    try {
      const result = await fns[i]();
      return result; // _source already set inside each fetcher
    } catch (e) {
      console.warn(`[FALLBACK] ${id} attempt ${i + 1} failed: ${e.message}`);
    }
  }
  throw new Error(`All sources failed for ${id}`);
}

// ─── Asset fetch config ───────────────────────────────────────────
function getFetchFn(id) {
  const configs = {
    BTC: () => fetchFromBinance("BTCUSDT"),
    ETH: () => fetchFromBinance("ETHUSDT"),
    SPY: () => tryInOrder(id, [
      () => fetchFromFinnhub("SPY"),
      () => fetchFromFMP("SPY"),
      () => fetchFromYahoo("SPY"),
    ]),
    QQQ: () => tryInOrder(id, [
      () => fetchFromFinnhub("QQQ"),
      () => fetchFromFMP("QQQ"),
      () => fetchFromYahoo("QQQ"),
    ]),
    WTI: () => tryInOrder(id, [
      () => fetchFromFinnhub("USOIL"),
      () => fetchFromYahoo("CL=F"),
      () => fetchFromFMP("USOIL"),
    ]),
    TNX: () => tryInOrder(id, [
      () => fetchFromFinnhub("US10Y"),
      () => fetchFromYahoo("^TNX"),
    ]),
    DXY: () => tryInOrder(id, [
      () => fetchFromFinnhub("DXY"),
      () => fetchFromYahoo("DX-Y.NYB"),
    ]),
    VIX: () => tryInOrder(id, [
      () => fetchFromFMP("^VIX"),
      () => fetchFromFinnhub("CBOE:VIX"),
    ]),
  };
  return configs[id] ?? null;
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
      console.warn(`[VALIDATE] ${id}: SUSPICIOUS — ${price} vs ${prev} (${(deviation * 100).toFixed(1)}% dev)`);
      return "error";
    }
  }

  return "valid";
}

// ─── Fallback prices ──────────────────────────────────────────────
const FALLBACK = {
  BTC: { symbol:"BTC", price:84320,  change:0,     percentChange:0,     marketState:"REGULAR", prevClose:84320,  source:"fallback", timestamp:null, status:"error", cached:false },
  ETH: { symbol:"ETH", price:1580,   change:0,     percentChange:0,     marketState:"REGULAR", prevClose:1580,   source:"fallback", timestamp:null, status:"error", cached:false },
  VIX: { symbol:"VIX", price:17.04,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:17.04,  source:"fallback", timestamp:null, status:"error", cached:false },
  SPY: { symbol:"SPY", price:679.46, change:-0.30, percentChange:-0.07, marketState:"CLOSED",  prevClose:679.91, source:"fallback", timestamp:null, status:"error", cached:false },
  QQQ: { symbol:"QQQ", price:578.32, change:-0.70, percentChange:-0.12, marketState:"CLOSED",  prevClose:578.50, source:"fallback", timestamp:null, status:"error", cached:false },
  WTI: { symbol:"WTI", price:96.57,  change:-1.30, percentChange:-1.33, marketState:"CLOSED",  prevClose:97.87,  source:"fallback", timestamp:null, status:"error", cached:false },
  TNX: { symbol:"TNX", price:4.34,   change:-0.04, percentChange:-0.09, marketState:"CLOSED",  prevClose:4.38,   source:"fallback", timestamp:null, status:"error", cached:false },
  DXY: { symbol:"DXY", price:98.87,  change:-0.15, percentChange:-0.15, marketState:"CLOSED",  prevClose:99.02,  source:"fallback", timestamp:null, status:"error", cached:false },
};

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const fetchedAt    = new Date().toISOString();
  const marketOpen   = isMarketOpen();
  const skipVIX      = !marketOpen; // Never poll VIX when market closed — saves FMP quota
  const rateLimits   = getRateLimitStatus();

  console.log(`[/api/prices] ${fetchedAt} | market=${marketOpen ? "OPEN" : "CLOSED"} | finnhub=${rateLimits.finnhub.calls}/${rateLimits.finnhub.limit} | fmp=${rateLimits.fmp.calls}/${rateLimits.fmp.limit}`);

  const ids    = ["BTC", "ETH", "SPY", "QQQ", "WTI", "TNX", "DXY", "VIX"];
  const assets = {};

  // ── Step 1: Serve from cache where fresh ─────────────────────────
  const staleIds = [];
  for (const id of ids) {
    if (id === "VIX" && skipVIX) {
      // Market closed — return last valid VIX, no fetch
      const saved = _lastValid.VIX ?? FALLBACK.VIX;
      assets.VIX = { ...saved, cached: true, status: saved.status ?? "stale", statusReason: "market_closed" };
      continue;
    }

    if (isCacheFresh(id)) {
      // Cache hit — return immediately, no upstream call
      const cached = getCacheEntry(id);
      assets[id] = { ...cached, cached: true };
      console.log(`[CACHE HIT] ${id} | tier=${ASSET_TIER[id]?.label} | age=${Math.round((Date.now() - _cache[id].fetchedAt) / 1000)}s`);
    } else {
      staleIds.push(id);
    }
  }

  // ── Step 2: If near rate limit, throttle low-priority stale assets ─
  const throttledIds = [];
  if (rateLimits.finnhub.nearLimit || rateLimits.fmp.nearLimit) {
    const lowPriority = staleIds.filter(id => ASSET_TIER[id] === TIERS.LOW);
    for (const id of lowPriority) {
      const saved = _lastValid[id] ?? getCacheEntry(id) ?? FALLBACK[id];
      if (saved) {
        assets[id] = { ...saved, cached: true, status: "stale", statusReason: "rate_limited" };
        throttledIds.push(id);
        console.warn(`[THROTTLE] ${id} — rate limit near, serving last known`);
      }
    }
  }

  // Remaining IDs that actually need a fresh fetch
  const fetchIds = staleIds.filter(id => !throttledIds.includes(id));

  // ── Step 3: Fetch stale assets in parallel ────────────────────────
  await Promise.all(
    fetchIds.map(id => {
      const fetchFn = getFetchFn(id);
      if (!fetchFn) return Promise.resolve();

      return fetchFn()
        .then(raw => {
          const result  = normalize(id, raw, raw._source ?? "unknown");
          const vstatus = validate(id, result);

          if (vstatus === "valid") {
            _lastValid[id] = result;
            setCacheEntry(id, { ...result, status: "valid" });
            assets[id] = { ...result, status: "valid", cached: false };
          } else if (vstatus === "stale") {
            assets[id] = { ...result, status: "stale", statusReason: "timestamp_old", cached: false };
          } else {
            const saved = _lastValid[id] ?? FALLBACK[id];
            assets[id] = { ...saved, status: "error", statusReason: "validation_failed", rejectedPrice: result.price, cached: false };
            console.warn(`[STATUS] ${id}: rejected price=${result.price}, serving=${saved.price}`);
          }

          console.log(`[RESULT] ${id}: $${assets[id].price} (${assets[id].percentChange}%) src=${assets[id].source} cached=false tier=${ASSET_TIER[id]?.label}`);
        })
        .catch(e => {
          console.error(`[FAIL] ${id}: ${e.message}`);
          const saved = _lastValid[id] ?? FALLBACK[id];
          assets[id] = { ...saved, status: "error", statusReason: "fetch_failed", cached: false };
        });
    })
  );

  // ── Step 4: Fill any gaps ─────────────────────────────────────────
  for (const id of ids) {
    if (!assets[id]) {
      const saved = _lastValid[id] ?? FALLBACK[id];
      assets[id]  = { ...saved, cached: true, status: "stale", statusReason: "no_data" };
    }
  }

  res.status(200).json({
    fetchedAt,
    marketOpen,
    rateLimits,
    cacheHits:  ids.filter(id => assets[id]?.cached).length,
    freshFetches: fetchIds.length,
    assets,
  });
}