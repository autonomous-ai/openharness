"""The backend, Desktop and the phone read chat tags by one rule, tested against one table kept in three copies (each
component's CI checks out only its own folder). The copies must stay byte-identical."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
COPIES = ("backend/src/superTabs/tagFixture.json", "desktop/test/fixtures/tag_fixture.json", "mobile/test/fixtures/tag_fixture.json")


def blob_ids(root, paths):
    """Each path's git object id at HEAD: equal ids are equal bytes. Process checks check out only scripts, but the
    commit's trees are there, so this needs none of the files on disk."""
    out = subprocess.check_output(["git", "ls-tree", "-z", "HEAD", "--", *paths], cwd=root, timeout=15).decode()
    ids = {}
    for entry in filter(None, out.split("\0")):
        meta, path = entry.split("\t", 1)
        ids[path] = meta.split()[2]
    return ids


def disk_ids(root, paths):
    """The same ids for the files as they are on disk, uncommitted edits included, when all of them are checked out."""
    files = [root / path for path in paths]
    if not all(f.is_file() for f in files):
        return None
    out = subprocess.check_output(["git", "hash-object", "--", *map(str, files)], cwd=root, timeout=15).decode()
    return dict(zip(paths, out.split()))


class TagFixtureCopies(unittest.TestCase):
    def test_the_three_copies_are_identical(self):
        ids = disk_ids(ROOT, COPIES) or blob_ids(ROOT, COPIES)
        self.assertEqual(sorted(ids), sorted(COPIES), "a copy of the tag table is missing")
        self.assertEqual(len(set(ids.values())), 1, f"the tag table copies differ: {ids}; copy {COPIES[0]} over the others")


if __name__ == "__main__":
    unittest.main()
