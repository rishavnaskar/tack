/**
 * Grants the owner makes by hand, and revoking one. A grant lets runs act on
 * the domains and kinds of action it names without asking each time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import type { RouteContext } from './context.ts';

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleCapabilityRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/capabilities' && req.method === 'POST') {
    await grant(ctx, req, res);
    return true;
  }
  const cap = url.pathname.match(/^\/api\/capabilities\/([\w-]+)$/);
  if (cap && req.method === 'DELETE') {
    ctx.app.capabilities.revoke(cap[1]);
    sendJson(res, { revoked: true });
    return true;
  }
  return false;
}

/** What the person reads. */
const COPY = {
  needsLabel: 'Say what this grant is for.',
  needsSite: 'Name at least one site, like example.com.',
  needsKind: 'Choose what kind of action it covers.',
  notSite: '“{site}” isn’t a site. Name one like example.com, or .example.com for it and its subdomains.',
  wholeSuffix: '“{site}” would cover every site that ends in {suffix}. Name one site, like example{suffix}.',
};

/**
 * Endings shared by unrelated sites. A grant on one reaches all of them, so
 * none can be granted whole; the list is the ones a person is likely to type.
 */
const SHARED_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in', 'gen.in', 'ind.in',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.sg', 'com.my', 'co.za', 'com.mx', 'co.kr',
  'com.tr', 'com.hk', 'com.tw', 'co.il', 'com.ar', 'co.id', 'com.ph', 'com.vn', 'com.pk', 'com.ng', 'co.ke', 'github.io', 'herokuapp.com',
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
]);

/**
 * A site as a grant names it: lower case, without a scheme, path or port,
 * with a leading dot kept for "and its subdomains". Null, with why, when it
 * names no one site.
 */
export function grantSite(raw: string): { site: string } | { problem: string } {
  const typed = raw.trim();
  let s = typed.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  const wide = s.startsWith('.') || s.startsWith('*.');
  s = s.replace(/^\*?\./, '');
  const labels = s.split('.');
  const shaped = labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) && /[a-z]/.test(labels[labels.length - 1] ?? '');
  if (!s || !shaped) return { problem: COPY.notSite.replace('{site}', typed) };
  if (labels.length < 2 || SHARED_SUFFIXES.has(s)) {
    const suffix = '.' + s;
    return { problem: COPY.wholeSuffix.replace('{site}', typed).replace(/\{suffix\}/g, suffix) };
  }
  return { site: (wide ? '.' : '') + s };
}

async function grant(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, Bodies.Grant);
  if (!body.label?.trim()) return sendJson(res, { error: COPY.needsLabel, field: 'label' }, 400);
  if (!body.domains?.some((d) => d.trim())) return sendJson(res, { error: COPY.needsSite, field: 'domains' }, 400);
  if (!body.sensitivities?.length) return sendJson(res, { error: COPY.needsKind, field: 'sensitivities' }, 400);
  // Checked here, not only in the page: a grant is a standing yes, and one on junk or on all of .com is not one anyone meant.
  const domains: string[] = [];
  for (const d of body.domains.filter((x) => x.trim())) {
    const r = grantSite(d);
    if ('problem' in r) return sendJson(res, { error: r.problem, field: 'domains' }, 400);
    if (!domains.includes(r.site)) domains.push(r.site);
  }
  try {
    const capability = ctx.app.capabilities.grant({
      label: body.label.trim(),
      workerId: body.workerId ?? null,
      domains,
      sensitivities: body.sensitivities,
      actionKinds: body.actionKinds ?? null,
      recipients: body.recipients ?? null,
      maxUses: body.maxUses ?? null,
      expiresAt: body.expiresInHours
        ? new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString()
        : null,
    });
    ctx.emit({ type: 'capability_granted', id: capability.id, label: capability.label });
    sendJson(res, capability);
  } catch (err) {
    sendJson(res, { error: (err as Error).message }, 400);
  }
}
