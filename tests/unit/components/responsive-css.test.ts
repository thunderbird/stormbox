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
    const source = readSource('../../../src/components/MessageListRow.vue');

    expect(source).toMatch(
      /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]*?\.msg-list__check\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?\.msg-list__unread-dot\s*\{[\s\S]*?opacity:\s*0;/,
    );
  });

  it('keeps a column\'s title row controls in the corner at every width and swipes between columns below 640px', () => {
    const list = readSource('../../../src/components/MessageList.vue');
    const columns = readSource('../../../src/components/MessageColumns.vue');

    // The folder name shrinks and truncates; the +/× control never shrinks or wraps.
    expect(list).toMatch(/\.msg-list__titlebar\s*\{[\s\S]*?display:\s*flex;/);
    expect(list).toMatch(/\.msg-list__title,\s*\.msg-list__folder-picker\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;/);
    expect(list).toMatch(/\.msg-list__title-name\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
    expect(list).toMatch(/\.msg-list__column-control\s*\{[\s\S]*?flex:\s*0 0 auto;/);
    // Below 640px each column fills the area and the user swipes between them.
    expect(columns).toMatch(
      /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]*?scroll-snap-type:\s*x mandatory;[\s\S]*?flex:\s*0 0 100%;[\s\S]*?scroll-snap-align:\s*start;/,
    );
  });
});
