---
name: docker-images
description: "Use when writing or changing a Dockerfile: builds small images with multi-stage builds, pins base image versions, orders layers so dependency installs are cached, runs as a non-root user, and keeps build tools and source out of the final image."
---

Pin the base image by version. Copy the lockfile and install dependencies before copying source, so code edits do not bust the cache. Build in one stage and copy only the output into a slim runtime stage. Add a non-root user and a .dockerignore, and check the image size after each change.
