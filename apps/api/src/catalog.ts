import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { admin, audit, HttpError, platformAudit, requireContext, requirePermission, unwrap, type Context } from './core.js'
import { accessibleCatalogEntries, accessibleCatalogSourceIds, catalogTypes, normalizeCatalogText, type CatalogType } from './catalog-governance.js'

type CatalogQuery = { q?: string; region?: string; days?: string; theme?: string; season?: string; location_id?: string; property_type?: string; limit?: string }
type Lookup = { id: string; source: 'catalog' | 'company'; title: string; subtitle: string; group?: string; data: Record<string, unknown> }

export { normalizeCatalogText } from './catalog-governance.js'
export const seasonForMonth = (month: number) => month >= 12 || month <= 2 ? 'winter' : month <= 4 ? 'spring' : month <= 8 ? 'summer' : 'autumn'
const query = (value: unknown) => value as CatalogQuery
const cleanLimit = (value?: string) => Math.min(50, Math.max(1, Number(value) || 50))
const matches = (needle: string, ...values: unknown[]) => !needle || values.some(value => normalizeCatalogText(value).includes(needle))

const optionTypes = new Set<CatalogType>(['room_type','property_type','hotel_category','voucher_inclusion'])
const sourceTables: Partial<Record<CatalogType, string>> = { hotel: 'catalog_hotels', location: 'catalog_locations', day_plan: 'catalog_day_plans', itinerary_template: 'catalog_itinerary_templates' }
const itemBody = z.object({ catalog_type: z.enum(catalogTypes), data: z.record(z.string(), z.unknown()), availability_mode: z.enum(['all','selected']).default('all') })
const idParam = (value: unknown) => (value as { id: string }).id

function owner(request: Parameters<typeof requireContext>[0]): Context {
  const ctx = requireContext(request)
  if (!ctx.platform) throw new HttpError(403, 'Only a platform owner can manage the travel catalog.')
  return ctx
}

const textValue = (data: Record<string, unknown>, key: string, required = false) => {
  const value = String(data[key] || '').trim()
  if (required && !value) throw new HttpError(400, `${key.replaceAll('_', ' ')} is required.`)
  if (value.length > 10000) throw new HttpError(400, `${key.replaceAll('_', ' ')} is too long.`)
  return value || null
}
const uuidValue = (data: Record<string, unknown>, key: string, required = false) => {
  const value = textValue(data, key, required)
  if (value && !z.uuid().safeParse(value).success) throw new HttpError(400, `${key.replaceAll('_', ' ')} is invalid.`)
  return value
}
const catalogKey = (name: string) => `${normalizeCatalogText(name) || 'item'}-${randomUUID().slice(0, 8)}`

async function replaceTemplateDays(templateId: string, raw: unknown): Promise<void> {
  const days = z.array(z.object({ day_number: z.coerce.number().int().min(1).max(60), day_plan_id: z.uuid(), overnight_location_id: z.uuid().nullable().optional() })).max(60).parse(raw || [])
  if (!days.length) throw new HttpError(400, 'Add at least one mapped day to publish a template.')
  const dayIds = days.map(day => day.day_plan_id); const locationIds = days.flatMap(day => day.overnight_location_id ? [day.overnight_location_id] : [])
  const active = await Promise.all([
    admin.from('catalog_entries').select('source_id').eq('catalog_type', 'day_plan').eq('active', true).in('source_id', dayIds),
    locationIds.length ? admin.from('catalog_entries').select('source_id').eq('catalog_type', 'location').eq('active', true).in('source_id', locationIds) : Promise.resolve({ data: [], error: null })
  ])
  if (active.some(result => result.error)) throw new HttpError(400, active.find(result => result.error)?.error?.message || 'Could not validate template dependencies.')
  if (new Set(active[0].data?.map(row => row.source_id)).size !== new Set(dayIds).size || new Set(active[1].data?.map(row => row.source_id)).size !== new Set(locationIds).size) throw new HttpError(409, 'Every day and overnight location must map to an active catalog item.')
  const removed = await admin.from('catalog_template_days').delete().eq('template_id', templateId)
  if (removed.error) throw new HttpError(400, removed.error.message)
  const inserted = await admin.from('catalog_template_days').insert(days.map(day => ({ template_id: templateId, ...day })))
  if (inserted.error) throw new HttpError(400, inserted.error.message)
}

async function createSource(type: CatalogType, data: Record<string, unknown>): Promise<any> {
  const name = textValue(data, 'name', true)!
  if (optionTypes.has(type)) return unwrap(await admin.from('catalog_options').insert({ option_type: type, name, description: textValue(data, 'description') }).select('*').single())
  if (type === 'location') return unwrap(await admin.from('catalog_locations').insert({ catalog_key: catalogKey(name), name, region: z.enum(['Kashmir','Ladakh']).parse(data.region), locality: textValue(data, 'locality'), aliases: z.array(z.string().max(200)).max(30).parse(data.aliases || []) }).select('*').single())
  if (type === 'hotel') return unwrap(await admin.from('catalog_hotels').insert({ catalog_key: catalogKey(name), canonical_name: name, aliases: z.array(z.string().max(200)).max(30).parse(data.aliases || []), region: z.enum(['Kashmir','Ladakh']).parse(data.region), location_id: uuidValue(data, 'location_id', true), locality: textValue(data, 'locality'), property_type: textValue(data, 'property_type', true), source_url: textValue(data, 'source_url'), source_type: textValue(data, 'source_type'), verified_on: textValue(data, 'verified_on') }).select('*').single())
  if (type === 'day_plan') return unwrap(await admin.from('catalog_day_plans').insert({ catalog_key: catalogKey(name), title: name, region: z.enum(['Kashmir','Ladakh','Combined']).parse(data.region), location_id: uuidValue(data, 'location_id'), description: textValue(data, 'description', true), route_destination: textValue(data, 'route_destination'), warning: textValue(data, 'warning') }).select('*').single())
  const duration = z.coerce.number().int().min(3).max(10).parse(data.duration)
  const template = unwrap(await admin.from('catalog_itinerary_templates').insert({ catalog_key: catalogKey(name), title: name, region: z.enum(['Kashmir','Ladakh','Combined']).parse(data.region), duration, theme: textValue(data, 'theme', true), season_tags: z.array(z.string().max(50)).max(20).parse(data.season_tags || []), gateway: textValue(data, 'gateway', true), route_label: textValue(data, 'route_label', true), warnings: z.array(z.string().max(1000)).max(20).parse(data.warnings || []) }).select('*').single())
  try { await replaceTemplateDays(template.id, data.days) } catch (error) { await admin.from('catalog_itinerary_templates').delete().eq('id', template.id); throw error }
  return template
}

async function updateSource(type: CatalogType, sourceId: string, data: Record<string, unknown>): Promise<any> {
  const name = textValue(data, 'name', true)!
  if (optionTypes.has(type)) return unwrap(await admin.from('catalog_options').update({ name, description: textValue(data, 'description'), updated_at: new Date().toISOString() }).eq('id', sourceId).eq('option_type', type).select('*').single())
  let values: Record<string, unknown>
  if (type === 'location') values = { name, region: z.enum(['Kashmir','Ladakh']).parse(data.region), locality: textValue(data, 'locality'), aliases: z.array(z.string().max(200)).max(30).parse(data.aliases || []) }
  else if (type === 'hotel') values = { canonical_name: name, aliases: z.array(z.string().max(200)).max(30).parse(data.aliases || []), region: z.enum(['Kashmir','Ladakh']).parse(data.region), location_id: uuidValue(data, 'location_id', true), locality: textValue(data, 'locality'), property_type: textValue(data, 'property_type', true), source_url: textValue(data, 'source_url'), source_type: textValue(data, 'source_type'), verified_on: textValue(data, 'verified_on') }
  else if (type === 'day_plan') values = { title: name, region: z.enum(['Kashmir','Ladakh','Combined']).parse(data.region), location_id: uuidValue(data, 'location_id'), description: textValue(data, 'description', true), route_destination: textValue(data, 'route_destination'), warning: textValue(data, 'warning') }
  else values = { title: name, region: z.enum(['Kashmir','Ladakh','Combined']).parse(data.region), duration: z.coerce.number().int().min(3).max(10).parse(data.duration), theme: textValue(data, 'theme', true), season_tags: z.array(z.string().max(50)).max(20).parse(data.season_tags || []), gateway: textValue(data, 'gateway', true), route_label: textValue(data, 'route_label', true), warnings: z.array(z.string().max(1000)).max(20).parse(data.warnings || []) }
  const item = unwrap(await admin.from(sourceTables[type]!).update({ ...values, updated_at: new Date().toISOString() }).eq('id', sourceId).select('*').single())
  if (type === 'itinerary_template' && data.days) await replaceTemplateDays(sourceId, data.days)
  return item
}

async function sourceRows(entries: any[]): Promise<Map<string, any>> {
  const map = new Map<string, any>()
  for (const type of catalogTypes) {
    const group = entries.filter(entry => entry.catalog_type === type)
    if (!group.length) continue
    const table = optionTypes.has(type) ? 'catalog_options' : sourceTables[type]!
    const result = await admin.from(table).select('*').in('id', group.map(entry => entry.source_id))
    if (result.error) throw new HttpError(400, result.error.message)
    for (const row of result.data || []) map.set(row.id, row)
  }
  return map
}

async function createCatalogItem(ctx: Context, type: CatalogType, data: Record<string, unknown>, availabilityMode: 'all' | 'selected' = 'all', provenance: 'platform' | 'company' = 'platform', sourceCompanyId?: string): Promise<any> {
  const source = await createSource(type, data)
  const locationSuffix = type === 'hotel' ? `:${source.location_id}` : ''
  try {
    const entry = unwrap(await admin.from('catalog_entries').insert({ id: source.id, catalog_type: type, source_id: source.id, normalized_key: `${normalizeCatalogText(source.canonical_name || source.title || source.name)}${locationSuffix}`, title: source.canonical_name || source.title || source.name, availability_mode: availabilityMode, provenance, source_company_id: sourceCompanyId || null, created_by: ctx.userId }).select('*').single())
    return { ...entry, data: source }
  } catch (error) {
    await admin.from(optionTypes.has(type) ? 'catalog_options' : sourceTables[type]!).delete().eq('id', source.id)
    throw error
  }
}

async function quoteReferences(sourceId: string): Promise<boolean> {
  for (let from = 0; ; from += 1000) {
    const result = await admin.from('quotes').select('itinerary,stays').range(from, from + 999)
    if (result.error) throw new HttpError(400, result.error.message)
    if ((result.data || []).some(row => JSON.stringify([row.itinerary, row.stays]).includes(sourceId))) return true
    if ((result.data || []).length < 1000) return false
  }
}

export async function registerCatalog(app: FastifyInstance): Promise<void> {
  app.get('/catalog/locations', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const { q = '', region } = query(request.query); const needle = normalizeCatalogText(q)
    let builder = admin.from('catalog_locations').select('*').order('region').order('name')
    if (region) builder = builder.eq('region', region)
    const [rows, visible, ownResult] = await Promise.all([
      builder.limit(200).then(unwrap), accessibleCatalogSourceIds(ctx.companyId, ['location']),
      ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', 'location').eq('status', 'Active').order('title').limit(100)
    ])
    if (ownResult.error) throw new HttpError(400, ownResult.error.message)
    const catalog = rows.filter(row => visible.has(row.id) && matches(needle, row.name, ...(row.aliases || []), row.locality)).map(row => ({ id: row.id, source: 'catalog' as const, title: row.name, subtitle: [row.locality, row.region].filter(Boolean).join(' · '), data: { ...row, catalog_entry_id: row.id, catalog_status: 'active' } }))
    const own = (ownResult.data || []).filter(row => !row.data?.catalog_entry_id || !visible.has(row.data.catalog_entry_id)).filter(row => matches(needle, row.title, row.data?.locality)).map(row => ({ id: row.id, source: 'company' as const, title: row.title, subtitle: 'My locations', group: 'My locations', data: row.data || {} }))
    return [...catalog, ...own].slice(0, 50)
  })

  app.get('/catalog/day-plans', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const { q = '', region, location_id: locationId } = query(request.query); const needle = normalizeCatalogText(q)
    let shared = admin.from('catalog_day_plans').select('*,catalog_locations(name)').order('title')
    if (region) shared = shared.eq('region', region)
    if (locationId) shared = shared.eq('location_id', locationId)
    if (q.trim()) { const safe = q.trim().replace(/[^a-zA-Z0-9 -]/g, ''); shared = shared.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`) }
    let company = ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', 'day_plan').eq('status', 'Active').order('title').limit(100)
    if (q.trim()) company = company.ilike('title', `%${q.trim().replace(/[%_,()]/g, '')}%`)
    const [catalogResult, companyResult, visible] = await Promise.all([shared.limit(q.trim() ? 50 : 200), company, accessibleCatalogSourceIds(ctx.companyId, ['day_plan'])])
    if (catalogResult.error || companyResult.error) throw new HttpError(400, catalogResult.error?.message || companyResult.error?.message || 'Could not search day plans.')
    const catalog: Lookup[] = (catalogResult.data || []).filter(row => visible.has(row.id) && matches(needle, row.title, row.description)).slice(0, 50).map(row => ({ id: row.id, source: 'catalog', title: row.title, subtitle: `${row.region} · ${(row.catalog_locations as any)?.name || 'Touring day'}`, group: 'Kashmir/Ladakh catalog', data: { ...row, catalog_entry_id: row.id, catalog_status: 'active' } }))
    const own: Lookup[] = (companyResult.data || []).filter(row => !row.data?.catalog_entry_id || !visible.has(row.data.catalog_entry_id)).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: 'My day plans', group: 'My day plans', data: row.data || {} }))
    return [...catalog.slice(0, Math.max(0, 50 - own.length)), ...own].slice(0, 50)
  })

  app.get('/catalog/templates', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const { days, region, theme, season } = query(request.query)
    let builder = admin.from('catalog_itinerary_templates').select('*').order('title')
    if (days) builder = builder.eq('duration', Number(days))
    if (region) builder = builder.eq('region', region)
    if (theme) builder = builder.eq('theme', theme)
    const [templateRows, visible, ownResult] = await Promise.all([
      builder.limit(50).then(unwrap), accessibleCatalogSourceIds(ctx.companyId, ['itinerary_template']),
      ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', 'itinerary_template').eq('status', 'Active').order('title').limit(50)
    ])
    if (ownResult.error) throw new HttpError(400, ownResult.error.message)
    const templates = templateRows.filter(row => visible.has(row.id))
    if (!templates.length) return (ownResult.data || []).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: 'My templates', data: row.data || {} }))
    const templateIds = templates.map(row => row.id)
    const dayRows = unwrap(await admin.from('catalog_template_days').select('template_id,day_number,overnight_location_id,catalog_day_plans(*),catalog_locations(name)').in('template_id', templateIds).order('day_number'))
    const catalog = templates.map(template => {
      const templateDays = dayRows.filter(row => row.template_id === template.id).map(row => {
        const plan = row.catalog_day_plans as any
        return { day_number: row.day_number, day_plan_id: plan.id, name: plan.title, description: plan.description, location_id: plan.location_id, route_destination: plan.route_destination, overnight_location_id: row.overnight_location_id, overnight_location: (row.catalog_locations as any)?.name || null, warning: plan.warning }
      })
      return { id: template.id, source: 'catalog', title: template.title, subtitle: `${template.duration} days · ${template.theme} · ${template.route_label}`, data: { ...template, days: templateDays, catalog_entry_id: template.id, catalog_status: 'active' }, season_match: season ? template.season_tags.includes(season) : false }
    }).sort((a, b) => Number(b.season_match) - Number(a.season_match))
    const own = (ownResult.data || []).filter(row => !row.data?.catalog_entry_id || !visible.has(row.data.catalog_entry_id)).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: 'My templates', data: row.data || {}, season_match: false }))
    return [...catalog, ...own].slice(0, 50)
  })

  app.get('/catalog/hotels', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const { q = '', region, location_id: locationId, property_type: propertyType, limit } = query(request.query); const needle = normalizeCatalogText(q); const max = cleanLimit(limit)
    let shared = admin.from('catalog_hotels').select('*,catalog_locations(name)').order('canonical_name')
    if (region) shared = shared.eq('region', region)
    if (locationId) shared = shared.eq('location_id', locationId)
    if (propertyType) shared = shared.eq('property_type', propertyType)
    let own = ctx.db.from('records').select('id,title,data').eq('company_id', ctx.companyId).eq('type', 'hotel').eq('status', 'Active').order('title').limit(100)
    if (q.trim()) own = own.ilike('title', `%${q.trim().replace(/[%_,()]/g, '')}%`)
    const [sharedResult, overrideResult, ownResult, visible] = await Promise.all([
      shared.limit(550),
      ctx.db.from('company_hotel_overrides').select('*').eq('company_id', ctx.companyId),
      own,
      accessibleCatalogSourceIds(ctx.companyId, ['hotel'])
    ])
    if (sharedResult.error || overrideResult.error || ownResult.error) throw new HttpError(400, sharedResult.error?.message || overrideResult.error?.message || ownResult.error?.message || 'Could not search hotels.')
    const overrides = new Map((overrideResult.data || []).map(row => [row.catalog_hotel_id, row]))
    const catalog: Lookup[] = (sharedResult.data || []).filter(row => {
      const override = overrides.get(row.id)
      return visible.has(row.id) && !override?.hidden && matches(needle, row.canonical_name, ...(row.aliases || []), row.locality, (row.catalog_locations as any)?.name)
    }).map(row => {
      const override = overrides.get(row.id)
      return { id: row.id, source: 'catalog' as const, title: row.canonical_name, subtitle: [row.property_type, row.locality || (row.catalog_locations as any)?.name, override?.category, !row.verified_on && 'Unverified'].filter(Boolean).join(' · '), group: override?.preferred ? 'Preferred' : 'Kashmir/Ladakh catalog', data: { ...row, override: override || null, catalog_entry_id: row.id, catalog_status: 'active' } }
    }).sort((a, b) => Number(b.group === 'Preferred') - Number(a.group === 'Preferred') || a.title.localeCompare(b.title))
    const mine: Lookup[] = (ownResult.data || []).filter(row => !row.data?.catalog_entry_id || !visible.has(row.data.catalog_entry_id)).filter(row => !locationId || normalizeCatalogText(row.data?.location) === normalizeCatalogText((sharedResult.data || []).find(x => x.location_id === locationId)?.catalog_locations?.name)).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: [row.data?.property_type || 'Hotel', row.data?.location].filter(Boolean).join(' · '), group: 'My properties', data: row.data || {} }))
    const preferred = catalog.filter(row => row.group === 'Preferred')
    const regular = catalog.filter(row => row.group !== 'Preferred').slice(0, Math.max(0, max - preferred.length - mine.length))
    return [...preferred, ...regular, ...mine].slice(0, max)
  })

  app.put('/catalog/hotels/:id/company', async request => {
    const ctx = requirePermission(request, 'hotel.write')
    const id = (request.params as { id: string }).id
    const value = z.object({ preferred: z.boolean().default(false), hidden: z.boolean().default(false), negotiated_rate: z.coerce.number().min(0).nullable().optional(), category: z.string().max(100).nullable().optional(), contact_name: z.string().max(200).nullable().optional(), contact_phone: z.string().max(50).nullable().optional(), contact_email: z.email().nullable().optional(), notes: z.string().max(5000).nullable().optional(), image_path: z.string().max(1000).nullable().optional() }).parse(request.body)
    if (value.image_path && !value.image_path.startsWith(`${ctx.companyId}/`)) throw new HttpError(400, 'The image must belong to this company.')
    const item = unwrap(await ctx.db.from('company_hotel_overrides').upsert({ company_id: ctx.companyId, catalog_hotel_id: id, ...value, updated_at: new Date().toISOString() }).select('*').single())
    await audit(ctx, 'catalog_hotel.override', id)
    return item
  })

  app.get('/catalog/contributions', async request => {
    const ctx = requirePermission(request, 'quotes.read')
    const result = await admin.from('catalog_submissions').select('id,source_record_id,item_type,operation,status,target_entry_id,reason,created_at,updated_at,reviewed_at').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(1000)
    if (result.error) throw new HttpError(400, result.error.message)
    return result.data || []
  })

  app.get('/platform/catalog/items', async request => {
    owner(request)
    const input = request.query as { type?: CatalogType; q?: string; state?: string; page?: string; company_id?: string }
    const page = Math.max(1, Number(input.page) || 1); const pageSize = 25
    let builder = admin.from('catalog_entries').select('*', { count: 'exact' }).order('title').range((page - 1) * pageSize, page * pageSize - 1)
    if (input.type && catalogTypes.includes(input.type)) builder = builder.eq('catalog_type', input.type)
    if (input.state === 'active') builder = builder.eq('active', true)
    if (input.state === 'disabled') builder = builder.eq('active', false)
    if (input.q?.trim()) builder = builder.ilike('title', `%${input.q.trim().replace(/[%_]/g, '')}%`)
    const [result, pendingResult] = await Promise.all([builder, admin.from('catalog_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending')])
    if (result.error || pendingResult.error) throw new HttpError(400, result.error?.message || pendingResult.error?.message || 'Could not load the catalog.')
    const entries = result.data || []; const sources = await sourceRows(entries)
    let companyAccess = new Map<string, boolean>()
    if (input.company_id) {
      const access = await admin.from('catalog_company_access').select('catalog_entry_id,included').eq('company_id', input.company_id)
      if (access.error) throw new HttpError(400, access.error.message)
      companyAccess = new Map((access.data || []).map(row => [row.catalog_entry_id, row.included]))
    }
    return { items: entries.map(entry => ({ ...entry, data: sources.get(entry.source_id) || {}, company_included: input.company_id ? (entry.availability_mode === 'all' ? companyAccess.get(entry.id) !== false : companyAccess.get(entry.id) === true) : undefined })), total: result.count || 0, page, pageSize, pending: pendingResult.count || 0 }
  })

  app.post('/platform/catalog/items', async request => {
    const ctx = owner(request); const value = itemBody.parse(request.body)
    const item = await createCatalogItem(ctx, value.catalog_type, value.data, value.availability_mode)
    await platformAudit(ctx, 'catalog.item.create', null, { entry_id: item.id, catalog_type: value.catalog_type, title: item.title })
    return item
  })

  app.get('/platform/catalog/items/:id', async request => {
    owner(request)
    const entry = unwrap(await admin.from('catalog_entries').select('*').eq('id', idParam(request.params)).single())
    const sources = await sourceRows([entry])
    const [access, duplicates] = await Promise.all([
      admin.from('catalog_company_access').select('company_id,included,companies(id,name)').eq('catalog_entry_id', entry.id),
      admin.from('catalog_entries').select('id,title,active').eq('catalog_type', entry.catalog_type).ilike('normalized_key', `${entry.normalized_key.split(':')[0]}%`).neq('id', entry.id).limit(10)
    ])
    if (access.error || duplicates.error) throw new HttpError(400, access.error?.message || duplicates.error?.message || 'Could not load the catalog item.')
    return { ...entry, data: sources.get(entry.source_id) || {}, access: access.data || [], duplicate_suggestions: duplicates.data || [] }
  })

  app.patch('/platform/catalog/items/:id', async request => {
    const ctx = owner(request)
    const value = z.object({ data: z.record(z.string(), z.unknown()), availability_mode: z.enum(['all','selected']).optional() }).parse(request.body)
    const entry = unwrap(await admin.from('catalog_entries').select('*').eq('id', idParam(request.params)).single())
    const proposedKey = `${normalizeCatalogText(value.data.name)}${entry.catalog_type === 'hotel' ? `:${value.data.location_id}` : ''}`
    const duplicate = await admin.from('catalog_entries').select('id').eq('catalog_type', entry.catalog_type).eq('normalized_key', proposedKey).neq('id', entry.id).maybeSingle()
    if (duplicate.error) throw new HttpError(400, duplicate.error.message)
    if (duplicate.data) throw new HttpError(409, 'A catalog item with this normalized name and location already exists.')
    const source = await updateSource(entry.catalog_type as CatalogType, entry.source_id, value.data)
    const locationSuffix = entry.catalog_type === 'hotel' ? `:${source.location_id}` : ''
    const updated = unwrap(await admin.from('catalog_entries').update({ title: source.canonical_name || source.title || source.name, normalized_key: `${normalizeCatalogText(source.canonical_name || source.title || source.name)}${locationSuffix}`, ...(value.availability_mode ? { availability_mode: value.availability_mode } : {}), updated_at: new Date().toISOString() }).eq('id', entry.id).select('*').single())
    await platformAudit(ctx, 'catalog.item.update', null, { entry_id: entry.id, catalog_type: entry.catalog_type, title: updated.title })
    return { ...updated, data: source }
  })

  app.post('/platform/catalog/items/:id/state', async request => {
    const ctx = owner(request); const value = z.object({ active: z.boolean() }).parse(request.body)
    const item = unwrap(await admin.from('catalog_entries').update({ active: value.active, updated_at: new Date().toISOString() }).eq('id', idParam(request.params)).select('*').single())
    await platformAudit(ctx, value.active ? 'catalog.item.enable' : 'catalog.item.disable', null, { entry_id: item.id, catalog_type: item.catalog_type, title: item.title })
    return item
  })

  app.put('/platform/catalog/items/:id/access', async request => {
    const ctx = owner(request)
    const value = z.object({ availability_mode: z.enum(['all','selected']), included_company_ids: z.array(z.uuid()).max(10000).default([]), excluded_company_ids: z.array(z.uuid()).max(10000).default([]) }).parse(request.body)
    const entry = unwrap(await admin.from('catalog_entries').update({ availability_mode: value.availability_mode, updated_at: new Date().toISOString() }).eq('id', idParam(request.params)).select('*').single())
    await admin.from('catalog_company_access').delete().eq('catalog_entry_id', entry.id)
    const rows = [...new Set(value.included_company_ids)].map(company_id => ({ catalog_entry_id: entry.id, company_id, included: true })).concat([...new Set(value.excluded_company_ids)].map(company_id => ({ catalog_entry_id: entry.id, company_id, included: false })))
    if (rows.length) { const result = await admin.from('catalog_company_access').insert(rows); if (result.error) throw new HttpError(400, result.error.message) }
    await platformAudit(ctx, 'catalog.item.access', null, { entry_id: entry.id, availability_mode: value.availability_mode, included: value.included_company_ids.length, excluded: value.excluded_company_ids.length })
    return { ...entry, overrides: rows }
  })

  app.delete('/platform/catalog/items/:id', async request => {
    const ctx = owner(request); const entry = unwrap(await admin.from('catalog_entries').select('*').eq('id', idParam(request.params)).single())
    const [links, quoteReference, overrides, templateDays] = await Promise.all([
      admin.from('records').select('id', { count: 'exact', head: true }).eq('data->>catalog_entry_id', entry.id),
      quoteReferences(entry.source_id),
      entry.catalog_type === 'hotel' ? admin.from('company_hotel_overrides').select('catalog_hotel_id', { count: 'exact', head: true }).eq('catalog_hotel_id', entry.source_id) : Promise.resolve({ count: 0, error: null }),
      ['day_plan','location'].includes(entry.catalog_type) ? admin.from('catalog_template_days').select('template_id,day_plan_id,overnight_location_id').limit(10000) : Promise.resolve({ data: [], error: null })
    ])
    if (links.error || overrides.error || templateDays.error) throw new HttpError(400, links.error?.message || overrides.error?.message || templateDays.error?.message || 'Could not verify references.')
    const templateReference = (templateDays.data || []).some(row => row.day_plan_id === entry.source_id || row.overnight_location_id === entry.source_id)
    if ((links.count || 0) + (overrides.count || 0) > 0 || quoteReference || templateReference) throw new HttpError(409, 'This item is referenced. Disable it instead of deleting it.')
    const table = optionTypes.has(entry.catalog_type as CatalogType) ? 'catalog_options' : sourceTables[entry.catalog_type as CatalogType]!
    const removed = await admin.from(table).delete().eq('id', entry.source_id)
    if (removed.error) throw new HttpError(409, 'This item is referenced. Disable it instead of deleting it.')
    unwrap(await admin.from('catalog_entries').delete().eq('id', entry.id).select('id').single())
    await platformAudit(ctx, 'catalog.item.delete', null, { entry_id: entry.id, catalog_type: entry.catalog_type, title: entry.title })
    return { ok: true }
  })

  app.get('/platform/catalog/submissions', async request => {
    owner(request)
    const input = request.query as { status?: string; type?: string; page?: string; q?: string }; const page = Math.max(1, Number(input.page) || 1); const pageSize = 25
    let builder = admin.from('catalog_submissions').select('*,companies(id,name)', { count: 'exact' }).order('created_at').range((page - 1) * pageSize, page * pageSize - 1)
    if (input.status) builder = builder.eq('status', input.status)
    if (input.type) builder = builder.eq('item_type', input.type)
    const result = await builder
    if (result.error) throw new HttpError(400, result.error.message)
    const needle = normalizeCatalogText(input.q)
    const items = (result.data || []).filter(row => matches(needle, row.snapshot?.name, (row.companies as any)?.name))
    return { items, total: needle ? items.length : result.count || 0, page, pageSize }
  })

  app.get('/platform/catalog/submissions/:id', async request => {
    owner(request)
    const submission = unwrap(await admin.from('catalog_submissions').select('*,companies(id,name),records(id,title,data)').eq('id', idParam(request.params)).single())
    const normalized = normalizeCatalogText(submission.snapshot?.name)
    const duplicates = unwrap(await admin.from('catalog_entries').select('id,title,catalog_type,active').eq('catalog_type', submission.item_type).ilike('normalized_key', `${normalized}%`).limit(10))
    return { ...submission, duplicate_suggestions: duplicates }
  })

  app.post('/platform/catalog/submissions/:id/resolve', async request => {
    const ctx = owner(request)
    const value = z.object({ resolution: z.enum(['approve','merge','reject']), target_entry_id: z.uuid().optional(), reason: z.string().trim().max(2000).optional(), data: z.record(z.string(), z.unknown()).default({}) }).parse(request.body)
    const submission = unwrap(await admin.from('catalog_submissions').select('*,companies(id,name),records(id,data)').eq('id', idParam(request.params)).eq('status', 'pending').single())
    if (value.resolution === 'reject') {
      if (!value.reason) throw new HttpError(400, 'Add a rejection reason for the company.')
      const rejected = unwrap(await admin.from('catalog_submissions').update({ status: 'rejected', reviewer_id: ctx.userId, reason: value.reason, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', submission.id).select('*').single())
      await platformAudit(ctx, 'catalog.submission.reject', submission.companies as any, { submission_id: submission.id, item_type: submission.item_type, reason: value.reason })
      return rejected
    }
    let entry: any
    if (value.resolution === 'merge') {
      if (!value.target_entry_id) throw new HttpError(400, 'Choose the catalog item to merge with.')
      entry = unwrap(await admin.from('catalog_entries').select('*').eq('id', value.target_entry_id).eq('catalog_type', submission.item_type).single())
    } else {
      const currentEntryId = (submission.records as any)?.data?.catalog_entry_id
      if (submission.operation === 'update' && currentEntryId) {
        const current = unwrap(await admin.from('catalog_entries').select('*').eq('id', currentEntryId).eq('catalog_type', submission.item_type).single())
        const fields = { ...submission.snapshot, ...value.data }; const proposedKey = `${normalizeCatalogText(fields.name)}${submission.item_type === 'hotel' ? `:${fields.location_id}` : ''}`
        const duplicate = await admin.from('catalog_entries').select('id').eq('catalog_type', submission.item_type).eq('normalized_key', proposedKey).neq('id', current.id).maybeSingle()
        if (duplicate.error) throw new HttpError(400, duplicate.error.message)
        if (duplicate.data) throw new HttpError(409, 'Merge with the matching catalog item instead of creating a duplicate.')
        const source = await updateSource(submission.item_type, current.source_id, fields)
        entry = unwrap(await admin.from('catalog_entries').update({ title: source.canonical_name || source.title || source.name, normalized_key: `${normalizeCatalogText(source.canonical_name || source.title || source.name)}${submission.item_type === 'hotel' ? `:${source.location_id}` : ''}`, updated_at: new Date().toISOString() }).eq('id', current.id).select('*').single())
      } else entry = await createCatalogItem(ctx, submission.item_type, { ...submission.snapshot, ...value.data }, 'all', 'company', submission.company_id)
    }
    const record = submission.records as any
    const linked = await admin.from('records').update({ data: { ...(record.data || {}), catalog_entry_id: entry.id }, updated_at: new Date().toISOString() }).eq('company_id', submission.company_id).eq('id', submission.source_record_id)
    if (linked.error) throw new HttpError(400, linked.error.message)
    const status = value.resolution === 'merge' ? 'merged' : 'approved'
    const resolved = unwrap(await admin.from('catalog_submissions').update({ status, target_entry_id: entry.id, reviewer_id: ctx.userId, reason: value.reason || null, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', submission.id).select('*').single())
    await admin.from('audit_events').insert({ company_id: submission.company_id, actor_id: ctx.userId, action: 'catalog.link', target_id: submission.source_record_id, details: { catalog_entry_id: entry.id, submission_id: submission.id } })
    await platformAudit(ctx, `catalog.submission.${status}`, submission.companies as any, { submission_id: submission.id, entry_id: entry.id, item_type: submission.item_type })
    return resolved
  })
}
