import { describe, it, expect } from 'vitest'
import { shouldRaiseLoad, RAISE_LOAD_REPS } from './raise-load.js'

const set = (w, r, extra) => ({ w, r, done: true, ...extra })

describe('shouldRaiseLoad', () => {
  it('fires on a ticked set past 9 reps, not at 9', () => {
    expect(RAISE_LOAD_REPS).toBe(9)
    expect(shouldRaiseLoad([set(40, 10)])).toBe(true)
    expect(shouldRaiseLoad([set(40, 9)])).toBe(false)
    expect(shouldRaiseLoad([set(40, 8), set(40, 12)])).toBe(true)
  })
  it('ignores a set that is not ticked: its reps may be the plan prefilled', () => {
    expect(shouldRaiseLoad([set(40, 12, { done: false })])).toBe(false)
  })
  it('ignores warm-ups and sets with no load', () => {
    expect(shouldRaiseLoad([set(20, 15, { warmup: true })], 9, s => s.warmup === true)).toBe(false)
    expect(shouldRaiseLoad([set(0, 15)])).toBe(false)
  })
  it('reads reps and weights that arrive as strings, and survives junk', () => {
    expect(shouldRaiseLoad([set('40', '10')])).toBe(true)
    expect(shouldRaiseLoad([null, {}, set(40, undefined)])).toBe(false)
    expect(shouldRaiseLoad(undefined)).toBe(false)
  })
  it('takes another ceiling', () => {
    expect(shouldRaiseLoad([set(40, 12)], 12)).toBe(false)
    expect(shouldRaiseLoad([set(40, 13)], 12)).toBe(true)
  })
})
