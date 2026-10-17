import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const configured = Boolean(url && key && import.meta.env.VITE_API_URL)
export const supabase = configured ? createClient(url!, key!) : null
const base = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:4000/api/v1'

export type Me = { userId: string; companyId: string | null; companyName: string | null; name: string; platform: boolean; permissions: string[]; availablePermissions: string[] }
export type Field = { key: string; label: string; kind?: 'text' | 'email' | 'tel' | 'date' | 'number' | 'textarea' | 'select' | 'relation'; required?: boolean; options?: string[]; relation?: string }
export type Module = { type: string; label: string; plural: string; titleField: string; fields: Field[] }
export type RecordItem = { id: string; title: string; type: string; status: string; data: Record<string, any>; created_at: string }
export type Quote = { id: string; quote_number: string; quote_revision: number; booking_id?: string; locked_at?: string; client_name: string; email?: string; phone?: string; status: string; destination: string; days: number; nights: number; adults: number; children: number; rooms: number; extra_beds: number; children_without_bed: number; booking_date?: string; assignee_id?: string; pricing_mode: 'total_package' | 'per_person'; price_lines: { category: string; label: string; quantity: number; unit_amount: number; amount?: number }[]; transport: Record<string, any>; arrival_date?: string; pickup?: string; dropoff?: string; flights?: string; inclusions?: string; exclusions?: string; base_amount: number; child_amount: number; discount_amount: number; gst_percent: number; gst_amount: number; total_amount: number; query_id?: string; itinerary: { day_plan_id: string; name: string; description: string }[]; stays: { hotel_id: string; name: string; room_type_id?: string; room_type?: string }[]; created_at: string }
export type Booking = { id: string; booking_number: string; source_quote_id: string; source_quote_revision: number; revision: number; status: 'confirmed' | 'in_progress' | 'completed' | 'cancelled'; client_name: string; email?: string; phone?: string; destination: string; arrival_date: string; departure_date: string; adults: number; children: number; rooms: number; total_amount: number; snapshot: Quote; confirmed_at: string; stays?: any[]; transport?: any[]; documents?: any[]; revisions?: any[]; payments?: any[] }
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

export function selectedCompany() { return localStorage.getItem('travcrm-company') || '' }
export function selectCompany(id: string, path = '/') { if (id) localStorage.setItem('travcrm-company', id); else localStorage.removeItem('travcrm-company'); window.location.assign(path) }

export async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    try { message = (await response.json()).error || message } catch { /* keep HTTP status */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error('Set the Supabase and API environment variables.')
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('Sign in to continue.')
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${data.session.access_token}`, ...(selectedCompany() ? { 'X-Company-Id': selectedCompany() } : {}), ...init.headers } })
  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    try { message = (await response.json()).error || message } catch { /* keep HTTP status */ }
    throw new Error(message)
  }
  const contentType = response.headers.get('Content-Type') || ''
  return contentType.includes('application/pdf') || contentType.includes('text/csv') ? await response.blob() as T : await response.json() as T
}

export function post<T>(path: string, body: unknown) { return api<T>(path, { method: 'POST', body: JSON.stringify(body) }) }
export function patch<T>(path: string, body: unknown) { return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }) }
export function put<T>(path: string, body: unknown) { return api<T>(path, { method: 'PUT', body: JSON.stringify(body) }) }
export function remove(path: string) { return api<{ ok: boolean }>(path, { method: 'DELETE' }) }

export async function download(path: string, filename: string) {
  const blob = await api<Blob>(path)
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename; anchor.click()
  URL.revokeObjectURL(href)
}

export async function upload(file: File) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const signed = await post<{ path: string; token: string }>('/files/upload-url', { filename: file.name, content_type: file.type })
  const { error } = await supabase.storage.from('crm-private').uploadToSignedUrl(signed.path, signed.token, file, { contentType: file.type })
  if (error) throw error
  return signed.path
}

export const money = (value: unknown) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0))
export const date = (value: unknown) => value ? new Date(String(value)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
