import { readFileSync } from 'node:fs';

import {
  describe, expect, it,
} from 'vitest';

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('single-column responsive CSS contracts', () => {
  it('keeps MessageView desktop gutters while narrowing all message insets to 5px below 640px', () => {
    const source = readSource('../../../src/components/MessageView.vue');

    expect(source).toMatch(/--message-content-inset:\s*20px;/);
    expect(source).toMatch(/--message-content-trailing-inset:\s*16px;/);
    expect(source).toMatch(/--message-html-edge-inset:\s*8px;/);
    expect(source).toMatch(/--message-toolbar-edge-inset:\s*12px;/);

    expect(source).toMatch(
      /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]*?\.message-view__article\s*\{[\s\S]*?--message-content-inset:\s*5px;[\s\S]*?--message-content-trailing-inset:\s*5px;[\s\S]*?--message-html-edge-inset:\s*5px;[\s\S]*?--message-toolbar-edge-inset:\s*5px;/,
    );
  });

  it('keeps message row checkboxes visible in single-column layout', () => {
    const source = readSource('../../../src/components/MessageList.vue');

    expect(source).toMatch(
      /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]*?\.msg-list__check\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?\.msg-list__unread-dot\s*\{[\s\S]*?opacity:\s*0;/,
    );
  });
});
