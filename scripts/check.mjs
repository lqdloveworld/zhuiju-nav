#!/usr/bin/env node
/**
 * 可用性检测 + 状态机 + 自动评分 + 自动归档
 *
 * 用法:
 *   node scripts/check.mjs                       # 权威检测（本机出口），改状态
 *   node scripts/check.mjs --observe-only        # 观察者模式，只写 reports，不改状态
 *   node scripts/check.mjs --dry                 # 不写盘
 *   node scripts/check.mjs --concurrency 8 --timeout 12000
 *
 * 为什么有两种出口：
 *   GitHub Actions 在海外，对国内站点会大面积误报 403/timeout。
 *   权威判定只应由能代表目标用户的出口（本机 VPS）执行；
 *   异地出口用 --observe-only 提供补充可用率样本，不参与生死判定。
 *
 * 状态机:
 *   pending --首检成功且满观察期--> live
 *   live    --受限响应(403/429/451)--> limited   （不算失败）
 *   live    --失败 x N--> dead                    （N = FAIL_TO_DEAD）
 *   dead    --恢复--> live
 *   dead    --超过 T 天未恢复--> archived         （移入 archive.json）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { probe, pool, hostOf } from './lib/http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/resources.json');
const ARCHIVE = path.join(ROOT, 'data/archive.json');
const REPORT = path.join(ROOT, 'reports/availability.json');

const FAIL_TO_DEAD = 3;        // 连续失败几次判死
const ARCHIVE_AFTER_DAYS = 14; // 判死后多久无恢复则归档
const OBSERVE_DAYS = 7;        // pending 观察期
const HISTORY_KEEP = 40;       // 每个站点保留多少条检测记录

const args = process.argv.slice(2);
const CONCURRENCY = Number(arg(args, '--concurrency', 8));
const TIMEOUT = Number(arg(args, '--timeout', 12000));
const DRY = args.includes('--dry');
const OBSERVE_ONLY = args.includes('--observe-only');
const VANTAGE = process.env.NAV_VANTAGE || (process.env.GITHUB_ACTIONS ? 'gh-actions' : 'local');

function arg(list, key, def) {
  const i = list.indexOf(key);
  return i >= 0 && list[i + 1] ? list[i + 1] : def;
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d) => Math.max(0, Math.round((Date.parse(today) - Date.parse(d || today)) / 86400e3));

const db = JSON.parse(await fs.readFile(DATA, 'utf8'));
const archive = await safeJson(ARCHIVE, { archived: [] });
const history = await safeJson(REPORT, { updatedAt: '', sites: {} });
history.sites ||= {};

// ---------- 1. 探活（主域名失败自动试镜像/发布页） ----------
const results = await pool(db.resources, CONCURRENCY, async (r) => {
  let res = await probe(r.url, { timeout: TIMEOUT });
  let usedMirror = null;
  if (!res.ok && !res.limited) {
    for (const m of r.mirrors || []) {
      const r2 = await probe(m, { timeout: TIMEOUT });
      if (r2.ok || r2.limited) {
        res = r2;
        usedMirror = m;
        break;
      }
    }
  }
  return { r, res, usedMirror };
});

// ---------- 2. 状态迁移（观察者模式跳过） ----------
const before = new Map(db.resources.map((r) => [r.id, r.status]));
const removed = [];

for (const { r, res, usedMirror } of results) {
  const prev = r.status;

  if (!OBSERVE_ONLY) {
    r.check = {
      code: res.code,
      ms: res.ms,
      ok: res.ok,
      limited: res.limited,
      mirror: usedMirror,
      error: res.error || undefined,
      vantage: VANTAGE,
      at: new Date().toISOString(),
    };

    if (res.ok) {
      r.failStreak = 0;
      r.lastOk = today;
      const seen = daysAgo(r.firstSeen); // pending 需过观察期才转正
      r.status = prev === 'pending' && seen < OBSERVE_DAYS ? 'pending' : 'live';
    } else if (res.limited) {
      // 受限：能通但被拦（CF/地区/需梯子），不算死
      r.status = 'limited';
      r.lastOk = r.lastOk || today;
    } else if (r.reach === 'vpn') {
      // 预期需梯子的站：本出口网络层不通属正常，判受限而非死亡，避免被归档
      r.status = 'limited';
      r.failStreak = 0;
      r.lastOk = r.lastOk || today;
    } else {
      r.failStreak = (r.failStreak || 0) + 1;
      if (r.failStreak >= FAIL_TO_DEAD) {
        r.status = 'dead';
        r.diedAt = r.diedAt || today;
      }
    }
    if (r.status === 'live') delete r.diedAt;
  }

  // ---------- 3. 记录检测历史（两种模式都写，作为可用率样本） ----------
  const id = r.id;
  const h = (history.sites[id] ||= { url: r.url, host: hostOf(r.url), runs: [] });
  h.url = r.url;
  h.host = hostOf(r.url);
  h.runs.push({
    d: today,
    ok: res.ok,
    limited: !!res.limited,
    ms: res.ms,
    code: res.code,
    vantage: VANTAGE,
  });
  h.runs = h.runs.slice(-HISTORY_KEEP);
}

// ---------- 4. 自动评分（fast / stable 由数据算，rich / clean 人工维护） ----------
if (!OBSERVE_ONLY) {
  for (const { r, res } of results) {
    r.scores ||= { rich: 3, fast: 3, clean: 3, stable: 3 };
    if (res.ok) r.scores.fast = msToFast(res.ms);

    const runs = (history.sites[r.id]?.runs || []).slice(-30);
    if (runs.length >= 3) {
      const rate = runs.filter((x) => x.ok).length / runs.length;
      r.scores.stable = Math.max(1, Math.min(5, Math.round(rate * 5)));
    }
    const s = r.scores;
    r.rating = round1((s.rich + s.fast + s.clean + s.stable) / 4);
  }

  // ---------- 5. 归档：长期死亡则移出主表 ----------
  const keep = [];
  for (const r of db.resources) {
    const deadTooLong =
      r.status === 'dead' && daysAgo(r.diedAt || r.lastOk || r.firstSeen) > ARCHIVE_AFTER_DAYS;
    if (deadTooLong) {
      archive.archived.push({
        ...r,
        archivedAt: new Date().toISOString(),
        reason: `连续失败 ${r.failStreak} 次，${ARCHIVE_AFTER_DAYS} 天未恢复`,
        lastVantage: VANTAGE,
      });
      removed.push(r.id);
      continue;
    }
    keep.push(r);
  }
  db.resources = keep;
  db.updatedAt = new Date().toISOString();
}
history.updatedAt = new Date().toISOString();

// ---------- 6. 写盘 ----------
const stat = summarize(results);
if (!DRY) {
  if (!OBSERVE_ONLY) {
    await fs.writeFile(DATA, JSON.stringify(db, null, 2) + '\n');
    await fs.writeFile(ARCHIVE, JSON.stringify(archive, null, 2) + '\n');
  }
  await fs.writeFile(REPORT, JSON.stringify(history, null, 2) + '\n');
}

// ---------- 输出 ----------
const tag = OBSERVE_ONLY ? `[观察者:${VANTAGE}]` : `[权威:${VANTAGE}]`;
console.log(
  `${tag} 检测 ${results.length} 站 | live ${stat.live} / limited ${stat.limited} / dead ${stat.dead} / pending ${stat.pending} | 平均 ${stat.avgMs}ms`,
);
if (!OBSERVE_ONLY) {
  const changed = [...before].filter(([id, st]) => {
    const now = db.resources.find((r) => r.id === id);
    return now && now.status !== st;
  });
  console.log(`状态变化 ${changed.length} | 归档 ${removed.length}`);
  for (const [id, st] of changed) {
    const now = db.resources.find((r) => r.id === id);
    console.log(`  ${st} -> ${now.status}  ${now.name}  (${now.check?.code || now.check?.error || '?'})`);
  }
  for (const id of removed) console.log(`  归档移除: ${id}`);
  if (changed.length || removed.length) console.log('CHANGED=true');
} else {
  console.log('观察者模式：未改动 resources.json，仅追加可用率样本');
}
if (DRY) console.log('(--dry 未写盘)');

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
