import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const unwrap = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data }
const iso = value => new Date(`${value}T09:00:00+05:30`).toISOString()
const addDays = (value, days) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }

async function main() {
  const company = unwrap(await db.from('companies').select('id,name').eq('slug', process.env.DEMO_COMPANY_SLUG || 'huzpoint').single(), 'find Huz company')
  const member = unwrap(await db.from('memberships').select('user_id').eq('company_id', company.id).eq('active', true).limit(1).single(), 'find Huz user')
  unwrap(await db.rpc('seed_operation_defaults', { p_company_id: company.id }), 'seed operation templates')
  const templates = unwrap(await db.from('operation_task_templates').select('*').eq('company_id', company.id).eq('active', true), 'load task templates')
  const bookings = unwrap(await db.from('bookings').select('*').eq('company_id', company.id).order('arrival_date'), 'load bookings')
  if (!bookings.length) throw new Error('Run scripts/seed-huz-bookings.mjs first.')
  const results = []
  for (const [index, booking] of bookings.entries()) {
    const scenario = index % 5
    const tasks = templates.map(template => {
      const anchor = template.anchor === 'confirmation' ? booking.confirmed_at.slice(0, 10) : template.anchor === 'departure' ? booking.departure_date : booking.arrival_date
      const completed = scenario === 0 || scenario === 2 || (scenario === 4 && template.position < 80)
      return { company_id: company.id, booking_id: booking.id, template_id: template.id, title: template.title, category: template.category, priority: template.priority, due_at: iso(addDays(anchor, template.offset_days)), assignee_id: member.user_id, source: 'template', status: booking.status === 'cancelled' ? 'cancelled' : completed ? 'done' : scenario === 3 && template.category === 'suppliers' ? 'blocked' : 'todo', completed_by: completed ? member.user_id : null, completed_at: completed ? new Date().toISOString() : null, created_by: member.user_id }
    })
    unwrap(await db.from('booking_tasks').upsert(tasks, { onConflict: 'booking_id,template_id' }), `seed tasks for ${booking.client_name}`)
    let travellers = unwrap(await db.from('booking_travellers').select('*').eq('company_id', company.id).eq('booking_id', booking.id), 'load travellers')
    if (!travellers.length) {
      const rows = [{ company_id: company.id, booking_id: booking.id, traveller_type: 'adult', full_name: booking.client_name, phone: booking.phone, email: booking.email, is_primary: true }]
      for (let n = 2; n <= booking.adults; n += 1) rows.push({ company_id: company.id, booking_id: booking.id, traveller_type: 'adult', full_name: `Adult ${n} · ${booking.client_name}`, is_primary: false })
      for (let n = 1; n <= booking.children; n += 1) rows.push({ company_id: company.id, booking_id: booking.id, traveller_type: 'child', full_name: `Child ${n} · ${booking.client_name}`, is_primary: false })
      travellers = unwrap(await db.from('booking_travellers').insert(rows).select('*'), 'insert travellers')
    }
    const existingDocs = unwrap(await db.from('booking_traveller_documents').select('id').eq('company_id', company.id).eq('booking_id', booking.id), 'load documents')
    if (!existingDocs.length) {
      const docs = travellers.flatMap((traveller, n) => ['Passport','Photograph'].map((document_type, d) => ({ company_id: company.id, booking_id: booking.id, traveller_id: traveller.id, document_type, status: scenario === 1 && (n > 0 || d === 0) ? 'required' : scenario === 3 && d === 0 ? 'rejected' : 'verified', original_name: scenario === 1 && (n > 0 || d === 0) ? null : `${document_type.toLowerCase()}-${n + 1}-demo.pdf`, verified_by: scenario === 1 && (n > 0 || d === 0) ? null : member.user_id, verified_at: scenario === 1 && (n > 0 || d === 0) ? null : new Date().toISOString(), created_by: member.user_id })))
      unwrap(await db.from('booking_traveller_documents').insert(docs), 'insert demo traveller documents')
    }
    const serviceResult = await db.from('booking_services').select('id', { count: 'exact', head: true }).eq('company_id', company.id).eq('booking_id', booking.id)
    if (serviceResult.error) throw new Error(`count services: ${serviceResult.error.message}`)
    if (!serviceResult.count) {
      const start = `${booking.arrival_date}T06:00:00+05:30`
      const rows = scenario === 2 ? [
        { company_id: company.id, booking_id: booking.id, type: 'train', title: 'Vande Bharat connection', status: 'on_hold', supplier_name: 'Himalayan Ticket Desk', supplier_phone: '+91 98712 44110', origin: 'New Delhi', destination: 'Jammu Tawi', start_at: start, cost: 8400, confirmation_reference: 'HOLD-VB-208', created_by: member.user_id },
        { company_id: company.id, booking_id: booking.id, type: 'activity', title: 'Accessible Shikara sunset ride', status: 'confirmed', supplier_name: 'Valley Wings DMC', supplier_phone: '+91 99064 88770', destination: 'Dal Lake', start_at: `${booking.arrival_date}T17:00:00+05:30`, cost: 2400, confirmation_reference: 'SHK-4412', created_by: member.user_id }
      ] : [{ company_id: company.id, booking_id: booking.id, type: 'flight', title: 'Arrival flight', status: scenario === 3 ? 'reconfirmation_required' : 'ticketed', supplier_name: 'Himalayan Ticket Desk', supplier_phone: '+91 98712 44110', origin: 'Delhi', destination: booking.destination, start_at: start, cost: 18400, confirmation_reference: scenario === 3 ? 'CHANGED-SCHEDULE' : `PNR-${booking.booking_number.slice(-4)}`, created_by: member.user_id }]
      unwrap(await db.from('booking_services').insert(rows), 'insert demo services')
    }
    const transportStatus = scenario === 1 ? { driver_status: 'unassigned', confirmation_status: 'pending', driver_name: '', driver_phone: '' } : scenario === 3 ? { driver_status: 'assigned', confirmation_status: 'reconfirmation_required' } : { driver_status: 'confirmed', confirmation_status: 'confirmed', driver_confirmed_at: new Date().toISOString(), confirmation_reference: `CAB-${booking.booking_number.slice(-4)}` }
    unwrap(await db.from('booking_transport_days').update(transportStatus).eq('company_id', company.id).eq('booking_id', booking.id), 'set transport readiness')
    unwrap(await db.from('user_notifications').upsert({ company_id: company.id, user_id: member.user_id, booking_id: booking.id, type: scenario === 1 ? 'overdue' : 'task', title: scenario === 1 ? 'Booking needs documents and a driver' : 'Operations workspace ready', body: `${booking.client_name} · ${booking.booking_number}`, dedupe_key: `demo-operations:${booking.id}` }, { onConflict: 'company_id,user_id,dedupe_key' }), 'seed notification')
    results.push({ booking: booking.booking_number, client: booking.client_name, scenario })
  }
  console.log(JSON.stringify({ ok: true, company: company.name, bookings: results }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
