import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
let rows, storage, rpcs

// A query builder that answers like PostgREST for the three calls supabase-media makes.
const table = () => ({
  select: cols => {
    const q = { _in: null, then: res => res({ data: rows.filter(r => !q._in || q._in.includes(r.hash)).map(r => (cols === 'size' ? { size: r.size } : { hash: r.hash })), error: null }) }
    q.in = (_c, v) => { q._in = v; return q }
    return q
  },
  upsert: vi.fn(async r => { rows.push(r); return { error: null } }),
  delete: () => ({ in: async (_c, v) => { rows = rows.filter(r => !v.includes(r.hash)); return { error: null } } }),
})

vi.mock('./supabase.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    from: () => table(),
    rpc: async (name, args) => { rpcs.push([name, args]); return name === 'get_state' ? { data: { state: { workouts: [{ media: [{ hash: H, mime: 'image/jpeg', size: 5 }] }] } }, error: null } : { data: [{ hash: H2, size: 7 }], error: null } },
    storage: { from: () => storage },
  },
}))

const mod = await import('./supabase-media.js')
const MB = 1024 * 1024

beforeEach(() => {
  rows = []
  rpcs = []
  storage = {
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://x.supabase.co/signed' }, error: null })),
    createSignedUploadUrl: vi.fn(async () => ({ data: { signedUrl: 'https://x.supabase.co/up?token=t' }, error: null })),
    remove: vi.fn(async () => ({ error: null })),
  }
})

describe('hashOfPath', () => {
  it('takes the hash of a media path and nothing else', () => {
    expect(mod.hashOfPath('/api/media/' + H)).toBe(H)
    expect(mod.hashOfPath('/api/media/missing')).toBeNull()
    expect(mod.hashOfPath('/api/media/' + H + '/x')).toBeNull()
  })
})

describe('missing', () => {
  it('answers the hashes without a row, with the space used', async () => {
    rows = [{ hash: H, size: 100 }]
    const r = await mod.missing([H, H2, H, 'nope'])
    expect(r.missing).toEqual([H2])
    expect(r.usage).toEqual({ bytes: 100, count: 1, quotaBytes: mod.SUPA_MEDIA_LIMITS.quotaMB * MB })
  })
})

describe('downloadUrl', () => {
  it('signs the file under the user folder', async () => {
    expect(await mod.downloadUrl(H)).toBe('https://x.supabase.co/signed')
    expect(storage.createSignedUrl).toHaveBeenCalledWith('u1/' + H, expect.any(Number))
  })
  it('says media-missing when the object is not there', async () => {
    storage.createSignedUrl = async () => ({ data: null, error: { message: 'Object not found', status: 404 } })
    await expect(mod.downloadUrl(H)).rejects.toMatchObject({ status: 404, code: 'media-missing' })
  })
})

describe('prepareUpload', () => {
  it('refuses a type the app does not store', async () => {
    await expect(mod.prepareUpload(H, 'application/pdf', 10)).rejects.toMatchObject({ status: 415, code: 'media-type' })
  })
  it('refuses a file over the cap of its kind', async () => {
    await expect(mod.prepareUpload(H, 'image/jpeg', 11 * MB)).rejects.toMatchObject({ status: 413 })
    await expect(mod.prepareUpload(H, 'video/mp4', 51 * MB)).rejects.toMatchObject({ status: 413 })
    await expect(mod.prepareUpload(H, 'video/mp4', 40 * MB)).resolves.toMatchObject({ url: expect.any(String) })
  })
  it('refuses with media-quota, in MB, when the space is used up', async () => {
    rows = [{ hash: H2, size: 999 * MB }]
    await expect(mod.prepareUpload(H, 'image/jpeg', 2 * MB)).rejects.toMatchObject({ code: 'media-quota', data: { usedMB: 999, quotaMB: 1000 } })
  })
  it('asks for an upload URL in the user folder', async () => {
    await mod.prepareUpload(H, 'image/jpeg', 100)
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith('u1/' + H)
  })
})

describe('sweep', () => {
  it('sends the hashes the stored state refers to, then removes what is due from Storage and the table', async () => {
    rows = [{ hash: H, size: 5 }, { hash: H2, size: 7 }]
    const r = await mod.sweep()
    expect(rpcs[1]).toEqual(['media_sweep', { refs: [H], grace_ms: mod.SWEEP_GRACE_MS }])
    expect(storage.remove).toHaveBeenCalledWith(['u1/' + H2])
    expect(rows.map(x => x.hash)).toEqual([H])
    expect(r).toEqual({ removed: 1, freedBytes: 7, skipped: false })
  })
  it('keeps the rows when Storage refuses the removal', async () => {
    rows = [{ hash: H2, size: 7 }]
    storage.remove = async () => ({ error: { message: 'boom' } })
    await expect(mod.sweep()).rejects.toThrow('boom')
    expect(rows).toHaveLength(1)
  })
})
