'use strict';
// ==========================================================================
// 千川重建/投放矩阵 —— 配置模板（**复制成 qc-config.js 再填你自己的值**）
// ==========================================================================
//   cp fp-matrix/bridge/qc-config.example.js fp-matrix/bridge/qc-config.js
//   然后编辑 qc-config.js 填你自己的环境ID / aavid / uid
//
// ⚠️ qc-config.js 已被 .gitignore 忽略 —— **真实账号值不要提交到仓库**
//    （本仓库会分享给别人，抖音号/千川号肯定不一样）
//
// 怎么找这些值：
//   · BitBrowser 环境ID：浏览器管理 → 环境 → 环境ID（一串 hex）
//   · 千川 aavid：千川后台 URL 里的 aavid=<数字>
//   · 抖音 uid：抖音号主页 URL / 创作者中心账号信息
// ==========================================================================

module.exports = {
  // ---- ① BitBrowser 环境 ID (必填) ----
  qcEnv: process.env.BIT_QC_ENV || '填你的代投千川环境ID',
  dyEnvs: [
    // { env: 抖音环境ID, uid: 抖音号ID, aavid: 该号直投千川账户ID, name: 备注名,
    //   prefix: 识别码前缀, downloadDirs: 该号的素材下载目录编号(数组) }
    // ⚠️ prefix（识别码前缀）**每个抖音号都不一样**，不是全局固定值：
    //     例：A 号用 demoA、B 号用 demoB、新号可以用 demoC …
    //     识别码形如 <prefix><YYMMDD><NN>（异常品加 -01）。prefix 写错/不写，
    //     该号的视频在抖音列表里就认不出来 → m7/m8 全链路失败。发号见 frag-code.js。
    // ⚠️ downloadDirs = 素材下载路径 `~/Downloads/<编号>/default/<商品ID>/video_N.mp4` 里的**编号层**。
    //     它回答"这批素材是哪个号的" —— mat-dir.js / bit-m1-pick.js 靠它自动反查号，
    //     免得每次新素材都回头问人。**一个号可以登记多个编号**（历史批次）。
    //     不登记 = 反查不出 → 脚本会报错要求显式 --account（**不猜**：猜错=素材发错号）。
    { env: '填你的直投号A环境ID', uid: '填直投号A的uid', aavid: '填直投号A的aavid', name: '直投号A', prefix: 'demoA', downloadDirs: ['4'] },
    { env: '填你的直投号B环境ID', uid: '填直投号B的uid', aavid: '填直投号B的aavid', name: '直投号B', prefix: 'demoB', downloadDirs: ['5'] },
  ],

  // ---- ② 代投账户 ID (aavid) (必填) ----
  accountId: process.env.QC_ACCOUNT_ID || '填你的代投aavid',

  // ---- ③ 识别码前缀 → 抖音环境 路由 ----
  prefixRoute: { 'demoA': '填你的直投号A环境ID', 'demoB': '填你的直投号B环境ID' },

  // ---- ④ 商品（一般不用填）----
  productId: process.env.QC_PRODUCT_ID || '',

  // ---- ⑤ 老 ego 兜底路径的常量（2026-09-12 从 qianchuan/qc-const.js 抽出）----
  // 只有 `qianchuan/qc-run.js`（比特不可用时的兜底）用这些；bit 链路不需要。
  // ⚠️ 旧值已从被 git 跟踪的 qc-const.js 里移出到这里 —— 不填的话，ego 兜底路径会
  //    为 `<未配置 legacy.x>` 时，比特链路会带着占位符去操作页面 → 出问题看这里。（`assertLegacy()` 随 ego 一起去了 ego-legacy 分支）
  legacy: {
    accountId: '填你 ego 时代的代投 aavid',
    accountName: '<代投号>',
    awemeId: '填抖音号ID',
    awemeName: '<直投号>',
    productId: '填商品ID',
    productName: '商品名',
    idVideo: { title: '识别码#日常#实拍#搞笑', itemid: '视频itemid', frag: '识别码' },
    nameSuffix: '-20%保3.5',   // 示例值（别填成你线上真实计划名后缀）
  },

  // ---- ⑥ 千川监控（m11，可选）----
  // 不配 chatId 也能跑：qc-notify.js 只会把报告打印出来（**不会**往群里发）。
  // 装了定时任务才会真发；安装脚本发现没配 chatId 会直接拒绝（见 fp-matrix/tools/monitor/install-monitor-cron.sh）。
  monitor: {
    transport: 'ego',           // 'ego' = 走 ego 浏览器（默认）｜ 'bit' = 走比特环境（备用）
    keepPage: false,            // false = 每轮跑完关掉监控页（不长期占窗口）；true = 一直开着
    accounts: ['代投'],          // ★ 监控范围**只代投号**；要带直投号就加名字，或命令行 --all
    chatId: '',                 // 飞书群 chat_id（oc_...）
    atOpenIds: [],              // 强预警 @ 谁：**完整 open_id**（ou_...，截断会导致 @ 空渲染）
    atAllOnCrit: true,          // 危急时 @所有人
    thresholds: {},             // 覆盖默认阈值，键见 fp-matrix/bridge/monitor/qc-alert.js 的 DEFAULT_TH
  },

  // ---- ⑦ 素材根目录（2026-09-29 新增：本地下载盘 → NAS / 任意目录）----
  // 背景：各 ego 空间的**浏览器下载目录**可以各自映射到一个目录（用户 2026-09-29 全部映射到 NAS，
  //       本地不再落盘）⇒ "素材在哪"必须配置化，不能再写死 `~/Downloads` ✗（见 mat-dir.js）。
  // 顺序 = 优先级（用户 2026-09-29 口径）：
  //   ① matSharedRoots：「共用」= **两个号都要用的素材** ⇒ **先查这里**
  //      （用户原话：「一般情况 在共用的 都是两个号都要用的素材，一般都是先检测共用，
  //        如果共用没有新的再去监测号自己的目录」）
  //   ② matRoots：各号自己的空间下载目录 ⇒ 共用没有再查这里
  //   ③ `~/Downloads`（老布局，靠目录编号反查号）仍作最后兜底 ⇒ 这两项不配也能跑 ✓
  // 支持两种落盘形状：`<根>/<商品ID>/` 与 `<根>/default/<商品ID>/`（扩展标准布局，优先 ✓）
  // ⚠️ NAS 没挂载时会跳过该根并打 `MAT_ROOT_MISSING`（不静默 ✗，canon #65 家族）
  // ⚠️ hetu / Default 这类**个人 ego 空间**若也下载到「共用」⇒ 不需要单列 ✓
  // ⚠️ 素材来自「共用」而去重是 `--inplace` ⇒ 改的是**两个号共用那批**（会打 `M2_DEDUP_SHARED` 提醒 ✓）
  matSharedRoots: ['/Volumes/<你的NAS>/qcwolrd/共用'],
  matRoots: {
    // '直投号A': '/Volumes/<你的NAS>/qcwolrd/<号A的空间目录>',
    // '直投号B': '/Volumes/<你的NAS>/qcwolrd/<号B的空间目录>',
  },
};
