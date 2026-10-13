// The Supabase project the app signs in to and syncs with. Configured by two build-time
// variables (frontend/.env.local, see supabase/schema.sql for the tables). Without them the app
// keeps talking to the openGym API exactly as before; tests never use it.
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const SUPABASE_ON = !!(url && key) && import.meta.env.MODE !== 'test'
export const supabase = SUPABASE_ON
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null
