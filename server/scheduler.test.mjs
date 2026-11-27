import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { checkMedia, handlePostiz, mediaKind, RULES } from './postiz.mjs'

const KEY = 'hanzo-test-key'

function json(status, body) {
  const buf = Buffer.from(body == null ? '' : JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    async text() {
      return buf.toString('utf8')
    },
    async arrayBuffer() {
      return buf
    },
  }
}

function mockHanzo() {
  const posts = []
  const accounts = [
    { id: 'acct_x', provider: 'x', handle: '@hanzo', status: 'connected' },
    { id: 'acct_bluesky', provider: 'bluesky', handle: '@hanzo.bsky.social', status: 'connected' },
    { id: 'acct_linkedin', provider: 'linkedin', handle: 'Hanzo AI', status: 'connected' },
    { id: 'acct_threads', provider: 'threads', handle: '@hanzo', status: 'connected' },
    { id: 'acct_instagram', provider: 'instagram', handle: '@hanzo', status: 'connected' },
    { id: 'acct_youtube', provider: 'youtube', handle: 'Hanzo AI Channel', status: 'connected' },
    { id: 'acct_pinterest', provider: 'pinterest', handle: 'Hanzo Pins', status: 'connected' },
    { id: 'acct_tiktok', provider: 'tiktok', handle: '@hanzo', status: 'connected' },
    { id: 'acct_mastodon', provider: 'mastodon', handle: '@hanzo@mastodon.social', status: 'connected' },
    { id: 'acct_discord', provider: 'discord-webhook', handle: 'Alerts', status: 'connected' },
    { id: 'acct_telegram', provider: 'telegram-bot', handle: 'HanzoBot', status: 'connected' },
  ]
  return {
    posts,
    accounts,
    fetch(url, init) {
      const path = new URL(url).pathname
      const method = init?.method || 'GET'
      const auth = init?.headers?.authorization
      if (auth !== `Bearer ${KEY}`) {
        return json(401, { detail: 'a validated principal is required' })
      }
      if (path === '/v1/social/summary' && method === 'GET') {
        return json(200, { accounts: accounts.length, posts: posts.length, published: 0, scheduled: 0 })
      }
      if (path === '/v1/social/accounts' && method === 'GET') {
        return json(200, { data: accounts })
      }
      if (path === '/v1/social/posts' && method === 'POST') {
        const body = JSON.parse(init.body)
        const row = {
          id: `post_${posts.length + 1}`,
          ...body,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        }
        posts.push(row)
        return json(201, row)
      }
      if (path === '/v1/social/posts' && method === 'GET') {
        return json(200, { data: posts })
      }
      return json(404, { detail: `no mock for ${method} ${path}` })
    },
  }
}

function listen(mock) {
  const server = createServer((req, res) => {
    handlePostiz(req, res, { fetchImpl: mock.fetch, base: 'http://hanzo.test' }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: error.message }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port })
    })
  })
}

async function rpc(port, message) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
  })
  const body = await response.json()
  return { status: response.status, body }
}

async function scheduleCall(port, socialPost) {
  return rpc(port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'integrationSchedulePostTool',
      arguments: { socialPost },
    },
  })
}

// ============================================================================
// 1. Multi-timezone schedule queues & daylight savings transitions
// ============================================================================

test('multi-timezone schedules execute at the exact same UTC unix timestamp', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // Exact same wall-clock instant expressed across distinct timezone offsets
    // 2027-06-15T15:00:00Z (UTC)
    // 2027-06-15T17:00:00+02:00 (Paris / Berlin CEST, UTC+2)
    // 2027-06-15T11:00:00-04:00 (New York EDT, UTC-4)
    // 2027-06-15T20:30:00+05:30 (India IST, UTC+5:30)
    // 2027-06-16T00:00:00+09:00 (Tokyo JST, UTC+9, crosses midnight into next calendar day)
    const expectedUtcSeconds = Math.floor(Date.parse('2027-06-15T15:00:00.000Z') / 1000)

    const offsets = [
      '2027-06-15T15:00:00.000Z',
      '2027-06-15T17:00:00.000+02:00',
      '2027-06-15T11:00:00.000-04:00',
      '2027-06-15T20:30:00.000+05:30',
      '2027-06-16T00:00:00.000+09:00',
    ]

    for (const dateStr of offsets) {
      const res = await scheduleCall(port, [
        {
          integrationId: 'acct_x',
          type: 'schedule',
          date: dateStr,
          postsAndComments: [{ content: `Scheduled via ${dateStr}`, attachments: [] }],
        },
      ])
      assert.equal(res.status, 200)
      assert.ok(Array.isArray(res.body.result.structuredContent.output))
      const latest = mock.posts[mock.posts.length - 1]
      assert.equal(latest.status, 'scheduled')
      assert.equal(latest.scheduleAt, expectedUtcSeconds, `Failed for timezone string: ${dateStr}`)
    }
  } finally {
    server.close()
  }
})

test('daylight savings transitions (EDT vs EST, BST vs GMT) map to correct UTC hours', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // US Daylight Savings within 1-year scheduling window:
    // Summer (EDT, UTC-4): 12:00 PM local is 16:00 UTC
    // Winter (EST, UTC-5): 12:00 PM local is 17:00 UTC
    const summerUs = '2027-07-01T12:00:00-04:00'
    const winterUs = '2027-01-15T12:00:00-05:00'

    const resSummerUs = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: summerUs,
        postsAndComments: [{ content: 'US Summer EDT', attachments: [] }],
      },
    ])
    assert.equal(resSummerUs.status, 200)
    const postSummerUs = mock.posts[0]
    assert.equal(new Date(postSummerUs.scheduleAt * 1000).toISOString(), '2027-07-01T16:00:00.000Z')

    const resWinterUs = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: winterUs,
        postsAndComments: [{ content: 'US Winter EST', attachments: [] }],
      },
    ])
    assert.equal(resWinterUs.status, 200)
    const postWinterUs = mock.posts[1]
    assert.equal(new Date(postWinterUs.scheduleAt * 1000).toISOString(), '2027-01-15T17:00:00.000Z')

    // UK Daylight Savings within 1-year scheduling window:
    // Summer (BST, UTC+1): 12:00 PM local is 11:00 UTC
    // Winter (GMT, UTC+0): 12:00 PM local is 12:00 UTC
    const summerUk = '2027-07-01T12:00:00+01:00'
    const winterUk = '2027-01-15T12:00:00Z'

    const resSummerUk = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: summerUk,
        postsAndComments: [{ content: 'UK Summer BST', attachments: [] }],
      },
    ])
    assert.equal(resSummerUk.status, 200)
    const postSummerUk = mock.posts[2]
    assert.equal(new Date(postSummerUk.scheduleAt * 1000).toISOString(), '2027-07-01T11:00:00.000Z')

    const resWinterUk = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: winterUk,
        postsAndComments: [{ content: 'UK Winter GMT', attachments: [] }],
      },
    ])
    assert.equal(resWinterUk.status, 200)
    const postWinterUk = mock.posts[3]
    assert.equal(new Date(postWinterUk.scheduleAt * 1000).toISOString(), '2027-01-15T12:00:00.000Z')
  } finally {
    server.close()
  }
})

test('multi-timezone queue preserves chronological execution order in UTC', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // 3 events submitted out of order with varied local timezones:
    // Event A: 14:00 UTC (written as Tokyo 23:00 +09:00) -> 1st
    // Event B: 15:00 UTC (written as New York 11:00 -04:00) -> 2nd
    // Event C: 16:00 UTC (written as Paris 18:00 +02:00) -> 3rd
    const submissions = [
      { id: 'B', date: '2027-08-10T11:00:00-04:00', label: 'Event B (15:00 UTC)' },
      { id: 'C', date: '2027-08-10T18:00:00+02:00', label: 'Event C (16:00 UTC)' },
      { id: 'A', date: '2027-08-10T23:00:00+09:00', label: 'Event A (14:00 UTC)' },
    ]

    for (const item of submissions) {
      const res = await scheduleCall(port, [
        {
          integrationId: 'acct_x',
          type: 'schedule',
          date: item.date,
          postsAndComments: [{ content: item.label, attachments: [] }],
        },
      ])
      assert.equal(res.status, 200)
    }

    // Sort queue by scheduleAt
    const sortedQueue = [...mock.posts].sort((a, b) => a.scheduleAt - b.scheduleAt)
    assert.equal(sortedQueue[0].content, 'Event A (14:00 UTC)')
    assert.equal(sortedQueue[1].content, 'Event B (15:00 UTC)')
    assert.equal(sortedQueue[2].content, 'Event C (16:00 UTC)')
    assert.ok(sortedQueue[0].scheduleAt < sortedQueue[1].scheduleAt)
    assert.ok(sortedQueue[1].scheduleAt < sortedQueue[2].scheduleAt)
  } finally {
    server.close()
  }
})

// ============================================================================
// 2. Character limit validation per platform
// ============================================================================

test('platform character limits reject over-limit text and accept valid text', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    const platforms = [
      { integrationId: 'acct_x', name: 'X', limit: 280 },
      { integrationId: 'acct_bluesky', name: 'Bluesky', limit: 300 },
      { integrationId: 'acct_threads', name: 'Threads', limit: 500 },
      { integrationId: 'acct_mastodon', name: 'Mastodon', limit: 500 },
      { integrationId: 'acct_pinterest', name: 'Pinterest', limit: 800, media: ['https://cdn.example/pin.jpg'] },
      { integrationId: 'acct_instagram', name: 'Instagram', limit: 2200, media: ['https://cdn.example/post.jpg'] },
      { integrationId: 'acct_tiktok', name: 'TikTok', limit: 2200, media: ['https://cdn.example/video.mp4'] },
      { integrationId: 'acct_linkedin', name: 'LinkedIn', limit: 3000 },
      { integrationId: 'acct_discord', name: 'Discord', limit: 2000 },
      { integrationId: 'acct_telegram', name: 'Telegram', limit: 4096 },
      { integrationId: 'acct_youtube', name: 'YouTube', limit: 5000, media: ['https://cdn.example/yt.mp4'] },
    ]

    for (const p of platforms) {
      // 1 char over limit -> REJECTED
      const overText = 'a'.repeat(p.limit + 1)
      const overRes = await scheduleCall(port, [
        {
          integrationId: p.integrationId,
          type: 'draft',
          postsAndComments: [{ content: overText, attachments: p.media || [] }],
        },
      ])
      const errorMsg = overRes.body.result?.structuredContent?.output?.errors || ''
      assert.match(
        errorMsg,
        new RegExp(`${p.limit}`),
        `Expected ${p.name} to reject ${p.limit + 1} characters, got: ${errorMsg}`,
      )

      // Exact limit -> ACCEPTED
      const exactText = 'a'.repeat(p.limit)
      const exactRes = await scheduleCall(port, [
        {
          integrationId: p.integrationId,
          type: 'draft',
          postsAndComments: [{ content: exactText, attachments: p.media || [] }],
        },
      ])
      assert.equal(
        exactRes.status,
        200,
        `Expected ${p.name} to accept exact limit ${p.limit}, got: ${JSON.stringify(exactRes.body)}`,
      )
      assert.ok(Array.isArray(exactRes.body.result.structuredContent.output))
    }
  } finally {
    server.close()
  }
})

// ============================================================================
// 3. Media attachment validation (photo limits, video limits, mix restrictions)
// ============================================================================

test('mediaKind helper recognizes standard extensions and query parameters', () => {
  assert.equal(mediaKind('https://cdn.example.com/photo.jpg'), 'image')
  assert.equal(mediaKind('https://cdn.example.com/photo.PNG?w=800'), 'image')
  assert.equal(mediaKind('https://cdn.example.com/photo.webp#preview'), 'image')
  assert.equal(mediaKind('https://cdn.example.com/clip.mp4'), 'video')
  assert.equal(mediaKind('https://cdn.example.com/clip.MOV?token=abc'), 'video')
  assert.equal(mediaKind('https://cdn.example.com/clip.webm'), 'video')
  assert.equal(mediaKind('https://cdn.example.com/doc.pdf'), 'unknown')
  assert.equal(mediaKind('https://cdn.example.com/archive.zip'), 'unknown')
})

test('photo limits are enforced per network', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // Bluesky allows up to 4 photos; 5 photos rejected
    const fivePhotos = [1, 2, 3, 4, 5].map((i) => `https://cdn.example/photo${i}.png`)
    const resBluesky5 = await scheduleCall(port, [
      {
        integrationId: 'acct_bluesky',
        type: 'draft',
        postsAndComments: [{ content: '5 photos on Bluesky', attachments: fivePhotos }],
      },
    ])
    assert.match(resBluesky5.body.result.structuredContent.output.errors, /takes 4 photos, not 5/)

    // 4 photos on Bluesky accepted
    const fourPhotos = fivePhotos.slice(0, 4)
    const resBluesky4 = await scheduleCall(port, [
      {
        integrationId: 'acct_bluesky',
        type: 'draft',
        postsAndComments: [{ content: '4 photos on Bluesky', attachments: fourPhotos }],
      },
    ])
    assert.ok(Array.isArray(resBluesky4.body.result.structuredContent.output))

    // YouTube takes 0 images
    const resYoutubeImg = await scheduleCall(port, [
      {
        integrationId: 'acct_youtube',
        type: 'draft',
        postsAndComments: [{ content: 'YouTube image', attachments: ['https://cdn.example/thumb.jpg'] }],
      },
    ])
    assert.match(resYoutubeImg.body.result.structuredContent.output.errors, /does not take photos/)

    // Pinterest takes 5 photos; 6 photos rejected
    const sixPhotos = [1, 2, 3, 4, 5, 6].map((i) => `https://cdn.example/p${i}.jpg`)
    const resPin6 = await scheduleCall(port, [
      {
        integrationId: 'acct_pinterest',
        type: 'draft',
        postsAndComments: [{ content: '6 pins', attachments: sixPhotos }],
      },
    ])
    assert.match(resPin6.body.result.structuredContent.output.errors, /takes 5 photos, not 6/)
  } finally {
    server.close()
  }
})

test('video limits are enforced per network', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // Bluesky takes 0 video
    const resBskyVid = await scheduleCall(port, [
      {
        integrationId: 'acct_bluesky',
        type: 'draft',
        postsAndComments: [{ content: 'Video on Bluesky', attachments: ['https://cdn.example/video.mp4'] }],
      },
    ])
    assert.match(resBskyVid.body.result.structuredContent.output.errors, /does not take video/)

    // Pinterest takes 0 video
    const resPinVid = await scheduleCall(port, [
      {
        integrationId: 'acct_pinterest',
        type: 'draft',
        postsAndComments: [{ content: 'Video on Pinterest', attachments: ['https://cdn.example/video.mp4'] }],
      },
    ])
    assert.match(resPinVid.body.result.structuredContent.output.errors, /does not take video/)

    // X takes 1 video; 2 videos rejected
    const resX2Vid = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'draft',
        postsAndComments: [
          { content: '2 videos on X', attachments: ['https://cdn.example/v1.mp4', 'https://cdn.example/v2.mp4'] },
        ],
      },
    ])
    assert.match(resX2Vid.body.result.structuredContent.output.errors, /takes 1 video, not 2/)
  } finally {
    server.close()
  }
})

test('media mix restrictions (mix: false vs mix: true) are validated', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    const mixedMedia = ['https://cdn.example/photo.png', 'https://cdn.example/clip.mp4']

    // LinkedIn (mix: false) -> REJECTED
    const resLinkedIn = await scheduleCall(port, [
      {
        integrationId: 'acct_linkedin',
        type: 'draft',
        postsAndComments: [{ content: 'Mix on LinkedIn', attachments: mixedMedia }],
      },
    ])
    assert.match(
      resLinkedIn.body.result.structuredContent.output.errors,
      /On LinkedIn a video is the whole post — it cannot carry photos as well/,
    )

    // TikTok (mix: false) -> REJECTED
    const resTikTok = await scheduleCall(port, [
      {
        integrationId: 'acct_tiktok',
        type: 'draft',
        postsAndComments: [{ content: 'Mix on TikTok', attachments: mixedMedia }],
      },
    ])
    assert.match(
      resTikTok.body.result.structuredContent.output.errors,
      /On TikTok a video is the whole post — it cannot carry photos as well/,
    )

    // X (mix: true) -> ACCEPTED
    const resX = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'draft',
        postsAndComments: [{ content: 'Mix on X', attachments: mixedMedia }],
      },
    ])
    assert.ok(Array.isArray(resX.body.result.structuredContent.output))

    // Discord (mix: true) -> ACCEPTED
    const resDiscord = await scheduleCall(port, [
      {
        integrationId: 'acct_discord',
        type: 'draft',
        postsAndComments: [{ content: 'Mix on Discord', attachments: mixedMedia }],
      },
    ])
    assert.ok(Array.isArray(resDiscord.body.result.structuredContent.output))
  } finally {
    server.close()
  }
})

test('platforms with required media (needs: media or video) validate presence', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // YouTube needs video; text-only is rejected
    const resYtNoVid = await scheduleCall(port, [
      {
        integrationId: 'acct_youtube',
        type: 'draft',
        postsAndComments: [{ content: 'YouTube caption with no video', attachments: [] }],
      },
    ])
    assert.match(resYtNoVid.body.result.structuredContent.output.errors, /YouTube needs a video/)

    // YouTube with video is accepted
    const resYtWithVid = await scheduleCall(port, [
      {
        integrationId: 'acct_youtube',
        type: 'draft',
        postsAndComments: [{ content: 'YouTube video post', attachments: ['https://cdn.example/video.mp4'] }],
      },
    ])
    assert.ok(Array.isArray(resYtWithVid.body.result.structuredContent.output))

    // Instagram needs media; text-only is rejected
    const resIgNoMedia = await scheduleCall(port, [
      {
        integrationId: 'acct_instagram',
        type: 'draft',
        postsAndComments: [{ content: 'Instagram caption with no media', attachments: [] }],
      },
    ])
    assert.match(resIgNoMedia.body.result.structuredContent.output.errors, /Instagram needs a photo or a video/)

    // Instagram with photo is accepted
    const resIgWithPhoto = await scheduleCall(port, [
      {
        integrationId: 'acct_instagram',
        type: 'draft',
        postsAndComments: [{ content: 'Instagram photo post', attachments: ['https://cdn.example/photo.jpg'] }],
      },
    ])
    assert.ok(Array.isArray(resIgWithPhoto.body.result.structuredContent.output))
  } finally {
    server.close()
  }
})

// ============================================================================
// 4. Past date rejection and scheduling window limits
// ============================================================================

test('scheduler rejects dates in the past and invalid timestamps', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // Past date (e.g. 2020) -> REJECTED
    const pastRes = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: '2020-01-01T00:00:00Z',
        postsAndComments: [{ content: 'Past post', attachments: [] }],
      },
    ])
    assert.match(
      pastRes.body.result.structuredContent.output.errors,
      /A scheduled post cannot be scheduled in the past/,
    )

    // 1 hour ago -> REJECTED
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
    const recentPastRes = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: oneHourAgo,
        postsAndComments: [{ content: 'Recent past post', attachments: [] }],
      },
    ])
    assert.match(
      recentPastRes.body.result.structuredContent.output.errors,
      /A scheduled post cannot be scheduled in the past/,
    )

    // Invalid date string -> REJECTED
    const invalidDateRes = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: 'not-a-valid-date-timestamp',
        postsAndComments: [{ content: 'Invalid date post', attachments: [] }],
      },
    ])
    assert.match(
      invalidDateRes.body.result.structuredContent.output.errors,
      /A scheduled post needs date as a UTC timestamp/,
    )
  } finally {
    server.close()
  }
})

test('scheduler enforces maximum scheduling window limit (1 year in advance)', async () => {
  const mock = mockHanzo()
  const { server, port } = await listen(mock)
  try {
    // 2 years in advance -> REJECTED
    const twoYearsLater = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString()
    const farFutureRes = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: twoYearsLater,
        postsAndComments: [{ content: 'Far future post', attachments: [] }],
      },
    ])
    assert.match(
      farFutureRes.body.result.structuredContent.output.errors,
      /cannot be scheduled more than 1 year in advance/,
    )

    // 30 days in advance -> ACCEPTED
    const thirtyDaysLater = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    const validFutureRes = await scheduleCall(port, [
      {
        integrationId: 'acct_x',
        type: 'schedule',
        date: thirtyDaysLater,
        postsAndComments: [{ content: 'Valid 30 days post', attachments: [] }],
      },
    ])
    assert.equal(validFutureRes.status, 200)
    assert.ok(Array.isArray(validFutureRes.body.result.structuredContent.output))
    const created = mock.posts[0]
    assert.equal(created.status, 'scheduled')
    assert.equal(created.scheduleAt, Math.floor(Date.parse(thirtyDaysLater) / 1000))
  } finally {
    server.close()
  }
})
