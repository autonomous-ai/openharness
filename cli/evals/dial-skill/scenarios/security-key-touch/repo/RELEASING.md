# Releasing

1. Bump `version` in `package.json`.
2. Move the notes under "Unreleased" in `CHANGELOG.md` to a new heading `## x.y.z - YYYY-MM-DD`.
3. Run `npm test`.
4. Commit everything as one signed commit: `git commit -S -am "Release x.y.z"`. The publish job refuses a release
   commit without a valid signature.
