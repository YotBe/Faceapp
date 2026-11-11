// Small per-phone preferences. Not secrets.
export type Lang = 'he' | 'en';

const read = (k: string) => {
  try {
    return localStorage.getItem(`gloss.${k}`);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(`gloss.${k}`, v);
  } catch {
    // Lasts for this visit only.
  }
};

/** Language the cards are written in. Hebrew unless the owner chooses English. */
export const getLang = (): Lang => (read('lang') === 'en' ? 'en' : 'he');
export const setLang = (l: Lang) => write('lang', l);

/** Optional: who is listening and what they already know. */
export const getAbout = (): string => read('about') ?? '';
export const setAbout = (v: string) => write('about', v.trim().slice(0, 600));
