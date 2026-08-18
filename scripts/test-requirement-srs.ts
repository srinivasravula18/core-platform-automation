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

**Details**

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

// Details must not read as acceptance criteria, and joining Gherkin clauses must not double-punctuate.
// Both inputs are verbatim from a real drafted requirement.
{
  const rendered = formatRequirementSrs([{
    title: 'New App form',
    requirements: [{
      title: 'Required creation fields',
      statement: 'The system shall require Label before the New App form can be submitted.',
      acceptanceCriteria: [
        { given: 'The administrator has opened the New App form.', when: 'Label is empty, no creation request is sent.', then: 'The app is not created.' },
        { given: 'Version is blank.', when: 'The service creates the app and Version is "1.0.0".', then: 'The default is used.' },
      ],
      details: ['The exact endpoint path was not supplied and must not be guessed.'],
    }],
  }]);

  // The bug: details rendered as bare bullets straight after the criteria, so they read as criteria.
  const detailsAt = rendered.indexOf('- The exact endpoint path');
  assert.ok(rendered.indexOf('**Details**') > rendered.indexOf('**Acceptance criteria**'), 'details get their own heading');
  assert.ok(rendered.lastIndexOf('**Details**', detailsAt) > -1 && rendered.indexOf('**Details**') < detailsAt, 'the heading precedes its bullets');

  assert.doesNotMatch(rendered, /\.,\s*(?:when|then)\b/, 'no ". ," collision where clauses join');
  assert.match(rendered, /- Given The administrator has opened the New App form, when Label is empty, no creation request is sent, then The app is not created\.$/m);
  assert.match(rendered, /Version is "1\.0\.0", then The default is used\.$/m, 'a decimal inside a clause survives the period trim');

  // A criterion with only one clause still ends as a sentence.
  const single = formatRequirementSrs([{ title: 'M', requirements: [{ title: 'R', statement: 'S', acceptanceCriteria: [{ then: 'The record is saved' }] }] }]);
  assert.match(single, /- then The record is saved\.$/m);
}

// Repo internals must never reach the rendered document. Inputs below are verbatim from a real drafted
// requirement that leaked them into the Agent Console.
{
  const leaky = formatRequirementSrs([{
    title: 'Creation validation',
    requirements: [{
      title: 'Existing parent required',
      statement: 'The system shall reject creation when the selected parent app does not exist.',
      details: [
        'Parent App is available through #create-app-parent.',
        'The layout is set by .admin-app-detail-section.',
        'Expected status: 404.',
      ],
      sources: [
        'DEEP PARALLEL RESEARCH NOTES — Validation and creation request',
        'apps/service/src/auth/routes.ts',
        'apps/service/src/permissions/routes.ts:120-140',
        'schema.sql',
      ],
    }],
  }]);

  assert.doesNotMatch(leaky, /apps\/service|routes\.ts|schema\.sql/, 'repo paths must not render');
  assert.doesNotMatch(leaky, /#create-app-parent|\.admin-app-detail-section/, 'raw selectors must not render');
  // Redaction must be surgical: the readable citation and the business detail both survive.
  assert.match(leaky, /\*Source: DEEP PARALLEL RESEARCH NOTES — Validation and creation request\*/);
  assert.match(leaky, /- Expected status: 404\./);
  assert.match(leaky, /The system shall reject creation/);

  // Redaction must not eat real business prose that happens to contain dots or ids.
  const prose = formatRequirementSrs([{
    title: 'M',
    requirements: [{
      title: 'R',
      statement: 'The system shall accept the allowed upload types.',
      details: ['Allowed file types are .png, .pdf and .csv.', 'Version defaults to 1.0.0.', 'The record id is returned.'],
    }],
  }]);
  assert.match(prose, /Allowed file types are \.png, \.pdf and \.csv\./, 'file extensions are not selectors');
  assert.match(prose, /Version defaults to 1\.0\.0\./, 'version numbers are not file paths');
  assert.match(prose, /The record id is returned\./);

  // A requirement whose ONLY citations are repo paths drops the Source line rather than printing an empty one.
  const pathsOnly = formatRequirementSrs([{
    title: 'M', requirements: [{ title: 'R', statement: 'The system shall do X.', sources: ['server/features/x.ts'] }],
  }]);
  assert.doesNotMatch(pathsOnly, /Source:/, 'no citation line when every source was a repo path');
}

console.log('Requirement SRS formatting checks passed.');
