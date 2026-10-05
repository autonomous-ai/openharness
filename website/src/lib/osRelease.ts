const repository = "https://github.com/autonomous-ai/openharness";
const api = "https://api.github.com/repos/autonomous-ai/openharness/releases";

type Candidate = { version: number[]; preview: boolean; url: string };

function candidate(value: unknown): Candidate | undefined {
  if (!value || typeof value !== "object") return;
  const release = value as Record<string, unknown>;
  if (release.draft !== false || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) return;
  const match = /^os-v(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(release.tag_name);
  if (!match) return;
  const preview = match[4] !== undefined;
  if (release.prerelease !== preview) return;
  const version = [match[1], match[2], match[3], match[4] || "0"].map(Number);
  if (!version.every(Number.isSafeInteger)) return;
  const names = new Set(release.assets.flatMap((asset: unknown) => {
    if (!asset || typeof asset !== "object") return [];
    const item = asset as Record<string, unknown>;
    return item.state === "uploaded" && typeof item.name === "string" ? [item.name] : [];
  }));
  const iso = `harness-${release.tag_name.slice(4)}-x86_64.iso`;
  if (![iso, iso + ".sha256", "INSTALL.md", "manifest.json", "validation.json"].every(name => names.has(name))) return;
  // Construct the destination ourselves; never trust an upstream redirect URL.
  return { version, preview, url: `${repository}/releases/tag/${release.tag_name}` };
}

export function latestOSRelease(releases: unknown[]): string {
  const candidates = releases.flatMap(value => candidate(value) || []);
  // Stable OS releases are the default once available. Until then, use the
  // highest numbered preview, not GitHub's mixed-product display order.
  candidates.sort((a, b) => Number(a.preview) - Number(b.preview) ||
    b.version[0] - a.version[0] || b.version[1] - a.version[1] ||
    b.version[2] - a.version[2] || b.version[3] - a.version[3]);
  if (!candidates.length) throw new Error("No complete OS release is available");
  return candidates[0].url;
}

export async function fetchLatestOSRelease(): Promise<string> {
  const releases: unknown[] = [];
  const signal = AbortSignal.timeout(15_000);
  // The monorepo publishes several products. Read every page so frequent app
  // releases cannot push the OS out of the result, with a bounded failure path.
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(`${api}?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store", signal,
    });
    if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid release response");
    releases.push(...data);
    if (!/rel="next"/.test(response.headers.get("link") || "")) return latestOSRelease(releases);
  }
  throw new Error("Release pagination did not finish");
}
