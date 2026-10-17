import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Activity, BarChart3, Bell, Building2, ChevronDown, CircleDollarSign, Compass, FileText, Hotel, LayoutDashboard, LogOut, Menu, ReceiptText, Search, Settings2, Shield, Users, Wallet, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, configured, selectCompany, supabase, type Me } from './api'
const DashboardPage = lazy(() => import('./pages/Dashboard'))
const EntityPage = lazy(() => import('./pages/Entity').then(m => ({ default: m.EntityPage })))
const QuotesPage = lazy(() => import('./pages/Sales').then(m => ({ default: m.QuotesPage })))
const QuoteEditor = lazy(() => import('./pages/Sales').then(m => ({ default: m.QuoteEditor })))
const LedgerPage = lazy(() => import('./pages/Finance').then(m => ({ default: m.LedgerPage })))
const HotelLedgerPage = lazy(() => import('./pages/Finance').then(m => ({ default: m.HotelLedgerPage })))
const PaymentsPage = lazy(() => import('./pages/Finance').then(m => ({ default: m.PaymentsPage })))
const CompaniesPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.CompaniesPage })))
const UsersPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.UsersPage })))
const RolesPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.RolesPage })))
const SettingsPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.SettingsPage })))
const IntegrationsPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.IntegrationsPage })))
const AuditPage = lazy(() => import('./pages/Admin').then(m => ({ default: m.AuditPage })))
const PlatformOverview = lazy(() => import('./pages/Platform').then(m => ({ default: m.PlatformOverview })))
const PlatformCompanyDetail = lazy(() => import('./pages/Platform').then(m => ({ default: m.PlatformCompanyDetail })))
const PlatformSettings = lazy(() => import('./pages/Platform').then(m => ({ default: m.PlatformSettings })))
const PlatformAudit = lazy(() => import('./pages/Platform').then(m => ({ default: m.PlatformAudit })))
const PublicLeadForm = lazy(() => import('./pages/PublicForm'))

type NavItem = { label: string; path: string; icon: LucideIcon; permission: string }
const groups: { label: string; items: NavItem[] }[] = [
  { label: 'Workspace', items: [
    { label: 'Overview', path: '/', icon: LayoutDashboard, permission: 'query.read' },
    { label: 'Queries', path: '/records/queries', icon: Compass, permission: 'query.read' },
    { label: 'Quotations', path: '/quotes', icon: FileText, permission: 'quotes.read' },
    { label: 'Follow-ups', path: '/records/follow-ups', icon: Bell, permission: 'follow_up.read' },
    { label: 'Leads', path: '/records/leads', icon: Users, permission: 'lead.read' }
  ] },
  { label: 'Travel library', items: [
    { label: 'Day plans', path: '/records/day-plans', icon: Compass, permission: 'day_plan.read' },
    { label: 'Hotels & houseboats', path: '/records/hotels', icon: Hotel, permission: 'hotel.read' },
    { label: 'Cabs', path: '/records/cabs', icon: Compass, permission: 'cab.read' },
    { label: 'Stay vouchers', path: '/records/stay-vouchers', icon: FileText, permission: 'stay_voucher.read' },
    { label: 'Cab vouchers', path: '/records/cab-vouchers', icon: FileText, permission: 'cab_voucher.read' }
  ] },
  { label: 'Finance', items: [
    { label: 'Ledger', path: '/ledger', icon: BarChart3, permission: 'payments.read' },
    { label: 'Hotel ledger', path: '/hotel-ledger', icon: Hotel, permission: 'hotel_payment.read' },
    { label: 'Hotel payments', path: '/records/hotel-payments', icon: Wallet, permission: 'hotel_payment.read' },
    { label: 'Payments', path: '/payments', icon: Wallet, permission: 'payments.read' },
    { label: 'Invoices', path: '/records/invoices', icon: ReceiptText, permission: 'invoice.read' },
    { label: 'Expenses', path: '/records/expenses', icon: Wallet, permission: 'expense.read' }
  ] },
  { label: 'Manage', items: [
    { label: 'Clients', path: '/records/clients', icon: Users, permission: 'client.read' },
    { label: 'Lead sources', path: '/records/lead-sources', icon: Compass, permission: 'lead_source.read' },
    { label: 'Hotel categories', path: '/records/hotel-categories', icon: Hotel, permission: 'hotel_category.read' },
    { label: 'Room types', path: '/records/room-types', icon: Hotel, permission: 'room_type.read' },
    { label: 'Voucher inclusions', path: '/records/voucher-inclusions', icon: FileText, permission: 'voucher_inclusion.read' },
    { label: 'Partners', path: '/records/partners', icon: Building2, permission: 'partner.read' },
    { label: 'Other catalog', path: '/records/other-catalog', icon: Settings2, permission: 'other_catalog.read' },
    { label: 'Team', path: '/users', icon: Users, permission: 'users.read' },
    { label: 'Roles', path: '/roles', icon: Shield, permission: 'roles.read' },
    { label: 'Company settings', path: '/settings', icon: Settings2, permission: 'company.read' },
    { label: 'Connections', path: '/integrations', icon: Compass, permission: 'integrations.read' },
    { label: 'Activity', path: '/audit', icon: BarChart3, permission: 'audit.read' }
  ] }
]
const platformGroups: { label: string; items: NavItem[] }[] = [{ label: 'Platform', items: [
  { label: 'Owner overview', path: '/platform', icon: LayoutDashboard, permission: '*' },
  { label: 'Companies', path: '/companies', icon: Building2, permission: '*' },
  { label: 'Product pricing', path: '/platform/settings', icon: CircleDollarSign, permission: '*' },
  { label: 'Platform activity', path: '/platform/audit', icon: Activity, permission: '*' }
] }]

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const [reset, setReset] = useState(false); const [sent, setSent] = useState(false)
  if (reset) return <div className="auth-page"><div className="auth-panel"><div className="brand-mark"><Compass size={25}/></div><p className="eyebrow">ACCOUNT ACCESS</p><h1>Reset your password.</h1><p className="muted">We’ll send a link to your work email.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const { error } = await supabase!.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/set-password` }); setBusy(false); if (error) setError(error.message); else setSent(true) }}><label>Email address<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}{sent && <p className="notice success">If this account exists, check your email for a reset link.</p>}<button className="button primary full" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button></form><button className="text-button" onClick={() => { setReset(false); setError('') }}>Back to sign in</button></div><div className="auth-art"><p>Every trip begins<br/>with a clear plan.</p></div></div>
  return <div className="auth-page"><div className="auth-panel"><div className="brand-mark"><Compass size={25}/></div><p className="eyebrow">TRAVEL OPERATIONS</p><h1>Welcome back.</h1><p className="muted">Sign in to manage the journeys behind every booking.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const result = await supabase!.auth.signInWithPassword({ email, password }); setBusy(false); if (result.error) setError(result.error.message); else onLogin() }}><label>Email address<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}/></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form><button className="text-button" onClick={() => { setReset(true); setError('') }}>Forgot password?</button></div><div className="auth-art"><div className="route-art"><span className="route-node one"/><span className="route-node two"/><span className="route-node three"/><div className="route-line"/></div><p>Every trip begins<br/>with a clear plan.</p></div></div>
}

function SetPassword() {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  return <div className="auth-page"><div className="auth-panel"><div className="brand-mark"><Shield size={25}/></div><p className="eyebrow">ACCOUNT ACCESS</p><h1>Set your password.</h1><p className="muted">Use at least 12 characters to protect your workspace.</p><form onSubmit={async e => { e.preventDefault(); if (password !== confirm) return setError('Passwords do not match.'); setBusy(true); setError(''); const result = await supabase!.auth.updateUser({ password }); setBusy(false); if (result.error) setError(result.error.message); else window.location.replace('/') }}><label>New password<input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></label><label>Confirm password<input type="password" required minLength={12} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button></form></div><div className="auth-art"><p>Every trip begins<br/>with a clear plan.</p></div></div>
}

function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname])
  const platformOnly = me.platform && !me.companyId
  const visibleGroups = platformOnly ? platformGroups : groups
  const can = (p: string) => me.platform || me.permissions.includes('*') || me.permissions.includes(p)
  const title = [...groups.flatMap(g => g.items), ...platformGroups.flatMap(g => g.items)].find(x => x.path === location.pathname)?.label || (location.pathname.includes('/platform/companies/') ? 'Company support' : location.pathname.includes('/quotes/') ? 'Quotation' : 'Workspace')
  return <div className="app-frame"><aside className={`sidebar ${open ? 'open' : ''}`}><div className="sidebar-head"><Link to={platformOnly ? '/platform' : '/'} className="brand"><span className="brand-mark small"><Compass size={21}/></span><span>Trav<span>CRM</span></span></Link><button className="icon-button mobile-only" onClick={() => setOpen(false)} aria-label="Close navigation"><X size={20}/></button></div><div className="company-chip"><span className="company-symbol">{(me.companyName || 'T').slice(0, 1).toUpperCase()}</span><span><strong>{me.companyName || 'TravCRM'}</strong><small>{platformOnly ? 'Owner portal' : me.platform ? 'Support workspace' : 'Company workspace'}</small></span><ChevronDown size={15}/></div><nav aria-label="Main navigation">{visibleGroups.map(group => { const items = group.items.filter(x => can(x.permission)); return items.length ? <div className="nav-group" key={group.label}><p>{group.label}</p>{items.map(item => <NavLink key={item.path} to={item.path} end={item.path === '/' || item.path === '/platform'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><item.icon size={18}/><span>{item.label}</span></NavLink>)}</div> : null })}{me.platform && me.companyId && <div className="nav-group"><p>Platform</p><button className="nav-link nav-button" onClick={() => selectCompany('', '/platform')}><Building2 size={18}/><span>Back to owner portal</span></button></div>}</nav><div className="sidebar-bottom"><span className="avatar">{me.name.slice(0, 1).toUpperCase()}</span><span className="user-details"><strong>{me.name}</strong><small>Signed in</small></span><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={() => supabase?.auth.signOut()}><LogOut size={18}/></button></div></aside>{open && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setOpen(false)}/>}<div className="main-area">{me.platform && me.companyId && <div className="support-banner"><Shield size={15}/>You are viewing <strong>{me.companyName}</strong> as a TravCRM platform administrator.<button onClick={() => selectCompany('', '/platform')}>Exit workspace</button></div>}<header className="topbar"><button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu size={22}/></button><div className="topbar-title"><span className="eyebrow">{platformOnly ? 'TRAVCRM / PLATFORM' : `OPERATIONS / ${me.companyName || 'PLATFORM'}`}</span><strong>{title}</strong></div><div className="topbar-actions"><span className="today">{new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</span>{!platformOnly && <><Link className="icon-button" to="/records/queries" title="Find queries" aria-label="Find queries"><Search size={17}/></Link><Link className="icon-button" to="/records/follow-ups" title="Follow-ups" aria-label="Follow-ups"><Bell size={17}/></Link></>}<span className="avatar top-avatar" title={me.name}>{me.name.slice(0, 1).toUpperCase()}</span></div></header><main className="content">{children}</main></div></div>
}

export default function App() {
  const location = useLocation()
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session)); if (!session) setMe(null) })
    return () => listener.subscription.unsubscribe()
  }, [])
  useEffect(() => { if (signedIn) api<Me>('/me').then(setMe).catch(e => setError(e.message)) }, [signedIn])
  if (!configured) return <div className="choice-page"><div className="choice-card"><div className="brand-mark"><Compass/></div><h1>Connect TravCRM</h1><p className="muted">Copy both example environment files, add your Supabase project keys, and start the API and web apps.</p><code>apps/web/.env.example<br/>apps/api/.env.example</code></div></div>
  if (location.pathname.startsWith('/forms/')) return <Suspense fallback={<div className="loading-screen">Opening form…</div>}><PublicLeadForm/></Suspense>
  if (signedIn === null) return <div className="loading-screen">Opening workspace…</div>
  if (!signedIn) return <Login onLogin={() => setSignedIn(true)}/>
  if (location.pathname === '/set-password') return <SetPassword/>
  if (error) return <div className="choice-page"><div className="choice-card"><h1>Account access</h1><p className="form-error">{error}</p><button className="button secondary" onClick={() => { setError(''); api<Me>('/me').then(setMe).catch(e => setError(e.message)) }}>Try again</button><button className="text-button" onClick={() => selectCompany('')}>Choose another company</button><button className="text-button" onClick={() => supabase?.auth.signOut()}>Sign out</button></div></div>
  if (!me) return <div className="loading-screen">Loading your workspace…</div>
  return <AppShell me={me}><Suspense fallback={<div className="loading-screen page-loading">Opening section…</div>}><Routes><Route path="/" element={me.platform && !me.companyId ? <Navigate to="/platform"/> : <DashboardPage me={me}/>}/><Route path="/platform" element={<PlatformOverview/>}/><Route path="/platform/companies/:id" element={<PlatformCompanyDetail/>}/><Route path="/platform/settings" element={<PlatformSettings/>}/><Route path="/platform/audit" element={<PlatformAudit/>}/><Route path="/records/:slug" element={<EntityPage me={me}/>}/><Route path="/quotes" element={<QuotesPage me={me}/>}/><Route path="/quotes/new" element={<QuoteEditor/>}/><Route path="/quotes/:id/edit" element={<QuoteEditor/>}/><Route path="/ledger" element={<LedgerPage/>}/><Route path="/hotel-ledger" element={<HotelLedgerPage/>}/><Route path="/payments" element={<PaymentsPage/>}/><Route path="/users" element={<UsersPage me={me}/>}/><Route path="/roles" element={<RolesPage me={me}/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/integrations" element={<IntegrationsPage/>}/><Route path="/audit" element={<AuditPage/>}/><Route path="/companies" element={<CompaniesPage me={me}/>}/><Route path="*" element={<Navigate to={me.platform && !me.companyId ? '/platform' : '/'}/>}/></Routes></Suspense></AppShell>
}
