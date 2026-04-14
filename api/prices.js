// api/prices.js — Vercel Serverless Function
// Data quality + source prioritization system
// Architecture: cache-first → scored source chain → confidence rating → fallback

// ─── Environment ──────────────────────────────────────────────────
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FMP_KEY     = process.env.FMP_API_KEY     || "";

// ─────────────────────────────────────────────────────────────────
// SOURCE REGISTRY
// Defines priority score, reliability, and per-source validation rules.
// Lower score = higher priority = tried first.
// ─────────────────────────────────────────────────────────────────
const SOURCES = {
  Binance: {
    priority:      1,
    reliability:   "high",   // Near real-time, no quota concerns
    maxAgeMs:      10 * 1000, // Reject if data > 10s old (crypto moves fast)
    maxDeviationPct: 12,      // Crypto is volatile — allow 12% swings
  },
  Finnhub: {
    priority:      1,         // Tied with Binance for equities
    reliability:   "high",
    maxAgeMs:      2 * 60 * 1000, // 2 min max age
    maxDeviationPct: 15,      // Abnormal move threshold per spec
  },
  FMP: {
    priority:      2,
    reliability:   "medium",  // Good data, but 250/day quota
    maxAgeMs:      5 * 60 * 1000, // Slightly more lenient — updates less often
    maxDeviationPct: 15,
  },
  Yahoo: {
    priority:      3,
    reliability:   "medium",  // Free, no quota, but can cache stale data
    maxAgeMs:      5 * 60 * 1000,
    maxDeviationPct: 15,
  },
  fallback: {
    priority:      99,
    reliability:   "low",
    maxAgeMs:      Infinity,
    maxDeviationPct: Infinity,
  },
};

// ─────────────────────────────────────────────────────────────────
// POLLING TIERS
// HIGH-tier TTL is 5s so a 12s frontend poll always gets fresh data
// during the trading session. BTC/ETH are WS-driven so TTL is moot for them.
// ─────────────────────────────────────────────────────────────────
const TIERS = {
  HIGH:   { ttl:  5 * 1000, label: "HIGH"   },   // SPY, QQQ, VIX — needs freshness
  MEDIUM: { ttl: 20 * 1000, label: "MEDIUM" },   // WTI, GOLD — move slower
  LOW:    { ttl: 60 * 1000, label: "LOW"    },   // TNX, DXY — macro, slow-moving
};

const ASSET_TIER = {
  BTC: TIERS.HIGH,
  ETH: TIERS.HIGH,
  SPY: TIERS.HIGH,
  QQQ: TIERS.HIGH,
  VIX: TIERS.HIGH,
  WTI: TIERS.MEDIUM,
  GOLD: TIERS.MEDIUM,  // Gold moves with macro — 30s is sufficient
  TNX: TIERS.LOW,
  DXY: TIERS.LOW,
};

// ─────────────────────────────────────────────────────────────────
// SERVER-SIDE CACHE + LAST-VALID
// ─────────────────────────────────────────────────────────────────
const _cache     = {};
const _lastValid = {};

function isCacheFresh(id) {
  const entry = _cache[id];
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < (ASSET_TIER[id] ?? TIERS.MEDIUM).ttl;
}

function setCacheEntry(id, data) {
  _cache[id] = { data, fetchedAt: Date.now() };
}

function getCacheEntry(id) {
  return _cache[id]?.data ?? null;
}

// ─────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────
const _rateLimiter = {
  finnhub: { calls: [], limit: 55 },
  fmp:     { calls: [], limit: 8  },
};

function recordCall(source) {
  const now     = Date.now();
  const tracker = _rateLimiter[source];
  if (!tracker) return;
  tracker.calls = tracker.calls.filter(t => now - t < 60 * 1000);
  tracker.calls.push(now);
}

function isNearLimit(source) {
  const now     = Date.now();
  const tracker = _rateLimiter[source];
  if (!tracker) return false;
  const recent = tracker.calls.filter(t => now - t < 60 * 1000).length;
  if (recent >= tracker.limit) {
    console.warn(`[RATE] ${source} near limit — ${recent}/${tracker.limit} calls/min`);
    return true;
  }
  return false;
}

function getRateLimitStatus() {
  const now = Date.now();
  return {
    finnhub: { calls: _rateLimiter.finnhub.calls.filter(t => now - t < 60 * 1000).length, limit: _rateLimiter.finnhub.limit },
    fmp:     { calls: _rateLimiter.fmp.calls.filter(t => now - t < 60 * 1000).length,     limit: _rateLimiter.fmp.limit     },
  };
}

// ─── Market hours ─────────────────────────────────────────────────
function isMarketOpen() {
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// ─── Normalize to standard shape ─────────────────────────────────
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
    confidence:    "high",
    cached:        false,
  };
}

// ─────────────────────────────────────────────────────────────────
// SCORE + VALIDATE
// Replaces simple validate() — now source-aware and returns
// a structured result with confidence scoring.
//
// Returns: { valid: bool, confidence: "high"|"medium"|"low", reason: string }
//
// Validation rules (expanded per spec):
//   1. price must be > 0 and not null
//   2. timestamp must not exceed source's maxAgeMs
//   3. percentChange must not exceed source's maxDeviationPct (15% for Finnhub/FMP)
//   4. Cross-source sanity: if lastValid exists and deviation > threshold → reject
// ─────────────────────────────────────────────────────────────────
function scoreAndValidate(id, incoming) {
  const sourceCfg = SOURCES[incoming.source] ?? SOURCES.fallback;
  const { price, percentChange, timestamp, source } = incoming;

  // Rule 1 — price must exist and be positive
  if (!price || price <= 0 || isNaN(price)) {
    console.warn(`[VALIDATE] ${id} [${source}]: REJECTED — null/zero price`);
    return { valid: false, confidence: "low", reason: "null_price" };
  }

  // Rule 2 — timestamp must be fresh (source-specific max age)
  if (timestamp && sourceCfg.maxAgeMs !== Infinity) {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    if (ageMs > sourceCfg.maxAgeMs) {
      console.warn(`[VALIDATE] ${id} [${source}]: STALE — age=${Math.round(ageMs/1000)}s > max=${sourceCfg.maxAgeMs/1000}s`);
      return { valid: false, confidence: "low", reason: "stale_timestamp" };
    }
  }

  // Rule 3 — abnormal single-period move (>15% per spec)
  if (Math.abs(percentChange) > sourceCfg.maxDeviationPct) {
    console.warn(`[VALIDATE] ${id} [${source}]: ABNORMAL MOVE — ${percentChange}% > ${sourceCfg.maxDeviationPct}% limit`);
    return { valid: false, confidence: "low", reason: `abnormal_move_${percentChange.toFixed(1)}pct` };
  }

  // Rule 4 — cross-source sanity check vs last known good
  const prev = _lastValid[id]?.price;
  if (prev && prev > 0) {
    const crossDeviation = Math.abs((price - prev) / prev) * 100;
    if (crossDeviation > 10) {
      console.warn(`[VALIDATE] ${id} [${source}]: CROSS-SOURCE DEVIATION — ${price} vs lastValid=${prev} (${crossDeviation.toFixed(1)}%)`);
      return { valid: false, confidence: "low", reason: `cross_source_deviation_${crossDeviation.toFixed(1)}pct` };
    }
  }

  // ── Confidence scoring ────────────────────────────────────────
  // High:   primary source, fresh timestamp, small move
  // Medium: fallback source used, or moderate move detected
  // Low:    secondary fallback, large move, or near-limit conditions
  let confidence = "high";

  if (sourceCfg.priority > 1) {
    // Not the primary source — medium confidence
    confidence = "medium";
  }

  if (Math.abs(percentChange) > 5) {
    // Large but valid move — flag as medium
    confidence = confidence === "high" ? "medium" : "low";
  }

  if (sourceCfg.reliability === "medium") {
    confidence = confidence === "high" ? "medium" : confidence;
  }

  return { valid: true, confidence, reason: "ok" };
}

// ─────────────────────────────────────────────────────────────────
// FETCHERS
// ─────────────────────────────────────────────────────────────────

async function fetchFromFinnhub(symbol) {
  if (!FINNHUB_KEY)           throw new Error("No Finnhub key");
  if (isNearLimit("finnhub")) throw new Error("Finnhub rate limit — throttling");

  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status} for ${symbol}`);

  const d = await res.json();
  if (!d.c || d.c === 0) throw new Error(`Finnhub zero price for ${symbol}`);

  recordCall("finnhub");
  console.log(`[Finnhub] ${symbol} | price=${d.c} | ${d.dp}% | priority=1`);

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
  if (!FMP_KEY)             throw new Error("No FMP key");
  if (isNearLimit("fmp"))   throw new Error("FMP rate limit — throttling");

  const res = await fetch(
    `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`FMP HTTP ${res.status} for ${symbol}`);

  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error(`FMP empty for ${symbol}`);

  const d = data[0];
  if (!d.price || d.price === 0) throw new Error(`FMP zero price for ${symbol}`);

  recordCall("fmp");
  console.log(`[FMP] ${symbol} | price=${d.price} | ${d.changePercentage}% | priority=2`);

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
      "Accept":     "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);

  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo no meta for ${symbol}`);

  const price = parseFloat((meta.regularMarketPrice ?? 0).toFixed(2));
  if (!price || price === 0) throw new Error(`Yahoo zero price for ${symbol}`);

  const prevClose = parseFloat((meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0).toFixed(2));
  console.log(`[Yahoo] ${symbol} | price=${price} | priority=3`);

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
  if (!res.ok) throw new Error(`Binance HTTP ${res.status} for ${symbol}`);

  const d     = await res.json();
  const price = parseFloat(parseFloat(d.lastPrice).toFixed(2));
  if (!price || price === 0) throw new Error(`Binance zero price for ${symbol}`);

  console.log(`[Binance] ${symbol} | price=${price} | priority=1`);

  return {
    price,
    percentChange: parseFloat(parseFloat(d.priceChangePercent).toFixed(2)),
    change:        parseFloat(parseFloat(d.priceChange).toFixed(2)),
    prevClose:     parseFloat(parseFloat(d.prevClosePrice).toFixed(2)),
    marketState:   "REGULAR",
    _source:       "Binance",
  };
}

// ─────────────────────────────────────────────────────────────────
// GET ASSET WITH FALLBACK
// Replaces tryInOrder — now quality-gated at each step.
// If Finnhub returns data but it fails validation → try FMP before giving up.
// Logs every decision with symbol + reason.
// ─────────────────────────────────────────────────────────────────
async function getAssetWithFallback(id, fetchChain) {
  const attempts = [];

  for (const { name, fn } of fetchChain) {
    let raw;
    try {
      raw = await fn();
    } catch (fetchErr) {
      const reason = fetchErr.message;
      console.warn(`[SOURCE FAIL] ${id} [${name}]: ${reason}`);
      attempts.push({ source: name, outcome: "fetch_error", reason });
      continue; // Try next source
    }

    // Normalize and score the result
    const result     = normalize(id, raw, raw._source ?? name);
    const { valid, confidence, reason } = scoreAndValidate(id, result);

    if (valid) {
      console.log(`[SOURCE OK] ${id} [${name}]: price=${result.price} confidence=${confidence}`);
      attempts.push({ source: name, outcome: "accepted", confidence });
      return { ...result, confidence, attempts };
    } else {
      // Data came back but failed quality checks — try next source
      console.warn(`[SOURCE REJECTED] ${id} [${name}]: ${reason} — falling back`);
      attempts.push({ source: name, outcome: "rejected", reason });
    }
  }

  // All sources exhausted
  console.error(`[ALL SOURCES FAILED] ${id}: ${attempts.map(a => `${a.source}(${a.outcome})`).join(" → ")}`);
  throw new Error(`All sources failed for ${id}`);
}

// ─── Asset fetch chains (ordered by source priority) ─────────────
function getFetchChain(id) {
  const chains = {
    BTC: [{ name: "Binance", fn: () => fetchFromBinance("BTCUSDT") }],
    ETH: [{ name: "Binance", fn: () => fetchFromBinance("ETHUSDT") }],
    SPY: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("SPY")   },
      { name: "FMP",     fn: () => fetchFromFMP("SPY")       },
      { name: "Yahoo",   fn: () => fetchFromYahoo("SPY")     },
    ],
    QQQ: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("QQQ")   },
      { name: "FMP",     fn: () => fetchFromFMP("QQQ")       },
      { name: "Yahoo",   fn: () => fetchFromYahoo("QQQ")     },
    ],
    WTI: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("USOIL") },
      { name: "Yahoo",   fn: () => fetchFromYahoo("CL=F")    },
      { name: "FMP",     fn: () => fetchFromFMP("USOIL")     },
    ],
    TNX: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("US10Y") },
      { name: "Yahoo",   fn: () => fetchFromYahoo("^TNX")    },
    ],
    DXY: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("DXY")         },
      { name: "Yahoo",   fn: () => fetchFromYahoo("DX-Y.NYB")      },
    ],
    VIX: [
      { name: "FMP",     fn: () => fetchFromFMP("^VIX")            },
      { name: "Finnhub", fn: () => fetchFromFinnhub("CBOE:VIX")    },
    ],
    GOLD: [
      { name: "Finnhub", fn: () => fetchFromFinnhub("GC1!")        }, // Finnhub continuous futures
      { name: "Yahoo",   fn: () => fetchFromYahoo("GC=F")          }, // Yahoo gold futures
      { name: "FMP",     fn: () => fetchFromFMP("GCUSD")           }, // FMP spot gold
    ],
  };
  return chains[id] ?? null;
}

// ─────────────────────────────────────────────────────────────────
// SYSTEM STATUS TRACKER
// Module-level — tracks consecutive outage counts per asset
// Used to determine global LIVE / DEGRADED / OFFLINE status
// ─────────────────────────────────────────────────────────────────
const _failCounts = {};   // id → consecutive fetch failure count
const _systemLog  = { lastStatus: "LIVE", degradedAt: null };

function computeSystemStatus(assets, ids) {
  const errorCount    = ids.filter(id => assets[id]?.isFallback).length;
  const totalTracked  = ids.length;

  let status;
  if (errorCount === 0)                       status = "LIVE";
  else if (errorCount < totalTracked * 0.5)   status = "DEGRADED";   // <50% fallback
  else                                         status = "OFFLINE";    // ≥50% fallback

  // Log transition into degraded/offline — only once per change
  if (status !== "LIVE" && _systemLog.lastStatus === "LIVE") {
    _systemLog.degradedAt = new Date().toISOString();
    console.warn(`[SYSTEM] Status changed: LIVE → ${status} at ${_systemLog.degradedAt} | ${errorCount}/${totalTracked} assets on fallback`);
  } else if (status === "LIVE" && _systemLog.lastStatus !== "LIVE") {
    console.log(`[SYSTEM] Recovered: ${_systemLog.lastStatus} → LIVE after ${Math.round((Date.now() - new Date(_systemLog.degradedAt).getTime()) / 1000)}s`);
    _systemLog.degradedAt = null;
  }

  _systemLog.lastStatus = status;
  return { status, errorCount, totalTracked, degradedAt: _systemLog.degradedAt };
}
const FALLBACK = {
  BTC:  { symbol:"BTC",  price:84320,  change:0,     percentChange:0,     marketState:"REGULAR", prevClose:84320,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  ETH:  { symbol:"ETH",  price:1580,   change:0,     percentChange:0,     marketState:"REGULAR", prevClose:1580,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  VIX:  { symbol:"VIX",  price:17.04,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:17.04,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  SPY:  { symbol:"SPY",  price:679.46, change:-0.30, percentChange:-0.07, marketState:"CLOSED",  prevClose:679.91, source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  QQQ:  { symbol:"QQQ",  price:578.32, change:-0.70, percentChange:-0.12, marketState:"CLOSED",  prevClose:578.50, source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  WTI:  { symbol:"WTI",  price:96.57,  change:-1.30, percentChange:-1.33, marketState:"CLOSED",  prevClose:97.87,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  TNX:  { symbol:"TNX",  price:4.34,   change:-0.04, percentChange:-0.09, marketState:"CLOSED",  prevClose:4.38,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  DXY:  { symbol:"DXY",  price:98.87,  change:-0.15, percentChange:-0.15, marketState:"CLOSED",  prevClose:99.02,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  GOLD: { symbol:"GOLD", price:3230,   change:5.00,  percentChange:0.16,  marketState:"CLOSED",  prevClose:3225,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
};

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const fetchedAt  = new Date().toISOString();
  const marketOpen = isMarketOpen();
  const skipVIX    = !marketOpen;
  const rateLimits = getRateLimitStatus();

  console.log(`[/api/prices] ${fetchedAt} | market=${marketOpen ? "OPEN" : "CLOSED"} | finnhub=${rateLimits.finnhub.calls}/${rateLimits.finnhub.limit} | fmp=${rateLimits.fmp.calls}/${rateLimits.fmp.limit}`);

  const ids    = ["BTC", "ETH", "SPY", "QQQ", "WTI", "GOLD", "TNX", "DXY", "VIX"];
  const assets = {};

  // ── Step 1: Serve from cache where fresh ─────────────────────────
  const staleIds = [];
  for (const id of ids) {
    if (id === "VIX" && skipVIX) {
      const saved = _lastValid.VIX ?? FALLBACK.VIX;
      assets.VIX  = { ...saved, cached: true, status: "stale", statusReason: "market_closed" };
      continue;
    }
    if (isCacheFresh(id)) {
      assets[id] = { ...getCacheEntry(id), cached: true };
      console.log(`[CACHE HIT] ${id} | age=${Math.round((Date.now() - _cache[id].fetchedAt) / 1000)}s | confidence=${assets[id].confidence}`);
    } else {
      staleIds.push(id);
    }
  }

  // ── Step 2: Throttle LOW-priority if near rate limit ─────────────
  const throttledIds = [];
  if (rateLimits.finnhub.calls >= rateLimits.finnhub.limit || rateLimits.fmp.calls >= rateLimits.fmp.limit) {
    staleIds
      .filter(id => ASSET_TIER[id] === TIERS.LOW)
      .forEach(id => {
        const saved = _lastValid[id] ?? getCacheEntry(id) ?? FALLBACK[id];
        assets[id]  = { ...saved, cached: true, status: "stale", statusReason: "rate_limited", confidence: "low" };
        throttledIds.push(id);
        console.warn(`[THROTTLE] ${id} — rate limit reached, serving cached`);
      });
  }

  const fetchIds = staleIds.filter(id => !throttledIds.includes(id));

  // ── Step 3: Fetch stale assets in parallel ────────────────────────
  await Promise.all(
    fetchIds.map(id => {
      const chain = getFetchChain(id);
      if (!chain) return Promise.resolve();

      return getAssetWithFallback(id, chain)
        .then(result => {
          _lastValid[id]  = result;
          _failCounts[id] = 0;   // reset on success
          setCacheEntry(id, result);
          assets[id] = { ...result, status: "valid", cached: false, isFallback: false };
          console.log(`[RESULT] ${id}: $${result.price} (${result.percentChange}%) src=${result.source} confidence=${result.confidence}`);
        })
        .catch(e => {
          _failCounts[id] = (_failCounts[id] ?? 0) + 1;
          console.error(`[FAIL] ${id} (fail #${_failCounts[id]}): ${e.message}`);
          const saved = _lastValid[id] ?? FALLBACK[id];
          assets[id]  = {
            ...saved,
            status:       "error",
            statusReason: "all_sources_failed",
            confidence:   "low",
            cached:       false,
            isFallback:   true,   // both Finnhub and FMP failed — serving last known
          };
        });
    })
  );

  // ── Step 4: Fill gaps ─────────────────────────────────────────────
  for (const id of ids) {
    if (!assets[id]) {
      const saved = _lastValid[id] ?? FALLBACK[id];
      const isHardFallback = !_lastValid[id]; // true if using hardcoded constant
      assets[id] = {
        ...saved,
        cached:       true,
        status:       "stale",
        statusReason: "no_data",
        confidence:   "low",
        isFallback:   isHardFallback,
      };
    }
  }

  const systemStatus = computeSystemStatus(assets, ids);

  // Annotate each asset with dataAge (ms since fetch) and stale flag.
  // Frontend uses this for STALE badges without needing its own clock math.
  const STALE_THRESHOLD_MS = 60 * 1000;
  const now = Date.now();
  for (const id of ids) {
    if (!assets[id]) continue;
    const ts = assets[id].timestamp ? new Date(assets[id].timestamp).getTime() : 0;
    const dataAge = ts > 0 ? now - ts : null;
    assets[id].dataAge = dataAge;
    assets[id].stale   = dataAge !== null && dataAge > STALE_THRESHOLD_MS;
  }

  res.status(200).json({
    fetchedAt,
    marketOpen,
    rateLimits,
    systemStatus,
    staleThresholdMs: STALE_THRESHOLD_MS,
    cacheHits:    ids.filter(id => assets[id]?.cached).length,
    freshFetches: fetchIds.length,
    assets,
  });
}