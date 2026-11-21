import assert from 'node:assert/strict'
import test from 'node:test'

import { mount } from './base.mjs'

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
