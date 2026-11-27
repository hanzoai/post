// What each network will accept, checked before the post is stored.
//
// The rules are a table, and a table is exactly the kind of thing that drifts:
// a limit edited to the wrong number still typechecks and still renders. These
// cases pin the two things the composer relies on — that every network has a
// usable rule, and that a post which breaks one is refused in words a person
// can act on rather than in silence.
import test from 'node:test'
import assert from 'node:assert/strict'

import { MEDIA, check, kind, rule } from '../src/network.ts'

const PHOTO = 'https://cdn.example/a.png'
const CLIP = 'https://cdn.example/a.mp4'

test('a network the table has not met keeps the platform-wide caps', () => {
  const it = rule('somewhere-new')
  assert.equal(it.name, 'somewhere-new')
  assert.equal(it.text, 8192)
  assert.equal(it.videos, MEDIA)
  assert.equal(it.images, MEDIA)
  assert.equal(it.mix, true)
  assert.equal(it.needs, 'nothing')
})

test('every ruled network has a cap and two counts that can be satisfied', () => {
  for (const provider of ['x', 'facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'pinterest', 'reddit', 'telegram-bot', 'discord-webhook', 'slack']) {
    const it = rule(provider)
    assert.ok(it.text > 0, `${provider} has a text cap`)
    assert.ok(it.images >= 0 && it.videos >= 0, `${provider} has media counts`)
    assert.notEqual(it.name, provider, `${provider} is named for a person, not for the wire`)
  }
})

test('a post inside every limit says nothing at all', () => {
  assert.deepEqual(check('x', 'hello', []), [])
  assert.deepEqual(check('x', '', [PHOTO]), [])
  assert.deepEqual(check('instagram', 'hi', [PHOTO]), [])
  assert.deepEqual(check('youtube', 'a clip', [CLIP]), [])
})

test('a caption over the cap is refused with the count of the overflow', () => {
  assert.deepEqual(check('x', 'a'.repeat(280), []), [])
  const over = check('x', 'a'.repeat(281), [])
  assert.equal(over.length, 1)
  assert.match(over[0], /1 characters over X's limit of 280/)
})

test('the tightest network is the one quoted, not the loosest', () => {
  const long = 'a'.repeat(600)
  assert.match(check('mastodon', long, [])[0], /Mastodon's limit of 500/)
  assert.equal(check('mastodon', 'a'.repeat(500), []).length, 0)
  // The same caption is well inside a network with more room.
  assert.deepEqual(check('facebook', long, []), [])
})

test('an empty post is refused before any network rule applies', () => {
  assert.deepEqual(check('x', '', []), ['There is nothing to post.'])
  // Whitespace is not content.
  assert.deepEqual(check('x', '   ', []), ['There is nothing to post.'])
})

test('a network that needs media says so in its own name', () => {
  assert.deepEqual(check('instagram', 'hi', []), ['Instagram needs a photo or a video.'])
  assert.deepEqual(check('pinterest', 'hi', []), ['Pinterest needs a photo or a video.'])
})

test('on YouTube the video is the post, so text alone is not enough', () => {
  assert.match(check('youtube', 'hi', [])[0], /YouTube needs a video/)
  // And a photo is not a video, however many there are.
  assert.ok(check('youtube', 'hi', [PHOTO]).some((s) => /YouTube does not take photos/.test(s)))
})

test('a network that takes no video refuses one, with the noun right', () => {
  assert.deepEqual(check('bluesky', 'hi', [CLIP]), ['Bluesky does not take video.'])
  assert.deepEqual(check('pinterest', 'hi', [CLIP]), ['Pinterest does not take video.'])
})

test('more videos than the network takes is counted, not rounded', () => {
  assert.deepEqual(check('x', 'hi', [CLIP, CLIP]), ['X takes 1 video, not 2.'])
  assert.deepEqual(check('linkedin', 'hi', [CLIP, CLIP, CLIP]), ['LinkedIn takes 1 video, not 3.'])
})

test('a video and photos together are refused where the video is the whole post', () => {
  const said = check('linkedin', 'hi', [CLIP, PHOTO])
  assert.equal(said.length, 1)
  assert.match(said[0], /on LinkedIn a video is the whole post/i)
})

test('a network that takes both kinds together accepts both', () => {
  assert.deepEqual(check('x', 'hi', [CLIP, PHOTO]), [])
  assert.deepEqual(check('facebook', 'hi', [CLIP, PHOTO]), [])
})

test("the platform-wide media cap is said once, in the platform's words", () => {
  const eleven = Array.from({ length: MEDIA + 1 }, (_, i) => `https://cdn.example/${i}.png`)
  const said = check('facebook', 'hi', eleven)
  assert.ok(said.includes(`${MEDIA} media items at most.`))
  assert.equal(check('facebook', 'hi', eleven.slice(0, MEDIA)).length, 0)
})

test('an address that names neither kind is refused rather than assumed', () => {
  const said = check('x', 'hi', ['https://cdn.example/no-extension'])
  assert.equal(said.length, 1)
  assert.match(said[0], /does not say whether it is a photo or a video/)
})

test('kind() reads the extension before the query string, in any case', () => {
  assert.equal(kind(PHOTO), 'image')
  assert.equal(kind(CLIP), 'video')
  assert.equal(kind('https://cdn.example/A.PNG?x=1'), 'image')
  assert.equal(kind('https://cdn.example/clip.MOV#t=3'), 'video')
  assert.equal(kind('https://cdn.example/no-extension'), 'unknown')
  assert.equal(kind(''), 'unknown')
})

test('a refusal is written for the person, not for the log', () => {
  const said = check('x', 'a'.repeat(300), ['https://cdn.example/no-extension'])
  assert.ok(said.length >= 2)
  for (const line of said) {
    assert.ok(line.length > 0)
    assert.ok(!/undefined|NaN|\[object/.test(line), `"${line}" reads as a sentence`)
  }
})
