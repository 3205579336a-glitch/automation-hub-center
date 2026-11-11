# Purchasing Automation Hub — 0.3.0 user guide

## Install or upgrade

1. Finish or safely stop active work, then close the old Hub.
2. Extract the entire approved Windows ZIP into a **new writable local folder**. Keep the EXE, resources, locales and DLLs together. Do not run directly from the ZIP or a network drive.
3. Open **SAP Automation Toolbox.exe**. The sidebar footer should show **0.3.0**. Existing per-user settings and history remain on the computer.

Python, Node.js and pip are not required on the user's computer. Company SAP GUI with Scripting, Excel, the installed Chrome/Edge browser used by ME12, and company network/VPN access are still required as applicable. SAP credentials, certificates and authorizations remain with the company system. If Windows or endpoint protection blocks the package, verify the source with your key user or IT; do not bypass policy.

## Run a task

1. Open **Operations**, choose a task and select **Info** for its short instructions.
2. Download the current template when the task uses Excel. Fill the input fields, keep the headers, save Excel and upload it. Excel may stay open; do not sort, move or edit input rows during execution.
3. Check the preview and any business options. Start and confirm where prompted. Check the actual SAP environment before any write.
4. Follow the header status and task progress. When done, review the result and any skipped or failed rows. Use **Execution History** to find run details and result locations.

Only one SAP task runs at a time. You can switch pages and prepare another task, but its Start button stays disabled. **Go to running task** returns to the active task. After it ends, the next task unlocks without losing its preparation. Task-specific result dialogs wait until you return to that task. The global **Action Required** dialog, when SAP needs a decision, still takes priority.

| Task | Input and result |
| --- | --- |
| Buyer Receipt / RFQ | Fill the RFQ template. Hub groups by Plant, Project and Supplier Parma, with up to 50 materials per RFQ. Review the Production confirmation and result numbers. Hub reports whether original-workbook writeback succeeded; if it did not, use the preserved copy and do not rerun SAP just to update Excel. |
| Purchasing Info Records (ME12) | Enter an Info Record and at least one of SLT, PDT or Conf. Ctrl. per row. Blank change fields are left untouched. Plant and purchasing organization default to C100; Standard + Consignment is the default. Review each category's Excel outcome. If your browser requests a certificate or SAP sign-in, complete it yourself. |
| APQP Date Management | Choose **Find APQPs & Edit Dates** for the four planned dates, or **Query Plan Closure Date** for the read-only Excel workflow. |
| Source List (ME01) | Fill Material No., Parma and required Dual Sourcing Yes/No. An existing target Parma is skipped without changes. For a new Parma, the new row receives Fix and MRP 1; Yes preserves other Fix/MRP, No clears other Fix/MRP. No supplier rows or dates are deleted. |
| Sub-commodity (MM02) | Fill Material and the exact six-digit Sub-commodity, including leading zeros. Open an idle SAP Easy Access window in Production 949 and ensure you have the MM02 change role. Hub verifies the target classification and writes a separate Excel result. The source workbook is not changed. |

### APQP planned dates

- Check the project and **User ID** before finding APQPs. A supported Windows login is prefilled; replace it if the APQP owner is different. It is a search filter, not a SAP sign-in.
- The editor uses Production SAP 949, Plant C100. Edit only the required planned dates: RTS Confirmation, RTS Action & Closure, Total PPAP and APQP Closure. Grey dates are read-only; actual dates and SD comments are not changed.
- **Save dates** writes to Production. For each saved record, the Hub reopens and verifies the dates before counting them as saved. An uncertain save stops safely; never repeat the run blindly.
- **Use previous results** shows an older local read, not live SAP values. Use **Refresh from SAP** for current data. After upgrading from an older actual-date layout, read from SAP once. **Clear this page** resets displayed results and edits but keeps the project and owner filters.

## Dashboard, history and recovery

- Collapse or expand the sidebar from its bottom button. Language, theme, text size and notification sound are under **Settings**. Key-user diagnostic access is under **Support & logs**.
- **Estimated time saved** shows **Today** and **All time** for this device's retained records. Removed history no longer contributes. The estimate subtracts whole-run time and is not a measured personal productivity figure. Verified APQP date fields count at one manual minute per saved field before elapsed time is deducted.
- **Stop safely** preserves previously saved SAP changes; it is not rollback. If a save is uncertain, review SAP and the result before retrying. After an interrupted RFQ, **Safe Recovery** requires manual review and never automatically resumes.
- Local history and eligible completed run files expire after 60 days. Export important results to a separate location. Original input workbooks and unresolved RFQ evidence are protected. Review logs for business identifiers before sharing.

For support, report the version, task, run ID, visible error and last known step to your key user. Do not send passwords, certificate material, or production workbooks through an unapproved channel.
