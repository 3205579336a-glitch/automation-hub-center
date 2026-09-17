import { Plus, Trash2 } from 'lucide-react'
import type { RfqItem } from './rfq-types'
import { useLocalization } from '../../i18n/use-localization'
import styles from './RfqSections.module.css'

interface RfqItemsProps {
  items: RfqItem[]
  onChange: (items: RfqItem[]) => void
}

export function RfqItems({ items, onChange }: RfqItemsProps): React.JSX.Element {
  const { t } = useLocalization()
  const updateItem = (id: number, field: keyof Omit<RfqItem, 'id'>, value: string): void => {
    onChange(items.map((item) => (item.id === id ? { ...item, [field]: value } : item)))
  }

  const addItem = (): void => {
    const id = Math.max(0, ...items.map((item) => item.id)) + 1
    onChange([...items, { id, material: '', description: '', quantity: '1', unit: 'EA', plant: '', deliveryDate: '' }])
  }

  const deleteItem = (id: number): void => {
    onChange(items.filter((item) => item.id !== id))
  }

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.headingRow}>
        <div className={styles.sectionHeading}>
          <span className={styles.step}>02</span>
          <div><h3 className="section-title">{t('rfqItems')}</h3><p className="section-copy">{t('rfqItemsCopy')}</p></div>
        </div>
        <button className="button" onClick={addItem}><Plus size={13} /> {t('addItem')}</button>
      </div>
      <div className={`table-wrap ${styles.editableTable}`}>
        <table className="data-table">
          <thead><tr><th>{t('material')} *</th><th>{t('description')}</th><th>{t('quantity')} *</th><th>{t('unit')}</th><th>{t('plant')} *</th><th>{t('deliveryDate')}</th><th /></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><input value={item.material} onChange={(event) => updateItem(item.id, 'material', event.target.value)} placeholder="Material no." /></td>
                <td><input value={item.description} onChange={(event) => updateItem(item.id, 'description', event.target.value)} placeholder="Item description" /></td>
                <td><input value={item.quantity} onChange={(event) => updateItem(item.id, 'quantity', event.target.value)} type="number" min="0" /></td>
                <td><select value={item.unit} onChange={(event) => updateItem(item.id, 'unit', event.target.value)}><option>EA</option><option>KG</option><option>PC</option></select></td>
                <td><input value={item.plant} onChange={(event) => updateItem(item.id, 'plant', event.target.value)} placeholder="Plant" /></td>
                <td><input value={item.deliveryDate} onChange={(event) => updateItem(item.id, 'deliveryDate', event.target.value)} type="date" /></td>
                <td><button className={styles.deleteButton} onClick={() => deleteItem(item.id)} disabled={items.length === 1} aria-label="Delete item"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
