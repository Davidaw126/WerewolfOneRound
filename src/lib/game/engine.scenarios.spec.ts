// Whole-game simulations: plays many complete games end to end, on every
// preset board plus custom boards covering every implemented role, with
// randomized (but rule-respecting) choices for every player and the host.
//
// What this guards against is the class of bug unit tests miss: a state the
// game can wander into after a few rounds where the judge's next move does
// nothing at all - the game silently stalls and nobody can move it on. After
// every host step it asserts the state actually changed, and that every night
// each living holder of an acting role really got their turn prompt.

import { describe, it, expect } from 'vitest';
import { startGame, reduce, stageConfirmComplete } from './engine';
import { buildSetup, validateSetup } from './rules/setup';
import { dealCards, deriveSeatCount } from './rules/deal';
import { PRESET_BOARDS } from './rules/presets';
import { ROLE_META, PACK_KILL_ROLES, STATUS_STAGE_ROLES, actsInStage } from './roleMeta';
import { notifyRoleHolders } from './rules/turnContext';
import { defaultRuleConfig, makeState } from './testFixtures';
import { cascadeDeaths, canTriggerShoot } from './rules/nightResolution';
import { baseCamp } from './rules/winCondition';
import type {
	Death,
	DeathCause,
	EngineAction,
	EngineEffect,
	EngineResult,
	GameState,
	RoleId,
	RuleConfig,
	Seat
} from './types';

type RoleConfig = Partial<Record<RoleId, number>>;

/** mulberry32 - small, seedable, good enough for test-choice randomness. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const kindOf = (e: EngineEffect) => (e.payload as { kind?: string } | undefined)?.kind;

function living(state: GameState): Seat[] {
	return Object.values(state.players)
		.filter((p) => !p.isDead)
		.map((p) => p.seat)
		.sort((a, b) => a - b);
}

function pick<T>(rng: () => number, items: readonly T[]): T | undefined {
	return items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];
}

/** Same matching rule as turnContext.ts's notifyRoleHolders. */
function holdersOf(state: GameState, stageRole: RoleId): Seat[] {
	return Object.values(state.players)
		.filter((p) => !p.isDead && actsInStage(stageRole, p.role))
		.map((p) => p.seat)
		.sort((a, b) => a - b);
}

interface Options {
	/** Day 1: every voter votes for the IDIOT (if alive). */
	exileIdiotDay1?: boolean;
	/** The old in-app day: EXILE / phone votes / HUNTER_SHOOT on the phone.
	 * Off = the shipped table flow (shotsAtTable, DAY_OUT). */
	legacy?: boolean;
	tweak?: (cfg: RuleConfig) => void;
	/** The host now and then changes a living player's card mid-night. */
	roleChanges?: boolean;
}

interface GameLog {
	rounds: number;
	winner: string | null;
	idiotRevealedAndSurvivedVote: boolean;
	promptsByRole: Map<RoleId, number>;
	/** Table-flow counters - what actually happened across the game. */
	stats: Record<string, number>;
}

class Sim {
	state: GameState;
	log: GameLog = {
		rounds: 0,
		winner: null,
		idiotRevealedAndSurvivedVote: false,
		promptsByRole: new Map(),
		stats: {}
	};
	/** Status-stage 👍/👎 shown to each shooter tonight, by seat. */
	private predicted = new Map<Seat, boolean>();
	/** Last night's deaths, with causes, for the morning's table shots. */
	private nightDeaths: Death[] = [];
	/** 白痴 flipped at the table - the app is never told. */
	private tableIdiots = new Set<Seat>();
	private rng: () => number;
	readonly roleConfig: RoleConfig;
	readonly opts: Options;

	constructor(roleConfig: RoleConfig, seed: number, opts: Options = {}) {
		this.roleConfig = roleConfig;
		this.opts = opts;
		this.rng = seeded(seed);
		const deal = dealCards(roleConfig, this.rng);
		const seatCount = deriveSeatCount(roleConfig);
		const ruleConfig = defaultRuleConfig();
		if (opts.legacy) ruleConfig.shotsAtTable = false;
		opts.tweak?.(ruleConfig);
		const players = Array.from({ length: seatCount }, (_, i) => ({
			seat: i + 1,
			sessionId: `s${i + 1}`,
			nickname: `P${i + 1}`
		}));
		const result = startGame({
			roomCode: 'SIM',
			ruleConfig,
			setup: buildSetup(roleConfig),
			deal,
			players,
			now: 0
		});
		this.state = result.state;
		this.check(result);
	}

	private apply(action: EngineAction): EngineResult {
		const result = reduce(this.state, action);
		this.state = result.state;
		this.check(result);
		return result;
	}

	/** Invariants that must hold after every single engine call. */
	private check(result: EngineResult): void {
		const s = result.state;
		for (const e of result.effects) {
			const kind = kindOf(e);
			if (kind === 'YourTurnPrompt') {
				const p = s.players[e.seat!];
				expect(p, `prompt sent to an empty seat ${e.seat}`).toBeDefined();
				expect(p.isDead, `prompt sent to dead seat ${e.seat}`).toBe(false);
				const { role, context } = e.payload as {
					role: RoleId;
					context?: { hunter?: { canShoot: boolean } };
				};
				this.log.promptsByRole.set(role, (this.log.promptsByRole.get(role) ?? 0) + 1);
				// The 黑狼王 is also woken in the pack's WEREWOLF stage - only his
				// own stage is the 确认开枪状态 one.
				if (STATUS_STAGE_ROLES.has(role) && s.currentStepKey === `role:${role}`) {
					expect(context?.hunter, `${role} status prompt without a 👍/👎`).toBeDefined();
					this.predicted.set(e.seat!, context!.hunter!.canShoot);
				}
			}
			if (kind === 'StageChanged') {
				const stage = (e.payload as { stage: { kind: string; role?: RoleId } | null }).stage;
				if (stage?.kind === 'ROLE_TURN' && stage.role) {
					// Every living holder of an acting role must be woken.
					const expected = holdersOf(s, stage.role);
					const got = result.effects
						.filter((x) => kindOf(x) === 'YourTurnPrompt')
						.map((x) => x.seat!)
						.sort((a, b) => a - b);
					expect(got, `round ${s.round} ${stage.role}: holders not all prompted`).toEqual(expected);
				}
			}
		}
		for (const p of Object.values(s.players)) {
			if (p.isRevealedIdiot) expect(p.hasVoteRight).toBe(false);
		}
	}

	private bump(key: string, by = 1): void {
		this.log.stats[key] = (this.log.stats[key] ?? 0) + by;
	}

	/** Dawn: announce, then hold the night's 👍/👎 to what really happened. */
	private announce(): void {
		const result = this.apply({ type: 'ANNOUNCE_NIGHT_RESULTS' });
		const announced = result.effects.find((e) => kindOf(e) === 'NightResultsAnnounced');
		this.nightDeaths = announced ? (announced.payload as { deaths: Death[] }).deaths : [];
		const status = new Map(
			result.effects
				.filter((e) => kindOf(e) === 'ShotStatus')
				.map((e) => [e.seat!, (e.payload as { canShoot: boolean }).canShoot])
		);
		for (const [seat, canShoot] of this.predicted) {
			const died = this.nightDeaths.find((d) => d.seat === seat);
			const actual = died ? canTriggerShoot(this.state.ruleConfig, this.state, died) : true;
			expect(canShoot, `round ${this.state.round} seat ${seat}: night 👍/👎 was wrong`).toBe(
				actual
			);
			if (!this.opts.legacy && died) {
				expect(status.get(seat), `seat ${seat} died but got no ShotStatus`).toBe(actual);
			}
			this.bump(canShoot ? 'statusThumbUp' : 'statusThumbDown');
		}
		this.predicted.clear();
		if (!this.opts.legacy) expect(this.state.pendingShoots).toEqual([]);
	}

	/** DAY_OUT, returning everyone who left with the cause the TABLE knows
	 * for a marked seat (it saw why) and the engine's own for a follow death. */
	private markOut(seats: Seat[], tableCause: DeathCause): Death[] {
		const result = this.apply({ type: 'DAY_OUT', seats });
		const ev = result.effects.find((e) => kindOf(e) === 'DayOut');
		expect(ev, `DAY_OUT ${seats} produced no DayOut`).toBeDefined();
		const { followDeaths } = ev!.payload as { seats: Seat[]; followDeaths: Seat[] };
		for (const seat of seats) expect(this.state.players[seat].isDead).toBe(true);
		expect(this.state.pendingShoots).toEqual([]);
		const out: Death[] = seats.map((seat) => ({ seat, cause: tableCause }));
		for (const f of followDeaths) {
			const cause = this.state.players[f].deathCause!;
			expect(['LOVER_SUICIDE', 'WOLF_BEAUTY_LINK']).toContain(cause);
			this.bump(`follow:${cause}`);
			// The app must privately tell a shooter dragged along whether he may shoot.
			const role = this.state.players[f].role;
			if (STATUS_STAGE_ROLES.has(role) || role === 'WOLF_KING') {
				const st = result.effects.find((e) => e.seat === f && kindOf(e) === 'ShotStatus');
				expect(st, `follow-death shooter ${f} got no ShotStatus`).toBeDefined();
				expect((st!.payload as { canShoot: boolean }).canShoot).toBe(
					canTriggerShoot(this.state.ruleConfig, this.state, { seat: f, cause })
				);
			}
			out.push({ seat: f, cause });
		}
		return out;
	}

	private get over(): boolean {
		return this.state.phase === 'GAME_OVER';
	}

	/** Every shooter among `deaths` fires at the table (or holds fire); the
	 * host marks the victim, which can chain into another shot. */
	private resolveShots(deaths: Death[]): void {
		const queue = [...deaths];
		while (queue.length > 0 && !this.over) {
			const d = queue.shift()!;
			if (!canTriggerShoot(this.state.ruleConfig, this.state, d)) continue;
			const shooter = this.state.players[d.seat];
			const target = this.rng() < 0.15 ? undefined : pick(this.rng, living(this.state));
			if (target === undefined) continue;
			const cause: DeathCause = shooter.role === 'HUNTER' ? 'HUNTER_SHOT' : 'WOLF_KING_SHOT';
			this.bump(`shot:${shooter.role}`);
			queue.push(...this.markOut([target], cause));
		}
	}

	/** The shipped day: everything public happens at the table; the host
	 * only marks who left (DAY_OUT), runs a 骑士决斗, then 进入下一夜. */
	private tableDay(): void {
		const cfg = this.state.ruleConfig;
		this.resolveShots(this.nightDeaths);
		this.nightDeaths = [];
		if (this.over) return;

		const knight = Object.values(this.state.players).find((p) => !p.isDead && p.role === 'KNIGHT');
		if (knight && !this.state.knightUsed && this.rng() < 0.3) {
			const target = pick(
				this.rng,
				living(this.state).filter((x) => x !== knight.seat)
			)!;
			// baseCamp: a converted 野孩子 counts as a wolf here, like in the engine.
			const wasWolf = baseCamp(this.state.players[target]) === 'WEREWOLF';
			const pre = this.state;
			const res = this.apply({ type: 'KNIGHT_DUEL', knightSeat: knight.seat, targetSeat: target });
			this.bump(wasWolf ? 'duel:wolf' : 'duel:good');
			const loser = wasWolf ? target : knight.seat;
			expect(this.state.players[loser].isDead || !cfg.knight.knightDiesIfGood).toBe(true);
			const ev = res.effects.find((e) => kindOf(e) === 'KnightDuelResolved')!.payload as {
				deaths: Seat[];
			};
			// Every death the duel caused reaches the phones.
			expect(ev.deaths).toEqual(
				Object.values(this.state.players)
					.filter((p) => p.isDead && !pre.players[p.seat].isDead)
					.map((p) => p.seat)
					.sort((a, b) => a - b)
			);
			const duelDeaths: Death[] = ev.deaths.map((seat) => ({
				seat,
				cause: this.state.players[seat].deathCause!
			}));
			this.resolveShots(duelDeaths);
			if (this.over) return;
			if (wasWolf && cfg.knight.duelEndsDayIfWolf) {
				expect(this.state.dayDecided).toBe(true);
				return void this.apply({ type: 'END_DAY' });
			}
		}

		// Now and then the host uses 上帝之手 to remove a player (a phone
		// died, someone left): every death it causes must reach the phones.
		if (this.rng() < 0.05) {
			const seat = pick(this.rng, living(this.state))!;
			const pre = this.state;
			const res = this.apply({ type: 'HOST_OVERRIDE', seat, kind: 'KILL' });
			const ev = res.effects.find((e) => kindOf(e) === 'HostOverrideApplied')!.payload as {
				deaths: Seat[];
			};
			expect(ev.deaths).toEqual(
				Object.values(this.state.players)
					.filter((p) => p.isDead && !pre.players[p.seat].isDead)
					.map((p) => p.seat)
					.sort((a, b) => a - b)
			);
			expect(this.state.pendingShoots).toEqual([]);
			this.bump('hostKill');
			if (ev.deaths.length > 1) this.bump('hostKillCascade');
			if (this.over) return;
		}

		const r = this.rng();
		const wolves = Object.values(this.state.players).filter(
			(p) => !p.isDead && ROLE_META[p.role].camp === 'WEREWOLF'
		);
		if (r < 0.1 && wolves.length > 0) {
			const wolf = pick(this.rng, wolves)!;
			this.bump(`explode:${wolf.role}`);
			this.resolveShots(this.markOut([wolf.seat], 'SELF_EXPLODE'));
			if (this.over) return;
			if (cfg.wolf.selfExplodeEndsDay) return void this.apply({ type: 'END_DAY' });
		}

		if (this.rng() < 0.85) {
			const idiotForced = this.opts.exileIdiotDay1 && this.state.round === 1;
			const idiot = Object.values(this.state.players).find(
				(p) => p.role === 'IDIOT' && !p.isDead && !this.tableIdiots.has(p.seat)
			);
			const exilable = living(this.state).filter((x) => !this.tableIdiots.has(x));
			const seat = idiotForced && idiot ? idiot.seat : pick(this.rng, exilable);
			if (seat !== undefined) {
				if (this.state.players[seat].role === 'IDIOT' && cfg.idiot.revealOnExile) {
					// Flips his card at the table - the host marks nobody.
					this.tableIdiots.add(seat);
					this.log.idiotRevealedAndSurvivedVote = true;
					this.bump('idiotFlip');
				} else {
					this.bump('exile');
					this.resolveShots(this.markOut([seat], 'VOTE_OUT'));
					if (this.over) return;
				}
			}
		}
		this.apply({ type: 'END_DAY' });
		if (!this.over) expect(this.state.phase).toBe('NIGHT');
	}

	/** One judge-level step. Throws if the game can't be moved on. */
	step(): void {
		const before = JSON.stringify(this.state);
		const s = this.state;
		switch (s.phase) {
			case 'FIRST_NIGHT':
			case 'NIGHT':
				this.nightStep();
				break;
			case 'DAWN':
				this.announce();
				break;
			case 'LAST_WORDS':
				this.apply({ type: 'NEXT_SPEAKER' });
				break;
			case 'HUNTER_SHOOT': {
				if (!this.opts.legacy) throw new Error('table flow must never stop in HUNTER_SHOOT');
				const shooter = s.pendingShoots[0];
				const target =
					this.rng() < 0.2
						? null
						: (pick(
								this.rng,
								living(s).filter((x) => x !== shooter)
							) ?? null);
				this.apply({ type: 'HUNTER_SHOOT', shooterSeat: shooter, targetSeat: target });
				break;
			}
			case 'DISCUSSION':
				this.discussionStep();
				break;
			case 'VOTE':
			case 'VOTE_PK':
				this.voteStep();
				break;
			default:
				throw new Error(`unexpected phase ${s.phase}`);
		}
		if (this.state.phase !== 'GAME_OVER' && JSON.stringify(this.state) === before) {
			throw new Error(
				`STALL: phase=${s.phase} step=${s.currentStepKey} round=${s.round} - the judge's move did nothing`
			);
		}
	}

	/** 上帝之手 · 改变身份 in the middle of the night: the phone learns the
	 * new card, and is woken at once if that role's turn is the current one. */
	private midNightRoleChange(): void {
		const s = this.state;
		const seat = pick(this.rng, living(s));
		const roles = (Object.keys(this.roleConfig) as RoleId[]).filter(
			(r) => r !== s.players[seat!].role
		);
		const role = pick(this.rng, roles);
		if (seat === undefined || role === undefined) return;
		const res = this.apply({ type: 'HOST_OVERRIDE', seat, kind: 'SET_ROLE', role });
		const toSeat = res.effects.filter((e) => e.seat === seat);
		expect(toSeat.some((e) => kindOf(e) === 'YourRole')).toBe(true);
		const key = s.currentStepKey;
		if (key?.startsWith('role:')) {
			const stageRole = key.slice('role:'.length) as RoleId;
			const shouldWake = actsInStage(stageRole, role) && !s.submittedRoles.includes(stageRole);
			expect(toSeat.some((e) => kindOf(e) === 'YourTurnPrompt')).toBe(shouldWake);
		}
		this.bump('midNightRoleChange');
	}

	private nightStep(): void {
		if (this.opts.roleChanges && this.rng() < 0.04) {
			this.midNightRoleChange();
			// Turning the last wolf good (or the like) ends the game there and then.
			if (this.over) return;
		}
		const s = this.state;
		const key = s.currentStepKey;
		const advance = () => this.apply({ type: 'ADVANCE_STAGE', expectedStepKey: key });
		if (key === 'couple_reveal') return void this.confirmCouple();
		if (!key || !key.startsWith('role:')) return void advance();
		const stageRole = key.slice('role:'.length) as RoleId;
		const holders = holdersOf(s, stageRole);
		// 确认开枪状态: the shooter confirms on their own phone (eyes shut for
		// everyone else); a dead holder's 假环节 auto-advances as before.
		if (STATUS_STAGE_ROLES.has(stageRole) && holders.length > 0) {
			const stranger = living(s).find((x) => !holders.includes(x));
			if (stranger !== undefined) {
				const r = reduce(s, { type: 'CONFIRM_STAGE', seat: stranger });
				expect(r.state.currentStepKey, 'a non-holder moved the status stage on').toBe(key);
			}
			// Every holder (a 上帝之手 duplicate included) gets to look.
			holders.forEach((seat, i) => {
				this.apply({ type: 'CONFIRM_STAGE', seat });
				expect(
					stageConfirmComplete(this.state),
					`status stage complete after ${i + 1}/${holders.length} confirms`
				).toBe(i === holders.length - 1);
			});
			// The IO shell's post-action pause, then on to the next role.
			this.apply({ type: 'ADVANCE_STAGE', expectedStepKey: key });
			this.bump('statusConfirmed');
			return;
		}
		const done =
			s.submittedRoles.includes(stageRole) ||
			(stageRole === 'WEREWOLF' && s.submittedRoles.some((r) => PACK_KILL_ROLES.has(r)));
		if (holders.length === 0 || STATUS_STAGE_ROLES.has(stageRole) || done) return void advance();

		// Any holder may act (the wolf kill is shared). Like the real app, the
		// judge has NO skip button for a regular role's turn - only COUPLE_REVEAL
		// and the 确认开枪状态 stages (HUNTER/BLACK_WOLF_KING) are host-advanced, and an absent role's 假环节 stage
		// auto-advances. So if no holder can make any accepted submission, the
		// night is genuinely stuck.
		let submitted = false;
		for (const seat of holders) {
			for (let attempt = 0; attempt < 12 && !submitted; attempt++) {
				const role = s.players[seat].role;
				// A feared player's prompt only offers a pass (an empty action).
				const action =
					s.fearedSeat === seat && role !== 'NIGHTMARE'
						? {}
						: stageRole === 'WEREWOLF'
							? this.nightChoice(seat, 'WEREWOLF', attempt) // every pack member picks the kill here
							: this.nightChoice(seat, role, attempt);
				const result = reduce(this.state, { type: 'SUBMIT_NIGHT_ACTION', seat, role, action });
				const rejected = result.effects.find(
					(e) => e.seat === seat && kindOf(e) === 'NightActionRejected'
				);
				if (rejected) {
					this.lastRejection = (rejected.payload as { error: string }).error;
					continue;
				}
				if (JSON.stringify(result.state) === JSON.stringify(this.state)) continue; // silent no-op
				this.state = result.state;
				this.check(result);
				submitted = true;
				if (stageRole === 'WEREWOLF') {
					// Every other living wolf still looking at the prompt is told
					// a teammate settled it (so they can close their eyes).
					const told = result.effects
						.filter((e) => kindOf(e) === 'PackKillChosen')
						.map((e) => e.seat!)
						.sort((x, y) => x - y);
					expect(told).toEqual(holders.filter((h) => h !== seat));
					if (told.length > 0) this.bump('packKillShared');
					const by = s.players[seat].role;
					if (by === 'WOLF_BEAUTY' || by === 'NIGHTMARE') {
						expect(this.state.submittedRoles).toContain('WEREWOLF');
						this.bump(`packKillBy:${by}`);
					}
				} else {
					// Only reachable via a 上帝之手 duplicate: the other holder is told.
					const told = result.effects
						.filter((e) => kindOf(e) === 'RoleDoneByOther')
						.map((e) => e.seat!)
						.sort((x, y) => x - y);
					expect(told).toEqual(holders.filter((h) => h !== seat));
					if (told.length > 0) this.bump('duplicateRoleTold');
				}
			}
			if (submitted) break;
		}
		if (!submitted) {
			throw new Error(
				`STALL: round ${s.round} ${stageRole} turn - no holder could submit anything (last rejection: ${this.lastRejection}), and the judge has no skip button`
			);
		}
		// The IO shell auto-advances a beat after a submission.
		advance();
	}

	/** 情侣相认: a non-lover's tap does nothing; the stage moves on only once
	 * every living lover has confirmed. */
	private confirmCouple(): void {
		const s = this.state;
		const lovers = (s.lovers ?? []).filter((x) => !s.players[x].isDead);
		if (lovers.length === 0) return void this.apply({ type: 'ADVANCE_STAGE' });
		const stranger = living(s).find((x) => !lovers.includes(x));
		if (stranger !== undefined) {
			const r = reduce(s, { type: 'CONFIRM_STAGE', seat: stranger });
			expect(r.effects, 'a non-lover tap must leave no trace').toEqual([]);
		}
		lovers.forEach((seat, i) => {
			this.apply({ type: 'CONFIRM_STAGE', seat });
			expect(
				stageConfirmComplete(this.state),
				`couple stage complete after ${i + 1}/${lovers.length} confirms`
			).toBe(i === lovers.length - 1);
		});
		this.apply({ type: 'ADVANCE_STAGE', expectedStepKey: 'couple_reveal' });
		this.bump('coupleConfirmed');
	}

	private lastRejection: string | null = null;

	private nightChoice(seat: Seat, role: RoleId, attempt: number): Record<string, unknown> {
		const s = this.state;
		const others = living(s).filter((x) => x !== seat);
		const any = living(s);
		const late = attempt >= 4; // after a few rejections, fall back to the simplest valid move
		switch (role) {
			case 'WEREWOLF':
			case 'WOLF_KING':
			case 'BLACK_WOLF_KING':
				return { wolfKillTarget: this.rng() < 0.1 ? null : pick(this.rng, any) };
			case 'SEER':
				return { seerCheckTarget: pick(this.rng, others) };
			case 'WITCH': {
				if (late) return {};
				const r = this.rng();
				const killed = s.nightActions.wolfKillTarget ?? null;
				if (r < 0.35 && killed !== null && !s.witchAntidoteUsed) return { witchAntidoteTarget: 0 };
				if (r < 0.65 && !s.witchPoisonUsed) return { witchPoisonTarget: pick(this.rng, others) };
				return {};
			}
			case 'GUARD':
				return {
					guardTarget: pick(
						this.rng,
						any.filter((x) => x !== s.lastGuardTarget)
					)
				};
			case 'WOLF_BEAUTY':
				return { wolfBeautyCharmTarget: pick(this.rng, others) };
			case 'NIGHTMARE':
				return { nightmareFearTarget: pick(this.rng, others) };
			case 'DREAM_WEAVER':
				return { dreamWeaverTarget: pick(this.rng, others) };
			case 'WILD_CHILD':
				return { wildChildIdol: pick(this.rng, others) };
			case 'CUPID': {
				const a = pick(this.rng, any)!;
				const b = pick(
					this.rng,
					any.filter((x) => x !== a)
				)!;
				return { cupidLinks: [a, b] };
			}
			case 'THIEF': {
				const cards = s.players[seat].thiefExtraCards ?? [];
				const bothWolf = cards.length === 2 && cards.every((c) => ROLE_META[c].camp === 'WEREWOLF');
				if (bothWolf || this.rng() < 0.6) return { thiefPick: pick(this.rng, cards) };
				return {};
			}
			default:
				return {};
		}
	}

	private discussionStep(): void {
		if (!this.opts.legacy) return void this.tableDay();
		const s = this.state;
		const r = this.rng();
		const wolves = Object.values(s.players).filter(
			(p) => !p.isDead && ROLE_META[p.role].camp === 'WEREWOLF'
		);
		const knight = Object.values(s.players).find((p) => !p.isDead && p.role === 'KNIGHT');
		// The host's only move once the day is settled.
		if (s.dayDecided) return void this.apply({ type: 'END_DAY' });
		if (r < 0.07 && wolves.length > 0) {
			this.apply({ type: 'SELF_EXPLODE', seat: pick(this.rng, wolves)!.seat });
			return;
		}
		if (r < 0.15 && knight && !s.knightUsed) {
			const target = pick(
				this.rng,
				living(s).filter((x) => x !== knight.seat)
			);
			if (target !== undefined) {
				this.apply({ type: 'KNIGHT_DUEL', knightSeat: knight.seat, targetSeat: target });
				return;
			}
		}
		// The shipped flow: the host records the table's hand vote (EXILE), or
		// skips straight to night. The in-app vote stays covered too.
		if (r < 0.75) {
			const idiot = Object.values(s.players).find(
				(p) => p.role === 'IDIOT' && !p.isDead && !p.isRevealedIdiot
			);
			const exilable = living(s).filter((x) => !s.players[x].isRevealedIdiot);
			const seat =
				this.opts.exileIdiotDay1 && s.round === 1 && idiot ? idiot.seat : pick(this.rng, exilable);
			if (seat !== undefined) {
				this.apply({ type: 'EXILE', seat });
				const p = this.state.players[seat];
				if (p.isRevealedIdiot && !p.isDead) this.log.idiotRevealedAndSurvivedVote = true;
				return;
			}
		}
		if (r < 0.82) return void this.apply({ type: 'END_DAY' });
		this.apply({ type: 'BEGIN_VOTE' });
	}

	private voteStep(): void {
		const s = this.state;
		const inPk = s.phase === 'VOTE_PK';
		const idiot = Object.values(s.players).find(
			(p) => p.role === 'IDIOT' && !p.isDead && !p.isRevealedIdiot
		);
		const forceIdiot = this.opts.exileIdiotDay1 && s.round === 1 && idiot && !inPk;
		const voters = Object.values(s.players).filter(
			(p) =>
				!p.isDead &&
				p.hasVoteRight &&
				s.fearedSeat !== p.seat &&
				!(inPk && s.pkCandidates.includes(p.seat))
		);
		const candidates = inPk ? s.pkCandidates : living(s);
		for (const v of voters) {
			const target = forceIdiot
				? idiot!.seat
				: this.rng() < 0.1
					? 'ABSTAIN'
					: (pick(this.rng, candidates) ?? 'ABSTAIN');
			this.apply({ type: 'CAST_VOTE', seat: v.seat, target });
		}
		const idiotBefore = idiot?.seat;
		this.apply({ type: 'TALLY_VOTES', random: Math.floor(this.rng() * 1000) });
		if (idiotBefore !== undefined) {
			const p = this.state.players[idiotBefore];
			if (p.isRevealedIdiot && !p.isDead) this.log.idiotRevealedAndSurvivedVote = true;
		}
	}

	run(maxSteps = 3000): GameLog {
		for (let i = 0; i < maxSteps && this.state.phase !== 'GAME_OVER'; i++) this.step();
		expect(this.state.phase, `game never ended (round ${this.state.round})`).toBe('GAME_OVER');
		this.log.rounds = this.state.round;
		this.log.winner = this.state.winner;
		return this.log;
	}
}

const CUSTOM_BOARDS: { name: string; roleConfig: RoleConfig }[] = [
	{
		name: 'idiot + hunter',
		roleConfig: { WEREWOLF: 2, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1, VILLAGER: 2 }
	},
	{
		name: 'wolf king + guard + knight',
		roleConfig: { WEREWOLF: 2, WOLF_KING: 1, SEER: 1, WITCH: 1, GUARD: 1, KNIGHT: 1, VILLAGER: 2 }
	},
	{
		name: 'black wolf king + hunter + witch',
		roleConfig: {
			WEREWOLF: 2,
			BLACK_WOLF_KING: 1,
			SEER: 1,
			WITCH: 1,
			HUNTER: 1,
			GUARD: 1,
			VILLAGER: 3
		}
	},
	{
		name: 'both wolf kings, no plain wolves',
		roleConfig: { WOLF_KING: 1, BLACK_WOLF_KING: 1, SEER: 1, WITCH: 1, HUNTER: 1, VILLAGER: 3 }
	},
	{
		name: 'wolf beauty + cupid',
		roleConfig: { WEREWOLF: 2, WOLF_BEAUTY: 1, SEER: 1, WITCH: 1, HUNTER: 1, CUPID: 1, VILLAGER: 2 }
	},
	{
		name: 'nightmare + dream weaver + wild child',
		roleConfig: {
			WEREWOLF: 2,
			NIGHTMARE: 1,
			SEER: 1,
			WITCH: 1,
			DREAM_WEAVER: 1,
			WILD_CHILD: 1,
			VILLAGER: 2
		}
	},
	{
		name: 'thief',
		roleConfig: { WEREWOLF: 2, SEER: 1, WITCH: 1, HUNTER: 1, THIEF: 1, VILLAGER: 3 }
	},
	{
		name: 'every role at once',
		roleConfig: {
			WEREWOLF: 3,
			WOLF_KING: 1,
			BLACK_WOLF_KING: 1,
			WOLF_BEAUTY: 1,
			NIGHTMARE: 1,
			SEER: 1,
			WITCH: 1,
			HUNTER: 1,
			GUARD: 1,
			IDIOT: 1,
			KNIGHT: 1,
			CUPID: 1,
			THIEF: 1,
			WILD_CHILD: 1,
			DREAM_WEAVER: 1,
			VILLAGER: 4
		}
	}
];

const BOARDS = [
	...PRESET_BOARDS.map((b) => ({ name: b.name, roleConfig: b.roleConfig as RoleConfig })),
	...CUSTOM_BOARDS
];

const GAMES_PER_BOARD = 80;

describe('whole-game simulation', () => {
	it('every board used here is itself a valid setup', () => {
		for (const b of BOARDS) {
			const setup = buildSetup(b.roleConfig);
			expect(validateSetup(setup, setup.numberOfSeats).ok, b.name).toBe(true);
		}
	});

	for (const board of BOARDS) {
		it(`${board.name}: ${GAMES_PER_BOARD} random games all finish without stalling`, () => {
			let multiRound = 0;
			for (let seed = 1; seed <= GAMES_PER_BOARD; seed++) {
				try {
					const log = new Sim(board.roleConfig, seed * 7919).run();
					if (log.rounds >= 3) multiRound++;
				} catch (err) {
					throw new Error(`[${board.name} seed ${seed * 7919}] ${(err as Error).message}`, {
						cause: err
					});
				}
			}
			// Sanity: the simulation really does reach later rounds, not just
			// games that end on night 1.
			expect(multiRound).toBeGreaterThan(0);
		});
	}

	it('every acting role on the all-roles board gets prompted across the runs', () => {
		const seen = new Set<RoleId>();
		for (let seed = 1; seed <= 60; seed++) {
			const log = new Sim(CUSTOM_BOARDS[CUSTOM_BOARDS.length - 1].roleConfig, seed).run();
			for (const role of log.promptsByRole.keys()) seen.add(role);
		}
		for (const role of [
			'WEREWOLF',
			'WOLF_KING',
			'WOLF_BEAUTY',
			'NIGHTMARE',
			'SEER',
			'WITCH',
			'HUNTER',
			'GUARD',
			'CUPID',
			'THIEF',
			'WILD_CHILD',
			'DREAM_WEAVER'
		] as RoleId[]) {
			expect(seen.has(role), `${role} never got a turn`).toBe(true);
		}
	});
});

/** A random valid board for `n` players: about a third wolves (some of them
 * special wolves), a random set of special good roles, villagers for the
 * rest. A 盗贼 adds the two extra cards he picks from. */
function randomBoard(n: number, rng: () => number): RoleConfig {
	const WOLF_SPECIALS: RoleId[] = ['WOLF_KING', 'BLACK_WOLF_KING', 'WOLF_BEAUTY', 'NIGHTMARE'];
	const GOOD_SPECIALS: RoleId[] = [
		'SEER',
		'WITCH',
		'HUNTER',
		'GUARD',
		'IDIOT',
		'KNIGHT',
		'CUPID',
		'WILD_CHILD',
		'DREAM_WEAVER',
		'THIEF'
	];
	for (;;) {
		const cfg: RoleConfig = {};
		const wolves = Math.max(1, Math.round(n / 3) - (rng() < 0.3 ? 1 : 0));
		let plain = wolves;
		for (const w of WOLF_SPECIALS) {
			if (plain > 0 && rng() < 0.4) {
				cfg[w] = 1;
				plain--;
			}
		}
		if (plain > 0) cfg.WEREWOLF = plain;
		const goods = n - wolves;
		let left = goods;
		for (const g of [...GOOD_SPECIALS].sort(() => rng() - 0.5)) {
			if (left > 1 && rng() < 0.55) {
				cfg[g] = 1;
				left--;
			}
		}
		// 盗贼's two extra cards: plain villagers, or now and then a wolf.
		if (cfg.THIEF) cfg.VILLAGER = (cfg.VILLAGER ?? 0) + 2;
		cfg.VILLAGER = (cfg.VILLAGER ?? 0) + left;
		if (deriveSeatCount(cfg) !== n) continue;
		const setup = buildSetup(cfg);
		if (validateSetup(setup, n).ok) return cfg;
	}
}

/** House-rule variants every generated board is also played under. */
const RULE_VARIANTS: { name: string; tweak?: (cfg: RuleConfig) => void }[] = [
	{ name: 'defaults' },
	{
		name: 'lover-death shots flipped',
		tweak: (c) => {
			c.hunter.canShootWhenLoverSuicide = !c.hunter.canShootWhenLoverSuicide;
			c.wolf.blackWolfKingCanShootWhenLoverSuicide = !c.wolf.blackWolfKingCanShootWhenLoverSuicide;
			c.cupidPoisonBlocksHunter = !c.cupidPoisonBlocksHunter;
		}
	},
	{
		name: 'day goes on after explode/duel, knight survives, 屠城',
		tweak: (c) => {
			c.wolf.selfExplodeEndsDay = false;
			c.knight.duelEndsDayIfWolf = false;
			c.knight.knightDiesIfGood = false;
			c.winCondition = 'TOTAL_KILL';
		}
	}
];

describe('6 to 12 players: random boards, every rule variant', () => {
	const BOARDS_PER_COUNT = 10;
	const GAMES_PER_BOARD = 12;
	const totals: Record<string, number> = {};
	const prompted = new Set<RoleId>();
	const dealt = new Set<RoleId>();

	for (let n = 6; n <= 12; n++) {
		it(`${n} players: ${BOARDS_PER_COUNT} boards x ${RULE_VARIANTS.length} rule sets x ${GAMES_PER_BOARD} games, table flow`, () => {
			const rng = seeded(n * 104729);
			for (let b = 0; b < BOARDS_PER_COUNT; b++) {
				const board = randomBoard(n, rng);
				for (const role of Object.keys(board) as RoleId[]) dealt.add(role);
				for (const variant of RULE_VARIANTS) {
					for (let g = 1; g <= GAMES_PER_BOARD; g++) {
						const seed = n * 1_000_003 + b * 1009 + g;
						try {
							const log = new Sim(board, seed, {
								tweak: variant.tweak,
								roleChanges: g % 3 === 0
							}).run();
							for (const [k, v] of Object.entries(log.stats)) totals[k] = (totals[k] ?? 0) + v;
							for (const role of log.promptsByRole.keys()) prompted.add(role);
							totals[`winner:${log.winner}`] = (totals[`winner:${log.winner}`] ?? 0) + 1;
						} catch (err) {
							throw new Error(
								`[${n}p ${JSON.stringify(board)} / ${variant.name} / seed ${seed}] ${(err as Error).message}`,
								{ cause: err }
							);
						}
					}
				}
			}
		});
	}

	it('the in-app (legacy) day still works on the same player counts', () => {
		for (let n = 6; n <= 12; n++) {
			const rng = seeded(n * 7);
			for (let b = 0; b < 4; b++) {
				const board = randomBoard(n, rng);
				for (let g = 1; g <= 10; g++) new Sim(board, n * 31 + b * 7 + g, { legacy: true }).run();
			}
		}
	});

	it('across all those games, every special role and day event really happened', () => {
		// Every night role that was dealt somewhere got its turn somewhere.
		for (const role of dealt) {
			if (ROLE_META[role].nightOrder === null) continue;
			expect(prompted.has(role), `${role} was dealt but never prompted`).toBe(true);
		}
		for (const key of [
			'statusThumbUp',
			'statusThumbDown',
			'statusConfirmed',
			'coupleConfirmed',
			'shot:HUNTER',
			'shot:BLACK_WOLF_KING',
			'shot:WOLF_KING',
			'follow:LOVER_SUICIDE',
			'follow:WOLF_BEAUTY_LINK',
			'explode:WEREWOLF',
			'explode:WOLF_KING',
			'duel:wolf',
			'duel:good',
			'idiotFlip',
			'exile',
			'hostKill',
			'hostKillCascade',
			'midNightRoleChange',
			'packKillShared',
			'duplicateRoleTold',
			'packKillBy:WOLF_BEAUTY',
			'packKillBy:NIGHTMARE',
			'winner:GOOD',
			'winner:WEREWOLF'
		]) {
			expect(totals[key] ?? 0, `${key} never happened`).toBeGreaterThan(0);
		}
		console.log('6-12p totals', totals);
	});
});

describe('idiot exiled on day 1', () => {
	const config: RoleConfig = { WEREWOLF: 2, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1, VILLAGER: 2 };

	it('flips, stays alive without a vote, and the game keeps going for later rounds', () => {
		let reveals = 0;
		for (let seed = 1; seed <= 120; seed++) {
			const log = new Sim(config, seed, { exileIdiotDay1: true }).run();
			if (log.idiotRevealedAndSurvivedVote) reveals++;
		}
		expect(reveals).toBeGreaterThan(20);
	});

	it('host exiles the idiot: flips, the day waits, night 2 still lets wolves target him', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const sim = new Sim(config, seed, { exileIdiotDay1: true });
			let guard = 0;
			while (sim.state.phase !== 'DISCUSSION' && sim.state.phase !== 'GAME_OVER' && guard++ < 200)
				sim.step();
			const idiot = Object.values(sim.state.players).find((p) => p.role === 'IDIOT')!;
			if (sim.state.phase !== 'DISCUSSION' || idiot.isDead) continue;

			const exiled = reduce(sim.state, { type: 'EXILE', seat: idiot.seat });
			const effects = exiled.effects;
			let state = exiled.state;
			expect(state.players[idiot.seat].isDead).toBe(false);
			expect(state.players[idiot.seat].isRevealedIdiot).toBe(true);
			const resolved = effects.find((e) => kindOf(e) === 'DayResolved')!.payload as {
				identity: unknown;
				idiotRevealed: boolean;
			};
			expect(resolved.idiotRevealed).toBe(true);
			expect(resolved.identity).toBeNull();
			expect(state.phase).toBe('DISCUSSION');
			expect(state.dayDecided).toBe(true);

			({ state } = reduce(state, { type: 'END_DAY' }));
			expect(state.phase).toBe('NIGHT');
			expect(state.round).toBe(2);
			const wolf = Object.values(state.players).find((p) => !p.isDead && p.role === 'WEREWOLF')!;
			expect(state.currentStepKey).toBe('role:WEREWOLF');
			const r = reduce(state, {
				type: 'SUBMIT_NIGHT_ACTION',
				seat: wolf.seat,
				role: 'WEREWOLF',
				action: { wolfKillTarget: idiot.seat }
			});
			expect(r.effects.some((e) => kindOf(e) === 'NightActionRejected')).toBe(false);
			return;
		}
		throw new Error('no seed reached a day-1 idiot reveal');
	});
});

describe('恶灵骑士 fear never freezes the night', () => {
	function nightWith(roles: Record<number, RoleId>, fearedSeat: number, stepRole: RoleId) {
		const cfg: RoleConfig = {};
		for (const r of Object.values(roles)) cfg[r] = (cfg[r] ?? 0) + 1;
		const base = startGame({
			roomCode: 'F',
			ruleConfig: defaultRuleConfig(),
			setup: buildSetup(cfg),
			deal: { identities: Object.fromEntries(Object.entries(roles)), buried: null },
			players: Object.keys(roles).map((s) => ({
				seat: Number(s),
				sessionId: `s${s}`,
				nickname: s
			})),
			now: 0
		}).state;
		return {
			...base,
			phase: 'NIGHT' as const,
			isFirstNight: false,
			round: 2,
			fearedSeat,
			currentStepKey: `role:${stepRole}`
		};
	}
	const rejected = (r: EngineResult) => r.effects.some((e) => kindOf(e) === 'NightActionRejected');

	it('a feared witch can pass (and only pass)', () => {
		const st = nightWith(
			{ 1: 'NIGHTMARE', 2: 'WEREWOLF', 3: 'WITCH', 4: 'SEER', 5: 'VILLAGER', 6: 'VILLAGER' },
			3,
			'WITCH'
		);
		const potion = reduce(st, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WITCH',
			action: { witchPoisonTarget: 2 }
		});
		expect(rejected(potion)).toBe(true);
		const pass = reduce(st, { type: 'SUBMIT_NIGHT_ACTION', seat: 3, role: 'WITCH', action: {} });
		expect(rejected(pass)).toBe(false);
		expect(pass.state.submittedRoles).toContain('WITCH');
		expect(pass.state.nightActions.witchPoisonTarget).toBeUndefined();
	});

	it('a feared wolf cannot pass away the pack kill while another wolf can act', () => {
		const st = nightWith(
			{
				1: 'NIGHTMARE',
				2: 'WEREWOLF',
				3: 'WEREWOLF',
				4: 'SEER',
				5: 'WITCH',
				6: 'VILLAGER',
				7: 'VILLAGER'
			},
			2,
			'WEREWOLF'
		);
		const pass = reduce(st, { type: 'SUBMIT_NIGHT_ACTION', seat: 2, role: 'WEREWOLF', action: {} });
		expect(rejected(pass)).toBe(true);
		const kill = reduce(st, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 3,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 6 }
		});
		expect(rejected(kill)).toBe(false);
	});

	it('a feared wolf cannot pass the kill away while the 恶灵骑士 (now in the pack) can make it', () => {
		const st = nightWith(
			{ 1: 'NIGHTMARE', 2: 'WEREWOLF', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER', 6: 'VILLAGER' },
			2,
			'WEREWOLF'
		);
		expect(
			rejected(reduce(st, { type: 'SUBMIT_NIGHT_ACTION', seat: 2, role: 'WEREWOLF', action: {} }))
		).toBe(true);
		const kill = reduce(st, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'NIGHTMARE',
			action: { wolfKillTarget: 5 }
		});
		expect(rejected(kill)).toBe(false);
		expect(kill.state.nightActions.wolfKillTarget).toBe(5);
		// His own skill wasn't used up by the kill.
		expect(kill.state.submittedRoles).toEqual(['WEREWOLF']);
	});

	it('the only living wolf, feared, passes and the night goes on with no kill', () => {
		const base = nightWith(
			{ 1: 'NIGHTMARE', 2: 'WEREWOLF', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER', 6: 'VILLAGER' },
			2,
			'WEREWOLF'
		);
		// The 恶灵骑士 feared seat 2 and has since died - seat 2 is the pack.
		const st = { ...base, players: { ...base.players, 1: { ...base.players[1], isDead: true } } };
		const pass = reduce(st, { type: 'SUBMIT_NIGHT_ACTION', seat: 2, role: 'WEREWOLF', action: {} });
		expect(rejected(pass)).toBe(false);
		expect(pass.state.submittedRoles).toContain('WEREWOLF');
		expect(pass.state.nightActions.wolfKillTarget).toBeUndefined();
	});

	it("the feared seat's prompt says so", () => {
		const st = nightWith(
			{ 1: 'NIGHTMARE', 2: 'WEREWOLF', 3: 'SEER', 4: 'WITCH', 5: 'VILLAGER', 6: 'VILLAGER' },
			3,
			'SEER'
		);
		const [prompt] = notifyRoleHolders(st, 'SEER');
		expect(prompt.seat).toBe(3);
		expect((prompt.payload as { context: { feared?: boolean } }).context.feared).toBe(true);
		const [unfeared] = notifyRoleHolders(st, 'WITCH');
		expect((unfeared.payload as { context: { feared?: boolean } }).context.feared).toBeUndefined();
	});
});

describe('黑狼王', () => {
	const roles: Record<number, RoleId> = {
		1: 'BLACK_WOLF_KING',
		2: 'WEREWOLF',
		3: 'SEER',
		4: 'WITCH',
		5: 'VILLAGER',
		6: 'VILLAGER',
		7: 'HUNTER'
	};
	function begin(r: Record<number, RoleId> = roles) {
		const cfg: RoleConfig = {};
		for (const role of Object.values(r)) cfg[role] = (cfg[role] ?? 0) + 1;
		return startGame({
			roomCode: 'B',
			ruleConfig: defaultRuleConfig(),
			setup: buildSetup(cfg),
			deal: { identities: Object.fromEntries(Object.entries(r)), buried: null },
			players: Object.keys(r).map((s) => ({
				seat: Number(s),
				sessionId: `s${s}`,
				nickname: s
			})),
			now: 0
		});
	}

	it('wakes with the pack and can make the kill', () => {
		const { state, effects } = begin();
		expect(state.currentStepKey).toBe('role:WEREWOLF');
		const prompted = effects
			.filter((e) => kindOf(e) === 'YourTurnPrompt')
			.map((e) => e.seat!)
			.sort((a, b) => a - b);
		expect(prompted).toEqual([1, 2]);
		const r = reduce(state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'BLACK_WOLF_KING',
			action: { wolfKillTarget: 5 }
		});
		expect(r.state.nightActions.wolfKillTarget).toBe(5);
		// ...and the other wolf can't overwrite it.
		const again = reduce(r.state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 2,
			role: 'WEREWOLF',
			action: { wolfKillTarget: 6 }
		});
		expect(again.effects.some((e) => kindOf(e) === 'NightActionRejected')).toBe(true);
	});

	it('gets his own 确认开枪状态 stage after the witch, showing the poison verdict', () => {
		const stageAfterWitch = (poison: number | null) => {
			let { state } = begin();
			state = reduce(state, {
				type: 'SUBMIT_NIGHT_ACTION',
				seat: 1,
				role: 'BLACK_WOLF_KING',
				action: { wolfKillTarget: 5 }
			}).state;
			while (state.currentStepKey !== 'role:WITCH') {
				state = reduce(state, { type: 'ADVANCE_STAGE' }).state;
			}
			state = reduce(state, {
				type: 'SUBMIT_NIGHT_ACTION',
				seat: 4,
				role: 'WITCH',
				action: poison === null ? {} : { witchPoisonTarget: poison }
			}).state;
			let effects: ReturnType<typeof reduce>['effects'] = [];
			while (state.currentStepKey !== 'role:BLACK_WOLF_KING') {
				({ state, effects } = reduce(state, { type: 'ADVANCE_STAGE' }));
			}
			return { state, effects };
		};

		const safe = stageAfterWitch(null);
		const prompt = safe.effects.find((e) => kindOf(e) === 'YourTurnPrompt');
		expect(prompt?.seat).toBe(1);
		const ctx = (prompt?.payload as { context: { hunter?: { canShoot: boolean } } }).context;
		expect(ctx.hunter).toEqual({ canShoot: true });
		// The pack's turn is over - no kill can be slipped in from here.
		const late = reduce(safe.state, {
			type: 'SUBMIT_NIGHT_ACTION',
			seat: 1,
			role: 'BLACK_WOLF_KING',
			action: { wolfKillTarget: 6 }
		});
		expect(late.state.nightActions.wolfKillTarget).toBe(5);
		expect(late.effects.some((e) => kindOf(e) === 'NightActionRejected')).toBe(true);

		const poisoned = stageAfterWitch(1);
		const p2 = poisoned.effects.find((e) => kindOf(e) === 'YourTurnPrompt');
		expect((p2?.payload as { context: { hunter?: { canShoot: boolean } } }).context.hunter).toEqual(
			{ canShoot: false }
		);
	});

	it("keeps his status stage after he's dead (假环节)", () => {
		const s = makeState(roles, { phase: 'NIGHT', round: 2 });
		s.players[1].isDead = true;
		s.currentStepKey = 'role:HUNTER';
		const r = reduce(s, { type: 'ADVANCE_STAGE' });
		expect(r.state.currentStepKey).toBe('role:BLACK_WOLF_KING');
		expect(r.effects.some((e) => kindOf(e) === 'YourTurnPrompt')).toBe(false);
	});

	it('shoots when voted out, not when poisoned', () => {
		const voted = makeState(roles, { phase: 'VOTE', round: 1 });
		for (const seat of [2, 3, 4, 5, 6, 7]) voted.votes[seat] = 1;
		const r = reduce(voted, { type: 'TALLY_VOTES' });
		expect(r.state.players[1].isDead).toBe(true);
		expect(r.state.pendingShoots).toContain(1);

		const poisoned = makeState(roles, { phase: 'NIGHT', round: 2 });
		const deaths = cascadeDeaths(poisoned, [{ seat: 1, cause: 'WITCH_POISON' }], {
			ruleConfig: poisoned.ruleConfig
		});
		expect(deaths.map((d) => d.seat)).toContain(1);
		expect(poisoned.pendingShoots).not.toContain(1);
	});

	it('shoots when killed at night (by his own pack), not when self-exploding', () => {
		const night = makeState(roles, { phase: 'NIGHT', round: 2 });
		cascadeDeaths(night, [{ seat: 1, cause: 'WOLF_KILL' }], { ruleConfig: night.ruleConfig });
		expect(night.pendingShoots).toContain(1);

		const day = makeState(roles, { phase: 'DISCUSSION', round: 1 });
		const r = reduce(day, { type: 'SELF_EXPLODE', seat: 1 });
		expect(r.state.players[1].isDead).toBe(true);
		expect(r.state.pendingShoots).not.toContain(1);
	});

	it('a wolf-kings-only board still gets a wolf turn', () => {
		const { state } = begin({
			1: 'WOLF_KING',
			2: 'BLACK_WOLF_KING',
			3: 'SEER',
			4: 'WITCH',
			5: 'VILLAGER',
			6: 'VILLAGER',
			7: 'VILLAGER'
		});
		expect(state.currentStepKey).toBe('role:WEREWOLF');
	});
});

describe('进入黑夜 (END_DAY)', () => {
	const roles: Record<number, RoleId> = {
		1: 'WEREWOLF',
		2: 'WEREWOLF',
		3: 'SEER',
		4: 'WITCH',
		5: 'VILLAGER',
		6: 'VILLAGER'
	};

	it('skips the vote and starts the next night with nobody exiled', () => {
		for (const phase of ['DISCUSSION', 'VOTE'] as const) {
			const s = makeState(roles, { phase, round: 1 });
			s.votes = { 3: 1 };
			const r = reduce(s, { type: 'END_DAY' });
			expect(r.state.phase).toBe('NIGHT');
			expect(r.state.round).toBe(2);
			expect(r.state.votes).toEqual({});
			expect(Object.values(r.state.players).every((p) => !p.isDead)).toBe(true);
		}
	});

	it('is a no-op at night', () => {
		const s = makeState(roles, { phase: 'NIGHT', round: 2 });
		expect(reduce(s, { type: 'END_DAY' }).effects).toEqual([]);
	});
});
