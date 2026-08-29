// @vitest-environment happy-dom

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { VueDatePicker } from '@vuepic/vue-datepicker';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ContactDetailPane from '../../../src/components/contacts/ContactDetailPane.vue';
import ContactLabelDropdown from '../../../src/components/contacts/ContactLabelDropdown.vue';
import IdentityDetailPane from '../../../src/components/contacts/IdentityDetailPane.vue';
import RichTextEditor from '../../../src/components/RichTextEditor.vue';
import type {
  ContactEditorEmail,
  ContactEditorLink,
} from '../../../src/components/contacts/contact-editor';
import {
  CONTACT_MISSING_MESSAGE,
  useContactsStore,
} from '../../../src/stores/contacts-store';
import type { ContactDetail, IdentityRow } from '../../../src/types';

function contactDetail(): ContactDetail {
  return {
    id: 1,
    remote_id: 'card-1',
    addressbook_ids: [1, 2],
    display_name: 'Ada Lovelace',
    full_name: 'Augusta Ada Lovelace',
    emails: [
      {
        mapKey: 'email-a',
        position: 0,
        value: 'ada@example.com',
        label: null,
        contexts: ['work'],
        pref: 1,
        isPreferred: true,
      },
      {
        mapKey: 'email-b',
        position: 1,
        value: 'ada@home.example',
        label: 'Home office',
        contexts: ['private'],
        pref: null,
        isPreferred: false,
      },
      {
        mapKey: 'email-c',
        position: 2,
        value: 'other@example.com',
        label: null,
        contexts: [],
        pref: null,
        isPreferred: false,
      },
    ],
    phones: [{
      mapKey: 'phone-a',
      position: 0,
      value: '+1 555 0100',
      label: null,
      contexts: [],
      features: ['mobile', 'voice'],
      pref: null,
    }],
    links: [{
      mapKey: 'link-a',
      position: 0,
      value: 'https://example.com',
      label: null,
      contexts: ['private'],
      pref: null,
    }],
    anniversaries: [{
      mapKey: 'date-a',
      position: 0,
      kind: 'birth',
      date: {
        kind: 'partial',
        year: null,
        month: 12,
        day: 10,
      },
    }],
    notes: [{
      mapKey: 'note-a',
      position: 0,
      value: 'First programmer',
    }],
    organizations: [
      {
        mapKey: 'org-a',
        position: 0,
        name: 'Analytical Engines',
        contexts: ['work'],
        units: [
          { position: 0, value: 'Research' },
          { position: 1, value: 'Preserved unit' },
        ],
      },
      {
        mapKey: 'org-b',
        position: 1,
        name: 'Royal Society',
        contexts: ['work'],
        units: [{ position: 0, value: 'Mathematics' }],
      },
    ],
    titles: [
      {
        mapKey: 'title-a',
        position: 0,
        value: 'Programmer',
        kind: 'title',
        organizationMapKey: 'org-a',
      },
      {
        mapKey: 'role-a',
        position: 1,
        value: 'Founder',
        kind: 'role',
        organizationMapKey: 'org-a',
      },
      {
        mapKey: 'title-extra',
        position: 2,
        value: 'Mathematician',
        kind: 'title',
        organizationMapKey: 'org-a',
      },
      {
        mapKey: 'title-b',
        position: 3,
        value: 'Fellow',
        kind: 'title',
        organizationMapKey: 'org-b',
      },
    ],
  };
}

function identityDetail(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: overrides.id ?? 10,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? 'identity-10',
    name: overrides.name ?? '',
    email: overrides.email ?? 'identity@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    bcc_json: overrides.bcc_json ?? null,
    text_signature: overrides.text_signature ?? null,
    html_signature: overrides.html_signature ?? null,
    may_delete: overrides.may_delete ?? 1,
    raw_json: overrides.raw_json ?? null,
    updated_at: overrides.updated_at ?? 1,
    reply_to: overrides.reply_to ?? null,
    bcc: overrides.bcc ?? null,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('ContactDetailPane', () => {
  it('shows every supported detail group and address-book membership', () => {
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal', 'Team'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'view',
      },
    });

    expect(wrapper.text()).toContain('Augusta Ada Lovelace');
    expect(wrapper.text()).toContain('ada@example.com');
    expect(wrapper.text()).toContain('+1 555 0100');
    expect(wrapper.text()).toContain('https://example.com');
    expect(wrapper.text()).toContain('December 10');
    expect(wrapper.text()).not.toContain('--12-10');
    expect(wrapper.text()).toContain('First programmer');
    expect(wrapper.text()).toContain('Analytical Engines');
    expect(wrapper.text()).toContain('Programmer');
    expect(wrapper.text()).toContain('Founder');
    expect(wrapper.text()).toContain('Personal, Team');
  });

  it('keeps the displayed calendar year stable when year inclusion changes', async () => {
    const wrapper = mount(ContactDetailPane, {
      attachTo: document.body,
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    const input = wrapper.get('input[aria-label="Contact date"]');
    expect((input.element as HTMLInputElement).value).toBe('--12-10');
    expect(wrapper.get('[aria-label="Choose contact date from calendar"]').attributes('title'))
      .toBe('Choose date from calendar');
    expect(wrapper.find('.contact-dates__include-year').exists()).toBe(false);
    const picker = wrapper.findComponent(VueDatePicker);
    expect(picker.props('arrowNavigation')).toBe(true);
    expect(picker.props('sixWeeks')).toBe(true);
    const currentYear = new Date().getFullYear();
    expect((picker.props('startDate') as Date).getFullYear()).toBe(currentYear);

    const selected = new Date(0);
    selected.setHours(12, 0, 0, 0);
    selected.setFullYear(currentYear, 5, 12);
    const yearlessDayLabel = picker.props('ariaLabels').day({
      classData: {},
      current: true,
      text: 12,
      value: selected,
    });
    expect(yearlessDayLabel).toContain('12');
    expect(yearlessDayLabel).not.toContain(String(currentYear));
    picker.vm.$emit('update:modelValue', selected);
    await nextTick();

    expect((input.element as HTMLInputElement).value).toBe('--06-12');

    await wrapper.get('[aria-label="Choose contact date from calendar"]').trigger('click');
    await flushPromises();
    const includeYear = document.querySelector(
      '.contact-dates__include-year input',
    ) as HTMLInputElement;
    expect(includeYear.checked).toBe(false);
    expect(includeYear.dataset.dpActionElement).toBe('0');
    expect(includeYear.closest('.dp--action-extra')).not.toBeNull();
    const calendar = document.querySelector('.dp--calendar');
    expect(calendar).not.toBeNull();
    const yearBeforeIncluding = (picker.props('modelValue') as Date).getFullYear();
    includeYear.checked = true;
    includeYear.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe(`${currentYear}-06-12`);
    expect((picker.props('modelValue') as Date).getFullYear()).toBe(yearBeforeIncluding);
    expect(document.querySelector('.dp--calendar')).toBe(calendar);

    const yearBeforeOmitting = (picker.props('modelValue') as Date).getFullYear();
    includeYear.checked = false;
    includeYear.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe('--06-12');
    expect((picker.props('modelValue') as Date).getFullYear()).toBe(yearBeforeOmitting);
    expect(document.querySelector('.dp--calendar')).toBe(calendar);
    wrapper.unmount();
  });

  it('uses a valid leap year behind a yearless February 29', () => {
    const detail = contactDetail();
    detail.anniversaries[0].date = {
      kind: 'partial',
      year: null,
      month: 2,
      day: 29,
    };
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail,
        mode: 'edit',
      },
    });
    const value = wrapper.findComponent(VueDatePicker).props('modelValue') as Date;

    expect(value.getMonth()).toBe(1);
    expect(value.getDate()).toBe(29);
    expect(value.getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear());
  });

  it('removes a middle repeated row without changing its siblings’ DOM keys', async () => {
    const wrapper = mount(ContactDetailPane, {
      attachTo: document.body,
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    await nextTick();
    const emailSection = wrapper.findAll('.contact-resource')[0];
    const before = emailSection.findAll('.contact-resource__row')
      .map((row) => row.attributes('data-field-key'));

    await emailSection.findAll('button[aria-label="Remove email"]')[1].trigger('click');
    const after = emailSection.findAll('.contact-resource__row')
      .map((row) => row.attributes('data-field-key'));

    expect(after).toEqual([before[0], before[2]]);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('input[autocomplete="name"]').element);
    wrapper.unmount();
  });

  it('exposes all affiliations through a themed selector and preserved-detail copy', async () => {
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    const summary = wrapper.get('.contact-affiliations__summary');
    (summary.element.closest('details') as HTMLDetailsElement).open = true;
    await nextTick();

    const options = wrapper.findAll('.contact-affiliations__option');
    expect(options).toHaveLength(2);
    expect(options[0].text()).toContain('Research');
    expect(options[0].text()).toContain('Programmer');
    expect(wrapper.text()).toContain('Department: Preserved unit');
    expect(wrapper.text()).toContain('Title: Mathematician');

    await options[1].trigger('click');
    expect(wrapper.get('[data-organization-form-id="org-b"]')
      .attributes('data-organization-form-id')).toBe('org-b');
  });

  it('submits an email-less contact through the detailed mutation DTO', async () => {
    const store = useContactsStore();
    const createdDetail = {
      ...contactDetail(),
      id: 9,
      remote_id: 'card-9',
      addressbook_ids: [2],
      display_name: 'Email Less',
      full_name: 'Email Less',
      emails: [],
    };
    const create = vi.spyOn(store, 'createContactResult').mockImplementation(async (input) => {
      store.contacts = [
        {
          id: 8,
          remote_id: 'concurrent-card',
          uid: 'urn:uuid:00000000-0000-4000-8000-000000000008',
          addressbook_ids: [2],
          display_name: 'Concurrent arrival',
          email: null,
        },
        {
          id: 9,
          remote_id: 'card-9',
          uid: 'urn:uuid:00000000-0000-4000-8000-000000000009',
          addressbook_ids: [2],
          display_name: 'Email Less',
          email: null,
        },
      ];
      return {
        ok: true,
        uid: 'urn:uuid:00000000-0000-4000-8000-000000000009',
        contactId: 9,
        detail: createdDetail,
      };
    });
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: [],
        createAddressbookIds: [2],
        detail: null,
        mode: 'create',
      },
    });
    await wrapper.get('input[autocomplete="name"]').setValue('Email Less');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith({
      addressbookIds: [2],
      contact: expect.objectContaining({
        fullName: 'Email Less',
        emails: [],
        phones: [],
        links: [],
      }),
    });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({
      key: 'contact:9',
      detail: expect.objectContaining({ id: 9, emails: [] }),
    });
  });

  it('marks a blank existing resource row and keeps Remove actionable', async () => {
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    const firstEmail = wrapper.get('input[aria-label="Email addresses value"]');
    await firstEmail.setValue('');
    await wrapper.get('form').trigger('submit');
    await nextTick();

    expect(firstEmail.attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('.contact-resource__error').text())
      .toBe('Enter an email address or remove this email row.');
    await wrapper.get('button[aria-label="Remove email"]').trigger('click');
    expect(wrapper.find('.contact-resource__error').exists()).toBe(false);
  });

  it('connects every repeated-row error and focuses the first invalid field', async () => {
    const wrapper = mount(ContactDetailPane, {
      attachTo: document.body,
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    const phone = wrapper.get('input[aria-label="Phone numbers value"]');
    const website = wrapper.get('input[aria-label="Websites value"]');
    const date = wrapper.get('input[aria-label="Contact date"]');
    await phone.setValue('');
    await website.setValue('ftp://example.com');
    await date.setValue('2023-02-31');
    await wrapper.findAll('button')
      .find((button) => button.text().includes('Add website'))!
      .trigger('click');

    await wrapper.get('form').trigger('submit');
    await nextTick();

    const invalidFields = wrapper.findAll('[aria-invalid="true"]');
    expect(invalidFields).toHaveLength(4);
    for (const field of invalidFields) {
      const errorId = field.attributes('aria-describedby');
      expect(errorId).toBeTruthy();
      expect(wrapper.findAll('[role="alert"]')
        .find((error) => error.attributes('id') === errorId)).toBeDefined();
    }
    expect(wrapper.findAll('.contact-resource__error').map((error) => error.text()))
      .toEqual([
        'Enter a phone number or remove this phone row.',
        'Enter an absolute HTTP or HTTPS website.',
        'Enter a website or remove this website row.',
      ]);
    expect(wrapper.get('.contact-dates__error').text())
      .toContain('Use YYYY, YYYY-MM, YYYY-MM-DD');
    expect(document.activeElement).toBe(phone.element);
    wrapper.unmount();
  });

  it('submits the editor-opening contact as the sparse-update baseline', async () => {
    const store = useContactsStore();
    const update = vi.spyOn(store, 'updateContact').mockResolvedValue(false);
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    await wrapper.get('input[aria-label="Phone numbers value"]')
      .setValue('+1 555 0199');

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalledWith({
      contactId: 1,
      baseline: expect.objectContaining({
        fullName: 'Augusta Ada Lovelace',
        phones: [expect.objectContaining({ value: '+1 555 0100' })],
      }),
      contact: expect.objectContaining({
        fullName: 'Augusta Ada Lovelace',
        phones: [expect.objectContaining({ value: '+1 555 0199' })],
      }),
    });
  });

  it('shows a terminal message when the edited contact disappeared', async () => {
    const store = useContactsStore();
    const update = vi.spyOn(store, 'updateContact').mockImplementation(async () => {
      store.error = CONTACT_MISSING_MESSAGE;
      return false;
    });
    const wrapper = mount(ContactDetailPane, {
      props: {
        addressbookNames: ['Personal'],
        createAddressbookIds: [],
        detail: contactDetail(),
        mode: 'edit',
      },
    });
    await wrapper.get('input[autocomplete="name"]').setValue('Updated name');

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalled();
    expect(wrapper.get('.contact-detail__error').text()).toBe(CONTACT_MISSING_MESSAGE);
    expect(wrapper.emitted('saved')).toBeUndefined();
  });
});

describe('ContactLabelDropdown', () => {
  it('opens and focuses Custom without mutating preset metadata', async () => {
    const resource: ContactEditorEmail = {
      formKey: 'email:stable',
      mapKey: 'email-stable',
      position: 0,
      value: 'ada@example.com',
      label: null,
      contexts: ['work'],
      pref: 1,
      isPreferred: true,
    };
    const wrapper = mount(ContactLabelDropdown, {
      attachTo: document.body,
      props: { kind: 'email', resource },
    });

    await wrapper.findAll('[role="menuitemradio"]')
      .find((option) => option.text().includes('Custom'))!
      .trigger('click');
    await nextTick();

    const input = wrapper.get('input[aria-label="Custom email label"]');
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.emitted('update')).toBeUndefined();
    expect(resource.contexts).toEqual(['work']);

    await input.setValue('School');
    expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({
      label: 'School',
      contexts: [],
    });
    wrapper.unmount();
  });

  it('shows an existing custom label immediately', () => {
    const resource: ContactEditorLink = {
      formKey: 'link:stable',
      mapKey: 'link-stable',
      position: 0,
      value: 'https://example.com',
      label: 'Portfolio',
      contexts: ['private'],
      pref: null,
    };
    const wrapper = mount(ContactLabelDropdown, {
      props: {
        kind: 'website',
        resource,
      },
    });

    expect(wrapper.get('input[aria-label="Custom website label"]').element)
      .toHaveProperty('value', 'Portfolio');
  });
});

describe('IdentityDetailPane', () => {
  it('does not treat a missing edit target as a successful save', async () => {
    const wrapper = mount(IdentityDetailPane, {
      props: {
        identity: null,
        mode: 'edit',
      },
    });

    await wrapper.get('input[autocomplete="name"]').setValue('Missing');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('no longer available');
    await wrapper.get('input[autocomplete="name"]').setValue('Still editing');
    await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('uses the shared rich editor and safely initializes a text-only signature', () => {
    const identity = identityDetail({
      name: 'Alias',
      text_signature: '<unsafe & line\nsecond',
      html_signature: null,
      reply_to: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      bcc: [{ name: null, email: 'audit@example.com' }],
    });
    const wrapper = mount(IdentityDetailPane, {
      props: { identity, mode: 'edit' },
    });

    expect(wrapper.findComponent(RichTextEditor).exists()).toBe(true);
    expect(wrapper.findComponent(RichTextEditor).props('initialHtml'))
      .toContain('&lt;unsafe &amp; line');
    expect(wrapper.get('input[type="email"]').attributes('readonly')).toBeDefined();
    expect(wrapper.findAll('[data-form-key]')).toHaveLength(3);
  });

  it('retains a text-only signature when htmlSignature is empty on first edit', async () => {
    const identity = identityDetail({
      name: 'Alias',
      text_signature: 'First line\nSecond line',
      html_signature: '',
    });
    const confirmed = identityDetail({
      ...identity,
      text_signature: 'First line\nSecond line!',
      html_signature: '<div>First line</div><div>Second line!</div>',
    });
    const store = useContactsStore();
    const update = vi.spyOn(store, 'updateIdentity').mockResolvedValue({
      ok: true,
      identity: confirmed,
    });
    const wrapper = mount(IdentityDetailPane, {
      attachTo: document.body,
      props: { identity, mode: 'edit' },
    });
    const richEditor = wrapper.findComponent(RichTextEditor);
    expect(richEditor.props('initialHtml')).toContain('First line');
    expect(richEditor.props('initialHtml')).toContain('Second line');

    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = '<div>First line</div><div>Second line!</div>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      htmlSignature: '<div>First line</div><div>Second line!</div>',
      textSignature: 'First line\nSecond line!',
    }));
    wrapper.unmount();
  });

  it('uses textSignature when stored HTML is semantically empty', () => {
    const wrapper = mount(IdentityDetailPane, {
      props: {
        identity: identityDetail({
          text_signature: 'Meaningful text',
          html_signature: '<p><br></p>',
        }),
        mode: 'edit',
      },
    });

    expect(wrapper.findComponent(RichTextEditor).props('initialHtml'))
      .toContain('Meaningful text');
  });

  it('keeps repeater keys stable when removing an address', async () => {
    const wrapper = mount(IdentityDetailPane, {
      props: {
        identity: identityDetail({
          reply_to: [
            { name: null, email: 'first@example.com' },
            { name: null, email: 'second@example.com' },
          ],
        }),
        mode: 'edit',
      },
    });
    const before = wrapper.findAll('[data-form-key]')
      .map((row) => row.attributes('data-form-key'));

    await wrapper.get('[aria-label="Remove Reply-To address 1"]').trigger('click');

    const after = wrapper.findAll('[data-form-key]')
      .map((row) => row.attributes('data-form-key'));
    expect(after).toEqual([before[1]]);
  });

  it('clears the final address with RFC null instead of an empty array', async () => {
    const identity = identityDetail({
      reply_to: [{ name: null, email: 'reply@example.com' }],
    });
    const store = useContactsStore();
    const update = vi.spyOn(store, 'updateIdentity').mockResolvedValue({
      ok: true,
      identity: { ...identity, reply_to: null },
    });
    const wrapper = mount(IdentityDetailPane, {
      props: { identity, mode: 'edit' },
    });

    await wrapper.get('[aria-label="Remove Reply-To address 1"]').trigger('click');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      remoteId: identity.remote_id,
      replyTo: null,
    }));
  });

  it('submits sparse paired fields and emits the exact returned row key', async () => {
    const identity = identityDetail({
      id: 10,
      name: 'Alias',
      reply_to: [{ name: null, email: 'old@example.com' }],
    });
    const confirmed = identityDetail({
      ...identity,
      id: 42,
      name: '',
      reply_to: [{ name: null, email: 'reply@example.com' }],
      bcc: [{ name: 'Audit', email: 'audit@example.com' }],
      text_signature: 'Signature',
      html_signature: '<div>Signature</div>',
    });
    const store = useContactsStore();
    const update = vi.spyOn(store, 'updateIdentity').mockResolvedValue({
      ok: true,
      identity: confirmed,
    });
    const wrapper = mount(IdentityDetailPane, {
      props: { identity, mode: 'edit' },
    });

    await wrapper.get('input[autocomplete="name"]').setValue('');
    await wrapper.get('[aria-label="Reply-To email 1"]').setValue('reply@example.com');
    await wrapper.get('button').trigger('focus');
    const addBcc = wrapper.findAll('button')
      .find((button) => button.text().includes('Add Bcc address'))!;
    await addBcc.trigger('click');
    await wrapper.get('[aria-label="Bcc display name 1"]').setValue('Audit');
    await wrapper.get('[aria-label="Bcc email 1"]').setValue('audit@example.com');
    wrapper.findComponent(RichTextEditor).vm.$emit('update', {
      html: '<div>Signature</div>',
      text: 'Signature',
    });
    await nextTick();
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalledWith({
      operationId: expect.any(String),
      remoteId: 'identity-10',
      name: '',
      replyTo: [{ name: null, email: 'reply@example.com' }],
      bcc: [{ name: 'Audit', email: 'audit@example.com' }],
      htmlSignature: '<div>Signature</div>',
      textSignature: 'Signature',
    });
    expect(update.mock.calls[0][0]).not.toHaveProperty('email');
    expect(wrapper.emitted('saved')?.at(-1)?.[0]).toBe('identity:42');
  });

  it('shows the strict UTF-8 signature limit while retaining editor state', async () => {
    const store = useContactsStore();
    const create = vi.spyOn(store, 'createIdentity').mockResolvedValue({
      ok: true,
      identity: identityDetail({ id: 50, remote_id: 'identity-50' }),
    });
    const wrapper = mount(IdentityDetailPane, {
      attachTo: document.body,
      props: { identity: null, mode: 'create' },
    });
    await wrapper.get('input[type="email"]').setValue('new@example.com');
    const richEditor = wrapper.findComponent(RichTextEditor);
    const editor = wrapper.get('.editor').element as HTMLElement;
    const oversized = 'é'.repeat(1024);

    editor.focus();
    editor.textContent = oversized;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    richEditor.vm.$emit('update', { html: oversized, text: oversized });
    await nextTick();
    expect(wrapper.text()).toContain('Each must be under 2,048 UTF-8 bytes');
    expect(wrapper.get('.editor').attributes()).toMatchObject({
      'aria-describedby': 'identity-signature-help identity-signature-error',
      'aria-invalid': 'true',
    });
    expect(document.activeElement).toBe(editor);
    expect(wrapper.get('.identity-detail__footer button:last-child').attributes('disabled'))
      .toBeDefined();

    const accepted = `${'é'.repeat(1023)}a`;
    editor.textContent = accepted;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    richEditor.vm.$emit('update', { html: accepted, text: accepted });
    await nextTick();
    expect(wrapper.text()).not.toContain('Each must be under 2,048 UTF-8 bytes');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'new@example.com',
      htmlSignature: accepted,
      textSignature: accepted,
    }));
    wrapper.unmount();
  });

  it('connects the create email error to its input', async () => {
    const wrapper = mount(IdentityDetailPane, {
      props: { identity: null, mode: 'create' },
    });

    await wrapper.get('form').trigger('submit');
    await nextTick();

    expect(wrapper.get('input[type="email"]').attributes()).toMatchObject({
      'aria-describedby': 'identity-email-error',
      'aria-invalid': 'true',
    });
    expect(wrapper.get('#identity-email-error').text())
      .toBe('Enter a valid email address.');
  });

  it('does not enqueue a second save while the first click is pending', async () => {
    const store = useContactsStore();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi.spyOn(store, 'createIdentity').mockImplementation(async () => {
      store.saving = true;
      await pending;
      store.saving = false;
      return {
        ok: true,
        identity: identityDetail({ id: 51, remote_id: 'identity-51' }),
      };
    });
    const wrapper = mount(IdentityDetailPane, {
      props: { identity: null, mode: 'create' },
    });
    await wrapper.get('input[type="email"]').setValue('new@example.com');

    void wrapper.get('form').trigger('submit');
    await nextTick();
    await wrapper.get('form').trigger('submit');
    expect(create).toHaveBeenCalledTimes(1);

    finish();
    await flushPromises();
  });

  it('disables deletion when mayDelete is false', () => {
    const wrapper = mount(IdentityDetailPane, {
      props: {
        identity: identityDetail({ may_delete: 0 }),
        mode: 'view',
      },
    });

    expect(wrapper.get('[aria-label="Delete"]').attributes('disabled')).toBeDefined();
  });
});
