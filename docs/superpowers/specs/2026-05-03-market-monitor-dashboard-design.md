# Market Monitor — Financial Research Dashboard
**Date:** 2026-05-03  
**Status:** Approved

---

## Overview

Expand the existing Market Monitor (React 19 + Vite) into a multi-dashboard financial research suite with a sidebar navigation shell. Seven new analytical dashboards are added alongside the refactored live monitor. All heavy computation runs in Vercel serverless functions. Historical data comes from Financial Modeling Prep (FMP), which is already integrated. Asset scope is any ticker via free-form input. Every dashboard is fully interactive — user sets parameters and runs on demand.

---

## Architecture

### Approach: React Router + shared MarketDataContext

The current `MarketMonitor.jsx` (275KB) entangles data logic with UI. This refactor separates them:

1. **MarketDataContext** — extract `_priceCache`, polling loops, WebSocket handlers, and alert logic out of `MarketMonitor.jsx` into a React context. All dashboards get shared live prices, regime state, and alerts for free.
2. **AppShell** — new root component wrapping `<RouterProvider>`. Renders `<Sidebar>` + `<Outlet>`.
3. **Routes** — each dashboard is a lazy-loaded route component. URL state enables bookmarking and deep-linking.
4. **Vercel functions** — heavy compute (simulations, backtests, risk math) runs server-side in `/api/`. Frontend sends parameters, receives results.

### File Structure

```
src/
  AppShell.jsx                  ← sidebar + <Outlet>
  context/
    MarketDataContext.jsx        ← extracted from MarketMonitor.jsx
  pages/
    LiveMonitor.jsx             ← refactored MarketMonitor.jsx (UI only)
    MonteCarlo.jsx
    RegimeDetection.jsx
    SensitivityAnalysis.jsx
    Backtester.jsx
    PortfolioRisk.jsx
    SentimentAnalysis.jsx
    CorrelationBreak.jsx
  components/
    Sidebar.jsx                 ← grouped nav links, active state
    TopBar.jsx                  ← live price strip across all dashboards
    shared/
      StatTile.jsx              ← reusable metric card
      HeatmapGrid.jsx           ← reusable correlation/sensitivity heatmap
      FanChart.jsx              ← percentile band chart (Monte Carlo)
  services/
    api/
      marketService.js          ← existing (prices, news, social)
      fmpHistoryService.js      ← new: FMP historical OHLCV
  hooks/
    useMarketData.js            ← existing
    useHistoricalData.js        ← new: fetches + caches FMP history

api/                            ← Vercel serverless functions
  history.js                   ← FMP historical data proxy (CORS + caching)
  monte-carlo.js               ← GBM simulation engine
  regime.js                    ← regime classification
  backtest.js                  ← multi-asset regime backtesting engine
  risk.js                      ← VaR / CVaR / beta / Sharpe
  correlation.js               ← rolling correlation + break detection
```

### New Dependencies

| Package | Purpose |
|---|---|
| `react-router-dom` | Client-side routing |

No additional math libraries needed — GBM and stats (mean, std, percentiles) are implemented in native JS inside the Vercel functions.

No other new dependencies. Recharts (already installed) handles all charts.

### Data Flow

```
FMP Historical API
      ↓
api/history.js (Vercel proxy — handles CORS, 5-min cache)
      ↓
useHistoricalData hook (fetches on ticker change, caches in memory)
      ↓
Dashboard component (passes to Vercel compute function or processes locally)
      ↓
api/monte-carlo.js | api/backtest.js | api/risk.js | api/correlation.js
      ↓
Dashboard renders results
```

Live price data continues flowing through `MarketDataContext` unchanged.

---

## Navigation

**Sidebar** — left-side, 180px wide, dark background (`#0d0d1a`). Three groups:

| Group | Items |
|---|---|
| Live | 📊 Live Monitor |
| Analysis | 🎲 Monte Carlo · 🔍 Regime · 🎚 Sensitivity · ⏮ Backtester |
| Risk & Signal | ⚠️ Portfolio Risk · 💬 Sentiment · 🔗 Correlation |

**TopBar** — fixed strip above every dashboard. Shows live prices for SPY, VIX, BTC pulled from `MarketDataContext`. Always visible regardless of active dashboard.

---

## Dashboards

### 1. Live Monitor (`/`)
Refactored `MarketMonitor.jsx` — UI extracted, data sourced from `MarketDataContext`. No functional changes to the existing live monitor behavior.

---

### 2. Monte Carlo Simulation (`/monte-carlo`)

**Purpose:** Project future price paths for any asset using Geometric Brownian Motion. Drift and volatility derived from FMP historical daily returns.

**User inputs:**
- Ticker (free-form, validated against FMP)
- Time horizon: 1M / 3M / 6M / 1Y / 2Y / 5Y
- Number of simulations: 1,000 / 10,000 / 100,000
- Initial portfolio value ($)

**Computation (api/monte-carlo.js):**
- Fetch 2Y daily OHLCV from FMP via `api/history.js`
- Compute annualized drift (μ) and volatility (σ) from log returns
- Run N GBM paths: `S(t+1) = S(t) * exp((μ - σ²/2)dt + σ√dt * Z)` where Z ~ N(0,1)
- Return percentile arrays: P5, P25, P50, P75, P95

**Output UI:**
- Fan chart (Recharts `AreaChart`) showing P5–P95 percentile bands over time
- 4 stat tiles: Median Return, VaR 95% (= P5), Probability of Profit, Max Drawdown (P95 worst path)

**Error handling:** FMP failure → show error state with retry. Simulation timeout (>10s) → reduce sim count suggestion.

---

### 3. Regime Detection (`/regime`)

**Purpose:** Classify current and historical market regimes for any ticker using rolling technical indicators.

**Regime classification (api/regime.js):**
Four regimes detected via rule cascade:
1. **Bull Trend** — price > 50d MA > 200d MA AND VIX < 20
2. **Bear Trend** — price < 50d MA < 200d MA AND VIX > 20
3. **High Volatility** — VIX > 25 (overrides MA signal)
4. **Risk-Off** — VIX > 30 OR price drops >5% in 5 days

**User inputs:**
- Ticker (free-form)
- Lookback window: 6M / 1Y / 2Y / 5Y

**Output UI:**
- Current regime badge (color-coded: green/red/orange/purple)
- Duration in current regime + avg annualized return for this regime type
- Price chart with regime color bands overlaid (Recharts `ComposedChart`)
- Regime history table: Regime | Start Date | Duration | Return

---

### 4. Sensitivity Analysis (`/sensitivity`)

**Purpose:** Sweep two parameters simultaneously to visualize how they affect a target metric. Reveals which parameters matter most and what combinations are dangerous.

**User inputs:**
- Asset (ticker)
- X-axis parameter: Volatility | Annual Drift | Market Correlation (vs SPY) | Time Horizon
- Y-axis parameter: (same options, different from X)
- Target metric: Expected Return | VaR | Probability of Profit | Sharpe Ratio
- Grid resolution: 5×5 / 8×8 / 10×10

**Computation (api/monte-carlo.js reused with parameter sweep):**
- Run Monte Carlo for each (X, Y) grid cell
- Return N×M matrix of target metric values

**Output UI:**
- Color heatmap grid (green = high/good, red = low/bad)
- Hover tooltip showing exact parameter values and metric
- Current real-world parameters highlighted with a border

---

### 5. Multi-Asset Regime Backtester (`/backtester`)

**Purpose:** Test a regime-switching allocation strategy against historical FMP data. User defines which assets to hold in each regime, backtest runs over a chosen period, results compared to a benchmark.

**User inputs:**
- Allocation table: one row per regime, columns for assets + weight %
  - Regimes: Bull / Bear / High-Vol / Risk-Off
  - Assets: free-form ticker input per cell, weights must sum to 100% per row
- Backtest period: 1Y / 3Y / 5Y / Custom date range
- Benchmark ticker (default: SPY)
- Rebalancing frequency: Daily / Weekly / Monthly

**Computation (api/backtest.js):**
- Fetch historical OHLCV for all tickers in the allocation table
- Run regime classifier day-by-day over the period
- On each day: look up current regime → apply that regime's allocation → compute daily P&L
- Apply rebalancing logic at specified frequency
- Return: daily equity curve, benchmark equity curve, drawdown series

**Output UI:**
- Allocation rules table (editable inline)
- Run Backtest button
- Equity curve chart (strategy vs benchmark, Recharts `LineChart`)
- 4 stat tiles: Total Return vs Benchmark | Sharpe Ratio vs Benchmark | Max Drawdown vs Benchmark | Calmar Ratio vs Benchmark

**Validation:** Weights per regime must sum to 100% before run is allowed. Unknown tickers validated against FMP before run.

---

### 6. Portfolio Risk Dashboard (`/risk`)

**Purpose:** Given a set of positions, compute standard risk metrics and show stress scenario impacts.

**User inputs:**
- Position table: Ticker | Weight % | Value $ (rows add/remove dynamically)
- Total portfolio value ($) — drives $ figures

**Computation (api/risk.js):**
- Fetch 1Y daily returns for each position ticker from FMP
- **VaR (Historical Simulation):** sort portfolio daily returns, take 5th percentile
- **CVaR:** average of returns below VaR threshold
- **Beta:** regress portfolio returns against SPY returns (OLS)
- **Sharpe:** (mean daily return × 252 − rf) / (std daily return × √252), rf = current 10Y yield
- **Correlation matrix:** pairwise Pearson correlations of daily returns
- **Stress scenarios:** apply fixed historical shock vectors to current weights

**Stress scenario shocks (hardcoded):**

| Scenario | SPY | QQQ | BTC | GLD | TLT |
|---|---|---|---|---|---|
| 2008 GFC | -56% | -54% | 0% (didn't exist) | +5% | +26% |
| COVID Crash | -34% | -28% | -50% | +1% | +20% |
| Rate Shock +2% | -15% | -20% | -30% | -5% | -20% |
| BTC -50% | -5% | -5% | -50% | +2% | +2% |

**Output UI:**
- Position table (editable)
- 4 stat tiles: 1-Day VaR (95%) | CVaR | Portfolio Beta | Sharpe (1Y)
- Correlation matrix heatmap
- Stress scenario table

---

### 7. Sentiment Analysis (`/sentiment`)

**Purpose:** Surface the existing NewsAPI + social feed sentiment scoring as a dedicated dashboard with trend tracking and category breakdown.

**Data sources:** Reuses `fetchNews()` and `fetchSocialFeed()` from `marketService.js`. No new API calls needed.

**Computation (client-side — lightweight):**
- Aggregate sentiment labels (bullish / bearish / risk-off / neutral) from last 24h of articles
- Score: bullish=+1, bearish=−1, risk-off=−0.5, neutral=0 → normalize to 0–100
- Track rolling 7-day score history (stored in `localStorage`)
- Group by category: Macro / Equities / Crypto / Commodities / Geopolitical

**Output UI:**
- Overall score gauge (0–100, color-coded: <40 bearish, 40–60 neutral, >60 bullish)
- 7-day rolling score sparkline
- Per-category horizontal bar chart with score
- Recent high-signal articles list with sentiment badge

---

### 8. Correlation Break Detector (`/correlation`)

**Purpose:** Monitor rolling correlations between asset pairs. Alert when a pair's current correlation deviates >2σ from its 1-year baseline.

**User inputs:**
- Asset list (multi-select or free-form, default: SPY QQQ BTC ETH GLD TLT)
- Rolling window: 30d / 60d / 90d
- Alert threshold: 1.5σ / 2σ / 2.5σ

**Computation (api/correlation.js):**
- Fetch 1Y+ daily returns for all selected assets from FMP
- Compute 1Y baseline correlation for each pair (Pearson)
- Compute rolling N-day correlation for each pair
- Compute z-score: (current − baseline) / rolling_std_of_correlation
- Flag pairs where |z-score| > threshold

**Output UI:**
- Break alert banner (red) listing flagged pairs with z-score and direction
- Correlation matrix heatmap (current values, red-bordered cells = breaks)
- Pair drill-down: click any cell → time-series chart of that pair's rolling correlation vs baseline

---

## Error Handling

- Every dashboard shows a loading skeleton while computation runs
- FMP API failure → error state with retry button; cached data used if available
- Vercel function timeout (default 10s) → user-facing "Computation timed out — try fewer assets or a shorter period"
- Invalid ticker → inline validation error before run is triggered
- Weights not summing to 100% (Backtester) → blocked Run button with inline message

---

## Testing

- Unit tests for each Vercel function (regime classifier, GBM engine, VaR math, correlation logic) using Vitest
- Integration tests: FMP proxy returns normalized shape for known tickers
- UI smoke tests: each route renders without crashing with mock data
- No end-to-end browser tests required at this stage

---

## Implementation Phases

Given scope, implementation is split into 3 phases:

**Phase 1 — Shell + Data Layer (foundation)**
- Install react-router-dom
- Extract `MarketDataContext` from `MarketMonitor.jsx`
- Build `AppShell`, `Sidebar`, `TopBar`
- Create `api/history.js` Vercel proxy
- Create `useHistoricalData` hook
- Refactor `LiveMonitor.jsx` to consume context

**Phase 2 — Analysis Dashboards**
- Monte Carlo (`/monte-carlo` + `api/monte-carlo.js`)
- Regime Detection (`/regime` + `api/regime.js`)
- Sensitivity Analysis (`/sensitivity` + reuse Monte Carlo API)
- Backtester (`/backtester` + `api/backtest.js`)

**Phase 3 — Risk & Signal Dashboards**
- Portfolio Risk (`/risk` + `api/risk.js`)
- Sentiment Analysis (`/sentiment`, client-side only)
- Correlation Break Detector (`/correlation` + `api/correlation.js`)
