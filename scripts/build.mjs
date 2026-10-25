#!/usr/bin/env node
/**
 * 编译数据 -> 静态站可直接 fetch 的 web/data.json
 * 同时输出 stats.json（给首页做数据条）
 * 用法: node scripts/build.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const db = JSON.parse(await fs.readFile(path.join(ROOT, 'data/resources.json'), 'utf8'));
const report = await safeJson(path.join(ROOT, 'reports/availability.json'), { sites: {} });

const STATUS_ORDER = { live: 0, limited: 1, pending: 2, unreachable: 3, dead: 4 };
const CAT_ORDER = new Map(db.categories.map((c, i) => [c.id, i]));

const items = db.resources
  .map((r) => {
    const runs = report.sites?.[r.id]?.runs?.slice(-30) || [];
    const up = runs.length ? runs.filter((x) => x.ok).length / runs.length : null;
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      mirrors: r.mirrors || [],
      host: safeHost(r.url),
      category: r.category,
      tags: r.tags || [],
      desc: r.desc || '',
      status: r.status,
      scores: r.scores,
      rating: r.rating ?? avg(r.scores),
      uptime: up == null ? null : Math.round(up * 100),
      ms: r.check?.ms ?? null,
      code: r.check?.code ?? null,
      lastOk: r.lastOk || null,
      firstSeen: r.firstSeen || null,
      // 前端默认只隐藏确认死亡的站；"当前出口不可达"仍需展示（可能是区域封锁）
      visible: r.status !== 'dead',
      search: [r.name, r.desc, ...(r.tags || []), safeHost(r.url)].join(' ').toLowerCase(),
    };
  })
  .sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      b.rating - a.rating ||
      a.name.localeCompare(b.name, 'zh'),
  );

const cats = db.categories
  .map((c) => ({
    ...c,
    count: items.filter((i) => i.category === c.id && i.visible).length,
    total: items.filter((i) => i.category === c.id).length,
  }))
  .filter((c) => c.total > 0)
  .sort((a, b) => (CAT_ORDER.get(a.id) ?? 9) - (CAT_ORDER.get(b.id) ?? 9));

const out = {
  generatedAt: new Date().toISOString(),
  updatedAt: db.updatedAt,
  categories: cats,
  items,
  stats: {
    total: items.length,
    live: items.filter((i) => i.status === 'live').length,
    limited: items.filter((i) => i.status === 'limited').length,
    dead: items.filter((i) => i.status === 'dead').length,
    pending: items.filter((i) => i.status === 'pending').length,
    avgMs: meanMs(items.map((i) => i.ms).filter((n) => typeof n === 'number' && n > 0)),
  },
};

await fs.mkdir(path.join(ROOT, 'web'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'web/data.json'), JSON.stringify(out));
await fs.writeFile(
  path.join(ROOT, 'web/sitemap.txt'),
  ['/', ...cats.map((c) => `/?cat=${c.id}`)].join('\n') + '\n',
);
console.log(
  `生成 web/data.json | ${out.stats.total} 条 (live ${out.stats.live} / limited ${out.stats.limited} / dead ${out.stats.dead} / pending ${out.stats.pending}) | 分类 ${cats.length}`,
);

function avg(s) { return s ? Math.round(((s.rich + s.fast + s.clean + s.stable) / 4) * 10) / 10 : 3; }
function meanMs(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }
function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
async function safeJson(p, def) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return def; } }
