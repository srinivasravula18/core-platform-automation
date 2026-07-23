import { Fragment, useEffect, useId, useState } from 'react';
import { withBasePath } from '@/src/lib/base-path';

function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      const rendered = await mermaid.render(id, source);
      if (active) setSvg(rendered.svg);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [id, source]);

  if (error) return <pre className="my-3 overflow-x-auto rounded-md bg-black/30 p-3 text-xs"><code>{source}</code></pre>;
  return <div aria-label="Architecture diagram" className="my-4 overflow-x-auto rounded-lg border border-[var(--border)] bg-slate-950 p-4" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function inlineParts(text: string) {
  const parts = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (/^`[^`]+`$/.test(part)) {
      return <code key={i} className="rounded bg-black/20 px-1 py-0.5 font-mono text-[0.92em]">{part.slice(1, -1)}</code>;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isDividerRow(line: string): boolean {
  return isTableRow(line) && /^[\s|:-]+$/.test(line);
}

function renderTable(rows: string[], key: string) {
  const cells = rows.filter((r) => !isDividerRow(r)).map(splitRow);
  if (!cells.length) return null;
  const [head, ...body] = cells;
  return (
    <div key={key} className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border border-[var(--border)] bg-black/20 px-2 py-1.5 text-left font-semibold">{inlineParts(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i} className="border border-[var(--border)] px-2 py-1.5 align-top">{inlineParts(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarkdownText({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let code: string[] | null = null;
  let codeLanguage = '';
  let table: string[] | null = null;

  const flushTable = (i: number) => {
    if (table && table.length) blocks.push(renderTable(table, `table-${i}`));
    table = null;
  };

  lines.forEach((line, i) => {
    // Collect consecutive |...| rows into one table block.
    if (!code && isTableRow(line)) {
      (table ??= []).push(line);
      return;
    }
    flushTable(i);
    if (line.trim().startsWith('```')) {
      if (code) {
        const source = code.join('\n');
        blocks.push(codeLanguage === 'mermaid'
          ? <Fragment key={`code-${i}`}><MermaidDiagram source={source} /></Fragment>
          : <pre key={`code-${i}`} className="my-2 overflow-x-auto rounded-md bg-black/30 p-2 text-xs"><code>{source}</code></pre>);
        code = null;
        codeLanguage = '';
      } else {
        code = [];
        codeLanguage = line.trim().slice(3).trim().toLowerCase();
      }
      return;
    }
    if (code) {
      code.push(line);
      return;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      blocks.push(<img key={i} src={withBasePath(image[2])} alt={image[1] || 'evidence'} className="my-2 max-h-80 w-full rounded-md border border-[var(--border)] object-contain" />);
      return;
    }

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      blocks.push(<div key={i} className="mt-2 font-semibold">{inlineParts(h[2])}</div>);
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push(<div key={i} className="ml-3 flex gap-2"><span>•</span><span>{inlineParts(bullet[1])}</span></div>);
      return;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push(<div key={i} className="ml-3">{inlineParts(line.trim())}</div>);
      return;
    }

    blocks.push(line.trim()
      ? <p key={i} className="my-1">{inlineParts(line)}</p>
      : <div key={i} className="h-2" />);
  });

  flushTable(lines.length);
  if (code) {
    const source = code.join('\n');
    blocks.push(codeLanguage === 'mermaid'
      ? <Fragment key="code-tail"><MermaidDiagram source={source} /></Fragment>
      : <pre key="code-tail" className="my-2 overflow-x-auto rounded-md bg-black/30 p-2 text-xs"><code>{source}</code></pre>);
  }

  return <div className="space-y-0.5 break-words">{blocks}</div>;
}
