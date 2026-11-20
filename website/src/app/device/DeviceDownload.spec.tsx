import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitorPlatform } from "@/lib/desktopPlatform";
import { parseDeviceRelease, type DeviceBuild } from "@/lib/deviceRelease";

let platform: VisitorPlatform | null = null;
vi.mock("@/lib/useVisitorPlatform", () => ({ useVisitorPlatform: () => platform }));

const { DeviceDownload } = await import("./DeviceDownload");

const CDN = "https://cdn.autonomous.ai/harness/device/0.1.10/";
const DMG = `${CDN}Harness-Device.dmg`;
const MAC_LINE = "For Mac · Apple silicon and Intel · version 0.1.10 · macOS 13 or later";

// The shape of the live device manifest on 2026-11-20.
const LIVE = {
  version: "0.1.10",
  pub_date: "2026-11-19T15:19:46Z",
  platforms: {
    "darwin-aarch64": { url: `${CDN}Harness-Device.app.tar.gz`, signature: "s" },
    "darwin-x86_64": { url: `${CDN}Harness-Device.app.tar.gz`, signature: "s" },
  },
  "device-macos": { url: `${CDN}Harness-Device.app.tar.gz`, size: 11000000 },
  "device-macos-arm64": { url: `${CDN}Harness-Device.app.tar.gz`, size: 11000000 },
  "device-macos-dmg": { url: DMG, size: 11650555 },
  "device-macos-arm64-dmg": { url: DMG, size: 11650555 },
  notes: "Harness Device 0.1.10\n\n- Harness Device: the Orca plugin is set up by default (#4498)",
};

function builds(extra: Record<string, unknown> = {}): DeviceBuild[] {
  return parseDeviceRelease({ ...LIVE, ...extra })!.builds;
}

const WINDOWS = { "device-windows-x64-msi": { url: `${CDN}Harness-Device.msi`, size: 1 } };
const LINUX_DEB = `${CDN}Harness-Device.deb`;
const LINUX = { "device-linux-x64-deb": { url: LINUX_DEB, size: 1 } };

describe("the /device download offer", () => {
  beforeEach(() => {
    platform = null;
  });

  it("gives a Mac the dmg, its line and nothing else", () => {
    platform = "macos";
    const { container } = render(<DeviceDownload builds={builds()} version="0.1.10" />);

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", DMG);
    expect(container).toHaveTextContent(MAC_LINE);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("renders the Mac offer before the browser has answered", () => {
    platform = null;
    const { container } = render(<DeviceDownload builds={builds()} version="0.1.10" />);

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", DMG);
    expect(container).toHaveTextContent(MAC_LINE);
  });

  it.each(["windows", "linux"] as const)("tells a %s visitor it is macOS-only and still offers the Mac dmg", (p) => {
    platform = p;
    const { container } = render(<DeviceDownload builds={builds()} version="0.1.10" />);

    expect(screen.getByText("Harness Device is macOS-only for now.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", DMG);
    expect(container).toHaveTextContent(MAC_LINE);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("names the visitor's OS when other OSes have builds but not this one", () => {
    platform = "linux-x64";
    render(<DeviceDownload builds={builds(WINDOWS)} version="0.1.10" />);

    expect(screen.getByText("Harness Device isn't on Linux yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", DMG);
    expect(screen.getByRole("link", { name: "Windows · x64" })).toBeInTheDocument();
  });

  it("sends a phone to a computer and lists every build", () => {
    platform = "mobile";
    render(<DeviceDownload builds={builds()} version="0.1.10" />);

    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    expect(screen.getByText("Open this page on your computer to download the app.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mac · Apple silicon and Intel" })).toHaveAttribute("href", DMG);
  });

  it("gives a Linux x64 visitor its own build, with the Mac one as a link", () => {
    platform = "linux-x64";
    const { container } = render(<DeviceDownload builds={builds(LINUX)} version="0.1.10" />);

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", LINUX_DEB);
    expect(container).toHaveTextContent("For Linux · x64 · version 0.1.10");
    expect(container).not.toHaveTextContent("macOS 13");
    expect(screen.getByRole("link", { name: "Mac · Apple silicon and Intel" })).toHaveAttribute("href", DMG);
  });

  it("does not guess a Linux CPU it does not know: every build is a link, no button", () => {
    platform = "linux";
    const { container } = render(<DeviceDownload builds={builds(LINUX)} version="0.1.10" />);

    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("Harness Device is");
    expect(container).not.toHaveTextContent("Harness Device isn't");
    expect(screen.getByRole("link", { name: "Mac · Apple silicon and Intel" })).toHaveAttribute("href", DMG);
    expect(screen.getByRole("link", { name: "Linux · x64" })).toHaveAttribute("href", LINUX_DEB);
  });

  it("falls back to the Mac route with no version when there is no release", () => {
    platform = "macos";
    const { container } = render(<DeviceDownload builds={[]} version={null} />);

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/device/download-macos");
    expect(container).toHaveTextContent("For Mac · macOS 13 or later");
    expect(container).not.toHaveTextContent("version");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
