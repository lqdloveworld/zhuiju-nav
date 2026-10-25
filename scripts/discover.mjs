#!/usr/bin/env node
/**
 * 资源发现流水线：自动找新站 -> 去重 -> 探活 -> 进 pending 观察期 -> 满期转正
 * 用法: node scripts/discover.mjs [--dry] [--max 40]
 *
 * 候选来源（可自由增删 SOURCES）：
 *   1. 已订阅的公开索引（JSON / Markdown / README），自动提取外链
 *   2. data/candidates.json 手工投递（前端"提交"表单或 Issue 都改这里）
 * 安全性：新站只进 pending，前端默认隐藏；必须连续 N 天可访问才转正，避免一次性进主表。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { probe, pool, hostOf } from './lib/http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = {
  db: path.join(ROOT, 'data/resources.json'),
  cand: path.join(ROOT, 'data/candidates.json'),
  arch: path.join(ROOT, 'data/archive.json'),
};
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const MAX_NEW = Number(args.includes('--max') ? args[args.indexOf('--max') + 1] : 40);
const OBSERVE_DAYS = 7;       // 观察期
const MIN_UPTIME = 0.6;       // 观察期内成功率门槛
const today = new Date().toISOString().slice(0, 10);

// 订阅源：返回 [{url, name?, desc?, category?}]
const SOURCES = [
  { id: 'zhuiju', url: 'https://raw.githubusercontent.com/xiangfeigao/movie_resource/main/resources/resources.json', type: 'json' },
  { id: 'zhuiju-readme', url: 'https://raw.githubusercontent.com/xiangfeigao/movie_resource/main/README.md', type: 'md' },
];

const db = JSON.parse(await fs.readFile(F.db, 'utf8'));
const cand = await safeJson(F.cand, { pending: [], rejected: [] });
const arch = await safeJson(F.arch, { archived: [] });

const known = new Set([
  ...db.resources.flatMap((r) => [hostOf(r.url), ...(r.mirrors || []).map(hostOf)]),
  ...arch.archived.flatMap((r) => [hostOf(r.url)]),
  ...cand.pending.map((c) => c.host),
  ...cand.rejected.map((c) => c.host),
  ...(cand.blocklist || []),
]);

// ---------- 1. 采集 ----------
const harvested = [];
for (const src of SOURCES) {
  try {
    const res = await fetch(src.url, { headers: { 'user-agent': 'nav-discover/1.0' } });
    if (!res.ok) { console.log(`跳过 ${src.id}: HTTP ${res.status}`); continue; }
    const text = await res.text();
    const found = src.type === 'json' ? fromJson(text, src.id) : fromMarkdown(text, src.id);
    harvested.push(...found);
    console.log(`采集 ${src.id}: ${found.length} 条`);
  } catch (e) {
    console.log(`采集 ${src.id} 失败: ${String(e.message).slice(0, 80)}`);
  }
}

// ---------- 2. 去重 ----------
const fresh = [];
const seenHost = new Set();
for (const h of harvested) {
  const host = hostOf(h.url);
  if (!host || known.has(host) || seenHost.has(host)) continue;
  seenHost.add(host);
  fresh.push({ ...h, host });
}
console.log(`去重后新增候选: ${fresh.length}（上限 ${MAX_NEW}）`);

// ---------- 3. 探活（死链直接进 rejected，不污染 pending） ----------
const checked = await pool(fresh.slice(0, MAX_NEW), 6, async (c) => {
  const r = await probe(c.url, { timeout: 10000 });
  return { c, r };
});
let added = 0, rejected = 0;
for (const { c, r } of checked) {
  if (!r.ok && !r.limited) {
    cand.rejected.push({ host: c.host, url: c.url, name: c.name, at: today, reason: `probe ${r.code || r.error}` });
    rejected++;
    continue;
  }
  cand.pending.push({
    id: c.host.replace(/[^a-z0-9]+/gi, '-'),
    name: c.name || c.host,
    url: c.url,
    host: c.host,
    category: c.category || 'online',
    tags: [],
    desc: c.desc || `自动发现于 ${c.from}`,
    source: c.from,
    status: 'pending',
    firstSeen: today,
    failStreak: 0,
    lastOk: today,
    check: { code: r.code, ms: r.ms, at: new Date().toISOString() },
    runs: [{ d: today, ok: r.ok }],
  });
  added++;
}
console.log(`探活通过 ${added} 条进入 pending，剔除 ${rejected} 条死链`);

// ---------- 4. 观察期转正 ----------
let promoted = 0;
const stillPending = [];
for (const c of cand.pending) {
  const days = daysBetween(c.firstSeen, today);
  const runs = c.runs || [];
  const uptime = runs.length ? runs.filter((x) => x.ok).length / runs.length : 0;
  if (days >= OBSERVE_DAYS && uptime >= MIN_UPTIME) {
    if (hostOf(c.url)) {
      db.resources.push({
        id: c.id,
        name: c.name,
        url: c.url,
        category: c.category || 'online',
        tags: c.tags || [],
        desc: c.desc,
        mirrors: [],
        scores: { rich: 3, fast: 3, clean: 3, stable: Math.max(1, Math.round(uptime * 5)) },
        rating: 3,
        status: 'live',
        firstSeen: c.firstSeen,
        lastOk: c.lastOk || today,
        failStreak: 0,
        source: c.source,
        check: c.check,
      });
      promoted++;
      continue;
    }
    // 观察期结束但域名解析不到，丢掉
    cand.rejected.push({ ...c, reason: `观察期 ${days} 天，可用率 ${(uptime * 100) | 0}%` });
    continue;
  }
  stillPending.push(c);
}
cand.pending = stillPending;
db.updatedAt = new Date().toISOString();
console.log(`转正 ${promoted} 条，pending 剩余 ${cand.pending.length} 条`);

if (!DRY && (added || promoted || rejected)) {
  await fs.writeFile(F.db, JSON.stringify(db, null, 2) + '\n');
  await fs.writeFile(F.cand, JSON.stringify(cand, null, 2) + '\n');
  console.log('CHANGED=true');
}
if (DRY) console.log('(--dry 未写盘)');

// ---------- 解析器 ----------
function fromJson(text, from) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(j) ? j : j.resources || j.items || j.data || [];
  return list
    .map((x) => ({
      url: x.url || x.link || x.href,
      name: x.name || x.title,
      desc: x.desc || x.description || '',
      category: mapCat(x.category || x.cat || x.type),
      from,
    }))
    .filter((x) => isHttp(x.url));
}
function fromMarkdown(text, from) {
  const out = [];
  const re = /\[([^\]]{1,40})\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, name, url] = m;
    if (/github\.com|t\.me|img|badge|shields\.io|creativecommons/i.test(url)) continue;
    out.push({ name, url, from, category: mapCat(name + url), desc: '' });
  }
  return out;
}
function mapCat(s = '') {
  const t = String(s).toLowerCase();
  if (/netdisk|网盘|panso|夸克|百度|aliyun|pan\./.test(t)) return 'panso';
  if (/magnet|bt|torrent|磁力|种子/.test(t)) return 'magnet';
  if (/novel|book|小说|书|txt|library/.test(t)) return 'novel';
  if (/tvbox|接口|json|config/.test(t)) return 'tvbox';
  if (/app|客户端/.test(t)) return 'app';
  if (/github|开源|oss/.test(t)) return 'oss';
  return 'online';
}
function isHttp(u) { return typeof u === 'string' && /^https?:\/\//.test(u); }
function daysBetween(a, b) { return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400e3)); }
async function safeJson(p, def) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return def; } }
