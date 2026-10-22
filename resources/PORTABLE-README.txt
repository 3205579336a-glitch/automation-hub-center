SAP Automation Toolbox 0.2.4-hotfix.2 / 使用说明

本次热修（2026-10-16）：修复 RFQ / Source List 已有 SAP 会话识别及登录后重新检查；APQP 支持将选中的已有 949 窗口从其他 T-code 直接切到 ZMFM050035 并发查询。普通 APQP 模板快速预览不启动 Python/Excel，保存后缓存失效，运行前仍读取 Excel 当前数据；公式等特殊输入保留实时 Excel 预览。隐藏的登录窗口会尝试恢复显示。软件不会代选登录、证书、结束其他登录或保存/放弃。开始前请保存当前 SAP 工作。
请停止任务并退出旧版，再将本包完整解压到一个新文件夹运行；不要只覆盖旧 EXE。个人设置和日志仍保留在用户本地数据目录。

1. 请把整个文件夹解压到本机可写目录，再运行 SAP Automation Toolbox.exe。
2. 软件已内置 Python 自动化运行时，用户无需安装 Python 或 pip 包。
3. 业务运行仍需要公司电脑已有的 SAP GUI、Microsoft Excel、Google Chrome 和公司网络/VPN。
4. 首次测试请使用测试系统和少量数据。正式系统操作会写入真实业务数据。
5. 功能：NPL 批量创建 Buyer Receipt/RFQ、SLT 标准/寄售维护、APQP 日期查询、Source List 维护。PR/ME52N 不在本次发布中。
6. SLT 的并发浏览器及 APQP 的并发 SAP 会话受设置、可用窗口和系统限制；APQP 不要求先回首页，也不额外创建会话。RFQ、Source List 顺序执行。用户仍须完成证书选择及 SAP 登录，不会绕过权限。
7. Source List 模板中的 Dual Sourcing 必须选 Yes/No。Yes 保留其他 Fix/MRP；No 清空其他 Fix/MRP，保留原供应商行及日期。新增行默认当天起至 31.12.2099，采购组织及 Plant 默认 C100。
8. RFQ 每组结果先保存在日志目录的安全副本，再写回原始 Excel 的执行结果列；支持原文件已打开，也可由后台 Excel 打开后写入。请勿在运行中排序或修改输入数据。只读、冲突或保存失败会明确提醒查看结果副本，不会重新执行 SAP。其他功能也支持回写打开的 Excel。Hub 生成的备份、临时文件、错误日志位于隐藏数据目录 logs 下；Excel 自身的锁文件由 Office 管理。
9. 60 天清理仅处理符合条件的日志/已完成生成文件；正在运行或待核查的记录受到保护。程序重启发现未完成 RFQ 时要求人工核查，不会自动重放 Create/Save。
10. 停止不会撤销已保存的 SAP 数据。已经发出的创建/保存操作可能需要等待确认；请查看结果再重试。
11. 不要只复制 EXE；保留 resources、locales 和所有 DLL。不要从 ZIP 内或网络盘直接运行。无法启动时请保留报错截图并联系 Key User；公司安全策略可能需要 IT 批准。

English

Hotfix (2026-10-16): RFQ/Source List verify existing SAP sessions and allow sign-in rechecks. APQP switches selected existing [949] windows from other T-codes to ZMFM050035 for parallel queries, without creating sessions. Normal saved-template previews no longer start Python/Excel; changed files invalidate the cache and execution still validates current Excel data. Formula/special inputs retain live Excel preview. Hidden sign-in windows are restored where possible. Sign-in, certificates, ending other logons and save/discard choices remain manual. Save current SAP work before starting.
Stop active runs and exit the old app before extracting this complete package into a new folder. Do not replace only the EXE. Existing per-user settings and logs remain in the local data directory.

1. Extract the complete folder to a writable local directory, then run SAP Automation Toolbox.exe.
2. The Python automation runtime and packages are included. Users do not install Python or pip packages.
3. Business operations still require the company-provided SAP GUI, Microsoft Excel, Google Chrome, and network/VPN access.
4. Start with a few rows in the test system. Production operations write real business data.
5. Included: batch Buyer Receipt/RFQ from NPL, standard/consignment SLT maintenance, APQP date queries, and Source List maintenance. PR/ME52N is not exposed in this release.
6. SLT browser and APQP concurrency depends on Settings, available windows and system limits. APQP does not require SAP home or create additional sessions. RFQ and Source List run sequentially. Sign-in/certificate selection and SAP authorization remain required.
7. Source List requires explicit Dual Sourcing Yes/No. Yes preserves other Fix/MRP; No clears other Fix/MRP while retaining supplier rows and dates. New rows default to today through 31.12.2099, purchasing organization/Plant C100.
8. RFQ group results are saved to a safe copy in logs first, then written to the original workbook's result columns through Excel (open or opened in the background). Do not sort or change inputs during a run. Read-only files, conflicts or save failures show a warning and retain the result copy; SAP work is never replayed to retry Excel writeback. Other operations also support open-workbook writeback. Hub backups, temporary files and logs stay in the hidden data logs directory; Office manages its own lock files.
9. Retention removes eligible logs/completed generated files after 60 days. Active/unresolved work is protected. Safe Recovery requires manual review and never automatically replays Create/Save.
10. Stop is not SAP rollback; dispatched create/save actions may need confirmation before stopping. Review results before retrying.
11. Keep the entire extracted folder, including resources, locales and DLLs. Do not run inside the ZIP or from a network share. Corporate endpoint policy may require IT approval; retain startup errors for your Key User.
