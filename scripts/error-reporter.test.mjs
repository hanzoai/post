import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/error-reporter.ts'],
  bundle: true,
  write: false,
  format: 'esm',
})
const modUrl = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
const { installPostErrorReporter, reportPostError, resetPostErrorReporterForTest } = await import(modUrl)

test('reportPostError sends scrubbed error events with publishable key when signed out and deduplicates', async () => {
  resetPostErrorReporterForTest()
  const origFetch = globalThis.fetch
  const origWindow = globalThis.window
  const store = new Map()
  globalThis.window = {
    location: { hostname: 'post.hanzo.ai', origin: 'https://post.hanzo.ai', pathname: '/compose' },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    addEventListener: () => {},
  }
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return new Response('{}', { status: 200 })
  }

  try {
    await reportPostError({
      type: 'TypeError',
      message: 'Failed for alice@hanzo.ai with Bearer secret_token_123456',
      stack: 'TypeError: boom\n    at Compose (https://post.hanzo.ai/assets/main.js:1:1)',
    })
    await reportPostError({
      type: 'TypeError',
      message: 'Failed for alice@hanzo.ai with Bearer secret_token_123456',
    })
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.startsWith('https://api.hanzo.ai/v1/event?ingest_key=pk-'))
    const ev = JSON.parse(calls[0].body).batch[0]
    assert.equal(ev.type, 'error')
    assert.equal(ev.product, 'post')
    assert.equal(ev.release, '0.1.3')
    assert.equal(ev.properties.release, '0.1.3')
    assert.equal(ev.site, 'post.hanzo.ai')
    assert.equal(ev.path, '/compose')
    assert.ok(!ev.error.message.includes('alice@hanzo.ai'))
    assert.ok(!ev.error.message.includes('secret_token_123456'))
  } finally {
    globalThis.fetch = origFetch
    if (origWindow === undefined) delete globalThis.window
    else globalThis.window = origWindow
  }
})

test('reportPostError prefers hanzo-release meta tag when stamped by build', async () => {
  resetPostErrorReporterForTest()
  const origFetch = globalThis.fetch
  const origWindow = globalThis.window
  const origDocument = globalThis.document
  globalThis.window = {
    location: { hostname: 'hanzo.app', origin: 'https://hanzo.app', pathname: '/post/compose' },
    addEventListener: () => {},
  }
  globalThis.document = {
    querySelector: (sel) =>
      sel === 'meta[name="hanzo-release"]'
        ? { getAttribute: (name) => (name === 'content' ? 'abcdef1234567890abcdef1234567890abcdef12' : null) }
        : null,
  }
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return new Response('{}', { status: 200 })
  }
  try {
    await reportPostError({ type: 'Error', message: 'boom' })
    assert.equal(calls.length, 1)
    const ev = JSON.parse(calls[0].body).batch[0]
    assert.equal(ev.release, 'abcdef1234567890abcdef1234567890abcdef12')
    assert.equal(ev.properties.release, 'abcdef1234567890abcdef1234567890abcdef12')
  } finally {
    globalThis.fetch = origFetch
    if (origWindow === undefined) delete globalThis.window
    else globalThis.window = origWindow
    if (origDocument === undefined) delete globalThis.document
    else globalThis.document = origDocument
  }
})

test('installPostErrorReporter attaches global error and unhandledrejection listeners once', () => {
  resetPostErrorReporterForTest()
  const origWindow = globalThis.window
  const added = []
  globalThis.window = {
    addEventListener: (type) => added.push(type),
  }
  try {
    installPostErrorReporter()
    installPostErrorReporter()
    assert.deepEqual(added, ['error', 'unhandledrejection'])
  } finally {
    if (origWindow === undefined) delete globalThis.window
    else globalThis.window = origWindow
  }
})
