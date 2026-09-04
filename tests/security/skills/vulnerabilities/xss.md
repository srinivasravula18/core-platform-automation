# XSS — Cross-Site Scripting
> Injecting script that executes in another user's browser (stored, reflected, or DOM-based).

## When it applies
Any user input rendered back into HTML/JS: comments, names, search terms, error messages reflecting input, markdown, and client-side sinks (`innerHTML`, `document.write`, template bindings).

## How to test
- Reflected: inject a unique marker, find where it lands, then break out of the context (HTML body, attribute, JS string, URL) with the right payload: `"><svg onload=…>`, `'-alert(1)-'`, `javascript:` URLs.
- Stored: submit a payload that persists (profile, comment) and confirm it fires when the victim view loads.
- DOM: trace `location`/`postMessage`/`hash` into a sink; test `#<img src=x onerror=…>`.
- Prefer a benign proof (`document.title` change, callback to your listener) over `alert()` for evidence capture.

## How to validate
Demonstrate script execution in a victim context — a callback carrying the victim's cookie/DOM, or a stored payload that runs for another user. Reflected input without execution (properly encoded) is not a finding.

## Remediation
Contextual output encoding; a strict CSP; framework auto-escaping; avoid dangerous sinks; `HttpOnly` cookies to blunt theft.
