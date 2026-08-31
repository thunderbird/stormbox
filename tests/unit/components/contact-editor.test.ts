// @vitest-environment happy-dom

import {
  describe,
  expect,
  it,
} from 'vitest';

import type { ContactDetail } from '../../../src/types';
import {
  contactFieldsAreEmpty,
  validateContactFields,
} from '../../../src/utils/contact-fields';
import {
  applyContactLabel,
  contactDateFromInput,
  contactDateToInput,
  contactEditorFields,
  contactLabelChoice,
  createContactEditorModel,
  createContactEditorOrganization,
  createContactEditorResource,
  createContactEditorTitle,
  formatContactDate,
  setPrimaryOrganizationUnit,
  type ContactEditorPhone,
} from '../../../src/components/contacts/contact-editor';

function detail(): ContactDetail {
  return {
    id: 1,
    remote_id: 'card-1',
    addressbook_ids: [1],
    display_name: 'Ada',
    full_name: 'Ada Lovelace',
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
        label: 'Cottage',
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
    phones: [],
    links: [],
    anniversaries: [],
    notes: [],
    organizations: [],
    titles: [],
  };
}

describe('contact editor mapping', () => {
  it('round-trips the selected photo and treats it as contact content', () => {
    const source = detail();
    source.photo = {
      mapKey: 'avatar',
      uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      blobId: null,
      mediaType: 'image/png',
      pref: 1,
    };
    const result = contactEditorFields(createContactEditorModel(source));

    expect(result.fields?.photo).toEqual(source.photo);
    expect(contactFieldsAreEmpty({
      fullName: null,
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
      photo: source.photo,
    })).toBe(false);
  });

  it('maps preset and custom labels while preserving unrelated phone metadata', () => {
    const phone: ContactEditorPhone & { vendorValue: string } = {
      formKey: 'phone:one',
      mapKey: 'phone-one',
      position: 0,
      value: '+1 555 0100',
      label: null,
      contexts: ['work'],
      features: ['voice', 'fax'],
      pref: 4,
      vendorValue: 'keep',
    };

    const mobile = applyContactLabel('phone', phone, 'mobile');
    expect(mobile).toMatchObject({
      contexts: [],
      features: ['voice', 'mobile'],
      label: null,
      pref: 4,
      vendorValue: 'keep',
    });
    expect(contactLabelChoice('phone', mobile)).toBe('mobile');

    const custom = applyContactLabel('phone', mobile, 'custom', 'Satellite');
    expect(custom.label).toBe('Satellite');
    expect(custom.features).toEqual(['voice']);
    expect(contactLabelChoice('phone', custom)).toBe('custom');
  });

  it('maps email and website presets to standard contexts', () => {
    const email = createContactEditorResource('email');
    expect(applyContactLabel('email', email, 'home')).toMatchObject({
      contexts: ['private'],
      label: null,
    });
    expect(applyContactLabel('email', email, 'work')).toMatchObject({
      contexts: ['work'],
      label: null,
    });
    expect(applyContactLabel('email', email, 'custom', 'School')).toMatchObject({
      contexts: [],
      label: 'School',
    });

    const website = createContactEditorResource('website');
    expect(applyContactLabel('website', website, 'personal').contexts)
      .toEqual(['private']);
    expect(applyContactLabel('website', website, 'work').contexts)
      .toEqual(['work']);
    expect(applyContactLabel('website', website, 'other').contexts)
      .toEqual([]);
  });

  it.each([
    ['1985', { kind: 'partial', year: 1985, month: null, day: null }],
    ['1985-06', { kind: 'partial', year: 1985, month: 6, day: null }],
    ['1985-06-12', { kind: 'partial', year: 1985, month: 6, day: 12 }],
    ['--06', { kind: 'partial', year: null, month: 6, day: null }],
    ['--06-12', { kind: 'partial', year: null, month: 6, day: 12 }],
    ['1985-06-12T03:04:05Z', { kind: 'timestamp', utc: '1985-06-12T03:04:05Z' }],
  ])('accepts and round-trips strict contact date %s', (text, expected) => {
    const parsed = contactDateFromInput(text);
    expect(parsed).toEqual(expected);
    expect(contactDateToInput(parsed!)).toBe(text);
  });

  it.each([
    [{ kind: 'partial', year: 1985, month: null, day: null }, '1985'],
    [{ kind: 'partial', year: 1985, month: 6, day: null }, 'June 1985'],
    [{ kind: 'partial', year: 1985, month: 6, day: 12 }, 'June 12, 1985'],
    [{ kind: 'partial', year: null, month: 6, day: null }, 'June'],
    [{ kind: 'partial', year: null, month: 6, day: 12 }, 'June 12'],
    [{ kind: 'timestamp', utc: '1985-06-12T03:04:05Z' }, 'June 12, 1985'],
  ] as const)('formats contact date values as readable text', (date, expected) => {
    expect(formatContactDate(date, 'en-US')).toBe(expected);
  });

  it.each([
    '',
    '1985-00',
    '1985-02-29',
    '--13',
    '--02-30',
    '06-12',
    '1985/06/12',
    '1985-6-2',
    '1985-06-12T03:04:05+01:00',
  ])('rejects invalid or non-canonical contact date %s', (text) => {
    expect(contactDateFromInput(text)).toBeNull();
  });

  it('keeps stable repeated-row identities when a middle row is removed', () => {
    const model = createContactEditorModel(detail());
    const [firstKey, removedKey, lastKey] = model.emails.map((email) => email.formKey);
    model.emails = model.emails.filter((email) => email.formKey !== removedKey);
    const result = contactEditorFields(model);

    expect(model.emails.map((email) => email.formKey)).toEqual([firstKey, lastKey]);
    expect(result.error).toBeNull();
    expect(result.fields?.emails.map((email) => email.mapKey))
      .toEqual(['email-a', 'email-c']);
    expect(result.fields?.emails[0]).toMatchObject({
      contexts: ['work'],
      pref: 1,
      isPreferred: true,
    });
  });

  it('keeps multiple affiliations, extra units, and stable title links', () => {
    const source = detail();
    source.organizations = [
      {
        mapKey: 'org-a',
        position: 0,
        name: 'Analytical Engines',
        contexts: ['work'],
        units: [
          { position: 0, value: 'Research' },
          { position: 1, value: 'Preserved lab' },
        ],
      },
      {
        mapKey: 'org-b',
        position: 1,
        name: 'Royal Society',
        contexts: ['work'],
        units: [{ position: 0, value: 'Mathematics' }],
      },
    ];
    source.titles = [
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
        mapKey: 'title-b',
        position: 2,
        value: 'Fellow',
        kind: 'title',
        organizationMapKey: 'org-b',
      },
    ];
    const model = createContactEditorModel(source);
    model.organizations[0] = setPrimaryOrganizationUnit(
      model.organizations[0],
      'Advanced Research',
    );
    const result = contactEditorFields(model);

    expect(model.organizations.map((organization) => organization.formId))
      .toEqual(['org-a', 'org-b']);
    expect(result.fields?.organizations).toHaveLength(2);
    expect(result.fields?.organizations[0].units.map((unit) => unit.value))
      .toEqual(['Advanced Research', 'Preserved lab']);
    expect(result.fields?.titles.map((title) => [
      title.mapKey,
      title.organizationMapKey,
      title.organizationFormId,
    ])).toEqual([
      ['title-a', 'org-a', 'org-a'],
      ['role-a', 'org-a', 'org-a'],
      ['title-b', 'org-b', 'org-b'],
    ]);
  });

  it('creates stable form references for a new work affiliation', () => {
    const model = createContactEditorModel();
    const organization = createContactEditorOrganization();
    organization.name = 'New Organization';
    model.organizations.push(organization);
    const title = createContactEditorTitle('title', organization);
    title.value = 'Engineer';
    model.titles.push(title);
    const result = contactEditorFields(model);

    expect(result.fields?.organizations[0].formId).toBe(organization.formId);
    expect(result.fields?.titles[0]).toMatchObject({
      organizationMapKey: organization.mapKey,
      organizationFormId: organization.formId,
    });
  });

  it.each(['title', 'role'] as const)(
    'keeps a %s-only affiliation linked to its empty organization',
    (kind) => {
      const model = createContactEditorModel();
      const organization = createContactEditorOrganization();
      const title = createContactEditorTitle(kind, organization);
      title.value = kind === 'title' ? 'Engineer' : 'Advisor';
      model.organizations.push(organization);
      model.titles.push(title);

      const result = contactEditorFields(model);

      expect(result.fields?.organizations).toHaveLength(1);
      expect(result.fields?.titles[0]).toMatchObject({
        organizationMapKey: organization.mapKey,
        organizationFormId: organization.formId,
      });
      expect(validateContactFields(result.fields!, { rejectEmpty: true })).toBeNull();
      expect(contactFieldsAreEmpty(result.fields!)).toBe(false);
    },
  );

  it('removes blank notes and reports blank required rows actionably', () => {
    const source = detail();
    source.notes = [{ mapKey: 'note-a', position: 0, value: 'Old note' }];
    const model = createContactEditorModel(source);
    model.notes[0].value = '';
    const phone = createContactEditorResource('phone');
    model.phones.push(phone as ContactEditorPhone);

    const invalid = contactEditorFields(model);
    expect(invalid).toMatchObject({
      fields: null,
      errorFieldKey: phone.formKey,
      error: 'Enter a phone number or remove this phone row.',
    });

    model.phones = [];
    expect(contactEditorFields(model).fields?.notes).toEqual([]);
  });

  it('produces an email-less mutation while leaving empty-card rejection to the store', () => {
    const named = createContactEditorModel();
    named.fullName = 'Email Less';
    expect(contactEditorFields(named).fields).toMatchObject({
      fullName: 'Email Less',
      emails: [],
    });

    const empty = createContactEditorModel();
    expect(contactEditorFields(empty).fields).toMatchObject({
      fullName: null,
      emails: [],
      phones: [],
    });
  });
});
