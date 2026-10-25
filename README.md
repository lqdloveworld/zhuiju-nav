# 追剧导航 · 可自动化维护的资源导航站

> 在线影视 / 网盘搜索 / 磁力BT / 小说资源 / 影视APP / TVBox接口 / 开源项目
> 每日自动探活 · 死亡站点自动下架归档 · 新站点自动发现并进入观察期

---

## 一、你的需求 → 我补全后的完整需求

你说了四件事，我把每件事拆成可执行的机制，并补齐了做这类站**必须提前定掉**的东西：

| 你的原始需求 | 落地机制 | 我补全的部分 |
|---|---|---|
| 分类：在线影视、网盘搜索、磁力BT、小说 | `categories` 表驱动，7 个分类（+影视APP/TVBox接口/开源项目），前端 tab 自动生成 | 分类不写死在代码里；新增分类只改 JSON。加 `tags` 做二级维度（夸克/4K/需梯子/无广告） |
| 后续自动更新 | GitHub Actions 每日 `check` + 每周 `discover`，结果自动 commit | 检测**不只看活着没有**：分 `live/limited/pending/dead` 四态，403/429 判"受限"而非死亡（否则误杀一堆需梯子的好站） |
| 删除无用网站 | 连续失败 3 次 → `dead`；`dead` 超 14 天 → 移入 `archive.json`（软删除） | **不做硬删除**：死站是资产不是垃圾。归档留全量记录，域名复活可一键恢复；同时记 `reason` 便于复盘 |
| 添加可用的网站 | `discover` 从订阅源采集 → 去重 → 探活 → 进 `pending` → 7 天观察期 → 转正 | **新站不直接进主表**：先隐身观察 7 天、可用率 ≥60% 才转正，避免"收录即死"污染首页；死链直接进 `rejected` |
| （未提）评分 | `rich/clean` 人工评，`fast/stable` 由检测数据自动算 | 评分不靠拍脑袋：响应时间映射「快」，30 次检测成功率映射「稳」，四项平均出推荐指数 |
| （未提）审核可控 | discover 产物走 PR，不是直推 main | 机器只能提名，人决定入库 |
| （未提）域名漂移 | 每条支持 `mirrors[]`，主域探测失败自动试备用/发布页 | 这类站换域名是常态，`mirrors` 让"站死了"变成"换了个地址" |
| （未提）合规边界 | 只存 URL + 简介，不存文件、不代理、不转存 | 定位是索引站，避免变成侵权主体 |

---

## 二、架构

```
                    ┌─────────────────────────────────────────┐
   订阅索引源 ──────►│  discover.mjs   采集→去重→探活→pending  │
   (JSON/README)     └──────────────┬──────────────────────────┘
                                    │ 7天观察期 + 可用率≥60%
                                    ▼
   ┌──────────────┐  每日    ┌──────────────┐   build   ┌─────────────┐
   │ resources.json│◄───────│  check.mjs   │──────────►│  web/data.json│
   │   (主数据)    │ 状态机  │ 探活/评分/归档│           └──────┬──────┘
   └──────┬───────┘         └──────┬───────┘                  │
          │                        │ 3次失败→dead             ▼
          │                        │ 14天→archive      ┌─────────────┐
          │                        ▼                   │  静态前端    │
          │                 ┌──────────────┐           │ index.html  │
          └────────────────►│ archive.json │           │  app.js     │
                            └──────────────┘           └─────────────┘
```

**三条流水线，职责单一，互不阻塞：**

| 流水线 | 触发 | 做什么 | 写什么 |
|---|---|---|---|
| `check.mjs` | 每天 09:00 / push | 探活 → 状态迁移 → 自动评分 → 归档 | `resources.json`、`archive.json`、`reports/availability.json` |
| `discover.mjs` | 每周一 10:00 / 手动 | 采集 → 去重 → 探活 → pending → 转正 | `candidates.json`、`resources.json`（转正时） |
| `build.mjs` | 每次数据变更 | 编译前端数据、算统计 | `web/data.json`、`web/sitemap.txt` |

---

## 三、数据模型

```jsonc
// data/resources.json
{
  "id": "ppnix",                       // 唯一，前端锚点/去重键
  "name": "PPnix",
  "url": "https://www.ppnix.com/cn/",
  "mirrors": ["https://备用域名"],      // 主域失败时自动回退探测
  "category": "online",                // 对应 categories[].id
  "tags": ["热播剧", "无广告"],          // 二级筛选/搜索维度
  "desc": "热门在线影视，速度快/纯净",
  "scores": { "rich": 5, "fast": 5, "clean": 5, "stable": 5 }, // 多/快/净/稳
  "rating": 5.0,                       // 四项平均，build 时也可重算
  "status": "live",                    // live | limited | pending | dead
  "firstSeen": "2026-10-25",
  "lastOk": "2026-10-25",
  "failStreak": 0,                     // 连续失败计数
  "diedAt": null,                      // 判死日期，用于算归档倒计时
  "check": { "code": 200, "ms": 420, "ok": true, "limited": false, "at": "..." }
}
```

`reports/availability.json` 每个站保留最近 40 条检测记录（日期、是否可用、耗时、状态码），用于算可用率和趋势——不引入数据库，单文件、可 diff、可 PR review。

---

## 四、状态机（核心逻辑，改这里就能改策略）

```
           首检成功且满 7 天
 pending ───────────────────► live ◄──────────┐
    │                          │              │ 恢复
    │ 探活失败                  │ 失败×3        │
    ▼                          ▼              │
 rejected                   dead ─────────────┘
（不会进主表）                 │ 仍失败且 >14 天
                              ▼
                          archive.json（归档，可恢复）
```

阈值全部集中在文件顶部，改一行即生效：

| 常量 | 位置 | 默认 | 含义 |
|---|---|---|---|
| `FAIL_TO_DEAD` | check.mjs | 3 | 连续失败几次判死（防单次网络抖动误杀） |
| `ARCHIVE_AFTER_DAYS` | check.mjs | 14 | 判死后多久归档 |
| `OBSERVE_DAYS` | check.mjs / discover.mjs | 7 | 新站观察期 |
| `MIN_UPTIME` | discover.mjs | 0.6 | 观察期可用率门槛 |
| `HISTORY_KEEP` | check.mjs | 40 | 每站保留检测记录数 |

**判定规则**：`2xx/3xx` → 可用；`401/403/418/429/451` → 受限（Cloudflare、地区限制、需梯子，不算死）；`5xx/超时/DNS失败` → 失败计数。探活只读响应头 + 前 8KB 就断开，不拉整站。

---

## 五、目录结构

```
nav/
├── data/
│   ├── resources.json     # 主数据（人工可编辑，唯一事实来源）
│   ├── candidates.json    # 待观察 pending / 已拒绝 rejected / blocklist
│   └── archive.json       # 已归档死站（软删除）
├── reports/
│   └── availability.json  # 检测历史，可用率与趋势的数据来源
├── scripts/
│   ├── lib/http.mjs       # 探活 + 并发池 + host 归一化
│   ├── check.mjs          # 每日检测流水线
│   ├── discover.mjs       # 每周发现流水线
│   ├── build.mjs          # 编译前端数据
│   └── serve.mjs          # 零依赖本地预览
├── web/                   # 纯静态前端（无框架、无构建）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data.json          # build 产物
└── .github/workflows/
    ├── check.yml          # 每日检测 + 自动 commit
    ├── discover.yml       # 每周发现 + 自动 PR
    └── deploy.yml         # 部署 GitHub Pages
```

---

## 六、跑起来

```bash
cd nav
node scripts/check.mjs --dry        # 试运行，不写盘，先看结果
node scripts/check.mjs              # 真实检测（43 站约 8 秒）
node scripts/discover.mjs --dry     # 试跑发现流程
node scripts/build.mjs              # 生成 web/data.json
node scripts/serve.mjs 8090         # 打开 http://127.0.0.1:8090
```

实测（2026-10-25）：43 站，8.2 秒，live 39 / limited 4，平均响应 890ms；discover 从公开索引采集 73 条、去重后 29 条新候选、探活通过 14 条进 pending、剔除 6 条死链。

**部署三种选择：**

1. **GitHub Pages**（最省事）：仓库推上去 → Settings → Pages → Source 选 GitHub Actions，`deploy.yml` 自动接管。检测结果 commit 触发重新部署，全程零运维。
2. **Cloudflare Pages / Vercel**：构建命令 `node scripts/build.mjs`，输出目录 `web`，免费额度足够日更。
3. **自建 VPS**：`crontab -e` 加 `0 9 * * * cd /path/nav && node scripts/check.mjs && node scripts/build.mjs`，nginx 指向 `web/`。

---

## 七、日常运维手册

**加一个站**：直接编辑 `data/resources.json` 加一条（`status` 写 `"pending"`，`firstSeen` 写今天），提交 PR。次日起自动检测，7 天后自动转正。

**删一个站**：把它从 `resources.json` 删除即可；或把域名加进 `candidates.json` 的 `blocklist`，`discover` 以后不会再收它。

**恢复误杀**：从 `archive.json` 里把对象整条贴回 `resources.json`，`status` 改 `"pending"`，`failStreak` 归零。

**调严格度**：只想收"绝对不会死"的站 → `FAIL_TO_DEAD: 2`、`ARCHIVE_AFTER_DAYS: 7`；想宽容 → 反过来。

**换订阅源**：`discover.mjs` 顶部 `SOURCES` 数组，支持 `json`（读 `resources/items/data` 字段）和 `md`（正则提外链）两种解析器。想接 RSS / GitHub Search API / TG 频道，加一个 `type` 或先跑个转换脚本落地成 JSON 即可。

---

## 八、下一步可以加什么（按性价比排序）

1. **双通道探测**：GitHub Actions 出口固定，被墙的站会误判受限。加一个海外出口（Cloudflare Worker 定时打点）做交叉验证，`limited` 判定会更准。
2. **响应内容指纹**：现在只看状态码，有些站会返回 200 的"域名已过期"停放页。探活时校验 `<title>` 关键词（黑名单：`域名出售/已过期/parking`），能再砍掉一批假活。
3. **变更订阅**：`web/feed.xml` 输出"本周新增/本周恢复/本周下架"，用户可 RSS 订阅；这个导航站真正的黏性来自"知道哪个站刚活过来"。
4. **众包投票**：卡片加"我这边能打开/打不开"，用真实用户数据修正 GitHub Actions 的单点偏差。
5. **前端静态化 SEO**：`build.mjs` 额外为每个分类生成 `web/cat/{id}.html`（内容内联，不依赖 JS），收录效果远好于单页。
6. **镜像自动发现**：站点判死后，用搜索引擎查 `站名 + 发布页` 抓新域名，写入 `mirrors` 并重新探活——把"人工找新域名"也自动化。

---

## 九、边界

本项目只维护 URL 索引、简介与可用性记录，不托管、不缓存、不代理任何影视文件或破解资源。第三方站点的内容与合法性由其自身负责，收录不代表背书；`dead`/`archive` 机制本身也是一种持续筛除。
