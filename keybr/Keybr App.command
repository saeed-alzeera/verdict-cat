#!/bin/bash
cd /Users/saeedalzeera/Documents/keybr.com

# Open a second Terminal window for webpack watch (auto-rebuilds on file changes)
osascript -e 'tell application "Terminal" to do script "cd /Users/saeedalzeera/Documents/keybr.com && npm run watch"'

# Open the browser once the server is ready
(sleep 6 && open http://localhost:3000) &

# Initialize DB schema if not already done (safe to run every time — skips existing tables)
node_modules/.bin/tsnode packages/devenv/lib/initdb.ts 2>&1 | grep -v "Access token\|Visit http"

# Start the server in this window
npm start
