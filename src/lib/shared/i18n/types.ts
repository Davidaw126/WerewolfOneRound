// The static string dictionary's shape. zh.ts and en.ts both declare
// `const zh: Strings = {...}` / `const en: Strings = {...}` - TypeScript then
// enforces exact key parity between the two languages at compile time (a
// missing/extra key in either file is a type error), without over-
// constraining the actual string VALUES the way `satisfies typeof zh` would
// (that would force en's values to be assignable to zh's literal string
// types, which - since these are all just `string` here, not literals -
// isn't actually a risk either way; declared explicitly for clarity).

import type { RoomErrorCode } from '../actionErrors';
import type { NightRuleError } from '../../game/rules/nightRules';

export type Lang = 'zh' | 'en';

export interface Strings {
	common: {
		confirm: string;
		cancel: string;
		ok: string;
	};
	register: {
		title: string;
		subtitle: string;
		usernameLabel: string;
		usernamePlaceholder: string;
		submit: string;
		submitting: string;
		errorEmptyUsername: string;
		errorTooLong: string;
		errorNameTaken: string;
		errorRateLimited: string;
	};
	lobby: {
		title: string;
		logout: string;
		loggingOut: string;
		createRoom: string;
		creating: string;
		or: string;
		joinRoomLabel: string;
		joinCodePlaceholder: string;
		joinRoom: string;
		joining: string;
		errorCreateFailed: string;
		errorInvalidCode: string;
	};
	room: {
		loading: string;
		scrollMore: string;
		invite: string;
		scanToJoin: string;
		shareLink: string;
		linkCopied: string;
		closeInvite: string;
		waitingHostConfig: (hostUsername: string) => string;
		announceButton: string;
		dawnExplodeButton: string;
		dawnExplodePick: string;
		dawnExplodeConfirm: (seat: number) => string;
		dawnExploded: string;
		seatingWaitingHost: string;
		playAgain: string;
		restarting: string;
		backToLobby: string;
		leavingBack: string;
		waitingOthers: string;
		viewCouple: string;
		coupleLinked: (partnerSeat: number) => string;
		coupleNotLinked: string;
		continueButton: string;
		closingEyes: string;
		coupleConfirm: string;
		stageConfirmedWait: string;
		forceContinue: string;
		confirmForceContinue: string;
		reroll: string;
		startGame: string;
		voteWaitAnnounceHost: string;
		voteWaitAnnouncePlayer: string;
		dawnWaitPlayer: string;
		eyesClosed: string;
	};
	phaseBanner: {
		lobby: string;
		seating: string;
		night: (n: number) => string;
		nightHunter: (n: number) => string;
		lastWords: (n: number) => string;
		discussion: (n: number) => string;
		dayVote: (n: number) => string;
		dayHunter: (n: number) => string;
		gameOver: string;
		stageCoupleConfirm: string;
		stageActing: string;
		roomCode: string;
		stopGameConfirm: string;
		stopGameAria: string;
		menu: string;
		menuClose: string;
		menuName: string;
		menuSound: string;
		menuLanguage: string;
		menuLeave: string;
	};
	/** Refusal codes -> popup text (formatRefusal). Every code needs a line;
	 * `fallback` is for a reply from a newer server this phone doesn't know. */
	errors: Record<RoomErrorCode, string> & { fallback: string };
	nightPrompt: {
		yourTurn: (role: string) => string;
		submittedWaiting: string;
		doneCloseEyes: (description: string) => string;
		packKillChosen: (bySeat: number, target: number | null) => string;
		roleDoneByOther: string;
		roleChangedForYou: string;
		wildChildConverted: string;
		tapSeatAbove: string;
		pickedSeats: (seats: string) => string;
		fearedTonight: string;
		fearedPass: string;
		descFearedPassed: string;
		checkResult: (seat: number, isWolf: boolean) => string;
		wolfTeammates: (seats: string) => string;
		soloWolf: string;
		guardLastProtected: (seat: number) => string;
		selectWolfTarget: string;
		emptyKill: string;
		descEmptyKill: string;
		emptyGuard: string;
		descEmptyGuard: string;
		selectSeerTarget: string;
		selectGuardTarget: string;
		selectWolfBeautyTarget: string;
		selectWildChildTarget: string;
		selectDreamWeaverTarget: string;
		selectNightmareTarget: string;
		confirm: string;
		witchAntidoteLabel: string;
		witchPoisonLabel: string;
		witchAvailable: string;
		witchSpent: string;
		witchKilledTonight: (seat: number) => string;
		witchNoOneKilled: string;
		witchKillHidden: string;
		witchUseAntidote: (seat: number) => string;
		witchSelfSaveBlocked: string;
		witchOnePotionPerNight: string;
		witchSelectPoisonTarget: string;
		witchAntidoteChosenAlready: string;
		cupidSelectTwo: string;
		thiefBuriedCards: (a: string, b: string) => string;
		thiefSwapFirst: (a: string) => string;
		thiefSwapSecond: (b: string) => string;
		thiefKeepOriginal: string;
		thiefLoadingCards: string;
		hunterCanShoot: string;
		hunterPoisonedNoShoot: string;
		hunterNoActionNeeded: string;
		statusNoActionNeeded: string;
		statusConfirm: string;
		ruleMessages: Record<NightRuleError, string> & { fallback: string };
		descSelectedSeat: (seat: number) => string;
		descWitchSaved: (seat: number) => string;
		descWitchPoisoned: (seat: number) => string;
		descWitchNoAction: string;
		descCupidLinked: (a: number, b: number) => string;
		descThiefKept: string;
		descThiefSwapped: (newRole: string) => string;
	};
	roleConfig: {
		title: string;
		presets: string;
		atLeastOneRole: string;
		submitFailed: string;
		submitting: string;
		confirm: string;
		goodCamp: string;
		wolfCamp: string;
		decrease: string;
		increase: string;
		cardCountSummary: (total: number) => string;
		cardCountWithThief: (total: number, seats: number) => string;
		houseRuleHeader: string;
		cupidPoisonBlocksHunter: string;
		winConditionLabel: string;
		winConditionSideKill: string;
		winConditionTotalKill: string;
		wolfAllowEmptyKill: string;
		guardAllowEmptyGuard: string;
		sameGuardSameSaveLabel: string;
		sameGuardSameSaveDies: string;
		sameGuardSameSaveLives: string;
		witchHeader: string;
		witchSelfRescueLabel: string;
		witchSelfRescueFirstNightOnly: string;
		witchSelfRescueNever: string;
		witchSelfRescueAlways: string;
		witchCanPoisonSelf: string;
		witchBothPotionsSameNight: string;
		hunterHeader: string;
		blackWolfKingHeader: string;
		blackWolfKingCanShootWhenLoverSuicide: string;
		wildChildHeader: string;
		campSummary: (wolves: number, gods: number, villagers: number) => string;
		wildChildJoinsPack: string;
		hunterCanShootWhenPoisoned: string;
		hunterCanShootWhenWolfKilled: string;
		hunterCanShootWhenLoverSuicide: string;
	};
	discussion: {
		lastWordsTitle: string;
		currentSpeaker: (seat: number, username: string) => string;
		lastWordsEnded: string;
		next: string;
		dayTitle: string;
		outHeader: string;
		outHint: string;
		outButton: (seats: number[]) => string;
		outPickFirst: string;
		confirmOut: (seats: number[]) => string;
		dayDecided: string;
		enterNight: string;
		confirmEnterNight: string;
		confirmEnterNightPlain: string;
		playerWaiting: string;
		knightDuelButton: string;
		selectKnightSeat: string;
		selectDuelTargetSeat: string;
		confirmDuel: (knightSeat: number, targetSeat: number) => string;
		confirm: string;
		cancel: string;
		waitingHost: string;
	};
	vote: {
		pk: string;
		day: string;
		votedCount: (voted: number, total: number) => string;
		pkCandidateNote: string;
		revealedIdiotNote: string;
		abstain: string;
		endVote: string;
		myVoteAbstain: string;
		myVoteFor: (seat: number) => string;
	};
	hostOverride: {
		toggle: string;
		/** Shown on the 上帝之手 button while the panel is open. */
		close: string;
		warning: string;
		selectPlayer: string;
		selected: (seat: number) => string;
		voiceTest: string;
		gameToolsLater: string;
		voiceTestLine: string;
		voiceUnsupported: string;
		boardRolesOnly: string;
		kill: string;
		revive: string;
		setRoleTo: (role: string) => string;
		confirmPrompt: (seat: number, label: string) => string;
		changeRoleTo: string;
		selectRolePlaceholder: string;
		confirmChangeRole: string;
	};
	gameOver: {
		wolvesWin: string;
		loversWin: string;
		villageWin: string;
		unknownRole: string;
		timeline: string;
		couple: string;
		alive: string;
	};
	seatCircle: {
		host: string;
		dead: string;
		empty: string;
	};
	hunterShot: {
		promptTitle: string;
		submitted: string;
		noShoot: string;
		waitingFor: (seat: number) => string;
		descNoShoot: string;
		descShot: (seat: number) => string;
	};
	activityLog: {
		title: string;
		empty: string;
		publicChip: string;
		hide: string;
		button: string;
		youCheckedIdentity: string;
	};
	roomLog: {
		title: string;
		empty: string;
		hide: string;
		button: string;
	};
	leaveRoom: {
		button: string;
		hostWarning: string;
		hostConfirmLabel: string;
		midGameWarning: string;
		midGameConfirmLabel: string;
		simpleConfirm: string;
		simpleConfirmLabel: string;
		logoutConfirm: string;
	};
	audioToggle: {
		sfxOn: string;
		sfxOff: string;
		nudgeOn: string;
		nudgeOff: string;
	};
	roleReveal: {
		revealing: string;
		holdToView: string;
		yourIdentity: string;
		releaseToHide: string;
	};
	narration: {
		wolfTurn: string;
		seerTurn: string;
		witchTurn: string;
		guardTurn: string;
		wolfBeautyTurn: string;
		cupidTurn: string;
		thiefTurn: string;
		hunterTurn: string;
		blackWolfKingTurn: string;
		wildChildTurn: string;
		dreamWeaverTurn: string;
		nightmareTurn: string;
		cupidClose: string;
		coupleReveal: string;
		nightBegins: string;
		dawnBreaks: string;
		allEyesClosed: string;
		hurryUp: string;
		voiceBlocked: string;
		/** Host-only button shown while narration isn't enabled on this device. */
		enableVoice: string;
		/** Shown instead when this browser has no speech synthesis at all. */
		voiceUnsupported: string;
	};
}
