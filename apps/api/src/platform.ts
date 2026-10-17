import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { admin, companyEntitlements, HttpError, platformAudit, requireContext, unwrap, type Context } from './core.js'

const companyId = (request: FastifyRequest) => (request.params as { id: string }).id
function platform(request: FastifyRequest): Context {
  const ctx = requireContext(request)
  if (!ctx.platform) throw new HttpError(403, 'Only a platform admin can use this area.')
  return ctx
}

const subscriptionSchema = z.object({
  plan_id: z.uuid(),
  billing_cycle: z.enum(['monthly', 'annual']),
  price: z.coerce.number().min(0),
  started_at: z.iso.date(),
  renews_on: z.iso.date().nullable().optional(),
  payment_status: z.enum(['trial', 'paid', 'due', 'overdue', 'waived']),
  subscription_status: z.enum(['trialing', 'active', 'past_due', 'cancelled']),
  current_period_start: z.iso.date().nullable().optional(),
  current_period_end: z.iso.date().nullable().optional(),
  cancel_at_period_end: z.boolean().default(false),
  limit_overrides: z.record(z.string(), z.coerce.number().int().min(-1).max(1000000)).default({}),
  feature_overrides: z.record(z.string(), z.boolean()).default({}),
  notes: z.string().max(2000).nullable().optional()
})

const featureKeys = ['crm','quotations','bookings','documents','finance','integrations','custom_branding','reports','api_access','priority_support'] as const
const planSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().optional(), active: z.boolean().default(true),
  monthly_price: z.coerce.number().min(0), annual_price: z.coerce.number().min(0), trial_days: z.coerce.number().int().min(0).max(365),
  limits: z.record(z.string(), z.coerce.number().int().min(-1).max(1000000)), features: z.array(z.enum(featureKeys)),
  display_order: z.coerce.number().int().min(0).max(1000)
})

const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
const dayDistance = (value?: string | null) => value ? Math.ceil((new Date(value).getTime() - Date.now()) / 86400000) : null

function rows<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw new HttpError(400, result.error.message)
  return result.data || []
}

async function overview() {
  const since = monthStart()
  const [companiesResult, membersResult, recordsResult, quotesResult, bookingsResult, integrationsResult, subscriptionsResult, revenueResult, supportResult] = await Promise.all([
    admin.from('companies').select('id,name,slug,status,trial_ends_at,created_at,updated_at').order('created_at', { ascending: false }),
    admin.from('memberships').select('company_id,active'),
    admin.from('records').select('company_id,type,status,created_at'),
    admin.from('quotes').select('company_id,status,total_amount,created_at'),
    admin.from('bookings').select('company_id,status,total_amount,created_at'),
    admin.from('integration_accounts').select('company_id,kind,last_success_at,last_error,updated_at'),
    admin.from('company_subscriptions').select('*,subscription_plans(id,code,name,limits,features)'),
    admin.from('platform_subscription_payments').select('company_id,amount,paid_at'),
    admin.from('platform_support_sessions').select('id').is('revoked_at', null).gt('expires_at', new Date().toISOString())
  ])
  const companies = rows(companiesResult)
  const members = rows(membersResult)
  const records = rows(recordsResult)
  const quotes = rows(quotesResult)
  const bookings = rows(bookingsResult)
  const integrations = rows(integrationsResult)
  const subscriptions = rows(subscriptionsResult)
  const revenue = rows(revenueResult)
  const supportSessions = rows(supportResult)
  const health = companies.map(company => {
    const companyRecords = records.filter(x => x.company_id === company.id)
    const companyQuotes = quotes.filter(x => x.company_id === company.id)
    const companyIntegrations = integrations.filter(x => x.company_id === company.id)
    const companyBookings = bookings.filter(x => x.company_id === company.id)
    const subscription = subscriptions.find(x => x.company_id === company.id) || null
    const lastDates = [...companyRecords.map(x => x.created_at), ...companyQuotes.map(x => x.created_at), ...companyBookings.map(x => x.created_at)].filter(Boolean).sort().reverse()
    const lastActivity = lastDates[0] || null
    const trialDays = dayDistance(company.trial_ends_at)
    let healthScore = 100
    if (company.status === 'suspended') healthScore -= 70
    if (company.status === 'archived') healthScore = 0
    if (subscription?.payment_status === 'overdue' || subscription?.subscription_status === 'past_due') healthScore -= 30
    if (trialDays !== null && trialDays >= 0 && trialDays <= 7) healthScore -= 20
    if (companyIntegrations.some(x => x.last_error)) healthScore -= 15
    if (!lastActivity || Date.now() - new Date(lastActivity).getTime() > 30 * 86400000) healthScore -= 20
    if (!members.some(x => x.company_id === company.id && x.active)) healthScore -= 25
    healthScore = Math.max(0, healthScore)
    return {
      ...company,
      users: members.filter(x => x.company_id === company.id && x.active).length,
      leads: companyRecords.filter(x => x.type === 'lead').length,
      queries: companyRecords.filter(x => x.type === 'query').length,
      quotes: companyQuotes.length,
      bookings: companyBookings.length,
      confirmed: companyQuotes.filter(x => x.status === 'Confirmed').length,
      travel_value: companyQuotes.reduce((sum, x) => sum + Number(x.total_amount || 0), 0),
      connections: companyIntegrations.length,
      connection_errors: companyIntegrations.filter(x => x.last_error).length,
      last_activity: lastActivity,
      usage: {
        team_members: members.filter(x => x.company_id === company.id && x.active).length,
        leads_monthly: companyRecords.filter(x => x.type === 'lead' && x.created_at >= since).length,
        quotes_monthly: companyQuotes.filter(x => x.created_at >= since).length,
        bookings_monthly: companyBookings.filter(x => x.created_at >= since).length
      },
      health_score: healthScore,
      health_label: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'watch' : 'risk',
      subscription
    }
  })
  const statusCounts = Object.fromEntries(['trial', 'active', 'suspended', 'archived'].map(status => [status, companies.filter(x => x.status === status).length]))
  const mrr = subscriptions.filter(x => ['active','past_due'].includes(x.subscription_status)).reduce((sum, x) => sum + Number(x.price || 0) / (x.billing_cycle === 'annual' ? 12 : 1), 0)
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
      revenue_due: subscriptions.filter(x => ['due', 'overdue'].includes(x.payment_status)).reduce((sum, x) => sum + Number(x.price || 0), 0),
      mrr,
      past_due: subscriptions.filter(x => x.subscription_status === 'past_due' || x.payment_status === 'overdue').length,
      trials_ending: companies.filter(x => { const days = dayDistance(x.trial_ends_at); return x.status === 'trial' && days !== null && days >= 0 && days <= 7 }).length,
      at_risk: health.filter(x => x.health_label === 'risk').length,
      support_sessions: supportSessions.length
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
    const since = monthStart()
    const [company, subscription, payments, users, integrations, records, quotes, bookings, supportSessions] = await Promise.all([
      admin.from('companies').select('*').eq('id', id).single(),
      admin.from('company_subscriptions').select('*,subscription_plans(id,code,name,features,limits)').eq('company_id', id).maybeSingle(),
      admin.from('platform_subscription_payments').select('*').eq('company_id', id).order('paid_at', { ascending: false }),
      admin.from('memberships').select('user_id,name,email,active,created_at,roles(name)').eq('company_id', id).order('name'),
      admin.from('integration_accounts').select('kind,external_id,connected_at,last_success_at,last_error,updated_at').eq('company_id', id),
      admin.from('records').select('type,status,created_at').eq('company_id', id),
      admin.from('quotes').select('status,total_amount,created_at').eq('company_id', id),
      admin.from('bookings').select('status,total_amount,created_at').eq('company_id', id),
      admin.from('platform_support_sessions').select('id,reason,expires_at,revoked_at,created_at').eq('company_id', id).order('created_at', { ascending: false }).limit(10)
    ])
    const c = unwrap(company)
    const recordRows = rows(records); const quoteRows = rows(quotes); const bookingRows = rows(bookings); const integrationRows = rows(integrations); const userRows = rows(users)
    const lastActivity = [...recordRows.map(x => x.created_at), ...quoteRows.map(x => x.created_at), ...bookingRows.map(x => x.created_at)].filter(Boolean).sort().reverse()[0] || null
    const trialDays = dayDistance(c.trial_ends_at); let healthScore = 100
    if (c.status === 'suspended') healthScore -= 70
    if (c.status === 'archived') healthScore = 0
    if (subscription.data?.payment_status === 'overdue' || subscription.data?.subscription_status === 'past_due') healthScore -= 30
    if (trialDays !== null && trialDays >= 0 && trialDays <= 7) healthScore -= 20
    if (integrationRows.some(x => x.last_error)) healthScore -= 15
    if (!lastActivity || Date.now() - new Date(lastActivity).getTime() > 30 * 86400000) healthScore -= 20
    if (!userRows.some(x => x.active)) healthScore -= 25
    healthScore = Math.max(0, healthScore)
    return {
      company: { ...c, health_score: healthScore, health_label: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'watch' : 'risk', last_activity: lastActivity }, subscription: subscription.data, payments: rows(payments), users: userRows, integrations: integrationRows, support_sessions: rows(supportSessions),
      entitlements: await companyEntitlements(id),
      usage: {
        team_members: userRows.filter(x => x.active).length,
        leads_monthly: recordRows.filter(x => x.type === 'lead' && x.created_at >= since).length,
        quotes_monthly: quoteRows.filter(x => x.created_at >= since).length,
        bookings_monthly: bookingRows.filter(x => x.created_at >= since).length
      },
      metrics: {
        leads: recordRows.filter(x => x.type === 'lead').length,
        queries: recordRows.filter(x => x.type === 'query').length,
        quotes: quoteRows.length,
        bookings: bookingRows.length,
        confirmed: quoteRows.filter(x => x.status === 'Confirmed').length,
        travel_value: quoteRows.reduce((sum, x) => sum + Number(x.total_amount || 0), 0)
      }
    }
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
    const parsed = z.object({ reason: z.string().trim().min(3).max(500), minutes: z.coerce.number().int().min(15).max(480).optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Add a short reason for opening this workspace.')
    const company = unwrap(await admin.from('companies').select('id,name,status').eq('id', companyId(request)).single())
    if (company.status === 'archived') throw new HttpError(400, 'Restore this company before opening its workspace.')
    const settings = unwrap(await admin.from('platform_settings').select('support_session_minutes').eq('singleton', true).single())
    const minutes = parsed.data.minutes || settings.support_session_minutes
    const expiresAt = new Date(Date.now() + minutes * 60000).toISOString()
    const session = unwrap(await admin.from('platform_support_sessions').insert({ platform_admin_id: ctx.userId, company_id: company.id, reason: parsed.data.reason, expires_at: expiresAt }).select('id,expires_at').single())
    await platformAudit(ctx, 'companies.workspace.open', company, { reason: parsed.data.reason, minutes, support_session_id: session.id })
    return session
  })

  app.post('/platform/support-sessions/:id/revoke', async request => {
    const ctx = platform(request)
    const session = unwrap(await admin.from('platform_support_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', companyId(request)).eq('platform_admin_id', ctx.userId).select('id,company_id').single())
    const company = unwrap(await admin.from('companies').select('id,name').eq('id', session.company_id).single())
    await platformAudit(ctx, 'companies.workspace.close', company, { support_session_id: session.id })
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
    const plan = unwrap(await admin.from('subscription_plans').select('id,name').eq('id', parsed.data.plan_id).single())
    const subscription = unwrap(await admin.from('company_subscriptions').upsert({ company_id: company.id, ...parsed.data, updated_at: new Date().toISOString() }).select('*').single())
    await platformAudit(ctx, 'subscriptions.update', company, { plan: plan.name, status: subscription.subscription_status, billing_cycle: subscription.billing_cycle })
    return subscription
  })

  app.post('/platform/companies/:id/subscription-payments', async request => {
    const ctx = platform(request)
    const parsed = z.object({ amount: z.coerce.number().positive(), paid_at: z.iso.date(), method: z.string().trim().min(2).max(80), reference: z.string().max(200).nullable().optional(), period_start: z.iso.date().nullable().optional(), period_end: z.iso.date().nullable().optional(), notes: z.string().max(1000).nullable().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check the payment details.')
    const company = unwrap(await admin.from('companies').select('id,name').eq('id', companyId(request)).single())
    const payment = unwrap(await admin.from('platform_subscription_payments').insert({ company_id: company.id, ...parsed.data, created_by: ctx.userId }).select('*').single())
    await admin.from('company_subscriptions').update({ payment_status: 'paid', subscription_status: 'active', updated_at: new Date().toISOString() }).eq('company_id', company.id)
    await platformAudit(ctx, 'subscriptions.payment.record', company, { amount: payment.amount })
    return payment
  })

  app.get('/platform/plans', async request => {
    platform(request)
    return rows(await admin.from('subscription_plans').select('*').order('display_order').order('monthly_price'))
  })

  app.post('/platform/plans', async request => {
    const ctx = platform(request)
    const parsed = planSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check plan details.')
    const plan = unwrap(await admin.from('subscription_plans').insert(parsed.data).select('*').single())
    await platformAudit(ctx, 'plans.create', null, { plan_id: plan.id, name: plan.name })
    return plan
  })

  app.patch('/platform/plans/:id', async request => {
    const ctx = platform(request)
    const parsed = planSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check plan details.')
    const plan = unwrap(await admin.from('subscription_plans').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('id', companyId(request)).select('*').single())
    await platformAudit(ctx, 'plans.update', null, { plan_id: plan.id, name: plan.name, active: plan.active })
    return plan
  })

  app.get('/platform/settings', async request => { platform(request); return unwrap(await admin.from('platform_settings').select('*').eq('singleton', true).single()) })
  app.patch('/platform/settings', async request => {
    const ctx = platform(request)
    const parsed = z.object({ monthly_price: z.coerce.number().min(0), annual_price: z.coerce.number().min(0), default_trial_days: z.coerce.number().int().min(0).max(365), support_session_minutes: z.coerce.number().int().min(15).max(480), company_signup_enabled: z.boolean() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check the platform defaults.')
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
