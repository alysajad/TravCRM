import 'regenerator-runtime/runtime.js'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFile } from 'node:fs/promises'
import { admin } from './core.js'

type Json = Record<string, any>
const blue = rgb(74 / 255, 58 / 255, 82 / 255)
const muted = rgb(120 / 255, 109 / 255, 128 / 255)
const accent = rgb(192 / 255, 132 / 255, 252 / 255)
function color(value: unknown) {
  const text = String(value || '')
  if (!/^#[0-9a-f]{6}$/i.test(text)) return accent
  return rgb(parseInt(text.slice(1, 3), 16) / 255, parseInt(text.slice(3, 5), 16) / 255, parseInt(text.slice(5, 7), 16) / 255)
}
const raw = (value: unknown) => String(value ?? '').replace(/[\x00-\x08\x0B-\x1F]/g, '')
const money = (value: unknown) => `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

class Document {
  pdf!: PDFDocument
  page!: PDFPage
  font!: PDFFont
  bold!: PDFFont
  devanagari!: PDFFont
  brandColor = accent
  secondaryColor = color('#A5D8FF')
  y = 0
  async init() {
    this.pdf = await PDFDocument.create()
    this.pdf.registerFontkit(fontkit)
    const base = new URL('../assets/fonts/', import.meta.url)
    this.font = await this.pdf.embedFont(await readFile(new URL('NotoSans-Regular.ttf', base)))
    this.bold = await this.pdf.embedFont(await readFile(new URL('NotoSans-Bold.ttf', base)))
    this.devanagari = await this.pdf.embedFont(await readFile(new URL('NotoSansDevanagari-Regular.ttf', base)))
    this.newPage()
  }
  text(value: unknown, strong = false) {
    const source = raw(value)
    const font = /[\u0900-\u097F]/.test(source) ? this.devanagari : strong ? this.bold : this.font
    const characters = new Set(font.getCharacterSet())
    return { font, value: Array.from(source).map(char => characters.has(char.codePointAt(0)!) ? char : '?').join('') }
  }
  newPage() {
    this.page = this.pdf.addPage([595, 842]); this.y = 790
  }
  ensure(height = 22) { if (this.y - height < 65) this.newPage() }
  line(label: string, value = '', size = 10, strong = false) {
    this.ensure(size + 8)
    const left = this.text(label, strong)
    this.page.drawText(left.value, { x: 46, y: this.y, size, font: left.font, color: strong ? blue : muted })
    if (value) { const right = this.text(value); this.page.drawText(right.value.slice(0, 90), { x: 220, y: this.y, size, font: right.font, color: blue }) }
    this.y -= size + 8
  }
  heading(text: string) { this.y -= 10; this.ensure(30); this.line(text, '', 13, true); this.y -= 4 }
  paragraph(text: string) {
    const formatted = this.text(text)
    const words = formatted.value.split(/\s+/).filter(Boolean); let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (formatted.font.widthOfTextAtSize(next, 10) > 500 && line) { this.line(line); line = word } else line = next
    }
    if (line) this.line(line)
  }
  async header(company: string, title: string, number: string, settings: Json) {
    this.brandColor = color(settings.document_color)
    this.secondaryColor = color(settings.document_secondary_color)
    const template = settings.document_template || 'elegant'
    if (template === 'modern') {
      this.page.drawRectangle({ x: 0, y: 0, width: 13, height: 842, color: this.brandColor })
      this.page.drawRectangle({ x: 30, y: 812, width: 535, height: 2, color: this.secondaryColor })
    } else if (template === 'compact') {
      this.page.drawRectangle({ x: 0, y: 804, width: 595, height: 38, color: this.brandColor })
    } else {
      this.page.drawRectangle({ x: 0, y: 814, width: 595, height: 28, color: blue })
    }
    const nameText = this.text(company, true)
    this.page.drawText(nameText.value.slice(0, 38), { x: 46, y: template === 'compact' ? 766 : 767, size: template === 'compact' ? 17 : 21, font: nameText.font, color: blue })
    const titleText = this.text(title, true)
    this.page.drawText(titleText.value, { x: 46, y: 738, size: 14, font: titleText.font, color: this.brandColor })
    this.page.drawText(this.text(number).value, { x: 425, y: 742, size: 10, font: this.font, color: muted })
    if (settings.logo_path) {
      try {
        const { data } = await admin.storage.from('crm-private').download(settings.logo_path)
        if (data) {
          const bytes = new Uint8Array(await data.arrayBuffer())
          const image = /\.png$/i.test(settings.logo_path) ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes)
          const scaled = image.scale(Math.min(65 / image.width, 45 / image.height))
          this.page.drawImage(image, { x: 524 - scaled.width, y: 759, width: scaled.width, height: scaled.height })
        }
      } catch { /* text header remains available when a logo is missing */ }
    }
    this.y = 708
    if (settings.address) this.paragraph(String(settings.address))
    if (settings.phone || settings.email) this.line([settings.phone, settings.email].filter(Boolean).join('  |  '))
    if (settings.gstin) this.line(`GSTIN: ${settings.gstin}`)
    this.y -= 10
  }
  async signature(settings: Json) {
    if (!settings.signature_path) return
    this.ensure(90)
    try {
      const { data } = await admin.storage.from('crm-private').download(settings.signature_path)
      if (!data) return
      const bytes = new Uint8Array(await data.arrayBuffer())
      const image = /\.png$/i.test(settings.signature_path) ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes)
      const scaled = image.scale(Math.min(110 / image.width, 55 / image.height))
      this.page.drawImage(image, { x: 46, y: this.y - scaled.height, width: scaled.width, height: scaled.height })
      this.y -= scaled.height + 8
      this.line('Authorised signature', '', 8)
    } catch { /* a missing signature must not prevent a client document */ }
  }
  async bytes(settings: Json) {
    const pages = this.pdf.getPages()
    pages.forEach((page, index) => {
      page.drawLine({ start: { x: 46, y: 40 }, end: { x: 549, y: 40 }, thickness: 0.6, color: muted })
      const companyFooter = this.text(settings.company_footer || '')
      if (companyFooter.value) page.drawText(companyFooter.value.slice(0, 65), { x: 46, y: 25, size: 7, font: companyFooter.font, color: muted })
      const mark = this.text(`Made with TravCRM  ·  ${index + 1}/${pages.length}`)
      const width = mark.font.widthOfTextAtSize(mark.value, 7)
      page.drawText(mark.value, { x: 549 - width, y: 25, size: 7, font: mark.font, color: muted })
    })
    return this.pdf.save()
  }
}

export async function quotePdf(quote: Json, settings: Json, fallbackName: string): Promise<Uint8Array> {
  const d = new Document(); await d.init()
  const config = settings.document_config || {}
  const labels = config.labels || {}
  const label = (key: string, fallback: string) => String(labels[key] || fallback)
  const sections: string[] = Array.isArray(config.sections) ? config.sections : ['itinerary','accommodation','inclusions','exclusions','price','payment','terms']
  await d.header(settings.brand_name || fallbackName, label('document_title', 'Travel quotation'), `#${quote.id.slice(0, 8).toUpperCase()}`, settings)
  d.line('Prepared for', quote.client_name, 11, true)
  d.line('Destination', quote.destination)
  d.line('Travelers', `${quote.adults} adults, ${quote.children} children`)
  d.line('Duration', `${quote.days} days / ${quote.nights} nights`)
  if (quote.arrival_date) d.line('Arrival', quote.arrival_date)
  if (quote.pickup) d.line('Pickup', quote.pickup)
  if (quote.dropoff) d.line('Drop-off', quote.dropoff)
  if (quote.flights) d.line('Flights', quote.flights)
  for (const section of sections) {
    if (section === 'itinerary' && quote.itinerary?.length) {
      d.heading(label('itinerary', 'Day-by-day itinerary'))
      for (const day of quote.itinerary) { d.line(`Day ${day.day}`, day.name, 10, true); if (day.description) d.paragraph(day.description) }
    }
    if (section === 'accommodation' && quote.stays?.length) {
      d.heading(label('accommodation', 'Accommodation'))
      for (const stay of quote.stays) d.line(`Night ${stay.night}`, `${stay.name}${stay.room_type ? ` / ${stay.room_type}` : ''}`)
    }
    if (section === 'inclusions' && quote.inclusions) { d.heading(label('inclusions', 'Inclusions')); d.paragraph(quote.inclusions) }
    if (section === 'exclusions' && quote.exclusions) { d.heading(label('exclusions', 'Exclusions')); d.paragraph(quote.exclusions) }
    if (section === 'price') {
      d.heading(label('price', 'Price summary'))
      d.line('Package cost', money(quote.base_amount)); d.line('Child cost', money(quote.child_amount)); d.line('Discount', `- ${money(quote.discount_amount)}`); d.line(`GST (${quote.gst_percent}%)`, money(quote.gst_amount)); d.line('Total', money(quote.total_amount), 12, true)
    }
    if (section === 'payment' && settings.bank_details) { d.heading(label('payment', 'Payment details')); d.paragraph(settings.bank_details) }
    if (section === 'terms' && (settings.terms || settings.cancellation_policy)) {
      d.heading(label('terms', 'Terms & policies'))
      if (settings.terms) d.paragraph(settings.terms)
      if (settings.cancellation_policy) { d.line('Cancellation', '', 10, true); d.paragraph(settings.cancellation_policy) }
    }
  }
  await d.signature(settings)
  return d.bytes(settings)
}

export async function recordPdf(type: string, record: Json, settings: Json, companyName: string): Promise<Uint8Array> {
  const d = new Document(); await d.init()
  const title = type === 'invoice' ? 'Invoice' : type === 'stay_voucher' ? 'Stay voucher' : 'Cab voucher'
  await d.header(settings.brand_name || companyName, title, `#${record.id.slice(0, 8).toUpperCase()}`, settings)
  const data = record.data || {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'items' || key === 'items_parsed' || key === 'subtotal' || key === 'gst_amount' || key === 'total') continue
    if (value === null || value === undefined || value === '') continue
    d.line(key.replace(/_/g, ' ').replace(/^./, x => x.toUpperCase()), String(value))
  }
  if (type === 'invoice') {
    d.heading('Items')
    for (const item of data.items_parsed || []) d.line(`${item.description}  x${item.quantity}`, money(item.amount))
    d.heading('Totals')
    d.line('Subtotal', money(data.subtotal))
    d.line('GST', money(data.gst_amount))
    d.line('Grand total', money(data.total), 12, true)
  }
  if (settings.terms) { d.heading('Terms & policies'); d.paragraph(settings.terms) }
  await d.signature(settings)
  return d.bytes(settings)
}
