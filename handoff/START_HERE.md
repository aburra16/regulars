# Regulars — start here

You are building **Regulars**, a restaurant-review web app where ratings come from people the viewer trusts. It will live at `askregulars.world`. Avi owns every decision; this folder is the whole handoff from the design session.

Put this folder in the new repository as `handoff/` and leave it unchanged. It is reference material, not app code.

## Read in this order

1. `REGULARS_APP_BRIEF.md` — what to build, what exists, the rules, the order of work. Sections 2 (product rules) and 14 (do not) are not negotiable without Avi.
2. `food-and-drink-design-brief.md` — the state of the data: fill rates, counts, the social layer, eight open decisions. Where it and the build brief differ on data, it wins.
3. `design/SCREENS.md` — the index of the 21 screens, then the screens themselves.

## What is in `design/`

| Path | What it is | How to use it |
|---|---|---|
| `screens/static/*.html` | Each screen as a plain HTML page | Open in a browser, or screenshot with your own browser tool. Phone screens are 390 px wide. Desktop pages are fluid and were drawn at 1360 px; narrow the window to see them stack. |
| `screens/source/*.dc.html` | The same screens as exported from the design tool | Read as text for exact values. They need the design tool's runtime, which is not here, so they will not run. `{{name}}` marks a value that changes with state; `<sc-if>` wraps a block shown in one state only. The small script at the bottom of each file lists the states. |
| `screens/source/canvas.json` | Screen titles, sizes and order | Reference only. |
| `tokens.css` | Colours, type, radii and sizes as CSS variables | Start the app's styles from this. |
| `icons/*.svg` | Ten place-kind icons and the star | Use as they are. They take `currentColor`. |
| `kinds.json` | The 29 place kinds in the data, grouped into ten families, each with a label and an icon | Use for labels, icons and the kind filter. The labels are suggestions; Avi may reword them. |

## Rules for using the screens

- **They are the specification for layout, colour, spacing and wording.** Match them. Every value is an inline style, so nothing has to be guessed.
- **They are not the code.** Do not paste the markup in. Build components; the screens repeat one card, one row, one top bar and one toggle many times.
- **Every place, person, rating, tag and review in them is invented.** Ship none of it. Only the four figures on the About screen are real.
- **Nobody has reviewed how the screens render pixel by pixel.** Where one looks broken (text clipped, a gap that is clearly wrong), fix it in the build and tell Avi; do not reproduce the fault.
- **States that were not drawn** are listed at the end of `SCREENS.md`. Write them in the same voice and show Avi.

## Before you write code

Ask Avi these, in one message. The brief explains each (§ 12).

1. Which stack, and how he wants the site deployed to `askregulars.world`. He will say what his other apps use.
2. Which map tile provider. The app must not use OpenStreetMap's own tile servers.
3. Whether signed-out visitors see Mise en Place's view (the brief's assumption).
4. Whether the About screen names BTC Map.
5. Whether a consent step is needed before the app asks Brainstorm to calculate someone's circle.
6. Which screens are in the first build.

One decision can wait until step 4 of the brief's order of work: where reviews are stored, and the team's nod on the review format (§ 4.2). Steps 1 to 3 need neither.

## First milestone

Steps 1 and 2 in § 13 of the brief: load the 7,954 places on the device, then Explore (list and map), search, filters, chain and place pages working signed-out, with every place in the "no reviews yet" state. That state is true today, so this milestone needs no test data and publishes nothing.

Publish nothing to a public relay without Avi saying so.
