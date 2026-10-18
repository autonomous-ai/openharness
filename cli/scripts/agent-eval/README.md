# How lost a fresh agent gets with Harness

The eval in docs/design/2026-10-15-agent-experience.md (part 9). Each case runs Claude Code (`claude -p`) or Codex
(`codex exec`) once, in a fresh session, told only that `harness` is installed. Its transcript is saved and scored
(`score.mts`): harness calls before the first action that only look around, wrong options, retries after a refusal,
harnesses left open, and whether the task was done.

**It starts real harnesses and spends the person's tokens.** Run it only with their approval, at most one agent at a
time. Without `--yes` it only prints what it would do.

    cd cli
    npx tsx --test scripts/agent-eval/score.test.mts
    npx tsx scripts/agent-eval/run.mts --agent claude --machine office --offline linux-box --out ~/agent-eval/2026-10-15
    npx tsx scripts/agent-eval/run.mts --agent claude --machine office --offline linux-box --out ~/agent-eval/2026-10-15 --yes

Before each case it says what to set up (the switch on or off, a harness waiting on a permission) and waits for
Enter. Keep the transcripts out of the repository: they hold the machine's paths and the agents' answers.

Record each run in the pull request of the phase it measures: the CLI version, the agent and its version, and the
summary line.
