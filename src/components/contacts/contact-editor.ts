import type {
  ContactAnniversaryDate,
  ContactAnniversaryKind,
  ContactContext,
  ContactDetail,
  ContactDetailAnniversary,
  ContactDetailEmail,
  ContactDetailLink,
  ContactDetailNote,
  ContactDetailOrganization,
  ContactDetailOrganizationUnit,
  ContactDetailPhone,
  ContactDetailTitle,
  ContactMutationFields,
  ContactPhoneFeature,
  ContactTitleKind,
} from '../../types';
import {
  isHttpContactWebsite,
  isValidContactDate,
  isValidEmailAddress,
} from '../../utils/contact-fields';
import { createContactMapKey } from '../../utils/contact-uid';

export type ContactResourceKind = 'email' | 'phone' | 'website';

export type ContactLabelChoice =
  | 'custom'
  | 'fax'
  | 'home'
  | 'main'
  | 'mobile'
  | 'other'
  | 'pager'
  | 'personal'
  | 'work';

export interface ContactLabelOption {
  value: ContactLabelChoice;
  label: string;
}

interface ContactEditorKey {
  formKey: string;
  isPlaceholder?: boolean;
  isNew?: boolean;
  originalValue?: string;
}

export type ContactEditorEmail = ContactDetailEmail & ContactEditorKey;
export type ContactEditorPhone = ContactDetailPhone & ContactEditorKey;
export type ContactEditorLink = ContactDetailLink & ContactEditorKey;

export type ContactEditorResource =
  | ContactEditorEmail
  | ContactEditorLink
  | ContactEditorPhone;

export interface ContactEditorAnniversary
  extends Omit<ContactDetailAnniversary, 'date'>, ContactEditorKey {
  date: ContactAnniversaryDate;
  dateText: string;
}

export type ContactEditorNote = ContactDetailNote & ContactEditorKey;

export interface ContactEditorOrganization
  extends Omit<ContactDetailOrganization, 'formId'>, ContactEditorKey {
  formId: string;
}

export type ContactEditorTitle = ContactDetailTitle & ContactEditorKey;

export interface ContactEditorModel {
  fullName: string;
  emails: ContactEditorEmail[];
  phones: ContactEditorPhone[];
  links: ContactEditorLink[];
  anniversaries: ContactEditorAnniversary[];
  notes: ContactEditorNote[];
  organizations: ContactEditorOrganization[];
  titles: ContactEditorTitle[];
}

export interface ContactEditorFieldsResult {
  errors: Record<string, string>;
  fields: ContactMutationFields | null;
  error: string | null;
  errorFieldKey: string | null;
}

const PHONE_LABEL_FEATURES = new Set<ContactPhoneFeature>([
  'fax',
  'main-number',
  'mobile',
  'pager',
]);

const LABEL_OPTIONS: Record<ContactResourceKind, readonly ContactLabelOption[]> = {
  email: [
    { value: 'home', label: 'Home' },
    { value: 'work', label: 'Work' },
    { value: 'other', label: 'Other' },
    { value: 'custom', label: 'Custom' },
  ],
  phone: [
    { value: 'home', label: 'Home' },
    { value: 'work', label: 'Work' },
    { value: 'mobile', label: 'Mobile' },
    { value: 'main', label: 'Main' },
    { value: 'fax', label: 'Fax' },
    { value: 'pager', label: 'Pager' },
    { value: 'other', label: 'Other' },
    { value: 'custom', label: 'Custom' },
  ],
  website: [
    { value: 'personal', label: 'Personal' },
    { value: 'work', label: 'Work' },
    { value: 'other', label: 'Other' },
    { value: 'custom', label: 'Custom' },
  ],
};

let formKeySequence = 0;

function createFormKey(prefix: string, mapKey: string | null = null): string {
  formKeySequence += 1;
  return `${prefix}:${mapKey ?? 'new'}:${formKeySequence}`;
}

function cloneContexts(contexts: ContactContext[]): ContactContext[] {
  return [...contexts];
}

function cloneDate(date: ContactAnniversaryDate): ContactAnniversaryDate {
  switch (date.kind) {
    case 'partial':
      return { ...date };
    case 'timestamp':
      return { ...date };
    default: {
      const exhaustive: never = date;
      return exhaustive;
    }
  }
}

export function contactLabelOptions(
  kind: ContactResourceKind,
): readonly ContactLabelOption[] {
  return LABEL_OPTIONS[kind];
}

export function contactLabelChoice(
  kind: ContactResourceKind,
  resource: ContactEditorResource,
): ContactLabelChoice {
  if (resource.label?.trim()) return 'custom';
  switch (kind) {
    case 'email':
      if (resource.contexts.includes('work')) return 'work';
      if (resource.contexts.includes('private')) return 'home';
      return 'other';
    case 'phone': {
      const phone = resource as ContactEditorPhone;
      if (phone.features.includes('mobile')) return 'mobile';
      if (phone.features.includes('main-number')) return 'main';
      if (phone.features.includes('fax')) return 'fax';
      if (phone.features.includes('pager')) return 'pager';
      if (phone.contexts.includes('work')) return 'work';
      if (phone.contexts.includes('private')) return 'home';
      return 'other';
    }
    case 'website':
      if (resource.contexts.includes('work')) return 'work';
      if (resource.contexts.includes('private')) return 'personal';
      return 'other';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function contextsForLabel(
  kind: ContactResourceKind,
  choice: ContactLabelChoice,
): ContactContext[] {
  switch (kind) {
    case 'email':
      if (choice === 'home') return ['private'];
      if (choice === 'work') return ['work'];
      return [];
    case 'phone':
      if (choice === 'home') return ['private'];
      if (choice === 'work') return ['work'];
      return [];
    case 'website':
      if (choice === 'personal') return ['private'];
      if (choice === 'work') return ['work'];
      return [];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function phoneFeaturesForLabel(
  features: ContactPhoneFeature[],
  choice: ContactLabelChoice,
): ContactPhoneFeature[] {
  const preserved = features.filter((feature) => !PHONE_LABEL_FEATURES.has(feature));
  switch (choice) {
    case 'mobile':
      return [...preserved, 'mobile'];
    case 'main':
      return [...preserved, 'main-number'];
    case 'fax':
      return [...preserved, 'fax'];
    case 'pager':
      return [...preserved, 'pager'];
    case 'custom':
    case 'home':
    case 'other':
    case 'personal':
    case 'work':
      return preserved;
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

export function applyContactLabel<T extends ContactEditorResource>(
  kind: ContactResourceKind,
  resource: T,
  choice: ContactLabelChoice,
  customLabel = '',
): T {
  const next = {
    ...resource,
    contexts: contextsForLabel(kind, choice),
    label: choice === 'custom' ? customLabel : null,
  };
  if (kind === 'phone') {
    return {
      ...next,
      features: phoneFeaturesForLabel(
        (resource as ContactEditorPhone).features,
        choice,
      ),
    } as T;
  }
  return next as T;
}

export function createContactEditorResource(
  kind: ContactResourceKind,
): ContactEditorResource {
  const mapKey = createContactMapKey(kind === 'website' ? 'link' : kind);
  const common = {
    formKey: createFormKey(kind, mapKey),
    isNew: true,
    mapKey,
    position: 0,
    value: '',
    label: null,
    contexts: [],
    pref: null,
  };
  switch (kind) {
    case 'email':
      return { ...common, isPreferred: false };
    case 'phone':
      return { ...common, features: [] };
    case 'website':
      return common;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function createContactEditorAnniversary(): ContactEditorAnniversary {
  const mapKey = createContactMapKey('date');
  const date: ContactAnniversaryDate = {
    kind: 'partial',
    year: null,
    month: null,
    day: null,
  };
  return {
    formKey: createFormKey('date', mapKey),
    isNew: true,
    mapKey,
    position: 0,
    kind: 'birth',
    date,
    dateText: '',
  };
}

export function createContactEditorNote(): ContactEditorNote {
  const mapKey = createContactMapKey('note');
  return {
    formKey: createFormKey('note', mapKey),
    isNew: true,
    mapKey,
    position: 0,
    value: '',
  };
}

export function createContactEditorOrganization(
  position = 0,
): ContactEditorOrganization {
  const mapKey = createContactMapKey('organization');
  return {
    formKey: createFormKey('organization', mapKey),
    isNew: true,
    formId: createFormKey('organization-form', mapKey),
    mapKey,
    position,
    name: null,
    contexts: ['work'],
    units: [],
  };
}

export function createContactEditorTitle(
  kind: ContactTitleKind,
  organization: ContactEditorOrganization,
  position = 0,
): ContactEditorTitle {
  const mapKey = createContactMapKey('title');
  return {
    formKey: createFormKey('title', mapKey),
    isNew: true,
    mapKey,
    position,
    value: '',
    kind,
    organizationMapKey: organization.mapKey,
    organizationFormId: organization.formId,
  };
}

export function createContactEditorModel(
  detail: ContactDetail | null = null,
): ContactEditorModel {
  if (!detail) {
    const email = createContactEditorResource('email') as ContactEditorEmail;
    email.isPreferred = true;
    email.pref = 1;
    email.isPlaceholder = true;
    return {
      fullName: '',
      emails: [email],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    };
  }

  const organizations = detail.organizations.map((organization) => {
    const formId = organization.formId?.trim()
      || organization.mapKey
      || createFormKey('organization-form');
    return {
      ...organization,
      formKey: createFormKey('organization', organization.mapKey),
      isNew: false,
      formId,
      contexts: cloneContexts(organization.contexts),
      units: organization.units.map((unit) => ({ ...unit })),
    };
  });
  const organizationFormIds = new Map(
    organizations
      .filter((organization) => organization.mapKey)
      .map((organization) => [organization.mapKey, organization.formId]),
  );

  return {
    fullName: detail.full_name ?? detail.display_name ?? '',
    emails: detail.emails.map((email) => ({
      ...email,
      formKey: createFormKey('email', email.mapKey),
      isNew: false,
      contexts: cloneContexts(email.contexts),
    })),
    phones: detail.phones.map((phone) => ({
      ...phone,
      formKey: createFormKey('phone', phone.mapKey),
      isNew: false,
      contexts: cloneContexts(phone.contexts),
      features: [...phone.features],
    })),
    links: detail.links.map((link) => ({
      ...link,
      formKey: createFormKey('link', link.mapKey),
      isNew: false,
      originalValue: link.value,
      contexts: cloneContexts(link.contexts),
    })),
    anniversaries: detail.anniversaries.map((anniversary) => ({
      ...anniversary,
      formKey: createFormKey('date', anniversary.mapKey),
      isNew: false,
      date: cloneDate(anniversary.date),
      dateText: contactDateToInput(anniversary.date),
    })),
    notes: detail.notes.map((note) => ({
      ...note,
      formKey: createFormKey('note', note.mapKey),
      isNew: false,
    })),
    organizations,
    titles: detail.titles.map((title) => ({
      ...title,
      formKey: createFormKey('title', title.mapKey),
      isNew: false,
      organizationFormId: title.organizationFormId
        ?? organizationFormIds.get(title.organizationMapKey)
        ?? null,
    })),
  };
}

function withoutFormKey<T extends ContactEditorKey>(
  detail: T,
): Omit<T, 'formKey' | 'isNew' | 'isPlaceholder' | 'originalValue'> {
  const {
    formKey: _formKey,
    isNew: _isNew,
    isPlaceholder: _isPlaceholder,
    originalValue: _originalValue,
    ...value
  } = detail;
  return value;
}

function normalizePositions<T extends { position: number }>(details: T[]): T[] {
  return details.map((detail, position) => ({ ...detail, position }));
}

function resourceFields<T extends ContactEditorResource>(
  details: T[],
): Array<Omit<T, 'formKey' | 'isNew' | 'isPlaceholder' | 'originalValue'>> {
  return normalizePositions(
    details
      .filter((detail) => detail.value.trim())
      .map((detail) => withoutFormKey(detail)),
  );
}

export function contactEditorFields(
  model: ContactEditorModel,
): ContactEditorFieldsResult {
  const errors = contactEditorFieldErrors(model);
  const errorFieldKey = Object.keys(errors)[0] ?? null;
  if (errorFieldKey) {
    return {
      errors,
      fields: null,
      error: errors[errorFieldKey],
      errorFieldKey,
    };
  }

  const anniversaries: ContactDetailAnniversary[] = [];
  for (const detail of model.anniversaries) {
    const date = contactDateFromInput(detail.dateText);
    if (!date) continue;
    const {
      formKey: _formKey,
      isNew: _isNew,
      dateText: _dateText,
      ...anniversary
    } = detail;
    anniversaries.push({ ...anniversary, date });
  }

  const organizations = normalizePositions(
    model.organizations
      .filter((organization) => (
        Boolean(organization.name?.trim())
        || organization.units.some((unit) => unit.value.trim())
        || model.titles.some((title) => (
          Boolean(title.value.trim())
          && (
            title.organizationFormId === organization.formId
            || (
              organization.mapKey != null
              && title.organizationMapKey === organization.mapKey
            )
          )
        ))
      ))
      .map((organization) => {
        const { formKey: _formKey, isNew: _isNew, ...value } = organization;
        return {
          ...value,
          name: value.name?.trim() || null,
          units: normalizePositions(
            value.units.filter((unit) => unit.value.trim()),
          ),
        };
      }),
  );
  const titles = normalizePositions(
    model.titles
      .filter((title) => title.value.trim())
      .map((title) => {
        const { formKey: _formKey, isNew: _isNew, ...value } = title;
        return { ...value, value: value.value.trim() };
      }),
  );

  return {
    errors: {},
    error: null,
    errorFieldKey: null,
    fields: {
      fullName: model.fullName.trim() || null,
      emails: resourceFields(model.emails) as ContactDetailEmail[],
      phones: resourceFields(model.phones) as ContactDetailPhone[],
      links: resourceFields(model.links) as ContactDetailLink[],
      anniversaries: normalizePositions(anniversaries),
      notes: normalizePositions(
        model.notes
          .filter((note) => note.value.trim())
          .map((note) => withoutFormKey(note)),
      ) as ContactDetailNote[],
      organizations,
      titles,
    },
  };
}

export function contactEditorFieldErrors(
  model: ContactEditorModel,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const email of model.emails) {
    if (!email.isPlaceholder && !email.value.trim()) {
      errors[email.formKey] = 'Enter an email address or remove this email row.';
    } else if (email.value.trim() && !isValidEmailAddress(email.value)) {
      errors[email.formKey] = 'Enter a valid email address.';
    }
  }
  for (const phone of model.phones) {
    if (!phone.value.trim()) {
      errors[phone.formKey] = 'Enter a phone number or remove this phone row.';
    }
  }
  for (const link of model.links) {
    if (!link.value.trim()) {
      errors[link.formKey] = 'Enter a website or remove this website row.';
    } else if (
      (link.isNew || link.value !== link.originalValue)
      && !isHttpContactWebsite(link.value)
    ) {
      errors[link.formKey] = 'Enter an absolute HTTP or HTTPS website.';
    }
  }
  for (const anniversary of model.anniversaries) {
    if (!anniversary.dateText.trim()) {
      errors[anniversary.formKey] = 'Enter a date or remove this date row.';
    } else if (!contactDateFromInput(anniversary.dateText)) {
      errors[anniversary.formKey] =
        'Use YYYY, YYYY-MM, YYYY-MM-DD, --MM, --MM-DD, or a UTC timestamp.';
    }
  }
  return errors;
}

export function contactDateToInput(date: ContactAnniversaryDate): string {
  switch (date.kind) {
    case 'timestamp':
      return date.utc;
    case 'partial': {
      const year = date.year == null ? '' : String(date.year).padStart(4, '0');
      const month = date.month == null ? '' : String(date.month).padStart(2, '0');
      const day = date.day == null ? '' : String(date.day).padStart(2, '0');
      if (year && month && day) return `${year}-${month}-${day}`;
      if (year && month) return `${year}-${month}`;
      if (year) return year;
      if (month && day) return `--${month}-${day}`;
      if (month) return `--${month}`;
      return '';
    }
    default: {
      const exhaustive: never = date;
      return exhaustive;
    }
  }
}

export function contactDateFromInput(value: string): ContactAnniversaryDate | null {
  const text = value.trim();
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d*[1-9])?Z)$/
    .exec(text);
  if (timestamp) {
    const date: ContactAnniversaryDate = { kind: 'timestamp', utc: timestamp[1] };
    return isValidContactDate(date) ? date : null;
  }
  const complete = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  const withoutYear = /^--(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (!complete && !withoutYear) return null;
  const date: ContactAnniversaryDate = {
    kind: 'partial',
    year: complete ? Number(complete[1]) : null,
    month: complete?.[2] != null
      ? Number(complete[2])
      : (withoutYear?.[1] != null ? Number(withoutYear[1]) : null),
    day: complete?.[3] != null
      ? Number(complete[3])
      : (withoutYear?.[2] != null ? Number(withoutYear[2]) : null),
  };
  return isValidContactDate(date) ? date : null;
}

export function contactAnniversaryKindLabel(
  kind: ContactAnniversaryKind,
): string {
  switch (kind) {
    case 'birth':
      return 'Birthday';
    case 'wedding':
      return 'Wedding';
    case 'death':
      return 'Death';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function contactResourceLabel(
  kind: ContactResourceKind,
  resource: ContactEditorResource,
): string {
  const choice = contactLabelChoice(kind, resource);
  if (choice === 'custom') return resource.label?.trim() || 'Custom';
  return contactLabelOptions(kind)
    .find((option) => option.value === choice)?.label ?? 'Other';
}

export function formatContactDate(
  date: ContactAnniversaryDate,
  locales?: Intl.LocalesArgument,
): string {
  let year: number | null;
  let month: number | null;
  let day: number | null;

  switch (date.kind) {
    case 'timestamp':
      [year, month, day] = date.utc
        .slice(0, 10)
        .split('-')
        .map(Number) as [number, number, number];
      break;
    case 'partial':
      ({ year, month, day } = date);
      break;
    default: {
      const exhaustive: never = date;
      return exhaustive;
    }
  }

  if (month == null) return year == null ? '' : String(year);

  const value = new Date(0);
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCFullYear(year ?? 2000, month - 1, day ?? 1);
  return new Intl.DateTimeFormat(locales, {
    ...(day == null ? {} : { day: 'numeric' }),
    month: 'long',
    timeZone: 'UTC',
    ...(year == null ? {} : { year: 'numeric' }),
  }).format(value);
}

export function organizationAdditionalDetails(
  organization: ContactEditorOrganization,
  titles: ContactEditorTitle[],
): string[] {
  const details = organization.units.slice(1)
    .map((unit) => unit.value.trim())
    .filter(Boolean)
    .map((unit) => `Department: ${unit}`);
  const linked = titles.filter((title) => (
    title.organizationFormId === organization.formId
    || (organization.mapKey != null
      && title.organizationMapKey === organization.mapKey)
  ));
  const seenKind = new Set<ContactTitleKind>();
  for (const title of linked) {
    if (!seenKind.has(title.kind)) {
      seenKind.add(title.kind);
      continue;
    }
    if (title.value.trim()) {
      details.push(`${title.kind === 'title' ? 'Title' : 'Role'}: ${title.value.trim()}`);
    }
  }
  return details;
}

export function setPrimaryOrganizationUnit(
  organization: ContactEditorOrganization,
  value: string,
): ContactEditorOrganization {
  const first: ContactDetailOrganizationUnit = { position: 0, value };
  return {
    ...organization,
    units: [first, ...organization.units.slice(1)],
  };
}
