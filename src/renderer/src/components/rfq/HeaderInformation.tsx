import type { RfqHeader } from './rfq-types'
import { useLocalization } from '../../i18n/use-localization'
import styles from './RfqSections.module.css'

interface HeaderInformationProps {
  value: RfqHeader
  onChange: (value: RfqHeader) => void
}

export function HeaderInformation({
  value,
  onChange
}: HeaderInformationProps): React.JSX.Element {
  const { t } = useLocalization()
  const update = (field: keyof RfqHeader, fieldValue: string): void => {
    onChange({ ...value, [field]: fieldValue })
  }

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHeading}>
        <span className={styles.step}>01</span>
        <div><h3 className="section-title">{t('headerInformation')}</h3><p className="section-copy">{t('headerInformationCopy')}</p></div>
      </div>
      <div className={styles.headerGrid}>
        <div className="field">
          <label>{t('documentType')} <span>*</span></label>
          <select className="select" value={value.documentType} onChange={(event) => update('documentType', event.target.value)}>
            <option value="">Select type</option>
            <option value="AN">AN — Request for Quotation</option>
          </select>
        </div>
        <div className="field">
          <label>{t('purchasingOrganization')} <span>*</span></label>
          <input className="input" value={value.purchasingOrganization} onChange={(event) => update('purchasingOrganization', event.target.value)} placeholder="e.g. 1000" />
        </div>
        <div className="field">
          <label>{t('purchasingGroup')} <span>*</span></label>
          <input className="input" value={value.purchasingGroup} onChange={(event) => update('purchasingGroup', event.target.value)} placeholder="e.g. 001" />
        </div>
        <div className="field">
          <label>{t('quotationDeadline')} <span>*</span></label>
          <input className="input" type="date" value={value.quotationDeadline} onChange={(event) => update('quotationDeadline', event.target.value)} />
        </div>
        <div className="field">
          <label>{t('currency')} <span>*</span></label>
          <select className="select" value={value.currency} onChange={(event) => update('currency', event.target.value)}>
            <option value="">Select currency</option>
            <option value="USD">USD — US Dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="CNY">CNY — Chinese Yuan</option>
          </select>
        </div>
        <div className={`field ${styles.headerText}`}>
          <label>{t('headerText')}</label>
          <textarea className="textarea" value={value.headerText} onChange={(event) => update('headerText', event.target.value)} placeholder="Optional notes for this quotation request" />
        </div>
      </div>
    </section>
  )
}
