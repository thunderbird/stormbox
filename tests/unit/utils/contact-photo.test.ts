// @vitest-environment happy-dom

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  CONTACT_PHOTO_MAX_BYTES,
  copyableContactPhoto,
  readContactPhotoFile,
  renderableContactPhotoUri,
  validatedContactPhotoDataUri,
} from '../../../src/utils/contact-photo';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_URI = `data:image/png;base64,${PNG_BASE64}`;

describe('contact photos', () => {
  it('accepts a bounded raster data URI for rendering', () => {
    expect(validatedContactPhotoDataUri(PNG_URI)).toEqual({
      mediaType: 'image/png',
      uri: PNG_URI,
    });
    expect(renderableContactPhotoUri({
      mapKey: 'photo',
      uri: PNG_URI,
      blobId: null,
      mediaType: 'image/png',
      pref: 1,
    })).toBe(PNG_URI);
  });

  it('copies only self-contained validated photos', () => {
    const photo = {
      mapKey: 'photo',
      uri: PNG_URI,
      blobId: null,
      mediaType: 'image/png',
      pref: null,
    };
    expect(copyableContactPhoto(photo)).toEqual(photo);
    expect(copyableContactPhoto({ ...photo, blobId: 'blob-1' })).toBeNull();
    expect(copyableContactPhoto({
      ...photo,
      uri: 'https://example.com/photo.png',
    })).toBeNull();
  });

  it.each([
    'https://example.com/photo.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,PHN2Zy8+',
    'data:image/png;base64,%%%%',
  ])('rejects an unsafe or malformed source %s', (uri) => {
    expect(validatedContactPhotoDataUri(uri)).toBeNull();
  });

  it('validates file bytes and preserves the original raster payload', async () => {
    const bytes = Uint8Array.from(atob(PNG_BASE64), (value) => value.charCodeAt(0));
    const result = await readContactPhotoFile(
      new File([bytes], 'avatar.png', { type: 'image/png' }),
    );
    expect(result).toEqual({ mediaType: 'image/png', uri: PNG_URI });
  });

  it('rejects a file above the contact photo limit before reading it', async () => {
    const file = new File(
      [new Uint8Array(CONTACT_PHOTO_MAX_BYTES + 1)],
      'large.png',
      { type: 'image/png' },
    );
    await expect(readContactPhotoFile(file))
      .rejects.toThrow('Choose an image no larger than 1 MiB.');
  });
});
