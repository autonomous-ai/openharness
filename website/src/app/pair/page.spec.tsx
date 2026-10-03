import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PairPage from "./page";

describe("/pair — the desktop app's Add phone QR, scanned with the Camera app", () => {
  it("says to scan it from the Harness app, and asks for nothing", () => {
    render(<PairPage />);

    expect(screen.getByRole("heading", { name: "Scan this from the Harness app" })).toBeInTheDocument();
    expect(document.body).toHaveTextContent("Yes — scan to connect");
    // The fragment holds a one-time pairing code: nothing here may take input or show it back.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
