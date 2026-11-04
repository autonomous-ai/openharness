import { LAUNCH_ERROR_CODES, LAUNCH_ERROR_FAMILIES, PRODUCT_FEEDBACK, PRODUCT_FEEDBACK_REASONS, PRODUCT_FEEDBACK_OUTCOMES, PRODUCT_USAGE_ACTIONS, PRODUCT_USAGE_ADD_PHONE_OPENINGS, PRODUCT_USAGE_AUTOMATIC_ACTIONS, PRODUCT_USAGE_FLOWS, PRODUCT_USAGE_LONG_FLOWS, PRODUCT_USAGE_LONG_MEASURES, PRODUCT_USAGE_ONBOARDING_MARKS, PRODUCT_USAGE_PHONE_OFFER_SKIP_REASONS, PRODUCT_USAGE_SETUP_FLOWS, PRODUCT_USAGE_SIGN_IN_END_REASONS, PRODUCT_USAGE_SURFACES, PRODUCT_USAGE_UI_SURFACES, PRODUCT_USAGE_USER_OPENED_ACTIONS } from '../types/productUsage.js'
import { DAILY_PRODUCT_METRICS } from './dailyProductUsage.js'

type Row = { dayUtc: Date; metric: string; value: number }
const DAY = 86400000
const dayKey = (stamp: number) => new Date(stamp).toISOString().slice(0, 10)
const rate = (n: number, d: number) => d > 0 && n >= 0 && n <= d ? Math.round(n / d * 1000) / 10 : null
const sum = (c: Record<string, number>, names: string[]) => names.reduce((n, key) => n + (c[key] ?? 0), 0)

/** Descriptive triage, not an automatic verdict or a causal claim about the latest release. */
export function dailyProductReview(rows: Row[], now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const byDay = new Map<string, Record<string, number>>()
  for (const row of rows) {
    if (!DAILY_PRODUCT_METRICS.includes(row.metric as typeof DAILY_PRODUCT_METRICS[number]) || !Number.isSafeInteger(row.value) || row.value < 0) continue
    const key = row.dayUtc.toISOString().slice(0, 10), c = byDay.get(key) ?? {}
    c[row.metric] = (c[row.metric] ?? 0) + row.value; byDay.set(key, c)
  }
  const window = (from: number, until: number) => {
    const counters: Record<string, number> = {}
    let observedDays = 0
    for (let day = from; day < until; day += DAY) {
      const c = byDay.get(dayKey(day))
      if (!c) continue
      if ((c.active_installation_days ?? 0) > 0 || (c.working_installation_days ?? 0) > 0 || (c.measurement_v2_installation_days ?? 0) > 0) observedDays++
      for (const [k, n] of Object.entries(c)) counters[k] = (counters[k] ?? 0) + n
    }
    return { from: dayKey(from), untilExclusive: dayKey(until), observedDays, counters }
  }
  const recent = window(today - 7 * DAY, today), baseline = window(today - 14 * DAY, today - 7 * DAY)
  const comparison = (name: string, numerator: string[], denominator: string[]) => {
    const side = (w: typeof recent) => {
      const n = sum(w.counters, numerator), d = sum(w.counters, denominator)
      return { numerator: n, denominator: d, percent: rate(n, d), observedDays: w.observedDays }
    }
    const current = side(recent), previous = side(baseline)
    return { name, current, previous,
      differencePercentagePoints: current.percent !== null && previous.percent !== null ? Math.round((current.percent - previous.percent) * 10) / 10 : null,
      evidence: current.denominator < 20 || previous.denominator < 20 || recent.observedDays < 7 || baseline.observedDays < 7
        ? 'Sparse or incomplete; inspect individual synthetic reproductions, do not claim a trend.'
        : 'Descriptive comparison only. Repeated work is not independent sampling; releases, adoption and population changes can confound it.',
    }
  }
  const comparisons = [
    comparison('Observed new-harness launch failure', ['launch_failed'], ['launch_created', 'launch_failed']),
    comparison('First response took at least one minute', ['response_1m_to_5m', 'response_over_5m'],
      ['response_under_10s', 'response_10s_to_1m', 'response_1m_to_5m', 'response_over_5m']),
    comparison('Matched turn ended without an observed text response', ['turns_ended_without_response'], ['turns_ended', 'turns_interrupted']),
    comparison('Matched turn interrupted', ['turns_interrupted'], ['turns_ended', 'turns_interrupted']),
    comparison('Useful among voluntary feedback responses', ['feedback_useful'], PRODUCT_FEEDBACK_REASONS.map(a => `feedback_${a}`)),
    comparison('Completed among voluntary task-outcome responses', ['feedback_completed'], PRODUCT_FEEDBACK_OUTCOMES.map(a => `feedback_${a}`)),
    ...PRODUCT_USAGE_ACTIONS.map(action => comparison(`${action}: request refusal`, [`${action}_failed`], [`${action}_ok`, `${action}_failed`])),
  ]
  const c = recent.counters
  // The fixed codes counted beside an `other` total, most frequent first: production had 23 of 25 launch failures
  // as `other` on 2026-10-16 with nothing to say which. Codes only; there is no message to look up.
  const topCodes = (family: typeof LAUNCH_ERROR_FAMILIES[number]) => LAUNCH_ERROR_CODES
    .map(code => ({ code, count: c[`${family}_${code}`] ?? 0 })).filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 5)
  const marksOf = (prefix: string) => {
    const marks = PRODUCT_USAGE_ONBOARDING_MARKS.filter(metric => metric.startsWith(prefix))
    return marks.length ? { marks: Object.fromEntries(marks.map(metric => [metric.slice(prefix.length), c[metric] ?? 0])) } : {}
  }
  const signals = [
    { area: 'Agent setup', count: c.launch_failed_setup ?? 0, next: 'Reproduce a first launch on a clean machine; verify engine installation, tmux and native hook preparation.' },
    { area: 'Sign-in or permission', count: c.launch_failed_auth ?? 0, next: 'Exercise expired sign-in and reconnect with a test account; verify recovery and the visible explanation.' },
    { area: 'Dependency availability', count: c.launch_failed_unavailable ?? 0, next: 'Test an unavailable model/service and recovery; verify that a saved launch starts exactly once.' },
    { area: 'Launch choices', count: c.launch_failed_invalid ?? 0, next: 'Reproduce invalid project/model selections with fixtures; verify validation before starting work.' },
    { area: 'Unknown launch refusal', count: c.launch_failed_other ?? 0, codes: topCodes('launch_failed_code'), next: 'Reproduce the most frequent codes with launch failure fixtures and add a justified fixed category; `unlisted` is a code missing from LAUNCH_ERROR_CODES. Do not retrieve user error messages.' },
    { area: 'Engine did not start after create', count: c.launch_late_failed ?? 0, codes: topCodes('launch_late_failed_code'), next: 'Reproduce an engine that exits, is missing or never shows its process in a new pane; these launches are also counted as created.' },
    { area: 'Response wait', count: c.turns_waiting_over_1m ?? 0, next: 'Benchmark the same synthetic task and toolchain before/after; separate model wait from Harness overhead locally.' },
    { area: 'No observed response', count: c.turns_ended_without_response ?? 0, next: 'Reproduce interruptions, provider failures and tool-only turns; a missing text event alone does not establish task failure.' },
    { area: 'Launch outcome coverage', count: (c.launch_unobserved ?? 0) + (c.launch_unconfirmed ?? 0), next: 'Verify receipt polling, window close and daemon restart; unknown outcomes must not be counted as failed launches.' },
  ].filter(s => s.count > 0).sort((a, b) => b.count - a.count)
  const retention = [1, 7, 28].map(lag => {
    const cohorts = Array.from({ length: 7 }, (_, i) => {
      const stamp = today - (lag + 7 - i) * DAY, cohort = byDay.get(dayKey(stamp)) ?? {}
      const denominator = cohort.working_installation_days ?? 0
      const followUpObserved = (byDay.get(dayKey(stamp + lag * DAY))?.working_installation_days ?? 0) > 0
      // Older collectors reported work but had no D28 counter. Their missing metric is unknown, not zero retention.
      const measurementAvailable = lag !== 28 || (cohort.measurement_v2_installation_days ?? 0) > 0
      const returned = denominator && followUpObserved && measurementAvailable ? cohort[`d${lag}_returning_work_installations`] ?? 0 : null
      return { day: dayKey(stamp), workingInstallations: denominator || null, returned, measurementAvailable,
        percent: returned === null ? null : rate(returned, denominator) }
    })
    return { day: lag, definition: `Observed work on both the cohort's UTC day and UTC day +${lag}. Installation counts, not people.`, cohorts }
  })
  const month = new Date(today)
  const monthStart = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)
  const priorStart = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)
  const earlierStart = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 2, 1)
  const completeMonth = window(priorStart, monthStart), previousMonth = window(earlierStart, priorStart)
  const monthDenominator = previousMonth.counters.monthly_working_installations ?? 0
  const monthReturn = completeMonth.counters.monthly_returning_installations ?? 0
  return {
    monthlyRetention: { from: completeMonth.from, untilExclusive: completeMonth.untilExclusive,
      previousWorkingInstallations: monthDenominator || null,
      returningInstallations: monthDenominator && completeMonth.counters.monthly_working_installations ? monthReturn : null,
      percent: completeMonth.counters.monthly_working_installations ? rate(monthReturn, monthDenominator) : null,
      definition: 'Participating installations with work in two consecutive complete UTC calendar months; late uploads and measurement rollout affect coverage.',
    },
    // hn has app flows but no signed-out setup channel.
    flows: ['setup', 'ui'].flatMap(channel => ((channel === 'setup' ? PRODUCT_USAGE_SURFACES : PRODUCT_USAGE_UI_SURFACES) as readonly string[]).flatMap(surface => PRODUCT_USAGE_FLOWS
      .filter(flow => channel !== 'setup' || (PRODUCT_USAGE_SETUP_FLOWS as readonly string[]).includes(flow))
      .map(flow => {
        const prefix = `${channel}_${surface}_${flow}_`
        const started = c[`${prefix}started`] ?? null
        const observed = ['ok', 'failed', 'cancelled', 'unknown'].reduce((n, outcome) => n + (c[`${prefix}${outcome}`] ?? 0), 0)
        return { channel, surface, flow, started,
          outcomes: Object.fromEntries(['ok', 'failed', 'cancelled', 'unknown'].map(outcome => [outcome, c[`${prefix}${outcome}`] ?? (started ? 0 : null)])),
          unmatchedStarts: started === null ? null : Math.max(0, started - observed),
          durationBuckets: Object.fromEntries(['under_1s', '1s_to_10s', '10s_to_1m', 'over_1m'].map(bucket => [bucket, c[`${prefix}${bucket}`] ?? (started ? 0 : null)])),
          // The phone's onboarding: over_1m split further, and what happened on the way (once per sign-in).
          ...(channel === 'ui' && surface === 'phone' && (PRODUCT_USAGE_LONG_FLOWS as readonly string[]).includes(flow)
            ? { over1mBuckets: Object.fromEntries(PRODUCT_USAGE_LONG_MEASURES.map(bucket => [bucket, c[`${prefix}${bucket}`] ?? (started ? 0 : null)])) } : {}),
          ...(channel === 'ui' ? marksOf(prefix) : {}),
          // Beside the Desktop's signed-out sign-in: why each one that did not go through ended.
          ...(channel === 'setup' && surface === 'desktop' && flow === 'sign_in'
            ? { endReasons: Object.fromEntries(PRODUCT_USAGE_SIGN_IN_END_REASONS.map(reason => [reason, c[`setup_desktop_sign_in_reason_${reason}`] ?? 0])) } : {}),
          // Beside the Desktop's card: openings, new phones by opening, and reasons a card did not show.
          ...(channel === 'ui' && surface === 'desktop' && flow === 'phone_offer'
            ? { addPhoneOpenings: Object.fromEntries(PRODUCT_USAGE_ADD_PHONE_OPENINGS.map(opening => [opening, c[`ui_desktop_add_phone_${opening}`] ?? 0])),
              addPhonePaired: Object.fromEntries(PRODUCT_USAGE_ADD_PHONE_OPENINGS.map(opening => [opening, c[`ui_desktop_add_phone_paired_${opening}`] ?? 0])),
              phoneOfferSkipped: Object.fromEntries(PRODUCT_USAGE_PHONE_OFFER_SKIP_REASONS.map(reason => [reason, c[`ui_desktop_phone_offer_skipped_${reason}`] ?? 0])) } : {}),
          interpretation: channel === 'setup'
            ? 'Optional signed-out app-session counts, untrusted and self-selected. No cross-step linkage, unique people or signup conversion. Web pre-sign-in is not collected.'
            : 'Observed app operations, possibly automatic. Missing outcomes include closed apps, offline reports and choice changes; absence is not failure. Viewer opening is not page rendering; update staging is not successful relaunch.',
        }
      }))),
    recent: { from: recent.from, untilExclusive: recent.untilExclusive, observedDays: recent.observedDays },
    baseline: { from: baseline.from, untilExclusive: baseline.untilExclusive, observedDays: baseline.observedDays },
    comparisons, investigate: signals, retention,
    firstLaunchCohorts: {
      definition: 'Participating installations after their first measured new-harness launch attempt. Work/response within 24 hours, counted locally on the original launch day. This is not signup activation or a same-task success rate; updated existing users are included.',
      cohorts: Array.from({ length: 7 }, (_, i) => {
        // A full UTC launch day needs the following UTC day to finish its 24-hour windows.
        const day = dayKey(today - (8 - i) * DAY), c = byDay.get(day) ?? {}
        const starts = c.first_launch_installations ?? 0
        const working = starts ? c.first_launch_work_24h_installations ?? 0 : null
        const responding = starts ? c.first_launch_response_24h_installations ?? 0 : null
        return { day, firstLaunchInstallations: starts || null, workingWithin24h: working, respondingWithin24h: responding,
          observedResponsePercent: responding === null ? null : rate(responding, starts) }
      }),
      caveat: 'No observed response is not proof of failure. Opt-outs, disconnected clients, late uploads and resets can reduce follow-up coverage.',
    },
    firstUse: { firstMeasuredWork: c.first_work_installations ?? null, firstObservedResponse: c.first_response_installations ?? null,
      launchAttempts: c.launch_started ?? null, observedLaunchesCreated: c.launch_created ?? null,
      interpretation: 'Post-sign-in first-use signals; these stage counts are not one signup cohort or a signup conversion rate. Already installed clients enter measurement when updated.' },
    feedback: Object.fromEntries(PRODUCT_FEEDBACK.map(answer => [answer, c[`feedback_${answer}`] ?? 0])),
    features: PRODUCT_USAGE_ACTIONS.map(action => {
      // The apps make these reads on their own; clients before the split still send their reach. The
      // Store and model lists are also opened by people, and only those requests carry reach (`_user_`).
      const automatic = PRODUCT_USAGE_AUTOMATIC_ACTIONS.includes(action)
      const opened = (PRODUCT_USAGE_USER_OPENED_ACTIONS as readonly string[]).includes(action)
      const reach = (measure: string) => opened ? c[`${action}_user_${measure}`] ?? null
        : automatic ? null : c[`${action}_${measure}`] ?? null
      return { action, automatic, requests: c[`${action}_requests`] ?? 0,
        userRequests: opened ? c[`${action}_user_requests`] ?? 0 : null,
        installationDays: reach('installation_days'),
        firstMeasuredInstallations: reach('first_installations'),
        repeatInstallationDays: reach('repeat_installation_days'),
        interpretation: opened
          ? 'Also requested by the apps on their own: requests are reliability only. userRequests and reach count only a person opening the list (apps that mark it); reach is installation-days, a lower bound.'
          : automatic
          ? 'Requested by the apps on their own (after updates, on connect, for previews): reliability and latency only, not feature use.'
          : 'An operation was requested, possibly automatically. Reach is installation-days, not unique people, UI clicks or successful feature use.',
      }
    }),
    measurementHealth: { updatedInstallationDays: c.measurement_v2_installation_days ?? null,
      queuePruning: c.measurement_queue_pruned ?? 0, turnObservationOverflow: c.turn_observation_overflow ?? 0,
      interpretation: 'Loss signals establish incomplete coverage; no loss signal does not prove complete collection.',
    },
    gaps: [
      'Signed-out setup/sign-in counts cover only explicitly participating native app sessions. Stage totals are not a linked funnel; web, app closures and privacy choices leave gaps. Test those paths synthetically.',
      'Durable launch outcomes require observed receipt replies; status polling adds no attempts. Missing outcomes, restarts and the 15-minute observation bound reduce coverage.',
      'Human and automated work are combined. App-open time is not productive use; technical completion is not task success.',
      'Feedback is voluntary and self-selected, not a representative satisfaction survey or a success rate for all tasks.',
      'Late reports, opt-outs, reinstallations and preference resets affect return counts. Today and immature return cohorts are excluded here.',
    ],
    nextReview: [
      'Choose one observed friction and write a falsifiable hypothesis, target metric, guardrails and comparison window before changing code.',
      'Reproduce with synthetic inputs, profile or benchmark the same workload, then add a regression test and review the fix.',
      'Record the released commit and rollout time. Compare matured equal-length windows; inspect participation changes and competing releases.',
      'Keep, revise or revert based on evidence. With little data, report uncertainty and continue observing instead of declaring a win.',
    ],
  }
}
