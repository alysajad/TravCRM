import { createClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'

const SEED = 'huz-visual-demo-v1'
const companySlug = process.env.DEMO_COMPANY_SLUG || 'huzpoint'
const supabaseUrl = process.env.SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')

const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
const inserted = { recordIds: [], quoteIds: [], paymentIds: [], auditIds: [] }

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

function byTitle(rows) {
  return Object.fromEntries(rows.map(row => [row.title, row]))
}

function dated(daysFromNow) {
  const date = new Date('2026-10-17T00:00:00.000Z')
  date.setUTCDate(date.getUTCDate() + daysFromNow)
  return date.toISOString().slice(0, 10)
}

function quoteAmount(base, child = 0, discount = 0, gstPercent = 5) {
  const taxable = base + child - discount
  const gst = Math.round(taxable * gstPercent) / 100
  return { base_amount: base, child_amount: child, discount_amount: discount, gst_percent: gstPercent, gst_amount: gst, total_amount: taxable + gst }
}

async function uploadIfPresent(companyId, source, destination) {
  try {
    const bytes = await readFile(source)
    unwrap(await db.storage.from('crm-private').upload(destination, bytes, { contentType: 'image/png', upsert: true }), `upload ${destination}`)
    return destination
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function addRecords(companyId, userId, values) {
  const payload = values.map(({ created_at, ...value }) => ({
    ...value,
    company_id: companyId,
    created_by: userId,
    created_at: created_at || new Date().toISOString(),
    data: { ...(value.data || {}), demo_seed: SEED },
  }))
  const rows = unwrap(await db.from('records').insert(payload).select('*'), `insert ${values[0]?.type || 'records'}`)
  inserted.recordIds.push(...rows.map(row => row.id))
  return rows
}

async function cleanup(companyId) {
  if (inserted.paymentIds.length) await db.from('payments').delete().eq('company_id', companyId).in('id', inserted.paymentIds)
  if (inserted.quoteIds.length) await db.from('quotes').delete().eq('company_id', companyId).in('id', inserted.quoteIds)
  if (inserted.recordIds.length) await db.from('records').delete().eq('company_id', companyId).in('id', inserted.recordIds)
  if (inserted.auditIds.length) await db.from('audit_events').delete().eq('company_id', companyId).in('id', inserted.auditIds)
}

async function main() {
  const companies = unwrap(await db.from('companies').select('*').eq('slug', companySlug), 'find company')
  if (companies.length !== 1) throw new Error(`Expected exactly one company with slug ${companySlug}; found ${companies.length}.`)
  const company = companies[0]
  const members = unwrap(await db.from('memberships').select('*').eq('company_id', company.id).eq('active', true).limit(2), 'find company member')
  if (members.length !== 1) throw new Error(`Expected exactly one active Huz member; found ${members.length}.`)
  const userId = members[0].user_id

  const migrationProbe = await db.from('platform_settings').select('singleton').limit(1)
  const migrationApplied = !migrationProbe.error
  const currentSettings = unwrap(await db.from('company_settings').select('document_cover_path').eq('company_id', company.id).single(), 'find company settings')
  const logoPath = await uploadIfPresent(company.id, '/tmp/huz-logo.png', `${company.id}/branding/huz-travels-logo.png`)
  const signaturePath = await uploadIfPresent(company.id, '/tmp/huz-signature.png', `${company.id}/branding/authorised-signature.png`)
  const kashmirPath = await uploadIfPresent(company.id, '/tmp/huz-kashmir.png', `${company.id}/library/kashmir-demo.png`)
  const ladakhPath = await uploadIfPresent(company.id, '/tmp/huz-ladakh.png', `${company.id}/library/ladakh-demo.png`)
  const hotelPath = await uploadIfPresent(company.id, '/tmp/huz-hotel.png', `${company.id}/library/hotel-demo.png`)

  const settings = {
    brand_name: 'Huz Travels & Experiences',
    phone: '+91 99060 12345',
    email: 'hello@huztravels.demo',
    address: 'Boulevard Road, Dal Lake, Srinagar, Jammu & Kashmir 190001',
    gstin: '01ABCDE1234F1Z5',
    bank_details: 'Demo payment details: Huz Travels & Experiences | Account ending 4521 | IFSC HDFC0000123. For preview only.',
    document_color: '#C084FC',
    website: 'https://huztravels.demo',
    social_links: { instagram: '@huztravels.demo', facebook: 'Huz Travels Demo' },
    ...(logoPath ? { logo_path: logoPath } : {}),
  }
  if (migrationApplied) Object.assign(settings, {
    document_template: 'journey',
    ...(kashmirPath && !currentSettings.document_cover_path ? { document_cover_path: kashmirPath } : {}),
    document_secondary_color: '#A5D8FF',
    document_config: { sections: ['itinerary', 'accommodation', 'inclusions', 'exclusions', 'price', 'payment', 'terms'], labels: { document_title: 'Your Himalayan Journey', itinerary: 'Your day-by-day experience', accommodation: 'Handpicked stays' } },
    terms: 'Rates are valid for the dates shown and remain subject to availability until the booking advance is received. Hotel check-in and transport timings follow local operating conditions.',
    cancellation_policy: '30 days or more before arrival: 15% fee. 15–29 days: 35% fee. 7–14 days: 60% fee. Within 7 days: non-refundable. Supplier-specific rules may also apply.',
    company_footer: 'Crafted with care in Kashmir · Emergency support: +91 99060 12345',
    ...(signaturePath ? { signature_path: signaturePath } : {}),
  })
  unwrap(await db.from('company_settings').update(settings).eq('company_id', company.id).select('company_id').single(), 'update company branding')

  const existing = unwrap(await db.from('records').select('id,type,title').eq('company_id', company.id).eq('data->>demo_seed', SEED).limit(5), 'check existing demo')
  if (existing.length) {
    const [{ count: records }, { count: quotes }, { count: payments }] = await Promise.all([
      db.from('records').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
      db.from('quotes').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
      db.from('payments').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
    ])
    console.log(JSON.stringify({ ok: true, alreadySeeded: true, company: company.name, migrationApplied, records, quotes, payments }))
    return
  }

  const sources = byTitle(await addRecords(company.id, userId, [
    { type: 'lead_source', title: 'Instagram Lead Ads', status: 'Active', data: { name: 'Instagram Lead Ads' } },
    { type: 'lead_source', title: 'Website Enquiry', status: 'Active', data: { name: 'Website Enquiry' } },
    { type: 'lead_source', title: 'Referral Partner', status: 'Active', data: { name: 'Referral Partner' } },
    { type: 'lead_source', title: 'Repeat Guest', status: 'Active', data: { name: 'Repeat Guest' } },
  ]))

  const hotelCategories = byTitle(await addRecords(company.id, userId, [
    { type: 'hotel_category', title: 'Boutique 4-star', status: 'Active', data: { name: 'Boutique 4-star' } },
    { type: 'hotel_category', title: 'Luxury 5-star', status: 'Active', data: { name: 'Luxury 5-star' } },
    { type: 'hotel_category', title: 'Premium houseboat', status: 'Active', data: { name: 'Premium houseboat' } },
  ]))

  const roomTypes = byTitle(await addRecords(company.id, userId, [
    { type: 'room_type', title: 'Deluxe Room', status: 'Active', data: { name: 'Deluxe Room' } },
    { type: 'room_type', title: 'Premium Valley View', status: 'Active', data: { name: 'Premium Valley View' } },
    { type: 'room_type', title: 'Family Suite', status: 'Active', data: { name: 'Family Suite' } },
  ]))

  const dayPlanValues = [
    ['Srinagar arrival & Shikara welcome', 'Private airport welcome, relaxed hotel check-in, sunset Shikara ride across Dal Lake, and time at the floating market.'],
    ['Srinagar heritage & Mughal gardens', 'Visit Nishat Bagh, Shalimar Bagh, Pari Mahal, Hazratbal shrine, and the old-city craft quarter with a local host.'],
    ['Gulmarg Gondola & alpine day', 'Scenic drive to Gulmarg, phase-one Gondola tickets, meadow walk, and a warming Kashmiri lunch before returning to the hotel.'],
    ['Pahalgam valleys excursion', 'Explore Aru, Betaab, and Chandanwari valleys by local union vehicle, with riverside photo stops and an easy evening.'],
    ['Sonamarg glacier trail', 'Full-day drive along the Sindh River, pony or local-cab option toward Thajiwas Glacier, and tea beside the meadows.'],
    ['Houseboat evening & local food walk', 'Check in to a premium houseboat, enjoy kahwa on deck, and join an optional guided tasting walk through Srinagar.'],
    ['Kashmir departure', 'Breakfast, assisted checkout, last-minute shopping when time permits, and private transfer to Srinagar Airport.'],
    ['Leh arrival & acclimatisation', 'Airport pickup, complete rest for altitude acclimatisation, an evening orientation, and hydration briefing.'],
    ['Leh monasteries & Indus valley', 'Visit Thiksey, Shey Palace, Rancho School, Sindhu Ghat, and Shanti Stupa with a private guide.'],
    ['Nubra via Khardung La', 'Cross Khardung La into Nubra Valley, visit Diskit Monastery, and enjoy the Hunder dunes at sunset.'],
    ['Pangong Lake expedition', 'Drive via Shyok to Pangong Lake, settle into a lakeside camp, and watch the changing colours at dusk.'],
    ['Leh market & departure', 'Return through Chang La, free time in Leh market, and an assisted airport departure the next morning.'],
  ].map(([name, description], index) => ({ type: 'day_plan', title: name, status: 'Active', data: { name, description, image_path: index < 7 ? kashmirPath : ladakhPath } }))
  const dayPlans = byTitle(await addRecords(company.id, userId, dayPlanValues))

  const hotels = byTitle(await addRecords(company.id, userId, [
    { type: 'hotel', title: 'The Chinar Retreat', status: 'Active', data: { name: 'The Chinar Retreat', category_id: hotelCategories['Boutique 4-star'].id, location: 'Srinagar', rating: 4.4, price: 6500, property_type: 'Hotel', image_path: hotelPath } },
    { type: 'hotel', title: 'Gulmarg Alpine Lodge', status: 'Active', data: { name: 'Gulmarg Alpine Lodge', category_id: hotelCategories['Luxury 5-star'].id, location: 'Gulmarg', rating: 4.7, price: 11000, property_type: 'Hotel', image_path: hotelPath } },
    { type: 'hotel', title: 'Pahalgam Riverside Resort', status: 'Active', data: { name: 'Pahalgam Riverside Resort', category_id: hotelCategories['Boutique 4-star'].id, location: 'Pahalgam', rating: 4.5, price: 8500, property_type: 'Hotel', image_path: hotelPath } },
    { type: 'hotel', title: 'Noor Palace Houseboat', status: 'Active', data: { name: 'Noor Palace Houseboat', category_id: hotelCategories['Premium houseboat'].id, location: 'Dal Lake, Srinagar', rating: 4.6, price: 7200, property_type: 'Houseboat', image_path: hotelPath } },
    { type: 'hotel', title: 'Leh Horizon Hotel', status: 'Active', data: { name: 'Leh Horizon Hotel', category_id: hotelCategories['Boutique 4-star'].id, location: 'Leh', rating: 4.3, price: 7800, property_type: 'Hotel', image_path: hotelPath } },
  ]))

  const cabs = byTitle(await addRecords(company.id, userId, [
    { type: 'cab', title: 'Toyota Innova Crysta · JK01 AB 4821', status: 'Active', data: { name: 'Toyota Innova Crysta', registration: 'JK01 AB 4821', type: 'SUV', seats: 6, price: 6500, driver_name: 'Yasir Mir', driver_phone: '+91 94190 23456' } },
    { type: 'cab', title: 'Tempo Traveller · JK01 T 9012', status: 'Active', data: { name: 'Tempo Traveller', registration: 'JK01 T 9012', type: 'Traveller', seats: 12, price: 10500, driver_name: 'Bilal Dar', driver_phone: '+91 97971 45678' } },
    { type: 'cab', title: 'Swift Dzire · JK01 C 7755', status: 'Active', data: { name: 'Swift Dzire', registration: 'JK01 C 7755', type: 'Sedan', seats: 4, price: 4200, driver_name: 'Aamir Lone', driver_phone: '+91 70068 11223' } },
  ]))

  await addRecords(company.id, userId, [
    { type: 'partner', title: 'Valley Wings DMC', status: 'Active', data: { name: 'Valley Wings DMC', phone: '+91 99064 88770', email: 'ops@valleywings.demo', notes: 'Ground handling and emergency transport support.' } },
    { type: 'partner', title: 'Himalayan Ticket Desk', status: 'Active', data: { name: 'Himalayan Ticket Desk', phone: '+91 98712 44110', email: 'desk@himalayantickets.demo', notes: 'Demo flight and Gondola ticket supplier.' } },
    { type: 'voucher_inclusion', title: 'Breakfast and dinner', status: 'Active', data: { name: 'Breakfast and dinner', description: 'Daily breakfast and dinner at the booked hotel unless stated otherwise.' } },
    { type: 'voucher_inclusion', title: 'Private sightseeing vehicle', status: 'Active', data: { name: 'Private sightseeing vehicle', description: 'Private vehicle for the itinerary, excluding local union vehicles.' } },
    { type: 'other_catalog', title: 'Gulmarg Gondola Phase 1', status: 'Active', data: { name: 'Gulmarg Gondola Phase 1', category: 'Tickets', price: 1200, notes: 'Per-person demo price.' } },
    { type: 'other_catalog', title: 'Anniversary room decoration', status: 'Active', data: { name: 'Anniversary room decoration', category: 'Experience', price: 4500, notes: 'Flowers, cake, and candlelight setup.' } },
  ])

  const scenarios = [
    { key: 'aisha', name: 'Aisha Khan & Zaid', phone: '+91 98765 11001', email: 'aisha.khan@demo.travcrm.test', address: 'Bandra West, Mumbai', source: 'Instagram Lead Ads', queryStatus: 'Confirmed', quoteStatus: 'Confirmed', destination: 'Srinagar · Gulmarg · Pahalgam', days: 6, adults: 2, children: 0, arrival: dated(25), notes: 'Honeymoon. Vegetarian meals. Anniversary decoration on night two.', plans: ['Srinagar arrival & Shikara welcome','Srinagar heritage & Mughal gardens','Gulmarg Gondola & alpine day','Pahalgam valleys excursion','Houseboat evening & local food walk','Kashmir departure'], stays: [['The Chinar Retreat','Premium Valley View'],['The Chinar Retreat','Premium Valley View'],['Gulmarg Alpine Lodge','Premium Valley View'],['Pahalgam Riverside Resort','Premium Valley View'],['Noor Palace Houseboat','Deluxe Room']], amount: quoteAmount(92000,0,5000), created: '2026-10-05T10:00:00Z' },
    { key: 'rohit', name: 'Rohit Sharma Family', phone: '+91 98765 11002', email: 'rohit.sharma@demo.travcrm.test', address: 'Gurugram, Haryana', source: 'Website Enquiry', queryStatus: 'Quoted', quoteStatus: 'Quoted', destination: 'Kashmir Family Escape', days: 7, adults: 4, children: 2, arrival: dated(45), notes: 'Family with two children aged 6 and 10. Interconnecting rooms preferred.', plans: ['Srinagar arrival & Shikara welcome','Srinagar heritage & Mughal gardens','Gulmarg Gondola & alpine day','Sonamarg glacier trail','Pahalgam valleys excursion','Houseboat evening & local food walk','Kashmir departure'], stays: [['The Chinar Retreat','Family Suite'],['The Chinar Retreat','Family Suite'],['Gulmarg Alpine Lodge','Family Suite'],['The Chinar Retreat','Family Suite'],['Pahalgam Riverside Resort','Family Suite'],['Noor Palace Houseboat','Family Suite']], amount: quoteAmount(128000,18000,8000), created: '2026-10-09T08:30:00Z' },
    { key: 'meera', name: 'Meera & Suresh Iyer', phone: '+91 98765 11003', email: 'meera.iyer@demo.travcrm.test', address: 'Indiranagar, Bengaluru', source: 'Referral Partner', queryStatus: 'Contacted', quoteStatus: 'Draft', destination: 'Relaxed Kashmir for Seniors', days: 5, adults: 2, children: 0, arrival: dated(70), notes: 'Senior travellers. Avoid stairs, long walks, and early departures. Ground-floor rooms required.', plans: ['Srinagar arrival & Shikara welcome','Srinagar heritage & Mughal gardens','Gulmarg Gondola & alpine day','Houseboat evening & local food walk','Kashmir departure'], stays: [['The Chinar Retreat','Deluxe Room'],['The Chinar Retreat','Deluxe Room'],['Gulmarg Alpine Lodge','Deluxe Room'],['Noor Palace Houseboat','Deluxe Room']], amount: quoteAmount(76000,0,2000), created: '2026-10-13T12:20:00Z' },
    { key: 'arjun', name: 'Arjun Mehta & Friends', phone: '+91 98765 11004', email: 'arjun.mehta@demo.travcrm.test', address: 'Pune, Maharashtra', source: 'Instagram Lead Ads', queryStatus: 'Interested', quoteStatus: 'Pending', destination: 'Leh · Nubra · Pangong', days: 7, adults: 8, children: 0, arrival: dated(110), notes: 'Group of friends. Two triple rooms and one twin. Interested in photography stops.', plans: ['Leh arrival & acclimatisation','Leh monasteries & Indus valley','Nubra via Khardung La','Pangong Lake expedition','Pangong Lake expedition','Leh market & departure','Leh market & departure'], stays: [['Leh Horizon Hotel','Premium Valley View'],['Leh Horizon Hotel','Premium Valley View'],['Leh Horizon Hotel','Family Suite'],['Leh Horizon Hotel','Family Suite'],['Leh Horizon Hotel','Family Suite'],['Leh Horizon Hotel','Premium Valley View']], amount: quoteAmount(198000,0,10000), created: '2026-10-14T09:15:00Z' },
    { key: 'neha', name: 'Neha Kapoor', phone: '+91 98765 11005', email: 'neha.kapoor@demo.travcrm.test', address: 'South Delhi', source: 'Repeat Guest', queryStatus: 'Completed', quoteStatus: 'Completed', destination: 'Kashmir Solo Retreat', days: 5, adults: 1, children: 0, arrival: dated(-50), notes: 'Completed solo trip. Airport assistance and female local guide requested.', plans: ['Srinagar arrival & Shikara welcome','Srinagar heritage & Mughal gardens','Gulmarg Gondola & alpine day','Houseboat evening & local food walk','Kashmir departure'], stays: [['The Chinar Retreat','Deluxe Room'],['The Chinar Retreat','Deluxe Room'],['Gulmarg Alpine Lodge','Deluxe Room'],['Noor Palace Houseboat','Deluxe Room']], amount: quoteAmount(65000,0,5000), created: '2026-08-08T07:40:00Z' },
    { key: 'omar', name: 'Omar Abdullah', phone: '+91 98765 11006', email: 'omar.abdullah@demo.travcrm.test', address: 'Lucknow, Uttar Pradesh', source: 'Website Enquiry', queryStatus: 'Cancelled', quoteStatus: 'Cancelled', destination: 'Kashmir Short Break', days: 4, adults: 2, children: 1, arrival: dated(18), notes: 'Cancelled after flight schedule changed. Keep record for pipeline and conversion reporting.', plans: ['Srinagar arrival & Shikara welcome','Gulmarg Gondola & alpine day','Srinagar heritage & Mughal gardens','Kashmir departure'], stays: [['The Chinar Retreat','Deluxe Room'],['Gulmarg Alpine Lodge','Deluxe Room'],['The Chinar Retreat','Deluxe Room']], amount: quoteAmount(58000,8000,3000), created: '2026-09-28T15:10:00Z' },
  ]

  const clients = byTitle(await addRecords(company.id, userId, scenarios.map(s => ({ type: 'client', title: s.name, status: s.quoteStatus === 'Cancelled' ? 'Inactive' : 'Active', created_at: s.created, data: { name: s.name, phone: s.phone, email: s.email, address: s.address, segment: s.key === 'neha' ? 'Repeat guest' : 'Demo traveller' } }))))
  void clients

  const leads = await addRecords(company.id, userId, scenarios.map((s, index) => ({ type: 'lead', title: s.name, status: index < 5 ? 'Converted' : 'Closed', created_at: s.created, data: { name: s.name, phone: s.phone, email: s.email, page: s.source === 'Website Enquiry' ? 'Website trip planner' : s.source, received_at: s.created.slice(0, 10), notes: s.notes, external_id: `DEMO-${String(index + 1).padStart(3, '0')}` } })))

  const queries = await addRecords(company.id, userId, scenarios.map((s, index) => ({ type: 'query', title: s.name, status: s.queryStatus, created_at: s.created, data: { client_name: s.name, phone: s.phone, email: s.email, arrival_date: s.arrival, destination: s.destination, adults: s.adults, children: s.children, days: s.days, source_id: sources[s.source].id, assignee_id: userId, notes: s.notes, source_lead_id: leads[index].id } })))
  for (let i = 0; i < leads.length; i += 1) {
    const updated = { ...leads[i].data, converted_query_id: queries[i].id }
    unwrap(await db.from('records').update({ data: updated }).eq('id', leads[i].id).eq('company_id', company.id), `link lead ${i + 1}`)
  }

  const quotePayload = scenarios.map((s, index) => ({
    company_id: company.id,
    query_id: queries[index].id,
    client_name: s.name,
    email: s.email,
    phone: s.phone,
    status: s.quoteStatus,
    destination: s.destination,
    days: s.days,
    adults: s.adults,
    children: s.children,
    arrival_date: s.arrival,
    pickup: s.key === 'arjun' ? 'Leh Airport' : 'Srinagar Airport',
    dropoff: s.key === 'arjun' ? 'Leh Airport' : 'Srinagar Airport',
    flights: s.key === 'aisha' ? '6E 2142 arrival 11:20 · 6E 235 departure 14:10' : s.key === 'neha' ? 'AI 827 arrival 09:45 · AI 828 departure 16:30' : 'Flight details awaited',
    itinerary: s.plans.map((name, day) => ({ day: day + 1, day_plan_id: dayPlans[name]?.id, name, description: dayPlans[name]?.data.description })),
    stays: s.stays.map(([name, room], night) => ({ night: night + 1, hotel_id: hotels[name].id, name, room_type_id: roomTypes[room].id, room_type: room })),
    inclusions: 'Accommodation with breakfast and dinner; private airport transfers; private sightseeing vehicle; tolls, parking, driver allowance; 24×7 trip support; Shikara ride where listed.',
    exclusions: 'Airfare; personal expenses; pony rides; local union vehicles in Pahalgam/Sonamarg; activities not listed; travel insurance; costs caused by weather or road closure.',
    ...s.amount,
    created_by: userId,
    created_at: s.created,
    updated_at: s.created,
  }))
  const quotes = unwrap(await db.from('quotes').insert(quotePayload).select('*'), 'insert demo quotations')
  inserted.quoteIds.push(...quotes.map(row => row.id))

  const payments = unwrap(await db.from('payments').insert([
    { company_id: company.id, quote_id: quotes[0].id, amount: 45000, paid_at: '2026-10-15', method: 'UPI', reference: 'DEMO-UPI-AISHA-45000', notes: 'Booking advance received. Demo transaction.', created_by: userId },
    { company_id: company.id, quote_id: quotes[4].id, amount: quotes[4].total_amount, paid_at: '2026-09-05', method: 'Bank transfer', reference: 'DEMO-NEFT-NEHA-FULL', notes: 'Final balance settled. Demo transaction.', created_by: userId },
  ]).select('*'), 'insert payments')
  inserted.paymentIds.push(...payments.map(row => row.id))

  const invoiceData = (client, quote, lines, issueDate, gst = 5) => {
    const items = lines.map(([description, quantity, rate]) => ({ description, quantity, rate, amount: quantity * rate }))
    const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
    const gstAmount = Math.round(subtotal * gst) / 100
    return { client_name: client, quote_id: quote.id, gstin: '01ABCDE1234F1Z5', issue_date: issueDate, items: lines.map(line => line.join(' | ')).join('\n'), items_parsed: items, subtotal, gst_percent: gst, gst_amount: gstAmount, total: subtotal + gstAmount }
  }

  await addRecords(company.id, userId, [
    { type: 'follow_up', title: 'Confirm Gondola tickets · Aisha Khan', status: 'Pending', data: { subject: 'Confirm Gondola tickets and anniversary setup', query_id: queries[0].id, quote_id: quotes[0].id, due_date: dated(2), notes: 'Call hotel and send final confirmation to the couple.' } },
    { type: 'follow_up', title: 'Family quotation decision · Rohit Sharma', status: 'Overdue', data: { subject: 'Check family quotation decision', query_id: queries[1].id, quote_id: quotes[1].id, due_date: dated(-2), notes: 'Offer alternate hotel if the family suite is unavailable.' } },
    { type: 'follow_up', title: 'Accessibility call · Meera Iyer', status: 'Pending', data: { subject: 'Discuss mobility and room access', query_id: queries[2].id, quote_id: quotes[2].id, due_date: dated(1), notes: 'Confirm lift access and walking limits before revising the draft.' } },
    { type: 'follow_up', title: 'Group budget review · Arjun Mehta', status: 'Pending', data: { subject: 'Review group budget and rooming', query_id: queries[3].id, quote_id: quotes[3].id, due_date: dated(5), notes: 'Request traveller ID details only after confirmation.' } },
    { type: 'follow_up', title: 'Post-trip feedback · Neha Kapoor', status: 'Completed', data: { subject: 'Collect review and referral', query_id: queries[4].id, quote_id: quotes[4].id, due_date: dated(-42), notes: 'Five-star feedback received. Customer opted into future offers.' } },
    { type: 'invoice', title: 'Aisha Khan & Zaid', status: 'Issued', data: invoiceData(scenarios[0].name, quotes[0], [['Kashmir honeymoon package',1,87000]], '2026-10-15') },
    { type: 'invoice', title: 'Neha Kapoor', status: 'Paid', data: invoiceData(scenarios[4].name, quotes[4], [['Kashmir solo retreat',1,60000]], '2026-09-05') },
    { type: 'stay_voucher', title: 'Aisha Khan · The Chinar Retreat', status: 'Issued', data: { guest_name: scenarios[0].name, guest_phone: scenarios[0].phone, quote_id: quotes[0].id, hotel_id: hotels['The Chinar Retreat'].id, check_in: scenarios[0].arrival, check_out: dated(27), meal_plan: 'MAP · breakfast and dinner', rooms: '1 Premium Valley View room · double occupancy', cost: 26000, inclusions: 'Welcome kahwa, breakfast, dinner, anniversary room decoration, all hotel taxes.' } },
    { type: 'stay_voucher', title: 'Neha Kapoor · Noor Palace Houseboat', status: 'Completed', data: { guest_name: scenarios[4].name, guest_phone: scenarios[4].phone, quote_id: quotes[4].id, hotel_id: hotels['Noor Palace Houseboat'].id, check_in: dated(-47), check_out: dated(-46), meal_plan: 'MAP · breakfast and dinner', rooms: '1 Deluxe room · single occupancy', cost: 7200, inclusions: 'Welcome kahwa, breakfast, dinner, one-hour Shikara ride.' } },
    { type: 'cab_voucher', title: 'Aisha Khan · Innova Crysta', status: 'Issued', data: { guest_name: scenarios[0].name, guest_phone: scenarios[0].phone, quote_id: quotes[0].id, cab_id: cabs['Toyota Innova Crysta · JK01 AB 4821'].id, start_date: scenarios[0].arrival, end_date: dated(30), pickup: 'Srinagar Airport arrivals', dropoff: 'Srinagar Airport departures', cost: 32500, driver_name: 'Yasir Mir', driver_phone: '+91 94190 23456' } },
    { type: 'cab_voucher', title: 'Arjun Mehta Group · Tempo Traveller', status: 'Provisional', data: { guest_name: scenarios[3].name, guest_phone: scenarios[3].phone, quote_id: quotes[3].id, cab_id: cabs['Tempo Traveller · JK01 T 9012'].id, start_date: scenarios[3].arrival, end_date: dated(116), pickup: 'Leh Airport arrivals', dropoff: 'Leh Airport departures', cost: 73500, driver_name: 'Bilal Dar', driver_phone: '+91 97971 45678' } },
    { type: 'expense', title: 'Gulmarg Gondola ticket advance', status: 'Paid', data: { description: 'Gondola phase-one ticket block for confirmed departures', amount: 9600, date: '2026-10-16', payment_type: 'UPI', remark: 'Demo operating expense · 8 tickets.' } },
    { type: 'expense', title: 'Welcome hamper supplies', status: 'Paid', data: { description: 'Kahwa, dry-fruit boxes, and printed welcome cards', amount: 4250, date: '2026-10-14', payment_type: 'Cash', remark: 'Demo expense for October arrivals.' } },
    { type: 'hotel_payment', title: 'Advance · The Chinar Retreat', status: 'Paid', data: { reference: 'DEMO-HOTEL-ADV-101', hotel_id: hotels['The Chinar Retreat'].id, amount: 18000, date: '2026-10-16', method: 'Bank transfer', notes: 'Advance for Aisha booking. Demo transaction.' } },
    { type: 'hotel_payment', title: 'Settlement · Noor Palace Houseboat', status: 'Paid', data: { reference: 'DEMO-HB-SETTLE-204', hotel_id: hotels['Noor Palace Houseboat'].id, amount: 7200, date: '2026-09-01', method: 'UPI', notes: 'Neha Kapoor stay settlement. Demo transaction.' } },
  ])

  const audit = unwrap(await db.from('audit_events').insert({ company_id: company.id, actor_id: userId, action: 'demo.seed', details: { seed: SEED, scenarios: scenarios.length, note: 'Visual testing dataset created at the workspace owner request.' } }).select('id').single(), 'write demo audit event')
  inserted.auditIds.push(audit.id)

  const [{ count: recordCount }, { count: quoteCount }, { count: paymentCount }] = await Promise.all([
    db.from('records').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
    db.from('quotes').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
    db.from('payments').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
  ])
  console.log(JSON.stringify({ ok: true, company: company.name, companyId: company.id, migrationApplied, recordCount, quoteCount, paymentCount, customers: scenarios.map(s => ({ name: s.name, stage: s.quoteStatus })) }))
}

main().catch(async error => {
  const company = await db.from('companies').select('id').eq('slug', companySlug).maybeSingle()
  if (company.data?.id) await cleanup(company.data.id)
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
