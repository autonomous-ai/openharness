import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fetchDeviceRelease, parseDeviceRelease } from "@/lib/deviceRelease";
import DevicePage, { metadata } from "./page";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
}));
vi.mock("@/lib/useVisitorPlatform", () => ({ useVisitorPlatform: () => "macos" }));
vi.mock("@/lib/deviceRelease", async (orig) => ({
  ...(await orig<typeof import("@/lib/deviceRelease")>()),
  fetchDeviceRelease: vi.fn(),
}));

const CDN = "https://cdn.autonomous.ai/harness/device/0.1.10/";
const DMG = `${CDN}Harness-Device.dmg`;

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
  notes:
    "Harness Device 0.1.10\n\n- Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone (#4498)\n- Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once (#4469)",
};

async function renderPage(manifest: unknown) {
  vi.mocked(fetchDeviceRelease).mockResolvedValue(manifest === null ? null : parseDeviceRelease(manifest));
  render(await DevicePage());
}

function downloadsPanel(): HTMLElement {
  return screen.getByRole("heading", { name: "Downloads" }).parentElement!;
}

describe("/device", () => {
  it("is the guide, with this release's notes and downloads", async () => {
    await renderPage(LIVE);

    for (const name of ["Get the app.", "Plug in.", "Open your agents.", "Tap. Talk.", "Send.", "Swipe.", "Scroll.", "Hold."]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("Drag up or down to read back.")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("up to 10 minutes a message");
    expect(document.body).toHaveTextContent("30 minutes a day");
    for (const app of ["Claude", "ChatGPT", "VS Code", "Cursor", "Orca", "herdr", "Terminal", "More joining"]) {
      expect(screen.getByText(app)).toBeInTheDocument();
    }
    for (const summary of [
      "The menu says “Plug in your device”.",
      "An agent is missing on the device.",
      "Voice stops or doesn't send.",
      "More than one computer?",
      "Something else is wrong.",
    ]) {
      expect(screen.getByText(summary)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Export logs").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "human@autonomous.ai" })[0]).toHaveAttribute("href", "mailto:human@autonomous.ai");
    expect(screen.getByRole("link", { name: "Product page ↗" })).toHaveAttribute("href", "https://www.autonomous.ai/harness-device");

    const notes = screen.getByRole("heading", { name: "Version 0.1.10" }).parentElement!;
    expect(within(notes).getByText("Nov 19, 2026")).toBeInTheDocument();
    expect(within(notes).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone",
      "Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once",
    ]);
    expect(document.body).not.toHaveTextContent("#4498");

    const files = downloadsPanel();
    const mac = within(files).getByRole("link", { name: "Mac · Apple silicon and Intel" });
    expect(mac).toHaveAttribute("href", DMG);
    const row = mac.closest("li")!;
    expect(row).toHaveTextContent(".dmg · 11.1 MB");
    expect(row).toHaveTextContent("This computer");
    expect(screen.getAllByText("This computer")).toHaveLength(1);
  });

  it("still offers the Mac download, with no version, when the manifest is unusable", async () => {
    await renderPage(null);

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/device/download-macos");
    expect(screen.queryByRole("heading", { name: /^Version / })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Version 0.1.10");
    const links = within(downloadsPanel()).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/device/download-macos");
    expect(screen.queryByText("This computer")).not.toBeInTheDocument();
  });

  it("shows the version with no list when the notes have no bullet line", async () => {
    await renderPage({ ...LIVE, notes: "Harness Device 0.1.10" });

    const notes = screen.getByRole("heading", { name: "Version 0.1.10" }).parentElement!;
    expect(within(notes).queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows two notes that read the same once their pull request numbers are gone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    await renderPage({ ...LIVE, notes: "- Fix the cable check (#1)\n- Fix the cable check (#2)" });

    const notes = screen.getByRole("heading", { name: "Version 0.1.10" }).parentElement!;
    expect(within(notes).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Fix the cable check", "Fix the cable check"]);
    expect(error).not.toHaveBeenCalled();
  });

  it("names the page for a person", () => {
    expect(metadata).toEqual({ title: "Harness Device", description: "Set up and use your Harness Device." });
  });
});
