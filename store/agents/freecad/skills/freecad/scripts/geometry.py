"""Real OpenCascade measurements, fresh per-part exports and projected drawings."""
import html
import math
import os
import re

import FreeCAD as App
import Part
import Mesh
import MeshPart
import TechDraw


def metrics(shape):
    box = shape.BoundBox
    values = [box.XLength, box.YLength, box.ZLength, shape.Volume, shape.Area]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Geometry contains non-finite measurements")
    return {"boundsMM": values[:3], "originMM": [box.XMin, box.YMin, box.ZMin],
            "volumeMM3": shape.Volume, "areaMM2": shape.Area,
            "solids": len(shape.Solids)}


def solid(shape, name):
    # Separate assembly bodies may intentionally touch. A compound-wide BOP check
    # calls those shared boundaries self-intersections; validate each body deeply.
    try:
        shape.check(False)
        for body in shape.Solids:
            body.check(True)
    except Exception as error:
        raise ValueError(name + " failed native shape validation: " + str(error)) from error
    if shape.isNull() or not shape.isValid() or not shape.isClosed() or not shape.Solids or shape.Volume <= 0:
        raise ValueError(name + " is not a closed, valid, positive-volume solid")
    return metrics(shape)


def recompute_document(document):
    document.recompute()
    # Failed FreeCAD features can retain a perfectly valid *previous* Shape.
    # Geometry validity cannot substitute for a successful dependency recompute.
    failures = [obj.Name + ": " + obj.getStatusString() for obj in document.Objects
                if not obj.isValid() or "Touched" in obj.State]
    if failures:
        raise ValueError("Native document has failed or uncomputed features: " + "; ".join(failures))


def measure(check, shapes):
    kind = check["type"]
    tolerance = check.get("tolerance", 0.02)
    if kind == "bounds":
        data = metrics(shapes[check["part"]])
        passed = all(abs(a - b) <= tolerance for a, b in zip(data["boundsMM"], check["size"]))
        if "origin" in check:
            passed = passed and all(abs(a - b) <= tolerance for a, b in zip(data["originMM"], check["origin"]))
        actual = {"sizeMM": data["boundsMM"], "originMM": data["originMM"], "toleranceMM": tolerance}
    elif kind in {"clearance", "no-overlap"}:
        left, right = [shapes[name] for name in check["parts"]]
        overlap = max(0, left.common(right).Volume)
        if kind == "no-overlap":
            limit = check.get("toleranceVolume", 0.00001)
            passed = overlap <= limit
            actual = {"overlapMM3": overlap, "toleranceMM3": limit}
        else:
            gap = left.distToShape(right)[0]
            # A contained solid can have nonzero surface distance despite overlapping volume.
            passed = (overlap <= 0.00001 and gap + tolerance >= check["minimum"] and
                      gap - tolerance <= check.get("maximum", float("inf")))
            actual = {"minimumDistanceMM": gap, "overlapMM3": overlap, "toleranceMM": tolerance}
    elif kind == "contains":
        outside = max(0, shapes[check["other"]].cut(shapes[check["part"]]).Volume)
        limit = check.get("toleranceVolume", 0.00001)
        passed = outside <= limit
        actual = {"outsideMM3": outside, "toleranceMM3": limit}
    elif kind == "bore":
        shape = shapes[check["part"]]
        axis = App.Vector(*check["axis"])
        axis.normalize()
        start = App.Vector(*check["origin"]) + axis * tolerance
        depth = check["length"] - 2 * tolerance
        radius = check["diameter"] / 2
        empty = Part.makeCylinder(radius - tolerance, depth, start, axis)
        ring = Part.makeCylinder(radius + check["wall"], depth, start, axis).cut(
            Part.makeCylinder(radius + tolerance, depth, start, axis))
        blocked = max(0, shape.common(empty).Volume)
        missing = max(0, ring.cut(shape).Volume)
        # A probe in empty space is not a hole: require surrounding material too.
        limit = min(0.00001, min(empty.Volume, ring.Volume) * 0.000001)
        if limit <= 0:
            raise ValueError("Bore probe is below the kernel's supported geometric scale")
        passed = blocked <= limit and missing <= limit
        actual = {"blockedBoreMM3": blocked, "missingSurroundMM3": missing,
                  "requiredDiameterMM": check["diameter"], "requiredSurroundMM": check["wall"],
                  "toleranceMM": tolerance, "volumeToleranceMM3": limit}
    else:
        raise ValueError("Unknown geometric check " + kind)
    if not all(math.isfinite(value) for value in actual.values() if isinstance(value, (float, int))):
        raise ValueError("Non-finite result for " + check["id"])
    return {"id": check["id"], "type": kind, "reason": check["reason"],
            "passed": bool(passed), "requirement": check, "measured": actual}


def drawing(shape, part, title, destination):
    box = shape.BoundBox
    centered = shape.copy()
    centered.translate(-box.Center)
    x, y, z = box.XLength, box.YLength, box.ZLength
    scale = min(1.0, 64 / max(x, y, z), 51 / max(y, z))
    escape = html.escape
    content = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210">',
        '<rect width="297" height="210" fill="white"/>',
        '<style>text{font-family:Arial,sans-serif;fill:#18342d}.small{font-size:3px}.dim{stroke:#53756a;stroke-width:.22;fill:none}</style>',
        '<rect x="10" y="10" width="277" height="190" fill="none" stroke="#53756a" stroke-width=".3"/>',
        '<text x="18" y="23" font-size="5">' + escape(part["label"][:75]) + '</text>',
        '<text x="18" y="30" class="small">' + escape(title[:120]) + '</text>',
    ]
    # Project along a fixed Z direction after explicit model rotations. Allowing
    # TechDraw to choose its own in-plane basis can rotate front/side views 90°,
    # making otherwise correct dimension labels point at the wrong edges.
    views = [("TOP · X/Y", App.Vector(1, 0, 0), 0, x, y),
             ("FRONT · X/Z", App.Vector(1, 0, 0), -90, x, z),
             ("RIGHT · Y/Z", App.Vector(1, 1, 1), -120, y, z)]
    for i, (label, axis, angle, width, height) in enumerate(views):
        cx, cy = 56 + i * 92, 80
        projected = centered.copy()
        projected.rotate(App.Vector(0, 0, 0), axis, angle)
        fragment = TechDraw.projectToSVG(projected, App.Vector(0, 0, 1))
        fragment = re.sub(r'\s+id\s*=\s*"[^"]*"', '', fragment)
        fragment = re.sub(r'stroke-width="[^"]*"', 'stroke-width="%g"' % (0.28 / scale), fragment)
        content.append('<text x="%g" y="42" text-anchor="middle" class="small">%s</text>' % (cx, label))
        content.append('<g class="projection" data-width="%g" data-height="%g" transform="translate(%g,%g) scale(%g)">%s</g>' % (width, height, cx, cy, scale, fragment))
        left, right = cx - width * scale / 2, cx + width * scale / 2
        top, bottom = cy - height * scale / 2, cy + height * scale / 2
        dy, dx = bottom + 7, right + 6
        content.append('<path class="dim" d="M %g %g V %g M %g %g V %g M %g %g H %g"/>' %
                       (left, bottom+1, dy+2, right, bottom+1, dy+2, left, dy, right))
        content.append('<path class="dim" d="M %g %g H %g M %g %g H %g M %g %g V %g"/>' %
                       (right+1, top, dx+2, right+1, bottom, dx+2, dx, top, bottom))
        content.append('<text x="%g" y="%g" text-anchor="middle" class="small">%.3f mm</text>' % (cx, dy+5, width))
        content.append('<text x="%g" y="%g" transform="rotate(-90 %g %g)" text-anchor="middle" class="small">%.3f mm</text>' %
                       (dx+4, cy, dx+4, cy, height))
    notes = ["DIMENSIONED REFERENCE · all dimensions in mm · use written dimensions, not screen/print scale",
             "Generated from the reopened native solid using FreeCAD TechDraw projections.",
             "Overall dimensions only. Hole/fit requirements and measured checks are in the handoff report.",
             "Not a toleranced production drawing. Manufacturing process, strength and physical fit require review.",
             "Material (project assumption): " + part["material"][:130],
             "Quantity: %s · object: %s · source units: mm" % (part.get("quantity", 1), part["object"])]
    for i, note in enumerate(notes):
        content.append('<text x="18" y="%g" class="small">%s</text>' % (148 + i * 7, escape(note)))
    content.append('</svg>')
    with open(destination, "w", encoding="utf8") as handle:
        handle.write("\n".join(content))


def export_project(project, native, output):
    document = App.openDocument(native)
    try:
        recompute_document(document)
        document.save()
        shapes, objects = {}, {}
        names = [part["object"] for part in project["parts"]] + project.get("references", [])
        for name in names:
            obj = document.getObject(name)
            if obj is None or not hasattr(obj, "Shape"):
                raise ValueError("Native document is missing shape object " + name)
            solid(obj.Shape, name)
            shapes[name], objects[name] = obj.Shape.copy(), obj
        parts_dir = os.path.join(output, "handoff", "parts")
        os.makedirs(parts_dir, exist_ok=True)
        reports = []
        for part in project["parts"]:
            shape = shapes[part["object"]]
            data = solid(shape, part["label"])
            if data["solids"] != 1:
                raise ValueError(part["label"] + " must be one solid; declare disconnected pieces separately")
            prefix = os.path.join(parts_dir, part["id"])
            shape.exportStep(prefix + ".step")
            reopened = Part.Shape()
            reopened.read(prefix + ".step")
            exported = solid(reopened, part["label"] + " STEP reimport")
            if (abs(exported["volumeMM3"] - data["volumeMM3"]) > max(0.00001, data["volumeMM3"] * 1e-6) or
                    any(abs(a - b) > 0.001 for field in ["boundsMM", "originMM"]
                        for a, b in zip(exported[field], data[field]))):
                raise ValueError(part["label"] + " changed dimensions or volume during STEP export")
            local = shape.copy()
            translation = [-coordinate for coordinate in data["originMM"]]
            local.translate(App.Vector(*translation))
            mesh = MeshPart.meshFromShape(Shape=local, LinearDeflection=0.05, AngularDeflection=0.1, Relative=False)
            mesh.write(prefix + ".stl")
            reopened_mesh = Mesh.Mesh(prefix + ".stl")
            if reopened_mesh.CountFacets == 0 or not reopened_mesh.isSolid():
                raise ValueError(part["label"] + " STL reimport is not a closed mesh")
            mesh_box = reopened_mesh.BoundBox
            if any(abs(a - b) > 0.11 for a, b in zip(
                    [mesh_box.XLength, mesh_box.YLength, mesh_box.ZLength], data["boundsMM"])):
                raise ValueError(part["label"] + " STL changed dimensions during tessellation")
            drawing(shape, part, project["title"], prefix + ".svg")
            reports.append({**part, **data, "stepReimported": True, "stlReimported": True,
                            "stlTranslationMM": translation, "meshTriangles": mesh.CountFacets,
                            "files": {kind: "parts/" + part["id"] + "." + kind for kind in ["step", "stl", "svg"]}})
        result = [measure(check, shapes) for check in project["checks"]]
        Part.export([objects[part["object"]] for part in project["parts"]], os.path.join(output, "part.step"))
        assembly = Part.Shape()
        assembly.read(os.path.join(output, "part.step"))
        data = solid(assembly, "Assembly STEP reimport")
        if data["solids"] != len(project["parts"]):
            raise ValueError("STEP assembly does not contain the declared manufactured parts")
        MeshPart.meshFromShape(Shape=assembly, LinearDeflection=0.05, AngularDeflection=0.1, Relative=False).write(
            os.path.join(output, "part.stl"))
        return {**data, "valid": True, "closed": True, "designChecked": True,
                "requirementsPassed": all(check["passed"] for check in result),
                "checks": result, "parts": reports,
                "freecadVersion": ".".join(App.Version()[:3])}
    finally:
        App.closeDocument(document.Name)
