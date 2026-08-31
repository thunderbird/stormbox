import type { ContactPhoto } from '../types/db';

export const CONTACT_PHOTO_MAX_BYTES = 1024 * 1024;

export const CONTACT_PHOTO_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

type ContactPhotoMediaType = typeof CONTACT_PHOTO_ACCEPT[number];

const DATA_URI_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function decodedBase64Size(value: string): number {
  const padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0);
  return Math.floor((value.length * 3) / 4) - padding;
}

function bytesFromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isRasterSignature(bytes: Uint8Array, mediaType: ContactPhotoMediaType): boolean {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 8
        && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
          .every((byte, index) => bytes[index] === byte);
    case 'image/jpeg':
      return bytes.length >= 3
        && bytes[0] === 0xff
        && bytes[1] === 0xd8
        && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 6
        && (
          String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a'
          || String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a'
        );
    case 'image/webp':
      return bytes.length >= 12
        && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    default: {
      const exhaustive: never = mediaType;
      return exhaustive;
    }
  }
}

export function validatedContactPhotoDataUri(
  value: unknown,
  maxBytes = CONTACT_PHOTO_MAX_BYTES,
): { mediaType: ContactPhotoMediaType; uri: string } | null {
  if (typeof value !== 'string') return null;
  const match = DATA_URI_RE.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  const mediaType = match[1] as ContactPhotoMediaType;
  const size = decodedBase64Size(match[2]);
  if (size <= 0 || size > maxBytes) return null;
  const bytes = bytesFromBase64(match[2]);
  if (!bytes || bytes.byteLength !== size || !isRasterSignature(bytes, mediaType)) {
    return null;
  }
  return { mediaType, uri: value };
}

export function renderableContactPhotoUri(
  photo: ContactPhoto | null | undefined,
): string {
  const valid = validatedContactPhotoDataUri(photo?.uri);
  return valid && photo?.mediaType === valid.mediaType ? valid.uri : '';
}

export function copyableContactPhoto(
  photo: ContactPhoto | null | undefined,
): ContactPhoto | null {
  const uri = renderableContactPhotoUri(photo);
  if (!photo || !uri || photo.blobId != null) return null;
  return { ...photo, uri };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function readContactPhotoFile(file: File): Promise<{
  mediaType: ContactPhotoMediaType;
  uri: string;
}> {
  if (!CONTACT_PHOTO_ACCEPT.includes(file.type as ContactPhotoMediaType)) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
  }
  if (file.size <= 0 || file.size > CONTACT_PHOTO_MAX_BYTES) {
    throw new Error('Choose an image no larger than 1 MiB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = file.type as ContactPhotoMediaType;
  if (!isRasterSignature(bytes, mediaType)) {
    throw new Error('The selected file is not a valid raster image.');
  }
  return {
    mediaType,
    uri: `data:${mediaType};base64,${base64FromBytes(bytes)}`,
  };
}
