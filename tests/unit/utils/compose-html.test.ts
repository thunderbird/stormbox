// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { editSafeDraftHtml } from '../../../src/utils/compose-html';

function sanitizedBody(html: string): HTMLDivElement {
  const body = document.createElement('div');
  body.innerHTML = editSafeDraftHtml(html);
  return body;
}

describe('compose draft HTML', () => {
  it('removes every network-loading resource before mounting a server draft', () => {
    const body = sanitizedBody(`
      <img alt="remote" src="https://tracker.example/pixel.gif"
        srcset="https://tracker.example/one.png 1x">
      <video src="https://tracker.example/movie.mp4"
        poster="https://tracker.example/poster.png">
        <source src="https://tracker.example/movie.webm">
      </video>
      <audio src="https://tracker.example/sound.mp3"></audio>
      <table background="https://tracker.example/background.png"><tr><td>Body</td></tr></table>
      <p style="color: red; background-image: url(https://tracker.example/style.png)">Text</p>
    `);

    expect(body.querySelector('img[alt="remote"]')?.hasAttribute('src')).toBe(false);
    expect(body.querySelector('img[alt="remote"]')?.hasAttribute('srcset')).toBe(false);
    expect(body.querySelector('video,audio,source,track')).toBeNull();
    expect(body.querySelector('table')?.hasAttribute('background')).toBe(false);
    expect(body.querySelector('p')?.style.color).toBe('red');
    expect(body.querySelector('p')?.style.backgroundImage).toBe('');
    expect(body.innerHTML).not.toContain('tracker.example');
  });

  it('keeps navigation links and local raster image sources', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const body = sanitizedBody(`
      <a href="https://example.com/path">Web</a>
      <a href="mailto:reader@example.com">Mail</a>
      <img alt="cid" src="cid:image@example.com">
      <img alt="blob" src="blob:https://localhost/local-image">
      <img alt="data" src="${png}">
      <img alt="svg" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">
    `);

    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/path');
    expect(body.querySelectorAll('a')[1]?.getAttribute('href'))
      .toBe('mailto:reader@example.com');
    expect(body.querySelector('img[alt="cid"]')?.getAttribute('src'))
      .toBe('cid:image@example.com');
    expect(body.querySelector('img[alt="blob"]')?.getAttribute('src'))
      .toBe('blob:https://localhost/local-image');
    expect(body.querySelector('img[alt="data"]')?.getAttribute('src')).toBe(png);
    expect(body.querySelector('img[alt="svg"]')?.hasAttribute('src')).toBe(false);
  });
});
