# Image Sources

`public/assets/mentors/` bundles the portraits rendered on the mentor
cards. The `/api/mentor-image` proxy (`api/mentor-image.js`) also fetches
and caches new portraits from Wikipedia at request time.

## Current status

- No per-file license metadata (author, license, source URL) is recorded in
  this repository.
- `public/assets/mentors/manifest.json` maps display names to bundled
  files, but not to their upstream pages.
- The repository's MIT license (`LICENSE`) covers the code; it does not
  license the photographs or the franchise artwork.

## Before redistributing

Treat each file as provenance-unknown until it is traced back to its source
page. Most of the portraits appear to originate from Wikimedia Commons,
which usually requires attribution and, for some files, share-alike terms.
Remove or replace any file that cannot be verified; the proxy path is a
reasonable replacement for unverified files.
