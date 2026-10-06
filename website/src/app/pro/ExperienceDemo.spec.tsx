import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExperienceDemo from "./ExperienceDemo";
import { sampleWords } from "./experience";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const device = () => screen.getByTestId("pro-screen");
const click = (name: string | RegExp, root?: HTMLElement) =>
  fireEvent.click((root ? within(root) : screen).getByRole("button", { name }));
const onDevice = (name: string | RegExp) => click(name, device());
const pane = (title: string) =>
  screen.getByRole("region", { name: title + " app pane" });
const advance = (milliseconds = 1000) =>
  act(() => vi.advanceTimersByTime(milliseconds));
const edges = () => fireEvent.click(screen.getByText("Try the edges"));
const reviewCarry = () => {
  onDevice("1 ready");
  onDevice("Select passage 2");
  onDevice("Carry");
  onDevice("Carry to Checkout tests on MacBook");
  onDevice("Add a voice instruction");
  onDevice("Finish and review");
};
const pointer = (
  target: HTMLElement,
  type: string,
  id: number,
  x: number,
  y: number,
) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: "touch" },
    clientX: { value: x },
    clientY: { value: y },
    button: { value: 0 },
  });
  fireEvent(target, event);
};
const swipe = (target: HTMLElement, count: number, dx: number, dy = 0) => {
  for (let id = 1; id <= count; id++)
    pointer(target, "pointerdown", id, 180, id * 30);
  for (let id = 1; id <= count; id++)
    pointer(target, "pointermove", id, 180 + dx, id * 30 + dy);
  for (let id = 1; id <= count; id++)
    pointer(target, "pointerup", id, 180 + dx, id * 30 + dy);
};

describe("the app-centered Pro experience", () => {
  it("leaves vertical touch drags to the product page and clears cancelled gestures before tapping a control", () => {
    render(<ExperienceDemo product />);
    swipe(device(), 1, 0, 80);
    expect(screen.getByText("Line 42")).toBeInTheDocument();
    pointer(
      within(device()).getByRole("button", { name: "Open workspace map" }),
      "pointerdown",
      2,
      30,
      30,
    );
    onDevice("Open workspace map");
    pointer(device(), "pointerdown", 1, 180, 100);
    pointer(device(), "pointercancel", 1, 180, 180);
    const back = within(device()).getByRole("button", { name: "Back to work" });
    pointer(back, "pointerdown", 2, 30, 30);
    fireEvent.click(back);
    expect(
      within(device()).getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeEnabled();
  });

  it("shows current work, attention and scoped sample usage without a Browser mode", () => {
    render(<ExperienceDemo />);
    const face = within(device());
    expect(
      face.getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeEnabled();
    expect(face.getByText("Build the launch")).toBeInTheDocument();
    expect(
      face.getByRole("button", { name: "2 need you" }),
    ).toBeInTheDocument();
    expect(face.getByRole("button", { name: "1 ready" })).toBeInTheDocument();
    expect(
      face.queryByRole("button", { name: "Browser" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Interactive study · Sample voice and app data"),
    ).toBeInTheDocument();
    onDevice("View today's local spending");
    expect(within(device()).getByText("MacBook")).toBeInTheDocument();
    expect(within(device()).getByText("Other machines")).toBeInTheDocument();
    expect(within(device()).getByText("Not included")).toBeInTheDocument();
    expect(within(device()).getByText(/Sample estimate/)).toBeInTheDocument();
  });

  it("mirrors the app arrangement and browses workspaces without stealing desktop focus", () => {
    render(<ExperienceDemo />);
    onDevice("Open workspace map");
    const deviceTile = within(device()).getByRole("button", {
      name: "Open Checkout tests on MacBook",
    });
    const appTile = pane("Checkout tests");
    for (const key of ["left", "top", "width", "height"] as const)
      expect(deviceTile.style[key]).toBe(appTile.style[key]);
    onDevice("Browse Mobile workspace");
    expect(
      screen.getByRole("button", { name: "Focus Build the launch in app" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Focus Mobile checkout in app" }),
    ).not.toBeInTheDocument();
    const map = within(screen.getByTestId("device-workspace-map"));
    expect(map.getAllByRole("button")).toHaveLength(1);
    expect(map.getByText("App preview")).toBeInTheDocument();
    onDevice("Open Mobile checkout on Home Mac");
    expect(device()).toHaveTextContent("Home Mac");
    expect(pane("Mobile checkout")).toBeInTheDocument();
    expect(within(device()).getByText("Today · MacBook")).toBeInTheDocument();
    onDevice("Speak to Codex");
    onDevice("Finish and send");
    advance();
    expect(
      within(pane("Mobile checkout")).getByText("Instruction received."),
    ).toBeInTheDocument();
  });

  it("keeps quick voice pinned while the app focus changes and waits for its receipt", () => {
    render(<ExperienceDemo />);
    onDevice("Speak to Claude Code");
    click("Focus Checkout tests in app");
    expect(within(device()).getByText("Build the launch")).toBeInTheDocument();
    onDevice("Finish and send");
    const draft = screen.getByRole("textbox", {
      name: "Edit instruction on the app",
    }) as HTMLTextAreaElement;
    const words = draft.value;
    expect(words).toContain("mobile layout");
    expect(
      within(pane("Build the launch")).queryByText("Instruction received."),
    ).not.toBeInTheDocument();
    advance();
    expect(
      within(pane("Build the launch")).getByText(words),
    ).toBeInTheDocument();
    expect(
      within(pane("Checkout tests")).queryByText(words),
    ).not.toBeInTheDocument();
    expect(within(device()).getByText("Checkout tests")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sent");
  });

  it("reviews Goal and Loop requests and never shows a stale schedule after editing", () => {
    render(<ExperienceDemo />);
    onDevice("More actions");
    onDevice(/^Set a goal/);
    onDevice("Finish and review");
    let editor = screen.getByRole("textbox", {
      name: "Edit instruction on the app",
    });
    fireEvent.change(editor, { target: { value: " " } });
    expect(
      within(device()).getByRole("button", { name: "Send goal" }),
    ).toBeDisabled();
    fireEvent.change(editor, {
      target: {
        value: "Keep working until the checkout accessibility tests pass.",
      },
    });
    onDevice("Send goal");
    advance();
    expect(screen.getByRole("status")).toHaveTextContent("Goal request sent");
    expect(
      within(pane("Build the launch")).getByText(
        /checkout accessibility tests pass/,
      ),
    ).toBeInTheDocument();
    onDevice("More actions");
    onDevice(/^Set a loop/);
    onDevice("Finish and review");
    expect(within(device()).getByText("Asia/Ho_Chi_Minh")).toBeInTheDocument();
    editor = screen.getByRole("textbox", {
      name: "Edit instruction on the app",
    });
    fireEvent.change(editor, {
      target: { value: "Every Monday at 17:00 Europe/London, check staging." },
    });
    expect(
      within(device()).queryByText("Asia/Ho_Chi_Minh"),
    ).not.toBeInTheDocument();
    onDevice("Send loop");
    advance();
    expect(screen.getByRole("status")).toHaveTextContent("Loop request sent");
    expect(
      within(pane("Build the launch")).getByText(
        /Every Monday at 17:00 Europe\/London/,
      ),
    ).toBeInTheDocument();
  });

  it("keeps unsupported autonomy actions unavailable while retaining ordinary voice", () => {
    render(<ExperienceDemo />);
    onDevice("Open workspace map");
    onDevice("Open Customer research on Server");
    onDevice("More actions");
    expect(
      within(device()).getByRole("button", { name: /^Set a goal/ }),
    ).toBeDisabled();
    expect(
      within(device()).getByRole("button", { name: /^Set a loop/ }),
    ).toBeDisabled();
    onDevice("Back to work");
    expect(
      within(device()).getByRole("button", { name: "Speak to Hermes" }),
    ).toBeEnabled();
  });

  it("answers one question deliberately and advances without moving the desktop", () => {
    render(<ExperienceDemo />);
    const original = screen.getByTestId("app-reading-anchor").textContent;
    onDevice("2 need you");
    expect(
      within(device()).getByRole("button", { name: "Send answer" }),
    ).toBeDisabled();
    onDevice("Staging");
    expect(
      within(pane("Checkout tests")).getByText(
        "Where should I run the checkout tests?",
      ),
    ).toBeInTheDocument();
    onDevice("Send answer");
    expect(
      within(device()).getByRole("button", { name: "Sending…" }),
    ).toBeDisabled();
    advance();
    expect(
      within(pane("Checkout tests")).getByText("Answer received."),
    ).toBeInTheDocument();
    expect(
      within(device()).getByText("Which name should the new command use?"),
    ).toBeInTheDocument();
    expect(
      within(device()).getByRole("button", { name: "Send answer" }),
    ).toBeDisabled();
    expect(screen.getByTestId("app-reading-anchor").textContent).toBe(original);
  });

  it("withdraws a question answered elsewhere without sending the old selection", () => {
    render(<ExperienceDemo />);
    onDevice("2 need you");
    onDevice("Staging");
    edges();
    click("Answer elsewhere");
    expect(
      within(device()).queryByRole("button", { name: "Send answer" }),
    ).not.toBeInTheDocument();
    expect(
      within(device()).getByRole("button", { name: /Refine the CLI/ }),
    ).toBeInTheDocument();
    advance();
    expect(
      within(pane("Checkout tests")).queryByText("Answer received."),
    ).not.toBeInTheDocument();
    onDevice(/Refine the CLI/);
    expect(
      within(device()).getByRole("button", { name: "Send answer" }),
    ).toBeDisabled();
  });

  it("carries the selected passage with an explicitly started voice instruction to the chosen app pane", () => {
    render(<ExperienceDemo />);
    onDevice("1 ready");
    const excerpt = within(device()).getByRole("button", {
      name: "Select passage 2",
    }).textContent!;
    onDevice("Select passage 2");
    onDevice("Carry");
    onDevice("Carry to Checkout tests on MacBook");
    expect(
      within(device()).getByRole("button", { name: "Add a voice instruction" }),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Finish and review" }),
    ).not.toBeInTheDocument();
    onDevice("Add a voice instruction");
    onDevice("Finish and review");
    const editor = screen.getByRole("textbox", {
      name: "Edit instruction on the app",
    });
    fireEvent.change(editor, {
      target: { value: "Check this against the failures we saw." },
    });
    expect(within(device()).getByText("Passage preview")).toBeInTheDocument();
    expect(
      within(device()).getByText(excerpt, { exact: false }),
    ).toBeInTheDocument();
    onDevice("Send");
    advance();
    const target = within(pane("Checkout tests"));
    expect(
      target.getByText("Check this against the failures we saw."),
    ).toBeInTheDocument();
    expect(target.getByText(excerpt)).toBeInTheDocument();
    expect(target.getByText("Instruction received.")).toBeInTheDocument();
  });

  it("keeps an attached passage and edited words through a long review", () => {
    render(<ExperienceDemo />);
    reviewCarry();
    const words = "Preserve this direction while I review the passage.";
    fireEvent.change(
      screen.getByRole("textbox", { name: "Edit instruction on the app" }),
      { target: { value: words } },
    );
    advance(301_000);
    expect(
      within(device()).getByRole("button", { name: "Send" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Edit instruction on the app" }),
    ).toHaveValue(words);
    expect(
      within(device()).queryByRole("button", { name: "Choose again" }),
    ).not.toBeInTheDocument();
    onDevice("Send");
    advance();
    expect(within(pane("Checkout tests")).getByText(words)).toBeInTheDocument();
  });

  it("refreshes an expired unused passage before voice starts", () => {
    render(<ExperienceDemo />);
    onDevice("1 ready");
    onDevice("Select passage 2");
    onDevice("Carry");
    onDevice("Carry to Checkout tests on MacBook");
    advance(301_000);
    expect(
      within(device()).queryByRole("button", {
        name: "Add a voice instruction",
      }),
    ).not.toBeInTheDocument();
    onDevice("Choose again");
    onDevice("Select passage 3");
    onDevice("Use passage");
    expect(
      within(device()).getByRole("button", { name: "Add a voice instruction" }),
    ).toBeEnabled();
    expect(
      within(device()).queryByRole("button", { name: "Finish and review" }),
    ).not.toBeInTheDocument();
    onDevice("Add a voice instruction");
    onDevice("Finish and review");
    expect(
      within(device()).getByRole("button", { name: "Send" }),
    ).toBeEnabled();
  });

  it("rejects a stale passage selection when new output arrives before Carry", () => {
    render(<ExperienceDemo />);
    onDevice("1 ready");
    onDevice("Select passage 1");
    edges();
    click("Update research result");
    onDevice("Carry");
    expect(
      within(device()).getByText(/New research is available/),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", {
        name: "Carry to Checkout tests on MacBook",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/changed|select/i);
    onDevice("Select passage 1");
    onDevice("Carry");
    expect(
      within(device()).getByRole("button", {
        name: "Carry to Checkout tests on MacBook",
      }),
    ).toBeInTheDocument();
  });

  it("reads locally, visits the result, and returns to the original reading position", () => {
    render(<ExperienceDemo />);
    const original = screen.getByTestId("app-reading-anchor").textContent;
    onDevice("1 ready");
    expect(screen.getByTestId("app-reading-anchor").textContent).toBe(original);
    onDevice("Open in app");
    expect(within(device()).getByText("Customer research")).toBeInTheDocument();
    onDevice(/Return to Build the launch/);
    expect(screen.getByTestId("app-reading-anchor").textContent).toBe(original);
    expect(
      within(device()).queryByRole("button", { name: /Return to/ }),
    ).not.toBeInTheDocument();
  });

  it("explains a pruned return anchor instead of claiming an exact return", () => {
    render(<ExperienceDemo />);
    onDevice("1 ready");
    onDevice("Open in app");
    edges();
    click("Prune earlier output");
    onDevice(/Return to Build the launch/);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The earlier text is no longer available",
    );
    expect(screen.getByTestId("app-reading-anchor")).toHaveTextContent("60");
  });

  it("keeps unknown delivery separate from success while allowing local reading", () => {
    render(<ExperienceDemo />);
    edges();
    click("Hold host receipts");
    onDevice("Speak to Claude Code");
    onDevice("Finish and send");
    click("Check missing receipt");
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    onDevice("Back to work");
    expect(
      within(device()).getByRole("button", { name: "Check delivery" }),
    ).toBeInTheDocument();
    onDevice("View today's local spending");
    expect(within(device()).getByText(/Sample estimate/)).toBeInTheDocument();
    onDevice("Back to work");
    onDevice("1 ready");
    expect(
      within(device()).getByRole("button", { name: "Select passage 1" }),
    ).toBeInTheDocument();
    onDevice("Back to work");
    onDevice("Check delivery");
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    expect(
      within(pane("Build the launch")).queryByText("Instruction received."),
    ).not.toBeInTheDocument();
    click("Resume host receipts");
    advance();
    expect(
      within(pane("Build the launch")).getAllByText("Instruction received."),
    ).toHaveLength(1);
    expect(
      within(device()).queryByRole("button", { name: "Check delivery" }),
    ).not.toBeInTheDocument();
  });

  it("reconciles after disconnecting between send and acknowledgement without duplicating the instruction", () => {
    render(<ExperienceDemo />);
    onDevice("Speak to Claude Code");
    onDevice("Review first");
    onDevice("Finish and review");
    onDevice("Send");
    edges();
    click("Interrupt app link");
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    advance();
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    click("Reconnect app link");
    expect(within(device()).getByText("Offline copy")).toBeInTheDocument();
    onDevice("Recover message");
    expect(
      within(device()).getByText("Recovered · read only"),
    ).toBeInTheDocument();
    expect(within(device()).getByText("Passed to Harness")).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
    expect(
      within(pane("Build the launch")).getAllByText("Instruction received."),
    ).toHaveLength(1);
  });

  it("keeps direct voice receipt checking separate from reviewed-message recovery", () => {
    render(<ExperienceDemo />);
    edges();
    click("Hold host receipts");
    onDevice("Speak to Claude Code");
    onDevice("Finish and send");
    click("Interrupt app link");
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Recover message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restart device" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Forget host draft" }),
    ).toBeDisabled();
    click("Reconnect app link");
    expect(
      within(device()).queryByRole("button", { name: "Recover message" }),
    ).not.toBeInTheDocument();
    click("Resume host receipts");
    advance();
    expect(
      within(pane("Build the launch")).getAllByText("Instruction received."),
    ).toHaveLength(1);
    expect(
      within(device()).getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeEnabled();
  });

  it.each(["task", "goal", "loop", "carry"] as const)(
    "recovers %s review after a powered link interruption and requires Close before a fresh recording",
    (kind) => {
      render(
        <ExperienceDemo
          scenario={kind === "goal" || kind === "loop" ? kind : "home"}
        />,
      );
      if (kind === "carry") reviewCarry();
      else if (kind === "task") {
        onDevice("Speak to Claude Code");
        onDevice("Review first");
        onDevice("Finish and review");
      }
      const text = sampleWords(
        kind === "carry" ? "task" : kind,
        kind === "carry",
      );
      const recipient =
        kind === "carry" ? "Checkout tests" : "Build the launch";
      edges();
      click("Interrupt app link");
      expect(within(device()).getByText(text)).toBeInTheDocument();
      expect(within(device()).getByText(recipient)).toBeInTheDocument();
      expect(
        within(device()).getByRole("button", { name: "Recover message" }),
      ).toBeDisabled();
      expect(
        within(device()).queryByRole("button", {
          name: /^(Send|Send goal|Send loop)$/,
        }),
      ).not.toBeInTheDocument();
      expect(
        within(device()).queryByRole("button", { name: "Add a thought" }),
      ).not.toBeInTheDocument();
      click("Reconnect app link");
      expect(within(device()).getByText("Offline copy")).toBeInTheDocument();
      onDevice("Recover message");
      expect(
        within(device()).getByText("Recovered · read only"),
      ).toBeInTheDocument();
      expect(within(device()).getByText(text)).toBeInTheDocument();
      if (kind === "carry")
        expect(
          within(device()).getByLabelText("Show passage preview from Hermes"),
        ).toBeInTheDocument();
      onDevice("Back to work");
      onDevice("Your message");
      expect(within(device()).getByText(text)).toBeInTheDocument();
      onDevice("Close");
      onDevice(kind === "carry" ? "Speak to Codex" : "Speak to Claude Code");
      expect(
        within(device()).getByRole("button", { name: "Finish and send" }),
      ).toBeInTheDocument();
      expect(within(device()).queryByText(text)).not.toBeInTheDocument();
      expect(
        within(pane(recipient)).queryByText("Instruction received."),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps the cached words when the sample host forgets its archive", () => {
    render(<ExperienceDemo scenario="goal" />);
    edges();
    click("Interrupt app link");
    click("Forget host draft");
    click("Reconnect app link");
    onDevice("Recover message");
    expect(
      within(device()).getByText("Full message unavailable"),
    ).toBeInTheDocument();
    expect(within(device()).getByText(sampleWords("goal"))).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Send goal" }),
    ).not.toBeInTheDocument();
    onDevice("Close");
    expect(
      within(device()).getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeEnabled();
  });

  it("restarts Carry with only its recipient and identity, then recovers words without recreating the passage preview", () => {
    render(<ExperienceDemo />);
    reviewCarry();
    const text = sampleWords("task", true);
    edges();
    click("Restart device");
    expect(within(device()).queryByText(text)).not.toBeInTheDocument();
    expect(within(device()).getByText("Codex")).toBeInTheDocument();
    expect(
      within(device()).queryByText("Checkout tests"),
    ).not.toBeInTheDocument();
    expect(
      within(device()).getByText("No words saved on device."),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByLabelText("Show passage preview from Hermes"),
    ).not.toBeInTheDocument();
    expect(within(device()).queryByText(/Part \d+ of/)).not.toBeInTheDocument();
    expect(
      within(device()).getByRole("button", { name: "Recover message" }),
    ).toBeDisabled();
    click("Reconnect app link");
    expect(within(device()).queryByText(text)).not.toBeInTheDocument();
    onDevice("Recover message");
    expect(within(device()).getByText(text)).toBeInTheDocument();
    expect(
      within(device()).getByText("Recovered · read only"),
    ).toBeInTheDocument();
    expect(
      within(device()).getByText("Passage preview unavailable."),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByLabelText("Show passage preview from Hermes"),
    ).not.toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
    onDevice("Close");
    onDevice("Speak to Codex");
    expect(
      within(device()).getByRole("button", { name: "Finish and send" }),
    ).toBeEnabled();
  });

  it("shows no invented local words when the host archive is missing after restart", () => {
    render(<ExperienceDemo scenario="goal" />);
    edges();
    click("Restart device");
    click("Forget host draft");
    click("Reconnect app link");
    onDevice("Recover message");
    expect(
      within(device()).getByText("Full message unavailable"),
    ).toBeInTheDocument();
    expect(
      within(device()).getByText("No words saved on device."),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByText(sampleWords("goal")),
    ).not.toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Send goal" }),
    ).not.toBeInTheDocument();
    onDevice("Close");
    onDevice("Speak to Claude Code");
    expect(
      within(device()).getByRole("button", { name: "Finish and send" }),
    ).toBeEnabled();
  });

  it("reads recovered parts without restoring Send, and keeps the current part after expiry", () => {
    render(<ExperienceDemo scenario="goal" />);
    for (let part = 0; part < 18; part++) {
      onDevice("Add a thought");
      onDevice("Finish and review");
    }
    expect(
      within(device()).getByRole("button", { name: "Earlier message part" }),
    ).toBeEnabled();
    const before = within(device())
      .getByRole("region", { name: "Instruction and context" })
      .querySelector("p")!.textContent;
    edges();
    click("Interrupt app link");
    expect(
      within(device()).getByRole("button", { name: "Earlier message part" }),
    ).toBeDisabled();
    click("Reconnect app link");
    onDevice("Recover message");
    expect(
      within(device())
        .getByRole("region", { name: "Instruction and context" })
        .querySelector("p")!.textContent,
    ).toBe(before);
    onDevice("Earlier message part");
    const cached = within(device())
      .getByRole("region", { name: "Instruction and context" })
      .querySelector("p")!.textContent;
    expect(cached).not.toBe(before);
    click("Expire host draft");
    expect(
      within(device()).getByText("Full message unavailable"),
    ).toBeInTheDocument();
    expect(
      within(device())
        .getByRole("region", { name: "Instruction and context" })
        .querySelector("p")!.textContent,
    ).toBe(cached);
    expect(
      within(device()).getByRole("button", { name: "Next message part" }),
    ).toBeDisabled();
    expect(
      within(device()).queryByRole("button", { name: "Send goal" }),
    ).not.toBeInTheDocument();
  });

  it("locks a rejected reviewed goal and only a fresh recording can create another instruction", () => {
    render(<ExperienceDemo scenario="goal" />);
    edges();
    click("Hold host receipts");
    onDevice("Send goal");
    click("Host rejects instruction");
    expect(
      within(device()).getByText("Instruction rejected"),
    ).toBeInTheDocument();
    expect(
      within(device()).queryByRole("button", { name: "Send goal" }),
    ).not.toBeInTheDocument();
    onDevice("Close");
    onDevice("Speak to Claude Code");
    onDevice("Finish and send");
    click("Resume host receipts");
    advance();
    expect(
      within(pane("Build the launch")).getAllByText("Instruction received."),
    ).toHaveLength(1);
  });

  it("keeps an unconfirmed answer inspectable after that question was handled elsewhere", () => {
    render(<ExperienceDemo />);
    edges();
    click("Hold host receipts");
    onDevice("2 need you");
    onDevice("Staging");
    onDevice("Send answer");
    click("Check missing receipt");
    onDevice("Back to work");
    click("Answer elsewhere");
    onDevice("Check delivery");
    expect(within(device()).getByText("Staging")).toBeInTheDocument();
    expect(
      within(device()).getByText("Delivery unconfirmed"),
    ).toBeInTheDocument();
    expect(
      within(device()).getByRole("button", { name: "Check status" }),
    ).toBeEnabled();
    expect(
      within(device()).queryByRole("button", { name: "Send answer" }),
    ).not.toBeInTheDocument();
    onDevice("Check status");
    expect(within(device()).getByText("Staging")).toBeInTheDocument();
    onDevice("Back to work");
    expect(
      within(device()).getByRole("button", { name: "1 need you" }),
    ).toBeInTheDocument();
    expect(
      within(device()).getByRole("button", { name: "Check delivery" }),
    ).toBeInTheDocument();
    onDevice("Check delivery");
    onDevice("Close");
    expect(
      within(device()).queryByText("Delivery unconfirmed"),
    ).not.toBeInTheDocument();
    expect(
      within(pane("Checkout tests")).queryByText("Answer accepted."),
    ).not.toBeInTheDocument();
    onDevice(/Refine the CLI/);
    expect(
      within(device()).getByRole("button", { name: "Send answer" }),
    ).toBeDisabled();
  });

  it("scrolls with one finger and consumes the click after a drag instead of opening the microphone", () => {
    render(<ExperienceDemo />);
    const face = device();
    const before = screen.getByTestId("app-reading-anchor").textContent;
    swipe(face, 1, 0, 80);
    expect(screen.getByTestId("app-reading-anchor").textContent).not.toBe(
      before,
    );
    onDevice("Speak to Claude Code");
    expect(
      within(device()).queryByRole("button", { name: "Finish and send" }),
    ).not.toBeInTheDocument();
    onDevice("Speak to Claude Code");
    expect(
      within(device()).getByRole("button", { name: "Finish and send" }),
    ).toBeInTheDocument();
  });

  it("keeps cancelled and unsupported gestures from changing work or starting voice", () => {
    render(<ExperienceDemo />);
    const face = device();
    pointer(face, "pointerdown", 1, 180, 80);
    pointer(face, "pointermove", 1, 90, 80);
    pointer(face, "pointercancel", 1, 90, 80);
    pointer(face, "pointerup", 1, 90, 80);
    expect(
      within(face).getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeInTheDocument();
    swipe(face, 3, -80);
    expect(
      within(face).getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeInTheDocument();
    swipe(face, 2, -80);
    expect(
      within(face).getByTestId("device-workspace-map"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Focus Build the launch in app" }),
    ).toBeInTheDocument();
  });
});
