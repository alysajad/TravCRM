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

test('query validation requires customer contact and keeps known fields', () => {
  assert.throws(() => validateRecord(modules.queries!, { client_name: 'A' }), /Phone is required/)
  assert.deepEqual(validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', status: 'Pending', notes: 'Call tomorrow', unexpected: 'discard' }), { title: 'A', status: 'Pending', data: { client_name: 'A', phone: '1234567', notes: 'Call tomorrow' } })
  assert.throws(() => validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', status: 'Invalid' }), /Status is invalid/)
  assert.throws(() => validateRecord(modules.queries!, { client_name: 'A', phone: '1234567', arrival_date: '2026-02-31' }), /Expected arrival is invalid/)
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
