import type {
  ContactAnniversaryDate,
  ContactDetail,
  ContactDetailEmail,
  ContactMutationFields,
} from '../types/db';
import { addressKey } from './address-key';
import { validatedContactPhotoDataUri } from './contact-photo';
import { createContactMapKey } from './contact-uid';

export type ContactFieldValidationIssue =
  | 'duplicate-map-key'
  | 'empty-contact'
  | 'empty-email'
  | 'empty-organization'
  | 'empty-phone'
  | 'empty-website'
  | 'invalid-anniversary'
  | 'invalid-collection'
  | 'invalid-email'
  | 'invalid-fields'
  | 'invalid-map-key'
  | 'invalid-note'
  | 'invalid-organization-reference'
  | 'invalid-photo'
  | 'invalid-title'
  | 'invalid-website';

interface ContactFieldValidationOptions {
  baseline?: ContactMutationFields | null;
  rejectEmpty?: boolean;
  requireMapKeys?: boolean;
  validateEmails?: boolean;
}

export function emptyContactFields(): ContactMutationFields {
  return {
    fullName: null,
    emails: [],
    phones: [],
    links: [],
    anniversaries: [],
    notes: [],
    organizations: [],
    titles: [],
    photo: null,
  };
}

export function contactMutationFieldsFromDetail(
  detail: ContactDetail,
): ContactMutationFields {
  return {
    fullName: detail.full_name,
    emails: detail.emails.map((email) => ({
      ...email,
      contexts: [...email.contexts],
    })),
    phones: detail.phones.map((phone) => ({
      ...phone,
      contexts: [...phone.contexts],
      features: [...phone.features],
    })),
    links: detail.links.map((link) => ({
      ...link,
      contexts: [...link.contexts],
    })),
    anniversaries: detail.anniversaries.map((anniversary) => ({
      ...anniversary,
      date: { ...anniversary.date },
    })),
    notes: detail.notes.map((note) => ({ ...note })),
    organizations: detail.organizations.map((organization) => ({
      ...organization,
      contexts: [...organization.contexts],
      units: organization.units.map((unit) => ({ ...unit })),
    })),
    titles: detail.titles.map((title) => ({ ...title })),
    photo: detail.photo ? { ...detail.photo } : null,
  };
}

export function legacyCreateContactFields(
  name: unknown,
  emails: unknown,
): ContactMutationFields {
  const fields = emptyContactFields();
  fields.fullName = typeof name === 'string' && name ? name : null;
  fields.emails = normalizeAddressList(emails).map((value, position) => ({
    mapKey: createContactMapKey('email'),
    position,
    value,
    label: null,
    contexts: [],
    pref: null,
    isPreferred: position === 0,
  }));
  return fields;
}

export function legacyUpdatedContactFields(
  current: ContactMutationFields,
  name: unknown,
  emails: unknown,
): ContactMutationFields {
  const available = new Map<string, ContactDetailEmail[]>();
  for (const email of current.emails) {
    const key = addressKey(email.value);
    if (!available.has(key)) available.set(key, []);
    available.get(key)?.push(email);
  }
  const nextEmails = normalizeAddressList(emails).map((value, position) => {
    const reused = available.get(addressKey(value))?.shift();
    if (reused) {
      return { ...reused, value, position };
    }
    return {
      mapKey: null,
      position,
      value,
      label: null,
      contexts: [],
      pref: null,
      isPreferred: false,
    };
  });
  return withContactDetailKeys({
    ...current,
    fullName: typeof name === 'string' ? name : current.fullName,
    emails: nextEmails,
  }, current);
}

export function withContactDetailKeys(
  fields: ContactMutationFields,
  baseline: ContactMutationFields | null,
): ContactMutationFields {
  const organizations = prepareDetailKeys(
    fields.organizations,
    baseline?.organizations ?? [],
    'organization',
    (organization) => JSON.stringify([
      organization.name,
      organization.units.map((unit) => unit.value),
    ]),
  );
  const organizationForms = new Map<string, string | null>();
  for (const organization of organizations) {
    const formId = organization.formId?.trim();
    if (!formId) continue;
    const previous = organizationForms.get(formId);
    organizationForms.set(
      formId,
      previous === undefined ? organization.mapKey : null,
    );
  }
  const titlesWithResolvedOrganizations = fields.titles.map((title) => {
    const formId = title.organizationFormId?.trim()
      || (title.organizationMapKey && organizationForms.has(title.organizationMapKey)
        ? title.organizationMapKey
        : null);
    if (!formId) return title;
    const organizationMapKey = organizationForms.get(formId);
    return organizationMapKey
      ? { ...title, organizationMapKey }
      : title;
  });
  return {
    ...fields,
    photo: fields.photo
      ? {
          ...fields.photo,
          mapKey: isContactMapKey(fields.photo.mapKey)
            ? fields.photo.mapKey
            : createContactMapKey('photo'),
        }
      : null,
    emails: prepareDetailKeys(
      fields.emails,
      baseline?.emails ?? [],
      'email',
      (email) => addressKey(email.value),
    ),
    phones: prepareDetailKeys(
      fields.phones,
      baseline?.phones ?? [],
      'phone',
      (phone) => phone.value,
    ),
    links: prepareDetailKeys(
      fields.links,
      baseline?.links ?? [],
      'link',
      (link) => link.value,
    ),
    anniversaries: prepareDetailKeys(
      fields.anniversaries,
      baseline?.anniversaries ?? [],
      'date',
      (anniversary) => `${anniversary.kind}:${JSON.stringify(anniversary.date)}`,
    ),
    notes: prepareDetailKeys(
      fields.notes,
      baseline?.notes ?? [],
      'note',
      (note) => note.value,
    ),
    organizations,
    titles: prepareDetailKeys(
      titlesWithResolvedOrganizations,
      baseline?.titles ?? [],
      'title',
      (title) => `${title.kind}:${title.organizationMapKey ?? ''}:${title.value}`,
    ),
  };
}

function prepareDetailKeys<T extends { mapKey: string | null; position: number }>(
  details: T[],
  previous: T[],
  prefix: string,
  identity: (detail: T) => string,
): T[] {
  const claimedPrevious = new Set<number>();
  const preservedDesired = new Set<number>();
  const ambiguousDesired = new Set<number>();
  const unkeyedPrevious = previous
    .map((detail, index) => ({ detail, index }))
    .filter(({ detail }) => detail.mapKey == null);

  details.forEach((detail, desiredIndex) => {
    if (detail.mapKey != null) return;
    const matches = unkeyedPrevious.filter(
      ({ detail: candidate, index }) => !claimedPrevious.has(index)
        && identity(candidate) === identity(detail),
    );
    if (matches.length === 1) {
      claimedPrevious.add(matches[0].index);
      preservedDesired.add(desiredIndex);
    } else if (matches.length > 1) {
      ambiguousDesired.add(desiredIndex);
    }
  });

  const remainingDesired = details.filter(
    (detail, index) => detail.mapKey == null
      && !preservedDesired.has(index)
      && !ambiguousDesired.has(index),
  ).length;
  const remainingPrevious = unkeyedPrevious.filter(
    ({ index }) => !claimedPrevious.has(index),
  ).length;
  details.forEach((detail, desiredIndex) => {
    if (
      detail.mapKey != null
      || preservedDesired.has(desiredIndex)
      || ambiguousDesired.has(desiredIndex)
    ) return;
    const matches = unkeyedPrevious.filter(
      ({ detail: candidate, index }) => !claimedPrevious.has(index)
        && candidate.position === detail.position,
    );
    if (matches.length === 1 && remainingPrevious <= remainingDesired) {
      claimedPrevious.add(matches[0].index);
      preservedDesired.add(desiredIndex);
    }
  });

  return details.map((detail, index) => (
    detail.mapKey != null || preservedDesired.has(index) || ambiguousDesired.has(index)
      ? detail
      : { ...detail, mapKey: createContactMapKey(prefix) }
  ));
}

export function contactFieldsAreEmpty(fields: ContactMutationFields): boolean {
  return !fields.fullName?.trim()
    && fields.emails.every((detail) => !detail.value.trim())
    && fields.phones.every((detail) => !detail.value.trim())
    && fields.links.every((detail) => !detail.value.trim())
    && fields.anniversaries.length === 0
    && fields.notes.every((detail) => !detail.value.trim())
    && fields.organizations.every(
      (organization) => !organization.name?.trim()
        && organization.units.every((unit) => !unit.value.trim()),
    )
    && fields.titles.every((detail) => !detail.value.trim())
    && !fields.photo;
}

export function validateContactFields(
  fields: ContactMutationFields,
  options: ContactFieldValidationOptions = {},
): ContactFieldValidationIssue | null {
  if (!fields || typeof fields !== 'object') return 'invalid-fields';
  const collections = [
    fields.emails,
    fields.phones,
    fields.links,
    fields.anniversaries,
    fields.notes,
    fields.organizations,
    fields.titles,
  ];
  if (collections.some((collection) => !Array.isArray(collection))) {
    return 'invalid-collection';
  }
  const photo = fields.photo ?? null;
  if (photo) {
    if (!isContactMapKey(photo.mapKey)) return 'invalid-map-key';
    const baselinePhoto = options.baseline?.photo ?? null;
    const unchanged = baselinePhoto != null
      && baselinePhoto.mapKey === photo.mapKey
      && baselinePhoto.uri === photo.uri
      && baselinePhoto.blobId === photo.blobId
      && baselinePhoto.mediaType === photo.mediaType
      && baselinePhoto.pref === photo.pref;
    if (!unchanged) {
      const valid = validatedContactPhotoDataUri(photo.uri);
      if (
        !valid
        || photo.blobId != null
        || photo.mediaType !== valid.mediaType
      ) {
        return 'invalid-photo';
      }
    }
  }
  for (const collection of collections) {
    const keys = new Set<string>();
    for (const detail of collection) {
      if (detail.mapKey == null && !options.requireMapKeys) continue;
      if (!isContactMapKey(detail.mapKey)) return 'invalid-map-key';
      if (keys.has(detail.mapKey)) return 'duplicate-map-key';
      keys.add(detail.mapKey);
    }
  }
  if (fields.emails.some((detail) => !detail.value?.trim())) return 'empty-email';
  if (options.validateEmails && fields.emails.some(
    (detail) => !isValidEmailAddress(detail.value),
  )) return 'invalid-email';
  if (fields.phones.some((detail) => !detail.value?.trim())) return 'empty-phone';
  if (fields.links.some((detail) => !detail.value?.trim())) return 'empty-website';
  const previousLinks = new Map(
    (options.baseline?.links ?? [])
      .filter((link) => isContactMapKey(link.mapKey))
      .map((link) => [link.mapKey, link.value]),
  );
  if (fields.links.some((link) => (
    (options.requireMapKeys || previousLinks.get(link.mapKey ?? '') !== link.value)
    && !isHttpContactWebsite(link.value)
  ))) return 'invalid-website';
  if (fields.notes.some((detail) => typeof detail.value !== 'string')) return 'invalid-note';
  const organizationKeys = new Set(
    fields.organizations
      .map((organization) => organization.mapKey)
      .filter(isContactMapKey),
  );
  const organizationsByFormId = new Map<string, typeof fields.organizations>();
  for (const organization of fields.organizations) {
    const formId = organization.formId?.trim();
    if (!formId) continue;
    const matches = organizationsByFormId.get(formId) ?? [];
    matches.push(organization);
    organizationsByFormId.set(formId, matches);
  }
  if ([...organizationsByFormId.values()].some((matches) => matches.length !== 1)) {
    return 'invalid-organization-reference';
  }
  if (fields.organizations.some((organization) => {
    if (
      organization.name?.trim()
      || organization.units.some((unit) => unit.value?.trim())
    ) return false;
    return !fields.titles.some((title) => (
      Boolean(title.value?.trim())
      && (
        title.organizationMapKey === organization.mapKey
        || (
          organization.formId?.trim()
          && title.organizationFormId?.trim() === organization.formId.trim()
        )
      )
    ));
  })) return 'empty-organization';
  if (fields.titles.some((title) => {
    const formId = title.organizationFormId?.trim();
    if (formId) {
      const matches = organizationsByFormId.get(formId) ?? [];
      if (
        matches.length !== 1
        || !isContactMapKey(matches[0].mapKey)
        || title.organizationMapKey !== matches[0].mapKey
      ) return true;
    }
    return title.organizationMapKey != null
      && !organizationKeys.has(title.organizationMapKey);
  })) return 'invalid-organization-reference';
  if (fields.titles.some((title) => (
    !title.value?.trim() || (title.kind !== 'role' && title.kind !== 'title')
  ))) return 'invalid-title';
  if (fields.anniversaries.some((anniversary) => (
    (anniversary.kind !== 'birth'
      && anniversary.kind !== 'death'
      && anniversary.kind !== 'wedding')
    || !isValidContactDate(anniversary.date)
  ))) return 'invalid-anniversary';
  if (options.rejectEmpty && contactFieldsAreEmpty(fields)) return 'empty-contact';
  return null;
}

export function isContactMapKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

export function isHttpContactWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.host);
  } catch {
    return false;
  }
}

export function isValidContactDate(date: ContactAnniversaryDate): boolean {
  if (date?.kind === 'timestamp') return isUtcDateTime(date.utc);
  if (date?.kind !== 'partial') return false;
  const { year, month, day } = date;
  if (year != null && (!Number.isSafeInteger(year) || year < 0)) return false;
  if (month != null && (!Number.isSafeInteger(month) || month < 1 || month > 12)) {
    return false;
  }
  if (day != null && (
    month == null
    || !Number.isSafeInteger(day)
    || day < 1
    || day > daysInMonth(year, month)
  )) return false;
  return year != null || month != null;
}

export function isUtcDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d*[1-9])?Z$/
    .exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 60;
}

function normalizeAddressList(emails: unknown): string[] {
  const list = Array.isArray(emails) ? emails : (emails == null ? [] : [emails]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const address = String(raw ?? '').trim();
    if (!address) continue;
    const key = addressKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

export function isValidEmailAddress(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

function daysInMonth(year: number | null, month: number): number {
  if (month === 2) {
    if (year == null) return 29;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
