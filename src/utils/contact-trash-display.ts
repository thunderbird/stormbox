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
  ContactDetailPhone,
  ContactDetailTitle,
  ContactPhoneFeature,
  ContactPhoto,
  ContactTitleKind,
  ContactTrashDetail,
} from '../types';
import {
  isContactMapKey,
  isUtcDateTime,
  isValidContactDate,
} from './contact-fields';

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mapEntries(value: unknown): Array<[string | null, unknown]> {
  if (Array.isArray(value)) return value.map((entry) => [null, entry]);
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([key]) => isContactMapKey(key));
}

function isTypedObject(value: unknown, expectedType: string): value is RawRecord {
  return isRecord(value)
    && (value['@type'] == null || value['@type'] === expectedType);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function preference(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100
    ? Number(value)
    : null;
}

function standardContexts(value: unknown): ContactContext[] {
  if (!isRecord(value)) return [];
  return (['private', 'work'] as const).filter((context) => value[context] === true);
}

function standardPhoneFeatures(value: unknown): ContactPhoneFeature[] {
  if (!isRecord(value)) return [];
  return ([
    'fax',
    'main-number',
    'mobile',
    'pager',
    'text',
    'textphone',
    'video',
    'voice',
  ] as const).filter((feature) => value[feature] === true);
}

function normalizePhoto(value: unknown): ContactPhoto | null {
  const photos = mapEntries(value).flatMap(([mapKey, item]) => {
    if (
      !mapKey
      || !isTypedObject(item, 'Media')
      || item.kind !== 'photo'
    ) {
      return [];
    }
    const uri = stringOrNull(item.uri);
    const blobId = stringOrNull(item.blobId);
    if (!uri && !blobId) return [];
    return [{
      mapKey,
      uri,
      blobId,
      mediaType: stringOrNull(item.mediaType),
      pref: preference(item.pref),
    }];
  });
  photos.sort((left, right) => {
    if (left.pref == null && right.pref != null) return 1;
    if (left.pref != null && right.pref == null) return -1;
    return (left.pref ?? 101) - (right.pref ?? 101);
  });
  return photos[0] ?? null;
}

function normalizeEmails(value: unknown): ContactDetailEmail[] {
  const emails: ContactDetailEmail[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (typeof item === 'string') {
      if (item) {
        emails.push({
          mapKey,
          position: emails.length,
          value: item,
          label: null,
          contexts: [],
          pref: null,
          isPreferred: false,
        });
      }
      continue;
    }
    if (!isTypedObject(item, 'EmailAddress')) continue;
    const address = typeof item.address === 'string'
      ? item.address
      : (typeof item.email === 'string' ? item.email : null);
    if (!address) continue;
    emails.push({
      mapKey,
      position: emails.length,
      value: address,
      label: stringOrNull(item.label),
      contexts: standardContexts(item.contexts),
      pref: preference(item.pref),
      isPreferred: item.isDefault === true,
    });
  }
  const best = emails.reduce<number | null>(
    (min, email) => (
      email.pref != null && (min == null || email.pref < min) ? email.pref : min
    ),
    null,
  );
  if (best != null) {
    const winner = emails.findIndex((email) => email.pref === best);
    emails.forEach((email, index) => { email.isPreferred = index === winner; });
  }
  return emails;
}

function normalizePhones(value: unknown): ContactDetailPhone[] {
  const phones: ContactDetailPhone[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (typeof item === 'string') {
      if (item) {
        phones.push({
          mapKey,
          position: phones.length,
          value: item,
          label: null,
          contexts: [],
          features: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(item, 'Phone') || typeof item.number !== 'string' || !item.number) {
      continue;
    }
    phones.push({
      mapKey,
      position: phones.length,
      value: item.number,
      label: stringOrNull(item.label),
      contexts: standardContexts(item.contexts),
      features: standardPhoneFeatures(item.features),
      pref: preference(item.pref),
    });
  }
  return phones;
}

function normalizeLinks(value: unknown): ContactDetailLink[] {
  const links: ContactDetailLink[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (typeof item === 'string') {
      if (item) {
        links.push({
          mapKey,
          position: links.length,
          value: item,
          label: null,
          contexts: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(item, 'Link')) continue;
    const uri = typeof item.uri === 'string'
      ? item.uri
      : (typeof item.url === 'string' ? item.url : null);
    if (!uri) continue;
    links.push({
      mapKey,
      position: links.length,
      value: uri,
      label: stringOrNull(item.label),
      contexts: standardContexts(item.contexts),
      pref: preference(item.pref),
    });
  }
  return links;
}

function isAnniversaryKind(value: unknown): value is ContactAnniversaryKind {
  return value === 'birth' || value === 'death' || value === 'wedding';
}

function optionalUnsignedInteger(
  value: RawRecord,
  property: string,
): number | null | undefined {
  if (!(property in value)) return null;
  const candidate = value[property];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : undefined;
}

function normalizeDate(value: unknown): ContactAnniversaryDate | null {
  if (!isRecord(value)) return null;
  if (value['@type'] === 'Timestamp') {
    return isUtcDateTime(value.utc) ? { kind: 'timestamp', utc: value.utc } : null;
  }
  if (value['@type'] != null && value['@type'] !== 'PartialDate') return null;
  const year = optionalUnsignedInteger(value, 'year');
  const month = optionalUnsignedInteger(value, 'month');
  const day = optionalUnsignedInteger(value, 'day');
  if (year === undefined || month === undefined || day === undefined) return null;
  const date: ContactAnniversaryDate = { kind: 'partial', year, month, day };
  return isValidContactDate(date) ? date : null;
}

function normalizeAnniversaries(value: unknown): ContactDetailAnniversary[] {
  const anniversaries: ContactDetailAnniversary[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (!isTypedObject(item, 'Anniversary') || !isAnniversaryKind(item.kind)) continue;
    const date = normalizeDate(item.date);
    if (!date) continue;
    anniversaries.push({
      mapKey,
      position: anniversaries.length,
      kind: item.kind,
      date,
    });
  }
  return anniversaries;
}

function normalizeNotes(value: unknown): ContactDetailNote[] {
  const notes: ContactDetailNote[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (typeof item === 'string') {
      if (item) notes.push({ mapKey, position: notes.length, value: item });
      continue;
    }
    if (!isTypedObject(item, 'Note') || typeof item.note !== 'string') continue;
    notes.push({ mapKey, position: notes.length, value: item.note });
  }
  return notes;
}

function normalizeOrganizationUnits(value: unknown): ContactDetailOrganization['units'] {
  if (!Array.isArray(value)) return [];
  const units: ContactDetailOrganization['units'] = [];
  for (const item of value) {
    const name = typeof item === 'string'
      ? item
      : (
          isTypedObject(item, 'OrgUnit') && typeof item.name === 'string'
            ? item.name
            : null
        );
    if (name) units.push({ position: units.length, value: name });
  }
  return units;
}

function normalizeOrganizations(snapshot: RawRecord): ContactDetailOrganization[] {
  const source = snapshot.organizations ?? (
    snapshot.organization == null ? null : [snapshot.organization]
  );
  const referencedKeys = new Set(
    mapEntries(snapshot.titles)
      .map(([, item]) => (
        isTypedObject(item, 'Title') && typeof item.organizationId === 'string'
          ? item.organizationId
          : null
      ))
      .filter((key): key is string => key != null),
  );
  const organizations: ContactDetailOrganization[] = [];
  for (const [mapKey, item] of mapEntries(source)) {
    if (typeof item === 'string') {
      if (item) {
        organizations.push({
          mapKey,
          position: organizations.length,
          name: item,
          contexts: [],
          units: [],
        });
      }
      continue;
    }
    if (!isTypedObject(item, 'Organization')) continue;
    const name = stringOrNull(item.name);
    const units = normalizeOrganizationUnits(item.units);
    if (
      name == null
      && units.length === 0
      && (mapKey == null || !referencedKeys.has(mapKey))
    ) {
      continue;
    }
    organizations.push({
      mapKey,
      position: organizations.length,
      name,
      contexts: standardContexts(item.contexts),
      units,
    });
  }
  return organizations;
}

function isTitleKind(value: unknown): value is ContactTitleKind {
  return value === 'role' || value === 'title';
}

function normalizeTitles(
  value: unknown,
  organizations: ContactDetailOrganization[],
): ContactDetailTitle[] {
  const organizationKeys = new Set(
    organizations
      .map((organization) => organization.mapKey)
      .filter((key): key is string => key != null),
  );
  const titles: ContactDetailTitle[] = [];
  for (const [mapKey, item] of mapEntries(value)) {
    if (!isTypedObject(item, 'Title') || typeof item.name !== 'string' || !item.name) {
      continue;
    }
    const kind = item.kind == null ? 'title' : item.kind;
    if (!isTitleKind(kind)) continue;
    titles.push({
      mapKey,
      position: titles.length,
      value: item.name,
      kind,
      organizationMapKey: typeof item.organizationId === 'string'
        && organizationKeys.has(item.organizationId)
          ? item.organizationId
          : null,
    });
  }
  return titles;
}

function fullNameFromSnapshot(snapshot: RawRecord): string | null {
  const fullName = stringOrNull(snapshot.fullName);
  if (fullName != null) return fullName;
  return isRecord(snapshot.name) ? stringOrNull(snapshot.name.full) : null;
}

export function contactDetailFromTrash(detail: ContactTrashDetail): ContactDetail {
  const snapshot = detail.snapshot;
  const organizations = normalizeOrganizations(snapshot);
  const emails = normalizeEmails(snapshot.emails);
  if (emails.length === 0 && detail.primary_email) {
    emails.push({
      mapKey: null,
      position: 0,
      value: detail.primary_email,
      label: null,
      contexts: [],
      pref: null,
      isPreferred: true,
    });
  }
  return {
    id: detail.id,
    remote_id: detail.prior_remote_id,
    addressbook_ids: [],
    display_name: detail.display_name,
    full_name: fullNameFromSnapshot(snapshot),
    emails,
    phones: normalizePhones(snapshot.phones),
    links: normalizeLinks(snapshot.links),
    anniversaries: normalizeAnniversaries(snapshot.anniversaries),
    notes: normalizeNotes(snapshot.notes),
    organizations,
    titles: normalizeTitles(snapshot.titles, organizations),
    photo: normalizePhoto(snapshot.media),
  };
}
