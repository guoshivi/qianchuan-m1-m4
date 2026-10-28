# 抖音千川达人带货 · m1→m4 链路脚本

把「选品进来」到「放量计划素材传完」这四段动作做成可重跑的 CLI：**建账（m1）→ 素材去重（m2）→ 炮灰视频（m3）→ 直投放量（m4）**。

驱动方式不是 Selenium/Playwright，而是 **CDP 直接接管一个已经登录好的 Chromium**（默认 [ego lite](https://ego.app)，任何开了 `--remote-debugging-port` 的 Chromium 也能改一行接上）。零 npm 依赖，只用 Node 标准库。

> 这是从一套完整的 m1→m11 链路里**只取出前四段**的公开版。
> m5（素材就位探测）/ m6（代投授权转移）/ m7（控成本计划）/ m8（九步重建）/ m9~m11（飞书同步、指令、监控）不在本仓库。

---

## 这条链路在干什么

| 段 | 动作 | 关键判据 | 有没有写操作 |
|---|---|---|---|
| **m1 建账** | 按商品 ID 在选品车里搜到商品 → 读标题/店铺/佣金 → 算保本 ROI 与目标 ROI → 分配识别码 → 写台账 | 台账里出现 `识别码 / 保本 / 目标ROI / 名字后缀` | 默认**只读**，`--go` 才写台账 |
| **m2 素材去重** | 按商品 ID 找到素材目录 → 数条数 → 封面池按商品 ID 做种子挑图 → 逐条转码去重 | 去重后条数 = 原条数，且文件大小/指纹都变了 | 写素材文件（`--dry-run` 可只看） |
| **m3 炮灰视频** | 抓商品图 → Remotion 合成 8~10s 竖版视频（首帧=商品主图）→ 上传创作者中心 → 挂车 → 发布 | 发布后 URL 离开发布页 / 出现「审核中」 | **真的会发一条公开带车视频** |
| **m4 直投放量** | 建放量计划 → 搜商品加进计划 → 勾「自选投放素材」→ 本地拖 5 条素材进素材池 | URL 带 `sourceFrom=createSuccess` + 页面显示 `素材 5/视频 5` | 建计划 + 传素材，**到传完为止，不点发布** |

---

## 环境要求

- **macOS**（脚本按 macOS 的路径/ego 浏览器写的；Linux 上要自己改浏览器接入）
- **Node.js ≥ 18**（用 `node:fs` / `fetch`；无第三方依赖）
- **Python 3 + Pillow**（只有 m2 去重需要）
- **ego lite 浏览器**，且里面已经登录：巨量百应选品车、抖音创作者中心、千川后台
- **Remotion**（只有 m3 出片需要，装在 `remotion/` 里）

```bash
git clone https://github.com/guoshivi/qianchuan-m1-m4.git
cd qianchuan-m1-m4
node tools/verify.js          # 语法 + 配置自检
```

---

## 配置（必做）

```bash
cp bridge/qc-config.example.js bridge/qc-config.js
$EDITOR bridge/qc-config.js
```

`qc-config.js` 已被 `.gitignore` 忽略 —— **你的号名、aavid、uid、识别码前缀不要提交**。

必填的是这三块，顺序别搞反：

1. **`dyEnvs[]`** —— 每个直投抖音号一条：
   - `env`：ego profile id（登录态隔离单位，一个号一个）
   - `uid` / `aavid`：抖音号 ID / 该号直投的千川账户 ID
   - `name`：备注名（脚本按 `--account` 名字**包含匹配**找号）
   - `prefix`：**识别码前缀**，每个号都不同，形如 `<prefix><YYMMDD><NN>`
   - `downloadDirs`：素材下载路径 `~/Downloads/<编号>/default/<商品ID>/` 里的**编号层**
2. **`accountId`** —— 代投侧的千川 aavid
3. **`prefixRoute`** —— 识别码前缀 → 抖音环境 id

### 这三个字段最容易填错（都会静默出错，不报错）

- **`prefix` 填错/不填** → 该号发的视频在抖音列表里认不出来 → 后面的素材判定全盘皆错。发号逻辑在 `bridge/frag-code.js`。
- **`downloadDirs` 不登记** → `mat-dir.js` / `bit-m1-pick.js` 反查不出「这批素材是哪个号的」，脚本会**报错要求显式 `--account`，绝不猜**（猜错=素材发到别人的号）。
  一个号可以登记多个编号（历史批次）。
- **`name` 起得太像** → `--account` 是包含匹配，名字互相包含会挑错号。

---

## 四段怎么跑

所有脚本都可以先加 `--probe` / `--dryRun` 看它准备干什么。

### m1 · 建账

```bash
# 只看（默认只读，不写台账）
node bridge/bit-m1-pick.js --ids 3000000000000000001

# 真写台账 + 追加 manifest
node bridge/bit-m1-pick.js --ids 3000000000000000001,3000000000000000002 --go --account 直投号A

# 新号还没进配置时手动指定前缀
node bridge/bit-m1-pick.js --ids 3000000000000000001 --prefix demoC --go
```

- 数据来源是选品车缓存的 `/` 标签，`--refresh` 会提示你单独跑一次抓取（ego 沙箱里起不了子进程）。
- 识别码是**单调分配**的：扫台账取该号该日最大值 +1，重跑同一天的批次不会撞码。

### m2 · 素材去重

```bash
# 只算不写
python3 tools/video-dedup/dedup_run.py --input ~/Downloads/5/default/3000000000000000001 --dry-run

# 就地覆盖
python3 tools/video-dedup/dedup_run.py --input ~/Downloads/5/default/3000000000000000001 --inplace
```

- 封面池默认 `~/Downloads/4/image`（`--pool` 改），按商品 ID 做种子挑图 → 同一个品重跑结果一致，一次跑内不撞图。
- 素材目录是**按商品 ID 搜索**出来的，不写死 `~/Downloads/4` —— 历史上真出现过按品名命名和换编号的情况。

### m3 · 炮灰视频（三段）

```bash
# ① 出片（不上传）
node bridge/bit-m3-paohui.js --frag demoA26102701 --productId 3000000000000000001 --account 直投号A

# ② 上传到创作者中心
node bridge/bit-m3-upload.js --frag demoA26102701 --video ~/Downloads/paohui视频/2026-10-27/demoA26102701.mp4 --account 直投号A

# ③ 挂车 + 发布
node bridge/bit-m3-publish.js --frag demoA26102701 --cart 3000000000000000001 --shortTitle 吸油棉 --publish
```

- 首帧封面段默认 0.6s（`--coverSec`），抖音默认封面就取首帧 → 用商品主图。
- `--scene` 可选 `classic/circle/blinds/bounce/glitch/glass`，默认 `combo` 由 seed 随机挑。6 套模板结构不同，不只是换颜色。
- 出片工程在 `remotion/`：`cd remotion && pnpm i`（首次要装 Remotion 的 500MB 依赖）。素材图会临时落到 `remotion/public/`，`out/` 与 `public/` 已被忽略。

### m4 · 直投放量

```bash
# 只探测：能不能搜到商品、页面结构对不对
node bridge/bit-m4-upload.js --productId 3000000000000000001 --probe

# 建计划 + 传素材（不发布）
node bridge/bit-m4-upload.js --account 直投号A --productId 3000000000000000001 \
  --name 吸油棉 --dir ~/Downloads/5/default/3000000000000000001
```

- **跑到素材传完就停**，`--publish` 才会点发布。发布按钮留给人。
- 判据是页面出现 `素材 5/视频 5`，或 URL 带 `sourceFrom=createSuccess`。只看到「创建成功」不代表素材进去了。
- 商品搜索抽屉的判据是**两级**：主键优先（行内 `ID：<商品ID>` 相等），主键不可见时（渠道品）才用「抽屉里只有一个商品ID + 行含**完整标题**」兜底。模糊匹配一律不认。

---

## 目录结构

```
.
├── bridge/
│   ├── bit-m1-pick.js        m1 建账
│   ├── bit-m3-paohui.js      m3① 出片（Remotion）
│   ├── bit-m3-upload.js      m3② 上传
│   ├── bit-m3-publish.js     m3③ 挂车发布
│   ├── bit-m4-upload.js      m4 放量计划 + 素材上传
│   ├── bit-qc-lib.js         页面动作层（m4 复用的通用动作）
│   ├── bit-cdp.js bit-api.js CDP / 浏览器连接
│   ├── ego/                  ego 传输层（开空间、取标签、防串号）
│   ├── bit-ledger.js         台账（JSON，唯一事实源）
│   ├── mat-dir.js            素材目录解析（按号反查）
│   ├── frag-code.js          识别码发号
│   ├── roi-map.js            保本 → 目标 ROI 映射
│   ├── short-title.js        商品标题 → ≤10 字挂车短标题
│   ├── commission-*.js       佣金解析
│   ├── cart-cache.js         选品车缓存（按号分文件）
│   ├── captcha.js            验证码判据（认出即硬停）
│   └── qc-config.example.js  配置模板
├── remotion/                 m3 出片工程（Paohui 合成，6 套场景）
├── tools/
│   ├── video-dedup/          m2 去重（Python）
│   └── verify.js             自检
└── docs/                     链路说明
```

状态全部落在 `~/.qc-rebuild-ego/`（`QC_STATE_DIR` 可改）：

```
~/.qc-rebuild-ego/
├── products-ledger.json      台账：商品ID → 识别码/保本/目标ROI/各段产物
├── cart-map.<env>.json       选品车缓存（按号分文件，防止互相覆盖）
└── frag-prefixes.json        识别码前缀学习记录
```

---

## 踩过的坑（都在代码注释里，这里只列必须知道的）

1. **判据必须绑账号**。台账、断点、缓存全部按 `商品ID@号` 或按号分文件。曾经只看商品 ID，复用了别的号的断点，**静默假成功**。
2. **m4 必须在授权转移之前跑完**。授权是「转移」，转走之后直投号就加不进这个商品了；同店铺的品要在同一步里全部处理完。
3. **ego 每个空间最多 8 个标签**，同域只留一个：能复用就复用，别每次新开。脚本里由 `ego-transport.acquireTab()` 统一处理。
4. **导航有闸**：千川/联盟域按 profile 限频（默认 45s）。反复导航会把自己闸死。
5. **不要裸拼 JS 字符串**，用 `page.click('text=…')` / `waitForFunction` / `evaluate(fn, args)`；不要抢窗口焦点。
6. **验证码/滑块硬停**：认出验证码立即停下移交，不自动过（`captcha.js`）。
7. **别造数据**：解析不到就留空，不拿后缀冒充品名。台账空着 = 今天没事，是正确结果。

---

## 边界

- 脚本操作的是**你自己登录的账号和后台**。m3 会发出真实视频，m4 会建真实计划（会花钱）。
- 平台的 DOM 结构随时会变。每个动作前都先判状态（已勾/已开就别再点），所以多数改版表现为「某个判据超时」，而不是误操作 —— 看到 `ABORT_*` 就是判据没过，别硬往下跑。
- 只覆盖前四段。m5 之后的事（素材等就位、授权、控成本、重建、飞书、监控）不在本仓库，也没有计划加。

## License

MIT
