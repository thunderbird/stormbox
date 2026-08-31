<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
} from 'vue';

import type {
  ContactDetail,
  ContactDetailResource,
} from '../../types';
import { isHttpContactWebsite } from '../../utils/contact-fields';
import {
  contactAnniversaryKindLabel,
  contactResourceLabel,
  formatContactDate,
  type ContactEditorResource,
  type ContactResourceKind,
} from './contact-editor';
import ContactAvatar from './ContactAvatar.vue';

const props = withDefaults(defineProps<{
  addressbookNames?: string[];
  detail: ContactDetail;
  eyebrow?: string;
  expiryLabel?: string;
}>(), {
  addressbookNames: () => [],
  eyebrow: '',
  expiryLabel: '',
});

const headingEl = ref<HTMLHeadingElement | null>(null);
const title = computed(() =>
  props.detail.full_name?.trim()
    || props.detail.display_name?.trim()
    || '(no name)');
const preferredEmail = computed(() =>
  props.detail.emails.find((email) => email.isPreferred)?.value
    ?? props.detail.emails[0]?.value
    ?? null);

function labelFor(
  kind: ContactResourceKind,
  resource: ContactDetailResource,
): string {
  return contactResourceLabel(kind, {
    ...resource,
    formKey: resource.mapKey ?? '',
  } as ContactEditorResource);
}

function titlesForOrganization(
  organizationMapKey: string | null,
): ContactDetail['titles'] {
  return props.detail.titles.filter((title) =>
    organizationMapKey != null
      && title.organizationMapKey === organizationMapKey);
}

const unlinkedTitles = computed(() => {
  const organizationKeys = new Set(
    props.detail.organizations
      .map((organization) => organization.mapKey)
      .filter((mapKey): mapKey is string => Boolean(mapKey)),
  );
  return props.detail.titles.filter((title) =>
    title.organizationMapKey == null
    || !organizationKeys.has(title.organizationMapKey));
});

async function focusHeading(): Promise<void> {
  await nextTick();
  headingEl.value?.focus();
}

defineExpose({ focusHeading });
</script>

<template>
  <div class="contact-detail__body">
    <p v-if="eyebrow" class="contact-detail__eyebrow">{{ eyebrow }}</p>
    <div class="contact-detail__avatar">
      <ContactAvatar
        :email="preferredEmail"
        :name="title"
        :photo="detail.photo"
        size="large"
      />
    </div>
    <h2
      ref="headingEl"
      class="contact-detail__display-name"
      tabindex="-1"
    >
      {{ title }}
    </h2>
    <p v-if="expiryLabel" class="contact-detail__expiry">
      Available until {{ expiryLabel }}
    </p>

    <section v-if="detail.emails.length > 0">
      <h3>Email addresses</h3>
      <dl>
        <template v-for="email in detail.emails" :key="email.mapKey ?? email.position">
          <dt>{{ labelFor('email', email) }}</dt>
          <dd>
            <a :href="`mailto:${email.value}`">{{ email.value }}</a>
            <span v-if="email.isPreferred" class="contact-detail__primary">Primary</span>
          </dd>
        </template>
      </dl>
    </section>

    <section v-if="detail.phones.length > 0">
      <h3>Phone numbers</h3>
      <dl>
        <template v-for="phone in detail.phones" :key="phone.mapKey ?? phone.position">
          <dt>{{ labelFor('phone', phone) }}</dt>
          <dd><a :href="`tel:${phone.value}`">{{ phone.value }}</a></dd>
        </template>
      </dl>
    </section>

    <section v-if="detail.links.length > 0">
      <h3>Websites</h3>
      <dl>
        <template v-for="link in detail.links" :key="link.mapKey ?? link.position">
          <dt>{{ labelFor('website', link) }}</dt>
          <dd>
            <a
              v-if="isHttpContactWebsite(link.value)"
              :href="link.value"
              target="_blank"
              rel="noopener noreferrer"
            >{{ link.value }}</a>
            <span v-else>{{ link.value }}</span>
          </dd>
        </template>
      </dl>
    </section>

    <section v-if="detail.anniversaries.length > 0">
      <h3>Dates</h3>
      <dl>
        <template
          v-for="anniversary in detail.anniversaries"
          :key="anniversary.mapKey ?? anniversary.position"
        >
          <dt>{{ contactAnniversaryKindLabel(anniversary.kind) }}</dt>
          <dd>{{ formatContactDate(anniversary.date) }}</dd>
        </template>
      </dl>
    </section>

    <section v-if="detail.notes.length > 0">
      <h3>Notes</h3>
      <p
        v-for="note in detail.notes"
        :key="note.mapKey ?? note.position"
        class="contact-detail__note"
      >
        {{ note.value }}
      </p>
    </section>

    <section v-if="detail.organizations.length > 0 || unlinkedTitles.length > 0">
      <h3>Work affiliations</h3>
      <div
        v-for="organization in detail.organizations"
        :key="organization.mapKey ?? organization.position"
        class="contact-detail__affiliation"
      >
        <strong>{{ organization.name || 'Work' }}</strong>
        <p v-if="organization.units.length > 0">
          {{ organization.units.map((unit) => unit.value).join(' · ') }}
        </p>
        <p
          v-for="title in titlesForOrganization(organization.mapKey)"
          :key="title.mapKey ?? title.position"
        >
          {{ title.kind === 'title' ? 'Title' : 'Role' }}: {{ title.value }}
        </p>
      </div>
      <p
        v-for="title in unlinkedTitles"
        :key="title.mapKey ?? title.position"
        class="contact-detail__affiliation"
      >
        {{ title.kind === 'title' ? 'Title' : 'Role' }}: {{ title.value }}
      </p>
    </section>

    <section>
      <h3>Address books</h3>
      <p>{{ addressbookNames.length > 0 ? addressbookNames.join(', ') : 'None' }}</p>
    </section>

    <p
      v-if="
        detail.emails.length === 0
          && detail.phones.length === 0
          && detail.links.length === 0
          && detail.anniversaries.length === 0
          && detail.notes.length === 0
          && detail.organizations.length === 0
          && detail.titles.length === 0
      "
      class="contact-detail__empty"
    >
      No additional contact details.
    </p>
  </div>
</template>

<style scoped>
.contact-detail__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 20px;
  padding: 20px;
}

.contact-detail__body > * {
  width: min(100%, 480px);
  justify-self: center;
}

.contact-detail__display-name {
  min-width: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}

.contact-detail__avatar {
  display: grid;
  place-items: center;
}

.contact-detail__display-name:focus-visible {
  border-radius: 3px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.contact-detail__eyebrow,
.contact-detail__expiry {
  margin: 0;
  color: var(--muted, #6b7388);
}

.contact-detail__eyebrow {
  margin-bottom: -12px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.contact-detail__expiry {
  margin-top: -12px;
}

.contact-detail__body section {
  min-width: 0;
}

.contact-detail__body h3 {
  margin: 0 0 8px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-detail__body dl {
  display: grid;
  grid-template-columns: minmax(80px, 0.35fr) minmax(0, 1fr);
  gap: 7px 12px;
  margin: 0;
}

.contact-detail__body dt {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.contact-detail__body dd,
.contact-detail__body p {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.contact-detail__body a {
  color: var(--accent);
}

.contact-detail__primary {
  margin-left: 7px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.contact-detail__note {
  white-space: pre-wrap;
}

.contact-detail__affiliation {
  margin-bottom: 9px !important;
  padding: 10px 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
}

.contact-detail__affiliation p {
  margin-top: 3px;
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.contact-detail__empty {
  color: var(--muted, #6b7388);
  font-size: 12px;
}
</style>
