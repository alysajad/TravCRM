import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const read = async name => JSON.parse(await readFile(new URL(`../catalog/${name}.json`, import.meta.url), 'utf8'))
const stableId = key => {
  const hex = createHash('sha256').update(`travcrm:${key}`).digest('hex').slice(0, 32).split('')
  hex[12] = '4'; hex[16] = ['8','9','a','b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`
}
const upsert = async (table, rows, key = 'catalog_key') => { const { error } = await db.from(table).upsert(rows, { onConflict: key }); if (error) throw error }
const [locations, templates, hotels] = await Promise.all([read('locations'), read('itinerary-templates'), read('hotels')])
const locationId = new Map(locations.map(x => [x.catalog_key, stableId(`location:${x.catalog_key}`)]))
await upsert('catalog_locations', locations.map(x => ({ ...x, id: locationId.get(x.catalog_key), updated_at: new Date().toISOString() })))
const dayPlans = templates.flatMap(template => template.days.map(day => ({ id: stableId(`day:${day.catalog_key}`), catalog_key: day.catalog_key, title: day.title, region: template.region, location_id: locationId.get(day.location_id), description: day.description, route_destination: day.route_destination, warning: day.warning || null, updated_at: new Date().toISOString() })))
await upsert('catalog_day_plans', dayPlans)
await upsert('catalog_itinerary_templates', templates.map(({ days, ...template }) => ({ ...template, id: stableId(`template:${template.catalog_key}`), updated_at: new Date().toISOString() })))
const templateDays = templates.flatMap(template => template.days.map(day => ({ template_id: stableId(`template:${template.catalog_key}`), day_number: day.day_number, day_plan_id: stableId(`day:${day.catalog_key}`), overnight_location_id: day.overnight_location_id ? locationId.get(day.overnight_location_id) : null })))
await upsert('catalog_template_days', templateDays, 'template_id,day_number')
await upsert('catalog_hotels', hotels.map(hotel => ({ ...hotel, id: stableId(`hotel:${hotel.catalog_key}`), location_id: locationId.get(hotel.location_id), updated_at: new Date().toISOString() })))
console.log(`Upserted ${locations.length} locations, ${dayPlans.length} day plans, ${templates.length} templates, and ${hotels.length} hotels.`)
