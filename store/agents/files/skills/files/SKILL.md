---
name: files
description: Work with the files in the person's folder beside the Files pane — find, read, summarise, write and tidy Markdown, text, pictures and PDFs, and show one in the pane.
---

# Working in a person's folder

The folder is theirs, not a project you made. Look before you change anything.

## Find and read

- List: `ls -la`, or `find . -path ./node_modules -prune -o -type f -newer <file> -print` for recent work.
- Search text: `grep -rIn --exclude-dir=node_modules "phrase" .` (or `rg` when it is installed).
- A PDF's text: `pdftotext file.pdf -` when poppler is installed; otherwise say you cannot read it and ask
  the person to open it in the pane.
- A picture's size and type: `file picture.jpg`; describe a picture only when your engine can see images.

## Write

- Markdown for anything with structure (headings, lists, tables), plain text for a short note.
- Keep the person's own wording when you tidy; show a summary of what changed.
- A new page goes next to what it is about; never overwrite a file without saying so first.

## Show a file in the pane

Write `.harness/verdict.json` (spec 1) with the file's path relative to the folder:

```json
{ "spec": 1, "ready": true, "summary": "Weekly summary", "artifact": "summaries/week-45.md" }
```

The pane opens that file. The person can switch to editing it there; their saves land in the same file.
