/**
 * Follow Up Boss — consolidated contact fetch
 * Replaces Zap steps 2-5 (Person Record, Notes, Text Messages, Calls) with one step.
 *
 * SETUP (Zapier "Run JavaScript" action):
 *   1. Packages icon  -> toggle ON  @zapier/zapier-sdk (latest)
 *   2. App connection icon -> add the Follow Up Boss connection
 *   3. Input Data -> add key `personId`, map it to step 1's ID field
 *   4. Set CONNECTION_VAR below to the "Account ID variable" that panel generates
 *
 * Auth: none in this file. zapier.fetch() injects the Follow Up Boss connection's
 * credentials at runtime -- but ONLY if it is passed `connection` in its init object.
 * Per the SDK's own type definitions:
 *     fetch(url: string, init: { connection?: string; method?: string;
 *           headers?: Record<string,string>; body?: ...; maxTimeSeconds?: number })
 * Omit `connection` and every request goes out unauthenticated -> 401.
 *
 * The connection id comes from the App connection panel's "Account ID variable".
 * This file resolves it automatically; if that fails it tells you exactly what to do.
 *
 * Returns ONE top-level object, so downstream steps run exactly once.
 */

import { createZapierSdk } from '@zapier/zapier-sdk';

const zapier = createZapierSdk();

// The "Account ID variable" shown in the App connection panel.
// Set explicitly so this does not silently pick the wrong account if a second
// Follow Up Boss connection is ever attached to this step.
const CONNECTION_VAR = 'follow_up_boss';   // <- your Account ID variable

const BASE      = 'https://api.followupboss.com/v1';
const LIMIT     = 40;                                   // FUB max is 100
// FUB redacts message bodies and recording URLs, but the exact wording varies by
// account and endpoint. Observed in the wild:
//   "Content is hidden for privacy reasons."   (per the docs)
//   "* Body is hidden for privacy reasons *"   (observed on a live account)
// Match the stable middle of the phrase rather than either exact string.
const REDACTED_RE = /hidden\s+for\s+privacy\s+reasons/i;

// Resolves person.timeframeId without spending a 5th request on /v1/timeframes.
const TIMEFRAMES = {
  1: '0-3 Months',
  2: '3-6 Months',
  3: '6-12 Months',
  4: '12+ Months',
  5: 'No Plans',
};

// Domain conventions differ by vertical, so they are configured, not hardcoded.
// The default is Follow Up Boss's documented real-estate rule: a "Seller" tag
// means seller, its absence means buyer. Set to null for any vertical where
// that inference is meaningless -- an absent tag is not evidence of anything.
const LEAD_TYPE_RULE = { tag: 'seller', present: 'Seller', absent: 'Buyer' };

// Explicit field list keeps the person payload small and predictable.
// FUB does not return all fields by default; `allFields` can be very large.
const PERSON_FIELDS = [
  'id', 'name', 'firstName', 'lastName', 'created', 'updated', 'lastActivity',
  'stage', 'source', 'price', 'tags', 'contacted', 'assignedTo',
  'timeframeId', 'emails', 'phones', 'addresses', 'createdVia',
].join(',');

const stripHtml = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const isRedacted = (s) => !s || REDACTED_RE.test(String(s));

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

// The downstream summariser is instructed to emit no em/en dashes. Normalise them
// out of the source text too, so there is nothing to accidentally echo.
const noDashes = (s) => String(s || '').replace(/[\u2013\u2014]/g, '-');

export default async function main({ inputData }) {
  const personId = String(inputData.personId ?? '').trim();
  if (!/^\d+$/.test(personId)) {
    // Throw rather than return, so Zapier autoreplay can engage.
    throw new Error(`personId missing or non-numeric: "${inputData.personId}"`);
  }

  // Resolve the Follow Up Boss connection id.
  // Zapier exposes attached connections as a global `connections` object keyed by
  // the "Account ID variable" you set in the App connection panel. `typeof` guard
  // first -- a bare reference to an undeclared global throws ReferenceError.
  const conn = (() => {
    if (inputData.connection) return String(inputData.connection);
    const c = (typeof connections !== 'undefined' && connections) ? connections : null;
    if (!c) return null;
    if (CONNECTION_VAR && c[CONNECTION_VAR]) return c[CONNECTION_VAR];
    // Fall back to common spellings of an auto-generated variable name.
    const named = c.follow_up_boss || c.followupboss || c.followUpBoss || c.fub;
    if (named) return named;
    // Otherwise, if exactly one connection is attached, use it.
    const vals = Object.values(c).filter(Boolean);
    return vals.length === 1 ? vals[0] : null;
  })();

  if (!conn) {
    throw new Error(
      'No Follow Up Boss connection resolved. In the Code step: click the App connection '
      + 'icon, pick the account under "Select account connection", note the "Account ID '
      + 'variable" it generates, and Save. If the variable is not named follow_up_boss, '
      + 'either rename it to that, or add an Input Data row `connection` set to that name.'
    );
  }

  // One request. Never throws — a failed call is reported, not fatal, so a single
  // bad endpoint cannot cost you the whole summary.
  const get = async (label, path) => {
    try {
      const res = await zapier.fetch(`${BASE}${path}`, {
        connection: conn,                 // <- injects the FUB credentials
        method: 'GET',
        headers: { Accept: 'application/json' },
        maxTimeSeconds: 20,
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body?.errorMessage || '';
        } catch (_) { /* body not JSON */ }
        return {
          label,
          ok: false,
          status: res.status,
          retryAfter: res.headers?.get?.('Retry-After') || null,
          error: `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
        };
      }
      return { label, ok: true, status: res.status, data: await res.json() };
    } catch (e) {
      return { label, ok: false, status: null, error: e.message || String(e) };
    }
  };

  // NOTE: `sort` is deliberately omitted. It is undocumented on these three
  // collections, and FUB's documented default is already descending by id
  // (newest first) — the intended ordering, with no undocumented dependency.
  const [personRes, notesRes, textsRes, callsRes] = await Promise.all([
    get('person', `/people/${personId}?fields=${encodeURIComponent(PERSON_FIELDS)}`),
    get('notes',  `/notes?personId=${personId}&limit=${LIMIT}&includeThreadedReplies=true`),
    get('texts',  `/textMessages?personId=${personId}&limit=${LIMIT}`),
    get('calls',  `/calls?personId=${personId}&limit=${LIMIT}`),
  ]);

  const errors = [personRes, notesRes, textsRes, callsRes]
    .filter((r) => !r.ok)
    .map((r) => ({ source: r.label, status: r.status, error: r.error }));

  // The person call is the only one worth failing over — without it there is
  // nothing to summarise. Missing activity just means a thinner summary.
  if (!personRes.ok) {
    if (personRes.status === 401) {
      throw new Error(
        `401 from Follow Up Boss using connection "${conn}". The connection id resolved but `
        + 'was rejected. Check that the App connection panel points at the same Follow Up Boss '
        + 'account steps 2-5 use, and that it is saved.'
      );
    }
    throw new Error(`Person ${personId} fetch failed: ${personRes.error}`);
  }

  const p = personRes.data || {};

  const tags = Array.isArray(p.tags) ? p.tags : [];

  // Many accounts encode qualification data as structured `Key: Value` tags.
  // Parse them into facts. Every fact is surfaced in the transcript header, so
  // nothing here needs to know which keys a given vertical uses.
  const tagFacts = {};
  const plainTags = [];
  for (const raw of tags) {
    const m = /^([^:]+):\s*(.*)$/.exec(String(raw).trim());
    if (m && m[2]) tagFacts[m[1].trim().toLowerCase()] = m[2].trim();
    else plainTags.push(String(raw).trim());
  }

  const leadType = LEAD_TYPE_RULE
    ? (plainTags.some((t) => t.toLowerCase() === LEAD_TYPE_RULE.tag)
        ? LEAD_TYPE_RULE.present
        : LEAD_TYPE_RULE.absent)
    : null;

  const person = {
    id: p.id,
    name: p.name || [p.firstName, p.lastName].filter(Boolean).join(' '),
    stage: p.stage || null,
    source: p.source || null,
    price: p.price ?? null,
    tags,
    tagFacts,
    leadType,
    timeframe: TIMEFRAMES[p.timeframeId] || null,
    assignedTo: p.assignedTo || null,
    contactedCount: p.contacted ?? null,
    createdVia: p.createdVia || null,
    created: p.created || null,
    lastActivity: p.lastActivity || null,
    email: (p.emails || []).find((e) => e.isPrimary)?.value
        || (p.emails || [])[0]?.value || null,
    phone: (p.phones || []).find((e) => e.isPrimary)?.value
        || (p.phones || [])[0]?.value || null,
  };

  // ---- Notes -------------------------------------------------------------
  // `notes` is the array key. `body` is the richest free text in the whole set.
  const rawNotes = notesRes.ok ? (notesRes.data?.notes || []) : [];
  const notes = rawNotes
    .map((n) => ({
      date: n.created,
      author: n.createdBy || null,          // display-name string, not an id
      subject: n.subject || null,
      body: noDashes(n.isHtml ? stripHtml(n.body) : String(n.body || '').trim()),
      replies: (n.replies || [])
        .map((r) => ({ date: r.created, author: r.createdBy, body: String(r.body || '').trim() }))
        .filter((r) => r.body),
    }))
    .filter((n) => n.body || n.replies.length);

  // ---- Text messages -----------------------------------------------------
  // Array key is lowercase `textmessages`. Direction is `isIncoming`, not `direction`.
  // Redacted messages are dropped so the LLM never summarises the privacy notice.
  const rawTexts = textsRes.ok ? (textsRes.data?.textmessages || []) : [];
  const texts = rawTexts
    .filter((t) => !isRedacted(t.message))
    .map((t) => ({
      date: t.sent || t.created,
      direction: t.isIncoming ? 'inbound' : 'outbound',
      agent: t.userName || null,
      message: noDashes(String(t.message).trim()),
      hasMedia: Array.isArray(t.media) && t.media.length > 0,
    }));
  // Redacted texts still carry signal (that outreach happened, when, by whom)
  // even though the body is unavailable. Keep the metadata, drop the noise.
  const redactedTexts = rawTexts
    .filter((t) => isRedacted(t.message))
    .map((t) => ({
      date: t.sent || t.created,
      direction: t.isIncoming ? 'inbound' : 'outbound',
      agent: t.userName || null,
    }));
  const textsRedacted = redactedTexts.length;

  // ---- Calls -------------------------------------------------------------
  // `note` is the only free text. `outcome` is a useful categorical signal.
  const rawCalls = callsRes.ok ? (callsRes.data?.calls || []) : [];
  const calls = rawCalls.map((c) => ({
    date: c.created,
    direction: c.isIncoming ? 'inbound' : 'outbound',
    agent: c.userName || null,
    outcome: c.outcome || null,
    durationSec: c.duration ?? null,
    note: isRedacted(c.note) ? null : noDashes(String(c.note || '').trim()) || null,
  }));

  // ---- Truncation flags --------------------------------------------------
  // _metadata.total tells you whether limit=40 clipped the history.
  const totalOf = (r) => (r.ok ? (r.data?._metadata?.total ?? null) : null);
  const truncated = {
    notes: (totalOf(notesRes) ?? 0) > notes.length,
    texts: (totalOf(textsRes) ?? 0) > rawTexts.length,
    calls: (totalOf(callsRes) ?? 0) > rawCalls.length,
    totals: { notes: totalOf(notesRes), texts: totalOf(textsRes), calls: totalOf(callsRes) },
  };

  // ---- One chronological transcript for the AI step ----------------------
  // Feeding Claude a single clean, oldest-first narrative beats four raw JSON
  // envelopes on both token cost and summary quality.
  const events = [
    ...notes.map((n) => ({
      ts: n.date,
      line: `[NOTE] ${day(n.date)}${n.author ? ` (${n.author})` : ''}: ${n.subject ? `${n.subject}: ` : ''}${n.body}`
        + n.replies.map((r) => `\n    reply ${day(r.date)}${r.author ? ` (${r.author})` : ''}: ${r.body}`).join(''),
    })),
    ...texts.map((t) => ({
      ts: t.date,
      line: `[TEXT ${t.direction}] ${day(t.date)}${t.agent ? ` (${t.agent})` : ''}: ${t.message}${t.hasMedia ? ' [+media]' : ''}`,
    })),
    ...calls.map((c) => ({
      ts: c.date,
      line: `[CALL ${c.direction}] ${day(c.date)}${c.agent ? ` (${c.agent})` : ''}`
        + `: ${c.outcome || 'no outcome recorded'}, ${c.durationSec ?? 0}s`
        + (c.note ? `: ${c.note}` : ''),
    })),
  ]
    .filter((e) => e.ts)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));   // oldest first: reads as a story

  // A compact outreach picture. 29 near-zero-second call lines tell an LLM very
  // little individually; the pattern across them tells it a lot.
  const outreach = (() => {
    const bits = [];
    if (calls.length) {
      const connected = calls.filter((c) => (c.durationSec ?? 0) >= 30).length;
      const talk = calls.reduce((a, c) => a + (c.durationSec || 0), 0);
      const dates = calls.map((c) => c.date).filter(Boolean).sort();
      bits.push(
        `${calls.length} call attempts (${connected} lasting 30s+, total talk time ${talk}s)`
        + (dates.length ? ` between ${day(dates[0])} and ${day(dates[dates.length - 1])}` : '')
      );
      const agents = [...new Set(calls.map((c) => c.agent).filter(Boolean))];
      if (agents.length) bits.push(`callers: ${agents.join(', ')}`);
    }
    if (textsRedacted) {
      const dates = redactedTexts.map((t) => t.date).filter(Boolean).sort();
      bits.push(
        `${textsRedacted} text${textsRedacted === 1 ? '' : 's'} sent`
        + (dates.length ? ` between ${day(dates[0])} and ${day(dates[dates.length - 1])}` : '')
        + ' (bodies not exposed by the FUB API)'
      );
    }
    return bits.length ? `OUTREACH: ${bits.join('; ')}` : null;
  })();

  const header = [
    `CONTACT: ${person.name} (id ${person.id})`,
    person.leadType ? `LEAD TYPE: ${person.leadType}` : null,
    // Every structured tag fact, whatever keys this account happens to use.
    ...Object.entries(tagFacts).map(([k, v]) => `${k.toUpperCase()}: ${v}`),
    person.stage ? `STAGE: ${person.stage}` : null,
    person.timeframe ? `TIMEFRAME: ${person.timeframe}` : null,
    person.price ? `PRICE: ${person.price}` : null,
    person.source ? `SOURCE: ${person.source}` : null,
    person.assignedTo ? `ASSIGNED TO: ${person.assignedTo}` : null,
    plainTags.length ? `TAGS: ${plainTags.join(', ')}` : null,
    outreach,
  ].filter(Boolean).join('\n');

  const transcript = `${header}\n\nACTIVITY (oldest first, ${events.length} items):\n`
    + (events.length ? events.map((e) => e.line).join('\n') : '(no activity found)');

  return {
    ok: errors.length === 0,
    connectionUsed: conn,
    personId: Number(personId),
    person,
    counts: {
      notes: notes.length,
      texts: texts.length,
      calls: calls.length,
      textsRedacted,
      callAttempts: calls.length,
      events: events.length,
    },
    truncated,
    errors,                 // empty when all four succeeded
    transcript,             // <- map this into the Claude step
    notes,
    texts,
    calls,
  };
}
