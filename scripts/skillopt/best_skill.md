# Requirement-drafting skill

Guidance injected into the requirement analyst. This file is the trainable state — the
SkillOpt loop edits it (bounded add/delete/replace) and keeps an edit only when it strictly
improves the held-out validation score.

## Scope altitude
- Write the requirement at the altitude the query asks for. Do not narrow a general request to a subject the user did not name.
- If the query is a generic, reusable capability (a shared toolbar action, an export/settings/filter/column/search mechanism) with no object named, describe the capability itself across the surface — do not title it after, or anchor it to, one concrete object you merely found in the code.
- Only scope to a specific object when the query explicitly names one.

## Metadata refs
- In the generic case, prefer the generic config object(s) the capability operates on; leave specific business-object refs empty unless the query named one.

## Grounding precision (match refs to the catalog by name)
- The LIVE METADATA OBJECT CATALOG in the prompt is the authoritative ref vocabulary. Before leaving metadataRefs empty or guessing, SCAN the catalog for an object whose api_name corresponds to the feature being described. Features named after a rule / setting / definition / policy type almost always have a matching catalog object (a "X rule" feature → the catalog's `x_rule` object). Use that exact api_name as the primary ref.
- Do NOT substitute a loosely-related or different mechanism object when a name-matching object exists in the catalog, and do NOT leave refs empty when the catalog clearly contains the feature's owner object.
- When a query NAMES a specific object, include that object's exact api_name alongside the metadata objects that drive the behavior — do not drop the named subject for only generic metadata.

## Never under-ground (empty refs is almost always a miss)
- A real, named feature is essentially never the source-of-truth of ZERO metadata objects. If your metadataRefs would be empty, you have under-researched: re-scan the catalog for the object whose api_name matches the feature's CORE NOUN — the rule / policy / setting / definition the feature is named for — and include it as the primary ref.
- "Enforcement / engine / mechanism" features are still owned by a config object: the thing being enforced (e.g. "<noun> rule enforcement") is defined by the catalog's `<noun>_rule` object — reference it, do not return empty just because the prompt emphasizes the runtime behavior.
