# Store browsing

A few illustrated stories invite curiosity; compact app icons make the catalog easy
to scan. This follows the hierarchy in the Mac App Store Discover, Develop, Create,
and Arcade references: one hero or three features, then collections of icon rows.
See [Discover](https://apps.apple.com/us/mac/discover) and
[Apple’s discovery guide](https://developer.apple.com/app-store/discoverability/).

- Search stays large, focused on arrival, and fixed above scrolling content.
- Discover opens with three original illustrations for coding, 3D design, and
  circuits. Features open actual tools and only appear when those tools exist in
  the machine’s catalog. Narrow windows show the stories in a horizontal shelf.
- Coding agents are the first icon collection, followed by new releases, eligible
  community favorites, and a curated invitation to try another craft.
- Each discipline has one illustrated feature, followed by the same icon rows as
  Discover and search. Compact discipline links use icons and live counts.
- Browsing rows have no launch or install buttons. The entire row opens the
  harness page. That page shows Get before local installation, Update when an
  update is available, or New Harness when ready. Resume appears alongside New
  only when existing work is available; the pair has equal widths. These states
  never overlap. Resume lists matches across machines and never creates work.
- Columns adapt to window width and text size. Back navigation preserves filters
  and scroll position. Individual harness pages keep their existing examples.

## Collection data

**New & updated** orders available harnesses by their actual last catalog publication
change. This is a snapshot bundled with the app release, not a live publication feed.
The generator reads the `store-catalog` branch, ignores install-ref-only changes,
and records first publication and last metadata/package revision change. It gives
unknown entries no invented date. Refresh the snapshot for a release with:

```sh
git fetch origin store-catalog
node desktop/tool/store_catalog_history.mjs
```

**Top rated** uses the Store’s live community ratings: highest average first, review
count breaking ties. A harness needs at least three reviews; the shelf appears when
at least two available tools qualify. Ratings cannot establish usage or downloads,
so the Store does not label this collection “Most popular.” Viewers are excluded.

## Artwork

Eleven original editorial illustrations share a tactile paper-sculpture style and
navy, cobalt, coral, mint, cream, and yellow palette. They were generated with the
built-in imagegen tool; the exact [prompts](../tool/store_artwork/editorial-prompts.json)
and [assets](../assets/store/) are committed together. They illustrate disciplines,
not claimed agent output. Text stays in the UI for readability and accessibility.

Existing screenshots and source artwork remain available for tool detail pages and
future deliberate features. Having a cover does not put it in a browsing row.
