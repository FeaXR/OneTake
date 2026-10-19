import { en } from './en.ts';
import { hu } from './hu.ts';
import type { Message, Params } from './types.ts';

export type { Params } from './types.ts';
export type Language = 'en' | 'hu';
export type LanguageSetting = 'system' | Language;
export type MessageKey = keyof typeof en;

/** Languages offered in Settings, each named in its own language. */
export const LANGUAGES: Record<Language, string> = { en: 'English', hu: 'Magyar' };

const tables: Record<Language, Record<MessageKey, Message>> = { en, hu };
let current: Language = 'en';

export function setLanguage(lang: Language): void {
  current = lang;
}

export function getLanguage(): Language {
  return current;
}

/** "system" follows the OS locale (e.g. "hu-HU"), falling back to English. */
export function resolveLanguage(setting: LanguageSetting | undefined, locale: string): Language {
  if (setting && setting !== 'system') return setting;
  const code = locale.toLowerCase().split(/[-_]/)[0];
  return code in tables ? (code as Language) : 'en';
}

/** Translates a key in the current language, filling in {placeholders}. */
export function t(key: MessageKey, params: Params = {}): string {
  const msg = tables[current][key] ?? en[key];
  if (typeof msg === 'function') return msg(params);
  return msg.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] !== undefined ? String(params[name]) : whole));
}

/** Decimal separator for the current language (Hungarian uses a comma). */
export function formatNumber(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return current === 'hu' ? text.replace('.', ',') : text;
}

/**
 * An error whose message is a translation key, for errors raised in the main process.
 * It crosses IPC as text and is turned into the UI language by translateCodes().
 */
export function codedError(key: MessageKey, params: Params = {}): Error {
  return new Error(`@@${key}@@${JSON.stringify(params)}@@`);
}

export function translateCodes(text: string): string {
  return text.replace(/@@([\w.]+)@@(\{.*?\})@@/g, (whole, key: string, json: string) => {
    if (!(key in en)) return whole;
    try {
      return t(key as MessageKey, JSON.parse(json) as Params);
    } catch {
      return whole;
    }
  });
}
