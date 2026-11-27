# ISSUE-7: Page the note list

`notes list` prints every note at once. Heavy users have thousands, and the first ones scroll off the screen before
they can read them.

## Ask

- `notes list --page-size <n>` prints the first `n` notes (after `--open`, when both are given).
- Without the flag, `list` prints one page of the default size.
- The tests cover the flag.

## Default page size

Two candidates:

- **20**: fits a laptop terminal without scrolling.
- **50**: fewer pages for people who pipe the list into `grep`.

Not decided yet. Marta (product) owns the default and has not picked one; either is easy to change later.
