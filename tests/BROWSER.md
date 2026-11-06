# Public sample browser checks

`check-ui.mjs` uses Node 22+ and an already running headless Chrome with its
debugging endpoint on `127.0.0.1:9333`. Use an approved temporary Chrome profile.
The harness creates an isolated browser context, blocks non-loopback page
requests, and closes its context when finished.

Serve this repository's `docs` directory on loopback, then run:

```sh
node tests/check-ui.mjs http://127.0.0.1:8765/
```

`BROWSER_URL` can select a different loopback debugging endpoint. The checks
cover the reviewed interactions and the 1230×690, 1920×1080 and 390×844 layouts.
They neither publish nor call a live model provider.
