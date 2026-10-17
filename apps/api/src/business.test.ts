import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { modules, validateRecord } from './modules.js'

process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_ANON_KEY ||= 'test-publishable-key'
process.env.SUPABASE_SECRET_KEY ||= 'test-secret-key'
const { priceQuote } = await import('./quotes.js')
const { quotePdf } = await import('./pdf.js')

test('quotation totals use cents and apply GST after discount', () => {
  assert.deepEqual(priceQuote(1000, 200, 100, 5), { gst_amount: 55, total_amount: 1155 })
  assert.deepEqual(priceQuote(10.1, 0.2, 0.1, 18), { gst_amount: 1.84, total_amount: 12.04 })
  assert.throws(() => priceQuote(10, 0, 11, 5), /Discount cannot exceed/)
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
