// api/stocks.js — Vercel Serverless Function
// Fetches individual stock + BDC prices server-side via Finnhub → Yahoo fallback.
// Replaces the broken corsproxy.io client-side fetches for:
//   SOFI, PLTR, ZETA (Stock Momentum panel)
//   ARCC, OBDC, FSKKR, GBDC, PCMM (BDC / Private Credit panel)
//   BMNR, BMNU, BMNG (Leveraged assets panel)
//
// Call: GET /api/stocks?symbols=PLTR,SOFI,ARCC
// Returns: { fetchedAt, marketOpen, stocks: { PLTR: { price, change, percentChange, prevClose, source, confidence, marketState, timestamp } } }

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FMP_KEY     = process.env.FMP_API_KEY     || "";

// ─── Rate limiter (per Vercel function invocation — module-level) ─
const _rateLimiter = {
  finnhub: { calls: [], limit: 55 },
  fmp:     { calls: [], limit: 8  },
};

function recordCall(source) {
  const tracker = _rateLimiter[source];
  if (!tracker) return;
  const now = Date.now();
  tracker.calls = tracker.calls.filter(t => now - t < 60_000);
  tracker.calls.push(now);
}

function isNearLimit(source) {
  const tracker = _rateLimiter[source];
  if (!tracker) return false;
  const now    = Date.now();
  const recent = tracker.calls.filter(t => now - t < 60_000).length;
  return recent >= tracker.limit;
}

// ─── Market hours (NYSE/NASDAQ) ───────────────────────────────────
function isMarketOpen() {
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// ─── Simple server-side cache (warm Vercel invocations) ──────────
const _cache     = {};
const _lastValid = {};
const CACHE_TTL  = isMarketOpen() ? 15_000 : 120_000;  // 15s open, 2min closed

function isCacheFresh(symbol) {
  const entry = _cache[symbol];
  return entry && (Date.now() - entry.fetchedAt < CACHE_TTL);
}

// ─── Validate price sanity ────────────────────────────────────────
function validate(symbol, price, percentChange) {
  if (!price || price <= 0) return { valid: false, reason: "zero_price" };
  // BDC/stock threshold: 20% intraday move is extreme — reject and use lastValid
  if (Math.abs(percentChange) > 20) return { valid: false, reason: `extreme_move_${percentChange.toFixed(1)}pct` };
  return { valid: true };
}

// ─── Finnhub quote ─────────────────────────────────────────────────
async function fetchFinnhub(symbol) {
  if (!FINNHUB_KEY)           throw new Error("No Finnhub key");
  if (isNearLimit("finnhub")) throw new Error("Finnhub rate limit");

  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);

  const d = await res.json();
  if (!d.c || d.c === 0) throw new Error(`Finnhub zero price`);

  recordCall("finnhub");

  const price         = parseFloat(d.c.toFixed(2));
  const percentChange = parseFloat((d.dp ?? 0).toFixed(2));
  const v = validate(symbol, price, percentChange);
  if (!v.valid) throw new Error(`Finnhub validation failed: ${v.reason}`);

  return {
    price,
    percentChange,
    change:      parseFloat((d.d  ?? 0).toFixed(2)),
    prevClose:   parseFloat((d.pc ?? d.c).toFixed(2)),
    marketState: isMarketOpen() ? "REGULAR" : "CLOSED",
    source:      "Finnhub",
    confidence:  "high",
    timestamp:   new Date().toISOString(),
  };
}

// ─── Yahoo Finance (server-side, no CORS proxy needed) ────────────
async function fetchYahoo(symbol) {
  // Yahoo Chart API — works server-side without CORS proxy
  const yahooSymbol = symbol.replace(".", "-");  // BRK.B → BRK-B
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=2d`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("Yahoo no meta");

  const price         = parseFloat((meta.regularMarketPrice ?? 0).toFixed(2));
  const percentChange = parseFloat((meta.regularMarketChangePercent ?? 0).toFixed(2));
  const prevClose     = parseFloat((meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0).toFixed(2));
  if (!price || price === 0) throw new Error("Yahoo zero price");

  const v = validate(symbol, price, percentChange);
  if (!v.valid) throw new Error(`Yahoo validation failed: ${v.reason}`);

  return {
    price,
    percentChange,
    change:      parseFloat((price - prevClose).toFixed(2)),
    prevClose,
    marketState: meta.marketState ?? "CLOSED",
    source:      "Yahoo",
    confidence:  "medium",
    timestamp:   new Date().toISOString(),
  };
}

// ─── Yahoo History (3mo daily — for MA20/MA50 computation) ───────
async function fetchYahooHistory(symbol) {
  const yahooSymbol = symbol.replace(".", "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=3mo`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo history HTTP ${res.status}`);

  const data   = await res.json();
  const result = data?.chart?.result?.[0];
  const meta   = result?.meta;
  const quotes = result?.indicators?.quote?.[0];
  if (!meta || !quotes) throw new Error("Yahoo history no data");

  const closes  = (quotes.close  ?? []).filter(c => c != null);
  const volumes = (quotes.volume ?? []).filter(v => v != null);
  if (closes.length < 20) throw new Error("insufficient history");

  const price    = parseFloat((meta.regularMarketPrice ?? closes.at(-1)).toFixed(2));
  const pct      = parseFloat((meta.regularMarketChangePercent ?? 0).toFixed(2));
  const prevClose= parseFloat((meta.chartPreviousClose ?? price).toFixed(2));

  // SMA helper
  const sma = (arr, n) => {
    const sl = arr.slice(-n);
    return sl.length < n ? null : parseFloat((sl.reduce((a, b) => a + b, 0) / n).toFixed(2));
  };

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);

  const avgVol20    = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const todayVol    = volumes.at(-1) ?? 0;
  const volumeRatio = avgVol20 > 0 ? todayVol / avgVol20 : 1;

  if (!price || price === 0) throw new Error("Yahoo history zero price");

  return {
    price,
    percentChange: pct,
    change:        parseFloat((price - prevClose).toFixed(2)),
    prevClose,
    ma20, ma50, volumeRatio,
    closes,       // raw closes for client sparkline if needed
    marketState:  meta.marketState ?? "CLOSED",
    source:       "Yahoo",
    confidence:   "medium",
    timestamp:    new Date().toISOString(),
  };
}

// ─── Fetch one symbol with fallback chain ─────────────────────────
async function fetchSymbol(symbol) {
  // Cache hit
  if (isCacheFresh(symbol)) {
    console.log(`[stocks] CACHE HIT ${symbol}`);
    return { ..._cache[symbol].data, cached: true };
  }

  // Finnhub → Yahoo fallback
  const chain = [
    { name: "Finnhub", fn: () => fetchFinnhub(symbol) },
    { name: "Yahoo",   fn: () => fetchYahoo(symbol)   },
  ];

  for (const { name, fn } of chain) {
    try {
      const result = await fn();
      _cache[symbol]     = { data: result, fetchedAt: Date.now() };
      _lastValid[symbol] = result;
      console.log(`[stocks] ${symbol} via ${name}: $${result.price} (${result.percentChange}%)`);
      return { ...result, cached: false };
    } catch (e) {
      console.warn(`[stocks] ${symbol} ${name} failed: ${e.message}`);
    }
  }

  // All sources failed — serve last valid or null
  if (_lastValid[symbol]) {
    console.warn(`[stocks] ${symbol} ALL FAILED — serving last valid`);
    return { ..._lastValid[symbol], source: "lastValid", confidence: "low", cached: true, isFallback: true };
  }

  return null;
}

// ─── Fetch history for one symbol (MA20/MA50 mode) ──────────────
async function fetchSymbolHistory(symbol) {
  const cacheKey = `${symbol}__history`;
  const HISTORY_TTL = 5 * 60_000;  // 5min — history data changes slowly
  const entry = _cache[cacheKey];
  if (entry && (Date.now() - entry.fetchedAt < HISTORY_TTL)) {
    return { ..._cache[cacheKey].data, cached: true };
  }

  try {
    const result = await fetchYahooHistory(symbol);
    _cache[cacheKey]    = { data: result, fetchedAt: Date.now() };
    _lastValid[cacheKey] = result;
    return { ...result, cached: false };
  } catch (e) {
    console.warn(`[stocks history] ${symbol} Yahoo failed: ${e.message}`);
  }

  if (_lastValid[cacheKey]) {
    return { ..._lastValid[cacheKey], source: "lastValid", confidence: "low", isFallback: true };
  }

  return null;
}

// ─── Handler ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const rawSymbols = req.query.symbols || "";
  if (!rawSymbols) {
    return res.status(400).json({ error: "symbols param required. Example: /api/stocks?symbols=PLTR,SOFI,ARCC" });
  }

  // history=true → return MA20/MA50 + price for each symbol
  const historyMode = req.query.history === "true";

  // Parse + deduplicate symbol list (max 20 to prevent abuse)
  const symbols = [...new Set(
    rawSymbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
  )].slice(0, 20);

  const fetchedAt  = new Date().toISOString();
  const marketOpen = isMarketOpen();

  // Fetch all symbols in parallel
  const results = await Promise.all(
    symbols.map(async sym => {
      const data = historyMode
        ? await fetchSymbolHistory(sym)
        : await fetchSymbol(sym);
      return [sym, data];
    })
  );

  const stocks = Object.fromEntries(results.filter(([, d]) => d !== null));

  console.log(`[/api/stocks] ${fetchedAt} | mode=${historyMode ? "history" : "quote"} | symbols=${symbols.join(",")} | market=${marketOpen ? "OPEN" : "CLOSED"} | fetched=${Object.keys(stocks).length}`);

  res.status(200).json({ fetchedAt, marketOpen, stocks });
}