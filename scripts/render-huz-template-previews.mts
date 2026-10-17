import { createClient } from '@supabase/supabase-js'
import { mkdir, writeFile } from 'node:fs/promises'
import { quotePdf } from '../apps/api/src/pdf.js'

const companySlug = process.env.DEMO_COMPANY_SLUG || 'huzpoint'
const outputDirectory = process.env.PREVIEW_OUTPUT_DIR || '/tmp/travcrm-previews'
const supabaseUrl = process.env.SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.')

const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

function unwrap<T>(result: { data: T; error: { message: string } | null }, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

const companies = unwrap(await db.from('companies').select('id,name').eq('slug', companySlug), 'find company')
if (companies.length !== 1) throw new Error(`Expected one company with slug ${companySlug}; found ${companies.length}.`)
const company = companies[0]
const settings = unwrap(await db.from('company_settings').select('*').eq('company_id', company.id).single(), 'find company settings')
const quotes = unwrap(await db.from('quotes').select('*').eq('company_id', company.id).order('days', { ascending: false }).limit(1), 'find preview quotation')
if (!quotes.length) throw new Error('The Huz demo has no quotation to preview.')

await mkdir(outputDirectory, { recursive: true })
for (const template of ['journey', 'expedition', 'brochure'] as const) {
  const bytes = await quotePdf(quotes[0], { ...settings, document_template: template }, company.name)
  const path = `${outputDirectory}/huz-${template}.pdf`
  await writeFile(path, bytes)
  console.log(`${template}: ${path} (${bytes.length} bytes)`)
}
