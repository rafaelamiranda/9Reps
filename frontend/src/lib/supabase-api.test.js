import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = { getSession: vi.fn(), signOut: vi.fn() }
const rpc = vi.fn()
vi.mock('./supabase.js', () => ({ supabase: { auth, rpc }, SUPABASE_ON: true }))
const { supaApi, userOf } = await import('./supabase-api.js')

const signedIn = () => auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'u1', email: 'ana@x.com' } } }, error: null })
const put = body => supaApi('/api/data', { method: 'PUT', body: JSON.stringify(body) })

beforeEach(() => { vi.clearAllMocks(); signedIn() })

describe('supabase api adapter', () => {
  it('answers /api/me with the signed-in user, and 401 without a session', async () => {
    expect((await supaApi('/api/me')).user).toMatchObject({ id: 'u1', name: 'ana', admin: false })
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    await expect(supaApi('/api/me')).rejects.toMatchObject({ status: 401 })
  })
  it('names the user from the sign-up name when there is one', () => {
    expect(userOf({ id: 'a', email: 'b@c.d', user_metadata: { name: 'Bia' } }).name).toBe('Bia')
  })
  it('turns a stored-revision mismatch into the 409 the sync merges from', async () => {
    rpc.mockResolvedValue({ data: { ok: false, conflict: true, rev: 7, state: { workouts: [] } }, error: null })
    await expect(put({ state: { workouts: [], routines: [], x: 1 }, baseRev: 3 })).rejects.toMatchObject({ status: 409, data: { error: 'conflict', rev: 7 } })
  })
  it('sends the document without the in-progress workout, and returns rev and wid', async () => {
    rpc.mockResolvedValue({ data: { ok: true, rev: 4, wid: 'abc', ts: 9 }, error: null })
    const out = await put({ state: { workouts: [{ id: 1 }, null], routines: [], active: { a: 1 }, unit: 'kg' }, baseRev: 3, baseWid: 'w' })
    expect(out).toEqual({ ok: true, ts: 9, rev: 4, wid: 'abc' })
    const [name, args] = rpc.mock.calls[0]
    expect(name).toBe('put_state')
    expect(args).toMatchObject({ base_rev: 3, base_wid: 'w' })
    expect(args.doc.active).toBeUndefined()
    expect(args.doc.workouts).toEqual([{ id: 1 }])
  })
  it('refuses an empty or malformed state like the server did', async () => {
    await expect(put({ state: {} })).rejects.toMatchObject({ status: 400 })
    await expect(put({ state: { workouts: 'no' } })).rejects.toMatchObject({ status: 400 })
  })
  it('answers 404 for routes Supabase does not serve', async () => {
    await expect(supaApi('/api/coach/status')).rejects.toMatchObject({ status: 404 })
  })
})
