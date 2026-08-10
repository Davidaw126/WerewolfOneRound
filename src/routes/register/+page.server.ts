import { fail, redirect } from '@sveltejs/kit';
import { createSession } from '$lib/server/session';
import { SESSION_COOKIE_NAME } from '$lib/server/cookieName';
import { checkRegisterRateLimit } from '$lib/server/socket/rateLimit';
import { strings, type Lang } from '$lib/shared/i18n';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.session) {
		redirect(307, '/lobby');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		// The client's chosen UI language rides along as a hidden field
		// (LanguageToggle keeps it synced) - register is a plain form POST
		// with no other channel for the server to know it, unlike every
		// other user-facing string in the app, which is a client-side
		// rendering concern only.
		const lang: Lang = form.get('lang') === 'en' ? 'en' : 'zh';
		const t = strings(lang).register;

		if (!(await checkRegisterRateLimit(getClientAddress()))) {
			return fail(429, { error: t.errorRateLimited });
		}

		const username = String(form.get('username') ?? '').trim();

		if (!username) {
			return fail(400, { error: t.errorEmptyUsername });
		}
		if (username.length > 20) {
			return fail(400, { error: t.errorTooLong });
		}

		const created = await createSession(username);
		if (!created) {
			return fail(400, { error: t.errorNameTaken });
		}
		const { cookieValue } = created;
		cookies.set(SESSION_COOKIE_NAME, cookieValue, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 60 * 6
		});

		redirect(303, '/lobby');
	}
};
