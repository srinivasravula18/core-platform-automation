import type { ProviderImage } from '../ai/providers/types';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function parseAIImageAttachments(attachments: unknown): { images?: ProviderImage[]; error?: string } {
  if (attachments == null) return {};
  if (!Array.isArray(attachments)) return { error: 'Attachments must be an array.' };
  if (attachments.length > MAX_IMAGES) return { error: `A maximum of ${MAX_IMAGES} images is allowed per rework.` };
  const images: ProviderImage[] = [];
  for (const attachment of attachments) {
    const name = String(attachment?.name || 'image');
    const mimeType = String(attachment?.mimeType || '').toLowerCase();
    const dataBase64 = String(attachment?.dataBase64 || '');
    if (!IMAGE_TYPES.has(mimeType)) return { error: `Attachment "${name}": unsupported image type.` };
    if (!dataBase64) return { error: `Attachment "${name}": image data is empty.` };
    if ((dataBase64.length * 3) / 4 > MAX_IMAGE_BYTES) return { error: `Attachment "${name}": exceeds the 5MB size limit.` };
    images.push({ mimeType, dataBase64 });
  }
  return { images: images.length ? images : undefined };
}
