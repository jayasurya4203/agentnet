// Synthetic scale benchmark for the routing funnel.
//
//   node scripts/bench.js              # 10,000 agents
//   node scripts/bench.js --agents=25000
//
// This measures the in-process routing core (Stage 1 hard filters + flat cosine
// recall + judge shortlist) so the README's numbers are reproducible without a
// database. Production replaces the flat scan with pgvector HNSW and keeps the
// same sample/shortlist contract.

import { performance } from 'node:perf_hooks';
import { createAgentRecord } from '../src/agents.js';
import { routePost } from '../src/routing.js';
import { emptyState } from '../src/store.js';
import {
  INDUSTRIES,
  TOPICS,
  detectGeo,
  detectIntents,
  detectTopics,
  embed,
  extractDealFacts,
  keySentence,
  tokenize,
} from '../src/text.js';
import { id, percentile, round } from '../src/util.js';

const arg = process.argv.find((value) => value.startsWith('--agents='));
const AGENT_COUNT = Math.max(100, Number(arg?.split('=')[1] || process.env.AGENTNET_BENCH_AGENTS || 10000));
const ITERATIONS = Number(process.env.AGENTNET_BENCH_ITERATIONS || 40);
const WARMUP = 6;
const TOPK = 20;
const THRESHOLD = 0.58;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0xa6e27);
const topicKeys = Object.keys(TOPICS);
const industryKeys = Object.keys(INDUSTRIES).filter((key) => key !== 'Other');

function pickTopics(count) {
  const chosen = new Set();
  while (chosen.size < count) {
    chosen.add(topicKeys[Math.floor(random() * topicKeys.length)]);
  }
  return [...chosen];
}

function makeManifesto(company, industry, interests) {
  const labels = interests.map((topic) => TOPICS[topic].label).join(', ');
  return `${company} is a ${industry} business. We track ${labels} partnerships, merchant offers, seasonal promotions and co-marketing programmes across India.`;
}

function makePost(author) {
  const title = '5% off all Swiggy deliveries this Diwali week';
  const content =
    'Swiggy is offering a flat 5% off on all delivery orders above ₹300 from Nov 18–24. We are looking for payment and card partners to co-fund festive cashback for the campaign. Campaign budget ₹2.4Cr; settlement T+1.';
  const topics = detectTopics(title, content);
  return {
    id: id('pst'),
    authorId: author.id,
    title,
    content,
    topics,
    intents: detectIntents(title, content),
    geo: detectGeo(title, content),
    facts: extractDealFacts(title, content),
    keySentence: keySentence(title, content),
    embedding: embed(`${title}. ${content}`, topics),
    tokens: [...new Set(tokenize(`${title} ${content}`))],
    safety: { action: 'allow', risk: 0, flags: [] },
    status: 'published',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
  };
}

console.log(`\nAgentNet routing benchmark`);
console.log(`generating ${AGENT_COUNT.toLocaleString()} synthetic agents...`);

const buildStart = performance.now();
const state = emptyState();
state.subscriptions = [];

for (let index = 0; index < AGENT_COUNT; index += 1) {
  const industry = industryKeys[index % industryKeys.length];
  const interests = pickTopics(2 + (index % 3));
  const company = `Bench ${industry.split(' ')[0]} Co ${index}`;
  const capabilities = interests.map((topic) => `${TOPICS[topic].label.toLowerCase()} platform`);
  const verified = index % 23 !== 0;
  const { agent } = createAgentRecord(
    {
      company,
      industry,
      manifesto: makeManifesto(company, industry, interests),
      interests,
      capabilities,
      capabilityTopics: interests.slice(0, 2),
      preferredIntents: ['offer', 'request', 'announcement'],
      behavior: { topics: interests, minScore: 0.62 },
      active: index % 41 !== 0,
      webhookUrl: 'local://simulated',
    },
    {
      verified,
      trustScore: verified ? 0.7 + random() * 0.28 : 0.3 + random() * 0.15,
    },
  );
  state.agents.push(agent);
  state.affinity[agent.id] = {};
}

const publisher = createAgentRecord(
  {
    company: 'Bench Publisher',
    industry: 'Food Delivery',
    manifesto:
      'Bench Publisher is a food delivery marketplace looking for payment, card, loyalty and quick commerce partners for seasonal cashback campaigns.',
    interests: ['food_delivery', 'quick_commerce', 'payments'],
    capabilities: ['food delivery marketplace', 'consumer promotions'],
    capabilityTopics: ['food_delivery'],
    webhookUrl: 'local://simulated',
  },
  { verified: true, trustScore: 0.95 },
).agent;
state.agents.push(publisher);
state.affinity[publisher.id] = {};

const post = makePost(publisher);
const buildMs = performance.now() - buildStart;

for (let index = 0; index < WARMUP; index += 1) {
  routePost(state, post, { topK: TOPK, threshold: THRESHOLD, maxRecipients: 4, maxPerIndustry: 2 });
}

const samples = [];
let last = null;
for (let index = 0; index < ITERATIONS; index += 1) {
  const started = performance.now();
  last = routePost(state, post, { topK: TOPK, threshold: THRESHOLD, maxRecipients: 4, maxPerIndustry: 2 });
  samples.push(performance.now() - started);
}

const p50 = percentile(samples, 50);
const p95 = percentile(samples, 95);
const p99 = percentile(samples, 99);
const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;

console.log(`agents            ${state.agents.length.toLocaleString()} (including publisher)`);
console.log(`build time        ${round(buildMs, 0)} ms (${round(buildMs / state.agents.length, 3)} ms/agent, offline embeddings)`);
console.log(`eligible          ${last.summary.eligible.toLocaleString()} after Stage 1 hard filters`);
console.log(`shortlisted       ${last.summary.candidates.toLocaleString()} of ${last.summary.eligible.toLocaleString()} (top-K ${TOPK})`);
console.log(`notified          ${last.summary.notified} (threshold ${THRESHOLD})`);
console.log(`iterations        ${ITERATIONS} + ${WARMUP} warmup`);
console.log(`routing latency   p50 ${round(p50, 2)} ms | p95 ${round(p95, 2)} ms | p99 ${round(p99, 2)} ms | avg ${round(avg, 2)} ms`);
console.log(`judge calls saved ${(last.summary.eligible - last.summary.candidates).toLocaleString()} per post`);
console.log(`\nProduction swaps the flat cosine scan for pgvector HNSW; judge calls stay bounded by top-K.\n`);
