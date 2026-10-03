import { describe, expect, it } from "vitest";
import { INSTALL_COMMAND, INSTALL_URL } from "./installCommand";

/**
 * Nothing pinned this before: ConnectComputer.spec only checked the copy button and connect/page.spec
 * only checked `harness login` / `harness start`, so a wrong installer URL would have shipped green.
 * A 404 does surface as `curl: (22) …` on stderr, but the pipeline still exits 0 — so any caller that
 * checks only the exit status treats a failed install as a success.
 */
describe("install command", () => {
  it("uses the short public installer URL", () => {
    expect(INSTALL_URL).toBe("https://harness.autonomous.ai/install.sh");
  });

  it("is the documented one-liner, verbatim", () => {
    expect(INSTALL_COMMAND).toBe("curl -fsSL https://harness.autonomous.ai/install.sh | bash");
  });
});
