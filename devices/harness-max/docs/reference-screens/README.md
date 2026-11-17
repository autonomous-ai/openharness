# Reference screens for Harness Max's UI and UX

Every screen of the Harness Dial (258, 466 x 466) and the Harness Pro (72, 720 x 720), the Harness Max draft (12,
1920 x 480) and five animations, rendered on a Mac by the firmware's own C renderers (not photos of the glass).
Exported on 2026-11-17 from `main` `1e17b388ce` (Dial, Pro) and `feat/harness-max-all` `b4e0e70828` (Max), as the
starting point of Harness Max's UI and UX.

- `INDEX.md`: every screen with what it shows, grouped by flow, each device's way of interacting, and what the Max
  draft does not draw yet (written by `tools/build.py`, in Vietnamese).
- `gallery.html`: the same, one file with the images inside; opens offline.
- `screens/{dial,pro,max-draft,anim}`: the PNGs and WebP animations.
- `sheets/`: contact sheets used to review the export (Dial core, design and Focus faces; Pro; Max).
- `export.sh`: renders everything again into this folder (`REF=` for the Dial and Pro, `MAX_REF=` for Max, `OUT=` for
  another folder). Needs `cc` and Python with Pillow 12.

What the Max draft lacks next to the Dial and the Pro: an overview by tab, a notices list, bubble recaps, answering a
question (a later milestone), the pet and motion, a voice error with "Try again", and a controls menu.
