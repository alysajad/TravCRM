import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, HttpError, requirePermission, unwrap } from './core.js'
import { quotePdf } from './pdf.js'
import { statuses } from './modules.js'

const idSchema = z.uuid()
const quoteInput = z.object({
  query_id: idSchema.optional().nullable(),
  client_name: z.string().trim().min(1).max(200), email: z.email().optional().or(z.literal('')),
  phone: z.string().max(50).optional(), status: z.enum(statuses.quote as [string, ...string[]]).default('Draft'),
  destination: z.string().trim().min(1).max(200), days: z.coerce.number().int().min(1).max(60),
  adults: z.coerce.number().int().min(0).max(100), children: z.coerce.number().int().min(0).max(100),
  arrival_date: z.string().optional().nullable(), pickup: z.string().max(300).optional(), dropoff: z.string().max(300).optional(),
  flights: z.string().max(2000).optional(), inclusions: z.string().max(10000).optional(), exclusions: z.string().max(10000).optional(),
  base_amount: z.coerce.number().min(0).max(999999999), child_amount: z.coerce.number().min(0).max(999999999),
  discount_amount: z.coerce.number().min(0).max(999999999), gst_percent: z.coerce.number().min(0).max(100),
  itinerary: z.array(z.object({ day_plan_id: idSchema })),
  stays: z.array(z.object({ hotel_id: idSchema, room_type_id: idSchema.optional().nullable() }))
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

async function prepare(request: Parameters<typeof requirePermission>[0], raw: unknown) {
  const ctx = requirePermission(request, 'quotes.write')
  const parsed = quoteInput.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check quotation fields.')
  const value: QuoteInput = parsed.data
  value.base_amount = Math.round(value.base_amount * 100) / 100
  value.child_amount = Math.round(value.child_amount * 100) / 100
  value.discount_amount = Math.round(value.discount_amount * 100) / 100
  value.gst_percent = Math.round(value.gst_percent * 100) / 100
  if (value.adults + value.children < 1) throw new HttpError(400, 'Add at least one traveler.')
  if (value.itinerary.length !== value.days) throw new HttpError(400, 'Choose one day plan for each day.')
  if (value.stays.length !== value.days - 1) throw new HttpError(400, 'Choose one hotel for each night.')
  if (value.query_id) {
    const { data } = await ctx.db.from('records').select('id').eq('company_id', ctx.companyId).eq('type', 'query').eq('id', value.query_id).maybeSingle()
    if (!data) throw new HttpError(400, 'The linked query is not in this company.')
  }
  const ids = [...new Set([...value.itinerary.map(x => x.day_plan_id), ...value.stays.flatMap(x => [x.hotel_id, ...(x.room_type_id ? [x.room_type_id] : [])])])]
  const { data: records, error } = await ctx.db.from('records').select('id,type,title,data').eq('company_id', ctx.companyId).in('id', ids)
  if (error) throw new HttpError(400, error.message)
  const map = new Map((records || []).map(x => [x.id, x]))
  for (const day of value.itinerary) if (map.get(day.day_plan_id)?.type !== 'day_plan') throw new HttpError(400, 'A selected day plan is unavailable.')
  for (const stay of value.stays) {
    if (map.get(stay.hotel_id)?.type !== 'hotel') throw new HttpError(400, 'A selected hotel is unavailable.')
    if (stay.room_type_id && map.get(stay.room_type_id)?.type !== 'room_type') throw new HttpError(400, 'A selected room type is unavailable.')
  }
  const itinerary = value.itinerary.map((x, i) => ({ day: i + 1, day_plan_id: x.day_plan_id, name: map.get(x.day_plan_id)!.title, description: map.get(x.day_plan_id)!.data?.description || '' }))
  const stays = value.stays.map((x, i) => ({ night: i + 1, hotel_id: x.hotel_id, name: map.get(x.hotel_id)!.title, room_type_id: x.room_type_id || null, room_type: x.room_type_id ? map.get(x.room_type_id)?.title : null }))
  return { ctx, row: { ...value, company_id: ctx.companyId, itinerary, stays, ...priceQuote(value.base_amount, value.child_amount, value.discount_amount, value.gst_percent) } }
}

const path = (v: unknown) => v as { id: string }
const listQuery = (v: unknown) => v as { page?: string; status?: string; q?: string }

export async function registerQuotes(app: FastifyInstance): Promise<void> {
  app.get('/quote-options', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    return unwrap(await ctx.db.from('quotes').select('id,client_name,destination,total_amount').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(1000))
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
    return { items: data, total: count || 0, page: pageNumber, pageSize: 25 }
  })

  app.get('/quotes/:id', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    return unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', path(request.params).id).single())
  })

  app.post('/quotes', async request => {
    const { ctx, row } = await prepare(request, request.body)
    const quote = unwrap(await ctx.db.from('quotes').insert({ ...row, created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'quotes.create', quote.id)
    return quote
  })

  app.patch('/quotes/:id', async request => {
    const { ctx, row } = await prepare(request, request.body)
    const id = path(request.params).id
    const quote = unwrap(await ctx.db.from('quotes').update({ ...row, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id).select('*').single())
    await audit(ctx, 'quotes.update', id)
    return quote
  })

  app.post('/quotes/:id/duplicate', async request => {
    const ctx = requirePermission(request, 'quotes.write')
    const source = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', path(request.params).id).single())
    const { id, created_at, updated_at, nights, created_by, ...copy } = source
    const quote = unwrap(await ctx.db.from('quotes').insert({ ...copy, status: 'Draft', created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'quotes.duplicate', quote.id, { source: id })
    return quote
  })

  app.delete('/quotes/:id', async request => {
    const ctx = requirePermission(request, 'quotes.write')
    const id = path(request.params).id
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
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="quotation-${quote.id.slice(0, 8)}.pdf"`)
    return reply.send(Buffer.from(pdf))
  })
}
