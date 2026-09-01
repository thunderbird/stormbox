// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

import AppDropdown from '../../../src/components/AppDropdown.vue';
import { closeContainingDropdown } from '../../../src/utils/dropdown';

/**
 * The widget's one behavior: at most one dropdown open per group. The
 * mechanics of <details> itself are the browser's to prove.
 */

function mountDropdowns(template: string) {
  const host = defineComponent({
    components: { AppDropdown },
    template,
  });
  return mount(host, { attachTo: document.body });
}

/** Open a details the way a click does, with the toggle event it fires. */
async function open(details: any) {
  details.element.open = true;
  await details.trigger('toggle');
}

describe('AppDropdown', () => {
  it('closes an open peer when another opens', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div>menu a</div></AppDropdown>
      <AppDropdown id="b"><summary>B</summary><div>menu b</div></AppDropdown>
    `);
    const [a, b] = wrapper.findAll('details');

    await open(a);
    expect(a.element.open).toBe(true);

    await open(b);
    expect(b.element.open).toBe(true);
    expect(a.element.open, 'one dropdown at a time').toBe(false);

    wrapper.unmount();
  });

  it('leaves a differently grouped dropdown alone', async () => {
    // Exclusivity is per group: naming a group is the deliberate way to
    // let two dropdowns stand open side by side.
    const wrapper = mountDropdowns(`
      <AppDropdown id="a" group="left"><summary>A</summary><div /></AppDropdown>
      <AppDropdown id="b" group="right"><summary>B</summary><div /></AppDropdown>
    `);
    const [a, b] = wrapper.findAll('details');

    await open(a);
    await open(b);

    expect(a.element.open).toBe(true);
    expect(b.element.open).toBe(true);

    wrapper.unmount();
  });

  it('closes when the pointer goes down outside it', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div class="panel">menu</div></AppDropdown>
    `);
    const a = wrapper.get('details');

    await open(a);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(a.element.open).toBe(false);
    wrapper.unmount();
  });

  it('stays open for a pointer down inside its panel', async () => {
    // Clicking within the menu is not moving on; items that should
    // dismiss the menu close it themselves when activated.
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div class="panel">menu</div></AppDropdown>
    `);
    const a = wrapper.get('details');

    await open(a);
    wrapper.get('.panel').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(a.element.open).toBe(true);
    wrapper.unmount();
  });

  it('closes the dropdown containing an activated item', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a">
        <summary>A</summary>
        <button class="item">pick</button>
      </AppDropdown>
    `);
    const a = wrapper.get('details');
    await open(a);
    wrapper.get('.item').element.addEventListener('click', closeContainingDropdown);

    await wrapper.get('.item').trigger('click');

    expect(a.element.open).toBe(false);
    wrapper.unmount();
  });

  it('closes on Escape and stops the key there', async () => {
    // Whatever listens above — a dialog that closes on Escape — must not
    // also act on the press that dismissed the menu.
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div class="panel">menu</div></AppDropdown>
    `);
    const a = wrapper.get('details');
    await open(a);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);

    expect(a.element.open).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('puts focus back on the summary when Escape closed over a focused item', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div><button class="item">pick</button></div></AppDropdown>
    `);
    const a = wrapper.get('details');
    await open(a);
    (wrapper.get('.item').element as HTMLButtonElement).focus();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(a.element.open).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('summary').element);
    wrapper.unmount();
  });

  it('cancels summary activation while disabled', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a" :disabled="true"><summary>A</summary><div /></AppDropdown>
    `);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.get('summary').element.dispatchEvent(click);

    // Summary activation toggles <details> unless the click is
    // cancelled first, which is the whole of the disabling mechanism.
    expect(click.defaultPrevented).toBe(true);
    expect(wrapper.get('details').element.open).toBe(false);
    wrapper.unmount();
  });

  it('does not reopen anything when a dropdown closes', async () => {
    const wrapper = mountDropdowns(`
      <AppDropdown id="a"><summary>A</summary><div /></AppDropdown>
      <AppDropdown id="b"><summary>B</summary><div /></AppDropdown>
    `);
    const [a, b] = wrapper.findAll('details');

    await open(a);
    a.element.open = false;
    await a.trigger('toggle');

    expect(a.element.open).toBe(false);
    expect(b.element.open).toBe(false);

    wrapper.unmount();
  });
});
