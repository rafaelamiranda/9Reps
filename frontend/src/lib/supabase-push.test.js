import { describe, it, expect, vi, beforeEach } from 'vitest'

let subs, timers, invoked
const ok = d => ({ data: d, error: null })

const table = name => {
  const rows = name === 'push_subscriptions' ? subs : timers
  const q = { _eq: {}, _in: null }
  q.select = () => q
  q.eq = (c, v) => { q._eq[c] = v; return q }
  q.in = (c, v) => { q._in = [c, v]; return q }
  const match = () => rows.filter(r => Object.entries(q._eq).every(([c, v]) => r[c] === v) && (!q._in || q._in[1].includes(r[q._in[0]])))
  q.maybeSingle = async () => ok(match()[0] || null)
  q.then = res => res(ok(match()))
  q.upsert = async v => { for (const r of [].concat(v)) { const i = rows.findIndex(x => x.endpoint === r.endpoint); if (i >= 0) rows[i] = { ...rows[i], ...r }; else rows.push(r) } return ok(null) }
  q.delete = () => ({ in: async (c, v) => { for (const r of rows.filter(x => v.includes(x[c]))) rows.splice(rows.indexOf(r), 1); return ok(null) }, eq: async (c, v) => { for (const r of rows.filter(x => x[c] === v)) rows.splice(rows.indexOf(r), 1); return ok(null) } })
  return q
}

vi.mock('./supabase.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    from: table,
    functions: { invoke: vi.fn(async (name, opts) => { invoked.push([name, opts]); return { data: {}, error: null } }) },
  },
}))
vi.mock('./i18n-core.js', () => ({ getLang: () => 'en' }))

const push = await import('./supabase-push.js')
const sub = (endpoint, extra) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, ...extra })

beforeEach(() => { subs = []; timers = []; invoked = [] })

describe('subscribe / status / unsubscribe', () => {
  it('stores only the endpoint and the two keys, under the device id', async () => {
    await push.subscribe(sub('https://push.example/1', { deviceId: 'device-aaaa', subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a', extra: 'x' }, other: 1 } }))
    expect(subs[0]).toMatchObject({ user_id: 'u1', endpoint: 'https://push.example/1', device_id: 'device-aaaa', subscription: { keys: { p256dh: 'p', auth: 'a' } } })
    expect(subs[0].subscription.other).toBeUndefined()
    expect(await push.status('https://push.example/1')).toEqual({ subscribed: true, deviceId: 'device-aaaa' })
    expect(await push.status('https://push.example/none')).toEqual({ subscribed: false })
  })
  it('keeps the stored device id when a re-send brings none', async () => {
    await push.subscribe(sub('https://push.example/1', { deviceId: 'device-aaaa' }))
    await push.subscribe(sub('https://push.example/1'))
    expect(subs[0].device_id).toBe('device-aaaa')
  })
  it('refuses a malformed subscription or a plain-http endpoint', async () => {
    await expect(push.subscribe({ subscription: { endpoint: 'https://x', keys: {} } })).rejects.toMatchObject({ status: 400 })
    await expect(push.subscribe(sub('http://push.example/1'))).rejects.toMatchObject({ status: 400 })
  })
  it('unsubscribes by endpoint', async () => {
    await push.subscribe(sub('https://push.example/1'))
    await push.unsubscribe({ endpoint: 'https://push.example/1' })
    expect(subs).toHaveLength(0)
  })
})

describe('rest timer', () => {
  beforeEach(async () => {
    await push.subscribe(sub('https://push.example/mine', { deviceId: 'device-mine1' }))
    await push.subscribe(sub('https://push.example/other', { deviceId: 'device-other' }))
    await push.subscribe(sub('https://push.example/old'))   // from before device ids
  })
  it('schedules the alert for the device that rests, and the subscriptions with no id', async () => {
    await push.restTimer({ seconds: 90, deviceId: 'device-mine1' })
    expect(timers.map(t => t.endpoint).sort()).toEqual(['https://push.example/mine', 'https://push.example/old'])
    const at = new Date(timers[0].fire_at).getTime() - Date.now()
    expect(at).toBeGreaterThan(85_000)
    expect(at).toBeLessThanOrEqual(90_000)
    expect(timers[0]).toMatchObject({ user_id: 'u1', title: expect.any(String), body: expect.any(String) })
  })
  it('asks the function to wait for it, unless the rest is longer than it can', async () => {
    await push.restTimer({ seconds: 60, deviceId: 'device-mine1' })
    expect(invoked).toEqual([['send-due-pushes', { body: { wait: true } }]])
    invoked.length = 0
    await push.restTimer({ seconds: 600, deviceId: 'device-mine1' })
    expect(invoked).toHaveLength(0)
  })
  it('clamps to an hour and refuses a missing or unusable length', async () => {
    await push.restTimer({ seconds: 99999, deviceId: 'device-mine1' })
    expect(new Date(timers[0].fire_at).getTime() - Date.now()).toBeLessThanOrEqual(3600_000)
    for (const seconds of [undefined, 0, 'x', {}]) await expect(push.restTimer({ seconds })).rejects.toMatchObject({ status: 400 })
  })
  it('cancels the device\'s alert and nobody else\'s', async () => {
    await push.restTimer({ seconds: 90 })
    await push.cancelRestTimer({ deviceId: 'device-mine1' })
    expect(timers.map(t => t.endpoint)).toEqual(['https://push.example/other'])
  })
})

describe('public key and test', () => {
  it('says push is off without a configured key', () => {
    expect(() => push.publicKey()).toThrow(/not set up/)
  })
  it('asks the function for a test alert in the UI language', async () => {
    await push.test()
    expect(invoked[0][1].body.test).toMatchObject({ title: 'openGym', tag: 'test', body: expect.stringContaining('Test') })
  })
})
