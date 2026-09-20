# Third-party notices

**Jev** — TypeSafe AI's "System One" decision model (typesafe.ai). This harness does not vendor or
fetch any TypeSafe code. It calls TypeSafe's public API (`POST /v1/systemone`) only when a
`TYPESAFE_API_KEY` is set. Without one, the harness runs on a deterministic local mock (a stand-in
for the *plumbing*, not for Jev's judgement). Jev and TypeSafe are trademarks of TypeSafe AI.

**Google Chrome** — Google LLC. This harness drives a copy of Chrome already installed on the
machine, over the public DevTools protocol. It does not vendor, fetch or modify Chrome, and Chrome
and Chromium are trademarks of their owners.

**books.toscrape.com** — a public sandbox published by Zyte for practising web scraping. It is used
once in this harness's README to report a measured run. No code or content from it ships here.

**OpenHarness** — Autonomous (this repository), MIT license. This harness is a wrapper that adds a
viewer and agent instructions; it does not modify TypeSafe AI's product.

This project does not imply endorsement by TypeSafe AI.
