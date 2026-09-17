import { AlertTriangle, FolderOpen, Info, Monitor, Rows3, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/settings-types'
import { DiagnosticsPanel } from '../components/settings/DiagnosticsPanel'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './SettingsPage.module.css'

interface SettingsPageProps {
  notify: Notify
  onPreferencesSaved: (preferences: Pick<AppSettings, 'language' | 'fontSize' | 'theme'>) => void
}

const loadingDefaults: AppSettings = {
  sapWebGuiUrl: '',
  browser: 'chrome',
  headless: false,
  defaultDownloadFolder: '',
  batchStartRow: 2,
  batchSize: 100,
  maxConcurrentBrowsers: 1,
  language: 'en',
  fontSize: 'medium',
  theme: 'light'
}

export function SettingsPage({
  notify,
  onPreferencesSaved
}: SettingsPageProps): React.JSX.Element {
  const { t } = useLocalization()
  const [settings, setSettings] = useState<AppSettings>(loadingDefaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    window.sapAutomation
      .getSettings()
      .then((storedSettings) => {
        if (mounted) {
          setSettings(storedSettings)
          setLoading(false)
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setLoading(false)
          notify({
            kind: 'error',
            title: 'Settings unavailable',
            message: error instanceof Error ? error.message : 'Local settings could not be loaded.'
          })
        }
      })
    return () => {
      mounted = false
    }
  }, [notify])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.sapAutomation.saveSettings(settings)
      if (result.success) {
        setSettings(result.settings)
        onPreferencesSaved({
          language: result.settings.language,
          fontSize: result.settings.fontSize,
          theme: result.settings.theme
        })
        notify({ kind: 'success', title: t('settingsSaved'), message: t('settingsSavedCopy') })
      } else {
        notify({ kind: 'error', title: 'Settings not saved', message: result.message })
      }
    } catch (error) {
      notify({
        kind: 'error',
        title: 'Settings not saved',
        message: error instanceof Error ? error.message : 'The main process did not respond.'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <div><h2>{t('applicationSettings')}</h2><p>{t('applicationSettingsCopy')}</p></div>
        <button className="button primary" onClick={() => void save()} disabled={loading || saving}>
          <Save size={13} /> {saving ? 'Saving…' : t('saveSettings')}
        </button>
      </div>

      <div className={styles.layout}>
        <div className={styles.settingsColumn}>
          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div className={styles.icon}><Monitor size={18} /></div>
              <div><h3 className="section-title">{t('sapBrowser')}</h3><p className="section-copy">Connection target and installed browser used for automation</p></div>
            </div>
            <div className={styles.form}>
              <div className="field">
                <label>SAP WebGUI URL Template <span>*</span></label>
                <input
                  className="input"
                  value={settings.sapWebGuiUrl}
                  onChange={(event) => setSettings({ ...settings, sapWebGuiUrl: event.target.value })}
                  placeholder="https://ui5ce.volvo.com/sap/bc/gui/sap/its/webgui?~transaction={tcode}#"
                  disabled={loading}
                />
                <small>Use {'{tcode}'} as the transaction placeholder. Open SAP currently resolves it to SMEN.</small>
              </div>
              <div className={styles.twoColumns}>
                <div className="field">
                  <label>Browser</label>
                  <select
                    className="select"
                    value={settings.browser}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        browser: event.target.value === 'msedge' ? 'msedge' : 'chrome'
                      })
                    }
                    disabled={loading}
                  >
                    <option value="chrome">Google Chrome (Default)</option>
                    <option value="msedge">Microsoft Edge</option>
                  </select>
                </div>
                <div className={styles.toggleField}>
                  <div><strong>Headless mode</strong><span>Keep the browser visible during automation</span></div>
                  <button className={styles.toggle} disabled aria-label="Headless mode is off"><i /></button>
                </div>
              </div>
              <div className={styles.certificateNotice} role="note">
                <AlertTriangle size={20} />
                <div>
                  <strong>Action required in browser / 需要在浏览器中确认</strong>
                  <span>After the browser opens, select your Windows certificate and click OK. Automation waits for SAP sign-in before continuing. / 浏览器打开后，请选择 Windows 证书并点击“确定”；自动化会等待 SAP 登录完成后再继续。</span>
                </div>
              </div>
            </div>
          </section>

          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div className={styles.icon}><Monitor size={18} /></div>
              <div><h3 className="section-title">{t('appearance')} / 外观</h3><p className="section-copy">Language and text size / 语言和字体大小</p></div>
            </div>
            <div className={styles.form}>
              <div className={styles.threeColumns}>
                <div className="field">
                  <label>{t('language')} / 语言</label>
                  <select
                    className="select"
                    value={settings.language}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        language: event.target.value === 'zh-CN' ? 'zh-CN' : 'en'
                      })
                    }
                    disabled={loading}
                  >
                    <option value="en">English</option>
                    <option value="zh-CN">中文（简体）</option>
                  </select>
                </div>
                <div className="field">
                  <label>Theme / 主题</label>
                  <select
                    className="select"
                    value={settings.theme}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        theme: event.target.value === 'dark' ? 'dark' : 'light'
                      })
                    }
                    disabled={loading}
                  >
                    <option value="light">Light / 白天</option>
                    <option value="dark">Dark / 黑暗</option>
                  </select>
                </div>
                <div className="field">
                  <label>{t('fontSize')} / 字体大小</label>
                  <select
                    className="select"
                    value={settings.fontSize}
                    onChange={(event) => {
                      const value = event.target.value
                      setSettings({
                        ...settings,
                        fontSize:
                          value === 'small' || value === 'large' ? value : 'medium'
                      })
                    }}
                    disabled={loading}
                  >
                    <option value="small">{t('small')} / 小</option>
                    <option value="medium">{t('medium')} / 中</option>
                    <option value="large">{t('large')} / 大</option>
                  </select>
                </div>
              </div>
              <small>Changes apply after Save Settings / 保存设置后立即生效</small>
            </div>
          </section>

          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div className={styles.icon}><Rows3 size={18} /></div>
              <div><h3 className="section-title">{t('batchExecution')}</h3><p className="section-copy">Row range and browser capacity for future batch operations</p></div>
            </div>
            <div className={styles.form}>
              <div className={styles.batchGrid}>
                <div className="field">
                  <label>{t('startRow')} <span>*</span></label>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="1000000"
                    value={settings.batchStartRow}
                    onChange={(event) =>
                      setSettings({ ...settings, batchStartRow: Number(event.target.value) })
                    }
                    disabled={loading}
                  />
                  <small>First worksheet row to read.</small>
                </div>
                <div className="field">
                  <label>{t('rowsPerBatch')} <span>*</span></label>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="10000"
                    value={settings.batchSize}
                    onChange={(event) =>
                      setSettings({ ...settings, batchSize: Number(event.target.value) })
                    }
                    disabled={loading}
                  />
                  <small>Maximum rows loaded in one batch.</small>
                </div>
                <div className="field">
                  <label>{t('maxBrowsers')} <span>*</span></label>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="8"
                    value={settings.maxConcurrentBrowsers}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        maxConcurrentBrowsers: Number(event.target.value)
                      })
                    }
                    disabled={loading}
                  />
                  <small>Allowed range: 1–8 dedicated browser profiles.</small>
                </div>
              </div>
            </div>
          </section>

          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div className={styles.icon}><FolderOpen size={18} /></div>
              <div><h3 className="section-title">{t('filesDownloads')}</h3><p className="section-copy">Local path for future automation downloads</p></div>
            </div>
            <div className={styles.form}>
              <div className="field">
                <label>Default Download Folder <span>*</span></label>
                <input
                  className="input"
                  value={settings.defaultDownloadFolder}
                  onChange={(event) => setSettings({ ...settings, defaultDownloadFolder: event.target.value })}
                  placeholder="C:\Users\YourName\Downloads"
                  disabled={loading}
                />
                <small>Enter an existing folder path. Folder browsing will be added later.</small>
              </div>
            </div>
          </section>

          <DiagnosticsPanel notify={notify} />
        </div>

        <aside className={styles.infoColumn}>
          <section className={styles.securityCard}>
            <ShieldCheck size={22} />
            <h3>Local-first security</h3>
            <p>Settings are stored as a local JSON file in Electron’s application data directory.</p>
            <ul>
              <li>No SAP usernames or passwords</li>
              <li>No cloud database or web server</li>
              <li>Dedicated Chrome or Edge profile</li>
              <li>Manual Windows certificate confirmation</li>
              <li>Typed and isolated IPC bridge</li>
            </ul>
          </section>
          <div className={styles.note}>
            <Info size={16} />
            <p><strong>Certificate sign-in / 证书登录</strong><span>The app does not attempt to select or read a certificate. Confirm the Windows certificate directly in the browser when the highlighted reminder appears. / 应用不会选择或读取证书；看到醒目提醒后，请直接在浏览器中确认 Windows 证书。</span></p>
          </div>
        </aside>
      </div>
    </div>
  )
}
