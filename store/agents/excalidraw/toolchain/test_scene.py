import contextlib, io, json, math, os, runpy, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from scene import PALETTE, FONT_MONO, Scene, _edge
from verdict import judge

PACKAGE = Path(__file__).resolve().parent.parent

class SceneAndVerdict(unittest.TestCase):
    def test_a_scene_is_valid_and_bound(self):
        s = Scene()
        a = s.box(0, 0, "API"); b = s.box(320, 0, "DB", shape="ellipse", color="green")
        arrow = s.arrow(a, b, "SQL"); s.frame([a, b], "Backend")
        data = s.to_dict()
        self.assertEqual(data["type"], "excalidraw")
        self.assertEqual(arrow["startBinding"]["elementId"], a["id"]); self.assertEqual(arrow["endBinding"]["elementId"], b["id"])
        self.assertIn({"id": arrow["id"], "type": "arrow"}, a["boundElements"])
        v = judge(json.loads(json.dumps(data)), "diagram.excalidraw")
        self.assertTrue(v["ready"], v); self.assertEqual(v["summary"], "diagram.excalidraw · 2 shapes · 1 arrow · valid")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(data["elements"][0]["type"], "frame")
    def test_an_arrow_off_the_edge_starts_on_the_box_boundary(self):
        s = Scene(); a = s.box(0, 0, "A", w=100, h=50); b = s.box(300, 0, "B", w=100, h=50)
        arrow = s.arrow(a, b)
        self.assertAlmostEqual(arrow["x"], 100); self.assertAlmostEqual(arrow["y"], 25)
    def test_a_broken_binding_is_an_error(self):
        v = judge({"type": "excalidraw", "elements": [{"id": "x", "type": "arrow", "startBinding": {"elementId": "nope"}, "endBinding": None}]}, "d.excalidraw")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
    def test_not_a_scene(self):
        v = judge({"hello": 1}, "d.excalidraw"); self.assertFalse(v["ready"]); self.assertIsNone(v["artifact"])


class Nodes(unittest.TestCase):
    def test_an_unlabelled_box_is_one_element_at_the_default_size(self):
        s = Scene()
        node = s.box(10, 20, color="no-such-colour")
        self.assertEqual(s.elements, [node])
        self.assertEqual((node["width"], node["height"], node["boundElements"]), (160, 72, []))
        self.assertEqual((node["backgroundColor"], node["strokeColor"]), PALETTE["blue"], "an unknown colour is blue")
        self.assertEqual(node["roundness"], {"type": 3})

    def test_a_label_centres_in_its_box_and_grows_it(self):
        s = Scene()
        node = s.box(0, 0, "A rather long label", shape="diamond", color="red")
        label = s.elements[1]
        self.assertEqual(node["width"], len("A rather long label") * 20 * 0.6 + 4 + 48)
        self.assertEqual((label["containerId"], label["verticalAlign"], label["textAlign"]), (node["id"], "middle", "center"))
        self.assertAlmostEqual(label["x"] + label["width"] / 2, node["width"] / 2)
        self.assertIsNone(node["roundness"], "only rectangles are rounded")

    def test_free_text_title_and_note(self):
        s = Scene()
        t = s.text(5, 6, "line one\nline two", font=FONT_MONO, align="right")
        self.assertEqual((t["fontFamily"], t["textAlign"], t["verticalAlign"], t["containerId"]), (FONT_MONO, "right", "top", None))
        self.assertEqual((t["strokeColor"], t["height"]), ("#1e1e1e", 2 * 20 * 1.25))
        self.assertEqual(s.text(0, 0, "red", color="#e03131")["strokeColor"], "#e03131")
        self.assertEqual(s.title("Big", 0, -100)["fontSize"], 32)
        note = s.note(0, 0, "Retries: 3")
        self.assertEqual((note["width"], note["backgroundColor"], s.elements[-1]["fontSize"]), (220, PALETTE["yellow"][0], 16))

    def test_a_dark_scene_inks_light_and_says_so(self):
        s = Scene(dark=True)
        self.assertEqual(s.text(0, 0, "x")["strokeColor"], "#e9ecef")
        self.assertEqual(s.to_dict()["appState"]["theme"], "dark")


class Edges(unittest.TestCase):
    def test_dashed_two_headed_and_unlabelled(self):
        s = Scene(); a = s.box(0, 0, "A"); b = s.box(0, 300, "B")
        arrow = s.arrow(a, b, dashed=True, both=True)
        self.assertEqual((arrow["strokeStyle"], arrow["startArrowhead"], arrow["endArrowhead"]), ("dashed", "arrow", "arrow"))
        self.assertEqual(arrow["boundElements"], [], "no label, no bound text")
        self.assertEqual((arrow["x"], arrow["y"], arrow["points"][1]), (80, 72, [0, 300 - 72]), "straight down, edge to edge")

    def test_where_a_line_leaves_each_shape(self):
        rect = {"type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 50}
        self.assertEqual(_edge(rect, 50, 25), (50, 25), "toward its own centre: the centre")
        x, y = _edge(rect, 50, 500)
        self.assertEqual(x, 50); self.assertAlmostEqual(y, 50, msg="straight down leaves through the bottom")
        ellipse = {**rect, "type": "ellipse"}
        x, y = _edge(ellipse, 50 + 300, 25 + 300)
        self.assertAlmostEqual(((x - 50) / 50) ** 2 + ((y - 25) / 25) ** 2, 1)
        self.assertAlmostEqual(math.atan2(y - 25, x - 50), math.pi / 4)
        diamond = {**rect, "type": "diamond"}
        x, y = _edge(diamond, 150, 75)
        self.assertAlmostEqual(abs(x - 50) / 50 + abs(y - 25) / 25, 1, msg="on the diamond's outline, not its box")


class Output(unittest.TestCase):
    def test_save_writes_what_to_dict_says(self):
        s = Scene(); s.box(0, 0, "A")
        with tempfile.TemporaryDirectory() as d:
            path = s.save(Path(d) / "x.excalidraw")
            self.assertEqual(json.loads(path.read_text()), s.to_dict())
            cwd = os.getcwd()
            os.chdir(d)
            try:
                self.assertEqual(s.save(), Path("diagram.excalidraw"))
                self.assertTrue((Path(d) / "diagram.excalidraw").is_file())
            finally:
                os.chdir(cwd)


def rounded(value):
    if isinstance(value, float):
        return round(value, 6) + 0.0
    if isinstance(value, list):
        return [rounded(v) for v in value]
    return value


def shape_of(data: dict) -> list:
    """A scene without what is random per run (ids, seeds, timestamps): references become indexes,
    coordinates are compared to a millionth of a pixel."""
    index = {e["id"]: i for i, e in enumerate(data["elements"])}
    ref = lambda v: index.get(v, v)
    out = []
    for e in data["elements"]:
        e = {k: rounded(v) for k, v in e.items() if k not in ("id", "seed", "versionNonce", "updated")}
        e["boundElements"] = [{**b, "id": ref(b["id"])} for b in e["boundElements"]]
        for key in ("containerId", "frameId"):
            if e.get(key):
                e[key] = ref(e[key])
        for key in ("startBinding", "endBinding"):
            if e.get(key):
                e[key] = {**e[key], "elementId": ref(e[key]["elementId"])}
        out.append(e)
    return out


class Template(unittest.TestCase):
    def test_build_py_makes_the_starter_diagram_the_template_ships(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd()
            os.chdir(d)
            try:
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    runpy.run_path(str(PACKAGE / "template" / "build.py"), run_name="__main__")
            finally:
                os.chdir(cwd)
            self.assertEqual(printed.getvalue(), "diagram.excalidraw\n")
            built = json.loads((Path(d) / "diagram.excalidraw").read_text())
        v = judge(built, "diagram.excalidraw")
        self.assertTrue(v["ready"], v["findings"])
        self.assertEqual(v["summary"], "diagram.excalidraw · 5 shapes · 5 arrows · valid")
        shipped = json.loads((PACKAGE / "template" / "diagram.excalidraw").read_text())
        self.assertEqual(shape_of(built), shape_of(shipped), "template/diagram.excalidraw is what build.py draws")


if __name__ == "__main__": unittest.main()
