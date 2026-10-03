#!/bin/sh
# Pass-through. This used to rewrite NEXT_PUBLIC_* build-time sentinels from the pod's env for the old
# React app; nothing in the image reads them any more. Kept, and still the image's ENTRYPOINT, so a
# Deployment that names /app/docker-entrypoint.sh as its command keeps working.
exec "$@"
