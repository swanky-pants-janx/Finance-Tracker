#!/bin/sh
# Vercel runs this before deploying. It writes supabase-config.js from env vars.
cat > supabase-config.js <<EOF
const SUPABASE_URL  = '${SUPABASE_URL}';
const SUPABASE_ANON = '${SUPABASE_ANON}';
EOF
