// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import ContactTrashDetailPane from '../../../src/components/contacts/ContactTrashDetailPane.vue';
import type { ContactTrashDetail } from '../../../src/types';

function trashDetail(): ContactTrashDetail {
  return {
    id: 1,
    uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    prior_remote_id: 'card-1',
    display_name: 'Browser QA Contact',
    primary_email: 'preferred@example.com',
    trashed_at: Date.parse('2026-08-30T00:00:00Z'),
    expires_at: Date.parse('2026-09-29T00:00:00Z'),
    status: 'trashed',
    original_addressbook_ids: ['book-1'],
    email_keys: ['preferred@example.com', 'other@example.com'],
    media: [],
    snapshot: {
      '@type': 'Card',
      id: 'card-1',
      uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      addressBookIds: { 'book-1': true },
      name: { full: 'Browser QA Contact' },
      emails: {
        preferred: {
          '@type': 'EmailAddress',
          address: 'preferred@example.com',
          contexts: { work: true },
          pref: 1,
        },
        other: {
          '@type': 'EmailAddress',
          address: 'other@example.com',
          contexts: { private: true },
        },
      },
      phones: {
        mobile: {
          '@type': 'Phone',
          number: '+1 555 0100',
          features: { mobile: true },
        },
      },
      links: {
        website: {
          '@type': 'Link',
          uri: 'https://example.com',
          contexts: { work: true },
        },
      },
      anniversaries: {
        birthday: {
          '@type': 'Anniversary',
          kind: 'birth',
          date: {
            '@type': 'PartialDate',
            year: 1990,
            month: 4,
            day: 5,
          },
        },
      },
      notes: {
        note: {
          '@type': 'Note',
          note: 'Read-only note',
        },
      },
      organizations: {
        organization: {
          '@type': 'Organization',
          name: 'QA Labs',
          units: [
            { '@type': 'OrgUnit', name: 'Reliability' },
          ],
        },
      },
      titles: {
        title: {
          '@type': 'Title',
          kind: 'title',
          name: 'Test Engineer',
          organizationId: 'organization',
        },
      },
    },
  };
}

describe('ContactTrashDetailPane', () => {
  it('renders the full read-only contact view with expiry below the name', () => {
    const wrapper = mount(ContactTrashDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        detail: trashDetail(),
      },
    });

    const heading = wrapper.get('h2').element;
    const expiry = wrapper.get('.contact-detail__expiry');
    expect(expiry.element.previousElementSibling).toBe(heading);
    expect(expiry.text()).toContain('Available until');
    expect(wrapper.text()).toContain('preferred@example.com');
    expect(wrapper.text()).toContain('other@example.com');
    expect(wrapper.text()).toContain('Primary');
    expect(wrapper.text()).toContain('+1 555 0100');
    expect(wrapper.text()).toContain('https://example.com');
    expect(wrapper.text()).toContain('April 5, 1990');
    expect(wrapper.text()).toContain('Read-only note');
    expect(wrapper.text()).toContain('QA Labs');
    expect(wrapper.text()).toContain('Reliability');
    expect(wrapper.text()).toContain('Test Engineer');
    expect(wrapper.text()).toContain('Personal');
    expect(wrapper.find('[aria-label="Edit"]').exists()).toBe(false);
  });
});
