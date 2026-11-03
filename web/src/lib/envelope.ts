import type { EnvelopeRequest, ProposalEvent } from './protocol'

export const STEP_OPTIONS = [50, 100, 150, 200] as const
export const DEFAULT_STEP = 150

/** Envelope pre-filled from the proposal: the feasible band that holds the proposed speed (else the first). */
export function defaultEnvelope(p: ProposalEvent | null): EnvelopeRequest {
  const bands = p?.feasible_band_rpm ?? []
  const target = p?.proposed.speed_rpm
  const band = bands.find(([a, b]) => target != null && target >= a && target <= b) ?? bands[0]
  if (band) return { lo_rpm: Math.round(band[0]), hi_rpm: Math.round(band[1]), max_step_rpm: DEFAULT_STEP, approved: true }
  const c = p?.current.speed_rpm ?? 1200
  const n = p?.proposed.speed_rpm ?? c
  return { lo_rpm: Math.round(Math.min(c, n) - 100), hi_rpm: Math.round(Math.max(c, n) + 100), max_step_rpm: DEFAULT_STEP, approved: true }
}
