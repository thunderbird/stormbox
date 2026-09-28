<script setup lang="ts">
import { Plus, Trash2, X } from '@lucide/vue';

import MailRuleSelect from './MailRuleSelect.vue';
import { newRuleId } from '../sieve/rules';
import type {
  MailRuleCondition, MailRuleConditionGroup, MailRuleTest, RuleMatch,
} from '../sieve/rules';

defineOptions({ name: 'MailRuleTestEditor' });

const props = withDefaults(defineProps<{
  match: RuleMatch;
  conditions: MailRuleTest[];
  negated?: boolean;
  depth?: number;
  root?: boolean;
  disabled?: boolean;
  removable?: boolean;
}>(), {
  negated: false,
  depth: 0,
  root: false,
  disabled: false,
  removable: true,
});

const matchOptions = [
  { value: 'all', label: 'all of these match' },
  { value: 'any', label: 'any of these match' },
] as const;

const fieldOptions = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'toCc', label: 'To or Cc' },
  { value: 'subject', label: 'Subject' },
  { value: 'header', label: 'Custom header' },
] as const;

const operatorOptions = [
  { value: 'is', label: 'is' },
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches wildcard' },
] as const;

const emit = defineEmits<{
  (event: 'update:match', value: RuleMatch): void;
  (event: 'update:conditions', value: MailRuleTest[]): void;
  (event: 'update:negated', value: boolean): void;
  (event: 'remove'): void;
}>();

function createCondition(): MailRuleCondition {
  return {
    id: newRuleId('condition'),
    type: 'condition',
    negated: false,
    field: 'from',
    operator: 'contains',
    value: '',
  };
}

function createGroup(): MailRuleConditionGroup {
  return {
    id: newRuleId('group'),
    type: 'group',
    negated: false,
    match: 'all',
    conditions: [createCondition()],
  };
}

function replaceCondition(index: number, condition: MailRuleTest) {
  const conditions = [...props.conditions];
  conditions.splice(index, 1, condition);
  emit('update:conditions', conditions);
}

function updateCondition(index: number, patch: Partial<MailRuleCondition>) {
  const condition = props.conditions[index];
  if (condition?.type !== 'condition') return;
  replaceCondition(index, { ...condition, ...patch });
}

function removeCondition(index: number) {
  if (props.conditions.length <= 1) return;
  const conditions = [...props.conditions];
  conditions.splice(index, 1);
  emit('update:conditions', conditions);
}

function addCondition() {
  emit('update:conditions', [...props.conditions, createCondition()]);
}

function addGroup() {
  emit('update:conditions', [...props.conditions, createGroup()]);
}

function updateField(index: number, value: string) {
  const field = value as MailRuleCondition['field'];
  updateCondition(index, {
    field,
    ...(field === 'header' ? { headerName: 'X-Header' } : { headerName: undefined }),
  });
}

function updateMatch(value: string) {
  emit('update:match', value as RuleMatch);
}

function onGroupNegatedChange(event: Event) {
  emit('update:negated', (event.target as HTMLInputElement).checked);
}

function onConditionNegatedChange(index: number, event: Event) {
  updateCondition(index, { negated: (event.target as HTMLInputElement).checked });
}

function updateOperator(index: number, value: string) {
  updateCondition(index, {
    operator: value as MailRuleCondition['operator'],
  });
}

function onTextInput(
  index: number,
  property: 'headerName' | 'value',
  event: Event,
) {
  updateCondition(index, { [property]: (event.target as HTMLInputElement).value });
}
</script>

<template>
  <div class="condition-group" :class="{ 'condition-group--nested': !root }">
    <div class="condition-group__header">
      <span>{{ root ? 'When' : 'Group' }}</span>
      <MailRuleSelect
        class="condition-group__match"
        :model-value="match"
        :options="matchOptions"
        :control-label="root ? 'Condition match mode' : 'Nested condition match mode'"
        :disabled="disabled"
        @update:model-value="updateMatch"
      />
      <label v-if="!root" class="condition-group__not">
        <input
          type="checkbox"
          :checked="negated"
          :disabled="disabled"
          @change="onGroupNegatedChange"
        />
        Not
      </label>
      <button
        v-if="!root"
        class="condition-group__icon-button condition-group__icon-button--danger"
        type="button"
        :disabled="disabled || !removable"
        aria-label="Remove condition group"
        @click="emit('remove')"
      ><Trash2 :size="15" aria-hidden="true" /></button>
    </div>

    <div class="condition-group__children">
      <template v-for="(condition, index) in conditions" :key="condition.id">
        <MailRuleTestEditor
          v-if="condition.type === 'group'"
          :match="condition.match"
          :conditions="condition.conditions"
          :negated="condition.negated"
          :depth="depth + 1"
          :disabled="disabled"
          :removable="conditions.length > 1"
          @update:match="replaceCondition(index, { ...condition, match: $event })"
          @update:conditions="replaceCondition(index, { ...condition, conditions: $event })"
          @update:negated="replaceCondition(index, { ...condition, negated: $event })"
          @remove="removeCondition(index)"
        />

        <div v-else class="condition-group__condition">
          <label class="condition-group__not">
            <input
              type="checkbox"
              :checked="condition.negated"
              :disabled="disabled"
              @change="onConditionNegatedChange(index, $event)"
            />
            Not
          </label>
          <MailRuleSelect
            :model-value="condition.field"
            :options="fieldOptions"
            control-label="Condition field"
            :disabled="disabled"
            @update:model-value="updateField(index, $event)"
          />
          <input
            v-if="condition.field === 'header'"
            :value="condition.headerName"
            type="text"
            :disabled="disabled"
            aria-label="Header name"
            placeholder="X-Header"
            @input="onTextInput(index, 'headerName', $event)"
          />
          <MailRuleSelect
            :model-value="condition.operator"
            :options="operatorOptions"
            control-label="Condition operator"
            :disabled="disabled"
            @update:model-value="updateOperator(index, $event)"
          />
          <input
            :value="condition.value"
            type="text"
            :disabled="disabled"
            aria-label="Condition value"
            placeholder="Value"
            @input="onTextInput(index, 'value', $event)"
          />
          <button
            class="condition-group__icon-button"
            type="button"
            :disabled="disabled || conditions.length === 1"
            aria-label="Remove condition"
            @click="removeCondition(index)"
          ><X :size="15" aria-hidden="true" /></button>
        </div>
      </template>
    </div>

    <div class="condition-group__actions">
      <button type="button" :disabled="disabled" @click="addCondition">
        <Plus :size="14" aria-hidden="true" /> Condition
      </button>
      <button type="button" :disabled="disabled || depth >= 7" @click="addGroup">
        <Plus :size="14" aria-hidden="true" /> Group
      </button>
    </div>
  </div>
</template>

<style scoped>
.condition-group {
  min-width: 0;
}
.condition-group--nested {
  margin: 8px 0;
  padding: 9px;
  border: 1px solid var(--border-soft);
  border-left: 3px solid color-mix(in srgb, var(--accent) 52%, var(--border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel) 58%, transparent);
}
.condition-group__header,
.condition-group__condition,
.condition-group__actions,
.condition-group__not {
  display: flex;
  align-items: center;
}
.condition-group__header {
  gap: 8px;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.condition-group__match {
  width: auto;
  min-width: 160px;
}
.condition-group__match :deep(.mail-rule-select__summary) {
  text-transform: none;
  letter-spacing: normal;
}
.condition-group__not {
  gap: 5px;
  white-space: nowrap;
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}
.condition-group__not input {
  width: 15px;
  min-height: 15px;
}
.condition-group__condition {
  display: grid;
  grid-template-columns: auto minmax(110px, 0.8fr) minmax(135px, 1fr) minmax(160px, 1.5fr) 32px;
  gap: 8px;
  margin-bottom: 8px;
}
.condition-group__condition:has(input[aria-label="Header name"]) {
  grid-template-columns: auto minmax(105px, 0.75fr) minmax(110px, 0.75fr) minmax(135px, 1fr) minmax(150px, 1.35fr) 32px;
}
.condition-group input[type="text"] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.condition-group input[type="checkbox"] { accent-color: var(--accent); }
.condition-group input:focus-visible {
  border-color: var(--accent);
  outline: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
  outline-offset: 1px;
}
.condition-group__actions {
  gap: 3px;
}
.condition-group__actions button,
.condition-group__icon-button {
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
}
.condition-group__actions button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 5px 7px;
}
.condition-group__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  padding: 0;
  border-radius: 999px;
  color: var(--muted);
}
.condition-group__actions button:hover:not(:disabled),
.condition-group__actions button:focus-visible,
.condition-group__icon-button:hover:not(:disabled),
.condition-group__icon-button:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
.condition-group__icon-button--danger:hover:not(:disabled),
.condition-group__icon-button--danger:focus-visible { color: #d84a4a; }
.condition-group button:disabled { opacity: 0.35; cursor: default; }

@media (max-width: 760px) {
  .condition-group__condition,
  .condition-group__condition:has(input[aria-label="Header name"]) {
    grid-template-columns: auto 1fr 32px;
  }
  .condition-group__condition > :not(.condition-group__not, button) { grid-column: 2; }
  .condition-group__condition > .condition-group__not { grid-column: 1; grid-row: 1; }
  .condition-group__condition > button { grid-column: 3; grid-row: 1; }
}
</style>
