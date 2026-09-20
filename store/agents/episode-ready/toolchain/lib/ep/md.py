"""A very small Markdown subset, rendered to HTML.

Show notes go into an RSS description, which accepts a handful of tags and nothing else. Doing
this in fifty lines is better than a dependency that would render things a feed reader strips.
"""
from __future__ import annotations

import html
import re

_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_CODE = re.compile(r"`([^`]+)`")


def inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = _CODE.sub(lambda m: f"<code>{m.group(1)}</code>", out)
    out = _LINK.sub(lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>', out)
    out = _BOLD.sub(lambda m: f"<strong>{m.group(1)}</strong>", out)
    out = _ITALIC.sub(lambda m: f"<em>{m.group(1)}</em>", out)
    return out


def to_html(markdown: str) -> str:
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    list_open: str | None = None
    paragraph: list[str] = []

    def close_list() -> None:
        nonlocal list_open
        if list_open:
            out.append(f"</{list_open}>")
            list_open = None

    def close_paragraph() -> None:
        if paragraph:
            out.append(f"<p>{inline(' '.join(paragraph).strip())}</p>")
            paragraph.clear()

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            close_paragraph()
            close_list()
            continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading:
            close_paragraph()
            close_list()
            level = min(4, len(heading.group(1))) + 1
            out.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
            continue
        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        number = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if bullet or number:
            close_paragraph()
            want = "ul" if bullet else "ol"
            if list_open != want:
                close_list()
                out.append(f"<{want}>")
                list_open = want
            out.append(f"<li>{inline((bullet or number).group(1))}</li>")
            continue
        if stripped.startswith(">"):
            close_paragraph()
            close_list()
            out.append(f"<blockquote><p>{inline(stripped.lstrip('> '))}</p></blockquote>")
            continue
        close_list()
        paragraph.append(stripped)
    close_paragraph()
    close_list()
    return "\n".join(out) + "\n"


def to_plain(markdown: str) -> str:
    text = _LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", markdown)
    text = _BOLD.sub(r"\1", text)
    text = _ITALIC.sub(r"\1", text)
    text = _CODE.sub(r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    return text.strip()
