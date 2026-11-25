import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitorPlatform } from "@/lib/desktopPlatform";
import { INSTALL_COMMAND } from "@/lib/installCommand";

let platform: VisitorPlatform | null = null;
vi.mock("@/lib/useVisitorPlatform", () => ({ useVisitorPlatform: () => platform }));

const { default: Page } = await import("./page");

const writeText = vi.fn<(text: string) => Promise<void>>();

describe("/download", () => {
  beforeEach(() => {
    platform = null;
    writeText.mockReset();
    writeText.mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("is a public landing page with no login gate", () => {
    render(<Page />);

    expect(screen.getByRole("heading", { name: "Download Harness" })).toBeInTheDocument();
    // Downloads stay public; entering the separate Flutter workspace, the site's front door, is an
    // ordinary link.
    expect(screen.getByRole("link", { name: "[ Open web app ]" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Harness" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("links each platform's desktop download straight at the manifest-backed route", () => {
    render(<Page />);

    expect(screen.getByRole("heading", { name: "Download the desktop app" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /macOS/ })).toHaveAttribute("href", "/desktop/download-macos");
    expect(screen.getByRole("link", { name: /Linux \(x64\)/ })).toHaveAttribute(
      "href",
      "/desktop/download/linux-x64",
    );
    expect(screen.getByRole("link", { name: /Linux \(ARM64\)/ })).toHaveAttribute(
      "href",
      "/desktop/download/linux-arm64",
    );
    expect(screen.getByRole("link", { name: /Windows/ })).toHaveAttribute("href", "/desktop/download/windows");
    // No install script for the desktop app any more — direct links only. (The CLI section below
    // still has its own `cli/install.sh` script, which is intentional and covered separately.)
    expect(document.body).not.toHaveTextContent("desktop/install.sh");
  });

  it("marks the one Windows installer as this computer on Windows on ARM", () => {
    platform = "windows-arm64";
    render(<Page />);

    expect(screen.getByRole("link", { name: /Windows/ })).toHaveTextContent("x64 and ARM · this computer");
    expect(screen.getAllByText(/this computer/)).toHaveLength(1);
  });

  it("guides users through the CLI install, from the shared constants", () => {
    render(<Page />);

    expect(screen.getByRole("heading", { name: "Install the CLI" })).toBeInTheDocument();
    expect(screen.getByText(INSTALL_COMMAND)).toBeInTheDocument();
    expect(INSTALL_COMMAND).toContain("https://harness.autonomous.ai/install.sh");
    expect(screen.getByText("harness login")).toBeInTheDocument();
    expect(screen.getByText("harness start")).toBeInTheDocument();
  });

  it("copies every CLI command to the clipboard when its row is clicked", async () => {
    render(<Page />);

    fireEvent.click(screen.getByRole("button", { name: "Copy 1. install" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND));

    fireEvent.click(screen.getByRole("button", { name: "Copy 2. sign in" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("harness login"));

    fireEvent.click(screen.getByRole("button", { name: "Copy 3. start" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("harness start"));

    expect(writeText).toHaveBeenCalledTimes(3);
  });
});
