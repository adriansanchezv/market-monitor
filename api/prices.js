// api/prices.js — Vercel Serverless Function
// Runs on Vercel's servers, no CORS issues
// Called by the frontend as /api/prices

const FMP_KEY = process.env.FMP_API_KEY || "";

// Fetch from Yahoo Finance directly (server-side, no CORS)
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
  return {
    price:       parseFloat((meta.regularMarketPrice ?? 0).toFixed(2)),
    change:      parseFloat((meta.regularMarketChangePercent ?? 0).toFixed(2)),
    marketState: meta.marketState ?? "CLOSED",
    prevClose:   parseFloat((meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0).toFixed(2)),
  };
}

// Fetch from Binance (server-side, no geo-block)
async function fetchBinance(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const d = await res.json();
  return {
    price:       parseFloat(parseFloat(d.lastPrice).toFixed(2)),
    change:      parseFloat(parseFloat(d.priceChangePercent).toFixed(2)),
    marketState: "REGULAR", // crypto is always live
    prevClose:   parseFloat(parseFloat(d.prevClosePrice).toFixed(2)),
  };
}

// Fetch VIX from FMP
async function fetchVIX() {
  if (!FMP_KEY) throw new Error("No FMP key");
  const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${FMP_KEY}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) throw new Error("VIX empty");
  const isOpen = isMarketOpen();
  return {
    price:       parseFloat((data[0].price ?? 0).toFixed(2)),
    change:      parseFloat((data[0].changePercentage ?? 0).toFixed(2)),
    marketState: isOpen ? "REGULAR" : "CLOSED",
    prevClose:   parseFloat((data[0].previousClose ?? data[0].price ?? 0).toFixed(2)),
  };
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

// Fallback prices — updated to current reality
const FALLBACK = {
  BTC: { price: 84320, change: 0, marketState: "REGULAR", prevClose: 84320 },
  ETH: { price: 1580,  change: 0, marketState: "REGULAR", prevClose: 1580  },
  VIX: { price: 17.04, change: 0, marketState: "CLOSED",  prevClose: 17.04 },
  SPY: { price: 679.46,change: -0.07, marketState: "CLOSED", prevClose: 679.91 },
  QQQ: { price: 578.32,change: -0.12, marketState: "CLOSED", prevClose: 578.50 },
  WTI: { price: 96.57, change: -1.33, marketState: "CLOSED", prevClose: 97.87 },
  TNX: { price: 4.34,  change: -0.09, marketState: "CLOSED", prevClose: 4.38  },
  DXY: { price: 98.87, change: -0.15, marketState: "CLOSED", prevClose: 99.02 },
};

export default async function handler(req, res) {
  // Allow CORS from your Vercel domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const results = { ...FALLBACK };

  // Fetch everything in parallel
  const tasks = [
    fetchBinance("BTCUSDT").then(r => { results.BTC = r; }).catch(e => console.error("BTC:", e.message)),
    fetchBinance("ETHUSDT").then(r => { results.ETH = r; }).catch(e => console.error("ETH:", e.message)),
    fetchYahoo("SPY").then(r   => { results.SPY = r; }).catch(e => console.error("SPY:", e.message)),
    fetchYahoo("QQQ").then(r   => { results.QQQ = r; }).catch(e => console.error("QQQ:", e.message)),
    fetchYahoo("CL=F").then(r  => { results.WTI = r; }).catch(e => console.error("WTI:", e.message)),
    fetchYahoo("^TNX").then(r  => { results.TNX = r; }).catch(e => console.error("TNX:", e.message)),
    fetchYahoo("DX-Y.NYB").then(r => { results.DXY = r; }).catch(e => console.error("DXY:", e.message)),
    fetchVIX().then(r          => { results.VIX = r; }).catch(e => console.error("VIX:", e.message)),
  ];

  await Promise.all(tasks);

  res.status(200).json(results);
}