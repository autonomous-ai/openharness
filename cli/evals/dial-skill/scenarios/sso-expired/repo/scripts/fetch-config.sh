#!/bin/sh
# Pulls an environment's app config from S3 into config/<env>.json.
set -eu

env="${1:?usage: fetch-config.sh <staging|prod>}"
aws s3 cp "s3://acme-app-config-$env/app.json" "config/$env.json" --profile corp
echo "fetched config/$env.json"
