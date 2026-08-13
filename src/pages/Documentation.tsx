import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { MarkdownText } from '@/src/components/MarkdownText';
import guideMarkdown from '../../docs/application-guide.md?raw';

const slug = (value: string) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const parsedGuide = (() => {
  const title = guideMarkdown.match(/^#\s+(.+)$/m)?.[1] || 'Documentation';
  const firstSection = guideMarkdown.search(/^##\s+/m);
  const intro = guideMarkdown.slice(guideMarkdown.indexOf('\n') + 1, firstSection < 0 ? undefined : firstSection).trim();
  const sectionSource = firstSection < 0 ? '' : guideMarkdown.slice(firstSection);
  const sections = sectionSource
    .split(/^##\s+/m)
    .filter(Boolean)
    .map((block) => {
      const [heading, ...body] = block.split('\n');
      return { id: slug(heading), title: heading.trim(), body: body.join('\n').trim() };
    });
  return { title, intro, sections };
})();

/**
 * Highlight the section you are actually reading. IntersectionObserver rather than scroll maths: the
 * diagrams render asynchronously and move every heading below them, which desynchronises any approach
 * that caches positions.
 */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState('');
  useEffect(() => {
    if (!ids.length) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id);
        }
        // Topmost visible section wins, so a long section stays selected while it scrolls past.
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      // Band across the upper page: a section counts as "being read" once its top reaches it.
      { rootMargin: '-80px 0px -55% 0px', threshold: 0 },
    );
    for (const id of ids) { const el = document.getElementById(id); if (el) observer.observe(el); }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

export default function Documentation() {
  const active = useActiveSection(parsedGuide.sections.map((s) => s.id));
  return (
    <div className="app-page-shell">
      <header className="mb-8 border-b border-[var(--border)] pb-6">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
          <BookOpen className="h-4 w-4" />
          Product Documentation
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{parsedGuide.title}</h1>
        <div className="mt-2 max-w-4xl text-sm leading-6 text-[var(--text-muted)]">
          <MarkdownText value={parsedGuide.intro} />
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label="Documentation sections" className="sticky top-0 max-h-[calc(100dvh-8rem)] space-y-1 overflow-y-auto pr-2">
            <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">On This Page</div>
            {parsedGuide.sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={active === section.id ? 'true' : undefined}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active === section.id
                    ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)] shadow-[inset_2px_0_0_var(--accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {section.title}
              </a>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 space-y-10 text-sm leading-7">
          {parsedGuide.sections.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-6 border-b border-[var(--border)] pb-10 last:border-0">
              <h2 className="mb-4 text-xl font-semibold tracking-tight text-[var(--text-primary)]">{section.title}</h2>
              <div className="text-[var(--text-muted)] [&_strong]:text-[var(--text-primary)] [&_table]:bg-[var(--bg-card)]">
                <MarkdownText value={section.body} />
              </div>
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
