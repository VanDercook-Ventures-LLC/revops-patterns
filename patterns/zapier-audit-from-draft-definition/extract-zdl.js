/**
 * Pull a Zap's full draft definition out of the Zapier editor.
 *
 * Open  https://zapier.com/editor/<ZAP_ID>/draft  while logged in, open the
 * browser console, paste this, press Enter. A JSON file downloads.
 *
 * Why this and not the API: the public Workflow API needs an OAuth app with the
 * `zap` scope, the internal v4 endpoint returns nodes without params or titles,
 * and the editor canvas is virtualized — at 60+ steps it will not screenshot or
 * scroll into a scraper. But the editor is a Next.js page and the *entire* draft,
 * every field mapping included, is already in `__NEXT_DATA__` on first render.
 *
 * Read-only. Nothing is sent anywhere; the file lands in your Downloads folder.
 */
(() => {
  const page = window.__NEXT_DATA__?.props?.pageProps;
  const zap = page?.zap;
  if (!zap?.draft?.zdl) throw new Error('No draft definition on this page — are you on /editor/<id>/draft?');

  const meta = Object.fromEntries(Object.entries(zap).filter(([k]) => k !== 'draft'));
  const payload = JSON.stringify(
    { exported_at: new Date().toISOString(), zap_id: page.zapId, zap_meta: meta, draft: zap.draft },
    null, 2,
  );

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = `zap-${page.zapId}-draft-zdl.json`;
  document.body.appendChild(a); a.click(); a.remove();
  return `${(payload.length / 1024).toFixed(0)} KB — ${zap.title}`;
})();
