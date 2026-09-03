# PROGRESS

## 2026-09-01：NetVerify 会话韧性任务开工回执

- 目标：为 RSSHub 增加同源 NetVerify 登录授权、无密码恢复、30 分钟网络宽限和唯一入口网关。
- 顺序：先冻结 UI 基线；再实现授权核心与持久恢复；随后接入网关/UI；最后测试、反向验证和部署检查。
- 分支：`feature/netverify-session-resilience`。
- 基线状态：与任务书一致；Node 98/98，语法检查通过，Compose 配置通过。
- 最大风险：token 与登录时 RSA 私钥必须成对恢复。
- 本轮约束：参考项目只读，不读取或复制凭据、私钥、DPAPI 文件或存储主密钥。

## 2026-09-01：NetVerify 任务 0 基线冻结

- 已在 `master` 的目标现场建立功能分支；禁止 reset/clean/stash，保留原有 UI 和 Compose 改动。
- `node --test ui/*.test.mjs`：98/98 通过，fail 0，skip 0，todo 0。
- `node --check ui/server.mjs`：通过。
- `docker compose config --quiet`：通过。
- 以上现有文件将作为独立 UI 基线提交；后续功能改动遵守任务书白名单。

### 任务 0 结论

- 参考 `.env`：NetVerify Base URL `present`，App ID `present`，App Secret `absent`，配置键名 `match`；未输出任何值。
- 基线提交：`2658a9696 chore: checkpoint RSSHub UI baseline`。

## 2026-09-01：任务 1 授权核心实现中

- 已确认固定连接配置将集中写入 `auth/config.py`，不接受环境变量覆盖；App Secret 固定为 `None`。
- 设计约束：唯一持久凭据记录同时包含 token、匹配 RSA 私钥、最后成功心跳和到期时间，并以 AES-256-GCM 原子替换写入。
- 设计约束：Docker 使用宿主卷中的一次性安装 ID；浏览器只接收九态及白名单授权摘要。

### 任务 1—2 已完成

- `auth/netverify.py` 实现九态、业务错误不重试、网络错误最多 3 次指数退避、token 轮换、心跳、激活、强退和 30 分钟宽限判定。
- `auth/secure_store.py` 使用 AES-256-GCM 单文件原子替换；token、匹配 RSA 私钥、最后成功心跳和授权到期时间始终成对保存，孤儿/损坏记录清除。
- `auth/gateway.py` 是唯一对外入口；只有根页、登录静态资源、`/api/auth/*`、`/healthz` 公开，功能 API/RSSHub 回退均须授权。
- UI 在 `/api/auth/session` 恢复完成前隐藏原界面；active 才解锁，networkError 保留当前任务并展示 30 分钟宽限提示，强退/明确失效停止新任务。
- Compose 已将 `127.0.0.1:1200` 指向 `auth-gateway`，UI 仅 `expose: 3000`；生产主密钥由宿主只读挂载，初始化脚本不覆盖既有文件。
- Python 授权测试：44/44 通过；Node 测试：115/115 通过；两者 fail/skip/todo 均为 0。

## 2026-09-01：反向验证

- API 鉴权反向验证：临时公开 `/api/query` 后未登录门禁为 `1 failed, 4 passed`；还原后为 `5 passed`。
- RSA 成对恢复反向验证：临时传入错误私钥后重建恢复为 `1 failed`（期望 active、实际 signedOut）；还原后为 `1 passed`。
- 以上破坏均已还原，未进入提交。

## 2026-09-01：最终验收

- `node --test ui/*.test.mjs`：115/115 通过，fail 0，skip 0，todo 0。
- `node --check ui/server.mjs`：通过。
- `E:\autocut-studio - 副本\.venv\Scripts\python.exe -m pytest -q auth/tests`：44/44 通过。
- `docker compose config --quiet`：通过。
- `docker compose build auth-gateway ui`：`rsshub-auth-gateway Built`、`rsshub-ui Built`。
- `git diff --check`：通过。
- 官方 SDK `netverify_client.py` 已原样复制，SHA256 与参考文件一致；功能改动均在白名单内。
- BLOCKED：无。

## 当前目标

为现有 RSSHub 可视化界面新增本地 `.xlsx` 导入、账号链接识别、最新更新时间抓取、保真回写、停止续跑与结果下载；不改变现有 Cookie 池和粘贴链接模式语义。

## 已完成

### 2026-09-01：恢复现场与任务 0 基线

- 已读取任务书、`PROGRESS.md`、`BLOCKED.md` 和当前 Git 状态。
- 已读取 Spreadsheets 技能、格式规范和 artifact-tool API 快速文档。
- 已定位 bundled Node 与 `@oai/artifact-tool` 依赖路径，尚未执行任何工作簿写出。
- 基线命令：
  - `git status --short`：`docker-compose.yml` 为已有修改；`ui/`、`PROGRESS.md`、`BLOCKED.md` 为未跟踪内容。
  - `node --test ui/*.test.mjs`：73/73 通过，fail 0，skip 0，todo 0。
  - `node --check ui/server.mjs`：通过。
  - `docker compose config --quiet`：通过。
- 任务书所写“68 个现有测试”与当前实际 73 个不一致；以当前 73 项作为只增不减的冻结基线。

## 当前阶段

- 任务 0—3 已完成，当前版本已部署到本机 Docker 并通过最终验收。

### 2026-09-01：任务 0 保真门禁

- 源样例：`总表-8月刊例拉克（文宸&星之&诺裕&听澜&超火&南絮）8.20_已更新.xlsx`，1,390,114 字节，SHA-256 `37AC0E157A020E491B0CEB9CBAEFE32DCABA8834078F846DABB553DCA1EEB9CC`。
- 已新增独立 OpenXML 指纹验证器 `ui/workbook-fidelity.mjs`，覆盖包部件、工作表顺序、单元格值/类型/公式/样式引用、列宽行高、合并、超链接、筛选、冻结窗格和关系资源。
- artifact-tool 无修改往返失败：虽然仍有 37 张工作表，但改变 80 个 OpenXML 部件、包资源从 79 个降至 77 个，并报告工作表 `sheetId` 异常；该方案禁止用于正式输出。
- 已切换为最小 OpenXML 补丁方向。JSZip 仅解包再原样封包的验证结果：`ok=true`、37 张工作表、79 个部件、0 个内容差异，源文件哈希保持不变。
- 文件事实：主样例有 37 张工作表，但 `xl/tables/` 部件数量为 0；任务书“37 个表格”与当前源文件不一致。为避免改变结构，后续以“正式 Table 部件数量保持与源文件一致”为验收标准，不凭空新增表格。

### 2026-09-01：任务 1 工作簿核心（第 1 轮实现）

- 已固定 JSZip 3.10.1 到 `ui/vendor/`，浏览器与 Node 测试均不依赖 CDN。
- 已新增包含多表头、冻结窗格、列宽行高、合并、公式、内外超链接和正式 Table 的合成工作簿夹具。
- 已新增 `ui/workbook.mjs`，支持文件校验、工作表/表头/链接列识别、默认列优先级、业务链接列排除、全工作簿去重、刷新/续跑计划、日期与错误回写、最小 OpenXML 插列修补。
- Excel 分析已能识别尚未跳转的短链所属平台；真正的短链解析保留在执行阶段。
- `node --test ui/workbook.test.mjs`：18/18 通过，fail 0，skip 0，todo 0。

### 2026-09-01：任务 2 页面、队列与下载门禁（第 2 轮实现）

- `ui/index.html` 已新增 Excel 区域：选择/拖放、文件校验、刷新/续跑、逐表链接列选择、命中和去重统计、开始/停止、进度、部分/最终下载。
- 已新增 `ui/workbook-runner.mjs`：去重任务每个只请求一次，按平台 Cookie 池健康/待验证成员和每 Cookie 并发数动态调度；停止后不再派发，未完成项不写入错误。
- Excel 状态与原粘贴链接状态完全分离，不复用原页面的 `rows` 或 `activeRun`。
- 已新增浏览器端 `verifyWorkbookOutput`：生成后二次构造期望输出，对比所有 OpenXML 部件，检查未声明变更、工作表顺序和目标列头；失败时下载按钮保持禁用。
- `ui/server.mjs` 已本地托管固定的 JSZip 和 Excel 模块，`ui/Dockerfile` 已包含这些文件。
- 页面交互检查：合成工作簿导入后显示 4 表/5 记录/3 去重/2 跳过；续跑切换为 4 记录；零网络任务组合能生成输出，保真校验通过并启用下载；页面控制台无错误。

### 2026-09-01：任务 3 样例与最终验收

- 主样例只读检测：37 张工作表，36 张含候选列，24 张默认选中；刷新模式 4,936 个出现位置/4,913 个去重账号，续跑模式 3,392 个出现位置/3,389 个去重账号。
- 指定表检测：“抖音汽车”主页列 501 条支持+4 条不支持（总记录约 505）；“小红书汽车”375 条；“快手-娱乐”20 条；“APP-KOC”实际 2,657 条链接中 2,395 条属于已支持的 29 平台、262 条不支持。任务书“APP-KOC 约 507”与实际文件不符，为避免漏抓未人为截断。
- 主样例无结果临时回写通过浏览器保真门禁：`verificationOk=true`，仅 9 个声明部件变化，无校验错误。
- 源样例最终 SHA-256 仍为 `37AC0E157A020E491B0CEB9CBAEFE32DCABA8834078F846DABB553DCA1EEB9CC`，与任务开始前相同。
- 已渲染并视觉检查主样例全部 37 张表的 `A1:Z25`；第 36 张表名末尾空格导致渲染器首次查找失败，仅在临时内存副本中去尾空格后成功渲染，源文件未变。
- 反向验证：故意删除超链接关系或将合成 Table 范围从 `A3:F5` 破坏为 `A3:E5` 时，指纹/下载门禁返回失败；恢复正确输出后返回通过。
- 最终命令：
  - `node --test ui/*.test.mjs`：98/98 通过，fail 0，skip 0，todo 0。
  - `node --check ui/server.mjs`、`ui/workbook.mjs`、`ui/workbook-runner.mjs`、`ui/workbook-ui.mjs`：通过。
  - `docker compose config --quiet`、`git diff --check`：通过。
  - Docker 四个服务均为 healthy，页面为 `http://localhost:1200/`。
- 改动范围审计：本任务只改了白名单内的 `ui/index.html`、`ui/core.mjs`、`ui/server.mjs`、`ui/server.test.mjs`、`ui/Dockerfile`、新增 `ui/workbook*.mjs`、`ui/fixtures/**`、`ui/vendor/**`、`PROGRESS.md`和`BLOCKED.md`。`docker-compose.yml` 在基线时已是脏文件，本任务未修改或回退它。

## 剩余风险

- 真实平台查询仍受 Cookie 有效期、登录墙和平台风控影响；Excel 模块会写入简短错误并允许续跑，不会伪造时间。
- 主样例实际没有 `xl/tables/` 正式 Table 部件，因此最终验收是保持 0 个，而不是任务书估算的 37 个。合成夹具已覆盖正式 Table 的插列保真。
- 为保护浏览器内存，首版继续限制单文件 20 MB。

## 下一步

无。当前任务已达到可交付状态。

## 2026-09-01：Excel 失败项自动重试

- Excel 批量模式在第一轮全部完成后，自动筛出真正失败的去重账号，最多连续重试三轮。
- 每轮只携带上一轮仍失败的账号；已成功账号和正常返回“无作品时间”的账号不重复请求，最终仍失败则保留最后一轮错误。
- 重试阶段单独显示完成进度，结束后才生成完整回写文件并再次执行工作簿保真校验。
- 切换工作表链接列或运行模式时会清除旧运行状态，防止旧失败记录污染新计划。
- `node --test ui/*.test.mjs`：118/118 通过，fail 0，skip 0，todo 0。
- `node --check ui/workbook-runner.mjs`、`ui/workbook-ui.mjs`：通过。
- Docker UI 与授权网关已重建；`http://localhost:1200/` 返回 200，全部 5 个服务 healthy。

### 2026-09-01：永久错误过滤与失败分类

- 已将 Excel 重试条件收紧为仅处理超时、HTTP 408/429/5xx、连接异常和临时风控；缺少可用 Cookie、HTTP 400/401/403/404、用户不存在、链接失效及未提取到时间均不再进入后续轮次。
- 回写错误统一增加可筛选的中文类别前缀，包括 `【缺少可用Cookie】`、`【用户不存在】`、`【链接失效】`、`【页面不存在】`、`【访问受限】`、`【请求超时】`、`【临时风控】`、`【平台临时异常】`、`【连接异常】`、`【未提取到时间】` 和 `【无作品时间】`。
- 回归测试先复现永久错误被请求4次，修复后永久错误仅请求1次，HTTP 503仍会重试并可恢复成功。
- `node --test ui/*.test.mjs`：120/120 通过，fail 0，skip 0，todo 0。
- 旧页面任务已主动停止，25条新增成功结果已保留，部分输出通过工作簿保真校验。

## 2026-09-01：按账号所属应用修正 App ID

- 用户确认新账号属于 NetVerify App ID `96`；此前参考 `.env` 的 App ID 为 `83`，会导致账号向错误应用发起登录。
- 已将当前功能分支集中固定配置改为 `96`；Base URL 不变，App Secret 仍固定为 `None`，不接受环境变量覆盖。
- 本次仅修改授权配置与对应测试断言；未合并或提交到 `master`，未触碰用户现有 Excel 未提交修改。

## 2026-09-02：Cookie 本地目录持久化与三页控制台（进行中）

- 已独立提交此前已有的 Cookie/Excel/授权功能改动：`8e2b2fc05 feat: improve cookie resilience and workbook retries`；生成目录、输出和凭据均未提交。
- Compose 已改为将 `${RSSHUB_USER_DATA_DIR:-E:/更新频率表/rsshub-console-data}/cookies` bind mount 到容器 `/cookies`（UI 可写、RSSHub 只读）；旧命名卷保留用于迁移和回滚。
- 新增迁移脚本：只读复制旧卷、临时目录校验文件数与 JSON、原子切换并写无凭据摘要；自动化测试覆盖无损 fixture 复制和目标非空拒绝。
- 已实现 hash 三页导航、当前/全平台 Cookie 并发设置，以及回收区逐条永久删除；后续继续做完整回归与实际迁移确认。
- 目标原有目录已按用户授权整体移至同级可恢复备份目录；未读取或输出其中内容。已从 `E:/更新频率表/cookies` 复制并校验 35 个文件到默认本地用户数据目录，迁移标记显示 `sourceKind=directory`、`fileCount=35`、`jsonValidated=true`；旧源目录与旧 Docker 卷均保留。
- `docker compose build ui rsshub`：通过；构建上下文仅包含 `ui/`，未包含宿主机用户数据目录。
- 容器级隔离验证：以临时用户数据根目录和假 Cookie 运行两次独立 `docker compose run --rm --no-deps ui`，首次导入与重建后恢复均为 `members=1`；临时目录、网络和专用测试卷均已清理。
- 用户确认现有 Cookie 在 `E:/更新频率表/cookies`；迁移工具现同时支持旧 Docker 卷和该类旧宿主机目录作为只读来源。源目录 35 个 JSON 文件已无损迁移；UI 重建后健康，内部 Cookie 列表 API 仅计数验证为 29 个平台、28 个成员，未输出 Cookie 或摘要；授权网关、RSSHub、UI 均 healthy。

## 2026-09-02：现代桌面工具视觉改版开工

- 目标：在不改动既有功能语义的前提下，统一登录、授权与三页控制台为亮暗主题的桌面应用框架。
- 顺序：先建立令牌和无闪主题初始化，再重构侧栏/顶栏/页面布局，随后补视觉契约和截图验收。
- 最大回归风险：框架重排可能误影响既有 id、hash 路由、授权恢复和 Excel/Cookie 交互；这些将保持原 id 与事件语义。

## 2026-09-02：现代桌面工具视觉改版完成

- 已在 `ui/index.html` 建立亮暗主题令牌、首屏恢复逻辑、固定 100dvh 壳层、216/72px 可记忆侧栏、内嵌 SVG 导航及 reduced-motion 规则；没有新增依赖或网络资源。
- 三页改为连续细边框面板；原有 id、hash 路由、表单、按钮和 API 调用均保留。已补正已解锁后授权重新恢复会错误隐藏壳层的问题，恢复期间保留当前任务与输入。
- 新增 `ui/visual-contract.test.mjs` 五项视觉契约；反向验证时临时删除 `--focus-ring`，得到 `pass 4 / fail 1`，还原后得到 `pass 5 / fail 0`。
- 视觉检查输出在 `outputs/ui-review/`：三页在 1280×720、1440×900 的亮/暗共 12 张，以及隔离空授权卷的 1440×900 登录亮/暗共 2 张；未输入、读取或输出真实 Cookie、密码、卡密。
- 侧栏实测：折叠后刷新保持 `72px`，重新展开刷新为 `216px`；正式授权网关重启后会话恢复到 `shell=grid`、`gate=none`。
