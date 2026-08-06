import { Paperclip, X } from 'lucide-react';

export type AIImageAttachment = { name: string; mimeType: string; dataBase64: string };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function appendAIImageAttachments(current: AIImageAttachment[], files: FileList | null) {
  const errors: string[] = [];
  const next = [...current];
  for (const file of Array.from(files || [])) {
    if (next.length >= MAX_IMAGES) { errors.push(`Max ${MAX_IMAGES} images per rework.`); break; }
    if (!IMAGE_TYPES.includes(file.type)) { errors.push(`${file.name}: only PNG, JPEG, WebP or GIF images are allowed.`); continue; }
    if (file.size > MAX_IMAGE_BYTES) { errors.push(`${file.name}: exceeds the 5MB limit.`); continue; }
    try { next.push({ name: file.name, mimeType: file.type, dataBase64: await readImage(file) }); }
    catch (error: any) { errors.push(error?.message || `Could not read ${file.name}`); }
  }
  return { next, error: errors.join(' ') };
}

export function AIImageAttachmentPicker({ attachments, error, disabled, onAdd, onRemove }: {
  attachments: AIImageAttachment[];
  error?: string;
  disabled?: boolean;
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <label className={`inline-flex min-h-8 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 text-[11px] font-medium text-[var(--text-muted)] ${disabled ? 'opacity-50' : 'cursor-pointer hover:border-[var(--accent)] hover:text-[var(--text-primary)]'}`}>
          <Paperclip className="h-3 w-3" /> Attach screenshot
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={disabled} className="sr-only" onChange={(event) => { onAdd(event.target.files); event.target.value = ''; }} />
        </label>
        {attachments.map((attachment, index) => (
          <span key={`${attachment.name}-${index}`} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[11px] text-[var(--text-muted)]">
            {attachment.name}
            <button type="button" onClick={() => onRemove(index)} disabled={disabled} aria-label={`Remove ${attachment.name}`} className="rounded p-1 hover:text-red-400 disabled:opacity-50">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
    </>
  );
}
