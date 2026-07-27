import ts from 'typescript';

const VALUE_METHODS = new Set(['fill', 'press', 'selectOption', 'setInputFiles', 'type']);

type Replacement = { start: number; end: number; text: string };

/** Compile the immutable action locations once, then materialize any number of dataset rows. */
export function createScriptMaterializer(script: string, steps: any[], mappings: any[], columns: any[]) {
  const source = ts.createSourceFile('recording.spec.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const locator = node.expression.expression.getText(source);
      if ((VALUE_METHODS.has(method) || method === 'check' || method === 'uncheck') && /getBy\w+\(/.test(locator)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  calls.sort((a, b) => a.getStart(source) - b.getStart(source));

  return (row: any): string => {
    const replacements: Replacement[] = [];
    for (const step of steps) {
      const mapping = mappings.find((item) => item.stepId === step.id && (!item.datasetId || item.datasetId === row.datasetId));
      const column = mapping && columns.find((item: any) => item.id === mapping.columnId);
      const value = mapping ? row.values?.[column?.id] : step.currentOverride;
      if (!mapping && (value === null || value === undefined)) continue;
      if (mapping && !column) throw new Error(`Mapping for ${step.metadata?.label || step.locator} references a missing column.`);
      if (mapping && (value === null || value === undefined || value === '')) throw new Error(`Row ${row.rowNumber}: ${column.name} is empty.`);

      const call = calls[step.ordinal];
      if (!call || !ts.isPropertyAccessExpression(call.expression)) {
        throw new Error(`Could not materialize ${step.metadata?.label || step.locator}.`);
      }
      const method = call.expression.name.text;
      if (method === 'check' || method === 'uncheck') {
        const checked = typeof value === 'boolean' ? value : /^(true|1|yes|on)$/i.test(String(value));
        replacements.push({ start: call.expression.name.getStart(source), end: call.expression.name.getEnd(), text: checked ? 'check' : 'uncheck' });
        continue;
      }
      const argument = call.arguments[0];
      if (!argument) throw new Error(`Could not materialize ${step.metadata?.label || step.locator}.`);
      replacements.push({ start: argument.getStart(source), end: argument.getEnd(), text: JSON.stringify(String(value)) });
    }

    let output = script;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
    }
    return output;
  };
}

/** Build one throwaway runtime script. The finalized recording remains unchanged. */
export function materializeScript(script: string, steps: any[], mappings: any[], row: any, columns: any[]): string {
  return createScriptMaterializer(script, steps, mappings, columns)(row);
}
