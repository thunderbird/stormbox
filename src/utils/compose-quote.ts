/**
 * Helpers for reply / forward / reply-all compose prefills.
 */

export function makeReplySubject(subject?: string | null): string {
  const s = (subject ?? '').trim();
  if (/^re:/i.test(s)) return s;
  return s ? `Re: ${s}` : 'Re: (no subject)';
}

export function makeForwardSubject(subject?: string | null): string {
  const s = (subject ?? '').trim();
  if (/^fwd:/i.test(s)) return s;
  return s ? `Fwd: ${s}` : 'Fwd: (no subject)';
}

export function formatQuotedHeader({
  from,
  date,
  subject,
}: {
  from?: string | null;
  date?: number | null;
  subject?: string | null;
}): string {
  const when = date
    ? new Date(Number(date)).toLocaleString()
    : '';
  const lines = [
    from ? `From: ${from}` : null,
    when ? `Date: ${when}` : null,
    subject ? `Subject: ${subject}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildQuotedText({
  from,
  date,
  subject,
  text,
}: {
  from?: string | null;
  date?: number | null;
  subject?: string | null;
  text?: string | null;
}): string {
  const header = formatQuotedHeader({ from, date, subject });
  const body = (text ?? '').trim();
  if (!header && !body) return '';
  if (!body) return `\n\n${header}\n`;
  const quoted = body.split('\n').map((line) => `> ${line}`).join('\n');
  return `\n\n${header}\n\n${quoted}\n`;
}

export function buildQuotedHtml({
  from,
  date,
  subject,
  html,
  text,
}: {
  from?: string | null;
  date?: number | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
}): string {
  const header = formatQuotedHeader({ from, date, subject });
  const inner = (html ?? '').trim() || escapeHtml(text ?? '').replace(/\n/g, '<br>');
  if (!header && !inner) return '';
  const headerHtml = header.split('\n').map((line) => escapeHtml(line)).join('<br>');
  return `<br><br><div class="moz-cite-prefix">${headerHtml}<br></div>`
    + `<blockquote type="cite">${inner}</blockquote>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseAddressTokens(input?: string | null): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractEmailAddress(token: string): string {
  const m = token.match(/<([^>]+)>/);
  return (m ? m[1] : token).trim().toLowerCase();
}

export function uniqueAddressTokens(tokens: string[], excludeEmails: string[] = []): string[] {
  const exclude = new Set(excludeEmails.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const email = extractEmailAddress(token);
    if (!email || exclude.has(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(token);
  }
  return out;
}

export function buildReplyAllRecipients({
  fromText,
  toText,
  selfEmail,
}: {
  fromText?: string | null;
  toText?: string | null;
  selfEmail?: string | null;
}): { to: string; cc: string } {
  const self = selfEmail?.trim().toLowerCase() ?? '';
  const from = (fromText ?? '').trim();
  const fromEmail = from ? extractEmailAddress(from) : '';
  const others = uniqueAddressTokens(
    parseAddressTokens(toText),
    self ? [self, fromEmail] : [fromEmail].filter(Boolean),
  );
  return {
    to: from,
    cc: others.join(', '),
  };
}
