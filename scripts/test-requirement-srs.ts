import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RequirementSrsEditor } from '../src/components/RequirementSrsEditor';
import { formatBusinessRulesMarkdown, formatRequirementSrs, SRS_INTRO } from '../src/lib/requirementSrs';

const modules = [{
  title: 'Scope & System Availability',
  requirements: [{
    title: 'Display Modes',
    statement: 'The system shall support table and chart modes.',
    details: ['Table: Displays records in rows.', 'Chart: Displays aggregated records.'],
  }],
}];
const output = formatRequirementSrs(modules);

assert.equal(output, `# Software Requirements Specification (SRS)

${SRS_INTRO}

## 1. Scope & System Availability

### 1.1 Display Modes

The system shall support table and chart modes.

- Table: Displays records in rows.

- Chart: Displays aggregated records.`);

assert.equal(
  formatBusinessRulesMarkdown(['Users must be authenticated.', 'Blank filters match all rows.']),
  `## Business Rules

- Users must be authenticated.

- Blank filters match all rows.`,
);

const editorModules = [{
  ...modules[0],
  requirements: [{
    ...modules[0].requirements[0],
    priority: 'Must',
    acceptanceCriteria: [{ given: 'the feature is open', when: 'the mode changes', then: 'the selected mode is displayed' }],
    sources: ['src/pages/Feature.tsx'],
  }],
}];
const editor = renderToStaticMarkup(createElement(RequirementSrsEditor, { modules: editorModules, onChange: () => undefined }));
assert.match(editor, /aria-label="Module 1 title"/);
assert.match(editor, /aria-label="Requirement 1\.1 statement"/);
assert.match(editor, /aria-label="Acceptance criterion 1 given"/);
assert.match(editor, /aria-label="Requirement 1\.1 sources"/);

console.log('Requirement SRS formatting checks passed.');
