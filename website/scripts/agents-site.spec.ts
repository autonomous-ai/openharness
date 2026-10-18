import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.js";

// The pages agents read (/agents and /llms.txt) and the skill they install describe commands an agent will run
// as written. These checks keep them true to the CLI, the plugin marketplace and the routes that serve them.
const site = process.cwd();
const repo = join(site, "..");
const page = readFileSync(join(site, "public", "agents", "index.html"), "utf8");
const llms = readFileSync(join(site, "public", "llms.txt"), "utf8");
const skillPath = join(repo, "plugins", "harness", "skills", "harness", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const cli = readFileSync(join(repo, "cli", "src", "cli.ts"), "utf8");
const agentVerbs = readFileSync(join(repo, "cli", "src", "agentClient", "commands.ts"), "utf8");
const marketplace = JSON.parse(readFileSync(join(repo, ".claude-plugin", "marketplace.json"), "utf8")) as {
  name: string;
  plugins: { name: string; source: string }[];
};

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

/** The code in a page: what an agent copies. Prose like "a harness you start" is not a command. */
function codeIn(text: string, html: boolean): string[] {
  const spans = html
    ? [...text.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1]))
    : [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g), ...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  // Shell comments explain a line; they are not run.
  return spans.map((span) => span.replace(/(^|\s)#.*$/gm, ""));
}

function verbsIn(text: string, html: boolean): Set<string> {
  const verbs = new Set<string>();
  for (const code of codeIn(text, html)) {
    for (const m of code.matchAll(/(?:^|[\s;&|(])harness ([a-z][a-z-]*)/gm)) verbs.add(m[1]);
  }
  return verbs;
}

describe("the pages and skill agents read", () => {
  // The CLI's commands: the cases of its dispatch, and the few it answers before it (`harness version`).
  const cliVerbs = new Set([...cli.matchAll(/^\s*case '([a-z][a-z-]*)':|\bcmd === '([a-z][a-z-]*)'/gm)].map((m) => m[1] ?? m[2]));

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s names only harness commands the CLI has", (_, text, html) => {
    const verbs = verbsIn(text, html);
    expect(verbs.size).toBeGreaterThan(3);
    for (const verb of verbs) expect(cliVerbs.has(verb), `harness ${verb}`).toBe(true);
  });

  // The agent commands each page must teach, and where each command's usage (its options) is written.
  const AGENT_VERBS = ["whoami", "ps", "new", "wait", "show", "send", "close"];
  const usageSources: Record<string, [string, string]> = {
    whoami: ["cli/src/agentClient/commands.ts", "WHOAMI_USAGE"],
    ps: ["cli/src/agentClient/commands.ts", "PS_USAGE"],
    show: ["cli/src/agentClient/commands.ts", "SHOW_USAGE"],
    wait: ["cli/src/agentClient/commands.ts", "WAIT_USAGE"],
    close: ["cli/src/agentClient/commands.ts", "CLOSE_USAGE"],
    new: ["cli/src/lib/newCommand.ts", "NEW_USAGE"],
    send: ["cli/src/messages/command.ts", "SEND_USAGE"],
  };
  /** The options a verb's usage names: every `--word` from `export const X` to the next export. */
  function usageFlags(verb: string): Set<string> {
    const [file, name] = usageSources[verb];
    const source = readFileSync(join(repo, file), "utf8");
    const start = source.indexOf(`export const ${name}`);
    expect(start, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\nexport ", start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    const flags = new Set([...block.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
    // `${ON_MACHINE}` stands for the --machine line the four verbs share.
    if (block.includes("${ON_MACHINE}")) flags.add("--machine");
    for (const always of ["--json", "--help"]) flags.add(always);
    return flags;
  }
  /** Each `harness <agent verb> …` in a page's code, with the options it uses (the task after ` -- ` left out). */
  function agentCalls(text: string, html: boolean): Array<{ verb: string; flags: string[]; line: string }> {
    const calls: Array<{ verb: string; flags: string[]; line: string }> = [];
    for (const code of codeIn(text, html)) {
      for (const m of code.matchAll(/(?:^|[\s;&|(])harness ([a-z][a-z-]*)([^\n]*)/gm)) {
        if (!AGENT_VERBS.includes(m[1]) && m[1] !== "whoami") continue;
        const rest = m[2].split(/\s--\s|&&|\|\||;|\|/)[0];
        calls.push({ verb: m[1], flags: [...rest.matchAll(/(?:^|[\s[(|])(--[a-z][a-z-]*)/g)].map((f) => f[1]), line: `harness ${m[1]}${m[2]}` });
      }
    }
    return calls;
  }

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s teaches every agent command", (_, text, html) => {
    const verbs = verbsIn(text, html);
    for (const verb of AGENT_VERBS) expect(verbs.has(verb), `harness ${verb}`).toBe(true);
  });

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s uses only options the agent commands take", (_, text, html) => {
    const calls = agentCalls(text, html);
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      if (!usageSources[call.verb]) continue;
      const known = usageFlags(call.verb);
      for (const flag of call.flags) expect(known.has(flag), `${flag} in: ${call.line}`).toBe(true);
    }
  });

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s names machines with --machine, never @", (_, text, html) => {
    // `harness new claude @office` became a project called "@office" on this machine; the CLI refuses it (#1333).
    for (const call of agentCalls(text, html)) expect(call.line.split(/\s--\s/)[0], call.line).not.toMatch(/\s@[A-Za-z]/);
  });

  it("gives the exit codes the agent commands return", () => {
    const literal = agentVerbs.match(/export const EXIT = \{([^}]*)\}/);
    expect(literal).not.toBeNull();
    const codes = [...literal![1].matchAll(/:\s*(\d+)/g)].map((m) => m[1]).sort();
    const table = page.slice(page.indexOf('id="exit-codes"'), page.indexOf('id="parallel"'));
    const listed = [...table.matchAll(/<tr><td><code>(\d+)<\/code><\/td>/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(codes);
  });

  it("answers the problems agents search for, in their words", () => {
    for (const heading of [
      "Run Claude Code agents in parallel",
      "Wait for a background agent to finish",
      "Hand a task to Codex and read its answer",
      "Keep working while another agent reviews",
    ]) expect(page).toMatch(new RegExp(`<h2 id="[a-z-]+">${heading}</h2>`));
  });

  it("is one plain file: no script, its canonical address, the llms.txt beside it", () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('<title>Harness for agents</title>');
    expect(page).toContain('<link rel="canonical" href="https://harness.autonomous.ai/agents">');
    expect(page).toContain('href="/llms.txt"');
    expect(llms.startsWith("# Harness\n\n> ")).toBe(true);
  });

  it("installs from the marketplace this repository defines", () => {
    const entry = marketplace.plugins.find((plugin) => plugin.name === "harness");
    expect(entry).toBeDefined();
    const id = `${entry!.name}@${marketplace.name}`;
    const pluginRoot = join(repo, entry!.source);
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    // The entry name is what people install; the manifest name namespaces the skill. Claude Code asks them to match.
    expect(manifest.name).toBe(entry!.name);
    expect(existsSync(join(pluginRoot, ".mcp.json"))).toBe(true);
    for (const text of [page, llms]) {
      expect(text).toContain("/plugin marketplace add autonomous-ai/openharness");
      expect(text).toContain(`/plugin install ${id}`);
      expect(text).toContain("codex plugin marketplace add autonomous-ai/openharness");
      expect(text).toContain(`codex plugin add ${id}`);
    }
  });

  it("checks out, with --sparse, the marketplace and the plugin it lists", () => {
    // A full clone of this repository was 670 MB and 70 seconds (135 for Codex); the sparse one 3 MB and 4. A
    // plugin moved outside the sparse paths would install from neither.
    const entry = marketplace.plugins.find((plugin) => plugin.name === "harness")!;
    for (const text of [page, llms]) {
      const claude = text.match(/claude plugin marketplace add autonomous-ai\/openharness --sparse ([^\n<`]+)/);
      const codex = text.match(/codex plugin marketplace add autonomous-ai\/openharness ((?:--sparse [^\s`<]+ ?)+)/);
      expect(claude).not.toBeNull();
      expect(codex).not.toBeNull();
      for (const paths of [claude![1].trim().split(/\s+/), codex![1].trim().split(/\s+/).filter((word) => word !== "--sparse")]) {
        expect(paths).toContain(".claude-plugin");
        expect(paths.some((path) => entry.source.replace(/^\.\//, "").startsWith(`${path}/`))).toBe(true);
        for (const path of paths) expect(existsSync(join(repo, path)), path).toBe(true);
      }
    }
  });

  it("installs the MCP server from each editor's link as the plugin registers it", () => {
    // The formats, as each editor documents them on 2026-10-11: Cursor (cursor.com/docs/mcp/install-links) and
    // LM Studio (lmstudio.ai/docs/app/mcp/deeplink) take a name and the base64 of the server's config; VS Code
    // (code.visualstudio.com/docs/copilot/guides/mcp-developer-guide) the URL-encoded config with its name in it,
    // and its mcp.json reference marks `type` required.
    const server = (JSON.parse(readFileSync(join(repo, "plugins", "harness", ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.harness;
    const links = [...page.matchAll(/href="((?:cursor|vscode|vscode-insiders|lmstudio|goose):[^"]+)"/g)].map((m) => decode(m[1]));
    const base64 = (value: string | null) => JSON.parse(Buffer.from(value ?? "", "base64").toString("utf8"));
    const query = (link: string) => new URL(link).searchParams;

    const cursor = links.filter((link) => link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?"));
    const vscode = links.filter((link) => /^vscode(-insiders)?:mcp\/install\?/.test(link));
    const lmstudio = links.filter((link) => link.startsWith("lmstudio://add_mcp?"));
    expect([cursor.length, vscode.length, lmstudio.length]).toEqual([1, 2, 1]);
    expect(links).toHaveLength(4);

    expect(query(cursor[0]).get("name")).toBe("harness");
    expect(base64(query(cursor[0]).get("config"))).toEqual(server);
    for (const link of vscode) expect(JSON.parse(decodeURIComponent(link.slice(link.indexOf("?") + 1)))).toEqual({ name: "harness", type: "stdio", ...(server as object) });
    expect(query(lmstudio[0]).get("name")).toBe("harness");
    expect(base64(query(lmstudio[0]).get("config"))).toEqual(server);

  });

  it("does not send agents to the npm package until it is published", () => {
    // npm answered 404 for @autonomous-ai/harness-mcp on 2026-10-15, and an agent that runs `npx` on it gets only an
    // error. Phase 10 of docs/design/2026-10-15-agent-experience.md publishes it and brings these back, with goose's
    // link (goose runs only commands such as npx).
    const npm = (JSON.parse(readFileSync(join(repo, "server.json"), "utf8")) as { packages: { registryType: string; identifier: string }[] })
      .packages.find((pkg) => pkg.registryType === "npm")!.identifier;
    for (const text of [page, llms, skill]) {
      expect(text).not.toContain(npm);
      expect(text).not.toContain("goose://");
    }
  });

  it("links the skill where it is in this repository", () => {
    for (const text of [page, llms]) {
      for (const m of text.matchAll(/https:\/\/(?:raw\.githubusercontent\.com\/autonomous-ai\/openharness\/main|github\.com\/autonomous-ai\/openharness\/(?:blob|tree)\/main)\/([^\s")]+)/g)) {
        expect(existsSync(join(repo, m[1])), m[1]).toBe(true);
      }
    }
  });

  it("keeps the skill within the Agent Skills format", () => {
    const front = skill.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
    expect(front).not.toBeNull();
    const [, name, description] = front!;
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(name).toBe("harness");
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  it("is served at /agents, unaltered, beside an install URL that resolves", async () => {
    const rewrites = await nextConfig.rewrites();
    expect(rewrites.beforeFiles).toContainEqual({ source: "/agents", destination: "/agents/index.html" });
    const headers = await nextConfig.headers();
    for (const source of ["/agents", "/agents/index.html", "/llms.txt"]) {
      const rule = headers.find((entry) => entry.source === source);
      expect(rule?.headers).toContainEqual({ key: "Cache-Control", value: "no-store, no-transform" });
    }
    const redirects = await nextConfig.redirects();
    expect(redirects.find((entry) => entry.source === "/cli/install.sh")?.destination).toMatch(/^https:\/\/cdn\.autonomous\.ai\//);
    for (const text of [page, llms, skill]) expect(text).toContain("curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash");
  });

  // Nothing else on the site links to /agents or /llms.txt (/ is the web app): a search engine, or an agent searching
  // the web, finds them through the sitemap robots.txt names.
  it("can be found: robots.txt names a sitemap that lists /agents and /llms.txt", () => {
    const robots = readFileSync(join(site, "public", "robots.txt"), "utf8");
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/harness\.autonomous\.ai\/sitemap\.xml$/m);
    const sitemap = readFileSync(join(site, "public", "sitemap.xml"), "utf8");
    for (const url of ["https://harness.autonomous.ai/agents", "https://harness.autonomous.ai/llms.txt"]) {
      expect(sitemap).toContain(`<loc>${url}</loc>`);
    }
  });
});
