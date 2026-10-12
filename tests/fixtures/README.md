# Test fixtures

## funchal-items.json

Place data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0), via BTC Map. 40 real items near Funchal from the 2026-10-05 import, plus 3 crafted edge cases.

Each entry is a place event of the shape the places relay serves, signed by the house curator. The 40 real items are the ones closest to the centre of Funchal (32.6507, -16.9084), in order of distance. The last three are crafted, with `d` values that start with `crafted-`:

- `crafted-minimal`: only a name, a category, coordinates, `d`, `z` and the 9-character `g`.
- `crafted-long-name`: a name of exactly 67 characters.
- `crafted-japanese-name`: the name `ペーパー・クレーン`.

The `id` and `sig` of every entry are fakes: unique and the right length, but not a real hash or signature. Nothing here is checked against a relay, and no test opens a network connection.

## forged-reviews.jsonl

Two forged reviews (kind 34259), one of each of the first two places above, for the local-relay proof (`tests/proof/houseScores.proof.ts`). Both name one reviewer and have the right id, but each signature is a real signature of that id by another key. Both keys were made in memory and thrown away, so nobody holds either. `nak serve --events` loads the file without checking signatures; the proof checks that the app's reader drops both.

## follow-list.ts

A builder, not a data file: `buildFollowList(secretKey)` returns a signed follow list (kind 3) of 1,200 tags made up for the tests of the list's rules and of the change that writes it. It names nobody real: every public key is made from a number (`pubkeyAt`), so the list is the same each time, and only its author's key is the caller's. It holds the shapes clients write: plain `p` tags and ones with a relay hint or a petname, `e` and `client` tags, one person named twice, one named in upper-case hex, entries that are not follows (too short, not hex, empty), and a `content` that is a JSON map of relays, as old clients wrote.

## design-tokens.css

The design's tokens (colours, type, spacing, radii), as the design gives them. `src/styles/index.css` carries them verbatim, and three tests hold it to this file: `tests/styles.test.ts`, `tests/theme.test.tsx` and `tests/icons.test.ts`. To change a token, change it here and in the stylesheet together.
