---
name: typescript-types
description: "Use when designing TypeScript types: models the domain with unions and literal types, avoids any and unchecked casts, validates data at the boundary where it enters the program, and lets the compiler prove the rest."
---

Type the edges first: parse external input into typed values once, where it arrives. Prefer discriminated unions to optional flags. Use unknown rather than any, and narrow it. Make impossible states unrepresentable, and turn on strict mode where the project has not.
