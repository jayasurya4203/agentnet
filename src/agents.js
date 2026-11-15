import { id as makeId, randomKey, sha256, slugify } from './util.js';
import {
  INDUSTRIES,
  TOPICS,
  buildCapabilityWeights,
  buildTopicWeights,
  embed,
  profileDocument,
  tokenize,
} from './text.js';

export function createAgentRecord(input, options = {}) {
  const company = String(input.company || '').trim();
  if (company.length < 2) throw Object.assign(new Error('Company name must be at least 2 characters'), { status: 400 });
  const industry = INDUSTRIES[input.industry] ? input.industry : 'Other';
  const manifesto = String(input.manifesto || '').trim();
  if (manifesto.length < 20) {
    throw Object.assign(new Error('Interest manifesto must be at least 20 characters'), { status: 400 });
  }
  if (manifesto.length > 4000) {
    throw Object.assign(new Error('Interest manifesto must be under 4000 characters'), { status: 400 });
  }

  const id = options.id || input.id || makeId('agt');
  const apiKey = options.demoKey || randomKey();
  const webhookSecret = options.webhookSecret || randomKey('whsec');
  const verificationToken = options.verificationToken || randomKey('verify');
  const interests = (input.interests || []).filter((t) => TOPICS[t]);
  const capabilityTopics = (input.capabilityTopics || []).filter((t) => TOPICS[t]);
  const capabilityText = input.capabilities || [];
  const topicWeights = buildTopicWeights(manifesto, interests, industry);
  const capabilityWeights = buildCapabilityWeights(capabilityText, industry);
  for (const topic of capabilityTopics) capabilityWeights[topic] = 1;

  const agent = {
    id,
    slug: input.slug || slugify(company),
    company,
    industry,
    tagline: String(input.tagline || '').slice(0, 160),
    manifesto,
    interests,
    capabilities: capabilityText,
    topicWeights,
    capabilityWeights,
    preferredIntents: input.preferredIntents || ['offer', 'request', 'announcement'],
    mutedTopics: (input.mutedTopics || []).filter((t) => TOPICS[t]),
    competitors: input.competitors || [],
    geo: input.geo || 'IN',
    webhookUrl: input.webhookUrl || 'local://simulated',
    webhookSecret,
    apiKeyHash: sha256(apiKey),
    verificationTokenHash: sha256(verificationToken),
    demoKey: options.demoKey || null,
    verified: options.verified ?? Boolean(input.verified),
    trustScore: options.trustScore ?? input.trustScore ?? 0.55,
    active: input.active !== false,
    requireVerifiedSource: input.requireVerifiedSource !== false,
    behavior: input.behavior || { mode: 'generic', minScore: 0.66 },
    stats: { notified: 0, engaged: 0, ignored: 0 },
    createdAt: new Date().toISOString(),
  };

  const doc = profileDocument(agent);
  agent.tokens = Array.from(new Set(tokenize(doc)));
  agent.embedding = embed(doc, Object.entries(topicWeights).map(([topic, weight]) => ({ topic, weight })));

  return { agent, apiKey, verificationToken };
}

export function publicAgent(agent, { includeDemoKey = false } = {}) {
  if (!agent) return null;
  return {
    id: agent.id,
    slug: agent.slug,
    company: agent.company,
    industry: agent.industry,
    tagline: agent.tagline,
    manifesto: agent.manifesto,
    interests: agent.interests,
    capabilities: agent.capabilities,
    topicWeights: agent.topicWeights,
    capabilityWeights: agent.capabilityWeights,
    preferredIntents: agent.preferredIntents,
    mutedTopics: agent.mutedTopics,
    competitors: agent.competitors,
    geo: agent.geo,
    verified: agent.verified,
    trustScore: agent.trustScore,
    active: agent.active,
    simulated: agent.webhookUrl === 'local://simulated',
    webhookHost: agent.webhookUrl === 'local://simulated' ? 'simulated signed inbox' : safeHost(agent.webhookUrl),
    behavior: agent.behavior,
    stats: agent.stats,
    createdAt: agent.createdAt,
    demoKey: includeDemoKey ? agent.demoKey : undefined,
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid webhook';
  }
}

export function authorSnapshot(agent) {
  if (!agent) return { company: 'Unknown', industry: 'Unknown' };
  return {
    id: agent.id,
    slug: agent.slug,
    company: agent.company,
    industry: agent.industry,
    verified: agent.verified,
    trustScore: agent.trustScore,
  };
}
