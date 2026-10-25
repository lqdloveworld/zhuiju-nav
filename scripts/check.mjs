#!/usr/bin/env node
/**
 * 可用性检测 + 状态机 + 自动评分 + 自动归档
 * 用法: node scripts/check.mjs [--concurrency 8] [--timeout 12000] [--dry]
 *
 * 状态机:
 *   pending --首检成功-->  live
 *   live    --受限响应----> limited        (403/429/451，不算失败)
 *   live    --失败 x N----> dead           (N = FAIL_TO_DEAD, 默认 3)
 *   dead    --恢复--------> live
 *   dead    --超过 T 天无恢复--> archived  (移入 data/archive.json，前端不再展示)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { probe, pool, hostOf } from './lib/http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/resources.json');
const ARCHIVE = path.join(ROOT, 'data/archive.json');
const REPORT = path.join(ROOT, 'reports/availability.json');

const FAIL_TO_DEAD = 3;      // 连续失败几次判死
const ARCHIVE_AFTER_DAYS = 14; // 判死后多久无恢复则归档
const OBSERVE_DAYS = 7;      // pending 观察期
const HISTORY_KEEP = 40;     // 每个站点保留多少条检测记录

const args = process.argv.slice(2);
const CONCURRENCY = Number(arg(args, '--concurrency', 8));
const TIMEOUT = Number(arg(args, '--timeout', 12000));
const DRY = args.includes('--dry');
function arg(list, key, def) {
  const i = list.indexOf(key);
  return i >= 0 && list[i + 1] ? list[i + 1] : def;
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d) => Math.max(0, Math.round((Date.parse(today) - Date.parse(d || today)) / 86400e3));

const db = JSON.parse(await fs.readFile(DATA, 'utf8'));
const archive = await safeJson(ARCHIVE, { archived: [] });
let history = await safeJson(REPORT, { updatedAt: '', sites: {} });
history.sites ||= {};

// ---------- 1. 探活（主域名失败自动试镜像/发布页） ----------
const results = await pool(db.resources, CONCURRENCY, async (r) => {
  let res = await probe(r.url, { timeout: TIMEOUT });
  let usedMirror = null;
  if (!res.ok && !res.limited) {
    for (const m of r.mirrors || []) {
      const r2 = await probe(m, { timeout: TIMEOUT });
      if (r2.ok || r2.limited) { res = r2; usedMirror = m; break; }
    }
  }
  return { r, res, usedMirror };
});

// ---------- 2. 状态迁移 ----------
const before = new Map(db.resources.map((r) => [r.id, r.status]));
const removed = [];

for (const { r, res, usedMirror } of results) {
  r.check = {
    code: res.code,
    ms: res.ms,
    ok: res.ok,
    limited: res.limited,
    mirror: usedMirror,
    error: res.error || undefined,
    at: new Date().toISOString(),
  };

  const prev = r.status;
  if (res.ok) {
    r.failStreak = 0;
    r.lastOk = today;
    // pending 需过观察期才转正，其余直接恢复
    const seen = daysAgo(r.firstSeen);
    r.status = prev === 'pending' && seen < OBSERVE_DAYS ? 'pending' : 'live';
  } else if (res.limited) {
    // 受限：能通但被拦（CF/地区/需梯子），不算死
    r.status = 'limited';
    r.lastOk = r.lastOk || today;
  } else {
    r.failStreak = (r.failStreak || 0) + 1;
    if (r.failStreak >= FAIL_TO_DEAD) {
      r.status = 'dead';
      r.diedAt = r.diedAt || today;
    }
  }
  if (r.status === 'live') delete r.diedAt;

  // 历史打分用
  const id = r.id;
  const h = (history.sites[id] ||= { url: r.url, host: hostOf(r.url), runs: [] });
  h.url = r.url;
  h.host = hostOf(r.url);
  h.runs.push({ d: today, ok: res.ok, limited: !!res.limited, ms: res.ms, code: res.code });
  h.runs = h.runs.slice(-HISTORY_KEEP);
}

// ---------- 3. 自动评分（fast / stable 由数据算，rich / clean 人工维护） ----------
for (const { r, res } of results) {
  r.scores ||= { rich: 3, fast: 3, clean: 3, stable: 3 };
  if (res.ok) r.scores.fast = msToFast(res.ms);

  const runs = history.sites[r.id]?.runs?.slice(-30) || [];
  if (runs.length >= 3) {
    const rate = runs.filter((x) => x.ok).length / runs.length;
    r.scores.stable = Math.max(1, Math.min(5, Math.round(rate * 5)));
  }
  const s = r.scores;
  r.rating = round1((s.rich + s.fast + s.clean + s.stable) / 4);
}

// ---------- 4. 归档：长期死亡则移出主表 ----------
const keep = [];
for (const r of db.resources) {
  const deadTooLong =
    r.status === 'dead' && daysAgo(r.diedAt || r.lastOk || r.firstSeen) > ARCHIVE_AFTER_DAYS;
  if (deadTooLong) {
    archive.archived.push({
      ...r,
      archivedAt: new Date().toISOString(),
      reason: `连续失败 ${r.failStreak} 次，${ARCHIVE_AFTER_DAYS} 天未恢复`,
    });
    removed.push(r.id);
    continue;
  }
  keep.push(r);
}
db.resources = keep;
db.updatedAt = new Date().toISOString();
history.updatedAt = db.updatedAt;

// ---------- 5. 写盘 ----------
const stat = summarize(results);
if (!DRY) {
  await fs.writeFile(DATA, JSON.stringify(db, null, 2) + '\n');
  await fs.writeFile(ARCHIVE, JSON.stringify(archive, null, 2) + '\n');
  await fs.writeFile(REPORT, JSON.stringify(history, null, 2) + '\n');
}

// ---------- 输出 ----------
const changed = [...before].filter(([id, st]) => {
  const now = db.resources.find((r) => r.id === id);
  return now && now.status !== st;
});
console.log(`检测完成 ${results.length} 个站点 | live ${stat.live} / limited ${stat.limited} / dead ${stat.dead} / pending ${stat.pending}`);
console.log(`平均响应 ${stat.avgMs}ms | 状态变化 ${changed.length} | 归档 ${removed.length}`);
for (const [id, st] of changed) {
  const now = db.resources.find((r) => r.id === id);
  console.log(`  ${st} -> ${now.status}  ${now.name}`);
}
for (const id of removed) console.log(`  归档移除: ${id}`);
if (DRY) console.log('(--dry 未写盘)');

// 供 workflow 判断是否需要 commit
if (changed.length || removed.length) console.log('CHANGED=true');

function msToFast(ms) {
  if (ms < 400) return 5;
  if (ms < 900) return 4;
  if (ms < 2000) return 3;
  if (ms < 5000) return 2;
  return 1;
}
function round1(n) { return Math.round(n * 10) / 10; }
function summarize(rs) {
  const st = { live: 0, limited: 0, dead: 0, pending: 0 };
  let sum = 0, n = 0;
  for (const { r, res } of rs) {
    st[r.status] = (st[r.status] || 0) + 1;
    if (res.ms) { sum += res.ms; n++; }
  }
  return { ...st, avgMs: n ? Math.round(sum / n) : 0 };
}
async function safeJson(p, def) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return def; }
}
