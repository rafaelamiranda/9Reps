// The openGym API, answered by Supabase. api() hands every /api/ path here when SUPABASE_ON, so
// the store, the sync merge and every caller keep the contract they had with api/server.js:
// the same JSON out, the same `status` and `data` on the errors they branch on (401 not signed
// in, 409 conflict with the stored document). Routes the server owned and Supabase does not
// (admin, coach, passkeys) answer 404.
import { supabase } from './supabase.js'
import * as push from './supabase-push.js'
import { SUPA_MEDIA_LIMITS, missing as mediaMissing, sweep as mediaSweep } from './supabase-media.js'

const fail = (status, message, data) => Object.assign(new Error(message), { status, data: data || { error: message } })

// A PostgREST/auth refusal, in the shape callers know. No status = unreachable, as for fetch.
function toError(e) {
  const status = e?.status || (e?.code === 'PGRST301' || e?.code === '28000' ? 401 : undefined)
  const err = new Error(e?.message || 'request failed')
  if (status) err.status = status
  err.data = { error: err.message, ...(e?.code ? { code: e.code } : {}) }
  return err
}

export const userOf = u => u && ({
  id: u.id,
  name: u.user_metadata?.name || (u.email ? u.email.split('@')[0] : 'you'),
  email: u.email || '',
  admin: false,
})

const wid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
const isList = v => v == null || Array.isArray(v)
const entries = v => (Array.isArray(v) ? v.filter(x => !!x && typeof x === 'object' && !Array.isArray(x)) : [])

async function session() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw toError(error)
  return data.session
}
async function needUser() {
  const s = await session()
  if (!s) throw fail(401, 'not signed in')
  return s.user
}
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw toError(error)
  return data
}

// The old server swept every hour on its own; here the device that just pushed does it, at most
// every 10 minutes. A file only goes once it has been unreferenced for the whole grace.
const SWEEP_EVERY_MS = 600000
let lastSweep = 0
function sweepSoon() {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return
  lastSweep = Date.now()
  mediaSweep().catch(() => { lastSweep = 0 })
}

const routes = {
  // No guests and no invites: an account is the way in. Media limits: lib/supabase-media.js.
  'GET /api/config': async () => ({
    invite_only: false, allow_guest: false, password_login: true, supabase: true,
    media: { ...SUPA_MEDIA_LIMITS, workouts: true },
  }),
  'GET /api/me': async () => ({ user: userOf(await needUser()) }),
  'POST /api/logout': async () => { await supabase.auth.signOut({ scope: 'local' }); return { ok: true } },
  'POST /api/logout/all': async () => { await supabase.auth.signOut({ scope: 'global' }); return { ok: true } },
  'GET /api/data': async () => {
    await needUser()
    return rpc('get_state')
  },
  'GET /api/data/rev': async () => {
    await needUser()
    return rpc('get_rev')
  },
  'PUT /api/data': async (_q, body) => {
    await needUser()
    const state = body.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail(400, 'state required')
    if (!Object.keys(state).some(k => k !== '_rev' && k !== '_ts')) throw fail(400, 'state required')
    if (!isList(state.workouts) || !isList(state.routines)) throw fail(400, 'invalid state')
    const doc = { ...state, workouts: entries(state.workouts), routines: entries(state.routines), bodyweight: entries(state.bodyweight), measurements: entries(state.measurements) }
    delete doc.active   // an in-progress workout stays on its device
    const r = await rpc('put_state', {
      base_rev: body.baseRev == null ? null : body.baseRev,
      base_wid: typeof body.baseWid === 'string' ? body.baseWid : null,
      doc, new_wid: wid(),
    })
    if (r?.conflict) throw fail(409, 'conflict', { error: 'conflict', rev: r.rev, state: r.state })
    sweepSoon()
    return { ok: true, ts: r.ts ?? null, rev: r.rev, wid: r.wid }
  },
  'POST /api/media/missing': async (_q, body) => mediaMissing(body.hashes),
  'POST /api/media/sweep': async () => mediaSweep(),
  'GET /api/push/public-key': async () => push.publicKey(),
  'POST /api/push/subscribe': async (_q, body) => push.subscribe(body),
  'POST /api/push/unsubscribe': async (_q, body) => push.unsubscribe(body),
  'GET /api/push/status': async q => push.status(q.get('endpoint')),
  'POST /api/push/rest-timer': async (_q, body) => push.restTimer(body),
  'POST /api/push/rest-timer/cancel': async (_q, body) => push.cancelRestTimer(body),
  'POST /api/push/test': async () => push.test(),
  'POST /api/activity': async () => ({ ok: true }),
}

export async function supaApi(path, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase()
  const [route, query] = path.split('?')
  let body = {}
  try { body = opts && opts.body ? JSON.parse(opts.body) : {} } catch { throw fail(400, 'invalid body') }
  const handler = routes[method + ' ' + route]
  if (!handler) throw fail(404, 'not found')
  return handler(new URLSearchParams(query || ''), body)
}
