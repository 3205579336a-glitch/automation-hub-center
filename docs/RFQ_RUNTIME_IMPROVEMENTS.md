# RFQ 运行改进交付说明

日期：2026-10-09。仅源码修改，没有打包或自动创建任何正式 SAP 对象；开发验收后按用户要求提交并推送到现有 GitHub 仓库。

本次采用 Hub 运行时适配层，不重写 `rfq_engine.py` 中已接受的 RFQ 业务流程。原有 Parma 分组、精确多物料查询、Buyer Receipt、绿色校验、Cost Breakdown、RFQ 编号读取、Excel 回写和 PROD 护栏继续保留。此前已存在的源码修改也保留。

## 1. 本次文件变更

新增：

- `resources/rpa/rfq_runtime_improvements.py`：慢响应等待、Commodity 检查/重查、辅助会话、逐组性能观察与单次写入生命周期的列结构缓存。
- `src/main/services/run-diagnostic-cleanup.ts`：可信目录内的定向诊断清理。
- `scripts/test-rfq-runtime-improvements.py`：30 个运行安全、已确认 NPL/Commodity 字段与性能测试。
- `scripts/test-history-deletion.mjs`：19 个删除/批量清理、分页、保留期、IPC 护栏、文件保护、学习和暂停耗时测试。
- `scripts/rfq-runtime-smoke-test.mjs`：独立桌面验收，所有 SAP 入口模拟，历史删除使用真实本地 IPC。
- 本说明文件。

修改：

- `resources/rpa/rfq_runtime.py`、`rfq_interaction.py`：安装并还原运行时钩子；沿用共享等待框架，新增 `open-fix-session` 响应。
- `src/main/automation/rfq-native-runner.ts`：处理修正会话响应，保持暂停；校验 runId/requestId/allowedActions。
- `src/shared/automation-interaction.ts`、`rfq-batch-types.ts`、`execution-history-types.ts`、`ipc-channels.ts`：类型与受限 IPC。
- `src/main/services/execution-history-service.ts`、`diagnostic-logger.ts`：历史原子删除、运行日志归属和定向清理。
- `src/main/ipc/history-handlers.ts`、`rfq-handlers.ts`、`me01-handlers.ts`、`me12-handlers.ts`、`apqp-handlers.ts`：运行归属、删除护栏、历史结果路径。
- `src/main/index.ts`、`src/preload/index.ts`、`types.ts`：服务接入及最小 API。
- `src/renderer/src/pages/CreateRfqPage.tsx`、`HistoryPage.tsx`、`components/common/ActionRequiredModal.tsx`：双语等待状态、共享处理弹窗和删除确认。
- `scripts/fixtures/rfq-mock-engine.mjs`、`test-rfq-runner.mjs`：新增修正会话的主进程协议测试。
- `scripts/build-automation-engine.ps1`：未来构建所需 hidden import；本次未执行引擎打包。
- `package.json`、`README.md`：测试入口及说明。

上述清单只说明本任务；工作区中更早的 UI、智能排序、ETA 和 SAP 登录修正不属于这次重新实现的内容。

## 2. SAP 等待策略：修改前后

修改前：公共 Busy、控件、表格列等待在单一超时后抛错；短暂慢响应容易被当成失败。原引擎本来就存在状态轮询，并非所有步骤都是固定睡眠。

修改后：Hub 覆盖这三个公共等待入口，仍只观察状态，不重复按钮动作。

- 正常时间：检查 Busy 清除、预期控件或预期列是否可读。
- 软超时：沿用每个调用传入的原超时，仅显示 `SAP_SLOW`；最长每 5 秒更新等待秒数，不播放普通慢响应告警。
- 恢复：预期条件满足后发出 `SAP_RECOVERED`，直接返回这次等待结果，不重新 Save/Create。
- 硬超时：内部 `RFQ_WAIT_HARD_TIMEOUT_SEC` 默认 180 秒，可设 30–900；实际上限不小于原调用的软超时。进入共享 `WAITING_FOR_USER` 弹窗。
- 只有确认原系统、Client、用户、会话、窗口标题和 NPL 表格列的创建前检查点，允许重查。随后仍须执行原精确匹配和 Commodity 检查。未知页面、Busy 单独等待和提交后的公共等待不提供盲目继续。
- 保留原已测试的业务弹窗恢复信号，不将业务错误当成普通慢响应。
- 创建开始后正常 Stop 保留“完成当前组、读编号、保存 Excel 后停止”。NPL 创建前及已暂停处理点可立即停止。提交结果不明时停止不代表回滚，必须在 SAP 核对后重试。

内部 `RFQ_WAIT_POLL_SEC` 默认沿用引擎轮询周期，可设 0.05–2 秒。ETA 历史不控制任何安全超时。

范围限制：专用保存弹窗、绿色状态、返回 NPL 和 RFQ 完成步骤中已有的独立循环没有全部替换；保留它们的既有安全处理。已知同步边界的 0.4 秒动作后暂停也没有凭假设删除。

## 3. 性能剖析和实测对比

日志增加 `WRITE_PROFILE`：Material→行映射、列元数据、每列写入、focus、TriggerModified、Enter/validation、写入期间 Busy/控件等待。每组 `RUNTIME_PROFILE` 汇总公共控件等待、Busy 等待和原绿色状态检查。日志中的嵌套时间可能重叠，不能简单相加。UI 不将这些内部性能事件当作用户操作提示。

本次定位到可确定的冗余：同一个写入函数、同一个表格内反复读取不变的列结构。仅缓存该次函数调用的列存在结果，结束即丢弃。**不跨页面缓存物料映射、数据或 COM 控件**。

没有逐字段 sleep 可安全直接删除；本次不减少 focus、TriggerModified、Enter 次数，也不改变其顺序。所有 COM 写入仍串行执行。内部 `RFQ_SCHEMA_CACHE_ENABLED=false` 可关闭缓存进行对照。

50 行受控模拟结果：

| 写入阶段 | 修改前 | 修改后 | 列元数据读取次数 |
| --- | ---: | ---: | ---: |
| Buyer Receipt | 3.950 秒 | 2.970 秒 | 100 → 2 |
| RFQ | 4.100 秒 | 2.630 秒 | 150 → 3 |

这是注入延迟的确定性模拟，不是生产 SAP 性能承诺。fixture 设定 ColumnOrder 10ms、GetCellValue 2ms、写入 4ms、TriggerModified 6ms、Enter 7ms。前后输出值、checkbox 状态及调用顺序完全一致；真实环境的主要瓶颈仍需用新增日志确认。

## 4. Commodity 字段/控件

在现有 NPL `ID_GRID_CUSTOMER1` 表格、精确匹配之后、原 `create_buyer_receipt_skipping_existing_rfq` 之前检查。

技术列现已由用户提供的 ZMFM050072 SAP GUI 录制确认：`setCurrentCell -1,"ZCOMCODE"`、`selectColumn "ZCOMCODE"`，对应 `wnd[0]/usr/cntlCUSTOMER1/shellcont/shell`。默认明确绑定 `ZCOMCODE`，不再依赖列标题或语言猜测。仍读取 `ColumnOrder` 验证该列存在；缺列、表格不可读或值不可读一律暂停，不创建 Buyer Receipt，也不回退到其他同名/相似列。

逐物料重新验证 `MATNR`、`WERKS`、NPL 项目列 `ZPSPID` 的唯一行。实际 SAP 只读排查确认：NPL 不包含 `MPPPSPID`，读取它会产生 `E_INVALIDARG`，这不是 Commodity 缺失。Hub 仅在 NPL 精确匹配调用内将项目参数适配为 `ZPSPID`，并在 finally 还原；原引擎常量及 Buyer Receipt/RFQ 页面使用的 `MPPPSPID` 不变。

Commodity 直接 `GetCellValue`：成功读取为空白、null/None 时进入 `COMMODITY_MISSING`；缺列、COM 读取异常、类型异常或 Plant/Project 不匹配进入 `NPL_READ_FAILED`。后者明确告知“尚未确认 Commodity 缺失，请勿因此修改主数据”，不提供修正会话按钮，只允许重新读取检查或停止。错误详情记录字段、SAP 行号和物料。不强加固定长度或数字规则。`COMMODITY_CHECK_RESULT` 记录项目技术列名、Commodity 技术列名及受影响物料。

重查仍使用原精确查询并读取新数据；重查失败时可在这两个原因间转换，但不解锁任务。新的 requestId、检查点及允许操作同步更新；已用过的打开修正会话动作不会重新出现。

可由开发者在确认实际 SAP 字段后设置内部 `RFQ_COMMODITY_COLUMN`，仍要求该列确实存在；普通用户不需要填写技术字段。

技术列名已由用户实际录制与当前 NPL 只读检查确认；自动回归测试全部使用模拟数据，没有在 SAP 创建对象。尚需用户人工验收完整的缺失→修正→重新查询→继续流程。列标识和读取接口参考 SAP 官方 [GuiGridView 文档](https://help.sap.com/docs/help/b47d018c3b9b45e897faf66a6c0885a8/4af24c3281fb4d6a809e53238562d3b2.html)。

缺失物料合并为当前组一个共享弹窗，沿用 ATTENTION 音效、任务栏提醒；不要求在 Hub 输入 Commodity。点击“已修复，重新检查”必须使用原精确查询逻辑重新查询 NPL、重新匹配全部待处理物料并读取新值。未修复、会话变化或错误页面继续暂停。

## 5. 辅助 SAP 会话

仅 Commodity 暂停检查点提供 Open Fix Session。

调用原已验证会话的 `CreateSession()`，只在它的 Parent connection 中查找新 SessionId，再验证 SystemName、Client、User 与原会话一致。不调用 OpenConnection，不重新登录、不采集凭据、不自动选择多重登录选项。

新会话在 Hub 明确标注为人工修正会话。原 NPL 会话不导航、不写 Commodity。没有猜测主数据维护事务码。

12 秒观察窗口内找不到符合条件的新会话，或 IT 策略/会话数量限制导致失败时，保留原暂停，提示使用另一个已有 SAP 会话人工维护，再点击 Recheck。共享请求保持有效，失败不是 RFQ 批次失败。每个暂停检查点仅尝试打开一次，之后隐藏按钮，避免重复开窗；人工重查和停止仍可用。

## 6. 删除日志/历史行为

Execution History 和设置诊断日志均分页展示（分别 25 条、20 条/页），查询条件先应用再分页，筛选变化回到第一页。历史行只保留查看详情，不再提供逐条删除。

两个页面共用“一键清空日志”确认弹窗，明确清理全部已结束历史和可识别的日志，而不仅是当前页/筛选结果。当前有自动化运行时主进程拒绝清理；清理持有独占标记，新批次不能同时开始。未结束的 Running 历史及能归属到它的共享日志保留。

软件启动时和每 24 小时空闲检查一次 60 天保留期。按完成时间（老记录无完成时间才用开始时间）清理，恰好 60 天边界、无效日期、Running 记录不删除；关闭软件时不运行清理。共享日志按实际时间戳清理，自动清理保留损坏或无法确定日期的行。人工清空仅可删除可信日志目录内固定命名的 app JSONL；链接、结果/备份和无法安全归属的外部日志不删除。

确认后先原子写入新历史，成功后才清理；历史损坏或写入失败不会先删除文件。

- RFQ：可信 UUID run 下 `logs/`、`temp/`；历史明确归属且位于该 run/output 内的日志 CSV，及 native runner 在 logs 中复制的同名诊断 CSV。成功、失败、取消的已知日志路径均记录到历史；无可识别路径的旧/异常诊断采用保留策略。
- 其他任务：明确归属的 `interactions/<diagnosticRunId>/` 检查点。
- 共享每日日志：自动保留期只清理超过截止时间的行；人工清空移除全部普通应用日志，保留未结束历史对应的行。
- 保留原始 Excel、输入快照、结果工作簿、备份、其他任务数据、浏览器配置、设置和预览缓存。
- 路径由主进程历史和配置解析，不接收 renderer 的任意目录。删除前验证范围和真实路径；不跟随 junction/symlink；业务数据扩展名及已登记结果/备份路径受到保护。
- 未归属的旧日志、共享日志、不明确或在用户 Downloads 中的外部 sidecar 采用保留策略。锁定、权限或路径验证问题返回保留提示。删除历史不保证清除所有旧版本零散文件。
- 删除仅影响本地数据，不修改 SAP，更不会撤销已创建对象。确认后诊断删除不可恢复；需要排错的运行请先保存诊断。

自动测试实际删除的只有独立临时 fixture；没有删除用户现有执行历史。

## 7. ETA/排序影响

- SAP_SLOW 是自动化活动时间，照常参与 ETA 观察；不会播放人工处理提醒。
- Commodity 或硬超时 WAITING_FOR_USER，以及手动重查 RECOVERING，不计入学习活动时间，显示等待/验证状态。
- 仅 `INTERACTION_RESOLVED` 允许 ETA 解除暂停；普通日志或修正会话打开成功不解除暂停。
- 删除运行会同时移除其 performance 样本。下一次任务页/首页排序快照和下一次运行 timing model 使用剩余历史。
- 历史为空返回默认顺序及内置 ETA。保留原“当前页面不跳动”和“排序/ETA 不控制 SAP”的契约。

## 8. 验证结果

通过的测试：

- `npm run test:rfq-runtime`：30 个，包括实际三物料乱序回归、NPL `ZPSPID` 与其他页面 `MPPPSPID` 隔离、映射钩子异常还原、字段读取失败不误报缺失、重查原因双向转换且始终暂停、受限修正会话动作及原等待/性能测试。
- `npm run test:history-deletion`：19 个，包括分页/筛选、全量清理、精确 60 天边界、未结束任务保护、主进程拒绝运行中清理及旧逐条删除请求、损坏历史不删除日志、独占清理、跨记录结果保护、部分清理反馈及学习/暂停耗时。
- `npm run test:rfq`：34；RFQ 原业务定义 AST 基线仍通过。
- `npm run test:rfq-fields`：12；Cost Breakdown No 强制取消、Yes 不动、Qty 正确映射。
- `npm run test:rfq-material-reset`：9；上一组物料清理不回归。
- `npm run test:rfq-recovery`：13。
- `npm run test:rfq-runner`：10 个子测试（Node 含父测试报告 11），含修正会话 IPC、过期响应拒绝和 Stop-only 护栏。
- `npm run test:guided`：11 个 Node 子测试及 11 个 Python 测试。
- `npm run test:intelligence`：Node 报告 38；四个实际 IPC adapter 的 mock 引擎回归。
- `npm run test:apqp`：13；ME01 回归：3。
- `node scripts/rfq-runtime-smoke-test.mjs`：RFQ Running/Ready 与跨路由状态、启动保留期、真实 IPC 历史/诊断分页、筛选复位、带筛选的全量清理/取消确认与结果保护，以及原暂停恢复回归。所有文件清理均限于独立临时 fixture。
- 原 `rfq-smoke-test.mjs`、`intelligence-smoke-test.mjs`、`smoke-test.mjs`：通过；下载/预览、确认、通用人机交互、排名/ETA、四任务 UI 均未回归。
- TypeScript 检查、ESLint、前端/主进程构建及 `git diff --check`：通过。

截图位于 `artifacts/rfq-runtime-slow.png`、`rfq-runtime-commodity-dark-large.png`、`rfq-runtime-read-failure-dark-large.png`、`history-delete-confirmation-dark-large.png`。构建只生成开发运行所需 `out`，不生成安装包或便携包。已运行的 Python 引擎不会热加载源码修复，必须停止旧任务并重启源码版再验收；已有便携 EXE 未更新。

## 9. 剩余风险与人工验收

1. COM 调用是同步调用。如果 SAP GUI/COM 单次调用彻底卡死，进程内轮询无法在调用返回前触发硬超时；未引入会强杀并危及保存的新 watchdog。
2. 用户录制已确认 `ZCOMCODE`；其他系统/补丁的字段差异仍需人工验证。默认缺列会安全暂停，不能仅靠相似标题继续；不是自动写主数据。
3. 单次写入内列结构缓存假设这次函数中表格 schema 稳定；真实 SAP 重绘差异应先在安全验收环境检查。发现异常可关闭缓存。
4. 原专用恢复/提交循环的超时和安全延迟保留；此版本不承诺所有 SAP 等待都已变为统一慢响应模型。
5. 真实 SAP/网络性能没有测量。模拟性能对照只证明减少元数据调用且结果一致。
6. 增开会话受 IT 策略与 SAP 限额约束；辅助会话失败不能取消暂停，也不能改变原自动化会话。
7. SAP 保存后的未知结果不能回滚。Hard-timeout Stop 后必须核对对象和 Excel 状态，不能直接重复整批创建。
8. 旧版没有 runId 的日志及外部 sidecar 不会猜测归属后删除；异常终止遗留的 Running 历史仍受删除保护。
9. 真实 SAP 验收由用户手动确认执行：先验证全部有 Commodity 的组，再验证缺失→合并暂停→额外会话人工修正→重新查询→继续。检查 Qty、绿色状态、RFQ 编号及 Excel 一致性后再推广。本次自动测试全部使用 mock、fixture、离线验证，不访问 PROD 创建对象。
