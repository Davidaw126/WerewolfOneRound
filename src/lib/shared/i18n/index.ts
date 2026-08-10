import { zh } from './zh';
import { en } from './en';
import type { Lang, Strings } from './types';

export type { Lang, Strings } from './types';
export * from './roles';
export * from './format';

const DICTS: Record<Lang, Strings> = { zh, en };

export function strings(lang: Lang): Strings {
	return DICTS[lang];
}
