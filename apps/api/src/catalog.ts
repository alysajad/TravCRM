import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, HttpError, requirePermission, unwrap } from './core.js'

type CatalogQuery = { q?: string; region?: string; days?: string; theme?: string; season?: string; location_id?: string; property_type?: string; limit?: string }
type Lookup = { id: string; source: 'catalog' | 'company'; title: string; subtitle: string; group?: string; data: Record<string, unknown> }

export const normalizeCatalogText = (value: unknown) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
export const seasonForMonth = (month: number) => month >= 12 || month <= 2 ? 'winter' : month <= 4 ? 'spring' : month <= 8 ? 'summer' : 'autumn'
const query = (value: unknown) => value as CatalogQuery
const cleanLimit = (value?: string) => Math.min(50, Math.max(1, Number(value) || 50))
const matches = (needle: string, ...values: unknown[]) => !needle || values.some(value => normalizeCatalogText(value).includes(needle))

export async function registerCatalog(app: FastifyInstance): Promise<void> {
  app.get('/catalog/locations', async request => {
    requirePermission(request, 'quotes.read')
    const { q = '', region } = query(request.query); const needle = normalizeCatalogText(q)
    let builder = admin.from('catalog_locations').select('*').order('region').order('name')
    if (region) builder = builder.eq('region', region)
    const rows = unwrap(await builder.limit(200))
    return rows.filter(row => matches(needle, row.name, ...(row.aliases || []), row.locality)).slice(0, 50).map(row => ({ id: row.id, source: 'catalog', title: row.name, subtitle: [row.locality, row.region].filter(Boolean).join(' · '), data: row }))
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
    const [catalogResult, companyResult] = await Promise.all([shared.limit(q.trim() ? 50 : 200), company])
    if (catalogResult.error || companyResult.error) throw new HttpError(400, catalogResult.error?.message || companyResult.error?.message || 'Could not search day plans.')
    const catalog: Lookup[] = (catalogResult.data || []).filter(row => matches(needle, row.title, row.description)).slice(0, 50).map(row => ({ id: row.id, source: 'catalog', title: row.title, subtitle: `${row.region} · ${(row.catalog_locations as any)?.name || 'Touring day'}`, group: 'Kashmir/Ladakh catalog', data: row }))
    const own: Lookup[] = (companyResult.data || []).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: 'My day plans', group: 'My day plans', data: row.data || {} }))
    return [...catalog.slice(0, Math.max(0, 50 - own.length)), ...own].slice(0, 50)
  })

  app.get('/catalog/templates', async request => {
    requirePermission(request, 'quotes.read')
    const { days, region, theme, season } = query(request.query)
    let builder = admin.from('catalog_itinerary_templates').select('*').order('title')
    if (days) builder = builder.eq('duration', Number(days))
    if (region) builder = builder.eq('region', region)
    if (theme) builder = builder.eq('theme', theme)
    const templates = unwrap(await builder.limit(50))
    if (!templates.length) return []
    const templateIds = templates.map(row => row.id)
    const dayRows = unwrap(await admin.from('catalog_template_days').select('template_id,day_number,overnight_location_id,catalog_day_plans(*),catalog_locations(name)').in('template_id', templateIds).order('day_number'))
    return templates.map(template => {
      const templateDays = dayRows.filter(row => row.template_id === template.id).map(row => {
        const plan = row.catalog_day_plans as any
        return { day_number: row.day_number, day_plan_id: plan.id, name: plan.title, description: plan.description, location_id: plan.location_id, route_destination: plan.route_destination, overnight_location_id: row.overnight_location_id, overnight_location: (row.catalog_locations as any)?.name || null, warning: plan.warning }
      })
      return { id: template.id, source: 'catalog', title: template.title, subtitle: `${template.duration} days · ${template.theme} · ${template.route_label}`, data: { ...template, days: templateDays }, season_match: season ? template.season_tags.includes(season) : false }
    }).sort((a, b) => Number(b.season_match) - Number(a.season_match))
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
    const [sharedResult, overrideResult, ownResult] = await Promise.all([
      shared.limit(550),
      ctx.db.from('company_hotel_overrides').select('*').eq('company_id', ctx.companyId),
      own
    ])
    if (sharedResult.error || overrideResult.error || ownResult.error) throw new HttpError(400, sharedResult.error?.message || overrideResult.error?.message || ownResult.error?.message || 'Could not search hotels.')
    const overrides = new Map((overrideResult.data || []).map(row => [row.catalog_hotel_id, row]))
    const catalog: Lookup[] = (sharedResult.data || []).filter(row => {
      const override = overrides.get(row.id)
      return !override?.hidden && matches(needle, row.canonical_name, ...(row.aliases || []), row.locality, (row.catalog_locations as any)?.name)
    }).map(row => {
      const override = overrides.get(row.id)
      return { id: row.id, source: 'catalog' as const, title: row.canonical_name, subtitle: [row.property_type, row.locality || (row.catalog_locations as any)?.name, override?.category].filter(Boolean).join(' · '), group: override?.preferred ? 'Preferred' : 'Kashmir/Ladakh catalog', data: { ...row, override: override || null } }
    }).sort((a, b) => Number(b.group === 'Preferred') - Number(a.group === 'Preferred') || a.title.localeCompare(b.title))
    const mine: Lookup[] = (ownResult.data || []).filter(row => !locationId || normalizeCatalogText(row.data?.location) === normalizeCatalogText((sharedResult.data || []).find(x => x.location_id === locationId)?.catalog_locations?.name)).map(row => ({ id: row.id, source: 'company', title: row.title, subtitle: [row.data?.property_type || 'Hotel', row.data?.location].filter(Boolean).join(' · '), group: 'My properties', data: row.data || {} }))
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
}
