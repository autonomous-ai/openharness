// @vitest-environment node
import Ajv from "ajv";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ASSET, MCPB, releasedServerJson } from "../../cli/packages/harness-mcp/mcpb/build.mjs";

// The files directories read to list Harness (docs/research/2026-10-11-listing-submissions.md): server.json for the
// Official MCP Registry, the MCP Bundle's manifest, the Cursor plugin and glama.json. A directory rejects a bad one
// only when it is submitted, after a release; these checks reject it here.
//
// The schemas are vendored as published on 2026-10-11: the registry's from
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json, the bundle's from
// github.com/modelcontextprotocol/mcpb schemas/mcpb-manifest-v0.3.schema.json (the version `mcpb pack` 2.1.2 checks).
const repo = join(process.cwd(), "..");
const read = (...path: string[]) => readFileSync(join(repo, ...path), "utf8");
const json = (...path: string[]) => JSON.parse(read(...path));
const schemas = join(process.cwd(), "scripts", "schemas");
const ajv = new Ajv({ allErrors: true });
const registrySchema = JSON.parse(readFileSync(join(schemas, "mcp-registry-server-2025-12-11.schema.json"), "utf8"));
const validServer = ajv.compile(registrySchema);
const validManifest = ajv.compile(JSON.parse(readFileSync(join(schemas, "mcpb-manifest-0.3.schema.json"), "utf8")));

interface Pkg { registryType: string; identifier: string; version?: string; fileSha256?: string; registryBaseUrl?: string; transport: { type: string } }
interface Server { $schema: string; name: string; description: string; version: string; packages: Pkg[] }

const server = json("server.json") as Server;
const manifest = json("cli", "packages", "harness-mcp", "mcpb", "manifest.json");

/** What the registry checks beyond the schema when it publishes (its internal/validators, read on 2026-10-11). */
function registryRules(entry: Server) {
  expect(entry.name).toBe("ai.autonomous.harness/harness");
  expect(entry.packages.map((pkg) => pkg.registryType).sort()).toEqual(["mcpb", "npm"]);
  for (const pkg of entry.packages) expect(pkg.transport).toEqual({ type: "stdio" });
  const npm = entry.packages.find((pkg) => pkg.registryType === "npm")!;
  expect(npm.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(npm.fileSha256).toBeUndefined();
  expect([undefined, "https://registry.npmjs.org"]).toContain(npm.registryBaseUrl);
  const mcpb = entry.packages.find((pkg) => pkg.registryType === "mcpb")!;
  expect(mcpb.registryBaseUrl).toBeUndefined();
  expect(mcpb.fileSha256).toMatch(/^[a-f0-9]{64}$/);
  // A GitHub release asset, and the URL must say "mcp".
  expect(mcpb.identifier).toMatch(/^https:\/\/github\.com\/autonomous-ai\/openharness\/releases\/download\/[^/]+\/[^/]+$/);
  expect(mcpb.identifier.toLowerCase()).toContain("mcp");
}

describe("the files directories list Harness from", () => {
  it("server.json follows the registry's schema and rules, with placeholders the build fills", () => {
    expect(server.$schema).toBe(registrySchema.$id);
    expect(validServer(server), ajv.errorsText(validServer.errors)).toBe(true);
    registryRules(server);
    expect(server.version).toBe("0.0.0");
    expect(server.packages.find((pkg) => pkg.registryType === "mcpb")!.fileSha256).toBe("0".repeat(64));
  });

  it("the server.json a release publishes points at that release's bundle", () => {
    const sha256 = "ab".repeat(32);
    const released = releasedServerJson(server, { version: "0.3.74", tag: "v0.3.74_cli", sha256, npmVersion: "0.1.0" }) as Server;
    expect(validServer(released), ajv.errorsText(validServer.errors)).toBe(true);
    registryRules(released);
    expect(released.version).toBe("0.3.74");
    expect(released.packages.find((pkg) => pkg.registryType === "mcpb")).toMatchObject({
      identifier: `https://github.com/autonomous-ai/openharness/releases/download/v0.3.74_cli/${ASSET}`,
      fileSha256: sha256,
    });
    expect(server.version).toBe("0.0.0");
  });

  it("names the npm package that names this server", () => {
    const npm = server.packages.find((pkg) => pkg.registryType === "npm")!;
    expect(npm.identifier).toBe("@autonomous-ai/harness-mcp");
    const packageJson = join(repo, "cli", "packages", "harness-mcp", "package.json");
    // The registry accepts the npm entry only when the package's `mcpName` is this server's name.
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
      expect(pkg.name).toBe(npm.identifier);
      expect(pkg.mcpName).toBe(server.name);
    }
  });

  it("the bundle's manifest follows the MCPB schema and lists the tools harness mcp serves", () => {
    expect(validManifest(manifest), ajv.errorsText(validManifest.errors)).toBe(true);
    expect(MCPB).toMatch(/^@anthropic-ai\/mcpb@\d+\.\d+\.\d+$/);
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.version).toBe("0.0.0");
    // build.mjs puts the npm package's bin.mjs at server/bin.mjs; Claude Desktop runs it on its own Node.
    expect(manifest.server).toEqual({ type: "node", entry_point: "server/bin.mjs", mcp_config: { command: "node", args: ["${__dirname}/server/bin.mjs"] } });
    expect(manifest.description).toBe(server.description);
    expect(manifest.long_description).toContain("curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash");
    // harness_send is offered only inside a harness's pane, which an app's server never runs in.
    const served = [...read("cli", "src", "agentClient", "mcp.ts").matchAll(/^\s+name: '(harness_[a-z]+)',$/gm)].map((m) => m[1]);
    expect(served).toContain("harness_send");
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(served.filter((name) => name !== "harness_send"));
  });

  it("the Cursor plugin is the same plugin, with the same MCP server", () => {
    const marketplace = json(".cursor-plugin", "marketplace.json");
    const claudeMarketplace = json(".claude-plugin", "marketplace.json");
    expect(marketplace.name).toBe(claudeMarketplace.name);
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.source).not.toMatch(/^\.|\.\./);
    expect(join(repo, entry.source)).toBe(join(repo, claudeMarketplace.plugins[0].source));
    const plugin = json(entry.source, ".cursor-plugin", "plugin.json");
    expect(plugin.name).toBe(entry.name);
    expect(plugin.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(plugin.name).toBe(json(entry.source, ".claude-plugin", "plugin.json").name);
    // Cursor resolves a relative logo inside the repository and refuses `..` and absolute paths.
    expect(plugin.logo).not.toMatch(/^\/|\.\./);
    expect(existsSync(join(repo, entry.source, plugin.logo))).toBe(true);
    // Cursor reads mcp.json, Claude Code .mcp.json: one server, written twice.
    expect(json(entry.source, "mcp.json")).toEqual(json(entry.source, ".mcp.json"));
    expect(existsSync(join(repo, entry.source, "skills", "harness", "SKILL.md"))).toBe(true);
  });

  it("the Codex manifest is the same plugin, with the same MCP server, its tools approved", () => {
    const source = json(".claude-plugin", "marketplace.json").plugins[0].source;
    const claude = json(source, ".claude-plugin", "plugin.json");
    const codex = json(source, ".codex-plugin", "plugin.json");
    // Codex reads .codex-plugin/plugin.json before .claude-plugin/plugin.json, and its server from there.
    for (const key of ["name", "description", "keywords", "homepage", "repository", "license"]) expect(codex[key]).toEqual(claude[key]);
    expect(codex.interface.displayName).toBe(claude.displayName);
    // The server Claude Code and Cursor run, and Codex's own setting that it runs Harness's tools without asking:
    // Harness decides what an agent may do with them. A setting the person makes for it in config.toml still wins.
    const { harness } = json(source, ".mcp.json").mcpServers;
    expect(codex.mcpServers).toEqual({ harness: { ...harness, default_tools_approval_mode: "approve" } });
  });

  it("glama.json names maintainers, and the image Glama builds runs harness mcp from the installer", () => {
    const glama = json("glama.json");
    expect(glama.$schema).toBe("https://glama.ai/mcp/schemas/server.json");
    expect(glama.maintainers.length).toBeGreaterThan(0);
    expect(new Set(glama.maintainers).size).toBe(glama.maintainers.length);
    const dockerfile = read("cli", "docker", "harness-mcp", "Dockerfile");
    expect(dockerfile).toContain("RUN curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash");
    expect(dockerfile).toMatch(/^CMD \["harness", "mcp"\]$/m);
  });
});
