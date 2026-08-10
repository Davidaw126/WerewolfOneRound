import type { Lang } from '$lib/shared/i18n';

const STORAGE_KEY = 'wolf:lang';

function detectInitialLang(): Lang {
	if (typeof window === 'undefined') return 'zh';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'zh' || stored === 'en') return stored;
	// No stored preference yet - defaults to zh (the app's original/primary
	// language) rather than the browser's own locale. Most people opening
	// this for the first time are still Chinese speakers even on an
	// English-locale device (e.g. a shared party phone), so guessing from
	// navigator.language would get it wrong more often than right.
	return 'zh';
}

/** Single source of truth for the UI language - a $state so every component
 * reading it re-renders on change, persisted to localStorage so it survives
 * a reload/reconnect. Deliberately client-only (no server-side knowledge of
 * this preference) - see setLang's own note on the SSR flash tradeoff. */
class I18nStore {
	lang = $state<Lang>(detectInitialLang());

	setLang(lang: Lang): void {
		this.lang = lang;
		this.syncDocumentLang();
		if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
	}

	/** Called once from the root layout on mount, and again on every
	 * setLang - keeps <html lang="..."> (hardcoded to "zh" in app.html,
	 * since SSR has no way to know a returning visitor's stored preference
	 * before the page has loaded) in sync with the actual UI language. A
	 * returning English-preference visitor briefly sees the page rendered
	 * server-side as zh before this runs post-hydration - an accepted
	 * flash, not worth a cookie-based SSR sync for this app's scale. */
	syncDocumentLang(): void {
		if (typeof document !== 'undefined') document.documentElement.lang = this.lang;
	}
}

export const i18n = new I18nStore();
