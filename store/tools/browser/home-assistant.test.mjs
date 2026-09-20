import { test } from "node:test";

// The retired static subset preview is not an acceptance path. The dedicated
// CI job installs Core and executes this same native browser workflow.
test(
  "Habitat: native original/revised workflows and actual JSON/ZIP reopens",
  {
    skip: !process.env.HA_PYTHON,
    timeout: 600000,
  },
  async () => {
    await import("../../agents/home-assistant/test/browser.mjs");
  },
);
