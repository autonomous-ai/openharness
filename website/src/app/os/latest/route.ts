import { unstable_cache } from "next/cache";
import { fetchLatestOSRelease } from "@/lib/osRelease";

export const dynamic = "force-dynamic";

// Share a short server-side lookup cache; browsers must never pin the redirect.
const latest = unstable_cache(fetchLatestOSRelease, ["harness-os-release-v1"], { revalidate: 300 });

export async function GET(): Promise<Response> {
  try {
    return new Response(null, {
      status: 302,
      headers: { Location: await latest(), "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return new Response("Harness downloads are temporarily unavailable. Please try again shortly.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
