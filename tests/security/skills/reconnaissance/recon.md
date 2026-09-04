# Reconnaissance & mapping
> Build an accurate map of the attack surface before testing anything.

- Enumerate endpoints and methods: crawl the app, read any API spec (OpenAPI/Swagger/Postman) in scope, diff authenticated vs anonymous views.
- Identify the auth/session model, roles, and trust boundaries — where does one user's data end and another's begin.
- Fingerprint technologies (server, framework, datastore, client stack) to prioritize likely vuln classes.
- Catalogue every user-controllable input: query params, path segments, headers, cookies, JSON/form fields, file uploads.
- Produce prioritized LEADS: concrete, testable weaknesses with a vuln class, a location, and why it is promising. Quality of leads determines the whole exercise.
