'use strict';
/* Light Proxy Service Worker
 * - /service/<base64url(URL)>  : 프록시 내비게이션
 * - 프록시 페이지에서 나가는 모든 하위 요청(cross-origin 포함)을 릴레이로 중계
 */
const PREFIX = '/service/';
const RELAY = '/api/relay';
const PASS = /^\/(?:$|index\.html$|sw\.js$|api\/|lib\/)/;   // 프록시 자체 경로는 건드리지 않음

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* ---------- IndexedDB KV (설정/쿠키 저장) ---------- */
let dbp;
const db = () => dbp ||= new Promise((ok, no) => {
  const r = indexedDB.open('px', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
const kvGet = async (k) => { const d = await db(); return new Promise((ok) => {
  const q = d.transaction('kv').objectStore('kv').get(k);
  q.onsuccess = () => ok(q.result); q.onerror = () => ok(undefined); }); };
const kvSet = async (k, v) => { const d = await db(); return new Promise((ok) => {
  const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k);
  t.oncomplete = t.onerror = t.onabort = () => ok(); }); };

let cfgCache, jar;
const getCfg = async () => cfgCache ||= ((await kvGet('cfg')) || {});
const loadJar = async () => jar ||= ((await kvGet('jar')) || {});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'cfg') { cfgCache = d.cfg || {}; e.waitUntil(kvSet('cfg', cfgCache)); }
  if (d.type === 'clear') { jar = {}; e.waitUntil(kvSet('jar', jar)); }
});

/* ---------- 간이 쿠키 저장소 (도메인 기준) ---------- */
async function cookieFor(host) {
  const j = await loadJar(), out = [];
  for (const d in j) if (host === d || host.endsWith('.' + d))
    for (const n in j[d]) out.push(n + '=' + j[d][n]);
  return out.join('; ');
}
async function storeCookies(host, list) {
  const j = await loadJar(); let dirty = false;
  for (const c of list) {
    const parts = c.split(';'), i = parts[0].indexOf('=');
    if (i < 1) continue;
    const n = parts[0].slice(0, i).trim(), v = parts[0].slice(i + 1).trim();
    let d = host, del = false;
    for (const a of parts.slice(1)) {
      const [k, ...r] = a.split('='), key = k.trim().toLowerCase(), val = r.join('=').trim();
      if (key === 'domain' && val) d = val.replace(/^\./, '').toLowerCase();
      else if (key === 'max-age' && Number(val) <= 0) del = true;
      else if (key === 'expires' && Date.parse(val) < Date.now()) del = true;
    }
    if (!(host === d || host.endsWith('.' + d))) continue;   // 타 도메인 쿠키 주입 차단
    (j[d] ||= {});
    if (del) delete j[d][n]; else j[d][n] = v;
    dirty = true;
  }
  if (dirty) await kvSet('jar', j);
}

/* ---------- URL 인코딩 ---------- */
const b64e = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = (s) => new TextDecoder().decode(
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function decodeTarget(u) {            // u: 프록시 URL 객체 → 실제 URL 문자열
  try {
    const tok = u.pathname.slice(PREFIX.length).split('/')[0];
    const t = new URL(b64d(tok));
    if (!/^https?:$/.test(t.protocol)) return null;
    if (u.search) t.search = u.search;  // GET 폼 제출 시 쿼리 교체
    return t.href;
  } catch { return null; }
}
function realFromProxyUrl(href) {
  try {
    const u = new URL(href);
    return (u.origin === location.origin && u.pathname.startsWith(PREFIX)) ? decodeTarget(u) : null;
  } catch { return null; }
}
async function baseOf(e) {            // 이 요청을 보낸 페이지가 프록시 페이지라면 실제 URL 반환
  const req = e.request;
  let ref = '';
  if (req.mode === 'navigate') ref = req.referrer;
  else if (e.clientId) { const c = await self.clients.get(e.clientId); if (c) ref = c.url; }
  if (!ref) ref = req.referrer;
  return realFromProxyUrl(ref);
}

/* ---------- fetch 핸들러 ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  let u; try { u = new URL(req.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  const own = u.origin === location.origin;

  if (own && u.pathname.startsWith(PREFIX)) { e.respondWith(serve(req, decodeTarget(u))); return; }
  if (own && PASS.test(u.pathname)) return;

  e.respondWith((async () => {
    const base = await baseOf(e);
    if (!base) return fetch(req);     // 프록시 페이지가 아니면 그대로 통과
    return serve(req, own ? new URL(u.pathname + u.search, base).href : u.href);
  })());
});

/* ---------- 프록시 요청 처리 ---------- */
const strip = (s) => { const u = new URL(s); u.hash = ''; return u.href; };

async function serve(req, target) {
  const nav = req.mode === 'navigate';
  if (!target) return nav ? page('잘못된 주소', '프록시 주소를 해석할 수 없습니다.') : new Response('bad url', { status: 400 });
  try {
    const cfg = await getCfg();
    const host = new URL(target).hostname;

    const h = new Headers();
    for (const k of ['accept', 'accept-language', 'content-type', 'range']) {
      const v = req.headers.get(k); if (v) h.set(k, v);
    }
    const ck = await cookieFor(host); if (ck) h.set('x-cookie', ck);
    if (cfg.key) h.set('x-key', cfg.key);

    const init = { method: req.method, headers: h, credentials: 'omit', cache: nav ? 'no-cache' : 'default' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();

    const r = await fetch(RELAY + '?u=' + encodeURIComponent(target), init);

    if (r.headers.has('x-relay-error')) {
      const m = await r.text();
      return nav ? page('프록시 오류 (' + r.status + ')', m) : new Response(m, { status: r.status });
    }

    const sc = r.headers.get('x-set-cookie');
    if (sc) { try { await storeCookies(host, JSON.parse(decodeURIComponent(sc))); } catch {} }

    const final = r.headers.get('x-final-url') || target;
    if (nav && strip(final) !== strip(target)) {          // 리다이렉트 → 주소창도 프록시 URL로 갱신
      return Response.redirect(location.origin + PREFIX + b64e(strip(final)), 302);
    }

    const out = new Headers();
    r.headers.forEach((v, k) => { if (!/^x-(final-url|set-cookie|relay-error)$/.test(k)) out.set(k, v); });
    const ct = r.headers.get('content-type') || '';

    if (nav && /^(text\/html|application\/xhtml\+xml)/i.test(ct)) {
      const html = rewriteHtml(decode(await r.arrayBuffer(), ct), final, cfg);
      out.set('content-type', 'text/html; charset=utf-8');
      out.set('cache-control', 'no-store');
      return new Response(html, { status: r.status, statusText: r.statusText, headers: out });
    }
    // 그 외 리소스는 스트림 그대로 통과 (메모리 절약)
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
  } catch (err) {
    return nav ? page('연결 실패', String(err)) : new Response(String(err), { status: 502 });
  }
}

/* ---------- HTML 재작성 (정규식 기반, DOM 파싱 없음) ---------- */
function decode(buf, ct) {
  let cs = (/charset=["']?([\w-]+)/i.exec(ct) || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toProxy = (u, base) => {
  try {
    const a = new URL(u.replace(/&amp;/g, '&'), base);
    if (!/^https?:$/.test(a.protocol)) return u;
    const h = a.hash; a.hash = '';
    return PREFIX + b64e(a.href) + h;
  } catch { return u; }
};

/* 클라이언트 훅: 링크/폼/window.open/pushState 를 프록시 주소로 보정 + 미니 툴바 */
function hook(o) {
  var P = location.origin + '/service/', B = o.base;
  var enc = function (s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var px = function (u) {
    try {
      if (String(u).indexOf(P) === 0) return u;
      var a = new URL(u, B);
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
      var h = a.hash; a.hash = '';
      return P + enc(a.href) + h;
    } catch (e) { return u; }
  };
  var fixA = function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href],area[href]');
    if (!a) return;
    var r = a.getAttribute('href');
    if (!r) return;
    if (r.charAt(0) === '#') { if (e.type === 'click' && !e.defaultPrevented) { e.preventDefault(); location.hash = r; } return; }
    var p = px(r); if (p !== r) a.setAttribute('href', p);
  };
  document.addEventListener('click', fixA, true);
  document.addEventListener('auxclick', fixA, true);
  document.addEventListener('contextmenu', fixA, true);
  document.addEventListener('submit', function (e) {
    var f = e.target; if (!f || !f.getAttribute) return;
    var r = f.getAttribute('action');
    f.setAttribute('action', px(r ? r : B));
  }, true);
  ['pushState', 'replaceState'].forEach(function (m) {
    var f = history[m];
    history[m] = function (s, t, u) { return f.call(history, s, t, u == null ? u : px(String(u))); };
  });
  var wo = window.open;
  window.open = function (u) { var a = Array.prototype.slice.call(arguments); if (u) a[0] = px(String(u)); return wo.apply(window, a); };
  if (o.title) try { Object.defineProperty(document, 'title', { get: function () { return o.title; }, set: function () {} }); } catch (e) {}

  if (o.pill && window.top === window) document.addEventListener('DOMContentLoaded', function () {
    var host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    var s = host.attachShadow({ mode: 'closed' });
    s.innerHTML = '<style>*{box-sizing:border-box;font:13px system-ui}button,input{border:0;border-radius:8px;padding:6px 10px;background:#262626;color:#e5e5e5}#w{display:flex;gap:4px;align-items:center;opacity:.35}#w:hover,#w:focus-within{opacity:1}#m{display:none;gap:4px}#w.o #m{display:flex}input{width:220px;outline:1px solid #404040}</style><div id="w"><span id="m"><input id="i" placeholder="URL / 검색"><button id="g">Go</button><button id="h">홈</button></span><button id="t">⋯</button></div>';
    var w = s.getElementById('w'), i = s.getElementById('i');
    s.getElementById('t').onclick = function () { w.classList.toggle('o'); if (w.classList.contains('o')) i.focus(); };
    var go = function () {
      var v = i.value.trim(); if (!v) return;
      if (!/^https?:\/\//i.test(v)) v = /^([\w-]+\.)+[a-z]{2,}(:\d+)?([\/?#]\S*)?$/i.test(v) ? 'https://' + v : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(v);
      location.href = px(v);
    };
    s.getElementById('g').onclick = go;
    i.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    s.getElementById('h').onclick = function () { location.href = '/'; };
    (document.body || document.documentElement).appendChild(host);
  });
}
const HOOK_SRC = hook.toString();

function rewriteHtml(html, pageUrl, cfg) {
  let base = pageUrl;
  html = html
    // 페이지 자체 <base> 제거 (유효 base 계산 후 우리 것으로 교체)
    .replace(/<base\b[^>]*>/gi, (m) => {
      const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m);
      if (h) { try { base = new URL(h[1] ?? h[2] ?? h[3], pageUrl).href; } catch {} }
      return '';
    })
    // 메타 CSP 제거
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    // meta refresh
    .replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*?url=)([^"'>\s]+)/gi,
      (m, a, u) => a + toProxy(u, base))
    // iframe / frame src (교차 출처 내비게이션은 SW가 못 잡으므로 직접 치환)
    .replace(/(<i?frame\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, u) =>
      (!u || /^(about:|javascript:|data:|blob:|#)/i.test(u)) ? m : a + q + toProxy(u, base) + q);

  let inject = '<base href="' + esc(base) + '">';
  if (cfg.title) {      // 탭 위장: 원본 title / favicon 제거 후 사용자 값 주입
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
               .replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b[^>]*>/gi, '');
    inject += '<title>' + esc(cfg.title) + '</title>';
  }
  if (cfg.icon) {
    if (!cfg.title) html = html.replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b[^>]*>/gi, '');
    inject += '<link rel="icon" href="' + esc(cfg.icon) + '">';
  }
  const opts = JSON.stringify({ base, title: cfg.title || '', pill: cfg.pill !== false }).replace(/</g, '\\u003c');
  inject += '<script>(' + HOOK_SRC + ')(' + opts + ')</script>';

  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + inject);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + inject);
  return inject + html;
}

function page(title, msg) {
  return new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>' + esc(title) +
    '</title><body style="font:16px system-ui;background:#0a0a0a;color:#ddd;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:32rem;padding:1rem"><h1 style="font-size:1.25rem">' +
    esc(title) + '</h1><p style="color:#999;word-break:break-word">' + esc(msg) + '</p><a href="/" style="color:#7dd3fc">← 홈으로</a></div>',
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
