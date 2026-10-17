import 'regenerator-runtime/runtime.js'
import { PDFDocument, StandardFonts, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFile } from 'node:fs/promises'
import { admin } from './core.js'

type Json = Record<string, any>
type Template = 'elegant' | 'modern' | 'compact' | 'journey' | 'expedition' | 'brochure'
const pageWidth = 595
const pageHeight = 842
const ink = rgb(74 / 255, 58 / 255, 82 / 255)
const muted = rgb(120 / 255, 109 / 255, 128 / 255)
const paper = rgb(253 / 255, 250 / 255, 253 / 255)
const accent = rgb(192 / 255, 132 / 255, 252 / 255)

function color(value: unknown, fallback = accent) {
  const text = String(value || '')
  if (!/^#[0-9a-f]{6}$/i.test(text)) return fallback
  return rgb(parseInt(text.slice(1, 3), 16) / 255, parseInt(text.slice(3, 5), 16) / 255, parseInt(text.slice(5, 7), 16) / 255)
}

const raw = (value: unknown) => String(value ?? '').replace(/[\x00-\x08\x0B-\x1F]/g, '')
const money = (value: unknown) => `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

class Document {
  pdf!: PDFDocument
  page!: PDFPage
  font!: PDFFont
  bold!: PDFFont
  display!: PDFFont
  devanagari!: PDFFont
  brandColor = accent
  secondaryColor = color('#A5D8FF')
  y = 0
  imageCache = new Map<string, PDFImage | null>()

  async init(settings: Json) {
    this.pdf = await PDFDocument.create()
    this.pdf.registerFontkit(fontkit)
    const base = new URL('../assets/fonts/', import.meta.url)
    this.font = await this.pdf.embedFont(await readFile(new URL('NotoSans-Regular.ttf', base)))
    this.bold = await this.pdf.embedFont(await readFile(new URL('NotoSans-Bold.ttf', base)))
    this.devanagari = await this.pdf.embedFont(await readFile(new URL('NotoSansDevanagari-Regular.ttf', base)))
    this.display = await this.pdf.embedFont(StandardFonts.TimesRomanItalic)
    this.brandColor = color(settings.document_color)
    this.secondaryColor = color(settings.document_secondary_color, color('#A5D8FF'))
    this.newPage()
  }

  text(value: unknown, strong = false, display = false) {
    const source = raw(value)
    const font = /[\u0900-\u097F]/.test(source) ? this.devanagari : display ? this.display : strong ? this.bold : this.font
    const characters = new Set(font.getCharacterSet())
    return { font, value: Array.from(source).map(char => characters.has(char.codePointAt(0)!) ? char : '?').join('') }
  }

  newPage(background = rgb(1, 1, 1)) {
    this.page = this.pdf.addPage([pageWidth, pageHeight])
    this.page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: background })
    this.y = 790
  }

  ensure(height = 22) { if (this.y - height < 65) this.newPage() }

  line(label: string, value = '', size = 10, strong = false) {
    this.ensure(size + 8)
    const left = this.text(label, strong)
    this.page.drawText(left.value, { x: 46, y: this.y, size, font: left.font, color: strong ? ink : muted })
    if (value) {
      const right = this.text(value)
      this.page.drawText(right.value.slice(0, 90), { x: 220, y: this.y, size, font: right.font, color: ink })
    }
    this.y -= size + 8
  }

  heading(text: string) { this.y -= 10; this.ensure(30); this.line(text, '', 13, true); this.y -= 4 }

  wrap(text: unknown, x: number, y: number, width: number, options: { size?: number; lineHeight?: number; strong?: boolean; display?: boolean; tone?: ReturnType<typeof rgb>; maxLines?: number } = {}) {
    const size = options.size || 10
    const lineHeight = options.lineHeight || size + 4
    const formatted = this.text(text, options.strong, options.display)
    const paragraphs = formatted.value.split(/\n+/)
    let cursor = y
    let lines = 0
    const maxLines = options.maxLines || 1000
    for (const paragraph of paragraphs) {
      let line = ''
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word
        if (formatted.font.widthOfTextAtSize(next, size) > width && line) {
          this.page.drawText(line, { x, y: cursor, size, font: formatted.font, color: options.tone || ink })
          cursor -= lineHeight; lines += 1; line = word
          if (lines >= maxLines) return cursor
        } else line = next
      }
      if (line && lines < maxLines) {
        this.page.drawText(line, { x, y: cursor, size, font: formatted.font, color: options.tone || ink })
        cursor -= lineHeight; lines += 1
      }
    }
    return cursor
  }

  paragraph(text: string) {
    const next = this.wrap(text, 46, this.y, 500, { size: 10, lineHeight: 18, tone: muted })
    this.y = next
  }

  async image(path: unknown): Promise<PDFImage | null> {
    const key = String(path || '')
    if (!key) return null
    if (this.imageCache.has(key)) return this.imageCache.get(key) || null
    try {
      const { data, error } = await admin.storage.from('crm-private').download(key)
      if (error || !data) throw error || new Error('Image not found')
      const bytes = new Uint8Array(await data.arrayBuffer())
      const embedded = /\.png$/i.test(key) ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes)
      this.imageCache.set(key, embedded)
      return embedded
    } catch {
      this.imageCache.set(key, null)
      return null
    }
  }

  async picture(path: unknown, x: number, y: number, width: number, height: number) {
    const image = await this.image(path)
    if (!image) {
      this.page.drawRectangle({ x, y, width, height, color: this.secondaryColor, opacity: .28 })
      this.page.drawCircle({ x: x + width * .72, y: y + height * .65, size: Math.min(width, height) * .16, color: this.brandColor, opacity: .28 })
      this.page.drawSvgPath(`M 0 0 L ${width * .35} ${height * .55} L ${width * .52} ${height * .28} L ${width} ${height * .7} L ${width} 0 Z`, { x, y, color: ink, opacity: .18 })
      return
    }
    const scale = Math.max(width / image.width, height / image.height)
    const renderedWidth = image.width * scale
    const renderedHeight = image.height * scale
    this.page.pushOperators(pushGraphicsState(), rectangle(x, y, width, height), clip(), endPath())
    this.page.drawImage(image, {
      x: x + (width - renderedWidth) / 2,
      y: y + (height - renderedHeight) / 2,
      width: renderedWidth,
      height: renderedHeight,
    })
    this.page.pushOperators(popGraphicsState())
  }

  async logo(settings: Json, x: number, y: number, width = 72, height = 45) {
    const image = await this.image(settings.logo_path)
    if (!image) return
    const ratio = Math.min(width / image.width, height / image.height)
    const w = image.width * ratio; const h = image.height * ratio
    this.page.drawImage(image, { x: x + width - w, y: y + (height - h) / 2, width: w, height: h })
  }

  async header(company: string, title: string, number: string, settings: Json) {
    const template: Template = settings.document_template || 'elegant'
    if (template === 'modern') {
      this.page.drawRectangle({ x: 0, y: 0, width: 13, height: pageHeight, color: this.brandColor })
      this.page.drawRectangle({ x: 30, y: 812, width: 535, height: 2, color: this.secondaryColor })
    } else if (template === 'compact') this.page.drawRectangle({ x: 0, y: 804, width: pageWidth, height: 38, color: this.brandColor })
    else this.page.drawRectangle({ x: 0, y: 814, width: pageWidth, height: 28, color: ink })
    const nameText = this.text(company, true)
    this.page.drawText(nameText.value.slice(0, 38), { x: 46, y: template === 'compact' ? 766 : 767, size: template === 'compact' ? 17 : 21, font: nameText.font, color: ink })
    const titleText = this.text(title, true)
    this.page.drawText(titleText.value, { x: 46, y: 738, size: 14, font: titleText.font, color: this.brandColor })
    this.page.drawText(this.text(number).value, { x: 425, y: 742, size: 10, font: this.font, color: muted })
    await this.logo(settings, 454, 754, 70, 48)
    this.y = 708
    if (settings.address) this.paragraph(String(settings.address))
    if (settings.phone || settings.email) this.line([settings.phone, settings.email].filter(Boolean).join('  |  '))
    if (settings.gstin) this.line(`GSTIN: ${settings.gstin}`)
    this.y -= 10
  }

  async miniHeader(settings: Json, label: string) {
    this.page.drawRectangle({ x: 0, y: 795, width: pageWidth, height: 47, color: paper })
    this.page.drawRectangle({ x: 0, y: 795, width: 11, height: 47, color: this.brandColor })
    const name = this.text(settings.brand_name || 'Travel company', true)
    this.page.drawText(name.value.slice(0, 35), { x: 38, y: 813, size: 11, font: name.font, color: ink })
    const title = this.text(label, true)
    const titleWidth = title.font.widthOfTextAtSize(title.value, 9)
    this.page.drawText(title.value, { x: 510 - titleWidth, y: 814, size: 9, font: title.font, color: this.brandColor })
    await this.logo(settings, 518, 799, 50, 35)
    this.y = 755
  }

  async signature(settings: Json) {
    if (!settings.signature_path) return
    this.ensure(90)
    const image = await this.image(settings.signature_path)
    if (!image) return
    const ratio = Math.min(110 / image.width, 55 / image.height)
    this.page.drawImage(image, { x: 46, y: this.y - image.height * ratio, width: image.width * ratio, height: image.height * ratio })
    this.y -= image.height * ratio + 8
    this.line('Authorised signature', '', 8)
  }

  async bytes(settings: Json) {
    const pages = this.pdf.getPages()
    pages.forEach((page, index) => {
      page.drawLine({ start: { x: 46, y: 40 }, end: { x: 549, y: 40 }, thickness: .6, color: muted, opacity: .55 })
      const companyFooter = this.text(settings.company_footer || '')
      if (companyFooter.value) page.drawText(companyFooter.value.slice(0, 72), { x: 46, y: 25, size: 7, font: companyFooter.font, color: muted })
      const mark = this.text(`Made with TravCRM  ·  ${index + 1}/${pages.length}`)
      const width = mark.font.widthOfTextAtSize(mark.value, 7)
      page.drawText(mark.value, { x: 549 - width, y: 25, size: 7, font: mark.font, color: muted })
    })
    return this.pdf.save()
  }
}

async function enrichQuote(quote: Json) {
  if (!quote.company_id) return quote
  const ids = [...new Set([...(quote.itinerary || []).map((day: Json) => day.day_plan_id), ...(quote.stays || []).map((stay: Json) => stay.hotel_id)].filter(Boolean))]
  if (!ids.length) return quote
  try {
    const { data } = await admin.from('records').select('id,data').eq('company_id', quote.company_id).in('id', ids)
    const map = new Map((data || []).map(row => [row.id, row.data || {}]))
    return {
      ...quote,
      itinerary: (quote.itinerary || []).map((day: Json) => ({ ...day, image_path: day.image_path || map.get(day.day_plan_id)?.image_path || null })),
      stays: (quote.stays || []).map((stay: Json) => ({ ...stay, image_path: stay.image_path || map.get(stay.hotel_id)?.image_path || null })),
    }
  } catch { return quote }
}

const labelsFor = (settings: Json) => {
  const labels = settings.document_config?.labels || {}
  return (key: string, fallback: string) => String(labels[key] || fallback)
}

const sectionsFor = (settings: Json): string[] => Array.isArray(settings.document_config?.sections)
  ? settings.document_config.sections
  : ['itinerary','accommodation','inclusions','exclusions','price','payment','terms']

const coverFor = (quote: Json, settings: Json) => quote.cover_image_path
  || quote.itinerary?.find((day: Json) => day.image_path)?.image_path
  || settings.document_cover_path
  || quote.stays?.find((stay: Json) => stay.image_path)?.image_path

async function detailPages(d: Document, quote: Json, settings: Json, title = 'Trip details') {
  const label = labelsFor(settings)
  const sections = sectionsFor(settings).filter(section => section !== 'itinerary')
  d.newPage(); await d.miniHeader(settings, title)
  for (const section of sections) {
    if (section === 'accommodation' && quote.stays?.length) {
      d.heading(label('accommodation', 'Accommodation'))
      for (const stay of quote.stays) d.line(`Night ${stay.night}`, `${stay.name}${stay.room_type ? ` / ${stay.room_type}` : ''}`)
    }
    if (section === 'inclusions' && quote.inclusions) { d.heading(label('inclusions', 'Inclusions')); d.paragraph(quote.inclusions) }
    if (section === 'exclusions' && quote.exclusions) { d.heading(label('exclusions', 'Exclusions')); d.paragraph(quote.exclusions) }
    if (section === 'price') {
      d.heading(label('price', 'Price summary'))
      if (quote.price_lines?.length) for (const line of quote.price_lines) d.line(`${line.label}${Number(line.quantity) !== 1 ? ` × ${line.quantity}` : ''}`, money(line.amount ?? Number(line.quantity) * Number(line.unit_amount)))
      else { d.line('Package cost', money(quote.base_amount)); d.line('Child cost', money(quote.child_amount)) }
      d.line('Discount', `- ${money(quote.discount_amount)}`); d.line(`GST (${quote.gst_percent}%)`, money(quote.gst_amount)); d.line('Total', money(quote.total_amount), 12, true)
    }
    if (section === 'payment' && settings.bank_details) { d.heading(label('payment', 'Payment details')); d.paragraph(settings.bank_details) }
    if (section === 'terms' && (settings.terms || settings.cancellation_policy)) {
      d.heading(label('terms', 'Terms & policies'))
      if (settings.terms) d.paragraph(settings.terms)
      if (settings.cancellation_policy) { d.line('Cancellation', '', 10, true); d.paragraph(settings.cancellation_policy) }
    }
  }
  await d.signature(settings)
}

async function journeyPdf(d: Document, quote: Json, settings: Json) {
  const label = labelsFor(settings)
  d.page.drawCircle({ x: 80, y: 785, size: 5, color: d.brandColor })
  d.page.drawLine({ start: { x: 85, y: 783 }, end: { x: 178, y: 805 }, thickness: 2, color: d.brandColor, dashArray: [6, 6] })
  d.page.drawLine({ start: { x: 178, y: 805 }, end: { x: 211, y: 770 }, thickness: 2, color: d.brandColor, dashArray: [6, 6] })
  await d.logo(settings, 475, 770, 78, 50)
  const travel = d.text('Travel', false, true)
  d.page.drawText(travel.value, { x: 206, y: 736, size: 39, font: travel.font, color: ink })
  const itinerary = d.text(label('document_title', 'ITINERARY'), true)
  d.page.drawText(itinerary.value.toUpperCase().slice(0, 25), { x: 112, y: 684, size: 37, font: itinerary.font, color: ink })
  d.page.drawLine({ start: { x: 52, y: 644 }, end: { x: 543, y: 644 }, thickness: 1, color: muted, opacity: .45 })
  const facts = [
    ['Destination', quote.destination], ['Duration', `${quote.days} days / ${quote.nights} nights`],
    ['Arrival', quote.arrival_date || 'To be confirmed'], ['Departure', quote.dropoff || 'To be confirmed'],
  ]
  facts.forEach(([key, value], index) => {
    const x = index % 2 ? 310 : 52; const y = index < 2 ? 614 : 577
    d.wrap(`${key}:`, x, y, 85, { size: 9, strong: true })
    d.wrap(value, x + 78, y, 175, { size: 9, maxLines: 2, tone: muted })
  })
  let top = 525
  for (const day of quote.itinerary || []) {
    if (top < 185) { d.newPage(paper); await d.miniHeader(settings, label('itinerary', 'Day-by-day itinerary')); top = 735 }
    await d.picture(day.image_path, 52, top - 112, 135, 108)
    d.page.drawLine({ start: { x: 211, y: top - 7 }, end: { x: 211, y: top - 109 }, thickness: 1.2, color: d.brandColor, opacity: .72 })
    d.page.drawCircle({ x: 211, y: top - 22, size: 5, color: d.brandColor })
    d.wrap(`DAY ${day.day}`, 230, top, 310, { size: 8, strong: true, tone: d.brandColor })
    const titleY = d.wrap(day.name, 230, top - 20, 310, { size: 14, strong: true, lineHeight: 17, maxLines: 2 })
    d.wrap(day.description, 230, titleY - 4, 310, { size: 8.5, lineHeight: 12.5, maxLines: 6, tone: muted })
    top -= 145
  }
  await detailPages(d, quote, settings, 'Journey summary')
}

async function expeditionPdf(d: Document, quote: Json, settings: Json) {
  const label = labelsFor(settings)
  const cover = coverFor(quote, settings)
  await d.picture(cover, 0, 430, pageWidth, 412)
  d.page.drawRectangle({ x: 0, y: 430, width: pageWidth, height: 412, color: ink, opacity: .30 })
  d.wrap(quote.destination, 52, 708, 490, { size: 34, lineHeight: 40, display: true, tone: rgb(1, 1, 1), maxLines: 2 })
  d.wrap(label('document_title', 'EXPEDITION ITINERARY').toUpperCase(), 54, 620, 470, { size: 12, strong: true, tone: rgb(1, 1, 1) })
  d.page.drawRectangle({ x: 52, y: 525, width: 225, height: 44, color: rgb(1, 1, 1), opacity: .94 })
  d.page.drawRectangle({ x: 295, y: 525, width: 248, height: 44, color: rgb(1, 1, 1), opacity: .94 })
  d.wrap(`ARRIVAL  ${quote.arrival_date || 'TO BE CONFIRMED'}`, 68, 542, 190, { size: 8.5, strong: true })
  d.wrap(`${quote.days} DAYS / ${quote.nights} NIGHTS`, 311, 542, 215, { size: 8.5, strong: true })
  d.page.drawSvgPath('M 0 0 L 595 0 L 595 45 L 535 31 L 472 49 L 410 28 L 344 47 L 275 26 L 203 50 L 130 29 L 64 47 L 0 30 Z', { x: 0, y: 408, color: rgb(1, 1, 1) })
  await d.logo(settings, 465, 350, 80, 52)
  d.wrap(settings.brand_name || 'Travel company', 52, 365, 370, { size: 11, strong: true, tone: d.brandColor })
  d.wrap(`Prepared for ${quote.client_name}`, 52, 327, 480, { size: 18, strong: true })
  d.wrap(`${quote.adults} adults · ${quote.children} children · Pickup ${quote.pickup || 'to be confirmed'}`, 52, 298, 480, { size: 9.5, tone: muted })
  d.wrap('A considered journey with handpicked stays, private transfers, and a day-by-day plan prepared by your travel company.', 52, 248, 450, { size: 11, lineHeight: 17, tone: muted, maxLines: 4 })
  for (const day of quote.itinerary || []) {
    d.newPage(paper); await d.miniHeader(settings, label('itinerary', 'Expedition itinerary'))
    await d.picture(day.image_path || cover, 0, 452, pageWidth, 315)
    d.page.drawRectangle({ x: 38, y: 417, width: 112, height: 54, color: d.brandColor })
    d.wrap(`DAY ${day.day}`, 55, 440, 80, { size: 13, strong: true, tone: rgb(1, 1, 1) })
    d.wrap(day.name, 52, 379, 490, { size: 23, lineHeight: 28, strong: true, maxLines: 2 })
    d.page.drawLine({ start: { x: 52, y: 319 }, end: { x: 116, y: 319 }, thickness: 4, color: d.brandColor })
    d.wrap(day.description, 52, 290, 490, { size: 11, lineHeight: 18, tone: muted, maxLines: 11 })
  }
  await detailPages(d, quote, settings, 'Expedition details')
}

async function brochurePdf(d: Document, quote: Json, settings: Json) {
  const label = labelsFor(settings)
  const cover = coverFor(quote, settings)
  d.page.drawRectangle({ x: 0, y: 796, width: pageWidth, height: 46, color: d.brandColor })
  d.page.drawSvgPath('M 0 0 L 145 0 L 74 150 L 0 104 Z', { x: 0, y: 642, color: d.brandColor, opacity: .36 })
  await d.logo(settings, 35, 735, 105, 52)
  d.wrap(settings.brand_name || 'Travel company', 36, 716, 180, { size: 9, strong: true, tone: ink })
  d.wrap(label('document_title', 'MAGICAL JOURNEY'), 238, 748, 310, { size: 25, strong: true, tone: d.brandColor, maxLines: 2 })
  await d.picture(cover, 190, 590, 405, 135)
  d.wrap('TOUR', 52, 555, 55, { size: 8, strong: true, tone: d.brandColor })
  d.wrap(quote.destination, 100, 555, 225, { size: 9, strong: true })
  d.wrap('DURATION', 370, 555, 75, { size: 8, strong: true, tone: d.brandColor })
  d.wrap(`${quote.nights} nights / ${quote.days} days`, 445, 555, 105, { size: 9, strong: true })
  d.wrap(label('itinerary', 'ITINERARY'), 52, 514, 490, { size: 12, strong: true, tone: d.brandColor })
  let top = 478
  for (const day of quote.itinerary || []) {
    const estimatedLines = Math.max(2, Math.ceil(raw(day.description).length / 92))
    const height = Math.max(82, 48 + Math.min(estimatedLines, 7) * 12)
    if (top - height < 72) { d.newPage(paper); await d.miniHeader(settings, label('itinerary', 'Tour itinerary')); top = 738 }
    d.page.drawCircle({ x: 77, y: top - 17, size: 23, color: d.brandColor, opacity: .17 })
    d.page.drawCircle({ x: 77, y: top - 17, size: 16, color: d.brandColor })
    d.wrap(`D${day.day}`, 67, top - 13, 23, { size: 8, strong: true, tone: rgb(1, 1, 1) })
    d.wrap(day.name.toUpperCase(), 116, top, 420, { size: 10, strong: true, tone: d.brandColor, maxLines: 2 })
    d.wrap(day.description, 116, top - 24, 420, { size: 8.5, lineHeight: 12, tone: ink, maxLines: 7 })
    top -= height
  }
  await detailPages(d, quote, settings, 'Tour inclusions & price')
}

async function standardPdf(d: Document, quote: Json, settings: Json, fallbackName: string) {
  const label = labelsFor(settings)
  const sections = sectionsFor(settings)
  await d.header(settings.brand_name || fallbackName, label('document_title', 'Travel quotation'), quote.quote_number ? `${quote.quote_number} · R${quote.quote_revision || 1}` : `#${quote.id.slice(0, 8).toUpperCase()}`, settings)
  d.line('Prepared for', quote.client_name, 11, true)
  d.line('Destination', quote.destination); d.line('Travelers', `${quote.adults} adults, ${quote.children} children`); d.line('Duration', `${quote.days} days / ${quote.nights} nights`)
  if (quote.arrival_date) d.line('Arrival', quote.arrival_date)
  if (quote.pickup) d.line('Pickup', quote.pickup)
  if (quote.dropoff) d.line('Drop-off', quote.dropoff)
  if (quote.flights) d.line('Flights', quote.flights)
  for (const section of sections) {
    if (section === 'itinerary' && quote.itinerary?.length) {
      d.heading(label('itinerary', 'Day-by-day itinerary'))
      for (const day of quote.itinerary) { d.line(`Day ${day.day}`, day.name, 10, true); if (day.description) d.paragraph(day.description) }
    }
    if (section === 'accommodation' && quote.stays?.length) { d.heading(label('accommodation', 'Accommodation')); for (const stay of quote.stays) d.line(`Night ${stay.night}`, `${stay.name}${stay.room_type ? ` / ${stay.room_type}` : ''}`) }
    if (section === 'inclusions' && quote.inclusions) { d.heading(label('inclusions', 'Inclusions')); d.paragraph(quote.inclusions) }
    if (section === 'exclusions' && quote.exclusions) { d.heading(label('exclusions', 'Exclusions')); d.paragraph(quote.exclusions) }
    if (section === 'price') { d.heading(label('price', 'Price summary')); if (quote.price_lines?.length) for (const line of quote.price_lines) d.line(`${line.label}${Number(line.quantity) !== 1 ? ` × ${line.quantity}` : ''}`, money(line.amount ?? Number(line.quantity) * Number(line.unit_amount))); else { d.line('Package cost', money(quote.base_amount)); d.line('Child cost', money(quote.child_amount)) } d.line('Discount', `- ${money(quote.discount_amount)}`); d.line(`GST (${quote.gst_percent}%)`, money(quote.gst_amount)); d.line('Total', money(quote.total_amount), 12, true) }
    if (section === 'payment' && settings.bank_details) { d.heading(label('payment', 'Payment details')); d.paragraph(settings.bank_details) }
    if (section === 'terms' && (settings.terms || settings.cancellation_policy)) { d.heading(label('terms', 'Terms & policies')); if (settings.terms) d.paragraph(settings.terms); if (settings.cancellation_policy) { d.line('Cancellation', '', 10, true); d.paragraph(settings.cancellation_policy) } }
  }
  await d.signature(settings)
}

export async function quotePdf(input: Json, settings: Json, fallbackName: string): Promise<Uint8Array> {
  const quote = await enrichQuote(input)
  const d = new Document(); await d.init(settings)
  const template: Template = settings.document_template || 'elegant'
  if (template === 'journey') await journeyPdf(d, quote, settings)
  else if (template === 'expedition') await expeditionPdf(d, quote, settings)
  else if (template === 'brochure') await brochurePdf(d, quote, settings)
  else await standardPdf(d, quote, settings, fallbackName)
  return d.bytes(settings)
}

export async function recordPdf(type: string, record: Json, settings: Json, companyName: string): Promise<Uint8Array> {
  const d = new Document(); await d.init(settings)
  const title = type === 'invoice' ? 'Invoice' : type === 'stay_voucher' ? 'Stay voucher' : 'Cab voucher'
  await d.header(settings.brand_name || companyName, title, record.document_number || `#${record.id.slice(0, 8).toUpperCase()}`, { ...settings, document_template: ['elegant','modern','compact'].includes(settings.document_template) ? settings.document_template : 'modern' })
  const data = record.data || {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'items' || key === 'items_parsed' || key === 'subtotal' || key === 'gst_amount' || key === 'total' || key === 'demo_seed' || key === 'routes' || key === 'inclusions') continue
    if (value === null || value === undefined || value === '') continue
    d.line(key.replace(/_/g, ' ').replace(/^./, x => x.toUpperCase()), String(value))
  }
  if (data.routes?.length) { d.heading('Daily transport plan'); for (const route of data.routes) d.line(`Day ${route.day} · ${route.service_date}`, [route.destination, route.pickup && `Pickup: ${route.pickup}`, route.dropoff && `Drop: ${route.dropoff}`].filter(Boolean).join(' · ')) }
  if (data.inclusions) { d.heading('Inclusions'); d.paragraph(String(data.inclusions)) }
  if (type === 'invoice') { d.heading('Items'); for (const item of data.items_parsed || []) d.line(`${item.description}  x${item.quantity}`, money(item.amount)); d.heading('Totals'); d.line('Subtotal', money(data.subtotal)); d.line('GST', money(data.gst_amount)); d.line('Grand total', money(data.total), 12, true) }
  if (settings.terms) { d.heading('Terms & policies'); d.paragraph(settings.terms) }
  await d.signature(settings)
  return d.bytes(settings)
}
