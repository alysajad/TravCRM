import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { admin, audit, decrypt, encrypt, env, HttpError, requirePermission, unwrap } from './core.js'
import { quotePdf, recordPdf } from './pdf.js'

type Smtp = { host: string; port: number; secure: boolean; user: string; password: string; from: string }
type Whatsapp = { phone_number_id: string; access_token: string; template_name: string; voucher_template_name: string; language: string }
type Facebook = { page_id: string; page_access_token: string }
const schemas = {
  smtp: z.object({ host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().min(1), password: z.string().min(1), from: z.email() }),
  whatsapp: z.object({ phone_number_id: z.string().min(1), access_token: z.string().min(1), template_name: z.string().min(1), voucher_template_name: z.string().min(1), language: z.string().default('en') }),
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
  const response = await transport.sendMail({ from: account.from, to: recipient, subject: `Your ${quote.destination} travel quotation`, text: `Hello ${quote.client_name},\n\nYour ${quote.destination} travel quotation is attached.\n\nPlease contact us if you have questions.`, attachments: [{ filename: `quotation-${quote.id.slice(0, 8)}.pdf`, content: Buffer.from(pdf), contentType: 'application/pdf' }] })
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
    if (error && error.code !== '23505') throw new Error(error.message)
  }
}

export async function registerIntegrations(app: FastifyInstance): Promise<void> {
  app.get('/integrations', async request => {
    const ctx = requirePermission(request, 'settings.write')
    const { data, error } = await admin.from('integration_accounts').select('kind,external_id,updated_at').eq('company_id', ctx.companyId)
    if (error) throw new HttpError(400, error.message)
    return data
  })

  app.put('/integrations/:kind', async request => {
    const ctx = requirePermission(request, 'settings.write')
    const k = kind(request.params)
    const parsed = schemas[k].safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check account details.')
    const value = parsed.data
    const external_id = k === 'facebook' ? (value as Facebook).page_id : k === 'whatsapp' ? (value as Whatsapp).phone_number_id : null
    unwrap(await admin.from('integration_accounts').upsert({ company_id: ctx.companyId, kind: k, external_id, ciphertext: encrypt(value), updated_at: new Date().toISOString() }).select('kind').single())
    await audit(ctx, `integrations.${k}.connect`)
    return { kind: k, connected: true }
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
        : await (async () => { const sender = await account<Whatsapp>(ctx.companyId, 'whatsapp'); return sendWhatsapp(sender, recipient, quote.client_name, document.url, sender.template_name, `quotation-${quote.id.slice(0, 8)}.pdf`) })()
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

  app.post('/files/upload-url', async request => {
    const ctx = requirePermission(request, 'files.write')
    const parsed = z.object({ filename: z.string().min(1).max(200), content_type: z.string().regex(/^(image\/(png|jpeg|webp)|application\/pdf)$/) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Upload a PNG, JPEG, WebP, or PDF file.')
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
