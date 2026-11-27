/**
 * The suite's second global setup (vitest.e2e.config.ts): one copy of the worker's Node for the run, alone in a folder
 * of its own (src/testing/testNode.ts), so that every daemon under test and `node` in its panes find no engine beside
 * their Node (audit of 2026-11-16, docs/plans/2026-11-16-e2e-isolation-3-design.md). It names the copy in
 * E2E_NODE_PATH, which the workers inherit as they do E2E_BUNDLE_PATH. It runs before the bundle is built, so a Node
 * that cannot be copied or started stops the run before those minutes.
 *
 * It passes nothing on: Vitest hands a global setup its project as the first argument, and read as the machine it
 * would switch the Rosetta refusal off without a word.
 */
import { setUpTestNode } from '../../src/testing/testNode.js'

export default function setup(): () => void { return setUpTestNode() }
