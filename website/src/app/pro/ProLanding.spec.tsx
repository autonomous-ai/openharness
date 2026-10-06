import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProLanding from "./ProLanding";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the scrolling product story", () => {
  it("exposes each feature without selecting a marketing tab and keeps examples independent", () => {
    render(<ProLanding />);
    for (const name of [
      "Voice",
      "Navigation",
      "Decisions",
      "Carry",
      "Return",
      "Goal",
      "Loop",
      "Today",
    ]) {
      expect(
        screen.getByRole("group", { name: `${name} preview` }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: `Reset ${name} preview` }),
      ).toBeEnabled();
    }
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const voice = within(
      screen.getByRole("region", { name: "Say what’s next." }),
    );
    const navigation = within(
      screen.getByRole("region", {
        name: /Know where you are\.\s*Go where you need\./,
      }),
    );
    fireEvent.click(
      voice.getByRole("button", { name: "Speak to Claude Code" }),
    );
    fireEvent.click(voice.getByRole("button", { name: "Finish and send" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(voice.getByText("Instruction received.")).toBeInTheDocument();
    expect(
      navigation.queryByText("Instruction received."),
    ).not.toBeInTheDocument();
    expect(
      navigation.getByRole("button", {
        name: "Open Checkout tests on MacBook",
      }),
    ).toBeVisible();
    expect(screen.getByRole("group", { name: "Carry preview" })).toBeVisible();
  });

  it("opens Goal and Loop as independent reviewed requests and resets only its own example", () => {
    render(<ProLanding />);
    const goal = within(screen.getByRole("group", { name: "Goal preview" }));
    const loop = within(screen.getByRole("group", { name: "Loop preview" }));
    expect(goal.getByRole("button", { name: "Send goal" })).toBeEnabled();
    expect(loop.getByRole("button", { name: "Send loop" })).toBeEnabled();
    expect(loop.getByText(/Requested/)).toBeVisible();
    fireEvent.click(goal.getByRole("button", { name: "Send goal" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(goal.getByRole("status")).toHaveTextContent("Goal request sent");
    expect(loop.getByRole("button", { name: "Send loop" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset Goal preview" }));
    expect(goal.getByRole("button", { name: "Send goal" })).toBeEnabled();
    expect(goal.queryByRole("status")).not.toBeInTheDocument();
    expect(loop.getByRole("button", { name: "Send loop" })).toBeEnabled();
  });

  it("shows a real return bookmark immediately and restores its original reading position", () => {
    render(<ProLanding />);
    const chapter = within(
      screen.getByRole("region", {
        name: /Follow a thought\.\s*Find your way back\./,
      }),
    );
    fireEvent.click(
      chapter.getByRole("button", {
        name: "Return to Build the launch line 42",
      }),
    );
    expect(chapter.getByText("Line 42")).toBeVisible();
    expect(
      chapter.getByRole("button", { name: "Speak to Claude Code" }),
    ).toBeEnabled();
    expect(
      chapter.queryByRole("button", { name: /Return to Build/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      chapter.getByRole("button", { name: "Reset Return preview" }),
    );
    expect(
      chapter.getByRole("button", {
        name: "Return to Build the launch line 42",
      }),
    ).toBeEnabled();
  });
});
