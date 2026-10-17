import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { FastifyRequest } from 'fastify'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const env = {
  port: Number(process.env.PORT || 4000),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  appUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
  url: process.env.SUPABASE_URL || '',
  anon: process.env.SUPABASE_ANON_KEY || '',
  secret: process.env.SUPABASE_SECRET_KEY || '',
  encryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaAppId: process.env.META_APP_ID || '',
  metaRedirectUri: process.env.META_REDIRECT_URI || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v23.0',
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY || '',
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
  cronSecret: process.env.CRON_SECRET || ''
}

if (!env.url || !env.anon || !env.secret) throw new Error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY.')
export const admin = createClient(env.url, env.secret, { auth: { autoRefreshToken: false, persistSession: false } })

export type Context = {
  userId: string
  companyId: string | null
  companyName: string | null
  name: string
  platform: boolean
  permissions: string[]
  features: string[]
  limits: Record<string, number>
  supportSessionId: string | null
  supportExpiresAt: string | null
  db: SupabaseClient
}

declare module 'fastify' { interface FastifyRequest { crm?: Context } }

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

export function requireContext(request: FastifyRequest): Context {
  if (!request.crm) throw new HttpError(401, 'Sign in to continue.')
  return request.crm
}

export function requireCompany(request: FastifyRequest): Context & { companyId: string } {
  const ctx = requireContext(request)
  if (!ctx.companyId) throw new HttpError(400, 'Select a company first.')
  return ctx as Context & { companyId: string }
}

export function requirePermission(request: FastifyRequest, permission: string): Context & { companyId: string } {
  const ctx = requireCompany(request)
  if (!ctx.platform && !ctx.permissions.includes('*') && !ctx.permissions.includes(permission)) throw new HttpError(403, 'You do not have permission for this action.')
  return ctx
}

export function requireAnyPermission(request: FastifyRequest, permissions: string[]): Context & { companyId: string } {
  const ctx = requireCompany(request)
  if (!ctx.platform && !ctx.permissions.includes('*') && !permissions.some(permission => ctx.permissions.includes(permission))) throw new HttpError(403, 'You do not have permission for this action.')
  return ctx
}

type Entitlements = { features: string[]; limits: Record<string, number>; subscriptionStatus?: string; currentPeriodEnd?: string | null; cancelAtPeriodEnd?: boolean }

export function mergeEntitlements(planFeatures: string[], planLimits: Record<string, number>, featureOverrides: Record<string, boolean> = {}, limitOverrides: Record<string, number> = {}): Entitlements {
  const features = new Set(planFeatures)
  for (const [feature, enabled] of Object.entries(featureOverrides)) enabled ? features.add(feature) : features.delete(feature)
  return { features: [...features], limits: { ...planLimits, ...limitOverrides } }
}

function related<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] || null : value || null
}

export async function companyEntitlements(companyId: string): Promise<Entitlements> {
  const { data, error } = await admin.from('company_subscriptions')
    .select('limit_overrides,feature_overrides,subscription_status,current_period_end,cancel_at_period_end,subscription_plans(features,limits)')
    .eq('company_id', companyId).maybeSingle()
  if (error) throw new HttpError(500, 'Could not load company plan access.')
  if (!data) return { features: ['*'], limits: {} }
  const plan = related(data.subscription_plans as { features: string[]; limits: Record<string, number> } | { features: string[]; limits: Record<string, number> }[] | null)
  return { ...mergeEntitlements(plan?.features || [], plan?.limits || {}, (data.feature_overrides || {}) as Record<string, boolean>, (data.limit_overrides || {}) as Record<string, number>), subscriptionStatus: data.subscription_status, currentPeriodEnd: data.current_period_end, cancelAtPeriodEnd: data.cancel_at_period_end }
}

export function requireFeature(ctx: Context, feature: string): void {
  if (!ctx.companyId || ctx.features.includes('*') || ctx.features.includes(feature)) return
  throw new HttpError(403, `${feature.replaceAll('_', ' ')} is not included in this company plan.`)
}

export async function enforceLimit(ctx: Context & { companyId: string }, key: string, current: number): Promise<void> {
  const limit = ctx.limits[key]
  if (typeof limit === 'number' && limit >= 0 && current >= limit) throw new HttpError(403, `This company has reached its ${key.replaceAll('_', ' ')} plan limit (${limit}).`)
}

export function enforceRouteFeature(request: FastifyRequest): void {
  const ctx = requireContext(request)
  if (!ctx.companyId) return
  const path = request.url.split('?')[0] || ''
  const rules: [RegExp, string][] = [
    [/^\/api\/v1\/(quotes|quote-options)(\/|$)/, 'quotations'],
    [/^\/api\/v1\/(bookings|booking-stays|booking-transport|booking-documents|booking-tasks|booking-travellers|traveller-documents|booking-services|operations|operation-templates|reminder-rules|notifications)(\/|$)/, 'bookings'],
    [/^\/api\/v1\/(payments|ledger|hotel-ledger)(\/|$)/, 'finance'],
    [/^\/api\/v1\/records\/(expenses|invoices|hotel-payments)(\/|$)/, 'finance'],
    [/^\/api\/v1\/records\/(stay-vouchers|cab-vouchers)(\/|$)/, 'documents'],
    [/^\/api\/v1\/(records|options|assignees|leads)(\/|$)/, 'crm'],
    [/^\/api\/v1\/(integrations|lead-form)(\/|$)/, 'integrations']
  ]
  const match = rules.find(([pattern]) => pattern.test(path))
  if (match) requireFeature(ctx, match[1])
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Sign in to continue.')
  const { data: claimData, error: claimError } = await admin.auth.getClaims(token)
  if (claimError || !claimData?.claims?.sub) throw new HttpError(401, 'Your session has expired. Sign in again.')
  const userId = claimData.claims.sub
  const [{ data: platform }, { data: membership, error: memberError }] = await Promise.all([
    admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    admin.from('memberships').select('company_id,name,active,roles(name,permissions),companies(name,active,status,trial_ends_at)').eq('user_id', userId).maybeSingle()
  ])
  if (memberError) throw new HttpError(500, 'Could not load your account.')
  const isPlatform = Boolean(platform)
  const company = Array.isArray(membership?.companies) ? membership.companies[0] : membership?.companies
  const trialExpired = company?.status === 'trial' && company.trial_ends_at && company.trial_ends_at < new Date().toISOString().slice(0, 10)
  if (!isPlatform && (!membership || !membership.active || !company || !['trial', 'active'].includes(company.status) || trialExpired)) throw new HttpError(403, trialExpired ? 'Your TravCRM trial has ended. Contact your administrator.' : 'This company workspace is not active.')
  let companyId: string | null = membership?.company_id ?? null
  let companyName: string | null = company?.name ?? null
  let supportSessionId: string | null = null
  let supportExpiresAt: string | null = null
  if (isPlatform && typeof request.headers['x-company-id'] === 'string') {
    const selected = request.headers['x-company-id']
    const { data: company } = await admin.from('companies').select('id,name,status').eq('id', selected).maybeSingle()
    if (!company || company.status === 'archived') throw new HttpError(404, 'Company workspace is archived.')
    const requestedSession = typeof request.headers['x-support-session'] === 'string' ? request.headers['x-support-session'] : ''
    const { data: session } = requestedSession ? await admin.from('platform_support_sessions').select('id,expires_at').eq('id', requestedSession).eq('platform_admin_id', userId).eq('company_id', company.id).is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle() : { data: null }
    if (!session) throw new HttpError(403, 'Start a support session from the owner portal to open this workspace.')
    companyId = company.id
    companyName = company.name
    supportSessionId = session.id
    supportExpiresAt = session.expires_at
  }
  const entitlements = companyId ? await companyEntitlements(companyId) : { features: ['*'], limits: {} }
  const subscriptionEnded = entitlements.subscriptionStatus === 'cancelled' && (!entitlements.cancelAtPeriodEnd || !entitlements.currentPeriodEnd || entitlements.currentPeriodEnd < new Date().toISOString().slice(0, 10))
  if (!isPlatform && subscriptionEnded) throw new HttpError(403, 'This TravCRM subscription has ended. Contact your administrator.')
  const roles = Array.isArray(membership?.roles) ? membership.roles[0] : membership?.roles
  request.crm = {
    userId, companyId, companyName, name: membership?.name || String(claimData.claims.email || 'User'),
    platform: isPlatform, permissions: isPlatform ? ['*'] : roles?.permissions || [],
    features: entitlements.features, limits: entitlements.limits, supportSessionId, supportExpiresAt,
    db: createClient(env.url, env.anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  }
}

export function unwrap<T>(result: { data: T; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (result.error) throw new HttpError(result.error.code === '42501' ? 403 : 400, result.error.message)
  if (result.data === null) throw new HttpError(404, 'Record not found.')
  return result.data as NonNullable<T>
}

export async function audit(ctx: Context, action: string, targetId?: string, details: Record<string, unknown> = {}): Promise<void> {
  await admin.from('audit_events').insert({ company_id: ctx.companyId, actor_id: ctx.userId, action, target_id: targetId, details })
}

export async function platformAudit(ctx: Context, action: string, company?: { id: string; name: string } | null, details: Record<string, unknown> = {}): Promise<void> {
  await admin.from('platform_audit_events').insert({ actor_id: ctx.userId, target_company_id: company?.id, company_name: company?.name, action, details })
}

function keyBytes(): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(env.encryptionKey)) throw new HttpError(503, 'Integration encryption is not configured.')
  return Buffer.from(env.encryptionKey, 'hex')
}

export function encrypt(value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decrypt<T>(value: string): T {
  const all = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), all.subarray(0, 12))
  decipher.setAuthTag(all.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(all.subarray(28)), decipher.final()]).toString('utf8')) as T
}
