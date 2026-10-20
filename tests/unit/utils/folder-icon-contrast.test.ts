// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';

import axe from 'axe-core';
import type { Window as HappyWindow } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { folderPresentation } from '../../../src/utils/folder-presentation';

interface ContrastColor {
  alpha: number;
  red: number;
  green: number;
  blue: number;
  parseString(value: string): ContrastColor;
}

const { Color, flattenColors, getContrast } = (axe.commons as typeof axe.commons & {
  color: {
    Color: new () => ContrastColor;
    flattenColors(foreground: ContrastColor, background: ContrastColor): ContrastColor;
    getContrast(background: ContrastColor, foreground: ContrastColor): number;
  };
}).color;

describe('generic folder icon contrast', () => {
  const styles = document.createElement('style');
  const icon = document.createElement('span');
  const originalClasses = document.documentElement.className;
  const device = (window as unknown as HappyWindow).happyDOM.settings.device;
  const originalColorScheme = device.prefersColorScheme;

  beforeAll(() => {
    device.prefersColorScheme = 'light';
    const classicStyles = readFileSync('src/assets/styles.css', 'utf8');
    const boltStyles = readFileSync('src/assets/bolt-theme.css', 'utf8');
    styles.textContent = `${classicStyles}\n${boltStyles}`;
    document.head.append(styles);
    icon.style.color = folderPresentation({ name: 'Project A', role: null }).color;
    document.body.append(icon);
  });

  afterAll(() => {
    styles.remove();
    icon.remove();
    document.documentElement.className = originalClasses;
    device.prefersColorScheme = originalColorScheme;
  });

  it.each(['light', 'palette-bolt light', ''])('retains a yellow hue with theme classes "%s"', (classes) => {
    document.documentElement.className = classes;
    const color = new Color().parseString(getComputedStyle(icon).color);
    expect(color.red).toBeGreaterThan(color.green);
    expect(color.green).toBeGreaterThanOrEqual(color.red * 0.75);
    expect(color.blue).toBeLessThanOrEqual(color.red * 0.25);
  });

  it.each(['light', 'palette-bolt light', ''])('has a visibly yellow fill with theme classes "%s"', (classes) => {
    document.documentElement.className = classes;
    icon.style.backgroundColor = 'var(--folder-icon-fill)';
    const computed = getComputedStyle(icon);
    const fill = new Color().parseString(computed.backgroundColor);
    expect(fill.alpha).toBe(1);
    expect(fill.red).toBeGreaterThan(fill.green);
    expect(fill.green).toBeGreaterThanOrEqual(fill.red * 0.85);
    expect(fill.blue).toBeLessThanOrEqual(fill.red * 0.7);
    expect(getContrast(fill, new Color().parseString(computed.color))).toBeGreaterThanOrEqual(3);
  });

  it.each(['dark', 'light', 'palette-bolt dark', 'palette-bolt light', ''])(
    'exceeds 3:1 against normal, hovered, and selected surfaces with theme classes "%s"',
    (classes) => {
      document.documentElement.className = classes;
      for (const surface of [
        '--colour-neutral-lower', '--colour-neutral-base', '--panel', '--panel2',
        '--rowHover', '--rowActive',
      ]) {
        icon.style.backgroundColor = `var(${surface})`;
        const computed = getComputedStyle(icon);
        const background = new Color().parseString(computed.backgroundColor);
        expect(background.alpha, `${classes}, ${surface} resolves to an opaque surface`).toBe(1);
        const contrast = getContrast(
          background,
          new Color().parseString(computed.color),
        );
        expect(contrast, `${classes}, ${surface}`).toBeGreaterThanOrEqual(3);
      }

      // Happy DOM retains color-mix tokens without compositing their backgrounds.
      const hoverToken = getComputedStyle(document.documentElement).getPropertyValue('--control-hover-bg');
      const hoverMix = /^color-mix\(in srgb, (.+) ([\d.]+)%, transparent\)$/.exec(hoverToken.trim());
      expect(hoverMix, 'picker hover token is an sRGB color mixed with transparency').not.toBeNull();
      const overlay = new Color().parseString(hoverMix![1]);
      overlay.alpha = Number(hoverMix![2]) / 100;
      for (const surface of ['--colour-neutral-base', '--panel']) {
        icon.style.backgroundColor = `var(${surface})`;
        const computed = getComputedStyle(icon);
        const background = new Color().parseString(computed.backgroundColor);
        expect(background.alpha).toBe(1);
        const hovered = flattenColors(overlay, background);
        expect(
          getContrast(hovered, new Color().parseString(computed.color)),
          `${classes}, picker hover over ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
