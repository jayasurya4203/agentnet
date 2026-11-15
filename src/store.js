import fs from 'node:fs';
import path from 'node:path';
import { id, nowIso, clamp } from './util.js';

const subscribers = new Set();
let persistTimer = null;
let persistTarget = null;

export function emptyState() {
  return {
    meta: {
      version: 1,
      generation: id('gen'),
      createdAt: nowIso(),
    },
    agents: [],
    posts: [],
    comments: [],
    routing: [],
    notifications: [],
    subscriptions: [],
    affinity: {},
    learning: [],
    events: [],
    latency: [],
  };
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function emit(state, type, data = {}) {
  const event = { id: id('evt'), type, at: nowIso(), data };
  state.events.push(event);
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // A dead SSE client must not break routing.
    }
  }
  return event;
}

export function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.agents)) return null;
    if (!raw.latency) raw.latency = [];
    if (!raw.learning) raw.learning = [];
    if (!raw.affinity) raw.affinity = {};
    if (!raw.meta) raw.meta = {};
    if (!raw.meta.generation) raw.meta.generation = id('gen');
    return raw;
  } catch {
    return null;
  }
}

export function saveStateNow(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const persisted = {
    ...state,
    // SSE replay lives in memory; keep the file focused on durable records.
    events: state.events.slice(-30),
  };
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  fs.renameSync(tmp, file);
}

export function schedulePersist(file, state, delay = 120) {
  persistTarget = { file, state };
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      saveStateNow(file, state);
    } catch (error) {
      console.error('[agentnet] persist failed:', error.message);
    }
  }, delay);
}

export function flushPersist() {
  if (!persistTarget) return;
  clearTimeout(persistTimer);
  try {
    saveStateNow(persistTarget.file, persistTarget.state);
  } catch (error) {
    console.error('[agentnet] persist failed:', error.message);
  }
}

export function getAffinity(state, agentId, topic) {
  return state.affinity[agentId]?.[topic] || 0;
}

export function applyFeedback(state, agentId, topics, delta, reason) {
  if (!topics.length) return [];
  if (!state.affinity[agentId]) state.affinity[agentId] = {};
  const changes = [];
  for (const { topic, weight } of topics) {
    const current = state.affinity[agentId][topic] || 0;
    const next = clamp(current + delta * (weight ?? 1), -0.4, 0.5);
    const applied = Math.round((next - current) * 1000) / 1000;
    if (!applied) continue;
    state.affinity[agentId][topic] = Math.round(next * 1000) / 1000;
    changes.push({ topic, delta: applied, value: state.affinity[agentId][topic] });
  }
  if (changes.length) {
    state.learning.push({
      id: id('lrn'),
      agentId,
      delta,
      reason,
      changes,
      at: nowIso(),
    });
    if (state.learning.length > 200) state.learning.splice(0, state.learning.length - 200);
  }
  return changes;
}

export function registerAgentInState(state, agent) {
  state.agents.push(agent);
  if (!state.affinity[agent.id]) state.affinity[agent.id] = {};
}

export function findAgent(state, idOrSlug) {
  return state.agents.find((a) => a.id === idOrSlug || a.slug === idOrSlug);
}
