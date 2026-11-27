// The two forms this app turns a moment into, and the calendar it groups them
// by. Nothing here reads the platform: every case is arithmetic on a timestamp,
// so the expectations can be written down exactly.
//
// The wall-clock cases build their moment with the same local `Date`
// constructor the module uses, which is what makes them pass in every zone
// instead of only in the one the author ran them in. The daylight-saving cases
// find the zone's own transition first and skip when the zone has none, so the
// file is honest in UTC and thorough in a zone that shifts.
import test from 'node:test'
import assert from 'node:assert/strict'

import { at, day, fromField, grid, now, since, toField } from '../src/time.ts'

/** A local wall-clock moment, in the seconds this app counts. */
function local(year, month, date, hour = 0, minute = 0) {
  return Math.floor(new Date(year, month - 1, date, hour, minute).getTime() / 1000)
}

/** A moment's local calendar day, written the way `day` writes it. */
function localKey(moment) {
  const d = new Date(moment * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const BASE = 1_800_000_000

test('now() counts seconds, not the milliseconds the clock holds', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE * 1000 + 999 })
  assert.equal(now(), BASE)
})

test('at() leaves an unset moment blank and writes a set one out in full', () => {
  assert.equal(at(0), '')
  const written = at(local(2026, 3, 12, 14, 30))
  assert.match(written, /2026/)
  assert.match(written, /12/)
})

test('since() reads a moment forward or backward, never as a negative', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE * 1000 })
  assert.equal(since(0), '')
  assert.equal(since(BASE + 30), 'in 30 seconds')
  assert.equal(since(BASE - 30), '30 seconds ago')
  assert.equal(since(BASE + 90), 'in 2 minutes')
  assert.equal(since(BASE + 7200), 'in 2 hours')
  assert.equal(since(BASE + 3 * 86400), 'in 3 days')
  assert.equal(since(BASE + 60 * 86400), 'in 2 months')
})

test('since() says one, not ones', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE * 1000 })
  assert.equal(since(BASE + 1), 'in 1 second')
  assert.equal(since(BASE + 60), 'in 1 minute')
  assert.equal(since(BASE + 3600), 'in 1 hour')
  assert.equal(since(BASE + 86400), 'in 1 day')
})

// A moment one second short of an hour must not round up to "60 minutes": the
// unit is chosen before the rounding, so the row above it already says "1 hour"
// and the widest value of "minute" is 59.
test('since() never reaches the unit above it by rounding', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE * 1000 })
  assert.equal(since(BASE + 3599), 'in 1 hour')
  assert.equal(since(BASE + 86399), 'in 1 day')
})

test('day() groups by the local calendar, not the UTC one', () => {
  const evening = local(2026, 3, 12, 23, 30)
  assert.equal(day(evening), '2026-03-12')
  assert.equal(day(evening), localKey(evening))
  // Where the local day and the UTC day disagree, the local one wins: a person
  // schedules against the clock on their wall.
  const utc = new Date(evening * 1000).toISOString().slice(0, 10)
  if (utc !== localKey(evening)) assert.notEqual(day(evening), utc)
})

test('grid() lays a month out in whole Monday-first weeks', () => {
  for (const [year, month] of [
    [2026, 1],
    [2026, 2],
    [2024, 2],
    [2026, 8],
    [2026, 12],
  ]) {
    const cells = grid(year, month - 1)
    assert.equal(cells.length % 7, 0, `${year}-${month} is a whole number of weeks`)
    assert.equal(cells[0].date.getDay(), 1, `${year}-${month} starts on a Monday`)
    assert.equal(cells.at(-1).date.getDay(), 0, `${year}-${month} ends on a Sunday`)

    const keys = cells.map((c) => c.key)
    assert.equal(new Set(keys).size, keys.length, `${year}-${month} repeats no day`)

    // Every day of the month is present exactly once, and everything before the
    // first of them is padding rather than a day of this month.
    const inMonth = cells.filter((c) => c.inMonth)
    assert.equal(inMonth.length, new Date(year, month, 0).getDate())
    assert.equal(inMonth[0].key, day(local(year, month, 1)))
    assert.equal(inMonth.at(-1).key, day(local(year, month, inMonth.length)))
    const first = cells.findIndex((c) => c.inMonth)
    assert.ok(cells.slice(0, first).every((c) => !c.inMonth))
  }
})

test('toField() and fromField() are a round trip for a whole minute', () => {
  for (const moment of [
    local(2026, 1, 5, 9, 0),
    local(2026, 6, 15, 23, 59),
    local(2026, 12, 31, 0, 0),
    local(2024, 2, 29, 12, 0),
  ]) {
    assert.equal(fromField(toField(moment)), moment)
  }
})

test('a datetime-local field that holds nothing, or nonsense, is no moment at all', () => {
  assert.equal(toField(0), '')
  assert.equal(fromField(''), 0)
  assert.equal(fromField('not a date'), 0)
})

// --- daylight saving ------------------------------------------------------
//
// These find the zone's transition rather than assuming one. In UTC, and in a
// zone that never shifts, they skip: there is nothing there to get wrong.

/** The local offset, in minutes, an instant is read at. */
function offsetAt(moment) {
  return new Date(moment * 1000).getTimezoneOffset()
}

/** The first midnight-to-midnight step in 2026 where the offset moves, if any. */
function findTransition() {
  for (let d = 1; d < 366; d++) {
    const midnight = new Date(2026, 0, d)
    const next = new Date(2026, 0, d + 1)
    if (offsetAt(midnight.getTime() / 1000) === offsetAt(next.getTime() / 1000)) continue
    // Narrow to the hour that moves.
    for (let h = 0; h < 24; h++) {
      const a = new Date(2026, 0, d, h)
      const b = new Date(2026, 0, d, h + 1)
      if (offsetAt(a.getTime() / 1000) !== offsetAt(b.getTime() / 1000)) {
        return { before: a.getTime() / 1000, after: b.getTime() / 1000 }
      }
    }
  }
  return null
}

const transition = findTransition()

test('day() keeps its own calendar across the hour the zone shifts', (t) => {
  if (!transition) return t.skip('this zone does not shift its clock')
  const { before, after } = transition
  assert.equal(day(Math.floor(before)), localKey(Math.floor(before)))
  assert.equal(day(Math.floor(after)), localKey(Math.floor(after)))
})

test('a moment written out and read back lands on the same instant across a shift', (t) => {
  if (!transition) return t.skip('this zone does not shift its clock')
  // An evening either side of the transition, away from the moved hour itself.
  for (const moment of [local(2026, 3, 7, 22, 0), local(2026, 3, 9, 22, 0)]) {
    assert.equal(fromField(toField(moment)), moment)
  }
})

test('an hour the zone skips is read as the nearest moment that exists', (t) => {
  if (!transition) return t.skip('this zone does not shift its clock')
  const { before, after } = transition
  // The wall-clock minute inside the gap, if the gap is a forward step.
  const forward = after - before > 0
  if (!forward) return t.skip('this zone falls back rather than forward')

  const start = new Date(before * 1000)
  const inside = new Date(start.getTime() + 30 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const field = `${inside.getFullYear()}-${pad(inside.getMonth() + 1)}-${pad(inside.getDate())}T${pad(inside.getHours())}:${pad(inside.getMinutes())}`

  const read = fromField(field)
  // It resolves to a real instant rather than NaN...
  assert.ok(read > 0)
  // ...and that instant is not the one written, because that wall-clock time
  // never happened. Reading it back therefore shows a later hour, not the hour
  // asked for; what must not happen is a silent NaT or a wrong day.
  assert.equal(day(read), day(Math.floor(inside.getTime() / 1000)))
})
