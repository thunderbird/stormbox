/**
 * Synthetic clipboard pastes into a contenteditable editor.
 *
 * Files are described as `{ name, type, base64 }` or `{ name, type, text }`
 * so they survive the Node → page boundary; the File objects are rebuilt in
 * the page and dispatched on a plain `paste` Event with `clipboardData`
 * attached via defineProperty, which both Chromium and Firefox honour where
 * the ClipboardEvent constructor's `clipboardData` does not.
 */

/** A solid-colour PNG of `width` × `height`, rendered by the page's canvas. */
export async function createGeneratedImageFile(page, {
  width,
  height,
  name = 'generated.png',
  type = 'image/png',
  fillStyle = '#3366cc',
}) {
  return page.evaluate(async (options) => {
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a 2D canvas context');
    context.fillStyle = options.fillStyle;
    context.fillRect(0, 0, options.width, options.height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error(`Could not encode generated image as ${options.type}`));
      }, options.type);
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      base64: btoa(binary),
      name: options.name,
      type: blob.type || options.type,
    };
  }, {
    width,
    height,
    name,
    type,
    fillStyle,
  });
}

/** Focus `editor` (a Locator) and paste `files` as one clipboard payload. */
export async function pasteFilesIntoEditor(editor, files) {
  await editor.evaluate((element, fileInputs) => {
    if (!(element instanceof HTMLElement)) throw new Error('Editor is missing');
    element.focus();

    const transfer = new DataTransfer();
    for (const input of fileInputs) {
      let contents;
      if (typeof input.base64 === 'string') {
        const binary = atob(input.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        contents = bytes;
      } else if (typeof input.text === 'string') {
        contents = input.text;
      } else {
        throw new Error(`Paste file ${input.name} has no contents`);
      }
      transfer.items.add(new File([contents], input.name, { type: input.type }));
    }

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
  }, files);
}
