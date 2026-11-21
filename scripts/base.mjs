// Mount the built bundle under /post.
//
// `hanzo serve build` writes every asset address as /assets/<name>, which is
// right at a host's root and wrong at hanzo.app/post, where /assets belongs to
// nobody the edge routes here. Every such address in the page, the scripts and
// the styles becomes /post/assets/<name>. Files keep their place in dist/:
// the edge strips /post before it reads them.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FROM = '/assets/'
export const TO = '/post/assets/'
const kinds = new Set(['.html', '.js', '.mjs', '.css', '.map'])

/** Rewrite one file's text; a file already mounted is left as it is. */
export function mount(text) {
  return text.split(TO).join(FROM).split(FROM).join(TO)
}

export function mountDir(dir) {
  let changed = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      changed += mountDir(path)
    } else if (kinds.has(extname(name))) {
      const before = readFileSync(path, 'utf8')
      const after = mount(before)
      if (after !== before) {
        writeFileSync(path, after)
        changed++
      }
    }
  }
  return changed
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || 'dist'
  const changed = mountDir(dir)
  if (!changed) throw new Error(`no file under ${dir} named ${FROM}: nothing was mounted`)
  console.log(`mounted ${changed} files under /post`)
}
