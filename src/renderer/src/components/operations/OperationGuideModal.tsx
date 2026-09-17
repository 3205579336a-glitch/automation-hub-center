import { CheckCircle2, ChevronRight, Info, X } from 'lucide-react'
import { useEffect } from 'react'
import styles from './OperationGuideModal.module.css'

export interface OperationGuide {
  title: string
  description: string
  steps: string[]
  availability: 'active' | 'coming-soon'
}

interface OperationGuideModalProps {
  guide: OperationGuide
  closeLabel: string
  onClose: () => void
}

export function OperationGuideModal({
  guide,
  closeLabel,
  onClose
}: OperationGuideModalProps): React.JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-guide-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.titleIcon}><Info size={20} /></div>
          <div>
            <span>OPERATION GUIDE / 操作演示</span>
            <h3 id="operation-guide-title">{guide.title}</h3>
          </div>
          <button className={styles.close} onClick={onClose} aria-label={closeLabel}>
            <X size={18} />
          </button>
        </header>

        <p className={styles.description}>{guide.description}</p>
        <div className={styles.demo} aria-label="Animated operation steps">
          {guide.steps.map((step, index) => (
            <div className={styles.stepGroup} key={step}>
              <div className={styles.step} style={{ animationDelay: `${index * 1.5}s` }}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{step}</strong>
                <CheckCircle2 size={16} />
              </div>
              {index < guide.steps.length - 1 && <ChevronRight className={styles.arrow} size={18} />}
            </div>
          ))}
        </div>
        {guide.availability === 'coming-soon' && (
          <p className={styles.comingSoon}>This workflow is a reserved extension point. / 此流程为预留扩展功能。</p>
        )}
        <footer>
          <button className="button primary" onClick={onClose}>{closeLabel}</button>
        </footer>
      </section>
    </div>
  )
}
