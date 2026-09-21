"""Run the official CLI with a lease tied to the owning viewer process."""
import os
import signal
import threading
import time


def watch_parent(expected):
    while True:
        time.sleep(2)
        if os.getppid() != expected:
            os.killpg(os.getpgrp(), signal.SIGTERM)
            return


if __name__ == "__main__":
    threading.Thread(target=watch_parent, args=(int(os.environ["HARNESS_PARENT_PID"]),), daemon=True).start()
    from vllm.entrypoints.cli.main import main
    main()
