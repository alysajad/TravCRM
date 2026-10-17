import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { admin, audit, env, HttpError, requireAnyPermission, requirePermission, unwrap } from './core.js'
import { sendOperationalMessage } from './integrations.js'

const id = (value: unknown) => (value as { id: string }).id
const taskStatuses = ['todo','in_progress','blocked','done','cancelled'] as const
const priorities = ['low','normal','high','urgent'] as const
const confirmationStatuses = ['pending','requested','on_hold','confirmed','reconfirmation_required','cancelled'] as const
const serviceStatuses = ['draft','requested','on_hold','confirmed','ticketed','reconfirmation_required','cancelled'] as const
const serviceTypes = ['flight','train','activity'] as const

const templateInput = z.object({
  title: z.string().trim().min(2).max(200), category: z.string().trim().min(2).max(60).default('general'),
  anchor: z.enum(['confirmation','arrival','departure']).default('arrival'), offset_days: z.coerce.number().int().min(-365).max(365).default(0),
  priority: z.enum(priorities).default('normal'), assignment_rule: z.enum(['booking_owner','unassigned']).default('booking_owner'),
  position: z.coerce.number().int().min(0).max(10000).default(0), active: z.boolean().default(true)
})
const taskInput = z.object({
  title: z.string().trim().min(2).max(200).optional(), category: z.string().trim().min(2).max(60).optional(), status: z.enum(taskStatuses).optional(),
  priority: z.enum(priorities).optional(), due_at: z.iso.datetime().nullable().optional(), assignee_id: z.uuid().nullable().optional(), notes: z.string().max(5000).nullable().optional()
})
const travellerInput = z.object({
  traveller_type: z.enum(['adult','child']).default('adult'), full_name: z.string().trim().min(1).max(200), date_of_birth: z.iso.date().nullable().optional(),
  phone: z.string().max(50).nullable().optional(), email: z.union([z.email(), z.literal('')]).nullable().optional(), is_primary: z.boolean().default(false), notes: z.string().max(2000).nullable().optional()
})
const serviceInput = z.object({
  type: z.enum(serviceTypes), title: z.string().trim().min(2).max(200), status: z.enum(serviceStatuses).default('draft'),
  supplier_id: z.uuid().nullable().optional(), supplier_name: z.string().max(200).nullable().optional(), supplier_phone: z.string().max(50).nullable().optional(), supplier_email: z.union([z.email(), z.literal('')]).nullable().optional(),
  confirmation_reference: z.string().max(200).nullable().optional(), booking_deadline: z.iso.datetime().nullable().optional(), start_at: z.iso.datetime().nullable().optional(), end_at: z.iso.datetime().nullable().optional(),
  origin: z.string().max(200).nullable().optional(), destination: z.string().max(200).nullable().optional(), cost: z.coerce.number().min(0).max(999999999).default(0), currency: z.string().trim().length(3).default('INR'),
  segments: z.array(z.object({ carrier: z.string().max(120).optional(), number: z.string().max(80).optional(), origin: z.string().max(160).optional(), destination: z.string().max(160).optional(), departure: z.string().max(80).optional(), arrival: z.string().max(80).optional(), class: z.string().max(80).optional() })).max(20).default([]),
  traveller_ids: z.array(z.uuid()).max(100).default([]), notes: z.string().max(5000).nullable().optional()
})
const ruleInput = z.object({
  name: z.string().trim().min(2).max(120).optional(), event: z.enum(['arrival','departure','supplier_reconfirm','task_due']).optional(), recipient: z.enum(['customer','supplier','staff']).optional(),
  channel: z.enum(['email','whatsapp','in_app']).optional(), offset_hours: z.coerce.number().int().min(-8760).max(8760).optional(), send_hour: z.coerce.number().int().min(0).max(23).optional(),
  subject_template: z.string().max(300).nullable().optional(), body_template: z.string().min(2).max(3000).optional(), active: z.boolean().optional()
})

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10)
}

export function operationLocalTime(date: string, hour: number, timezone: string): string {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`)
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(guess).filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    return new Date(guess.getTime() - (shown - guess.getTime())).toISOString()
  } catch { return guess.toISOString() }
}

function render(value: string | null, booking: Record<string, any>): string {
  return String(value || '').replace(/{{(\w+)}}/g, (_, key: string) => String(booking[key] ?? ''))
}

async function notifyAssignee(companyId: string, task: Record<string, any>): Promise<void> {
  if (!task.assignee_id) return
  const booking = unwrap(await admin.from('bookings').select('booking_number,client_name').eq('company_id', companyId).eq('id', task.booking_id).single())
  await admin.from('user_notifications').upsert({ company_id: companyId, user_id: task.assignee_id, booking_id: task.booking_id, task_id: task.id, type: 'task', title: 'Task assigned', body: `${task.title} · ${booking.client_name} (${booking.booking_number})`, dedupe_key: `task-assigned:${task.id}:${task.assignee_id}` }, { onConflict: 'company_id,user_id,dedupe_key', ignoreDuplicates: true })
}

async function queueRule(companyId: string, booking: Record<string, any>, rule: Record<string, any>, target: string, recipient: string, extra: Record<string, any> = {}): Promise<void> {
  if (!recipient || rule.channel === 'in_app') return
  const anchor = rule.event === 'departure' ? booking.departure_date : booking.arrival_date
  const base = new Date(operationLocalTime(anchor, Number(rule.send_hour || 10), booking.timezone || 'Asia/Kolkata'))
  base.setTime(base.getTime() + Number(rule.offset_hours || 0) * 3600000)
  const scheduled = new Date(Math.max(Date.now(), base.getTime())).toISOString()
  const values = { ...booking, ...extra }
  const kind = `reminder:${rule.id}:${target}`
  const existing = (await admin.from('messages').select('status').eq('company_id', companyId).eq('booking_id', booking.id).eq('kind', kind).maybeSingle()).data
  if (existing?.status === 'sent') return
  const row = { company_id: companyId, booking_id: booking.id, channel: rule.channel, recipient, status: 'queued', request_key: randomUUID(), kind, subject: render(rule.subject_template, values), body: render(rule.body_template, values), scheduled_for: scheduled, next_attempt_at: scheduled }
  await admin.from('messages').upsert(row, { onConflict: 'company_id,booking_id,kind' })
}

export async function queueSupplierReminder(companyId: string, bookingId: string, target: string, contact: { name?: string | null; phone?: string | null; email?: string | null }): Promise<void> {
  const [{ data: booking }, { data: settings }, { data: rules }] = await Promise.all([
    admin.from('bookings').select('*').eq('company_id', companyId).eq('id', bookingId).single(),
    admin.from('company_settings').select('timezone').eq('company_id', companyId).single(),
    admin.from('operation_reminder_rules').select('*').eq('company_id', companyId).eq('event', 'supplier_reconfirm').eq('active', true)
  ])
  if (!booking) return
  for (const rule of rules || []) await queueRule(companyId, { ...booking, timezone: settings?.timezone }, rule, target, rule.channel === 'email' ? String(contact.email || '') : String(contact.phone || ''), { supplier_name: contact.name || 'Supplier' })
}

export async function initializeBookingOperations(companyId: string, booking: Record<string, any>, actorId: string): Promise<void> {
  await admin.rpc('seed_operation_defaults', { p_company_id: companyId })
  const [{ data: templates }, { data: settings }, { count: travellerCount }, { data: rules }] = await Promise.all([
    admin.from('operation_task_templates').select('*').eq('company_id', companyId).eq('active', true).order('position'),
    admin.from('company_settings').select('timezone').eq('company_id', companyId).single(),
    admin.from('booking_travellers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('booking_id', booking.id),
    admin.from('operation_reminder_rules').select('*').eq('company_id', companyId).eq('active', true).in('event', ['arrival','departure'])
  ])
  const timezone = settings?.timezone || 'Asia/Kolkata'
  if (templates?.length) {
    const tasks = templates.map(row => {
      const anchor = row.anchor === 'confirmation' ? String(booking.confirmed_at).slice(0, 10) : row.anchor === 'departure' ? booking.departure_date : booking.arrival_date
      return { company_id: companyId, booking_id: booking.id, template_id: row.id, title: row.title, category: row.category, priority: row.priority, due_at: operationLocalTime(addDays(anchor, row.offset_days), 9, timezone), assignee_id: row.assignment_rule === 'booking_owner' ? booking.assignee_id || actorId : null, source: 'template', created_by: actorId }
    })
    await admin.from('booking_tasks').upsert(tasks, { onConflict: 'booking_id,template_id', ignoreDuplicates: true })
    for (const task of tasks) await admin.from('booking_tasks').update({ title: task.title, category: task.category, priority: task.priority, due_at: task.due_at, updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('booking_id', booking.id).eq('template_id', task.template_id).in('status', ['todo','in_progress','blocked'])
  }
  if (!travellerCount) {
    const travellers = [{ company_id: companyId, booking_id: booking.id, traveller_type: 'adult', full_name: booking.client_name, phone: booking.phone, email: booking.email, is_primary: true }]
    for (let n = 2; n <= Number(booking.adults || 0); n += 1) travellers.push({ company_id: companyId, booking_id: booking.id, traveller_type: 'adult', full_name: `Adult ${n}`, phone: null, email: null, is_primary: false })
    for (let n = 1; n <= Number(booking.children || 0); n += 1) travellers.push({ company_id: companyId, booking_id: booking.id, traveller_type: 'child', full_name: `Child ${n}`, phone: null, email: null, is_primary: false })
    await admin.from('booking_travellers').insert(travellers)
  }
  for (const rule of rules || []) {
    const recipient = rule.channel === 'email' ? booking.email : booking.phone
    await queueRule(companyId, { ...booking, timezone }, rule, 'customer', String(recipient || ''))
  }
}

async function ensureMember(companyId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const { data } = await admin.from('memberships').select('user_id').eq('company_id', companyId).eq('user_id', userId).eq('active', true).maybeSingle()
  if (!data) throw new HttpError(400, 'Choose an active team member from this company.')
}

async function ensureTravellers(companyId: string, bookingId: string, travellerIds: string[]): Promise<void> {
  if (!travellerIds.length) return
  const { count } = await admin.from('booking_travellers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('booking_id', bookingId).in('id', travellerIds)
  if ((count || 0) !== new Set(travellerIds).size) throw new HttpError(400, 'Choose travellers from this booking.')
}

export async function processDueOperations(): Promise<{ notifications: number; sent: number; failed: number }> {
  const now = new Date().toISOString(); let notifications = 0; let sent = 0; let failed = 0
  const { data: dueTasks } = await admin.from('booking_tasks').select('id,company_id,booking_id,title,assignee_id,due_at').not('assignee_id', 'is', null).in('status', ['todo','in_progress','blocked']).lte('due_at', now).limit(200)
  for (const task of dueTasks || []) {
    const day = now.slice(0, 10)
    const { error } = await admin.from('user_notifications').upsert({ company_id: task.company_id, user_id: task.assignee_id, booking_id: task.booking_id, task_id: task.id, type: 'overdue', title: 'Task needs attention', body: task.title, dedupe_key: `task-due:${task.id}:${day}` }, { onConflict: 'company_id,user_id,dedupe_key', ignoreDuplicates: true })
    if (!error) notifications += 1
  }
  const { data: messages } = await admin.from('messages').select('*').in('status', ['queued','retry']).lte('scheduled_for', now).lte('next_attempt_at', now).order('scheduled_for').limit(25)
  for (const message of messages || []) {
    const claimed = await admin.from('messages').update({ status: 'processing', updated_at: now }).eq('id', message.id).eq('status', message.status).select('id').maybeSingle()
    if (!claimed.data) continue
    try {
      const providerId = await sendOperationalMessage(message.company_id, message.channel, message.recipient, message.subject || 'Travel update', message.body || '')
      await admin.from('messages').update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq('id', message.id)
      sent += 1
    } catch (error) {
      const attempts = Number(message.attempt_count || 0) + 1
      const next = new Date(Date.now() + Math.min(24, 2 ** attempts) * 3600000).toISOString()
      await admin.from('messages').update({ status: attempts >= 5 ? 'failed' : 'retry', attempt_count: attempts, next_attempt_at: next, error: (error as Error).message.slice(0, 1000), updated_at: new Date().toISOString() }).eq('id', message.id)
      failed += 1
    }
  }
  return { notifications, sent, failed }
}

export async function runOperationsJob(request: FastifyRequest): Promise<{ notifications: number; sent: number; failed: number }> {
  if (!env.cronSecret) throw new HttpError(503, 'CRON_SECRET is not configured.')
  if (request.headers.authorization !== `Bearer ${env.cronSecret}`) throw new HttpError(401, 'Invalid job credential.')
  return processDueOperations()
}

export async function registerOperations(app: FastifyInstance): Promise<void> {
  app.get('/operations/summary', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); const now = new Date().toISOString()
    const [open, overdue, unassigned, unread] = await Promise.all([
      ctx.db.from('booking_tasks').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).in('status', ['todo','in_progress','blocked']),
      ctx.db.from('booking_tasks').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).in('status', ['todo','in_progress','blocked']).lt('due_at', now),
      ctx.db.from('booking_transport_days').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('driver_status', 'unassigned'),
      ctx.db.from('user_notifications').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('user_id', ctx.userId).is('read_at', null)
    ])
    return { open_tasks: open.count || 0, overdue_tasks: overdue.count || 0, unassigned_drivers: unassigned.count || 0, unread_notifications: unread.count || 0 }
  })

  app.get('/operations/tasks', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); const q = request.query as { mine?: string; status?: string }
    let builder = ctx.db.from('booking_tasks').select('*,bookings(booking_number,client_name,destination,arrival_date,departure_date)').eq('company_id', ctx.companyId).order('due_at')
    if (q.mine === 'true') builder = builder.eq('assignee_id', ctx.userId)
    if (q.status) builder = builder.eq('status', q.status)
    else builder = builder.neq('status', 'cancelled')
    return unwrap(await builder)
  })
  app.get('/operations/assignees', async request => {
    const ctx = requirePermission(request, 'booking_operations.read')
    return unwrap(await admin.from('memberships').select('user_id,name').eq('company_id', ctx.companyId).eq('active', true).order('name'))
  })

  app.get('/operation-templates', async request => {
    const ctx = requirePermission(request, 'booking_operations.read')
    return unwrap(await ctx.db.from('operation_task_templates').select('*').eq('company_id', ctx.companyId).order('position'))
  })
  app.post('/operation-templates', async request => {
    const ctx = requirePermission(request, 'operation_settings.write'); const parsed = templateInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check template details.')
    const row = unwrap(await ctx.db.from('operation_task_templates').insert({ ...parsed.data, company_id: ctx.companyId }).select('*').single()); await audit(ctx, 'operation_templates.create', row.id); return row
  })
  app.patch('/operation-templates/:id', async request => {
    const ctx = requirePermission(request, 'operation_settings.write'); const parsed = templateInput.partial().safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check template details.')
    const row = unwrap(await ctx.db.from('operation_task_templates').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single()); await audit(ctx, 'operation_templates.update', row.id); return row
  })

  app.get('/bookings/:id/tasks', async request => {
    const ctx = requirePermission(request, 'booking_operations.read')
    return unwrap(await ctx.db.from('booking_tasks').select('*').eq('company_id', ctx.companyId).eq('booking_id', id(request.params)).order('due_at'))
  })
  app.post('/bookings/:id/tasks', async request => {
    const ctx = requirePermission(request, 'booking_operations.write'); const parsed = taskInput.extend({ title: z.string().trim().min(2).max(200) }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check task details.'); await ensureMember(ctx.companyId, parsed.data.assignee_id)
    const row = unwrap(await ctx.db.from('booking_tasks').insert({ ...parsed.data, company_id: ctx.companyId, booking_id: id(request.params), source: 'manual', created_by: ctx.userId }).select('*').single()); await notifyAssignee(ctx.companyId, row); await audit(ctx, 'booking_tasks.create', row.id); return row
  })
  app.patch('/booking-tasks/:id', async request => {
    const ctx = requireAnyPermission(request, ['booking_operations.write','booking_tasks.assign']); const parsed = taskInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check task details.'); await ensureMember(ctx.companyId, parsed.data.assignee_id)
    const canWrite = ctx.platform || ctx.permissions.includes('*') || ctx.permissions.includes('booking_operations.write')
    if (!canWrite && Object.keys(parsed.data).some(key => key !== 'assignee_id')) throw new HttpError(403, 'You may only change the task assignee.')
    const values: Record<string, any> = { ...parsed.data, updated_at: new Date().toISOString() }
    if (parsed.data.status === 'done') Object.assign(values, { completed_at: new Date().toISOString(), completed_by: ctx.userId })
    else if (parsed.data.status) Object.assign(values, { completed_at: null, completed_by: null })
    const row = unwrap(await ctx.db.from('booking_tasks').update(values).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single()); if (parsed.data.assignee_id) await notifyAssignee(ctx.companyId, row); await audit(ctx, 'booking_tasks.update', row.id); return row
  })
  app.post('/booking-tasks/:id/complete', async request => {
    const ctx = requirePermission(request, 'booking_operations.write')
    const row = unwrap(await ctx.db.from('booking_tasks').update({ status: 'done', completed_at: new Date().toISOString(), completed_by: ctx.userId, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single()); await audit(ctx, 'booking_tasks.complete', row.id); return row
  })

  app.get('/bookings/:id/travellers', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); const bookingId = id(request.params)
    const [travellers, documents] = await Promise.all([
      ctx.db.from('booking_travellers').select('*').eq('company_id', ctx.companyId).eq('booking_id', bookingId).order('is_primary', { ascending: false }).order('created_at'),
      ctx.permissions.includes('*') || ctx.permissions.includes('traveller_documents.read') ? ctx.db.from('booking_traveller_documents').select('*').eq('company_id', ctx.companyId).eq('booking_id', bookingId).order('created_at') : Promise.resolve({ data: [], error: null })
    ])
    if (travellers.error || documents.error) throw new HttpError(400, travellers.error?.message || documents.error?.message || 'Could not load travellers.')
    return (travellers.data || []).map(row => ({ ...row, documents: (documents.data || []).filter(doc => doc.traveller_id === row.id) }))
  })
  app.post('/bookings/:id/travellers', async request => {
    const ctx = requirePermission(request, 'booking_operations.write'); const parsed = travellerInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check traveller details.')
    const row = unwrap(await ctx.db.from('booking_travellers').insert({ ...parsed.data, email: parsed.data.email || null, company_id: ctx.companyId, booking_id: id(request.params) }).select('*').single()); await audit(ctx, 'booking_travellers.create', row.id); return row
  })
  app.patch('/booking-travellers/:id', async request => {
    const ctx = requirePermission(request, 'booking_operations.write'); const parsed = travellerInput.partial().safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check traveller details.')
    const row = unwrap(await ctx.db.from('booking_travellers').update({ ...parsed.data, email: parsed.data.email || null, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single()); await audit(ctx, 'booking_travellers.update', row.id); return row
  })
  app.post('/booking-travellers/:id/documents', async request => {
    const ctx = requirePermission(request, 'traveller_documents.write')
    const parsed = z.object({ document_type: z.string().trim().min(2).max(80), storage_path: z.string().max(500), original_name: z.string().max(200), mime_type: z.string().max(100), size_bytes: z.coerce.number().int().min(0).max(25 * 1024 * 1024), expiry_date: z.iso.date().nullable().optional() }).safeParse(request.body)
    if (!parsed.success || !parsed.data.storage_path.startsWith(`${ctx.companyId}/`)) throw new HttpError(400, 'Check document details.')
    const traveller = unwrap(await ctx.db.from('booking_travellers').select('id,booking_id').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    const row = unwrap(await ctx.db.from('booking_traveller_documents').insert({ ...parsed.data, company_id: ctx.companyId, booking_id: traveller.booking_id, traveller_id: traveller.id, status: 'uploaded', created_by: ctx.userId }).select('*').single()); await audit(ctx, 'traveller_documents.upload', row.id, { booking: traveller.booking_id }); return row
  })
  app.patch('/traveller-documents/:id/verify', async request => {
    const ctx = requirePermission(request, 'traveller_documents.verify'); const parsed = z.object({ status: z.enum(['verified','rejected']), notes: z.string().max(2000).nullable().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Choose verified or rejected.')
    const row = unwrap(await ctx.db.from('booking_traveller_documents').update({ ...parsed.data, verified_by: ctx.userId, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single()); await audit(ctx, `traveller_documents.${parsed.data.status}`, row.id); return row
  })
  app.get('/traveller-documents/:id/download-url', async request => {
    const ctx = requirePermission(request, 'traveller_documents.read'); const row = unwrap(await ctx.db.from('booking_traveller_documents').select('storage_path').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    if (!row.storage_path) throw new HttpError(404, 'No file has been uploaded.'); return { url: unwrap(await admin.storage.from('crm-private').createSignedUrl(row.storage_path, 600)).signedUrl }
  })

  app.get('/bookings/:id/services', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); const bookingId = id(request.params)
    const [services, links] = await Promise.all([ctx.db.from('booking_services').select('*').eq('company_id', ctx.companyId).eq('booking_id', bookingId).order('start_at'), ctx.db.from('booking_service_travellers').select('*').eq('company_id', ctx.companyId)])
    if (services.error || links.error) throw new HttpError(400, services.error?.message || links.error?.message || 'Could not load services.')
    return (services.data || []).map(row => ({ ...row, traveller_ids: (links.data || []).filter(link => link.service_id === row.id).map(link => link.traveller_id) }))
  })
  app.post('/bookings/:id/services', async request => {
    const ctx = requirePermission(request, 'booking_operations.write'); const parsed = serviceInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check reservation details.'); const { traveller_ids, ...value } = parsed.data; const bookingId = id(request.params); await ensureTravellers(ctx.companyId, bookingId, traveller_ids)
    const row = unwrap(await ctx.db.from('booking_services').insert({ ...value, supplier_email: value.supplier_email || null, currency: value.currency.toUpperCase(), company_id: ctx.companyId, booking_id: bookingId, created_by: ctx.userId }).select('*').single())
    if (traveller_ids.length) await ctx.db.from('booking_service_travellers').insert(traveller_ids.map(traveller_id => ({ company_id: ctx.companyId, service_id: row.id, traveller_id })))
    if (!['confirmed','ticketed','cancelled'].includes(row.status)) await queueSupplierReminder(ctx.companyId, row.booking_id, `service:${row.id}`, { name: row.supplier_name, phone: row.supplier_phone, email: row.supplier_email })
    await audit(ctx, 'booking_services.create', row.id); return { ...row, traveller_ids }
  })
  app.patch('/booking-services/:id', async request => {
    const ctx = requirePermission(request, 'booking_operations.write'); const parsed = serviceInput.partial().safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check reservation details.'); const { traveller_ids, ...value } = parsed.data
    const existing = unwrap(await ctx.db.from('booking_services').select('booking_id').eq('company_id', ctx.companyId).eq('id', id(request.params)).single()); if (traveller_ids) await ensureTravellers(ctx.companyId, existing.booking_id, traveller_ids)
    const row = unwrap(await ctx.db.from('booking_services').update({ ...value, currency: value.currency?.toUpperCase(), updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    if (traveller_ids) { await ctx.db.from('booking_service_travellers').delete().eq('company_id', ctx.companyId).eq('service_id', row.id); if (traveller_ids.length) await ctx.db.from('booking_service_travellers').insert(traveller_ids.map(traveller_id => ({ company_id: ctx.companyId, service_id: row.id, traveller_id }))) }
    if (!['confirmed','ticketed','cancelled'].includes(row.status)) await queueSupplierReminder(ctx.companyId, row.booking_id, `service:${row.id}`, { name: row.supplier_name, phone: row.supplier_phone, email: row.supplier_email })
    await audit(ctx, 'booking_services.update', row.id); return { ...row, traveller_ids }
  })

  app.get('/bookings/:id/supplier-readiness', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); const bookingId = id(request.params)
    const [stays, transport, services] = await Promise.all([
      ctx.db.from('booking_stays').select('id,property_name,confirmation_status,confirmation_reference,supplier_phone,supplier_email').eq('company_id', ctx.companyId).eq('booking_id', bookingId),
      ctx.db.from('booking_transport_days').select('id,day,destination,confirmation_status,confirmation_reference,supplier_name,supplier_phone,supplier_email,driver_status').eq('company_id', ctx.companyId).eq('booking_id', bookingId),
      ctx.db.from('booking_services').select('id,type,title,status,confirmation_reference,supplier_name,supplier_phone,supplier_email').eq('company_id', ctx.companyId).eq('booking_id', bookingId)
    ])
    if (stays.error || transport.error || services.error) throw new HttpError(400, 'Could not load supplier readiness.')
    return [
      ...(stays.data || []).map(x => ({ ...x, type: 'stay', title: x.property_name, ready: x.confirmation_status === 'confirmed' })),
      ...(transport.data || []).map(x => ({ ...x, type: 'transport', title: `Day ${x.day} · ${x.destination}`, ready: x.confirmation_status === 'confirmed' && ['confirmed','completed'].includes(x.driver_status) })),
      ...(services.data || []).map(x => ({ ...x, confirmation_status: x.status, ready: ['confirmed','ticketed'].includes(x.status) }))
    ]
  })

  app.get('/reminder-rules', async request => {
    const ctx = requirePermission(request, 'booking_operations.read'); return unwrap(await ctx.db.from('operation_reminder_rules').select('*').eq('company_id', ctx.companyId).order('created_at'))
  })
  app.patch('/reminder-rules/:id', async request => {
    const ctx = requirePermission(request, 'operation_settings.write'); const parsed = ruleInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check reminder rule details.')
    const row = unwrap(await ctx.db.from('operation_reminder_rules').update({ ...parsed.data, updated_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    if (row.active) {
      const [bookings, settings] = await Promise.all([admin.from('bookings').select('*').eq('company_id', ctx.companyId).in('status', ['confirmed','in_progress']), admin.from('company_settings').select('timezone').eq('company_id', ctx.companyId).single()])
      for (const booking of bookings.data || []) {
        const timed = { ...booking, timezone: settings.data?.timezone }
        if (row.event === 'arrival' || row.event === 'departure') await queueRule(ctx.companyId, timed, row, 'customer', row.channel === 'email' ? String(booking.email || '') : String(booking.phone || ''))
        if (row.event === 'supplier_reconfirm') {
          const [stays, transport, services] = await Promise.all([
            admin.from('booking_stays').select('id,property_name,supplier_phone,supplier_email,confirmation_status').eq('company_id', ctx.companyId).eq('booking_id', booking.id).not('confirmation_status', 'in', '(confirmed,cancelled)'),
            admin.from('booking_transport_days').select('id,supplier_name,supplier_phone,supplier_email,confirmation_status').eq('company_id', ctx.companyId).eq('booking_id', booking.id).not('confirmation_status', 'in', '(confirmed,cancelled)'),
            admin.from('booking_services').select('id,supplier_name,supplier_phone,supplier_email,status').eq('company_id', ctx.companyId).eq('booking_id', booking.id).not('status', 'in', '(confirmed,ticketed,cancelled)')
          ])
          for (const supplier of [...(stays.data || []).map(x => ({ ...x, target: `stay:${x.id}`, name: x.property_name })), ...(transport.data || []).map(x => ({ ...x, target: `transport:${x.id}`, name: x.supplier_name })), ...(services.data || []).map(x => ({ ...x, target: `service:${x.id}`, name: x.supplier_name }))]) await queueRule(ctx.companyId, timed, row, supplier.target, row.channel === 'email' ? String(supplier.supplier_email || '') : String(supplier.supplier_phone || ''), { supplier_name: supplier.name || 'Supplier' })
        }
      }
    }
    await audit(ctx, 'reminder_rules.update', row.id); return row
  })

  app.get('/notifications', async request => {
    const ctx = requirePermission(request, 'notifications.read'); return unwrap(await ctx.db.from('user_notifications').select('*,bookings(booking_number,client_name)').eq('company_id', ctx.companyId).eq('user_id', ctx.userId).order('created_at', { ascending: false }).limit(100))
  })
  app.post('/notifications/:id/read', async request => {
    const ctx = requirePermission(request, 'notifications.read'); return unwrap(await ctx.db.from('user_notifications').update({ read_at: new Date().toISOString() }).eq('company_id', ctx.companyId).eq('user_id', ctx.userId).eq('id', id(request.params)).select('*').single())
  })
}
