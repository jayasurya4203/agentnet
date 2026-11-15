import { TOPICS, cosine, labelForTopic } from './text.js';
import { clamp, round } from './util.js';
import { getAffinity } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SIMILARITY_SUPPRESS = 0.95;

function topicFit(agent, post) {
  let best = { score: 0, kind: 'none', postTopic: null, allied: null, direct: 0 };
  // Direct interest anywhere in the post is the strongest signal.
  for (const pt of post.topics) {
    const direct = (agent.topicWeights?.[pt.topic] || 0) * pt.weight;
    if (direct > best.score) {
      best = { score: direct, kind: 'direct', postTopic: pt.topic, allied: null, direct };
    }
  }
  // Complementary capability is evaluated against the post's lead topic only.
  // This prevents incidental words ("payments" mentioned in a food offer) from
  // pulling in every adjacent company.
  const primary = post.topics[0];
  const meta = primary ? TOPICS[primary.topic] : null;
  if (meta) {
    for (const allied of meta.allies) {
      const cap = (agent.capabilityWeights?.[allied] || 0) * 0.9;
      const interest = (agent.topicWeights?.[allied] || 0) * 0.55;
      const value = Math.max(cap, interest) * 0.95 * primary.weight;
      if (value > best.score) {
        best = { score: value, kind: 'allied', postTopic: primary.topic, allied, direct: 0 };
      }
    }
  }
  return {
    score: round(clamp(best.score, 0, 1), 4),
    kind: best.kind,
    postTopic: best.postTopic,
    allied: best.allied,
  };
}

function lexicalScore(agent, post) {
  const postTokens = post.tokens || [];
  if (!postTokens.length) return 0;
  const agentTokens = new Set(agent.tokens || []);
  let shared = 0;
  let weight = 0;
  for (const token of postTokens) {
    const w = Math.min(8, token.length) / 8;
    weight += w;
    if (agentTokens.has(token)) shared += w;
  }
  return round(weight ? shared / weight : 0, 4);
}

function intentFit(agent, post) {
  const preferred = agent.preferredIntents || [];
  if (preferred.includes('all')) return 1;
  const overlap = post.intents.filter((i) => preferred.includes(i));
  if (overlap.length) return 1;
  if (post.intents.includes('request')) return 0.55;
  return 0.3;
}

function geoFit(agent, post) {
  if (!post.geo || post.geo === 'GLOBAL') return 1;
  if (agent.geo === post.geo || agent.geo === 'GLOBAL') return 1;
  return 0.15;
}

function affinityFor(agentId, post, state) {
  let total = 0;
  let weight = 0;
  for (const topic of post.topics.slice(0, 3)) {
    total += getAffinity(state, agentId, topic.topic) * topic.weight;
    weight += topic.weight;
  }
  return weight ? round(total / weight, 4) : 0;
}

function subscriptionsFor(state, agentId) {
  return state.subscriptions.filter((s) => s.agentId === agentId);
}

function matchingSubscription(subs, post, author) {
  return subs.find((s) => {
    if (s.type === 'topic') return post.topics.some((t) => t.topic === s.value);
    if (s.type === 'industry') return author.industry === s.value;
    if (s.type === 'author') return author.id === s.value || author.company === s.value;
    return false;
  });
}

function recentlyNotifiedSimilar(state, agentId, post) {
  if (!post.embedding || state.posts.length < 2) return null;
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const notifiedPostIds = new Set(
    state.routing
      .filter(
        (r) =>
          r.agentId === agentId &&
          ['notified', 'engaged', 'ignored', 'queued'].includes(r.status) &&
          new Date(r.createdAt).getTime() >= cutoff,
      )
      .map((r) => r.postId),
  );
  for (const other of state.posts) {
    if (other.id === post.id || !other.embedding || !notifiedPostIds.has(other.id)) continue;
    if (cosine(post.embedding, other.embedding) >= SIMILARITY_SUPPRESS) return other;
  }
  return null;
}

function dailyNotificationCount(state, agentId) {
  const cutoff = Date.now() - DAY_MS;
  return state.notifications.filter(
    (n) =>
      n.agentId === agentId &&
      n.status !== 'failed' &&
      new Date(n.createdAt).getTime() >= cutoff,
  ).length;
}

function logBase(agent, post, stage, status) {
  return {
    id: `rt_${post.id.slice(4)}_${agent.id.slice(4)}`,
    postId: post.id,
    agentId: agent.id,
    agent: { id: agent.id, company: agent.company, industry: agent.industry, slug: agent.slug },
    stage,
    status,
    dense: 0,
    lexical: 0,
    topicFit: 0,
    final: 0,
    affinity: 0,
    reasons: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * The core relevance funnel:
 *   Stage 1  hard eligibility filters         (N agents -> eligible)
 *   Stage 2  hybrid recall: dense + topic     (eligible -> topK candidates)
 *   Stage 3  explainable judge + threshold    (candidates -> <= max recipients)
 *
 * Every evaluated agent gets an auditable routing record so the dashboard can
 * show why Bajaj Auto was not notified, not just that it wasn't.
 */
export function routePost(state, post, config = {}) {
  const started = performance.now();
  const topK = config.topK ?? 20;
  const threshold = config.threshold ?? 0.58;
  const maxRecipients = config.maxRecipients ?? 4;
  const maxPerIndustry = config.maxPerIndustry ?? 2;
  const author = state.agents.find((a) => a.id === post.authorId);
  if (!author) throw new Error('Post author not found');

  const logs = [];
  const eligible = [];

  for (const agent of state.agents) {
    const log = logBase(agent, post, 'filtered', 'excluded');

    if (agent.id === author.id) {
      log.filterReason = 'self';
      logs.push(log);
      continue;
    }
    if (agent.active === false) {
      log.filterReason = 'inactive';
      logs.push(log);
      continue;
    }
    if (!agent.verified && agent.trustScore < 0.5) {
      log.filterReason = 'unverified_low_trust_agent';
      logs.push(log);
      continue;
    }
    if (agent.blockedCompanies?.includes(author.company)) {
      log.filterReason = 'blocked_source';
      logs.push(log);
      continue;
    }
    const muted = post.topics.find((t) => agent.mutedTopics?.includes(t.topic));
    if (muted) {
      log.filterReason = `muted_topic:${muted.topic}`;
      logs.push(log);
      continue;
    }
    if (geoFit(agent, post) < 1) {
      log.filterReason = `geo_mismatch:${post.geo}`;
      logs.push(log);
      continue;
    }
    if (post.safety?.action === 'review' && !agent.verified) {
      log.filterReason = 'reviewed_post_requires_verified_agent';
      logs.push(log);
      continue;
    }
    if (author.trustScore < 0.45 && agent.requireVerifiedSource !== false) {
      log.filterReason = 'low_trust_source';
      logs.push(log);
      continue;
    }
    if (dailyNotificationCount(state, agent.id) >= (config.dailyNotificationCap ?? 60)) {
      log.filterReason = 'daily_notification_cap';
      logs.push(log);
      continue;
    }
    const similar = recentlyNotifiedSimilar(state, agent.id, post);
    if (similar) {
      log.filterReason = `similar_post_suppressed:${similar.id}`;
      logs.push(log);
      continue;
    }

    const dense = round(clamp((cosine(post.embedding, agent.embedding) + 0.15) / 0.9, 0, 1), 4);
    const fit = topicFit(agent, post);
    log.stage = 'candidate';
    log.status = 'scored';
    log.dense = dense;
    log.topicFit = fit.score;
    log.fitKind = fit.kind;
    log.fitTopic = fit.postTopic;
    log.fitAllied = fit.allied;
    log.recall = round(0.55 * dense + 0.45 * fit.score, 4);
    // Lexical overlap and learned affinity are only needed for the judge
    // shortlist, so they are computed there instead of for every agent.
    eligible.push({ agent, log, dense, fit });
  }

  eligible.sort((a, b) => b.log.recall - a.log.recall || b.log.topicFit - a.log.topicFit);
  const shortlist = eligible.slice(0, topK);
  const shortlistIds = new Set(shortlist.map((e) => e.agent.id));

  for (const entry of eligible) {
    if (!shortlistIds.has(entry.agent.id)) {
      entry.log.stage = 'not_shortlisted';
      entry.log.status = 'scored';
      entry.log.reasons.push(
        `Recall ${(entry.log.recall * 100).toFixed(0)} outside top ${topK} — not worth a judge call`,
      );
      logs.push(entry.log);
    }
  }

  const subsByAgent = new Map();
  for (const entry of shortlist) {
    subsByAgent.set(entry.agent.id, subscriptionsFor(state, entry.agent.id));
  }

  for (const entry of shortlist) {
    const { agent, log, dense, fit } = entry;
    const lexical = lexicalScore(agent, post);
    const intent = intentFit(agent, post);
    const geo = geoFit(agent, post);
    const affinity = affinityFor(agent.id, post, state);
    const sub = matchingSubscription(subsByAgent.get(agent.id) || [], post, author);
    const affinityBonus = affinity * 0.18;
    const subBoost = sub ? 0.08 : 0;
    const trustPenalty = author.trustScore < 0.6 ? round((0.6 - author.trustScore) * 0.12, 4) : 0;
    const final = clamp(
      0.46 * fit.score + 0.2 * dense + 0.14 * lexical + 0.12 * intent + 0.08 * geo + affinityBonus + subBoost - trustPenalty,
      0,
      1,
    );

    log.lexical = lexical;
    log.intentFit = round(intent, 3);
    log.geoFit = round(geo, 3);
    log.affinity = affinity;
    log.final = round(final, 4);
    log.subscription = sub ? `${sub.type}:${sub.value}` : null;

    if (fit.kind === 'direct') {
      log.reasons.push(`Direct interest in ${labelForTopic(fit.postTopic)}`);
    } else if (fit.kind === 'allied') {
      log.reasons.push(
        `${labelForTopic(fit.postTopic)} post meets your ${labelForTopic(fit.allied)} capability`,
      );
    } else {
      log.reasons.push('No topical or complementary fit');
    }
    if (sub) log.reasons.push(`Explicit subscription (${sub.type}: ${sub.value})`);
    if (affinity > 0.02) {
      log.reasons.push(`Learned affinity +${Math.round(affinity * 100)} on ${labelForTopic(fit.postTopic)}`);
    } else if (affinity < -0.02) {
      log.reasons.push(`Learned disinterest ${Math.round(affinity * 100)} on ${labelForTopic(fit.postTopic)}`);
    }
    if (author.trustScore < 0.6) log.reasons.push(`Author trust ${author.trustScore.toFixed(2)} — score damped`);
    if (agent.competitors?.includes(author.company)) log.reasons.push('Competitor source — intelligence only');

    if (final >= threshold) {
      log.stage = 'notified';
      log.status = 'queued';
    } else {
      log.stage = 'below_threshold';
      log.status = 'rejected';
      log.reasons.push(`${(final * 100).toFixed(0)} < ${(threshold * 100).toFixed(0)} threshold`);
    }
    logs.push(log);
  }

  const selected = shortlist
    .filter((e) => e.log.final >= threshold)
    .sort((a, b) => b.log.final - a.log.final);

  const industryCount = new Map();
  const recipients = [];
  for (const entry of selected) {
    if (recipients.length >= maxRecipients) {
      entry.log.stage = 'below_threshold';
      entry.log.status = 'rejected';
      entry.log.reasons.push(`Fan-out cap reached (${maxRecipients} recipients)`);
      continue;
    }
    const count = industryCount.get(entry.agent.industry) || 0;
    if (count >= maxPerIndustry) {
      entry.log.stage = 'below_threshold';
      entry.log.status = 'rejected';
      entry.log.reasons.push(`Diversity cap: already ${maxPerIndustry} recipients from ${entry.agent.industry}`);
      continue;
    }
    industryCount.set(entry.agent.industry, count + 1);
    recipients.push(entry);
  }

  const latencyMs = round(performance.now() - started, 2);
  const summary = {
    eligible: eligible.length,
    candidates: shortlist.length,
    notified: recipients.length,
    filtered: logs.filter((l) => l.stage === 'filtered').length,
    evaluated: state.agents.length,
    threshold,
    topK,
    maxRecipients,
    latencyMs,
  };

  return { logs, recipients: recipients.map((r) => r.log), summary };
}

export { topicFit, lexicalScore, intentFit, geoFit, affinityFor };
