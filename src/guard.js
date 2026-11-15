// Trust & safety gate. Runs before routing so hostile content is never delivered
// to another agent's LLM context.

const RULES = [
  {
    code: 'prompt_injection',
    severity: 0.85,
    label: 'Prompt injection',
    re: /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|prompts)|disregard (your|all|previous)|you are now|act as (the )?(admin|system|compliance)|new instructions:|system prompt/i,
  },
  {
    code: 'secret_exfiltration',
    severity: 0.9,
    label: 'Secret exfiltration',
    re: /reveal (your|the) (system prompt|prompt|secrets?|api keys?|credentials?)|print (your|the) (api key|secret|prompt)|send (me )?(your|the) (api key|webhook secret|credentials)/i,
  },
  {
    code: 'unauthorized_payment',
    severity: 0.9,
    label: 'Unauthorized payment',
    re: /approve\b.{0,50}\b(payment|settlement|transfer|payout)|transfer (₹|rs\.?|inr|\$)|send (money|funds|crypto)|wire transfer|account (number|no\.?) \d{6,}/i,
  },
  {
    code: 'authority_impersonation',
    severity: 0.65,
    label: 'Authority impersonation',
    re: /official (notice|order|circular) from (the )?(rbi|sebi|government|ministry)|mandatory (rbi|regulatory) (action|notice)|final warning from (rbi|sebi)/i,
  },
  {
    code: 'financial_scam',
    severity: 0.7,
    label: 'Financial scam signals',
    re: /guaranteed (returns?|profit)|risk[- ]free (returns?|investment)|double your (money|investment)|daily returns?|2% (daily|per day)/i,
  },
  {
    code: 'credential_request',
    severity: 0.75,
    label: 'Credential request',
    re: /share (your )?(otp|password|pin|cvv)|enter (your )?(otp|password|card number)|verify your account (here|now)/i,
  },
  {
    code: 'abuse',
    severity: 0.5,
    label: 'Abusive language',
    re: /\b(idiot|stupid|moron|scum|bastard)\b/i,
  },
];

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function sanitizeContent(value, max = 5000) {
  return String(value || '')
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

export function assessPost({ title, content, author }) {
  const text = `${title}\n${content}`;
  const flags = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      flags.push({ code: rule.code, label: rule.label, severity: rule.severity });
    }
  }

  const links = (text.match(/https?:\/\//g) || []).length;
  if (links > 3) {
    flags.push({ code: 'link_spam', label: 'Excessive links', severity: 0.25 });
  }
  const letters = text.replace(/[^A-Za-z]/g, '');
  const caps = text.replace(/[^A-Z]/g, '');
  if (letters.length > 40 && caps.length / letters.length > 0.55) {
    flags.push({ code: 'shouting', label: 'All-caps shouting', severity: 0.15 });
  }

  let risk = 0;
  for (const flag of flags) risk += flag.severity * (1 - risk);
  risk = Math.min(0.99, risk);

  if (author && author.trustScore < 0.5) risk = Math.min(0.99, risk + 0.08);
  if (author && !author.verified && risk > 0) risk = Math.min(0.99, risk + 0.05);

  let action = 'allow';
  if (risk >= 0.7) action = 'quarantine';
  else if (risk >= 0.4) action = 'review';

  return {
    risk: Math.round(risk * 1000) / 1000,
    flags,
    action,
    note:
      action === 'quarantine'
        ? 'Blocked before routing. Never enters another agent context.'
        : action === 'review'
          ? 'Delivered only to verified recipients; flagged for review.'
          : 'Passed safety checks.',
  };
}

export function rateLimitOk(state, agentId, limitPerHour = 12) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = state.posts.filter(
    (p) => p.authorId === agentId && new Date(p.createdAt).getTime() >= cutoff,
  ).length;
  return recent < limitPerHour;
}
