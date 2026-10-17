import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, HttpError, requirePermission, unwrap } from './core.js'
import { recordPdf } from './pdf.js'

const id = (value: unknown) => (value as { id: string }).id
const round = (value: unknown) => Math.round(Number(value || 0) * 100) / 100
const bookingStatuses = ['confirmed', 'in_progress', 'completed', 'cancelled'] as const
const mealPlans = ['EPAI', 'CPAI', 'MAPAI', 'AP', 'Jain Food'] as const

function isoAdd(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function groupBookingStays(quote: Record<string, any>) {
  const stays: Record<string, any>[] = []
  for (const [index, night] of (quote.stays || []).entries()) {
    const previous = stays.at(-1)
    const key = `${night.hotel_id}:${night.room_type_id || ''}`
    if (previous?.key === key) previous.nights += 1
    else stays.push({ key, firstNight: index, nights: 1, ...night })
  }
  return stays.map((stay, index) => ({
    sequence: index + 1,
    hotel_id: stay.hotel_id,
    property_name: stay.name,
    property_type: stay.property_type || 'Hotel',
    room_type: stay.room_type || null,
    check_in: isoAdd(quote.arrival_date, stay.firstNight),
    check_out: isoAdd(quote.arrival_date, stay.firstNight + stay.nights),
    rooms: quote.rooms || 1,
    extra_beds: quote.extra_beds || 0,
    children_without_bed: quote.children_without_bed || 0,
    meal_plan: stay.meal_plan || 'CPAI',
    supplier_cost: round(stay.supplier_cost),
    inclusions: quote.inclusions || ''
  }))
}

function buildTransport(quote: Record<string, any>) {
  if (!quote.transport?.included) return []
  return Array.from({ length: quote.days }, (_, index) => {
    const row = quote.transport.days?.[index] || {}
    const plan = quote.itinerary?.[index] || {}
    return {
      day: index + 1,
      service_date: isoAdd(quote.arrival_date, index),
      destination: row.destination || plan.name || quote.destination,
      hotel: row.hotel || quote.stays?.[Math.min(index, Math.max(0, quote.stays.length - 1))]?.name || '',
      cab_id: quote.transport.cab_id || null,
      vehicle_type: quote.transport.vehicle_type || '',
      vehicle_number: quote.transport.vehicle_number || '',
      driver_name: quote.transport.driver_name || '',
      driver_phone: quote.transport.driver_phone || '',
      pickup: index === 0 ? quote.pickup || '' : row.pickup || '',
      dropoff: index === quote.days - 1 ? quote.dropoff || '' : row.dropoff || ''
    }
  })
}

function buildDocuments(quote: Record<string, any>, stays: Record<string, any>[], transport: Record<string, any>[]) {
  const common = {
    guest_name: quote.client_name, guest_phone: quote.phone || '', guest_email: quote.email || '', adults: quote.adults,
    children: quote.children, booking_date: quote.booking_date || new Date().toISOString().slice(0, 10),
    destination: quote.destination
  }
  const documents: { type: string; stay_sequence: number | null; payload: Record<string, any> }[] = stays.map(stay => ({
    type: 'stay_voucher', stay_sequence: stay.sequence,
    payload: { ...common, hotel: stay.property_name, property_type: stay.property_type, check_in: stay.check_in, check_out: stay.check_out, rooms: stay.rooms, extra_beds: stay.extra_beds, children_without_bed: stay.children_without_bed, room_type: stay.room_type, meal_plan: stay.meal_plan, inclusions: stay.inclusions }
  }))
  if (transport.length) { const first = transport[0]!
    documents.push({
      type: 'cab_voucher', stay_sequence: null,
      payload: { ...common, start_date: first.service_date, end_date: transport.at(-1)!.service_date, vehicle_type: first.vehicle_type, vehicle_number: first.vehicle_number, driver_name: first.driver_name, driver_phone: first.driver_phone, routes: transport }
    })
  }
  return documents
}

export async function registerBookings(app: FastifyInstance): Promise<void> {
  app.get('/bookings', async request => {
    const ctx = requirePermission(request, 'bookings.read')
    const query = request.query as { page?: string; status?: string; q?: string; from?: string; to?: string }
    const page = Math.max(1, Number(query.page || 1))
    let builder = ctx.db.from('bookings').select('*', { count: 'exact' }).eq('company_id', ctx.companyId).order('arrival_date').range((page - 1) * 25, page * 25 - 1)
    if (query.status) builder = builder.eq('status', query.status)
    if (query.q?.trim()) builder = builder.ilike('client_name', `%${query.q.trim().replace(/[%_]/g, '')}%`)
    if (query.from) builder = builder.gte('arrival_date', query.from)
    if (query.to) builder = builder.lte('arrival_date', query.to)
    const { data, error, count } = await builder
    if (error) throw new HttpError(400, error.message)
    return { items: data, total: count || 0, page, pageSize: 25 }
  })

  app.get('/bookings/:id', async request => {
    const ctx = requirePermission(request, 'bookings.read')
    const booking = unwrap(await ctx.db.from('bookings').select('*').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    const quoteIds = unwrap(await ctx.db.from('quotes').select('id').eq('company_id', ctx.companyId).eq('quote_series_id', booking.quote_series_id)).map(row => row.id)
    const [stays, transport, documents, revisions, payments] = await Promise.all([
      ctx.db.from('booking_stays').select('*').eq('company_id', ctx.companyId).eq('booking_id', booking.id).order('sequence'),
      ctx.db.from('booking_transport_days').select('*').eq('company_id', ctx.companyId).eq('booking_id', booking.id).order('day'),
      ctx.db.from('booking_documents').select('*').eq('company_id', ctx.companyId).eq('booking_id', booking.id).order('created_at'),
      ctx.db.from('booking_revisions').select('id,revision,source_quote_id,created_at').eq('company_id', ctx.companyId).eq('booking_id', booking.id).order('revision', { ascending: false }),
      quoteIds.length ? ctx.db.from('payments').select('*').eq('company_id', ctx.companyId).in('quote_id', quoteIds).order('paid_at', { ascending: false }) : Promise.resolve({ data: [], error: null })
    ])
    for (const result of [stays, transport, documents, revisions, payments]) if (result.error) throw new HttpError(400, result.error.message)
    return { ...booking, stays: stays.data, transport: transport.data, documents: documents.data, revisions: revisions.data, payments: payments.data }
  })

  app.post('/quotes/:id/revisions', async request => {
    const ctx = requirePermission(request, 'quotes.revise')
    const source = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    if (!source.locked_at) throw new HttpError(400, 'Create revisions after a quotation has been confirmed.')
    const latest = unwrap(await ctx.db.from('quotes').select('id,quote_revision').eq('company_id', ctx.companyId).eq('quote_series_id', source.quote_series_id).order('quote_revision', { ascending: false }).limit(1).single())
    const { id: _id, booking_id: _booking, locked_at: _locked, created_at: _created, updated_at: _updated, ...copy } = source
    const revision = unwrap(await ctx.db.from('quotes').insert({ ...copy, quote_revision: Number(latest.quote_revision) + 1, supersedes_quote_id: latest.id, status: 'Draft', created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'quotes.revise', revision.id, { source: source.id, revision: revision.quote_revision })
    return revision
  })

  app.post('/quotes/:id/confirm', async request => {
    const ctx = requirePermission(request, 'bookings.confirm')
    const quote = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    if (quote.booking_id) return unwrap(await ctx.db.from('bookings').select('*').eq('company_id', ctx.companyId).eq('id', quote.booking_id).single())
    if (!quote.arrival_date) throw new HttpError(400, 'Add the travel date before confirming this quotation.')
    if (quote.itinerary?.length !== quote.days || quote.stays?.length !== quote.nights) throw new HttpError(400, 'Complete every itinerary day and overnight stay before confirming.')
    const seriesQuotes = unwrap(await ctx.db.from('quotes').select('id').eq('company_id', ctx.companyId).eq('quote_series_id', quote.quote_series_id))
    const seriesPayments = seriesQuotes.length ? unwrap(await ctx.db.from('payments').select('amount').eq('company_id', ctx.companyId).in('quote_id', seriesQuotes.map(row => row.id))) : []
    const paid = round(seriesPayments.reduce((sum, payment) => sum + Number(payment.amount), 0))
    if (paid > round(quote.total_amount)) throw new HttpError(400, `The revised quotation total cannot be below ${paid.toFixed(2)} already received.`)
    const stays = groupBookingStays(quote)
    const transport = buildTransport(quote)
    const departure = isoAdd(quote.arrival_date, Math.max(0, quote.days - 1))
    const snapshot = { ...quote, departure_date: departure, confirmed_at: new Date().toISOString() }
    const documents = buildDocuments(quote, stays, transport)
    const { data: bookingId, error } = await admin.rpc('apply_quote_booking', { p_company_id: ctx.companyId, p_quote_id: quote.id, p_actor_id: ctx.userId, p_snapshot: snapshot, p_stays: stays, p_transport: transport, p_documents: documents })
    if (error) throw new HttpError(400, error.message)
    const booking = unwrap(await ctx.db.from('bookings').select('*').eq('company_id', ctx.companyId).eq('id', bookingId).single())
    await audit(ctx, 'bookings.confirm', booking.id, { quote: quote.id, quote_revision: quote.quote_revision })
    return booking
  })

  app.patch('/bookings/:id/status', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ status: z.enum(bookingStatuses) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a valid booking status.')
    const booking = unwrap(await ctx.db.from('bookings').update({ status: parsed.data.status, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    await audit(ctx, 'bookings.status', booking.id, parsed.data)
    return booking
  })

  app.patch('/booking-stays/:id', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ meal_plan: z.enum(mealPlans).optional(), confirmation_status: z.enum(['pending','confirmed','cancelled']).optional(), confirmation_reference: z.string().max(200).nullable().optional(), supplier_cost: z.coerce.number().min(0).max(999999999).optional(), inclusions: z.string().max(10000).optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check stay details.')
    const stay = unwrap(await ctx.db.from('booking_stays').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    const { data: draft } = await admin.from('booking_documents').select('id,payload').eq('company_id', ctx.companyId).eq('booking_id', stay.booking_id).eq('type', 'stay_voucher').eq('stay_sequence', stay.sequence).eq('status', 'draft').maybeSingle()
    if (draft) await admin.from('booking_documents').update({ payload: { ...draft.payload, meal_plan: stay.meal_plan, confirmation_reference: stay.confirmation_reference || '', inclusions: stay.inclusions || '' }, updated_at: new Date().toISOString() }).eq('id', draft.id)
    await audit(ctx, 'booking_stays.update', stay.id, { booking: stay.booking_id })
    return stay
  })

  app.patch('/booking-transport/:id', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ vehicle_type: z.string().max(100).optional(), vehicle_number: z.string().max(100).optional(), driver_name: z.string().max(200).optional(), driver_phone: z.string().max(50).optional(), pickup: z.string().max(300).optional(), dropoff: z.string().max(300).optional(), destination: z.string().min(1).max(300).optional(), hotel: z.string().max(300).optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check transport details.')
    const row = unwrap(await ctx.db.from('booking_transport_days').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    const [{ data: routes }, { data: draft }] = await Promise.all([
      ctx.db.from('booking_transport_days').select('*').eq('company_id', ctx.companyId).eq('booking_id', row.booking_id).order('day'),
      admin.from('booking_documents').select('id,payload').eq('company_id', ctx.companyId).eq('booking_id', row.booking_id).eq('type', 'cab_voucher').eq('status', 'draft').maybeSingle()
    ])
    if (draft && routes?.length) await admin.from('booking_documents').update({ payload: { ...draft.payload, vehicle_type: routes[0]?.vehicle_type || '', vehicle_number: routes[0]?.vehicle_number || '', driver_name: routes[0]?.driver_name || '', driver_phone: routes[0]?.driver_phone || '', routes }, updated_at: new Date().toISOString() }).eq('id', draft.id)
    await audit(ctx, 'booking_transport.update', row.id, { booking: row.booking_id })
    return row
  })

  app.patch('/booking-documents/:id', async request => {
    const ctx = requirePermission(request, 'booking_documents.write')
    const document = unwrap(await ctx.db.from('booking_documents').select('*').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    if (document.status !== 'draft') throw new HttpError(409, 'Issued documents are locked. Create a quotation revision to prepare a replacement.')
    const parsed = z.object({ payload: z.record(z.string(), z.unknown()) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check document details.')
    const updated = unwrap(await ctx.db.from('booking_documents').update({ payload: parsed.data.payload, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', document.id).select('*').single())
    await audit(ctx, 'booking_documents.update', updated.id)
    return updated
  })

  app.post('/booking-documents/:id/issue', async request => {
    const ctx = requirePermission(request, 'booking_documents.issue')
    const documentId = id(request.params)
    const { error } = await admin.rpc('issue_booking_document', { p_company_id: ctx.companyId, p_document_id: documentId, p_actor_id: ctx.userId })
    if (error) throw new HttpError(409, error.message)
    const updated = unwrap(await ctx.db.from('booking_documents').select('*').eq('company_id', ctx.companyId).eq('id', documentId).single())
    await audit(ctx, 'booking_documents.issue', updated.id, { replaces: updated.replaces_document_id })
    return updated
  })

  app.post('/booking-documents/:id/cancel', async request => {
    const ctx = requirePermission(request, 'booking_documents.issue')
    const document = unwrap(await ctx.db.from('booking_documents').update({ status: 'cancelled', cancelled_by: ctx.userId, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).in('status', ['draft','issued']).select('*').single())
    await audit(ctx, 'booking_documents.cancel', document.id)
    return document
  })

  app.get('/booking-documents/:id/pdf', async (request, reply) => {
    const ctx = requirePermission(request, 'booking_documents.read')
    const document = unwrap(await ctx.db.from('booking_documents').select('*').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
    const bytes = await recordPdf(document.type, { id: document.id, document_number: document.document_number, data: document.payload }, settings, ctx.companyName || 'Travel company')
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${document.document_number}.pdf"`).send(Buffer.from(bytes))
  })
}
