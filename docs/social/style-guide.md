# X post style guide (@dee_hw)

Source: Dee's public profile page, read logged out on 2026-10-31. Only his
5 newest posts are public without signing in; X, the Wayback Machine and the
mirrors refused older history. Update the table when more posts are readable.

## What performed (Oct 29-31, 2026)

| Post | Likes | Replies | Views | Shape |
|---|---|---|---|---|
| "Lamp is shipping." (pinned) | 35 | 8 | 1.9k | 3-word hook, a concrete scene, an emotional closer, link, photo |
| "There's a lot I love about Lamp..." | 21 | 4 | 2.6k | personal moment, "You don't have to ask. Lamp just does it.", link, video |
| "Gift season: a new kind of burgundy 🍷" | 12 | 1 | 0.9k | one-line pun quoting a product post |
| "Hardware is eating the world." | 7 | 1 | 0.6k | one-line take quoting a big account |
| "Having a lot of fun designing this Spaceship Pod..." | 3 | 0 | 0.2k | posted hours before this read; too early to judge |

## The pattern

- **Hook:** first line is a short declarative sentence that stands alone
  ("Lamp is shipping."). No question hooks, no "thread 🧵".
- **Body:** one concrete, physical detail (packing boxes, a sip of water), told
  in first person ("I", "we"). Short paragraphs with blank lines between them.
- **Closer:** a human line ("9 months of raising a kid. Time to let them go.")
  or a crisp benefit in 2-3 short sentences.
- **Length:** either a one-liner (under 40 chars) or a full post (240-280).
- **Tone:** warm, plain, a little proud; never salesy. No jargon.
- **Emoji:** rare, at most one, only as part of a pun (🍷).
- **Hashtags:** none. **Mentions:** none in his own posts.
- **Link:** one, at the end.
- **Visual:** always one: a real photo or a short video of the thing itself.
  For software, a clean, real product screenshot (dark theme), cropped to the
  part that tells the story.

## Rules for daily drafts

1. Under 280 characters as X counts them (a link counts as 23).
2. One shipped, public fact a day; never repeat a topic in `log.md`.
3. Hook line first; one concrete detail; human closer; one link.
4. One visual from our own committed screenshots; no names, no private
   chats, nothing unreleased-sensitive.
5. Drafts only: Dee posts them himself.

## Daily run (for the agent drafting today)

Dee asked on 2026-10-31 for one draft a day at about 19:00 VN, as a reply in
his thread in the project chat (his message asking for daily X posts).

1. `TZ=Asia/Ho_Chi_Minh date`. If `log.md` already has today's VN date, stop.
2. Pick one topic not in `log.md`, from PRs merged since the last row:
   `gh pr list -R autonomous-ai/openharness --state merged --search "merged:>=YYYY-MM-DD"`.
   Prefer a feature a user can see, with a screenshot committed in the PR.
3. Get the screenshot: copy its `blob/<sha>/<path>?raw=true` link from the PR
   body, then `gh api -H "Accept: application/vnd.github.raw"
   "repos/autonomous-ai/openharness/contents/<path>?ref=<sha>" > shot.png`.
   Crop to what tells the story (`sips -c HEIGHT WIDTH --cropOffset Y X`;
   dark theme, no empty panels). Look at it before using it.
4. Write the copy with the pattern above. Check the count:
   `python3 -I docs/social/count.py docs/social/drafts/DATE.txt` (under 280).
5. Check the release: `gh release list -R autonomous-ai/openharness`. If the
   feature merged after the latest Desktop release, add a one-line note that
   it isn't downloadable yet.
6. Save `drafts/DATE.txt` and `drafts/DATE.png`, add a row to `log.md`,
   commit those files by name and push this branch.
7. Post the draft and the image as one reply in Dee's thread. Nothing else in
   the project chat. Never post to X or sign in anywhere.
