import { linkedExistingCases, scoreCaseReuse } from '../server/features/agent/caseReuse';

const keywords = ['list', 'view', 'object', 'settings', 'search', 'admin'];
const related = scoreCaseReuse('write test cases for list view', 'Objects list shows the All Objects list view', keywords);
const unrelated = scoreCaseReuse('write test cases for list view', 'Object settings show global search and inline edit controls', keywords);

if (!related.matched || related.anchor !== 'list view') throw new Error('A true List View case was not matched.');
if (unrelated.matched) throw new Error('An Object Settings case leaked into List View reuse.');

const linked = linkedExistingCases(
  [],
  [{ reused: true, existingCaseId: 'TC-1' }, { reused: false, id: 'TC-2' }, { reused: true, existingCaseId: 'TC-1' }],
);
if (linked.length !== 1 || linked[0].existingCaseId !== 'TC-1') throw new Error('Reused requirement links were lost or duplicated.');

console.log('case reuse checks passed');
