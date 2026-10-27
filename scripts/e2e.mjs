// End-to-end smoke test: plays games against a running server with real
// sessions and real sockets - the server layer (handlers, projection, effect
// routing) that the engine's unit tests never touch.
//
//   npm run dev                      (in another terminal; needs Redis)
//   npm run e2e                      both games below
//   npm run e2e -- basic             6 players: wolves/seer/witch - night, dawn,
//                                    改变身份, leaving during the day
//   npm run e2e -- special           7 players: 丘比特/盗贼/守卫/猎人 - two nights
//   npm run e2e -- halt              stops right after the wolf kill; kill the
//   npm run e2e -- resume            server, restart it, then resume checks the
//                                    night moved on by itself after the restart
//
// E2E_BASE overrides the server URL (default http://localhost:5173). A full run
// registers ~15 users; registration is rate-limited per IP (60/min).
import { io } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173';
const MODE = process.argv[2] ?? 'full';
const STATE_FILE = path.join(os.tmpdir(), 'werewolf-e2e-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
	if (!ok) failures++;
};

async function register(name) {
	const body = new URLSearchParams({ username: name, lang: 'zh' });
	const res = await fetch(`${BASE}/register`, {
		method: 'POST',
		body,
		redirect: 'manual',
		headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' }
	});
	const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
	if (!cookie) throw new Error(`register ${name} failed: ${res.status}`);
	return cookie;
}

function connect(cookie, name) {
	const sock = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
	const c = { name, sock, cookie, events: [], priv: [], role: null, prompt: null };
	sock.on('server:event', (e) => c.events.push(e));
	sock.on('server:private', (e) => {
		c.priv.push(e);
		if (e.kind === 'YourRole') c.role = e.role;
		if (e.kind === 'YourTurnPrompt') c.prompt = e;
	});
	c.act = (action) =>
		new Promise((resolve) =>
			sock
				.timeout(8000)
				.emit('client:action', action, (err, res) =>
					resolve(err ? { ok: false, error: 'timeout' } : res)
				)
		);
	return new Promise((resolve) => sock.on('connect', () => resolve(c)));
}

async function waitFor(fn, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${what}`);
}

if (MODE === 'resume') {
	const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
	const host = await connect(saved.hostCookie, 'host');
	await host.act({ kind: 'RoomJoin', roomCode: saved.code });
	const start = Date.now();
	await waitFor(
		() => host.events.some((e) => e.kind === 'NightAnnouncePending' || e.kind === 'StageChanged'),
		60000,
		'the night to move on after the restart'
	);
	console.log(
		`PASS  night moved on by itself ${Math.round((Date.now() - start) / 1000)}s after reconnecting`
	);
	process.exit(0);
}

const ALL_ROLES =
	'VILLAGER SEER WITCH HUNTER GUARD IDIOT KNIGHT DREAM_WEAVER CUPID THIEF WILD_CHILD WEREWOLF WOLF_KING BLACK_WOLF_KING WOLF_BEAUTY NIGHTMARE'.split(
		' '
	);

/** Registers `seats` players, has the first create a room with `roles`, seats
 * everyone and starts the game. Returns the players (index = seat - 1). */
async function setupGame(label, seats, roles) {
	const tag = Date.now().toString(36).slice(-4);
	const players = [];
	for (let i = 0; i < seats; i++) {
		const name = `${label}${i + 1}${tag}`;
		players.push(await connect(await register(name), name));
	}
	const host = players[0];
	const created = await host.act({ kind: 'RoomCreate' });
	const code = created.roomCode;
	check(created.ok && /^\d{6}$/.test(code), `[${label}] room created ${code}`);
	const cfg = await host.act({
		kind: 'RoomSubmitConfig',
		roleConfig: { ...Object.fromEntries(ALL_ROLES.map((r) => [r, 0])), ...roles },
		cupidPoisonBlocksHunter: false
	});
	check(cfg.ok, `[${label}] config submitted ${JSON.stringify(cfg.error ?? cfg.issues ?? '')}`);
	for (const p of players.slice(1)) await p.act({ kind: 'RoomJoin', roomCode: code });
	for (const [i, p] of players.entries()) {
		const r = await p.act({ kind: 'SeatTake', seatNumber: i + 1 });
		if (!r.ok) console.log('seat', i + 1, r);
		await p.act({ kind: 'RevealRole' });
	}
	await host.act({ kind: 'RoomLockSeats', locked: true });
	const started = await host.act({ kind: 'RoomStartGame' });
	check(
		started.ok,
		`[${label}] game started ${JSON.stringify(started.error ?? started.issues ?? '')}`
	);
	await sleep(500);
	return { players, host, code };
}

async function basicGame() {
	const { players, host, code } = await setupGame('b', 6, {
		WEREWOLF: 2,
		SEER: 1,
		WITCH: 1,
		VILLAGER: 2
	});
	const seatOf = (p) => players.indexOf(p) + 1;
	const byRole = (role) => players.filter((p) => p.role === role);
	console.log('roles:', players.map((p) => `${seatOf(p)}=${p.role}`).join(' '));

	// --- Night 1: play every prompt as it arrives -------------------------------
	const villagers = byRole('VILLAGER');
	const victim = villagers[0];
	const wolves = byRole('WEREWOLF');
	const seer = byRole('SEER')[0];
	const witch = byRole('WITCH')[0];
	const night = async () => {
		const deadline = Date.now() + 90000;
		const done = new Set();
		while (Date.now() < deadline) {
			if (host.events.some((e) => e.kind === 'NightAnnouncePending')) return true;
			for (const p of players) {
				const pr = p.prompt;
				if (!pr || done.has(pr)) continue;
				done.add(pr);
				let action = null;
				if (pr.role === 'WEREWOLF') action = { role: 'WEREWOLF', targetSeat: seatOf(victim) };
				if (pr.role === 'SEER') action = { role: 'SEER', targetSeat: seatOf(wolves[0]) };
				if (pr.role === 'WITCH') action = { role: 'WITCH', poisonTarget: null, useAntidote: false };
				if (!action) continue;
				const r = await p.act({ kind: 'NightSubmitAction', action });
				if (pr.role === 'WEREWOLF' && p === wolves[0]) {
					check(r.ok, `wolf kill on seat ${seatOf(victim)}`);
					if (MODE === 'halt') {
						fs.writeFileSync(STATE_FILE, JSON.stringify({ code, hostCookie: host.cookie }));
						console.log('HALT  wolf kill in, stopping now');
						process.exit(0);
					}
				}
				if (pr.role === 'SEER') {
					check(r.ok, 'seer check');
					// Double-tap: a second check the same night must be refused.
					const again = await p.act({
						kind: 'NightSubmitAction',
						action: { role: 'SEER', targetSeat: seatOf(villagers[1]) }
					});
					check(
						!again.ok && again.error === 'already_submitted',
						`seer double-tap refused (${again.error})`
					);
				}
			}
			await sleep(200);
		}
		return false;
	};
	check(await night(), 'night 1 reached dawn on its own');
	const seerResults = seer.priv.filter((e) => e.kind === 'SeerResult').length;
	check(seerResults === 1, `seer got exactly one result (${seerResults})`);
	const witchPrompt = witch.priv.find((e) => e.kind === 'YourTurnPrompt');
	check(
		witchPrompt?.context?.witch?.killedSeat === seatOf(victim),
		'witch saw the attacked seat (antidote unused)'
	);

	// --- Dawn leak: a phone reconnecting before 公布 must not see the death -----
	const rejoin = await connect(villagers[1].cookie, 'rejoin');
	const snap = await rejoin.act({ kind: 'RoomJoin', roomCode: code });
	check(
		snap.ok && snap.state.deadSeats.length === 0 && !snap.state.seats.some((s) => s.isDead),
		`refresh at dawn shows no deaths (deadSeats=${JSON.stringify(snap.state?.deadSeats)})`
	);
	const ann = await host.act({ kind: 'NightAnnounceResults' });
	check(ann.ok, 'host announced night results');
	const snap2 = await rejoin.act({ kind: 'ResyncRequest' });
	check(
		JSON.stringify(snap2.state.deadSeats) === JSON.stringify([seatOf(victim)]),
		`after 公布 the death shows (deadSeats=${JSON.stringify(snap2.state.deadSeats)})`
	);
	rejoin.sock.disconnect();

	// --- 改变身份: private to host + player, card replays the new role -----------
	const target = seer;
	for (const p of players) {
		p.priv.length = 0;
		p.events.length = 0;
	}
	const so = await host.act({
		kind: 'HostOverride',
		overrideKind: 'SET_ROLE',
		seat: seatOf(target),
		role: 'VILLAGER'
	});
	check(so.ok, `host changed seat ${seatOf(target)} to 普通村民`);
	await sleep(600);
	check(target.role === 'VILLAGER', 'target phone got the new card');
	check(
		target.priv.some((e) => e.kind === 'RoleChangedByHost' && e.forYou),
		'target was told privately'
	);
	check(
		host.priv.some((e) => e.kind === 'RoleChangedByHost' && !e.forYou),
		'host got the private log line'
	);
	const others = players.filter((p) => p !== host && p !== target);
	check(
		others.every(
			(p) =>
				!p.events.some((e) => e.kind === 'HostOverrideApplied') &&
				!p.priv.some((e) => e.kind === 'RoleChangedByHost')
		),
		'nobody else heard about the role change'
	);
	const reload = await connect(target.cookie, 'reload');
	await reload.act({ kind: 'RoomJoin', roomCode: code });
	await sleep(400);
	check(reload.role === 'VILLAGER', `card after a refresh shows the new role (${reload.role})`);
	reload.sock.disconnect();

	// --- Leaving during the day resets the round --------------------------------
	for (const p of players) p.events.length = 0;
	const leaver = players[5];
	const before = await host.act({ kind: 'ResyncRequest' });
	console.log('phase before leave:', before.state.phase);
	const lv = await leaver.act({ kind: 'RoomLeave' });
	check(lv.ok, 'player left during the day');
	await sleep(600);
	check(
		host.events.some((e) => e.kind === 'GameReset'),
		'day-time leave reset the round'
	);
	console.log('host events after leave:', host.events.map((e) => e.kind).join(','));

	for (const p of players) p.sock.disconnect();
}

/** 7 seats, 9 cards: 盗贼 sees two buried cards. Two nights covering 盗贼's
 * swap, 丘比特's link + 情侣相认 confirms, 守卫's save and no-repeat rule,
 * 猎人's status stage and a lover's 殉情. Adapts to whichever two cards ended
 * up buried, so a role that isn't in play skips its own checks. */
async function specialGame() {
	const { players, host, code } = await setupGame('s', 7, {
		WEREWOLF: 2,
		CUPID: 1,
		THIEF: 1,
		GUARD: 1,
		HUNTER: 1,
		SEER: 1,
		VILLAGER: 2
	});
	const seatOf = (p) => players.indexOf(p) + 1;
	const isWolf = (p) => p.role === 'WEREWOLF';
	console.log('[s] dealt:', players.map((p) => `${seatOf(p)}=${p.role}`).join(' '));

	// Decided as the night unfolds - each needs the roles as they stand after
	// 盗贼's swap.
	let lovers = null; // [hunterOrOther, other]
	let guardSave = null; // night 1: the seat the guard protects and the wolves attack
	let thief = null;
	let thiefNewRole = null;
	const nightsDone = () => host.events.filter((e) => e.kind === 'NightAnnouncePending').length;
	// Across nights: each phone keeps its last prompt object, which a later
	// night must not replay.
	const done = new Set();

	const pickGuardSave = () => {
		if (guardSave) return guardSave;
		guardSave =
			players.find((p) => !isWolf(p) && !lovers?.includes(p) && p.role !== 'CUPID') ??
			players.find((p) => !isWolf(p));
		return guardSave;
	};

	async function playNight(n) {
		const target = nightsDone() + 1;
		const fromEvent = host.priv.length; // only this night's stage changes
		let coupleHandled = false;
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			if (nightsDone() >= target) return true;

			// 情侣相认: every phone has the button; only the lovers' taps count,
			// and the stage waits for both.
			const coupleUp = host.priv
				.slice(fromEvent)
				.some((e) => e.kind === 'HostStageChanged' && e.stage?.kind === 'COUPLE_REVEAL');
			if (coupleUp && !coupleHandled && lovers) {
				coupleHandled = true;
				const stranger = players.find((p) => !lovers.includes(p));
				const r0 = await stranger.act({ kind: 'NightConfirmStage' });
				check(r0.ok, '[s] a non-lover tapping 我知道了 looks the same (ok, no error)');
				for (const [i, l] of lovers.entries()) {
					const partner = l.priv.find((e) => e.kind === 'CoupleRevealed');
					check(
						partner?.partnerSeat === seatOf(lovers[1 - i]),
						`[s] lover ${seatOf(l)} was told their partner (${partner?.partnerSeat})`
					);
				}
				await lovers[0].act({ kind: 'NightConfirmStage' });
				await sleep(1500);
				const mid = await host.act({ kind: 'ResyncRequest' });
				check(
					mid.state.hostStage?.kind === 'COUPLE_REVEAL',
					'[s] 情侣相认 waits for the second lover'
				);
				await lovers[1].act({ kind: 'NightConfirmStage' });
			}

			for (const p of players) {
				const pr = p.prompt;
				if (!pr || done.has(pr)) continue;
				done.add(pr);
				const ctx = pr.context ?? {};
				if (pr.role === 'THIEF') {
					thief = p;
					const choice = p.priv.find((e) => e.kind === 'ThiefChoice')?.buried ?? [];
					console.log(`[s] 盗贼 (seat ${seatOf(p)}) sees: ${choice.join(', ')}`);
					// Take whichever buried card keeps the most of this board in play.
					const order = ['GUARD', 'HUNTER', 'CUPID', 'SEER', 'VILLAGER', 'WEREWOLF'];
					const best = [...choice].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
					const swap = choice[0] === best ? 'buried1' : 'buried2';
					const r = await p.act({ kind: 'NightSubmitAction', action: { role: 'THIEF', swap } });
					check(r.ok, `[s] 盗贼 took ${best}`);
					await sleep(400);
					thiefNewRole = best;
					check(p.role === best, `[s] 盗贼's phone now shows ${best} (${p.role})`);
				} else if (pr.role === 'CUPID') {
					const cupid = p;
					const hunter = players.find((x) => x.role === 'HUNTER' && x !== cupid);
					const others = players.filter(
						(x) => x !== cupid && x !== hunter && !isWolf(x) && x.role !== 'GUARD'
					);
					lovers = hunter ? [hunter, others[0]] : [others[0], others[1]];
					const r = await p.act({
						kind: 'NightSubmitAction',
						action: { role: 'CUPID', seatA: seatOf(lovers[0]), seatB: seatOf(lovers[1]) }
					});
					check(r.ok, `[s] 丘比特 linked ${seatOf(lovers[0])} & ${seatOf(lovers[1])}`);
				} else if (pr.role === 'GUARD') {
					if (n === 1) {
						const r = await p.act({
							kind: 'NightSubmitAction',
							action: { role: 'GUARD', targetSeat: seatOf(pickGuardSave()) }
						});
						check(r.ok, `[s] 守卫 protects seat ${seatOf(guardSave)}`);
					} else {
						check(
							ctx.guard?.lastProtectedSeat === seatOf(guardSave),
							'[s] 守卫 is reminded who they protected last night'
						);
						const again = await p.act({
							kind: 'NightSubmitAction',
							action: { role: 'GUARD', targetSeat: seatOf(guardSave) }
						});
						check(
							!again.ok && again.error === 'guard_repeat_target',
							`[s] 守卫 can't protect the same seat twice (${again.error})`
						);
						const wolf = players.find(isWolf);
						const r = await p.act({
							kind: 'NightSubmitAction',
							action: { role: 'GUARD', targetSeat: seatOf(wolf) }
						});
						check(r.ok, '[s] 守卫 picks someone else instead');
					}
				} else if (pr.role === 'WEREWOLF') {
					const victim = n === 1 ? pickGuardSave() : lovers?.[1];
					if (!victim) continue;
					const r = await p.act({
						kind: 'NightSubmitAction',
						action: { role: 'WEREWOLF', targetSeat: seatOf(victim) }
					});
					// The second wolf is refused (the first already chose) - fine.
					if (r.ok) console.log(`[s] night ${n}: wolves attack seat ${seatOf(victim)}`);
				} else if (pr.role === 'SEER') {
					const wolf = players.find(isWolf);
					const r = await p.act({
						kind: 'NightSubmitAction',
						action: { role: 'SEER', targetSeat: seatOf(wolf) }
					});
					check(r.ok, `[s] 预言家 checked seat ${seatOf(wolf)}`);
				} else if (pr.role === 'HUNTER') {
					check(
						typeof ctx.hunter?.canShoot === 'boolean',
						`[s] 猎人 sees whether they can shoot (${ctx.hunter?.canShoot})`
					);
					const r = await p.act({ kind: 'NightConfirmStage' });
					check(r.ok, '[s] 猎人 confirmed their status');
				}
			}
			await sleep(200);
		}
		return false;
	}

	const deadSeats = async () => (await host.act({ kind: 'ResyncRequest' })).state;

	// --- Night 1 -----------------------------------------------------------------
	check(await playNight(1), '[s] night 1 reached dawn on its own');
	await host.act({ kind: 'NightAnnounceResults' });
	const after1 = await deadSeats();
	const guardInPlay = players.some((p) => p.role === 'GUARD');
	if (guardInPlay)
		check(
			after1.deadSeats.length === 0,
			`[s] the guarded seat survived - a quiet night (dead: ${JSON.stringify(after1.deadSeats)})`
		);
	else console.log('[s] no 守卫 in play - skipping the save check');

	// The thief's new card must survive a refresh.
	if (thief) {
		const again = await connect(thief.cookie, 'thief-reload');
		await again.act({ kind: 'RoomJoin', roomCode: code });
		await sleep(400);
		check(
			again.role === thiefNewRole,
			`[s] 盗贼's card after a refresh shows ${thiefNewRole} (${again.role})`
		);
		again.sock.disconnect();
	}

	// --- Day 1 -> night 2 --------------------------------------------------------
	let st = after1;
	for (let i = 0; i < 10 && st.phase === 'LAST_WORDS'; i++) {
		await host.act({ kind: 'DayNextSpeaker' });
		st = await deadSeats();
	}
	if (st.phase === 'GAME_OVER') {
		console.log('[s] game over after night 1 - stopping early');
	} else {
		const end = await host.act({ kind: 'DayEndDay' });
		check(end.ok, `[s] host started night 2 (${end.error ?? ''})`);

		// --- Night 2: wolves kill a lover; the partner must follow ---------------
		check(await playNight(2), '[s] night 2 reached dawn on its own');
		for (const p of players) p.priv.length = 0;
		await host.act({ kind: 'NightAnnounceResults' });
		await sleep(500);
		const after2 = await deadSeats();
		if (lovers) {
			const both = lovers.map(seatOf);
			check(
				both.every((s) => after2.deadSeats.includes(s)),
				`[s] a lover's death took the partner too (dead: ${JSON.stringify(after2.deadSeats)}, lovers: ${both})`
			);
			const hunter = lovers.find((l) => l.role === 'HUNTER');
			if (hunter)
				check(
					hunter.priv.some((e) => e.kind === 'ShotStatus'),
					'[s] the fallen 猎人 was told whether they may shoot'
				);
		}
	}
	for (const p of players) p.sock.disconnect();
}

if (MODE === 'full' || MODE === 'basic' || MODE === 'halt') await basicGame();
if (MODE === 'full' || MODE === 'special') await specialGame();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
