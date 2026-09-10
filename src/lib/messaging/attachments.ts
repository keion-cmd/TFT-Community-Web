// Shared client+server constants for message attachment upload — mirrored
// by the storage bucket's file_size_limit/allowed_mime_types in
// supabase/migrations/0012_message_attachments_storage.sql. Kept in one
// place so the pre-upload check (requestAttachmentUpload), the post-upload
// re-check (sendMessage), and the picker's client-side check can't drift.

export const ATTACHMENT_BUCKET = "message-attachments";
export const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export const ALLOWED_FILE_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
] as const;

export const ALLOWED_ATTACHMENT_MIME_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_FILE_MIME_TYPES,
];

// Extensions accepted per mime type — checked in addition to the mime type
// itself, since a mime type alone is just a client-supplied label (or, for
// files uploaded via the browser file input, sniffed loosely) and mismatched
// extension/mime pairs are a common way to smuggle an unexpected file type
// past a mime-only check.
const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/zip": ["zip"],
};

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export function isImageMimeType(mimeType: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

// Strips everything but a conservative character set so the extension-
// bearing file name segment we put in the storage object path can't be used
// for path traversal (`../`) or to inject extra path segments the
// can_access_attachment_path() policy would parse as conversation prefix.
export function sanitizeFileNameForPath(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "attachment";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  return cleaned.length > 0 ? cleaned : "attachment";
}

export type AttachmentMeta = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type AttachmentValidationResult = { ok: true } | { ok: false; message: string };

export function validateAttachmentMeta({ fileName, mimeType, sizeBytes }: AttachmentMeta): AttachmentValidationResult {
  if (!fileName || fileName.trim().length === 0) {
    return { ok: false, message: "File name is required." };
  }
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(mimeType)) {
    return { ok: false, message: "That file type is not supported." };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, message: "File is empty." };
  }
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return { ok: false, message: `Files must be ${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)}MB or smaller.` };
  }
  const ext = fileExtension(fileName);
  const allowedExts = MIME_TO_EXTENSIONS[mimeType];
  if (!allowedExts || !allowedExts.includes(ext)) {
    return { ok: false, message: "File extension does not match its type." };
  }
  return { ok: true };
}
