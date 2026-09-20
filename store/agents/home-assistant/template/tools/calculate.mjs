import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import {
  CORE_VERSION,
  checkSource,
  revision,
  metadata,
  snapshot,
  unchanged,
  runtimeRevision,
} from "./project.mjs";

export async function pythonFor(root, explicit = process.env.HA_PYTHON) {
  const options = [
    explicit,
    process.env.HA_DSH_DIR &&
      join(process.env.HA_DSH_DIR, ".runtime/core/bin/python"),
    join(root, ".harness/runtime/bin/python"),
  ].filter(Boolean);
  for (const candidate of options) {
    const path = resolve(candidate);
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(
    "Home Assistant test runtime is missing. Run this harness's setup, or bash tools/setup.sh in an extracted project.",
  );
}
export async function engine(
  root,
  source,
  scenario,
  { python, signal, timeout = 30000, realClock = false } = {},
) {
  root = resolve(root);
  const interpreter = await pythonFor(root, python);
  const candidate = checkSource(source);
  const state = await metadata(root),
    testRoot = await mkdtemp(join(state, "jobs/run-"));
  try {
    const payload = JSON.stringify({
      ...candidate,
      scenario,
      testRoot,
      clock: realClock ? "realtime" : "controlled",
    });
    if (Buffer.byteLength(payload) > 3 * 1024 * 1024)
      throw new Error("Engine request exceeds 3 MiB.");
    return await new Promise((accept, reject) => {
      if (signal?.aborted) return reject(new Error("Test cancelled."));
      const child = spawn(
        interpreter,
        ["-I", "-X", "faulthandler", join(root, "tools/engine.py")],
        {
          cwd: testRoot,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: dirname(interpreter) + ":/usr/bin:/bin",
            LANG: "en_US.UTF-8",
          },
        },
      );
      const output = [],
        errors = [];
      let size = 0,
        errorSize = 0,
        failure;
      const stop = (message) => {
        failure ??= message;
        child.kill("SIGKILL");
      };
      const abort = () =>
        stop("Test cancelled. The last useful result is unchanged.");
      const timer = setTimeout(
        () =>
          stop(
            "Home Assistant exceeded the " +
              timeout / 1000 +
              "-second wall-clock budget for this scenario.",
          ),
        timeout,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (bytes) => {
        size += bytes.length;
        if (size > 8 * 1024 * 1024) stop("Engine result exceeds 8 MiB.");
        else output.push(bytes);
      });
      child.stderr.on("data", (bytes) => {
        errorSize += bytes.length;
        if (errorSize > 256 * 1024)
          stop("Engine error output exceeds its limit.");
        else errors.push(bytes);
      });
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        failure = error.message;
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) return reject(new Error(failure));
        const stderr = Buffer.concat(errors).toString("utf8");
        if (code !== 0)
          return reject(
            new Error(
              stderr.trim().slice(-8000) ||
                "Home Assistant did not complete this test (exit " +
                  code +
                  ", signal " +
                  exitSignal +
                  ").",
            ),
          );
        try {
          const result = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (
            result.scenario !== scenario ||
            result.engine?.version !== CORE_VERSION ||
            !Array.isArray(result.checks) ||
            result.checks.length < 3 ||
            typeof result.passed !== "boolean" ||
            result.passed !== result.checks.every((c) => c.passed === true) ||
            !Array.isArray(result.traces) ||
            !Array.isArray(result.calls) ||
            !Array.isArray(result.changes) ||
            !Array.isArray(result.rules) ||
            !result.rules.length
          )
            throw new Error("Unexpected Home Assistant result.");
          accept(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(payload);
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}
export async function calculate(
  root,
  raw,
  {
    scenario,
    python,
    signal,
    progress = () => {},
    runtime,
    budget = 180000,
  } = {},
) {
  const source = checkSource(raw),
    selected = scenario
      ? source.project.scenarios.filter((c) => c.id === scenario)
      : source.project.scenarios;
  if (!selected.length) throw new Error("Choose a declared scenario.");
  const files = runtime || (await snapshot(root)),
    results = [];
  const started = performance.now();
  for (let index = 0; index < selected.length; index++) {
    if (signal?.aborted) throw new Error("Test cancelled.");
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0)
      throw new Error("The scenario suite exceeded its wall-clock budget.");
    progress({ index, total: selected.length, name: selected[index].name });
    results.push(
      await engine(root, source, selected[index].id, {
        python,
        signal,
        timeout: Math.min(30000, remaining),
      }),
    );
    await unchanged(root, files);
  }
  const sourceRevision = revision(source);
  const rules = new Map(
    results[0].rules.map((rule) => [
      rule.id,
      { ...rule, completed: [], blocked: [] },
    ]),
  );
  for (const result of results)
    for (const trace of result.traces) {
      const entry = rules.get(trace.item_id) || {
        id: trace.item_id,
        alias: trace.config?.alias || trace.item_id,
        completed: [],
        blocked: [],
      };
      const acted = result.calls.some(
        (call) =>
          call.context === trace.context?.id ||
          call.parent === trace.context?.id,
      );
      if (
        !trace.not_triggered &&
        trace.script_execution === "finished" &&
        !trace.error &&
        acted
      )
        entry.completed.push(result.scenario);
      else if (
        trace.not_triggered ||
        trace.script_execution === "failed_conditions" ||
        (!trace.error && !result.calls.length)
      )
        entry.blocked.push(result.scenario);
      rules.set(trace.item_id, entry);
    }
  const complete =
    !scenario && results.length === source.project.scenarios.length;
  const suiteChecks = complete
    ? [...rules.values()].map((rule) => ({
        name: "Executed with a service call: " + rule.alias,
        passed: rule.completed.length > 0,
        expected:
          "At least one successful native execution with a captured service call",
        actual: [...new Set(rule.completed)],
      }))
    : [];
  return {
    spec: 1,
    sourceRevision,
    runtimeRevision: runtimeRevision(files),
    engine: CORE_VERSION,
    at: new Date().toISOString(),
    complete,
    passed:
      results.every((r) => r.passed) && suiteChecks.every((c) => c.passed),
    results,
    suiteChecks,
    coverage: [...rules.values()],
    scope:
      "Real Core automation logic; controlled clock, declared device doubles and non-persistent registries. No installation, discovery, restart/restore or physical device test.",
    revisionNote:
      "Changing YAML, entities, tests or notes invalidates this source-bound result.",
  };
}
