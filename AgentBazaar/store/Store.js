import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'agent-bazaar-store-v1';
const DAY = 86400000;

const StoreContext = createContext(null);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function buildSeed() {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

  const listings = [
    {
      id: 'lst_gpt4o',
      name: 'GPT-4o Inference',
      category: 'inference',
      description: 'Frontier multimodal inference endpoint with streaming and tool calling.',
      price: 0.004,
      priceUnit: '/1k tokens',
      latencyMs: 120,
      uptime: 99.97,
      calls24h: 12400,
      mcpEndpoint: 'mcp://openai.com/gpt-4o/inference',
      tiers: [
        { id: 'tier1', name: 'Pay as you go', price: 0.004, unit: '/1k tokens' },
        { id: 'tier2', name: 'Committed 10M', price: 0.0032, unit: '/1k tokens' },
        { id: 'tier3', name: 'Committed 100M', price: 0.0026, unit: '/1k tokens' },
      ],
      createdAt: iso(0),
    },
    {
      id: 'lst_vision',
      name: 'Vision Skill v2',
      category: 'skills',
      description: 'Image understanding, OCR and object detection skill pack.',
      price: 0.12,
      priceUnit: '/call',
      latencyMs: 240,
      uptime: 99.98,
      calls24h: 3120,
      mcpEndpoint: 'mcp://agentbazaar.io/skills/vision-v2',
      tiers: [
        { id: 'tier1', name: 'Pay as you go', price: 0.12, unit: '/call' },
        { id: 'tier2', name: 'Volume 50k', price: 0.09, unit: '/call' },
      ],
      createdAt: iso(0),
    },
    {
      id: 'lst_gpu',
      name: 'GPU Burst Compute',
      category: 'compute',
      description: 'On-demand H100 burst capacity billed by the hour, no commitment.',
      price: 1.85,
      priceUnit: '/hour',
      latencyMs: 850,
      uptime: 99.9,
      calls24h: 412,
      mcpEndpoint: 'mcp://agentbazaar.io/compute/gpu-burst',
      tiers: [
        { id: 'tier1', name: 'Burst', price: 1.85, unit: '/hour' },
        { id: 'tier2', name: 'Reserved 100h', price: 1.42, unit: '/hour' },
      ],
      createdAt: iso(0),
    },
    {
      id: 'lst_mcp_router',
      name: 'MCP Tool Router',
      category: 'mcp',
      description: 'Managed MCP server routing to 400+ tools with auth brokering.',
      price: 0.002,
      priceUnit: '/call',
      latencyMs: 45,
      uptime: 99.99,
      calls24h: 88200,
      mcpEndpoint: 'mcp://agentbazaar.io/router',
      tiers: [{ id: 'tier1', name: 'Pay as you go', price: 0.002, unit: '/call' }],
      createdAt: iso(2 * DAY),
    },
    {
      id: 'lst_embed',
      name: 'Embeddings Large',
      category: 'inference',
      description: '3072-dim embeddings for retrieval and clustering.',
      price: 0.00013,
      priceUnit: '/1k tokens',
      latencyMs: 38,
      uptime: 99.99,
      calls24h: 210400,
      mcpEndpoint: 'mcp://openai.com/embeddings-large',
      tiers: [{ id: 'tier1', name: 'Pay as you go', price: 0.00013, unit: '/1k tokens' }],
      createdAt: iso(3 * DAY),
    },
    {
      id: 'lst_websearch',
      name: 'Web Search Skill',
      category: 'skills',
      description: 'Live web search with citation payloads for grounding agents.',
      price: 0.008,
      priceUnit: '/call',
      latencyMs: 620,
      uptime: 99.95,
      calls24h: 9800,
      mcpEndpoint: 'mcp://agentbazaar.io/skills/web-search',
      tiers: [{ id: 'tier1', name: 'Pay as you go', price: 0.008, unit: '/call' }],
      createdAt: iso(4 * DAY),
    },
  ];

  const wallet = {
    id: 'wallet_main',
    balance: 2480,
    cap: 4000,
    spent24h: 312,
    a2aSettlements: 47,
    updatedAt: iso(0),
  };

  const transactions = [
    {
      id: 'txn_1',
      title: 'GPT-4o Inference',
      kind: 'purchase',
      amount: -12.4,
      at: iso(new Date().getHours() * 3600000 + new Date().getMinutes() * 60000),
      note: 'Manual purchase · 3.1M tokens',
    },
    {
      id: 'txn_2',
      title: 'A2A settlement',
      kind: 'a2a',
      amount: 260,
      at: iso(DAY + 1 * 3600000),
      note: 'Agent-to-agent settlement from agent-ops-7',
    },
    {
      id: 'txn_3',
      title: 'GPU Burst Compute',
      kind: 'purchase',
      amount: -18.5,
      at: iso(2 * DAY),
      note: 'Auto rule · queue > 500',
    },
    {
      id: 'txn_4',
      title: 'Top up',
      kind: 'topup',
      amount: 1000,
      at: iso(3 * DAY),
      note: 'Card top-up',
    },
    {
      id: 'txn_5',
      title: 'Vision Skill v2',
      kind: 'purchase',
      amount: -6.0,
      at: iso(4 * DAY),
      note: 'Manual purchase · 50 calls',
    },
  ];

  const rules = [
    {
      id: 'rule_queue',
      name: 'Queue > 500 → buy GPU Burst',
      trigger: 'Queue depth > 500',
      action: 'Purchase GPU Burst Compute (1 hour)',
      listingId: 'lst_gpu',
      enabled: true,
      runs24h: 18,
      saved: 94,
      lastRunAt: iso(2 * 3600000),
    },
    {
      id: 'rule_budget',
      name: 'Daily spend > £400 → pause inference',
      trigger: 'Spend today > £400',
      action: 'Pause GPT-4o Inference purchases',
      listingId: 'lst_gpt4o',
      enabled: true,
      runs24h: 2,
      saved: 38,
      lastRunAt: iso(6 * 3600000),
    },
    {
      id: 'rule_latency',
      name: 'p95 latency > 300ms → switch endpoint',
      trigger: 'p95 latency > 300ms',
      action: 'Switch to fallback inference endpoint',
      listingId: 'lst_gpt4o',
      enabled: false,
      runs24h: 0,
      saved: 0,
      lastRunAt: iso(5 * DAY),
    },
  ];

  const logEvents = [
    {
      id: 'log_1',
      mode: 'AUTO',
      listingName: 'GPU Burst Compute',
      amount: 1.85,
      at: iso(new Date().getHours() * 3600000 + new Date().getMinutes() * 60000 - 3600000),
      ruleId: 'rule_queue',
      payload: '{"mcp":"mcp://agentbazaar.io/compute/gpu-burst","method":"purchase","hours":1,"handshake":"ok"}',
      handshake: '{"protocol":"mcp/1.0","server":"gpu-burst","status":200}',
    },
    {
      id: 'log_2',
      mode: 'MANUAL',
      listingName: 'GPT-4o Inference',
      amount: 12.4,
      at: iso(new Date().getHours() * 3600000 + new Date().getMinutes() * 60000),
      ruleId: null,
      payload: '{"mcp":"mcp://openai.com/gpt-4o/inference","method":"purchase","tokens":3100000}',
      handshake: '{"protocol":"mcp/1.0","server":"openai","status":200}',
    },
    {
      id: 'log_3',
      mode: 'AUTO',
      listingName: 'GPU Burst Compute',
      amount: 1.85,
      at: iso(5 * 3600000),
      ruleId: 'rule_queue',
      payload: '{"mcp":"mcp://agentbazaar.io/compute/gpu-burst","method":"purchase","hours":1}',
      handshake: '{"protocol":"mcp/1.0","server":"gpu-burst","status":200}',
    },
    {
      id: 'log_4',
      mode: 'AUTO',
      listingName: 'GPU Burst Compute',
      amount: 1.85,
      at: iso(DAY + 3 * 3600000),
      ruleId: 'rule_queue',
      payload: '{"mcp":"mcp://agentbazaar.io/compute/gpu-burst","method":"purchase","hours":1}',
      handshake: '{"protocol":"mcp/1.0","server":"gpu-burst","status":200}',
    },
    {
      id: 'log_5',
      mode: 'MANUAL',
      listingName: 'Vision Skill v2',
      amount: 6.0,
      at: iso(2 * DAY),
      ruleId: null,
      payload: '{"mcp":"mcp://agentbazaar.io/skills/vision-v2","method":"purchase","calls":50}',
      handshake: '{"protocol":"mcp/1.0","server":"vision-v2","status":200}',
    },
  ];

  return {
    seeded: true,
    listings,
    wallet,
    transactions,
    rules,
    logEvents,
    logTotal: 128,
  };
}

export function StoreProvider({ children }) {
  const [state, setState] = useState({
    ready: false,
    seeded: false,
    listings: [],
    wallet: null,
    transactions: [],
    rules: [],
    logEvents: [],
    logTotal: 0,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (!alive) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          setState({ ready: true, ...parsed });
        } else {
          const seed = buildSeed();
          await AsyncStorage.setItem(KEY, JSON.stringify(seed));
          if (!alive) return;
          setState({ ready: true, ...seed });
        }
      } catch (e) {
        if (!alive) return;
        setState({ ready: true, ...buildSeed() });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback((next) => {
    setState((prev) => {
      const merged = typeof next === 'function' ? next(prev) : { ...prev, ...next };
      AsyncStorage.setItem(KEY, JSON.stringify(merged)).catch(() => {});
      return merged;
    });
  }, []);

  const add = useCallback(
    (collection, record) => {
      persist((prev) => {
        const item = { id: record.id || uid(), createdAt: record.createdAt || new Date().toISOString(), ...record };
        return { ...prev, [collection]: [item, ...(prev[collection] || [])] };
      });
    },
    [persist]
  );

  const update = useCallback(
    (collection, id, patch) => {
      persist((prev) => ({
        ...prev,
        [collection]: (prev[collection] || []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
      }));
    },
    [persist]
  );

  const remove = useCallback(
    (collection, id) => {
      persist((prev) => ({
        ...prev,
        [collection]: (prev[collection] || []).filter((r) => r.id !== id),
      }));
    },
    [persist]
  );

  const toggle = useCallback(
    (collection, id) => {
      persist((prev) => ({
        ...prev,
        [collection]: (prev[collection] || []).map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
      }));
    },
    [persist]
  );

  const topUp = useCallback(
    (amount) => {
      persist((prev) => {
        const w = prev.wallet || { balance: 0, cap: 4000, spent24h: 0, a2aSettlements: 0 };
        const tx = {
          id: uid(),
          title: 'Top up',
          kind: 'topup',
          amount,
          at: new Date().toISOString(),
          note: 'Card top-up',
        };
        return {
          ...prev,
          wallet: { ...w, balance: (w.balance || 0) + amount, updatedAt: new Date().toISOString() },
          transactions: [tx, ...(prev.transactions || [])],
        };
      });
    },
    [persist]
  );

  const purchase = useCallback(
    (listing, { mode = 'MANUAL', ruleId = null, qty = 1 } = {}) => {
      persist((prev) => {
        const w = prev.wallet || { balance: 0, cap: 4000, spent24h: 0, a2aSettlements: 0 };
        const amount = Number(((listing.price || 0) * qty).toFixed(2));
        const tx = {
          id: uid(),
          title: listing.name,
          kind: 'purchase',
          amount: -amount,
          at: new Date().toISOString(),
          note: mode === 'AUTO' ? 'Auto rule purchase' : 'Manual purchase',
        };
        const log = {
          id: uid(),
          mode,
          listingName: listing.name,
          amount,
          at: new Date().toISOString(),
          ruleId,
          payload: JSON.stringify({
            mcp: listing.mcpEndpoint || '',
            method: 'purchase',
            qty,
            unit: listing.priceUnit || '',
          }),
          handshake: JSON.stringify({
            protocol: 'mcp/1.0',
            server: (listing.mcpEndpoint || '').split('/')[2] || 'unknown',
            status: 200,
          }),
        };
        return {
          ...prev,
          wallet: {
            ...w,
            balance: (w.balance || 0) - amount,
            spent24h: (w.spent24h || 0) + amount,
            updatedAt: new Date().toISOString(),
          },
          transactions: [tx, ...(prev.transactions || [])],
          logEvents: [log, ...(prev.logEvents || [])],
          logTotal: (prev.logTotal || 0) + 1,
        };
      });
    },
    [persist]
  );

  const addRule = useCallback(
    (rule) => add('rules', rule),
    [add]
  );

  const removeRule = useCallback(
    (id) => remove('rules', id),
    [remove]
  );

  const toggleRule = useCallback(
    (id) => toggle('rules', id),
    [toggle]
  );

  const addPurchase = useCallback(
    (listing, opts) => purchase(listing, opts),
    [purchase]
  );

  const value = useMemo(
    () => ({
      ready: state.ready,
      seeded: state.seeded,
      listings: state.listings || [],
      wallet: state.wallet,
      transactions: state.transactions || [],
      rules: state.rules || [],
      logEvents: state.logEvents || [],
      logTotal: state.logTotal || 0,
      add,
      update,
      remove,
      toggle,
      topUp,
      purchase,
      addRule,
      removeRule,
      toggleRule,
      addPurchase,
    }),
    [state, add, update, remove, toggle, topUp, purchase, addRule, removeRule, toggleRule, addPurchase]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export const AppStoreProvider = StoreProvider;
