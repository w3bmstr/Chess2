
/**
 * Chess2 Engine Search Module
 *
 * Implements principal variation search, move ordering, pruning, and heuristics for robust, draw-oriented play.
 *
 * Key features:
 * - Fortress/endgame and king safety pruning
 * - History, killer, countermove, and continuation heuristics
 * - Late move reductions, futility pruning, null-move pruning
 * - Multi-PV and aspiration window search
 * - Highly documented and modular for maintainability
 *
 * TODO: Consider parallel search, NNUE, advanced pruning, and further tuning.
 */

/**
 * Checks if a position is structurally safe for TT cutoff (not in tactical danger).
 * @param {Array} board - 2D board array
 * @param {string} color - Color to check
 * @returns {boolean}
 */

function findKingQuick(board, color) {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const pc = board[y][x];
            if (pc && pc.type === "K" && pc.color === color) {
                return { x, y };
            }
        }
    }
    return null;
}

function hasPawnShield(board, king, color) {
    const dir = color === LIGHT ? -1 : 1;
    for (let dx of [-1, 0, 1]) {
        const x = king.x + dx;
        const y = king.y + dir;
        if (x < 0 || x > 7 || y < 0 || y > 7) continue;
        const pc = board[y][x];
        if (pc && pc.type === "P" && pc.color === color) return true;
    }
    return false;
}

function fileOpenTowardKing(board, king) {
    const x = king.x;
    // upward
    for (let y = king.y - 1; y >= 0; y--) {
        if (board[y][x]) return false;
    }
    // downward
    for (let y = king.y + 1; y < 8; y++) {
        if (board[y][x]) return false;
    }
    return true; // fully open
}

function centerIsWideOpen(board) {
    const files = [3, 4]; // d and e
    for (let x of files) {
        let hasPawn = false;
        for (let y = 0; y < 8; y++) {
            const pc = board[y][x];
            if (pc && pc.type === "P") {
                hasPawn = true;
                break;
            }
        }
        if (!hasPawn) return true; // open file
    }
    return false;
}


function isStructurallySafe(board, color) {
    const king = findKingQuick(board, color);
    if (!king) return false;

    // 1. King must be castled or near castled
    const castled = (color === LIGHT)
        ? (king.y === 7 && (king.x === 6 || king.x === 2))
        : (king.y === 0 && (king.x === 6 || king.x === 2));

    if (!castled) return false;

    // 2. Pawn shield must exist
    if (!hasPawnShield(board, king, color)) return false;

    // 3. No open file leading directly to king
    if (fileOpenTowardKing(board, king)) return false;

    // 4. Center should not be wide open
    if (centerIsWideOpen(board)) return false;

    return true;
}


/**
 * Checks for fortress/endgame or unsafe king for pruning guards.
 * @param {Array} board - 2D board array
 * @param {string} color - Color to check
 * @returns {boolean}
 */
function isFortressOrUnsafe(board, color) {
    let kingPos = { [LIGHT]: null, [DARK]: null };
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[y].length; x++) {
            const pc = board[y][x];
            if (pc && pc.type === "K") kingPos[pc.color] = { x, y };
        }
    }
    if (typeof isKingSafe === 'function' && !isKingSafe(color, kingPos, board, COLS, ROWS)) return true;
    if (typeof isWrongBishopRookPawnFortress === 'function' && isWrongBishopRookPawnFortress(board)) return true;
    if (typeof isAdvancedBlockade === 'function' && isAdvancedBlockade(board)) return true;
    return false;
}

/**
 * Classifies move safety for draw-machine heuristics.
 * @param {Array} board - 2D board array
 * @param {Object} mv - Move object
 * @param {string} color - Color making the move
 * @returns {number} Safety score (higher = safer)
 */
function getMoveSafety(board, mv, color) {
    const piece = board[mv.from.y][mv.from.x];
    if (!piece) return 1.0;
    if (piece.type === "K" && Math.abs(mv.to.x - mv.from.x) === 2) return 1.5; // Castling
    if (piece.type === "K" && ((color === LIGHT && mv.to.y === 7) || (color === DARK && mv.to.y === 0))) return 1.3; // King to back rank
    if (piece.type === "P" && Math.abs(mv.to.x - mv.from.x) === 0 && Math.abs(mv.to.y - mv.from.y) === 1) return 1.2; // Pawn blocks file
    if (mv.captured) return 1.2; // Recapture or trade
    if (piece.type === "P" && Math.abs(mv.to.y - mv.from.y) > 1) return 0.5; // Aggressive pawn push
    if (piece.type === "K" && ((color === LIGHT && mv.to.y < mv.from.y) || (color === DARK && mv.to.y > mv.from.y))) return 0.7; // King moves forward
    return 1.0;
}

const EXACT = 0;
const LOWERBOUND = 1;
const UPPERBOUND = 2;
const ZOBRIST = initZobrist();
const TT = new Map();
let searchAge = 0;
// Global node counter (used by UI for Engine Info). Reset at root when needed.
// Using `var` keeps it on `window` in non-module scripts.
var SEARCH_NODES = 0;
// Global abort flag: lets UI (and iterative deepening) stop thinking quickly.
// Checked frequently in search/quiescence to keep interrupts responsive.
var SEARCH_ABORT = false;
const PAWN_TT_SIZE = 1 << 16;
const PAWN_TT = Array(PAWN_TT_SIZE).fill(null);
const EVAL_TT_SIZE = 1 << 16;
const EVAL_TT = Array(EVAL_TT_SIZE).fill(null);
let seePruneMain = 0;
let seePruneQ = 0;
let currentDifficulty = null;
// Countermove heuristic: tracks which move refutes which previous move
const counterMoves = Array.from({ length: 2 }, () =>
    Array.from({ length: 64 }, () => Array(64).fill(null))
);
// Continuation history: rewards moves that worked well after specific previous moves
const continuationHistory = Array.from({ length: 2 }, () =>
    Array.from({ length: 64 }, () => Array(64).fill(0))
);

const killers = Array.from({ length: 64 }, () => [null, null]);
const historyHeur = [
    Array.from({ length: 64 }, () => Array(64).fill(0)),
    Array.from({ length: 64 }, () => Array(64).fill(0))
];

// Periodic decay for ordering heuristics so stale patterns don't dominate.
// Kept lightweight: 2 * 64 * 64 tables.
const HEUR_DECAY_INTERVAL = 8; // searches
const HEUR_DECAY_FACTOR = 0.90;
function maybeDecayHeuristics() {
	if (searchAge <= 0) return;
	if (searchAge % HEUR_DECAY_INTERVAL !== 0) return;
	const clearCounterMoves = (searchAge % (HEUR_DECAY_INTERVAL * 4) === 0);
	for (let c = 0; c < 2; c++) {
		for (let i = 0; i < 64; i++) {
			const hRow = historyHeur[c][i];
			const contRow = continuationHistory[c][i];
			const cmRow = counterMoves[c][i];
			for (let j = 0; j < 64; j++) {
				hRow[j] = Math.trunc(hRow[j] * HEUR_DECAY_FACTOR);
				contRow[j] = Math.trunc(contRow[j] * HEUR_DECAY_FACTOR);
				if (clearCounterMoves) cmRow[j] = null;
			}
		}
	}
}

// Pruning parameter table (pawn units). Low levels are more forgiving; high levels prune more for speed.
const PRUNING_PARAMS = {
	1:  { razor: 1.25, extFut: 1.90, lmpGate: 1.10, futPerDepth: 1.20 },
	2:  { razor: 1.15, extFut: 1.80, lmpGate: 1.05, futPerDepth: 1.15 },
	3:  { razor: 1.05, extFut: 1.70, lmpGate: 1.00, futPerDepth: 1.10 },
	4:  { razor: 0.98, extFut: 1.60, lmpGate: 0.95, futPerDepth: 1.05 },
	5:  { razor: 0.92, extFut: 1.50, lmpGate: 0.90, futPerDepth: 1.00 },
	6:  { razor: 0.88, extFut: 1.42, lmpGate: 0.86, futPerDepth: 0.96 },
	7:  { razor: 0.84, extFut: 1.35, lmpGate: 0.82, futPerDepth: 0.92 },
	8:  { razor: 0.80, extFut: 1.28, lmpGate: 0.78, futPerDepth: 0.90 },
	9:  { razor: 0.76, extFut: 1.22, lmpGate: 0.74, futPerDepth: 0.88 },
	10: { razor: 0.74, extFut: 1.18, lmpGate: 0.72, futPerDepth: 0.86 },
	11: { razor: 0.72, extFut: 1.14, lmpGate: 0.70, futPerDepth: 0.84 },
	12: { razor: 0.70, extFut: 1.12, lmpGate: 0.68, futPerDepth: 0.82 },
	13: { razor: 0.68, extFut: 1.10, lmpGate: 0.64, futPerDepth: 0.80 },
	14: { razor: 0.66, extFut: 1.08, lmpGate: 0.60, futPerDepth: 0.78 },
	15: { razor: 0.64, extFut: 1.06, lmpGate: 0.56, futPerDepth: 0.76 }
};

function getPruningParamsForCurrentDifficulty() {
	const level = (typeof state !== 'undefined' && state && Number.isFinite(state.aiLevel))
		? Math.min(15, Math.max(1, Math.round(state.aiLevel)))
		: 5;
	return PRUNING_PARAMS[level] || PRUNING_PARAMS[5];
}

const pieceCache = new Map();
const LMR_MAX_DEPTH = 32;
const LMR_MAX_MOVES = 64;
const LMR_TABLE = initLMRTable();
const PST = initPST();






	function initLMRTable() {
		const table = Array.from({ length: LMR_MAX_DEPTH + 1 }, () => Array(LMR_MAX_MOVES + 1).fill(0));
		const scale = 2.4;
		for (let d = 1; d <= LMR_MAX_DEPTH; d++) {
			for (let m = 1; m <= LMR_MAX_MOVES; m++) {
				const red = Math.max(0, Math.floor(Math.log(d + 1) * Math.log(m + 1) / scale));
				table[d][m] = red;
			}
		}
		return table;
	}

	const MATE_THRESHOLD = 9000;
	const REPLACEMENT_MARGIN = 2;

	function normalizeMateScore(score, ply) {
		if (!Number.isFinite(score)) return 0;
		if (score > MATE_THRESHOLD) return score + ply;
		if (score < -MATE_THRESHOLD) return score - ply;
		return score;
	}

	function denormalizeMateScore(score, ply) {
		if (score > MATE_THRESHOLD) return score - ply;
		if (score < -MATE_THRESHOLD) return score + ply;
		return score;
	}

	function ttProbe(hash, ply = 0) {
		let bucket = TT.get(hash);
		if (!bucket) return null;
		if (!Array.isArray(bucket)) bucket = [bucket];
		let best = null;
		for (const entry of bucket) {
			if (!entry || entry.key !== hash) continue;
			if (entry.age !== searchAge) continue;
			if (!best || entry.depth > best.depth) best = entry;
		}
		if (!best) return null;
		return { ...best, score: denormalizeMateScore(best.score, ply) };
	}

	function ttStore(hash, entry, ply = 0) {
		const normScore = normalizeMateScore(entry.score, ply);
		const newEntry = { ...entry, key: hash, score: normScore, age: searchAge };

		let bucket = TT.get(hash);
		if (bucket && !Array.isArray(bucket)) bucket = [bucket];

		if (!bucket) {
			TT.set(hash, [newEntry]);
			return;
		}

		if (bucket.length < 2) {
			bucket.push(newEntry);
			TT.set(hash, bucket);
			return;
		}

		const isExact = (flag) => flag === "EXACT";
		const entryScore = (e) => {
			const depthScore = e?.depth || 0;
			const ageScore = e?.age === searchAge ? 2 : 0;
			const exactScore = isExact(e?.flag) ? 1 : 0;
			return depthScore * 4 + ageScore + exactScore;
		};

		// Choose the weaker slot as victim.
		const idx = entryScore(bucket[0]) <= entryScore(bucket[1]) ? 0 : 1;
		const victim = bucket[idx];
		const victimDepth = victim?.depth || 0;
		const victimExact = isExact(victim?.flag);

		if (
			newEntry.depth + REPLACEMENT_MARGIN >= victimDepth ||
			(isExact(newEntry.flag) && !victimExact) ||
			newEntry.age > (victim?.age || 0) ||
			victimDepth < 3
		) {
			bucket[idx] = newEntry;
			TT.set(hash, bucket);
		}
}

function moveToAlgebraic(mv) {
		const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
		return `${sq(mv.from.x, mv.from.y)}${sq(mv.to.x, mv.to.y)}`;
	}

	function pickBookMove(legalMoves, strength) {
		if (!strength || strength === "none") return null;
		if (state.moveHistory.length > 12) return null;
		// Multi-move opening book: each line is an array of algebraic moves
		// Expanded with more classical, hypermodern, and gambit lines
		const bookLines = {
			weak: [
				["e2e4"], ["d2d4"], ["c2c4"], ["g1f3"], ["e2e4", "e7e5"], ["d2d4", "d7d5"],
				["e2e4", "c7c5"], ["d2d4", "g8f6"], ["c2c4", "e7e6"], ["g1f3", "c7c6"],
				["e2e4", "e7e6"], ["d2d4", "e7e6"], ["e2e4", "d7d6"], ["d2d4", "c7c5"],
				["e2e4", "g8f6"], ["c2c4", "g8f6"], ["g1f3", "d7d6"], ["e2e4", "c7c6"],
				["d2d4", "b8c6"], ["c2c4", "b8c6"]
			],
			basic: [
				["e2e4", "e7e5", "g1f3", "b8c6"], // Italian
				["e2e4", "c7c5", "g1f3", "d7d6"], // Sicilian
				["d2d4", "d7d5", "c2c4", "e7e6"], // Queen's Gambit Declined
				["d2d4", "g8f6", "c2c4", "e7e6"], // Indian Game
				["c2c4", "e7e5"], // English
				["g1f3", "d7d5"],
				["e2e4", "e7e5", "f1c4", "b8c6"], // Bishop's Opening
				["e2e4", "e7e6", "d2d4", "d7d5"], // French
				["d2d4", "d7d5", "c2c4", "c7c5"], // Benoni
				["e2e4", "c7c6", "d2d4", "d7d5"], // Caro-Kann
				["e2e4", "e7e5", "g1f3", "g8f6"], // Petrov
				["d2d4", "d7d5", "c2c4", "g8f6"], // QGD alternative
				["e2e4", "c7c5", "b1c3", "d7d6"], // Closed Sicilian
				["c2c4", "e7e6", "d2d4", "d7d5"], // English to QGD
				["g1f3", "c7c5", "c2c4", "g8f6"] // English/Indian
			],
			standard: [
				["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"], // Ruy Lopez
				["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"], // Italian
				["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "cxd4", "Nxd4", "g8f6", "b1c3", "a7a6"], // Najdorf
				["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "f8e7"], // QGD
				["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4"], // Nimzo-Indian
				["c2c4", "e7e5", "g1f3", "b8c6"], // English
				["g1f3", "d7d5", "d2d4", "g8f6"],
				["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "g8f6"], // French Tarrasch
				["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4"], // Caro-Kann
				["d2d4", "d7d5", "c2c4", "c7c5", "d4c5", "d8a5"], // Benoni Gambit
				["e2e4", "e7e5", "g1f3", "d7d6", "d2d4", "e5d4", "Nxd4", "g8f6", "b1c3", "f8e7"], // Philidor
				["e2e4", "c7c5", "b1c3", "g8f6", "g1f3", "d7d6", "d2d4", "cxd4", "Nxd4", "a7a6"], // Sicilian Four Knights
				["d2d4", "g8f6", "c2c4", "e7e6", "g1f3", "d7d5", "b1c3", "c7c5"], // Semi-Tarrasch
				["e2e4", "e7e5", "f1c4", "b8c6", "d2d3", "g8f6", "c1g5", "f8e7"], // Giuoco Pianissimo
				["e2e4", "c7c5", "b1c3", "d7d6", "f1b5", "g8f6", "b5c6", "b7c6"] // Sicilian Rossolimo
			],
			strong: [
				["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "f1a4", "g8f6", "O-O", "f8e7"], // Ruy Lopez main line
				["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "cxd4", "Nxd4", "g8f6", "b1c3", "a7a6", "f3f4"], // Sicilian Najdorf
				["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "O-O"], // Nimzo-Indian
				["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "f8e7", "c1g5", "h7h6"], // QGD
				["c2c4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4"], // English
				["g1f3", "d7d5", "d2d4", "g8f6", "c2c4", "c7c6"], // Semi-Slav
				["e2e4", "e7e5", "f1c4", "b8c6", "d2d3", "g8f6", "c1g5", "f8e7"], // Italian Giuoco Pianissimo
				["e2e4", "c7c5", "b1c3", "d7d6", "f1b5", "g8f6", "b5c6", "b7c6"], // Sicilian Rossolimo
				["d2d4", "g8f6", "c2c4", "e7e6", "g1f3", "d7d5", "b1c3", "c7c5"], // Semi-Tarrasch
				["e2e4", "e7e5", "g1f3", "d7d6", "d2d4", "e5d4", "Nxd4", "g8f6", "b1c3", "f8e7"], // Philidor
				["e2e4", "c7c5", "g1f3", "e7e6", "d2d4", "cxd4", "Nxd4", "a7a6", "b1c3", "g8f6", "f1e2", "d7d6"], // Sicilian Taimanov
				["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3", "d5c4", "a2a4", "b8a6"], // Queen's Gambit Accepted
				["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "O-O", "f8e7", "d2d3", "b5c6", "d7c6"], // Ruy Lopez extended
				["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "g8f6", "e4f6", "g7f6"], // Caro-Kann Exchange
				["d2d4", "d7d5", "c2c4", "c7c5", "d4c5", "d8a5", "b1c3", "a5c5", "c1e3", "c5a5"], // Benoni Gambit extended
				["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "g8f6", "e4e5", "f6d7", "c1e3", "b8c6", "f2f4"] // French Advance extended
			],
			full: [
				// Deepest mainlines and rare lines for maximum variety and depth
				["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "f1a4", "g8f6", "O-O", "f8e7", "d2d3", "b5c6", "d7c6", "d2d4", "e5d4", "Nxd4", "O-O", "f2f4"],
				["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "cxd4", "Nxd4", "g8f6", "b1c3", "a7a6", "f3f4", "e7e6", "f1e2", "b8c6", "O-O"],
				["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "O-O", "a2a3", "b4c3", "b2c3", "d7d5", "c4d5", "e6d5", "c1g5", "h7h6"],
				["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "f8e7", "c1g5", "h7h6", "g5h4", "O-O", "e2e3", "b8d7", "d1c2"],
				["c2c4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4", "Nxd4", "g8f6", "b1c3", "f8b4", "a2a3", "b4c3", "b2c3", "O-O", "g2g3", "d7d6"],
				["g1f3", "d7d5", "d2d4", "g8f6", "c2c4", "c7c6", "b1c3", "d5c4", "a2a4", "b8a6", "e2e3", "c8e6", "f1e2", "g7g6"],
				["e2e4", "e7e5", "f1c4", "b8c6", "d2d3", "g8f6", "c1g5", "f8e7", "O-O", "h7h6", "g5h4", "d7d6", "c2c3", "O-O", "d1e2"],
				["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "g8f6", "e4f6", "g7f6", "c1e3", "b8d7", "d1d2", "e7e6"],
				["d2d4", "d7d5", "c2c4", "c7c5", "d4c5", "d8a5", "b1c3", "a5c5", "c1e3", "c5a5", "a2a3", "b8c6", "d1d2", "e7e6"],
				["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "g8f6", "e4e5", "f6d7", "c1e3", "b8c6", "f2f4", "d8b6", "d1d2", "c8d7"]
			]
		};
		const lines = bookLines[strength] || [];
		const played = state.moveHistory.map(mv => moveToAlgebraic(mv));
		for (const line of lines) {
			if (played.length >= line.length) continue;
			let match = true;
			for (let i = 0; i < played.length; i++) {
				if (played[i] !== line[i]) { match = false; break; }
			}
			if (match) {
				const nextMove = line[played.length];
				const cand = legalMoves.find(mv => moveToAlgebraic(mv) === nextMove);
				if (cand) return cand;
			}
		}
		return null;
	}

	function quiescence(ctx, alpha, beta, povColor, turn, deadlineMs, ply = 0) {
		if (SEARCH_ABORT) return { score: 0, cut: true };
		SEARCH_NODES++;
		if (Date.now() > deadlineMs) return { score: evaluateBoard(ctx.board, povColor), cut: true };
		// Mate-distance pruning clamp.
		const MATE_SCORE = 10000;
		const mateBound = MATE_SCORE - ply;
		if (Number.isFinite(alpha) || alpha === -Infinity) alpha = Math.max(alpha, -mateBound);
		if (Number.isFinite(beta) || beta === Infinity) beta = Math.min(beta, mateBound);
		if (alpha >= beta) return { score: alpha };

		// TT probe in quiescence (speed + stability).
		try {
			const hash = computeHash(ctx, turn);
			const tt = ttProbe(hash, ply);
			if (tt) {
				if (tt.flag === "EXACT") return { score: tt.score };
				if (tt.flag === "LOW" && tt.score > alpha) alpha = tt.score;
				else if (tt.flag === "HIGH" && tt.score < beta) beta = tt.score;
				if (alpha >= beta) return { score: tt.score };
			}
		} catch (e) {
			// ignore
		}
		const enemy = turn === LIGHT ? DARK : LIGHT;
		const inChk = inCheck(turn, ctx.board);
		const standPat = inChk ? -Infinity : evaluateBoard(ctx.board, povColor);
		if (!inChk) {
			if (turn === povColor) {
				if (standPat > alpha) alpha = standPat;
				if (alpha >= beta) return { score: alpha };
			} else {
				if (standPat < beta) beta = standPat;
				if (alpha >= beta) return { score: beta };
			}
			const deltaMargin = 2; // in pawns (~200cp)
			if (standPat + deltaMargin < alpha) return { score: alpha };
		}
		const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turn);
		if (!legal.length) {
			// Terminal inside qsearch recursion.
			if (inChk) {
				const mateScore = (turn === povColor) ? (-MATE_SCORE + ply) : (MATE_SCORE - ply);
				return { score: mateScore };
			}
			return { score: 0 };
		}
		// Conservative qsearch checks policy:
		// - If in check: search all legal evasions (needed for correctness).
		// - Otherwise: capture/promotions only (avoid node explosion).
		const noisy = inChk
			? orderMoves(legal, ctx.board, ply)
			: legal
				.filter(mv => mv.promo || mv.enPassant || ctx.board[mv.to.y][mv.to.x])
				.sort((a, b) => {
					const tgtA = a.enPassant ? { type: "P" } : ctx.board[a.to.y][a.to.x];
					const tgtB = b.enPassant ? { type: "P" } : ctx.board[b.to.y][b.to.x];
					const va = tgtA ? (PIECE_VALUES[tgtA.type] || 0) : 0;
					const vb = tgtB ? (PIECE_VALUES[tgtB.type] || 0) : 0;
					const pa = a.promo ? (PIECE_VALUES[a.promo] || 0) : 0;
					const pb = b.promo ? (PIECE_VALUES[b.promo] || 0) : 0;
					const sa = va + (pa ? (20 + pa) : 0);
					const sb = vb + (pb ? (20 + pb) : 0);
					return sb - sa; // promotions first, then MVV ordering
				});
		let bestScore = inChk
			? (turn === povColor ? -Infinity : Infinity)
			: standPat;
		for (const mv of noisy) {
			if (SEARCH_ABORT) return { score: 0, cut: true };
			const nextSim = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
			const nextCtx = { board: nextSim.board, castling: nextSim.castling, enPassant: nextSim.enPassant };
			const givesCheck = inCheck(enemy, nextCtx.board);
			let seeScoreCached = null;
			if (!inChk) {
				const tgt = mv.enPassant ? { type: "P" } : ctx.board[mv.to.y][mv.to.x];
				const isPromo = !!mv.promo;
				if (tgt && !isPromo && !givesCheck) {
					const capVal = PIECE_VALUES[tgt.type] || 0;
					const deltaMargin = 2; // pawns
					if (standPat + capVal + deltaMargin < alpha) {
						seeScoreCached = see(ctx.board, mv);
						if (!(Number.isFinite(seeScoreCached) && seeScoreCached >= 0)) {
							continue;
						}
					}
				}
				const seeScore = seeScoreCached !== null ? seeScoreCached : see(ctx.board, mv);
				const seeMargins = currentDifficulty?.seeMargins || { quiescence: 0 };
				const qMargin = seeMargins.quiescence ?? 0;
				if (seeScore < qMargin) {
					seePruneQ++;
					continue;
				}
			}
			const res = quiescence(nextCtx, alpha, beta, povColor, enemy, deadlineMs, ply + 1);
			const score = res.score;
			if (turn === povColor) {
				if (score > bestScore) bestScore = score;
				alpha = Math.max(alpha, score);
				if (alpha >= beta) return { score: alpha };
			} else {
				if (score < bestScore) bestScore = score;
				beta = Math.min(beta, score);
				if (alpha >= beta) return { score: beta };
			}
		}
		return { score: bestScore };
	}

	function computeHash(ctx, turn) {
		let h = 0n;
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = ctx.board[y][x];
				if (!pc) continue;
				const colorIdx = pc.color === LIGHT ? 0 : 1;
				const pIdx = PIECE_IDX[pc.type];
				const idx = y * 8 + x;
				h ^= ZOBRIST.pieces[colorIdx][pIdx][idx];
			}
		}
		if (ctx.castling && ctx.castling[LIGHT] && typeof ctx.castling[LIGHT].kingside !== "undefined" && ctx.castling[LIGHT].kingside && ZOBRIST.castling[0] !== undefined) h ^= ZOBRIST.castling[0];
		if (ctx.castling && ctx.castling[LIGHT] && typeof ctx.castling[LIGHT].queenside !== "undefined" && ctx.castling[LIGHT].queenside && ZOBRIST.castling[1] !== undefined) h ^= ZOBRIST.castling[1];
		if (ctx.castling && ctx.castling[DARK] && typeof ctx.castling[DARK].kingside !== "undefined" && ctx.castling[DARK].kingside && ZOBRIST.castling[2] !== undefined) h ^= ZOBRIST.castling[2];
		if (ctx.castling && ctx.castling[DARK] && typeof ctx.castling[DARK].queenside !== "undefined" && ctx.castling[DARK].queenside && ZOBRIST.castling[3] !== undefined) h ^= ZOBRIST.castling[3];
		if (ctx.enPassant && ZOBRIST.ep && ZOBRIST.ep[ctx.enPassant.x] !== undefined) h ^= ZOBRIST.ep[ctx.enPassant.x];
		if (turn === DARK && ZOBRIST.side !== undefined) h ^= ZOBRIST.side;
		return h;
	}

	function orderMoves(moves, board, ply = 0, ttMove = null, prevMove = null) {
		// Enhanced move ordering: TT move > captures/promos > killer > history > quiets
		// Cheap quiet tie-breakers: direct-check bonus + PST delta + castling bonus.
		let sideColor = null;
		for (let i = 0; i < moves.length; i++) {
			const mv = moves[i];
			const pc = board?.[mv?.from?.y]?.[mv?.from?.x];
			if (pc && pc.color) { sideColor = pc.color; break; }
		}
		const enemyKing = sideColor ? findKingQuick(board, sideColor === LIGHT ? DARK : LIGHT) : null;
		const PST_SCALE = 2000;
		const CHECK_BONUS = 650_000;
		const CAPTURE_CHECK_BONUS = 500_000;
		const PROMO_CHECK_BONUS = 300_000;
		const CASTLE_BONUS = 25_000;

		function pstDelta(mover, from, to) {
			if (!mover || !PST || !PST[mover.type]) return 0;
			const table = mover.color === LIGHT ? PST[mover.type].w : PST[mover.type].b;
			if (!table) return 0;
			const fromIdx = from.y * 8 + from.x;
			const toIdx = to.y * 8 + to.x;
			return (table[toIdx] || 0) - (table[fromIdx] || 0);
		}

		function givesDirectCheck(board, mv, mover, enemyKing) {
			if (!enemyKing || !mover) return false;
			const toX = mv.to.x, toY = mv.to.y;
			const kx = enemyKing.x, ky = enemyKing.y;
			const dx = kx - toX;
			const dy = ky - toY;

			if (mover.type === "N") {
				const adx = Math.abs(dx), ady = Math.abs(dy);
				return (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
			}
			if (mover.type === "P") {
				const dir = mover.color === LIGHT ? -1 : 1;
				return (ky === toY + dir) && (kx === toX - 1 || kx === toX + 1);
			}
			if (mover.type === "K") {
				return Math.max(Math.abs(dx), Math.abs(dy)) === 1;
			}

			const clearRay = (stepX, stepY) => {
				let x = toX + stepX;
				let y = toY + stepY;
				while (x !== kx || y !== ky) {
					// Treat the mover's origin as empty after the move.
					if (!(x === mv.from.x && y === mv.from.y)) {
						if (board[y][x]) return false;
					}
					x += stepX;
					y += stepY;
				}
				return true;
			};

			if (mover.type === "B" || mover.type === "Q") {
				if (Math.abs(dx) === Math.abs(dy) && dx !== 0) {
					return clearRay(Math.sign(dx), Math.sign(dy));
				}
			}
			if (mover.type === "R" || mover.type === "Q") {
				if (dx === 0 && dy !== 0) return clearRay(0, Math.sign(dy));
				if (dy === 0 && dx !== 0) return clearRay(Math.sign(dx), 0);
			}
			return false;
		}

		return moves.slice().sort((a, b) => scoreMove(b) - scoreMove(a));

		function scoreMove(mv) {
			const mover = board[mv.from.y][mv.from.x];
			if (!mover) return 0;
			const tgt = mv.enPassant ? { type: "P" } : board[mv.to.y][mv.to.x];
			const isCapture = !!tgt || mv.enPassant;
			const isPromo = !!mv.promo;
			const isQuiet = !isCapture && !isPromo;
			const isCastle = mover.type === "K" && Math.abs(mv.to.x - mv.from.x) === 2;
			const movedPieceForCheck = (isPromo && typeof mv.promo === "string") ? { ...mover, type: mv.promo } : mover;
			const idxFrom = mv.from.y * 8 + mv.from.x;
			const idxTo = mv.to.y * 8 + mv.to.x;
			const colorIdx = mover.color === LIGHT ? 0 : 1;
			// TT move gets highest priority
			if (ttMove && ttMove.from.x === mv.from.x && ttMove.from.y === mv.from.y && ttMove.to.x === mv.to.x && ttMove.to.y === mv.to.y) return 10_000_000;
			// Captures/promos next
			if (isCapture) {
				const tgtVal = tgt ? (PIECE_VALUES[tgt.type] || 0) : 0;
				// For move ordering, don't treat king captures as inherently "bad" due to a large king value.
				const moverVal = mover ? (PIECE_VALUES[mover.type] || 0) : 0;
				const lvaVal = (mover && mover.type === "K") ? 0 : moverVal;
				const mvvLva = tgt ? (tgtVal * 120 - lvaVal * 40) : 0;
				let score = (mvvLva + see(board, mv) / 10) * 1000;
				// Capture-checks are highly forcing; boost them within the capture bucket.
				if (enemyKing && givesDirectCheck(board, mv, movedPieceForCheck, enemyKing)) score += CAPTURE_CHECK_BONUS;
				return score;
			}
			if (isPromo) {
				let score = 900_000;
				if (enemyKing && givesDirectCheck(board, mv, movedPieceForCheck, enemyKing)) score += PROMO_CHECK_BONUS;
				return score;
			}
			// Quiet checks are very forcing; prioritize them above killers/history.
			if (isQuiet && enemyKing && givesDirectCheck(board, mv, mover, enemyKing)) {
				return CHECK_BONUS + (historyHeur[colorIdx][idxFrom][idxTo] || 0);
			}
			// Killer moves
			const killerHit = isQuiet && killers[ply]?.some(k => k && k.from.x === mv.from.x && k.from.y === mv.from.y && k.to.x === mv.to.x && k.to.y === mv.to.y);
			if (killerHit) return 500_000;
			// Countermove heuristic (node-specific: refute previous ply move)
const prev = prevMove;
if (isQuiet && prev) {
    const pFrom = prev.from.y * 8 + prev.from.x;
    const pTo = prev.to.y * 8 + prev.to.x;
    const counter = counterMoves[colorIdx][pFrom][pTo];
    if (counter &&
        counter.from.x === mv.from.x &&
        counter.from.y === mv.from.y &&
        counter.to.x === mv.to.x &&
        counter.to.y === mv.to.y) {
        return 450_000; // just below killer moves
    }
}

// Continuation history
if (isQuiet && prev) {
    const pFrom = prev.from.y * 8 + prev.from.x;
    const pTo = prev.to.y * 8 + prev.to.x;
    const cont = continuationHistory[colorIdx][pFrom][pTo];
				const bonus = pstDelta(mover, mv.from, mv.to) * PST_SCALE + (isCastle ? CASTLE_BONUS : 0);
    return historyHeur[colorIdx][idxFrom][idxTo] + cont + bonus;
}

			// History heuristic for quiets
			if (isQuiet) {
				const bonus = pstDelta(mover, mv.from, mv.to) * PST_SCALE + (isCastle ? CASTLE_BONUS : 0);
				return historyHeur[colorIdx][idxFrom][idxTo] + bonus;
			}

			// Default
			return 0;
		}
	}
function attackersTo(board, x, y, color) {
		const attackers = [];
		const pawnDir = color === LIGHT ? -1 : 1;
		for (const dx of [-1, 1]) {
			const px = x + dx;
			const py = y - pawnDir;
			if (onBoard(px, py)) {
				const pc = board[py][px];
				if (pc && pc.color === color && pc.type === "P") attackers.push({ x: px, y: py, type: pc.type });
			}
		}

		const knightSteps = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
		for (const [dx, dy] of knightSteps) {
			const nx = x + dx, ny = y + dy;
			if (!onBoard(nx, ny)) continue;
			const pc = board[ny][nx];
			if (pc && pc.color === color && pc.type === "N") attackers.push({ x: nx, y: ny, type: pc.type });
		}

		const sliderGroups = [
			{ dirs: [[1,0],[-1,0],[0,1],[0,-1]], types: ["R", "Q"] },
			{ dirs: [[1,1],[1,-1],[-1,1],[-1,-1]], types: ["B", "Q"] }
		];
		for (const group of sliderGroups) {
			for (const [dx, dy] of group.dirs) {
				let nx = x + dx, ny = y + dy;
				while (onBoard(nx, ny)) {
					const pc = board[ny][nx];
					if (pc) {
						if (pc.color === color && group.types.includes(pc.type)) attackers.push({ x: nx, y: ny, type: pc.type });
						break;
					}
					nx += dx; ny += dy;
				}
			}
		}

		for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
			const nx = x + dx, ny = y + dy;
			if (!onBoard(nx, ny)) continue;
			const pc = board[ny][nx];
			if (pc && pc.color === color && pc.type === "K") attackers.push({ x: nx, y: ny, type: pc.type });
		}
		return attackers;
	}

	function leastValuableAttacker(board, attackers) {
		const order = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };
		let best = null;
		for (const a of attackers) {
			const pc = board[a.y][a.x];
			if (!pc) continue;
			const score = order[pc.type] || 7;
			if (!best || score < best.order || (score === best.order && (PIECE_VALUES[pc.type] || 0) < (PIECE_VALUES[best.type] || 0))) {
				best = { ...a, order: score, type: pc.type };
			}
		}
		return best ? { x: best.x, y: best.y, type: best.type } : null;
	}

	function see(board, mv) {
		const mover = board[mv.from.y][mv.from.x];
		const targetPiece = mv.enPassant ? (mv.capturePos ? board[mv.capturePos.y][mv.capturePos.x] : null) : board[mv.to.y][mv.to.x];
		if (!targetPiece) return 0;

		const b = cloneBoard(board);
		const toX = mv.to.x, toY = mv.to.y;
		const capVal = (PIECE_VALUES[targetPiece.type] || 0) * 100;
		let gain = [capVal];
		// Apply initial capture
		b[mv.from.y][mv.from.x] = null;
		if (mv.enPassant && mv.capturePos) b[mv.capturePos.y][mv.capturePos.x] = null;
		b[toY][toX] = { ...mover };

		let depth = 0;
		let side = mover.color === LIGHT ? DARK : LIGHT;
		let currentPiece = { ...mover };
		while (true) {
			const attackers = attackersTo(b, toX, toY, side);
			if (!attackers.length) break;
			const nxt = leastValuableAttacker(b, attackers);
			if (!nxt) break;
			const capturedVal = (PIECE_VALUES[currentPiece.type] || 0) * 100;
			depth += 1;
			gain[depth] = capturedVal - gain[depth - 1];
			// make capture
			const piece = b[nxt.y][nxt.x];
			b[nxt.y][nxt.x] = null;
			b[toY][toX] = piece;
			currentPiece = piece;
			side = side === LIGHT ? DARK : LIGHT;
		}
		for (let i = gain.length - 2; i >= 0; i--) gain[i] = -Math.max(-gain[i], gain[i + 1]);
		return gain[0];
	}

	// =====================================================================
	// Drawishness bias via repetition (soft heuristic)
	//
	// When clearly better: discourage repeating the same position.
	// When clearly worse: allow/encourage repetition as a drawing resource.
	//
	// Uses the same position key definition as state.js's repetition tracker:
	//   piece placement + active color + castling + en-passant.
	// We combine game-history counts (state.repetition.counts) with an O(1)
	// per-search-line counter to detect repetition inside the PV.
	// =====================================================================

	let REP_BASE_COUNTS = null; // read-only reference to state.repetition.counts
	let REP_PATH_COUNTS = Object.create(null);
	let REP_PATH_STACK = [];

	function repetitionKeyFor(board, castling, enPassant, turn) {
		let placement = "";
		for (let y = 0; y < 8; y++) {
			let empty = 0;
			for (let x = 0; x < 8; x++) {
				const pc = board[y][x];
				if (!pc) {
					empty++;
					continue;
				}
				if (empty) {
					placement += String(empty);
					empty = 0;
				}
				const t = pc.type;
				const letter = (typeof t === 'string' && t.length) ? t[0] : '?';
				placement += (pc.color === LIGHT) ? letter : letter.toLowerCase();
			}
			if (empty) placement += String(empty);
			if (y < 7) placement += "/";
		}

		const turnField = (turn === LIGHT) ? "w" : "b";

		let castlingField = "";
		try {
			if (castling && castling[LIGHT]) {
				if (castling[LIGHT].kingside) castlingField += "K";
				if (castling[LIGHT].queenside) castlingField += "Q";
			}
			if (castling && castling[DARK]) {
				if (castling[DARK].kingside) castlingField += "k";
				if (castling[DARK].queenside) castlingField += "q";
			}
		} catch (e) {
			castlingField = "";
		}
		if (!castlingField) castlingField = "-";

		let epField = "-";
		if (enPassant && Number.isInteger(enPassant.x) && Number.isInteger(enPassant.y)) {
			const file = String.fromCharCode(97 + enPassant.x);
			const rank = 8 - enPassant.y;
			epField = file + String(rank);
		}

		return placement + " " + turnField + " " + castlingField + " " + epField;
	}

	function repInitForRoot() {
		REP_BASE_COUNTS = null;
		REP_PATH_COUNTS = Object.create(null);
		REP_PATH_STACK = [];
		try {
			if (typeof state !== 'undefined' && state.repetition && state.repetition.counts) {
				REP_BASE_COUNTS = state.repetition.counts;
			}
		} catch (e) {
			REP_BASE_COUNTS = null;
		}
		// Root position is already included in REP_BASE_COUNTS via state.positionHistory,
		// so we intentionally do NOT push it into REP_PATH_COUNTS (avoid double-counting).
	}

	function repPush(key) {
		REP_PATH_STACK.push(key);
		REP_PATH_COUNTS[key] = (REP_PATH_COUNTS[key] || 0) + 1;
	}

	function repPop() {
		if (!REP_PATH_STACK.length) return;
		const key = REP_PATH_STACK.pop();
		const next = (REP_PATH_COUNTS[key] || 0) - 1;
		if (next <= 0) delete REP_PATH_COUNTS[key];
		else REP_PATH_COUNTS[key] = next;
	}

	function repExistingCount(key) {
		return (REP_PATH_COUNTS[key] || 0) + (REP_BASE_COUNTS ? (REP_BASE_COUNTS[key] || 0) : 0);
	}

	function repetitionDrawishBias(staticEvalPawns, existingCount, depth) {
		if (!existingCount) return 0;
		const adv = staticEvalPawns;
		const severity = existingCount >= 2 ? 2 : 1;
		const WIN = 0.60;
		const LOSE = -0.60;
		const depthScale = Math.max(0.35, Math.min(1.0, depth / 6));
		if (adv >= WIN) return (severity === 2 ? -0.45 : -0.20) * depthScale;
		if (adv <= LOSE) return (severity === 2 ? +0.45 : +0.20) * depthScale;
		return (severity === 2 ? -0.06 : -0.03) * depthScale;
	}

	function fiftyMoveNoProgressBias(staticEvalPawns, isNoProgress, depth) {
		// Penalize drifting (no pawn move/capture) when winning; reward it when losing.
		if (!isNoProgress) return 0;
		const WIN = 0.60;
		const LOSE = -0.60;
		const adv = staticEvalPawns;
		if (!(adv >= WIN || adv <= LOSE)) return 0;
		let halfmove = 0;
		try { halfmove = (typeof state !== 'undefined' && Number.isFinite(state.halfmove)) ? state.halfmove : 0; } catch (e) { halfmove = 0; }
		// Stronger bias closer to the 50-move threshold.
		const drift = Math.max(0, Math.min(1, halfmove / 100));
		const depthScale = Math.max(0.35, Math.min(1.0, depth / 6));
		const magnitude = (0.03 + 0.09 * drift) * depthScale; // pawns
		return adv >= WIN ? -magnitude : +magnitude;
	}

	function searchBestMove(ctx, depth, alpha, beta, povColor, turn, deadlineMs, ply = 0, prevMove = null) {
		if (ply === 0) repInitForRoot();
		let repPushed = false;
		try {
			if (ply > 0) {
				try {
					const nodeKey = repetitionKeyFor(ctx.board, ctx.castling, ctx.enPassant, turn);
					repPush(nodeKey);
					repPushed = true;
				} catch (e) {
					repPushed = false;
				}
			}

			if (SEARCH_ABORT) return { score: 0, move: null, cut: true };
			SEARCH_NODES++;
			if (deadlineMs !== Infinity && Date.now() > deadlineMs) return { score: evaluateBoard(ctx.board, povColor), move: null, cut: true };

			// Mate-distance pruning: clamp bounds so mates are preferred by distance.
			// Ensures we never search beyond the maximum possible mate score at this ply.
			const MATE_SCORE = 10000;
			const mateBound = MATE_SCORE - ply;
			if (Number.isFinite(alpha) || alpha === -Infinity) alpha = Math.max(alpha, -mateBound);
			if (Number.isFinite(beta) || beta === Infinity) beta = Math.min(beta, mateBound);
			if (alpha >= beta) return { score: alpha, move: null };
		const hash = computeHash(ctx, turn);
		const usableTT = ttProbe(hash, ply);
		const alphaOrig = alpha;
		const betaOrig = beta;
		const LMP_LIMIT = { 1: 3, 2: 6, 3: 12 };
		const SINGULAR_MARGIN = 90; // centipawns
		// Razoring and extended futility pruning parameters
		// NOTE: evaluation scores are in pawn units (e.g. 0.80), so pruning margins must also be pawn units.
		const pruning = getPruningParamsForCurrentDifficulty();
		const RAZOR_MARGIN = pruning.razor;
		const EXT_FUT_MARGIN = pruning.extFut;
		const LMP_EVAL_GATE = pruning.lmpGate;
		const FUTILITY_MARGIN_PER_DEPTH = pruning.futPerDepth;
		const NULL_MOVE_R_MARGIN = 0.0; // pawns (kept at 0 to preserve behavior)
		// TT move always used for ordering, but cutoff only if structurally safe
		let safeForCutoff = true;
		if (usableTT && usableTT.depth >= depth) {
			safeForCutoff = isStructurallySafe(ctx.board, turn);
			if (safeForCutoff && usableTT.flag === "EXACT") return { score: usableTT.score, move: usableTT.move };
			if (usableTT.flag === "LOW" && usableTT.score > alpha) alpha = usableTT.score;
			else if (usableTT.flag === "HIGH" && usableTT.score < beta) beta = usableTT.score;
			if (safeForCutoff && alpha >= beta) return { score: usableTT.score, move: usableTT.move };
		}

		const enemy = turn === LIGHT ? DARK : LIGHT;
		const inChk = inCheck(turn, ctx.board);
		const staticEval = evaluateBoard(ctx.board, povColor);
		const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turn);
		if (!legal.length) {
			// Draw detection: stalemate, threefold, 50-move rule
if (!inChk && (DrawDetection.isDrawByRepetition() || DrawDetection.isDrawByFiftyMoveRule())) {
			return { score: 0, move: null };
			}
			const mateScore = inChk ? (turn === povColor ? -10000 - depth : 10000 + depth) : 0;
			return { score: mateScore, move: null };
		}
		// Razoring: prune hopeless positions at shallow depth
		if (!inChk && depth === 1 && staticEval + RAZOR_MARGIN <= alpha) {
    return { score: staticEval, move: null };
}

		// Extended futility pruning: even more aggressive at depth 1
		if (!inChk && depth === 1 && staticEval + EXT_FUT_MARGIN <= alpha) {
			return { score: staticEval, move: null };
		}
		if (depth === 0) return quiescence(ctx, alpha, beta, povColor, turn, deadlineMs, ply);
		if (!inChk) {
			const margin = FUTILITY_MARGIN_PER_DEPTH * depth;
			if (staticEval - margin >= beta) return { score: staticEval, move: null }; // reverse futility
		}

		// Internal Iterative Deepening: get a move when TT is missing to improve ordering
		let iidMove = null;
		if (depth >= 4 && !inChk && (!usableTT || !usableTT.move)) {
			const iidDepth = depth - 2;
			if (iidDepth > 0) {
				const iidRes = searchBestMove(ctx, iidDepth, alpha, beta, povColor, turn, deadlineMs, ply, prevMove);
				if (!iidRes.cut && iidRes.move) iidMove = iidRes.move;
				const ttAfterIid = ttProbe(hash, ply);
				if (ttAfterIid && ttAfterIid.move) iidMove = ttAfterIid.move;
			}
		}

		const pieceCount = totalPieces(ctx.board);
		// Null-move pruning: DISABLE if king unsafe or fortress/endgame pattern
		if (depth >= 3 && !inChk && hasNonPawnMaterial(ctx.board, turn) && pieceCount > 6) {
			if (!isFortressOrUnsafe(ctx.board, turn)) {
				const nullCtx = { board: ctx.board, castling: ctx.castling, enPassant: null };
				const r = 2 + Math.floor(depth / 4);
				const nullRes = searchBestMove(nullCtx, depth - 1 - r, -beta, -beta + 1, povColor, enemy, deadlineMs, ply + 1, null);
				if (!nullRes.cut && nullRes.score >= beta + NULL_MOVE_R_MARGIN) return { score: nullRes.score, move: null };
			}
		}

		let bestMove = null;
		let bestScore = turn === povColor ? -Infinity : Infinity;
		const ordered = orderMoves(legal, ctx.board, ply, usableTT?.move || iidMove || null, prevMove);
		for (let i = 0; i < ordered.length; i++) {
			if (SEARCH_ABORT) return { score: 0, move: null, cut: true };
			const mv = ordered[i];
			const nextSim = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
			const nextCtx = { board: nextSim.board, castling: nextSim.castling, enPassant: nextSim.enPassant };
			const givesCheck = inCheck(enemy, nextCtx.board);
			let newDepth = depth - 1;
		let allowCheckExt = false;
if (givesCheck && newDepth > 0 && depth >= 4 && i < 4) {
    allowCheckExt = true;
}
if (allowCheckExt) {
    newDepth = Math.min(depth, newDepth + 1);
}


			const moverPiece = ctx.board[mv.from.y][mv.from.x];
			const isCapture = mv.enPassant || ctx.board[mv.to.y][mv.to.x];
			const isQuiet = !isCapture && !mv.promo && !givesCheck;
			const isTTMove = usableTT && usableTT.move && usableTT.move.from.x === mv.from.x && usableTT.move.from.y === mv.from.y && usableTT.move.to.x === mv.to.x && usableTT.move.to.y === mv.to.y;
			const idxFrom = mv.from.y * 8 + mv.from.x;
			const idxTo = mv.to.y * 8 + mv.to.x;
			const colorIdx = turn === LIGHT ? 0 : 1;
			const histVal = (historyHeur[colorIdx] && historyHeur[colorIdx][idxFrom]) ? (historyHeur[colorIdx][idxFrom][idxTo] || 0) : 0;
			const killerHit = isQuiet && killers[ply]?.some(k => k && k.from.x === mv.from.x && k.from.y === mv.from.y && k.to.x === mv.to.x && k.to.y === mv.to.y);

			// Passed Pawn Extension: extend search for advancing passed pawns
		if (depth >= 4 && moverPiece && moverPiece.type === "P" && !givesCheck) {
    const forward = moverPiece.color === LIGHT ? -1 : 1;
    const advance = mv.to.y - mv.from.y;
    const advances = advance === forward || advance === 2 * forward;
    if (advances) {
        const passedAfter = isPassedPawn(nextCtx.board, { x: mv.to.x, y: mv.to.y }, moverPiece.color);
        if (passedAfter) {
            const rank = moverPiece.color === LIGHT ? 7 - mv.to.y : mv.to.y;
            if (rank >= 5) { // 6th rank or beyond
                const seeScore = see(ctx.board, mv);
                if (Number.isFinite(seeScore) && seeScore >= 0) {
                    const ext = rank >= 6 && depth >= 6 ? 2 : 1;
                    newDepth = Math.min(depth, newDepth + ext);
                }
            }
        }
    }
}


			// Singular Extension: test if TT move looks unique
			if (isTTMove && depth >= 5 && !inChk && usableTT && (usableTT.flag === "LOW" || usableTT.flag === "EXACT") && newDepth > 0) {
				const singularLimit = usableTT.score - SINGULAR_MARGIN / 100; // convert cp to pawn units already scaled in eval
				const narrowAlpha = singularLimit;
				const narrowBeta = singularLimit + 0.01; // effectively singularLimit + 1 cp in pawn units
				let singular = true;
				for (const alt of ordered) {
					if (alt === mv) continue;
					const altSim = simulateMove(alt, ctx.board, ctx.castling, ctx.enPassant);
					const altCtx = { board: altSim.board, castling: altSim.castling, enPassant: altSim.enPassant };
					const altRes = searchBestMove(altCtx, Math.max(1, depth - 2), narrowAlpha, narrowBeta, povColor, enemy, deadlineMs, ply + 1, alt);
					if (altRes.cut || altRes.score >= narrowBeta) { singular = false; break; }
				}
				if (singular) newDepth = Math.min(depth, newDepth + 1);
			}

			// Late Move Pruning: prune late quiets at shallow depth when not in check and not TT move
		if (!inChk && isQuiet && !isTTMove && depth <= 3) {
    const limit = LMP_LIMIT[depth];
			if (limit !== undefined && i >= limit && staticEval + LMP_EVAL_GATE <= alpha) {
        continue;
    }
}


			// Futility pruning: DISABLE if king unsafe or fortress/endgame pattern
			if (!isTTMove && isQuiet && !inChk && depth <= 2 && !givesCheck) {
				if (!isFortressOrUnsafe(ctx.board, turn)) {
					const futMargin = depth * FUTILITY_MARGIN_PER_DEPTH;
					if (staticEval + futMargin <= alpha) {
						continue;
					}
				}
			}

			// SEE pruning: skip bad captures (keep checks/promos/TT move)
			// IMPORTANT: never prune captures when in check; all evasions must be searched.
			if (!inChk && !isTTMove && isCapture && !mv.promo && !givesCheck) {
				const seeScore = see(ctx.board, mv);
				if (!Number.isFinite(seeScore) || seeScore < -30) {
					seePruneMain++;
					continue;
				}
			}
			// More aggressive LMR: reduce even more for late quiets

// LMR: adjust reduction based on move safety
let lmrSafety = 1.0;
if (isQuiet) {
	lmrSafety = getMoveSafety(ctx.board, mv, turn);
	// Fortress/structural/safe: reduce less (scaling < 1), risky/aggressive: reduce more (scaling > 1)
	if (lmrSafety > 1.1) lmrSafety = 0.7; // fortress/structural
	else if (lmrSafety < 0.9) lmrSafety = 1.3; // risky/aggressive
	else lmrSafety = 1.0;
}
// LMR base gate: further restricted per-window inside searchMove().
// NOTE: PV nodes are handled by disallowing LMR on full-window searches.
const lmrLevelEnabled = !(typeof state !== 'undefined' && state && state.aiLevel === 10); // quick experiment gate
const applyLMRBase =
	lmrLevelEnabled &&
	!inChk &&
	isQuiet &&
	!isTTMove &&
	depth >= 4 &&
	i >= 6 &&
	!killerHit &&
	// Don't reduce "known good" quiets.
	histVal < 1500;

			const searchMove = (winA, winB) => {
				let res;
				// Only apply LMR on the PVS probe (null-window) searches.
				// This avoids reducing PV/full-window re-searches which can hide tactics.
				const isNullWindow = Number.isFinite(winA) && Number.isFinite(winB) && (winB === winA + 1);
				const applyLMR = applyLMRBase && isNullWindow;
				if (applyLMR) {
					const dIdx = Math.min(newDepth, LMR_MAX_DEPTH);
					const mIdx = Math.min(i + 1, LMR_MAX_MOVES);
					let reduction = LMR_TABLE[dIdx][mIdx] || 0;
					reduction = Math.round(reduction * lmrSafety);
					// Keep LMR conservative to avoid tactical oversights.
					if (reduction > 2) reduction = 2;
					const reducedDepth = Math.max(1, newDepth - reduction);
					if (reducedDepth < newDepth) {
						const shallow = searchBestMove(nextCtx, reducedDepth, winA, winB, povColor, enemy, deadlineMs, ply + 1, mv);
						// Re-search at full depth if the reduced search could affect the node bounds.
						const improves = turn === povColor ? shallow.score > winA : shallow.score < winB;
						res = improves ? searchBestMove(nextCtx, newDepth, winA, winB, povColor, enemy, deadlineMs, ply + 1, mv) : shallow;
					} else {
						res = searchBestMove(nextCtx, newDepth, winA, winB, povColor, enemy, deadlineMs, ply + 1, mv);
					}
				} else {
					res = searchBestMove(nextCtx, newDepth, winA, winB, povColor, enemy, deadlineMs, ply + 1, mv);
				}
				if (!Number.isFinite(res.score)) res = { ...res, score: 0 };
				// Soft repetition bias (pawn units): nudge away from repetition when
				// winning, nudge toward it when losing.
				if (!res.cut) {
					try {
						const nextKey = repetitionKeyFor(nextCtx.board, nextCtx.castling, nextCtx.enPassant, enemy);
						const existing = repExistingCount(nextKey);
						if (existing > 0) res = { ...res, score: res.score + repetitionDrawishBias(staticEval, existing, depth) };
					} catch (e) {
						// ignore
					}
					// Soft 50-move/no-progress bias: discourage quiet drift when winning,
					// encourage it when losing (drawing resource).
					const moverIsPawn = !!(moverPiece && moverPiece.type === "P");
					const isNoProgress = !isCapture && !moverIsPawn;
					const fmBias = fiftyMoveNoProgressBias(staticEval, isNoProgress, depth);
					if (fmBias) res = { ...res, score: res.score + fmBias };
				}
				return res;
			};

			let res;
			if (i === 0) {
				res = searchMove(alpha, beta); // full window for first move (PV)
			} else {
				res = searchMove(alpha, alpha + 1); // narrow window (PVS)
				const better = turn === povColor ? res.score > alpha : res.score < beta;
				if (better && res.score < beta) {
					res = searchMove(alpha, beta); // re-search with full window
				}
			}
			if (turn === povColor) {
				if (res.score > bestScore) { bestScore = res.score; bestMove = mv; }
				alpha = Math.max(alpha, res.score);
				if (beta <= alpha) {
					storeHeuristics(mv, turn, depth, ply, ctx.board, prevMove);
					return { score: res.score, move: mv };
				}
			} else {
				if (res.score < bestScore) { bestScore = res.score; bestMove = mv; }
				beta = Math.min(beta, res.score);
				if (beta <= alpha) {
					storeHeuristics(mv, turn, depth, ply, ctx.board, prevMove);
					return { score: res.score, move: mv };
				}
			}
			if (Date.now() > deadlineMs) break;
		}

		let flag = "EXACT";
		if (bestScore <= alphaOrig) flag = "HIGH";
		else if (bestScore >= betaOrig) flag = "LOW";
		ttStore(hash, { depth, score: bestScore, move: bestMove, flag, age: searchAge }, ply);
		return { score: bestScore, move: bestMove };
		} finally {
			if (repPushed) repPop();
		}
	}

	function storeHeuristics(mv, color, depth, ply, board, prevMove = null) {
		const idxFrom = mv.from.y * 8 + mv.from.x;
		const idxTo = mv.to.y * 8 + mv.to.x;
		const colorIdx = color === LIGHT ? 0 : 1;
		const b = board || state?.board;
		const target = mv.enPassant ? { type: "P" } : (b?.[mv.to.y]?.[mv.to.x] || null);
		const isCapture = !!target;
		const isPromo = !!mv.promo;
		const isQuiet = !isCapture && !isPromo;
		if (isQuiet) {
			const safety = getMoveSafety(b, mv, color);
			const bonus = Math.round(depth * depth * safety);
			const capped = Math.min(200_000, historyHeur[colorIdx][idxFrom][idxTo] + bonus);
			historyHeur[colorIdx][idxFrom][idxTo] = capped;
			const k = killers[ply];
			if (k) {
				const same = k[0] && k[0].from.x === mv.from.x && k[0].from.y === mv.from.y && k[0].to.x === mv.to.x && k[0].to.y === mv.to.y;
				if (!same) {
					k[1] = k[0];
					k[0] = mv;
				}
			}
			// Record countermove/continuation only for quiet moves.
			if (prevMove) {
				const pFrom = prevMove.from.y * 8 + prevMove.from.x;
				const pTo = prevMove.to.y * 8 + prevMove.to.x;
				counterMoves[colorIdx][pFrom][pTo] = mv;
				const contSafety = getMoveSafety(b, mv, color);
				const contBonus = Math.round(depth * depth * contSafety);
				continuationHistory[colorIdx][pFrom][pTo] =
					Math.min(200_000, continuationHistory[colorIdx][pFrom][pTo] + contBonus);
			}

			

		}
	}
	
	function hasNonPawnMaterial(board, color) {
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (pc && pc.color === color && pc.type !== "P" && pc.type !== "K") return true;
			}
		}
		return false;
	}

	function totalPieces(board) {
		let n = 0;
		for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (board[y][x]) n++;
		return n;
	}

	// aiChooseMove: main entry for AI move selection
	// TODO: Further tune move ordering and pruning for even higher strength
	let CONTEMPT = 0; // in centipawns, e.g. 20 = 0.2 pawns




	function aiChooseMove() {
		SEARCH_ABORT = false;
		if (typeof window !== 'undefined' && !window.abortSearch) {
			window.abortSearch = function() { SEARCH_ABORT = true; };
		}
		const legal = generateLegalMoves(state.aiColor);
		if (!legal.length) return null;
		const settings = getDifficultySettings(state.aiLevel);

		currentDifficulty = settings;
		// Set contempt factor based on difficulty (tune as needed)
		CONTEMPT = settings.contempt !== undefined ? settings.contempt : 20; // 0.2 pawns default
		if (settings.moveNoise && Math.random() < settings.moveNoise) return legal[Math.floor(Math.random() * legal.length)];

		const book = pickBookMove(legal, settings.openingBookStrength);
		if (book) return book;

		seePruneMain = 0;
		seePruneQ = 0;
		searchAge += 1;
		maybeDecayHeuristics();

		const ctx = cloneCtx(state.board, state.castling, state.enPassant);
		const maxDepth = settings.searchDepth;
		const deadline = Date.now() + Math.max(80, settings.thinkTimeMs * 1.3);
		// Deterministic fallback: if the search is interrupted before returning a move,
		// never pick a random legal move (especially important for "Engine Strength").
		let best = { move: legal[0], score: -Infinity };
		let prevScore = 0;

		// Iterative deepening with aspiration windows (scores are in pawns)
		for (let d = 1; d <= maxDepth; d++) {
			if (Date.now() > deadline) break;

			let alpha = -Infinity;
			let beta = Infinity;
			// Start with a tighter window; widen asymmetrically on fail-low/high.
			const ASP_INIT = 0.25; // pawns
			let aspDown = ASP_INIT;
			let aspUp = ASP_INIT;
			const ASP_MAX = 32; // pawns
			const ASP_RETRIES = 3;
			const ASP_TIME_GUARD_MS = 12;

			if (d > 1 && Number.isFinite(prevScore)) {
				alpha = prevScore - aspDown;
				beta = prevScore + aspUp;
			}

			let res = null;
			let attempts = 0;
			while (attempts < ASP_RETRIES) {
				if (Date.now() + ASP_TIME_GUARD_MS > deadline) break;
				res = searchBestMove(ctx, d, alpha, beta, state.aiColor, state.aiColor, deadline, 0);
				if (!res || res.cut || Date.now() > deadline) break;

				// If aspiration failed, widen asymmetrically and retry.
				if (d > 1 && Number.isFinite(prevScore)) {
					const failLow = res.score <= alpha;
					const failHigh = res.score >= beta;
					if (failLow || failHigh) {
						attempts++;
						if (failLow) {
							aspDown = Math.min(aspDown * 2, ASP_MAX);
							// Keep the opposite side tighter for stability, but let it grow
							// slightly after the first miss to reduce ping-pong.
							if (attempts >= 2) aspUp = Math.min(aspUp * 2, ASP_MAX);
						} else {
							aspUp = Math.min(aspUp * 2, ASP_MAX);
							if (attempts >= 2) aspDown = Math.min(aspDown * 2, ASP_MAX);
						}
						alpha = prevScore - aspDown;
						beta = prevScore + aspUp;
						continue;
					}
				}
				break;
			}

			// If we never got a stable score inside the window, fall back to full window once.
			if (
				res &&
				!res.cut &&
				d > 1 &&
				Number.isFinite(prevScore) &&
				(res.score <= alpha || res.score >= beta) &&
				(Date.now() + ASP_TIME_GUARD_MS <= deadline)
			) {
				res = searchBestMove(ctx, d, -Infinity, Infinity, state.aiColor, state.aiColor, deadline, 0);
			}

			if (res && res.move) {
				best = res;
				prevScore = res.score;
			}

			if (!res || res.cut || Date.now() > deadline) break;
		}

		if (typeof window !== 'undefined' && window.DEBUG_ENGINE) {
			console.debug("SEE pruning", { main: seePruneMain, qsearch: seePruneQ, depth: best.move ? maxDepth : 0 });
		}
		let choice = best.move || legal[0];
		if (settings.blunderChance > 0 && Math.random() < settings.blunderChance) {
			const others = legal.filter(mv => mv !== choice);
			if (others.length) choice = others[Math.floor(Math.random() * others.length)];
		}
		return choice;
	}

// ============================================================================
// Multi-PV Search Function
// ============================================================================

function searchMultiPV(ctx, depth, povColor, turn, deadlineMs, numLines) {
	// Reset node counter for accurate reporting (UI only; safe no-op if unavailable).
	try { if (typeof SEARCH_NODES !== 'undefined') SEARCH_NODES = 0; } catch (e) { /* ignore */ }
	searchAge += 1;
	maybeDecayHeuristics();
	const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

	if (numLines <= 1) {
		// Single-PV mode: use existing search
		const result = searchBestMove(ctx, depth, -Infinity, Infinity, povColor, turn, deadlineMs, 0, null);
		const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		const nodes = (typeof SEARCH_NODES !== 'undefined') ? SEARCH_NODES : 0;
		return [{
			score: result.score,
			pv: result.move ? [result.move] : [],
			depth: depth,
			nodes,
			timeMs: Math.max(0, Math.round(t1 - t0)),
			move: result.move
		}];
	}

	// Multi-PV mode: search for top N lines
	const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turn);
	if (!legal.length) {
		return [{
			score: 0,
			pv: [],
			depth: depth,
			nodes: 0,
			timeMs: 0,
			move: null
		}];
	}

	const results = [];
	const excludedMoves = [];
	const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

	for (let lineNum = 0; lineNum < Math.min(numLines, legal.length); lineNum++) {
		const lineT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		const lineNodes0 = (typeof SEARCH_NODES !== 'undefined') ? SEARCH_NODES : 0;
		// Find best move excluding previously found moves
		let bestMove = null;
		let bestScore = turn === povColor ? -Infinity : Infinity;
		let bestPV = [];

		// Order moves (excluding already found ones)
		const hash = computeHash(ctx, turn);
		const ttEntry = ttProbe(hash, 0);
		const candidateMoves = orderMoves(
			legal.filter(mv => !excludedMoves.some(ex => 
				ex.from.x === mv.from.x && ex.from.y === mv.from.y && 
				ex.to.x === mv.to.x && ex.to.y === mv.to.y
			)),
			ctx.board,
			0,
			ttEntry?.move || null,
			null
		);

		if (!candidateMoves.length) break;

		// Search each candidate move
		for (const mv of candidateMoves) {
			const nextSim = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
			const nextCtx = {
				board: nextSim.board,
				castling: nextSim.castling,
				enPassant: nextSim.enPassant
			};

			const enemy = turn === LIGHT ? DARK : LIGHT;
			const res = searchBestMove(
				nextCtx,
				depth - 1,
				-Infinity,
				Infinity,
				povColor,
				enemy,
				deadlineMs,
				1,
				mv
			);

			if (res.cut) break;

			const score = res.score;
			const isBetter = turn === povColor ? score > bestScore : score < bestScore;

			if (isBetter) {
				bestScore = score;
				bestMove = mv;
				// Build PV: current move + continuation
				bestPV = [mv];
				if (res.move) {
					// Extract PV from TT
					const pvMoves = extractPVFromTT(nextCtx, enemy, povColor, depth - 1);
					bestPV = bestPV.concat(pvMoves.slice(0, 10)); // Limit PV length
				}
			}

			if (Date.now() > deadlineMs) break;
		}

		if (!bestMove) break;
		const lineT1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		const lineNodes1 = (typeof SEARCH_NODES !== 'undefined') ? SEARCH_NODES : lineNodes0;
		const lineNodes = Math.max(0, lineNodes1 - lineNodes0);

		// Store this line
		results.push({
			score: bestScore,
			pv: bestPV,
			depth: depth,
			nodes: lineNodes,
			timeMs: Math.max(0, Math.round(lineT1 - lineT0)),
			move: bestMove
		});

		// Exclude this move from future iterations
		excludedMoves.push(bestMove);

		if (Date.now() > deadlineMs) break;
	}

	// Sort results by score (best first)
	results.sort((a, b) => {
		if (turn === povColor) {
			return b.score - a.score; // Descending for maximizing player
		} else {
			return a.score - b.score; // Ascending for minimizing player
		}
	});

	return results.length > 0 ? results : [{
		score: 0,
		pv: [],
		depth: depth,
		nodes: 0,
		timeMs: Math.max(0, Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime)),
		move: null
	}];
}

// ============================================================================
// PV Extraction from Transposition Table
// ============================================================================

function extractPVFromTT(ctx, turn, povColor, maxDepth) {
	const pv = [];
	let currentCtx = ctx;
	let currentTurn = turn;
	let depth = 0;

	while (depth < maxDepth) {
		const hash = computeHash(currentCtx, currentTurn);
		const entry = ttProbe(hash, depth);

		if (!entry || !entry.move) break;

		// Check if move is legal
		const legal = generateLegalMovesFor(
			currentCtx.board,
			currentCtx.castling,
			currentCtx.enPassant,
			currentTurn
		);

		const move = legal.find(m =>
			m.from.x === entry.move.from.x &&
			m.from.y === entry.move.from.y &&
			m.to.x === entry.move.to.x &&
			m.to.y === entry.move.to.y
		);

		if (!move) break;

		pv.push(move);

		// Simulate move and continue
		const nextSim = simulateMove(move, currentCtx.board, currentCtx.castling, currentCtx.enPassant);
		currentCtx = {
			board: nextSim.board,
			castling: nextSim.castling,
			enPassant: nextSim.enPassant
		};
		currentTurn = currentTurn === LIGHT ? DARK : LIGHT;
		depth++;
	}

	return pv;
}


