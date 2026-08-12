import { discoverRepoGrounding } from '../server/features/agent/workflow/nodes/repoGrounding';

const repoPath = process.argv[2] || 'D:/core-platform';
const nodes = discoverRepoGrounding(repoPath);
console.log(`Found ${nodes.length} repo-grounded node(s) in ${repoPath}`);

const pageObjectNodes = nodes.filter((n) => n.pageObjectRef);
const inlineNodes = nodes.filter((n) => !n.pageObjectRef);
console.log(`  ${pageObjectNodes.length} Page Object method(s), ${inlineNodes.length} inline locator(s)`);

console.log('\n--- Page Object methods ---');
for (const n of pageObjectNodes) {
  console.log(`${n.semanticName} -> ${n.pageObjectRef!.className}.${n.pageObjectRef!.method}() [${n.sourceRef!.file}:${n.sourceRef!.line}]`);
}

console.log('\n--- account-creation.spec.ts entries ---');
for (const n of inlineNodes) {
  if (!n.sourceRef!.file.includes('account-creation')) continue;
  console.log(`${n.semanticName} | role=${n.role} label=${JSON.stringify(n.label)} selector=${n.selector} selectorType=${n.selectorType} stateTag=${n.stateTag} [line ${n.sourceRef!.line}]`);
}

const dupes = new Map<string, number>();
for (const n of nodes) dupes.set(n.semanticName, (dupes.get(n.semanticName) || 0) + 1);
const collisions = [...dupes.entries()].filter(([, c]) => c > 1);
console.log(`\nSemantic name collisions across whole repo: ${collisions.length}`);
