# SSTI — Server-Side Template Injection
> Injecting template syntax that the server evaluates, often escalating to RCE.

## When it applies
User input rendered through a server template engine: email/notification templates, custom report/label builders, "personalization" fields, error pages, any `render(userInput)`.

## How to test
- Detect the engine with polyglot probes: `${7*7}`, `{{7*7}}`, `#{7*7}`, `<%= 7*7 %>` — a returned `49` confirms evaluation.
- Fingerprint (Jinja2/Twig/Freemarker/ERB/Handlebars) from which syntax evaluates, then use the engine-specific escalation to read files or run commands.
- Distinguish from XSS: SSTI evaluates server-side (math resolves in the response before it reaches the browser).

## How to validate
Show server-side evaluation of your expression (arithmetic resolved server-side), then, if reachable, escalate to file read or command execution as concrete impact.

## Remediation
Never render user input as a template; use a logic-less/sandboxed engine with a strict context; pass user data as data, not template source.
