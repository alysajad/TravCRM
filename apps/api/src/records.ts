import type { FastifyInstance } from 'fastify'
import { admin, audit, HttpError, requirePermission, unwrap } from './core.js'
import { modules, validateRecord } from './modules.js'

const params = (value: unknown) => value as { slug: string; id?: string }
const query = (value: unknown) => value as { page?: string; q?: string; status?: string }

function invoiceAmounts(data: Record<string, unknown>): void {
  const lines = String(data.items || '').split('\n').map(x => x.trim()).filter(Boolean)
  const items = lines.map(line => {
    const parts = line.split('|').map(x => x.trim())
    const quantity = Number(parts[1]); const rate = Number(parts[2])
    if (!parts[0] || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0) throw new HttpError(400, 'Each item must be: description | quantity | rate.')
    return { description: parts[0], quantity, rate, amount: Math.round(quantity * rate * 100) / 100 }
  })
  if (!items.length) throw new HttpError(400, 'Add at least one invoice item.')
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  const gstPercent = Number(data.gst_percent || 0)
  if (gstPercent < 0 || gstPercent > 100) throw new HttpError(400, 'GST must be between 0 and 100%.')
  const gstAmount = Math.round(subtotal * gstPercent) / 100
  Object.assign(data, { items_parsed: items, subtotal, gst_amount: gstAmount, total: Math.round((subtotal + gstAmount) * 100) / 100 })
}

export async function registerRecords(app: FastifyInstance): Promise<void> {
  app.get('/modules', async request => {
    const ctx = request.crm!
    return Object.fromEntries(Object.entries(modules).filter(([, m]) => ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes(`${m.type}.read`)))
  })

  app.get('/options/:slug', async request => {
    const { slug } = params(request.params); const mod = modules[slug]
    if (!mod) throw new HttpError(404, 'Module not found.')
    const ctx = requirePermission(request, `${mod.type}.read`)
    let builder = ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', mod.type)
    if (mod.type !== 'query') builder = builder.eq('status', 'Active')
    const { data, error } = await builder.order('title').limit(1000)
    if (error) throw new HttpError(400, error.message)
    return data
  })

  app.get('/assignees', async request => {
    const ctx = requirePermission(request, 'query.read')
    return unwrap(await admin.from('memberships').select('user_id,name').eq('company_id', ctx.companyId).eq('active', true).order('name'))
  })

  app.get('/records/:slug/export.csv', async (request, reply) => {
    const { slug } = params(request.params); const mod = modules[slug]
    if (!mod) throw new HttpError(404, 'Module not found.')
    const ctx = requirePermission(request, `${mod.type}.read`)
    const { data, error } = await ctx.db.from('records').select('title,status,data,created_at').eq('company_id', ctx.companyId).eq('type', mod.type).order('created_at', { ascending: false }).limit(10000)
    if (error) throw new HttpError(400, error.message)
    const headers = [mod.label, ...mod.fields.filter(x => x.key !== mod.titleField).map(x => x.label), 'Status', 'Created at']
    const cell = (value: unknown) => {
      const raw = String(value ?? '')
      const safe = /^\s*[=+@-]/.test(raw) ? `'${raw}` : raw
      return `"${safe.replace(/"/g, '""')}"`
    }
    const lines = [headers.map(cell).join(','), ...(data || []).map(row => [row.title, ...mod.fields.filter(x => x.key !== mod.titleField).map(x => row.data?.[x.key]), row.status, row.created_at].map(cell).join(','))]
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${slug}.csv"`)
    return reply.send(`\uFEFF${lines.join('\r\n')}`)
  })

  app.get('/records/:slug', async request => {
    const { slug } = params(request.params); const mod = modules[slug]
    if (!mod) throw new HttpError(404, 'Module not found.')
    const ctx = requirePermission(request, `${mod.type}.read`)
    const { page = '1', q, status } = query(request.query)
    const pageNumber = Math.max(1, Math.min(Number(page) || 1, 100000))
    let builder = ctx.db.from('records').select('*', { count: 'exact' }).eq('company_id', ctx.companyId).eq('type', mod.type).order('created_at', { ascending: false }).range((pageNumber - 1) * 25, pageNumber * 25 - 1)
    if (q?.trim()) builder = builder.ilike('title', `%${q.trim().replace(/[%_]/g, '')}%`)
    if (status) builder = builder.eq('status', status)
    const { data, error, count } = await builder
    if (error) throw new HttpError(400, error.message)
    return { items: data, total: count ?? 0, page: pageNumber, pageSize: 25 }
  })

  app.get('/records/:slug/:id', async request => {
    const { slug, id } = params(request.params); const mod = modules[slug]
    if (!mod || !id) throw new HttpError(404, 'Record not found.')
    const ctx = requirePermission(request, `${mod.type}.read`)
    return unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', mod.type).eq('id', id).single())
  })

  app.post('/leads/:id/convert', async request => {
    const ctx = requirePermission(request, 'lead.read')
    requirePermission(request, 'query.write')
    const lead = unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'lead').eq('id', (request.params as { id: string }).id).single())
    const { data: existing } = await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'query').eq('data->>source_lead_id', lead.id).maybeSingle()
    if (existing) return existing
    const payload = { client_name: lead.data.name || lead.title, phone: lead.data.phone || '', email: lead.data.email || '', notes: `Lead from ${lead.data.page || 'Facebook'}`, source_lead_id: lead.id }
    if (!payload.phone) throw new HttpError(400, 'Add a phone number to this lead before creating a query.')
    const created = await ctx.db.from('records').insert({ company_id: ctx.companyId, type: 'query', title: payload.client_name, status: 'Pending', data: payload, created_by: ctx.userId }).select('*').single()
    if (created.error?.code === '23505') return unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', 'query').eq('data->>source_lead_id', lead.id).single())
    const item = unwrap(created)
    await admin.from('records').update({ data: { ...lead.data, converted_query_id: item.id } }).eq('company_id', ctx.companyId).eq('id', lead.id)
    await audit(ctx, 'leads.convert', item.id, { lead: lead.id })
    return item
  })

  async function validatedData(slug: string, body: unknown, ctx: ReturnType<typeof requirePermission>) {
    const mod = modules[slug]
    if (!mod) throw new HttpError(404, 'Module not found.')
    let value: ReturnType<typeof validateRecord>
    try { value = validateRecord(mod, body) } catch (error) { throw new HttpError(400, (error as Error).message) }
    for (const field of mod.fields.filter(x => x.key.endsWith('_path') && value.data[x.key])) {
      if (!String(value.data[field.key]).startsWith(`${ctx.companyId}/`)) throw new HttpError(400, `${field.label} must belong to this company.`)
    }
    for (const field of mod.fields.filter(x => x.kind === 'relation' && value.data[x.key])) {
      if (field.relation === 'users') {
        const { data } = await admin.from('memberships').select('user_id').eq('company_id', ctx.companyId).eq('user_id', value.data[field.key]).eq('active', true).maybeSingle()
        if (!data) throw new HttpError(400, `${field.label} is not in this company.`)
      } else if (field.relation === 'quotes') {
        const { data } = await ctx.db.from('quotes').select('id').eq('company_id', ctx.companyId).eq('id', value.data[field.key]).maybeSingle()
        if (!data) throw new HttpError(400, `${field.label} is not in this company.`)
      } else if (field.relation) {
        const related = modules[field.relation]
        if (!related) throw new HttpError(400, `${field.label} is invalid.`)
        const { data } = await ctx.db.from('records').select('id').eq('company_id', ctx.companyId).eq('type', related.type).eq('id', value.data[field.key]).maybeSingle()
        if (!data) throw new HttpError(400, `${field.label} is not in this company.`)
      }
    }
    if (mod.type === 'invoice') invoiceAmounts(value.data)
    if (['expense', 'hotel_payment'].includes(mod.type) && Number(value.data.amount) <= 0) throw new HttpError(400, 'Amount must be greater than zero.')
    return { mod, value }
  }

  app.post('/records/:slug', async request => {
    const { slug } = params(request.params); const mod = modules[slug]
    if (!mod) throw new HttpError(404, 'Module not found.')
    const ctx = requirePermission(request, `${mod.type}.write`)
    const { value } = await validatedData(slug, request.body, ctx)
    const item = unwrap(await ctx.db.from('records').insert({ company_id: ctx.companyId, type: mod.type, title: value.title, status: value.status, data: value.data, created_by: ctx.userId }).select('*').single())
    await audit(ctx, `${mod.type}.create`, item.id)
    return item
  })

  app.patch('/records/:slug/:id', async request => {
    const { slug, id } = params(request.params); const mod = modules[slug]
    if (!mod || !id) throw new HttpError(404, 'Record not found.')
    const ctx = requirePermission(request, `${mod.type}.write`)
    const { value } = await validatedData(slug, request.body, ctx)
    const previous = unwrap(await ctx.db.from('records').select('data').eq('company_id', ctx.companyId).eq('type', mod.type).eq('id', id).single())
    const preserved = Object.fromEntries(Object.entries(previous.data || {}).filter(([key]) => !mod.fields.some(field => field.key === key)))
    const item = unwrap(await ctx.db.from('records').update({ title: value.title, status: value.status, data: { ...preserved, ...value.data }, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('type', mod.type).eq('id', id).select('*').single())
    await audit(ctx, `${mod.type}.update`, id)
    return item
  })

  app.delete('/records/:slug/:id', async request => {
    const { slug, id } = params(request.params); const mod = modules[slug]
    if (!mod || !id) throw new HttpError(404, 'Record not found.')
    const ctx = requirePermission(request, `${mod.type}.write`)
    unwrap(await ctx.db.from('records').delete().eq('company_id', ctx.companyId).eq('type', mod.type).eq('id', id).select('id').single())
    await audit(ctx, `${mod.type}.delete`, id)
    return { ok: true }
  })
}
