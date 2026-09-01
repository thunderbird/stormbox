import type { ContactDetail, ContactTrashDetail } from '../types';
import {
  normalizeAnniversaries,
  normalizeEmails,
  normalizeFullName,
  normalizeLinks,
  normalizeMedia,
  normalizeNotes,
  normalizeOrganizations,
  normalizePhones,
  normalizeTitles,
  preferredPhoto,
  toContactDetailEmail,
} from './contact-card-normalization';

export function contactDetailFromTrash(detail: ContactTrashDetail): ContactDetail {
  const snapshot = detail.snapshot;
  const organizations = normalizeOrganizations(snapshot);
  const emails = normalizeEmails(snapshot.emails).map(toContactDetailEmail);
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
    full_name: normalizeFullName(snapshot),
    emails,
    phones: normalizePhones(snapshot.phones),
    links: normalizeLinks(snapshot.links),
    anniversaries: normalizeAnniversaries(snapshot.anniversaries),
    notes: normalizeNotes(snapshot.notes),
    organizations,
    titles: normalizeTitles(snapshot.titles, organizations),
    // The pane shows the stored card as-is, so a media kind is matched
    // exactly rather than trimmed the way sync tolerates it.
    photo: preferredPhoto(normalizeMedia(snapshot.media, { trimKind: false })),
  };
}
