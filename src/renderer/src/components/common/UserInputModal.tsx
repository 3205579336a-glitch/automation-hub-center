import type { InteractionField } from '../../../../shared/automation-interaction'
import { useLocalization } from '../../i18n/use-localization'

/** Reusable inputs displayed inside the engine-owned ActionRequiredModal. */
export function UserInputModal({ fields, values, onChange, disabled }: {
  fields: InteractionField[]; values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean) => void; disabled: boolean
}): React.JSX.Element {
  const { language } = useLocalization()
  return <div className="guided-inputs">{fields.map(field => <label className="field" key={field.id}>
    <span>{language === 'zh-CN' ? field.labelZh ?? field.label : field.label}{field.required ? ' *' : ''}</span>
    {field.type === 'dropdown' || field.type === 'yes-no'
      ? <select className="select" value={String(values[field.id] ?? '')} disabled={disabled}
          onChange={event => onChange(field.id, event.target.value)}>
          <option value="">{language === 'zh-CN' ? '请选择' : 'Select an option'}</option>
          {(field.type === 'yes-no' ? [{ value: 'yes', label: language === 'zh-CN' ? '是' : 'Yes' },
            { value: 'no', label: language === 'zh-CN' ? '否' : 'No' }] : field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      : field.type === 'checkbox'
        ? <input type="checkbox" checked={values[field.id] === true} disabled={disabled} onChange={event => onChange(field.id, event.target.checked)} />
        : <input className="input" type={field.type === 'date' ? 'date' : 'text'} maxLength={1000}
            value={String(values[field.id] ?? '')} disabled={disabled} onChange={event => onChange(field.id, event.target.value)} />}
  </label>)}</div>
}
