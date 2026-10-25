// 轻量 HTTP 探活：只读首页响应头 + 首块响应体，下载 8KB 即断开，不解析内容。
// 返回 { code, ms, ok, limited, error }
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function probe(url, { timeout = 12000, maxBytes = 8192 } = {}) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        range: 'bytes=0-' + (maxBytes - 1),
      },
    });
    const ms = Date.now() - started;
    const code = res.status;

    // 读完首块就中断，避免把整站拉下来
    try {
      const reader = res.body?.getReader();
      if (reader) {
        let got = 0;
        while (got < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value?.byteLength || 0;
        }
        await reader.cancel().catch(() => {});
      } else {
        await res.arrayBuffer();
      }
    } catch {
      /* body 中断属正常，不影响判定 */
    }

    const limited =
      code === 401 || code === 403 || code === 418 || code === 429 || code === 451;
    const ok = code >= 200 && code < 400;
    return { code, ms, ok, limited, error: '' };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = String(e?.name === 'AbortError' ? 'timeout' : e?.message || e);
    return { code: 0, ms, ok: false, limited: false, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// 并发池
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { error: String(e?.message || e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// host 归一化：去协议/www/尾斜杠，用于去重
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
