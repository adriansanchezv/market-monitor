// api/prices.js — Vercel Serverless Function
// Data quality + source prioritization system
// Architecture: cache-first → scored source chain → confidence rating → fallback

// ─── Environment ──────────────────────────────────────────────────
const FINNHUB_KEY    = process.env.FINNHUB_API_KEY    || "";
const FMP_KEY        = process.env.FMP_API_KEY        || "";
const MARKETSTACK_KEY = process.env.MARKETSTACK_API_KEY || "7quxwtveJwSF2UW92xaNFwoxNTJl9BL8";

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
  Marketstack: {
    priority:      3,         // EOD fallback — no real-time, but reliable daily close
    reliability:   "medium",  // Data from Tiingo via Marketstack
    maxAgeMs:      12 * 60 * 60 * 1000, // 12h — EOD data, not real-time
    maxDeviationPct: 15,
    // NOTE: returns EOD close prices only, not intraday. Used when Finnhub+FMP fail.
    // Rate limit: 5 req/sec. Free tier: 100/mo. Use sparingly.
  },
  Yahoo: {
    priority:      4,
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
  BTC:  TIERS.HIGH,
  ETH:  TIERS.HIGH,
  SPY:  TIERS.HIGH,
  QQQ:  TIERS.HIGH,
  VIX:  TIERS.HIGH,
  // Momentum stocks — LOW tier (60s TTL), only fetched during market hours
  PLTR: TIERS.LOW,
  SOFI: TIERS.LOW,
  ZETA: TIERS.LOW,
  // BDCs — LOW tier, daily prices
  ARCC: TIERS.LOW,
  OBDC: TIERS.LOW,
  FSKKR:TIERS.LOW,
  GBDC: TIERS.LOW,
  PCMM: TIERS.LOW,
  WTI:  TIERS.MEDIUM,
  GOLD: TIERS.MEDIUM,
  TNX:  TIERS.LOW,
  DXY:  TIERS.LOW,
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
  finnhub:     { calls: [], limit: 55 },  // 55/min (hard limit: 60)
  fmp:         { calls: [], limit: 8  },  // 8/min on free tier
  marketstack: { calls: [], limit: 4  },  // 5 req/sec max, we self-limit to 4/min conservatively
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
    finnhub:     { calls: _rateLimiter.finnhub.calls.filter(t => now - t < 60 * 1000).length,     limit: _rateLimiter.finnhub.limit     },
    fmp:         { calls: _rateLimiter.fmp.calls.filter(t => now - t < 60 * 1000).length,         limit: _rateLimiter.fmp.limit         },
    marketstack: { calls: _rateLimiter.marketstack.calls.filter(t => now - t < 60 * 1000).length, limit: _rateLimiter.marketstack.limit },
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
// percentChange is always a % relative to the period baseline:
//   Crypto (Binance): rolling 24h from openPrice
//   Equities/Futures (Finnhub/FMP/Yahoo): vs previous close (TODAY)
// The `change` field here is the dollar amount — UI should use percentChange for display.
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

async function fetchFromMarketstack(symbol) {
  if (!MARKETSTACK_KEY)        throw new Error("No Marketstack key");
  if (isNearLimit("marketstack")) throw new Error("Marketstack rate limit — throttling");

  // Marketstack v2 EOD — returns last 2 trading days so we can compute % change
  // Fields: open, high, low, close, volume, adj_close, symbol, date
  // No real-time price — use adj_close as current price (EOD only)
  const res = await fetch(
    `https://api.marketstack.com/v2/eod?access_key=${MARKETSTACK_KEY}&symbols=${encodeURIComponent(symbol)}&limit=2`,
    { headers: { "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`Marketstack HTTP ${res.status} for ${symbol}`);

  const data = await res.json();
  if (data.error) throw new Error(`Marketstack error: ${data.error.message}`);

  const records = data.data;
  if (!Array.isArray(records) || records.length === 0)
    throw new Error(`Marketstack empty for ${symbol}`);

  const today     = records[0];   // most recent EOD (sorted DESC by default)
  const yesterday = records[1];   // previous trading day

  const price     = parseFloat(parseFloat(today.adj_close ?? today.close).toFixed(2));
  if (!price || price === 0) throw new Error(`Marketstack zero price for ${symbol}`);

  const prevClose = yesterday
    ? parseFloat(parseFloat(yesterday.adj_close ?? yesterday.close).toFixed(2))
    : price;

  // Compute % change from previous close — Marketstack doesn't provide it directly
  const dollarChange  = parseFloat((price - prevClose).toFixed(2));
  const percentChange = prevClose > 0
    ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
    : 0;

  recordCall("marketstack");
  console.log(`[Marketstack] ${symbol} | close=${price} | prevClose=${prevClose} | ${percentChange}% | date=${today.date}`);

  // Marketstack EOD date — use end-of-day timestamp (not current time)
  // This correctly signals to scoreAndValidate that this is EOD data
  const eodTimestamp = new Date(today.date).toISOString();

  return {
    price,
    percentChange,
    change:        dollarChange,
    prevClose,
    marketState:   "CLOSED",   // EOD data — market was closed when this was recorded
    _source:       "Marketstack",
    timestamp:     eodTimestamp,
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
// SPARKLINES — fetch real historical closes for equity/macro assets
// Called via ?sparklines=true&tf=1H|4H|24H
// Returns { SPY: [{v, t}, ...], QQQ: [...], ... }
// Uses Yahoo Chart API — works server-side (no CORS issues).
// ─────────────────────────────────────────────────────────────────

// Maps our asset IDs to Yahoo symbols for sparkline fetching
const SPARKLINE_SYMBOLS = {
  SPY:  "SPY",
  QQQ:  "QQQ",
  VIX:  "%5EVIX",
  WTI:  "CL%3DF",
  GOLD: "GC%3DF",
  DXY:  "DX-Y.NYB",
  TNX:  "%5ETNX",
};

// Timeframe → Yahoo interval + range
const SPARKLINE_TIMEFRAMES = {
  "1H":  { interval: "5m",  range: "1d"  },  // 5-min candles, today  (~12 points during session)
  "4H":  { interval: "15m", range: "1d"  },  // 15-min candles, today (~16 points)
  "24H": { interval: "1h",  range: "2d"  },  // 1-hour candles, 2 days (~26 points)
};

// Per-timeframe server-side cache
const _sparklinesCache = {};
const _sparklinesFetchedAt = {};

async function fetchEquitySparklines(tf = "24H") {
  const cfg     = SPARKLINE_TIMEFRAMES[tf] ?? SPARKLINE_TIMEFRAMES["24H"];
  const cacheAge = Date.now() - (_sparklinesFetchedAt[tf] ?? 0);
  const TTL     = isMarketOpen() ? 5 * 60_000 : 30 * 60_000;

  if (cacheAge < TTL && _sparklinesCache[tf] && Object.keys(_sparklinesCache[tf]).length > 0) {
    console.log(`[sparklines] CACHE HIT tf=${tf}`);
    return _sparklinesCache[tf];
  }

  const results = {};

  await Promise.all(Object.entries(SPARKLINE_SYMBOLS).map(async ([id, yahooSym]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${cfg.interval}&range=${cfg.range}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept":     "application/json",
        },
      });
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const data       = await res.json();
      const result     = data?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes     = result?.indicators?.quote?.[0]?.close ?? [];

      if (closes.length < 3) throw new Error("insufficient candles");

      const candles = closes
        .map((c, i) => ({ v: c, t: timestamps[i] ? timestamps[i] * 1000 : i }))
        .filter(c => c.v != null && c.v > 0);

      if (candles.length < 3) throw new Error("too many nulls");

      results[id] = candles;
      console.log(`[sparklines] ${id} tf=${tf}: ${candles.length} candles`);
    } catch (e) {
      console.warn(`[sparklines] ${id} tf=${tf} failed: ${e.message}`);
    }
  }));

  _sparklinesCache[tf]       = results;
  _sparklinesFetchedAt[tf]   = Date.now();

  return results;
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
      { name: "Finnhub",     fn: () => fetchFromFinnhub("SPY")            },
      { name: "FMP",         fn: () => fetchFromFMP("SPY")                },
      { name: "Marketstack", fn: () => fetchFromMarketstack("SPY")        },
      { name: "Yahoo",       fn: () => fetchFromYahoo("SPY")              },
    ],
    QQQ: [
      { name: "Finnhub",     fn: () => fetchFromFinnhub("QQQ")            },
      { name: "FMP",         fn: () => fetchFromFMP("QQQ")                },
      { name: "Marketstack", fn: () => fetchFromMarketstack("QQQ")        },
      { name: "Yahoo",       fn: () => fetchFromYahoo("QQQ")              },
    ],
    WTI: [
      // NYMEX:CL1! is Finnhub's front-month crude futures
      { name: "Finnhub",     fn: () => fetchFromFinnhub("NYMEX:CL1!")         },
      { name: "Yahoo",       fn: () => fetchFromYahoo("CL=F")                 },
      { name: "FMP",         fn: () => fetchFromFMP("USOIL")                  },
      { name: "Marketstack", fn: () => fetchFromMarketstack("USOIL")          },
    ],
    TNX: [
      { name: "Finnhub",     fn: () => fetchFromFinnhub("US10Y")          },
      { name: "Yahoo",       fn: () => fetchFromYahoo("^TNX")             },
    ],
    DXY: [
      { name: "Finnhub",     fn: () => fetchFromFinnhub("DXY")            },
      { name: "Yahoo",       fn: () => fetchFromYahoo("DX-Y.NYB")         },
    ],
    VIX: [
      { name: "FMP",         fn: () => fetchFromFMP("^VIX")               },
      { name: "Finnhub",     fn: () => fetchFromFinnhub("CBOE:VIX")       },
    ],
    GOLD: [
      // XAUUSD=X is Yahoo's spot gold — accurate, no futures roll issues
      { name: "Finnhub",     fn: () => fetchFromFinnhub("OANDA:XAU_USD")      },
      { name: "Yahoo",       fn: () => fetchFromYahoo("XAUUSD=X")             },
      { name: "FMP",         fn: () => fetchFromFMP("GCUSD")                  },
      { name: "Marketstack", fn: () => fetchFromMarketstack("XAUUSD")         },
    ],
    // ── Momentum stocks ─────────────────────────────────────────────
    PLTR:  [{ name: "Yahoo", fn: () => fetchFromYahoo("PLTR")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("PLTR")  }],
    SOFI:  [{ name: "Yahoo", fn: () => fetchFromYahoo("SOFI")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("SOFI")  }],
    ZETA:  [{ name: "Yahoo", fn: () => fetchFromYahoo("ZETA")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("ZETA")  }],
    // ── BDC tickers ──────────────────────────────────────────────────
    ARCC:  [{ name: "Yahoo", fn: () => fetchFromYahoo("ARCC")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("ARCC")  }],
    OBDC:  [{ name: "Yahoo", fn: () => fetchFromYahoo("OBDC")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("OBDC")  }],
    FSKKR: [{ name: "Yahoo", fn: () => fetchFromYahoo("FSK")   }, { name: "Finnhub", fn: () => fetchFromFinnhub("FSK")   }],
    GBDC:  [{ name: "Yahoo", fn: () => fetchFromYahoo("GBDC")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("GBDC")  }],
    PCMM:  [{ name: "Yahoo", fn: () => fetchFromYahoo("PCMM")  }, { name: "Finnhub", fn: () => fetchFromFinnhub("PCMM")  }],
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
  BTC:   { symbol:"BTC",  price:84320,  change:0,     percentChange:0,     marketState:"REGULAR", prevClose:84320,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  ETH:   { symbol:"ETH",  price:1580,   change:0,     percentChange:0,     marketState:"REGULAR", prevClose:1580,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  VIX:   { symbol:"VIX",  price:17.04,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:17.04,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  SPY:   { symbol:"SPY",  price:679.46, change:-0.30, percentChange:-0.07, marketState:"CLOSED",  prevClose:679.91, source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  QQQ:   { symbol:"QQQ",  price:578.32, change:-0.70, percentChange:-0.12, marketState:"CLOSED",  prevClose:578.50, source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  WTI:   { symbol:"WTI",  price:96.57,  change:-1.30, percentChange:-1.33, marketState:"CLOSED",  prevClose:97.87,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  TNX:   { symbol:"TNX",  price:4.34,   change:-0.04, percentChange:-0.09, marketState:"CLOSED",  prevClose:4.38,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  DXY:   { symbol:"DXY",  price:98.87,  change:-0.15, percentChange:-0.15, marketState:"CLOSED",  prevClose:99.02,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  GOLD:  { symbol:"GOLD", price:3230,   change:5.00,  percentChange:0.16,  marketState:"CLOSED",  prevClose:3225,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  // Momentum stocks — fallback to rough last-known prices
  PLTR:  { symbol:"PLTR", price:25.00,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:25.00,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  SOFI:  { symbol:"SOFI", price:9.00,   change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:9.00,   source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  ZETA:  { symbol:"ZETA", price:20.00,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:20.00,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  // BDC fallbacks
  ARCC:  { symbol:"ARCC", price:21.34,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:21.34,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  OBDC:  { symbol:"OBDC", price:15.62,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:15.62,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  FSKKR: { symbol:"FSKKR",price:19.88,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:19.88,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  GBDC:  { symbol:"GBDC", price:14.44,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:14.44,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
  PCMM:  { symbol:"PCMM", price:24.91,  change:0,     percentChange:0,     marketState:"CLOSED",  prevClose:24.91,  source:"fallback", timestamp:null, status:"error", confidence:"low", cached:false },
};

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  // ── Sparklines mode: ?sparklines=true ──────────────────────────
  // Returns { SPY: [{v, t},...], QQQ: [...], VIX: [...], ... }
  // Called once on page init to seed equity sparklines with real data.
  if (req.query.sparklines === "true") {
    try {
      const tf   = req.query.tf ?? "24H";
      const data = await fetchEquitySparklines(tf);
      console.log(`[/api/prices?sparklines] tf=${tf} fetched ${Object.keys(data).length} assets`);
      return res.status(200).json({ fetchedAt: new Date().toISOString(), tf, sparklines: data });
    } catch (e) {
      console.error("[sparklines handler]", e.message);
      return res.status(500).json({ error: e.message, sparklines: {} });
    }
  }

  // ── Crypto klines proxy: ?crypto=true&tf=1H|4H|24H ─────────────
  // Fetches BTC+ETH klines + 24hr baselines from Binance server-side.
  // Needed because Binance blocks direct browser requests from Vercel domain.
  if (req.query.crypto === "true") {
    try {
      const tf  = req.query.tf ?? "24H";
      const TF_TO_BINANCE = {
        "1H":  { interval: "5m",  limit: 12 },
        "4H":  { interval: "15m", limit: 16 },
        "24H": { interval: "1h",  limit: 24 },
      };
      const cfg = TF_TO_BINANCE[tf] ?? TF_TO_BINANCE["24H"];

      const fetchBinanceKlines = async (symbol) => {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${cfg.interval}&limit=${cfg.limit}`);
        if (!r.ok) throw new Error(`Binance klines ${r.status}`);
        const d = await r.json();
        return d.map(c => ({ v: parseFloat(parseFloat(c[4]).toFixed(2)), t: c[0] }));
      };

      const fetchBinanceBaseline = async (symbol) => {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        if (!r.ok) throw new Error(`Binance ticker ${r.status}`);
        const d = await r.json();
        return {
          price:         parseFloat(parseFloat(d.lastPrice).toFixed(2)),
          openPrice:     parseFloat(parseFloat(d.openPrice).toFixed(2)),
          percentChange: parseFloat(parseFloat(d.priceChangePercent).toFixed(2)),
          prevClose:     parseFloat(parseFloat(d.prevClosePrice).toFixed(2)),
          change:        parseFloat(parseFloat(d.priceChangePercent).toFixed(2)),
          source: "Binance", confidence: "high",
        };
      };

      const [btcKlines, ethKlines, btcBase, ethBase] = await Promise.all([
        fetchBinanceKlines("BTCUSDT"),
        fetchBinanceKlines("ETHUSDT"),
        fetchBinanceBaseline("BTCUSDT"),
        fetchBinanceBaseline("ETHUSDT"),
      ]);

      return res.status(200).json({
        fetchedAt: new Date().toISOString(), tf,
        BTC: { baseline: btcBase, klines: btcKlines },
        ETH: { baseline: ethBase, klines: ethKlines },
      });
    } catch (e) {
      console.error("[crypto handler]", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  const fetchedAt  = new Date().toISOString();
  const marketOpen = isMarketOpen();
  const skipVIX    = !marketOpen;
  const rateLimits = getRateLimitStatus();

  console.log(`[/api/prices] ${fetchedAt} | market=${marketOpen ? "OPEN" : "CLOSED"} | finnhub=${rateLimits.finnhub.calls}/${rateLimits.finnhub.limit} | fmp=${rateLimits.fmp.calls}/${rateLimits.fmp.limit} | marketstack=${rateLimits.marketstack.calls}/${rateLimits.marketstack.limit}`);

  // Core market assets + momentum stocks + BDCs — all go through same cache/fallback system
  const ids    = ["BTC", "ETH", "SPY", "QQQ", "WTI", "GOLD", "TNX", "DXY", "VIX",
                  "PLTR", "SOFI", "ZETA", "ARCC", "OBDC", "FSKKR", "GBDC", "PCMM"];
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