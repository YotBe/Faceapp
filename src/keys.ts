// The owner's own API keys, on the owner's own phone. See DECISIONS.md.
export type KeyName = 'soniox' | 'anthropic';

export function getKey(name: KeyName): string {
  try {
    return localStorage.getItem(`gloss.${name}`) ?? '';
  } catch {
    return '';
  }
}

export function setKey(name: KeyName, value: string): void {
  try {
    localStorage.setItem(`gloss.${name}`, value.trim());
  } catch {
    // Private browsing or blocked storage: the key simply lasts for this visit.
  }
}
