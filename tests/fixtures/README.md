# Test fixtures

## funchal-items.json

Place data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0), via BTC Map. 40 real items near Funchal from the 2026-10-05 import, plus 3 crafted edge cases.

Each entry is a place event of the shape the places relay serves, signed by the house curator. The 40 real items are the ones closest to the centre of Funchal (32.6507, -16.9084), in order of distance. The last three are crafted, with `d` values that start with `crafted-`:

- `crafted-minimal`: only a name, a category, coordinates, `d`, `z` and the 9-character `g`.
- `crafted-long-name`: a name of exactly 67 characters.
- `crafted-japanese-name`: the name `ペーパー・クレーン`.

The `id` and `sig` of every entry are fakes: unique and the right length, but not a real hash or signature. Nothing here is checked against a relay, and no test opens a network connection.
