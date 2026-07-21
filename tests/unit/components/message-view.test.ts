// @vitest-environment happy-dom
/**
 * Component-level regression test for the "Select a message to read
 * it" bug. The store's `messages` array is positional and may carry
 * explicit `undefined` slots for sparse positions (queryChanges
 * trimmed a tail, indexer hasn't filled a gap, etc.). MessageView
 * looks up the selected row with `messages.find(...)`, and
 * Array.prototype.find walks `undefined` values — accessing `m.id`
 * on undefined throws and leaves the computed silently stuck at
 * `null`, which is what showed the empty-state placeholder under a
 * row the user had just clicked.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

// services/auth.js calls oidcEarlyInit({ BASE_URL: '/' }) at module
// load and throws against happy-dom's stricter URL handling. Stub
// it before importing anything that transitively imports it
// (mail-store -> auth-store -> services/auth.js).
vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

import MessageView from '../../../src/components/MessageView.vue';
import { useMailStore } from '../../../src/stores/mail-store';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';

function makeRepo() {
  return {
    subscribe() { return () => {}; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async insertPendingMutation() { return undefined; },
    async replaceMessageKeywords() { return undefined; },
    async downloadBlob() { return null; },
    async filterExistingMessageIds(_accountId, ids) {
      return (ids ?? []).map(Number).filter((id) => Number.isFinite(id));
    },
    async getPendingMutationError() { return null; },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

// The app applies the theme as html.dark / html.light classes (services-ui's
// dark-mode convention), which MessageView reads to build the iframe srcdoc.
function setDocumentTheme(theme: 'dark' | 'light') {
  document.documentElement.classList.remove('dark', 'light');
  document.documentElement.classList.add(theme);
}

afterEach(() => {
  __resetRepositoryForTests();
  document.documentElement.classList.remove('dark', 'light');
  vi.unstubAllGlobals();
});

describe('MessageView with a sparse messages array', () => {
  it('still renders the selected message when surrounding positions are undefined', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();

    // Simulate the post-refreshLoadedPages cache shape that exposed
    // the bug: the selected message sits at position 1 between two
    // explicitly-undefined slots (positions whose query_view_items
    // entry had no corresponding messages row, mid-shrink). The
    // store's MessageList template guards undefined with `v-if`,
    // but MessageView used to walk these slots through
    // Array.prototype.find and throw on `m.id`.
    const selected = {
      id: 42,
      subject: 'hello',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    };
    mailStore.messages = [undefined, selected, undefined] as any;
    mailStore.selectedMessageId = 42;

    const wrapper = mount(MessageView);
    await nextTick();

    // The empty placeholder must NOT be the rendered output.
    // The presence of the article element (and the subject) is
    // what the user expects to see after a click.
    expect(wrapper.text()).not.toContain('Select a message to read it.');
    expect(wrapper.find('h2').text()).toBe('hello');
  });

  it('shows the empty placeholder only when no message is selected', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();

    mailStore.messages = [];
    mailStore.selectedMessageId = null;

    const wrapper = mount(MessageView);
    await nextTick();

    expect(wrapper.text()).toContain('Select a message to read it.');
    expect(wrapper.find('h2').exists()).toBe(false);
  });

  it('renders the single-message toolbar as icon-only actions in shortcut order', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Toolbar order',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;

    const wrapper = mount(MessageView);
    await nextTick();

    const actions = wrapper.findAll('.message-view__header .message-view__action');

    // R-3.10: icon-only buttons whose action text lives in title and
    // aria-label. We pin the action *identity* and ordering through
    // those a11y attributes — not through SVG width / stroke-width
    // which are presentational knobs.
    expect(actions.map((button) => button.attributes('title'))).toEqual([
      'Back',
      'Archive (A)',
      'Junk',
      'Delete (Del)',
      'Reply (Ctrl+R)',
      'Reply All (Ctrl+Shift+R)',
      'Forward (Ctrl+L)',
    ]);
    expect(
      actions.map((button) => button.attributes('aria-label')),
    ).toEqual(['Back', 'Archive', 'Mark as junk', 'Delete', 'Reply', 'Reply All', 'Forward']);
    expect(actions.every((button) => button.text() === '')).toBe(true);
    // Every action must render exactly one inline icon (Lucide svg or
    // tb-themed svg). We do not pin its dimensions.
    expect(
      actions.every((button) => button.find('.message-view__toolbar-icon').exists()),
    ).toBe(true);
  });

  it('shows neither Junk nor Not junk in a shared Junk folder', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();
    mailStore.folders = [{
      id: 2,
      account_id: 2,
      remote_id: 'shared-junk',
      name: 'Shared Junk',
      role: 'junk',
      is_deleted: 0,
    }];
    mailStore.currentFolderId = 2;
    mailStore.messages = [{
      id: 42,
      subject: 'Shared junk',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;

    const wrapper = mount(MessageView);
    await nextTick();
    const titles = wrapper
      .findAll('.message-view__header .message-view__action')
      .map((button) => button.attributes('title'));
    expect(titles).not.toContain('Junk');
    expect(titles).not.toContain('Whitelist sender and move to Inbox');
  });

  it('closes the message view from the back toolbar action', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Go back',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;
    mailStore.messageBody = { text: 'body text', html: '', attachments: [] };

    const wrapper = mount(MessageView);
    await nextTick();

    await wrapper.find('.message-view__header [aria-label="Back"]').trigger('click');

    expect(mailStore.selectedMessageId).toBeNull();
    expect(mailStore.messageBody).toBeNull();
  });

  it('marks the open message as junk from the toolbar', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Spammy offer',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;
    mailStore.messageBody = { text: 'body text', html: '', attachments: [] };
    const junkSpy = vi.spyOn(mailStore, 'junkMessages')
      .mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });

    const wrapper = mount(MessageView);
    await nextTick();

    await wrapper.find('.message-view__header [aria-label="Mark as junk"]').trigger('click');

    expect(junkSpy).toHaveBeenCalledWith([42]);
  });

  it('replies to the selected message from the toolbar', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Reply me',
      from_text: 'sender@example.com',
      to_text: 'me@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;
    mailStore.messageBody = { text: 'body text', html: '', attachments: [] };
    const replySpy = vi.spyOn(composeStore, 'prepareReplyFromMessage');

    const wrapper = mount(MessageView);
    await nextTick();

    await wrapper.find('.message-view__header [aria-label="Reply"]').trigger('click');

    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      expect.objectContaining({ text: 'body text' }),
    );
  });

  it('replies-all to the selected message from the toolbar', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Reply all me',
      from_text: 'sender@example.com',
      to_text: 'me@example.com, other@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;
    mailStore.messageBody = { text: 'body text', html: '', attachments: [] };
    const replyAllSpy = vi.spyOn(composeStore, 'prepareReplyAll');

    const wrapper = mount(MessageView);
    await nextTick();

    await wrapper.find('.message-view__header [aria-label="Reply All"]').trigger('click');

    expect(replyAllSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      expect.objectContaining({ text: 'body text' }),
    );
  });

  it('forwards the selected message from the toolbar', async () => {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    await mailStore.attach();

    mailStore.messages = [{
      id: 42,
      subject: 'Forward me',
      from_text: 'sender@example.com',
      received_at: 1_700_000_000_000,
    }];
    mailStore.selectedMessageId = 42;
    mailStore.messageBody = { text: 'body text', html: '', attachments: [] };
    const forwardSpy = vi.spyOn(composeStore, 'prepareForward');

    const wrapper = mount(MessageView);
    await nextTick();

    await wrapper.find('.message-view__header [aria-label="Forward"]').trigger('click');

    expect(forwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      expect.objectContaining({ text: 'body text' }),
    );
  });

});

describe('MessageView HTML body rendering', () => {
  function makeSelectedMessage(messageBody) {
    const authStore = useAuthStore();
    authStore.accountId = 1;
    __setRepositoryForTests(makeRepo());

    const mailStore = useMailStore() as any;
    return mailStore.attach().then(() => {
      const selected = {
        id: 7,
        subject: 'Wide marketing email',
        from_text: 'newsletter@example.com',
        received_at: 1_700_000_000_000,
      };
      mailStore.messages = [selected];
      mailStore.selectedMessageId = 7;
      mailStore.messageBody = messageBody;
      return mailStore;
    });
  }

  it('renders HTML bodies inside a sandboxed iframe via srcdoc, not inline', async () => {
    // Marketing emails ship inline <style> blocks plus <script> stubs.
    // Inline rendering would (a) leak the email's CSS into the host UI
    // — which used to make every email render at one fixed width
    // because the last email's <style> always won the cascade — and
    // (b) require us to fully trust DOMPurify never to miss a
    // <script>. The iframe + srcdoc + sandbox path makes that
    // structurally impossible.
    await makeSelectedMessage({
      text: '',
      html: '<style>body { background: red; }</style><p>hello</p><script>alert(1)</script>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const iframe = wrapper.find('iframe.message-view__html-frame');
    expect(iframe.exists()).toBe(true);

    // The iframe is sandboxed without allow-scripts so any <script>
    // that survived sanitisation is inert at runtime.
    const sandbox = iframe.attributes('sandbox') ?? '';
    expect(sandbox).toMatch(/allow-same-origin/);
    expect(sandbox).not.toMatch(/allow-scripts/);

    // The whole document is delivered via srcdoc — the DOMPurified body
    // is wrapped in <html><head><style>...</style></head><body>...</body>.
    const srcdoc = iframe.attributes('srcdoc') ?? '';
    expect(srcdoc).toMatch(/^<!DOCTYPE html>/);
    expect(srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain('hello');

    // No inline message-view__html div is rendered (we replaced the
    // inline-HTML path with the iframe). The iframe is what gives us
    // the style isolation that fixed the original "every email is
    // locked to the same width" bug.
    expect(wrapper.find('.message-view__html').exists()).toBe(false);

    wrapper.unmount();
  });

  it('uses the visible body pane as the initial iframe height instead of 120px', async () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('message-view__body') ? 640 : 0;
      },
    });

    try {
      await makeSelectedMessage({
        text: '',
        html: '<p>email body</p>',
        attachments: [],
      });

      const wrapper = mount(MessageView, {
        attachTo: document.body,
      });
      await nextTick();
      await nextTick();

      const iframe = wrapper.find('iframe.message-view__html-frame');
      expect(iframe.attributes('style')).toContain('height: 640px');

      wrapper.unmount();
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      } else {
        delete (HTMLElement.prototype as any).clientHeight;
      }
    }
  });

  it('passes dark-mode defaults into simple HTML iframe bodies', async () => {
    setDocumentTheme('dark');
    await makeSelectedMessage({
      text: '',
      html: '<p>test</p>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const iframe = wrapper.find('iframe.message-view__html-frame');
    expect(iframe.exists()).toBe(true);
    const srcdoc = iframe.attributes('srcdoc') ?? '';

    expect(srcdoc).toContain('color-scheme: dark');
    expect(srcdoc).toContain('background: transparent;');
    expect(srcdoc).toContain('color: #e6e8ef;');
    expect(srcdoc).toContain('<p>test</p>');
    expect(iframe.attributes('style')).toContain('background-color: #11131a');

    // This is intentionally not a full color-inversion engine.
    expect(srcdoc).not.toMatch(/\bfilter:\s*invert/);
    expect(srcdoc).not.toMatch(/body\s*\*\s*\{/);

    wrapper.unmount();
  });

  it('adapts a styled email body for dark mode before building the iframe srcdoc', async () => {
    // In the dark theme the email's hard-coded white background and black
    // text must be stripped (per dark-email.ts) so the body falls back to
    // the dark canvas, rather than punching a white slab into the dark UI.
    setDocumentTheme('dark');
    await makeSelectedMessage({
      text: '',
      html: '<div style="background:#ffffff;color:#000000">styled body</div>',
      attachments: [],
    });

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    const srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    expect(srcdoc).toContain('styled body');
    expect(srcdoc).not.toMatch(/#ffffff/i);
    expect(srcdoc).not.toMatch(/#000000/i);

    wrapper.unmount();
  });

  it('does not adapt email colours in the light theme', async () => {
    setDocumentTheme('light');
    await makeSelectedMessage({
      text: '',
      html: '<div style="background:#ffffff;color:#000000">styled body</div>',
      attachments: [],
    });

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    const srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    expect(srcdoc).toMatch(/#ffffff/i);
    expect(srcdoc).toMatch(/#000000/i);

    wrapper.unmount();
  });

  it('preserves complete-email head styles and body presentation in the light theme', async () => {
    setDocumentTheme('light');
    await makeSelectedMessage({
      text: '',
      html: '<html class="email-root"><head>'
        + '<style>.content{background:#ddeeff}.footer{background:#eef1f6}</style>'
        + '</head><body class="email-body" bgcolor="#fafafa">'
        + '<div class="content">body</div><div class="footer">footer</div>'
        + '</body></html>',
      attachments: [],
    });

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    const srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
    expect(doc.querySelector('head > style:last-of-type')?.textContent)
      .toContain('.footer{background:#eef1f6}');
    expect(doc.documentElement.classList.contains('email-root')).toBe(true);
    expect(doc.body.classList.contains('email-body')).toBe(true);
    expect(doc.body.getAttribute('bgcolor')).toBe('#fafafa');
    expect(doc.querySelector('.content')?.textContent).toBe('body');
    expect(doc.querySelector('.footer')?.textContent).toBe('footer');

    wrapper.unmount();
  });

  it('offers a per-message light escape hatch in dark mode that bypasses the adapter', async () => {
    setDocumentTheme('dark');
    await makeSelectedMessage({
      text: '',
      html: '<div style="background:#ffffff;color:#000000">styled body</div>',
      attachments: [],
    });

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    const toggle = wrapper.find('.message-view__action--view-mode');
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes('aria-pressed')).toBe('false');

    // Default dark view: the adapter has stripped the hard-coded colours.
    let srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    expect(srcdoc).toContain('color-scheme: dark');
    expect(srcdoc).not.toMatch(/#ffffff/i);

    // Escape this one message to light: the original colours come back.
    await toggle.trigger('click');
    await nextTick();
    await nextTick();

    expect(wrapper.find('.message-view__action--view-mode').attributes('aria-pressed')).toBe('true');
    srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    expect(srcdoc).toContain('color-scheme: light');
    expect(srcdoc).toMatch(/#ffffff/i);
    expect(srcdoc).toMatch(/#000000/i);

    wrapper.unmount();
  });

  it('resets the light escape hatch when a different message is opened', async () => {
    setDocumentTheme('dark');
    const mailStore = await makeSelectedMessage({
      text: '',
      html: '<div style="background:#ffffff;color:#000000">first</div>',
      attachments: [],
    });
    mailStore.messages = [
      { id: 7, subject: 'a', from_text: 'a@example.com', received_at: 1 },
      { id: 8, subject: 'b', from_text: 'b@example.com', received_at: 2 },
    ];

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    await wrapper.find('.message-view__action--view-mode').trigger('click');
    await nextTick();
    expect(wrapper.find('.message-view__action--view-mode').attributes('aria-pressed')).toBe('true');

    // Switch to another message: the override must clear.
    mailStore.selectedMessageId = 8;
    mailStore.messageBody = {
      text: '', html: '<div style="background:#ffffff;color:#000000">second</div>', attachments: [],
    };
    await nextTick();
    await nextTick();

    expect(wrapper.find('.message-view__action--view-mode').attributes('aria-pressed')).toBe('false');
    const srcdoc = wrapper.find('iframe.message-view__html-frame').attributes('srcdoc') ?? '';
    expect(srcdoc).toContain('color-scheme: dark');
    expect(srcdoc).not.toMatch(/#ffffff/i);

    wrapper.unmount();
  });

  it('hides the light escape hatch for plain-text bodies and in the light theme', async () => {
    setDocumentTheme('dark');
    await makeSelectedMessage({ text: 'just text', html: '', attachments: [] });
    const textWrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();
    expect(textWrapper.find('.message-view__action--view-mode').exists()).toBe(false);
    textWrapper.unmount();

    setDocumentTheme('light');
    await makeSelectedMessage({
      text: '', html: '<div style="color:#000000">styled</div>', attachments: [],
    });
    const lightWrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();
    expect(lightWrapper.find('.message-view__action--view-mode').exists()).toBe(false);
    lightWrapper.unmount();
  });

  it('preserves the email markup while keeping host layout control outside the iframe', async () => {
    // Regression: an earlier iteration of the iframe builder injected
    // `body * { max-width: 100% !important }` and friends, on the
    // theory that it would tame wide marketing emails. In practice
    // it shredded the design (PLEDGEBOX/UltraPill rendered with a
    // giant logo on a dark band, content left-aligned, etc.). The
    // user's intended behaviour is the opposite: a 640-px email is
    // a 640-px email, the iframe just adds whitespace around it.
    await makeSelectedMessage({
      text: '',
      html: '<table width="640" align="center" style="width:640px;"><tr><td>wide</td></tr></table>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const iframe = wrapper.find('iframe.message-view__html-frame');
    expect(iframe.exists()).toBe(true);
    const body = wrapper.find('.message-view__body');
    expect(body.exists()).toBe(true);

    // The host may wrap/scale the iframe to fit narrow reading panes,
    // but the HTML email still renders only inside the sandboxed frame.
    const shell = body.find(':scope > .message-view__html-shell');
    expect(shell.exists()).toBe(true);
    const iframeInShell = shell.find(':scope > iframe.message-view__html-frame');
    expect(iframeInShell.exists()).toBe(true);
    expect(body.findAll('section, article').length).toBe(0);

    const srcdoc = iframe.attributes('srcdoc') ?? '';

    // The original email markup is delivered verbatim — width
    // attributes, alignment, inline styles all intact.
    expect(srcdoc).toContain('width="640"');
    expect(srcdoc).toContain('align="center"');
    expect(srcdoc).toContain('width:640px');

    // None of the override rules that broke real emails.
    expect(srcdoc).not.toMatch(/max-width:\s*100%\s*!important/);
    expect(srcdoc).not.toMatch(/width:\s*auto\s*!important/);
    expect(srcdoc).not.toMatch(/body\s*\*\s*\{/);

    wrapper.unmount();
  });

  it('falls back to the plain-text pre block when the body has no HTML', async () => {
    await makeSelectedMessage({
      text: 'plain text body\nwith a newline',
      html: '',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('iframe.message-view__html-frame').exists()).toBe(false);
    const pre = wrapper.find('.message-view__text');
    expect(pre.exists()).toBe(true);
    expect(pre.text()).toContain('plain text body');

    wrapper.unmount();
  });

  it('aligns plaintext body content with the message header labels', async () => {
    await makeSelectedMessage({
      text: 'plain text body',
      html: '',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const details = wrapper.find('.message-view__details');
    const pre = wrapper.find('.message-view__text');

    expect(window.getComputedStyle(pre.element).paddingLeft)
      .toBe(window.getComputedStyle(details.element).paddingLeft);

    wrapper.unmount();
  });

  it('renders HTML message content inside the host gutter shell', async () => {
    await makeSelectedMessage({
      text: 'plain alternative',
      html: 'simple html body',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const shell = wrapper.find('.message-view__html-shell');

    expect(shell.exists()).toBe(true);
    expect(shell.find(':scope > iframe.message-view__html-frame').exists()).toBe(true);

    wrapper.unmount();
  });

  it('zooms a wide iframe document down to the visible message width instead of clipping it', async () => {
    // Fit-to-width is applied via CSS `zoom` on the iframe's own
    // documentElement (the approach Gmail's mobile web viewer uses).
    // We deliberately avoid `transform: scale` on the host iframe
    // because that requires manually keeping iframe.width / iframe.height
    // in sync with the unscaled content, and ResizeObserver firing on
    // the resulting layout change was creating a feedback loop and
    // visible flicker at narrow widths.
    await makeSelectedMessage({
      text: '',
      html: '<table width="640" style="width:640px;"><tr><td>wide</td></tr></table>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const shell = wrapper.find('.message-view__html-shell').element as HTMLElement;
    Object.defineProperty(shell, 'clientWidth', {
      configurable: true,
      value: 320,
    });

    const iframe = wrapper.find('iframe.message-view__html-frame').element as HTMLIFrameElement;
    const doc = iframe.contentDocument;
    expect(doc).toBeTruthy();

    Object.defineProperty(doc!.documentElement, 'scrollWidth', {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(doc!.documentElement, 'scrollHeight', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(doc!.body, 'scrollWidth', {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(doc!.body, 'scrollHeight', {
      configurable: true,
      value: 800,
    });

    iframe.dispatchEvent(new Event('load'));
    await nextTick();

    expect(doc!.documentElement.style.zoom).toBe('0.5');
    const iframeStyle = iframe.getAttribute('style') ?? '';
    expect(iframeStyle).toContain('height: 400px');
    expect(iframeStyle).not.toContain('transform');
    expect(iframeStyle).not.toMatch(/\bwidth:\s*640px/);
    expect(shell.getAttribute('style') ?? '').not.toMatch(/\bheight:/);

    wrapper.unmount();
  });

  it('zooms reflowable content down when the shell is narrower than the minimum email layout width', async () => {
    // Reflowable text would otherwise report scrollWidth == viewport
    // at any shell size and never zoom. That looks fine for plain
    // paragraphs but produces a cramped layout for typical HTML email
    // bodies (image headers collapse, buttons wrap, etc.). Below the
    // MIN_EMAIL_LAYOUT_WIDTH threshold we therefore apply CSS zoom even
    // when the document's scrollWidth matches the viewport, so the
    // email still lays out at the threshold width and is scaled down.
    await makeSelectedMessage({
      text: '',
      html: '<p>Short reflowable email body.</p>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const shell = wrapper.find('.message-view__html-shell').element as HTMLElement;
    Object.defineProperty(shell, 'clientWidth', {
      configurable: true,
      value: 300,
    });

    const iframe = wrapper.find('iframe.message-view__html-frame').element as HTMLIFrameElement;
    const doc = iframe.contentDocument;
    expect(doc).toBeTruthy();

    // Reflowable content reports scrollWidth that just matches the
    // viewport — no real horizontal overflow.
    Object.defineProperty(doc!.documentElement, 'scrollWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc!.documentElement, 'scrollHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(doc!.body, 'scrollWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(doc!.body, 'scrollHeight', {
      configurable: true,
      value: 600,
    });

    iframe.dispatchEvent(new Event('load'));
    await nextTick();

    // Shell 300 < MIN_EMAIL_LAYOUT_WIDTH (400) → ratio = 300 / 400 = 0.75.
    expect(doc!.documentElement.style.zoom).toBe('0.75');
    expect(iframe.getAttribute('style') ?? '').toContain('height: 450px');

    wrapper.unmount();
  });

  it('places the body directly under a grid-laid article (so overflow-y: auto can actually scroll)', async () => {
    // Layout regression: previously, .message-view itself was the
    // grid (with `grid-template-rows: auto 1fr`) but its only direct
    // child was the <article>. The header + body lived ONE LEVEL
    // DOWN from the grid, so the auto/1fr template never applied to
    // them — the article got the 'auto' row and grew to its full
    // content height, the 1fr row stayed empty, and the body's
    // overflow-y: auto rule had nothing to overflow because the body
    // itself had unconstrained height. Tall marketing emails were
    // therefore unscrollable.
    //
    // The fix moves the grid down onto a .message-view__article
    // container so the header (auto) and body (1fr) split happens
    // where it should. We pin that structure here.
    await makeSelectedMessage({
      text: '',
      html: '<p>email body</p>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const article = wrapper.find('.message-view__article');
    expect(article.exists()).toBe(true);

    // The header and body must be direct children of the grid
    // container, otherwise the grid template doesn't apply to them.
    const headerEl = article.find(':scope > header.message-view__header');
    const bodyEl = article.find(':scope > .message-view__body');
    expect(headerEl.exists()).toBe(true);
    expect(bodyEl.exists()).toBe(true);

    // The article must be a direct grid item of .message-view (so it
    // takes the column's full height) — i.e. there is nothing
    // wedged between section.message-view and article that would
    // re-wrap the layout.
    const section = wrapper.find('.message-view');
    const directArticle = section.find(':scope > article.message-view__article');
    expect(directArticle.exists()).toBe(true);

    wrapper.unmount();
  });

  it('renders attachment metadata (name, type, size) for each attachment on the open message', async () => {
    // R-2.5 / R-6.1: the message detail must surface the attachment
    // list (name, MIME type, size) even though MVP attachment
    // *download* is Planned. The component receives attachments via
    // mailStore.messageBody.attachments; they render under
    // .message-view__attachments.
    await makeSelectedMessage({
      text: 'see attachments',
      html: '',
      attachments: [
        { part_id: 'p1', name: 'report.pdf', mime_type: 'application/pdf', size: 2048 },
        { part_id: 'p2', name: 'photo.png', mime_type: 'image/png', size: null },
      ],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const items = wrapper.findAll('.message-view__attachments li');
    expect(items).toHaveLength(2);

    const first = items[0].text();
    expect(first).toContain('report.pdf');
    expect(first).toContain('application/pdf');
    // 2048 bytes -> 2 KB (Math.ceil(2048/1024)).
    expect(first).toContain('2 KB');

    const second = items[1].text();
    expect(second).toContain('photo.png');
    expect(second).toContain('image/png');
    // No size segment when size is null.
    expect(second).not.toContain('KB');

    wrapper.unmount();
  });

  it('hides inline cid images from the attachment list when the HTML references them', async () => {
    await makeSelectedMessage({
      text: '',
      html: '<p>logo <img src="cid:%3Clogo%40example.com%3E"></p>',
      attachments: [
        {
          part_id: 'logo',
          blob_id: 'blob-logo',
          name: 'logo.png',
          mime_type: 'image/png',
          size: 1024,
          disposition: 'inline',
          cid: '<logo@example.com>',
        },
        {
          part_id: 'pdf',
          blob_id: 'blob-pdf',
          name: 'report.pdf',
          mime_type: 'application/pdf',
          size: 2048,
          disposition: 'attachment',
          cid: null,
        },
      ],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    const items = wrapper.findAll('.message-view__attachments li');
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain('report.pdf');
    expect(wrapper.text()).not.toContain('logo.png');

    wrapper.unmount();
  });

  it('clears the iframe srcdoc on unmount so a stale email cannot bleed into the next view', async () => {
    await makeSelectedMessage({
      text: '',
      html: '<p>private content</p>',
      attachments: [],
    });

    const wrapper = mount(MessageView, {
      attachTo: document.body,
    });
    await nextTick();

    expect(wrapper.find('iframe.message-view__html-frame').exists()).toBe(true);
    wrapper.unmount();

    // After unmount the iframe is gone from the DOM; the srcdoc ref
    // is also nulled out (see onUnmounted hook). The most useful
    // assertion at the test layer is that no detached iframe is
    // still attached to the document — happy-dom keeps the element
    // alive only if something else references it.
    expect(document.querySelector('iframe.message-view__html-frame')).toBeNull();
  });

  it('shows the loading placeholder only while the body has not loaded yet', async () => {
    // messageBody is null between selecting a message and the body
    // load resolving.
    await makeSelectedMessage(null);

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    expect(wrapper.find('.message-view__placeholder').exists()).toBe(true);
    expect(wrapper.text()).toContain('Loading message');

    wrapper.unmount();
  });

  it('renders an empty body instead of a perpetual loading state when a loaded message has no content', async () => {
    // A message with no body parts and no attachments loads as an empty
    // body object; the view must drop the loading placeholder and show
    // nothing rather than spinning forever.
    await makeSelectedMessage({ text: '', html: '', attachments: [] });

    const wrapper = mount(MessageView, { attachTo: document.body });
    await nextTick();

    expect(wrapper.find('.message-view__placeholder').exists()).toBe(false);
    expect(wrapper.find('iframe.message-view__html-frame').exists()).toBe(false);
    expect(wrapper.find('.message-view__text').exists()).toBe(false);
    // The article and its body container still render; the body is empty.
    expect(wrapper.find('.message-view__body').exists()).toBe(true);

    wrapper.unmount();
  });
});
