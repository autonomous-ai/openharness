"""Private metadata/download worker; inference belongs to the native vLLM server."""
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

protocol = sys.stdout
sys.stdout = sys.stderr
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.constants import HF_HUB_CACHE
import psutil

root = Path(HF_HUB_CACHE)
registry = Path(os.environ["HARNESS_MODEL_REGISTRY"])
try:
    revisions = json.loads(registry.read_text())
    if not isinstance(revisions, dict):
        revisions = {}
except (OSError, ValueError):
    revisions = {}


def emit(event):
    protocol.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
    protocol.flush()


def validate(repo):
    if not isinstance(repo, str) or len(repo) > 180 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repo) or ".." in repo:
        raise ValueError("Use a Hugging Face owner/repository model ID.")
    return repo


def snapshot(repo):
    base = root / ("models--" + validate(repo).replace("/", "--"))
    candidates = [revisions.get(repo, "")]
    try:
        candidates.append((base / "refs/main").read_text().strip())
    except OSError:
        pass
    for revision in candidates:
        if isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{40,64}", revision):
            path = base / "snapshots" / revision
            if path.is_dir():
                return path
    paths = sorted((base / "snapshots").glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not paths:
        raise ValueError(f"{repo} is not downloaded.")
    return paths[0]


def describe(repo):
    path = snapshot(repo)
    config = json.loads((path / "config.json").read_text())
    if "vision_config" in config or "diffusion" in str(config.get("model_type", "")):
        raise ValueError("This harness currently supports text language models.")
    weights = list(path.glob("*.safetensors"))
    if not weights or not (path / "tokenizer_config.json").is_file():
        raise ValueError("Incomplete language-model snapshot. Download to resume.")
    index = path / "model.safetensors.index.json"
    if index.exists():
        expected = set(json.loads(index.read_text())["weight_map"].values())
        if any(Path(name).name != name or not (path / name).is_file() for name in expected):
            raise ValueError("Incomplete model shards. Download to resume.")
    quant = config.get("quantization") or config.get("quantization_config") or {}
    template = json.loads((path / "tokenizer_config.json").read_text()).get("chat_template", "")
    return {"id": repo, "name": repo.split("/")[-1], "path": str(path), "digest": path.name,
            "size": sum(p.stat().st_size for p in path.iterdir() if p.is_file()),
            "family": config.get("model_type"), "parameters": None,
            "quantization": f"{quant['bits']}-bit" if quant.get("bits") else config.get("torch_dtype", "Unquantized"),
            "supportsThinking": "enable_thinking" in str(template), "running": False, "resident": None}


def inventory():
    repos = set(revisions)
    for base in root.glob("models--*"):
        parts = base.name.split("--", 2)
        if len(parts) == 3:
            repos.add(parts[1] + "/" + parts[2])
    models = []
    for repo in sorted(repos):
        try:
            models.append(describe(repo))
        except (OSError, ValueError, KeyError):
            pass
    return {"models": models}


def download(repo, request_id, budget):
    info = HfApi().model_info(repo, files_metadata=True)
    suffixes = {".json", ".safetensors", ".model", ".tiktoken", ".txt", ".jinja"}
    files = [f for f in info.siblings if Path(f.rfilename).suffix in suffixes]
    if not any(f.rfilename.endswith(".safetensors") for f in files):
        raise ValueError("Choose a text model with safetensors weights.")
    if any(f.size is None or f.size < 0 or Path(f.rfilename).is_absolute() or ".." in Path(f.rfilename).parts for f in files):
        raise ValueError("Invalid model file metadata.")
    total = sum(f.size for f in files)
    if total > budget:
        raise ValueError("The model exceeds this harness's 80%-of-RAM download budget.")
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < total + 2 * 1024**3:
        raise ValueError("Insufficient disk space; reserve the model size plus 2 GiB.")
    complete = 0
    for i, file in enumerate(files):
        emit({"id": request_id, "event": "progress", "message": f"Downloading {file.rfilename} · {i+1}/{len(files)} files", "percent": int(complete / max(total, 1) * 100), "completed": complete, "total": total})
        hf_hub_download(repo, file.rfilename, revision=info.sha, cache_dir=str(root))
        complete += file.size
    revisions[repo] = info.sha
    registry.parent.mkdir(parents=True, exist_ok=True)
    temporary = registry.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(revisions))
    temporary.replace(registry)
    return describe(repo)


def memory(pid):
    try:
        parent = psutil.Process(pid)
        if parent.ppid() != os.getppid():
            return None  # Only inspect a sibling server owned by this controller.
        rss = 0
        for process in [parent] + parent.children(recursive=True):
            try:
                rss += process.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return rss
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


versions = {name: importlib.metadata.version(name) for name in ["vllm", "vllm-metal", "mlx", "mlx-lm"]}
emit({"event": "ready", "versions": versions, "cacheRoot": str(root), **inventory()})
for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 100000:
            raise ValueError("Request too large.")
        message = json.loads(line)
        request_id = message["id"]
        action = message["action"]
        repo = validate(message["model"]) if "model" in message else None
        if action == "inventory":
            result = inventory()
        elif action == "details":
            result = describe(repo)
        elif action == "download":
            result = download(repo, request_id, int(message["memoryBudget"]))
        elif action == "memory":
            result = {"rssBytes": memory(int(message["pid"]))}
        else:
            raise ValueError("Unknown cache action.")
        emit({"id": request_id, "event": "done", "result": result, "state": inventory()})
    except Exception as error:
        emit({"id": request_id, "event": "error", "message": str(error)[:1500]})
