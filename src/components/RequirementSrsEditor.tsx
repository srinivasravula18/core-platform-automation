import type { RequirementSrsModule } from '@/src/lib/requirementSrs';

const inputClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

export function RequirementSrsEditor({
  modules,
  onChange,
}: {
  modules: RequirementSrsModule[];
  onChange: (modules: RequirementSrsModule[]) => void;
}) {
  const updateModule = (moduleIndex: number, updates: Partial<RequirementSrsModule>) =>
    onChange(modules.map((module, index) => index === moduleIndex ? { ...module, ...updates } : module));

  const updateRequirement = (
    moduleIndex: number,
    requirementIndex: number,
    updates: Partial<RequirementSrsModule['requirements'][number]>,
  ) => updateModule(moduleIndex, {
    requirements: modules[moduleIndex].requirements.map((requirement, index) =>
      index === requirementIndex ? { ...requirement, ...updates } : requirement),
  });

  return (
    <div className="space-y-3">
      {modules.map((module, moduleIndex) => (
        <section key={moduleIndex} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Module {moduleIndex + 1}
          </label>
          <input
            aria-label={`Module ${moduleIndex + 1} title`}
            value={module.title}
            onChange={(event) => updateModule(moduleIndex, { title: event.target.value })}
            className={`${inputClass} font-semibold`}
          />

          <div className="mt-3 space-y-3">
            {module.requirements.map((requirement, requirementIndex) => (
              <div key={requirementIndex} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Requirement {moduleIndex + 1}.{requirementIndex + 1}
                </div>
                <div className="space-y-2">
                  <input
                    aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} title`}
                    value={requirement.title}
                    onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { title: event.target.value })}
                    className={`${inputClass} font-semibold`}
                    placeholder="Requirement title"
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} category`}
                      value={requirement.category || ''}
                      onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { category: event.target.value })}
                      className={inputClass}
                      placeholder="Category"
                    />
                    <select
                      aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} priority`}
                      value={requirement.priority || ''}
                      onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { priority: event.target.value })}
                      className={inputClass}
                    >
                      <option value="">No Priority</option>
                      {['Must', 'Should', 'Could', "Won't"].map((priority) => <option key={priority}>{priority}</option>)}
                    </select>
                  </div>
                  <textarea
                    aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} statement`}
                    value={requirement.statement}
                    onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { statement: event.target.value })}
                    className={`${inputClass} min-h-20 resize-y`}
                    placeholder="The system shall..."
                  />

                  {(requirement.acceptanceCriteria || []).map((criterion, criterionIndex) => (
                    <div key={criterionIndex} className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                      {(['given', 'when', 'then'] as const).map((part) => (
                        <input
                          key={part}
                          aria-label={`Acceptance criterion ${criterionIndex + 1} ${part}`}
                          value={criterion[part] || ''}
                          onChange={(event) => {
                            const acceptanceCriteria = (requirement.acceptanceCriteria || []).map((item, index) =>
                              index === criterionIndex ? { ...item, [part]: event.target.value } : item);
                            updateRequirement(moduleIndex, requirementIndex, { acceptanceCriteria });
                          }}
                          className={inputClass}
                          placeholder={`${part[0].toUpperCase()}${part.slice(1)}`}
                        />
                      ))}
                    </div>
                  ))}

                  <textarea
                    aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} details`}
                    value={(requirement.details || []).join('\n')}
                    onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { details: event.target.value.split('\n') })}
                    className={`${inputClass} min-h-16 resize-y`}
                    placeholder="Details (one per line)"
                  />
                  <textarea
                    aria-label={`Requirement ${moduleIndex + 1}.${requirementIndex + 1} sources`}
                    value={(requirement.sources || []).join('\n')}
                    onChange={(event) => updateRequirement(moduleIndex, requirementIndex, { sources: event.target.value.split('\n') })}
                    className={`${inputClass} min-h-16 resize-y font-mono`}
                    placeholder="Sources (one per line)"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
