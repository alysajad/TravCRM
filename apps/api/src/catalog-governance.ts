import { admin, HttpError, type Context } from './core.js'

export const catalogTypes = ['hotel','location','day_plan','itinerary_template','room_type','property_type','hotel_category','voucher_inclusion'] as const
export type CatalogType = typeof catalogTypes[number]

export const recordCatalogTypes = new Set<CatalogType>(catalogTypes)

export const normalizeCatalogText = (value: unknown) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

const durableFields: Record<CatalogType, string[]> = {
  hotel: ['name','location','location_id','property_type'],
  location: ['name','region','locality','aliases'],
  day_plan: ['name','description','location','location_id','region','route_destination','warning'],
  itinerary_template: ['name','region','duration','theme','season_tags','gateway','route_label','warnings','days'],
  room_type: ['name','description'],
  property_type: ['name','description'],
  hotel_category: ['name','description'],
  voucher_inclusion: ['name','description']
}

export function contributionSnapshot(record: { type: string; title: string; data?: Record<string, unknown> }): Record<string, unknown> {
  const type = record.type as CatalogType
  const snapshot: Record<string, unknown> = { name: record.title }
  for (const key of durableFields[type] || []) if (record.data?.[key] !== undefined) snapshot[key] = record.data[key]
  if (type === 'itinerary_template' && typeof snapshot.days === 'string') {
    try { snapshot.days = JSON.parse(snapshot.days) } catch { /* owner can repair the mapping during review */ }
  }
  // Commercial terms and tenant media deliberately never enter this object.
  return snapshot
}

export async function submitContribution(ctx: Context & { companyId: string }, record: { id: string; type: string; title: string; data?: Record<string, unknown> }, operation: 'create' | 'update'): Promise<void> {
  if (!recordCatalogTypes.has(record.type as CatalogType)) return
  const snapshot = contributionSnapshot(record)
  const { data: pending, error } = await admin.from('catalog_submissions').select('id').eq('source_record_id', record.id).eq('status', 'pending').maybeSingle()
  if (error) throw new HttpError(400, error.message)
  const values = { company_id: ctx.companyId, source_record_id: record.id, item_type: record.type, operation, snapshot, updated_at: new Date().toISOString() }
  const result = pending
    ? await admin.from('catalog_submissions').update(values).eq('id', pending.id)
    : await admin.from('catalog_submissions').insert(values)
  if (result.error) throw new HttpError(400, result.error.message)
}

export async function accessibleCatalogEntries(companyId: string, types?: CatalogType[], ids?: string[]): Promise<any[]> {
  let builder = admin.from('catalog_entries').select('*').eq('active', true)
  if (types?.length) builder = builder.in('catalog_type', types)
  if (ids?.length) builder = builder.in('source_id', ids)
  const [entriesResult, accessResult] = await Promise.all([
    builder.limit(5000),
    admin.from('catalog_company_access').select('catalog_entry_id,included').eq('company_id', companyId)
  ])
  if (entriesResult.error || accessResult.error) throw new HttpError(400, entriesResult.error?.message || accessResult.error?.message || 'Could not load catalog access.')
  const access = new Map((accessResult.data || []).map(row => [row.catalog_entry_id, row.included]))
  return (entriesResult.data || []).filter(entry => entry.availability_mode === 'all' ? access.get(entry.id) !== false : access.get(entry.id) === true)
}

export async function accessibleCatalogSourceIds(companyId: string, types: CatalogType[], ids?: string[]): Promise<Set<string>> {
  return new Set((await accessibleCatalogEntries(companyId, types, ids)).map(entry => entry.source_id))
}
