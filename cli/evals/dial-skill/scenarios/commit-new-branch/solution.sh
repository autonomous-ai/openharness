#!/bin/sh
set -e
git checkout -q -b docs/readme-typo
sed 's/recieve/receive/' README.md > README.md.new
mv README.md.new README.md
git commit -q -am 'Fix a typo in the README'
