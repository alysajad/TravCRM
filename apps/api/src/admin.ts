import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { admin, audit, env, HttpError, requireContext, requirePermission, unwrap } from './core.js'
import { modules } from './modules.js'

const id = (v: unknown) => (v as { id: string }).id
const companyInput = z.object({ name: z.string().trim().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]{3,40}$/), admin_email: z.email(), admin_name: z.string().trim().min(2).max(120) })
const roleInput = z.object({ name: z.string().trim().min(2).max(80), permissions: z.array(z.string()).default([]) })
const settingsInput = z.object({ brand_name: z.string().max(120).nullable().optional(), phone: z.string().max(50).nullable().optional(), email: z.string().max(200).nullable().optional(), address: z.string().max(2000).nullable().optional(), gstin: z.string().max(30).nullable().optional(), bank_details: z.string().max(2000).nullable().optional(), document_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), website: z.string().max(300).nullable().optional(), logo_path: z.string().max(500).nullable().optional(), social_links: z.record(z.string(), z.string()).optional() })
const allPermissions = ['company.read','settings.write','roles.read','roles.write','users.read','users.write','files.read','files.write','quotes.read','quotes.write','payments.read','payments.write','messages.read','messages.write','audit.read', ...Object.values(modules).flatMap(x => [`${x.type}.read`, `${x.type}.write`])]

export async function registerAdmin(app: FastifyInstance): Promise<void> {
  app.get('/me', async request => {
    const { db, ...ctx } = requireContext(request)
    return { ...ctx, availablePermissions: allPermissions }
  })

  app.get('/companies', async request => {
    const ctx = requireContext(request)
    const { data, error } = ctx.platform ? await admin.from('companies').select('*').order('name') : await ctx.db.from('companies').select('*').eq('id', ctx.companyId)
    if (error) throw new HttpError(400, error.message)
    return data
  })

  app.post('/companies', async request => {
    const ctx = requireContext(request)
    if (!ctx.platform) throw new HttpError(403, 'Only a platform admin can create companies.')
    const parsed = companyInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check company details.')
    const value = parsed.data
    const company = unwrap(await admin.from('companies').insert({ name: value.name, slug: value.slug }).select('*').single())
    let invitedId: string | undefined
    try {
      const role = unwrap(await admin.from('roles').insert({ company_id: company.id, name: 'Company admin', permissions: ['*'] }).select('*').single())
      unwrap(await admin.from('company_settings').insert({ company_id: company.id, brand_name: value.name }).select('*').single())
      const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(value.admin_email, { redirectTo: `${env.appUrl.replace(/\/$/, '')}/set-password` })
      if (error || !invited.user) throw new Error(error?.message || 'Could not invite company admin.')
      invitedId = invited.user.id
      unwrap(await admin.from('memberships').insert({ user_id: invited.user.id, company_id: company.id, role_id: role.id, name: value.admin_name, email: value.admin_email }).select('*').single())
    } catch (error) {
      if (invitedId) await admin.auth.admin.deleteUser(invitedId)
      await admin.from('companies').delete().eq('id', company.id)
      throw error
    }
    await audit({ ...ctx, companyId: company.id }, 'companies.create', company.id)
    return company
  })

  app.get('/users', async request => {
    const ctx = requirePermission(request, 'users.read')
    return unwrap(await ctx.db.from('memberships').select('user_id,company_id,role_id,name,email,active,roles(name)').eq('company_id', ctx.companyId).order('name'))
  })

  app.post('/users', async request => {
    const ctx = requirePermission(request, 'users.write')
    const parsed = z.object({ email: z.email(), name: z.string().trim().min(2), role_id: z.uuid() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Enter a valid name, email, and role.')
    const { email, name, role_id } = parsed.data
    const role = await ctx.db.from('roles').select('id').eq('company_id', ctx.companyId).eq('id', role_id).maybeSingle()
    if (!role.data) throw new HttpError(400, 'Role not found in this company.')
    const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${env.appUrl.replace(/\/$/, '')}/set-password` })
    if (error || !invited.user) throw new HttpError(400, error?.message || 'Could not invite user.')
    let member
    try { member = unwrap(await admin.from('memberships').insert({ user_id: invited.user.id, company_id: ctx.companyId, role_id, name, email }).select('*').single()) }
    catch (error) { await admin.auth.admin.deleteUser(invited.user.id); throw error }
    await audit(ctx, 'users.invite', invited.user.id)
    return member
  })

  app.patch('/users/:id', async request => {
    const ctx = requirePermission(request, 'users.write')
    const parsed = z.object({ name: z.string().trim().min(2).optional(), role_id: z.uuid().optional(), active: z.boolean().optional() }).safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, 'Check user details.')
    if (id(request.params) === ctx.userId && parsed.data.active === false) throw new HttpError(400, 'You cannot deactivate your own account.')
    const current = unwrap(await ctx.db.from('memberships').select('role_id,active').eq('company_id', ctx.companyId).eq('user_id', id(request.params)).single())
    const currentRole = unwrap(await ctx.db.from('roles').select('permissions').eq('company_id', ctx.companyId).eq('id', current.role_id).single())
    if (currentRole.permissions.includes('*') && (parsed.data.active === false || (parsed.data.role_id && parsed.data.role_id !== current.role_id))) {
      const { count } = await ctx.db.from('memberships').select('user_id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('role_id', current.role_id).eq('active', true)
      if ((count || 0) <= 1) throw new HttpError(400, 'Keep at least one active company admin.')
    }
    if (parsed.data.role_id) {
      const { data } = await ctx.db.from('roles').select('id').eq('company_id', ctx.companyId).eq('id', parsed.data.role_id).maybeSingle()
      if (!data) throw new HttpError(400, 'Role not found in this company.')
    }
    const member = unwrap(await ctx.db.from('memberships').update(parsed.data).eq('company_id', ctx.companyId).eq('user_id', id(request.params)).select('*').single())
    await audit(ctx, 'users.update', member.user_id)
    return member
  })

  app.get('/roles', async request => {
    const ctx = requirePermission(request, 'roles.read')
    return unwrap(await ctx.db.from('roles').select('*').eq('company_id', ctx.companyId).order('name'))
  })

  app.post('/roles', async request => {
    const ctx = requirePermission(request, 'roles.write')
    const parsed = roleInput.safeParse(request.body)
    if (!parsed.success || parsed.data.permissions.some(x => !allPermissions.includes(x))) throw new HttpError(400, 'Check role permissions.')
    const role = unwrap(await ctx.db.from('roles').insert({ ...parsed.data, company_id: ctx.companyId }).select('*').single())
    await audit(ctx, 'roles.create', role.id)
    return role
  })

  app.patch('/roles/:id', async request => {
    const ctx = requirePermission(request, 'roles.write')
    const parsed = roleInput.safeParse(request.body)
    if (!parsed.success || parsed.data.permissions.some(x => !allPermissions.includes(x))) throw new HttpError(400, 'Check role permissions.')
    const existing = unwrap(await ctx.db.from('roles').select('permissions').eq('company_id', ctx.companyId).eq('id', id(request.params)).single())
    if (existing.permissions.includes('*')) throw new HttpError(400, 'The company admin role cannot be changed.')
    const role = unwrap(await ctx.db.from('roles').update(parsed.data).eq('company_id', ctx.companyId).eq('id', id(request.params)).select('*').single())
    await audit(ctx, 'roles.update', role.id)
    return role
  })

  app.get('/settings', async request => {
    const ctx = requirePermission(request, 'company.read')
    return unwrap(await ctx.db.from('company_settings').select('*').eq('company_id', ctx.companyId).single())
  })

  app.patch('/settings', async request => {
    const ctx = requirePermission(request, 'settings.write')
    const parsed = settingsInput.safeParse(request.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Check settings.')
    if (parsed.data.logo_path && !parsed.data.logo_path.startsWith(`${ctx.companyId}/`)) throw new HttpError(400, 'Logo must belong to this company.')
    const settings = unwrap(await ctx.db.from('company_settings').update(parsed.data).eq('company_id', ctx.companyId).select('*').single())
    await audit(ctx, 'settings.update')
    return settings
  })

  app.get('/audit', async request => {
    const ctx = requirePermission(request, 'audit.read')
    return unwrap(await ctx.db.from('audit_events').select('*').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(100))
  })
}
