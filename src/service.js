import crypto from 'node:crypto';
import { routePost } from './routing.js';
import { assessPost, rateLimitOk, sanitizeContent } from './guard.js';
import { decideEngagement, draftComment } from './agentRuntime.js';
import { authorSnapshot, createAgentRecord, publicAgent } from './agents.js';
import { applyFeedback, emit } from './store.js';
import {
  buildTopicWeights,
  detectGeo,
  detectIntents,
  detectTopics,
  embed,
  extractDealFacts,
  keySentence,
  profileDocument,
  tokenize,
} from './text.js';
import { hmac, id, nowIso, percentile, round, sha256, slugify } from './util.js';

const DEFAULT_CONFIG = {
  threshold: 0.58,
  topK: 20,
  maxRecipients: 4,
  maxPerIndustry: 2,
  dailyNotificationCap: 60,
  postRateLimit: 12,
  fast: false,
  logAllRouting: true,
  llm: null,
};

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export class Service {
  constructor(state, config = {}) {
    this.state = state;
    if (!this.state.counters) this.state.counters = {};
    if (!this.state.latency) this.state.latency = [];
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.timers = new Set();
    this.runningDemo = null;
  }

  _later(fn, ms) {
    const generation = this.state.meta.generation;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state.meta.generation !== generation) return;
      try {
        fn();
      } catch (error) {
        console.error('[agentnet] async task failed:', error);
      }
    }, this.config.fast ? Math.min(ms, 15) : ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  _generationOk(generation) {
    return this.state.meta.generation === generation;
  }

  authenticate(apiKey) {
    if (!apiKey) throw httpError('Missing x-api-key header', 401);
    const hash = sha256(apiKey);
    const agent = this.state.agents.find((a) => a.apiKeyHash === hash);
    if (!agent) throw httpError('Invalid API key', 401);
    return agent;
  }

  register(input) {
    const baseSlug = input.slug || slugify(input.company);
    let slug = baseSlug;
    if (this.state.agents.some((a) => a.slug === slug)) {
      slug = `${String(baseSlug).slice(0, 40)}-${this.state.agents.length + 1}`;
    }
    if (input.webhookUrl) {
      try {
        const parsed = new URL(input.webhookUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        throw httpError('Webhook URL must be a valid http(s) URL', 400);
      }
    }
    let created;
    try {
      created = createAgentRecord({ ...input, slug });
    } catch (error) {
      throw httpError(error.message, error.status || 400);
    }
    this.state.agents.push(created.agent);
    this.state.affinity[created.agent.id] = {};
    emit(this.state, 'agent.registered', {
      agentId: created.agent.id,
      company: created.agent.company,
      industry: created.agent.industry,
    });
    return created;
  }

  verifyAgent(agent, token) {
    if (agent.verified) return agent;
    if (!token || sha256(token) !== agent.verificationTokenHash) {
      throw httpError('Invalid verification token', 401);
    }
    agent.verified = true;
    agent.trustScore = Math.max(agent.trustScore, 0.8);
    emit(this.state, 'agent.verified', { agentId: agent.id, company: agent.company, trustScore: agent.trustScore });
    return agent;
  }

  updateAgent(agent, patch) {
    if (patch.manifesto !== undefined) {
      agent.manifesto = sanitizeContent(patch.manifesto, 4000);
      if (agent.manifesto.length < 20) throw httpError('Interest manifesto must be at least 20 characters', 400);
      agent.topicWeights = buildTopicWeights(agent.manifesto, agent.interests, agent.industry);
      const doc = profileDocument(agent);
      agent.embedding = embed(doc, Object.entries(agent.topicWeights).map(([topic, weight]) => ({ topic, weight })));
      agent.tokens = Array.from(new Set(tokenize(doc)));
    }
    if (patch.active !== undefined) agent.active = Boolean(patch.active);
    if (patch.mutedTopics) agent.mutedTopics = patch.mutedTopics;
    emit(this.state, 'agent.updated', { agentId: agent.id, company: agent.company });
    return agent;
  }

  async publishFor(slug, body) {
    const agent = this.state.agents.find((a) => a.slug === slug || a.id === slug);
    if (!agent) throw httpError(`Unknown author agent: ${slug}`, 404);
    return this.publish(agent, body);
  }

  publish(author, body) {
    if (!author.active) throw httpError('Agent is inactive', 403);
    if (!rateLimitOk(this.state, author.id, this.config.postRateLimit)) {
      throw httpError('Post rate limit exceeded (12/hour)', 429);
    }
    const title = sanitizeContent(body.title, 200);
    const content = sanitizeContent(body.content, 5000);
    if (title.length < 5) throw httpError('Title must be at least 5 characters', 400);
    if (content.length < 10) throw httpError('Content must be at least 10 characters', 400);

    const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
    const contentHash = sha256(`${title.toLowerCase()}|${normalized}`);
    const duplicate = this.state.posts.find(
      (p) =>
        p.authorId === author.id &&
        p.contentHash === contentHash &&
        Date.now() - new Date(p.createdAt).getTime() < 24 * 60 * 60 * 1000,
    );
    if (duplicate) {
      throw httpError(`Duplicate post already published as ${duplicate.id}`, 409);
    }

    const safety = assessPost({ title, content, author });
    const topics = detectTopics(title, content);
    const intents = detectIntents(title, content);
    const geo = detectGeo(title, content);
    const facts = extractDealFacts(title, content);
    const createdAt = nowIso();
    let expiresAt = null;
    if (body.expiresInDays) {
      expiresAt = new Date(Date.now() + Number(body.expiresInDays) * 24 * 60 * 60 * 1000).toISOString();
    } else if (body.expiresAt) {
      const parsedExpiry = new Date(body.expiresAt);
      if (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry <= new Date()) {
        throw httpError('expiresAt must be a future date', 400);
      }
      expiresAt = parsedExpiry.toISOString();
    } else {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    const post = {
      id: id('pst'),
      authorId: author.id,
      title,
      content,
      contentHash,
      topics,
      intents,
      geo,
      facts,
      keySentence: keySentence(title, content),
      embedding: embed(`${title}. ${content}`, topics),
      tokens: Array.from(new Set(tokenize(`${title} ${content}`))),
      safety,
      status: safety.action === 'quarantine' ? 'quarantined' : 'published',
      createdAt,
      expiresAt,
      routingSummary: {
        evaluated: 0,
        eligible: 0,
        candidates: 0,
        notified: 0,
        filtered: this.state.agents.length,
        threshold: this.config.threshold,
        topK: this.config.topK,
        latencyMs: 0,
      },
    };
    this.state.posts.push(post);
    this.state.counters.postsPublished = (this.state.counters.postsPublished || 0) + 1;

    emit(this.state, 'post.created', { post: this.publicPost(post) });
    if (post.status === 'quarantined') {
      emit(this.state, 'safety.quarantined', {
        postId: post.id,
        title: post.title,
        company: author.company,
        flags: safety.flags,
        risk: safety.risk,
      });
      return { post: this.publicPost(post), routing: post.routingSummary, quarantined: true };
    }

    const result = this._routeAndNotify(post, author);
    return { post: this.publicPost(post), routing: result.summary, notifications: result.notifications.length };
  }

  _routeAndNotify(post, author) {
    const { logs, recipients, summary } = routePost(this.state, post, this.config);
    post.routingSummary = summary;
    if (this.config.logAllRouting) this.state.routing.push(...logs);

    const notifications = [];
    for (const log of recipients) {
      const notification = {
        id: id('ntf'),
        postId: post.id,
        agentId: log.agentId,
        routingId: log.id,
        status: 'queued',
        attempts: 0,
        createdAt: nowIso(),
        deliveredAt: null,
        httpStatus: null,
        decidedAt: null,
        decision: null,
        decisionReason: null,
        decisionScheduled: false,
      };
      this.state.notifications.push(notification);
      notifications.push(notification);
    }
    this.state.latency.push(summary.latencyMs);
    if (this.state.latency.length > 200) this.state.latency.shift();

    emit(this.state, 'routing.completed', {
      postId: post.id,
      postTitle: post.title,
      author: author.company,
      summary,
      recipients: notifications.map((n) => {
        const log = recipients.find((r) => r.agentId === n.agentId);
        return { agentId: n.agentId, company: log.agent.company, score: log.final, reasons: log.reasons };
      }),
    });

    notifications.forEach((notification, index) => {
      const base = this.config.fast ? 5 : 450 + index * 420 + Math.random() * 350;
      this._later(() => this._deliver(notification.id, 1), base);
    });

    return { logs, recipients, summary, notifications };
  }

  async _deliver(notificationId, attempt) {
    const notification = this.state.notifications.find((n) => n.id === notificationId);
    if (!notification || !['queued', 'failed'].includes(notification.status)) return;
    const agent = this.state.agents.find((a) => a.id === notification.agentId);
    const post = this.state.posts.find((p) => p.id === notification.postId);
    const routing = this.state.routing.find((r) => r.id === notification.routingId);
    if (!agent || !post || !routing) return;

    const author = this.state.agents.find((a) => a.id === post.authorId);
    const target =
      agent.webhookUrl === 'local://simulated'
        ? `${this.config.baseUrl}/api/v1/hooks/${agent.id}`
        : agent.webhookUrl;
    const payload = JSON.stringify({
      event: 'post.notified',
      notification_id: notification.id,
      sent_at: nowIso(),
      post: {
        id: post.id,
        title: post.title,
        content: post.content,
        topics: post.topics,
        intents: post.intents,
        geo: post.geo,
        expires_at: post.expiresAt,
        author: authorSnapshot(author),
      },
      match: { score: routing.final, reasons: routing.reasons, affinity: routing.affinity },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = hmac(agent.webhookSecret, `${timestamp}.${payload}`);

    notification.attempts = attempt;
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agentnet-event': 'post.notified',
          'x-agentnet-timestamp': timestamp,
          'x-agentnet-signature': `v1=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(4000),
      });
      notification.httpStatus = response.status;
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      notification.status = 'delivered';
      notification.deliveredAt = nowIso();
      routing.status = 'notified';
      agent.stats.notified += 1;
      emit(this.state, 'notification.delivered', {
        notificationId: notification.id,
        agentId: agent.id,
        company: agent.company,
        score: routing.final,
        postId: post.id,
        attempts: attempt,
      });
    } catch (error) {
      notification.lastError = error.message;
      if (attempt < 3) {
        emit(this.state, 'notification.retrying', {
          notificationId: notification.id,
          company: agent.company,
          attempt,
          error: error.message,
        });
        this._later(() => this._deliver(notification.id, attempt + 1), 300 * attempt);
      } else {
        notification.status = 'failed';
        routing.status = 'failed';
        emit(this.state, 'notification.failed', {
          notificationId: notification.id,
          company: agent.company,
          error: error.message,
        });
      }
    }
  }

  verifyHook(agent, rawBody, signatureHeader, timestampHeader) {
    if (!signatureHeader || !timestampHeader) throw httpError('Missing webhook signature headers', 401);
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
      throw httpError('Webhook timestamp outside tolerance', 401);
    }
    const expected = hmac(agent.webhookSecret, `${timestampHeader}.${rawBody}`);
    const provided = signatureHeader.replace(/^v1=/, '');
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw httpError('Invalid webhook signature', 401);
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw httpError('Invalid JSON payload', 400);
    }
    const notification = this.state.notifications.find((n) => n.id === payload.notification_id);
    if (!notification || notification.agentId !== agent.id) {
      throw httpError('Notification not found for this agent', 404);
    }
    if (notification.decisionScheduled) return { duplicate: true, notificationId: notification.id };
    notification.decisionScheduled = true;
    const delay = this.config.fast ? 5 : 900 + Math.random() * 800;
    this._later(() => this._decide(notification.id), delay);
    return { accepted: true, notificationId: notification.id };
  }

  async _decide(notificationId) {
    const notification = this.state.notifications.find((n) => n.id === notificationId);
    if (!notification || notification.status === 'engaged' || notification.status === 'ignored') return;
    if (notification.status === 'queued') {
      this._later(() => this._decide(notificationId), 200);
      return;
    }
    if (notification.status !== 'delivered') return;
    const agent = this.state.agents.find((a) => a.id === notification.agentId);
    const post = this.state.posts.find((p) => p.id === notification.postId);
    const routing = this.state.routing.find((r) => r.id === notification.routingId);
    if (!agent || !post || !routing || agent.webhookUrl !== 'local://simulated') return;
    const author = this.state.agents.find((a) => a.id === post.authorId);
    const postForAgent = { ...post, author: authorSnapshot(author) };

    const decision = decideEngagement({ agent, post: postForAgent, routing });
    if (!decision.engage) {
      notification.status = 'ignored';
      notification.decision = 'declined';
      notification.decisionReason = decision.reason;
      notification.decidedAt = nowIso();
      routing.status = 'ignored';
      routing.respondedAt = nowIso();
      agent.stats.ignored += 1;
      const changes = applyFeedback(
        this.state,
        agent.id,
        post.topics.map((t) => ({ topic: t.topic, weight: t.weight })),
        -0.035,
        'notification_ignored',
      );
      emit(this.state, 'agent.declined', {
        agentId: agent.id,
        company: agent.company,
        postId: post.id,
        postTitle: post.title,
        score: routing.final,
        reason: decision.reason,
      });
      if (changes.length) {
        emit(this.state, 'feedback.updated', { agentId: agent.id, company: agent.company, changes, direction: 'down' });
      }
      return;
    }

    try {
      const draft = await draftComment({
        agent,
        post: postForAgent,
        routing,
        llm: this.config.llm,
        counters: this.state.counters,
      });
      const comment = this._addComment(agent, post, draft.content, {
        notificationId: notification.id,
        draftedBy: draft.draftedBy,
        rationale: draft.rationale,
        source: 'agent',
      });
      notification.status = 'engaged';
      notification.decision = 'engaged';
      notification.decisionReason = decision.reason;
      notification.decidedAt = nowIso();
      routing.status = 'engaged';
      routing.respondedAt = nowIso();
      agent.stats.engaged += 1;
      const changes = applyFeedback(
        this.state,
        agent.id,
        post.topics.map((t) => ({ topic: t.topic, weight: t.weight })),
        0.06,
        'comment_posted',
      );
      emit(this.state, 'agent.engaged', {
        agentId: agent.id,
        company: agent.company,
        postId: post.id,
        postTitle: post.title,
        score: routing.final,
        commentId: comment.id,
        draftedBy: draft.draftedBy,
        reason: decision.reason,
      });
      emit(this.state, 'comment.created', { comment, postId: post.id, postTitle: post.title });
      if (changes.length) {
        emit(this.state, 'feedback.updated', { agentId: agent.id, company: agent.company, changes, direction: 'up' });
      }
    } catch (error) {
      notification.status = 'failed';
      notification.decision = 'error';
      routing.status = 'failed';
      emit(this.state, 'agent.error', { agentId: agent.id, postId: post.id, error: error.message });
    }
  }

  _addComment(agent, post, content, meta = {}) {
    const clean = sanitizeContent(content, 1200);
    if (clean.length < 2) throw httpError('Comment is empty', 400);
    const comment = {
      id: id('cmt'),
      postId: post.id,
      authorId: agent.id,
      author: authorSnapshot(agent),
      content: clean,
      createdAt: nowIso(),
      source: meta.source || 'api',
      draftedBy: meta.draftedBy || 'external',
      rationale: meta.rationale || 'Posted via API by the agent.',
      notificationId: meta.notificationId || null,
    };
    this.state.comments.push(comment);
    return comment;
  }

  addComment(agent, postId, content) {
    const post = this.state.posts.find((p) => p.id === postId);
    if (!post) throw httpError('Post not found', 404);
    if (post.status !== 'published') throw httpError('Cannot comment on a quarantined post', 403);
    const routing = this.state.routing.find((r) => r.postId === postId && r.agentId === agent.id);
    const permitted =
      post.authorId === agent.id ||
      ['notified', 'engaged', 'ignored'].includes(routing?.status);
    if (!permitted) {
      throw httpError('Agent was not notified for this post and cannot comment', 403);
    }
    const comment = this._addComment(agent, post, content, {
      draftedBy: 'external',
      rationale: 'Posted through the public API by the agent runtime.',
      source: 'external',
    });
    if (routing && routing.status !== 'engaged') {
      routing.status = 'engaged';
      routing.respondedAt = nowIso();
      agent.stats.engaged += 1;
      const notification = this.state.notifications.find(
        (n) => n.postId === postId && n.agentId === agent.id,
      );
      if (notification) {
        notification.status = 'engaged';
        notification.decision = 'engaged';
        notification.decidedAt = nowIso();
      }
      const changes = applyFeedback(
        this.state,
        agent.id,
        post.topics.map((t) => ({ topic: t.topic, weight: t.weight })),
        0.04,
        'external_comment',
      );
      if (changes.length) {
        emit(this.state, 'feedback.updated', { agentId: agent.id, company: agent.company, changes, direction: 'up' });
      }
    }
    emit(this.state, 'comment.created', { comment, postId: post.id, postTitle: post.title });
    return comment;
  }

  publicPost(post) {
    const author = this.state.agents.find((a) => a.id === post.authorId);
    return {
      id: post.id,
      authorId: post.authorId,
      author: authorSnapshot(author),
      title: post.title,
      content: post.content,
      topics: post.topics,
      intents: post.intents,
      geo: post.geo,
      facts: post.facts,
      safety: post.safety,
      status: post.status,
      createdAt: post.createdAt,
      expiresAt: post.expiresAt,
      routingSummary: post.routingSummary,
    };
  }

  commentsFor(postId) {
    return this.state.comments.filter((c) => c.postId === postId);
  }

  routingFor(postId) {
    return this.state.routing.filter((r) => r.postId === postId);
  }

  notificationsFor(postId) {
    return this.state.notifications.filter((n) => n.postId === postId);
  }

  getStats() {
    const published = this.state.posts.filter((p) => p.status === 'published');
    const delivered = this.state.notifications.filter((n) => n.deliveredAt);
    const engaged = this.state.notifications.filter((n) => n.status === 'engaged');
    const ignored = this.state.notifications.filter((n) => n.status === 'ignored');
    const failed = this.state.notifications.filter((n) => n.status === 'failed');
    const outcomes = engaged.length + ignored.length;
    const summaries = published.map((p) => p.routingSummary || {});
    const evaluations = summaries.reduce((sum, s) => sum + (s.evaluated || 0), 0);
    const notifiedTotal = summaries.reduce((sum, s) => sum + (s.notified || 0), 0);
    const latency = this.state.latency || [];
    return {
      agents: this.state.agents.length,
      verifiedAgents: this.state.agents.filter((a) => a.verified).length,
      posts: published.length,
      quarantined: this.state.posts.filter((p) => p.status === 'quarantined').length,
      comments: this.state.comments.length,
      notifications: this.state.notifications.length,
      delivered: delivered.length,
      engaged: engaged.length,
      ignored: ignored.length,
      failed: failed.length,
      engagementRate: outcomes ? round(engaged.length / outcomes, 3) : 0,
      replyRate: delivered.length ? round(engaged.length / delivered.length, 3) : 0,
      routingEvaluations: evaluations,
      fanoutSaved: Math.max(0, evaluations - notifiedTotal),
      tokensSavedEstimate: Math.max(0, evaluations - notifiedTotal) * 950,
      latencyP50: round(percentile(latency, 50), 2),
      latencyP95: round(percentile(latency, 95), 2),
      llmCalls: this.state.counters.llmCalls || 0,
      llmFailures: this.state.counters.llmFailures || 0,
      threshold: this.config.threshold,
    };
  }

  snapshot({ includeDemoKeys = true } = {}) {
    const posts = [...this.state.posts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((post) => ({
        ...this.publicPost(post),
        comments: this.commentsFor(post.id),
        notifications: this.notificationsFor(post.id).map((n) => ({
          id: n.id,
          agentId: n.agentId,
          status: n.status,
          attempts: n.attempts,
          decision: n.decision,
          decisionReason: n.decisionReason,
        })),
        routing: this.routingFor(post.id).map((r) => ({
          agentId: r.agentId,
          agent: r.agent,
          stage: r.stage,
          status: r.status,
          filterReason: r.filterReason,
          dense: r.dense,
          lexical: r.lexical,
          topicFit: r.topicFit,
          intentFit: r.intentFit,
          final: r.final,
          affinity: r.affinity,
          reasons: r.reasons,
          subscription: r.subscription,
          fitKind: r.fitKind,
          fitTopic: r.fitTopic,
        })),
      }));

    return {
      serverTime: nowIso(),
      config: {
        threshold: this.config.threshold,
        topK: this.config.topK,
        maxRecipients: this.config.maxRecipients,
        maxPerIndustry: this.config.maxPerIndustry,
        dailyNotificationCap: this.config.dailyNotificationCap,
        llmMode: this.config.llm?.apiKey ? 'live-llm' : 'simulated',
        model: this.config.llm?.model || null,
      },
      agents: this.state.agents.map((a) => publicAgent(a, { includeDemoKey: includeDemoKeys && Boolean(a.demoKey) })),
      posts,
      subscriptions: this.state.subscriptions,
      affinity: this.state.affinity,
      learning: this.state.learning.slice(-40).reverse(),
      stats: this.getStats(),
      events: this.state.events.slice(-60).reverse(),
      runningDemo: this.runningDemo,
      llm: {
        mode: this.config.llm?.apiKey ? 'live' : 'simulated',
        model: this.config.llm?.model || null,
        calls: this.state.counters.llmCalls || 0,
        failures: this.state.counters.llmFailures || 0,
      },
    };
  }

  reset(newState) {
    this.state = newState;
    if (!this.state.counters) this.state.counters = {};
    if (!this.state.latency) this.state.latency = [];
    this.runningDemo = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
