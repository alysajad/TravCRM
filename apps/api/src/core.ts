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
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || ''
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
  if (isPlatform && typeof request.headers['x-company-id'] === 'string') {
    const selected = request.headers['x-company-id']
    const { data: company } = await admin.from('companies').select('id,name,status').eq('id', selected).maybeSingle()
    if (!company || company.status === 'archived') throw new HttpError(404, 'Company workspace is archived.')
    companyId = company.id
    companyName = company.name
  }
  const roles = Array.isArray(membership?.roles) ? membership.roles[0] : membership?.roles
  request.crm = {
    userId, companyId, companyName, name: membership?.name || String(claimData.claims.email || 'User'),
    platform: isPlatform, permissions: isPlatform ? ['*'] : roles?.permissions || [],
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
