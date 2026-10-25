// End-to-end smoke test: plays a 6-player game against a running server with
// real sessions and real sockets - the server layer (handlers, projection,
// effect routing) that the engine's unit tests never touch.
//
//   npm run dev                      (in another terminal; needs Redis)
//   npm run e2e                      full game: night, dawn, 改变身份, leaving
//   npm run e2e -- halt              stops right after the wolf kill; kill the
//   npm run e2e -- resume            server, restart it, then resume checks the
//                                    night moved on by itself after the restart
//
// E2E_BASE overrides the server URL (default http://localhost:5173). Each run
// registers 6 users; registration is rate-limited per IP (60/min).
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

const tag = Date.now().toString(36).slice(-4);
const names = ['h', 'p2', 'p3', 'p4', 'p5', 'p6'].map((n) => `${n}${tag}`);
const players = [];
for (const n of names) players.push(await connect(await register(n), n));
const host = players[0];

const created = await host.act({ kind: 'RoomCreate' });
const code = created.roomCode;
check(created.ok && /^\d{6}$/.test(code), `room created ${code}`);
const cfg = await host.act({
	kind: 'RoomSubmitConfig',
	roleConfig: {
		...Object.fromEntries(
			'普通狼人 预言家 女巫 猎人 守卫 狼美人 丘比特 盗贼 白痴 骑士 禁言长老 摄梦人 高级村民 老流氓 普通村民 白狼王 黑狼王 隐狼 恶魔 恶灵骑士 梦魇 机械狼 野孩子'
				.split(' ')
				.map((r) => [r, 0])
		),
		普通狼人: 2,
		预言家: 1,
		女巫: 1,
		普通村民: 2
	},
	cupidPoisonBlocksHunter: false
});
check(cfg.ok, `config submitted ${JSON.stringify(cfg.error ?? '')}`);
for (const p of players.slice(1)) await p.act({ kind: 'RoomJoin', roomCode: code });
for (const [i, p] of players.entries()) {
	const r = await p.act({ kind: 'SeatTake', seatNumber: i + 1 });
	if (!r.ok) console.log('seat', i + 1, r);
	await p.act({ kind: 'RevealRole' });
}
await host.act({ kind: 'RoomLockSeats', locked: true });
const started = await host.act({ kind: 'RoomStartGame' });
check(started.ok, `game started ${JSON.stringify(started.error ?? '')}`);
await sleep(500);
const seatOf = (p) => players.indexOf(p) + 1;
const byRole = (role) => players.filter((p) => p.role === role);
console.log('roles:', players.map((p) => `${seatOf(p)}=${p.role}`).join(' '));

// --- Night 1: play every prompt as it arrives -------------------------------
const villagers = byRole('普通村民');
const victim = villagers[0];
const wolves = byRole('普通狼人');
const seer = byRole('预言家')[0];
const witch = byRole('女巫')[0];
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
			if (pr.role === '普通狼人') action = { role: '普通狼人', targetSeat: seatOf(victim) };
			if (pr.role === '预言家') action = { role: '预言家', targetSeat: seatOf(wolves[0]) };
			if (pr.role === '女巫') action = { role: '女巫', poisonTarget: null, useAntidote: false };
			if (!action) continue;
			const r = await p.act({ kind: 'NightSubmitAction', action });
			if (pr.role === '普通狼人' && p === wolves[0]) {
				check(r.ok, `wolf kill on seat ${seatOf(victim)}`);
				if (MODE === 'halt') {
					fs.writeFileSync(STATE_FILE, JSON.stringify({ code, hostCookie: host.cookie }));
					console.log('HALT  wolf kill in, stopping now');
					process.exit(0);
				}
			}
			if (pr.role === '预言家') {
				check(r.ok, 'seer check');
				// Double-tap: a second check the same night must be refused.
				const again = await p.act({
					kind: 'NightSubmitAction',
					action: { role: '预言家', targetSeat: seatOf(villagers[1]) }
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
	role: '普通村民'
});
check(so.ok, `host changed seat ${seatOf(target)} to 普通村民`);
await sleep(600);
check(target.role === '普通村民', 'target phone got the new card');
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
check(reload.role === '普通村民', `card after a refresh shows the new role (${reload.role})`);
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
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
