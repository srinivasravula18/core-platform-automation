import assert from 'node:assert/strict';
import { formatBusinessRulesMarkdown, formatRequirementSrs, SRS_INTRO } from '../src/lib/requirementSrs';

const output = formatRequirementSrs([{
  title: 'Scope & System Availability',
  requirements: [{
    title: 'Display Modes',
    statement: 'The system shall support table and chart modes.',
    details: ['Table: Displays records in rows.', 'Chart: Displays aggregated records.'],
  }],
}]);

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

console.log('Requirement SRS formatting checks passed.');
