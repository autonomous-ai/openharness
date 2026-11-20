import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.js";
import { DEVICE_INSTALL_COMMAND, DEVICE_INSTALL_URL, INSTALL_COMMAND, INSTALL_URL } from "./installCommand";

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

describe("Harness Device install command", () => {
  it("the Harness Device line is the documented one, verbatim", () => {
    expect(DEVICE_INSTALL_COMMAND).toBe("curl -fsSL https://harness.autonomous.ai/device/install.sh | bash");
  });

  it("its URL is the one next.config sends to the CDN", async () => {
    const path = new URL(DEVICE_INSTALL_URL).pathname;
    expect(await nextConfig.redirects()).toContainEqual({
      source: path,
      destination: "https://cdn.autonomous.ai/harness/device/install.sh",
      permanent: true,
    });
  });
});
