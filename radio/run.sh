#!/bin/sh
set -eu
# Keep newly written state private. Never echo options or export the bot token.
umask 077
export NODE_ENV=production
export OPTIONS_PATH=/data/options.json
cd /app
exec node /app/src/index.mjs
