import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Search, X } from 'lucide-react'

export type SearchOption = { id: string; source?: 'catalog' | 'company'; title: string; subtitle?: string; group?: string; data?: Record<string, any> }

export function SearchableCombobox({ label, value, selected, loadOptions, onChange, placeholder = 'Search…', emptyText = 'No matches found.', required, onCustom, customLabel = 'Other / custom' }: {
  label: string; value: string; selected?: SearchOption | null; loadOptions: (query: string) => Promise<SearchOption[]>; onChange: (option: SearchOption | null) => void
  placeholder?: string; emptyText?: string; required?: boolean; onCustom?: () => void; customLabel?: string
}) {
  const id = useId(); const inputRef = useRef<HTMLInputElement>(null)
  const loader = useRef(loadOptions); loader.current = loadOptions
  const typing = useRef(false)
  const request = useRef(0)
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(selected?.title || ''); const [options, setOptions] = useState<SearchOption[]>([]); const [loading, setLoading] = useState(false); const [active, setActive] = useState(-1)
  useEffect(() => { if (!value) { if (typing.current) typing.current = false; else setQuery('') } else if (selected?.title && !query) setQuery(selected.title) }, [value, selected?.title])
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => { const current = ++request.current; setLoading(true); loader.current(query === selected?.title ? '' : query).then(rows => { if (current !== request.current) return; setOptions(rows.slice(0, 50)); setActive(rows.length ? 0 : -1) }).catch(() => { if (current === request.current) setOptions([]) }).finally(() => { if (current === request.current) setLoading(false) }) }, 250)
    return () => window.clearTimeout(timer)
  }, [open, query, selected?.title])
  const choose = (option: SearchOption) => { onChange(option); setQuery(option.title); setOpen(false) }
  const closeLater = () => window.setTimeout(() => { request.current++; setOpen(false); if (!value) setQuery('') }, 120)
  const grouped = options.reduce<Record<string, SearchOption[]>>((all, option) => { (all[option.group || 'Results'] ||= []).push(option); return all }, {})
  return <div className="field combo-field">
    <span id={`${id}-label`}>{label}{required && ' *'}</span>
    <div className="combo-control">
      <Search size={15}/><input ref={inputRef} role="combobox" aria-labelledby={`${id}-label`} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined} required={required} value={query} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={closeLater} onChange={event => { setQuery(event.target.value); if (value) { typing.current = true; onChange(null) } setOpen(true) }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(options.length - 1, index + 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
        else if (event.key === 'Enter' && open && active >= 0) { event.preventDefault(); choose(options[active]!) }
        else if (event.key === 'Escape') { setOpen(false); setQuery(selected?.title || '') }
        else if (event.key === 'Home' && open) { event.preventDefault(); setActive(0) }
        else if (event.key === 'End' && open) { event.preventDefault(); setActive(options.length - 1) }
      }}/>
      {loading ? <LoaderCircle className="combo-spin" size={16}/> : value || query ? <button type="button" aria-label={`Clear ${label}`} onMouseDown={event => event.preventDefault()} onClick={() => { onChange(null); setQuery(''); setOpen(true); inputRef.current?.focus() }}><X size={15}/></button> : <ChevronDown size={15}/>}
    </div>
    {open && <div className="combo-menu" id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
      {loading && !options.length ? <div className="combo-state">Searching…</div> : !options.length ? <div className="combo-state">{emptyText}</div> : Object.entries(grouped).map(([group, rows]) => <div key={group}><div className="combo-group">{group}</div>{rows.map(option => { const index = options.indexOf(option); return <button type="button" role="option" aria-selected={option.id === value} id={`${id}-option-${index}`} className={index === active ? 'active' : ''} key={`${option.source || 'option'}-${option.id}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}><span><strong>{option.title}</strong>{option.subtitle && <small>{option.subtitle}</small>}</span>{option.id === value && <Check size={16}/>}</button> })}</div>)}
      {onCustom && <button type="button" className="combo-custom" onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(false); onCustom() }}>+ {customLabel}</button>}
    </div>}
  </div>
}
