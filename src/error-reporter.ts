/**
 * Lightweight, fail-soft global error reporter for Hanzo Post
 * (`post.hanzo.ai` / `social.hanzo.ai` / `hanzo.app/post`).
 *
 * Reports uncaught `window` errors and `unhandledrejection` events to Hanzo's
 * central `POST /v1/event` collector using the signed-in IAM bearer when
 * present, falling back to Hanzo's write-only publishable key (`?ingest_key=`)
 * so signed-out visitors are covered without console errors.
 */
import { bearer, subject } from './token'

const COLLECTOR_URL = 'https://api.hanzo.ai/v1/event'
const PUBLISHABLE_KEY = 'pk-CmfLA2K6kvsPflrS9DSkt06H_kSoQB_21sjedt6VJdc'
const MAX_EVENTS_PER_PAGE = 20
const DEDUP_WINDOW_MS = 60_000
const ANON_KEY = 'hanzo:post:anon'

const seen = new Map<string, number>()
let sentCount = 0
let installed = false

export function scrub(text: string): string {
  return text
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk|hk|rk|ghp|gho|ghs|github_pat)[-_]?[\w-]{12,}/g, '[redacted]')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[redacted]')
}

function anonId(): string {
  try {
    const existing = window.localStorage?.getItem(ANON_KEY)
    if (existing) return existing
    const fresh = `post_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    window.localStorage?.setItem(ANON_KEY, fresh)
    return fresh
  } catch {
    return `post_${Date.now().toString(36)}`
  }
}

const DEFAULT_RELEASE = '0.1.3'

function releaseOf(): string {
  try {
    const v = typeof document !== 'undefined'
      ? document.querySelector?.('meta[name="hanzo-release"]')?.getAttribute?.('content')?.trim()
      : ''
    if (v) return v
  } catch {
    /* ignore DOM access errors */
  }
  return DEFAULT_RELEASE
}

export function resetPostErrorReporterForTest(): void {
  seen.clear()
  sentCount = 0
  installed = false
}

export async function reportPostError(input: {
  type?: string
  message: string
  stack?: string
  handled?: boolean
}): Promise<void> {
  try {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return
    if (sentCount >= MAX_EVENTS_PER_PAGE) return

    const errType = (input.type || 'Error').slice(0, 80)
    const cleanMsg = scrub(String(input.message || 'Unknown error')).slice(0, 500)
    const cleanStack = input.stack ? scrub(String(input.stack)).slice(0, 4000) : ''

    const key = `${errType}|${cleanMsg.slice(0, 120)}`
    const now = Date.now()
    if (now - (seen.get(key) ?? 0) < DEDUP_WINDOW_MS) return
    seen.set(key, now)
    sentCount++

    const sub = subject()
    const path = scrub(window.location?.pathname || '/')
    const host = window.location?.hostname || 'post.hanzo.ai'
    const origin = window.location?.origin && window.location.origin !== 'null' ? window.location.origin : `https://${host}`
    const release = releaseOf()

    const payload = JSON.stringify({
      batch: [
        {
          messageId: `post-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'error',
          timestamp: new Date(now).toISOString(),
          distinctId: sub ?? anonId(),
          ...(sub ? { personId: sub } : {}),
          product: 'post',
          release,
          environment: 'production',
          site: host,
          url: `${origin}${path}`,
          path,
          level: 'error',
          library: '@hanzo/post',
          libraryVersion: release,
          error: {
            type: errType,
            message: cleanMsg,
            ...(cleanStack ? { stack: cleanStack } : {}),
            handled: input.handled ?? false,
          },
          properties: {
            source: 'post',
            release,
            signed_in: Boolean(bearer()),
          },
        },
      ],
    })

    const tok = bearer()
    if (tok) {
      const res = await fetch(COLLECTOR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: payload,
        keepalive: true,
      })
      if (res.ok || (res.status !== 401 && res.status !== 403)) return
    }
    await fetch(`${COLLECTOR_URL}?ingest_key=${encodeURIComponent(PUBLISHABLE_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: payload,
      keepalive: true,
    })
  } catch {
    /* fail-soft */
  }
}

export function installPostErrorReporter(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return
    const err = e.error as Error | undefined
    void reportPostError({
      type: err?.name || 'Error',
      message: err?.message || e.message || 'Uncaught error',
      stack: err?.stack,
      handled: false,
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined
    void reportPostError({
      type: r?.name || 'UnhandledRejection',
      message: r?.message || String(e.reason ?? 'Unhandled promise rejection'),
      stack: r?.stack,
      handled: false,
    })
  })
}
