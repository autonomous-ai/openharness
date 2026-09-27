# ASCII creature craft: what early text art teaches the daemons

2026-09-26. Research behind the daemons' art (`daemons/README.md`, "Art rules"): how people drew with
characters before pixels, what each era contributed as a technique, what works at our sizes (an 8-cell
status sprite and portraits up to 8 rows by 28 columns), and the pitfalls. Sources are linked; claims
that could not be confirmed are marked.

## An existing product to stand apart from

Claude Code's `/buddy` (April 2026; its source leaked a day before launch) is already a terminal
tamagotchi: 18 species, rarity tiers, five stats, 5×12 sprites with 3 frames on a 500 ms tick, drawn as
body, eye and hat layers beside the input box ([Castellano](https://jacopocastellano.com/blog/anthropic-leaked-claude-code-source-tamagotchi-buddy/),
[claudefa.st](https://claudefa.st/blog/guide/mechanics/claude-buddy); both are write-ups of the leak).
The daemons stand apart on lore (each is a piece of terminal history), pure 7-bit ASCII, living in the
status line, growth earned from real work, and doing real work.

## What each era added as a technique

| Era | Technique |
|---|---|
| Typewriter art (Flora Stacey's butterfly, 1898) [src](https://oztypewriter.blogspot.com/2020/02/flora-fanny-stacey-1845-1909-worlds.html) | Glyphs used as strokes, not letters |
| RTTY art (1960s–70s; Baudot code, uppercase only) [src](https://en.wikipedia.org/wiki/ASCII_art), [src](https://hughpyle.com/ASR33/) | Carriage return without line feed, then typing over the line: layered overstrike tones |
| Line printers (IBM 1403; the Mona Lisa passed around on DECUS tapes) [src](https://hughpyle.com/ASR33/) | Density ramps. [Bourke](https://paulbourke.net/dataformats/asciiart/) gives `` .:-=+*#%@``; density varies by font; cells are about 2:1 tall |
| Rogue 1980, then Hack (1982; Andries Brouwer's Hack 1.0, 1984, added the pet dog) [src](https://en.wikipedia.org/wiki/Hack_(video_game)), [src](https://nethackwiki.com/wiki/Jay_Fenlason's_Hack) | One glyph is the identity: `@` for you, `d` for the dog |
| NetHack [src](https://nethackwiki.com/wiki/Growing_up) | Pets grow as they level: kitten → housecat → large cat, little dog → dog → large dog |
| Zork's grue [src](https://en.wikipedia.org/wiki/Grue_(monster)) | A creature made only of a sentence, never drawn |
| `:-)` (Fahlman, 19 Sep 1982) vs `(^_^)` (Wakabayashi, 1986) [src](http://www.cs.cmu.edu/~sef/Orig-Smiley.htm), [src](https://en.wikipedia.org/wiki/Kaomoji) | Sideways and read from the mouth, vs upright and read from the eyes. Japanese readers judge emotion by the eyes, Americans by the mouth ([Yuki 2007](https://www.sciencedirect.com/science/article/abs/pii/S0022103106000321)). `orz` is a whole kneeling body in 3 letters |
| cowsay (Monroe, 1999) [source](https://github.com/tnalpgge/rank-amateur-cowsay) | A drawing with 2-character eye and tongue slots; each mood is an eye preset: `==` borg, `xx` + `U` dead, `$$` greedy, `@@` paranoid, `--` tired, `OO` wired, `..` young |
| FIGlet 1991 / toilet [src](http://caca.zoy.org/wiki/toilet) | Banner letters that overlap ("smushing"); toilet adds colour filters on plain glyphs |
| The art scene [src](http://www.roysac.com/roy-sac_styles_of_underground_text_art.html) | Oldskool (Amiga) is 7-bit line art in `/\-\|_`; newskool is fill made of `$#Xxo`; block style needs code page 437 shading `░▒▓`. Our lane is oldskool |
| ASCIImation (Jansen, 1997) [FAQ](https://www.asciimation.co.nz/asciimation/ascii_faq.html) | 67×13 frames at 15 fps; each frame starts with a hold count, which packed 17,357 frames into 3,849 |
| sl (Toyoda, 1993) [source](https://github.com/mtoyoda/sl) | Wheel frames picked by x-position, so wheels roll instead of sliding; smoke ages `(   )` → `()` → `O` → blank with eased drift; 40 ms tick |
| asciiquarium (Baucom, 2003; art mostly Joan Stark) [source](https://github.com/cmatsuoka/asciiquarium) | Colour masks re-rolled per spawn; random speed and depth; bubbles at 3% per frame; a dying visitor's callback spawns the next |
| Neko, xeyes (SIGGRAPH '88), eSheep [src](https://en.wikipedia.org/wiki/Neko_(software)), [src](https://illuminex.com/mac/eyespy/Heritage.html) | Pets that react to the pointer and the desktop: chase it, sleep when idle, follow it with their eyes, walk along window edges |
| Tamagotchi (1996) [src](https://en.wikipedia.org/wiki/Tamagotchi) | Hatches from an egg and grows in stages; quality of care picks the adult form |
| fortune (1979), ELIZA (1964–67) [src](https://en.wikipedia.org/wiki/ELIZA) | A small daily voice; reflecting the user back makes a trivial program feel present |
| The twirling baton (PLATO) [Jargon](http://jargon.net/jargonfile/t/twirlingbaton.html) | `-/\|\` typed over itself spins in place; a space after each backspace makes it travel while spinning |
| Text-mode demos (TMDC since 1996; AAlib, 1997) [src](https://aa-project.sourceforge.net/tune/summary.html) | AAlib sampled 2×2 pixels per cell and used dim, bold and reverse as extra tones |

## Techniques that work at our size

- **Eyes.** `oo` idle, `^^` pleased, `--` blinking or asleep, `OO` alert, `@@` overwhelmed, `xx` failed,
  `==` focused, `><` straining, `TT` sad, `o.` a glance, `-o` a wink. Shifting the eyes one cell toward
  what changed reads as looking (xeyes).
- **Glyph shape as pixel.** `( )` round, `/\` ears, `_` floor. `'` and `"` sit at the top of the cell,
  `,` and `.` at the bottom. A size ladder: `. o O @`. Motion: `~`.
- **Tone.** The density ramp above, in dim, normal and bold; a reverse-video space is a solid block.
- **Cycles** (intervals from [cli-spinners](https://github.com/sindresorhus/cli-spinners)): `-\|/`
  130 ms, `` .oO@* `` 140 ms, `+x*` 80 ms, `dqpb` 100 ms (a letter turning), `. .. ...` 400 ms, a bouncing
  `[=   ]` ↔ `[====]` 80 ms. Classics with no spinner source: `oo` → `--` blink, `zZ` sleep, `><>` ↔ `<><`
  turn around, `v`/`^` wing flap, the Kirby dance `(>'-')> <('-'<) ^('-')^`.
- **Timing.** Write animation as poses with hold counts, not frame by frame. Blinks last about
  100–150 ms, 15–20 a minute, dropping to about 5–7 during concentration
  ([Blinking](https://en.wikipedia.org/wiki/Blinking)). Squash for one frame before a hop
  (`(..)` → `(__)`). Tie movement frames to position, as sl does.
- **Ambient life.** A low chance of an event per tick, randomised details, the next event queued: never
  empty, never busy (asciiquarium).
- **Personality from one glyph** (NetHack). Chatting with a pet reads out its hidden state: it *whines*
  when distressed, *yips* when well fed, *barks* otherwise ([Chat](https://nethackwiki.com/wiki/Chat)).
  Out of sight: "You feel worried about <pet>"; on its death, "You have a sad feeling for a moment, then
  it passes" ([Pet](https://nethackwiki.com/wiki/Pet)). An `f` stays an `f` as it grows.

## Tiny creatures and eggs

- Creatures: `:-)` `(^_^)` `orz` `><>` `<('.')>`, the bunny `(\_/)(='.'=)(")_(")`, the owl `{o,o}` /
  `|)__)`, the cow `^__^ (oo)\___`, sl's `(O)` ↔ `\O/ Help!`.
- Eggs: a Tamagotchi egg wiggles for about five minutes before hatching (from a
  [fan wiki](https://tamagotchi.fandom.com/wiki/Tamagotchi_(1996_Pet)), not verified). In NetHack a
  hatchling bonds with you: "Its cries sound like "mommy"." ([Egg](https://nethackwiki.com/wiki/Egg)).
  Pokémon egg messages build up to "will hatch soon" (exact wording not confirmed).

## Pitfalls

- **Fonts.** Density and aspect ratio vary between fonts. Ligature fonts (Fira Code, JetBrains Mono,
  Cascadia) merge `->`, `==`, `<=`, `=>` and more into single glyphs
  ([qterminal#684](https://github.com/lxqt/qterminal/issues/684)).
- **Width.** Unicode "ambiguous width" characters (Greek letters, `°`, `·`, `×`) take two cells in CJK
  setups; emoji and `ツ` are always wide ([UAX #11](https://www.unicode.org/reports/tr11/)). 7-bit ASCII
  is always one cell.
- **Pasting into GitHub and Slack.** Markdown eats `\` (the one-armed shrug); `_` and `*` become
  formatting; whitespace collapses outside code blocks; Slack turns `:D` into an emoji by default
  ([Slack](https://slack.com/help/articles/202931348-Use-emoji-and-emoticons)). So copy creatures out as a
  fenced code block.
- **Colour.** Palettes come from the user's theme; Solarized makes bright black equal to the background
  ([terminal#6696](https://github.com/microsoft/terminal/issues/6696)). Respect
  [NO_COLOR](https://no-color.org/); never carry state by colour alone. Support for dim varies between
  terminals (from experience, not verified).
- **CP437** is a DOS code page; anywhere else it becomes Unicode, with the width and font problems above.

## Principles, and what the daemons took from them

| Principle | In the daemons |
|---|---|
| The eyes are the face: a 2-character eye slot, the body still | `{e}` eye placeholders; a mood changes at most two cells of the sprite |
| It must read in monochrome; colour is a filter | Each daemon has one colour, never the only signal; in the status line it takes the bar's own colour |
| Oldskool 7-bit only, no ligature pairs, no ambiguous width | Printable ASCII only; `rules.ligatureUnsafe` checked on every frame by `daemons/tools/generate.mjs`; two eyes never touch |
| Each cell is a pixel, chosen for its shape | tim's face is a tmux window, vim sits on `~` lines past the end of its buffer, bat is "a cat(1) clone with wings" |
| Animate poses with hold counts; change at most 2 of 8 cells per step | Work frames per daemon; one step per real agent event, at most two a second |
| Stillness is the default; life is random | No idle animation timer; blinks only as answers (ack, look, slow) |
| React to the work, not the clock | Moods come from agent events; fewer blinks while agents work |
| Say it in words | NetHack-style one-line voice, with slot templates filled from real facts |
| Grow by earned levels, keep the identity | Versions 0.1 → 1.0 → 2.0, one face; tldr shrinks on purpose |
| The egg is anticipation | The nest fills with habits; wobble, crack with a rarity tell, silhouette, banner, card |
| Lore is a Unix naming joke | tim is tmux improved, the way vim is vi improved |
| Stay visibly different from `/buddy` | Lore, pure ASCII, status line, earned growth, real work |
