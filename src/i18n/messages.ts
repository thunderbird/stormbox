import english from '../locales/en.json';

export type MessageParams = Record<string, unknown>;
type Translator = (key: string, params: MessageParams, count?: number) => string;
let translate: Translator | undefined;
let currentLocale = () => 'en';

/** The UI installs Vue I18n; workers keep stable English diagnostics. */
export function installTranslator(translator: Translator, locale: () => string): void {
  translate = translator;
  currentLocale = locale;
}

export function displayLocale(): string {
  return currentLocale();
}

/** English-only diagnostic fallback, without a Vue dependency in workers. */
export function sourceText(key: string, params: MessageParams = {}, count?: number): string {
  let value: unknown = english;
  for (const segment of key.split('.')) {
    value = value && typeof value === 'object' && Object.hasOwn(value, segment)
      ? (value as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof value !== 'string') return key;
  const branches = value.split(/\s+\|\s+/);
  const n = count ?? Number(params.count ?? params.n);
  const message = branches.length === 1 ? value
    : branches[branches.length === 2 ? (n === 1 ? 0 : 1) : (n === 0 ? 0 : n === 1 ? 1 : 2)];
  return message.replace(/\{'([^']*)'\}|\{(\w+)\}/g, (match, literal, name) =>
    literal ?? String(params[name] ?? (name === 'count' || name === 'n' ? n : match)));
}

export function t(key: string, params: MessageParams = {}, count?: number): string {
  return translate ? translate(key, params, count) : sourceText(key, params, count);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(displayLocale(), options).format(value);
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(displayLocale(), options).format(value);
}

export class LocalizedError extends Error {
  readonly messageKey: string;
  readonly messageParams: MessageParams;

  constructor(key: string, params: MessageParams = {}, options?: ErrorOptions) {
    super(sourceText(key, params), options);
    this.messageKey = key;
    this.messageParams = params;
    Object.defineProperty(this, 'message', { get: () => t(key, params), configurable: true });
  }
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'messageKey' in error
    && typeof error.messageKey === 'string') {
    return t(error.messageKey, ('messageParams' in error ? error.messageParams : {}) as MessageParams);
  }
  return error instanceof Error ? error.message : String(error);
}


export function errorDescription(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if ('descriptionKey' in error && typeof error.descriptionKey === 'string') {
    return t(error.descriptionKey, ('descriptionParams' in error ? error.descriptionParams : {}) as MessageParams);
  }
  if ('description' in error && typeof error.description === 'string') return error.description;
  return 'message' in error ? errorMessage(error) : null;
}
