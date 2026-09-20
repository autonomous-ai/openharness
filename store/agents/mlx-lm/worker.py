#!/usr/bin/env python3
"""Private JSON-lines bridge to MLX-LM. One loaded model per workspace worker."""
import gc
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid

# Vendor output belongs in the diagnostic log, never in the JSON protocol.
protocol = sys.stdout
sys.stdout = sys.stderr
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.constants import HF_HUB_CACHE
import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler

model = tokenizer = None
loaded_id = None
loaded_context = 4096
loaded_config = {}
registry_path = Path(os.environ.get("HARNESS_MLX_REGISTRY", Path(__file__).parent / ".harness/mlx-models.json"))
try:
    revisions = json.loads(registry_path.read_text())
    if not isinstance(revisions, dict):
        revisions = {}
except (OSError, ValueError):
    revisions = {}
extra_repos = set(revisions)
cache_root = Path(HF_HUB_CACHE)


def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    protocol.flush()


def validate_id(value):
    if not isinstance(value, str) or len(value) > 180 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", value) or ".." in value:
        raise ValueError("Use a Hugging Face model ID, such as mlx-community/Qwen3-0.6B-4bit.")
    return value


def snapshot(repo):
    base = cache_root / ("models--" + repo.replace("/", "--"))
    revision = revisions.get(repo, "")
    if isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{40,64}", revision):
        candidate = base / "snapshots" / revision
        if candidate.is_dir():
            return candidate
    try:
        revision = (base / "refs/main").read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
            raise ValueError("Invalid cached revision.")
        candidate = base / "snapshots" / revision
        if candidate.is_dir():
            return candidate
    except (OSError, ValueError):
        pass
    candidates = sorted((base / "snapshots").glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def describe(repo):
    path = snapshot(repo)
    if path is None:
        raise ValueError(f"{repo} is not downloaded.")
    config = json.loads((path / "config.json").read_text())
    weights = list(path.glob("*.safetensors"))
    index = path / "model.safetensors.index.json"
    if index.exists():
        expected = set(json.loads(index.read_text())["weight_map"].values())
        if any(Path(name).name != name or not (path / name).is_file() for name in expected):
            raise ValueError(f"{repo} has incomplete model weights; download it again to resume.")
    if not weights or any(not p.is_file() for p in weights) or not (path / "tokenizer_config.json").is_file():
        raise ValueError(f"{repo} has an incomplete snapshot; download it to resume.")
    if "vision_config" in config and config.get("model_type") not in {"gemma3_text"}:
        raise ValueError("This harness supports text models; multimodal models need MLX-VLM.")
    quant = config.get("quantization") or config.get("quantization_config") or {}
    bits = quant.get("bits")
    size = sum(p.stat().st_size for p in path.iterdir() if p.is_file())
    running = repo == loaded_id
    return {
        "id": repo, "name": repo.split("/")[-1], "size": size, "digest": path.name,
        "family": config.get("model_type"), "parameters": None,
        "quantization": f"{bits}-bit" if bits else str(config.get("torch_dtype", "Unquantized")),
        "running": running, "resident": {"size": mx.get_active_memory(), "context_length": loaded_context} if running else None,
    }


def inventory():
    repos = set(extra_repos)
    for base in cache_root.glob("models--*"):
        parts = base.name.split("--", 2)
        if len(parts) == 3 and (parts[1] == "mlx-community" or "mlx" in parts[2].lower()):
            repos.add(parts[1] + "/" + parts[2])
    rows = []
    for repo in sorted(repos):
        try:
            rows.append(describe(repo))
        except (OSError, ValueError, KeyError):
            continue  # An incomplete download is not an installed model.
    return {"models": rows, "activeMemoryBytes": mx.get_active_memory(), "cacheMemoryBytes": mx.get_cache_memory()}


def unload():
    global model, tokenizer, loaded_id, loaded_config
    model = tokenizer = None
    loaded_id = None
    loaded_config = {}
    gc.collect()
    mx.clear_cache()


def download(repo, request_id, memory_budget):
    info = HfApi().model_info(repo, files_metadata=True)
    # Safetensors and tokenizer/config data only. Never fetch or execute model Python.
    suffixes = {".json", ".safetensors", ".model", ".tiktoken", ".txt", ".jinja"}
    files = [f for f in info.siblings if Path(f.rfilename).suffix in suffixes]
    if not any(f.rfilename.endswith(".safetensors") for f in files):
        raise ValueError("This repository has no safetensors weights for MLX-LM.")
    if any(f.size is None or f.size < 0 or Path(f.rfilename).is_absolute() or ".." in Path(f.rfilename).parts for f in files):
        raise ValueError("The model repository returned invalid file metadata.")
    total = sum(f.size for f in files)
    if total > memory_budget:
        raise ValueError("This download exceeds the pilot's 80% of RAM model-size budget. Choose a smaller model.")
    cache_root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(cache_root).free < total + 2 * 1024**3:
        raise ValueError("Not enough free storage for the model plus 2 GiB of headroom.")
    complete = 0
    for index, file in enumerate(files):
        emit({"id": request_id, "event": "progress", "message": f"Downloading {file.rfilename} · {index + 1}/{len(files)} files", "percent": int(complete / max(total, 1) * 100), "completed": complete, "total": total})
        hf_hub_download(repo, file.rfilename, revision=info.sha, cache_dir=str(cache_root))
        complete += file.size
    # Pin this workspace's revision without changing another application's HF refs.
    revisions[repo] = info.sha
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    temp = registry_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temp.write_text(json.dumps(revisions))
    temp.replace(registry_path)
    extra_repos.add(repo)
    return describe(repo)


def load_model(repo, context):
    global model, tokenizer, loaded_id, loaded_context, loaded_config
    describe(repo)
    if repo != loaded_id:
        unload()
        try:
            model, tokenizer, loaded_config = load(str(snapshot(repo)), tokenizer_config={"trust_remote_code": False, "local_files_only": True}, return_config=True)
        except Exception:
            unload()
            raise
        loaded_id = repo
        extra_repos.add(repo)
    loaded_context = context
    return describe(repo)


def generate(repo, message, request_id):
    if repo != loaded_id:
        raise ValueError("Load the model before generating.")
    options = message.get("options", {})
    context = int(options.get("context", 4096))
    maximum = int(options.get("maxTokens", 512))
    messages = message["messages"]
    template = tokenizer.chat_template or ""
    thinking = bool(options.get("thinking", True)) and "enable_thinking" in template
    if template:
        prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=thinking)
        prompt = tokenizer.encode(prompt_text, add_special_tokens=False)
    else:
        prompt_text = "\n".join(m["role"] + ": " + m["content"] for m in messages) + "\nassistant:"
        prompt = tokenizer.encode(prompt_text)
    if len(prompt) + maximum > context:
        raise ValueError(f"Prompt plus output budget exceeds this harness's {context:,}-token context. Shorten the conversation.")
    mx.random.seed(int(options.get("seed", 42)))
    mx.reset_peak_memory()
    started = time.perf_counter()
    raw = visible = ""
    first_token = first_output = None
    starts_thinking = thinking and bool(re.search(r"<think>\s*$", prompt_text))
    last = None
    for response in stream_generate(model, tokenizer, prompt, max_tokens=maximum, sampler=make_sampler(temp=float(options.get("temperature", 0.3))), max_kv_size=context, prefill_step_size=512):
        last = response
        elapsed = (time.perf_counter() - started) * 1000
        if first_token is None:
            first_token = elapsed
            emit({"id": request_id, "event": "first_token"})
        raw += response.text
        current = raw
        if thinking:
            if starts_thinking:
                current = raw.split("</think>", 1)[1] if "</think>" in raw else ""
            current = re.sub(r"<think>.*?(?:</think>|$)", "", current, flags=re.S)
            # Hold incomplete delimiters and whitespace until actual answer text exists.
            # Otherwise the opening newline is incorrectly counted as visible output.
            for tag in ("<think>", "</think>"):
                for length in range(1, len(tag)):
                    if current.endswith(tag[:length]):
                        current = current[:-length]
                        break
            current = current.lstrip()
        if len(current) > len(visible):
            if first_output is None:
                first_output = elapsed
            emit({"id": request_id, "event": "token", "text": current[len(visible):]})
            visible = current
    if last is None:
        raise ValueError("MLX-LM returned no generation result.")
    mx.synchronize()
    metrics = {
        "model": repo, "tokens": last.generation_tokens, "promptTokens": last.prompt_tokens,
        "tokensPerSecond": last.generation_tps, "promptTokensPerSecond": last.prompt_tps,
        "nativeFirstTokenMs": first_token, "nativeFirstOutputMs": first_output,
        "peakMemoryBytes": round(last.peak_memory * 1e9), "thinking": thinking,
        "doneReason": last.finish_reason, "wallMs": (time.perf_counter() - started) * 1000,
        "measurement": "MLX-LM native generation_tps; TTFT includes local IPC; fresh prompt cache",
    }
    return {"text": visible, "metrics": metrics}


emit({"event": "ready", "version": importlib.metadata.version("mlx-lm"), "mlxVersion": importlib.metadata.version("mlx"), "cacheRoot": str(cache_root), **inventory()})
for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 100_000:
            raise ValueError("Worker request too large.")
        message = json.loads(line)
        request_id = message["id"]
        action = message["action"]
        repo = validate_id(message["model"]) if "model" in message else None
        if action == "inventory":
            result = inventory()
        elif action == "details":
            result = describe(repo)
        elif action == "download":
            result = download(repo, request_id, int(message["memoryBudget"]))
        elif action == "load":
            result = load_model(repo, int(message.get("context", 4096)))
        elif action == "unload":
            if loaded_id == repo:
                unload()
            result = {"unloaded": repo}
        elif action == "generate":
            result = generate(repo, message, request_id)
        else:
            raise ValueError("Unknown worker action.")
        emit({"id": request_id, "event": "done", "result": result, "state": inventory()})
    except Exception as error:
        emit({"id": request_id, "event": "error", "message": str(error)[:1500], "state": inventory()})
unload()
