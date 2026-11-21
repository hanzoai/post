/**
 * Where this app is mounted: hanzo.app/post. The router, the sign-in return
 * and every address the app hands to another window are built from it, so the
 * mount is stated once. `scripts/base.mjs` writes the same prefix into the
 * built asset URLs.
 */
export const BASE = '/post'
