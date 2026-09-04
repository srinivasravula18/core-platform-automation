# XXE — XML External Entity
> Abusing an XML parser that resolves external entities to read files, SSRF, or exfiltrate data.

## When it applies
Any endpoint parsing XML: SOAP, SAML, SVG/DOCX/XLSX uploads, RSS/sitemap import, XML APIs, config import.

## How to test
- Inject a DOCTYPE with an external entity: `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>` and reference `&x;` in a value that gets echoed.
- Blind/OOB: point the entity at a listener (`http://<listener>/`) or use a parameter entity + external DTD to exfiltrate file contents over your channel.
- SSRF via XXE: `SYSTEM "http://169.254.169.254/…"`.
- Try in file uploads (SVG on an avatar, XLSX/DOCX which are XML zips).

## How to validate
Show file contents returned (or exfiltrated to your listener), or an internal request made by the parser. Reflected `&x;` returning `/etc/passwd` content is definitive.

## Remediation
Disable DOCTYPE / external entities in the parser (`FEATURE_SECURE_PROCESSING`, `disallow-doctype-decl`); prefer non-XML formats; patch parser libs.
