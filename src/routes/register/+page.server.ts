import { fail, redirect } from '@sveltejs/kit';
import { createSession } from '$lib/server/session';
import { SESSION_COOKIE_NAME } from '$lib/server/cookieName';
import { checkRegisterRateLimit } from '$lib/server/socket/rateLimit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.session) {
		redirect(307, '/lobby');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if (!(await checkRegisterRateLimit(getClientAddress()))) {
			return fail(429, { error: '请求过于频繁，请稍后再试' });
		}

		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();

		if (!username) {
			return fail(400, { error: '请输入用户名' });
		}
		if (username.length > 20) {
			return fail(400, { error: '用户名最多 20 个字符' });
		}

		const created = await createSession(username);
		if (!created) {
			return fail(400, { error: '该用户名已被使用，请换一个' });
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
