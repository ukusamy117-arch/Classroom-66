const STRIP = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'report-to', 'nel', 'alt-svc',
  'clear-site-data', 'set-cookie'
]);
// 내부망/로컬 주소 접근 차단 (SSRF 방지)
const PRIVATE = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1?\]?$|\[?f[cd][0-9a-f]{2}:)/i;

export async function relay(request, accessKey) {
  const err = (m, s = 502) => new Response(m, {
    status: s,
    headers: { 'x-relay-error': '1', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });

  if (accessKey && request.headers.get('x-key') !== accessKey)
    return err('접근 키가 없거나 올바르지 않습니다. 홈 화면의 설정에서 접근 키를 입력하세요.', 401);

  let target;
  try { target = new URL(new URL(request.url).searchParams.get('u')); }
  catch { return err('잘못된 URL', 400); }
  if (!/^https?:$/.test(target.protocol) || PRIVATE.test(target.hostname)) return err('허용되지 않는 대상입니다.', 403);

  const h = new Headers();
  for (const k of ['accept', 'accept-language', 'content-type', 'range', 'user-agent']) {
    const v = request.headers.get(k); if (v) h.set(k, v);
  }
  const ck = request.headers.get('x-cookie'); if (ck) h.set('cookie', ck);
  h.set('referer', target.origin + '/');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (hasBody) h.set('origin', target.origin);

  let up;
  try {
    up = await fetch(target.href, {
      method: request.method, headers: h, redirect: 'follow',
      body: hasBody ? await request.arrayBuffer() : undefined
    });
  } catch (e) { return err('대상 서버에 연결할 수 없습니다: ' + e.message); }

  const out = new Headers();
  up.headers.forEach((v, k) => { if (!STRIP.has(k)) out.set(k, v); });
  const cc = out.get('cache-control');               // 공유 CDN 캐시 방지 (접근 키 우회 차단)
  if (cc) out.set('cache-control', cc.replace(/s-maxage=\d+,?\s*/i, '').replace(/\bpublic\b/i, 'private'));
  out.set('x-final-url', up.redirected ? up.url : target.href);
  const sc = up.headers.getSetCookie ? up.headers.getSetCookie() : [];
  if (sc.length) out.set('x-set-cookie', encodeURIComponent(JSON.stringify(sc)));

  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
}
