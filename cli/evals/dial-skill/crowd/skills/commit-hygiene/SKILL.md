---
name: commit-hygiene
description: "Use when preparing commits for review: one logical change per commit, a subject line under 72 characters in the imperative, a body that says why the change was made, no stray debug code or formatting churn, and history tidied with an interactive rebase before the pull request is opened."
---

Stage changes by hunk so each commit holds one idea. Write the subject as what the commit does and the body as why. Squash fixups into the commit they fix. Run the tests at each commit that has to stand alone, and never rewrite history that others have already pulled.
