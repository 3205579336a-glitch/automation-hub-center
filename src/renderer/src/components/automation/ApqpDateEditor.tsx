import { useEffect, useMemo, useRef, useState } from 'react'
import { APQP_DATE_KEYS, APQP_DATE_LABELS, type ApqpDateKey,
  type ApqpDateQuery, type ApqpDateSnapshot, type ApqpDates, type ApqpDateError, type ApqpQueryMismatch, type ApqpDateUpdateSummary } from '../../../../shared/apqp-date-types'
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
  const [outcome, setOutcome] = useState<{ update: ApqpDateUpdateSummary; resultPath: string } | null>(null)
  const [stagedPending, setStagedPending] = useState(false)
  const [needsSapReview, setNeedsSapReview] = useState(false), [cacheLoading, setCacheLoading] = useState(false)
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
    const stop = api.onApqpProgress(event => {
      if (inFlight.current) setProgress(previous => ({ message: event.message || previous.message, current: event.current ?? previous.current, total: event.total ?? previous.total,
        material: event.material ?? previous.material, vendor: event.vendor ?? previous.vendor, apqp: event.apqp ?? previous.apqp, step: event.step ?? previous.step }))
    })
    return () => stop()
  }, [api])

  const showError = (result: ApqpDateError): void => {
    const message = result.cancelled ? activePhase.current === 'update' ? t('Stopped. Review SAP and saved results before retrying; saved changes are not rolled back.', '已停止。重试前请核查 SAP 和结果，已保存的修改不会撤销。') : t('Read stopped. No SAP dates were changed.', '读取已停止，未修改 SAP 日期。') : zh && result.messageZh ? result.messageZh : result.message
    const diagnostic = [result.errorCode, result.details, result.logPath].filter(Boolean).join('\n')
    const title = result.cancelled ? t('Stopped safely', '已安全停止') : activePhase.current === 'update' ? t('APQP update could not finish', 'APQP 修改未完成') : t('APQP read could not finish', 'APQP 读取未完成')
    setError(message); setDetails(diagnostic); setNotice({ title, message, details: diagnostic })
    notify({ kind: result.cancelled ? 'warning' : 'error', title, message })
    setComparison(result.comparison ?? null)
    setErrorLog(result.logPath ?? '')
    // Preserve local drafts for untouched rows, but never reuse the invalidated
    // execution token. Manual SAP handling + cache reload/full read is required.
    if (result.writeMayHaveOccurred) { setNeedsSapReview(true); setStagedPending(true) }
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
    if (!stagedPending) { setSnapshot(null); setOutcome(null); setEdits(new Map()); setPage(0) }
    const result = await api.queryApqpDates(query)
    if (!result.success) { showError(result); return }
    setStagedPending(false); setNeedsSapReview(false); setOutcome(null); setPage(0); setSearch(''); setOrder('original')
    setSnapshot(result.snapshot)
    setEdits(new Map(result.snapshot.records.map(row => [row.apqp, { ...row.dates }])))
    try { localStorage.setItem('apqp-last-business-user', query.userId) } catch { /* No password is stored. */ }
    const message = t(`${result.snapshot.records.length} APQPs found. No SAP dates changed.`, `找到 ${result.snapshot.records.length} 条 APQP，未修改 SAP 日期。`)
    notify({ kind: result.snapshot.records.length ? 'success' : 'warning', title: t('APQP dates loaded', '已读取 APQP 日期'), message })
    if (!result.snapshot.records.length) setNotice({ title: t('No matching APQPs', '未找到匹配 APQP'), message: t('Check NPL and business User ID, then find again.', '请核对 NPL 和业务 User ID 后重新查询。') })
  }) }
  const loadCached = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setCacheLoading(true)
    try {
      const result = await api.loadCachedApqpDates(query)
      if (!result.success) {
        notify({ kind: 'warning', title: t('No cached result', '暂无缓存结果'), message: zh && result.messageZh ? result.messageZh : result.message })
        return
      }
      const sameRead = snapshot?.resultPath === result.snapshot.resultPath
      const processed = stagedPending ? progress.apqp : ''
      setSnapshot(result.snapshot)
      // Keep other pending edits. The explicitly handled, staged row is reset
      // to historical read values, not falsely relabelled as saved/current.
      setEdits(new Map(result.snapshot.records.map(row => [row.apqp,
        { ...(sameRead && row.apqp !== processed ? edits.get(row.apqp) ?? row.dates : row.dates) }])))
      setStagedPending(false); setOutcome(null); setPage(0); setError(''); setDetails(''); setComparison(null); setErrorLog(''); setNotice(null)
      setNeedsSapReview(current => current || Boolean(result.snapshot.lastAttempt))
      notify({ kind: 'warning', title: t('Previous results loaded', '已载入上次结果'),
        message: t('For the latest dates, choose Refresh from SAP.', '如需最新日期，请点击“重新查询 SAP”。') })
    } catch {
      notify({ kind: 'warning', title: t('Local result unavailable', '本地结果不可用'), message: t('Read from SAP again.', '请从 SAP 重新读取。') })
    } finally { inFlight.current = false; setCacheLoading(false) }
  }
  const execute = (): void => {
    if (!snapshot) return
    const request = { snapshotId: snapshot.id, edits: snapshot.records.map(row => ({ apqp: row.apqp, dates: edits.get(row.apqp)! })), confirmed: true as const }
    setOutcome(null)
    void work(async () => {
      const result = await api.executeApqpDateChanges(request)
      if (result.success) {
        if (result.update.stageOnly) {
          const filled = (result.update.staged ?? 0) > 0, failures = result.update.failed ?? 0
          setOutcome({ update: result.update, resultPath: result.resultPath }); setStagedPending(filled); setNeedsSapReview(current => current || filled)
          const message = t(`${failures} record issue(s) safely skipped; ${result.update.staged ?? 0} APQP filled, NOT SAVED. ${filled ? 'Inspect SAP and manually save or discard before another test.' : 'No inputs were left staged. Review the listed reasons.'}`,
            `安全跳过 ${failures} 条问题记录，填入 ${result.update.staged ?? 0} 条，未保存。${filled ? '请先在 SAP 核对并手动保存或放弃，再测试下一条。' : '未留下待保存输入，请查看下方原因。'}`)
          notify({ kind: 'warning', title: filled ? t('Filled — NOT SAVED', '已填入，未保存') : t('Input test finished', '试填检查完成'), message })
          if (failures) setNotice({ title: t('Some records were skipped', '部分记录已跳过'), message })
          return
        }
        setSnapshot(result.snapshot)
        setEdits(new Map(result.snapshot.records.map(row => {
          const before = snapshot.records.find(item => item.apqp === row.apqp)!
          const desired = edits.get(row.apqp)!
          const processed = APQP_DATE_KEYS.every(key => desired[key] === before.dates[key] || desired[key] === row.dates[key])
          return [row.apqp, { ...(processed ? row.dates : desired) }]
        })))
        setOutcome({ update: result.update, resultPath: result.resultPath })
        const failures = result.update.failed ?? 0
        const title = result.update.cancelled ? t('Stopped safely', '已安全停止') : failures ? t('Some records were skipped', '部分记录已跳过') : t('APQP dates updated', 'APQP 日期已修改')
        const message = t(`${result.update.succeeded} APQPs saved, ${result.update.savedFields ?? 0} dates updated; ${failures} records skipped.`, `成功保存 ${result.update.succeeded} 条 APQP，更新 ${result.update.savedFields ?? 0} 个日期；跳过 ${failures} 条。`)
        notify({ kind: result.update.cancelled || failures ? 'warning' : 'success', title, message })
        if (failures) setNotice({ title, message })
      }
      else showError(result)
    }, 'update')
  }
  const reset = (): void => {
    if (inFlight.current) return
    setStagedPending(false)
    setSnapshot(null); setEdits(new Map()); setOutcome(null)
    setError(''); setDetails(''); setComparison(null); setErrorLog(''); setProgress(emptyProgress); setPage(0); setNotice(null); setSearch(''); setOrder('original')
  }
  const criteria = (key: keyof ApqpDateQuery, value: string): void => {
    setQuery(current => ({ ...current, [key]: value })); setSnapshot(null); setOutcome(null); setEdits(new Map()); setError(''); setDetails(''); setComparison(null); setErrorLog(''); setPage(0); setSearch(''); setOrder('original')
  }
  const changed = snapshot?.records.filter(row => APQP_DATE_KEYS.some(key => row.dates[key] !== edits.get(row.apqp)?.[key])).length ?? 0
  const validInput = /^[A-Za-z0-9_/-]{1,32}$/.test(query.project) && /^[A-Za-z0-9_/-]{1,32}$/.test(query.userId)
  const visible = useMemo(() => visibleApqpRecords(snapshot?.records ?? [], search, order), [snapshot, search, order])
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const hiddenEdits = changed - visible.filter(row => APQP_DATE_KEYS.some(key => row.dates[key] !== edits.get(row.apqp)?.[key])).length
  const steps: Record<string, string> = { PREPARING: t('Connecting / checking SAP', '连接及检查 SAP'), READING_DATES: t('Reading dates', '读取日期'), READ_COMPLETE: t('Dates read', '日期读取完成'),
    LOCATING_APQP: t('Finding the record', '正在查找记录'), NAVIGATING_APQP: t('Opening APQP', '正在打开 APQP'), STAGED_READY_NOT_SAVED: t('Not saved', '未保存'), RECORD_SKIPPED_BEFORE_INPUT: t('Skipped; continuing', '已跳过，继续下一条'),
    CHECKING_DATES: t('Checking current dates', '检查当前日期'), CURRENT_VALUES_VERIFIED: t('Current dates checked', '当前日期已核对'), SD_CONFIRM_INPUT_DISPATCHED: t('Selecting SD conf', '勾选 SD conf'), SD_COMMENT_INPUT_DISPATCHED: t('Entering SD Comment', '填写 SD Comment'), DATE_INPUT_DISPATCHED: t('Entering dates', '输入日期'), SAVE_DISPATCHED: t('Saving — do not repeat', '正在保存，请勿重复操作'), SAVE_CONFIRMATION_DISPATCHED: t('Confirming Save', '确认保存'),
    SAVE_ACKNOWLEDGED: t('Checking the result', '正在确认结果'), UPDATE_VERIFIED: t('Saved', '保存完成'), SAVE_OUTCOME_UNCERTAIN: t('Check SAP before trying again', '请先检查 SAP，不要重复运行') }

  return <>
    <AutomationTaskToolbar status={running ? phase === 'query' ? t('Reading SAP', '正在读取 SAP') : t('Updating SAP', '正在修改 SAP') : snapshot ? t(`${snapshot.records.length} APQPs · ${changed} edited`, `${snapshot.records.length} 条 APQP · 已编辑 ${changed} 条`) : t('Find your APQPs', '查找你的 APQP')}
      hint={running ? t('Keep SAP open. Do not use the window being automated.', '请保持 SAP 打开，不要操作正在执行任务的窗口。') : t('Find APQPs, edit the dates, then save.', '查找 APQP，修改日期，然后保存。')}
      startLabel={stagedPending ? t('Check SAP first', '请先检查 SAP') : snapshot ? t(`Save dates (${changed})`, `保存 ${changed} 条修改`) : t('Find APQPs', '查找 APQP')}
      canRun={!cacheLoading && !stagedPending && (snapshot ? changed > 0 : validInput)} running={running} stopping={stopping} locked={running || cacheLoading} canClear={Boolean(query.project || query.userId || snapshot || error || stagedPending)}
      clearWarning={needsSapReview ? t('Handle the unsaved work in SAP first. Clearing this page does not save or discard SAP changes.', '请先到 SAP 处理上次未保存的内容。清空本页不会保存或放弃 SAP 中的修改。') : undefined}
      onStart={snapshot ? execute : find} onStop={() => { if (!stopping) { setStopping(true); void api.cancelApqp().then(result => { if (!result.success) setStopping(false) }).catch(() => setStopping(false)) } }} onClear={reset} />
    <div className={styles.queryGrid}>
    <section className={`card ${styles.section}`} aria-label={t('Find APQPs', '查找 APQP')}>
      <h3>{t('1. Find APQPs', '1. 查找 APQP')}</h3>
      <p className={styles.copy}>{t('Enter the project and responsible User ID. Uses SAP 949, Plant C100.', '填写项目编号和负责人的 User ID。系统固定使用 SAP 949，工厂 C100。')}</p>
      <div className={styles.fields}>
        <ApqpProjectInput value={query.project} projects={projects} disabled={running || cacheLoading || stagedPending} onChange={value => criteria('project', value)} />
        <label className="field"><span>User ID *</span><input className="input" value={query.userId} maxLength={32} disabled={running || cacheLoading || stagedPending} onChange={event => criteria('userId', event.target.value.trim().toUpperCase())} /></label>
      </div>
      <p className={styles.copy}>{t('Save any unfinished SAP work before starting. If SAP asks you to sign in or handle a message, follow its prompt.', '开始前请保存 SAP 中未完成的工作。如 SAP 要求登录或确认消息，请先按提示处理。')}</p>
      <div className={styles.actions}>
        <button className="button" disabled={running || cacheLoading || !validInput || changed > 0 && !stagedPending} onClick={() => { void loadCached() }}>{cacheLoading ? t('Loading…', '正在载入…') : t('Use previous results', '使用上次结果')}</button>
        {snapshot && <button className="button" disabled={running || cacheLoading || !validInput} onClick={find}>{t('Refresh from SAP', '重新查询 SAP')}</button>}
      </div>
      {snapshot?.cached && <p className={`${styles.notice} ${styles.warning}`} role="note">{t(`Results from ${new Date(snapshot.createdAt).toLocaleString()}. For the latest dates, refresh from SAP.`, `这是 ${new Date(snapshot.createdAt).toLocaleString()} 的查询结果。如需最新日期，请重新查询 SAP。`)}</p>}
      {needsSapReview && <p className={`${styles.notice} ${styles.warning}`} role="status">{t('SAP may contain unsaved changes. Check them in SAP before continuing.', 'SAP 中可能有未保存的修改。请先到 SAP 检查后再继续。')}</p>}
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
      <p className={styles.copy}>{t('Edit the dates below, then save using the button above. Grey dates cannot be changed. Leaving a date blank does not delete it from SAP.', '在下表修改日期，然后点击上方“保存”。灰色日期不可修改，留空不会删除 SAP 中的原日期。')}</p>
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
          <td>{row.apqp}{snapshot.lastAttempt?.apqp === row.apqp && <small className={styles.rowState}>{snapshot.lastAttempt.status === 'STAGED' ? t('Last input: save unconfirmed', '上次已填入，保存未确认') : t('Last attempt needs review', '上次未完成，请核查')}</small>}</td><td>{row.material}</td><td>{row.vendor}</td>
          {APQP_DATE_KEYS.map(key => <td key={key} data-changed={row.dates[key] !== edits.get(row.apqp)?.[key]}>
            <input type="date" className="input" aria-label={`${row.apqp} ${label(key)}`} value={edits.get(row.apqp)?.[key] ?? ''} disabled={running || !row.readable || !row.editable[key]}
              onChange={event => { const value = event.target.value || null; setEdits(current => new Map(current).set(row.apqp, { ...current.get(row.apqp)!, [key]: value })); setOutcome(null); setError('') }} />
            {!row.editable[key] && <small className={styles.rowState}>{t('Cannot be changed in SAP', 'SAP 不允许修改')}</small>}
          </td>)}
        </tr>)}
      </tbody></table></div></fieldset>
      <div className={styles.pager}><button className="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('Previous', '上一页')}</button><span>{page + 1} / {pages}</span><button className="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{t('Next', '下一页')}</button></div>
      {!snapshot.records.length && <p>{t('No APQPs matched. Check NPL and User ID.', '未找到匹配 APQP，请检查 NPL 和 User ID。')}</p>}
      {snapshot.records.length > 0 && !visible.length && <p>{t('No APQPs match this search. Clear the search to show all records.', '没有匹配的 APQP，请清空搜索以显示全部记录。')}</p>}
    </section>}
    {outcome && <section className={`card ${styles.section}`} aria-label={t('Date update result', '日期修改结果')}>
      <h3>{t('Date update result', '日期修改结果')}</h3>
      {outcome.update.stageOnly && <p className={`${styles.notice} ${styles.warning}`}>{t(`No Save was sent. Checked ${outcome.update.processed}/${outcome.update.total}; safely skipped ${outcome.update.failed ?? 0} record issue(s), filled ${outcome.update.staged ?? 0}. Stop after the first filled detail; manually handle it in SAP before testing another record.`, `未发送 Save。已检查 ${outcome.update.processed}/${outcome.update.total}，安全跳过 ${outcome.update.failed ?? 0} 条问题记录，填入 ${outcome.update.staged ?? 0} 条。成功填入一条后即停止，请先手动处理 SAP 详情再测试下一条。`)}</p>}
      <PreviewSummary metrics={[{ label: t('APQPs', 'APQP 数量'), value: outcome.update.total }, { label: t('Skipped', '已跳过'), value: outcome.update.failed ?? 0 }, { label: t('Saved', '保存成功'), value: outcome.update.succeeded }, { label: t('Date fields saved', '已保存日期字段'), value: outcome.update.savedFields ?? 0 }, { label: t('Unchanged', '无需修改'), value: outcome.update.skipped }]} />
      {Boolean(outcome.update.issues?.length) && <div className={`${styles.table} ${styles.compact}`} role="region" aria-label={t('Skipped record reasons', '跳过原因')}><table><thead><tr><th>APQP</th><th>{t('Material', '物料')}</th><th>Supplier Parma</th><th>{t('Reason — no input / Save', '原因（未输入、未保存）')}</th></tr></thead><tbody>
        {outcome.update.issues!.map(item => <tr key={item.apqp}><td>{item.apqp}</td><td>{item.material}</td><td>{item.vendor}</td><td style={{ whiteSpace: 'normal' }}>{item.code === 'APQP_DATE_READ_ONLY' ? t('SAP does not allow this date to be changed.', 'SAP 不允许修改此日期，请保留原日期。') : zh ? item.messageZh : item.message}</td></tr>)}
      </tbody></table></div>}
      <button className="button" onClick={() => openResult(outcome.resultPath)}>{t('Open update result', '打开修改结果')}</button>
    </section>}
    {details && <details className={styles.details}><summary>{t('View Details', '查看详情')}</summary><pre>{details}</pre>{errorLog && <button className="button" disabled={running} onClick={() => openResult(errorLog)}>{t('Open diagnostic record', '打开诊断记录')}</button>}</details>}
    <NoticeConfirmationModal notice={notice} onClose={() => setNotice(null)} />
  </>
}
