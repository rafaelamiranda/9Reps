// Photos and videos on Supabase Storage: bucket `media`, one private object per file at
// <uid>/<sha256>, one row per file in public.media (supabase/schema.sql). lib/api.js hands
// apiBlob and apiUpload here when SUPABASE_ON, so lib/media-sync.js keeps its contract with
// api/media.js: the same `code`s on a refusal (media-quota, media-type, media-missing), the
// same { missing, usage } answer, the same grace before a file nobody references is dropped.
import { supabase } from './supabase.js'
import { HASH_RE, MEDIA_MIMES, referencedHashes } from './media-refs.js'
import { MB } from './media-limits.js'

// What GET /api/config says and the bucket enforces (schema.sql sets file_size_limit from
// videoMB). The Free plan caps one upload at 50 MB; raise videoMB with the plan, in both places.
export const SUPA_MEDIA_LIMITS = Object.freeze({ imageMB: 10, gifMB: 20, videoMB: 50, videoSec: 60, quotaMB: 1000 })
// A file nobody references any more survives this long (api/media.js: the state push that
// names a fresh upload is usually a second behind it).
export const SWEEP_GRACE_MS = 3600000
const SIGNED_URL_SECONDS = 600
const BUCKET = 'media'

const fail = (status, message, code, data) => Object.assign(new Error(message), { status, code, data: { error: message, code, ...data } })

function toError(e) {
  const status = Number(e?.status || e?.statusCode) || undefined
  const err = new Error(e?.message || 'request failed')
  if (status) err.status = status
  err.code = e?.code || 'http'
  err.data = { error: err.message, code: err.code }
  return err
}

async function uidOf() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw toError(error)
  if (!data.session) throw fail(401, 'not signed in', 'http')
  return data.session.user.id
}

/** The hash in '/api/media/<hash>', or null for any other path. */
export const hashOfPath = path => {
  const m = /^\/api\/media\/([0-9a-f]{64})$/.exec(path)
  return m && HASH_RE.test(m[1]) ? m[1] : null
}

const capMB = mime => {
  const kind = MEDIA_MIMES[mime]?.kind
  return kind === 'video' ? SUPA_MEDIA_LIMITS.videoMB : kind === 'gif' ? SUPA_MEDIA_LIMITS.gifMB : SUPA_MEDIA_LIMITS.imageMB
}

/** What is stored for the signed-in user: { bytes, count, quotaBytes }. */
export async function usage() {
  const { data, error } = await supabase.from('media').select('size')
  if (error) throw toError(error)
  const rows = data || []
  return { bytes: rows.reduce((n, r) => n + (r.size || 0), 0), count: rows.length, quotaBytes: Math.round(SUPA_MEDIA_LIMITS.quotaMB * MB) }
}

/** POST /api/media/missing: the hashes with no row, which the device that has them sends again. */
export async function missing(hashes) {
  const asked = [...new Set((Array.isArray(hashes) ? hashes : []).filter(h => typeof h === 'string' && HASH_RE.test(h)))]
  await uidOf()
  let have = new Set()
  if (asked.length) {
    const { data, error } = await supabase.from('media').select('hash').in('hash', asked)
    if (error) throw toError(error)
    have = new Set((data || []).map(r => r.hash))
  }
  return { missing: asked.filter(h => !have.has(h)), usage: await usage() }
}

/** A short-lived URL to read one file. A file that is not there is the server's media-missing. */
export async function downloadUrl(hash) {
  const uid = await uidOf()
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(`${uid}/${hash}`, SIGNED_URL_SECONDS)
  if (error || !data?.signedUrl) {
    const status = Number(error?.status || error?.statusCode)
    if (!error || status === 404 || /not found|object/i.test(error.message || '')) throw fail(404, 'no such file', 'media-missing')
    throw toError(error)
  }
  return data.signedUrl
}

/**
 * Checks a file against the limits and the space left, then asks Storage for a one-use upload
 * URL. The refusals are the ones api/media.js gives, so media-sync's messages stay right.
 */
export async function prepareUpload(hash, mime, size) {
  if (!MEDIA_MIMES[mime]) throw fail(415, 'unsupported file type', 'media-type')
  if (size > Math.round(capMB(mime) * MB)) throw fail(413, 'file too large', 'media-too-large')
  const [uid, used] = await Promise.all([uidOf(), usage()])
  const quota = SUPA_MEDIA_LIMITS.quotaMB
  if (quota > 0 && used.bytes + size > quota * MB) {
    throw fail(413, 'media quota reached', 'media-quota', { usedMB: used.bytes / MB, quotaMB: quota })
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(`${uid}/${hash}`)
  if (error || !data?.signedUrl) throw toError(error || {})
  return { url: data.signedUrl }
}

/** Records the file as the profile's. It starts unreferenced: the state push that names it comes
 *  after, and the sweep clears the mark once it does. */
export async function recordUpload(hash, mime, size) {
  const uid = await uidOf()
  const { error } = await supabase.from('media')
    .upsert({ user_id: uid, hash, mime, size, unref_since: new Date().toISOString() }, { onConflict: 'user_id,hash' })
  if (error) throw toError(error)
}

/**
 * POST /api/media/sweep: drops every file the stored state no longer refers to and that has been
 * unreferenced for the whole grace. The references are read from the stored document here, never
 * taken from the caller, and a document that cannot be read sweeps nothing.
 */
export async function sweep({ graceMs = SWEEP_GRACE_MS } = {}) {
  const uid = await uidOf()
  const { data: doc, error: docErr } = await supabase.rpc('get_state')
  if (docErr) throw toError(docErr)
  const state = doc && doc.state
  if (!state || typeof state !== 'object') return { removed: 0, freedBytes: 0, skipped: true }
  const { data: due, error } = await supabase.rpc('media_sweep', { refs: [...referencedHashes(state)], grace_ms: Math.max(0, Math.round(graceMs)) })
  if (error) throw toError(error)
  const rows = due || []
  if (!rows.length) return { removed: 0, freedBytes: 0, skipped: false }
  // Storage first: a row without its file is repaired by the next upload, a file without its row
  // would be space nobody can see or free.
  const { error: rmErr } = await supabase.storage.from(BUCKET).remove(rows.map(r => `${uid}/${r.hash}`))
  if (rmErr) throw toError(rmErr)
  const { error: delErr } = await supabase.from('media').delete().in('hash', rows.map(r => r.hash))
  if (delErr) throw toError(delErr)
  return { removed: rows.length, freedBytes: rows.reduce((n, r) => n + (r.size || 0), 0), skipped: false }
}
