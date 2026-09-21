import {
  CORE_VERSION,
  json,
  sha,
  revision,
  runtimeRevision,
  savedProject,
} from "./project.mjs";
import { zip } from "./archive.mjs";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (value) => esc(JSON.stringify(value, null, 2));

export function integrationGuide(source, result) {
  const helpers = source.project.entities.filter((e) =>
    ["input_boolean", "input_number"].includes(e.kind),
  );
  return (
    "# Reviewed Home Assistant handoff\n\n" +
    (source.project.example
      ? "**EXAMPLE DEVICES — do not install unchanged.**\n\n"
      : "**Verify every entity ID and device capability before installation.**\n\n") +
    "This project was tested with Home Assistant Core " +
    CORE_VERSION +
    ", controlled time and declared device doubles. It did not connect to or test your installation, physical sensors, devices, network, restart behavior or notifications on a phone.\n\n" +
    "## Before installing\n\n" +
    "1. Back up your Home Assistant installation and current automation configuration. Keep the backup outside this new delivery folder.\n" +
    "2. Match the IDs in entities.json to your actual entities. Confirm states, units, capabilities, time zone and thresholds. Ask the agent to revise the source and tests, then rerun the suite.\n" +
    "3. Create or confirm these native helpers in Home Assistant; do not overwrite existing helpers:\n" +
    (helpers.length
      ? helpers
          .map(
            (e) =>
              "   - " +
              e.id +
              " — " +
              e.name +
              (e.kind === "input_number"
                ? "; choose appropriate real min/max/step values."
                : "."),
          )
          .join("\n")
      : "   - No native helpers are required.") +
    "\n" +
    "4. Import only the reviewed automation entries, keeping unrelated automations and configuration intact. For a YAML-managed installation, merge entries into its automation list; never replace configuration.yaml with this project.\n" +
    "5. Run the configuration check on your actual installation/version. The lab's version-specific tests are not a substitute. Check the Home Assistant documentation for your installation method.\n" +
    "6. Each delivered automation contains initial_state: false. It remains disabled at startup until you deliberately review and change that setting. After approval, remove that line if you want Home Assistant to restore its previous enabled state; then enable the automation in Home Assistant.\n" +
    "7. Perform a supervised, appropriate real-world test and inspect Home Assistant's own traces, including an important non-firing case. Do not use 'Run actions' as proof of trigger/condition behavior.\n" +
    "8. To roll back, disable the new automation and restore the affected entries from your backup. Restore helper definitions only if you changed them, without deleting unrelated state.\n\n" +
    "No automatic deployment, service call, account connection or upload is included. Locks, doors, heating, mains-powered equipment and other consequential devices require suitable hardware safeguards and actual validation.\n\n" +
    "## Test evidence\n\nSource revision: " +
    result.sourceRevision +
    "\nCore version: " +
    result.engine +
    "\nCompleted scenarios: " +
    result.results.length +
    "\nAll assertions passed: " +
    result.passed +
    "\n\nresults.json contains actual engine traces, exact captured service calls, time windows, final states and test-double effects. report.html is an inert readable copy. Traces include the project's entity states and text; review exports before sharing.\n\n" +
    "Official guidance:\n- https://www.home-assistant.io/docs/automation/troubleshooting/\n- https://www.home-assistant.io/common-tasks/container/#configuration-check\n- https://www.home-assistant.io/docs/automation/yaml/\n"
  );
}

export function report(source, result) {
  const cases = result.results
    .map(
      (item) =>
        "<section><h2>" +
        esc(item.name) +
        " · " +
        (item.passed ? "Passed" : "Needs attention") +
        "</h2><p>" +
        esc(source.project.scenarios.find((c) => c.id === item.scenario)?.why) +
        "</p>" +
        "<h3>Actual service calls in the isolated engine</h3>" +
        (item.calls.length
          ? "<table><thead><tr><th>Time</th><th>Service</th><th>Entities</th><th>Data</th></tr></thead><tbody>" +
            item.calls
              .map(
                (call) =>
                  "<tr><td>+" +
                  esc(call.at) +
                  " s</td><td>" +
                  esc(call.service) +
                  "</td><td>" +
                  esc(call.entities.join(", ")) +
                  "</td><td><code>" +
                  esc(JSON.stringify(call.data)) +
                  "</code></td></tr>",
              )
              .join("") +
            "</tbody></table>"
          : "<p>No service calls. See the assertions and native traces below.</p>") +
        "<h3>Assertions</h3><ul>" +
        item.checks
          .map(
            (check) =>
              "<li>" +
              (check.passed ? "PASS" : "FAIL") +
              " · " +
              esc(check.name) +
              (check.passed
                ? ""
                : "<pre>Expected: " +
                  pretty(check.expected) +
                  "\nActual: " +
                  pretty(check.actual) +
                  "</pre>") +
              "</li>",
          )
          .join("") +
        "</ul>" +
        "<details><summary>Exact final entity states</summary><pre>" +
        pretty(item.states) +
        "</pre></details>" +
        "<details><summary>Original Home Assistant execution traces</summary><pre>" +
        pretty(item.traces) +
        "</pre></details></section>",
    )
    .join("");
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(source.project.title) +
    " — Habitat report</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1050px;margin:40px auto;padding:0 24px;color:#16342e;background:#f5f8f4}h1{font-size:36px;line-height:1.15}h2{font-size:24px}section{background:white;border:1px solid #ccd9d0;border-radius:14px;padding:24px;margin:24px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f2;padding:16px;font-size:12px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ccd9d0;padding:10px;overflow-wrap:anywhere}code{font-size:12px}details{margin:16px 0}header p{overflow-wrap:anywhere}.notice{border-left:4px solid #997223;padding:16px;background:#fff5d8}@media(max-width:600px){body{padding:0 14px;margin:20px auto}section{padding:14px}table{font-size:12px;table-layout:fixed}}</style><body><header><p>HABITAT · HOME ASSISTANT CORE " +
    esc(CORE_VERSION) +
    "</p><h1>" +
    esc(source.project.title) +
    "</h1><p>" +
    esc(source.project.brief) +
    '</p><p class="notice">' +
    (source.project.example
      ? "EXAMPLE DEVICES. "
      : "DECLARED DEVICE TEST DOUBLES. ") +
    "Real Core automation logic; controlled time and simulated hardware. No live installation or physical device was tested.</p><p>Time zone: " +
    esc(source.project.timezone) +
    " · " +
    result.results.length +
    " scenarios · " +
    (result.passed
      ? "All declared assertions passed"
      : "Some assertions failed") +
    "</p><p>Source revision: " +
    esc(result.sourceRevision) +
    "</p><p>Notes: " +
    esc(source.project.notes) +
    "</p></header>" +
    cases +
    "<footer>Keep the editable project and test evidence. Review entity IDs, helpers and hardware behavior before installation.</footer></body></html>"
  );
}

export function makeDelivery(source, result, runtime) {
  if (
    !result.complete ||
    !result.passed ||
    result.sourceRevision !== revision(source) ||
    result.runtimeRevision !== runtimeRevision(runtime) ||
    result.engine !== CORE_VERSION
  )
    throw new Error(
      "Run all scenarios successfully for this exact source and runtime before exporting a checked delivery.",
    );
  const files = [
    { name: "automations.yaml", bytes: Buffer.from(source.yaml) },
    {
      name: "project.habitat.json",
      bytes: Buffer.from(json(savedProject(source))),
    },
    { name: "results.json", bytes: Buffer.from(json(result)) },
    {
      name: "entities.json",
      bytes: Buffer.from(
        json({
          example: source.project.example,
          timezone: source.project.timezone,
          entities: source.project.entities,
        }),
      ),
    },
    { name: "report.html", bytes: Buffer.from(report(source, result)) },
    {
      name: "INTEGRATION.md",
      bytes: Buffer.from(integrationGuide(source, result)),
    },
  ];
  const manifest = {
    spec: 1,
    harness: "autonomous/home-assistant",
    sourceRevision: result.sourceRevision,
    runtimeRevision: result.runtimeRevision,
    engine: result.engine,
    checkedAt: result.at,
    files: files.map((f) => ({
      name: f.name,
      bytes: f.bytes.length,
      sha256: sha(f.bytes),
    })),
  };
  files.push({ name: "manifest.json", bytes: Buffer.from(json(manifest)) });
  const portable = [
    ...runtime,
    { name: "project.json", bytes: Buffer.from(json(source.project)) },
    { name: "automations.yaml", bytes: Buffer.from(source.yaml) },
    ...files.map((f) => ({ name: "output/" + f.name, bytes: f.bytes })),
  ];
  files.push({ name: "project.zip", bytes: zip(portable) });
  return files;
}
