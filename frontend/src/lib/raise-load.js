// "Go heavier next time": a logged work set with more than this many reps says the weight was
// too light for it. It is a nudge on screen while you train, not a rule: what the next session
// actually prescribes is still the exercise's progression policy (lib/progression.js).
export const RAISE_LOAD_REPS = 9

/**
 * Whether any ticked work set of an exercise went past `ceiling` reps with a load on the bar.
 * Warm-ups are not the weight you work at, and a row nobody ticked may still hold the plan's
 * prefilled reps. A set with no weight (a bodyweight set) has no load to raise here.
 */
export function shouldRaiseLoad(sets, ceiling = RAISE_LOAD_REPS, isWarmup = () => false) {
  if (!Array.isArray(sets)) return false
  return sets.some(s => !!s && s.done === true && !isWarmup(s) && Number(s.w) > 0 && Number(s.r) > ceiling)
}
