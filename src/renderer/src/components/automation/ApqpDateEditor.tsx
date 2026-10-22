import { useEffect, useMemo, useRef, useState } from 'react'
import { APQP_DATE_CAPABILITIES, APQP_DATE_KEYS, APQP_DATE_LABELS, type ApqpDateCapabilities, type ApqpDateKey,
  type ApqpDateQuery, type ApqpDateSnapshot, type ApqpDates, type ApqpDateError, type ApqpQueryMismatch, type ApqpDateUpdateSummary, type ApqpSdComments } from '../../../../shared/apqp-date-types'
import { useLocalization } from '../../i18n/use-localization'
import type { Notify } from '../../types/notifications'
import { AutomationTaskToolbar } from './AutomationTaskToolbar'
import { NoticeConfirmationModal, PreviewSummary } from './AutomationPageLayout'
import { useAdaptiveEta } from '../../hooks/use-adaptive-eta'
import { prepareNotificationAudio } from '../../hooks/notification-sound'
import { AdaptiveEta } from './AdaptiveEta'
import { ApqpProjectInput } from './ApqpProjectInput'
import { readApqpProjects, rememberApqpProject, visibleApqpRecords, type ApqpRecordOrder } from './apqp-date-view'
import styles from '../../pages/ApqpDateManagement.module.css'

const PAGE_SIZE = 20
const rememberedUser = (): string => { try { return localStorage.getItem('apqp-last-business-user')?.slice(0, 32) ?? '' } catch { return '' } }

export function ApqpDateEditor({ notify, onBusyChange }: { notify: Notify; onBusyChange: (value: boolean) => void }): React.JSX.Element {
  const { language } = useLocalization(), zh = language === 'zh-CN'
  const t = (en: string, cn: string): string => zh ? cn : en
  const label = (key: ApqpDateKey): string => APQP_DATE_LABELS[key][zh ? 'zh' : 'en']
  const api = window.sapAutomation
  const [projects, setProjects] = useState(() => readApqpProjects())
  const [query, setQuery] = useState<ApqpDateQuery>(() => ({ project: projects[0], userId: rememberedUser(), environment: 'PROD' }))
  const [snapshot, setSnapshot] = useState<ApqpDateSnapshot | null>(null)
  const [edits, setEdits] = useState(new Map<string, ApqpDates>())
  const [comments, setComments] = useState(new Map<string, ApqpSdComments>())
  const [outcome, setOutcome] = useState<{ update: ApqpDateUpdateSummary; resultPath: string } | null>(null)
  const [stagedPending, setStagedPending] = useState(false)
  const [capabilities, setCapabilities] = useState<ApqpDateCapabilities>(APQP_DATE_CAPABILITIES)
  const [running, setRunning] = useState(false), [stopping, setStopping] = useState(false)
  const emptyProgress = { message: '', current: 0, total: 0, material: '', vendor: '', apqp: '', step: '' }
  const [progress, setProgress] = useState(emptyProgress)
  const [error, setError] = useState(''), [details, setDetails] = useState('')
  const [comparison, setComparison] = useState<ApqpQueryMismatch | null>(null)
  const [errorLog, setErrorLog] = useState('')
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState(''), [order, setOrder] = useState<ApqpRecordOrder>('original')
  const [notice, setNotice] = useState<{ title: string; message: string; details?: string } | null>(null)
  const [phase, setPhase] = useState<'query' | 'update'>('query')
  const timingId = phase === 'query' ? 'apqp-date-management' : 'apqp-date-update'
  const { eta, unavailable } = useAdaptiveEta(timingId, running)
  const inFlight = useRef(false)
  const activePhase = useRef<'query' | 'update'>('query')
  const editorSection = useRef<HTMLElement>(null), runPanel = useRef<HTMLElement>(null)

  useEffect(() => { onBusyChange(running || stagedPending) }, [running, stagedPending, onBusyChange])
  useEffect(() => { if (snapshot) editorSection.current?.scrollIntoView({ block: 'start' }) }, [snapshot])
  useEffect(() => {
    let active = true
    void api.getApqpDateCapabilities().then(value => { if (active && value) setCapabilities(value) }).catch(() => undefined)
    const stop = api.onApqpProgress(event => {
      if (inFlight.current) setProgress(previous => ({ message: event.message || previous.message, current: event.current ?? previous.current, total: event.total ?? previous.total,
        material: event.material ?? previous.material, vendor: event.vendor ?? previous.vendor, apqp: event.apqp ?? previous.apqp, step: event.step ?? previous.step }))
    })
    return () => { active = false; stop() }
  }, [api])

  const showError = (result: ApqpDateError): void => {
    const message = result.cancelled ? activePhase.current === 'update' ? t('Stopped. Review SAP and saved results before retrying; saved changes are not rolled back.', '已停止。重试前请核查 SAP 和结果，已保存的修改不会撤销。') : t('Read stopped. No SAP dates were changed.', '读取已停止，未修改 SAP 日期。') : zh && result.messageZh ? result.messageZh : result.message
    const diagnostic = [result.errorCode, result.details, result.logPath].filter(Boolean).join('\n')
    const title = result.cancelled ? t('Stopped safely', '已安全停止') : activePhase.current === 'update' ? t('APQP update could not finish', 'APQP 修改未完成') : t('APQP read could not finish', 'APQP 读取未完成')
    setError(message); setDetails(diagnostic); setNotice({ title, message, details: diagnostic })
    notify({ kind: result.cancelled ? 'warning' : 'error', title, message })
    setComparison(result.comparison ?? null)
    setErrorLog(result.logPath ?? '')
    if (result.writeMayHaveOccurred) { setSnapshot(null); setEdits(new Map()); setComments(new Map()) }
  }
  const openResult = (path: string): void => {
    void api.openAutomationArtifact(path).then(result => {
      if (!result.success) showError({ success: false, message: result.message ?? 'Could not open the local result.', messageZh: result.message ?? '无法打开本地结果文件。' })
    }).catch(reason => showError({ success: false, message: 'Could not open the local result.', messageZh: '无法打开本地结果文件。', details: String(reason) }))
  }
  const work = async (task: () => Promise<void>, action: 'query' | 'update' = 'query'): Promise<void> => {
    if (inFlight.current) return
    prepareNotificationAudio()
    inFlight.current = true; activePhase.current = action; setPhase(action); setRunning(true); setStopping(false); setError(''); setDetails(''); setComparison(null); setErrorLog(''); setNotice(null)
    setProgress({ ...emptyProgress, message: action === 'query' ? t('Reading SAP. No dates will be changed.', '正在读取 SAP，不会修改日期。') : t('Checking the edited dates before updating SAP.', '正在检查待修改日期。'), step: 'PREPARING' })
    window.dispatchEvent(new CustomEvent('guided-running', { detail: true }))
    runPanel.current?.scrollIntoView({ block: 'center' })
    try { await task() } catch (reason) { showError({ success: false, message: 'The request could not finish. Review details before trying again.', messageZh: '请求未能完成，请查看详情后再试。', details: String(reason) }) }
    finally { inFlight.current = false; setRunning(false); setStopping(false); window.dispatchEvent(new CustomEvent('guided-running', { detail: false })) }
  }
  const find = (): void => { void work(async () => {
    const remembered = rememberApqpProject(projects, query.project)
    setProjects(remembered)
    if (!stagedPending) { setSnapshot(null); setOutcome(null); setEdits(new Map()); setComments(new Map()); setPage(0) }
    const result = await api.queryApqpDates(query)
    if (!result.success) { showError(result); return }
    setStagedPending(false); setOutcome(null); setComments(new Map()); setPage(0); setSearch(''); setOrder('original')
    setSnapshot(result.snapshot)
    setEdits(new Map(result.snapshot.records.map(row => [row.apqp, { ...row.dates }])))
    try { localStorage.setItem('apqp-last-business-user', query.userId) } catch { /* No password is stored. */ }
    const message = t(`${result.snapshot.records.length} APQPs found. No SAP dates changed.`, `找到 ${result.snapshot.records.length} 条 APQP，未修改 SAP 日期。`)
    notify({ kind: result.snapshot.records.length ? 'success' : 'warning', title: t('APQP dates loaded', '已读取 APQP 日期'), message })
    if (!result.snapshot.records.length) setNotice({ title: t('No matching APQPs', '未找到匹配 APQP'), message: t('Check NPL and business User ID, then find again.', '请核对 NPL 和业务 User ID 后重新查询。') })
  }) }
  const execute = (): void => {
    if (!snapshot) return
    const request = { snapshotId: snapshot.id, edits: snapshot.records.map(row => {
      const dates = edits.get(row.apqp)!
      const sdComments = Object.fromEntries(Object.entries(comments.get(row.apqp) ?? {}).filter(([group, text]) => text.trim()
        && dates[group === 'g' ? 'gActualDate' : 'hActualDate'] !== row.dates[group === 'g' ? 'gActualDate' : 'hActualDate']))
      return { apqp: row.apqp, dates, ...(Object.keys(sdComments).length ? { sdComments } : {}) }
    }), confirmed: true as const }
    setOutcome(null)
    void work(async () => {
      const result = await api.executeApqpDateChanges(request)
      if (result.success) {
        if (result.update.stageOnly) {
          setOutcome({ update: result.update, resultPath: result.resultPath }); setStagedPending(true)
          notify({ kind: 'warning', title: t('Filled — NOT SAVED', '已填入，未保存'),
            message: t('One record was checked/filled. No Save was sent. Inspect SAP, then manually save or discard and return to the list.', '本次仅检查/填入 1 条，未发送 Save。请在 SAP 核对后手动保存或放弃，并返回列表。') })
          return
        }
        setSnapshot(result.snapshot)
        setEdits(new Map(result.snapshot.records.map(row => {
          const before = snapshot.records.find(item => item.apqp === row.apqp)!
          const desired = edits.get(row.apqp)!
          const processed = APQP_DATE_KEYS.every(key => desired[key] === before.dates[key] || desired[key] === row.dates[key])
          return [row.apqp, { ...(!result.update.cancelled || processed ? row.dates : desired) }]
        })))
        setOutcome({ update: result.update, resultPath: result.resultPath })
        setComments(current => new Map([...current].filter(([apqp]) => result.update.cancelled
          && result.snapshot.records.some(row => row.apqp === apqp && APQP_DATE_KEYS.some(key => edits.get(apqp)?.[key] !== row.dates[key])))))
        const title = result.update.cancelled ? t('Stopped safely', '已安全停止') : t('APQP dates updated', 'APQP 日期已修改')
        const message = t(`${result.update.succeeded} APQPs saved and verified; ${result.update.skipped} unchanged.`, `${result.update.succeeded} 条 APQP 已保存并复读验证；${result.update.skipped} 条无需修改。`)
        notify({ kind: result.update.cancelled ? 'warning' : 'success', title, message })
      }
      else showError(result)
    }, 'update')
  }
  const reset = (): void => {
    if (inFlight.current || stagedPending) return
    setQuery({ project: '', userId: '', environment: 'PROD' }); setSnapshot(null); setEdits(new Map()); setComments(new Map()); setOutcome(null)
    setError(''); setDetails(''); setComparison(null); setErrorLog(''); setProgress(emptyProgress); setPage(0); setNotice(null); setSearch(''); setOrder('original')
  }
  const criteria = (key: keyof ApqpDateQuery, value: string): void => {
    setQuery(current => ({ ...current, [key]: value })); setSnapshot(null); setOutcome(null); setEdits(new Map()); setComments(new Map()); setError(''); setDetails(''); setComparison(null); setErrorLog(''); setPage(0); setSearch(''); setOrder('original')
  }
  const changed = snapshot?.records.filter(row => APQP_DATE_KEYS.some(key => row.dates[key] !== edits.get(row.apqp)?.[key])).length ?? 0
  const validInput = /^[A-Za-z0-9_/-]{1,32}$/.test(query.project) && /^[A-Za-z0-9_/-]{1,32}$/.test(query.userId)
  const visible = useMemo(() => visibleApqpRecords(snapshot?.records ?? [], search, order), [snapshot, search, order])
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const hiddenEdits = changed - visible.filter(row => APQP_DATE_KEYS.some(key => row.dates[key] !== edits.get(row.apqp)?.[key])).length
  const steps: Record<string, string> = { PREPARING: t('Connecting / checking SAP', '连接及检查 SAP'), READING_DATES: t('Reading dates', '读取日期'), READ_COMPLETE: t('Dates read', '日期读取完成'),
    LOCATING_APQP: t('Locating edited APQP', '定位待修改 APQP'), STAGED_READY_NOT_SAVED: t('Filled — NOT SAVED', '已填入，未保存'),
    CHECKING_DATES: t('Checking current dates', '检查当前日期'), CURRENT_VALUES_VERIFIED: t('Current dates checked', '当前日期已核对'), SD_CONFIRM_INPUT_DISPATCHED: t('Selecting SD conf', '勾选 SD conf'), SD_COMMENT_INPUT_DISPATCHED: t('Entering SD Comment', '填写 SD Comment'), DATE_INPUT_DISPATCHED: t('Entering dates', '输入日期'), SAVE_DISPATCHED: t('Saving — do not repeat', '正在保存，请勿重复操作'), SAVE_CONFIRMATION_DISPATCHED: t('Confirming Save', '确认保存'),
    SAVE_ACKNOWLEDGED: t('Checking saved values', '核对保存结果'), UPDATE_VERIFIED: t('Saved and re-read', '已保存并复读验证'), SAVE_OUTCOME_UNCERTAIN: t('Review SAP before retrying', '请先核查 SAP，勿直接重试') }

  return <>
    <AutomationTaskToolbar status={running ? phase === 'query' ? t('Reading SAP', '正在读取 SAP') : t('Updating SAP', '正在修改 SAP') : snapshot ? t(`${snapshot.records.length} APQPs · ${changed} edited`, `${snapshot.records.length} 条 APQP · 已编辑 ${changed} 条`) : t('Find your APQPs', '查找你的 APQP')}
      hint={running ? t('Keep SAP open. Do not edit its working window.', '请保持 SAP 打开，期间不要操作其工作窗口。') : capabilities.stageOnly ? t('Test only: fill one record, leave its detail open, and never press Save.', '仅测试：每次填入一条，停在详情，不点击 Save。') : snapshot?.environment === 'PROD'
        ? t('Production · 949 — Update saves edited dates to SAP. Only changed fields are written; conflicts stop the update.', '正式系统 · 949 — 点击“修改”将真实保存已编辑日期。只写入变更字段，遇到冲突停止。')
        : t('Find → Edit dates → Update. SAP conflicts are checked automatically; no separate preview step.', '查找 → 编辑日期 → 点击修改。系统自动检查 SAP 冲突，无需单独预览。')}
      startLabel={stagedPending ? t('Filled — NOT SAVED', '已填入，未保存') : snapshot ? capabilities.stageOnly ? t(`Test fill ${Math.min(changed, 1)} APQP`, `测试填入 ${Math.min(changed, 1)} 条 APQP`) : t(`Update ${changed} ${changed === 1 ? 'APQP' : 'APQPs'}`, `修改 ${changed} 条 APQP`) : t('Find APQPs', '查找 APQP')}
      canRun={!stagedPending && (snapshot ? changed > 0 : validInput)} running={running} stopping={stopping} locked={running} canClear={!stagedPending && Boolean(query.project || query.userId || snapshot || error)}
      onStart={snapshot ? execute : find} onStop={() => { if (!stopping) { setStopping(true); void api.cancelApqp().then(result => { if (!result.success) setStopping(false) }).catch(() => setStopping(false)) } }} onClear={reset} />
    <div className={styles.queryGrid}>
    <section className={`card ${styles.section}`} aria-label={t('Find APQPs', '查找 APQP')}>
      <h3>{t('1. Find APQPs', '1. 查找 APQP')}</h3>
      <p className={styles.copy}>{t('Enter the project and business User ID. Query Plant is C100; shared Plant 0000 records are also valid. This is a read-only query.', '填写项目和业务 User ID，查询工厂固定为 C100；结果中的跨工厂记录 0000 同样有效。这一步只查询，不修改 SAP。')}</p>
      <div className={styles.fields}>
        <ApqpProjectInput value={query.project} projects={projects} disabled={running || stagedPending} onChange={value => criteria('project', value)} />
        <label className="field"><span>User ID *</span><input className="input" value={query.userId} maxLength={32} disabled={running || stagedPending} onChange={event => criteria('userId', event.target.value.trim().toUpperCase())} /></label>
        <label className="field"><span>{t('SAP environment', 'SAP 环境')}</span><select aria-label={t('SAP environment', 'SAP 环境')} className="select" value={query.environment} disabled={running || stagedPending} onChange={event => criteria('environment', event.target.value)}><option value="PROD">Production · 949</option><option value="QA">QA · 321</option></select></label>
      </div>
      <p className={styles.copy}>{t('User ID is the APQP business filter, not your SAP sign-in. Save your current SAP work first. The Hub reuses one window and opens ZMFM050035 automatically, even from another T-code. Sign-in or save/discard prompts need your attention; no new sessions are created.', 'User ID 是 APQP 业务筛选条件，不是 SAP 登录账号。请先保存当前 SAP 工作。Hub 复用原窗口，即使停在其他 T-code，也会自动进入 ZMFM050035；登录或保存/放弃提示需手动处理，不会新建会话。')}</p>
      {snapshot && <div className={styles.actions}><button className="button" disabled={running || !validInput} onClick={find}>{stagedPending ? t('SAP handled — Find again', '已在 SAP 处理，重新查询') : t('Find again', '重新查找')}</button><button className="button" disabled={running} onClick={() => openResult(snapshot.resultPath)}>{t('Open read result', '打开读取结果')}</button></div>}
    </section>
    <aside ref={runPanel} className={`card ${styles.section} ${styles.runPanel}`} aria-label={t('Run progress', '执行进度')}>
      <h3>{t('Run progress', '执行进度')}</h3>
      {running ? <AdaptiveEta eta={eta} unavailable={unavailable} automationId={timingId} total={progress.total} showFinishTime /> : <p className={styles.copy}>{t('ETA updates automatically while running.', '运行时自动估算剩余时间及完成时间。')}</p>}
      <dl className={styles.runFacts}><div><dt>{t('Current step', '当前步骤')}</dt><dd>{steps[progress.step] ?? (running ? t('Working', '正在处理') : t('Ready', '就绪'))}</dd></div>
        <div><dt>{t('Material', '物料')}</dt><dd>{progress.material || '—'}</dd></div><div><dt>APQP</dt><dd>{progress.apqp || '—'}</dd></div><div><dt>Supplier Parma</dt><dd>{progress.vendor || '—'}</dd></div></dl>
      <progress className={styles.progressBar} aria-label={t('APQP progress', 'APQP 进度')} max={progress.total || 1} value={progress.current} />
      <p className={styles.copy}>{progress.current} / {progress.total || '—'}</p>
      {progress.message && <p className={styles.progressMessage} role="status">{steps[progress.step] ?? progress.message}</p>}
    </aside></div>
    {error && <p className={`${styles.notice} ${styles.warning}`} role="alert">{error}</p>}
    {error && comparison && <section className={`card ${styles.section}`} aria-label={t('Query condition comparison', '查询条件对比')}>
      <h3>{t('Which value does not match?', '具体哪个值不一致？')}</h3>
      <p className={styles.copy}>{t(`${comparison.mismatchRows} of ${comparison.totalRows} SAP result rows do not match. Showing the first ${comparison.rows.length} mismatched rows below.`, `SAP 共返回 ${comparison.totalRows} 条，其中 ${comparison.mismatchRows} 条不一致；下表展示前 ${comparison.rows.length} 条不一致记录。`)}</p>
      <div className={`${styles.table} ${styles.compact}`}><table><thead><tr>
        <th>{t('SAP result row', 'SAP 结果行')}</th><th>APQP</th><th>{t('Material', '物料')}</th><th>{t('Field', '字段')}</th><th>{t('Expected', '预期值')}</th><th>{t('SAP actual', 'SAP 实际值')}</th><th>{t('Comparison', '对比')}</th>
      </tr></thead><tbody>{comparison.rows.flatMap(row => row.checks.map(check => <tr key={`${row.rowNumber}-${check.field}`} data-mismatch={!check.matches}>
        <td>{row.rowNumber}</td><td>{row.apqp || '—'}</td><td>{row.material || '—'}</td><td>{zh ? check.labelZh : check.label}</td><td>{check.expected || t('(blank)', '（空白）')}</td><td>{check.actual || t('(blank)', '（空白）')}</td><td>{check.matches ? t('Match', '一致') : t('Mismatch', '不一致')}</td>
      </tr>))}</tbody></table></div>
      <p className={styles.copy}>{t('Check the mismatched SAP record or query condition. The Hub will not change the Plant or bypass this check automatically.', '请核对不一致的 SAP 记录或查询条件，系统不会自动修改工厂或跳过校验。')}</p>
    </section>}
    {snapshot && <section ref={editorSection} className={`card ${styles.section}`} aria-label={t('Edit APQP dates', '编辑 APQP 日期')}>
      <h3>{t('2. Edit only the dates you need', '2. 只修改需要变更的日期')}</h3>
      <p className={styles.copy}>{t('Dates correspond to SAP RTS Action & Closure and Total PPAP. Blank does not mean clear: populated dates cannot be deleted here.', '日期对应 SAP 的 RTS Action & Closure 和 Total PPAP。空白不代表清除：这里不能通过删除已有日期来清空 SAP。')}</p>
      <p className={styles.copy}>{t('Changing an actual date automatically selects its matching SD conf and shows an optional SD Comment below that date. Blank keeps the SAP comment; new text replaces it. Planned-date-only edits do not change SD conf or comments.', '修改实际日期时，系统自动勾选对应 SD conf，日期下方会出现选填 SD Comment。留空保留 SAP 原备注，填写则替换。只改计划日期时，不改勾选或备注。')}</p>
      <div className={styles.tableControls}>
        <label className="field"><span>{t('Search APQPs', '搜索 APQP')}</span><input type="search" className="input" value={search} maxLength={100} disabled={running}
          placeholder={t('Material, Supplier Parma or APQP', '物料号、Supplier Parma 或 APQP 编号')} onChange={event => { setSearch(event.target.value); setPage(0) }} /></label>
        <label className="field"><span>{t('Sort by', '排序方式')}</span><select className="select" aria-label={t('Sort by', '排序方式')} value={order} disabled={running} onChange={event => { setOrder(event.target.value as ApqpRecordOrder); setPage(0) }}>
          <option value="original">{t('Original SAP order', 'SAP 原始顺序')}</option><option value="supplier-asc">{t('Supplier Parma: low to high', 'Supplier Parma：升序')}</option><option value="supplier-desc">{t('Supplier Parma: high to low', 'Supplier Parma：降序')}</option>
        </select></label>
      </div>
      <p className={styles.viewSummary} role="status">{t(`Showing ${visible.length} of ${snapshot.records.length} APQPs. Search and sorting change display only; all date edits are kept.`, `显示 ${visible.length} / ${snapshot.records.length} 条 APQP。搜索和排序仅改变显示，所有日期修改均保留。`)}
        {hiddenEdits > 0 && <strong>{t(` ${hiddenEdits} edited APQP(s) are hidden by this search. Execution still uses the original SAP order.`, ` 当前搜索隐藏了 ${hiddenEdits} 条已编辑记录；执行仍按 SAP 原始顺序处理。`)}</strong>}</p>
      <fieldset className={styles.editorFields} disabled={running || stagedPending}><div className={styles.table}><table><thead><tr><th>APQP</th><th>{t('Material', '物料')}</th><th>Supplier Parma</th>{APQP_DATE_KEYS.map(key => <th key={key}>{label(key)}</th>)}</tr></thead><tbody>
        {visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => <tr key={row.apqp}>
          <td>{row.apqp}</td><td>{row.material}</td><td>{row.vendor}</td>
          {APQP_DATE_KEYS.map(key => <td key={key} data-changed={row.dates[key] !== edits.get(row.apqp)?.[key]}>
            <input type="date" className="input" aria-label={`${row.apqp} ${label(key)}`} value={edits.get(row.apqp)?.[key] ?? ''} disabled={running || !row.readable}
              onChange={event => { const value = event.target.value || null; setEdits(current => new Map(current).set(row.apqp, { ...current.get(row.apqp)!, [key]: value })); setOutcome(null); setError('') }} />
            {key.endsWith('ActualDate') && row.dates[key] !== edits.get(row.apqp)?.[key] && <label className={styles.commentField}>
              <span>SD Comment {t('(optional)', '（选填）')}</span>
              <input type="text" className="input" aria-label={`${row.apqp} ${key === 'gActualDate' ? 'RTS' : 'Total PPAP'} SD Comment`}
                placeholder={t('Blank keeps SAP comment', '留空保留 SAP 原备注')} maxLength={255} value={comments.get(row.apqp)?.[key === 'gActualDate' ? 'g' : 'h'] ?? ''} disabled={running || !row.readable}
                onChange={event => { const value = event.target.value; setComments(current => new Map(current).set(row.apqp, { ...current.get(row.apqp), [key === 'gActualDate' ? 'g' : 'h']: value })); setOutcome(null) }} />
            </label>}
          </td>)}
        </tr>)}
      </tbody></table></div></fieldset>
      <div className={styles.pager}><button className="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('Previous', '上一页')}</button><span>{page + 1} / {pages}</span><button className="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{t('Next', '下一页')}</button></div>
      {!snapshot.records.length && <p>{t('No APQPs matched. Check NPL and User ID.', '未找到匹配 APQP，请检查 NPL 和 User ID。')}</p>}
      {snapshot.records.length > 0 && !visible.length && <p>{t('No APQPs match this search. Clear the search to show all records.', '没有匹配的 APQP，请清空搜索以显示全部记录。')}</p>}
    </section>}
    {outcome && <section className={`card ${styles.section}`} aria-label={t('Date update result', '日期修改结果')}>
      <h3>{outcome.update.stageOnly ? t('Test input — NOT SAVED', '测试填入 — 未保存') : t('Date update result', '日期修改结果')}</h3>
      {outcome.update.stageOnly && <p className={`${styles.notice} ${styles.warning}`}>{t('No Save was sent. Only the first edited record was checked/filled; remaining edits were not processed. Leave this page and SAP detail unchanged until you inspect the input. Manually save or discard in SAP, return to the list, then use SAP handled — Find again.', '未发送 Save。本次只检查/填入第一条待改记录，其余未处理。请先检查 SAP 详情中的输入，再手动保存或放弃、返回列表，之后点击“已在 SAP 处理，重新查询”。')}</p>}
      <PreviewSummary metrics={[{ label: t('Edited APQPs', '待改 APQP'), value: outcome.update.total }, ...(outcome.update.stageOnly ? [{ label: t('Filled — NOT SAVED', '已填入 — 未保存'), value: outcome.update.staged ?? 0 }] : []), { label: t('Saved and verified', '已保存并验证'), value: outcome.update.succeeded }, { label: t('Unchanged', '无需修改'), value: outcome.update.skipped }]} />
      <button className="button" onClick={() => openResult(outcome.resultPath)}>{t('Open update result', '打开修改结果')}</button>
    </section>}
    <p className={`${styles.notice} ${styles.warning}`} role="note">{zh ? capabilities.messageZh : capabilities.message}</p>
    {details && <details className={styles.details}><summary>{t('View Details', '查看详情')}</summary><pre>{details}</pre>{errorLog && <button className="button" disabled={running} onClick={() => openResult(errorLog)}>{t('Open diagnostic record', '打开诊断记录')}</button>}</details>}
    <NoticeConfirmationModal notice={notice} onClose={() => setNotice(null)} />
  </>
}
