<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
} from 'vue';
import { Plus, Trash2 } from '@lucide/vue';

import type { ContactTitleKind } from '../../types';
import { closeContainingDropdown } from '../../utils/dropdown';
import AppDropdown from '../AppDropdown.vue';
import {
  createContactEditorOrganization,
  createContactEditorTitle,
  organizationAdditionalDetails,
  setPrimaryOrganizationUnit,
  type ContactEditorOrganization,
  type ContactEditorTitle,
} from './contact-editor';

const props = defineProps<{
  organizations: ContactEditorOrganization[];
  titles: ContactEditorTitle[];
}>();

const emit = defineEmits<{
  'update:organizations': [organizations: ContactEditorOrganization[]];
  'update:titles': [titles: ContactEditorTitle[]];
}>();

const selectedFormId = ref<string | null>(null);
const organizationNameEl = ref<HTMLInputElement | null>(null);
const selectedOrganization = computed(() =>
  props.organizations.find((organization) =>
    organization.formId === selectedFormId.value) ?? null);
const unlinkedTitles = computed(() => props.titles.filter((title) =>
  !props.organizations.some((organization) => titleBelongsTo(title, organization))));

watch(
  () => props.organizations.map((organization) => organization.formId).join('\u0000'),
  () => {
    if (props.organizations.some((organization) =>
      organization.formId === selectedFormId.value)) return;
    selectedFormId.value = props.organizations[0]?.formId ?? null;
  },
  { immediate: true },
);

function titleBelongsTo(
  title: ContactEditorTitle,
  organization: ContactEditorOrganization,
): boolean {
  return title.organizationFormId === organization.formId
    || (organization.mapKey != null
      && title.organizationMapKey === organization.mapKey);
}

function linkedTitles(
  organization: ContactEditorOrganization,
  kind?: ContactTitleKind,
): ContactEditorTitle[] {
  return props.titles
    .filter((title) => titleBelongsTo(title, organization))
    .filter((title) => kind == null || title.kind === kind)
    .sort((left, right) => left.position - right.position);
}

function primaryTitle(kind: ContactTitleKind): ContactEditorTitle | null {
  const organization = selectedOrganization.value;
  if (!organization) return null;
  return linkedTitles(organization, kind)[0] ?? null;
}

function affiliationLabel(
  organization: ContactEditorOrganization,
  index: number,
): string {
  return organization.name?.trim()
    || organization.units[0]?.value.trim()
    || `Work ${index + 1}`;
}

function affiliationSummary(organization: ContactEditorOrganization): string {
  const detail = [
    organization.units[0]?.value.trim(),
    linkedTitles(organization, 'title')[0]?.value.trim(),
    linkedTitles(organization, 'role')[0]?.value.trim(),
  ].filter(Boolean);
  return detail.join(' · ') || 'No details yet';
}

function chooseOrganization(formId: string, event: Event): void {
  selectedFormId.value = formId;
  closeContainingDropdown(event);
}

async function addOrganization(): Promise<void> {
  const organization = createContactEditorOrganization(props.organizations.length);
  emit('update:organizations', [...props.organizations, organization]);
  selectedFormId.value = organization.formId;
  await nextTick();
  organizationNameEl.value?.focus();
}

function updateOrganization(
  patch: Partial<ContactEditorOrganization>,
): void {
  const organization = selectedOrganization.value;
  if (!organization) return;
  emit(
    'update:organizations',
    props.organizations.map((candidate) =>
      candidate.formId === organization.formId
        ? { ...candidate, ...patch }
        : candidate),
  );
}

function updateDepartment(value: string): void {
  const organization = selectedOrganization.value;
  if (!organization) return;
  const updated = setPrimaryOrganizationUnit(organization, value);
  emit(
    'update:organizations',
    props.organizations.map((candidate) =>
      candidate.formId === organization.formId ? updated : candidate),
  );
}

function updateTitle(kind: ContactTitleKind, value: string): void {
  const organization = selectedOrganization.value;
  if (!organization) return;
  const current = primaryTitle(kind);
  if (current) {
    emit(
      'update:titles',
      props.titles.map((title) =>
        title.formKey === current.formKey ? { ...title, value } : title),
    );
    return;
  }
  if (!value) return;
  const created = createContactEditorTitle(kind, organization, props.titles.length);
  created.value = value;
  emit('update:titles', [...props.titles, created]);
}

function removeSelectedOrganization(): void {
  const organization = selectedOrganization.value;
  if (!organization) return;
  const index = props.organizations.findIndex((candidate) =>
    candidate.formId === organization.formId);
  const remaining = props.organizations.filter((candidate) =>
    candidate.formId !== organization.formId);
  emit('update:organizations', remaining);
  emit(
    'update:titles',
    props.titles.filter((title) => !titleBelongsTo(title, organization)),
  );
  selectedFormId.value = remaining[index]?.formId
    ?? remaining[index - 1]?.formId
    ?? null;
}
</script>

<template>
  <fieldset class="contact-affiliations">
    <legend>Work affiliations</legend>
    <div class="contact-affiliations__toolbar">
      <AppDropdown v-if="organizations.length > 0" group="contact-affiliations">
        <summary
          class="contact-affiliations__summary app-dropdown__summary"
          aria-label="Choose work affiliation"
        >
          {{
            selectedOrganization
              ? affiliationLabel(
                selectedOrganization,
                organizations.findIndex((item) => item.formId === selectedOrganization?.formId),
              )
              : 'Choose work'
          }}
        </summary>
        <div class="app-dropdown__menu contact-affiliations__menu" role="menu">
          <button
            v-for="(organization, index) in organizations"
            :key="organization.formId"
            class="app-dropdown__item contact-affiliations__option"
            type="button"
            role="menuitemradio"
            :aria-checked="organization.formId === selectedFormId"
            @click="chooseOrganization(organization.formId, $event)"
          >
            <span aria-hidden="true">
              {{ organization.formId === selectedFormId ? '✓' : '' }}
            </span>
            <span>
              <strong>{{ affiliationLabel(organization, index) }}</strong>
              <small>{{ affiliationSummary(organization) }}</small>
            </span>
          </button>
        </div>
      </AppDropdown>
      <button
        class="contact-affiliations__add"
        type="button"
        @click="addOrganization"
      >
        <Plus :size="14" :stroke-width="2" aria-hidden="true" />
        <span>Add work</span>
      </button>
    </div>

    <div
      v-if="selectedOrganization"
      :key="selectedOrganization.formId"
      class="contact-affiliations__card"
      :data-organization-form-id="selectedOrganization.formId"
    >
      <label>
        <span>Organization</span>
        <input
          ref="organizationNameEl"
          class="contact-editor__input"
          type="text"
          :value="selectedOrganization.name ?? ''"
          autocomplete="organization"
          @input="updateOrganization({
            name: ($event.target as HTMLInputElement).value,
          })"
        />
      </label>
      <label>
        <span>Department</span>
        <input
          class="contact-editor__input"
          type="text"
          :value="selectedOrganization.units[0]?.value ?? ''"
          autocomplete="organization-title"
          @input="updateDepartment(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>Job title</span>
        <input
          class="contact-editor__input"
          type="text"
          :value="primaryTitle('title')?.value ?? ''"
          autocomplete="organization-title"
          @input="updateTitle('title', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>Role</span>
        <input
          class="contact-editor__input"
          type="text"
          :value="primaryTitle('role')?.value ?? ''"
          autocomplete="off"
          @input="updateTitle('role', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <ul
        v-if="organizationAdditionalDetails(selectedOrganization, titles).length > 0"
        class="contact-affiliations__preserved"
        aria-label="Additional preserved affiliation details"
      >
        <li
          v-for="detail in organizationAdditionalDetails(selectedOrganization, titles)"
          :key="detail"
        >
          {{ detail }}
        </li>
      </ul>

      <button
        class="contact-affiliations__remove"
        type="button"
        @click="removeSelectedOrganization"
      >
        <Trash2 :size="14" :stroke-width="1.8" aria-hidden="true" />
        <span>Remove this work affiliation</span>
      </button>
    </div>

    <div v-if="unlinkedTitles.length > 0" class="contact-affiliations__unlinked">
      <strong>Other preserved titles</strong>
      <ul>
        <li v-for="title in unlinkedTitles" :key="title.formKey">
          {{ title.kind === 'title' ? 'Title' : 'Role' }}: {{ title.value }}
        </li>
      </ul>
    </div>
  </fieldset>
</template>

<style scoped>
.contact-affiliations {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}

.contact-affiliations legend {
  margin-bottom: 7px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-affiliations__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.contact-affiliations__summary {
  display: inline-flex;
  min-width: 170px;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}

.contact-affiliations__summary:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.contact-affiliations__menu {
  min-width: min(320px, 80vw);
}

.contact-affiliations__option {
  align-items: start;
}

.contact-affiliations__option strong,
.contact-affiliations__option small {
  display: block;
}

.contact-affiliations__option small {
  margin-top: 2px;
  color: var(--muted, #6b7388);
  font-weight: 400;
}

.contact-affiliations__add,
.contact-affiliations__remove {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.contact-affiliations__add {
  padding: 4px 6px;
}

.contact-affiliations__remove {
  justify-self: start;
  padding: 5px 7px;
  color: #c93838;
}

.contact-affiliations__add:hover,
.contact-affiliations__add:focus-visible,
.contact-affiliations__remove:hover,
.contact-affiliations__remove:focus-visible {
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

.contact-affiliations__card {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel2, #f5f6fa) 55%, transparent);
}

.contact-affiliations__card label {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.contact-affiliations__card label > span {
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 600;
}

.contact-affiliations__preserved,
.contact-affiliations__unlinked ul {
  margin: 0;
  padding-left: 20px;
}

.contact-affiliations__preserved {
  grid-column: 1 / -1;
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.contact-affiliations__remove {
  grid-column: 1 / -1;
}

.contact-affiliations__unlinked {
  padding: 10px 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
  color: var(--muted, #6b7388);
  font-size: 12px;
}

@media (max-width: 760px) {
  .contact-affiliations__card {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
