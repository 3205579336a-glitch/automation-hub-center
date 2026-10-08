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
  const [advanced, setAdvanced] = useState(false)
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
    </section>
    <details className={`card ${styles.section}`} onToggle={event => setAdvanced(event.currentTarget.open)}>
      <summary>{zh ? '高级 / Key User 设置' : 'Advanced / Key User Settings'}</summary>
      {advanced && <><p>{zh ? '仅在公司环境需要调整时使用。普通操作不需要打开这里。' : 'Only for company-specific adjustments. Normal tasks do not require this area.'}</p>
        <div className={styles.fields}>
          <label className="field"><span>SAP WebGUI URL Template</span><input className="input" value={settings.sapWebGuiUrl} onChange={event => setSettings({ ...settings, sapWebGuiUrl: event.target.value })} /></label>
          <label className="field"><span>{zh ? '浏览器' : 'Browser'}</span><select className="select" value={settings.browser} onChange={event => setSettings({ ...settings, browser: event.target.value === 'msedge' ? 'msedge' : 'chrome' })}><option value="chrome">Google Chrome</option><option value="msedge">Microsoft Edge</option></select></label>
          <label className="field"><span>{zh ? '信息记录并发窗口' : 'Info Record worker windows'}</span><input className="input" type="number" min={1} max={8} value={settings.maxConcurrentBrowsers} onChange={event => setSettings({ ...settings, maxConcurrentBrowsers: Number(event.target.value) })} /></label>
          <label className="field"><span>{zh ? 'APQP 最大并发会话' : 'APQP maximum sessions'}</span><input className="input" type="number" min={1} max={5} value={settings.maxConcurrentSapSessions ?? 3} onChange={event => setSettings({ ...settings, maxConcurrentSapSessions: Number(event.target.value) })} /></label>
          <label className="field"><span>{zh ? '模板默认保存位置' : 'Default template download location'}</span><input className="input" value={settings.defaultDownloadFolder} onChange={event => setSettings({ ...settings, defaultDownloadFolder: event.target.value })} /></label>
        </div>
        <button className="button" onClick={() => void window.sapAutomation.openSapWebGui()}>{zh ? '检查浏览器连接' : 'Check browser connection'}</button>
        <DiagnosticsPanel notify={notify} />
      </>}
    </details></div>
  </div>
}
