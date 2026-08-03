import type { Role } from './roles';

// One emoji per role, extending the app's existing emoji-driven idiom (🐺 in
// SeatCircle, 🎴 on the role-reveal card) rather than introducing a separate
// icon asset/library.
export const ROLE_ICON: Record<Role, string> = {
	普通狼人: '🐺',
	预言家: '🔮',
	女巫: '🧪',
	猎人: '🏹',
	守卫: '🛡️',
	狼美人: '🌹',
	丘比特: '💘',
	盗贼: '🎭',
	白痴: '🃏',
	骑士: '⚔️',
	禁言长老: '🤐',
	摄梦人: '💤',
	高级村民: '🌾',
	老流氓: '🥃',
	普通村民: '👤',
	白狼王: '👑',
	黑狼王: '👑',
	隐狼: '👻',
	恶魔: '😈',
	恶灵骑士: '💀',
	梦魇: '🌑',
	机械狼: '🤖',
	野孩子: '🐾'
};
