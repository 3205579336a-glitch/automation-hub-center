SAP Automation Toolbox 0.3.0 / 便携版

1. 将压缩包完整解压到本机可写文件夹，再运行 SAP Automation Toolbox.exe。不要从 ZIP 内、网络盘运行，也不要只复制 EXE。
2. 已内置 Python 和自动化依赖，无需安装 Python 或 pip。公司 SAP GUI、Excel、Chrome/Edge 以及公司网络/VPN 仍需正常可用。
3. 升级前请停止任务并退出旧版。将本包解压到新文件夹；个人设置和日志保留在原本机数据目录。
4. APQP 日期管理固定使用正式系统 SAP 949。核对项目和负责人 User ID（默认填 Windows 登录名，可修改），查找、修改日期、保存。只保存四个计划日期，不修改实际日期、SD conf 或备注。
5. SAP 灰色日期不可修改。可安全处理的输入前问题会跳过；保存结果不确定或未知弹窗会停止，不会重复保存。开始前请保存 SAP 当前工作；运行中不要操作 Hub 使用的窗口。首次请只处理少量已获授权的数据。
6. APQP 日期修改按每个已保存并验证的字段人工 1 分钟估算节省时间，再扣除整批实际耗时。失败、跳过或未确认的字段不计入。
7. 其他功能：NPL 批量创建 Buyer Receipt/RFQ，标准/寄售 IR 的 SLT、PDT 和确认控制码维护，Excel 批量查询 APQP 关闭日期，Source List 维护和 MM02 Sub-commodity 批量修改。
8. Excel 可保持打开，但运行时不要排序、移动或修改输入行。回写失败时查看已保留的结果副本，不要重复运行 SAP。Source List 按目标供应商判断已存在记录；Dual Sourcing 为 Yes 时保留其他 Fix/MRP，为 No 时清除其他 Fix/MRP，保留供应商行及日期。
9. 登录、证书和 SAP 权限仍由公司系统控制。不要盲目结束其他登录或丢弃未保存内容。多窗口无法确定工作窗口时，按提示处理后再运行。
10. 停止不会撤销已保存的数据。重启后的 Safe Recovery 需要人工核查，不会自动恢复执行。日志和符合条件的已完成生成文件保留 60 天；原始 Excel、运行中及待核查证据不自动删除。重要结果请另存。
11. 同一时间仅运行一个任务，其他页面仍可准备。点击“查看正在运行的任务”可返回；结束后自动解锁。随包 docs 文件夹有 0.3.0 中英文指南和发布说明。公司安全策略仍可能需要 IT 批准；不要关闭或绕过公司安全软件。

English

1. Extract the complete ZIP into a writable LOCAL folder, then run SAP Automation Toolbox.exe. Keep resources, locales and all DLLs. Do not run inside the ZIP or from a network share.
2. Python and automation packages are included. Users do not install Python or pip. Company SAP GUI, Excel, Chrome/Edge and network/VPN access are still required.
3. Stop active tasks and close the old app before upgrading. Extract into a new folder; existing per-user settings and logs remain on the computer.
4. APQP date management uses PRODUCTION SAP 949. Check the project and responsible User ID (editable Windows login default), find APQPs, then edit and save. It saves the four planned dates, not actual dates, SD conf or comments.
5. Grey dates cannot be edited. Safe pre-input issues are skipped; uncertain saves and unknown dialogs stop the batch without replaying Save. Save unfinished SAP work first and do not use the automated window during a run. Start with a small authorized batch.
6. APQP date savings use 1 manual minute per saved and verified date field, minus total batch time. Failed, skipped and unverified fields earn no savings.
7. Also includes batch NPL Buyer Receipt/RFQ, Standard/Consignment Info Record SLT/PDT/confirmation control, Excel APQP closure queries, Source List maintenance and MM02 Sub-commodity updates.
8. Excel can stay open. Do not sort or edit inputs during execution. Review preserved results instead of rerunning SAP to retry Excel writeback. Source List skips existing target suppliers; Dual Sourcing Yes preserves other Fix/MRP, while No clears other Fix/MRP without deleting supplier rows or dates.
9. Sign-in, certificates, authorization and save/discard decisions remain subject to company controls. Stop is not rollback. Safe Recovery is manual review, never automatic resume.
10. Eligible logs/completed generated files expire after 60 days; original workbooks and active/unresolved evidence are protected. Export important results.
11. One task runs at a time; other pages remain available for preparation. Go to running task returns to the active task. The docs folder contains the 0.3.0 guides and release notes. Corporate security approval may still be required; do not disable or bypass endpoint protection.
