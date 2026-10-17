import Fastify from 'fastify'
import cors from '@fastify/cors'
import rawBody from 'fastify-raw-body'
import { authenticate, env, HttpError } from './core.js'
import { registerAdmin } from './admin.js'
import { registerRecords } from './records.js'
import { registerQuotes } from './quotes.js'
import { registerFinance } from './finance.js'
import { registerIntegrations } from './integrations.js'

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 })
await app.register(cors, { origin: env.webOrigin.split(',').map(x => x.trim()), methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id'] })
await app.register(rawBody, { global: false, encoding: 'utf8', runFirst: true })
app.setErrorHandler((error, request, reply) => {
  const fault = error as Error & { statusCode?: number }
  const status = fault instanceof HttpError ? fault.statusCode : fault.statusCode && fault.statusCode < 500 ? fault.statusCode : 500
  if (status >= 500) request.log.error(fault)
  reply.code(status).send({ error: status >= 500 && !(fault instanceof HttpError) ? 'Unexpected server error.' : fault.message })
})
app.get('/health', async () => ({ ok: true }))

await app.register(async api => {
  api.addHook('onRequest', async request => {
    if (request.url.startsWith('/api/v1/webhooks/meta')) return
    await authenticate(request)
  })
  await registerAdmin(api)
  await registerRecords(api)
  await registerQuotes(api)
  await registerFinance(api)
  await registerIntegrations(api)
}, { prefix: '/api/v1' })

await app.listen({ port: env.port, host: '0.0.0.0' })
