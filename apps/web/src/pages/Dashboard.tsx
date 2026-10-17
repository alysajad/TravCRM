import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, CirclePlus, Clock3, FileText, MessageSquareText, Sparkles } from 'lucide-react'
import { api, date, money, type Me, type RecordItem } from '../api'
import { Empty, ErrorNotice, PageHeading } from './Entity'

type Dashboard = {
  counts: Record<string, number>
  totalQueries: number
  totalQuotes: number
  dueFollowups: number
  todayFollowups: number
  missedFollowups: number
  todayArrivals: number
  tomorrowArrivals: number
  activeBookings: number
  pendingHotelConfirmations: number
  unpaidBalance: number
  upcomingBookings: { id: string; booking_number: string; client_name: string; destination: string; arrival_date: string; status: string }[]
  arrivals: RecordItem[]
  followups: RecordItem[]
}

const stages = [
  { name: 'Pending', color: '#C084FC' },
  { name: 'Contacted', color: '#A5D8FF' },
  { name: 'Interested', color: '#9360C9' },
  { name: 'Quoted', color: '#7ABCEB' },
  { name: 'Confirmed', color: '#6D4C82' },
  { name: 'Completed', color: '#4A3A52' },
  { name: 'Cancelled', color: '#DAC8E5' }
]

export default function DashboardPage({ me }: { me: Me }) {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api<Dashboard>('/dashboard').then(setData).catch(e => setError(e.message)) }, [])

  const total = data?.totalQueries || 0
  let stop = 0
  const slices = stages.flatMap(stage => {
    const portion = total ? ((data?.counts[stage.name] || 0) / total) * 100 : 0
    const start = stop
    stop += portion
    return portion ? [`${stage.color} ${start}% ${stop}%`] : []
  })
  const ring = total ? `conic-gradient(${slices.join(', ')})` : 'conic-gradient(#E9DCEE 0 100%)'
  const max = Math.max(1, ...stages.map(stage => data?.counts[stage.name] || 0))
  const can = (permission: string) => me.platform || me.permissions.includes('*') || me.permissions.includes(permission)
  const metrics = [
    { label: 'Total queries', value: data?.totalQueries, icon: MessageSquareText, hint: 'All enquiries', className: 'violet', path: '/records/queries', permission: 'query.read' },
    { label: 'Quotations', value: data?.totalQuotes, icon: FileText, hint: 'Trips prepared', className: 'white', path: '/quotes', permission: 'quotes.read' },
    { label: 'Active bookings', value: data?.activeBookings, icon: Sparkles, hint: 'Confirmed and travelling', className: 'white', path: '/bookings', permission: 'bookings.read' },
    { label: 'Today arrivals', value: data?.todayArrivals, icon: CalendarDays, hint: `${data?.tomorrowArrivals || 0} arriving tomorrow`, className: 'sky', path: '/bookings', permission: 'bookings.read' },
    { label: 'Pending hotels', value: data?.pendingHotelConfirmations, icon: Clock3, hint: 'Supplier confirmations', className: 'white', path: '/bookings', permission: 'bookings.read' },
    { label: 'Outstanding', value: money(data?.unpaidBalance), icon: FileText, hint: 'Across active bookings', className: 'white', path: '/ledger', permission: 'payments.read' },
    { label: 'Follow-ups due', value: data?.dueFollowups, icon: Clock3, hint: `${data?.missedFollowups || 0} missed · ${data?.todayFollowups || 0} today`, className: 'white', path: '/records/follow-ups', permission: 'follow_up.read' }
  ].filter(metric => can(metric.permission))

  return <div className="dashboard-page">
    <PageHeading eyebrow="YOUR WORKSPACE" title="Sales overview" description="A clear view of every enquiry, quotation and trip in progress." action={<Link to="/records/queries" className="button primary"><CirclePlus size={17}/> New query</Link>}/>
    <ErrorNotice message={error}/>
    <div className="dashboard-overview">
      <div className="metric-grid">
        {metrics.map(metric => <Link key={metric.label} to={metric.path} className={`metric-card ${metric.className}`}>
          <span className="metric-icon"><metric.icon size={19}/></span>
          <span className="metric-label">{metric.label}</span>
          <strong>{metric.value ?? '—'}</strong>
          <span className="metric-hint">{metric.hint}<ArrowRight size={15}/></span>
        </Link>)}
      </div>
      <section className="dashboard-panel mix-panel" aria-label="Query status breakdown">
        <div className="dashboard-panel-head"><div><span className="eyebrow">PIPELINE</span><h2>Enquiry mix</h2><p>Where your queries stand today</p></div><span className="panel-period">All time</span></div>
        <div className="mix-visual" role="img" aria-label={`${total} queries across ${stages.length} statuses`}><div className="mix-ring" style={{ background: ring }}><div className="mix-center"><strong>{data?.totalQueries ?? '—'}</strong><span>queries</span></div></div></div>
        <div className="mix-legend">{stages.map(stage => <Link to={`/records/queries?status=${stage.name}`} key={stage.name}><span className="legend-dot" style={{ backgroundColor: stage.color }}/><span>{stage.name}</span><strong>{data?.counts[stage.name] ?? '—'}</strong></Link>)}</div>
      </section>
    </div>

    <div className={`dashboard-detail ${can('follow_up.read') ? '' : 'solo'}`}>
      <section className="dashboard-panel stage-panel">
        <div className="dashboard-panel-head"><div><span className="eyebrow">SALES ACTIVITY</span><h2>Queries by stage</h2><p>Follow the path from first contact to confirmed trip</p></div><Link to="/records/queries" className="panel-link">View queries <ArrowRight size={15}/></Link></div>
        <div className="stage-chart">{stages.map(stage => {
          const value = data?.counts[stage.name] || 0
          return <Link to={`/records/queries?status=${stage.name}`} className="stage-column" key={stage.name} title={`${stage.name}: ${value} queries`}>
            <span className="stage-value">{data ? value : '—'}</span>
            <span className="stage-track"><span className="stage-bar" style={{ height: `${Math.max(value ? 11 : 2, value / max * 100)}%`, backgroundColor: stage.color }}/></span>
            <span className="stage-name">{stage.name}</span>
          </Link>
        })}</div>
      </section>
      {can('follow_up.read') && <section className="dashboard-panel work-panel">
        <div className="dashboard-panel-head"><div><span className="eyebrow">NEEDS ATTENTION</span><h2>Follow-ups due</h2><p>Conversations waiting for your team</p></div><Clock3 size={19}/></div>
        {data?.followups.length ? data.followups.map(item => <Link className="work-row" to="/records/follow-ups" key={item.id}><span className="work-date">{item.data.due_date ? new Date(item.data.due_date).getDate() : '—'}</span><span className="work-copy"><strong>{item.title}</strong><small>Due {date(item.data.due_date)}</small></span><ArrowRight size={16}/></Link>) : <Empty title="All caught up" description="Due follow-ups will appear here."/>}
      </section>}
    </div>

    <section className="dashboard-panel arrival-panel">
      <div className="dashboard-panel-head"><div><span className="eyebrow">COMING UP</span><h2>Expected arrivals</h2><p>Trips scheduled from your current queries</p></div><CalendarDays size={20}/></div>
      {data?.upcomingBookings?.length ? <div className="arrival-list">{data.upcomingBookings.map(item => <Link className="work-row" to={`/bookings/${item.id}`} key={item.id}><span className="work-date sky-date">{new Date(item.arrival_date).getDate()}</span><span className="work-copy"><strong>{item.client_name}</strong><small>{item.destination} · {date(item.arrival_date)} · {item.booking_number}</small></span><ArrowRight size={16}/></Link>)}</div> : <Empty title="No upcoming bookings" description="Confirmed trips will appear here."/>}
    </section>
  </div>
}
