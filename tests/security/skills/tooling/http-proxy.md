# Tooling: HTTP interception & request manipulation
> Capture, inspect, replay, and tamper with HTTP the way an interception proxy does — using the shell you already have.

You do not need a GUI proxy. With your sandbox shell you can do everything an interception proxy does:
- **Craft & tamper**: use `curl -v`, `curl --data-raw`, custom headers/cookies, and raw sockets to send exactly the bytes you want; replay a captured request with one field changed.
- **Scripted interception**: run `mitmproxy`/`mitmdump` (install via pip if absent) to record and rewrite traffic; or drive requests from Python (`requests`, `httpx`) so you can loop, fuzz, and diff responses programmatically.
- **Diff-based analysis**: script a baseline request and a tampered request, diff status/length/body to detect boolean/blind conditions.
- **Session handling**: capture auth from a login response, thread the cookie/bearer through subsequent requests; test what happens when you drop or swap it.

Method: capture a real request → replay it unchanged to confirm your harness → then mutate one variable at a time (id, header, method, body field) and compare responses. Automate the mutation loop in Python rather than sending dozens of manual curls.
