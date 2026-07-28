import ts from 'typescript';
import { resolveExpression } from './variableEngine';

const VALUE_METHODS = new Set(['fill', 'press', 'selectOption', 'select', 'setInputFiles', 'type']);

type Replacement = { start: number; end: number; text: string };
type EditableCall = { call: ts.CallExpression; valueArgument: number };

/** Compile the immutable action locations once, then materialize any number of dataset rows. */
export function createScriptMaterializer(script: string, steps: any[], mappings: any[], columns: any[], runToken?: string) {
  const source = ts.createSourceFile('recording.spec.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: EditableCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(source);
      if ((VALUE_METHODS.has(method) || method === 'check' || method === 'uncheck') && /getBy\w+\(/.test(receiver)) {
        calls.push({ call: node, valueArgument: 0 });
      } else if (receiver === 'runner' && ['fill', 'press', 'select', 'check', 'uncheck'].includes(method)) {
        calls.push({ call: node, valueArgument: 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  calls.sort((a, b) => a.call.getStart(source) - b.call.getStart(source));

  return (row: any): string => {
    const replacements: Replacement[] = [];
    for (const step of steps) {
      const mapping = mappings.find((item) => item.stepId === step.id && (!item.datasetId || item.datasetId === row.datasetId));
      let value: any;
      if (mapping) {
        // A mapping resolves an expression (column reference, generator, or literal+transform mix).
        const column = columns.find((item: any) => item.id === mapping.columnId);
        const expression = mapping.expression || (column ? `{{${column.name}}}` : '');
        value = resolveExpression(expression, { columns, values: row.values || {}, rowNumber: row.rowNumber, runToken, rowSeq: row.rowSeq ?? row.rowNumber });
        if (value === null || value === undefined || value === '') {
          throw new Error(`Row ${row.rowNumber}: ${step.metadata?.label || step.locator} resolved to an empty value.`);
        }
      } else {
        value = step.currentOverride;
        if (value === null || value === undefined) continue;
      }

      const editable = calls[step.ordinal];
      const call = editable?.call;
      if (!editable || !call || !ts.isPropertyAccessExpression(call.expression)) {
        throw new Error(`Could not materialize ${step.metadata?.label || step.locator}.`);
      }
      const method = call.expression.name.text;
      if (method === 'check' || method === 'uncheck') {
        const checked = typeof value === 'boolean' ? value : /^(true|1|yes|on)$/i.test(String(value));
        replacements.push({ start: call.expression.name.getStart(source), end: call.expression.name.getEnd(), text: checked ? 'check' : 'uncheck' });
        continue;
      }
      const argument = call.arguments[editable.valueArgument];
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
export function materializeScript(script: string, steps: any[], mappings: any[], row: any, columns: any[], runToken?: string): string {
  return createScriptMaterializer(script, steps, mappings, columns, runToken)(row);
}
