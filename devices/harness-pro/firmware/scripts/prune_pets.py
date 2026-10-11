#!/usr/bin/env python3
"""Drops the pet data Pod can never play from main/pod/pets.c (a file imported from the round dial).

    scripts/prune_pets.py <pets.c>      rewrites in place, prints the bytes removed; a second run removes 0.

Pod plays only each pet's idle and asking small loops and its work, listen and send scenes (pod_pet.c). So:
  * alert_scene and relaxing_scene become NULL; whatever only they reached (scenes, overlays, frame arrays) goes;
  * the small frames only the WORKING / DONE loops use go (codex), the kept frames are renumbered, and the
    WORKING / DONE rows (never read) become {0,0}.
The file is one C statement per line. Anything else unexpected stops the run before the file is touched.
"""
import re
import sys

STEPS, STATES, IDLE, ASKING = 24, 4, 0, 3
IDENT = re.compile(r"[A-Za-z_]\w*")
DEF = re.compile(r"static const [\w ]+? \**(\w+)(?:\[[^=]*\])? = \{.*\};$")


def fail(msg):
    sys.exit(f"prune_pets: {msg}")


def main(path):
    text = open(path).read()
    lines = text.split("\n")
    if lines[-1] != "":
        fail("no trailing newline")
    lines.pop()
    pets = [i for i, l in enumerate(lines) if l.startswith("const ht_pet_t ht_pets[] = ")]
    if len(pets) != 1:
        fail("expected exactly one ht_pets table")
    stmts = {}   # name -> line index
    for i, l in enumerate(lines):
        if l.startswith("static "):
            m = DEF.match(l)
            if not m or m.group(1) in stmts:
                fail(f"line {i + 1}: not a one-line definition: {l[:80]}")
            stmts[m.group(1)] = i
        elif i != pets[0] and not (l.startswith(("//", "#include ", "_Static_assert(", "const unsigned ht_pet_count = "))):
            fail(f"line {i + 1}: unexpected: {l[:80]}")

    # 1. ht_pets: alert and relaxing scenes become NULL, and each pet's small frames shrink to what idle/asking play.
    row = lines[pets[0]]
    ent = re.findall(r'\{"(\w+)",\d+,\d+,NULL,(\w+)_loops,(\w+)_step_ms,&\w+,&\w+,&\w+,(\w+),(&\w+|NULL),(\d+),(&\w+|NULL)\}', row)
    if len(ent) != row.count('{"'):
        fail("ht_pets row has an unexpected shape")
    for eng, _, _, frames, alert, steps, relax in ent:
        if alert not in ("NULL", f"&{eng}_alert") or relax not in ("NULL", f"&{eng}_relax") or frames != eng + "_frames":
            fail(f"{eng}: unexpected scene names")
        loops_i = stmts[eng + "_loops"]
        m = re.fullmatch(r"(static const ht_pet_step_t \w+_loops\[HT_PET_STATES\]\[HT_PET_STEPS\] = )\{(.*)\};", lines[loops_i])
        pairs = re.findall(r"\{(-?\d+),(-?\d+)\}", m.group(2)) if m else []
        if len(pairs) != STATES * STEPS or re.sub(r"[{},\-\d]", "", m.group(2)):
            fail(f"{eng}_loops: unexpected shape")
        pairs = [(int(a), int(b)) for a, b in pairs]
        n = int(steps) or STEPS
        used = sorted({pairs[s * STEPS + i][0] for s in (IDLE, ASKING) for i in range(n)})
        fm = re.fullmatch(r"(static const ht_cell_frame_t \w+_frames)\[(\d+)\]( = )\{(.*)\};", lines[stmts[frames]])
        fl = re.findall(r"\{[^{}]*\}", fm.group(4)) if fm else []
        if not fm or len(fl) != int(fm.group(2)) or ",".join(fl) != fm.group(4) or used[-1] >= len(fl):
            fail(f"{frames}: unexpected shape")
        new = {old: k for k, old in enumerate(used)}
        out = []
        for s in range(STATES):
            for i in range(STEPS):
                f, dy = pairs[s * STEPS + i]
                keep = s in (IDLE, ASKING)
                out.append((new.get(f, 0), dy) if keep else (0, 0))
        body = ",".join("{" + ",".join("{%d,%d}" % p for p in out[s * STEPS:(s + 1) * STEPS]) + "}" for s in range(STATES))
        lines[loops_i] = m.group(1) + "{" + body + "};"
        lines[stmts[frames]] = f"{fm.group(1)}[{len(used)}]{fm.group(3)}{{{','.join(fl[o] for o in used)}}};"
        row = row.replace(f"{frames},{alert},", f"{frames},NULL,").replace(f",{relax}}}", ",NULL}")
    lines[pets[0]] = row

    # 2. Keep only what the table reaches (a definition is kept when a kept line names it).
    keep, todo = {pets[0]}, [pets[0]]
    while todo:
        for name in IDENT.findall(lines[todo.pop()]):
            j = stmts.get(name)
            if j is not None and j not in keep:
                keep.add(j)
                todo.append(j)
    # A _Static_assert goes with the arrays it checks (it never keeps one alive).
    def live(i, l):
        if l.startswith("static "):
            return i in keep
        if l.startswith("_Static_assert("):
            return all(stmts[n] in keep for n in IDENT.findall(l) if n in stmts)
        return True
    out = "\n".join(l for i, l in enumerate(lines) if live(i, l)) + "\n"
    removed = len(text) - len(out)
    if removed:
        open(path, "w").write(out)
    print(f"prune_pets: removed {removed} B from {path}")


if len(sys.argv) != 2:
    sys.exit(__doc__)
main(sys.argv[1])
