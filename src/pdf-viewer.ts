import './pdf-viewer.css';

const PDF_VIEWER_CHANNEL_PREFIX = 'stormbox-pdf-viewer:';
const PDF_VIEWER_LOAD_TIMEOUT_MS = 30_000;

interface PdfViewerMessage {
  type?: string;
  blob?: Blob;
  name?: string;
  message?: string;
}

const status = document.querySelector<HTMLParagraphElement>('#pdf-viewer-status');
const frame = document.querySelector<HTMLIFrameElement>('#pdf-viewer-frame');

function showError(message: string): void {
  if (!status) return;
  status.textContent = message;
  status.setAttribute('role', 'alert');
  status.hidden = false;
}

function viewerToken(): string | null {
  try {
    const token = decodeURIComponent(window.location.hash.slice(1));
    return /^[0-9a-f-]{36}$/iu.test(token) ? token : null;
  } catch {
    return null;
  }
}

const token = viewerToken();
if (!token || !status || !frame) {
  showError('This PDF viewer link is invalid. Close this tab and try again.');
} else {
  const channel = new BroadcastChannel(`${PDF_VIEWER_CHANNEL_PREFIX}${token}`);
  const timeout = window.setTimeout(() => {
    channel.close();
    showError('The PDF did not arrive. Close this tab and try again.');
  }, PDF_VIEWER_LOAD_TIMEOUT_MS);

  channel.onmessage = (event: MessageEvent<PdfViewerMessage>) => {
    const message = event.data;
    if (message?.type === 'error') {
      window.clearTimeout(timeout);
      channel.close();
      showError(message.message || 'The PDF could not be opened.');
      return;
    }
    if (
      message?.type !== 'pdf'
      || !(message.blob instanceof Blob)
      || message.blob.type !== 'application/pdf'
    ) {
      return;
    }

    window.clearTimeout(timeout);
    channel.close();
    const url = URL.createObjectURL(message.blob);
    document.title = message.name || 'PDF attachment';
    frame.addEventListener('load', () => {
      status.hidden = true;
    }, { once: true });
    frame.src = url;
    frame.hidden = false;
    window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
  };

  channel.postMessage({ type: 'ready' });
}
