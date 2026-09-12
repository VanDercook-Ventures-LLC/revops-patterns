/**
 * Follow Up Boss -> Google Sheets full account export
 *
 * Built to archive a CRM seat before its connection is removed. Zapier's own
 * Zap history only reaches back 29-69 days; the CRM account itself holds the
 * complete record.
 *
 * Runs as a Code by Zapier "Run JavaScript" step. It is RESUMABLE: each run
 * pulls as many pages as fit inside its time budget, appends them to a sheet,
 * and hands back a cursor. Feed that cursor into the next run until done.
 *
 * SETUP
 *   1. Packages icon        -> toggle ON @zapier/zapier-sdk (latest)
 *   2. App connection icon  -> add BOTH:
 *        - the Follow Up Boss account being exported
 *        - a Google Sheets account that can write the target sheet
 *      Note each Account ID variable and set them below.
 *   3. Fill in the SETTINGS block below. No Input Data required -- Code by Zapier
 *      only offers inputData on the ACTION version, not the trigger, so everything
 *      this needs is a constant you edit in place.
 *   4. Set "Extended runtime (seconds)" to 300 on the Configure tab so the whole
 *      account finishes in one pass. Without it the step stops around 500 rows
 *      and hands back a cursor to resume from.
 *   5. Run it. While `done` is false, paste the returned nextCursor into CURSOR
 *      below (or the cursor Input Data row) and run again.
 *
 * Auth: zapier.fetch() injects each connection's credentials. No API keys.
 */

import { createZapierSdk } from '@zapier/zapier-sdk';

const zapier = createZapierSdk();

// ---------------------------------------------------------------- SETTINGS
// Account ID variables from the App connection panel.
const FUB_CONN_VAR    = 'follow_up_boss';      // <- your Account ID variable
const SHEETS_CONN_VAR = 'google_sheets';       // <- your Account ID variable

// The long id in the sheet URL between /d/ and /edit
const SPREADSHEET_ID  = '';
const SHEET_NAME      = 'Sheet1';   // the TAB name, not the file name. Input Data wins if set.

// Leave '' for the first run. After each run, paste the returned nextCursor
// here and run again, until the output says done: true.
const CURSOR          = '';
// -------------------------------------------------------------------------

const FUB   = 'https://api.followupboss.com/v1';
const PAGE  = 100;            // FUB maximum

// How long to keep fetching before handing back a cursor.
// A code step gets ~30s by default, and the SDK costs ~10s of startup on top of
// whatever this budget allows -- a 20s budget measured ~24s of real step time.
// To finish a large account in one pass, set the step's "Extended runtime
// (seconds)" field (Configure tab, below the code) to 300 and raise this to
// 240000. Extended runtime bills more than one task, which is irrelevant for a
// one-off archive.
const BUDGET_MS = 240000;

const FLUSH_EVERY_PAGES = 5;

// Google rejects an oversized append with a 413. Row count is a bad proxy for
// payload size because the fullJson column varies hugely per contact, so every
// append is chunked by estimated bytes instead.
const MAX_APPEND_BYTES = 800000;

const HEADER = [
  'id', 'created', 'updated', 'name', 'stage', 'source', 'sourceUrl',
  'assignedTo', 'primaryEmail', 'primaryPhone', 'tags', 'address', 'fullJson',
];

const resolveConn = (connections, preferred, inputValue) => {
  if (inputValue) return String(inputValue);
  if (!connections) return null;
  if (preferred && connections[preferred]) return connections[preferred];
  return null;
};

const first = (arr, key) => {
  if (!Array.isArray(arr) || !arr.length) return '';
  const primary = arr.find((x) => x && x.isPrimary);
  return String(((primary || arr[0]) || {})[key] ?? '');
};

const addressOf = (p) => {
  const a = (p.addresses || [])[0] || {};
  return [a.street, [a.city, a.state].filter(Boolean).join(', '), a.code]
    .filter(Boolean).join(' ').trim();
};

export default async function main(ctx) {
  // inputData exists on the action version of Code by Zapier and not the trigger.
  // Constants win when set, so this runs either way.
  const inputData = (ctx && ctx.inputData) || {};

  // Input Data wins when present -- it is the field a human can see and edit in the
  // step. The constants are the fallback for the trigger version, which has no
  // Input Data at all. Getting this the wrong way round silently ignores whatever
  // is typed into the UI.
  const spreadsheetId = (String(inputData.spreadsheetId || '') || SPREADSHEET_ID).trim();
  const sheetName     = (String(inputData.sheetName || '') || SHEET_NAME || 'Sheet1').trim();
  if (!spreadsheetId) {
    throw new Error('Set SPREADSHEET_ID at the top of this file: the id in the sheet URL between /d/ and /edit');
  }

  const conns  = (typeof connections !== 'undefined' && connections) ? connections : null;
  const fubConn    = resolveConn(conns, FUB_CONN_VAR, inputData.fubConnection);
  const sheetsConn = resolveConn(conns, SHEETS_CONN_VAR, inputData.sheetsConnection);

  if (!fubConn || !sheetsConn) {
    const names = conns ? Object.keys(conns).join(', ') : '(none attached)';
    throw new Error(
      'Could not resolve both connections. Attach the Follow Up Boss account and a Google '
      + `Sheets account in the App connection panel, then set FUB_CONN_VAR and SHEETS_CONN_VAR. `
      + `Account ID variables currently visible: ${names}`
    );
  }

  const started = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - started);

  // ---- Follow Up Boss --------------------------------------------------
  // Keyset pagination via the opaque `next` cursor. FUB's docs strongly prefer
  // it over offset, and enforce it once you page deep.
  const fetchPage = async (cursor) => {
    const qs = new URLSearchParams({ limit: String(PAGE), fields: 'allFields' });
    if (cursor) qs.set('next', cursor);
    const res = await zapier.fetch(`${FUB}/people?${qs}`, {
      connection: fubConn,
      method: 'GET',
      headers: { Accept: 'application/json' },
      maxTimeSeconds: 20,
    });
    if (res.status === 429) {
      const retry = res.headers?.get?.('Retry-After');
      throw new Error(`Rate limited by Follow Up Boss. Retry-After ${retry || 'unknown'}s. Re-run with the same cursor.`);
    }
    if (!res.ok) throw new Error(`Follow Up Boss ${res.status} ${res.statusText}`);
    return res.json();
  };

  // ---- Google Sheets ---------------------------------------------------
  const postRows = async (rows) => {
    if (!rows.length) return;
    const range = encodeURIComponent(`${sheetName}!A1`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`
      + `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await zapier.fetch(url, {
      connection: sheetsConn,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
      maxTimeSeconds: 20,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch (_) {}
      throw new Error(`Google Sheets ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
  };

  // Split whatever is handed to us into requests Google will accept. A single
  // row larger than the cap still goes on its own rather than being dropped.
  const appendRows = async (rows) => {
    let batch = [];
    let bytes = 0;
    for (const row of rows) {
      const size = JSON.stringify(row).length;
      if (batch.length && bytes + size > MAX_APPEND_BYTES) {
        await postRows(batch);
        appendRequests += 1;
        batch = [];
        bytes = 0;
      }
      batch.push(row);
      bytes += size;
    }
    if (batch.length) {
      await postRows(batch);
      appendRequests += 1;
    }
  };

  const toRow = (p) => ([
    p.id ?? '',
    p.created ?? '',
    p.updated ?? '',
    p.name || [p.firstName, p.lastName].filter(Boolean).join(' '),
    p.stage ?? '',
    p.source ?? '',
    p.sourceUrl ?? '',
    p.assignedTo ?? '',
    first(p.emails, 'value'),
    first(p.phones, 'value'),
    Array.isArray(p.tags) ? p.tags.join(' | ') : '',
    addressOf(p),
    // Nothing is lost: the untouched record travels with every row.
    JSON.stringify(p),
  ]);

  let cursor = (String(inputData.cursor || '') || CURSOR).trim() || null;
  const firstRun = !cursor;
  let written = 0, pages = 0, total = null, appendRequests = 0;
  const buffer = [];
  const errors = [];

  if (firstRun) await appendRows([HEADER]);

  while (timeLeft() > 6000) {
    const data = await fetchPage(cursor);
    pages += 1;
    const people = data?.people || [];
    if (total === null) total = data?._metadata?.total ?? null;

    if (people.length) {
      buffer.push(...people.map(toRow));
      written += people.length;
    }

    // Flush every few pages: fewer round trips than appending per page, but
    // frequent enough that a timeout costs at most a few hundred rows.
    if (buffer.length >= PAGE * FLUSH_EVERY_PAGES) {
      await appendRows(buffer);
      buffer.length = 0;
    }

    cursor = data?._metadata?.next || null;
    if (!cursor || !people.length) break;
  }

  if (buffer.length) await appendRows(buffer);

  return {
    done: !cursor,
    nextCursor: cursor || '',
    rowsWrittenThisRun: written,
    pagesThisRun: pages,
    appendRequests,
    reportedTotal: total,
    elapsedMs: Date.now() - started,
    errors,
    // Feed this straight back into the next run's `cursor` input.
    note: cursor
      ? `More to fetch. Paste this into CURSOR at the top of the code and run again: ${cursor}`
      : 'Export complete.',
  };
}
