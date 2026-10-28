import { bindDocumentLocale } from './i18n';
import { t } from './i18n/messages';
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

bindDocumentLocale();
document.title = t('pdfViewer.attachment');
if (status) status.textContent = t('pdfViewer.opening');
if (frame) frame.title = t('pdfViewer.attachment');

const token = viewerToken();
if (!token || !status || !frame) {
  showError(t('pdfViewer.thisPDFViewerLinkIsInvalidCloseThisTab'));
} else {
  const channel = new BroadcastChannel(`${PDF_VIEWER_CHANNEL_PREFIX}${token}`);
  const timeout = window.setTimeout(() => {
    channel.close();
    showError(t('pdfViewer.thePDFDidNotArriveCloseThisTabAnd'));
  }, PDF_VIEWER_LOAD_TIMEOUT_MS);

  channel.onmessage = (event: MessageEvent<PdfViewerMessage>) => {
    const message = event.data;
    if (message?.type === 'error') {
      window.clearTimeout(timeout);
      channel.close();
      showError(message.message || t('pdfViewer.thePDFCouldNotBeOpened'));
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
    document.title = message.name || t('pdfViewer.pDFAttachment');
    frame.addEventListener('load', () => {
      status.hidden = true;
    }, { once: true });
    frame.src = url;
    frame.hidden = false;
    window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
  };

  channel.postMessage({ type: 'ready' });
}
