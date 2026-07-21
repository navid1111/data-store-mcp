#!/usr/bin/env bash
# Deterministic stand-in for a real model: prints the prompt it received to
# stderr (so the demo can show what context each mode supplies) and returns a
# fixed SQL answer on stdout.
cat > /tmp/dsm-demo-prompt.txt
wc -c < /tmp/dsm-demo-prompt.txt | xargs -I{} echo "[fake-llm] prompt bytes: {}" >&2
echo "SELECT count(*) AS n FROM film WHERE rating = 'PG-13'"
