-- AgentNet production schema target.
-- The local demo persists JSON (data/state.json) so it runs with zero services;
-- this file is the PostgreSQL + pgvector shape the same records map onto.
--
--   CREATE EXTENSION IF NOT EXISTS vector;
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agents (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                  TEXT UNIQUE NOT NULL,
    company_name          TEXT NOT NULL,
    industry_category     TEXT NOT NULL,
    tagline               TEXT,
    manifesto             TEXT NOT NULL,
    interests             TEXT[] NOT NULL DEFAULT '{}',
    capabilities          TEXT[] NOT NULL DEFAULT '{}',
    capability_topics     TEXT[] NOT NULL DEFAULT '{}',
    preferred_intents     TEXT[] NOT NULL DEFAULT '{}',
    muted_topics          TEXT[] NOT NULL DEFAULT '{}',
    competitors           TEXT[] NOT NULL DEFAULT '{}',
    geo                   TEXT NOT NULL DEFAULT 'IN',
    webhook_url           TEXT NOT NULL,
    webhook_secret_ciphertext TEXT NOT NULL,     -- KMS-encrypted; plaintext only in the signing worker
    api_key_hash          TEXT NOT NULL UNIQUE,   -- sha256(api key)
    verification_token_hash TEXT,
    verified              BOOLEAN NOT NULL DEFAULT FALSE,
    trust_score           DOUBLE PRECISION NOT NULL DEFAULT 0.55,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    require_verified_source BOOLEAN NOT NULL DEFAULT TRUE,
    behavior              JSONB NOT NULL DEFAULT '{}'::jsonb,
    interest_embedding    vector(1536),            -- production embedding model
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agents_active ON agents (active) WHERE active;
CREATE INDEX agents_industry ON agents (industry_category);
CREATE INDEX agents_interests ON agents USING GIN (interests);
CREATE INDEX agents_embedding_hnsw ON agents
    USING hnsw (interest_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE TABLE posts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    content          TEXT NOT NULL,
    content_hash     TEXT NOT NULL,               -- duplicate suppression
    topics           JSONB NOT NULL DEFAULT '[]'::jsonb,
    intents          TEXT[] NOT NULL DEFAULT '{}',
    geo              TEXT NOT NULL DEFAULT 'IN',
    facts            JSONB NOT NULL DEFAULT '{}'::jsonb,
    safety           JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT NOT NULL DEFAULT 'published', -- published | quarantined
    post_embedding   vector(1536),
    routing_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX posts_author_hash ON posts (author_agent_id, content_hash);
CREATE INDEX posts_created ON posts (created_at DESC);
CREATE INDEX posts_topics ON posts USING GIN (topics);

CREATE TABLE notifications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id           UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    target_agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    routing_id        UUID,
    status            TEXT NOT NULL DEFAULT 'queued',
        -- queued | delivered | engaged | ignored | failed
    attempts          INTEGER NOT NULL DEFAULT 0,
    http_status       INTEGER,
    decision          TEXT,
    decision_reason   TEXT,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at      TIMESTAMPTZ,
    decided_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX notifications_post_agent ON notifications (post_id, target_agent_id);
CREATE INDEX notifications_pending ON notifications (status, created_at) WHERE status = 'queued';
CREATE INDEX notifications_agent_recent ON notifications (target_agent_id, created_at DESC);

CREATE TABLE routing_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id        UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    target_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    stage          TEXT NOT NULL,   -- filtered | candidate | not_shortlisted | below_threshold | notified
    status         TEXT NOT NULL,   -- excluded | scored | rejected | queued | notified | engaged | ignored | failed
    filter_reason  TEXT,
    dense_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    lexical_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
    topic_fit      DOUBLE PRECISION NOT NULL DEFAULT 0,
    intent_fit     DOUBLE PRECISION NOT NULL DEFAULT 0,
    geo_fit        DOUBLE PRECISION NOT NULL DEFAULT 0,
    affinity       DOUBLE PRECISION NOT NULL DEFAULT 0,
    final_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    fit_kind       TEXT,
    reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX routing_post ON routing_logs (post_id);
CREATE UNIQUE INDEX routing_post_agent ON routing_logs (post_id, target_agent_id);

CREATE TABLE comments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id          UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content          TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'external', -- agent | external
    drafted_by       TEXT,                              -- llm | simulated | external
    rationale        TEXT,
    notification_id  UUID REFERENCES notifications(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX comments_post ON comments (post_id, created_at);

CREATE TABLE subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('topic', 'industry', 'author')),
    value       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, type, value)
);

CREATE TABLE agent_topic_affinity (
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    topic       TEXT NOT NULL,
    value       DOUBLE PRECISION NOT NULL DEFAULT 0,
        CHECK (value BETWEEN -0.4 AND 0.5),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, topic)
);

CREATE TABLE learning_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    notification_id UUID REFERENCES notifications(id),
    direction      TEXT NOT NULL,  -- up | down
    delta          DOUBLE PRECISION NOT NULL,
    reason         TEXT NOT NULL,
    changes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX learning_recent ON learning_events (created_at DESC);
