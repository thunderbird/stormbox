import { describe, expect, it } from 'vitest';
import { validateCatalogs, validateReferences, validateSourceText } from '../../../scripts/check-locales.mjs';

describe('translation catalogs', () => {
  it('compile, preserve parameters, and contain no HTML', () => {
    expect(validateCatalogs().messages).toBeGreaterThan(1000);
    validateReferences();
  });
  it('rejects missing message keys and interpolation parameters', () => {
    const messages = { 'example.named': 'Hello {name}', 'example.plural': '{count} item | {count} items' };
    expect(() => validateSourceText("t('example.missing')", messages)).toThrow('unknown message');
    expect(() => validateSourceText("t('example.named')", messages)).toThrow('missing parameter name');
    expect(() => validateSourceText("t('example.named', { name: value })", messages)).not.toThrow();
    expect(() => validateSourceText("t('example.plural', {}, count)", messages)).not.toThrow();
  });
});
