"""Exercise the real audit guard without opening a network connection."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("habitat_engine", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[2])
blocked = module.install_guards(root)
def sock(operation):
    with socket.socket() as connection:
        getattr(connection, operation)(("127.0.0.1", 9))
operations = [lambda: sock("connect"), lambda: sock("bind"),
              lambda: socket.getaddrinfo("localhost", 80), lambda: socket.gethostbyname("localhost"),
              lambda: subprocess.run(["/usr/bin/true"], check=True),
              lambda: (root.parent / "must-not-be-written").write_text("no")]
denied = 0
for operation in operations:
    try:
        operation()
    except PermissionError:
        denied += 1
assert denied == len(operations)
assert not (root.parent / "must-not-be-written").exists()
(root / "allowed.json").write_text("{}")
assert (root / "allowed.json").read_text() == "{}"
print(json.dumps({"denied": denied, "blocked": blocked}))
