import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitorPlatform } from "@/lib/desktopPlatform";

let platform: VisitorPlatform | null = null;
vi.mock("@/lib/useVisitorPlatform", () => ({ useVisitorPlatform: () => platform }));

const { DesktopDownload } = await import("./DesktopDownload");

describe("the /desktop download offer", () => {
  beforeEach(() => {
    platform = null;
  });

  it("gives a Windows visitor the installer, the way past SmartScreen, and the PowerShell line", () => {
    platform = "windows";
    render(<DesktopDownload />);

    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", "/desktop/download/windows");
    expect(screen.getByText("Download the installer and open it. It sets up Harness and opens the app.")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("isn't code-signed yet, so Windows may say it protected your PC. Choose More info, then Run anyway.");
    // Its own code element, so a copy takes the command and nothing after it.
    expect(screen.getByText("irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "macOS" })).toHaveAttribute("href", "/desktop/download-macos");
    expect(screen.getByRole("link", { name: "Linux (x64)" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("no Windows version");
  });

  it("lists Windows among the other downloads on a Mac", () => {
    platform = "macos-arm64";
    render(<DesktopDownload />);

    expect(screen.getByRole("link", { name: "Windows" })).toHaveAttribute("href", "/desktop/download/windows");
  });

  it("names Windows among the computers a phone visitor can open the page on", () => {
    platform = "mobile";
    render(<DesktopDownload />);

    expect(document.body).toHaveTextContent("runs on a Mac, a Windows PC or a Linux computer");
  });
});
