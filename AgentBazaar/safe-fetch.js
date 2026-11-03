'use strict';
// SSRF-safe fetch for vendor webhooks (Node). Closes DNS rebinding without an egress proxy:
//
//   1. resolve the hostname ONCE (all A/AAAA records)
//   2. refuse if ANY address is private, loopback, link-local, CGNAT, multicast, reserved, documentation,
//      or an IPv6 form that embeds one (IPv4-mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16)
//   3. connect to exactly that validated address (custom `lookup`), so a second DNS answer can never be used.
//      TLS still verifies the certificate against the hostname (SNI + checkServerIdentity are unaffected).
//
// No redirects are followed; the body is capped; proxies from env are deliberately ignored (they would resolve
// the name again). Returns a fetch-like {status, ok, headers.get(), text(), json()}.
const dns = require('dns'), net = require('net'), http = require('http'), https = require('https');

const V4 = [
  ['0.0.0.0', 8, 'this_network'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'cgnat'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'ietf'], ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4_relay'], ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmark'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];
const V6 = [
  ['::', 128, 'unspecified'], ['::1', 128, 'loopback'], ['100::', 64, 'discard'], ['2001::', 32, 'teredo'], ['2001:db8::', 32, 'documentation'],
  ['2001:10::', 28, 'orchid'], ['2001:20::', 28, 'orchid'], ['fc00::', 7, 'unique_local'], ['fe80::', 10, 'link_local'], ['fec0::', 10, 'site_local'], ['ff00::', 8, 'multicast'],
];
function v4ToInt(a) { return a.split('.').reduce((n, o) => (n << 8) + +o, 0) >>> 0; }
function inV4(addr, base, bits) { const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (v4ToInt(addr) & m) === (v4ToInt(base) & m); }
/** Expand an IPv6 string to 8 hextets (handles :: and a trailing dotted IPv4). */
function v6Groups(a) {
  a = a.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const m = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4ToInt(m[1]); a = a.slice(0, -m[1].length) + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16); }
  const [h, t] = a.split('::');
  const head = h ? h.split(':') : [], rest = t ? t.split(':') : [];
  const g = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill('0'), ...rest];
  return g.slice(0, 8).map(x => parseInt(x || '0', 16));
}
function inV6(g, base, bits) {
  const b = v6Groups(base);
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((g[i] & m) !== (b[i] & m)) return false;
  }
  return true;
}
const g2v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');

/** null when the address is publicly routable, otherwise the reason. */
function classify(addr) {
  const fam = net.isIP(addr);
  if (fam === 4) { for (const [b, n, why] of V4) if (inV4(addr, b, n)) return why; if (addr === '255.255.255.255') return 'broadcast'; return null; }
  if (fam === 6 || /^\[.*\]$/.test(addr)) {
    const g = v6Groups(addr);
    if (inV6(g, '::', 128)) return 'unspecified';
    if (inV6(g, '::1', 128)) return 'loopback';
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return classify(g2v4(g[6], g[7])) && 'ipv4_mapped_' + classify(g2v4(g[6], g[7]));   // ::ffff:a.b.c.d
    if (g.slice(0, 6).every(x => x === 0) && (g[6] || g[7])) return 'ipv4_compatible';                                                      // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) { const r = classify(g2v4(g[6], g[7])); return r && 'nat64_' + r; }
    if (g[0] === 0x2002) { const r = classify(g2v4(g[1], g[2])); return r && '6to4_' + r; }
    for (const [b, n, why] of V6) if (inV6(g, b, n)) return why;
    return null;
  }
  return 'not_an_ip';
}

function createSafeFetch(opts = {}) {
  const resolve = opts.resolve || (async host => (await dns.promises.lookup(host, { all: true, verbatim: true })).map(r => r.address));
  const allowHttp = !!opts.allowHttp, maxBytes = opts.maxBytes || 1024 * 1024;
  const request = opts.request || null;   // tests inject a transport

  return async function safeFetch(url, init = {}) {
    let u; try { u = new URL(url); } catch { throw new Error('egress_blocked:bad_url'); }
    if (u.username || u.password) throw new Error('egress_blocked:credentials_in_url');
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('egress_blocked:scheme');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : await resolve(host);
    if (!addrs || !addrs.length) throw new Error('egress_blocked:no_address');
    for (const a of addrs) { const why = classify(a); if (why) throw new Error('egress_blocked:' + why); }
    const pinned = addrs[0], family = net.isIP(pinned);
    // Connect only to the validated address, whatever DNS says later.
    const lookup = (_h, o, cb) => { if (typeof o === 'function') cb = o; if (o && o.all) cb(null, [{ address: pinned, family }]); else cb(null, pinned, family); };
    const lib = request || (u.protocol === 'https:' ? https.request : http.request);
    const headers = { ...(init.headers || {}) };
    return new Promise((resolveP, reject) => {
      const req = lib({ protocol: u.protocol, hostname: host, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
        method: init.method || 'GET', headers, lookup, agent: false, servername: net.isIP(host) ? undefined : host, signal: init.signal }, res => {
        const chunks = []; let n = 0;
        res.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(new Error('egress_blocked:response_too_large')); return; } chunks.push(c); });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolveP({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, connected_to: pinned,
            headers: { get: k => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
            text: async () => body, json: async () => JSON.parse(body) });
        });
        res.on('error', reject);
      });
      req.on('error', e => reject(e && e.name === 'AbortError' ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : e));
      if (init.body) req.write(init.body);
      req.end();
    });
  };
}

module.exports = { createSafeFetch, classify };
