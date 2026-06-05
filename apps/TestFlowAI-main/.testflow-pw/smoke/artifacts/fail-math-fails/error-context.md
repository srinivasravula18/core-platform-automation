# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fail.spec.ts >> math fails
- Location: tests\fail.spec.ts:1:48

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 1
```

# Test source

```ts
> 1 | import {test, expect} from "@playwright/test"; test("math fails", async()=>{ expect(1).toBe(2); });
    |                                                                                        ^ Error: expect(received).toBe(expected) // Object.is equality
```