import assert from 'node:assert/strict'
import test from 'node:test'

import { check, kind, MEDIA, rule } from '../src/network.ts'

/**
 * Deterministic unit tests for:
 * 1. Multi-timezone & DST schedule queue ordering / UTC window filtering
 * 2. Platform-specific character-limit boundary validation
 * 3. Media attachment type, count, and mix-rule validation
 */

function toUtcMs(isoWithOffset) {
  const ms = Date.parse(isoWithOffset)
  assert.ok(Number.isFinite(ms), `Expected valid ISO-8601 timestamp: ${isoWithOffset}`)
  return ms
}

function sortScheduleQueue(items) {
  return [...items].sort((a, b) => {
    const diff = toUtcMs(a.scheduledAt) - toUtcMs(b.scheduledAt)
    return diff !== 0 ? diff : a.id.localeCompare(b.id)
  })
}

function filterScheduleWindow(items, startUtc, endUtc) {
  const start = toUtcMs(startUtc)
  const end = toUtcMs(endUtc)
  return sortScheduleQueue(items).filter((item) => {
    const t = toUtcMs(item.scheduledAt)
    return t >= start && t <= end
  })
}

test('multi-timezone schedule queue sorts chronologically by UTC instant', () => {
  const queue = [
    { id: 'post_kst', scheduledAt: '2026-06-15T18:00:00+09:00' }, // 09:00 UTC
    { id: 'post_utc', scheduledAt: '2026-06-15T08:30:00Z' },      // 08:30 UTC
    { id: 'post_est', scheduledAt: '2026-06-15T04:00:00-04:00' }, // 08:00 UTC
    { id: 'post_ist', scheduledAt: '2026-06-15T14:15:00+05:30' }, // 08:45 UTC
  ]

  const ordered = sortScheduleQueue(queue).map((item) => item.id)
  assert.deepEqual(ordered, ['post_est', 'post_utc', 'post_ist', 'post_kst'])
})

test('multi-timezone schedule queue preserves deterministic tie-breaking for identical UTC instants', () => {
  const queue = [
    { id: 'b_tokyo', scheduledAt: '2026-06-15T21:00:00+09:00' }, // 12:00 UTC
    { id: 'a_london', scheduledAt: '2026-06-15T13:00:00+01:00' }, // 12:00 UTC
    { id: 'c_ny', scheduledAt: '2026-06-15T08:00:00-04:00' },     // 12:00 UTC
  ]

  const ordered = sortScheduleQueue(queue).map((item) => item.id)
  assert.deepEqual(ordered, ['a_london', 'b_tokyo', 'c_ny'])
})

test('DST spring-forward and fall-back transitions map to exact UTC instants without drift', () => {
  // US Eastern Spring Forward: 2026-03-08 02:00 EST (-05:00) -> 03:00 EDT (-04:00)
  const beforeSpring = toUtcMs('2026-03-08T01:30:00-05:00') // 06:30 UTC
  const afterSpring = toUtcMs('2026-03-08T03:30:00-04:00')  // 07:30 UTC
  assert.equal(afterSpring - beforeSpring, 60 * 60 * 1000)

  // US Eastern Fall Back: 2026-11-01 01:30 EDT (-04:00) vs 01:30 EST (-05:00)
  const firstFall = toUtcMs('2026-11-01T01:30:00-04:00')  // 05:30 UTC
  const secondFall = toUtcMs('2026-11-01T01:30:00-05:00') // 06:30 UTC
  assert.equal(secondFall - firstFall, 60 * 60 * 1000)

  const window = filterScheduleWindow(
    [
      { id: 'fall_1', scheduledAt: '2026-11-01T01:30:00-04:00' },
      { id: 'fall_2', scheduledAt: '2026-11-01T01:30:00-05:00' },
      { id: 'outside', scheduledAt: '2026-11-01T02:30:00-05:00' },
    ],
    '2026-11-01T05:00:00Z',
    '2026-11-01T07:00:00Z',
  )
  assert.deepEqual(window.map((p) => p.id), ['fall_1', 'fall_2'])
})

test('platform character-limit boundaries accept exact limit and reject limit + 1', () => {
  const cases = [
    ['x', 280, []],
    ['bluesky', 300, []],
    ['threads', 500, []],
    ['mastodon', 500, []],
    ['pinterest', 800, ['https://cdn.example.com/pin.png']],
    ['discord-webhook', 2000, []],
    ['instagram', 2200, ['https://cdn.example.com/ig.jpg']],
    ['tiktok', 2200, ['https://cdn.example.com/tt.mp4']],
    ['linkedin', 3000, []],
    ['slack', 4000, []],
    ['telegram-bot', 4096, []],
    ['youtube', 5000, ['https://cdn.example.com/yt.mp4']],
    ['unknown-custom-network', 8192, []],
  ]

  for (const [provider, limit, media] of cases) {
    assert.equal(rule(provider).text, limit, `${provider} rule text limit`)
    assert.deepEqual(check(provider, 'a'.repeat(limit), media), [], `${provider} at exact limit`)
    const errs = check(provider, 'a'.repeat(limit + 1), media)
    assert.ok(errs.length > 0, `${provider} over limit should fail`)
    assert.match(errs[0], new RegExp(`1 characters over .*limit of ${limit}`))
  }
})

test('media kind detection handles query strings, fragments, uppercase extensions, and unknown URLs', () => {
  assert.equal(kind('https://cdn.example.com/photo.JPG?w=1200&q=80'), 'image')
  assert.equal(kind('https://cdn.example.com/banner.webp#hero'), 'image')
  assert.equal(kind('https://cdn.example.com/clip.MP4?token=abc'), 'video')
  assert.equal(kind('https://cdn.example.com/reel.webm#t=5'), 'video')
  assert.equal(kind('https://cdn.example.com/media/12345'), 'unknown')
})

test('empty content and empty media is rejected across networks', () => {
  const errs = check('x', '   \n\t  ', [])
  assert.ok(errs.some((e) => /nothing to post/i.test(e)))
})

test('YouTube requires exactly one video and rejects images or multiple videos', () => {
  assert.ok(check('youtube', 'My title', []).length > 0)
  assert.ok(check('youtube', 'My title', ['https://cdn.example.com/thumb.png']).length > 0)
  assert.deepEqual(check('youtube', 'My title', ['https://cdn.example.com/video.mp4']), [])
  assert.ok(
    check('youtube', 'My title', [
      'https://cdn.example.com/v1.mp4',
      'https://cdn.example.com/v2.mp4',
    ]).length > 0,
  )
})

test('networks with mix=false reject combining images and videos in one post', () => {
  const mixed = ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.mp4']
  for (const provider of ['linkedin', 'tiktok', 'mastodon', 'reddit']) {
    const errs = check(provider, 'hello', mixed)
    assert.ok(errs.length > 0, `${provider} should reject mixed image + video`)
  }
})

test('networks with mix=true accept images and videos within caps and enforce MEDIA cap', () => {
  assert.deepEqual(
    check('x', 'launch', [
      'https://cdn.example.com/1.png',
      'https://cdn.example.com/2.png',
      'https://cdn.example.com/clip.mp4',
    ]),
    [],
  )

  const tooMany = Array.from({ length: MEDIA + 1 }, (_, i) => `https://cdn.example.com/${i}.png`)
  assert.ok(check('instagram', 'carousel', tooMany).length > 0)
})
