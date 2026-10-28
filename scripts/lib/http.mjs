// 轻量 HTTP 探活：只读首页响应头 + 首块响应体，下载 8KB 即断开，不解析内容。
// 返回 { code, ms, ok, limited, error }
import http from 'node:http';
import https from 'node:https';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 部分站点（多为 WAF 生成）返回的响应头带多余空格，undici 会直接判协议错误。
// 浏览器能容忍，所以这里加一条宽松解析的兜底通道，避免把好站误判成「不可达」。
function probeRaw(url, { timeout = 12000, maxBytes = 8192 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        insecureHTTPParser: true,
        timeout,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/json,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          range: `bytes=0-${maxBytes - 1}`,
        },
      },
      (res) => {
        const ms = Date.now() - started;
        const code = res.statusCode || 0;
        const limited = [401, 403, 418, 429, 451].includes(code);
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got >= maxBytes) res.destroy();
        });
        res.on('close', () => finish({ code, ms, ok: code >= 200 && code < 400, limited, error: '' }));
        res.on('error', () => finish({ code, ms, ok: code >= 200 && code < 400, limited, error: '' }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ code: 0, ms: Date.now() - started, ok: false, limited: false, error: 'timeout' });
    });
    req.on('error', (e) =>
      finish({ code: 0, ms: Date.now() - started, ok: false, limited: false, error: String(e?.code || e?.message || e).slice(0, 120) }),
    );
    req.end();
  });
}

export async function probe(url, opts = {}) {
  const timeout = opts.timeout ?? 12000;
  const maxBytes = opts.maxBytes ?? 8192;
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
    // fetch 失败（含严格协议解析报错）时走宽松解析兜底，避免误判
    if (!/abort/i.test(msg)) {
      const r = await probeRaw(url, { timeout: Math.max(3000, timeout - (Date.now() - started)), maxBytes });
      if (r.code) return r;
    }
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
