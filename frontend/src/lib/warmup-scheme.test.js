import { describe, it, expect } from 'vitest'
import { buildSets, rerampWarmups, newExerciseConfig, WARMUP_SCHEME } from './history.js'
import { warmupRestSecFor } from './supersetFlow.js'
import { isWarmupRow } from './workout-model.js'

const S = { unit: 'kg', routines: [], history: [], workouts: [] }
const cfg = { id: 'bench', sets: 3, reps: 9, repsMin: 5, weight: 80, mode: 'reps', warmupSets: 2 }

describe('warm-up scheme', () => {
  it('builds 50% x 8 then 80% x 3 before the work sets', () => {
    const rows = buildSets(S, cfg, { step: 2.5 })
    const warm = rows.filter(isWarmupRow)
    expect(warm.map(r => [r.w, r.r, r.restSec])).toEqual([[40, 8, 15], [62.5, 3, 30]])
    expect(rows.slice(2).every(r => !isWarmupRow(r))).toBe(true)
  })
  it('never goes under the bar', () => {
    const rows = buildSets({ ...S, bars: {} }, { ...cfg, weight: 30 }, { step: 2.5 })
    expect(rows.filter(isWarmupRow).every(r => r.w <= 30)).toBe(true)
  })
  it('keeps the old halving ramp past two warm-ups', () => {
    const rows = buildSets(S, { ...cfg, warmupSets: 3 }, { step: 2.5 })
    expect(rows.filter(isWarmupRow).map(r => r.w)).toEqual([40, 60, 70])
  })
  it('re-ramps by percentage when the work weight changes', () => {
    const rows = buildSets(S, cfg, { step: 2.5 }).map(r => (isWarmupRow(r) ? r : { ...r, w: 100 }))
    expect(rerampWarmups(rows, 2.5, 0).filter(isWarmupRow).map(r => r.w)).toEqual([50, 80])
  })
  it('rests 15 s after the first and 30 s after the second warm-up', () => {
    const entry = { sets: buildSets(S, cfg, { step: 2.5 }), target: {} }
    expect(warmupRestSecFor(entry, 0, 120)).toBe(15)
    expect(warmupRestSecFor(entry, 1, 120)).toBe(30)
    expect(warmupRestSecFor(entry, 2, 120)).toBe(120)
  })
  it('a new loaded exercise starts with 5 to 9, 2 min and two warm-ups', () => {
    expect(newExerciseConfig('barbell-bench-press')).toMatchObject({ reps: 9, repsMin: 5, prog: 'double', restSec: 120, warmupSets: WARMUP_SCHEME.length })
  })
})

import { warmupFirstPerMuscle } from './session-start.js'
describe('warm-up only on the first exercise of each muscle', () => {
  const groups = { a: 'chest', b: 'chest', c: 'back', d: null, e: null }
  const out = warmupFirstPerMuscle(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, warmupSets: 2 })), c => groups[c.id])
  it('keeps the first of a muscle and drops the repeats', () => {
    expect(out.map(c => c.warmupSets)).toEqual([2, 0, 2, 2, 2])
  })
  it('leaves exercises with no muscle on record alone', () => {
    expect(out[3].warmupSets).toBe(2)
  })
})
