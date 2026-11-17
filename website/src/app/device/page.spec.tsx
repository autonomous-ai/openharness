import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DevicePage from "./page";

describe("/device", () => {
  it("names the app and offers one Download link to the dmg route", () => {
    render(<DevicePage />);

    expect(screen.getByRole("heading", { name: "Harness" })).toBeInTheDocument();
    expect(screen.getByText("The menu-bar app for the dial. macOS 13 or later.")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Download");
    expect(links[0]).toHaveAttribute("href", "/device/download-macos");
  });
});
