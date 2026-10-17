import type { FastifyInstance } from 'fastify'
import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { admin, audit, companyEntitlements, decrypt, encrypt, env, HttpError, requireAnyPermission, requirePermission, unwrap } from './core.js'
import { quotePdf, recordPdf } from './pdf.js'

const leadBuckets = new Map<string, { count: number; reset: number }>()
const leadFields = ['name','phone','email','destination','message'] as const
const leadFormSchema = z.object({ title: z.string().trim().min(2).max(120), success_message: z.string().trim().min(2).max(500), primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), enabled_fields: z.array(z.enum(leadFields)).min(1), required_fields: z.array(z.enum(leadFields)), allowed_origins: z.array(z.string().url()).max(20), source_label: z.string().trim().min(2).max(80), active: z.boolean() })
const keyHash = (value: string) => createHash('sha256').update(value).digest('hex')

async function ensureLeadCapacity(companyId: string): Promise<void> {
  const { limits } = await companyEntitlements(companyId)
  const limit = limits.leads_monthly
  if (typeof limit !== 'number' || limit < 0) return
  const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  const { count } = await admin.from('records').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('type', 'lead').gte('created_at', since)
  if ((count || 0) >= limit) throw new HttpError(403, `This company has reached its leads monthly plan limit (${limit}).`)
}

async function storageBytes(path: string): Promise<number> {
  let total = 0
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.storage.from('crm-private').list(path, { limit: 100, offset })
    if (error) throw new HttpError(502, 'Could not inspect company storage usage.')
    for (const item of data || []) {
      if (item.id) total += Number((item.metadata as { size?: number } | null)?.size || 0)
      else total += await storageBytes(`${path}/${item.name}`)
    }
    if (!data || data.length < 100) break
  }
  return total
}

type Smtp = { host: string; port: number; secure: boolean; user: string; password: string; from: string }
type Whatsapp = { phone_number_id: string; access_token: string; template_name: string; voucher_template_name: string; operations_template_name?: string; language: string }
type Facebook = { page_id: string; page_access_token: string }
const schemas = {
  smtp: z.object({ host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().min(1), password: z.string().min(1), from: z.email() }),
  whatsapp: z.object({ phone_number_id: z.string().min(1), access_token: z.string().min(1), template_name: z.string().min(1), voucher_template_name: z.string().min(1), operations_template_name: z.string().min(1).default('travcrm_operations_update'), language: z.string().default('en') }),
  facebook: z.object({ page_id: z.string().min(1), page_access_token: z.string().min(1) })
}
type Kind = keyof typeof schemas
const kind = (value: unknown): Kind => {
  const k = (value as { kind: string }).kind
  if (!(k in schemas)) throw new HttpError(404, 'Integration not found.')
  return k as Kind
}
async function account<T>(companyId: string, integrationKind: Kind): Promise<T> {
  const row = unwrap(await admin.from('integration_accounts').select('ciphertext').eq('company_id', companyId).eq('kind', integrationKind).maybeSingle())
  return decrypt<T>(row.ciphertext)
}

async function storedQuotePdf(companyId: string, quote: Record<string, any>, settings: Record<string, any>, companyName: string): Promise<{ bytes: Uint8Array; url: string }> {
  const bytes = await quotePdf(quote, settings, companyName)
  const url = await storedPdf(companyId, `quotations/${quote.id}.pdf`, bytes)
  return { bytes, url }
}

async function storedPdf(companyId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
  const path = `${companyId}/${relativePath}`
  const { error } = await admin.storage.from('crm-private').upload(path, bytes, { contentType: 'application/pdf', upsert: true })
  if (error) throw new HttpError(502, 'Could not prepare the quotation PDF.')
  const signed = unwrap(await admin.storage.from('crm-private').createSignedUrl(path, 60 * 60 * 24 * 7))
  return signed.signedUrl
}

async function sendEmail(account: Smtp, recipient: string, quote: Record<string, any>, pdf: Uint8Array): Promise<string> {
  const transport = nodemailer.createTransport({ host: account.host, port: account.port, secure: account.secure, auth: { user: account.user, pass: account.password }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000 })
  const response = await transport.sendMail({ from: account.from, to: recipient, subject: `Your ${quote.destination} travel quotation`, text: `Hello ${quote.client_name},\n\nYour ${quote.destination} travel quotation is attached.\n\nPlease contact us if you have questions.`, attachments: [{ filename: `${quote.quote_number || `quotation-${quote.id.slice(0, 8)}`}-R${quote.quote_revision || 1}.pdf`, content: Buffer.from(pdf), contentType: 'application/pdf' }] })
  return response.messageId
}

async function sendWhatsapp(account: Whatsapp, recipient: string, name: string, pdfUrl: string, templateName: string, filename: string): Promise<string> {
  const digits = recipient.replace(/\D/g, '')
  const to = digits.length === 10 ? `91${digits}` : digits.length === 11 && digits.startsWith('0') ? `91${digits.slice(1)}` : digits
  if (!/^\d{11,15}$/.test(to)) throw new Error('Enter a valid WhatsApp phone number with country code.')
  const response = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/${account.phone_number_id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: {
      name: templateName, language: { code: account.language }, components: [
        { type: 'header', parameters: [{ type: 'document', document: { link: pdfUrl, filename } }] },
        { type: 'body', parameters: [{ type: 'text', text: name }] }
      ]
    } })
  })
  const body = await response.json() as { messages?: { id: string }[]; error?: { message: string } }
  if (!response.ok || !body.messages?.[0]?.id) throw new Error(body.error?.message || 'WhatsApp did not accept the message.')
  return body.messages[0].id
}

export async function sendOperationalMessage(companyId: string, channel: string, recipient: string, subject: string, body: string): Promise<string> {
  if (channel === 'email') {
    const smtp = await account<Smtp>(companyId, 'smtp')
    const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.password }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000 })
    return (await transport.sendMail({ from: smtp.from, to: recipient, subject, text: body })).messageId
  }
  if (channel !== 'whatsapp') throw new Error('Unsupported reminder channel.')
  const whatsapp = await account<Whatsapp>(companyId, 'whatsapp')
  if (!whatsapp.operations_template_name) throw new Error('Set an approved operations WhatsApp template in Connections.')
  const digits = recipient.replace(/\D/g, '')
  const to = digits.length === 10 ? `91${digits}` : digits.length === 11 && digits.startsWith('0') ? `91${digits.slice(1)}` : digits
  if (!/^\d{11,15}$/.test(to)) throw new Error('Enter a valid WhatsApp phone number with country code.')
  const response = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/${whatsapp.phone_number_id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${whatsapp.access_token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: whatsapp.operations_template_name, language: { code: whatsapp.language }, components: [{ type: 'body', parameters: [{ type: 'text', text: subject }, { type: 'text', text: body }] }] } })
  })
  const result = await response.json() as { messages?: { id: string }[]; error?: { message: string } }
  if (!response.ok || !result.messages?.[0]?.id) throw new Error(result.error?.message || 'WhatsApp did not accept the reminder.')
  return result.messages[0].id
}

function verifyMeta(raw: string | Buffer, signature: string | undefined): boolean {
  if (!env.metaAppSecret || !signature?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', env.metaAppSecret).update(raw).digest('hex')
  const provided = signature.slice(7)
  return expected.length === provided.length && timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

async function handleLead(entry: Record<string, any>): Promise<void> {
  const pageId = String(entry.id || '')
  const { data: integration } = await admin.from('integration_accounts').select('company_id,ciphertext').eq('kind', 'facebook').eq('external_id', pageId).maybeSingle()
  if (!integration) return
  await ensureLeadCapacity(integration.company_id)
  const credentials = decrypt<Facebook>(integration.ciphertext)
  for (const change of entry.changes || []) {
    if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue
    const leadId = String(change.value.leadgen_id)
    const response = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/${encodeURIComponent(leadId)}?fields=id,created_time,field_data`, { headers: { Authorization: `Bearer ${credentials.page_access_token}` }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Could not fetch Facebook lead.')
    const lead = await response.json() as { id: string; created_time?: string; field_data?: { name: string; values: string[] }[] }
    const fields = Object.fromEntries((lead.field_data || []).map(x => [x.name, x.values?.[0] || '']))
    const name = fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' ') || 'Facebook lead'
    const { error } = await admin.from('records').insert({ company_id: integration.company_id, type: 'lead', title: name, status: 'Active', data: { name, phone: fields.phone_number || '', email: fields.email || '', page: pageId, received_at: (lead.created_time || new Date().toISOString()).slice(0, 10), external_id: leadId, raw_fields: fields } })
    if (error && error.code !== '23505') {
      await admin.from('integration_accounts').update({ last_error: error.message }).eq('company_id', integration.company_id).eq('kind', 'facebook')
      throw new Error(error.message)
    }
    await admin.from('integration_accounts').update({ last_success_at: new Date().toISOString(), last_error: null }).eq('company_id', integration.company_id).eq('kind', 'facebook')
  }
}

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!env.turnstileSecret) return true
  if (!token) return false
  const body = new URLSearchParams({ secret: env.turnstileSecret, response: token, remoteip: ip })
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) })
  const result = await response.json() as { success?: boolean }
  return Boolean(result.success)
}

export async function registerIntegrations(app: FastifyInstance): Promise<void> {
  app.get('/integrations', async request => {
    const ctx = requirePermission(request, 'integrations.read')
    const { data, error } = await admin.from('integration_accounts').select('kind,external_id,connected_at,last_success_at,last_error,updated_at').eq('company_id', ctx.companyId)
    if (error) throw new HttpError(400, error.message)
    return data
  })

  app.put('/integrations/:kind', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const k = kind(request.params)
    const parsed = schemas[k].safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check account details.')
    const value = parsed.data
    const external_id = k === 'facebook' ? (value as Facebook).page_id : k === 'whatsapp' ? (value as Whatsapp).phone_number_id : null
    unwrap(await admin.from('integration_accounts').upsert({ company_id: ctx.companyId, kind: k, external_id, ciphertext: encrypt(value), connected_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).select('kind').single())
    await audit(ctx, `integrations.${k}.connect`)
    return { kind: k, connected: true }
  })

  app.delete('/integrations/:kind', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const k = kind(request.params)
    const { error } = await admin.from('integration_accounts').delete().eq('company_id', ctx.companyId).eq('kind', k)
    if (error) throw new HttpError(400, error.message)
    await audit(ctx, `integrations.${k}.disconnect`)
    return { ok: true }
  })

  app.post('/integrations/meta/oauth/start', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    if (!env.metaAppId || !env.metaAppSecret || !env.metaRedirectUri) throw new HttpError(503, 'Meta OAuth is not configured by the TravCRM platform administrator.')
    const state = unwrap(await admin.from('integration_oauth_states').insert({ company_id: ctx.companyId, actor_id: ctx.userId }).select('state').single()).state
    const query = new URLSearchParams({ client_id: env.metaAppId, redirect_uri: env.metaRedirectUri, state, response_type: 'code', scope: 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval' })
    return { url: `https://www.facebook.com/${env.metaGraphVersion}/dialog/oauth?${query}` }
  })

  app.get('/integrations/meta/oauth/callback', async (request, reply) => {
    const parsed = z.object({ code: z.string().min(1), state: z.uuid() }).safeParse(request.query)
    if (!parsed.success) throw new HttpError(400, 'Meta did not return a valid connection request.')
    const state = unwrap(await admin.from('integration_oauth_states').select('*').eq('state', parsed.data.state).gt('expires_at', new Date().toISOString()).single())
    const query = new URLSearchParams({ client_id: env.metaAppId, client_secret: env.metaAppSecret, redirect_uri: env.metaRedirectUri, code: parsed.data.code })
    const tokenResponse = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/oauth/access_token?${query}`, { signal: AbortSignal.timeout(15000) })
    const tokenBody = await tokenResponse.json() as { access_token?: string; error?: { message: string } }
    if (!tokenResponse.ok || !tokenBody.access_token) throw new HttpError(400, tokenBody.error?.message || 'Meta login could not be completed.')
    const longQuery = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.metaAppId, client_secret: env.metaAppSecret, fb_exchange_token: tokenBody.access_token })
    const longResponse = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/oauth/access_token?${longQuery}`, { signal: AbortSignal.timeout(15000) })
    const longBody = await longResponse.json() as { access_token?: string }
    const userToken = longBody.access_token || tokenBody.access_token
    const pagesResponse = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`, { signal: AbortSignal.timeout(15000) })
    const pagesBody = await pagesResponse.json() as { data?: { id: string; name: string; access_token: string }[]; error?: { message: string } }
    if (!pagesResponse.ok) throw new HttpError(400, pagesBody.error?.message || 'Could not load Facebook Pages.')
    await admin.from('integration_oauth_states').update({ ciphertext: encrypt(pagesBody.data || []) }).eq('state', state.state)
    return reply.redirect(`${env.appUrl.replace(/\/$/, '')}/integrations?meta_state=${state.state}`)
  })

  app.get('/integrations/meta/oauth/pages', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const parsed = z.object({ state: z.uuid() }).safeParse(request.query)
    if (!parsed.success) throw new HttpError(400, 'Meta connection state is missing.')
    const state = unwrap(await admin.from('integration_oauth_states').select('*').eq('state', parsed.data.state).eq('company_id', ctx.companyId).eq('actor_id', ctx.userId).gt('expires_at', new Date().toISOString()).single())
    if (!state.ciphertext) throw new HttpError(400, 'Complete Meta login first.')
    return decrypt<{ id: string; name: string; access_token: string }[]>(state.ciphertext).map(({ id, name }) => ({ id, name }))
  })

  app.post('/integrations/meta/oauth/complete', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const parsed = z.object({ state: z.uuid(), page_id: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose a Facebook Page.')
    const state = unwrap(await admin.from('integration_oauth_states').select('*').eq('state', parsed.data.state).eq('company_id', ctx.companyId).eq('actor_id', ctx.userId).gt('expires_at', new Date().toISOString()).single())
    const page = decrypt<{ id: string; name: string; access_token: string }[]>(state.ciphertext).find(x => x.id === parsed.data.page_id)
    if (!page) throw new HttpError(400, 'Facebook Page not found in this connection.')
    const subscribe = await fetch(`https://graph.facebook.com/${env.metaGraphVersion}/${encodeURIComponent(page.id)}/subscribed_apps`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: page.access_token }), signal: AbortSignal.timeout(15000) })
    const subscribed = await subscribe.json() as { success?: boolean; error?: { message: string } }
    if (!subscribe.ok || !subscribed.success) throw new HttpError(400, subscribed.error?.message || 'The Page could not be subscribed to lead notifications.')
    unwrap(await admin.from('integration_accounts').upsert({ company_id: ctx.companyId, kind: 'facebook', external_id: page.id, ciphertext: encrypt({ page_id: page.id, page_access_token: page.access_token, page_name: page.name }), connected_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).select('kind').single())
    await admin.from('integration_oauth_states').delete().eq('state', state.state)
    await audit(ctx, 'integrations.facebook.connect', undefined, { page_id: page.id, page_name: page.name })
    return { kind: 'facebook', connected: true, page: { id: page.id, name: page.name } }
  })

  app.get('/lead-form', async request => {
    const ctx = requirePermission(request, 'integrations.read')
    const { data } = await admin.from('lead_forms').select('*').eq('company_id', ctx.companyId).maybeSingle()
    if (data) return data
    const publicKey = randomBytes(12).toString('hex')
    return unwrap(await admin.from('lead_forms').insert({ company_id: ctx.companyId, public_key: publicKey }).select('*').single())
  })

  app.put('/lead-form', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const parsed = leadFormSchema.safeParse(request.body)
    if (!parsed.success || parsed.data.required_fields.some(x => !parsed.data.enabled_fields.includes(x))) throw new HttpError(400, 'Check the lead form settings and required fields.')
    const form = unwrap(await admin.from('lead_forms').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).select('*').single())
    await audit(ctx, 'lead_form.update')
    return form
  })

  app.post('/lead-form/rotate-key', async request => {
    const ctx = requirePermission(request, 'integrations.write')
    const secret = `trv_${randomBytes(24).toString('base64url')}`
    unwrap(await admin.from('lead_forms').update({ write_key_hash: keyHash(secret), updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).select('company_id').single())
    await audit(ctx, 'lead_form.key.rotate')
    return { write_key: secret }
  })

  app.get('/public/forms/:key', async request => {
    const key = (request.params as { key: string }).key
    const form = unwrap(await admin.from('lead_forms').select('company_id,title,success_message,primary_color,enabled_fields,required_fields,active,source_label').eq('public_key', key).single())
    if (!form.active) throw new HttpError(404, 'This enquiry form is not accepting responses.')
    const settings = unwrap(await admin.from('company_settings').select('brand_name,logo_path').eq('company_id', form.company_id).single())
    let logo_url: string | null = null
    if (settings.logo_path) logo_url = (await admin.storage.from('crm-private').createSignedUrl(settings.logo_path, 3600)).data?.signedUrl || null
    return { ...form, company_id: undefined, brand_name: settings.brand_name, logo_url, turnstile_site_key: env.turnstileSiteKey || null }
  })

  app.post('/public/leads/:key', async request => {
    const publicKey = (request.params as { key: string }).key
    const form = unwrap(await admin.from('lead_forms').select('*').eq('public_key', publicKey).single())
    if (!form.active) throw new HttpError(404, 'This enquiry form is not accepting responses.')
    await ensureLeadCapacity(form.company_id)
    const bucketKey = `${publicKey}:${request.ip}`
    const now = Date.now(); const bucket = leadBuckets.get(bucketKey)
    if (bucket && bucket.reset > now && bucket.count >= 10) throw new HttpError(429, 'Too many enquiries. Try again in a few minutes.')
    leadBuckets.set(bucketKey, !bucket || bucket.reset <= now ? { count: 1, reset: now + 600000 } : { ...bucket, count: bucket.count + 1 })
    const body = z.object({ name: z.string().trim().max(120).optional(), phone: z.string().trim().max(40).optional(), email: z.string().trim().email().max(200).optional().or(z.literal('')), destination: z.string().trim().max(200).optional(), message: z.string().trim().max(3000).optional(), external_id: z.string().max(200).optional(), website: z.string().max(0).optional(), turnstile_token: z.string().optional() }).safeParse(request.body)
    if (!body.success || body.data.website) throw new HttpError(400, 'Check the enquiry details.')
    const supplied = request.headers['x-travcrm-lead-key'] as string | undefined
    const serverRequest = Boolean(supplied && form.write_key_hash && timingSafeEqual(Buffer.from(keyHash(supplied)), Buffer.from(form.write_key_hash)))
    const origin = String(request.headers.origin || '').replace(/\/$/, '')
    const platformOrigins = env.webOrigin.split(',').map(x => x.trim().replace(/\/$/, ''))
    if (!serverRequest && origin && !platformOrigins.includes(origin) && !(form.allowed_origins as string[]).map(x => x.replace(/\/$/, '')).includes(origin)) throw new HttpError(403, 'This website is not allowed to use the enquiry form.')
    if (!serverRequest && !await verifyTurnstile(body.data.turnstile_token, request.ip)) throw new HttpError(400, 'Please complete the spam check.')
    for (const field of form.required_fields as string[]) if (!body.data[field as keyof typeof body.data]) throw new HttpError(400, `${(field[0] || '').toUpperCase() + field.slice(1)} is required.`)
    const sourceId = body.data.external_id ? `web-${body.data.external_id}` : `web-${randomUUID()}`
    const data = { name: body.data.name || 'Website lead', phone: body.data.phone || '', email: body.data.email || '', destination: body.data.destination || '', notes: body.data.message || '', page: form.source_label, received_at: new Date().toISOString().slice(0, 10), external_id: sourceId }
    const { error } = await admin.from('records').insert({ company_id: form.company_id, type: 'lead', title: data.name, status: 'Active', data })
    if (error?.code === '23505') return { ok: true, message: form.success_message }
    if (error) throw new HttpError(400, error.message)
    return { ok: true, message: form.success_message }
  })

  app.post('/quotes/:id/send', async request => {
    const ctx = requirePermission(request, 'messages.write')
    requirePermission(request, 'quotes.read')
    const parsed = z.object({ channel: z.enum(['email', 'whatsapp']), request_key: z.uuid() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose email or WhatsApp.')
    const quote = unwrap(await ctx.db.from('quotes').select('*').eq('company_id', ctx.companyId).eq('id', (request.params as { id: string }).id).single())
    const recipient = parsed.data.channel === 'email' ? quote.email : quote.phone
    if (!recipient) throw new HttpError(400, `Add the client’s ${parsed.data.channel === 'email' ? 'email' : 'phone number'} to this quotation.`)
    const { data: previous } = await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('request_key', parsed.data.request_key).maybeSingle()
    if (previous) return previous
    const inserted = await ctx.db.from('messages').insert({ company_id: ctx.companyId, quote_id: quote.id, channel: parsed.data.channel, recipient, request_key: parsed.data.request_key, created_by: ctx.userId }).select('*').single()
    if (inserted.error?.code === '23505') return unwrap(await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('request_key', parsed.data.request_key).single())
    const message = unwrap(inserted)
    try {
      const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
      const document = await storedQuotePdf(ctx.companyId, quote, settings, ctx.companyName || 'Travel company')
      const providerId = parsed.data.channel === 'email'
        ? await sendEmail(await account<Smtp>(ctx.companyId, 'smtp'), recipient, quote, document.bytes)
        : await (async () => { const sender = await account<Whatsapp>(ctx.companyId, 'whatsapp'); return sendWhatsapp(sender, recipient, quote.client_name, document.url, sender.template_name, `${quote.quote_number || `quotation-${quote.id.slice(0, 8)}`}-R${quote.quote_revision || 1}.pdf`) })()
      const sent = unwrap(await ctx.db.from('messages').update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() }).eq('id', message.id).select('*').single())
      if (quote.status === 'Draft') await ctx.db.from('quotes').update({ status: 'Quoted' }).eq('company_id', ctx.companyId).eq('id', quote.id)
      if (quote.query_id) await admin.from('records').update({ status: 'Quoted' }).eq('company_id', ctx.companyId).eq('type', 'query').eq('id', quote.query_id)
      await audit(ctx, `messages.${parsed.data.channel}.send`, message.id)
      return sent
    } catch (error) {
      await ctx.db.from('messages').update({ status: 'failed', error: (error as Error).message.slice(0, 1000) }).eq('id', message.id)
      throw new HttpError(502, `Message failed: ${(error as Error).message}`)
    }
  })

  app.get('/quotes/:id/messages', async request => {
    const ctx = requirePermission(request, 'messages.read')
    return unwrap(await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('quote_id', (request.params as { id: string }).id).order('created_at', { ascending: false }))
  })

  app.post('/records/:slug/:id/send', async request => {
    const ctx = requirePermission(request, 'messages.write')
    const { slug, id } = request.params as { slug: string; id: string }
    const type = slug === 'stay-vouchers' ? 'stay_voucher' : slug === 'cab-vouchers' ? 'cab_voucher' : null
    if (!type) throw new HttpError(404, 'Voucher not found.')
    requirePermission(request, `${type}.read`)
    const parsed = z.object({ request_key: z.uuid() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Request key is required.')
    const record = unwrap(await ctx.db.from('records').select('*').eq('company_id', ctx.companyId).eq('type', type).eq('id', id).single())
    const recipient = String(record.data?.guest_phone || '')
    if (!recipient) throw new HttpError(400, 'Add the guest phone number to this voucher first.')
    const { data: previous } = await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('request_key', parsed.data.request_key).maybeSingle()
    if (previous) return previous
    const inserted = await ctx.db.from('messages').insert({ company_id: ctx.companyId, record_id: id, channel: 'whatsapp', recipient, request_key: parsed.data.request_key, created_by: ctx.userId }).select('*').single()
    if (inserted.error?.code === '23505') return unwrap(await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('request_key', parsed.data.request_key).single())
    const message = unwrap(inserted)
    try {
      const sender = await account<Whatsapp>(ctx.companyId, 'whatsapp')
      if (!sender.voucher_template_name) throw new Error('Set an approved voucher template in Connections.')
      const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
      const bytes = await recordPdf(type, record, settings, ctx.companyName || 'Travel company')
      const filename = `${type.replace('_', '-')}-${id.slice(0, 8)}.pdf`
      const url = await storedPdf(ctx.companyId, `vouchers/${id}.pdf`, bytes)
      const providerId = await sendWhatsapp(sender, recipient, String(record.data.guest_name), url, sender.voucher_template_name, filename)
      const sent = unwrap(await ctx.db.from('messages').update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() }).eq('id', message.id).select('*').single())
      await audit(ctx, `messages.${type}.send`, message.id)
      return sent
    } catch (error) {
      await ctx.db.from('messages').update({ status: 'failed', error: (error as Error).message.slice(0, 1000) }).eq('id', message.id)
      throw new HttpError(502, `Message failed: ${(error as Error).message}`)
    }
  })

  app.post('/booking-documents/:id/send', async request => {
    const ctx = requirePermission(request, 'messages.write')
    requirePermission(request, 'booking_documents.read')
    const documentId = (request.params as { id: string }).id
    const parsed = z.object({ request_key: z.uuid() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Request key is required.')
    const document = unwrap(await ctx.db.from('booking_documents').select('*').eq('company_id', ctx.companyId).eq('id', documentId).single())
    if (document.status !== 'issued') throw new HttpError(409, 'Issue this voucher before sending it.')
    const recipient = String(document.payload?.guest_phone || '')
    if (!recipient) throw new HttpError(400, 'Add the guest phone number to this voucher first.')
    const { data: previous } = await ctx.db.from('messages').select('*').eq('company_id', ctx.companyId).eq('request_key', parsed.data.request_key).maybeSingle()
    if (previous) return previous
    const message = unwrap(await ctx.db.from('messages').insert({ company_id: ctx.companyId, booking_document_id: document.id, channel: 'whatsapp', recipient, request_key: parsed.data.request_key, created_by: ctx.userId }).select('*').single())
    try {
      const sender = await account<Whatsapp>(ctx.companyId, 'whatsapp')
      if (!sender.voucher_template_name) throw new Error('Set an approved voucher template in Connections.')
      const settings = unwrap(await admin.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
      const bytes = await recordPdf(document.type, { id: document.id, document_number: document.document_number, data: document.payload }, settings, ctx.companyName || 'Travel company')
      const url = await storedPdf(ctx.companyId, `booking-vouchers/${document.id}.pdf`, bytes)
      const providerId = await sendWhatsapp(sender, recipient, String(document.payload.guest_name || 'Traveller'), url, sender.voucher_template_name, `${document.document_number}.pdf`)
      const sent = unwrap(await ctx.db.from('messages').update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() }).eq('id', message.id).select('*').single())
      await audit(ctx, `messages.${document.type}.send`, message.id, { booking_document: document.id })
      return sent
    } catch (error) {
      await ctx.db.from('messages').update({ status: 'failed', error: (error as Error).message.slice(0, 1000) }).eq('id', message.id)
      throw new HttpError(502, `Message failed: ${(error as Error).message}`)
    }
  })

  app.post('/files/upload-url', async request => {
    const ctx = requireAnyPermission(request, ['files.write', 'documents.write', 'settings.write', 'traveller_documents.write'])
    const parsed = z.object({ filename: z.string().min(1).max(200), content_type: z.string().regex(/^(image\/(png|jpeg|webp)|application\/pdf)$/), size: z.coerce.number().int().positive().max(25 * 1024 * 1024) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Upload a PNG, JPEG, WebP, or PDF file.')
    const { limits } = await companyEntitlements(ctx.companyId)
    const storageLimit = limits.storage_mb
    if (typeof storageLimit === 'number' && storageLimit >= 0 && await storageBytes(ctx.companyId) + parsed.data.size > storageLimit * 1024 * 1024) throw new HttpError(403, `This company has reached its storage plan limit (${storageLimit} MB).`)
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' } as Record<string, string>)[parsed.data.content_type]
    const path = `${ctx.companyId}/uploads/${randomUUID()}.${extension}`
    const signed = unwrap(await admin.storage.from('crm-private').createSignedUploadUrl(path))
    return { path, token: signed.token }
  })

  app.get('/files/url', async request => {
    const ctx = requirePermission(request, 'files.read')
    const path = (request.query as { path?: string }).path || ''
    if (!path.startsWith(`${ctx.companyId}/`)) throw new HttpError(403, 'File is outside this company.')
    const signed = unwrap(await admin.storage.from('crm-private').createSignedUrl(path, 60 * 10))
    return { url: signed.signedUrl }
  })

  app.get('/webhooks/meta', async (request, reply) => {
    const q = request.query as Record<string, string>
    if (q['hub.mode'] === 'subscribe' && env.metaVerifyToken && q['hub.verify_token'] === env.metaVerifyToken) return reply.type('text/plain').send(q['hub.challenge'])
    throw new HttpError(403, 'Verification failed.')
  })

  app.post('/webhooks/meta', { config: { rawBody: true } }, async request => {
    const raw = (request as typeof request & { rawBody?: string | Buffer }).rawBody
    if (!raw || !verifyMeta(raw, request.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(403, 'Webhook signature is invalid.')
    const payload = request.body as { object?: string; entry?: Record<string, any>[] }
    if (payload.object === 'whatsapp_business_account') {
      for (const entry of payload.entry || []) for (const change of entry.changes || []) for (const status of change.value?.statuses || []) {
        if (!status.id || !['sent','delivered','read','failed'].includes(status.status)) continue
        await admin.from('messages').update({ status: status.status, error: status.errors?.[0]?.message || null }).eq('provider_id', status.id)
      }
    } else if (payload.object === 'page') {
      for (const entry of payload.entry || []) await handleLead(entry)
    }
    return { ok: true }
  })
}
