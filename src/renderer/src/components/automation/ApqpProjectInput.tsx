import { ChevronDown } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useLocalization } from '../../i18n/use-localization'
import styles from '../../pages/ApqpDateManagement.module.css'

/** Editable project history; choosing a suggestion never starts a SAP query. */
export function ApqpProjectInput({ value, projects, disabled, onChange }: {
  value: string; projects: string[]; disabled: boolean; onChange: (value: string) => void
}): React.JSX.Element {
  const zh = useLocalization().language === 'zh-CN'
  const id = useId(), [open, setOpen] = useState(false), [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const expanded = open && !disabled
  const select = (index: number): void => { onChange(projects[index]); setOpen(false); input.current?.focus() }
  return <div className="field">
    <label htmlFor={id}>{zh ? 'NPL / 项目编号' : 'NPL / Project Code'} *</label>
    <div className={styles.projectCombo} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <input ref={input} id={id} className="input" role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`}
        aria-activedescendant={expanded ? `${id}-option-${active}` : undefined} value={value} maxLength={32} disabled={disabled}
        autoComplete="off" onChange={event => { onChange(event.target.value.trim()); setOpen(false) }} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive(expanded ? (active + (event.key === 'ArrowDown' ? 1 : -1) + projects.length) % projects.length : Math.max(0, projects.indexOf(value)))
            setOpen(true)
          } else if (event.key === 'Enter' && expanded) { event.preventDefault(); select(active) }
          else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
        }} />
      <button type="button" className={styles.projectToggle} disabled={disabled} aria-label={zh ? '选择已用项目' : 'Choose recent project'}
        aria-expanded={expanded} aria-controls={`${id}-list`} onMouseDown={event => event.preventDefault()}
        onClick={() => { setActive(Math.max(0, projects.indexOf(value))); setOpen(!expanded); input.current?.focus() }}><ChevronDown size={17} aria-hidden="true" /></button>
      {expanded && <ul id={`${id}-list`} className={styles.projectOptions} role="listbox" aria-label={zh ? '最近使用的项目' : 'Recent projects'}>
        {projects.map((project, index) => <li id={`${id}-option-${index}`} key={project} role="option" aria-selected={index === active}
          onMouseDown={event => event.preventDefault()} onClick={() => select(index)}>{project}</li>)}
      </ul>}
    </div>
  </div>
}
