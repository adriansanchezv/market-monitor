// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET MONITOR — API Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Fill in your keys below. Leave a field as "" to fall back to mock data.
// Never commit real keys to version control — use .env in production.
// ─────────────────────────────────────────────────────────────────────────────

export const API_KEYS = {
  // https://financialmodelingprep.com/developer/docs — free tier: 250 req/day
  FMP: "",

  // https://www.alphavantage.co/support/#api-key — free tier: 25 req/day
  ALPHA_VANTAGE: "",

  // https://twelvedata.com/pricing — free tier: 800 req/day
  TWELVE_DATA: "",

  // https://newsapi.org — free tier: 100 req/day (dev only, no CORS on prod)
  NEWS_API: "",

  // https://eia.gov/opendata — free, no key needed for basic endpoints
  EIA: "",

  // CoinGecko public API — no key required for basic endpoints
  COINGECKO: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// POLLING INTERVALS (ms)
// ─────────────────────────────────────────────────────────────────────────────
export const INTERVALS = {
  PRICES:    8000,   // stock + crypto prices
  NEWS:     60000,   // news feed
  SOCIAL:  120000,   // social feed (rate-limit sensitive)
  OIL:      15000,   // EIA / oil price
};

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE FLAGS — set false to force mock data for that source
// ─────────────────────────────────────────────────────────────────────────────
export const USE_REAL_API = {
  STOCKS:  false,   // FMP / TwelveData
  CRYPTO:  false,   // CoinGecko
  OIL:     false,   // EIA
  NEWS:    false,   // NewsAPI
  SOCIAL:  false,   // Twitter/X (manual wrapper required)
};
