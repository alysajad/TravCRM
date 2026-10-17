import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { admin, HttpError, platformAudit, requireContext, unwrap, type Context } from './core.js'

const companyId = (request: FastifyRequest) => (request.params as { id: string }).id
function platform(request: FastifyRequest): Context {
  const ctx = requireContext(request)
  if (!ctx.platform) throw new HttpError(403, 'Only a platform admin can use this area.')
  return ctx
}

const subscriptionSchema = z.object({
  billing_cycle: z.enum(['monthly', 'annual']),
  price: z.coerce.number().min(0),
  started_at: z.iso.date(),
  renews_on: z.iso.date().nullable().optional(),
  payment_status: z.enum(['trial', 'paid', 'due', 'overdue', 'waived']),
  notes: z.string().max(2000).nullable().optional()
})

function rows<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw new HttpError(400, result.error.message)
  return result.data || []
}

async function overview() {
  const [companiesResult, membersResult, recordsResult, quotesResult, integrationsResult, subscriptionsResult, revenueResult] = await Promise.all([
    admin.from('companies').select('id,name,slug,status,trial_ends_at,created_at,updated_at').order('created_at', { ascending: false }),
    admin.from('memberships').select('company_id,active'),
    admin.from('records').select('company_id,type,status,created_at'),
    admin.from('quotes').select('company_id,status,total_amount,created_at'),
    admin.from('integration_accounts').select('company_id,kind,last_success_at,last_error,updated_at'),
    admin.from('company_subscriptions').select('*'),
    admin.from('platform_subscription_payments').select('company_id,amount,paid_at')
  ])
  const companies = rows(companiesResult)
  const members = rows(membersResult)
  const records = rows(recordsResult)
  const quotes = rows(quotesResult)
  const integrations = rows(integrationsResult)
  const subscriptions = rows(subscriptionsResult)
  const revenue = rows(revenueResult)
  const health = companies.map(company => {
    const companyRecords = records.filter(x => x.company_id === company.id)
    const companyQuotes = quotes.filter(x => x.company_id === company.id)
    const companyIntegrations = integrations.filter(x => x.company_id === company.id)
    const lastDates = [...companyRecords.map(x => x.created_at), ...companyQuotes.map(x => x.created_at)].filter(Boolean).sort().reverse()
    return {
      ...company,
      users: members.filter(x => x.company_id === company.id && x.active).length,
      leads: companyRecords.filter(x => x.type === 'lead').length,
      queries: companyRecords.filter(x => x.type === 'query').length,
      quotes: companyQuotes.length,
      confirmed: companyQuotes.filter(x => x.status === 'Confirmed').length,
      travel_value: companyQuotes.reduce((sum, x) => sum + Number(x.total_amount || 0), 0),
      connections: companyIntegrations.length,
      connection_errors: companyIntegrations.filter(x => x.last_error).length,
      last_activity: lastDates[0] || null,
      subscription: subscriptions.find(x => x.company_id === company.id) || null
    }
  })
  const statusCounts = Object.fromEntries(['trial', 'active', 'suspended', 'archived'].map(status => [status, companies.filter(x => x.status === status).length]))
  return {
    summary: {
      companies: companies.length,
      ...statusCounts,
      users: members.filter(x => x.active).length,
      leads: records.filter(x => x.type === 'lead').length,
      quotes: quotes.length,
      confirmed: quotes.filter(x => x.status === 'Confirmed').length,
      travel_value: quotes.reduce((sum, x) => sum + Number(x.total_amount || 0), 0),
      revenue_received: revenue.reduce((sum, x) => sum + Number(x.amount || 0), 0),
      revenue_due: subscriptions.filter(x => ['due', 'overdue'].includes(x.payment_status)).reduce((sum, x) => sum + Number(x.price || 0), 0)
    },
    companies: health
  }
}

async function storageFiles(path: string): Promise<string[]> {
  const found: string[] = []
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.storage.from('crm-private').list(path, { limit: 100, offset })
    if (error) throw new HttpError(502, `Could not inspect company files: ${error.message}`)
    for (const item of data || []) {
      const child = `${path}/${item.name}`
      if (item.id) found.push(child)
      else found.push(...await storageFiles(child))
    }
    if (!data || data.length < 100) break
  }
  return found
}

export async function registerPlatform(app: FastifyInstance): Promise<void> {
  app.get('/platform/overview', async request => { platform(request); return overview() })

  app.get('/platform/companies', async request => { platform(request); return (await overview()).companies })

  app.get('/platform/companies/:id', async request => {
    platform(request)
    const id = companyId(request)
    const [company, subscription, payments, users, integrations, records, quotes] = await Promise.all([
      admin.from('companies').select('*').eq('id', id).single(),
      admin.from('company_subscriptions').select('*').eq('company_id', id).maybeSingle(),
      admin.from('platform_subscription_payments').select('*').eq('company_id', id).order('paid_at', { ascending: false }),
      admin.from('memberships').select('user_id,name,email,active,created_at,roles(name)').eq('company_id', id).order('name'),
      admin.from('integration_accounts').select('kind,external_id,connected_at,last_success_at,last_error,updated_at').eq('company_id', id),
      admin.from('records').select('type,status,created_at').eq('company_id', id),
      admin.from('quotes').select('status,total_amount,created_at').eq('company_id', id)
    ])
    const c = unwrap(company)
    return { company: c, subscription: subscription.data, payments: rows(payments), users: rows(users), integrations: rows(integrations), metrics: {
      leads: rows(records).filter(x => x.type === 'lead').length,
      queries: rows(records).filter(x => x.type === 'query').length,
      quotes: rows(quotes).length,
      confirmed: rows(quotes).filter(x => x.status === 'Confirmed').length,
      travel_value: rows(quotes).reduce((sum, x) => sum + Number(x.total_amount || 0), 0)
    } }
  })

  app.patch('/platform/companies/:id', async request => {
    const ctx = platform(request)
    const parsed = z.object({ name: z.string().trim().min(2).max(120).optional(), slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(), trial_ends_at: z.iso.date().nullable().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check the company details.')
    const updated = unwrap(await admin.from('companies').update(parsed.data).eq('id', companyId(request)).select('*').single())
    await platformAudit(ctx, 'companies.update', updated)
    return updated
  })

  app.post('/platform/companies/:id/access', async request => {
    const ctx = platform(request)
    const company = unwrap(await admin.from('companies').select('id,name,status').eq('id', companyId(request)).single())
    if (company.status === 'archived') throw new HttpError(400, 'Restore this company before opening its workspace.')
    await platformAudit(ctx, 'companies.workspace.open', company)
    return { ok: true }
  })

  app.post('/platform/companies/:id/status', async request => {
    const ctx = platform(request)
    const parsed = z.object({ status: z.enum(['trial', 'active', 'suspended', 'archived']), reason: z.string().trim().max(1000).optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a valid company status.')
    const current = unwrap(await admin.from('companies').select('id,name,status').eq('id', companyId(request)).single())
    const now = new Date().toISOString()
    const changes = {
      status: parsed.data.status,
      suspension_reason: parsed.data.status === 'suspended' ? parsed.data.reason || 'Suspended by platform admin' : null,
      suspended_at: parsed.data.status === 'suspended' ? now : null,
      archived_at: parsed.data.status === 'archived' ? now : null
    }
    const updated = unwrap(await admin.from('companies').update(changes).eq('id', current.id).select('*').single())
    await platformAudit(ctx, `companies.${parsed.data.status}`, current, { from: current.status, reason: parsed.data.reason })
    return updated
  })

  app.put('/platform/companies/:id/subscription', async request => {
    const ctx = platform(request)
    const parsed = subscriptionSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check subscription details.')
    const company = unwrap(await admin.from('companies').select('id,name').eq('id', companyId(request)).single())
    const subscription = unwrap(await admin.from('company_subscriptions').upsert({ company_id: company.id, ...parsed.data, updated_at: new Date().toISOString() }).select('*').single())
    await platformAudit(ctx, 'subscriptions.update', company)
    return subscription
  })

  app.post('/platform/companies/:id/subscription-payments', async request => {
    const ctx = platform(request)
    const parsed = z.object({ amount: z.coerce.number().positive(), paid_at: z.iso.date(), method: z.string().trim().min(2).max(80), reference: z.string().max(200).nullable().optional(), period_start: z.iso.date().nullable().optional(), period_end: z.iso.date().nullable().optional(), notes: z.string().max(1000).nullable().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check the payment details.')
    const company = unwrap(await admin.from('companies').select('id,name').eq('id', companyId(request)).single())
    const payment = unwrap(await admin.from('platform_subscription_payments').insert({ company_id: company.id, ...parsed.data, created_by: ctx.userId }).select('*').single())
    await admin.from('company_subscriptions').update({ payment_status: 'paid', updated_at: new Date().toISOString() }).eq('company_id', company.id)
    await platformAudit(ctx, 'subscriptions.payment.record', company, { amount: payment.amount })
    return payment
  })

  app.get('/platform/settings', async request => { platform(request); return unwrap(await admin.from('platform_settings').select('*').eq('singleton', true).single()) })
  app.patch('/platform/settings', async request => {
    const ctx = platform(request)
    const parsed = z.object({ monthly_price: z.coerce.number().min(0), annual_price: z.coerce.number().min(0) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Enter valid monthly and annual prices.')
    const value = unwrap(await admin.from('platform_settings').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('singleton', true).select('*').single())
    await platformAudit(ctx, 'platform.settings.update', null, parsed.data)
    return value
  })

  app.get('/platform/audit', async request => {
    platform(request)
    return rows(await admin.from('platform_audit_events').select('*').order('created_at', { ascending: false }).limit(250))
  })

  app.delete('/platform/companies/:id', async request => {
    const ctx = platform(request)
    const parsed = z.object({ confirm_slug: z.string() }).safeParse(request.body)
    const company = unwrap(await admin.from('companies').select('id,name,slug,status').eq('id', companyId(request)).single())
    if (company.status !== 'archived') throw new HttpError(400, 'Archive this company before permanently erasing it.')
    if (!parsed.success || parsed.data.confirm_slug !== company.slug) throw new HttpError(400, `Type ${company.slug} to confirm permanent erasure.`)
    const memberships = rows(await admin.from('memberships').select('user_id').eq('company_id', company.id))
    const files = await storageFiles(company.id)
    if (files.length) {
      const { error } = await admin.storage.from('crm-private').remove(files)
      if (error) throw new HttpError(502, `Company files could not be erased: ${error.message}`)
    }
    for (const table of ['records','quotes','payments','messages'] as const) await admin.from(table).update({ created_by: null }).eq('company_id', company.id)
    await admin.from('audit_events').update({ actor_id: null }).eq('company_id', company.id)
    for (const member of memberships) {
      const { data: protectedUser } = await admin.from('platform_admins').select('user_id').eq('user_id', member.user_id).maybeSingle()
      if (!protectedUser) {
        const { error } = await admin.auth.admin.deleteUser(member.user_id)
        if (error) throw new HttpError(502, `A company account could not be erased: ${error.message}`)
      }
    }
    await platformAudit(ctx, 'companies.erase', company, { slug: company.slug })
    const { error } = await admin.from('companies').delete().eq('id', company.id)
    if (error) throw new HttpError(400, error.message)
    return { ok: true }
  })
}
