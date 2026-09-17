import { Download, FileSpreadsheet, UploadCloud } from 'lucide-react'
import type { Notify } from '../../types/notifications'
import styles from './RfqSections.module.css'

interface ExcelUploadPanelProps {
  notify: Notify
}

export function ExcelUploadPanel({ notify }: ExcelUploadPanelProps): React.JSX.Element {
  const laterMilestone = (): void => {
    notify({
      kind: 'info',
      title: 'Excel integration',
      message: 'Template download and Excel parsing will be added in the next milestone.'
    })
  }

  return (
    <div className={styles.excelLayout}>
      <section className={`card ${styles.section}`}>
        <div className={styles.headingRow}>
          <div>
            <h3 className="section-title">Upload RFQ data</h3>
            <p className="section-copy">Use a structured workbook to prepare larger requests.</p>
          </div>
          <button className="button" onClick={laterMilestone}><Download size={13} /> Download Template</button>
        </div>
        <button className={styles.uploadZone} onClick={laterMilestone}>
          <span className={styles.uploadIcon}><UploadCloud size={25} /></span>
          <strong>Drop your Excel file here</strong>
          <span>or browse for a workbook from this device</span>
          <span className="button primary"><FileSpreadsheet size={13} /> Select Excel File</span>
          <small>Accepted format: .xlsx · Maximum file size: 10 MB · One RFQ per workbook</small>
        </button>
      </section>

      <section className={`card ${styles.section}`}>
        <div><h3 className="section-title">File preview</h3><p className="section-copy">Review imported rows before validation.</p></div>
        <div className={styles.emptyPreview}>
          <FileSpreadsheet size={27} />
          <strong>No workbook selected</strong>
          <span>Excel parsing and preview will be added in a later milestone.</span>
        </div>
      </section>
    </div>
  )
}
