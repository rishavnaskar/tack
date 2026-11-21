/**
 * Hosts Fanfold must not work on from this extension.
 *
 * The list comes from Fanfold's site catalog in the handshake: sites whose
 * terms rule out automation by a browser extension. It is enforced here as
 * well as in the app because this is the side that holds the user's
 * sign-ins, and it should refuse by itself whatever it is asked.
 *
 * Fanfold's own pages are refused the same way. In its own window the app
 * blocks requests to them; here there is no request interception, so the
 * attach, navigate and after-commit checks are what keep an agent out of the
 * page that holds the person's key.
 */

export const COPY = {
  ownPage: "That is Fanfold's own page, which only you use. Fanfold does not work inside it.",
};

let denyHosts = [];
/** Fanfold's own origins ("http://127.0.0.1:4318"), as the app reports them. */
let ownOrigins = new Set();

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

export function setDenyHosts(hosts) {
  denyHosts = Array.isArray(hosts)
    ? hosts.filter((h) => typeof h === 'string' && h.length > 0).map((h) => h.toLowerCase())
    : [];
}

/** Only loopback origins: the app's pages are on this machine and nowhere else. */
export function setOwnOrigins(origins) {
  ownOrigins = new Set(Array.isArray(origins)
    ? origins.filter((o) => typeof o === 'string').map((o) => o.toLowerCase()).filter((o) => LOOPBACK_ORIGIN.test(o))
    : []);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** Same rule as the catalog: a leading dot covers the domain and every subdomain. */
function matches(host, pattern) {
  if (pattern.startsWith('.')) return host === pattern.slice(1) || host.endsWith(pattern);
  return host === pattern;
}

function ownHostOf(url) {
  if (!ownOrigins.size) return null;
  try {
    const parsed = new URL(url);
    return ownOrigins.has(parsed.origin.toLowerCase()) ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isOwnHost(host) {
  for (const origin of ownOrigins) if (new URL(origin).host === host) return true;
  return false;
}

/** The denied host a URL is on (with its port, for Fanfold's own pages), or null when Fanfold may work there. */
export function deniedHost(url) {
  const own = ownHostOf(url ?? '');
  if (own) return own;
  const host = hostOf(url ?? '');
  if (!host) return null;
  return denyHosts.some((pattern) => matches(host, pattern)) ? host : null;
}

export function denyMessage(host) {
  if (isOwnHost(host)) return COPY.ownPage;
  return `Fanfold does not work on ${host} from your Chrome: that site's terms do not allow automation ` +
    "from a browser extension. Use Fanfold's own window for it.";
}

/** Pages chrome.debugger can attach to. Browser pages (chrome://, the new tab page) are not. */
export function attachable(url) {
  return !url || /^(https?:|file:|data:|blob:|about:blank)/i.test(url);
}
