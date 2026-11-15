// Topic ontology, lightweight extraction and hashed-vector embeddings.
// The production design swaps this module for a real embedding model + pgvector;
// everything downstream (recall, scoring, feedback) stays the same.

export const TOPICS = {
  food_delivery: {
    label: 'Food delivery',
    terms: ['food delivery', 'delivery order', 'restaurant', 'cloud kitchen', 'swiggy', 'zomato', 'order food', 'delivery partner', 'dark kitchen', 'biryanis', 'food orders'],
    allies: ['payments', 'cards', 'loyalty', 'quick_commerce', 'dining'],
  },
  quick_commerce: {
    label: 'Quick commerce',
    terms: ['quick commerce', 'q-commerce', 'q commerce', '10-minute', '10 minute delivery', 'instant delivery', 'dark store', 'instamart', 'blinkit', 'zepto', 'qcommerce'],
    allies: ['food_delivery', 'payments', 'logistics', 'loyalty', 'cards'],
  },
  payments: {
    label: 'Payments',
    terms: ['upi', 'phonepe', 'paytm', 'payment', 'payments', 'merchant acquiring', 'mdr', 'settlement', 'wallet', 'checkout', 'payment gateway', 'psp', 'remittance'],
    allies: ['food_delivery', 'ecommerce', 'quick_commerce', 'cards', 'loyalty', 'fintech_lending', 'security'],
  },
  cards: {
    label: 'Cards & rewards',
    terms: ['credit card', 'debit card', 'cards', 'card', 'card issuer', 'issuer', 'reward points', 'co-branded', 'cobranded', 'visa', 'mastercard', 'rupay'],
    allies: ['food_delivery', 'ecommerce', 'travel', 'loyalty', 'payments', 'dining'],
  },
  banking: {
    label: 'Banking',
    terms: ['bank', 'banking', 'savings account', 'fixed deposit', 'current account', 'interest rate', 'treasury', 'deposit'],
    allies: ['payments', 'cards', 'fintech_lending', 'auto_finance', 'insurance'],
  },
  ecommerce: {
    label: 'E-commerce',
    terms: ['e-commerce', 'ecommerce', 'marketplace', 'flipkart', 'amazon', 'myntra', 'seller', 'online sale', 'big billion', 'gmv', 'catalog', 'd2c'],
    allies: ['payments', 'cards', 'logistics', 'advertising', 'fintech_lending', 'quick_commerce'],
  },
  logistics: {
    label: 'Logistics',
    terms: ['logistics', 'last mile', 'last-mile', 'warehouse', 'fulfilment', 'fulfillment', 'courier', 'shipping', 'supply chain', 'delivery fleet', 'fleet'],
    allies: ['ecommerce', 'food_delivery', 'quick_commerce', 'automotive'],
  },
  automotive: {
    label: 'Automotive',
    terms: ['automotive', 'two-wheeler', 'two wheeler', 'scooter', 'motorcycle', 'vehicle', 'dealer network', 'bajaj', 'ather', 'car'],
    allies: ['ev', 'auto_finance', 'insurance', 'fuel', 'logistics'],
  },
  ev: {
    label: 'Electric vehicles',
    terms: ['electric vehicle', 'electric scooter', 'ev', 'charging', 'battery', 'battery-as-a-service', 'charging station', 'electrification', 'swap network'],
    allies: ['automotive', 'auto_finance', 'fuel', 'logistics'],
  },
  auto_finance: {
    label: 'Vehicle finance',
    terms: ['auto loan', 'vehicle finance', 'dealer finance', 'fleet finance', 'car loan', 'two-wheeler loan', 'ev finance', 'auto finance'],
    allies: ['automotive', 'ev', 'banking', 'cards'],
  },
  fintech_lending: {
    label: 'Consumer lending',
    terms: ['bnpl', 'buy now pay later', 'credit line', 'lending', 'consumer credit', 'instant loan', 'underwriting', 'nbfc'],
    allies: ['payments', 'ecommerce', 'banking', 'cards'],
  },
  travel: {
    label: 'Travel',
    terms: ['travel', 'flight', 'hotel', 'booking', 'makemytrip', 'trip', 'homestay'],
    allies: ['cards', 'payments', 'loyalty', 'insurance'],
  },
  loyalty: {
    label: 'Loyalty',
    terms: ['loyalty', 'rewards', 'reward points', 'membership', 'subscription program', 'points', 'cashback program'],
    allies: ['food_delivery', 'ecommerce', 'cards', 'travel', 'payments', 'dining'],
  },
  advertising: {
    label: 'Advertising',
    terms: ['advertising', 'ad spend', 'retail media', 'media buy', 'cpm', 'influencer', 'sponsored placement'],
    allies: ['food_delivery', 'ecommerce', 'quick_commerce', 'telecom', 'travel'],
  },
  insurance: {
    label: 'Insurance',
    terms: ['insurance', 'policy', 'premium', 'insurer', 'motor insurance', 'health insurance'],
    allies: ['automotive', 'travel', 'banking', 'cards'],
  },
  fuel: {
    label: 'Fuel & energy',
    terms: ['petrol', 'diesel', 'fuel', 'cng', 'fuel price'],
    allies: ['automotive', 'ev', 'payments'],
  },
  telecom: {
    label: 'Telecom',
    terms: ['telecom', 'recharge', 'data plan', 'airtel', 'jio', 'sim card'],
    allies: ['advertising', 'payments', 'ecommerce'],
  },
  dining: {
    label: 'Dining',
    terms: ['dining', 'dine-in', 'dine in', 'table reservation', 'restaurant booking', 'dineout'],
    allies: ['food_delivery', 'cards', 'loyalty', 'travel'],
  },
  security: {
    label: 'Security & fraud',
    terms: ['fraud', 'cyber', 'breach', 'security', 'risk engine', 'authentication', 'chargeback'],
    allies: ['payments', 'banking', 'fintech_lending'],
  },
  regulation: {
    label: 'Regulation',
    terms: ['rbi', 'sebi', 'regulatory', 'compliance', 'circular', 'guideline', 'licence'],
    allies: ['banking', 'payments', 'fintech_lending', 'cards'],
  },
};

export const INDUSTRIES = {
  'Food Delivery': {
    topics: ['food_delivery', 'quick_commerce', 'loyalty'],
    capabilities: ['food_delivery', 'quick_commerce'],
  },
  'Payments & Fintech': {
    topics: ['payments', 'fintech_lending', 'loyalty'],
    capabilities: ['payments', 'fintech_lending'],
  },
  Banking: {
    topics: ['banking', 'cards', 'loyalty'],
    capabilities: ['banking', 'cards', 'auto_finance'],
  },
  'Cards & Banking': {
    topics: ['cards', 'banking', 'payments'],
    capabilities: ['cards', 'payments', 'loyalty'],
  },
  'E-commerce': {
    topics: ['ecommerce', 'logistics', 'advertising'],
    capabilities: ['ecommerce', 'logistics', 'advertising'],
  },
  Automotive: {
    topics: ['automotive', 'ev', 'auto_finance', 'fuel'],
    capabilities: ['automotive', 'ev'],
  },
  'EV & Mobility': {
    topics: ['ev', 'automotive', 'fuel'],
    capabilities: ['ev', 'charging'],
  },
  'Travel & Hospitality': {
    topics: ['travel', 'dining', 'loyalty'],
    capabilities: ['travel', 'dining'],
  },
  Telecom: {
    topics: ['telecom', 'advertising'],
    capabilities: ['telecom'],
  },
  'Logistics & Supply Chain': {
    topics: ['logistics', 'automotive'],
    capabilities: ['logistics'],
  },
  'Insurance': {
    topics: ['insurance', 'banking'],
    capabilities: ['insurance'],
  },
  Other: { topics: [], capabilities: [] },
};

const STOPWORDS = new Set(
  'a an and are as at be been being but by can could do does for from had has have how i if in into is it its just like may might more most much must my new no not now of on or our out over own same she should so some such than that the their them then there these they this those through to too under up us very was we were what when where which while who will with would you your about above after again against all also any because before below between both during each few further he her here him his itself me only other per s t until via'.split(
    ' ',
  ),
);

const GEO_TERMS = {
  IN: ['india', 'inr', '₹', 'diwali', 'delhi', 'mumbai', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'chennai', 'upi', 'rupee'],
  US: ['usa', 'united states', 'usd', '$', 'thanksgiving', 'black friday'],
  AE: ['uae', 'dubai', 'aed'],
  GB: ['uk', 'united kingdom', 'gbp', '£'],
  GLOBAL: ['global', 'worldwide', 'international'],
};

const INTENT_PATTERNS = [
  ['request', /looking for|seeking|we need|request(ing)?|rfp|invite|apply|partner with us|call for|integrat|pilot with/],
  ['offer', /(% off|percent off|discount|cashback|offer|deal|sale|coupon|free|save up to|flat ₹|₹\d|rs\.?\s?\d)/],
  ['announcement', /launch|introduc|announc|now live|unveil|is rolling out|rolls out|partnership with|opens /],
  ['alert', /outage|fraud|breach|security incident|urgent|compliance action|regulatory action/],
  ['market_update', /report|growth|survey|gmv|market share|quarter|q[1-4]|revenue|data shows|increased|declined|forecast/],
];

const TOPIC_ALIASES = {
  'q-commerce': 'quick_commerce',
  'quick-commerce': 'quick_commerce',
  'e-commerce': 'ecommerce',
  'd2c': 'ecommerce',
  'electric-vehicle': 'ev',
  'financial-services': 'banking',
};

const PHRASE_TERMS = Object.entries(TOPICS).flatMap(([topic, meta]) =>
  meta.terms.map((term) => ({ topic, term: term.toLowerCase() })),
);
PHRASE_TERMS.sort((a, b) => b.term.length - a.term.length);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stem(token) {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9₹%]+/)
    .map(stem)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function isNegated(text, index) {
  const prefix = text.slice(Math.max(0, index - 48), index);
  const clause = prefix.split(/[.!?;]/).pop();
  return /\b(not|no|never|without|excluding|avoid|isn't|aren't|don't|doesn't)\b/i.test(clause);
}

function countTerms(text) {
  const hits = {};
  for (const { topic, term } of PHRASE_TERMS) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, 'g');
    let match;
    let count = 0;
    while ((match = re.exec(text)) && count < 8) {
      const start = match.index + match[1].length;
      if (!isNegated(text, start)) count += 1;
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
    if (count) hits[topic] = (hits[topic] || 0) + count;
  }
  return hits;
}

export function detectTopics(title, content = '') {
  const titleText = normalizeText(title);
  const bodyText = normalizeText(content);
  const titleHits = countTerms(titleText);
  const bodyHits = countTerms(bodyText);
  const hits = { ...bodyHits };
  for (const [topic, count] of Object.entries(titleHits)) {
    hits[topic] = (hits[topic] || 0) + count;
  }
  const topics = Object.entries(hits)
    .map(([topic, count]) => {
      const inTitle = Boolean(titleHits[topic]);
      const weight = Math.min(1, 0.35 + 0.22 * count + (inTitle ? 0.15 : 0));
      return { topic, weight, hits: count, titleHit: inTitle };
    })
    .sort((a, b) => Number(b.titleHit) - Number(a.titleHit) || b.weight - a.weight || b.hits - a.hits);
  return topics.slice(0, 6);
}

export function topicScoresFromText(text, multiplier = 1) {
  return Object.fromEntries(detectTopics('', text).map((t) => [t.topic, Math.min(1, t.weight * multiplier)]));
}

export function detectIntents(title, content = '') {
  const text = normalizeText(`${title} ${content}`);
  const intents = INTENT_PATTERNS.filter(([, re]) => re.test(text)).map(([intent]) => intent);
  if (!intents.length) intents.push('announcement');
  // Requests are the strongest commercial signal; keep the primary intent meaningful.
  const priority = ['request', 'offer', 'alert', 'announcement', 'market_update'];
  intents.sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return intents;
}

export function detectGeo(title, content = '') {
  const text = normalizeText(`${title} ${content}`);
  for (const [geo, terms] of Object.entries(GEO_TERMS)) {
    if (terms.some((term) => text.includes(term))) return geo;
  }
  return 'IN';
}

export function extractDealFacts(title, content = '') {
  const text = `${title} ${content}`;
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/)?.[1];
  const money = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)(?:\s*(cr|crore|lakh|l|k))?/i);
  const expiry = text.match(/(?:valid till|until|before|by)\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:[–-]\d{1,2})?)/);
  let moneyLabel = null;
  let moneyValue = null;
  if (money) {
    const amount = Number(money[1].replace(/,/g, ''));
    const unit = (money[2] || '').toLowerCase();
    const scale = unit.startsWith('cr') ? 1e7 : unit.startsWith('lak') || unit === 'l' ? 1e5 : unit === 'k' ? 1e3 : 1;
    moneyValue = amount * scale;
    moneyLabel = money[0].trim();
  }
  return {
    percent: percent ? Number(percent) : null,
    moneyLabel,
    moneyValue,
    expiryHint: expiry?.[1] || null,
  };
}

export function keySentence(title, content) {
  const sentence = String(content || '').split(/(?<=[.!?])\s+/)[0] || title;
  return sentence.length > 150 ? `${sentence.slice(0, 147)}...` : sentence;
}

// Stable, dependency-free embedding. Production: text-embedding-3-small (1536d).
const DIM = 256;

function hash32(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function embed(text, topics = []) {
  const vec = new Float32Array(DIM);
  const tokens = tokenize(text);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  for (const [token, count] of counts) {
    const weight = (1 + Math.log(count)) * (token.includes('_') ? 0.55 : 1);
    const idx = hash32(token) % DIM;
    const sign = hash32(token, 0x9e3779b9) & 1 ? 1 : -1;
    vec[idx] += sign * weight;
  }
  for (const t of topics) {
    const key = `topic:${t.topic || t}`;
    const weight = 2.4 * (t.weight ?? 1);
    const idx = hash32(key) % DIM;
    vec[idx] += weight;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i += 1) vec[i] = Math.round((vec[i] / norm) * 1e6) / 1e6;
  return Array.from(vec);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

export function profileDocument(agent) {
  return [
    agent.manifesto,
    agent.manifesto,
    (agent.interests || []).join('. '),
    (agent.capabilities || []).join('. '),
    (agent.topicWeights ? Object.keys(agent.topicWeights).map((t) => TOPICS[t]?.label || t).join('. ') : ''),
    (agent.capabilityWeights ? Object.keys(agent.capabilityWeights).map((t) => TOPICS[t]?.label || t).join('. ') : ''),
    agent.industry,
  ]
    .filter(Boolean)
    .join('. ');
}

export function buildTopicWeights(manifesto, explicitTopics = [], industry) {
  const weights = {};
  for (const topic of explicitTopics) {
    const key = TOPIC_ALIASES[topic] || topic;
    if (TOPICS[key]) weights[key] = 1;
  }
  const inferred = topicScoresFromText(manifesto, 0.85);
  for (const [topic, weight] of Object.entries(inferred)) {
    weights[topic] = Math.max(weights[topic] || 0, Math.min(0.82, weight));
  }
  const preset = INDUSTRIES[industry];
  if (preset) {
    for (const topic of preset.topics) weights[topic] = Math.max(weights[topic] || 0, 0.65);
  }
  return weights;
}

export function buildCapabilityWeights(capabilities = [], industry) {
  const weights = {};
  const text = capabilities.join('. ');
  for (const [topic, weight] of Object.entries(topicScoresFromText(text, 1))) {
    weights[topic] = Math.max(weights[topic] || 0, Math.min(0.95, weight));
  }
  const preset = INDUSTRIES[industry];
  if (preset) {
    for (const topic of preset.capabilities) weights[topic] = Math.max(weights[topic] || 0, 0.9);
  }
  return weights;
}

export function labelForTopic(topic) {
  return TOPICS[topic]?.label || topic;
}
