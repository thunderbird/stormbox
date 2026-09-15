import { nextTick } from 'vue';
import type { Ref } from 'vue';

export interface UseMenuKeyboardOptions {
  /** Element whose descendants matching `itemSelector` the arrow keys move between. */
  menuEl: Ref<HTMLElement | null>;
  /** Item selector, e.g. `[role="menuitem"]` or `[role="option"]`. */
  itemSelector: string;
  /** Item to focus when the menu opens; the first item when undefined. */
  initialItem?: (items: HTMLElement[]) => HTMLElement | undefined;
}

/**
 * Arrow-key navigation for a dropdown panel of focusable items
 * (WAI-ARIA menu / listbox pattern): ArrowDown/ArrowUp step, Home/End
 * jump, and opening the panel focuses an item. Escape and outside
 * clicks belong to the dropdown widget.
 */
export function useMenuKeyboard(options: UseMenuKeyboardOptions) {
  function items(): HTMLElement[] {
    return Array.from(
      options.menuEl.value?.querySelectorAll<HTMLElement>(options.itemSelector) ?? [],
    );
  }

  /** `toggle` handler for the containing `<details>`. */
  function onToggle(event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement | null;
    if (!details?.open) return;
    void nextTick(() => {
      const list = items();
      (options.initialItem?.(list) ?? list[0])?.focus();
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    // Tab leaves the composite: the panel closes and focus returns to the
    // summary, from which the browser's default Tab continues.
    if (event.key === 'Tab') {
      const details = options.menuEl.value?.closest('details');
      if (details instanceof HTMLDetailsElement && details.open) {
        details.open = false;
        details.querySelector<HTMLElement>('summary')?.focus();
      }
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const list = items();
    if (list.length === 0) return;
    event.preventDefault();
    const current = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : Math.min(list.length - 1, current + 1);
        break;
      case 'ArrowUp':
        next = current < 0 ? list.length - 1 : Math.max(0, current - 1);
        break;
      case 'Home':
        next = 0;
        break;
      default:
        next = list.length - 1;
    }
    list[next]?.focus();
  }

  return { items, onToggle, onKeydown };
}
