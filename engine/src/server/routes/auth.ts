/**
 * Signing in and out. The page signs in with Firebase, hands the ID token
 * here once, and lets go of it: the token is checked, who it names is
 * remembered, and the token itself is kept nowhere.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import type { RouteContext } from './context.ts';
import { TokenError, type TokenVerifier } from '../../auth/verify.ts';
import { accountOf, isSignedIn, signIn, signOut } from '../../auth/account.ts';
import type { FirebaseConfig } from '../../auth/config.ts';
import { access, accessView } from '../../auth/access.ts';

/** What the server signs in with. */
export interface AuthDeps {
  enabled: boolean;
  firebase: FirebaseConfig;
  verifier: TokenVerifier;
}

/** What the person reads. */
export const COPY = {
  off: 'Signing in is turned off in this Fanfold.',
};

/** Whether sign-in is on, who is signed in, and what the page signs in with. */
function authView(ctx: RouteContext, auth: AuthDeps): Record<string, unknown> {
  const signedIn = isSignedIn(ctx.app.store);
  const a = signedIn ? accountOf(ctx.app.store) : null;
  return {
    enabled: auth.enabled,
    signedIn,
    account: a ? { name: a.name, email: a.email, phone: a.phone, photo: a.photo, provider: a.provider } : null,
    firebase: auth.enabled ? { ...auth.firebase } : null,
    access: accessView(access(ctx.app)),
  };
}

/** The part of the app state the page decides its first screen by. */
export function authSummary(ctx: RouteContext, auth: AuthDeps): { enabled: boolean; signedIn: boolean; name: string | null; email: string | null; photo: string | null } {
  const signedIn = isSignedIn(ctx.app.store);
  const a = signedIn ? accountOf(ctx.app.store) : null;
  return { enabled: auth.enabled, signedIn, name: a?.name ?? null, email: a?.email ?? null, photo: a?.photo ?? null };
}

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleAuthRoutes(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL, auth: AuthDeps,
): Promise<boolean> {
  if (url.pathname === '/api/auth' && req.method === 'GET') {
    sendJson(res, authView(ctx, auth));
    return true;
  }
  if (url.pathname === '/api/auth/session' && req.method === 'POST') {
    const body = await readBody(req, Bodies.AuthSession);
    if (!auth.enabled) {
      sendJson(res, { error: COPY.off }, 409);
      return true;
    }
    let token;
    try {
      token = await auth.verifier.verify(body.idToken);
    } catch (err) {
      if (!(err instanceof TokenError)) throw err;
      ctx.log.info('a sign-in was not accepted', { problem: err.problem });
      sendJson(res, { error: err.message }, err.problem === 'unreachable' ? 502 : 401);
      return true;
    }
    const filled = Object.keys(signIn({ store: ctx.app.store, profile: ctx.app.profile }, token));
    ctx.log.info('signed in', { provider: token.provider, from: body.from ?? 'app', filled });
    if (filled.length) {
      ctx.emit({ type: 'profile_changed' });
      ctx.emit({ type: 'setup_changed' });
    }
    ctx.emit({ type: 'auth_changed' });
    ctx.app.recheckAccess();
    sendJson(res, authView(ctx, auth));
    return true;
  }
  if (url.pathname === '/api/auth/signout' && req.method === 'POST') {
    signOut(ctx.app.store);
    ctx.emit({ type: 'auth_changed' });
    ctx.app.recheckAccess();
    sendJson(res, authView(ctx, auth));
    return true;
  }
  return false;
}
