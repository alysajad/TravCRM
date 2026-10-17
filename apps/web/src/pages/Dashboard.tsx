import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarDays, CirclePlus, Clock3, FileText, MessageSquareText, Sparkles } from 'lucide-react'
import { api, date, type Me, type RecordItem } from '../api'
import { Empty, ErrorNotice, PageHeading } from './Entity'

type Dashboard = {
  counts: Record<string, number>
  totalQueries: number
  totalQuotes: number
  dueFollowups: number
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
    { label: 'Confirmed trips', value: data?.counts.Confirmed, icon: Sparkles, hint: 'Ready to travel', className: 'white', path: '/records/queries?status=Confirmed', permission: 'query.read' },
    { label: 'Follow-ups due', value: data?.dueFollowups, icon: Clock3, hint: 'Needs your attention', className: 'sky', path: '/records/follow-ups', permission: 'follow_up.read' }
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
      {data?.arrivals.length ? <div className="arrival-list">{data.arrivals.map(item => <Link className="work-row" to="/records/queries" key={item.id}><span className="work-date sky-date">{item.data.arrival_date ? new Date(item.data.arrival_date).getDate() : '—'}</span><span className="work-copy"><strong>{item.title}</strong><small>{item.data.destination || 'Destination not set'} · {date(item.data.arrival_date)}</small></span><ArrowRight size={16}/></Link>)}</div> : <Empty title="No upcoming arrivals" description="Add an arrival date to a query to see it here."/>}
    </section>
  </div>
}
