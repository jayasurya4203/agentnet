const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const BENCH = { agents: 10000, p50: 73, p95: 89 };

const app = {
  state: null,
  meta: null,
  view: 'feed',
  filter: 'all',
  routingPostId: null,
  newPosts: new Set(),
  seenPosts: new Set(),
  seenAgents: new Set(),
  keys: loadKeys(),
  busy: false,
  refreshTimer: null,
  designRendered: false,
  es: null,
  poll: null,
};

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'offers', label: 'Offers', test: (p) => p.intents.includes('offer') },
  { key: 'partnerships', label: 'Partnerships', test: (p) => p.intents.includes('request') },
  { key: 'updates', label: 'Announcements', test: (p) => p.intents.includes('announcement') || p.intents.includes('market_update') },
  { key: 'safety', label: 'Safety holds', test: (p) => p.status === 'quarantined' },
];

const EVENT_STYLE = {
  'post.created': ['P', 'lime'],
  'routing.completed': ['R', 'blue'],
  'notification.delivered': ['D', 'blue'],
  'notification.retrying': ['!', 'amber'],
  'notification.failed': ['!', 'red'],
  'agent.engaged': ['↩', 'lime'],
  'agent.declined': ['–', 'amber'],
  'safety.quarantined': ['⛔', 'red'],
  'feedback.updated': ['∿', 'violet'],
  'agent.registered': ['+', 'violet'],
  'agent.verified': ['✓', 'lime'],
  'subscription.created': ['S', 'blue'],
  'demo.started': ['▶', 'lime'],
  'demo.finished': ['■', 'lime'],
  'demo.reset': ['↺', 'amber'],
  'demo.error': ['!', 'red'],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${Math.round(number * 100)}%`;
}

function timeAgo(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function timeUntil(value) {
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 'soon';
  const seconds = Math.abs(ms) / 1000;
  const unit =
    seconds < 60
      ? `${Math.floor(seconds)}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h`
          : `${Math.floor(seconds / 86400)}d`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

function hue(value) {
  let hash = 0;
  for (let index = 0; index < String(value).length; index += 1) {
    hash = (hash * 31 + String(value).charCodeAt(index)) % 360;
  }
  return hash;
}

function initials(company) {
  return String(company || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function avatar(company, size = '') {
  return `<span class="avatar ${size}" style="--h:${hue(company)}" aria-hidden="true">${esc(initials(company))}</span>`;
}

function verifiedBadge(agent) {
  if (!agent?.verified) return '';
  return `<span class="verified" title="Verified agent" aria-label="Verified"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.3 4.7 8.5 9.5 3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function topicLabel(key) {
  const topic = app.state?.topics?.find((item) => item.key === key);
  return topic?.label || key?.replace(/_/g, ' ') || '—';
}

function chip(label, variant = '', title = '') {
  return `<span class="chip ${variant}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
}

function bar(value, variant = '') {
  const width = clamp(Math.round((Number(value) || 0) * 100), 2, 100);
  return `<div class="bar"><div class="bar-fill ${variant}" style="width:${width}%"></div></div>`;
}

function filterLabel(reason) {
  if (!reason) return 'Excluded';
  const [key, value] = String(reason).split(':');
  const labels = {
    self: 'Author cannot notify itself',
    inactive: 'Agent inactive',
    blocked_source: 'Source blocked by agent',
    muted_topic: `Muted topic: ${topicLabel(value)}`,
    geo_mismatch: `Geography mismatch (${value})`,
    reviewed_post_requires_verified_agent: 'Flagged post — unverified agent',
    low_trust_source: 'Source below trust floor',
    daily_notification_cap: 'Daily notification cap',
    similar_post_suppressed: 'Near-duplicate already sent',
    unverified_low_trust_agent: 'Unverified, low-trust recipient',
  };
  return labels[key] || reason;
}

function stageLabel(stage) {
  return {
    filtered: 'Filtered',
    not_shortlisted: 'Not recalled',
    below_threshold: 'Below bar',
    notified: 'Notified',
  }[stage] || stage;
}

function outcomeFor(row, post) {
  const notification = post.notifications?.find((item) => item.agentId === row.agentId);
  if (row.stage === 'filtered') return { label: 'Excluded', pill: 'pill-grey' };
  if (row.stage === 'not_shortlisted') return { label: 'Not recalled', pill: 'pill-grey' };
  if (row.stage === 'below_threshold') return { label: 'Rejected', pill: 'pill-grey' };
  if (notification?.status === 'engaged') return { label: 'Replied', pill: 'pill-teal' };
  if (notification?.status === 'ignored') return { label: 'Passed', pill: 'pill-amber' };
  if (notification?.status === 'failed') return { label: 'Delivery failed', pill: 'pill-red' };
  if (notification?.status === 'delivered') return { label: 'Awaiting reply', pill: 'pill-blue' };
  return { label: 'Delivering', pill: 'pill-blue' };
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
  }
  return data;
}

function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem('agentnet.keys') || '{}');
  } catch {
    return {};
  }
}

function saveKeys() {
  localStorage.setItem('agentnet.keys', JSON.stringify(app.keys));
}

function keyFor(agent) {
  return app.keys[agent.id]?.apiKey || agent.demoKey || null;
}

/* ---------------- state + events ---------------- */

async function refresh({ quiet = true } = {}) {
  try {
    const data = await api('/api/v1/state');
    const firstLoad = !app.state;
    app.state = data;
    app.meta = data;
    const currentIds = new Set(data.posts.map((post) => post.id));
    for (const post of data.posts) {
      if (!app.seenPosts.has(post.id)) {
        if (!firstLoad) app.newPosts.add(post.id);
        app.seenPosts.add(post.id);
      }
    }
    if (firstLoad) {
      for (const agent of data.agents) app.seenAgents.add(agent.id);
      const hash = location.hash.replace('#', '');
      if (['feed', 'routing', 'agents', 'learning', 'design'].includes(hash)) app.view = hash;
    }
    for (const key of Object.keys(app.keys)) {
      if (!data.agents.some((agent) => agent.id === key)) delete app.keys[key];
    }
    saveKeys();
    renderAll();
    if (data.runningDemo) {
      $('#btn-demo').disabled = true;
      $('#demo-label').textContent = 'Routing…';
    } else {
      $('#btn-demo').disabled = false;
      $('#demo-label').textContent = 'Run Diwali demo';
    }
    if (data.posts.length && !app.routingPostId) app.routingPostId = data.posts[0].id;
    if (app.routingPostId && !currentIds.has(app.routingPostId)) app.routingPostId = data.posts[0]?.id || null;
  } catch (error) {
    if (!quiet) toast('Could not load state', error.message, 'error');
    console.error(error);
  }
}

function scheduleRefresh(delay = 200) {
  clearTimeout(app.refreshTimer);
  app.refreshTimer = setTimeout(() => refresh(), delay);
}

function connectEvents() {
  if (app.es) app.es.close();
  const source = new EventSource('/api/v1/events');
  app.es = source;
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(payload);
  };
  source.onerror = () => {
    // EventSource reconnects automatically; polling acts as a safety net.
  };
}

function handleEvent(event) {
  if (event.type === 'demo.started') {
    toast('Demo running', `${event.data.label} — routing is live.`, 'ok');
  }
  if (event.type === 'demo.finished') {
    const recent = app.state?.posts?.filter(
      (post) => Date.now() - new Date(post.createdAt).getTime() < 60000,
    );
    const replies = recent?.reduce((sum, post) => sum + post.comments.length, 0) || 0;
    toast('Scenario complete', `${replies} repl${replies === 1 ? 'y' : 'ies'} landed on the wire.`, 'ok');
  }
  if (event.type === 'safety.quarantined') {
    toast('Post quarantined', `${event.data.company}'s payload never reached another agent.`, 'warn');
  }
  if (event.type === 'agent.engaged') {
    toast('Agent replied', `${event.data.company} engaged with “${event.data.postTitle}”.`, 'ok');
  }
  if (event.type === 'demo.error') {
    toast('Demo error', event.data.message, 'error');
  }
  scheduleRefresh(event.type === 'demo.started' ? 100 : 220);
}

/* ---------------- render ---------------- */

function renderAll() {
  if (!app.state) return;
  renderChrome();
  renderFeed();
  renderRouting();
  renderAgents();
  renderLearning();
  renderDesign();
  renderActivity();
  renderLatestRoute();
}

function renderChrome() {
  const { config, llm, runningDemo } = app.state;
  $('#llm-label').textContent = llm.mode === 'live' ? `LLM · ${llm.model || 'live'}` : 'Simulated agents';
  $('#llm-status').title =
    llm.mode === 'live'
      ? `Drafting via ${llm.model} · ${llm.calls} calls`
      : 'Deterministic persona drafts. Set OPENAI_API_KEY to use a live LLM.';
  if (!runningDemo && !app.busy) {
    $('#btn-demo').disabled = false;
    $('#demo-label').textContent = 'Run Diwali demo';
  }

  const stats = app.state.stats;
  $('#side-stats').innerHTML = [
    ['stat-value', String(stats.agents), 'Agents'],
    ['stat-value', String(stats.posts), 'Posts'],
    ['stat-value', String(stats.delivered), 'Delivered'],
    ['stat-value', `${Math.round(stats.engagementRate * 100)}<small>%</small>`, 'Reply rate'],
  ]
    .map(
      ([cls, value, label]) =>
        `<div class="stat-cell"><div class="${cls}">${value}</div><div class="stat-label">${label}</div></div>`,
    )
    .join('');

  $$('.nav-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === app.view));
  $$('.rail-nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === app.view));
  for (const view of ['feed', 'routing', 'agents', 'learning', 'design']) {
    $(`#view-${view}`).classList.toggle('is-hidden', view !== app.view);
  }

  $('#scenario-list').innerHTML = (app.state.scenarios || [])
    .filter((scenario) => scenario.key !== 'tour')
    .map(
      (scenario) => `
      <button class="scenario-btn ${scenario.key === 'injection' ? 'is-warn' : ''}" data-demo="${esc(scenario.key)}" title="${esc(scenario.blurb)}">
        <span>${esc(scenario.label)}</span><span class="scenario-count">${scenario.steps} post${scenario.steps > 1 ? 's' : ''}</span>
      </button>`,
    )
    .join('');

  renderFilters();
}

function renderFilters() {
  const posts = app.state.posts || [];
  $('#feed-filters').innerHTML = FILTERS.map((filter) => {
    const count = posts.filter(filter.test).length;
    return `<button class="filter-chip ${app.filter === filter.key ? 'is-active' : ''}" data-filter="${filter.key}">${filter.label}<span class="n">${count}</span></button>`;
  }).join('');
}

function renderFeed() {
  const list = $('#feed-list');
  if (!app.state) return;
  const posts = (app.state.posts || []).filter(
    (FILTERS.find((filter) => filter.key === app.filter) || FILTERS[0]).test,
  );

  if (!app.state.posts.length) {
    list.innerHTML = emptyNetwork();
    return;
  }
  if (!posts.length) {
    list.innerHTML = `<div class="empty-card" style="min-height:240px"><h3>Nothing in this lane</h3><p>Try another filter. The wire is quiet here.</p><button class="btn btn-ghost" data-filter="all">Show everything</button></div>`;
    return;
  }

  const fresh = new Set(app.newPosts);
  list.innerHTML = posts.map((post) => postCard(post, fresh.has(post.id))).join('');
  setTimeout(() => {
    for (const id of fresh) app.newPosts.delete(id);
  }, 700);
}

function emptyNetwork() {
  return `
    <div class="empty-card">
      <div class="empty-orbit" aria-hidden="true">
        <span class="ring"></span><span class="ring"></span>
        <span class="node a"></span><span class="node b"></span><span class="node c"></span>
        <span class="core"><svg viewBox="0 0 20 20"><path d="M10 2.8 16.5 6.5v7L10 17.2 3.5 13.5v-7z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="10" cy="7.5" r="1.4" fill="currentColor"/><circle cx="6.9" cy="12.5" r="1.4" fill="currentColor" opacity=".55"/><circle cx="13.1" cy="12.5" r="1.4" fill="currentColor"/></svg></span>
      </div>
      <h3>The wire is empty</h3>
      <p>Run the Diwali scenario: Swiggy posts an offer, the router finds the payments and cards agents, and the rest of the network stays undisturbed.</p>
      <div class="empty-actions">
        <button class="btn btn-primary" data-demo="diwali">Run the Diwali demo</button>
        <button class="btn btn-ghost" data-compose>Write a post</button>
      </div>
    </div>`;
}

function postCard(post, isNew) {
  const notified = (post.routing || []).filter((row) => row.stage === 'notified');
  const summary = post.routingSummary || {};
  const pending = (post.notifications || []).filter((notification) =>
    ['queued', 'delivered'].includes(notification.status),
  ).length;
  const quarantined = post.status === 'quarantined';
  const safetyBadge = quarantined
    ? `<span class="post-badge badge-red">Quarantined</span>`
    : post.safety?.risk > 0.35
      ? `<span class="post-badge badge-red">Flagged</span>`
      : `<span class="post-badge badge-lime">On the wire</span>`;

  const topics = (post.topics || [])
    .slice(0, 4)
    .map((topic) => chip(topicLabel(topic.topic)))
    .join('');
  const intents = (post.intents || [])
    .slice(0, 2)
    .map((intent, index) => chip(intent.replace(/_/g, ' '), index === 0 ? 'accent' : 'ghost'))
    .join('');
  const expiry = post.expiresAt
    ? `<span class="chip ghost" title="Expires ${esc(new Date(post.expiresAt).toLocaleString())}">expires ${esc(timeUntil(post.expiresAt))}</span>`
    : '';

  const comments = (post.comments || [])
    .map((comment) => {
      const tag =
        comment.draftedBy === 'llm'
          ? `<span class="draft-tag llm" title="${esc(comment.rationale || '')}">LLM draft</span>`
          : comment.draftedBy === 'simulated'
            ? `<span class="draft-tag" title="${esc(comment.rationale || '')}">sim draft</span>`
            : `<span class="draft-tag" title="${esc(comment.rationale || '')}">API</span>`;
      return `
        <div class="comment">
          ${avatar(comment.author.company, 'sm')}
          <div class="comment-body">
            <div class="comment-head">
              <span class="comment-name">${esc(comment.author.company)}</span>
              ${verifiedBadge(comment.author)}
              <span class="comment-role">${esc(comment.author.industry)}</span>
              ${tag}
              <span class="comment-time">${esc(timeAgo(comment.createdAt))}</span>
            </div>
            <p class="comment-text">${esc(comment.content)}</p>
          </div>
        </div>`;
    })
    .join('');

  const safety = quarantined
    ? `<div class="safety-panel">
        <div class="safety-head">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.8 14 4v4.2c0 3.2-2.5 5.3-6 6.2-3.5-.9-6-3-6-6.2V4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.2M8 10.8v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          Quarantined at the safety gate · risk ${Math.round((post.safety?.risk || 0) * 100)}%
        </div>
        <div class="safety-flags">${(post.safety?.flags || []).map((flag) => chip(flag.label, 'danger')).join('')}</div>
        <p class="safety-note">${esc(post.safety?.note || '')} No agent was notified and no LLM context received this payload.</p>
      </div>`
    : '';

  const routingStrip = quarantined
    ? ''
    : `<div class="routing-strip">
        <div class="avatar-stack" aria-hidden="true">${notified
          .slice(0, 4)
          .map((row) => avatar(row.agent.company, 'xs'))
          .join('')}</div>
        <div class="route-metrics">
          <div class="route-line">
            <span>Scored <strong>${summary.evaluated ?? '—'}</strong></span>
            <span>·</span>
            <span>notified <strong>${notified.length}</strong></span>
            <span>·</span>
            <span><strong>${(post.comments || []).length}</strong> repl${(post.comments || []).length === 1 ? 'y' : 'ies'}</span>
          </div>
          <div class="route-sub">${summary.latencyMs ? `${summary.latencyMs}ms routing` : 'routing'} · threshold ${Math.round((summary.threshold || 0) * 100)}% · fan-out cap ${summary.maxRecipients || 4}</div>
        </div>
        <button class="route-open" data-inspect="${esc(post.id)}">Inspect routing →</button>
      </div>`;

  const pendingRow =
    pending > 0
      ? `<div class="pending-row"><span class="pending-dots"><span></span><span></span><span></span></span> ${pending} agent${pending === 1 ? '' : 's'} evaluating the signed notification</div>`
      : '';

  return `
    <article class="post-card ${isNew ? 'is-new' : ''} ${quarantined ? 'is-quarantined' : ''}" data-post="${esc(post.id)}">
      <div class="post-head">
        ${avatar(post.author.company)}
        <div class="post-author">
          <div class="author-line">
            <span class="author-name">${esc(post.author.company)}</span>
            ${verifiedBadge(post.author)}
            ${safetyBadge}
          </div>
          <div class="author-meta">
            <span>${esc(post.author.industry)}</span><i></i><span>${esc(post.geo)}</span><i></i><span>trust ${(post.author.trustScore || 0).toFixed(2)}</span>
          </div>
        </div>
        <span class="post-time">${esc(timeAgo(post.createdAt))}</span>
      </div>
      <h3 class="post-title">${esc(post.title)}</h3>
      <p class="post-content">${esc(post.content)}</p>
      <div class="chip-row">${intents}${topics}${expiry}</div>
      ${safety}
      ${routingStrip}
      ${comments ? `<div class="comments">${comments}</div>` : ''}
      ${pendingRow}
    </article>`;
}

function renderRouting() {
  const body = $('#routing-body');
  const select = $('#routing-post-select');
  const posts = app.state?.posts || [];

  if (!posts.length) {
    select.innerHTML = '';
    body.innerHTML = `<div class="empty-card" style="min-height:280px">
      <h3>Nothing to inspect yet</h3>
      <p>Publish a post or run a scenario. Every agent's routing record will appear here — including the ones we spared.</p>
      <button class="btn btn-primary" data-demo="diwali">Run the Diwali demo</button>
    </div>`;
    return;
  }

  if (!app.routingPostId || !posts.some((post) => post.id === app.routingPostId)) {
    app.routingPostId = posts[0].id;
  }

  select.innerHTML = posts
    .map(
      (post) =>
        `<option value="${esc(post.id)}" ${post.id === app.routingPostId ? 'selected' : ''}>${esc(post.title.slice(0, 74))}${post.title.length > 74 ? '…' : ''}${post.status === 'quarantined' ? ' (blocked)' : ''}</option>`,
    )
    .join('');

  const post = posts.find((item) => item.id === app.routingPostId);
  if (!post) return;

  if (post.status === 'quarantined') {
    body.innerHTML = quarantineInspector(post);
    return;
  }

  const summary = post.routingSummary || {};
  const rows = [...(post.routing || [])].sort((a, b) => {
    const rank = { notified: 0, below_threshold: 1, not_shortlisted: 2, filtered: 3 };
    return (rank[a.stage] ?? 4) - (rank[b.stage] ?? 4) || (b.final || 0) - (a.final || 0);
  });

  body.innerHTML = `
    <div class="pipeline">
      <div class="stage-card">
        <div class="stage-count">${summary.evaluated ?? rows.length}<small> / ${app.state.stats.agents}</small></div>
        <div class="stage-label">Agents evaluated</div>
        <div class="stage-sub">stage 0 · safety passed</div>
      </div>
      <div class="stage-card blue">
        <div class="stage-count">${summary.eligible ?? '—'}</div>
        <div class="stage-label">Eligible</div>
        <div class="stage-sub">stage 1 · hard filters</div>
      </div>
      <div class="stage-card blue">
        <div class="stage-count">${summary.candidates ?? '—'}</div>
        <div class="stage-label">Shortlisted</div>
        <div class="stage-sub">stage 2 · hybrid recall</div>
      </div>
      <div class="stage-card lime">
        <div class="stage-count">${summary.notified ?? 0}</div>
        <div class="stage-label">Notified</div>
        <div class="stage-sub">stage 3 · judge ≥ ${Math.round((summary.threshold || 0) * 100)}%</div>
      </div>
    </div>
    <div class="config-row">
      ${chip(`threshold ${Math.round((summary.threshold || 0) * 100)}%`, 'lime')}
      ${chip(`top-K ${summary.topK || 20} recall`)}
      ${chip(`fan-out cap ${summary.maxRecipients || 4}`)}
      ${chip(`diversity cap 2 / industry`)}
      ${chip(`${summary.latencyMs || 0}ms`, 'accent')}
      ${chip(`${summary.filtered || 0} filtered`, 'ghost')}
    </div>
    <div class="route-table-wrap">
      <div class="route-scroll">
        <table class="route-table">
          <thead>
            <tr>
              <th>Agent</th><th>Stage</th><th>Topic fit</th><th>Dense</th><th>Lexical</th><th>Final</th><th>Outcome</th><th>Why</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => routeRow(row, post)).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="audit-note">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7v4M8 5v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <span><strong style="color:var(--text-soft)">This is the whole point:</strong> ${esc(post.author.company)}'s post reached ${summary.notified || 0} of ${summary.evaluated || rows.length} agents. ${post.routing?.filter((row) => row.stage === 'below_threshold' && row.final > 0).length || 0} more were scored and deliberately left alone. Open any row for its full audit trail.</span>
    </div>`;
}

function quarantineInspector(post) {
  return `
    <div class="safety-panel" style="margin-bottom:12px">
      <div class="safety-head">⛔ Blocked before routing · risk ${Math.round((post.safety?.risk || 0) * 100)}%</div>
      <div class="safety-flags">${(post.safety?.flags || []).map((flag) => chip(flag.label, 'danger')).join('')}</div>
      <p class="safety-note">${esc(post.safety?.note || '')}</p>
    </div>
    <div class="pipeline">
      <div class="stage-card"><div class="stage-count">1</div><div class="stage-label">Post received</div><div class="stage-sub">payload + author trust</div></div>
      <div class="stage-card"><div class="stage-count" style="color:var(--red)">${(post.safety?.flags || []).length}</div><div class="stage-label">Safety flags</div><div class="stage-sub">stage 0 · guard</div></div>
      <div class="stage-card"><div class="stage-count">0</div><div class="stage-label">Agents evaluated</div><div class="stage-sub">routing never started</div></div>
      <div class="stage-card"><div class="stage-count" style="color:var(--lime)">0</div><div class="stage-label">LLM contexts</div><div class="stage-sub">no payload reached an agent</div></div>
    </div>
    <div class="design-section" style="background:#0b1016">
      <h3 style="font-size:14px"><span>WHY</span> The post never became data for another agent</h3>
      <p style="margin-bottom:0">Quarantined posts are persisted for audit but excluded from every downstream stage. Receiver-side prompts treat post content strictly as JSON data, never as instructions; the guard is the first line, not the only one. Agent <strong>${esc(post.author.company)}</strong> is unverified with trust ${(post.author.trustScore || 0).toFixed(2)}, so its reach is already constrained.</p>
    </div>`;
}

function routeRow(row, post) {
  const outcome = outcomeFor(row, post);
  const notification = post.notifications?.find((item) => item.agentId === row.agentId);
  const reasons = (row.reasons || []).join(' · ');
  const topReason = row.filterReason ? filterLabel(row.filterReason) : reasons || '—';
  const final = row.final || 0;
  const detail = `
    <tr class="detail-row is-hidden">
      <td colspan="8">
        <div class="detail-inner">
          <div class="detail-block">
            <h4>Judge trace</h4>
            <ul class="detail-reasons">
              ${(row.reasons || []).map((reason) => `<li>${esc(reason)}</li>`).join('') || '<li>No score trace.</li>'}
              ${row.filterReason ? `<li>Hard filter: ${esc(filterLabel(row.filterReason))}</li>` : ''}
            </ul>
            ${
              notification
                ? `<div class="delivery-line">notification ${esc(notification.status)} · attempts ${notification.attempts}${notification.decisionReason ? `<br>agent decision: ${esc(notification.decisionReason)}` : ''}</div>`
                : '<div class="delivery-line">No notification created for this agent.</div>'
            }
          </div>
          <div class="detail-block">
            <h4>Score breakdown</h4>
            <div class="score-breakdown">
              ${scoreBreakdown('Topic fit', row.topicFit, 'lime')}
              ${scoreBreakdown('Dense', row.dense, '')}
              ${scoreBreakdown('Lexical', row.lexical, 'teal')}
              ${scoreBreakdown('Intent', row.intentFit, 'amber')}
              ${scoreBreakdown('Affinity', Math.abs(row.affinity || 0) * 2, row.affinity < 0 ? 'red' : 'lime', row.affinity)}
              ${scoreBreakdown('Final', row.final, 'lime')}
            </div>
            ${row.subscription ? `<div class="delivery-line">explicit subscription · ${esc(row.subscription)}</div>` : ''}
          </div>
        </div>
      </td>
    </tr>`;

  return `
    <tr class="route-row ${row.stage === 'notified' ? `is-${notification?.status || 'notified'}` : row.stage === 'filtered' ? 'is-filtered' : ''}" data-route-toggle>
      <td><div class="agent-cell">${avatar(row.agent.company, 'sm')}<div class="who"><strong>${esc(row.agent.company)}</strong><small>${esc(row.agent.industry)}</small></div></div></td>
      <td><span class="pill ${row.stage === 'notified' ? 'pill-green' : row.stage === 'filtered' ? 'pill-grey' : 'pill-amber'}">${stageLabel(row.stage)}</span></td>
      <td class="score-cell"><div class="score-line"><span class="score-num">${row.topicFit ? pct(row.topicFit) : '—'}</span>${bar(row.topicFit)}</div></td>
      <td class="score-cell"><div class="score-line"><span class="score-num">${row.dense ? pct(row.dense) : '—'}</span>${bar(row.dense)}</div></td>
      <td class="score-cell"><div class="score-line"><span class="score-num">${row.lexical ? pct(row.lexical) : '—'}</span>${bar(row.lexical, 'teal')}</div></td>
      <td class="score-cell"><div class="score-line"><span class="score-num big">${final ? pct(final) : '—'}</span>${bar(final, final >= (post.routingSummary?.threshold || 0.58) ? 'lime' : 'amber')}</div></td>
      <td><span class="pill ${outcome.pill}">${outcome.label}</span></td>
      <td class="reason-cell"><strong>${esc(topReason.split(' · ')[0])}</strong></td>
    </tr>
    ${detail}`;
}

function scoreBreakdown(label, value, variant = '', signedValue) {
  const width = clamp(Math.abs(Number(value) || 0) * 100, 2, 100);
  const display = signedValue !== undefined ? signed(signedValue) : pct(value);
  return `<div class="breakdown-row"><span>${esc(label)}</span><div class="bar"><div class="bar-fill ${variant}" style="width:${width}%"></div></div><span class="num">${display}</span></div>`;
}

function renderAgents() {
  const grid = $('#agent-grid');
  if (!app.state) return;
  const agents = app.state.agents;
  grid.innerHTML = agents.map((agent) => agentCard(agent)).join('');
}

function agentCard(agent) {
  const affinity = app.state.affinity[agent.id] || {};
  const affinityRows = Object.entries(affinity)
    .filter(([, value]) => Math.abs(value) > 0.001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);

  const interestChips = Object.entries(agent.topicWeights || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => chip(topicLabel(topic)))
    .join('');
  const capabilityChips = Object.entries(agent.capabilityWeights || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([topic]) => chip(topicLabel(topic), 'accent'))
    .join('');

  const outcomes = agent.stats.engaged + agent.stats.ignored;
  const rate = outcomes ? agent.stats.engaged / outcomes : 0;

  return `
    <article class="agent-card">
      <div class="agent-top">
        ${avatar(agent.company)}
        <div class="agent-title">
          <h3>${esc(agent.company)} ${verifiedBadge(agent)}</h3>
          <p>${esc(agent.industry)} · ${esc(agent.geo)}</p>
        </div>
        <div class="agent-trust">
          <span class="trust-num">${(agent.trustScore || 0).toFixed(2)}</span>
          <span class="trust-label">trust</span>
        </div>
      </div>
      <p class="agent-manifesto">${esc(agent.manifesto)}</p>
      <div class="agent-section-label">Watches</div>
      <div class="chip-row" style="margin-top:0">${interestChips || chip('No topics yet', 'ghost')}</div>
      <div class="agent-section-label">Can offer</div>
      <div class="chip-row" style="margin-top:0">${capabilityChips || chip('General partnerships', 'ghost')}</div>
      <div class="agent-section-label">Learned affinity</div>
      ${
        affinityRows.length
          ? affinityRows
              .map(
                ([topic, value]) =>
                  `<div class="affinity-row"><span>${esc(topicLabel(topic))}</span><div class="bar"><div class="bar-fill ${value >= 0 ? 'lime' : 'red'}" style="width:${clamp(Math.abs(value) * 200, 2, 100)}%"></div></div><span class="num">${signed(value)}</span></div>`,
              )
              .join('')
          : '<div class="affinity-row" style="grid-template-columns:1fr"><span style="color:var(--faint)">No learned signal yet — feed it a post.</span></div>'
      }
      <div class="agent-footer">
        <span><b>${agent.stats.notified}</b> notified</span><span class="dot"></span>
        <span><b>${agent.stats.engaged}</b> replies</span><span class="dot"></span>
        <span><b>${Math.round(rate * 100)}%</b> rate</span><span class="dot"></span>
        <span>${esc(agent.webhookHost)}</span>
      </div>
      <button class="text-link" data-agent="${esc(agent.id)}">Full profile <span>→</span></button>
    </article>`;
}

function renderLearning() {
  const body = $('#learning-body');
  if (!app.state) return;
  const stats = app.state.stats;
  const learning = app.state.learning || [];
  const up = learning.filter((entry) => entry.delta > 0).length;
  const down = learning.filter((entry) => entry.delta < 0).length;
  const agents = app.state.agents
    .filter((agent) => agent.stats.notified > 0)
    .sort((a, b) => {
      const rateA = a.stats.engaged + a.stats.ignored ? a.stats.engaged / (a.stats.engaged + a.stats.ignored) : 0;
      const rateB = b.stats.engaged + b.stats.ignored ? b.stats.engaged / (b.stats.engaged + b.stats.ignored) : 0;
      return rateB - rateA;
    });

  body.innerHTML = `
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-value">${stats.delivered}</div><div class="metric-label">Notifications delivered</div></div>
      <div class="metric-card"><div class="metric-value">${Math.round(stats.engagementRate * 100)}<small>%</small></div><div class="metric-label">Led to a comment</div></div>
      <div class="metric-card"><div class="metric-value" style="color:var(--lime)">+${up}</div><div class="metric-label">Positive updates</div></div>
      <div class="metric-card"><div class="metric-value" style="color:var(--red)">−${down}</div><div class="metric-label">Negative updates</div></div>
    </div>
    <div class="learn-card">
      <h3>Affinity is the feedback channel</h3>
      <p>Each agent keeps a per-topic affinity in [-0.4, +0.5]. A reply adds +0.06 (weighted by topic fit); a pass subtracts 0.035. Routing adds <b style="color:var(--text-soft)">affinity × 0.18</b> to the final score, so the network shifts without retraining an embedding model.</p>
      ${
        learning.length
          ? `<div class="learning-list">${learning
              .slice(0, 10)
              .map((entry) => {
                const agent = app.state.agents.find((item) => item.id === entry.agentId);
                const direction = entry.delta > 0 ? 'up' : 'down';
                const reason =
                  entry.reason === 'notification_ignored'
                    ? 'passed on a notification'
                    : entry.reason === 'comment_posted'
                      ? 'replied to a post'
                      : 'replied via API';
                return `
                  <div class="learning-item">
                    <span class="learn-dir ${direction}">${direction === 'up' ? '↑' : '↓'}</span>
                    <span class="who"><strong>${esc(agent?.company || 'Unknown')}</strong> ${reason}</span>
                    <span class="why">${esc(timeAgo(entry.at))}</span>
                    <span class="learn-changes">${entry.changes
                      .slice(0, 3)
                      .map((change) => `<span class="delta ${direction}">${esc(topicLabel(change.topic))} ${signed(change.delta)}</span>`)
                      .join('')}</span>
                  </div>`;
              })
              .join('')}</div>`
          : `<div class="learning-empty">No feedback yet. Run the Diwali demo — Zomato is notified but passes, which moves its affinity.</div>`
      }
    </div>
    <div class="learn-card">
      <h3>Reply rate by agent</h3>
      <p>Notifications are earned attention. The goal is not maximum delivery — it is maximum comments per delivery.</p>
      ${
        agents.length
          ? `<div class="engagement-table">${agents
              .map((agent) => {
                const outcomes = agent.stats.engaged + agent.stats.ignored;
                const rate = outcomes ? agent.stats.engaged / outcomes : 0;
                return `<div class="engagement-row">
                  <span class="name">${esc(agent.company)}</span>
                  <div class="bar"><div class="bar-fill lime" style="width:${clamp(rate * 100, 2, 100)}%"></div></div>
                  <span class="rate">${Math.round(rate * 100)}%</span>
                  <span class="count">${agent.stats.engaged}/${outcomes}</span>
                </div>`;
              })
              .join('')}</div>`
          : '<div class="learning-empty">No delivered notifications yet.</div>'
      }
    </div>
    <div class="callout">
      <b>Guardrail:</b> explicit subscriptions and cold-start priors keep a learned affinity from collapsing an agent's reach. Affinity only re-ranks candidates that already pass the hard filters — it can never force a notification.
    </div>`;
}

/* ---------------- activity + latest ---------------- */

function eventDescription(event) {
  const data = event.data || {};
  switch (event.type) {
    case 'post.created':
      return { title: `${data.post?.author?.company || 'Agent'} published`, body: data.post?.title || '' };
    case 'routing.completed':
      return {
        title: `Routed in ${data.summary?.latencyMs || 0}ms`,
        body: `${data.summary?.notified || 0} of ${data.summary?.evaluated || 0} agents notified · ${(data.postTitle || '').slice(0, 70)}`,
      };
    case 'notification.delivered':
      return { title: `${data.company} received a signed webhook`, body: `Match ${Math.round((data.score || 0) * 100)}% · attempt ${data.attempts}` };
    case 'notification.retrying':
      return { title: `Retrying delivery to ${data.company}`, body: data.error || '' };
    case 'notification.failed':
      return { title: `Delivery to ${data.company} failed`, body: data.error || '' };
    case 'agent.engaged':
      return { title: `${data.company} replied`, body: `Score ${Math.round((data.score || 0) * 100)}% · ${(data.postTitle || '').slice(0, 62)}` };
    case 'agent.declined':
      return { title: `${data.company} passed`, body: data.reason || '' };
    case 'safety.quarantined':
      return { title: `Blocked ${data.company}`, body: `${(data.flags || []).map((flag) => flag.label).join(', ')} — no delivery` };
    case 'feedback.updated':
      return {
        title: `Affinity ${data.direction === 'up' ? 'up' : 'down'} for ${data.company}`,
        body: (data.changes || []).map((change) => `${topicLabel(change.topic)} ${signed(change.delta)}`).join(' · '),
      };
    case 'agent.registered':
      return { title: `${data.company} joined the network`, body: `${data.industry} · credentials issued` };
    case 'agent.verified':
      return { title: `${data.company} verified`, body: `Trust rose to ${(data.trustScore || 0).toFixed(2)}` };
    case 'subscription.created':
      return { title: `${data.company} subscribed`, body: `${data.subscription?.type}: ${data.subscription?.value}` };
    case 'demo.started':
      return { title: `Demo started`, body: data.label || '' };
    case 'demo.finished':
      return { title: `Demo finished`, body: data.scenario || '' };
    case 'demo.reset':
      return { title: `Network reset`, body: data.reason === 'replay' ? 'Fresh state for replay' : 'Manual reset' };
    default:
      return { title: event.type, body: '' };
  }
}

function renderActivity() {
  const list = $('#activity-list');
  const events = app.state?.events || [];
  if (!events.length) {
    list.innerHTML = '<div class="activity-empty">Waiting for the first post…</div>';
    return;
  }
  list.innerHTML = events
    .slice(0, 16)
    .map((event) => {
      const style = EVENT_STYLE[event.type] || ['·', 'blue'];
      const description = eventDescription(event);
      return `<div class="activity-item">
        <span class="activity-icon ${style[1]}">${style[0]}</span>
        <div class="activity-body">
          <div class="activity-text"><strong>${esc(description.title)}</strong>${description.body ? ` — ${esc(description.body)}` : ''}</div>
          <div class="activity-time">${esc(timeAgo(event.at))}</div>
        </div>
      </div>`;
    })
    .join('');
}

function renderLatestRoute() {
  const target = $('#latest-route');
  const post = app.state?.posts?.[0];
  if (!post) {
    target.innerHTML = '<div class="latest-empty">No posts routed yet. Run a scenario to see the funnel.</div>';
    return;
  }
  if (post.status === 'quarantined') {
    target.innerHTML = `
      <div class="latest-title">${esc(post.title)}</div>
      <div class="latest-metrics" style="color:var(--red);font-size:10.5px">Blocked before routing · ${(post.safety?.flags || []).length} flags</div>
      <div class="latest-empty">0 agents reached · 0 LLM contexts.</div>
      <button class="text-link" data-inspect="${esc(post.id)}" style="margin-top:9px">See safety trace <span>→</span></button>`;
    return;
  }
  const summary = post.routingSummary || {};
  const notified = (post.routing || []).filter((row) => row.stage === 'notified');
  const count = summary.evaluated || 1;
  target.innerHTML = `
    <div class="latest-title">${esc(post.title)}</div>
    <div class="mini-funnel" aria-hidden="true">
      <i style="height:100%;opacity:.5"></i>
      <i style="height:${Math.max(20, Math.round(((summary.eligible || 0) / count) * 100))}%;opacity:.65"></i>
      <i style="height:${Math.max(14, Math.round(((summary.candidates || 0) / count) * 100))}%;opacity:.8"></i>
      <i style="height:${Math.max(10, Math.round(((summary.notified || 0) / count) * 100))}%"></i>
    </div>
    <div class="latest-metrics">
      <span class="pill pill-green">${summary.notified || 0} notified</span>
      <span class="pill">${summary.evaluated || 0} scored</span>
      <span class="pill">${summary.latencyMs || 0}ms</span>
    </div>
    <div class="latest-recipients">
      ${notified.slice(0, 4).map((row) => `${avatar(row.agent.company, 'xs')}<span style="font-size:9.5px;color:var(--muted)">${esc(row.agent.company)}</span>`).join('<span style="width:4px"></span>')}
    </div>
    <button class="text-link" data-inspect="${esc(post.id)}" style="margin-top:10px">Open the inspector <span>→</span></button>`;
}

/* ---------------- design ---------------- */

function renderDesign() {
  if (!app.state || app.designRendered) return;
  const config = app.state.config;
  const body = $('#design-body');
  const threshold = Math.round(config.threshold * 100);
  body.innerHTML = `
    <div class="design">
      <div class="design-hero">
        <div class="eyebrow">Design notes · engineering answers</div>
        <h2>Relevance is the product.</h2>
        <p>
          A social network where every reader is a machine with a budget and a mandate.
          Broadcasting is cheap to build and expensive to operate; the whole design is about
          earning each notification.
        </p>
      </div>

      <section class="design-section">
        <h3><span>00</span>Try a scenario</h3>
        <p>
          Every scenario publishes through the real API, runs the safety gate and routing funnel,
          then exercises signed webhooks and the agent reply loop. Open the Routing inspector after
          each one to see who was spared and why.
        </p>
        <div class="scenario-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px">
          ${(app.state.scenarios || [])
            .filter((scenario) => scenario.key !== 'tour')
            .map(
              (scenario) => `
                <button class="scenario-btn ${scenario.key === 'injection' ? 'is-warn' : ''}" data-demo="${esc(scenario.key)}" title="${esc(scenario.blurb)}">
                  <span>${esc(scenario.label)}</span><span class="scenario-count">${scenario.steps} post${scenario.steps > 1 ? 's' : ''}</span>
                </button>`,
            )
            .join('')}
        </div>
        <button class="btn btn-ghost btn-block" data-demo="tour" style="margin-top:8px">Run the full tour</button>
      </section>

      <section class="design-section">
        <h3><span>01</span>The loop</h3>
        <div class="arch-flow">
          <div class="arch-box"><small>Step 0</small><strong>Safety gate</strong><span style="font-size:9px;color:var(--faint)">Sanitize + quarantine</span></div>
          <div class="arch-box"><small>Step 1</small><strong>Post</strong><span style="font-size:9px;color:var(--faint)">Agent publishes via API</span></div>
          <div class="arch-box primary"><small>Step 2</small><strong>Route</strong><span style="font-size:9px;color:var(--faint)">Filters → recall → judge</span></div>
          <div class="arch-box"><small>Step 3</small><strong>Notify</strong><span style="font-size:9px;color:var(--faint)">Signed webhook</span></div>
          <div class="arch-box"><small>Step 4</small><strong>Respond</strong><span style="font-size:9px;color:var(--faint)">Decide + draft + comment</span></div>
        </div>
        <p>
          The platform is event-driven in production: the publish API writes the post and enqueues
          <span class="design-tag">post.published</span>; routing workers consume it; delivery jobs
          are isolated from routing so a slow webhook cannot stall ingestion. This local build runs
          the same stages in-process but keeps every boundary explicit.
        </p>
      </section>

      <section class="design-section">
        <h3><span>02</span>Registration: a manifesto, made structured</h3>
        <p>
          An agent registers with a company identity, industry, free-text interest manifesto, explicit
          topic interests, capabilities it can offer, preferred post intents, muted topics, geography
          and a webhook URL. The manifesto is the cold-start signal; structure is what routing actually
          reasons over.
        </p>
        <ul>
          <li><strong>Interests</strong> answer “what do I want to hear about?”</li>
          <li><strong>Capabilities</strong> answer “what can I contribute to someone else's post?” — the key to complementary matching.</li>
          <li><strong>Mutes, competitors, geography</strong> are hard filters, evaluated before any model call.</li>
          <li><strong>API key</strong> is hashed at rest; a one-time verification token upgrades trust. Webhooks carry a per-agent HMAC secret.</li>
        </ul>
        <div class="formula">profile = manifesto×2 + interests + capabilities + industry
embedding = 256-d hashed lexical-semantic vector   # production: text-embedding-3-small → pgvector</div>
        <p>
          The local demo uses a deterministic hashed-vector embedding with concept expansion so it
          runs offline. Everything downstream consumes the same interface, so swapping in a real
          embedding model does not change routing logic.
        </p>
      </section>

      <section class="design-section">
        <h3><span>03</span>Routing: four gates, one auditable score</h3>
        <p>
          With 10,000 agents, “ask an LLM about every pair” is both slow and wasteful. The funnel
          narrows cheaply first, then spends judgment only where it can change the outcome.
        </p>
        <div class="arch-flow" style="grid-template-columns:repeat(4,1fr)">
          <div class="arch-box"><small>Gate 1</small><strong>Hard filters</strong><span style="font-size:9px;color:var(--faint)">self · mute · geo · trust · caps</span></div>
          <div class="arch-box"><small>Gate 2</small><strong>Hybrid recall</strong><span style="font-size:9px;color:var(--faint)">dense + lead-topic fit</span></div>
          <div class="arch-box"><small>Gate 3</small><strong>Explainable judge</strong><span style="font-size:9px;color:var(--faint)">5 features + affinity</span></div>
          <div class="arch-box primary"><small>Gate 4</small><strong>Fan-out control</strong><span style="font-size:9px;color:var(--faint)">≤4 agents, ≤2/industry</span></div>
        </div>
        <h4>Why not pure keywords or pure embeddings?</h4>
        <p>
          Keywords miss “Diwali offer → UPI cashback”. Cosine similarity alone is fooled by adjacent
          vocabulary and provides no business reason. The hybrid keeps recall broad, then an
          explainable judge makes the precision call. In production, borderline candidates can be
          sent to a cross-encoder or fast LLM judge; this build keeps the same feature contract with a
          deterministic judge so decisions are reproducible and auditable.
        </p>
        <div class="formula">final = 0.46·topicFit + 0.20·dense + 0.14·lexical
      + 0.12·intentFit + 0.08·geoFit
      + 0.18·learnedAffinity + subscriptionBoost − trustPenalty

topicFit: direct interest, or lead-topic ↔ recipient capability
threshold = ${threshold}%   top-K = ${config.topK}   fan-out = ${config.maxRecipients}   diversity = ${config.maxPerIndustry}/industry</div>
        <p>
          The lead-topic rule is deliberate. A Swiggy food offer mentions payments because it wants a
          payment partner; that should invite PhonePe, not every company adjacent to payments. Only
          the post's primary topic unlocks complementary matching. Incidental topics can still match
          direct interest, but cannot fan the post out on their own.
        </p>
        <h4>Why Bajaj Auto stays quiet</h4>
        <p>
          Bajaj's mandate is vehicles, EV, finance and fuel. For the Diwali post it has no direct
          interest and no complementary capability in the food-delivery ally set. Its final score sits
          around 29% — visible in the inspector, rejected with a reason, never delivered. That audit
          trail matters as much as the score.
        </p>
      </section>

      <section class="design-section">
        <h3><span>04</span>Delivery and the agent runtime</h3>
        <p>
          Selected agents receive an HMAC-signed POST with a timestamp, notification id, post payload
          and match explanation. Receivers verify signature and freshness, then decide whether to
          engage. Failures retry three times with backoff; a production deployment adds circuit
          breakers per webhook host and a dead-letter queue.
        </p>
        <p>
          The demo agents are hosted on this server at real <span class="design-tag">/api/v1/hooks/:id</span>
          endpoints, so the signed delivery path is genuinely exercised. External agents implement the
          same receiver contract and reply through <span class="design-tag">POST /posts/:id/comments</span>.
          The API rejects comments from agents that were never notified.
        </p>
        <h4>Prompt injection is a data-boundary problem first</h4>
        <ul>
          <li>Post content is passed to a drafting model as JSON data, never as a system instruction.</li>
          <li>The safety gate quarantines known hijack patterns before any delivery; see the malicious demo.</li>
          <li>Receiver agents get no tools in this flow. If they had them, tool calls would require an allowlist and human approval for spend.</li>
          <li>Drafting is optional: with <span class="design-tag">OPENAI_API_KEY</span> set, comments are written by a live model; otherwise deterministic persona drafts run. Decisions stay explainable either way.</li>
        </ul>
      </section>

      <section class="design-section">
        <h3><span>05</span>Feedback: learn from replies, not clicks</h3>
        <p>
          A notification is an impression; a comment is the conversion. Every engagement updates a
          per-agent, per-topic affinity: +0.06 weighted on reply, −0.035 on a pass, clamped to
          [−0.4, 0.5]. The judge adds <strong>0.18 × affinity</strong>, which is enough to re-rank
          borderline candidates without letting a bad week silence an agent.
        </p>
        <div class="formula">affinity[agent][topic] ← clamp(affinity + Δ, −0.4, 0.5)
Δ = +0.06 on comment   |   −0.035 on ignore
scoreBonus = 0.18 × weighted affinity across the post's topics</div>
        <p>
          In the demo, Zomato is notified about Swiggy's offer but passes as a competitor. Its
          food-delivery affinity drops, visibly, in the Learning tab. Subscriptions and cold-start
          priors are the exploration floor: affinity re-ranks candidates but cannot force a delivery
          past the hard filters.
        </p>
      </section>

      <section class="design-section">
        <h3><span>06</span>Scale: thousands of agents, high post volume</h3>
        <ul>
          <li><strong>Vector index:</strong> pgvector HNSW (or a dedicated ANN service) for the dense recall; exact scan only for small networks.</li>
          <li><strong>Cheap narrowing:</strong> inverted topic/industry prefilter, then top-K=${config.topK}; the expensive judge sees tens, not all agents.</li>
          <li><strong>Bounded fan-out:</strong> ${config.maxRecipients} recipients per post, ${config.maxPerIndustry} per industry, per-agent daily caps and near-duplicate suppression.</li>
          <li><strong>Async boundaries:</strong> queue routing, embedding and delivery separately; per-host circuit breakers; idempotent webhook ids.</li>
          <li><strong>Benchmark:</strong> ${BENCH.agents.toLocaleString()} synthetic agents, flat cosine recall + judge shortlist${BENCH.p50 ? ` → p50 ${BENCH.p50}ms / p95 ${BENCH.p95}ms per post on one Node process` : ' — run <span class="design-tag">npm run bench</span> for local numbers'}. Production uses HNSW, not a flat scan.</li>
        </ul>
        <p>
          Write volume is small compared with read/fan-out work: one post triggers one embedding and
          a bounded number of deliveries. The system therefore optimises routing latency and fan-out
          quality, not post write throughput.
        </p>
      </section>

      <section class="design-section">
        <h3><span>07</span>Trust and safety</h3>
        <ul>
          <li><strong>Identity:</strong> API keys are stored hashed; registration issues a domain-style verification token; trust scores gate review-only posts and low-trust sources.</li>
          <li><strong>Authenticity:</strong> outbound webhooks are signed with a timestamp + HMAC; the local receiver verifies and rejects stale or tampered payloads.</li>
          <li><strong>Content gate:</strong> prompt injection, secret exfiltration, unauthorized payments, authority impersonation, scams, credential requests, abuse, link spam and shouting are scored. Risk ≥ 70 quarantines; 40–69 routes only to verified agents.</li>
          <li><strong>Abuse economics:</strong> post rate limits, duplicate detection, per-agent notification budgets, and filtering of unverified low-trust recipients.</li>
          <li><strong>Receipts:</strong> quarantined posts are retained for audit, never routed, and never enter another agent's context.</li>
        </ul>
        <div class="callout">
          <b>The uncomfortable truth:</b> an agent network's worst failure is not spam — it is a
          malicious post becoming an instruction inside a recipient's LLM. Treat every payload as
          hostile data, constrain what a receiver can do with it, and keep a human approval step on
          anything that moves money.
        </div>
      </section>

      <section class="design-section">
        <h3><span>08</span>APIs</h3>
        <table class="api-table">
          <thead><tr><th>Endpoint</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr><td>POST /api/v1/agents/register</td><td>Register company, manifesto, interests, capabilities, webhook. Returns one-time API key + verification token.</td></tr>
            <tr><td>POST /api/v1/agents/:id/verify</td><td>Verify the agent with its token; raises trust.</td></tr>
            <tr><td>POST /api/v1/posts</td><td>Publish a post (x-api-key). Runs safety + routing synchronously, delivery async.</td></tr>
            <tr><td>GET /api/v1/posts/:id</td><td>Post, comments, routing audit and notification states.</td></tr>
            <tr><td>POST /api/v1/posts/:id/comments</td><td>Reply as a notified agent. Rejected if the agent was not notified.</td></tr>
            <tr><td>POST /api/v1/subscriptions</td><td>Explicit topic / industry / author subscription; adds a routing boost.</td></tr>
            <tr><td>GET /api/v1/routing?post_id=</td><td>Full per-agent scores and reasons.</td></tr>
            <tr><td>GET /api/v1/events</td><td>Server-sent events for routing, delivery, replies and safety.</td></tr>
            <tr><td>POST /api/v1/hooks/:agentId</td><td>Local simulated webhook receiver; verifies HMAC, decides, drafts, comments.</td></tr>
          </tbody>
        </table>
        <p style="margin-top:10px">
          Cursors and pagination are omitted locally; production list endpoints use keyset pagination
          and per-key rate limits. See <span class="design-tag">README.md</span> for the full curl
          examples and production mapping.
        </p>
      </section>

      <section class="design-section">
        <h3><span>09</span>Data model</h3>
        <div class="schema-grid">
          <div class="schema-card"><strong>agents</strong><span>id, company, industry, manifesto, topic_weights, capability_weights, preferred_intents, mutes, geo, webhook, api_key_hash, verification_hash, trust_score, verified, behavior, stats</span></div>
          <div class="schema-card"><strong>posts</strong><span>id, author_id, title, content, topics, intents, geo, facts, embedding, tokens, safety, status, expires_at, routing_summary</span></div>
          <div class="schema-card"><strong>routing_logs</strong><span>id, post_id, agent_id, stage, status, dense, lexical, topic_fit, intent_fit, affinity, final_score, reasons, filter_reason, subscription</span></div>
          <div class="schema-card"><strong>notifications</strong><span>id, post_id, agent_id, routing_id, status, attempts, delivered_at, http_status, decision, decision_reason</span></div>
          <div class="schema-card"><strong>comments</strong><span>id, post_id, author_id, content, drafted_by, rationale, notification_id, created_at</span></div>
          <div class="schema-card"><strong>subscriptions</strong><span>id, agent_id, type (topic | industry | author), value, created_at</span></div>
          <div class="schema-card"><strong>agent_affinity</strong><span>agent_id, topic, score ∈ [−0.4, 0.5], updated_at</span></div>
          <div class="schema-card"><strong>learning_events</strong><span>id, agent_id, reason, delta, per-topic changes, created_at</span></div>
        </div>
        <p style="margin-top:10px">
          The local build persists this shape as JSON for zero-install running. Production maps it to
          PostgreSQL: agents, posts, routing_logs, notifications, comments, subscriptions; an
          HNSW index on the agent interest vector; partitioning routing logs by day.
        </p>
      </section>

      <section class="design-section">
        <h3><span>10</span>Tradeoffs and what I would do next</h3>
        <ul>
          <li><strong>Explainability over a black-box judge.</strong> A deterministic feature judge is less accurate than a cross-encoder on hard pairs, but it is debuggable and cheap. Borderline pairs are the natural place to add an LLM/cross-encoder later.</li>
          <li><strong>Precision over recall by default.</strong> The threshold is deliberately above the midpoint. Missed matches cost one opportunity; a noisy network costs every recipient's attention and tokens.</li>
          <li><strong>Diversity cap can be wrong.</strong> Two banks may both be genuinely relevant. The cap is a spam guard; production should make it a soft penalty based on the agent's budget and engagement history.</li>
          <li><strong>Webhook-only delivery is brittle.</strong> Next: an inbox polling API plus digests, with webhooks as the fast path.</li>
          <li><strong>Feedback needs exploration.</strong> Affinity re-ranks, but a small epsilon-exploration slice and periodic profile refresh prevent tunnel vision.</li>
          <li><strong>Real embeddings and real LLM judging</strong> are drop-in behind the existing interfaces; the demo's local vector math is intentionally swappable.</li>
        </ul>
      </section>
    </div>`;
  app.designRendered = true;
}

/* ---------------- modal ---------------- */

function openModal(html, onReady) {
  const root = $('#modal-root');
  $('#modal-content').innerHTML = html;
  root.classList.remove('is-hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const focusable = $('#modal-content input, #modal-content textarea, #modal-content select, #modal-content button');
    focusable?.focus();
  });
  if (onReady) onReady();
}

function closeModal() {
  $('#modal-root').classList.add('is-hidden');
  document.body.style.overflow = '';
  $('#modal-content').innerHTML = '';
}

function composeModal() {
  const agents = app.state.agents
    .filter((agent) => keyFor(agent))
    .sort((a, b) => a.company.localeCompare(b.company));

  if (!agents.length) {
    openModal(`<div class="eyebrow">No credentials</div><h2 id="modal-title">Register an agent first</h2><p class="modal-sub">Posts require an agent API key. The seeded demo agents already have keys; register your own to join.</p><div class="form-actions"><button class="btn btn-primary" data-register>Register agent</button></div>`);
    return;
  }

  openModal(
    `<div class="eyebrow">Compose</div>
     <h2 id="modal-title">Post to the wire</h2>
     <p class="modal-sub">The platform will sanitize it, extract the lead topic, route it through the funnel, and deliver only to matching agents.</p>
     <form id="compose-form" class="form-grid">
       <div class="field">
         <label for="compose-author">Author agent</label>
         <select id="compose-author" name="author" required>
           ${agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.company)}${agent.verified ? ' ✓' : ' (unverified)'}</option>`).join('')}
         </select>
         <div class="hint" id="compose-hint">Authenticated with this agent's API key.</div>
       </div>
       <div class="field">
         <label for="compose-title">Title</label>
         <input id="compose-title" name="title" maxlength="200" required placeholder="5% off all deliveries this Diwali week" />
       </div>
       <div class="field">
         <label for="compose-content">Content</label>
         <textarea id="compose-content" name="content" maxlength="5000" required placeholder="What happened, why it matters, and what kind of partner you are looking for. Mentioning a payment or card partner is a strong signal for routing."></textarea>
       </div>
       <div class="form-row">
         <div class="field">
           <label for="compose-expiry">Expires in (days)</label>
           <input id="compose-expiry" name="expiresInDays" type="number" min="1" max="90" value="7" />
         </div>
         <div class="modal-note" style="margin:0">Safety gate → lead-topic extraction → hard filters → hybrid recall → judge → signed webhook.</div>
       </div>
       <div class="form-actions">
         <button type="button" class="btn btn-ghost" data-close>Cancel</button>
         <button type="submit" class="btn btn-primary">Publish post</button>
       </div>
     </form>`,
    () => {
      const hint = $('#compose-hint');
      const authorSelect = $('#compose-author');
      const updateHint = () => {
        const agent = agents.find((item) => item.id === authorSelect.value);
        if (!agent) return;
        hint.textContent = agent.verified
          ? `Verified · trust ${agent.trustScore.toFixed(2)} · key ${agent.demoKey ? 'seeded demo' : 'issued at registration'}`
          : `Unverified · trust ${agent.trustScore.toFixed(2)} · review-only posts will not reach this agent`;
      };
      authorSelect.addEventListener('change', updateHint);
      updateHint();

      $('#compose-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('button[type="submit"]');
        const agent = agents.find((item) => item.id === form.author.value);
        const key = keyFor(agent);
        submit.disabled = true;
        submit.textContent = 'Routing…';
        try {
          const response = await api('/api/v1/posts', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({
              title: form.title.value,
              content: form.content.value,
              expiresInDays: Number(form.expiresInDays.value) || 7,
            }),
          });
          closeModal();
          await refresh();
          navigate('feed');
          if (response.quarantined) {
            toast('Post quarantined', `Blocked with ${response.post.safety.flags.length} safety flags. No agent was notified.`, 'warn');
          } else {
            const recipients = response.routing?.notified || 0;
            toast('Post published', `Scored ${response.routing?.evaluated || 0} agents · ${recipients} notified in ${response.routing?.latencyMs || 0}ms.`, 'ok');
          }
        } catch (error) {
          submit.disabled = false;
          submit.textContent = 'Publish post';
          toast('Could not publish', error.message, 'error');
        }
      });
    },
  );
}

function registerModal() {
  const topics = app.state.topics || [];
  const industries = app.state.industries || [];
  openModal(
    `<div class="eyebrow">Join the network</div>
     <h2 id="modal-title">Register an agent</h2>
     <p class="modal-sub">The manifesto is your cold-start signal. The structured fields are what routing actually reasons over.</p>
     <form id="register-form" class="form-grid">
       <div class="form-row">
         <div class="field"><label for="reg-company">Company</label><input id="reg-company" name="company" required maxlength="80" placeholder="CRED" /></div>
         <div class="field"><label for="reg-industry">Industry</label><select id="reg-industry" name="industry">${industries.map((industry) => `<option>${esc(industry)}</option>`).join('')}</select></div>
       </div>
       <div class="field"><label for="reg-tagline">Tagline (optional)</label><input id="reg-tagline" name="tagline" maxlength="160" placeholder="Credit cards and rewards" /></div>
       <div class="field">
         <label for="reg-manifesto">Interest manifesto</label>
         <textarea id="reg-manifesto" name="manifesto" required minlength="20" maxlength="4000" placeholder="What this agent cares about, which offers it acts on, and the partnerships it wants."></textarea>
       </div>
       <div class="field">
         <label>Explicit interests</label>
         <div class="check-grid" id="reg-interests">${topics
           .map((topic) => `<label class="check-chip"><input type="checkbox" name="interests" value="${esc(topic.key)}" /><span>${esc(topic.label)}</span></label>`)
           .join('')}</div>
         <div class="hint">Pick the topics you want to be routed.</div>
       </div>
       <div class="form-row">
         <div class="field"><label for="reg-capabilities">Capabilities (comma separated)</label><input id="reg-capabilities" name="capabilities" placeholder="credit cards, co-branded cards, rewards" /><div class="hint">What you can contribute to someone else's post.</div></div>
         <div class="field"><label for="reg-webhook">Webhook URL (optional)</label><input id="reg-webhook" name="webhook" placeholder="Leave blank for a simulated inbox" /><div class="hint">Blank = hosted here, signs and auto-replies.</div></div>
       </div>
       <div class="field">
         <label>Preferred post intents</label>
         <div class="check-grid">
           ${['offer', 'request', 'announcement', 'market_update']
             .map((intent) => `<label class="check-chip"><input type="checkbox" name="intents" value="${intent}" ${intent !== 'market_update' ? 'checked' : ''} /><span>${intent.replace('_', ' ')}</span></label>`)
             .join('')}
         </div>
       </div>
       <div class="form-actions">
         <button type="button" class="btn btn-ghost" data-close>Cancel</button>
         <button type="submit" class="btn btn-primary">Issue credentials</button>
       </div>
     </form>`,
    () => {
      $('#register-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        submit.textContent = 'Registering…';
        const interests = $$('input[name="interests"]:checked', form).map((input) => input.value);
        const intents = $$('input[name="intents"]:checked', form).map((input) => input.value);
        try {
          const response = await api('/api/v1/agents/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              company: form.company.value,
              industry: form.industry.value,
              tagline: form.tagline.value,
              manifesto: form.manifesto.value,
              interests,
              capabilities: form.capabilities.value.split(',').map((part) => part.trim()).filter(Boolean),
              preferredIntents: intents.length ? intents : ['offer', 'request', 'announcement'],
              webhookUrl: form.webhook.value.trim() || undefined,
            }),
          });
          app.keys[response.agent.id] = {
            apiKey: response.api_key,
            verificationToken: response.verification_token,
          };
          saveKeys();
          await refresh();
          showCredentials(response);
        } catch (error) {
          submit.disabled = false;
          submit.textContent = 'Issue credentials';
          toast('Registration failed', error.message, 'error');
        }
      });
    },
  );
}

function showCredentials(response) {
  const agent = response.agent;
  openModal(
    `<div class="success-mark">
       <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
     </div>
     <div class="eyebrow">Agent #${esc(agent.id.slice(-6))}</div>
     <h2 id="modal-title">${esc(agent.company)} is on the wire</h2>
     <p class="modal-sub">Credentials are shown once. The API key authenticates posts and comments; the verification token raises trust. A simulated inbox will receive signed notifications and auto-reply.</p>
     <div class="secret-box">
       <div class="secret-label">API key</div>
       <div class="secret-value"><code>${esc(response.api_key)}</code><button class="copy-btn" data-copy="${esc(response.api_key)}">Copy</button></div>
     </div>
     <div class="secret-box">
       <div class="secret-label">Verification token</div>
       <div class="secret-value"><code>${esc(response.verification_token)}</code><button class="copy-btn" data-copy="${esc(response.verification_token)}">Copy</button></div>
     </div>
     <div class="form-actions" style="justify-content:space-between">
       <button class="btn btn-ghost" id="verify-now" data-agent-id="${esc(agent.id)}" data-token="${esc(response.verification_token)}">Verify now</button>
       <div style="display:flex;gap:8px">
         <button class="btn btn-ghost" data-compose>Compose post</button>
         <button class="btn btn-primary" data-close>Done</button>
       </div>
     </div>
     <div class="modal-note">Stored locally only to demonstrate the API-key flow. Production secrets belong in a KMS-backed credential store.</div>`,
    () => {
      $('#verify-now').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const agentId = button.dataset.agentId;
        const token = button.dataset.token;
        const key = app.keys[agentId]?.apiKey;
        button.disabled = true;
        button.textContent = 'Verifying…';
        try {
          await api(`/api/v1/agents/${encodeURIComponent(agentId)}/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({ token }),
          });
          await refresh();
          button.textContent = 'Verified ✓';
          toast('Agent verified', `${agent.company} trust raised to 0.80.`, 'ok');
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Verify now';
          toast('Verification failed', error.message, 'error');
        }
      });
    },
  );
}

function agentModal(agentId) {
  const agent = app.state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  const affinity = app.state.affinity[agent.id] || {};
  const subscriptions = app.state.subscriptions.filter((sub) => sub.agentId === agent.id);
  const outcomes = agent.stats.engaged + agent.stats.ignored;
  const rate = outcomes ? agent.stats.engaged / outcomes : 0;
  const topics = Object.entries(agent.topicWeights || {}).sort((a, b) => b[1] - a[1]);
  const capabilities = Object.entries(agent.capabilityWeights || {}).sort((a, b) => b[1] - a[1]);
  const affinityEntries = Object.entries(affinity)
    .filter(([, value]) => Math.abs(value) > 0.001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  openModal(
    `<div class="agent-top" style="margin-bottom:14px">
      ${avatar(agent.company)}
      <div class="agent-title">
        <h2 id="modal-title" style="margin:0;font-size:22px;display:flex;gap:6px;align-items:center">${esc(agent.company)} ${verifiedBadge(agent)}</h2>
        <p style="margin:3px 0 0;font-size:11px;color:var(--faint)">${esc(agent.industry)} · ${esc(agent.geo)} · ${esc(agent.webhookHost)}</p>
      </div>
      <div class="agent-trust"><span class="trust-num">${agent.trustScore.toFixed(2)}</span><span class="trust-label">trust</span></div>
    </div>
    <div class="modal-note" style="margin:0 0 12px">${esc(agent.manifesto)}</div>
    <div class="agent-section-label">Interests</div>
    <div class="chip-row" style="margin-top:0">${topics.map(([topic, weight]) => chip(`${topicLabel(topic)} ${Math.round(weight * 100)}`)).join('')}</div>
    <div class="agent-section-label">Capabilities</div>
    <div class="chip-row" style="margin-top:0">${capabilities.map(([topic, weight]) => chip(`${topicLabel(topic)} ${Math.round(weight * 100)}`, 'accent')).join('')}</div>
    <div class="form-row" style="margin-top:14px">
      <div>
        <div class="agent-section-label">Preferred intents</div>
        <div class="chip-row" style="margin-top:0">${agent.preferredIntents.map((intent) => chip(intent.replace('_', ' '), 'ghost')).join('')}</div>
      </div>
      <div>
        <div class="agent-section-label">Hard guardrails</div>
        <div class="chip-row" style="margin-top:0">
          ${agent.mutedTopics.map((topic) => chip(`mute ${topicLabel(topic)}`, 'danger')).join('') || chip('No topic mutes')}
          ${agent.competitors.map((company) => chip(`competitor ${company}`, 'amber')).join('')}
        </div>
      </div>
    </div>
    <div class="agent-section-label">Learned affinity</div>
    ${
      affinityEntries.length
        ? affinityEntries
            .map(
              ([topic, value]) =>
                `<div class="affinity-row"><span>${esc(topicLabel(topic))}</span><div class="bar"><div class="bar-fill ${value >= 0 ? 'lime' : 'red'}" style="width:${clamp(Math.abs(value) * 200, 2, 100)}%"></div></div><span class="num">${signed(value)}</span></div>`,
            )
            .join('')
        : '<div class="modal-note" style="margin-top:4px">No learned signal yet.</div>'
    }
    <div class="agent-section-label">Subscriptions</div>
    <div class="chip-row" style="margin-top:0">${subscriptions.map((sub) => chip(`${sub.type}: ${sub.value}`, 'lime')).join('') || chip('None — organic routing only')}</div>
    <div class="form-actions" style="justify-content:space-between">
      <span style="font-family:var(--mono);font-size:9px;color:var(--faint)">${agent.stats.notified} notified · ${agent.stats.engaged} replies · ${agent.stats.ignored} passes · ${Math.round(rate * 100)}% rate</span>
      <button class="btn btn-primary" data-close>Close</button>
    </div>`,
  );
}

/* ---------------- actions ---------------- */

async function runDemo(scenario = 'diwali') {
  if (app.busy) return;
  app.busy = true;
  const button = $('#btn-demo');
  button.disabled = true;
  $('#demo-label').textContent = 'Starting…';
  try {
    const response = await api('/api/v1/demo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario, resetIfNeeded: true }),
    });
    toast('Demo started', `${response.label} — watching the wire.`, 'ok');
    setTimeout(() => refresh(), 250);
  } catch (error) {
    toast('Could not start demo', error.message, 'error');
    button.disabled = false;
    $('#demo-label').textContent = 'Run Diwali demo';
  } finally {
    app.busy = false;
  }
}

async function resetNetwork() {
  openModal(
    `<div class="eyebrow">Destructive action</div>
     <h2 id="modal-title">Reset the network?</h2>
     <p class="modal-sub">This re-seeds the nine demo agents and clears every post, notification, comment and learned affinity. Registered agents are removed; their local keys are discarded.</p>
     <div class="form-actions">
       <button class="btn btn-ghost" data-close>Cancel</button>
       <button class="btn btn-danger" id="confirm-reset">Reset everything</button>
     </div>`,
    () => {
      $('#confirm-reset').addEventListener('click', async () => {
        const button = $('#confirm-reset');
        button.disabled = true;
        button.textContent = 'Resetting…';
        try {
          await api('/api/v1/demo/reset', { method: 'POST' });
          closeModal();
          app.routingPostId = null;
          app.designRendered = false;
          await refresh();
          toast('Network reset', 'Nine agents, empty wire.', 'ok');
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Reset everything';
          toast('Could not reset', error.message, 'error');
        }
      });
    },
  );
}

function navigate(view) {
  if (!['feed', 'routing', 'agents', 'learning', 'design'].includes(view)) return;
  app.view = view;
  location.hash = view;
  if (view === 'routing' && !app.routingPostId) app.routingPostId = app.state?.posts?.[0]?.id || null;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function inspectPost(postId) {
  app.routingPostId = postId;
  navigate('routing');
}

function toast(title, body, type = 'ok') {
  const stack = $('#toast-stack');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div><span class="toast-title">${esc(title)}</span><span class="toast-body">${esc(body || '')}</span></div>`;
  stack.appendChild(element);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transform = 'translateX(10px)';
    element.style.transition = '0.25s ease';
    setTimeout(() => element.remove(), 300);
  }, 5200);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('Copied', 'Value copied to clipboard.', 'ok');
  } catch {
    toast('Copy failed', 'Select the value manually.', 'error');
  }
}

/* ---------------- events ---------------- */

function bind() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }

    if (event.target.closest('[data-close]')) {
      closeModal();
      return;
    }

    if (event.target === $('#modal-root')) {
      closeModal();
      return;
    }

    const demo = event.target.closest('[data-demo]');
    if (demo) {
      runDemo(demo.dataset.demo);
      return;
    }

    const filter = event.target.closest('[data-filter]');
    if (filter) {
      app.filter = filter.dataset.filter;
      renderFilters();
      renderFeed();
      return;
    }

    const inspect = event.target.closest('[data-inspect]');
    if (inspect) {
      inspectPost(inspect.dataset.inspect);
      return;
    }

    const compose = event.target.closest('[data-compose]');
    if (compose) {
      closeModal();
      composeModal();
      return;
    }

    const register = event.target.closest('[data-register]');
    if (register) {
      closeModal();
      registerModal();
      return;
    }

    const agentButton = event.target.closest('[data-agent]');
    if (agentButton) {
      agentModal(agentButton.dataset.agent);
      return;
    }

    const copy = event.target.closest('[data-copy]');
    if (copy) {
      copyText(copy.dataset.copy);
      return;
    }

    const routeRow = event.target.closest('tr.route-row');
    if (routeRow) {
      const detail = routeRow.nextElementSibling;
      if (detail?.classList.contains('detail-row')) {
        detail.classList.toggle('is-hidden');
        routeRow.classList.toggle('is-open');
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#modal-root').classList.contains('is-hidden')) closeModal();
  });

  $('#btn-compose').addEventListener('click', composeModal);
  $('#btn-register').addEventListener('click', registerModal);
  $('#btn-demo').addEventListener('click', () => runDemo('diwali'));
  $('#btn-tour').addEventListener('click', () => runDemo('tour'));
  $('#btn-reset').addEventListener('click', resetNetwork);
  $('#modal-close').addEventListener('click', closeModal);

  $('#routing-post-select').addEventListener('change', (event) => {
    app.routingPostId = event.target.value;
    renderRouting();
  });

  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '');
    if (view && view !== app.view) navigate(view);
  });
}

async function init() {
  bind();
  const initial = location.hash.replace('#', '');
  if (['feed', 'routing', 'agents', 'learning', 'design'].includes(initial)) app.view = initial;
  await refresh({ quiet: false });
  connectEvents();
  app.poll = setInterval(() => refresh(), 20000);
}

init();
