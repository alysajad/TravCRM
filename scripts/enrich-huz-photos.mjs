import { createClient } from '@supabase/supabase-js'

const companySlug = process.env.DEMO_COMPANY_SLUG || 'huzpoint'
const supabaseUrl = process.env.SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const licenseUrl = 'https://www.pexels.com/license/'

if (!supabaseUrl || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')

const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

const photos = [
  { type: 'day_plan', title: 'Srinagar arrival & Shikara welcome', id: 20283818, slug: 'dal-lake-arrival', credit: 'Aadil Mehraj', page: 'https://www.pexels.com/photo/dal-lake-in-india-20283818/' },
  { type: 'day_plan', title: 'Srinagar heritage & Mughal gardens', id: 33836435, slug: 'srinagar-mughal-garden', credit: 'capturesbyhatim', page: 'https://www.pexels.com/photo/mughal-garden-with-stunning-mountain-backdrop-33836435/' },
  { type: 'day_plan', title: 'Gulmarg Gondola & alpine day', id: 35672516, slug: 'gulmarg-snow', credit: 'Basit Manzoor', page: 'https://www.pexels.com/photo/snow-covered-landscape-in-gulmarg-kashmir-35672516/' },
  { type: 'day_plan', title: 'Pahalgam valleys excursion', id: 28805621, slug: 'pahalgam-valley', credit: 'Sheikh Muzamil', page: 'https://www.pexels.com/photo/scenic-himalayas-landscape-in-pahalgam-kashmir-28805621/' },
  { type: 'day_plan', title: 'Sonamarg glacier trail', id: 35027253, slug: 'sonamarg-river', credit: 'Rubaitul Azad', page: 'https://www.pexels.com/photo/majestic-sonamarg-river-in-lush-green-valley-35027253/' },
  { type: 'day_plan', title: 'Houseboat evening & local food walk', id: 28316197, slug: 'srinagar-houseboats', credit: 'Pexels contributor', page: 'https://www.pexels.com/photo/a-boat-is-floating-on-the-water-with-houses-on-it-28316197/' },
  { type: 'day_plan', title: 'Kashmir departure', id: 17328712, slug: 'dal-lake-aerial', credit: 'Pexels contributor', page: 'https://www.pexels.com/photo/aerial-view-of-houses-around-the-dal-lake-in-jammu-and-kashmir-india-17328712/' },
  { type: 'day_plan', title: 'Leh arrival & acclimatisation', id: 5014918, slug: 'leh-valley-sunset', credit: 'ArtHouse Studio', page: 'https://www.pexels.com/photo/landscape-of-leh-city-near-mountains-5014918/' },
  { type: 'day_plan', title: 'Leh monasteries & Indus valley', id: 6650457, slug: 'thiksey-monastery', credit: 'shalender kumar', page: 'https://www.pexels.com/photo/thikse-monastery-built-on-mountainside-6650457/' },
  { type: 'day_plan', title: 'Nubra via Khardung La', id: 13652207, slug: 'nubra-valley-camel', credit: 'Imad Clicks', page: 'https://www.pexels.com/photo/pasir-hewan-unta-india-13652207/' },
  { type: 'day_plan', title: 'Pangong Lake expedition', id: 32909865, slug: 'pangong-lake', credit: 'Simranpreet Singh', page: 'https://www.pexels.com/photo/dramatic-landscape-of-pangong-lake-ladakh-32909865/' },
  { type: 'day_plan', title: 'Leh market & departure', id: 13905847, slug: 'leh-city', credit: 'Bibhukalyan Acharya', page: 'https://www.pexels.com/photo/leh-valley-city-in-ladakh-india-13905847/' },
  { type: 'hotel', title: 'The Chinar Retreat', id: 28347470, slug: 'chinar-retreat-demo', credit: 'SVH Manali', page: 'https://www.pexels.com/photo/a-hotel-room-with-wooden-floors-and-a-large-bed-28347470/' },
  { type: 'hotel', title: 'Gulmarg Alpine Lodge', id: 16642423, slug: 'gulmarg-lodge-demo', credit: 'Cheng', page: 'https://www.pexels.com/photo/tourist-resort-in-the-mountains-16642423/' },
  { type: 'hotel', title: 'Pahalgam Riverside Resort', id: 34800402, slug: 'pahalgam-resort-demo', credit: 'betul nur akyurek', page: 'https://www.pexels.com/photo/scenic-riverside-cabin-surrounded-by-lush-forest-34800402/' },
  { type: 'hotel', title: 'Noor Palace Houseboat', id: 34582949, slug: 'noor-houseboat-demo', credit: 'Imad Clicks', page: 'https://www.pexels.com/photo/cozy-traditional-living-room-in-kashmir-houseboat-34582949/' },
  { type: 'hotel', title: 'Leh Horizon Hotel', id: 30722813, slug: 'leh-horizon-demo', credit: 'mohd hasan', page: 'https://www.pexels.com/photo/modern-hotel-room-with-scenic-view-30722813/' },
]

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

async function download(photo) {
  const url = `https://images.pexels.com/photos/${photo.id}/pexels-photo-${photo.id}.jpeg?auto=compress&cs=tinysrgb&w=3840`
  const response = await fetch(url, { headers: { 'User-Agent': 'TravCRM demo image installer' }, signal: AbortSignal.timeout(45_000) })
  if (!response.ok) throw new Error(`Download ${photo.id} failed with HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error(`Download ${photo.id} was not a JPEG`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`Download ${photo.id} exceeds the 10 MB storage limit`)
  return bytes
}

async function main() {
  const companies = unwrap(await db.from('companies').select('id,name').eq('slug', companySlug), 'find company')
  if (companies.length !== 1) throw new Error(`Expected exactly one company with slug ${companySlug}; found ${companies.length}.`)
  const company = companies[0]
  const records = unwrap(await db.from('records').select('id,type,title,data').eq('company_id', company.id).in('type', ['day_plan', 'hotel']), 'find visual records')
  const recordMap = new Map(records.map(record => [`${record.type}:${record.title}`, record]))
  const missing = photos.filter(photo => !recordMap.has(`${photo.type}:${photo.title}`))
  if (missing.length) throw new Error(`Missing demo records: ${missing.map(photo => photo.title).join(', ')}`)

  const cache = new Map()
  const installed = []
  for (const photo of photos) {
    console.log(`Installing ${installed.length + 1}/${photos.length}: ${photo.title}`)
    let bytes = cache.get(photo.id)
    if (!bytes) { bytes = await download(photo); cache.set(photo.id, bytes) }
    const path = `${company.id}/library/pexels/${photo.id}-${photo.slug}.jpg`
    unwrap(await db.storage.from('crm-private').upload(path, bytes, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true }), `upload ${photo.title}`)
    const record = recordMap.get(`${photo.type}:${photo.title}`)
    const data = {
      ...(record.data || {}),
      image_path: path,
      image_source_url: photo.page,
      image_credit: `${photo.credit} / Pexels`,
      image_license_url: licenseUrl,
      image_usage: photo.type === 'hotel' ? 'Demo property imagery; replace with the supplier\'s approved media before client use.' : 'Licensed destination imagery.',
    }
    unwrap(await db.from('records').update({ data }).eq('id', record.id).eq('company_id', company.id).select('id').single(), `update ${photo.title}`)
    installed.push({ title: photo.title, path, bytes: bytes.length })
  }

  const cover = installed.find(item => item.title === 'Srinagar arrival & Shikara welcome')
  unwrap(await db.from('company_settings').update({ document_cover_path: cover.path }).eq('company_id', company.id).select('company_id').single(), 'set document cover')
  console.log(JSON.stringify({ ok: true, company: company.name, installed: installed.length, bytes: installed.reduce((sum, item) => sum + item.bytes, 0), cover: cover.path }, null, 2))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
