// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageListRow from '../../../src/components/MessageListRow.vue';

describe('Message selection checkbox names', () => {
  it.each([
    { subject: 'Project update', showsRecipients: false, correspondent: 'Sender' },
    { subject: '', showsRecipients: false, correspondent: 'Sender' },
    { subject: null, showsRecipients: true, correspondent: 'Recipient' },
  ])('identifies the subject and correspondent for $subject / recipients=$showsRecipients', ({
    subject, showsRecipients, correspondent,
  }) => {
    const wrapper = mount(MessageListRow, {
      props: {
        message: {
          id: 1, subject,
          from_text: 'Sender <sender@example.com>',
          to_text: 'Recipient <recipient@example.com>',
        },
        showsRecipients,
        index: 0, start: 0, size: 64,
      },
    });
    expect(wrapper.get('input[type="checkbox"]').attributes('aria-label'))
      .toBe(`Select message: ${subject || '(no subject)'}, ${correspondent}`);
    wrapper.unmount();
  });
});
