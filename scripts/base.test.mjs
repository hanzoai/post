import assert from 'node:assert/strict'
import test from 'node:test'

import { mount, stampRelease } from './base.mjs'

test('every asset address moves under /post, once', () => {
  const page = '<script src="/assets/main-AB12.js"></script><link href="/assets/main-AB12.css">'
  const out = mount(page)
  assert.equal(out, '<script src="/post/assets/main-AB12.js"></script><link href="/post/assets/main-AB12.css">')
  assert.equal(mount(out), out)
})

test('a script that builds the address at run time is moved too', () => {
  assert.equal(mount('n.p="/assets/"'), 'n.p="/post/assets/"')
  assert.equal(mount('url(/assets/font-1.woff2)'), 'url(/post/assets/font-1.woff2)')
})

test('stampRelease writes hanzo-release meta tag once and ignores invalid values', () => {
  const html = '<html><head><title>Post</title></head><body></body></html>'
  const stamped = stampRelease(html, 'abc123def456')
  assert.ok(stamped.includes('<meta name="hanzo-release" content="abc123def456">'))
  assert.equal(stampRelease(stamped, '999aaa').match(/hanzo-release/g)?.length, 1)
  assert.ok(stampRelease(stamped, '999aaa').includes('content="999aaa"'))
  assert.equal(stampRelease(html, 'bad "quote"'), html)
})
