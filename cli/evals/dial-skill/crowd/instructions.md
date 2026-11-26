# Team engineering rules

These rules apply to every change in this repository.

## Code

- Make the smallest change that does the task. Leave unrelated code as it is.
- One way to do a thing. When you add a second way, remove the first in the same change.
- No dead code, commented-out blocks or TODOs without an issue number.
- Names say what a thing is or does. Avoid abbreviations other than well-known ones (id, url, http).
- Functions do one thing. Split a function when its name needs "and".
- Prefer plain data and functions over classes unless the code already uses classes.
- Comments explain why, not what. Delete a comment the code has made untrue.
- Keep files under about 400 lines; split by responsibility, not by size alone.
- Handle errors where something useful can be done; otherwise let them propagate with context.
- Every timeout, retry and queue has a bound.

## Style

- Run the formatter and the linter before committing. Do not disable a lint rule to silence it.
- Follow the style of the file you are editing, even where your own style differs.
- Imports are sorted and unused ones removed.
- Use the project's existing helpers before writing a new one.

## Tests

- Every behavior change comes with a test that fails without it.
- Test behavior through public interfaces, not private functions.
- Tests are independent: no shared mutable state, no order dependence.
- No fixed sleeps in tests. Wait on the condition, with a timeout.
- A flaky test is a bug: fix it or remove it, never retry it into passing.
- Keep unit tests fast; slow tests go in the integration suite.
- Run the tests of what you changed before pushing.

## Commits and pull requests

- One logical change per commit, with a subject line in the imperative under 72 characters.
- The commit body says why the change was made when the subject does not.
- One task per pull request. Split a pull request that does two things.
- The description lists what changed, how it was tested, and the platforms it affects.
- Keep pull requests under about 400 changed lines where the task allows.
- Rebase on main before review; resolve conflicts keeping the intent of both sides.

## Dependencies

- Add a dependency only when it saves real work; prefer the standard library.
- Pin exact versions in the lockfile and commit it.
- Update dependencies in their own pull request, not mixed with feature work.

## Performance

- Measure before and after any change made for speed, and include the numbers.
- Every list, batch and fan-out has a limit.
- Avoid queries inside loops; batch them.

## Documentation

- Public functions and endpoints have a short doc comment.
- Update the README when setup, commands or behavior that users see changes.
- Write docs in plain, short sentences.
