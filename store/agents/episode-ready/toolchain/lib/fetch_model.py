"""Fetch one CTranslate2 Whisper model, pinned to a Hugging Face commit, into the package.

Usage: fetch_model.py <name> <repo@revision> <models-dir>
Prints one `ok`/`miss` line and exits non-zero on failure, like the shell scripts around it.
"""
import os
import shutil
import sys


def main() -> int:
    name, ref, root = sys.argv[1], sys.argv[2], sys.argv[3]
    if "@" not in ref:
        print(f"miss the pin for {name} is not repo@revision: {ref}")
        return 1
    repo, revision = ref.rsplit("@", 1)
    dest = os.path.join(root, name)
    if os.path.exists(os.path.join(dest, "model.bin")):
        print(f"ok   Whisper {name} weights already here")
        return 0
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # The hub's deprecation notice and its "set a token for faster downloads" advert are not the
    # install's business; the install prints one line per step and nothing else.
    import logging
    import warnings

    warnings.filterwarnings("ignore")
    logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
    from huggingface_hub.utils import GatedRepoError, HfHubHTTPError, RepositoryNotFoundError

    partial = dest + ".partial"
    shutil.rmtree(partial, ignore_errors=True)
    print(f"     Whisper {name} weights from {repo} at {revision[:12]}")
    try:
        from faster_whisper.utils import download_model

        download_model(repo, output_dir=partial, revision=revision)
    except (HfHubHTTPError, RepositoryNotFoundError, GatedRepoError, OSError) as exc:
        shutil.rmtree(partial, ignore_errors=True)
        print(f"miss the Whisper {name} weights could not be fetched ({type(exc).__name__}) — check this machine's internet connection")
        return 1
    if not os.path.exists(os.path.join(partial, "model.bin")):
        shutil.rmtree(partial, ignore_errors=True)
        print(f"miss the Whisper {name} download arrived without a model.bin")
        return 1
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(partial, dest)
    print(f"ok   Whisper {name} weights")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
