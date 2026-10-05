import { afterEach, expect, it, vi } from "vitest";
import { fetchLatestOSRelease } from "@/lib/osRelease";
import { GET } from "./route";

vi.mock("@/lib/osRelease", () => ({ fetchLatestOSRelease: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (callback: () => Promise<string>) => callback }));
afterEach(() => vi.resetAllMocks());

it("redirects to the OS release without caching the browser's destination", async () => {
  const url = "https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.13";
  vi.mocked(fetchLatestOSRelease).mockResolvedValue(url);
  const response = await GET();
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(url);
  expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
});

it("offers a retry instead of a broken or unrelated download when lookup fails", async () => {
  vi.mocked(fetchLatestOSRelease).mockRejectedValue(new Error("upstream unavailable"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(response.headers.get("Location")).toBeNull();
  expect(response.headers.get("Retry-After")).toBe("60");
});
