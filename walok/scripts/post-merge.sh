#!/bin/bash
set -e

npm install --no-audit --no-fund

if [ -f server/package.json ]; then
  (cd server && npm install --no-audit --no-fund)
fi
