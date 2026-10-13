// Sign-in screen for the Supabase build: e-mail and password, a new account, a reset link.
// It ends exactly where the passkey sign-in did (Login.jsx): setUser, then adoptProfile for an
// account coming back, or the device's data pushed into a new one.
import { useState } from 'react'
import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { supabase } from '../lib/supabase.js'
import { userOf } from '../lib/supabase-api.js'
import { askAddDeviceData } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

export const MIN_PASSWORD = 8
const toast = m => useUI.getState().toast(m)

// The refusals worth a sentence of their own; anything else is shown as Supabase worded it.
export function authError(e) {
  const m = String(e?.message || '')
  if (/invalid login credentials/i.test(m)) return t('Wrong e-mail or password.')
  if (/email not confirmed/i.test(m)) return t('Confirm your e-mail first, then sign in.')
  if (/already registered|already been registered/i.test(m)) return t('Another profile already uses this e-mail address.')
  if (/password should be at least|weak/i.test(m)) return t('Use at least {0} characters.', MIN_PASSWORD)
  if (/rate limit|too many/i.test(m)) return t('Too many attempts. Try again in a few minutes.')
  return m || t('Sign-in failed')
}

export default function SupabaseAuth() {
  const [mode, setMode] = useState('in')   // 'in' | 'up' | 'reset'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async e => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) { setErr(t('Enter your e-mail')); return }
    if (mode !== 'reset' && password.length < MIN_PASSWORD) { setErr(t('Use at least {0} characters.', MIN_PASSWORD)); return }
    setBusy(true); setErr('')
    try {
      const st = useStore.getState()
      if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo: window.location.origin })
        if (error) throw error
        toast(t('If that address has a profile, a reset link is on its way.'))
        setMode('in')
      } else if (mode === 'in') {
        const { data, error } = await supabase.auth.signInWithPassword({ email: addr, password })
        if (error) throw error
        const u = userOf(data.user)
        st.setUser(u, { adopt: true })
        await st.adoptProfile(askAddDeviceData)
        toast(t('Welcome back, {0}', u.name))
      } else {
        const { data, error } = await supabase.auth.signUp({ email: addr, password, options: { data: { name: name.trim() } } })
        if (error) throw error
        if (!data.session) { toast(t('Check your e-mail to confirm the profile, then sign in.')); setMode('in'); return }
        const u = userOf(data.user)
        st.setUser(u)
        if (hasData(useStore.getState().S)) { await st.pushState(); toast(t('Profile created, and this device’s data moved into it')) }
        else { await st.pullState(); toast(t('Welcome, {0}', u.name)) }
      }
    } catch (x) { setErr(authError(x)) }
    finally { setBusy(false) }
  }

  const title = mode === 'up' ? t('Create new profile') : mode === 'reset' ? t('Reset password') : t('Sign in')
  return (
    <div className="narrow" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }}>
      <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
      <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>openGym</h1>
      <div className="muted" style={{ marginBottom: 26 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      <form onSubmit={submit} style={{ textAlign: 'start' }}>
        <h3 style={{ margin: '0 0 12px' }}>{title}</h3>
        {mode === 'up' && <>
          <input className="input" placeholder={t('Your name')} maxLength={40} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          <div style={{ height: 10 }} />
        </>}
        <input className="input" type="email" placeholder={t('E-mail')} autoComplete="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} />
        {mode !== 'reset' && <>
          <div style={{ height: 10 }} />
          <input className="input" type="password" placeholder={t('Password')} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} />
        </>}
        {err && <div className="small" role="alert" style={{ color: 'var(--red)', marginTop: 10 }}>{err}</div>}
        <div style={{ height: 14 }} />
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t('Please wait…') : title}</Button>
      </form>
      <div style={{ height: 10 }} />
      {mode !== 'in' && <Button variant="ghost" className="dim" onClick={() => { setMode('in'); setErr('') }}>{t('Sign in')}</Button>}
      {mode === 'in' && <>
        <Button icon="plusCircle" onClick={() => { setMode('up'); setErr('') }}>{t('Create new profile')}</Button>
        <Button variant="ghost" className="dim" onClick={() => { setMode('reset'); setErr('') }}>{t('Forgot your password?')}</Button>
      </>}
    </div>
  )
}
