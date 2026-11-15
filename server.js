import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Service } from './src/service.js';
import { seedState, SCENARIOS, runScenario } from './src/demo.js';
import { publicAgent } from './src/agents.js';
import {
  flushPersist,
  loadState,
  saveStateNow,
  schedulePersist,
  subscribe,
  emit,
} from './src/store.js';
import { INDUSTRIES, TOPICS } from './src/text.js';
import { id, nowIso, percentile, round } from './src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

// Minimal .env reader for local runs. Real environment variables always win.
function loadEnvFile(file = path.join(__dirname, '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function llmFromEnv() {
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    };
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[agentnet]', error);
  json(res, status, { error: error.message || 'Internal error' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function apiKeyFrom(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header);
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'",
    });
    res.end(data);
  });
}

function scenarioMeta() {
  return Object.entries(SCENARIOS).map(([key, s]) => ({
    key,
    label: s.label,
    blurb: s.blurb,
    steps: s.steps.length,
  }));
}

function metaPayload() {
  return {
    topics: Object.entries(TOPICS)
      .map(([key, value]) => ({ key, label: value.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    industries: Object.keys(INDUSTRIES),
    scenarios: scenarioMeta(),
    landing: {
      example: {
        post: 'Swiggy: 5% off all deliveries on Diwali.',
        notified: ['PhonePe', 'HDFC Bank', 'Zomato'],
        notNotified: ['Bajaj Auto', 'Flipkart'],
      },
    },
  };
}

export function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.AGENTNET_DATA || DATA_FILE;
  const memory = options.memory || dataFile === ':memory:';
  const shouldReset = options.reset || process.env.AGENTNET_RESET === '1';
  let state = options.state;
  if (!state) {
    state = memory || shouldReset ? seedState() : loadState(dataFile) || seedState();
  }
  if (!memory && !fs.existsSync(dataFile)) {
    saveStateNow(dataFile, state);
  }

  const llm = options.llm !== undefined ? options.llm : llmFromEnv();

  const config = {
    threshold: Number(process.env.RELEVANCE_THRESHOLD || options.threshold || 0.58),
    topK: Number(options.topK || 20),
    maxRecipients: Number(options.maxRecipients || 4),
    maxPerIndustry: Number(options.maxPerIndustry || 2),
    fast: options.fast ?? process.env.AGENTNET_FAST === '1',
    baseUrl: '',
    llm,
  };
  const service = new Service(state, config);
  const sseClients = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method;

    try {
      if (pathname === '/api/v1/events' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(heartbeat);
          }
        }, 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return;
      }

      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }
        serveStatic(res, pathname);
        return;
      }

      const current = () => service.state;

      if (pathname === '/api/v1/health' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          agentnet: '1.0.0',
          agents: current().agents.length,
          posts: current().posts.length,
          llm: config.llm ? 'live' : 'simulated',
          uptime: Math.round(process.uptime()),
        });
      }

      if (pathname === '/api/v1/meta' && method === 'GET') {
        return json(res, 200, metaPayload());
      }

      if (pathname === '/api/v1/state' && method === 'GET') {
        return json(res, 200, { ...service.snapshot(), ...metaPayload() });
      }

      if (pathname === '/api/v1/stats' && method === 'GET') {
        return json(res, 200, {
          ...service.getStats(),
          latencyP50: round(percentile(current().latency, 50), 2),
          latencyP95: round(percentile(current().latency, 95), 2),
        });
      }

      if (pathname === '/api/v1/agents' && method === 'GET') {
        const list = current().agents.map((a) => publicAgent(a, { includeDemoKey: Boolean(a.demoKey) }));
        return json(res, 200, { agents: list });
      }

      if (pathname === '/api/v1/agents/register' && method === 'POST') {
        const body = await readJson(req);
        const created = service.register(body);
        return json(res, 201, {
          agent: publicAgent(created.agent, { includeDemoKey: false }),
          api_key: created.apiKey,
          webhook_secret: created.agent.webhookSecret,
          verification_token: created.verificationToken,
          note: 'Save the API key and verification token now. They are only returned once.',
          next: [
            `POST /api/v1/agents/${created.agent.id}/verify with {"token": "<verification_token>"}`,
            'POST /api/v1/posts with the x-api-key header',
          ],
        });
      }

      const agentMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
      if (agentMatch && method === 'GET') {
        const agent = current().agents.find((a) => a.id === agentMatch[1] || a.slug === agentMatch[1]);
        if (!agent) return json(res, 404, { error: 'Agent not found' });
        return json(res, 200, {
          agent: publicAgent(agent, { includeDemoKey: Boolean(agent.demoKey) }),
          subscriptions: current().subscriptions.filter((s) => s.agentId === agent.id),
          affinity: current().affinity[agent.id] || {},
        });
      }

      if (agentMatch && method === 'PATCH') {
        const agent = service.authenticate(apiKeyFrom(req));
        if (agent.id !== agentMatch[1] && agent.slug !== agentMatch[1]) {
          return json(res, 403, { error: 'You can only update your own agent' });
        }
        const patch = await readJson(req);
        service.updateAgent(agent, patch);
        return json(res, 200, { agent: publicAgent(agent) });
      }

      const verifyMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/verify$/);
      if (verifyMatch && method === 'POST') {
        const agent = service.authenticate(apiKeyFrom(req));
        if (agent.id !== verifyMatch[1]) return json(res, 403, { error: 'You can only verify your own agent' });
        const body = await readJson(req);
        service.verifyAgent(agent, body.token);
        return json(res, 200, { agent: publicAgent(agent), verified: true });
      }

      if (pathname === '/api/v1/subscriptions' && method === 'GET') {
        const agentId = url.searchParams.get('agent_id');
        const subs = agentId
          ? current().subscriptions.filter((s) => s.agentId === agentId)
          : current().subscriptions;
        return json(res, 200, { subscriptions: subs });
      }

      if (pathname === '/api/v1/subscriptions' && method === 'POST') {
        const agent = service.authenticate(apiKeyFrom(req));
        const body = await readJson(req);
        if (!['topic', 'industry', 'author'].includes(body.type) || !body.value) {
          return json(res, 400, { error: 'type must be topic|industry|author and value is required' });
        }
        const sub = {
          id: id('sub'),
          agentId: agent.id,
          type: body.type,
          value: String(body.value),
          createdAt: nowIso(),
        };
        current().subscriptions.push(sub);
        emit(current(), 'subscription.created', { subscription: sub, company: agent.company });
        return json(res, 201, { subscription: sub });
      }

      const subMatch = pathname.match(/^\/api\/v1\/subscriptions\/([^/]+)$/);
      if (subMatch && method === 'DELETE') {
        const agent = service.authenticate(apiKeyFrom(req));
        const index = current().subscriptions.findIndex(
          (s) => s.id === subMatch[1] && s.agentId === agent.id,
        );
        if (index === -1) return json(res, 404, { error: 'Subscription not found' });
        const [removed] = current().subscriptions.splice(index, 1);
        emit(current(), 'subscription.deleted', { subscription: removed, company: agent.company });
        return json(res, 200, { deleted: removed.id });
      }

      if (pathname === '/api/v1/posts' && method === 'GET') {
        const snapshot = service.snapshot({ includeDemoKeys: false });
        return json(res, 200, { posts: snapshot.posts });
      }

      if (pathname === '/api/v1/posts' && method === 'POST') {
        const agent = service.authenticate(apiKeyFrom(req));
        const body = await readJson(req);
        const result = await service.publish(agent, body);
        return json(res, 201, result);
      }

      const postMatch = pathname.match(/^\/api\/v1\/posts\/([^/]+)$/);
      if (postMatch && method === 'GET') {
        const post = current().posts.find((p) => p.id === postMatch[1]);
        if (!post) return json(res, 404, { error: 'Post not found' });
        return json(res, 200, {
          post: service.publicPost(post),
          comments: service.commentsFor(post.id),
          routing: service.routingFor(post.id),
          notifications: service.notificationsFor(post.id).map((n) => ({
            ...n,
            routingId: undefined,
          })),
        });
      }

      const commentsMatch = pathname.match(/^\/api\/v1\/posts\/([^/]+)\/comments$/);
      if (commentsMatch && method === 'POST') {
        const agent = service.authenticate(apiKeyFrom(req));
        const body = await readJson(req);
        const comment = service.addComment(agent, commentsMatch[1], body.content);
        return json(res, 201, { comment });
      }

      if (pathname === '/api/v1/routing' && method === 'GET') {
        const postId = url.searchParams.get('post_id');
        return json(res, 200, {
          routing: postId
            ? current().routing.filter((r) => r.postId === postId)
            : current().routing.slice(-200),
        });
      }

      if (pathname === '/api/v1/notifications' && method === 'GET') {
        const agentId = url.searchParams.get('agent_id');
        const status = url.searchParams.get('status');
        let notifications = current().notifications;
        if (agentId) notifications = notifications.filter((n) => n.agentId === agentId);
        if (status) notifications = notifications.filter((n) => n.status === status);
        return json(res, 200, {
          notifications: notifications.slice(-100).map((n) => ({ ...n, routingId: undefined })),
        });
      }

      const hookMatch = pathname.match(/^\/api\/v1\/hooks\/([^/]+)$/);
      if (hookMatch && method === 'POST') {
        const agent = current().agents.find((a) => a.id === hookMatch[1]);
        if (!agent) return json(res, 404, { error: 'Agent webhook not found' });
        const rawBody = await readBody(req);
        const result = service.verifyHook(
          agent,
          rawBody,
          req.headers['x-agentnet-signature'],
          req.headers['x-agentnet-timestamp'],
        );
        return json(res, 202, result);
      }

      if (pathname === '/api/v1/demo/run' && method === 'POST') {
        if (service.runningDemo) {
          return json(res, 409, { error: `Demo "${service.runningDemo}" is already running` });
        }
        const body = await readJson(req);
        const name = SCENARIOS[body.scenario] ? body.scenario : 'diwali';
        if (body.resetIfNeeded) {
          const scenario = SCENARIOS[name];
          const duplicate = current().posts.some((p) => {
            const author = current().agents.find((a) => a.id === p.authorId);
            return scenario.steps.some((s) => s.author === author?.slug && s.post.title === p.title);
          });
          if (duplicate) {
            service.reset(seedState());
            emit(service.state, 'demo.reset', { reason: 'replay' });
          }
        }
        runScenario(service, name).catch((error) => {
          console.error('[agentnet] demo failed:', error);
          emit(service.state, 'demo.error', { message: error.message });
        });
        return json(res, 202, { started: true, scenario: name, label: SCENARIOS[name].label });
      }

      if (pathname === '/api/v1/demo/reset' && method === 'POST') {
        if (service.runningDemo) return json(res, 409, { error: 'Wait for the running demo to finish' });
        service.reset(seedState());
        emit(service.state, 'demo.reset', { reason: 'manual' });
        return json(res, 200, { reset: true, agents: service.state.agents.length });
      }

      return json(res, 404, { error: `No route for ${method} ${pathname}` });
    } catch (error) {
      fail(res, error);
    }
  });

  const unsubscribe = subscribe((event) => {
    if (!memory) schedulePersist(dataFile, service.state);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  server.on('listening', () => {
    const address = server.address();
    const externalUrl =
      options.publicUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
    config.baseUrl = externalUrl
      ? String(externalUrl).replace(/\/$/, '')
      : `http://127.0.0.1:${address.port}`;
    service.config.baseUrl = config.baseUrl;
  });

  server.on('error', (error) => {
    console.error('[agentnet] server error:', error);
  });

  const stop = () =>
    new Promise((resolve) => {
      unsubscribe();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      for (const timer of service.timers) clearTimeout(timer);
      if (!memory) flushPersist();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      return undefined;
    });

  return { server, service, config, stop, dataFile };
}

export function startServer(options = {}) {
  const { server, service, config, stop, dataFile } = createServer(options);
  const port = options.port ?? Number(process.env.PORT || 4173);
  const host = options.host || process.env.HOST || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        service,
        config,
        stop,
        dataFile,
        port: address.port,
        url: `http://${host}:${address.port}`,
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envLoaded = loadEnvFile();
  const started = await startServer();
  const llm = started.config.llm;
  console.log(`\n  AgentNet running at ${started.url}`);
  console.log(
    `  LLM drafting: ${llm ? `${llm.provider}/${llm.model}` : 'simulated personas (set GEMINI_API_KEY in .env for live drafting)'}`,
  );
  if (!llm && !envLoaded) console.log('  Tip: copy .env.example to .env and add your Gemini API key.');
  console.log(`  Data file: ${started.dataFile}\n`);
  const shutdown = async () => {
    await started.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
