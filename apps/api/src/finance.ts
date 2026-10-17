import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, HttpError, requirePermission, unwrap } from './core.js'
import { recordPdf } from './pdf.js'
import { modules, statuses } from './modules.js'

const paymentInput = z.object({ quote_id: z.uuid(), amount: z.coerce.number().positive().max(999999999), paid_at: z.iso.date(), method: z.string().trim().min(1).max(80), reference: z.string().max(200).optional(), notes: z.string().max(2000).optional() })
const path = (x: unknown) => x as { id: string; slug: string }
const number = (v: unknown) => Math.round(Number(v || 0) * 100) / 100

export async function registerFinance(app: FastifyInstance): Promise<void> {
  app.get('/payments', async request => {
    const ctx = requirePermission(request, 'payments.read')
    const q = request.query as { quote_id?: string; page?: string }
    const page = Math.max(1, Number(q.page || 1))
    let builder = ctx.db.from('payments').select('*', { count: 'exact' }).eq('company_id', ctx.companyId).order('paid_at', { ascending: false }).range((page - 1) * 25, page * 25 - 1)
    if (q.quote_id) builder = builder.eq('quote_id', q.quote_id)
    const { data, error, count } = await builder
    if (error) throw new HttpError(400, error.message)
    return { items: data, total: count || 0, page, pageSize: 25 }
  })

  app.post('/payments', async request => {
    const ctx = requirePermission(request, 'payments.write')
    const parsed = paymentInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check payment details.')
    const value = parsed.data
    value.amount = Math.round(value.amount * 100) / 100
    if (value.amount <= 0) throw new HttpError(400, 'Payment must be at least INR 0.01.')
    const quote = unwrap(await ctx.db.from('quotes').select('id,total_amount').eq('company_id', ctx.companyId).eq('id', value.quote_id).single())
    const existing = unwrap(await ctx.db.from('payments').select('amount').eq('company_id', ctx.companyId).eq('quote_id', value.quote_id))
    const paid = existing.reduce((sum, payment) => sum + number(payment.amount), 0)
    if (number(paid + value.amount) > number(quote.total_amount)) throw new HttpError(400, 'Payment exceeds the quotation balance.')
    const payment = unwrap(await ctx.db.from('payments').insert({ ...value, company_id: ctx.companyId, created_by: ctx.userId }).select('*').single())
    await audit(ctx, 'payments.create', payment.id)
    return payment
  })

  app.delete('/payments/:id', async request => {
    const ctx = requirePermission(request, 'payments.write')
    const payment = unwrap(await ctx.db.from('payments').delete().eq('company_id', ctx.companyId).eq('id', path(request.params).id).select('id').single())
    await audit(ctx, 'payments.delete', payment.id)
    return { ok: true }
  })

  app.get('/ledger', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    requirePermission(request, 'payments.read')
    const page = Math.max(1, Number((request.query as { page?: string }).page || 1))
    const quotes = unwrap(await ctx.db.from('quotes').select('id,client_name,destination,status,total_amount,created_at', { count: 'exact' }).eq('company_id', ctx.companyId).order('created_at', { ascending: false }).range((page - 1) * 25, page * 25 - 1))
    const ids = quotes.map(x => x.id)
    const payments = ids.length ? unwrap(await ctx.db.from('payments').select('quote_id,amount').eq('company_id', ctx.companyId).in('quote_id', ids)) : []
    const totals = new Map<string, number>()
    for (const payment of payments) totals.set(payment.quote_id, number((totals.get(payment.quote_id) || 0) + number(payment.amount)))
    return quotes.map(quote => ({ ...quote, paid: totals.get(quote.id) || 0, balance: number(number(quote.total_amount) - (totals.get(quote.id) || 0)) }))
  })

  app.get('/hotel-ledger', async request => {
    const ctx = requirePermission(request, 'hotel.read')
    requirePermission(request, 'stay_voucher.read')
    requirePermission(request, 'hotel_payment.read')
    // ponytail: 10k rows per type; move aggregation into SQL if supplier volume exceeds this.
    const [hotelsResult, vouchersResult, paymentsResult] = await Promise.all([
      ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', 'hotel').limit(10000),
      ctx.db.from('records').select('data').eq('company_id', ctx.companyId).eq('type', 'stay_voucher').eq('status', 'Active').limit(10000),
      ctx.db.from('records').select('data').eq('company_id', ctx.companyId).eq('type', 'hotel_payment').eq('status', 'Active').limit(10000)
    ])
    const hotels = unwrap(hotelsResult); const vouchers = unwrap(vouchersResult); const payments = unwrap(paymentsResult)
    const due = new Map<string, number>(); const paid = new Map<string, number>()
    for (const row of vouchers) { const id = String(row.data?.hotel_id || ''); due.set(id, number((due.get(id) || 0) + Number(row.data?.cost || 0))) }
    for (const row of payments) { const id = String(row.data?.hotel_id || ''); paid.set(id, number((paid.get(id) || 0) + Number(row.data?.amount || 0))) }
    return hotels.map(hotel => ({ id: hotel.id, name: hotel.title, due: due.get(hotel.id) || 0, paid: paid.get(hotel.id) || 0, balance: number((due.get(hotel.id) || 0) - (paid.get(hotel.id) || 0)) }))
  })

  app.get('/dashboard', async request => {
    const ctx = requirePermission(request, 'query.read')
    const counts = await Promise.all(statuses.query.map(async status => {
      const { count, error } = await ctx.db.from('records').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('type', 'query').eq('status', status)
      if (error) throw new HttpError(400, error.message)
      return [status, count || 0] as const
    }))
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })
    const arrivals = unwrap(await ctx.db.from('records').select('id,title,status,data').eq('company_id', ctx.companyId).eq('type', 'query').gte('data->>arrival_date', today).order('data->>arrival_date').limit(5))
    const canReadFollowups = ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes('follow_up.read')
    const followups = canReadFollowups ? unwrap(await ctx.db.from('records').select('id,title,status,data').eq('company_id', ctx.companyId).eq('type', 'follow_up').eq('status', 'Active').lte('data->>due_date', today).order('data->>due_date').limit(5)) : []
    const { count: dueFollowups, error: dueError } = canReadFollowups
      ? await ctx.db.from('records').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('type', 'follow_up').eq('status', 'Active').lte('data->>due_date', today)
      : { count: 0, error: null }
    if (dueError) throw new HttpError(400, dueError.message)
    const { count: quoteCount } = ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes('quotes.read') ? await ctx.db.from('quotes').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId) : { count: 0 }
    return { counts: Object.fromEntries(counts), totalQueries: counts.reduce((sum, [, value]) => sum + value, 0), totalQuotes: quoteCount || 0, dueFollowups: dueFollowups || 0, arrivals, followups }
  })

  app.get('/records/:slug/:id/pdf', async (request, reply) => {
    const { slug, id } = path(request.params); const mod = modules[slug]
    if (!mod || !['invoice', 'stay_voucher', 'cab_voucher'].includes(mod.type)) throw new HttpError(404, 'Document not found.')
    const ctx = requirePermission(request, `${mod.type}.read`)
    const record = unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', mod.type).eq('id', id).single())
    const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
    const bytes = await recordPdf(mod.type, record, settings, ctx.companyName || 'Travel company')
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${mod.type}-${id.slice(0, 8)}.pdf"`)
    return reply.send(Buffer.from(bytes))
  })
}
