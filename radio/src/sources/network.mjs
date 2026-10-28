import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const urlHash = value => createHash('sha256').update(value).digest('hex');
function safeValidators(value = {}) {
  // Accept only bounded HTTP validators, never arbitrary caller-supplied headers.
  const etag = typeof value.etag === 'string' && value.etag.length <= 1024 && /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(value.etag) ? value.etag : undefined;
  const lastModified = typeof value.lastModified === 'string' && value.lastModified.length <= 64 && Number.isFinite(Date.parse(value.lastModified)) && new Date(Date.parse(value.lastModified)).toUTCString() === value.lastModified ? value.lastModified : undefined;
  return { ...(etag && {etag}), ...(lastModified && {lastModified}) };
}
export function responseValidators(url, headers = {}) {
  const validators = safeValidators({etag:headers.etag,lastModified:headers['last-modified']});
  if (!Object.keys(validators).length) return undefined;
  return {urlHash:urlHash(publicURL(url).href),...validators};
}

// Fail closed for all IPv6 except global unicast; block IPv4 special-use ranges.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address);
  return false;
}
export function publicURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid source URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports without credentials are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host))) throw new Error('Private network URLs are forbidden');
  url.hash = '';
  return url;
}
export async function resolvePublic(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address:host, family:isIP(host) }] : await lookup(host, {all:true, verbatim:true});
  if (!addresses.length || addresses.some(({address}) => !isPublicAddress(address))) throw new Error('Source resolves to a private or reserved network');
  return addresses[0];
}
// DNS is checked and pinned to the socket at EACH redirect. No cookies, authorization,
// user headers, ambient proxy credentials or remote referrers are forwarded.
export async function openPublic(value, { signal, timeoutMs = 30000, maxRedirects = 5, lookup, request: requestTransport, validators } = {}) {
  let url = publicURL(value);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    combined.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_,reject) => { onAbort = () => reject(combined.reason); combined.addEventListener('abort',onAbort,{once:true}); });
    let selected;
    try { selected = await Promise.race([resolvePublic(url, lookup),aborted]); }
    finally { combined.removeEventListener('abort',onAbort); }
    combined.throwIfAborted();
    // A redirect must not receive a different resource's validators, even on the
    // same host. Persist a digest rather than any signed final URL in metadata.
    const conditional = validators?.urlHash === urlHash(url.href) ? safeValidators(validators) : {};
    const conditionalHeaders = {
      ...(conditional.etag && {'if-none-match':conditional.etag}),
      ...(conditional.lastModified && {'if-modified-since':conditional.lastModified}),
    };
    const response = await new Promise((resolve,reject) => {
      const request = (requestTransport || ((...args) => (url.protocol === 'https:' ? https : http).get(...args)))(url, {
        signal:combined, agent:false,
        headers:{'user-agent':'HAOS-Discord-Radio/1.0','accept-encoding':'identity',...conditionalHeaders},
        lookup: (_host, options, callback) => options.all ? callback(null,[selected]) : callback(null, selected.address, selected.family),
      }, resolve);
      request.on('error', reject);
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location) throw new Error('Redirect has no destination');
      const next = publicURL(new URL(response.headers.location,url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade forbidden');
      url = next;
      continue;
    }
    if (response.statusCode !== 200 && !(response.statusCode === 304 && Object.keys(conditionalHeaders).length)) { response.destroy(); throw new Error(`Source returned HTTP ${response.statusCode}`); }
    return { body:response, headers:response.headers, url:url.href, statusCode:response.statusCode };
  }
  throw new Error('Too many redirects');
}
export async function readLimited(response, maxBytes) {
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Response exceeds byte limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) { response.body.destroy?.(); throw error; }
}
