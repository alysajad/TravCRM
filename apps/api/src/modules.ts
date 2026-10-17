export type Field = {
  key: string
  label: string
  kind?: 'text' | 'email' | 'tel' | 'date' | 'number' | 'textarea' | 'select' | 'relation'
  required?: boolean
  options?: string[]
  relation?: string
}

export type Module = { type: string; label: string; plural: string; titleField: string; fields: Field[] }
const field = (key: string, label: string, kind: Field['kind'] = 'text', extra: Partial<Field> = {}): Field => ({ key, label, kind, ...extra })

export const modules: Record<string, Module> = {
  'lead-sources': { type: 'lead_source', label: 'Lead source', plural: 'Lead sources', titleField: 'name', fields: [field('name', 'Source name', 'text', { required: true })] },
  clients: { type: 'client', label: 'Client', plural: 'Clients', titleField: 'name', fields: [field('name', 'Client name', 'text', { required: true }), field('phone', 'Phone', 'tel'), field('email', 'Email', 'email'), field('address', 'Address', 'textarea')] },
  queries: { type: 'query', label: 'Query', plural: 'Queries', titleField: 'client_name', fields: [field('client_id', 'Client', 'relation', { relation: 'clients' }), field('client_name', 'Client name', 'text', { required: true }), field('phone', 'Phone', 'tel'), field('email', 'Email', 'email'), field('arrival_date', 'Expected arrival', 'date'), field('destination', 'Destination'), field('adults', 'Adults', 'number'), field('children', 'Children', 'number'), field('days', 'Days', 'number'), field('source_id', 'Lead source', 'relation', { relation: 'lead-sources' }), field('assignee_id', 'Assigned to', 'relation', { relation: 'users' }), field('notes', 'Admin notes', 'textarea')] },
  'follow-ups': { type: 'follow_up', label: 'Follow-up', plural: 'Follow-ups', titleField: 'subject', fields: [field('subject', 'Subject', 'text', { required: true }), field('client_id', 'Client', 'relation', { relation: 'clients' }), field('query_id', 'Query', 'relation', { relation: 'queries' }), field('quote_id', 'Quotation', 'relation', { relation: 'quotes' }), field('due_date', 'Due date', 'date', { required: true }), field('notes', 'Notes', 'textarea')] },
  'day-plans': { type: 'day_plan', label: 'Day plan', plural: 'Day plans', titleField: 'name', fields: [field('name', 'Plan name', 'text', { required: true }), field('description', 'Description', 'textarea'), field('image_path', 'Image path')] },
  'hotel-categories': { type: 'hotel_category', label: 'Hotel category', plural: 'Hotel categories', titleField: 'name', fields: [field('name', 'Category name', 'text', { required: true })] },
  'room-types': { type: 'room_type', label: 'Room type', plural: 'Room types', titleField: 'name', fields: [field('name', 'Room type', 'text', { required: true })] },
  hotels: { type: 'hotel', label: 'Hotel or houseboat', plural: 'Hotels & houseboats', titleField: 'name', fields: [field('name', 'Property name', 'text', { required: true }), field('category_id', 'Category', 'relation', { relation: 'hotel-categories' }), field('location', 'Location'), field('rating', 'Rating', 'number'), field('price', 'Price per night', 'number'), field('property_type', 'Property type', 'select', { options: ['Hotel', 'Houseboat'] }), field('image_path', 'Image path')] },
  cabs: { type: 'cab', label: 'Cab', plural: 'Cabs', titleField: 'name', fields: [field('name', 'Vehicle name', 'text', { required: true }), field('registration', 'Registration number'), field('type', 'Vehicle type'), field('seats', 'Seats', 'number'), field('price', 'Daily rate', 'number'), field('driver_name', 'Driver name'), field('driver_phone', 'Driver phone', 'tel')] },
  expenses: { type: 'expense', label: 'Expense', plural: 'Expenses', titleField: 'description', fields: [field('description', 'Description', 'text', { required: true }), field('amount', 'Amount', 'number', { required: true }), field('date', 'Date', 'date', { required: true }), field('payment_type', 'Payment type', 'select', { options: ['Cash', 'Bank transfer', 'Card', 'UPI', 'Other'] }), field('remark', 'Remark', 'textarea')] },
  invoices: { type: 'invoice', label: 'Invoice', plural: 'Invoices', titleField: 'client_name', fields: [field('client_name', 'Client or company', 'text', { required: true }), field('quote_id', 'Quotation', 'relation', { relation: 'quotes' }), field('gstin', 'GSTIN'), field('issue_date', 'Issue date', 'date', { required: true }), field('items', 'Items (one description | quantity | rate per line)', 'textarea', { required: true }), field('gst_percent', 'GST %', 'number')] },
  'stay-vouchers': { type: 'stay_voucher', label: 'Stay voucher', plural: 'Stay vouchers', titleField: 'guest_name', fields: [field('guest_name', 'Guest name', 'text', { required: true }), field('guest_phone', 'Guest phone', 'tel'), field('quote_id', 'Quotation', 'relation', { relation: 'quotes' }), field('hotel_id', 'Hotel', 'relation', { relation: 'hotels' }), field('check_in', 'Check-in', 'date'), field('check_out', 'Check-out', 'date'), field('meal_plan', 'Meal plan'), field('rooms', 'Rooms', 'number'), field('cost', 'Supplier cost', 'number'), field('inclusions', 'Inclusions', 'textarea')] },
  'hotel-payments': { type: 'hotel_payment', label: 'Hotel payment', plural: 'Hotel payments', titleField: 'reference', fields: [field('reference', 'Payment reference', 'text', { required: true }), field('hotel_id', 'Hotel', 'relation', { relation: 'hotels', required: true }), field('amount', 'Amount', 'number', { required: true }), field('date', 'Date', 'date', { required: true }), field('method', 'Method', 'select', { options: ['Bank transfer', 'Cash', 'Card', 'UPI', 'Other'] }), field('notes', 'Notes', 'textarea')] },
  'cab-vouchers': { type: 'cab_voucher', label: 'Cab voucher', plural: 'Cab vouchers', titleField: 'guest_name', fields: [field('guest_name', 'Guest name', 'text', { required: true }), field('guest_phone', 'Guest phone', 'tel'), field('quote_id', 'Quotation', 'relation', { relation: 'quotes' }), field('cab_id', 'Cab', 'relation', { relation: 'cabs' }), field('start_date', 'Start date', 'date'), field('end_date', 'End date', 'date'), field('pickup', 'Pickup'), field('dropoff', 'Drop-off'), field('cost', 'Cost', 'number'), field('driver_name', 'Driver name'), field('driver_phone', 'Driver phone', 'tel')] },
  leads: { type: 'lead', label: 'Lead', plural: 'Leads', titleField: 'name', fields: [field('name', 'Name', 'text', { required: true }), field('phone', 'Phone', 'tel'), field('email', 'Email', 'email'), field('page', 'Source page'), field('received_at', 'Received at', 'date'), field('notes', 'Notes', 'textarea')] },
  partners: { type: 'partner', label: 'Partner', plural: 'Partners', titleField: 'name', fields: [field('name', 'Partner name', 'text', { required: true }), field('phone', 'Phone', 'tel'), field('email', 'Email', 'email'), field('website', 'Website'), field('notes', 'Notes', 'textarea')] },
  'voucher-inclusions': { type: 'voucher_inclusion', label: 'Voucher inclusion', plural: 'Voucher inclusions', titleField: 'name', fields: [field('name', 'Inclusion', 'text', { required: true }), field('description', 'Description', 'textarea')] },
  'other-catalog': { type: 'other_catalog', label: 'Catalog item', plural: 'Other catalog', titleField: 'name', fields: [field('name', 'Name', 'text', { required: true }), field('description', 'Description', 'textarea')] }
}

export const statuses = {
  query: ['Pending', 'Contacted', 'Interested', 'Quoted', 'Confirmed', 'Completed', 'Cancelled'],
  quote: ['Draft', 'Pending', 'Quoted', 'Confirmed', 'Completed', 'Cancelled'],
  generic: ['Active', 'Inactive']
}

export function validateRecord(module: Module, body: unknown): { title: string; status: string; data: Record<string, unknown> } {
  if (!body || typeof body !== 'object') throw new Error('Enter the required fields.')
  const input = body as Record<string, unknown>
  const data: Record<string, unknown> = {}
  for (const f of module.fields) {
    const raw = input[f.key]
    if (f.required && (raw === undefined || raw === null || String(raw).trim() === '')) throw new Error(`${f.label} is required.`)
    if (raw === undefined || raw === null || raw === '') continue
    if (f.kind === 'number') {
      const number = Number(raw)
      if (!Number.isFinite(number) || number < 0) throw new Error(`${f.label} must be a non-negative number.`)
      data[f.key] = number
    } else {
      if (typeof raw !== 'string' || raw.length > 10000) throw new Error(`${f.label} is invalid.`)
      if (f.kind === 'email' && raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error(`${f.label} is invalid.`)
      if (f.kind === 'tel' && raw && raw.replace(/\D/g, '').length < 7) throw new Error(`${f.label} needs a complete phone number.`)
      if (f.kind === 'date' && raw) {
        const date = new Date(`${raw}T00:00:00Z`)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error(`${f.label} is invalid.`)
      }
      if (f.kind === 'select' && f.options && !f.options.includes(raw)) throw new Error(`${f.label} is invalid.`)
      data[f.key] = raw.trim()
    }
  }
  const title = String(data[module.titleField] ?? '').trim()
  if (!title) throw new Error('A title is required.')
  const status = typeof input.status === 'string' ? input.status : module.type === 'query' ? 'Pending' : 'Active'
  const allowed = module.type === 'query' ? statuses.query : statuses.generic
  if (!allowed.includes(status)) throw new Error('Status is invalid.')
  return { title, status, data }
}
