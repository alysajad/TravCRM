import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { modules, validateRecord } from './modules.js'

process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_ANON_KEY ||= 'test-publishable-key'
process.env.SUPABASE_SECRET_KEY ||= 'test-secret-key'
const { priceQuote } = await import('./quotes.js')
const { quotePdf } = await import('./pdf.js')
const { groupBookingStays } = await import('./bookings.js')
const { mergeEntitlements } = await import('./core.js')
const { operationLocalTime } = await import('./operations.js')
const { normalizeEmail, normalizePhone, matchClientContacts, latestTimeline } = await import('./clients.js')
const { normalizeCatalogText, seasonForMonth } = await import('./catalog.js')
const { contributionSnapshot } = await import('./catalog-governance.js')

test('travel catalog has stable unique keys and the promised regional counts', async () => {
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../../../catalog/${name}.json`, import.meta.url), 'utf8')) as Array<Record<string, any>>
  const [locations, templates, hotels] = await Promise.all([read('locations'), read('itinerary-templates'), read('hotels')])
  assert.equal(new Set(locations.map(row => row.catalog_key)).size, locations.length)
  assert.equal(new Set(hotels.map(row => row.catalog_key)).size, 500)
  const propertyKeys = hotels.map(row => `${normalizeCatalogText(row.canonical_name)}|${row.location_id}`)
  assert.equal(new Set(propertyKeys).size, 500)
  assert.ok(hotels.every(row => !/\b\d{3}$/.test(row.canonical_name)))
  assert.ok(hotels.every(row => /^https:\/\//.test(row.source_url) && /^\d{4}-\d{2}-\d{2}$/.test(row.verified_on)))
  assert.equal(hotels.filter(row => row.region === 'Kashmir').length, 400)
  assert.equal(hotels.filter(row => row.region === 'Ladakh').length, 100)
  assert.deepEqual({
    srinagar: hotels.filter(row => row.location_id === 'srinagar').length,
    pahalgam: hotels.filter(row => row.location_id === 'pahalgam').length,
    gulmarg_tangmarg: hotels.filter(row => ['gulmarg','tangmarg'].includes(row.location_id)).length,
    sonamarg_ganderbal: hotels.filter(row => ['sonamarg','ganderbal'].includes(row.location_id)).length,
    kashmir_other: hotels.filter(row => row.region === 'Kashmir' && !['srinagar','pahalgam','gulmarg','tangmarg','sonamarg','ganderbal'].includes(row.location_id)).length
  }, { srinagar: 210, pahalgam: 65, gulmarg_tangmarg: 40, sonamarg_ganderbal: 30, kashmir_other: 55 })
  assert.deepEqual({
    leh: hotels.filter(row => row.location_id === 'leh').length,
    nubra_turtuk: hotels.filter(row => ['nubra','turtuk'].includes(row.location_id)).length,
    pangong: hotels.filter(row => row.location_id === 'pangong').length,
    kargil_drass: hotels.filter(row => ['kargil','drass'].includes(row.location_id)).length,
    ladakh_other: hotels.filter(row => row.region === 'Ladakh' && !['leh','nubra','turtuk','pangong','kargil','drass'].includes(row.location_id)).length
  }, { leh: 55, nubra_turtuk: 20, pangong: 8, kargil_drass: 10, ladakh_other: 7 })
  assert.ok(locations.find(row => row.catalog_key === 'sonamarg')?.aliases.includes('Sonmarg'))
  assert.ok(locations.find(row => row.catalog_key === 'pahalgam')?.aliases.includes('Pahalgham'))
  assert.deepEqual(Object.fromEntries(['Kashmir','Ladakh','Combined'].map(region => [region, templates.filter(row => row.region === region).length])), { Kashmir: 27, Ladakh: 9, Combined: 4 })
  assert.ok(templates.every(row => row.days.length === row.duration))
  assert.ok(templates.filter(row => row.duration === 7).every(row => row.days.length === 7))
  assert.ok(templates.filter(row => row.duration === 7).every(row => row.days.slice(0, -1).filter((day: Record<string, any>) => day.overnight_location_id).length === 6))
  assert.equal(normalizeCatalogText('Pahalgham'), 'pahalgham')
  assert.equal(seasonForMonth(12), 'winter')
  assert.equal(seasonForMonth(7), 'summer')
  assert.equal(seasonForMonth(9), 'autumn')
})

test('catalog contribution snapshots exclude tenant-private hotel fields', () => {
  assert.deepEqual(contributionSnapshot({ type: 'hotel', title: 'Alpine House', data: { name: 'Alpine House', location: 'Gulmarg', location_id: 'location-id', property_type: 'Hotel', price: 9999, negotiated_rate: 7500, contact_name: 'Private supplier', notes: 'Private note', image_path: 'company/photo.jpg' } }), {
    name: 'Alpine House', location: 'Gulmarg', location_id: 'location-id', property_type: 'Hotel'
  })
})

test('catalog governance migration backfills stable source ids and defaults to global access', async () => {
  const migration = await readFile(new URL('../../../supabase/migrations/0010_platform_managed_catalog.sql', import.meta.url), 'utf8')
  assert.match(migration, /availability_mode text not null default 'all'/)
  assert.match(migration, /select id,'hotel',id/)
  assert.match(migration, /source_url drop not null/)
  assert.match(migration, /unique index catalog_submissions_one_pending_idx/)
})

test('quotation totals use cents and apply GST after discount', () => {
  assert.deepEqual(priceQuote(1000, 200, 100, 5), { gst_amount: 55, total_amount: 1155 })
  assert.deepEqual(priceQuote(10.1, 0.2, 0.1, 18), { gst_amount: 1.84, total_amount: 12.04 })
  assert.throws(() => priceQuote(10, 0, 11, 5), /Discount cannot exceed/)
})

test('booking stay segments merge consecutive nights at the same property', () => {
  const stays = groupBookingStays({ arrival_date: '2026-11-10', rooms: 2, extra_beds: 1, children_without_bed: 1, inclusions: 'Breakfast', stays: [
    { hotel_id: 'a', name: 'Lake Hotel', room_type_id: 'deluxe', room_type: 'Deluxe' },
    { hotel_id: 'a', name: 'Lake Hotel', room_type_id: 'deluxe', room_type: 'Deluxe' },
    { hotel_id: 'b', name: 'Mountain Camp', room_type_id: 'tent', room_type: 'Tent' }
  ] })
  assert.equal(stays.length, 2)
  assert.deepEqual(stays.map(x => [x.check_in, x.check_out]), [['2026-11-10','2026-11-12'], ['2026-11-12','2026-11-13']])
  assert.equal(stays[0]!.rooms, 2)
})

test('operation deadlines respect the company timezone', () => {
  assert.equal(operationLocalTime('2026-11-10', 9, 'Asia/Kolkata'), '2026-11-10T03:30:00.000Z')
  assert.equal(operationLocalTime('2026-07-10', 9, 'Europe/London'), '2026-07-10T08:00:00.000Z')
})

test('company plan overrides can add and remove features and replace limits', () => {
  const value = mergeEntitlements(['crm','finance'], { team_members: 3, quotes_monthly: 100 }, { finance: false, integrations: true }, { team_members: 8 })
  assert.deepEqual(value.features.sort(), ['crm','integrations'])
  assert.deepEqual(value.limits, { team_members: 8, quotes_monthly: 100 })
})

test('query validation accepts reviewable contacts and keeps known fields', () => {
  assert.deepEqual(validateRecord(modules.queries!, { client_name: 'A' }), { title: 'A', status: 'Pending', data: { client_name: 'A' } })
  assert.deepEqual(validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', status: 'Pending', notes: 'Call tomorrow', unexpected: 'discard' }), { title: 'A', status: 'Pending', data: { client_name: 'A', phone: '1234567', notes: 'Call tomorrow' } })
  assert.throws(() => validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', status: 'Invalid' }), /Status is invalid/)
  assert.throws(() => validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', arrival_date: '2026-02-31' }), /Expected arrival is invalid/)
})

test('customer contact normalization and matching are conservative', () => {
  assert.equal(normalizeEmail('  PERSON@Example.COM '), 'person@example.com')
  assert.equal(normalizePhone('+91 (987) 654-3210'), '919876543210')
  const clients = [
    { id: 'a', data: { email_normalized: 'a@example.com', phone_normalized: '1111111' } },
    { id: 'b', data: { email_normalized: 'b@example.com', phone_normalized: '2222222' } },
    { id: 'c', data: { email_normalized: 'duplicate@example.com', phone_normalized: '3333333' } },
    { id: 'd', data: { email_normalized: 'duplicate@example.com', phone_normalized: '4444444' } }
  ]
  assert.deepEqual(matchClientContacts(clients, ' A@example.com ', ''), { outcome: 'unique', clientId: 'a' })
  assert.deepEqual(matchClientContacts(clients, 'new@example.com', '9999999'), { outcome: 'none', clientId: null })
  assert.deepEqual(matchClientContacts(clients, 'duplicate@example.com', ''), { outcome: 'conflict', clientId: null })
  assert.deepEqual(matchClientContacts(clients, 'a@example.com', '2222222'), { outcome: 'conflict', clientId: null })
  assert.deepEqual(matchClientContacts(clients, '', ''), { outcome: 'missing', clientId: null })
})

test('customer timeline is reverse chronological and capped at 100', () => {
  const entries = Array.from({ length: 105 }, (_, index) => ({ id: index, occurred_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }))
  const result = latestTimeline(entries)
  assert.equal(result.length, 100)
  assert.equal(result[0]!.id, 104)
  assert.equal(result.at(-1)!.id, 5)
})

test('quotation PDF renders company branding and Indian-script client details', async () => {
  const bytes = await quotePdf({ id: '12345678-0000-0000-0000-000000000000', client_name: 'राहुल', destination: 'कश्मीर', adults: 2, children: 0, days: 1, nights: 0, itinerary: [{ day: 1, name: 'आगमन', description: 'Welcome to Kashmir' }], stays: [], base_amount: 100, child_amount: 0, discount_amount: 0, gst_percent: 5, gst_amount: 5, total_amount: 105 }, { brand_name: 'Huz Travel', document_color: '#168d9c' }, 'Travel company')
  const document = await PDFDocument.load(bytes)
  assert.equal(document.getPageCount(), 1)
  assert.ok(bytes.length > 1000)
})

test('visual itinerary templates render without external images', async () => {
  const quote = { id: '12345678-0000-0000-0000-000000000000', client_name: 'Aisha Khan', destination: 'Kashmir', adults: 2, children: 0, days: 2, nights: 1, arrival_date: '2026-11-11', pickup: 'Srinagar Airport', itinerary: [{ day: 1, name: 'Arrival and Shikara welcome', description: 'Private airport pickup, hotel check-in, and a sunset Shikara ride on Dal Lake.' }, { day: 2, name: 'Gulmarg alpine day', description: 'A scenic mountain drive, Gondola experience, meadow walk, and return transfer.' }], stays: [{ night: 1, name: 'The Chinar Retreat', room_type: 'Deluxe Room' }], inclusions: 'Hotel, breakfast, dinner, and private transfers.', exclusions: 'Flights and personal expenses.', base_amount: 50000, child_amount: 0, discount_amount: 1000, gst_percent: 5, gst_amount: 2450, total_amount: 51450 }
  for (const document_template of ['journey','expedition','brochure']) {
    const bytes = await quotePdf(quote, { brand_name: 'Huz Travels', document_template, document_color: '#C084FC', document_secondary_color: '#A5D8FF' }, 'Travel company')
    const document = await PDFDocument.load(bytes)
    assert.ok(document.getPageCount() >= 2, `${document_template} should render itinerary and detail pages`)
    assert.ok(bytes.length > 1000)
  }
})
