---
name: regex-patterns
description: "Use when writing or fixing a regular expression: anchors it, avoids nested quantifiers that backtrack catastrophically, prefers a small parser when the input has structure, and tests it against matching and non-matching samples, including the edge cases."
---

Write the samples first: what must match, what must not. Anchor the pattern and keep quantifiers bounded. Name capture groups. If the pattern needs a comment to be read, consider splitting it or parsing the input instead. Run it against a long adversarial input to rule out slow backtracking.
