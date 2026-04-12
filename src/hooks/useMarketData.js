// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET MONITOR — Hooks
// hooks/useMarketData.js   (also exports useAlerts, useNews, useSocialFeed)
//
// Designed for polling now, WebSocket-ready later.
// To add WS: replace the setInterval in useMarketData with a WS onmessage handler
// that calls the same setAssets updater.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  fetchAllPrices,
  fetchNews,
  fetchSocialFeed,
  generateSparkline,
  ASSET_META,
} from "../services/api/marketService.js";
import { INTERVALS } from "../config/apis.js";

// ─────────────────────────────────────────────
// ALERT THRESHOLDS — tune here
// ─────────────────────────────────────────────
export const ALERT_THRESHOLDS = {
  VIX_WARNING:             20,
  VIX_DANGER:              25,
  VIX_EXTREME:             30,
  OIL_MOVE_PCT:             3,
  CRYPTO_MOVE_PCT:          5,
  VOLUME_SPIKE_MULTIPLIER:  2.5,
};

// Per-alert-type cooldown in ms — prevents spam
const ALERT_COOLDOWNS = {
  VIX_EXTREME:  5 * 60 * 1000,  // 5 min
  VIX_DANGER:   5 * 60 * 1000,
  OIL_SPIKE:    3 * 60 * 1000,
  CRYPTO_MOVE:  2 * 60 * 1000,
};

// ─────────────────────────────────────────────
// SOUND — single shared AudioContext
// ─────────────────────────────────────────────
let _audioCtx = null;
const getAudioCtx = () => {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
};

const playBeep = (freq = 880, duration = 0.15, volume = 0.3) => {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {
    // AudioContext blocked before user gesture — silently skip
  }
};

export const ALERT_SOUNDS = {
  critical: () => { playBeep(440, 0.2, 0.4); setTimeout(() => playBeep(330, 0.3, 0.4), 250); },
  danger:   () => playBeep(660, 0.2, 0.3),
  warning:  () => playBeep(880, 0.12, 0.25),
  info:     () => playBeep(1100, 0.08, 0.2),
};

// ─────────────────────────────────────────────
// useMarketData
// ─────────────────────────────────────────────
export const useMarketData = () => {
  const [assets, setAssets] = useState(() =>
    ASSET_META.map(meta => ({
      ...meta,
      price: 0,
      change: 0,
      sparkline: generateSparkline(100, meta.vol),
      loading: true,
    }))
  );
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const fetchAndUpdate = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    try {
      const fresh = await fetchAllPrices();
      setAssets(prev =>
        fresh.map(asset => {
          const existing = prev.find(p => p.id === asset.id);
          const newSparkline = existing
            ? [...existing.sparkline.slice(1), { v: asset.price, t: Date.now() }]
            : generateSparkline(asset.price, asset.vol);
          return {
            ...asset,
            sparkline: newSparkline,
            loading: false,
            flash: existing
              ? asset.price > existing.price ? "up" : asset.price < existing.price ? "down" : null
              : null,
          };
        })
      );
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("[useMarketData]", e);
        setError(e.message);
      }
    }
  }, []);

  useEffect(() => {
    fetchAndUpdate(); // initial load
    const interval = setInterval(fetchAndUpdate, INTERVALS.PRICES);
    return () => {
      clearInterval(interval);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchAndUpdate]);

  // WebSocket hook point:
  // useEffect(() => {
  //   const ws = new WebSocket("wss://your-price-stream");
  //   ws.onmessage = (e) => {
  //     const { id, price, change } = JSON.parse(e.data);
  //     setAssets(prev => prev.map(a => a.id === id
  //       ? { ...a, price, change, sparkline: [...a.sparkline.slice(1), { v: price, t: Date.now() }], flash: price > a.price ? "up" : "down" }
  //       : a
  //     ));
  //   };
  //   return () => ws.close();
  // }, []);

  return { assets, lastUpdated, error };
};

// ─────────────────────────────────────────────
// useAlerts  — deduplication + cooldowns + sound
// ─────────────────────────────────────────────
export const useAlerts = (assets) => {
  const [alerts, setAlerts]           = useState([]);
  const [notifications, setNotifications] = useState([]);
  const prevAssetsRef   = useRef({});
  const cooldownsRef    = useRef({});  // { alertKey: lastFiredTimestamp }
  const seenKeysRef     = useRef(new Set()); // dedup within session

  const canFire = useCallback((key, cooldownMs) => {
    const now = Date.now();
    const last = cooldownsRef.current[key] ?? 0;
    if (now - last < cooldownMs) return false;
    cooldownsRef.current[key] = now;
    return true;
  }, []);

  useEffect(() => {
    const newAlerts = [];

    assets.forEach(asset => {
      const prev = prevAssetsRef.current[asset.id];
      if (!prev || asset.loading) {
        prevAssetsRef.current[asset.id] = asset;
        return;
      }

      // VIX EXTREME
      if (
        asset.id === "VIX" &&
        asset.price >= ALERT_THRESHOLDS.VIX_EXTREME &&
        prev.price < ALERT_THRESHOLDS.VIX_EXTREME
      ) {
        const key = `VIX_EXTREME_${Math.floor(asset.price / 5)}`;
        if (!seenKeysRef.current.has(key) && canFire("VIX_EXTREME", ALERT_COOLDOWNS.VIX_EXTREME)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "critical", msg: `🚨 VIX EXTREME: ${asset.price.toFixed(2)} — Panic levels detected`, time: new Date() });
          ALERT_SOUNDS.critical();
        }
      }

      // VIX DANGER
      else if (
        asset.id === "VIX" &&
        asset.price >= ALERT_THRESHOLDS.VIX_DANGER &&
        prev.price < ALERT_THRESHOLDS.VIX_DANGER
      ) {
        const key = `VIX_DANGER_${Math.floor(asset.price / 2)}`;
        if (!seenKeysRef.current.has(key) && canFire("VIX_DANGER", ALERT_COOLDOWNS.VIX_DANGER)) {
          seenKeysRef.current.add(key);
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "danger", msg: `⚠️ VIX DANGER: ${asset.price.toFixed(2)} — High volatility alert`, time: new Date() });
          ALERT_SOUNDS.danger();
        }
      }

      // OIL SPIKE — only fires when change crosses threshold direction
      if (
        asset.id === "WTI" &&
        Math.abs(asset.change) > ALERT_THRESHOLDS.OIL_MOVE_PCT &&
        Math.abs(prev.change) <= ALERT_THRESHOLDS.OIL_MOVE_PCT
      ) {
        const dir = asset.change > 0 ? "up" : "dn";
        const key = `OIL_SPIKE_${dir}_${new Date().toDateString()}`;
        if (!seenKeysRef.current.has(key) && canFire("OIL_SPIKE", ALERT_COOLDOWNS.OIL_SPIKE)) {
          seenKeysRef.current.add(key);
          const pct = `${asset.change >= 0 ? "+" : ""}${asset.change.toFixed(2)}%`;
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "warning", msg: `🛢 OIL SPIKE: WTI ${pct} — Macro risk elevated`, time: new Date() });
          ALERT_SOUNDS.warning();
        }
      }

      // CRYPTO MOVE
      if (
        (asset.id === "BTC" || asset.id === "ETH") &&
        Math.abs(asset.change) > ALERT_THRESHOLDS.CRYPTO_MOVE_PCT &&
        Math.abs(prev.change) <= ALERT_THRESHOLDS.CRYPTO_MOVE_PCT
      ) {
        const dir = asset.change > 0 ? "up" : "dn";
        const key = `CRYPTO_${asset.id}_${dir}_${new Date().toDateString()}`;
        if (!seenKeysRef.current.has(key) && canFire("CRYPTO_MOVE", ALERT_COOLDOWNS.CRYPTO_MOVE)) {
          seenKeysRef.current.add(key);
          const pct = `${asset.change >= 0 ? "+" : ""}${asset.change.toFixed(2)}%`;
          newAlerts.push({ id: `${key}_${Date.now()}`, level: "info", msg: `${asset.icon} CRYPTO MOVE: ${asset.label} ${pct}`, time: new Date() });
          ALERT_SOUNDS.info();
        }
      }

      prevAssetsRef.current[asset.id] = asset;
    });

    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 50));
      setNotifications(prev => {
        const next = [...newAlerts, ...prev].slice(0, 3);
        return next;
      });
      // Auto-dismiss newest toast batch after 5s
      setTimeout(() => {
        setNotifications(prev => prev.slice(newAlerts.length));
      }, 5000);
    }
  }, [assets, canFire]);

  return { alerts, notifications };
};

// ─────────────────────────────────────────────
// useNews  — polling with dedup by headline
// ─────────────────────────────────────────────
export const useNews = () => {
  const [news, setNews]     = useState([]);
  const [loading, setLoading] = useState(true);
  const seenHeadlines = useRef(new Set());

  const fetchAndMerge = useCallback(async () => {
    try {
      const fresh = await fetchNews();
      setNews(prev => {
        const incoming = fresh.filter(n => !seenHeadlines.current.has(n.headline));
        incoming.forEach(n => seenHeadlines.current.add(n.headline));
        return [...incoming, ...prev].slice(0, 40);
      });
      setLoading(false);
    } catch (e) {
      console.error("[useNews]", e);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAndMerge();
    const interval = setInterval(fetchAndMerge, INTERVALS.NEWS);
    return () => clearInterval(interval);
  }, [fetchAndMerge]);

  return { news, loading };
};

// ─────────────────────────────────────────────
// useSocialFeed — polling, dedup by id
// ─────────────────────────────────────────────
export const useSocialFeed = () => {
  const [feed, setFeed]     = useState([]);
  const [loading, setLoading] = useState(true);
  const seenIds = useRef(new Set());

  const fetchAndMerge = useCallback(async () => {
    try {
      const fresh = await fetchSocialFeed();
      setFeed(prev => {
        const incoming = fresh.filter(p => !seenIds.current.has(p.id));
        incoming.forEach(p => seenIds.current.add(p.id));
        return [...incoming, ...prev].slice(0, 30);
      });
      setLoading(false);
    } catch (e) {
      console.error("[useSocialFeed]", e);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAndMerge();
    const interval = setInterval(fetchAndMerge, INTERVALS.SOCIAL);
    return () => clearInterval(interval);
  }, [fetchAndMerge]);

  return { feed, loading };
};

// ─────────────────────────────────────────────
// useClock
// ─────────────────────────────────────────────
export const useClock = () => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return time;
};
