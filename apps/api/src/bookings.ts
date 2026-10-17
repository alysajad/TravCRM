import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, enforceLimit, HttpError, requirePermission, unwrap } from './core.js'
import { recordPdf } from './pdf.js'
import { initializeBookingOperations, queueSupplierReminder } from './operations.js'

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
    const ids = (data || []).map(row => row.id)
    if (!ids.length) return { items: data, total: count || 0, page, pageSize: 25 }
    const canReadOperations = ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes('booking_operations.read')
    const [tasks, stays, transport, services, travellerDocuments] = await Promise.all([
      canReadOperations ? ctx.db.from('booking_tasks').select('booking_id,status').eq('company_id', ctx.companyId).in('booking_id', ids) : Promise.resolve({ data: [], error: null }),
      ctx.db.from('booking_stays').select('booking_id,confirmation_status').eq('company_id', ctx.companyId).in('booking_id', ids),
      ctx.db.from('booking_transport_days').select('booking_id,confirmation_status,driver_status').eq('company_id', ctx.companyId).in('booking_id', ids),
      canReadOperations ? ctx.db.from('booking_services').select('booking_id,status').eq('company_id', ctx.companyId).in('booking_id', ids) : Promise.resolve({ data: [], error: null }),
      (ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes('traveller_documents.read')) ? ctx.db.from('booking_traveller_documents').select('booking_id,status').eq('company_id', ctx.companyId).in('booking_id', ids) : Promise.resolve({ data: [], error: null })
    ])
    for (const result of [tasks, stays, transport, services, travellerDocuments]) if (result.error) throw new HttpError(400, result.error.message)
    const items = (data || []).map(row => { const bookingTasks = (tasks.data || []).filter(x => x.booking_id === row.id); const supplierRows = [...(stays.data || []).filter(x => x.booking_id === row.id).map(x => x.confirmation_status === 'confirmed'), ...(transport.data || []).filter(x => x.booking_id === row.id).map(x => x.confirmation_status === 'confirmed' && ['confirmed','completed'].includes(x.driver_status)), ...(services.data || []).filter(x => x.booking_id === row.id).map(x => ['confirmed','ticketed'].includes(x.status))]; return { ...row, operations: { tasks_total: bookingTasks.length, tasks_done: bookingTasks.filter(x => x.status === 'done').length, suppliers_total: supplierRows.length, suppliers_ready: supplierRows.filter(Boolean).length, missing_documents: (travellerDocuments.data || []).filter(x => x.booking_id === row.id && ['required','rejected','expired'].includes(x.status)).length } } })
    return { items, total: count || 0, page, pageSize: 25 }
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
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
    const { count } = await admin.from('bookings').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).gte('created_at', since)
    await enforceLimit(ctx, 'bookings_monthly', count || 0)
    if (!quote.arrival_date) throw new HttpError(400, 'Add the travel date before confirming this quotation.')
    if (quote.itinerary?.length !== quote.days || quote.stays?.length !== quote.nights) throw new HttpError(400, 'Complete every itinerary day and overnight stay before confirming.')
    const seriesQuotes = unwrap(await ctx.db.from('quotes').select('id').eq('company_id', ctx.companyId).eq('quote_series_id', quote.quote_series_id))
    const seriesPayments = seriesQuotes.length ? unwrap(await ctx.db.from('payments').select('amount').eq('company_id', ctx.companyId).in('quote_id', seriesQuotes.map(row => row.id))) : []
    const paid = round(seriesPayments.reduce((sum, payment) => sum + Number(payment.amount), 0))
    if (paid > round(quote.total_amount)) throw new HttpError(400, `The revised quotation total cannot be below ${paid.toFixed(2)} already received.`)
    const existingBooking = (await ctx.db.from('bookings').select('id').eq('company_id', ctx.companyId).eq('quote_series_id', quote.quote_series_id).maybeSingle()).data
    const [oldStays, oldTransport] = existingBooking ? await Promise.all([
      ctx.db.from('booking_stays').select('*').eq('company_id', ctx.companyId).eq('booking_id', existingBooking.id),
      ctx.db.from('booking_transport_days').select('*').eq('company_id', ctx.companyId).eq('booking_id', existingBooking.id)
    ]) : [{ data: [] }, { data: [] }]
    const stays = groupBookingStays(quote)
    const transport = buildTransport(quote)
    const departure = isoAdd(quote.arrival_date, Math.max(0, quote.days - 1))
    const snapshot = { ...quote, departure_date: departure, confirmed_at: new Date().toISOString() }
    const documents = buildDocuments(quote, stays, transport)
    const { data: bookingId, error } = await admin.rpc('apply_quote_booking', { p_company_id: ctx.companyId, p_quote_id: quote.id, p_actor_id: ctx.userId, p_snapshot: snapshot, p_stays: stays, p_transport: transport, p_documents: documents })
    if (error) throw new HttpError(400, error.message)
    const booking = unwrap(await ctx.db.from('bookings').select('*').eq('company_id', ctx.companyId).eq('id', bookingId).single())
    if (existingBooking) {
      let needsReview = false
      const [newStays, newTransport] = await Promise.all([
        admin.from('booking_stays').select('*').eq('company_id', ctx.companyId).eq('booking_id', booking.id),
        admin.from('booking_transport_days').select('*').eq('company_id', ctx.companyId).eq('booking_id', booking.id)
      ])
      for (const row of newStays.data || []) { const old = (oldStays.data || []).find(x => x.sequence === row.sequence); if (old) { const changed = old.property_name !== row.property_name || old.check_in !== row.check_in || old.check_out !== row.check_out; needsReview ||= changed; await admin.from('booking_stays').update({ confirmation_status: changed ? 'reconfirmation_required' : old.confirmation_status, confirmation_reference: old.confirmation_reference, supplier_cost: old.supplier_cost, supplier_id: old.supplier_id, supplier_phone: old.supplier_phone, supplier_email: old.supplier_email, confirmation_deadline: old.confirmation_deadline }).eq('id', row.id) } }
      for (const row of newTransport.data || []) { const old = (oldTransport.data || []).find(x => x.day === row.day); if (old) { const changed = old.destination !== row.destination || old.service_date !== row.service_date; needsReview ||= changed; await admin.from('booking_transport_days').update({ confirmation_status: changed ? 'reconfirmation_required' : old.confirmation_status, confirmation_reference: old.confirmation_reference, supplier_id: old.supplier_id, supplier_name: old.supplier_name, supplier_phone: old.supplier_phone, supplier_email: old.supplier_email, vehicle_type: old.vehicle_type, vehicle_number: old.vehicle_number, driver_name: old.driver_name, driver_phone: old.driver_phone, driver_status: old.driver_status, driver_confirmed_at: old.driver_confirmed_at, instructions: old.instructions }).eq('id', row.id) } }
      if (needsReview) await admin.from('booking_tasks').insert({ company_id: ctx.companyId, booking_id: booking.id, title: `Review supplier changes from revision ${booking.revision}`, category: 'suppliers', status: 'todo', priority: 'urgent', due_at: new Date().toISOString(), assignee_id: booking.assignee_id || ctx.userId, source: 'system', created_by: ctx.userId })
    }
    await initializeBookingOperations(ctx.companyId, booking, ctx.userId)
    await audit(ctx, 'bookings.confirm', booking.id, { quote: quote.id, quote_revision: quote.quote_revision })
    return booking
  })

  app.patch('/bookings/:id/status', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ status: z.enum(bookingStatuses) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a valid booking status.')
    const booking = unwrap(await ctx.db.from('bookings').update({ status: parsed.data.status, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    if (parsed.data.status === 'cancelled') await Promise.all([
      admin.from('booking_tasks').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('booking_id', booking.id).in('status', ['todo','in_progress','blocked']),
      admin.from('messages').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('booking_id', booking.id).in('status', ['queued','retry'])
    ])
    await audit(ctx, 'bookings.status', booking.id, parsed.data)
    return booking
  })

  app.patch('/booking-stays/:id', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ meal_plan: z.enum(mealPlans).optional(), confirmation_status: z.enum(['pending','requested','on_hold','confirmed','reconfirmation_required','cancelled']).optional(), confirmation_reference: z.string().max(200).nullable().optional(), supplier_cost: z.coerce.number().min(0).max(999999999).optional(), inclusions: z.string().max(10000).optional(), supplier_id: z.uuid().nullable().optional(), supplier_phone: z.string().max(50).nullable().optional(), supplier_email: z.union([z.email(), z.literal('')]).nullable().optional(), confirmation_deadline: z.iso.datetime().nullable().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check stay details.')
    const stay = unwrap(await ctx.db.from('booking_stays').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    const { data: draft } = await admin.from('booking_documents').select('id,payload').eq('company_id', ctx.companyId).eq('booking_id', stay.booking_id).eq('type', 'stay_voucher').eq('stay_sequence', stay.sequence).eq('status', 'draft').maybeSingle()
    if (draft) await admin.from('booking_documents').update({ payload: { ...draft.payload, meal_plan: stay.meal_plan, confirmation_reference: stay.confirmation_reference || '', inclusions: stay.inclusions || '' }, updated_at: new Date().toISOString() }).eq('id', draft.id)
    if (!['confirmed','cancelled'].includes(stay.confirmation_status)) await queueSupplierReminder(ctx.companyId, stay.booking_id, `stay:${stay.id}`, { name: stay.property_name, phone: stay.supplier_phone, email: stay.supplier_email })
    await audit(ctx, 'booking_stays.update', stay.id, { booking: stay.booking_id })
    return stay
  })

  app.patch('/booking-transport/:id', async request => {
    const ctx = requirePermission(request, 'bookings.write')
    const parsed = z.object({ cab_id: z.uuid().nullable().optional(), vehicle_type: z.string().max(100).optional(), vehicle_number: z.string().max(100).optional(), driver_name: z.string().max(200).optional(), driver_phone: z.string().max(50).optional(), driver_status: z.enum(['unassigned','assigned','confirmed','completed','cancelled']).optional(), confirmation_status: z.enum(['pending','requested','on_hold','confirmed','reconfirmation_required','cancelled']).optional(), confirmation_reference: z.string().max(200).nullable().optional(), supplier_id: z.uuid().nullable().optional(), supplier_name: z.string().max(200).nullable().optional(), supplier_phone: z.string().max(50).nullable().optional(), supplier_email: z.union([z.email(), z.literal('')]).nullable().optional(), instructions: z.string().max(2000).nullable().optional(), pickup: z.string().max(300).optional(), dropoff: z.string().max(300).optional(), destination: z.string().min(1).max(300).optional(), hotel: z.string().max(300).optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check transport details.')
    const values: Record<string, any> = { ...parsed.data, supplier_email: parsed.data.supplier_email || null, updated_at: new Date().toISOString() }
    if (parsed.data.cab_id) {
      const cab = unwrap(await ctx.db.from('records').select('id,data').eq('company_id', ctx.companyId).eq('type', 'cab').eq('id', parsed.data.cab_id).single())
      Object.assign(values, { vehicle_type: parsed.data.vehicle_type || cab.data?.type || cab.data?.name || '', vehicle_number: parsed.data.vehicle_number || cab.data?.registration || '', driver_name: parsed.data.driver_name || cab.data?.driver_name || '', driver_phone: parsed.data.driver_phone || cab.data?.driver_phone || '', driver_status: parsed.data.driver_status || 'assigned' })
    }
    if (values.driver_status === 'confirmed') values.driver_confirmed_at = new Date().toISOString()
    const row = unwrap(await ctx.db.from('booking_transport_days').update(values).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    const [{ data: routes }, { data: draft }] = await Promise.all([
      ctx.db.from('booking_transport_days').select('*').eq('company_id', ctx.companyId).eq('booking_id', row.booking_id).order('day'),
      admin.from('booking_documents').select('id,payload').eq('company_id', ctx.companyId).eq('booking_id', row.booking_id).eq('type', 'cab_voucher').eq('status', 'draft').maybeSingle()
    ])
    if (draft && routes?.length) await admin.from('booking_documents').update({ payload: { ...draft.payload, vehicle_type: routes[0]?.vehicle_type || '', vehicle_number: routes[0]?.vehicle_number || '', driver_name: routes[0]?.driver_name || '', driver_phone: routes[0]?.driver_phone || '', routes }, updated_at: new Date().toISOString() }).eq('id', draft.id)
    if (!['confirmed','cancelled'].includes(row.confirmation_status)) await queueSupplierReminder(ctx.companyId, row.booking_id, `transport:${row.id}`, { name: row.supplier_name, phone: row.supplier_phone, email: row.supplier_email })
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
