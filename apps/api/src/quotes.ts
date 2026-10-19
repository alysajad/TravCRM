import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, enforceLimit, HttpError, requirePermission, unwrap } from './core.js'
import { quotePdf } from './pdf.js'
import { statuses } from './modules.js'
import { resolveClientLink } from './clients.js'
import { accessibleCatalogSourceIds } from './catalog-governance.js'

const idSchema = z.uuid()
const priceLineInput = z.object({ category: z.enum(['package','hotel','transport','activity','supplement','custom']).default('custom'), label: z.string().trim().min(1).max(200), quantity: z.coerce.number().positive().max(10000), unit_amount: z.coerce.number().min(0).max(999999999) })
const transportDayInput = z.object({ destination: z.string().max(300).optional(), hotel: z.string().max(300).optional(), pickup: z.string().max(300).optional(), dropoff: z.string().max(300).optional() })
const dayChoiceInput = z.object({
  source: z.enum(['catalog','company','custom']).optional(), day_plan_id: idSchema.optional().nullable(),
  name: z.string().trim().max(200).optional(), description: z.string().max(10000).optional(), location_id: idSchema.optional().nullable(), location: z.string().max(200).optional(), image_path: z.string().max(1000).optional().nullable()
})
const stayChoiceInput = z.object({
  source: z.enum(['catalog','company','custom']).optional(), hotel_id: idSchema.optional().nullable(), room_type_id: idSchema.optional().nullable(),
  name: z.string().trim().max(200).optional(), location_id: idSchema.optional().nullable(), location: z.string().max(200).optional(), property_type: z.string().max(100).optional(), room_type: z.string().max(100).optional(), image_path: z.string().max(1000).optional().nullable()
})
const quoteInput = z.object({
  query_id: idSchema.optional().nullable(),
  client_id: idSchema.optional().nullable(),
  client_name: z.string().trim().min(1).max(200), email: z.email().optional().or(z.literal('')),
  phone: z.string().max(50).optional(), status: z.enum(statuses.quote as [string, ...string[]]).default('Draft'),
  destination: z.string().trim().min(1).max(200), days: z.coerce.number().int().min(1).max(60),
  adults: z.coerce.number().int().min(0).max(100), children: z.coerce.number().int().min(0).max(100),
  rooms: z.coerce.number().int().min(0).max(100).default(1), extra_beds: z.coerce.number().int().min(0).max(100).default(0), children_without_bed: z.coerce.number().int().min(0).max(100).default(0),
  booking_date: z.string().optional().nullable(), assignee_id: idSchema.optional().nullable(), pricing_mode: z.enum(['total_package','per_person']).default('total_package'),
  arrival_date: z.string().optional().nullable(), pickup: z.string().max(300).optional(), dropoff: z.string().max(300).optional(),
  flights: z.string().max(2000).optional(), inclusions: z.string().max(10000).optional(), exclusions: z.string().max(10000).optional(),
  base_amount: z.coerce.number().min(0).max(999999999), child_amount: z.coerce.number().min(0).max(999999999),
  discount_amount: z.coerce.number().min(0).max(999999999), gst_percent: z.coerce.number().min(0).max(100),
  price_lines: z.array(priceLineInput).max(50).default([]),
  transport: z.object({ included: z.boolean().default(false), cab_id: idSchema.optional().nullable(), vehicle_type: z.string().max(100).optional(), vehicle_number: z.string().max(100).optional(), driver_name: z.string().max(200).optional(), driver_phone: z.string().max(50).optional(), days: z.array(transportDayInput).max(60).default([]) }).default({ included: false, days: [] }),
  itinerary: z.array(dayChoiceInput),
  stays: z.array(stayChoiceInput)
})

export function priceQuote(base: number, child: number, discount: number, gstPercent: number) {
  const subtotalCents = Math.round(base * 100) + Math.round(child * 100)
  const discountCents = Math.round(discount * 100)
  if (discountCents > subtotalCents) throw new HttpError(400, 'Discount cannot exceed package and child costs.')
  const taxableCents = subtotalCents - discountCents
  const gstCents = Math.round(taxableCents * gstPercent / 100)
  return { gst_amount: gstCents / 100, total_amount: (taxableCents + gstCents) / 100 }
}

type QuoteInput = z.infer<typeof quoteInput>

async function prepare(request: Parameters<typeof requirePermission>[0], raw: unknown, grandfathered = new Set<string>()) {
  const ctx = requirePermission(request, 'quotes.write')
  const parsed = quoteInput.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check quotation fields.')
  const value: QuoteInput = parsed.data
  value.base_amount = Math.round(value.base_amount * 100) / 100
  value.child_amount = Math.round(value.child_amount * 100) / 100
  value.discount_amount = Math.round(value.discount_amount * 100) / 100
  value.gst_percent = Math.round(value.gst_percent * 100) / 100
  value.price_lines = value.price_lines.map(line => ({ ...line, quantity: round(line.quantity), unit_amount: round(line.unit_amount), amount: round(line.quantity * line.unit_amount) })) as typeof value.price_lines
  if (value.price_lines.length) { value.base_amount = round(value.price_lines.reduce((sum, line) => sum + Number((line as any).amount), 0)); value.child_amount = 0 }
  if (value.adults + value.children < 1) throw new HttpError(400, 'Add at least one traveler.')
  if (value.status === 'Confirmed') throw new HttpError(400, 'Use Confirm & create booking to confirm a quotation.')
  if (value.itinerary.length !== value.days) throw new HttpError(400, 'Choose one day plan for each day.')
  if (value.stays.length !== value.days - 1) throw new HttpError(400, 'Choose one hotel for each night.')
  let inheritedClientId: string | null = null
  if (value.query_id) {
    const { data } = await admin.from('records').select('id,data').eq('company_id', ctx.companyId).eq('type', 'query').eq('id', value.query_id).maybeSingle()
    if (!data) throw new HttpError(400, 'The linked query is not in this company.')
    inheritedClientId = data.data?.client_id || null
  }
  const clientLink = await resolveClientLink(ctx, { clientId: value.client_id, inheritedClientId, name: value.client_name, email: value.email, phone: value.phone })
  value.client_id = clientLink.clientId
  if (value.assignee_id) {
    const { data } = await admin.from('memberships').select('user_id').eq('company_id', ctx.companyId).eq('user_id', value.assignee_id).eq('active', true).maybeSingle()
    if (!data) throw new HttpError(400, 'The assignee is not in this company.')
  }
  if (value.transport.included && value.transport.days.length !== value.days) throw new HttpError(400, 'Add one transport route for every trip day.')
  const companyDayIds = value.itinerary.filter(x => (x.source || 'company') === 'company').flatMap(x => x.day_plan_id ? [x.day_plan_id] : [])
  const catalogDayIds = value.itinerary.filter(x => x.source === 'catalog').flatMap(x => x.day_plan_id ? [x.day_plan_id] : [])
  const companyHotelIds = value.stays.filter(x => (x.source || 'company') === 'company').flatMap(x => x.hotel_id ? [x.hotel_id] : [])
  const catalogHotelIds = value.stays.filter(x => x.source === 'catalog').flatMap(x => x.hotel_id ? [x.hotel_id] : [])
  const roomTypeIds = value.stays.flatMap(x => x.room_type_id ? [x.room_type_id] : [])
  const recordIds = [...new Set([...companyDayIds, ...companyHotelIds, ...roomTypeIds, ...(value.transport.cab_id ? [value.transport.cab_id] : [])])]
  const [{ data: records, error }, catalogDaysResult, catalogHotelsResult, overridesResult, visibleDayIds, visibleHotelIds, visibleRoomIds, catalogRoomsResult] = await Promise.all([
    recordIds.length ? ctx.db.from('records').select('id,type,title,data').eq('company_id', ctx.companyId).in('id', recordIds) : Promise.resolve({ data: [], error: null }),
    catalogDayIds.length ? admin.from('catalog_day_plans').select('*,catalog_locations(name)').in('id', catalogDayIds) : Promise.resolve({ data: [], error: null }),
    catalogHotelIds.length ? admin.from('catalog_hotels').select('*,catalog_locations(name)').in('id', catalogHotelIds) : Promise.resolve({ data: [], error: null }),
    catalogHotelIds.length ? ctx.db.from('company_hotel_overrides').select('*').eq('company_id', ctx.companyId).in('catalog_hotel_id', catalogHotelIds) : Promise.resolve({ data: [], error: null }),
    accessibleCatalogSourceIds(ctx.companyId, ['day_plan'], catalogDayIds),
    accessibleCatalogSourceIds(ctx.companyId, ['hotel'], catalogHotelIds),
    accessibleCatalogSourceIds(ctx.companyId, ['room_type'], roomTypeIds),
    roomTypeIds.length ? admin.from('catalog_options').select('id,name').eq('option_type', 'room_type').in('id', roomTypeIds) : Promise.resolve({ data: [], error: null })
  ])
  if (error || catalogDaysResult.error || catalogHotelsResult.error || overridesResult.error || catalogRoomsResult.error) throw new HttpError(400, error?.message || catalogDaysResult.error?.message || catalogHotelsResult.error?.message || overridesResult.error?.message || catalogRoomsResult.error?.message || 'A selected catalog item is unavailable.')
  const map = new Map((records || []).map(x => [x.id, x]))
  const catalogDays = new Map((catalogDaysResult.data || []).map(x => [x.id, x]))
  const catalogHotels = new Map((catalogHotelsResult.data || []).map(x => [x.id, x]))
  const overrides = new Map((overridesResult.data || []).map(x => [x.catalog_hotel_id, x]))
  const catalogRooms = new Map((catalogRoomsResult.data || []).map(x => [x.id, x]))
  for (const day of value.itinerary) {
    const source = day.source || 'company'
    if (source === 'company' && (!day.day_plan_id || map.get(day.day_plan_id)?.type !== 'day_plan')) throw new HttpError(400, 'A selected day plan is unavailable.')
    if (source === 'catalog' && (!day.day_plan_id || !catalogDays.has(day.day_plan_id) || (!visibleDayIds.has(day.day_plan_id) && !grandfathered.has(day.day_plan_id)))) throw new HttpError(400, 'A selected catalog day plan is unavailable.')
    if (source === 'custom' && (!day.name || !day.description || !day.location)) throw new HttpError(400, 'Custom days need a title, description and location.')
    if (source === 'custom' && day.image_path && !day.image_path.startsWith(`${ctx.companyId}/`)) throw new HttpError(400, 'Custom day images must belong to this company.')
  }
  for (const stay of value.stays) {
    const source = stay.source || 'company'
    if (source === 'company' && (!stay.hotel_id || map.get(stay.hotel_id)?.type !== 'hotel')) throw new HttpError(400, 'A selected hotel is unavailable.')
    if (source === 'catalog' && (!stay.hotel_id || !catalogHotels.has(stay.hotel_id) || ((!visibleHotelIds.has(stay.hotel_id) || overrides.get(stay.hotel_id)?.hidden) && !grandfathered.has(stay.hotel_id)))) throw new HttpError(400, 'A selected catalog hotel is unavailable.')
    if (source === 'custom' && (!stay.name || !stay.location)) throw new HttpError(400, 'Custom stays need a property name and location.')
    if (source === 'custom' && stay.image_path && !stay.image_path.startsWith(`${ctx.companyId}/`)) throw new HttpError(400, 'Custom stay images must belong to this company.')
    if (stay.room_type_id && map.get(stay.room_type_id)?.type !== 'room_type' && (!catalogRooms.has(stay.room_type_id) || (!visibleRoomIds.has(stay.room_type_id) && !grandfathered.has(stay.room_type_id)))) throw new HttpError(400, 'A selected room type is unavailable.')
  }
  const itinerary = value.itinerary.map((x, i) => {
    const source = x.source || 'company'; const company = x.day_plan_id ? map.get(x.day_plan_id) : null; const catalog = x.day_plan_id ? catalogDays.get(x.day_plan_id) : null
    return { day: i + 1, source, day_plan_id: x.day_plan_id || null, name: source === 'custom' ? x.name : source === 'catalog' ? catalog?.title : company?.title, description: source === 'custom' ? x.description : source === 'catalog' ? catalog?.description : company?.data?.description || '', location_id: x.location_id || catalog?.location_id || null, location: x.location || (catalog?.catalog_locations as any)?.name || company?.data?.location || '', image_path: source === 'custom' ? x.image_path || null : source === 'catalog' ? catalog?.image_path || null : company?.data?.image_path || null }
  })
  if (value.transport.cab_id && map.get(value.transport.cab_id)?.type !== 'cab') throw new HttpError(400, 'The selected cab is unavailable.')
  const stays = value.stays.map((x, i) => {
    const source = x.source || 'company'; const company = x.hotel_id ? map.get(x.hotel_id) : null; const catalog = x.hotel_id ? catalogHotels.get(x.hotel_id) : null; const override = x.hotel_id ? overrides.get(x.hotel_id) : null
    return { night: i + 1, source, hotel_id: x.hotel_id || null, name: source === 'custom' ? x.name : source === 'catalog' ? catalog?.canonical_name : company?.title, location_id: x.location_id || catalog?.location_id || null, location: x.location || (catalog?.catalog_locations as any)?.name || company?.data?.location || '', property_type: source === 'custom' ? x.property_type || 'Hotel' : source === 'catalog' ? catalog?.property_type : company?.data?.property_type || 'Hotel', room_type_id: x.room_type_id || null, room_type: x.room_type_id ? map.get(x.room_type_id)?.title || catalogRooms.get(x.room_type_id)?.name : x.room_type || null, image_path: source === 'custom' ? x.image_path || null : source === 'catalog' ? override?.image_path || null : company?.data?.image_path || null }
  })
  const cab = value.transport.cab_id ? map.get(value.transport.cab_id) : null
  const transport = { ...value.transport, vehicle_type: value.transport.vehicle_type || cab?.data?.type || cab?.title || '', vehicle_number: value.transport.vehicle_number || cab?.data?.registration || '', driver_name: value.transport.driver_name || cab?.data?.driver_name || '', driver_phone: value.transport.driver_phone || cab?.data?.driver_phone || '' }
  return { ctx, row: { ...value, company_id: ctx.companyId, itinerary, stays, transport, ...priceQuote(value.base_amount, value.child_amount, value.discount_amount, value.gst_percent) }, clientLinkStatus: clientLink.status }
}

const round = (value: unknown) => Math.round(Number(value || 0) * 100) / 100

const path = (v: unknown) => v as { id: string }
const listQuery = (v: unknown) => v as { page?: string; status?: string; q?: string }

export async function registerQuotes(app: FastifyInstance): Promise<void> {
  app.get('/quote-options', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    return unwrap(await ctx.db.from('quotes').select('id,quote_number,quote_revision,client_name,destination,total_amount').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(1000))
  })
  app.get('/quotes', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const { page = '1', status, q } = listQuery(request.query)
    const pageNumber = Math.max(1, Number(page) || 1)
    let builder = ctx.db.from('quotes').select('*', { count: 'exact' }).eq('company_id', ctx.companyId).order('created_at', { ascending: false }).range((pageNumber - 1) * 25, pageNumber * 25 - 1)
    if (status) builder = builder.eq('status', status)
    if (q?.trim()) builder = builder.ilike('client_name', `%${q.trim().replace(/[%_]/g, '')}%`)
    const { data, error, count } = await builder
    if (error) throw new HttpError(400, error.message)
    return { items: (data || []).map(row => ({ ...row, client_link_status: row.client_id ? 'linked' : 'needs_review' })), total: count || 0, page: pageNumber, pageSize: 25 }
  })

  app.get('/quotes/:id', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const quote = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', path(request.params).id).single())
    return { ...quote, client_link_status: quote.client_id ? 'linked' : 'needs_review' }
  })

  app.post('/quotes', async request => {
    const { ctx, row, clientLinkStatus } = await prepare(request, request.body)
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
    const { count } = await admin.from('quotes').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).gte('created_at', since)
    await enforceLimit(ctx, 'quotes_monthly', count || 0)
    const { data: quoteNumber, error } = await admin.rpc('next_document_number', { p_company_id: ctx.companyId, p_kind: 'quote' })
    if (error) throw new HttpError(400, error.message)
    const quote = unwrap(await ctx.db.from('quotes').insert({ ...row, quote_number: quoteNumber, created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'quotes.create', quote.id)
    return { ...quote, client_link_status: clientLinkStatus }
  })

  app.patch('/quotes/:id', async request => {
    const id = path(request.params).id
    const ctx = requirePermission(request, 'quotes.write')
    const existing = unwrap(await ctx.db.from('quotes').select('locked_at,itinerary,stays').eq('company_id', ctx.companyId).eq('id', id).single())
    if (existing.locked_at) throw new HttpError(409, 'Confirmed quotations are locked. Create a revision to make changes.')
    const grandfathered = new Set<string>([...(existing.itinerary || []).flatMap((row: any) => row.day_plan_id ? [row.day_plan_id] : []), ...(existing.stays || []).flatMap((row: any) => [row.hotel_id, row.room_type_id].filter(Boolean))])
    const prepared = await prepare(request, request.body, grandfathered); const row = prepared.row
    const quote = unwrap(await ctx.db.from('quotes').update({ ...row, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id).select('*').single())
    await audit(ctx, 'quotes.update', id)
    return { ...quote, client_link_status: prepared.clientLinkStatus }
  })

  app.post('/quotes/:id/duplicate', async request => {
    const ctx = requirePermission(request, 'quotes.write')
    const source = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', path(request.params).id).single())
    const { data: quoteNumber, error } = await admin.rpc('next_document_number', { p_company_id: ctx.companyId, p_kind: 'quote' })
    if (error) throw new HttpError(400, error.message)
    const { id, created_at, updated_at, nights, created_by, quote_number, quote_revision, quote_series_id, supersedes_quote_id, booking_id, locked_at, ...copy } = source
    const quote = unwrap(await ctx.db.from('quotes').insert({ ...copy, quote_number: quoteNumber, status: 'Draft', created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'quotes.duplicate', quote.id, { source: id })
    return { ...quote, client_link_status: quote.client_id ? 'linked' : 'needs_review' }
  })

  app.delete('/quotes/:id', async request => {
    const ctx = requirePermission(request, 'quotes.write')
    const id = path(request.params).id
    const existing = unwrap(await ctx.db.from('quotes').select('locked_at').eq('company_id', ctx.companyId).eq('id', id).single())
    if (existing.locked_at) throw new HttpError(409, 'Confirmed quotations are part of the booking audit trail and cannot be deleted.')
    const { count } = await ctx.db.from('payments').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('quote_id', id)
    if (count) throw new HttpError(409, 'This quote has payments. Remove or correct them first.')
    unwrap(await ctx.db.from('quotes').delete().eq('company_id', ctx.companyId).eq('id', id).select('id').single())
    await audit(ctx, 'quotes.delete', id)
    return { ok: true }
  })

  app.get('/quotes/:id/pdf', async (request, reply) => {
    const ctx = requirePermission(request, 'quotes.read')
    const quote = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', path(request.params).id).single())
    const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
    const pdf = await quotePdf(quote, settings, ctx.companyName || 'Travel company')
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${quote.quote_number || `quotation-${quote.id.slice(0, 8)}`}-R${quote.quote_revision || 1}.pdf"`)
    return reply.send(Buffer.from(pdf))
  })
}
