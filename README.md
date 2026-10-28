# 追剧导航

> 在线影视 / 网盘搜索 / 磁力 BT / 小说资源 / 影视 APP / TVBox 接口 / 开源项目
> 每日自动探活 · 失效站点自动归档 · 新站点先观察后上线

**🌐 在线访问：<https://lqdloveworld.github.io/zhuiju-nav/>**

打开即用，无需注册、无需安装。手机 / 平板 / 电脑均可访问。

---

## 目录

- [这是什么](#这是什么)
- [功能一览](#功能一览)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [自动化机制](#自动化机制)
- [部署](#部署)
- [日常维护](#日常维护)
- [数据格式](#数据格式)
- [常见问题](#常见问题)
- [说明与边界](#说明与边界)

---

## 这是什么

一个**纯静态**的影视资源导航站，只收录 URL、简介和可用性数据，不托管、不缓存、不代理任何文件。

它解决的不是"列一堆链接"，而是**让链接列表不会烂掉**：

| 现实问题 | 这里的做法 |
|---|---|
| 站点会突然打不开 | 每日自动探活，连续失败才降级，最终归档 |
| 站点会换域名 | 每条支持多个备用域名，主域失败自动回退 |
| 新收录的站是死链 | 先进 7 天观察期，可用率达标才上首页 |
| 评分全靠人工拍脑袋 | 「快」「稳」由真实检测数据算出，不手填 |
| 长期没人维护就荒废 | 服务器定时任务 + GitHub Actions 全自动更新 |

技术栈：Node.js ≥ 18，**零第三方依赖**；前端纯 HTML / CSS / JS，无框架、无构建步骤。

---

## 功能一览

- 🔍 **搜索**：按站名、标签、域名实时过滤，快捷键 `/`
- 🗂 **7 个分类**：分类由数据驱动，新增分类只改 JSON，Tab 自动生成
- 🏷 **状态角标**：`可用` / `受限` / `不可达` / `待观察` / `已失效`，一眼看出能不能点
- ⭐ **四维评分**：内容多（rich）、加载快（fast）、界面净（clean）、运行稳（stable）
- ↕️ **三种排序**：按推荐指数 / 按响应速度 / 按名称
- 🌗 **明暗主题**：跟随系统，可手动切换
- 📱 **响应式**：手机端单列、桌面端多列，无横向滚动
- 🔗 **直链跳转**：点击卡片新标签页打开原站，不经任何中间页

---

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/lqdloveworld/zhuiju-nav.git
cd zhuiju-nav

# 2. 试跑一次检测（不写盘，只看结果）
node scripts/check.mjs --dry

# 3. 生成前端数据并本地预览
node scripts/build.mjs
node scripts/serve.mjs 8090
```

浏览器打开 <http://127.0.0.1:8090> 即可看到完整站点。

> 需要 Node.js 18 或更高版本。除 Node 本身外**不需要 `npm install`**，没有任何第三方包。

### 常用命令

| 命令 | 作用 | 是否修改数据 |
|---|---|---|
| `node scripts/check.mjs --dry` | 试运行检测，只看结果 | 否 |
| `node scripts/check.mjs` | 正式检测：探活 → 状态迁移 → 评分 → 归档 | 是 |
| `node scripts/check.mjs --observe-only` | 观察者模式：只追加可用率样本，不判生死 | 只写 `reports/` |
| `node scripts/discover.mjs --dry` | 试跑资源发现流程 | 否 |
| `node scripts/discover.mjs --max 40` | 正式发现：采集 → 去重 → 探活 → 观察期转正 | 是 |
| `node scripts/build.mjs` | 编译前端数据 `web/data.json` | 是（构建产物） |
| `node scripts/serve.mjs 8090` | 本地静态预览服务器 | 否 |
| `./scripts/daily.sh` | 一键跑完整流水线并推送（定时任务调用） | 是 |

### 可选参数

```bash
--concurrency 8     # 并发数，默认 8（别调太高，容易被 CDN 当成扫描）
--timeout 12000     # 单站超时毫秒，默认 12000
--max 40            # 单次发现最多新增多少条候选
```

### npm 快捷方式

```bash
npm run check     # = node scripts/check.mjs
npm run discover  # = node scripts/discover.mjs
npm run build     # = node scripts/build.mjs
npm run serve     # = node scripts/serve.mjs
npm run all       # 检测 + 发现 + 构建，一条龙
```

---

## 目录结构

```
zhuiju-nav/
├── data/
│   ├── resources.json     # 主数据：所有站点（唯一事实来源，可手工编辑）
│   ├── candidates.json    # 待观察 pending / 已拒绝 rejected / 黑名单 blocklist
│   └── archive.json       # 已归档的死站（软删除，可恢复）
├── reports/
│   └── availability.json  # 每站最近 40 条检测记录，可用率的数据来源
├── scripts/
│   ├── lib/http.mjs       # 探活核心：并发池 + 重试 + 镜像回退
│   ├── check.mjs          # 每日检测流水线
│   ├── discover.mjs       # 每周发现流水线
│   ├── build.mjs          # 编译前端数据
│   ├── daily.sh           # 定时任务入口（检测→发现→构建→提交→推送）
│   └── serve.mjs          # 零依赖本地预览服务器
├── web/                   # 纯静态前端（部署的就是这个目录）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── data.json          # build 产物
│   └── sitemap.txt        # build 产物
└── .github/workflows/
    ├── check.yml          # 手动触发的异地抽样（只观察，不改状态）
    ├── discover.yml       # 每周一自动发现，产出 PR 等人工合并
    └── deploy.yml         # 推送到 main 后自动部署 GitHub Pages
```

---

## 自动化机制

三条流水线，职责单一，互不阻塞：

| 流水线 | 触发时机 | 做什么 | 写什么文件 |
|---|---|---|---|
| `check.mjs` | 每天 09:00 / 手动 | 探活 → 状态迁移 → 自动评分 → 归档 | `resources.json`、`archive.json`、`reports/availability.json` |
| `discover.mjs` | 每周一 10:00 / 手动 | 采集 → 去重 → 探活 → 进观察期 → 转正 | `candidates.json`、`resources.json` |
| `build.mjs` | 每次数据变更后 | 编译前端数据、算统计、生成 sitemap | `web/data.json`、`web/sitemap.txt` |

```
订阅索引源 ──► discover.mjs ──► pending（7 天观察）──► resources.json
                                                          │
                              每天 09:00 ──► check.mjs ◄──┘
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                  reports/ 检测历史      archive.json 归档      web/data.json
                                                                   │
                                                             静态前端页面
```

### 状态机

```
pending ──观察满 7 天且可用率 ≥60%──► live
   │                                   │
   │ 探活失败                           ├── 403/429/451 ──► limited    （被拦，站还活着）
   ▼                                   ├── 5xx/超时/DNS ─► unreachable（当前出口连不上）
rejected                               │
（不进主表）                            └── 404/410 连续 3 次 ──► dead
                                                                    │
                                                          14 天未恢复 ──► archive（可恢复）
```

**关键设计：`unreachable` ≠ `dead`。**

检测机器的网络出口位置，直接决定它看到的世界：海外出口访问国内影视站，经常拿到 502 / 444 / 超时。如果按"失败即死"处理，一批能用的站会在两周内被自动清空。

| 服务器实际回应 | 判定 | 理由 |
|---|---|---|
| `2xx` / `3xx` | `live` | 正常可用 |
| `403` / `429` / `451` | `limited` | 被拦了，但站点本身活着 |
| `5xx` / 超时 / DNS 失败 | `unreachable` | 只能证明"这个出口连不上"，不能证明站点停运 |
| `404` / `410` 连续 3 次 | `dead` | 服务器明确回答"没这个页面"，才可能是真死 |
| `dead` 超过 14 天 | 移入 `archive.json` | 归档留档，域名复活可恢复 |

原则：**宁可前端多显示一个灰色角标，也不自动删数据。**

### 可调阈值

全部集中在文件顶部，改一行即生效：

| 常量 | 位置 | 默认值 | 含义 |
|---|---|---|---|
| `FAIL_TO_DEAD` | `check.mjs` | `3` | 404/410 连续几次判死 |
| `ARCHIVE_AFTER_DAYS` | `check.mjs` | `14` | 判死后多少天无恢复则归档 |
| `OBSERVE_DAYS` | `check.mjs` / `discover.mjs` | `7` | 新站观察期 |
| `MIN_UPTIME` | `discover.mjs` | `0.6` | 观察期可用率门槛 |
| `HISTORY_KEEP` | `check.mjs` | `40` | 每站保留多少条检测记录 |

### 抗抖动

单站失败后会间隔 1.5–2.3 秒重试一次，再尝试 `mirrors[]` 里的备用域名，三次都不通才记一次失败。探活只读响应头 + 前 8KB 就断开，不拉整站内容，对目标站几乎无压力。

---

## 部署

### 方式一：GitHub Pages（当前采用，最省事）

仓库已配好 `.github/workflows/deploy.yml`：

1. 代码推到 `main` 分支
2. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**
3. 之后每次 `data/resources.json` 或 `web/**` 有变更，自动重新部署

线上地址：**<https://lqdloveworld.github.io/zhuiju-nav/>**

> 换自定义域名：在仓库根目录加一个 `CNAME` 文件写入域名，把域名 CNAME 解析到 `lqdloveworld.github.io`，再到 Pages 设置里勾选 Enforce HTTPS。

### 方式二：Cloudflare Pages / Vercel

- 构建命令：`node scripts/build.mjs`
- 输出目录：`web`
- 免费额度足够日更

### 方式三：自建服务器 + 定时任务（权威检测出口）

GitHub Actions 的机器在海外，测国内站点会大面积误判，所以**权威检测建议放在自己的服务器上跑**，Actions 只负责部署页面。

```bash
chmod +x scripts/daily.sh

# 每天 09:00 执行，flock 防止重叠
(crontab -l 2>/dev/null; echo "0 9 * * * /usr/bin/flock -n /tmp/nav-daily.lock $(pwd)/scripts/daily.sh") | crontab -

crontab -l          # 确认已写入
./scripts/daily.sh  # 手动跑一次，日志见 reports/run.log
```

`daily.sh` 的完整流程：

```
git fetch + reset 对齐远端
  → check.mjs 权威检测
  → discover.mjs 发现候选
  → build.mjs 编译前端
  → git commit
  → git push（失败自动 rebase 重试 3 次）
```

日志写入 `reports/run.log`（已 gitignore，只保留最近 500 行）。

> 1 核 1G 的机器就够，全程无数据库、无常驻进程。

### 可选：异地交叉验证

想提高判定准确度，可以在另一个网络出口再跑一份**只观察**的检测：

```bash
NAV_VANTAGE=overseas node scripts/check.mjs --observe-only
```

它只往 `reports/` 追加可用率样本（带 `vantage` 标签），不参与生死判定，不影响主数据。

---

## 日常维护

### 加一个站

1. 编辑 `data/resources.json`，按[数据格式](#数据格式)加一条，`status` 写 `"pending"`，`firstSeen` 写今天
2. 提交 PR，合并后次日起自动检测
3. 观察满 7 天、可用率 ≥60% 自动转正上首页

不想手工改也行：`node scripts/discover.mjs` 会从订阅源自动采集，产物同样先进 `pending`。

### 删一个站

- **临时下架**：从 `data/resources.json` 里删掉这条
- **永久拉黑**：把域名加进 `data/candidates.json` 的 `blocklist`，以后 `discover` 不会再收它

### 恢复被误判的站

从 `data/archive.json` 里把整条记录贴回 `data/resources.json`，改三处：

```jsonc
"status": "pending",   // 重新走观察期
"failStreak": 0,       // 失败计数归零
"diedAt": null
```

### 调整严格度

- 只想留"绝对死不了"的站：`FAIL_TO_DEAD = 2`、`ARCHIVE_AFTER_DAYS = 7`
- 想更宽容：把这两个数字调大

### 更换订阅源

`scripts/discover.mjs` 顶部的 `SOURCES` 数组，支持两种解析器：

- `type: 'json'` —— 从 `resources` / `items` / `data` 字段读数组
- `type: 'md'` —— 用正则从 Markdown 里提取外链

想接 RSS、GitHub Search API、TG 频道，先写个小脚本落地成 JSON，再加一个 `SOURCES` 条目即可。

### 手工投递候选

编辑 `data/candidates.json` 的 `pending` 数组（结构与 `resources.json` 类似），下次 `discover` 会一起探活。

---

## 数据格式

想加一个站，往 `data/resources.json` 的 `resources` 数组里加一个对象：

```jsonc
{
  "id": "example",                     // 唯一标识，前端锚点与去重键
  "name": "示例站",
  "url": "https://example.com/",
  "mirrors": ["https://example.net/"], // 可选，主域失败时自动回退
  "category": "online",                // 必须是 categories 里已有的 id
  "tags": ["热播剧", "无广告"],          // 搜索与筛选维度
  "desc": "一句话介绍",
  "scores": { "rich": 5, "fast": 5, "clean": 4, "stable": 4 }, // 多/快/净/稳
  "rating": 4.5,
  "status": "pending",                 // live | limited | pending | dead
  "firstSeen": "2026-10-28",
  "lastOk": null,
  "failStreak": 0,
  "diedAt": null
}
```

分类定义在同一个文件的 `categories` 数组里，新增分类只改这里，前端 Tab 自动生成：

```jsonc
{ "id": "online", "name": "在线影视", "icon": "🎬", "desc": "直接在浏览器播放的影视站" }
```

字段由谁维护：

| 字段 | 谁维护 | 说明 |
|---|---|---|
| `scores.rich` / `scores.clean` | 人工 | 内容多不多、干不干净，主观评分 1–5 |
| `scores.fast` / `scores.stable` | 自动 | 由响应耗时和成功率算出，不用手填 |
| `rating` | 自动 | 四项平均，`build.mjs` 会重算 |
| `status` | 自动 | 由 `check.mjs` 状态机维护，手工加站时写 `pending` |
| `failStreak` | 自动 | 连续失败计数，恢复可用时归零 |

`reports/availability.json` 里每个站保留最近 40 条检测记录（日期、是否可用、耗时、状态码），是可用率和趋势的唯一数据源。**不引入数据库**——单文件、可 diff、可 review。

---

## 常见问题

**Q：为什么有的站显示"受限"而不是"失效"？**
`limited` 表示服务器返回了 403 / 429 / 451，站点本身是活的，只是拦了当前出口（Cloudflare 盾、地区限制、需要特定网络环境）。这类站对部分用户完全可用，所以保留展示，只加灰色角标。

**Q：为什么有的站显示"不可达"？**
`unreachable` 表示超时或 5xx，只能说明**检测机这个出口**连不上。国内影视站对海外 IP 经常返回 502 / 444，所以这类站不会被判死，也不会被归档。

**Q：刚加的站为什么首页看不到？**
新站默认 `pending`，前端不展示。观察满 7 天且可用率 ≥60% 才自动转正。

**Q：检测多久跑一次？**
权威检测每天 09:00 一次，资源发现每周一 10:00 一次。想更频繁，改 crontab 或 `discover.yml` 里的 cron 即可。

**Q：会不会把目标站打挂？**
不会。并发默认 5–8，单站只读响应头和前 8KB 就断开，失败还带重试间隔，流量特征接近普通浏览器访问。

**Q：数据更新了页面没变？**
GitHub Pages 有 1–2 分钟部署延迟；浏览器也可能缓存了 `data.json`，强制刷新（Ctrl / Cmd + Shift + R）即可。

**Q：想加自己的站 / 想下架某个站？**
参考[日常维护](#日常维护)，或直接提 Issue。

---

## 说明与边界

- **只做索引**：本仓库仅维护 URL、简介与可用性记录，不托管、不缓存、不代理任何影视文件或破解资源，不提供下载服务。
- **第三方内容自负其责**：收录不代表背书或推荐；`dead` / `archive` 机制本身也是一种持续筛除。
- **侵权处理**：请针对具体第三方站点主张权利；本仓库在收到有效通知后会移除对应索引条目。
- **隐私**：仓库不含服务器地址、账号、密钥等个人环境信息；检测记录只保留出口标签（`local` / `gh-actions`），不记录 IP；运行日志不入库。

---

<p align="center">
  <sub>每日 09:00 自动检测 · 数据见 <code>data/resources.json</code> · 站点数量与状态见首页数据条</sub>
</p>
