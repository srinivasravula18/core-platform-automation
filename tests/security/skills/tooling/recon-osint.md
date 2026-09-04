# Tooling: reconnaissance, enumeration & fingerprinting
> Map the attack surface with shell tooling — endpoints, subdomains, technologies, and content.

Within the authorized scope only, use the sandbox shell to enumerate:
- **Content/endpoints**: crawl with `curl`/scripted fetch; brute paths with a wordlist (`ffuf`/`gobuster`/`dirsearch` if installed, else a scripted loop) for `/admin`, `/api`, `/.git`, `/.env`, `/swagger`, backups.
- **Parameters**: mine hidden params (`arjun`-style) and read client JS bundles for endpoint/route/secret hints.
- **Fingerprinting**: identify server, framework, and datastore from headers, error pages, cookies, and favicon/asset hashes — use it to prioritize likely vuln classes.
- **Subdomains/hosts** (only if in scope): passive enumeration; never touch a host that is not in the system-verified scope.
- **API discovery**: if an OpenAPI/Swagger/Postman spec is in scope, parse it and enumerate every declared endpoint instead of guessing.

Prefer established tools where present; script the loops in Python to batch and triage. Produce prioritized, testable leads — quality of recon determines the whole exercise.
