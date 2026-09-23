# Sunset Weather

Static page: side-by-side NWS forecasts for 7 points on SF's west side.
Live: https://dmitryzotman.github.io/sunset-weather (GitHub Pages from main).

## Layout
- index.html / app.js / styles.css: current page. No build step, no deps.
- Tunable values live in CONFIG and LOCATIONS at the top of app.js.

## Rules
- American spelling. No em dashes in UI copy or README.
- Light mode only.
- Classic scripts, no ES modules (page must work opened from disk).
- Walking thresholds were calibrated outdoors. Don't change them unless asked.
- After editing app.js or styles.css, bump the ?v= query string in index.html
  (format YYYYMMDD-N).
- If a threshold or rating rule changes, update the README section that documents it.

## Workflow
- Branch + PR for every change. Never commit to main. Dmitry merges.
- Match effort to the diff. A one-line change is: edit, commit, push, PR.
- Edit in place (sed or targeted edits). Don't read or rewrite whole files
  for small changes.
- Verify scoring changes with a quick node check of the scoring function
  against a few cases. Don't run browser/Playwright tests unless the change
  is visual; live weather makes them non-deterministic.
- Don't re-check permissions or re-fetch data you already have in this session.
