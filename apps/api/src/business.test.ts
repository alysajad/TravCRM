import test from 'node:test'
import assert from 'node:assert/strict'
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
