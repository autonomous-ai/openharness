---
name: image-optimization
description: "Use when a page or app ships images: serves modern formats with fallbacks, sizes images to the slot they fill with srcset, lazy-loads anything below the fold, sets width and height to avoid layout shift, and keeps source files out of the shipped bundle."
---

Export at the largest size the layout needs and let the build produce smaller ones. Prefer AVIF or WebP with a JPEG fallback. Give every image explicit dimensions. Lazy-load offscreen images and preload the one that paints first. Measure the page weight before and after.
