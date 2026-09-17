import { Plus, Trash2 } from 'lucide-react'
import type { Supplier } from './rfq-types'
import { useLocalization } from '../../i18n/use-localization'
import styles from './RfqSections.module.css'

interface SuppliersProps {
  suppliers: Supplier[]
  onChange: (suppliers: Supplier[]) => void
}

export function Suppliers({ suppliers, onChange }: SuppliersProps): React.JSX.Element {
  const { t } = useLocalization()
  const updateSupplier = (id: number, field: 'number' | 'name', value: string): void => {
    onChange(suppliers.map((supplier) => (supplier.id === id ? { ...supplier, [field]: value } : supplier)))
  }

  const addSupplier = (): void => {
    const id = Math.max(0, ...suppliers.map((supplier) => supplier.id)) + 1
    onChange([...suppliers, { id, number: '', name: '' }])
  }

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.headingRow}>
        <div className={styles.sectionHeading}>
          <span className={styles.step}>03</span>
          <div><h3 className="section-title">{t('suppliers')}</h3><p className="section-copy">{t('suppliersCopy')}</p></div>
        </div>
        <button className="button" onClick={addSupplier}><Plus size={13} /> {t('addSupplier')}</button>
      </div>
      <div className={styles.suppliers}>
        {suppliers.map((supplier, index) => (
          <div className={styles.supplierRow} key={supplier.id}>
            <span className={styles.rowNumber}>{String(index + 1).padStart(2, '0')}</span>
            <div className="field">
              <label>{t('supplierNumber')} <span>*</span></label>
              <input className="input" value={supplier.number} onChange={(event) => updateSupplier(supplier.id, 'number', event.target.value)} placeholder="e.g. 100001" />
            </div>
            <div className="field">
              <label>{t('supplierName')}</label>
              <input className="input" value={supplier.name} onChange={(event) => updateSupplier(supplier.id, 'name', event.target.value)} placeholder="Optional display name" />
            </div>
            <button className={styles.deleteButton} onClick={() => onChange(suppliers.filter((entry) => entry.id !== supplier.id))} disabled={suppliers.length === 1} aria-label="Delete supplier"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </section>
  )
}
