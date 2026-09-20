"""The saved job contract. Standard-library only so validation needs no CAD runtime."""
import math
import os
import re


def fail(message):
    raise ValueError("design.json: " + message)


def text(value, name, limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail(name + " must be nonempty text (at most %d characters)" % limit)
    return value


def number(value, name, minimum=None, maximum=1000000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(name + " must be a finite number")
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        fail(name + " is outside the supported range")
    return value


def vector(value, name, positive=False):
    if not isinstance(value, list) or len(value) != 3:
        fail(name + " must contain three millimetre coordinates")
    for component in value:
        number(component, name, 0.000001 if positive else -1000000)
    return value


def keys(value, required, optional, name):
    if not isinstance(value, dict):
        fail(name + " must be an object")
    missing = set(required) - set(value)
    unknown = set(value) - set(required) - set(optional)
    if missing:
        fail(name + " is missing " + ", ".join(sorted(missing)))
    if unknown:
        fail(name + " has unknown fields: " + ", ".join(sorted(unknown)))


def source_path(value):
    text(value, "sourceFiles entry", 240)
    components = value.split("/")
    if (os.path.isabs(value) or "\\" in value or ":" in value or
            any(not c or c.startswith(".") for c in components) or
            any(ord(c) < 32 for c in value)):
        fail("sourceFiles must be visible, relative paths inside the project")
    if components[0].lower() in {"handoff", "tools", "node_modules", "part.step", "part.stl", "part.fcstd", "candidate.step", "rebuild.txt"}:
        fail("sourceFiles cannot include generated outputs or tools: " + value)
    return value


def validate(value):
    keys(value, ["spec", "title", "brief", "units", "parts", "checks"],
         ["references", "sourceFiles", "assumptions", "assembly", "hardware"], "project")
    if value["spec"] != 1 or isinstance(value["spec"], bool):
        fail("spec must be 1")
    if value["units"] != "mm":
        fail("units must be mm; convert the user's measurements explicitly")
    text(value["title"], "title", 160)
    text(value["brief"], "brief", 6000)
    parts = value["parts"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 32:
        fail("parts must contain 1–32 manufactured parts")
    objects, ids = set(), set()
    for part in parts:
        keys(part, ["id", "object", "label", "material"], ["quantity", "notes"], "part")
        for field in ["id", "object"]:
            if not isinstance(part[field], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", part[field]):
                fail("part " + field + " must be a short ASCII identifier")
        if part["id"].lower() in ids or part["object"] in objects:
            fail("part IDs (case-insensitive) and FreeCAD object names must be unique")
        ids.add(part["id"].lower())
        objects.add(part["object"])
        text(part["label"], "part label", 160)
        text(part["material"], "part material", 240)
        quantity = part.get("quantity", 1)
        if type(quantity) is not int or not 1 <= quantity <= 1000:
            fail("part quantity must be an integer from 1 to 1000")
        if "notes" in part:
            text(part["notes"], "part notes")
    references = value.get("references", [])
    if not isinstance(references, list) or len(references) > 64:
        fail("references must be a list of up to 64 FreeCAD object names")
    for name in references:
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", name) or name in objects:
            fail("reference object names must be unique, distinct from manufactured parts")
        objects.add(name)
    sources = value.get("sourceFiles", ["part.FCMacro", "design.json"])
    if not isinstance(sources, list) or not 1 <= len(sources) <= 128:
        fail("sourceFiles must contain 1–128 explicitly selected source files")
    for path in sources:
        source_path(path)
    if len(set(path.lower() for path in sources)) != len(sources):
        fail("sourceFiles cannot contain duplicate names")
    if not {"part.FCMacro", "design.json"}.issubset(sources):
        fail("sourceFiles must include part.FCMacro and design.json")
    for field in ["assumptions", "assembly", "hardware"]:
        if field in value:
            if not isinstance(value[field], list) or len(value[field]) > 100:
                fail(field + " must contain at most 100 text entries")
            for entry in value[field]:
                text(entry, field + " entry")
    checks = value["checks"]
    if not isinstance(checks, list) or not 1 <= len(checks) <= 256:
        fail("checks must contain 1–256 measurable requirements")
    check_ids = set()
    for check in checks:
        if not isinstance(check, dict):
            fail("each check must be an object")
        kind = check.get("type")
        schemas = {
            "bounds": (["part", "size"], ["origin", "tolerance"]),
            "clearance": (["parts", "minimum"], ["maximum", "tolerance"]),
            "no-overlap": (["parts"], ["toleranceVolume"]),
            "contains": (["part", "other"], ["toleranceVolume"]),
            "bore": (["part", "origin", "axis", "diameter", "length", "wall"], ["tolerance"]),
        }
        if not isinstance(kind, str) or kind not in schemas:
            fail("unsupported check type: " + str(kind))
        required, optional = schemas[kind]
        keys(check, ["id", "type", "reason"] + required, optional, "check")
        text(check["id"], "check id", 100)
        text(check["reason"], "check reason", 1000)
        if check["id"] in check_ids:
            fail("check IDs must be unique")
        check_ids.add(check["id"])
        names = [check[field] for field in ["part", "other"] if field in check]
        if "parts" in check:
            if not isinstance(check["parts"], list) or len(check["parts"]) != 2:
                fail("check parts must name exactly two different objects")
            names += check["parts"]
        if any(not isinstance(name, str) or name not in objects for name in names) or len(set(names)) != len(names):
            fail("checks must name distinct objects declared in parts or references")
        for field in ["origin", "axis", "size"]:
            if field in check:
                vector(check[field], field, field == "size")
        for field in ["minimum", "maximum", "tolerance", "toleranceVolume"]:
            if field in check:
                number(check[field], field, 0)
        for field in ["diameter", "length", "wall"]:
            if field in check:
                number(check[field], field, 0.000001)
        if kind == "clearance" and check.get("maximum", float("inf")) < check["minimum"]:
            fail("clearance maximum cannot be less than minimum")
        if kind == "bore":
            if sum(component ** 2 for component in check["axis"]) < 1e-12:
                fail("bore axis cannot be zero")
            tolerance = check.get("tolerance", 0.02)
            if tolerance >= min(check["diameter"] / 2, check["length"] / 2, check["wall"]):
                fail("bore tolerance must be smaller than its radius, half-depth and wall")
    return value
