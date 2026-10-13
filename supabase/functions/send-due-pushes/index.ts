// Sends the rest-timer alerts that are due, from rest_timers, with web push. Deployed with
//   supabase functions deploy send-due-pushes
// and these secrets (the public key is the app's VITE_VAPID_PUBLIC_KEY):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// It reads and writes with the service role, which Supabase hands to the function itself. That
// key never reaches the app.
//
// Three callers, told apart by what they send:
//   - the schedule (supabase/push-cron.sql): the service role as bearer, no body. Sends every
//     due alert once.
//   - a signed-in app, { wait: true }: waits for that user's own alerts and sends them as they
//     fall due, up to WAIT_MAX_MS.
//   - a signed-in app, { test: { title, body, tag } }: sends that alert to the user's devices now.
// A due alert is claimed by deleting its row, so two callers never send the same one twice, and
// a rest cancelled or restarted meanwhile is not sent.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const WAIT_MAX_MS = 130_000
const LATE_GRACE_MS = 10 * 60_000   // a rest that fell due this long ago is stale, not an alert

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function sendTo(userId: string, endpoint: string, payload: Record<string, unknown>) {
  const { data } = await admin.from('push_subscriptions').select('subscription').eq('user_id', userId).eq('endpoint', endpoint).maybeSingle()
  if (!data) return false
  try {
    await webpush.sendNotification(data.subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high' })
    return true
  } catch (e) {
    // The push service says this subscription is gone for good: forget it.
    const status = (e as { statusCode?: number }).statusCode
    if (status === 404 || status === 410) {
      await admin.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint)
    } else {
      console.error('push failed', status, (e as Error).message)
    }
    return false
  }
}

// Claims and sends what is due now. `userId` narrows it to one account (the signed-in caller).
async function sendDue(userId?: string) {
  const now = Date.now()
  let q = admin.from('rest_timers').delete()
    .lte('fire_at', new Date(now).toISOString())
    .gte('fire_at', new Date(now - LATE_GRACE_MS).toISOString())
  if (userId) q = q.eq('user_id', userId)
  const { data, error } = await q.select()
  if (error) { console.error('claim failed', error.message); return 0 }
  let sent = 0
  await Promise.all((data || []).map(async r => {
    const ok = await sendTo(r.user_id, r.endpoint, { title: r.title || 'openGym', body: r.body || '', tag: 'rest-timer' })
    if (ok) sent++
  }))
  // Rows older than the grace were never going to be useful; the same sweep drops them.
  await admin.from('rest_timers').delete().lt('fire_at', new Date(now - LATE_GRACE_MS).toISOString())
  return sent
}

async function waitAndSend(userId: string) {
  const end = Date.now() + WAIT_MAX_MS
  let sent = 0
  while (Date.now() < end) {
    sent += await sendDue(userId)
    const { data } = await admin.from('rest_timers').select('fire_at').eq('user_id', userId).order('fire_at').limit(1)
    if (!data?.length) break   // nothing left to wait for (sent, cancelled, or none)
    const due = new Date(data[0].fire_at).getTime()
    if (due > end) break       // too far off for this call: the schedule takes it
    await sleep(Math.max(250, Math.min(due - Date.now(), 5000)))
  }
  return sent
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    } })
  }
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  let body: { wait?: boolean; test?: { title?: string; body?: string; tag?: string } } = {}
  try { body = await req.json() } catch { /* the schedule sends none */ }

  // The schedule: the service role itself.
  if (token && token === serviceKey) return json(200, { sent: await sendDue() })

  const { data: u, error } = await admin.auth.getUser(token)
  if (error || !u?.user) return json(401, { error: 'not signed in' })
  const userId = u.user.id

  if (body.test) {
    const payload = { title: body.test.title || 'openGym', body: body.test.body || '', tag: 'test' }
    const { data: subs } = await admin.from('push_subscriptions').select('endpoint').eq('user_id', userId)
    const results = await Promise.all((subs || []).map(s => sendTo(userId, s.endpoint, payload)))
    return json(200, { sent: results.filter(Boolean).length })
  }
  if (body.wait) return json(200, { sent: await waitAndSend(userId) })
  return json(200, { sent: await sendDue(userId) })
})
