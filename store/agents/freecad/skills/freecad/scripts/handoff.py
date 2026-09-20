"""Portable, allowlisted source bundle and a report of actual CAD measurements."""
import hashlib
import html
import json
import os
import stat
import zipfile


def read_sources(project, workspace):
    sources = {}
    total = 0
    for name in project.get("sourceFiles", ["part.FCMacro", "design.json"]):
        path = workspace
        for component in name.split("/"):
            path = os.path.join(path, component)
            if stat.S_ISLNK(os.lstat(path).st_mode):
                raise ValueError("Bundle source cannot be a symlink: " + name)
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
            raise ValueError("Bundle source must be a regular file under 64 MiB: " + name)
        with open(path, "rb") as handle:
            data = handle.read(64 * 1024 * 1024 + 1)
        total += len(data)
        if len(data) > 64 * 1024 * 1024 or total > 128 * 1024 * 1024:
            raise ValueError("Source bundle exceeds its 128 MiB limit")
        sources[name] = data
    return sources


def fingerprints(sources):
    return {name: hashlib.sha256(data).hexdigest() for name, data in sorted(sources.items())}


def source_revision(sources):
    return hashlib.sha256(json.dumps(fingerprints(sources), sort_keys=True).encode("utf8")).hexdigest()


def render_report(project, report):
    esc = html.escape
    passed = sum(check["passed"] for check in report["checks"])
    total = len(report["checks"])
    rows = []
    for check in report["checks"]:
        detail = json.dumps(check["measured"], indent=2, ensure_ascii=False)
        expected = json.dumps(check["requirement"], indent=2, ensure_ascii=False)
        rows.append('<tr><td><span class="%s">%s</span></td><td><strong>%s</strong><p>%s</p>'
                    '<details><summary>Requirement and measurement</summary><h4>Required</h4><pre>%s</pre>'
                    '<h4>Measured</h4><pre>%s</pre></details></td></tr>' %
                    ("pass" if check["passed"] else "fail", "PASS" if check["passed"] else "FAIL",
                     esc(check["id"]), esc(check["reason"]), esc(expected), esc(detail)))
    cards = []
    for part in report["parts"]:
        links = ' '.join('<a href="%s" download>%s ↓</a>' % (esc(path), kind.upper()) for kind, path in part["files"].items())
        cards.append('<article class="part"><div><h3>%s</h3><p>%s · quantity %s</p></div>'
                     '<a href="%s"><img src="%s" alt="Projected reference drawing of %s"></a>'
                     '<p class="dimensions">%s mm</p><p>%.2f cm³ · %s mesh triangles · STEP and STL reimports checked</p>'
                     '<p class="downloads">%s</p><p>%s</p></article>' %
                     (esc(part["label"]), esc(part["material"]), part.get("quantity", 1),
                      esc(part["files"]["svg"]), esc(part["files"]["svg"]), esc(part["label"]),
                      ' × '.join('%.3f' % d for d in part["boundsMM"]), part["volumeMM3"] / 1000,
                      part["meshTriangles"], links, esc(part.get("notes", ""))))
    def items(field, fallback):
        return '<ul>' + ''.join('<li>%s</li>' % esc(value) for value in project.get(field, [fallback])) + '</ul>'
    source_rows = ''.join('<tr><td>%s</td><td><code>%s</code></td></tr>' % (esc(name), digest)
                          for name, digest in report["sources"].items())
    bundle = '<a class="primary" href="project.zip" download>Download editable project + deliverables ↓</a>' if report["requirementsPassed"] else '<p class="fail">Some requirements failed. No release bundle was created.</p>'
    return '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>''' + esc(project["title"]) + ''' · FreeCAD handoff</title>
<style>
:root{color-scheme:light;--ink:#182e3c;--muted:#596e78;--line:#d5e0e4;--blue:#185bb1;--paper:#f3f6f7}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:16px/1.6 system-ui,sans-serif}
main{max-width:1140px;margin:auto;padding:44px 32px 70px}.eyebrow{font:12px ui-monospace,monospace;letter-spacing:.15em;color:var(--blue)}
h1{font-size:clamp(30px,5vw,56px);line-height:1.1;letter-spacing:-.04em;max-width:900px;margin:16px 0 24px}h2{font-size:25px;margin:0 0 18px}h3{margin:0;font-size:20px}
p{margin:8px 0;color:var(--muted)}.brief{max-width:800px;white-space:pre-wrap}.primary{display:inline-block;background:var(--blue);color:#fff;padding:14px 20px;border-radius:8px;margin:22px 0;text-decoration:none;font-weight:600}
.summary{display:flex;gap:28px;flex-wrap:wrap;padding:22px 0;margin-bottom:24px;border-bottom:1px solid var(--line)}.summary strong{font-size:24px;display:block}.summary span{font-size:13px;color:var(--muted)}
section{margin-top:30px;background:white;border:1px solid var(--line);border-radius:12px;padding:28px}.parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,390px),1fr));gap:20px}
.part{border:1px solid var(--line);border-radius:10px;overflow:hidden;padding:22px}.part img{width:100%;display:block;margin:12px 0}.part p{font-size:13px}.part .dimensions{font:600 19px ui-monospace,monospace;color:var(--ink)}
a{color:var(--blue)}.downloads{display:flex;flex-wrap:wrap;gap:20px}table{border-collapse:collapse;width:100%}td{vertical-align:top;border-bottom:1px solid var(--line);padding:17px 8px}td:first-child{width:90px}
.pass,.fail{font:600 12px ui-monospace,monospace;white-space:nowrap}.pass{color:#176c44}.fail{color:#b3261e}details{font-size:13px}summary{cursor:pointer;color:var(--blue)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--paper);padding:12px;border-radius:6px}
.caution{border-left:4px solid #d89938;background:#fffaf0;padding:18px 22px;margin:24px 0}.caution p{color:#77501d}code{font:12px ui-monospace,monospace;overflow-wrap:anywhere}.hashes{table-layout:fixed;font-size:12px}.hashes td:first-child{width:35%;overflow-wrap:anywhere}
@media(max-width:600px){main{padding:26px 16px}section{padding:18px}.part{padding:14px}.summary{gap:18px}td{padding:12px 5px}.primary{font-size:14px}section h2{font-size:22px}}
@media print{body{background:white}main{padding:0}section,.part{break-inside:avoid}.primary{display:none}details{display:block}}
</style><main><div class="eyebrow">FREECAD / MEASURED BUILD</div><h1>''' + esc(project["title"]) + '''</h1>
<p class="brief">''' + esc(project["brief"]) + '''</p>''' + bundle + '''
<div class="summary"><div><strong>''' + str(passed) + ' / ' + str(total) + '''</strong><span>specified checks passed</span></div>
<div><strong>''' + str(len(report["parts"])) + '''</strong><span>individually exported parts</span></div>
<div><strong>mm</strong><span>design units</span></div><div><strong>''' + esc(report["freecadVersion"]) + '''</strong><span>FreeCAD runtime</span></div></div>
<div class="caution"><strong>Checked geometry, not a physical test</strong><p>These checks verify only the requirements below. They do not certify strength, wall thickness everywhere, process suitability or real-world fit. Review material, tolerances, orientation, supports and hardware before manufacturing.</p></div>
<section><h2>Your parts</h2><p>STEP keeps assembly coordinates. Each STL is translated to the positive octant; its orientation is unchanged. Review orientation in your slicer.</p><div class="parts">''' + ''.join(cards) + '''</div>
<p class="downloads"><a href="../part.step" download>Assembly STEP ↓</a><a href="../part.FCStd" download>Native FreeCAD document ↓</a><a href="../part.stl" download>Assembly mesh ↓</a></p></section>
<section><h2>Requirements, measured</h2><p>Measurements are made on the reopened native solids. Individual STEP files are reimported and checked for valid solids, volume, position and dimensions. STL files are reimported and checked for closed meshes and dimensions.</p><table>''' + ''.join(rows) + '''</table><p><a href="checks.json" download>Download measurement receipt ↓</a></p></section>
<section><h2>Assembly and hardware</h2>''' + items("assembly", "Assembly steps have not been supplied; obtain them before making the design.") + items("hardware", "No hardware has been specified.") + '''</section>
<section><h2>Assumptions to review</h2>''' + items("assumptions", "Manufacturing assumptions have not been supplied.") + '''</section>
<section><h2>Keep editing it</h2><p>The ZIP contains the named source files, native document, exports and standalone build tools. Extract it to a new folder. With Node 20+ and FreeCAD installed, run <code>node tools/build.mjs</code> from that folder. Set <code>FREECAD_BIN</code> for a nonstandard FreeCAD installation.</p>
<p>Open this saved report directly, or run <code>node tools/serve-handoff.mjs</code> for a local download page. This report describes the saved build, not subsequent edits.</p><p>The macro and its inputs are the parametric source. The native file may contain generated solids rather than a fully constrained Sketcher feature history. Only run macros you trust.</p><p>Source revision <code>''' + report["sourceRevision"] + '''</code></p>
<details><summary>Included source files and SHA-256 fingerprints</summary><table class="hashes">''' + source_rows + '''</table></details></section></main></html>'''


def write_handoff(project, report, sources, output, tools):
    directory = os.path.join(output, "handoff")
    os.makedirs(directory, exist_ok=True)
    report["sources"] = fingerprints(sources)
    report["sourceRevision"] = source_revision(sources)
    with open(os.path.join(directory, "checks.json"), "w", encoding="utf8") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
    with open(os.path.join(directory, "index.html"), "w", encoding="utf8") as handle:
        handle.write(render_report(project, report))
    if not report["requirementsPassed"]:
        return
    with zipfile.ZipFile(os.path.join(directory, "project.zip"), "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(sources.items()):
            archive.writestr(name, data)
        for name in ["build.mjs", "runner.py", "design.py", "geometry.py", "handoff.py", "serve-handoff.mjs", "LICENSE"]:
            archive.write(os.path.join(tools, name), "tools/" + name)
        for name in ["part.step", "part.stl", "part.FCStd"]:
            archive.write(os.path.join(output, name), name)
        for root, dirs, files in os.walk(directory, followlinks=False):
            for name in files:
                if name == "project.zip":
                    continue
                path = os.path.join(root, name)
                if os.path.islink(path):
                    raise ValueError("Generated bundle cannot contain symlinks")
                archive.write(path, os.path.relpath(path, output))
        archive.writestr("REBUILD.txt", "Extract this project. Install Node 20+ and FreeCAD.\n"
                         "From the extracted folder run: node tools/build.mjs\n"
                         "Set FREECAD_BIN to your FreeCADCmd binary if it is not detected.\n"
                         "Edit part.FCMacro and the named source inputs, not the generated exports.\n"
                         "Review design.json against your measurements; never weaken a requirement merely to pass.\n"
                         "The saved project contains executable Python. Run only trusted source.\n"
                         "Open handoff/index.html for the measurements, part files and assumptions.\n")
        bad = archive.testzip()
        if bad is not None:
            raise ValueError("Project archive failed CRC verification: " + bad)
