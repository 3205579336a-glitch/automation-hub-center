import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import type { AppSettings } from '../../../shared/settings-types'
import { DiagnosticsPanel } from '../components/settings/DiagnosticsPanel'
import { useLocalization } from '../i18n/use-localization'
import { setNotificationSoundsEnabled } from '../hooks/notification-sound'
import type { Notify } from '../types/notifications'
import styles from '../components/automation/GuidedAutomation.module.css'

const defaults: AppSettings = { sapWebGuiUrl: '', browser: 'chrome', headless: false, defaultDownloadFolder: '',
  batchStartRow: 2, batchSize: 100, maxConcurrentBrowsers: 1, language: 'en', fontSize: 'medium', theme: 'light',
  notificationSounds: true, openResultAfterCompletion: false }

export function SettingsPage({ notify, onPreferencesSaved }: {
  notify: Notify; onPreferencesSaved: (preferences: Pick<AppSettings, 'language' | 'fontSize' | 'theme'>) => void
}): React.JSX.Element {
  const { language, t } = useLocalization()
  const zh = language === 'zh-CN'
  const [settings, setSettings] = useState<AppSettings>(defaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  useEffect(() => {
    let active = true
    void window.sapAutomation.getSettings().then(stored => { if (active) setSettings(stored) })
      .catch(() => notify({ kind: 'error', title: zh ? '无法读取设置' : 'Settings unavailable', message: zh ? '请重启应用后重试。' : 'Restart the app and try again.' }))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify])
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const response = await window.sapAutomation.saveSettings(settings)
      if (!response.success) throw new Error(response.message)
      setSettings(response.settings)
      setNotificationSoundsEnabled(response.settings.notificationSounds !== false)
      onPreferencesSaved({ language: response.settings.language, theme: response.settings.theme, fontSize: response.settings.fontSize })
      notify({ kind: 'success', title: t('settingsSaved'), message: t('settingsSavedCopy') })
    } catch { notify({ kind: 'error', title: zh ? '未能保存' : 'Could not save', message: zh ? '请检查设置后重试。' : 'Check the settings and try again.' }) }
    finally { setSaving(false) }
  }
  return <div className="page">
    <div className="page-heading"><div><h2>{t('applicationSettings')}</h2><p>{zh ? '按自己的习惯调整显示和提醒，无需配置自动化。' : 'Adjust appearance and reminders. No automation setup is needed.'}</p></div>
      <button className="button primary" disabled={loading || saving} onClick={() => void save()}><Save size={14} />{saving ? zh ? '保存中…' : 'Saving…' : t('saveSettings')}</button></div>
    <div className={styles.workflow}><section className={`card ${styles.section}`}>
      <h3>{zh ? '显示与提醒' : 'Appearance & reminders'}</h3>
      <div className={styles.fields}>
        <label className="field"><span>{zh ? '语言' : 'Language'}</span><select className="select" aria-label={zh ? '语言' : 'Language'} disabled={loading} value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value === 'zh-CN' ? 'zh-CN' : 'en' })}><option value="en">English</option><option value="zh-CN">中文（简体）</option></select></label>
        <label className="field"><span>{zh ? '主题' : 'Theme'}</span><select className="select" aria-label={zh ? '主题' : 'Theme'} disabled={loading} value={settings.theme} onChange={event => setSettings({ ...settings, theme: event.target.value === 'dark' ? 'dark' : 'light' })}><option value="light">{zh ? '白天' : 'Light'}</option><option value="dark">{zh ? '黑暗' : 'Dark'}</option></select></label>
        <label className="field"><span>{zh ? '字体大小' : 'Text Size'}</span><select className="select" aria-label={zh ? '字体大小' : 'Text Size'} disabled={loading} value={settings.fontSize} onChange={event => setSettings({ ...settings, fontSize: event.target.value === 'small' ? 'small' : event.target.value === 'large' ? 'large' : 'medium' })}><option value="small">{zh ? '小' : 'Small'}</option><option value="medium">{zh ? '中' : 'Medium'}</option><option value="large">{zh ? '大' : 'Large'}</option></select></label>
      </div>
      <label><input type="checkbox" disabled={loading} checked={settings.notificationSounds !== false} onChange={event => setSettings({ ...settings, notificationSounds: event.target.checked })} /> {zh ? '提示音' : 'Notification Sounds'}</label>
      <label><input type="checkbox" disabled={loading} checked={settings.openResultAfterCompletion === true} onChange={event => setSettings({ ...settings, openResultAfterCompletion: event.target.checked })} /> {zh ? '完成后自动打开结果（信息记录、APQP、货源清单）' : 'Open Result After Completion (Info Record, APQP, Source List)'}</label>
      <p>{zh ? '所有数据与日志保存在本机，不收集 SAP 密码或证书。' : 'Data and logs stay on this computer. SAP passwords and certificates are not collected.'}</p>
      <p>{zh ? '备份、截图和独立结果统一保存在本地 logs 目录，已结束任务的生成文件60天后自动清理。原 Excel 和未核查的 RFQ 不删除；重要结果请另存。' : 'Backups, screenshots and separate results stay under local logs. Finished generated files expire after 60 days. Original Excel and unresolved RFQ evidence are kept; export important results.'}</p>
    </section>
    <details className={`card ${styles.section}`} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)}>
      <summary>{zh ? '支持与日志' : 'Support & logs'}</summary>
      {diagnosticsOpen && <DiagnosticsPanel notify={notify} />}
    </details></div>
  </div>
}
