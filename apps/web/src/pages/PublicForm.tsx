import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, Compass } from 'lucide-react'
import { publicApi } from '../api'

type Config = { title: string; success_message: string; primary_color: string; enabled_fields: string[]; required_fields: string[]; brand_name?: string; logo_url?: string; turnstile_site_key?: string }
const labels: Record<string, string> = { name: 'Your name', phone: 'Phone number', email: 'Email address', destination: 'Where would you like to go?', message: 'Tell us about your trip' }

export default function PublicLeadForm() {
  const { key = '' } = useParams(); const [config, setConfig] = useState<Config>(); const [error, setError] = useState(''); const [done, setDone] = useState(''); const [busy, setBusy] = useState(false)
  useEffect(() => { publicApi<Config>(`/public/forms/${key}`).then(setConfig).catch(e => setError(e.message)) }, [key])
  useEffect(() => {
    if (!config?.turnstile_site_key || document.querySelector('script[data-turnstile]')) return
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; script.async = true; script.dataset.turnstile = 'true'; document.head.appendChild(script)
  }, [config])
  if (error) return <main className="public-form-page"><div className="public-form-card"><Compass size={28}/><h1>Form unavailable</h1><p>{error}</p></div></main>
  if (!config) return <main className="public-form-page"><div className="public-form-card">Loading enquiry form…</div></main>
  return <main className="public-form-page" style={{ '--form-accent': config.primary_color } as React.CSSProperties}><div className="public-form-card">
    <header>{config.logo_url ? <img src={config.logo_url} alt=""/> : <span className="public-form-mark"><Compass size={22}/></span>}<div><small>ENQUIRY FORM</small><strong>{config.brand_name || 'Travel company'}</strong></div></header>
    {done ? <div className="public-form-success"><CheckCircle2 size={38}/><h1>Enquiry received</h1><p>{done}</p></div> : <><h1>{config.title}</h1><p className="muted">Share a few details and the travel team will contact you.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const values = Object.fromEntries(new FormData(e.currentTarget)); try { const result = await publicApi<{ message: string }>(`/public/leads/${key}`, { method: 'POST', body: JSON.stringify({ ...values, turnstile_token: values['cf-turnstile-response'] }) }); setDone(result.message) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>
      {config.enabled_fields.map(field => <label className="field" key={field}><span>{labels[field] || field}{config.required_fields.includes(field) ? ' *' : ''}</span>{field === 'message' ? <textarea name={field} required={config.required_fields.includes(field)} rows={4}/> : <input name={field} type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'} required={config.required_fields.includes(field)}/>}</label>)}
      <input className="form-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"/>
      {config.turnstile_site_key && <div className="cf-turnstile" data-sitekey={config.turnstile_site_key}/>} {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy ? 'Sending…' : 'Send enquiry'}</button>
    </form></>}
    <footer>Made with TravCRM</footer>
  </div></main>
}
