SAP Automation Toolbox 0.2.4 / 使用说明

1. 请把整个文件夹解压到本机可写目录，再运行 SAP Automation Toolbox.exe。
2. 软件已内置 Python 自动化运行时，用户无需安装 Python 或 pip 包。
3. 业务运行仍需要公司电脑已有的 SAP GUI、Microsoft Excel、Google Chrome 和公司网络/VPN。
4. 首次测试请使用测试系统和少量数据。正式系统操作会写入真实业务数据。
5. 功能：NPL 批量创建 Buyer Receipt/RFQ、SLT 标准/寄售维护、APQP 日期查询、Source List 维护。PR/ME52N 不在本次发布中。
6. SLT 的并发浏览器及 APQP 的并发 SAP 会话受设置、空闲窗口和系统限制；RFQ、Source List 顺序执行。用户仍须完成证书选择及 SAP 登录，不会绕过权限。
7. Source List 模板中的 Dual Sourcing 必须选 Yes/No。Yes 保留其他 Fix/MRP；No 清空其他 Fix/MRP，保留原供应商行及日期。新增行默认当天起至 31.12.2099，采购组织及 Plant 默认 C100。
8. RFQ 执行结果及生成的 RFQ 号码保存在工作副本；其他功能可回写打开的 Excel。生成的备份、临时文件、错误日志位于本地隐藏数据目录的 logs 下，而不是程序或输入文件旁。
9. 60 天清理仅处理符合条件的日志/已完成生成文件；正在运行或待核查的记录受到保护。程序重启发现未完成 RFQ 时要求人工核查，不会自动重放 Create/Save。
10. 停止不会撤销已保存的 SAP 数据。已经发出的创建/保存操作可能需要等待确认；请查看结果再重试。
11. 不要只复制 EXE；保留 resources、locales 和所有 DLL。不要从 ZIP 内或网络盘直接运行。无法启动时请保留报错截图并联系 Key User；公司安全策略可能需要 IT 批准。

English

1. Extract the complete folder to a writable local directory, then run SAP Automation Toolbox.exe.
2. The Python automation runtime and packages are included. Users do not install Python or pip packages.
3. Business operations still require the company-provided SAP GUI, Microsoft Excel, Google Chrome, and network/VPN access.
4. Start with a few rows in the test system. Production operations write real business data.
5. Included: batch Buyer Receipt/RFQ from NPL, standard/consignment SLT maintenance, APQP date queries, and Source List maintenance. PR/ME52N is not exposed in this release.
6. SLT browser and APQP session concurrency depends on Settings, idle sessions and system limits. RFQ and Source List run sequentially. Sign-in/certificate selection and SAP authorization remain required.
7. Source List requires explicit Dual Sourcing Yes/No. Yes preserves other Fix/MRP; No clears other Fix/MRP while retaining supplier rows and dates. New rows default to today through 31.12.2099, purchasing organization/Plant C100.
8. RFQ numbers/results are stored in a working copy; other operations can write back through an open Excel workbook. Generated backups, temporary files and logs are kept under the per-user hidden data logs directory.
9. Retention removes eligible logs/completed generated files after 60 days. Active/unresolved work is protected. Safe Recovery requires manual review and never automatically replays Create/Save.
10. Stop is not SAP rollback; dispatched create/save actions may need confirmation before stopping. Review results before retrying.
11. Keep the entire extracted folder, including resources, locales and DLLs. Do not run inside the ZIP or from a network share. Corporate endpoint policy may require IT approval; retain startup errors for your Key User.
