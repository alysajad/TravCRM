import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const unwrap = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data }
const addDays = (date, days) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }

function groupedStays(quote) {
  const groups = []
  for (const [index, night] of quote.stays.entries()) {
    const key = `${night.hotel_id}:${night.room_type_id || ''}`
    if (groups.at(-1)?.key === key) groups.at(-1).nights += 1
    else groups.push({ ...night, key, firstNight: index, nights: 1 })
  }
  return groups.map((stay, index) => ({ sequence: index + 1, hotel_id: stay.hotel_id, property_name: stay.name, property_type: stay.property_type || 'Hotel', room_type: stay.room_type, check_in: addDays(quote.arrival_date, stay.firstNight), check_out: addDays(quote.arrival_date, stay.firstNight + stay.nights), rooms: quote.rooms, extra_beds: quote.extra_beds, children_without_bed: quote.children_without_bed, meal_plan: 'MAPAI', supplier_cost: 0, inclusions: quote.inclusions }))
}

function documents(quote, stays, routes) {
  const common = { guest_name: quote.client_name, guest_phone: quote.phone, adults: quote.adults, children: quote.children, destination: quote.destination, booking_date: quote.booking_date }
  const result = stays.map(stay => ({ type: 'stay_voucher', stay_sequence: stay.sequence, payload: { ...common, hotel: stay.property_name, property_type: stay.property_type, check_in: stay.check_in, check_out: stay.check_out, rooms: stay.rooms, extra_beds: stay.extra_beds, children_without_bed: stay.children_without_bed, room_type: stay.room_type, meal_plan: stay.meal_plan, inclusions: stay.inclusions } }))
  if (routes.length) result.push({ type: 'cab_voucher', stay_sequence: null, payload: { ...common, start_date: routes[0].service_date, end_date: routes.at(-1).service_date, vehicle_type: routes[0].vehicle_type, vehicle_number: routes[0].vehicle_number, driver_name: routes[0].driver_name, driver_phone: routes[0].driver_phone, routes } })
  return result
}

async function main() {
  const company = unwrap(await db.from('companies').select('id,name').eq('slug', process.env.DEMO_COMPANY_SLUG || 'huzpoint').single(), 'find Huz company')
  const member = unwrap(await db.from('memberships').select('user_id').eq('company_id', company.id).eq('active', true).limit(1).single(), 'find Huz user')
  const cab = unwrap(await db.from('records').select('id,title,data').eq('company_id', company.id).eq('type', 'cab').eq('status', 'Active').limit(1).single(), 'find demo cab')
  const quotes = unwrap(await db.from('quotes').select('*').eq('company_id', company.id).in('client_name', ['Aisha Khan & Zaid','Rohit Sharma Family','Neha Kapoor','Arjun Mehta & Friends']).order('created_at'), 'find demo quotes')
  if (!quotes.length) throw new Error('Run scripts/seed-huz-demo.mjs before this booking seed.')
  const created = []
  for (const original of quotes) {
    const routes = original.itinerary.map((day, index) => ({ day: index + 1, service_date: addDays(original.arrival_date, index), destination: day.name, hotel: original.stays[Math.min(index, original.stays.length - 1)]?.name || '', cab_id: cab.id, vehicle_type: cab.data.type || cab.title, vehicle_number: cab.data.registration || '', driver_name: cab.data.driver_name || '', driver_phone: cab.data.driver_phone || '', pickup: index === 0 ? original.pickup : '', dropoff: index === original.days - 1 ? original.dropoff : '' }))
    const price = Number(original.base_amount) + Number(original.child_amount)
    unwrap(await db.from('quotes').update({ rooms: original.client_name.includes('Rohit') ? 2 : original.client_name.includes('Arjun') ? 3 : 1, extra_beds: original.client_name.includes('Rohit') ? 1 : 0, children_without_bed: original.client_name.includes('Rohit') ? 1 : 0, booking_date: original.created_at.slice(0, 10), assignee_id: member.user_id, pricing_mode: original.client_name.includes('Rohit') ? 'per_person' : 'total_package', price_lines: [{ category: 'package', label: `${original.destination} package`, quantity: 1, unit_amount: price, amount: price }], transport: { included: true, cab_id: cab.id, vehicle_type: cab.data.type || cab.title, vehicle_number: cab.data.registration || '', driver_name: cab.data.driver_name || '', driver_phone: cab.data.driver_phone || '', days: routes.map(({ destination, hotel, pickup, dropoff }) => ({ destination, hotel, pickup, dropoff })) } }).eq('company_id', company.id).eq('id', original.id), `prepare ${original.client_name}`)
    const quote = unwrap(await db.from('quotes').select('*').eq('id', original.id).single(), `reload ${original.client_name}`)
    const stays = groupedStays(quote)
    const snapshot = { ...quote, departure_date: addDays(quote.arrival_date, quote.days - 1), confirmed_at: new Date().toISOString() }
    const bookingId = unwrap(await db.rpc('apply_quote_booking', { p_company_id: company.id, p_quote_id: quote.id, p_actor_id: member.user_id, p_snapshot: snapshot, p_stays: stays, p_transport: routes, p_documents: documents(quote, stays, routes) }), `confirm ${quote.client_name}`)
    const status = quote.client_name === 'Neha Kapoor' ? 'completed' : quote.client_name.includes('Arjun') ? 'cancelled' : 'confirmed'
    unwrap(await db.from('bookings').update({ status }).eq('id', bookingId), `set ${quote.client_name} status`)
    const stayStatus = quote.client_name.includes('Rohit') ? 'pending' : 'confirmed'
    unwrap(await db.from('booking_stays').update({ confirmation_status: stayStatus, confirmation_reference: stayStatus === 'confirmed' ? `HUZ-DEMO-${quote.client_name.slice(0, 3).toUpperCase()}` : null }).eq('booking_id', bookingId), `set ${quote.client_name} hotels`)
    if (['Aisha Khan & Zaid','Neha Kapoor'].includes(quote.client_name)) unwrap(await db.from('booking_documents').update({ status: 'issued', issued_by: member.user_id, issued_at: new Date().toISOString() }).eq('booking_id', bookingId).eq('status', 'draft'), `issue ${quote.client_name} documents`)
    created.push({ client: quote.client_name, bookingId, status })
  }
  console.log(JSON.stringify({ ok: true, company: company.name, bookings: created }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
