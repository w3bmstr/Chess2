// ============================================================================
// Integration: Replace existing makeMove and resetBoard
// ============================================================================

// Store original makeMove reference
const originalMakeMove = makeMove;

// Replace makeMove with makeMoveAndRecord
makeMove = function(move) {
	return makeMoveAndRecord(move);
};

// Update resetBoard to initialize positionHistory
const originalResetBoard = resetBoard;
resetBoard = function() {
	clearTrainingNotes();
	const b = createEmptyBoard();
	b[0] = [p("R", DARK), p("N", DARK), p("B", DARK), p("Q", DARK), p("K", DARK), p("B", DARK), p("N", DARK), p("R", DARK)];
	b[1] = Array(COLS).fill(null).map(() => p("P", DARK));
	b[ROWS - 2] = Array(COLS).fill(null).map(() => p("P", LIGHT));
	b[ROWS - 1] = [p("R", LIGHT), p("N", LIGHT), p("B", LIGHT), p("Q", LIGHT), p("K", LIGHT), p("B", LIGHT), p("N", LIGHT), p("R", LIGHT)];

	state.board = b;
	state.turn = LIGHT;
	state.moveHistory = [];
	state.redoStack = [];
	state.lastMove = null;
	state.captures = { [LIGHT]: 0, [DARK]: 0 };
	state.gameOver = false;
	state.winner = null;
	state.message = "";
	state.selected = null;
	state.legal = [];
	state.cursor = { x: 4, y: ROWS - 1 };
	state.castling = initialCastling();
	state.enPassant = null;
	state.halfmove = 0;
	state.fullmove = 1;
	
	// Initialize position history
	const initialFEN = boardToFEN();
	state.positionHistory = [initialFEN];
	if (typeof rebuildRepetitionTracker === 'function') rebuildRepetitionTracker();
	
	updateHud();
	clearHint();
};

let selectedMode = "1p";
let selectedDiff = 5;
currentDifficulty = getDifficultySettings(selectedDiff);
let hintMove = null;
let hintBusy = false;
let hintTimer = null;
let hintRequestToken = 0;
let hintVisible = false;
let trainingMessage = "--";
let mobileExpandedLevel = null;


// Global Multi-PV configuration
let multiPVConfig = {
	enabled: false,
	lines: 1, // 1, 2, 3, or 5
	currentResults: [] // Array of PV entries
};

	function getDifficultySettings(level) {
		const clamped = Math.min(15, Math.max(1, Math.round(level)));
		const table = {
			1:  { name: "Beginner", maxDepth: 1,  searchDepth: 1,  randomness: 0.80, moveNoise: 0.80, blunderChance: 0.65, pruning: 1.00, evalSimplify: 1.00, thinkTimeMs: 70,  openingBookStrength: "none",    seeMargins: { shallow: -260, deeper: -260, quiescence: -230 }, mobile: { range: "100–300", desc: "Relaxed, simplified play with high randomness." } },
			2:  { name: "Casual Player", maxDepth: 2,  searchDepth: 2,  randomness: 0.60, moveNoise: 0.60, blunderChance: 0.45, pruning: 0.90, evalSimplify: 0.90, thinkTimeMs: 90,  openingBookStrength: "weak",   seeMargins: { shallow: -210, deeper: -230, quiescence: -200 }, mobile: { range: "300–600", desc: "Light mistakes and loose pruning for casual feel." } },
			3:  { name: "Hobbyist", maxDepth: 3,  searchDepth: 3,  randomness: 0.45, moveNoise: 0.45, blunderChance: 0.30, pruning: 0.85, evalSimplify: 0.80, thinkTimeMs: 120, openingBookStrength: "weak",   seeMargins: { shallow: -160, deeper: -200, quiescence: -170 }, mobile: { range: "600–900", desc: "Basic tactics, still human-like errors." } },
			4:  { name: "Intermediate", maxDepth: 4,  searchDepth: 4,  randomness: 0.35, moveNoise: 0.35, blunderChance: 0.20, pruning: 0.75, evalSimplify: 0.70, thinkTimeMs: 160, openingBookStrength: "basic",  seeMargins: { shallow: -120, deeper: -170, quiescence: -140 }, mobile: { range: "900–1200", desc: "Solid tactics with occasional misses." } },
			5:  { name: "Strong Amateur", maxDepth: 5,  searchDepth: 5,  randomness: 0.25, moveNoise: 0.25, blunderChance: 0.12, pruning: 0.65, evalSimplify: 0.60, thinkTimeMs: 200, openingBookStrength: "standard", seeMargins: { shallow: -90,  deeper: -140, quiescence: -110 }, mobile: { range: "1200–1500", desc: "Tighter search, still approachable." } },
			6:  { name: "Club Player", maxDepth: 6,  searchDepth: 6,  randomness: 0.20, moveNoise: 0.20, blunderChance: 0.07, pruning: 0.55, evalSimplify: 0.50, thinkTimeMs: 240, openingBookStrength: "standard", seeMargins: { shallow: -70,  deeper: -120, quiescence: -95 }, mobile: { range: "1500–1800", desc: "Consistent play with moderate pruning." } },
			7:  { name: "Advanced Club Player", maxDepth: 7,  searchDepth: 7,  randomness: 0.15, moveNoise: 0.15, blunderChance: 0.05, pruning: 0.45, evalSimplify: 0.40, thinkTimeMs: 280, openingBookStrength: "strong",  seeMargins: { shallow: -55,  deeper: -105, quiescence: -85 }, mobile: { range: "1800–2000", desc: "Stronger pruning and steadier choices." } },
			8:  { name: "Expert", maxDepth: 8,  searchDepth: 8,  randomness: 0.10, moveNoise: 0.10, blunderChance: 0.03, pruning: 0.35, evalSimplify: 0.30, thinkTimeMs: 320, openingBookStrength: "strong",  seeMargins: { shallow: -45,  deeper: -90,  quiescence: -75 }, mobile: { range: "2000–2200", desc: "Low randomness, disciplined tactics." } },
			9:  { name: "Candidate Master", maxDepth: 9,  searchDepth: 9,  randomness: 0.08, moveNoise: 0.08, blunderChance: 0.02, pruning: 0.30, evalSimplify: 0.20, thinkTimeMs: 370, openingBookStrength: "strong",  seeMargins: { shallow: -35,  deeper: -80,  quiescence: -65 }, mobile: { range: "2200–2400", desc: "Sharper calculations with balanced pruning." } },
			10: { name: "Master", maxDepth: 10, searchDepth: 10, randomness: 0.06, moveNoise: 0.06, blunderChance: 0.015, pruning: 0.25, evalSimplify: 0.15, thinkTimeMs: 430, openingBookStrength: "full",    seeMargins: { shallow: -28,  deeper: -70,  quiescence: -55 }, mobile: { range: "2400–2600", desc: "Tight pruning, few errors." } },
			11: { name: "International Master", maxDepth: 11, searchDepth: 11, randomness: 0.04, moveNoise: 0.04, blunderChance: 0.010, pruning: 0.20, evalSimplify: 0.10, thinkTimeMs: 500, openingBookStrength: "full",    seeMargins: { shallow: -22,  deeper: -60,  quiescence: -50 }, mobile: { range: "2600–2800", desc: "Deep search with disciplined eval." } },
			12: { name: "Grandmaster", maxDepth: 12, searchDepth: 12, randomness: 0.03, moveNoise: 0.03, blunderChance: 0.007, pruning: 0.15, evalSimplify: 0.05, thinkTimeMs: 580, openingBookStrength: "full",    seeMargins: { shallow: -18,  deeper: -55,  quiescence: -45 }, mobile: { range: "2800–3000", desc: "Very low randomness and solid pruning." } },
			13: { name: "Super-GM", maxDepth: 13, searchDepth: 13, randomness: 0.02, moveNoise: 0.02, blunderChance: 0.004, pruning: 0.10, evalSimplify: 0.02, thinkTimeMs: 660, openingBookStrength: "full",    seeMargins: { shallow: -14,  deeper: -50,  quiescence: -42 }, mobile: { range: "3000–3200", desc: "Engine-like precision with deep search." } },
			14: { name: "Engine-GM", maxDepth: 14, searchDepth: 14, randomness: 0.01, moveNoise: 0.01, blunderChance: 0.002, pruning: 0.05, evalSimplify: 0.00, thinkTimeMs: 760, openingBookStrength: "full",    seeMargins: { shallow: -12,  deeper: -50,  quiescence: -40 }, mobile: { range: "3200–3400", desc: "Ultra-tight pruning; essentially perfect." } },
			   15: { name: "Engine Strength", maxDepth: 30, searchDepth: 30, randomness: 0.00, moveNoise: 0.00, blunderChance: 0.00, pruning: 0.00, evalSimplify: 0.00, thinkTimeMs: 5000, openingBookStrength: "full",    seeMargins: { shallow: -10,  deeper: -50,  quiescence: -40 }, mobile: { range: "3400–3500", desc: "Full engine strength; no limits. No blunders or randomness." } }
		};
		return table[clamped];
}


	function detectBlunder(prevEval, newEval, move) {
		const delta = newEval - prevEval; // positive is good for mover
		if (delta <= -1.0) return `Blunder: lost about ${Math.abs(delta).toFixed(1)} pawns`;
		if (delta <= -0.5) return `Inaccuracy: dropped about ${Math.abs(delta).toFixed(1)} pawns`;
		if (delta >= 0.8) return `Great move: improved by ${delta.toFixed(1)} pawns`;
		if (delta >= 0.3) return `Good move: improved by ${delta.toFixed(1)} pawns`;
		return `Solid move: ${describeMove(move)}`;
	}

	function explainMove(move, prevEval, newEval) {
		if (!move) return "--";
		const delta = newEval - prevEval;
		const dir = delta > 0 ? "+" : delta < 0 ? "" : "";
		const impact = delta === 0 ? "Neutral move" : `${delta > 0 ? "Improves" : "Worsens"} position by ${dir}${delta.toFixed(2)} pawns`;
		let motifs = (typeof window !== 'undefined' && window.lastTacticalMotifs && window.lastTacticalMotifs.length)
			? `\nTactics: ${window.lastTacticalMotifs.join(", ")}` : "";
		return `${describeMove(move)} — ${impact}${motifs}`;
	}

	function describeMove(move) {
		if (!move) return "--";
		if (move.castle === "kingside") return "Kingside castle";
		if (move.castle === "queenside") return "Queenside castle";
		const piece = move.piece?.type || "?";
		const toSq = `${String.fromCharCode(97 + move.to.x)}${ROWS - move.to.y}`;
		const parts = [`${piece} to ${toSq}`];
		if (move.captured) parts.push(`captures ${move.captured.type}`);
		if (move.promo) parts.push(`promotes to ${move.promo}`);
		return parts.join("; ");
	}







