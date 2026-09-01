/**
 * JSContact (RFC 9553) card normalization, protocol-free.
 *
 * Decodes a raw ContactCard into the flat detail shapes the DB layer and
 * the contact panes consume. Shared by the JMAP sync backend and the
 * contacts trash pane so both read a card the same way. Tolerates both
 * the keyed-map shape Stalwart serves (`addressBookIds`, `emails` as a
 * keyed map, `name.full`, `organizations`) and the older single-book /
 * flat-array shape used by some servers and the unit tests
 * (`addressBookId`, `emails: [...]`, `fullName`, `organization`).
 */

import type {
  ContactAnniversaryDate,
  ContactAnniversaryKind,
  ContactContext,
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
} from '../types/db';
import {
  isContactMapKey as isMapKey,
  isUtcDateTime,
  isValidContactDate,
} from './contact-fields';

export const STANDARD_CONTEXT_NAMES = ['private', 'work'] as const;
export const STANDARD_PHONE_FEATURE_NAMES = [
  'fax',
  'main-number',
  'mobile',
  'pager',
  'text',
  'textphone',
  'video',
  'voice',
] as const;

export interface NormalizedEmail {
  mapKey: string | null;
  position: number;
  email: string;
  label: string | null;
  contexts: ContactContext[];
  pref: number | null;
  isPreferred: boolean;
}

export interface NormalizedMedia extends ContactPhoto {
  kind: string;
  position: number;
}

export interface NormalizedCard {
  id: string;
  uid: string | null;
  bookRemoteIds: string[];
  fullName: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  organization: string | null;
  nicknames: string[];
  emails: NormalizedEmail[];
  phones: ContactDetailPhone[];
  links: ContactDetailLink[];
  anniversaries: ContactDetailAnniversary[];
  notes: ContactDetailNote[];
  organizations: ContactDetailOrganization[];
  titles: ContactDetailTitle[];
  media: NormalizedMedia[];
  raw: unknown;
}

export interface NormalizeMediaOptions {
  /**
   * Whether a `kind` padded with whitespace counts as its trimmed value.
   * Sync tolerates it; the trash pane matches the stored value exactly.
   */
  trimKind?: boolean;
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Normalize a ContactCard into the flat shape our DB layer expects. Returns
 * null for anything without a non-empty string `id`.
 */
export function normalizeCard(card: any): NormalizedCard | null {
  if (!isPlainObject(card) || typeof card.id !== 'string' || !card.id) return null;
  const bookRemoteIds = isPlainObject(card.addressBookIds)
    ? Object.keys(card.addressBookIds).filter(
        (id) => isMapKey(id) && card.addressBookIds[id] === true,
      )
    : (
        typeof card.addressBookId === 'string' && card.addressBookId
          ? [card.addressBookId]
          : []
      );

  const emails = normalizeEmails(card.emails);
  const phones = normalizePhones(card.phones);
  const links = normalizeLinks(card.links);
  const anniversaries = normalizeAnniversaries(card.anniversaries);
  const notes = normalizeNotes(card.notes);
  const organizations = normalizeOrganizations(card);
  const titles = normalizeTitles(card.titles, organizations);
  const media = normalizeMedia(card.media);
  const fullName = normalizeFullName(card);
  // RFC 9553 §2.2.1 carries given/family names as NameComponent entries,
  // keyed by `kind`; the flat name.given/name.surname reads stay as a
  // tolerance for the older non-RFC shape.
  const givenName = joinComponentValues(card.name, ['given'])
    ?? (isPlainObject(card.name) ? stringOrNull(card.name.given) : null);
  const familyName = joinComponentValues(card.name, ['surname', 'surname2'])
    ?? (
      isPlainObject(card.name)
        ? stringOrNull(card.name.surname) ?? stringOrNull(card.name.surnames)
        : null
    );
  const display = fullName
    ?? combineNameComponents(card.name)
    ?? emails[0]?.email
    ?? organizations.find((organization) => organization.name)?.name
    ?? phones[0]?.value
    ?? '(no name)';

  return {
    id: card.id,
    uid: stringOrNull(card.uid),
    bookRemoteIds,
    fullName,
    displayName: display,
    givenName,
    familyName,
    organization: organizations.find((organization) => organization.name)?.name ?? null,
    nicknames: normalizeNicknames(card.nicknames),
    emails,
    phones,
    links,
    anniversaries,
    notes,
    organizations,
    titles,
    media,
    raw: card,
  };
}

/** The card's `fullName`, else `name.full` for the RFC 9553 shape. */
export function normalizeFullName(card: any): string | null {
  return stringOrNull(card?.fullName)
    ?? (isPlainObject(card?.name) ? stringOrNull(card.name.full) : null);
}

/**
 * The names a card's `nicknames` map carries (RFC 9553 §2.2.2), for the
 * search tokens CS-3.2 asks for. Tolerates a flat array of strings the
 * way the other normalizers tolerate the pre-RFC shape.
 */
function normalizeNicknames(nicknames: any): string[] {
  if (!nicknames) return [];
  const entries = Array.isArray(nicknames) ? nicknames : Object.values(nicknames);
  const out: string[] = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

export function normalizeEmails(emails: any): NormalizedEmail[] {
  if (!emails) return [];
  const out: NormalizedEmail[] = [];
  for (const [mapKey, e] of normalizedMapEntries(emails)) {
    if (typeof e === 'string') {
      if (!e) continue;
      out.push({
        mapKey,
        position: out.length,
        email: e,
        label: null,
        contexts: [],
        pref: null,
        isPreferred: false,
      });
      continue;
    }
    if (!isTypedObject(e, 'EmailAddress')) continue;
    const email = typeof e.address === 'string'
      ? e.address
      : (typeof e.email === 'string' ? e.email : null);
    if (!email) continue;
    out.push({
      mapKey,
      position: out.length,
      email,
      label: stringOrNull(e.label),
      contexts: standardContexts(e.contexts),
      pref: preference(e.pref),
      isPreferred: e.isDefault === true,
    });
  }
  // RFC 9553 §1.5.3: pref is a 1-100 ordering, lower is more preferred, and
  // an address without one is least preferred. Exactly the most-preferred
  // address is marked (ties go to the first listed).
  const best = out.reduce<number | null>(
    (min, email) => (
      email.pref != null && (min == null || email.pref < min) ? email.pref : min
    ),
    null,
  );
  if (best != null) {
    const winner = out.findIndex((email) => email.pref === best);
    out.forEach((e, i) => { e.isPreferred = i === winner; });
  }
  return out;
}

/** A normalized email as the `ContactDetailEmail` the panes and patches use. */
export function toContactDetailEmail(email: NormalizedEmail): ContactDetailEmail {
  return {
    mapKey: email.mapKey,
    position: email.position,
    value: email.email,
    label: email.label,
    contexts: [...email.contexts],
    pref: email.pref,
    isPreferred: email.isPreferred,
  };
}

export function normalizeMedia(
  value: unknown,
  { trimKind = true }: NormalizeMediaOptions = {},
): NormalizedMedia[] {
  const media: NormalizedMedia[] = [];
  for (const [mapKey, item] of normalizedMapEntries(value)) {
    if (!isMapKey(mapKey) || !isTypedObject(item, 'Media')) continue;
    const rawKind = typeof item.kind === 'string' ? item.kind : '';
    const kind = trimKind ? rawKind.trim() : rawKind;
    const uri = stringOrNull(item.uri);
    const blobId = stringOrNull(item.blobId);
    if (!kind || (!uri && !blobId)) continue;
    media.push({
      mapKey,
      position: media.length,
      kind,
      uri,
      blobId,
      mediaType: stringOrNull(item.mediaType),
      pref: preference(item.pref),
    });
  }
  return media;
}

export function preferredPhoto(media: NormalizedMedia[]): ContactPhoto | null {
  const photos = media.filter((item) => item.kind === 'photo');
  photos.sort((left, right) => {
    if (left.pref == null && right.pref != null) return 1;
    if (left.pref != null && right.pref == null) return -1;
    if (left.pref != null && right.pref != null && left.pref !== right.pref) {
      return left.pref - right.pref;
    }
    return left.position - right.position;
  });
  const photo = photos[0];
  if (!photo) return null;
  return {
    mapKey: photo.mapKey,
    uri: photo.uri,
    blobId: photo.blobId,
    mediaType: photo.mediaType,
    pref: photo.pref,
  };
}

export function normalizePhones(phones: any): ContactDetailPhone[] {
  const out: ContactDetailPhone[] = [];
  for (const [mapKey, phone] of normalizedMapEntries(phones)) {
    if (typeof phone === 'string') {
      if (phone) {
        out.push({
          mapKey,
          position: out.length,
          value: phone,
          label: null,
          contexts: [],
          features: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(phone, 'Phone') || typeof phone.number !== 'string' || !phone.number) {
      continue;
    }
    out.push({
      mapKey,
      position: out.length,
      value: phone.number,
      label: stringOrNull(phone.label),
      contexts: standardContexts(phone.contexts),
      features: standardPhoneFeatures(phone.features),
      pref: preference(phone.pref),
    });
  }
  return out;
}

export function normalizeLinks(links: any): ContactDetailLink[] {
  const out: ContactDetailLink[] = [];
  for (const [mapKey, link] of normalizedMapEntries(links)) {
    if (typeof link === 'string') {
      if (link) {
        out.push({
          mapKey,
          position: out.length,
          value: link,
          label: null,
          contexts: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(link, 'Link')) continue;
    const uri = typeof link.uri === 'string'
      ? link.uri
      : (typeof link.url === 'string' ? link.url : null);
    if (!uri) continue;
    out.push({
      mapKey,
      position: out.length,
      value: uri,
      label: stringOrNull(link.label),
      contexts: standardContexts(link.contexts),
      pref: preference(link.pref),
    });
  }
  return out;
}

export function normalizeAnniversaries(anniversaries: any): ContactDetailAnniversary[] {
  const out: ContactDetailAnniversary[] = [];
  for (const [mapKey, anniversary] of normalizedMapEntries(anniversaries)) {
    if (!isTypedObject(anniversary, 'Anniversary')) continue;
    if (!isAnniversaryKind(anniversary.kind)) continue;
    const date = normalizeAnniversaryDate(anniversary.date);
    if (!date) continue;
    out.push({
      mapKey,
      position: out.length,
      kind: anniversary.kind,
      date,
    });
  }
  return out;
}

export function normalizeNotes(notes: any): ContactDetailNote[] {
  const out: ContactDetailNote[] = [];
  for (const [mapKey, note] of normalizedMapEntries(notes)) {
    if (typeof note === 'string') {
      if (note) out.push({ mapKey, position: out.length, value: note });
      continue;
    }
    if (!isTypedObject(note, 'Note') || typeof note.note !== 'string') continue;
    out.push({ mapKey, position: out.length, value: note.note });
  }
  return out;
}

/**
 * Organizations of a card. Takes the whole card because an organization
 * that is empty apart from being referenced by a title is still kept.
 */
export function normalizeOrganizations(card: any): ContactDetailOrganization[] {
  const source = card.organizations ?? (
    card.organization == null ? null : [card.organization]
  );
  const referencedOrganizationKeys = new Set(
    normalizedMapEntries(card.titles)
      .map(([, title]) => (
        isTypedObject(title, 'Title') && typeof title.organizationId === 'string'
          ? title.organizationId
          : null
      ))
      .filter((value): value is string => value != null),
  );
  const out: ContactDetailOrganization[] = [];
  for (const [mapKey, organization] of normalizedMapEntries(source)) {
    if (typeof organization === 'string') {
      if (organization) {
        out.push({
          mapKey,
          position: out.length,
          name: organization,
          contexts: [],
          units: [],
        });
      }
      continue;
    }
    if (!isTypedObject(organization, 'Organization')) continue;
    const name = stringOrNull(organization.name);
    const units = normalizeOrganizationUnits(organization.units);
    if (
      name == null
      && units.length === 0
      && (mapKey == null || !referencedOrganizationKeys.has(mapKey))
    ) continue;
    out.push({
      mapKey,
      position: out.length,
      name,
      contexts: standardContexts(organization.contexts),
      units,
    });
  }
  return out;
}

function normalizeOrganizationUnits(units: any): ContactDetailOrganization['units'] {
  if (!Array.isArray(units)) return [];
  const out: ContactDetailOrganization['units'] = [];
  for (const unit of units) {
    const value = typeof unit === 'string'
      ? unit
      : (
          isTypedObject(unit, 'OrgUnit') && typeof unit.name === 'string'
            ? unit.name
            : null
        );
    if (value) out.push({ position: out.length, value });
  }
  return out;
}

export function normalizeTitles(
  titles: any,
  organizations: ContactDetailOrganization[] = [],
): ContactDetailTitle[] {
  const exposedOrganizationKeys = new Set(
    organizations
      .map((organization) => organization.mapKey)
      .filter((mapKey): mapKey is string => isMapKey(mapKey)),
  );
  const out: ContactDetailTitle[] = [];
  for (const [mapKey, title] of normalizedMapEntries(titles)) {
    if (!isTypedObject(title, 'Title') || typeof title.name !== 'string' || !title.name) {
      continue;
    }
    const kind = title.kind == null ? 'title' : title.kind;
    if (!isTitleKind(kind)) continue;
    out.push({
      mapKey,
      position: out.length,
      value: title.name,
      kind,
      organizationMapKey: typeof title.organizationId === 'string'
        && exposedOrganizationKeys.has(title.organizationId)
          ? title.organizationId
          : null,
    });
  }
  return out;
}

function normalizedMapEntries(value: any): Array<[string | null, any]> {
  if (Array.isArray(value)) return value.map((entry) => [null, entry]);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(([key]) => isMapKey(key))
    .map(([key, entry]) => [key, entry]);
}

export function isTypedObject(value: any, expectedType: string): value is Record<string, any> {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value['@type'] == null || value['@type'] === expectedType),
  );
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function preference(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100
    ? Number(value)
    : null;
}

function standardContexts(value: any): ContactContext[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return STANDARD_CONTEXT_NAMES.filter((context) => value[context] === true);
}

function standardPhoneFeatures(value: any): ContactPhoneFeature[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return STANDARD_PHONE_FEATURE_NAMES.filter((feature) => value[feature] === true);
}

function isAnniversaryKind(value: unknown): value is ContactAnniversaryKind {
  return value === 'birth' || value === 'death' || value === 'wedding';
}

function isTitleKind(value: unknown): value is ContactTitleKind {
  return value === 'role' || value === 'title';
}

function normalizeAnniversaryDate(value: any): ContactAnniversaryDate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value['@type'] === 'Timestamp') {
    return isUtcDateTime(value.utc) ? { kind: 'timestamp', utc: value.utc } : null;
  }
  if (value['@type'] != null && value['@type'] !== 'PartialDate') return null;
  const year = optionalUnsignedInteger(value, 'year');
  const month = optionalUnsignedInteger(value, 'month');
  const day = optionalUnsignedInteger(value, 'day');
  if (year === undefined || month === undefined || day === undefined) return null;
  if (month != null && (month < 1 || month > 12)) return null;
  const normalized: ContactAnniversaryDate = { kind: 'partial', year, month, day };
  return isValidContactDate(normalized) ? normalized : null;
}

function optionalUnsignedInteger(
  value: Record<string, unknown>,
  property: string,
): number | null | undefined {
  if (!(property in value)) return null;
  const candidate = value[property];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : undefined;
}

/** The values of the RFC 9553 §2.2.1.2 name components of the given kinds. */
function componentValues(name: any, kinds: readonly string[]): string[] {
  if (!Array.isArray(name?.components)) return [];
  return name.components
    .filter((c: any) => kinds.includes(c?.kind) && typeof c?.value === 'string' && c.value)
    .map((c: any) => c.value as string);
}

function joinComponentValues(name: any, kinds: readonly string[]): string | null {
  const values = componentValues(name, kinds);
  return values.length > 0 ? values.join(' ') : null;
}

/**
 * A display name assembled from a structured Name. RFC 9553 §2.2.1.1 makes
 * `full` optional once `components` is set, so a components-only card must
 * still get a readable name: its component values in listed order, joined
 * by `defaultSeparator` when the card names one. The flat given/surname
 * reads remain as a tolerance for the older non-RFC shape.
 */
function combineNameComponents(name: any): string | null {
  if (!name) return null;
  if (Array.isArray(name.components)) {
    const parts = name.components
      .filter((c: any) => c?.kind !== 'separator' && typeof c?.value === 'string' && c.value)
      .map((c: any) => c.value as string);
    if (parts.length > 0) {
      const separator = typeof name.defaultSeparator === 'string' && name.defaultSeparator
        ? name.defaultSeparator
        : ' ';
      return parts.join(separator);
    }
  }
  const parts = [name.given, name.surname].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}
