# Hachi

Your own harness for starting and following your other harnesses: give it a goal, and it starts Claude Code or
Codex where the work belongs, on this computer or your others, follows them, and tells you what they did and what
they need from you.

Hachi is bundled with the Harness CLI and hidden from the Store and from New Harness. Turn it on in **Settings ▸
Experimental ▸ Hachi**, then press ⇧⌘H. Its package is put in place only while that switch is on; turning it off
leaves an installed Hachi, with its goals and conversation, as it was.

The package is its instructions (`AGENTS.md`) and a workspace template. The release build adds the `harness` skill
from `plugins/harness/skills/harness` as `skills/harness/SKILL.md` (`cli/scripts/lib/modelManagerBundle.mjs`), so
the repository keeps one copy of it.

## Credit and stewardship

Created and maintained by Autonomous as part of OpenHarness. This package is licensed under the
[MIT License](LICENSE).
