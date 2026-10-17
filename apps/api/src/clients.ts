import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, HttpError, requirePermission, unwrap, type Context } from './core.js'

export const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase()
export const normalizePhone = (value: unknown) => String(value || '').replace(/\D/g, '')

export type ClientMatch = { id: string; data?: Record<string, unknown> }
export type ClientMatchResult = { outcome: 'unique' | 'none' | 'conflict' | 'missing'; clientId: string | null }

export function matchClientContacts(clients: ClientMatch[], email: unknown, phone: unknown): ClientMatchResult {
  const normalizedEmail = normalizeEmail(email); const normalizedPhone = normalizePhone(phone)
  if (!normalizedEmail && !normalizedPhone) return { outcome: 'missing', clientId: null }
  const matches = new Set(clients.filter(client =>
    (normalizedEmail && client.data?.email_normalized === normalizedEmail) ||
    (normalizedPhone && client.data?.phone_normalized === normalizedPhone)
  ).map(client => client.id))
  return matches.size === 1 ? { outcome: 'unique', clientId: [...matches][0]! } : matches.size ? { outcome: 'conflict', clientId: null } : { outcome: 'none', clientId: null }
}

type CompanyContext = Context & { companyId: string }

async function clientById(companyId: string, clientId: string) {
  const { data } = await admin.from('records').select('id,title,data,status').eq('company_id', companyId).eq('type', 'client').eq('id', clientId).maybeSingle()
  if (!data) throw new HttpError(400, 'The selected client is not in this company.')
  return data
}

async function matchingClients(companyId: string, email: unknown, phone: unknown): Promise<ClientMatch[]> {
  const normalizedEmail = normalizeEmail(email); const normalizedPhone = normalizePhone(phone)
  const [emails, phones] = await Promise.all([
    normalizedEmail ? admin.from('records').select('id,data').eq('company_id', companyId).eq('type', 'client').eq('data->>email_normalized', normalizedEmail) : Promise.resolve({ data: [], error: null }),
    normalizedPhone ? admin.from('records').select('id,data').eq('company_id', companyId).eq('type', 'client').eq('data->>phone_normalized', normalizedPhone) : Promise.resolve({ data: [], error: null })
  ])
  if (emails.error || phones.error) throw new HttpError(400, emails.error?.message || phones.error?.message || 'Could not match the client.')
  return [...new Map([...(emails.data || []), ...(phones.data || [])].map(row => [row.id, row])).values()]
}

export async function resolveClientLink(ctx: CompanyContext, input: { clientId?: string | null; inheritedClientId?: string | null; name: string; email?: unknown; phone?: unknown; create?: boolean }) {
  if (input.clientId) {
    await clientById(ctx.companyId, input.clientId)
    if (input.inheritedClientId && input.inheritedClientId !== input.clientId) throw new HttpError(409, 'The selected client conflicts with the linked query.')
    return { clientId: input.clientId, status: 'linked' as const, outcome: 'explicit' as const }
  }
  if (input.inheritedClientId) {
    await clientById(ctx.companyId, input.inheritedClientId)
    return { clientId: input.inheritedClientId, status: 'linked' as const, outcome: 'inherited' as const }
  }
  const matches = await matchingClients(ctx.companyId, input.email, input.phone)
  const match = matchClientContacts(matches, input.email, input.phone)
  if (match.clientId) return { clientId: match.clientId, status: 'linked' as const, outcome: match.outcome }
  if (match.outcome === 'none' && input.create !== false) {
    const email = String(input.email || '').trim(); const phone = String(input.phone || '').trim()
    const data = { name: input.name, ...(phone ? { phone } : {}), ...(email ? { email } : {}), email_normalized: normalizeEmail(email), phone_normalized: normalizePhone(phone) }
    const created = unwrap(await admin.from('records').insert({ company_id: ctx.companyId, type: 'client', title: input.name, status: 'Active', data, created_by: ctx.userId }).select('id').single())
    return { clientId: created.id, status: 'linked' as const, outcome: 'created' as const }
  }
  return { clientId: null, status: 'needs_review' as const, outcome: match.outcome }
}

const allowed = (ctx: Context, permission: string) => ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes(permission)
const path = (value: unknown) => value as { id: string; activityId?: string }
const timeline = (type: string, id: string, occurred_at: string, title: string, body?: string, href?: string, meta?: Record<string, unknown>) => ({ type, id, occurred_at, title, body: body || null, href: href || null, ...meta })
export const latestTimeline = <T extends { occurred_at: string }>(entries: T[]) => [...entries].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, 100)

export async function registerClients(app: FastifyInstance): Promise<void> {
  app.get('/clients/:id/overview', async request => {
    const ctx = requirePermission(request, 'client.read'); const clientId = path(request.params).id
    const client = unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'client').eq('id', clientId).single())
    const canQueries = allowed(ctx, 'query.read'); const canQuotes = allowed(ctx, 'quotes.read'); const canBookings = allowed(ctx, 'bookings.read')
    const canPayments = allowed(ctx, 'payments.read'); const canFollowups = allowed(ctx, 'follow_up.read'); const canMessages = allowed(ctx, 'messages.read')
    const [queryResult, quoteResult, bookingResult, activityResult] = await Promise.all([
      canQueries ? ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'query').eq('data->>client_id', clientId).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      canQuotes ? ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('client_id', clientId).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      canBookings ? ctx.db.from('bookings').select('*').eq('company_id', ctx.companyId).eq('client_id', clientId).order('confirmed_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      ctx.db.from('client_activities').select('*').eq('company_id', ctx.companyId).eq('client_id', clientId).order('occurred_at', { ascending: false }).limit(100)
    ])
    for (const result of [queryResult, quoteResult, bookingResult, activityResult]) if (result.error) throw new HttpError(400, result.error.message)
    const queries = queryResult.data || []; const quotes = quoteResult.data || []; const bookings = bookingResult.data || []
    const missingQueryIds = canQueries ? [...new Set(quotes.map(row => row.query_id).filter((value): value is string => Boolean(value) && !queries.some(query => query.id === value)))] : []
    if (missingQueryIds.length) queries.push(...unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'query').in('id', missingQueryIds)))
    const identityQueries = !canQueries && (canFollowups || canMessages) ? unwrap(await admin.from('records').select('id').eq('company_id', ctx.companyId).eq('type', 'query').eq('data->>client_id', clientId)) : queries
    const identityQuotes = !canQuotes && (canPayments || canFollowups || canMessages) ? unwrap(await admin.from('quotes').select('id,quote_series_id,quote_revision,total_amount').eq('company_id', ctx.companyId).eq('client_id', clientId)) : quotes
    const identityBookings = !canBookings && canMessages ? unwrap(await admin.from('bookings').select('id').eq('company_id', ctx.companyId).eq('client_id', clientId)) : bookings
    const queryIds = identityQueries.map(row => row.id); const quoteIds = identityQuotes.map(row => row.id); const bookingIds = identityBookings.map(row => row.id)
    const bookingDocumentIds = canMessages && bookingIds.length ? (unwrap(await admin.from('booking_documents').select('id').eq('company_id', ctx.companyId).in('booking_id', bookingIds))).map(row => row.id) : []
    const [paymentResult, followupResult, messageResult] = await Promise.all([
      canPayments && quoteIds.length ? ctx.db.from('payments').select('*').eq('company_id', ctx.companyId).in('quote_id', quoteIds) : Promise.resolve({ data: [], error: null }),
      canFollowups ? ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'follow_up').eq('status', 'Active').limit(1000) : Promise.resolve({ data: [], error: null }),
      canMessages ? ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(1000) : Promise.resolve({ data: [], error: null })
    ])
    for (const result of [paymentResult, followupResult, messageResult]) if (result.error) throw new HttpError(400, result.error.message)
    const payments = paymentResult.data || []
    const followups = (followupResult.data || []).filter(row => row.data?.client_id === clientId || queryIds.includes(row.data?.query_id) || quoteIds.includes(row.data?.quote_id)).sort((a, b) => String(a.data?.due_date || '').localeCompare(String(b.data?.due_date || '')))
    const messages = (messageResult.data || []).filter(row => quoteIds.includes(row.quote_id) || queryIds.includes(row.record_id) || bookingIds.includes(row.booking_id) || bookingDocumentIds.includes(row.booking_document_id))
    const series = new Map<string, any[]>()
    for (const quote of quotes) series.set(quote.quote_series_id, [...(series.get(quote.quote_series_id) || []), quote])
    const financeSeries = new Map<string, any[]>()
    for (const quote of identityQuotes) financeSeries.set(quote.quote_series_id, [...(financeSeries.get(quote.quote_series_id) || []), quote])
    const seriesView = (rows: any[]) => {
      const revisions = [...rows].sort((a, b) => Number(b.quote_revision) - Number(a.quote_revision)); const latest = revisions[0]
      const seriesQuoteIds = revisions.map(row => row.id); const received = payments.filter(row => seriesQuoteIds.includes(row.quote_id)).reduce((sum, row) => sum + Number(row.amount), 0)
      return { id: latest.quote_series_id, latest, revisions, booking: bookings.find(row => row.quote_series_id === latest.quote_series_id) || null, ...(canPayments ? { received, balance: Math.max(0, Number(latest.total_amount) - received) } : {}) }
    }
    const queryJourneys = queries.map(query => ({ query, quote_series: [...series.values()].filter(rows => rows.some(quote => quote.query_id === query.id)).map(seriesView) }))
    const directQuotes = [...series.values()].filter(rows => rows.every(quote => !quote.query_id)).map(seriesView)
    const entries = latestTimeline([
      ...(activityResult.data || []).map(row => timeline(row.type, row.id, row.occurred_at, row.type === 'call' ? `${row.direction === 'incoming' ? 'Incoming' : 'Outgoing'} call` : 'Note added', row.body, undefined, { outcome: row.outcome })),
      ...quotes.map(row => timeline('quotation', row.id, row.created_at, `${row.quote_number} · Revision ${row.quote_revision}`, `${row.destination} · ${row.status}`, row.locked_at ? '/quotes' : `/quotes/${row.id}/edit`)),
      ...bookings.map(row => timeline('booking', row.id, row.confirmed_at, `Booking ${row.booking_number} confirmed`, `${row.destination} · ${row.status}`, `/bookings/${row.id}`)),
      ...payments.map(row => timeline('payment', row.id, row.paid_at ? `${row.paid_at}T12:00:00Z` : row.created_at, 'Payment received', `${row.amount} · ${row.method}`, '/payments')),
      ...followups.map(row => timeline('follow_up', row.id, row.created_at, row.title, row.data?.notes, `/records/follow-ups?edit=${row.id}`, { due_at: row.data?.due_date })),
      ...messages.map(row => timeline('message', row.id, row.sent_at || row.created_at, `${row.channel === 'email' ? 'Email' : 'WhatsApp'} ${row.status}`, row.recipient))
    ])
    const summary: Record<string, number> = {}
    if (canQueries) summary.queries = queries.length
    if (canBookings) summary.booked_trips = bookings.length
    if (canPayments) {
      summary.received = payments.reduce((sum, row) => sum + Number(row.amount), 0)
      summary.outstanding = [...financeSeries.values()].reduce((sum, rows) => sum + Number(seriesView(rows).balance || 0), 0)
    }
    return { client, summary, ...(canFollowups ? { follow_ups: followups } : {}), ...(canQueries || canQuotes ? { journeys: queryJourneys, direct_quotes: directQuotes } : {}), timeline: entries }
  })

  app.post('/clients/:id/activities', async request => {
    const ctx = requirePermission(request, 'client.write'); const clientId = path(request.params).id
    const parsed = z.discriminatedUnion('type', [
      z.object({ type: z.literal('note'), body: z.string().trim().min(1).max(10000), occurred_at: z.iso.datetime().optional() }),
      z.object({ type: z.literal('call'), body: z.string().trim().min(1).max(10000), occurred_at: z.iso.datetime().optional(), direction: z.enum(['incoming','outgoing']), outcome: z.enum(['connected','no_answer','left_message','callback_requested']) })
    ]).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Add valid activity details.')
    await clientById(ctx.companyId, clientId)
    const row = unwrap(await ctx.db.from('client_activities').insert({ company_id: ctx.companyId, client_id: clientId, created_by: ctx.userId, ...parsed.data }).select('*').single())
    await audit(ctx, 'client.activity.create', row.id, { client: clientId, type: row.type })
    return row
  })

  app.delete('/clients/:id/activities/:activityId', async request => {
    const ctx = requirePermission(request, 'client.write'); const { id, activityId } = path(request.params)
    unwrap(await ctx.db.from('client_activities').delete().eq('company_id', ctx.companyId).eq('client_id', id).eq('id', activityId!).select('id').single())
    await audit(ctx, 'client.activity.delete', activityId, { client: id })
    return { ok: true }
  })

  app.patch('/queries/:id/client', async request => {
    const ctx = requirePermission(request, 'query.write'); const queryId = path(request.params).id
    const parsed = z.object({ client_id: z.uuid().nullable() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a valid client.')
    if (parsed.data.client_id) await clientById(ctx.companyId, parsed.data.client_id)
    const query = unwrap(await admin.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'query').eq('id', queryId).single())
    const data = { ...query.data }; parsed.data.client_id ? data.client_id = parsed.data.client_id : delete data.client_id
    const updated = unwrap(await admin.from('records').update({ data, updated_at: new Date().toISOString() }).eq('id', query.id).select('*').single())
    await admin.from('quotes').update({ client_id: parsed.data.client_id }).eq('company_id', ctx.companyId).eq('query_id', query.id)
    await audit(ctx, 'query.client.assign', query.id, { client_id: parsed.data.client_id })
    return { ...updated, client_link_status: parsed.data.client_id ? 'linked' : 'needs_review' }
  })

  app.patch('/quotes/:id/client', async request => {
    const ctx = requirePermission(request, 'quotes.write'); const quoteId = path(request.params).id
    const parsed = z.object({ client_id: z.uuid().nullable() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a valid client.')
    const quote = unwrap(await admin.from('quotes').select('id,query_id,quote_series_id').eq('company_id', ctx.companyId).eq('id', quoteId).single())
    if (parsed.data.client_id) await clientById(ctx.companyId, parsed.data.client_id)
    if (quote.query_id) {
      const query = unwrap(await admin.from('records').select('data').eq('company_id', ctx.companyId).eq('type', 'query').eq('id', quote.query_id).single())
      if (query.data?.client_id && query.data.client_id !== parsed.data.client_id) throw new HttpError(409, 'The selected client conflicts with the linked query.')
    }
    unwrap(await admin.from('quotes').update({ client_id: parsed.data.client_id, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('quote_series_id', quote.quote_series_id).select('id'))
    await audit(ctx, 'quotes.client.assign', quote.id, { client_id: parsed.data.client_id })
    return { ok: true, client_id: parsed.data.client_id, client_link_status: parsed.data.client_id ? 'linked' : 'needs_review' }
  })
}
