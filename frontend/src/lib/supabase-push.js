// Web Push on Supabase: the /api/push/* routes of api/server.js, answered from the tables in
// supabase/schema.sql. The alert itself is sent by the Edge Function `send-due-pushes`
// (supabase/functions/send-due-pushes), which reads rest_timers with the service role: the
// browser never holds a key that can push to anyone.
import { supabase } from './supabase.js'
import { getLang } from './i18n-core.js'

const fail = (status, message, code) => Object.assign(new Error(message), { status, data: { error: message, ...(code ? { code } : {}) } })
const DEVICE_RULE = /^[A-Za-z0-9_-]{8,64}$/   // deviceIdOf in api/server.js
const MAX_REST_SEC = 3600
// A function started with the rest waits for the alert itself, within the time an Edge Function
// may run. Longer rests are left to the per-10-second schedule (supabase/push-cron.sql).
export const WAIT_MAX_SEC = 120

const COPY = {
  en: { restTitle: 'Rest over 💪', restBody: 'Time for your next set.', testBody: 'Test notification ✅ This is what alerts look like.' },
  'pt-BR': { restTitle: 'Descanso terminado 💪', restBody: 'Hora da próxima série.', testBody: 'Notificação de teste ✅ É assim que os alertas aparecem.' },
}
const copy = () => COPY[getLang()] || (/^pt/.test(getLang() || '') ? COPY['pt-BR'] : COPY.en)

export const vapidPublicKey = () => import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

const deviceOf = v => (typeof v === 'string' && DEVICE_RULE.test(v) ? v : null)

async function uidOf() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw fail(undefined, error.message)
  if (!data.session) throw fail(401, 'not signed in')
  return data.session.user.id
}
const check = ({ error }) => { if (error) throw fail(Number(error.status) || undefined, error.message, error.code) }

export function publicKey() {
  const key = vapidPublicKey()
  if (!key) throw fail(503, 'push is not set up on this server', 'push-off')
  return { key }
}

export async function subscribe(body) {
  const uid = await uidOf()
  const sub = body.subscription
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw fail(400, 'invalid subscription')
  if (!/^https:\/\//i.test(String(sub.endpoint))) throw fail(400, 'invalid subscription endpoint')
  const prev = await supabase.from('push_subscriptions').select('device_id').eq('endpoint', sub.endpoint).maybeSingle()
  check(prev)
  // No usable id in a re-send leaves the id the row already has, as the server did.
  const device = deviceOf(body.deviceId) || prev.data?.device_id || null
  check(await supabase.from('push_subscriptions').upsert({
    user_id: uid,
    endpoint: sub.endpoint,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    device_id: device,
  }, { onConflict: 'user_id,endpoint' }))
  return { ok: true }
}

export async function unsubscribe(body) {
  await uidOf()
  if (typeof body.endpoint === 'string') check(await supabase.from('push_subscriptions').delete().eq('endpoint', body.endpoint))
  return { ok: true }
}

export async function status(endpoint) {
  await uidOf()
  const r = await supabase.from('push_subscriptions').select('device_id').eq('endpoint', endpoint || '').maybeSingle()
  check(r)
  return r.data ? { subscribed: true, deviceId: r.data.device_id || null } : { subscribed: false }
}

// The endpoints a rest-timer alert may go to: the subscriptions the device registered, and any
// stored without an id (an older client). A resting device with none gets nothing.
async function endpointsFor(deviceId) {
  const r = await supabase.from('push_subscriptions').select('endpoint, device_id')
  check(r)
  const id = deviceOf(deviceId)
  return (r.data || []).filter(s => !id || !s.device_id || s.device_id === id).map(s => s.endpoint)
}

export async function restTimer(body) {
  const uid = await uidOf()
  const raw = body.seconds
  const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
  if (!(n >= 1)) throw fail(400, 'seconds required')
  const sec = Math.min(MAX_REST_SEC, Math.round(n))
  const endpoints = await endpointsFor(body.deviceId)
  if (!endpoints.length) return { ok: true }
  const c = copy()
  const fireAt = new Date(Date.now() + sec * 1000).toISOString()
  check(await supabase.from('rest_timers').upsert(
    endpoints.map(endpoint => ({ user_id: uid, endpoint, fire_at: fireAt, title: c.restTitle, body: c.restBody })),
    { onConflict: 'user_id,endpoint' }))
  // Not awaited: the function holds the call open until the alert is due. When it is not
  // deployed, or the rest is longer than it may wait, the schedule sends it.
  if (sec <= WAIT_MAX_SEC) supabase.functions.invoke('send-due-pushes', { body: { wait: true } }).catch(() => {})
  return { ok: true }
}

export async function cancelRestTimer(body) {
  await uidOf()
  const endpoints = await endpointsFor(body.deviceId)
  if (endpoints.length) check(await supabase.from('rest_timers').delete().in('endpoint', endpoints))
  return { ok: true }
}

export async function test() {
  await uidOf()
  const { error } = await supabase.functions.invoke('send-due-pushes', { body: { test: { title: 'openGym', body: copy().testBody, tag: 'test' } } })
  if (error) throw fail(Number(error.context?.status) || 502, error.message || 'push function unavailable')
  return { ok: true }
}
