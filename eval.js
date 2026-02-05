// Make isAttacked globally available at the very top
function isAttacked(board, x, y, color) {
	const enemy = color === LIGHT ? DARK : LIGHT;
	const castling = (typeof state !== 'undefined' && state.castling) ? state.castling : initialCastling();
	const enPassant = (typeof state !== 'undefined' && state.enPassant) ? state.enPassant : null;
	for (let yy = 0; yy < ROWS; yy++) {
		for (let xx = 0; xx < COLS; xx++) {
			const pc = board[yy][xx];
			if (!pc || pc.color !== enemy) continue;
			const moves = genPseudoMovesForSquare(xx, yy, board, castling, enPassant);
			if (moves.some(mv => mv.to.x === x && mv.to.y === y)) return true;
		}
	}
	return false;
}

// Fortress/endgame pattern recognition for draw-machine
function isWrongBishopRookPawnFortress(board) {
	// Detect K+B vs K+P (rook pawn) with bishop of wrong color
	let whiteKing, blackKing, whiteBishop, blackBishop, whitePawn, blackPawn;
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const pc = board[y][x];
			if (!pc) continue;
			if (pc.type === "K" && pc.color === LIGHT) whiteKing = {x, y};
			if (pc.type === "K" && pc.color === DARK) blackKing = {x, y};
			if (pc.type === "B" && pc.color === LIGHT) whiteBishop = {x, y};
			if (pc.type === "B" && pc.color === DARK) blackBishop = {x, y};
			if (pc.type === "P" && pc.color === LIGHT) whitePawn = {x, y};
			if (pc.type === "P" && pc.color === DARK) blackPawn = {x, y};
		}
	}
	// Only one bishop and one pawn for one side
	if (whiteBishop && whitePawn && !blackBishop && !blackPawn) {
		// Rook pawn?
		if (whitePawn.x === 0 || whitePawn.x === 7) {
			// Bishop color
			const lightSquare = (whiteBishop.x + whiteBishop.y) % 2 === 0;
			const promotionCorner = (whitePawn.x === 0) ? 0 : 7;
			// King in wrong corner
			if (whiteKing && whiteKing.x === promotionCorner && (whiteKing.y === 0 || whiteKing.y === 7)) {
				const kingSquare = (whiteKing.x + whiteKing.y) % 2 === 0;
				if (kingSquare !== lightSquare) return true;
			}
		}
	}
	if (blackBishop && blackPawn && !whiteBishop && !whitePawn) {
		if (blackPawn.x === 0 || blackPawn.x === 7) {
			const lightSquare = (blackBishop.x + blackBishop.y) % 2 === 0;
			const promotionCorner = (blackPawn.x === 0) ? 0 : 7;
			if (blackKing && blackKing.x === promotionCorner && (blackKing.y === 0 || blackKing.y === 7)) {
				const kingSquare = (blackKing.x + blackKing.y) % 2 === 0;
				if (kingSquare !== lightSquare) return true;
			}
		}
	}
	return false;
}

function isAdvancedBlockade(board) {
	// Simple version: all pawns are blocked by other pawns, no open files, no minors/majors
	let onlyPawns = true;
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const pc = board[y][x];
			if (!pc) continue;
			if (pc.type !== "P" && pc.type !== "K") onlyPawns = false;
		}
	}
	if (!onlyPawns) return false;
	// Check if all pawns are blocked
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const pc = board[y][x];
			if (!pc || pc.type !== "P") continue;
			const dir = pc.color === LIGHT ? -1 : 1;
			const ny = y + dir;
			if (ny < 0 || ny >= ROWS) continue;
			if (!board[ny][x]) return false;
		}
	}
	return true;
}

function isNoProgress(board) {
	// Both sides have only pawns and kings, and all pawns are locked
	return isAdvancedBlockade(board);
}
// Make isAttacked globally available at the very top
// Draw-machine: penalize open center with unsafe king
function isCentralFileOpen(file, pawnFiles) {
	// Central files: d/e (3,4)
	return isFileOpen(pawnFiles, LIGHT, file) && isFileOpen(pawnFiles, DARK, file);
}

function isKingSafe(color, kingPos, board, COLS, ROWS) {
	const king = kingPos[color];
	if (!king) return false;
	// Consider castled if on g1/c1/g8/c8
	if ((color === LIGHT && king.y === 7 && (king.x === 6 || king.x === 2)) ||
		(color === DARK && king.y === 0 && (king.x === 6 || king.x === 2))) {
		// Check pawn shield
		let shield = 0;
		const dir = color === LIGHT ? -1 : 1;
		for (let dx = -1; dx <= 1; dx++) {
			const x = king.x + dx, y = king.y + dir;
			if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
			const pc = board[y][x];
			if (pc && pc.type === "P" && pc.color === color) shield++;
		}
		return shield >= 2;
	}
	return false;
}


	if (typeof window !== 'undefined') window.initPST = initPST;
	if (typeof global !== 'undefined') global.initPST = initPST;
	function initPST() {
		const mirror = idx => (7 - Math.floor(idx / 8)) * 8 + (idx % 8);
		const make = vals => ({ w: vals, b: vals.map((_, i) => vals[mirror(i)]) });
		return {
			P: make([
				0, 0, 0, 0, 0, 0, 0, 0,
				5, 8, 8, -2, -2, 8, 8, 5,
				1, 1, 2, 3, 3, 2, 1, 1,
				0, 0, 0, 2, 2, 0, 0, 0,
				0, 0, 0, -2, -2, 0, 0, 0,
				1, -1, -2, 0, 0, -2, -1, 1,
				1, 2, 2, -4, -4, 2, 2, 1,
				0, 0, 0, 0, 0, 0, 0, 0
			]),
			N: make([
				-5, -4, -2, -1, -1, -2, -4, -5,
				-3, -2, 0, 0, 0, 0, -2, -3,
				-2, 0, 1, 1, 1, 1, 0, -2,
				-2, 0, 2, 2, 2, 2, 0, -2,
				-2, 0, 2, 2, 2, 2, 0, -2,
				   /* #controls button { flex: 1 1 calc(50% - 6px); text-align: center; }
				   #difficulty-select { display: none; }
				   #difficulty-mobile { display: block; } */
				-3, -2, 0, 0, 0, 0, -2, -3,
				-5, -4, -2, -1, -1, -2, -4, -5
			]),
			B: make([
				-2, -1, -1, -1, -1, -1, -1, -2,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 1, 2, 2, 1, 0, -1,
				-1, 1, 1, 2, 2, 1, 1, -1,
				-1, 0, 2, 2, 2, 2, 0, -1,
				-1, 2, 2, 2, 2, 2, 2, -1,
				-1, 1, 0, 0, 0, 0, 1, -1,
				-2, -1, -1, -1, -1, -1, -1, -2
			]),
			R: make([
				0, 0, 0, 1, 1, 0, 0, 0,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 0, 0, 0, 0, 0, -1,
				1, 1, 1, 1, 1, 1, 1, 1,
				0, 0, 0, 0, 0, 0, 0, 0
			]),
			Q: make([
				0, 0, 0, 1, 1, 0, 0, 0,
				-1, 0, 0, 0, 0, 0, 0, -1,
				-1, 0, 1, 1, 1, 1, 0, -1,
				0, 0, 1, 1, 1, 1, 0, -1,
				-1, 0, 1, 1, 1, 1, 0, -1,
				-1, 0, 1, 1, 1, 1, 0, -1,
				-1, 0, 0, 0, 0, 0, 0, -1,
				0, 0, 0, 0, 0, 0, 0, 0
			]),
			K: make([
				-3, -4, -4, -5, -5, -4, -4, -3,
				-3, -4, -4, -5, -5, -4, -4, -3,
				-3, -4, -4, -5, -5, -4, -4, -3,
				-2, -3, -3, -4, -4, -3, -3, -2,
				-1, -2, -2, -2, -2, -2, -2, -1,
				1, 2, 2, 2, 2, 2, 2, 1,
				2, 3, 3, 3, 3, 3, 3, 2,
				2, 4, 4, 3, 3, 4, 4, 2
			])
		};
	}

	function computePawnHash(board) {
		let h = 0n;
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (!pc || pc.type !== "P") continue;
				const colorIdx = pc.color === LIGHT ? 0 : 1;
				const idx = y * 8 + x;
				h ^= ZOBRIST.pieces[colorIdx][PIECE_IDX.P][idx];
			}
		}
		return h;
	}

	function computeFullHashForEval(board, povColor) {
		// reuse zobrist over pieces only; povColor is not part of the hash to allow symmetry, but side-to-move sign handled by caller
		let h = 0n;
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (!pc) continue;
				const colorIdx = pc.color === LIGHT ? 0 : 1;
				const idx = y * 8 + x;
				const pieceIdx = PIECE_IDX[pc.type];
				if (pieceIdx === undefined) continue;
				h ^= ZOBRIST.pieces[colorIdx][pieceIdx][idx];
			}
		}
		return h;
	}

	function probeEvalHash(key) {
		const idx = Number(key & BigInt(EVAL_TT_SIZE - 1));
		const entry = EVAL_TT[idx];
		if (entry && entry.key === key && entry.age === searchAge) return entry.score;
		return null;
	}

	function storeEvalHash(key, score) {
		if (!Number.isFinite(score)) return;
		const idx = Number(key & BigInt(EVAL_TT_SIZE - 1));
		const entry = EVAL_TT[idx];
		if (!entry || entry.age !== searchAge || entry.key !== key) {
			EVAL_TT[idx] = { key, score, age: searchAge };
		} else {
			EVAL_TT[idx] = { key, score, age: searchAge };
		}
	}

	function countSameColorPawns(board, color, squareParity) {
		let n = 0;
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (pc && pc.type === "P" && pc.color === color && ((x + y) % 2 === squareParity)) n++;
			}
		}
		return n;
	}

	// NOTE: Legacy evalPawns() removed: it was unused and contained stale references
	// (kingPos/pawns/aggressionScale) that could crash if reintroduced.

	function evaluateBoard(board, povColor) {
			// ...existing code...

		// ...existing code...

		// --- Conditional aggression: boost attack/aggression only if own king is safe and opponent's king/structure is weak ---
		function isKingExposed(king, color) {
			if (!king) return false;
			// Exposed if not castled, not shielded, or open/semi-open files nearby
			let openFiles = 0;
			for (let dx = -1; dx <= 1; dx++) {
				const file = king.x + dx;
				if (file < 0 || file >= COLS) continue;
				if (isFileOpen(pawnFiles, color, file) || isFileSemiOpen(pawnFiles, color, file)) openFiles++;
			}
			// Not castled or missing shield
			let shield = 0;
			const dir = color === LIGHT ? -1 : 1;
			for (let dx = -1; dx <= 1; dx++) {
				const x = king.x + dx, y = king.y + dir;
				if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
				const pc = board[y][x];
				if (pc && pc.type === "P" && pc.color === color) shield++;
			}
			const castled = (color === LIGHT && king.y === 7 && (king.x === 6 || king.x === 2)) ||
							(color === DARK && king.y === 0 && (king.x === 6 || king.x === 2));
			return (!castled || shield < 2 || openFiles > 0);
		}

		// --- variable initialization (must be before any function or logic that uses them) ---
		let kingPos = { [LIGHT]: null, [DARK]: null };
		let bishopCount = { [LIGHT]: 0, [DARK]: 0 };
		let score = 0;
		let openingScore = 0;
		let endgameScore = 0;
		let phase = 0;
		const pawnFiles = { [LIGHT]: Array(COLS).fill(0), [DARK]: Array(COLS).fill(0) };
		const pawns = { [LIGHT]: [], [DARK]: [] };
		const rooks = { [LIGHT]: [], [DARK]: [] };
		const queens = { [LIGHT]: [], [DARK]: [] };

		let aggressionScale = 0.5;
		const oppColor = povColor === LIGHT ? DARK : LIGHT;
		if (kingPos && kingPos[povColor] && kingPos[oppColor]) {
			const myKingSafe = isKingSafe(povColor, kingPos, board, COLS, ROWS);
			const oppKingExposed = isKingExposed(kingPos[oppColor], oppColor);
			if (myKingSafe && oppKingExposed) aggressionScale = 1.5;
			else if (myKingSafe) aggressionScale = 1.0;
		}

		// let score = 0; // Removed duplicate declaration
		// Drawish endgame heuristics: opposite bishops, rook+pawn vs rook fortress, etc.
		function isOppositeBishops(board) {
			let bishops = [];
			for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (pc && pc.type === "B") bishops.push({color: pc.color, x, y});
			}
			if (bishops.length === 2 && bishops[0].color !== bishops[1].color) {
				// Check if on opposite colors
				const color1 = (bishops[0].x + bishops[0].y) % 2;
				const color2 = (bishops[1].x + bishops[1].y) % 2;
				if (color1 !== color2) return true;
			}
			return false;
		}
		if (isOppositeBishops(board)) return 0; // Dead draw

		// Advanced pawn structure heuristics: reward chains/walls, penalize unnecessary breaks
		function pawnChainBonus(pawns, color) {
			let bonus = 0;
			for (const p of pawns[color]) {
				// Check for friendly pawn diagonally behind
				const dir = color === LIGHT ? 1 : -1;
				for (let dx of [-1, 1]) {
					const nx = p.x + dx, ny = p.y + dir;
					if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
					const pc = board[ny][nx];
					if (pc && pc.type === "P" && pc.color === color) bonus += 3;
				}
			}
			return bonus;
		}
		score += pawnChainBonus(pawns, LIGHT);
		score -= pawnChainBonus(pawns, DARK);
						// Discourage unnecessary trades: penalize if a trade increases pawn islands or breaks fortress potential
						function countPawnIslands(pawnFiles, color) {
							let islands = 0;
							let inIsland = false;
							for (let file = 0; file < COLS; file++) {
								if (pawnFiles[color][file] > 0) {
									if (!inIsland) islands++;
									inIsland = true;
								} else {
									inIsland = false;
								}
							}
							return islands;
						}
						// If minor/major pieces are reduced and pawn islands increase, penalize
						let whitePieces = 0, blackPieces = 0;
						for (let y = 0; y < ROWS; y++) {
							for (let x = 0; x < COLS; x++) {
								const pc = board[y][x];
								if (!pc) continue;
								if (pc.color === LIGHT && ["N","B","R","Q"].includes(pc.type)) whitePieces++;
								if (pc.color === DARK && ["N","B","R","Q"].includes(pc.type)) blackPieces++;
							}
						}
						const whiteIslands = countPawnIslands(pawnFiles, LIGHT);
						const blackIslands = countPawnIslands(pawnFiles, DARK);
						// If few pieces and more than 2 islands, penalize
						if (whitePieces <= 2 && whiteIslands > 2) score -= 12 * (whiteIslands - 2);
						if (blackPieces <= 2 && blackIslands > 2) score += 12 * (blackIslands - 2);
					// King fortress zone bonus: reward if king is surrounded by own pawns/minors in endgame
					function kingFortressZoneBonus(king, color) {
						if (!king) return 0;
						let fortress = 0;
						let minorTypes = ["P", "N", "B"];
						for (let dx = -1; dx <= 1; dx++) {
							for (let dy = -1; dy <= 1; dy++) {
								if (dx === 0 && dy === 0) continue;
								const x = king.x + dx, y = king.y + dy;
								if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
								const pc = board[y][x];
								if (pc && pc.color === color && minorTypes.includes(pc.type)) fortress++;
							}
						}
						// Only reward in endgame (few pieces left)
						if (fortress >= 5 && totalPieces(board) <= 12) return 20;
						if (fortress >= 3 && totalPieces(board) <= 8) return 40;
						return 0;
					}
					score += kingFortressZoneBonus(kingPos[LIGHT], LIGHT);
					score -= kingFortressZoneBonus(kingPos[DARK], DARK);
				// Symmetry bonus: reward highly symmetrical pawn structure and piece placement
				function symmetryScore(board) {
					let pawnSym = 0, pieceSym = 0, total = 0;
					for (let y = 0; y < ROWS; y++) {
						for (let x = 0; x < Math.floor(COLS/2); x++) {
							const mirrorX = COLS - 1 - x;
							const left = board[y][x];
							const right = board[y][mirrorX];
							if (left && right && left.type === right.type && left.color === right.color) {
								if (left.type === "P") pawnSym++;
								else pieceSym++;
							}
							total++;
						}
					}
					// Weight: prefer pawn symmetry, but reward both
					return pawnSym * 3 + pieceSym;
				}
				score += symmetryScore(board);
			// Fortress/endgame pattern recognition (draw-machine)
			if (isWrongBishopRookPawnFortress(board) || isAdvancedBlockade(board) || isNoProgress(board)) {
				return 0; // Draw
			}
		// ...existing code...

		// ...existing code...
			// Guarantee piece arrays exist before any reference
			const knights = { [LIGHT]: [], [DARK]: [] };
			const bishops = { [LIGHT]: [], [DARK]: [] };
		// ...existing code...
		// ...existing code...
	// ...existing code...


function isDefended(board, x, y, color) {
	const castling = (typeof state !== 'undefined' && state.castling) ? state.castling : initialCastling();
	const enPassant = (typeof state !== 'undefined' && state.enPassant) ? state.enPassant : null;
	for (let yy = 0; yy < ROWS; yy++) {
		for (let xx = 0; xx < COLS; xx++) {
			const pc = board[yy][xx];
			if (!pc || pc.color !== color) continue;
			if (xx === x && yy === y) continue;
			const moves = genPseudoMovesForSquare(xx, yy, board, castling, enPassant);
			if (moves.some(mv => mv.to.x === x && mv.to.y === y)) return true;
		}
	}
	return false;
}
	// ...existing code...
		
// ...existing code...
		// ...existing code...
				// ...existing code...
		const fullKey = computeFullHashForEval(board, povColor);
		const cached = probeEvalHash(fullKey);
		if (cached !== null) return cached;
		const MOBILITY_WEIGHT = 2;
		const KNIGHT_CENTER_BONUS = 14;
		const BISHOP_PAIR_BONUS = 32;
		const ROOK_OPEN_BONUS = 24;
		const ROOK_SEMI_BONUS = 12;
		const LONG_DIAG_WEIGHT = 2;
		const ENDGAME_THRESHOLD = 12;

		// Tapered PST: opening and endgame tables (modest values)
		const mirror = idx => (7 - Math.floor(idx / 8)) * 8 + (idx % 8);
		const make = vals => ({ w: vals, b: vals.map((_, i) => vals[mirror(i)]) });
		const PST_OPEN = {
			P: make([
				0, 0, 0, 0, 0, 0, 0, 0,
				5, 8, 8, 5, 5, 8, 8, 5,
				1, 2, 3, 4, 4, 3, 2, 1,
				0, 0, 1, 3, 3, 1, 0, 0,
				0, 0, 0, 2, 2, 0, 0, 0,
				1, 0, 0, -2, -2, 0, 0, 1,
				1, 1, 1, -4, -4, 1, 1, 1,
				0, 0, 0, 0, 0, 0, 0, 0
			]),
			N: make([
				-8, -6, -4, -4, -4, -4, -6, -8,
				-6, -2, 0, 0, 0, 0, -2, -6,
				-4, 0, 4, 6, 6, 4, 0, -4,
				-4, 1, 6, 8, 8, 6, 1, -4,
				-4, 1, 6, 8, 8, 6, 1, -4,
				-4, 0, 4, 6, 6, 4, 0, -4,
				-6, -2, 0, 1, 1, 0, -2, -6,
				-8, -6, -4, -4, -4, -4, -6, -8
			]),
			B: make([
				-4, -2, -2, -2, -2, -2, -2, -4,
				-2, 0, 0, 0, 0, 0, 0, -2,
				-2, 0, 2, 3, 3, 2, 0, -2,
				-2, 2, 3, 4, 4, 3, 2, -2,
				-2, 0, 3, 4, 4, 3, 0, -2,
				-2, 2, 3, 4, 4, 3, 2, -2,
				-2, 0, 1, 1, 1, 1, 0, -2,
				-4, -2, -2, -2, -2, -2, -2, -4
			]),
			R: make([
				0, 0, 1, 2, 2, 1, 0, 0,
				-1, -1, 0, 1, 1, 0, -1, -1,
				-1, -1, 0, 1, 1, 0, -1, -1,
				-1, -1, 0, 1, 1, 0, -1, -1,
				-1, -1, 0, 1, 1, 0, -1, -1,
				1, 1, 1, 2, 2, 1, 1, 1,
				2, 2, 2, 2, 2, 2, 2, 2,
				1, 1, 1, 1, 1, 1, 1, 1
			]),
			Q: make([
				0, 0, 0, 1, 1, 0, 0, 0,
				0, 0, 1, 2, 2, 1, 0, 0,
				0, 1, 1, 2, 2, 1, 1, 0,
				0, 1, 2, 2, 2, 2, 1, 0,
				0, 1, 2, 2, 2, 2, 1, 0,
				0, 1, 1, 2, 2, 1, 1, 0,
				0, 0, 1, 2, 2, 1, 0, 0,
				0, 0, 0, 1, 1, 0, 0, 0
			]),
			K: make([
				-10, -12, -12, -14, -14, -12, -12, -10,
				-10, -12, -12, -14, -14, -12, -12, -10,
				-8, -10, -12, -14, -14, -12, -10, -8,
				-6, -8, -10, -12, -12, -10, -8, -6,
				-4, -6, -8, -8, -8, -8, -6, -4,
				-2, -2, -4, -4, -4, -4, -2, -2,
				4, 4, 0, 0, 0, 0, 4, 4,
				6, 8, 4, 0, 0, 4, 8, 6
			])
		};

		const PST_END = {
			P: make([
				0, 0, 0, 0, 0, 0, 0, 0,
				2, 3, 3, 3, 3, 3, 3, 2,
				2, 4, 5, 6, 6, 5, 4, 2,
				1, 3, 4, 6, 6, 4, 3, 1,
				1, 2, 3, 4, 4, 3, 2, 1,
				0, 1, 2, 3, 3, 2, 1, 0,
				0, 0, 0, 0, 0, 0, 0, 0,
				0, 0, 0, 0, 0, 0, 0, 0
			]),
			N: make([
				-6, -4, -2, -2, -2, -2, -4, -6,
				-4, 0, 1, 2, 2, 1, 0, -4,
				-2, 1, 5, 7, 7, 5, 1, -2,
				-2, 2, 7, 10, 10, 7, 2, -2,
				-2, 2, 7, 10, 10, 7, 2, -2,
				-2, 1, 5, 7, 7, 5, 1, -2,
				-4, 0, 1, 2, 2, 1, 0, -4,
				-6, -4, -2, -2, -2, -2, -4, -6
			]),
			B: make([
				-3, -2, -2, -2, -2, -2, -2, -3,
				-2, 0, 1, 1, 1, 1, 0, -2,
				-2, 1, 3, 4, 4, 3, 1, -2,
				-2, 2, 4, 6, 6, 4, 2, -2,
				-2, 2, 4, 6, 6, 4, 2, -2,
				-2, 1, 3, 4, 4, 3, 1, -2,
				-2, 0, 1, 1, 1, 1, 0, -2,
				-3, -2, -2, -2, -2, -2, -2, -3
			]),
			R: make([
				0, 0, 1, 2, 2, 1, 0, 0,
				0, 0, 1, 2, 2, 1, 0, 0,
				0, 0, 1, 2, 2, 1, 0, 0,
				1, 1, 2, 3, 3, 2, 1, 1,
				1, 1, 2, 3, 3, 2, 1, 1,
				1, 1, 2, 2, 2, 2, 1, 1,
				2, 2, 2, 2, 2, 2, 2, 2,
				2, 2, 2, 2, 2, 2, 2, 2
			]),
			Q: make([
				0, 0, 1, 2, 2, 1, 0, 0,
				0, 1, 2, 3, 3, 2, 1, 0,
				0, 2, 3, 4, 4, 3, 2, 0,
				0, 2, 4, 5, 5, 4, 2, 0,
				0, 2, 4, 5, 5, 4, 2, 0,
				0, 2, 3, 4, 4, 3, 2, 0,
				0, 1, 2, 3, 3, 2, 1, 0,
				0, 0, 1, 2, 2, 1, 0, 0
			]),
			K: make([
				-4, -2, -2, -2, -2, -2, -2, -4,
				-2, 0, 0, 0, 0, 0, 0, -2,
				-2, 0, 2, 2, 2, 2, 0, -2,
				-2, 0, 2, 4, 4, 2, 0, -2,
				-2, 0, 2, 4, 4, 2, 0, -2,
				-2, 0, 2, 2, 2, 2, 0, -2,
				-2, 0, 0, 0, 0, 0, 0, -2,
				-4, -2, -2, -2, -2, -2, -2, -4
			])
		};

		const PHASE_WEIGHTS = { P: 0, N: 1, B: 1, R: 2, Q: 4, K: 0 };
		const MAX_PHASE = 32;

		function evaluatePawns(board, pawns, pawnFiles) {
			const key = computePawnHash(board);
			const idx = Number(key & BigInt(PAWN_TT_SIZE - 1));
			const entry = PAWN_TT[idx];
			if (entry && entry.key === key && entry.age === searchAge) {
				return entry;
			}
			const struct = evaluatePawnStructure(board, pawns, pawnFiles);
			const safeStruct = Number.isFinite(struct) ? struct : 0;
			const record = { key, opening: safeStruct, endgame: safeStruct, age: searchAge };
			PAWN_TT[idx] = record;
			return record;
		}

		// ...existing code...


		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (!pc) continue;
				
				// Tactical safety is handled later via a single hanging-piece pass;
				// avoid per-piece SEE scanning here (very expensive and double-counting).

				const idx = y * 8 + x;
				const material = (PIECE_VALUES[pc.type] || 0) * 100;
				score += (pc.color === povColor ? 1 : -1) * material;
				const oPst = PST_OPEN[pc.type][pc.color === LIGHT ? "w" : "b"][idx] || 0;
				const ePst = PST_END[pc.type][pc.color === LIGHT ? "w" : "b"][idx] || 0;
				openingScore += (pc.color === povColor ? 1 : -1) * oPst;
				endgameScore += (pc.color === povColor ? 1 : -1) * ePst;
				phase += PHASE_WEIGHTS[pc.type] || 0;

				if (pc.type === "P") {
					pawnFiles[pc.color][x] += 1;
					pawns[pc.color].push({ x, y });
				} else if (pc.type === "R") {
					rooks[pc.color].push({ x, y });
				} else if (pc.type === "Q") {
					queens[pc.color].push({ x, y });
				} else if (pc.type === "B") {
					bishops[pc.color].push({ x, y });
					bishopCount[pc.color]++;
				} else if (pc.type === "N") {
					knights[pc.color].push({ x, y });
				} else if (pc.type === "K") {
					kingPos[pc.color] = { x, y };
				}
			}
		}

		// Now that piece lists and king positions are known, compute aggressionScale.
		aggressionScale = 0.5;
		const oppColor2 = povColor === LIGHT ? DARK : LIGHT;
		if (kingPos[povColor] && kingPos[oppColor2]) {
			const myKingSafe = isKingSafe(povColor, kingPos, board, COLS, ROWS);
			const oppKingExposed = isKingExposed(kingPos[oppColor2], oppColor2);
			if (myKingSafe && oppKingExposed) aggressionScale = 1.5;
			else if (myKingSafe) aggressionScale = 1.0;
		}

		    // --- Development Bonus ---
    score += evaluateDevelopment(board, knights, bishops, rooks, queens, kingPos, povColor);

    // --- Center Control ---
    score += evaluateCenterControl(board, povColor);
	    // --- Mobility Scoring ---
	// Mobility is already included in evaluateActivity(); avoid double-counting here.
    // --- King Safety Scaling ---
	const kingSafetyScale = evaluateKingSafetyPhase(phase);
   
    // --- Rook Activity ---
    score += evaluateRookActivity(board, rooks, pawns, povColor);

		// Pawn structure (TT-backed) should feed into the tapered evaluation.
		const pawnEval = evaluatePawns(board, pawns, pawnFiles);
		if (pawnEval) {
			openingScore += pawnEval.opening * (povColor === LIGHT ? 1 : -1);
			endgameScore += pawnEval.endgame * (povColor === LIGHT ? 1 : -1);
		}

		const ph = Math.max(0, Math.min(MAX_PHASE, phase));
		const mgScale = ph / MAX_PHASE;
		const blendedPst = (openingScore * ph + endgameScore * (MAX_PHASE - ph)) / MAX_PHASE;
		score += blendedPst;

		// --- Advanced Pawn Structure ---
		function advancedPawnStructure(color) {
			let iso = 0, dbl = 0, bwd = 0, pass = 0, conn = 0;
			for (let file = 0; file < COLS; file++) {
				const count = pawnFiles[color][file];
				if (count > 1) dbl += count - 1;
				if (count > 0) {
					const left = file > 0 ? pawnFiles[color][file - 1] : 0;
					const right = file < COLS - 1 ? pawnFiles[color][file + 1] : 0;
					if (left === 0 && right === 0) iso++;
					if (left > 0 || right > 0) conn++;
				}
			}
			for (const p of pawns[color]) {
				if (isBackwardPawn(board, pawnFiles, p, color)) bwd++;
				if (isPassedPawn(board, p, color)) pass++;
			}
			return { iso, dbl, bwd, pass, conn };
		}
		const pawnStructW = advancedPawnStructure(LIGHT);
		const pawnStructB = advancedPawnStructure(DARK);
		// Avoid double-counting pawn structure: isolated/doubled/backward/passed are already covered
		// by evaluatePawnStructure() via pawnEval. Keep only the connected-pawn signal here.
		score += (pawnStructW.conn - pawnStructB.conn) * 4;

		// --- Outpost Detection ---
		function isOutpost(x, y, color) {
			const enemy = color === LIGHT ? DARK : LIGHT;
			if (color === LIGHT && y > 4) return false;
			if (color === DARK && y < 3) return false;
			const pawnDir = color === LIGHT ? 1 : -1;
			for (const dx of [-1, 1]) {
				const px = x + dx, py = y + pawnDir;
				if (px < 0 || px >= COLS || py < 0 || py >= ROWS) continue;
				const pc = board[py][px];
				if (pc && pc.type === "P" && pc.color === enemy) return false;
			}
			return true;
		}
		let outpostScore = 0;
		for (const n of knights[LIGHT]) if (isOutpost(n.x, n.y, LIGHT)) outpostScore += 12;
		for (const n of knights[DARK]) if (isOutpost(n.x, n.y, DARK)) outpostScore -= 12;
		score += outpostScore;

		// --- King Zone Attack Count ---
		function kingZoneAttackCount(king, color) {
			if (!king) return 0;
			const enemy = color === LIGHT ? DARK : LIGHT;
			let count = 0;
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					if (dx === 0 && dy === 0) continue;
					const x = king.x + dx, y = king.y + dy;
					if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
					if (isAttacked(board, x, y, enemy)) count++;
				}
			}
			return count;
		}
		const kingZoneW = kingZoneAttackCount(kingPos[LIGHT], LIGHT);
		const kingZoneB = kingZoneAttackCount(kingPos[DARK], DARK);
		// King zone pressure is a middlegame concept; scale it down in endgames.
		score -= (kingZoneW - kingZoneB) * 10 * kingSafetyScale;

		// --- Space Advantage (draw-machine: scale down unless king is safe and center is closed) ---
		function isCenterClosed() {
			// Center squares: d4, d5, e4, e5 (3,3 3,4 4,3 4,4)
			for (const [x, y] of [[3,3],[3,4],[4,3],[4,4]]) {
				const pc = board[y][x];
				if (!pc || pc.type === "P") continue;
				// If any non-pawn piece is on a center square, consider open
				return false;
			}
			return true;
		}
		function spaceAdvantage(color) {
			let space = 0;
			const start = color === LIGHT ? 2 : 5;
			const end = color === LIGHT ? 6 : 2;
			const dir = color === LIGHT ? 1 : -1;
			for (let y = start; color === LIGHT ? y < end : y > end; y += dir) {
				for (let x = 0; x < COLS; x++) {
					const pc = board[y][x];
					if (!pc) space++;
					else if (pc.color === color) space += 0.2;
				}
			}
			return space;
		}
		const spaceW = spaceAdvantage(LIGHT);
		const spaceB = spaceAdvantage(DARK);
		let spaceScale = 1.0;
		if (!isKingSafe(LIGHT, kingPos, board, COLS, ROWS) || !isKingSafe(DARK, kingPos, board, COLS, ROWS) || !isCenterClosed()) spaceScale = 0.4;
		score += (spaceW - spaceB) * 2.5 * spaceScale * mgScale;

		// --- Initiative (move count in enemy half) ---
		function initiative(color) {
			let moves = 0;
			const half = color === LIGHT ? 3 : 4;
			for (let y = 0; y < ROWS; y++) {
				for (let x = 0; x < COLS; x++) {
					const pc = board[y][x];
					if (!pc || pc.color !== color) continue;
					const pseudo = genPseudoMovesForSquare(x, y, board, state?.castling, state?.enPassant);
					for (const mv of pseudo) {
						if ((color === LIGHT && mv.to.y < half) || (color === DARK && mv.to.y > half)) moves++;
					}
				}
			}
			return moves;
		}
		const initW = initiative(LIGHT);
		const initB = initiative(DARK);
		score += (initW - initB) * 1.5 * aggressionScale * mgScale;

		// --- Dynamic Imbalances (queen activity) ---
		let imbalance = 0;
		// Draw-machine: Only reward queen activity if king is safe (castled and shielded)
		function isKingSafeForQueenActivity(color) {
			return isKingSafe(color, kingPos, board, COLS, ROWS);
		}
		if (isKingSafeForQueenActivity(LIGHT)) {
			for (const q of queens[LIGHT]) if (q.y < 4) imbalance += 4;
		}
		if (isKingSafeForQueenActivity(DARK)) {
			for (const q of queens[DARK]) if (q.y > 3) imbalance -= 4;
		}
		score += imbalance;

		if (bishopCount[LIGHT] >= 2) score += BISHOP_PAIR_BONUS * (povColor === LIGHT ? 1 : -1);
		if (bishopCount[DARK] >= 2) score -= BISHOP_PAIR_BONUS * (povColor === LIGHT ? 1 : -1);

		if (kingPos[LIGHT]) score += evaluateKingSafetyDetailed(board, kingPos[LIGHT], LIGHT, pawnFiles, rooks, queens, bishops, knights) * kingSafetyScale * (povColor === LIGHT ? 1 : -1);
		if (kingPos[DARK]) score += evaluateKingSafetyDetailed(board, kingPos[DARK], DARK, pawnFiles, rooks, queens, bishops, knights) * kingSafetyScale * (povColor === DARK ? 1 : -1);

		// Hanging piece penalty (after score and piece lists are built)
		let hangingPenalty = 0;
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (!pc || pc.type === "K") continue;
				if (isAttacked(board, x, y, pc.color) && !isDefended(board, x, y, pc.color)) {
					// Penalize hanging pieces, scaled by value
					const penalty = (PIECE_VALUES[pc.type] || 1) * 40;
					hangingPenalty += (pc.color === povColor ? -penalty : penalty);
				}
			}
		}
		score += hangingPenalty;

		// Rook open/semi-open file activity is handled by evaluateRookActivity(); avoid double-counting here.

		const activityScore = evaluateActivity(board, pawns, knights, bishops, rooks, queens, kingPos, MOBILITY_WEIGHT, KNIGHT_CENTER_BONUS, LONG_DIAG_WEIGHT);
		score += activityScore * (povColor === LIGHT ? 1 : -1) * aggressionScale;

		const tropismScore = evaluateKingTropism(board, knights, bishops, rooks, queens, kingPos, ph, MAX_PHASE);
		score += tropismScore * (povColor === LIGHT ? 1 : -1);

		const rook7Score = evaluateRookOnSeventh(board, rooks, pawns, kingPos, ph, MAX_PHASE);
		score += rook7Score * (povColor === LIGHT ? 1 : -1);
	// --- Advanced Tactical Pattern Recognition ---
		// Forks and pins assumed present; add discovered attacks, skewers, double checks
		function isLineClear(x1, y1, x2, y2, board) {
			const dx = Math.sign(x2 - x1);
			const dy = Math.sign(y2 - y1);
			let cx = x1 + dx, cy = y1 + dy;
			while (cx !== x2 || cy !== y2) {
				if (cx === x2 && cy === y2) break;
				if (board[cy][cx]) return false;
				cx += dx; cy += dy;
			}
			return true;
		}

		let tacticalScore = 0;
		let tacticalMotifs = [];

		// Discovered attacks and double checks
		for (const color of [LIGHT, DARK]) {
			const enemy = color === LIGHT ? DARK : LIGHT;
			const myRooks = rooks[color];
			const myBishops = bishops[color];
			const myQueens = queens[color];
			const myKnights = knights[color];
			const myKing = kingPos[color];
			const enemyKing = kingPos[enemy];

			// Discovered attacks: move a piece to reveal a rook/bishop/queen attack on a valuable enemy piece
			const sliders = [...myRooks, ...myBishops, ...myQueens];
			for (const s of sliders) {
				const dirs = [];
				if (myRooks.some(r => r.x === s.x && r.y === s.y) || myQueens.some(q => q.x === s.x && q.y === s.y)) {
					dirs.push([1,0],[-1,0],[0,1],[0,-1]);
				}
				if (myBishops.some(b => b.x === s.x && b.y === s.y) || myQueens.some(q => q.x === s.x && q.y === s.y)) {
					dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
				}
				for (const [dx, dy] of dirs) {
					let nx = s.x + dx, ny = s.y + dy;
					let blocked = false, foundBlocker = null, foundTarget = null;
					while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
						const pc = board[ny][nx];
						if (pc) {
							if (!blocked && pc.color === color && pc.type !== "K") {
								blocked = true;
								foundBlocker = { x: nx, y: ny, type: pc.type };
							} else if (blocked && pc.color === enemy) {
								foundTarget = { x: nx, y: ny, type: pc.type };
								break;
							} else break;
						}
						nx += dx; ny += dy;
					}
					if (blocked && foundBlocker && foundTarget && PIECE_VALUES[foundTarget.type] > PIECE_VALUES[foundBlocker.type]) {
						// Discovered attack: moving blocker reveals attack on more valuable enemy piece
						tacticalScore += (PIECE_VALUES[foundTarget.type] - PIECE_VALUES[foundBlocker.type]) * 12 * (color === povColor ? 1 : -1);
						if (color === povColor) tacticalMotifs.push(`Discovered attack: ${foundBlocker.type} reveals ${foundTarget.type}`);
					}
				}
			}

			// Skewers: valuable piece in front, less valuable behind
			for (const s of sliders) {
				const dirs = [];
				if (myRooks.some(r => r.x === s.x && r.y === s.y) || myQueens.some(q => q.x === s.x && q.y === s.y)) {
					dirs.push([1,0],[-1,0],[0,1],[0,-1]);
				}
				if (myBishops.some(b => b.x === s.x && b.y === s.y) || myQueens.some(q => q.x === s.x && q.y === s.y)) {
					dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
				}
				for (const [dx, dy] of dirs) {
					let nx = s.x + dx, ny = s.y + dy;
					let foundValuable = null, foundLesser = null;
					while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
						const pc = board[ny][nx];
						if (pc) {
							if (!foundValuable && pc.color === enemy && PIECE_VALUES[pc.type] >= 5) {
								foundValuable = { x: nx, y: ny, type: pc.type };
							} else if (foundValuable && pc.color === enemy && PIECE_VALUES[pc.type] < PIECE_VALUES[foundValuable.type]) {
								foundLesser = { x: nx, y: ny, type: pc.type };
								break;
							} else break;
						}
						nx += dx; ny += dy;
					}
					if (foundValuable && foundLesser) {
						tacticalScore += (PIECE_VALUES[foundValuable.type] - PIECE_VALUES[foundLesser.type]) * 10 * (color === povColor ? 1 : -1);
						if (color === povColor) tacticalMotifs.push(`Skewer: ${foundValuable.type} in front of ${foundLesser.type}`);
					}
				}
			}

			// Double check: two pieces simultaneously attack the king
			if (enemyKing) {
				let attackers = 0;
				const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
				for (const [dx, dy] of dirs) {
					let nx = enemyKing.x + dx, ny = enemyKing.y + dy;
					while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
						const pc = board[ny][nx];
						if (pc) {
							if (pc.color === color && ["Q","R","B"].includes(pc.type)) attackers++;
							break;
						}
						nx += dx; ny += dy;
					}
				}
				for (const n of myKnights) {
					if (Math.abs(n.x - enemyKing.x) === 1 && Math.abs(n.y - enemyKing.y) === 2) attackers++;
					if (Math.abs(n.x - enemyKing.x) === 2 && Math.abs(n.y - enemyKing.y) === 1) attackers++;
				}
				if (attackers >= 2) {
					tacticalScore += 60 * (color === povColor ? 1 : -1);
					if (color === povColor) tacticalMotifs.push(`Double check on enemy king`);
				}
			}
		}

		score += tacticalScore;
		// Expose motifs for training notes (global for last eval)
		if (typeof window !== 'undefined') window.lastTacticalMotifs = tacticalMotifs;

		// --- Trapped Pieces ---
		for (const color of [LIGHT, DARK]) {
			const enemy = color === LIGHT ? DARK : LIGHT;
			const allPieces = [ ...knights[color], ...bishops[color], ...rooks[color], ...queens[color] ];
			for (const p of allPieces) {
				const moves = genPseudoMovesForSquare(p.x, p.y, board, state?.castling, state?.enPassant);
				if (moves.length === 0 && isAttacked(board, p.x, p.y, color)) {
					if (color === povColor) tacticalMotifs.push(`Trapped ${board[p.y][p.x].type} at ${String.fromCharCode(97+p.x)}${8-p.y}`);
					score += (color === povColor ? -1 : 1) * (PIECE_VALUES[board[p.y][p.x].type] * 40);
				}
			}
		}

		// --- Overworked Defenders ---
		function countDefenses(board, x, y, color) {
			let count = 0;
			const castling = (typeof state !== 'undefined' && state.castling) ? state.castling : initialCastling();
			const enPassant = (typeof state !== 'undefined' && state.enPassant) ? state.enPassant : null;
			for (let yy = 0; yy < ROWS; yy++) {
				for (let xx = 0; xx < COLS; xx++) {
					const pc = board[yy][xx];
					if (!pc || pc.color !== color) continue;
					if (xx === x && yy === y) continue;
					const moves = genPseudoMovesForSquare(xx, yy, board, castling, enPassant);
					if (moves.some(mv => mv.to.x === x && mv.to.y === y)) count++;
				}
			}
			return count;
		}
		for (const color of [LIGHT, DARK]) {
			const enemy = color === LIGHT ? DARK : LIGHT;
			for (let y = 0; y < ROWS; y++) {
				for (let x = 0; x < COLS; x++) {
					const pc = board[y][x];
					if (!pc || pc.color !== color) continue;
					if (isAttacked(board, x, y, color)) {
						const defenseCount = countDefenses(board, x, y, color);
						if (defenseCount === 1) {
							// Is this defender also defending another attacked piece?
							for (let yy = 0; yy < ROWS; yy++) {
								for (let xx = 0; xx < COLS; xx++) {
									if ((xx !== x || yy !== y) && board[yy][xx] && board[yy][xx].color === color && isAttacked(board, xx, yy, color)) {
										const sharedDef = genPseudoMovesForSquare(xx, yy, board, state?.castling, state?.enPassant).some(mv => mv.to.x === x && mv.to.y === y);
										if (sharedDef) {
											if (color === povColor) tacticalMotifs.push(`Overworked defender at ${String.fromCharCode(97+x)}${8-y}`);
											score += (color === povColor ? -1 : 1) * 40;
										}
									}
								}
							}
						}
					}
				}
			}
		}

		const total = totalPieces(board);

	// --- Zwischenzug (In-between Move) ---
		// For each capture, check if a forcing move (check or threat) is available before recapture
		for (const color of [LIGHT, DARK]) {
			const enemy = color === LIGHT ? DARK : LIGHT;
			for (let y = 0; y < ROWS; y++) {
				for (let x = 0; x < COLS; x++) {
					const pc = board[y][x];
					if (!pc || pc.color !== color) continue;
					const moves = genPseudoMovesForSquare(x, y, board, state?.castling, state?.enPassant);
					for (const mv of moves) {
						const target = board[mv.to.y][mv.to.x];
						if (target && target.color === enemy) {
							// Simulate not recapturing, but playing a forcing move elsewhere
							for (let yy = 0; yy < ROWS; yy++) {
								for (let xx = 0; xx < COLS; xx++) {
									const alt = board[yy][xx];
									if (!alt || alt.color !== color || (xx === x && yy === y)) continue;
									const altMoves = genPseudoMovesForSquare(xx, yy, board, state?.castling, state?.enPassant);
									for (const amv of altMoves) {
										const sim = simulateMove(amv, board, state?.castling, state?.enPassant);
										const enemyKing = kingPos[enemy];
										if (enemyKing && isSquareAttacked(sim.board, enemyKing.x, enemyKing.y, color)) {
											if (color === povColor) tacticalMotifs.push(`Zwischenzug: ${alt.type} at ${String.fromCharCode(97+xx)}${8-yy} can check before recapture`);
											score += (color === povColor ? 1 : -1) * 25;
										}
									}
								}
							}
						}
					}
				}
			}
		}
// --- Endgame heuristics ---
		// 1. Insufficient material: K vs K, K+N vs K, K+B vs K, K+B vs K+B (same color)
		function isFortress() {
			// Wrong rook pawn fortress (K+P vs K, pawn is a/h file, king in corner)
			let pieceList = [];
			for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (pc) pieceList.push({ type: pc.type, color: pc.color, x, y });
			}
			if (pieceList.length === 3) {
				const pawn = pieceList.find(p => p.type === "P");
				if (pawn && (pawn.x === 0 || pawn.x === 7)) {
					const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawn.color);
					if (enemyKing && ((pawn.color === LIGHT && enemyKing.x === pawn.x && enemyKing.y === 0) || (pawn.color === DARK && enemyKing.x === pawn.x && enemyKing.y === 7))) {
						return true; // Fortress: draw
					}
				}
			}
			// K+B+N vs K fortress: king in wrong corner
			if (pieceList.length === 4) {
				const b = pieceList.find(p => p.type === "B");
				const n = pieceList.find(p => p.type === "N");
				const enemyKing = pieceList.find(p => p.type === "K" && p.color !== b?.color);
				if (b && n && enemyKing) {
					// Wrong corner: bishop can't force mate
					const lightSquare = (b.x + b.y) % 2 === 0;
					if ((enemyKing.x === 0 || enemyKing.x === 7) && (enemyKing.y === 0 || enemyKing.y === 7)) {
						const kingSquare = (enemyKing.x + enemyKing.y) % 2 === 0;
						if (kingSquare !== lightSquare) return true;
					}
				}
			}
			return false;
		}
		function insufficientMaterial() {
			const allPieces = [];
			for (let y = 0; y < ROWS; y++) {
				for (let x = 0; x < COLS; x++) {
					const pc = board[y][x];
					if (pc) allPieces.push(pc);
				}
			}
			// Only kings
			if (allPieces.length === 2) return true;
			// King and single minor vs king
			if (allPieces.length === 3) {
				const minors = allPieces.filter(p => p.type === "B" || p.type === "N");
				if (minors.length === 1) return true;
			}
			// King and bishop vs king and bishop (same color)
			if (allPieces.length === 4) {
				const bishops = allPieces.filter(p => p.type === "B");
				if (bishops.length === 2) {
					// Check if both bishops are on same color
					const sameColor = (x, y) => (x + y) % 2;
					const b1 = bishops[0], b2 = bishops[1];
					if (sameColor(b1.x, b1.y) === sameColor(b2.x, b2.y)) return true;
				}
			}
			return false;
		}
	
		// --- Endgame Tablebase Probe ---
		// If in a 3-4-5 piece endgame, probe tablebase for perfect score
		const tbScore = probeTablebase(board, povColor);
		if (tbScore !== null) {
			storeEvalHash(fullKey, tbScore);
			return tbScore;
		}
		// Fortress detection
		if (insufficientMaterial() || isFortress()) {
			storeEvalHash(fullKey, 0);
			return 0; // Draw
		}
// --- Minimal Endgame Tablebase Probe (stub, replace with real data/API for full strength) ---
function probeTablebase(board, povColor) {
	// Count pieces
	let pieceList = [];
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const pc = board[y][x];
			if (pc) pieceList.push({ type: pc.type, color: pc.color, x, y });
		}
	}
	// Only probe for 3-4-5 piece endings (KPK, KQK, KRK, KPKP, etc.)
	if (pieceList.length < 3 || pieceList.length > 5) return null;
	const types = pieceList.map(p => p.type).sort().join("");

	// Stalemate fortress: K+Q vs K+P, pawn blocks king in corner
	if (types === "KQKP") {
		const queen = pieceList.find(p => p.type === "Q");
		const pawn = pieceList.find(p => p.type === "P");
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== queen.color);
		if (pawn && enemyKing) {
			// Pawn on 7th, king in corner behind pawn
			if ((pawn.color === LIGHT && pawn.y === 1 && enemyKing.y === 0 && Math.abs(enemyKing.x - pawn.x) <= 1) ||
				(pawn.color === DARK && pawn.y === 6 && enemyKing.y === 7 && Math.abs(enemyKing.x - pawn.x) <= 1)) {
				return 0; // Draw by stalemate fortress
			}
		}
	}
	// Vancura defense: KRP vs KR, rook behind pawn, king blocks
	if (types === "KKPR") {
		const pawn = pieceList.find(p => p.type === "P");
		const rook = pieceList.find(p => p.type === "R" && p.color === pawn.color);
		const enemyRook = pieceList.find(p => p.type === "R" && p.color !== pawn.color);
		const myKing = pieceList.find(p => p.type === "K" && p.color === pawn.color);
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawn.color);
		if (pawn && rook && enemyRook && myKing && enemyKing) {
			// Rook behind pawn, king blocks pawn, enemy rook on rank
			if ((rook.y === pawn.y + (pawn.color === LIGHT ? 1 : -1)) && (myKing.x === pawn.x && ((pawn.color === LIGHT && myKing.y === pawn.y + 1) || (pawn.color === DARK && myKing.y === pawn.y - 1)))) {
				if ((enemyRook.y === pawn.y) && (enemyKing.x === pawn.x && ((pawn.color === LIGHT && enemyKing.y < pawn.y) || (pawn.color === DARK && enemyKing.y > pawn.y)))) {
					return 0; // Draw by Vancura defense
				}
			}
		}
	}
	// Second rank defense: KRP vs KR, defending rook on 2nd/7th, king blocks pawn
	if (types === "KKPR") {
		const pawn = pieceList.find(p => p.type === "P");
		const enemyRook = pieceList.find(p => p.type === "R" && p.color !== pawn.color);
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawn.color);
		if (pawn && enemyRook && enemyKing) {
			if ((pawn.color === LIGHT && enemyRook.y === 1 && enemyKing.y <= 1) || (pawn.color === DARK && enemyRook.y === 6 && enemyKing.y >= 6)) {
				return 0; // Draw by second rank defense
			}
		}
	}
	// Fortress: K+R vs K+P, pawn blockaded, king in front
	if (types === "KKPR") {
		const pawn = pieceList.find(p => p.type === "P");
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawn.color);
		if (pawn && enemyKing) {
			if ((pawn.color === LIGHT && enemyKing.y === pawn.y - 1 && enemyKing.x === pawn.x) || (pawn.color === DARK && enemyKing.y === pawn.y + 1 && enemyKing.x === pawn.x)) {
				return 0; // Draw by fortress
			}
		}
	}
	// KPK: King and Pawn vs King
	if (types === "KKP") {
		const pawn = pieceList.find(p => p.type === "P");
		const pawnColor = pawn.color;
		const promotionRank = pawnColor === LIGHT ? 0 : 7;
		if ((pawnColor === LIGHT && pawn.y === promotionRank) || (pawnColor === DARK && pawn.y === promotionRank)) {
			return pawnColor === povColor ? 1 : -1;
		}
		// If pawn is blockaded in front by king, it's a draw
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawnColor);
		if (enemyKing && ((pawnColor === LIGHT && enemyKing.y === pawn.y - 1 && enemyKing.x === pawn.x) || (pawnColor === DARK && enemyKing.y === pawn.y + 1 && enemyKing.x === pawn.x))) {
			return 0;
		}
		// Otherwise, assume draw for simplicity
		return 0;
	}
	// KQK: King and Queen vs King
	if (types === "KKQ") {
		// If lone king is on edge/corner and queen/king can mate, return win
		const queen = pieceList.find(p => p.type === "Q");
		const qColor = queen.color;
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== qColor);
		// If kings are adjacent, it's mate
		const myKing = pieceList.find(p => p.type === "K" && p.color === qColor);
		if (enemyKing && myKing && Math.abs(enemyKing.x - myKing.x) <= 1 && Math.abs(enemyKing.y - myKing.y) <= 1) {
			return qColor === povColor ? 1 : -1;
		}
		// If queen controls escape squares and king is on edge, assume win
		if (enemyKing && (enemyKing.x === 0 || enemyKing.x === 7 || enemyKing.y === 0 || enemyKing.y === 7)) {
			return qColor === povColor ? 1 : -1;
		}
		// Otherwise, assume win for side with queen
		return qColor === povColor ? 1 : -1;
	}
	// KRK: King and Rook vs King
	if (types === "KKR") {
		const rook = pieceList.find(p => p.type === "R");
		const rColor = rook.color;
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== rColor);
		const myKing = pieceList.find(p => p.type === "K" && p.color === rColor);
		// If kings are adjacent, it's mate
		if (enemyKing && myKing && Math.abs(enemyKing.x - myKing.x) <= 1 && Math.abs(enemyKing.y - myKing.y) <= 1) {
			return rColor === povColor ? 1 : -1;
		}
		// If enemy king is on edge, assume win
		if (enemyKing && (enemyKing.x === 0 || enemyKing.x === 7 || enemyKing.y === 0 || enemyKing.y === 7)) {
			return rColor === povColor ? 1 : -1;
		}
		// Otherwise, assume win for side with rook
		return rColor === povColor ? 1 : -1;
	}
	// KPKP: King and Pawn vs King and Pawn
	if (types === "KKPP") {
		// If either pawn is about to promote, that side wins
		const pawns = pieceList.filter(p => p.type === "P");
		for (const pawn of pawns) {
			const promotionRank = pawn.color === LIGHT ? 0 : 7;
			if ((pawn.color === LIGHT && pawn.y === promotionRank) || (pawn.color === DARK && pawn.y === promotionRank)) {
				return pawn.color === povColor ? 1 : -1;
			}
		}
		// Otherwise, assume draw for simplicity
		return 0;
	}
	// KBNK: King, Bishop, Knight vs King (always win for side with bishop+knight)
	if (types === "KBNK") {
		const bnkColor = pieceList.find(p => p.type === "B" || p.type === "N").color;
		return bnkColor === povColor ? 1 : -1;
	}
	// KBBK: King, two Bishops vs King (always win for side with bishops)
	if (types === "KBBK") {
		const bbColor = pieceList.find(p => p.type === "B").color;
		return bbColor === povColor ? 1 : -1;
	}
	// KNNK: King, two Knights vs King (draw, except for rare mate)
	if (types === "KNNK") {
		return 0; // Draw in almost all cases
	}
	// KRBK: King, Rook, Bishop vs King (win for side with rook+bishop)
	if (types === "KBRK" || types === "KRBK") {
		const rbColor = pieceList.find(p => p.type === "R" || p.type === "B").color;
		return rbColor === povColor ? 1 : -1;
	}
	// KQP: King, Queen vs Pawn (win for queen unless stalemate or underpromotion)
	if (types === "KQP") {
		const queen = pieceList.find(p => p.type === "Q");
		return queen.color === povColor ? 1 : -1;
	}
	// KRP: King, Rook vs Pawn (win for rook unless pawn is about to promote)
	if (types === "KPR") {
		const rook = pieceList.find(p => p.type === "R");
		const pawn = pieceList.find(p => p.type === "P");
		const promotionRank = pawn.color === LIGHT ? 0 : 7;
		if ((pawn.color === LIGHT && pawn.y === promotionRank) || (pawn.color === DARK && pawn.y === promotionRank)) {
			return pawn.color === povColor ? 1 : -1;
		}
		return rook.color === povColor ? 1 : -1;
	}
	// KQKP: King, Queen vs King, Pawn (win for queen unless pawn is about to promote)
	if (types === "KKPQ") {
		const queen = pieceList.find(p => p.type === "Q");
		const pawn = pieceList.find(p => p.type === "P");
		const promotionRank = pawn.color === LIGHT ? 0 : 7;
		if ((pawn.color === LIGHT && pawn.y === promotionRank) || (pawn.color === DARK && pawn.y === promotionRank)) {
			return pawn.color === povColor ? 1 : -1;
		}
		return queen.color === povColor ? 1 : -1;
	}
	// Lucena/Philidor: KRP vs KR
	if (types === "KKPR") {
		// Lucena: pawn on 7th, king in front, rook cuts off enemy king
		const pawn = pieceList.find(p => p.type === "P");
		const rook = pieceList.find(p => p.type === "R" && p.color === pawn.color);
		const enemyRook = pieceList.find(p => p.type === "R" && p.color !== pawn.color);
		const myKing = pieceList.find(p => p.type === "K" && p.color === pawn.color);
		const enemyKing = pieceList.find(p => p.type === "K" && p.color !== pawn.color);
		if (pawn && rook && enemyRook && myKing && enemyKing) {
			const promotionRank = pawn.color === LIGHT ? 0 : 7;
			if ((pawn.color === LIGHT && pawn.y === 1) || (pawn.color === DARK && pawn.y === 6)) {
				// Lucena: king in front of pawn, rook cuts off enemy king
				if ((pawn.color === LIGHT && myKing.y === 0 && myKing.x === pawn.x) || (pawn.color === DARK && myKing.y === 7 && myKing.x === pawn.x)) {
					if ((enemyKing.x < pawn.x - 1 || enemyKing.x > pawn.x + 1)) {
						return pawn.color === povColor ? 1 : -1;
					}
				}
			}
			// Philidor: defending rook on 6th/3rd, king blocks pawn
			if ((pawn.color === LIGHT && enemyRook.y === 2) || (pawn.color === DARK && enemyRook.y === 5)) {
				if ((pawn.color === LIGHT && enemyKing.y === 2) || (pawn.color === DARK && enemyKing.y === 5)) {
					return 0; // Draw
				}
			}
		}
	}
	// Underpromotion: K+P vs K+R, K+P vs K+N
	if (types === "KKPR" || types === "KKPN") {
		const pawn = pieceList.find(p => p.type === "P");
		const promotionRank = pawn.color === LIGHT ? 0 : 7;
		if ((pawn.color === LIGHT && pawn.y === promotionRank) || (pawn.color === DARK && pawn.y === promotionRank)) {
			// If underpromotion is only way to draw, return draw
			return 0;
		}
	}
	// Add more tablebase logic for other endings as needed
	return null; // Not a known tablebase position
}

		if (total <= ENDGAME_THRESHOLD) {
			const endgameScale = (ENDGAME_THRESHOLD + 2 - total) * 2;
			const centerDist = (k) => Math.abs(3.5 - k.x) + Math.abs(3.5 - k.y);
			// King activity: encourage centralization and proximity to enemy pawns
			function kingProximityToPawns(king, enemyPawns) {
				if (!king || enemyPawns.length === 0) return 0;
				let minDist = 8;
				for (const p of enemyPawns) {
					const dist = Math.abs(king.x - p.x) + Math.abs(king.y - p.y);
					if (dist < minDist) minDist = dist;
				}
				return 4 - minDist; // closer is better
			}
			if (kingPos[LIGHT]) {
				score += (4 - centerDist(kingPos[LIGHT])) * endgameScale * 1.2 * (povColor === LIGHT ? 1 : -1);
				score += kingProximityToPawns(kingPos[LIGHT], pawns[DARK]) * endgameScale * 0.8 * (povColor === LIGHT ? 1 : -1);
			}
			if (kingPos[DARK]) {
				score += (4 - centerDist(kingPos[DARK])) * endgameScale * 1.2 * (povColor === DARK ? 1 : -1);
				score += kingProximityToPawns(kingPos[DARK], pawns[LIGHT]) * endgameScale * 0.8 * (povColor === DARK ? 1 : -1);
			}

			// King opposition: bonus for being closer to enemy king
			if (kingPos[LIGHT] && kingPos[DARK]) {
				const dist = Math.abs(kingPos[LIGHT].x - kingPos[DARK].x) + Math.abs(kingPos[LIGHT].y - kingPos[DARK].y);
				score += (7 - dist) * 2 * (povColor === LIGHT ? 1 : -1);
			}

			// Pawn promotion: bonus for pawns on 6th/7th rank
			function pawnPromotionBonus(p, color) {
				if ((color === LIGHT && p.y <= 1) || (color === DARK && p.y >= 6)) return 40 * endgameScale;
				if ((color === LIGHT && p.y === 2) || (color === DARK && p.y === 5)) return 20 * endgameScale;
				return 0;
			}
			// Passed pawns: extra bonus in endgame
			function isConnectedPassedPawn(p, color, pawns) {
				const dir = color === LIGHT ? -1 : 1;
				for (let dx = -1; dx <= 1; dx += 2) {
					const nx = p.x + dx;
					if (nx < 0 || nx >= COLS) continue;
					if (pawns.some(other => other.x === nx && other.y === p.y)) return true;
				}
				return false;
			}
			for (const p of pawns[LIGHT]) {
				let bonus = (6 - p.y) * endgameScale * 1.5;
				if (isConnectedPassedPawn(p, LIGHT, pawns[LIGHT])) bonus += 18 * endgameScale;
				bonus += pawnPromotionBonus(p, LIGHT);
				score += bonus * (povColor === LIGHT ? 1 : -1);
			}
			for (const p of pawns[DARK]) {
				let bonus = p.y * endgameScale * 1.5;
				if (isConnectedPassedPawn(p, DARK, pawns[DARK])) bonus += 18 * endgameScale;
				bonus += pawnPromotionBonus(p, DARK);
				score -= bonus * (povColor === LIGHT ? 1 : -1);
			}

			// Penalize stalemated king (no legal moves)
			function isStalemated(king, color) {
				if (!king) return false;
				const moves = genPseudoMovesForSquare(king.x, king.y, board, state?.castling, state?.enPassant);
				return moves.length === 0;
			}
			if (isStalemated(kingPos[povColor], povColor)) score -= 50 * endgameScale;
			if (isStalemated(kingPos[povColor === LIGHT ? DARK : LIGHT], povColor === LIGHT ? DARK : LIGHT)) score += 50 * endgameScale;
		}

		if (!Number.isFinite(score)) return 0;
		const finalScore = score / 100;
		storeEvalHash(fullKey, finalScore);
		return finalScore;
	}

	function evaluatePawnStructure(board, pawns, pawnFiles) {
		const doubledPenalty = 16;
		const isolatedPenalty = 26;
		const backwardPenalty = 14;
		const passedBase = 22;
		const passedAdvance = 10;

		let white = 0;
		let black = 0;

		for (let file = 0; file < COLS; file++) {
			const cW = pawnFiles[LIGHT][file];
			const cB = pawnFiles[DARK][file];
			if (cW > 1) white -= (cW - 1) * doubledPenalty;
			if (cB > 1) black -= (cB - 1) * doubledPenalty;
		}

		const applyPawn = (color, list) => {
			const total = totalPieces(board);
			const endgameBoost = 1 + Math.max(0, (14 - total)) * 0.08; // bigger bonuses as pieces come off
			for (const p of list) {
				const iso = isIsolatedPawn(pawnFiles, color, p.x);
				if (iso) {
					if (color === LIGHT) white -= isolatedPenalty;
					else black -= isolatedPenalty;
				}
				if (isPassedPawn(board, p, color)) {
					const advance = color === LIGHT ? (6 - p.y) : (p.y - 1);
					const bonus = (passedBase + Math.max(0, advance) * passedAdvance) * endgameBoost;
					if (color === LIGHT) white += bonus; else black += bonus;
					continue;
				}
				if (isBackwardPawn(board, pawnFiles, p, color)) {
					if (color === LIGHT) white -= backwardPenalty; else black -= backwardPenalty;
				}
			}
		};

		applyPawn(LIGHT, pawns[LIGHT]);
		applyPawn(DARK, pawns[DARK]);

		return white - black;
	}

	function evaluateKingSafetyDetailed(board, kingPos, color, pawnFiles, rooks, queens, bishops, knights) {
		const enemy = color === LIGHT ? DARK : LIGHT;
		const forward = color === LIGHT ? -1 : 1;
		let penalty = 0;

		// Pawn shield in front of king
		let shield = 0;
		for (let dx = -1; dx <= 1; dx++) {
			const x = kingPos.x + dx;
			const y = kingPos.y + forward;
			if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
			const pc = board[y][x];
			if (pc && pc.type === "P" && pc.color === color) shield++;
		}
		penalty += (3 - shield) * 16; // increased penalty for missing shield

		// Open/semi-open files near king
		for (let dx = -1; dx <= 1; dx++) {
			const file = kingPos.x + dx;
			if (file < 0 || file >= COLS) continue;
			const open = isFileOpen(pawnFiles, color, file);
			const semi = isFileSemiOpen(pawnFiles, color, file);
			if (open) penalty += 28;
			else if (semi) penalty += 18;
		}

		// Enemy major pieces on open/semi-open files
		const majors = [...rooks[enemy], ...queens[enemy]];
		for (const m of majors) {
			if (Math.abs(m.x - kingPos.x) <= 1) {
				if (isFileOpen(pawnFiles, color, m.x) || isFileSemiOpen(pawnFiles, color, m.x)) {
					if (clearPathVertical(board, m.x, m.y, kingPos.y)) penalty += 28;
				}
			}
		}

		// Penalty for enemy pieces close to king
		for (const piece of [...rooks[enemy], ...queens[enemy], ...bishops[enemy], ...knights[enemy]]) {
			const dist = Math.abs(piece.x - kingPos.x) + Math.abs(piece.y - kingPos.y);
			if (dist <= 2) penalty += 10;
		}

		return -penalty;
	}

	function evaluateActivity(board, pawns, knights, bishops, rooks, queens, kingPos, mobilityWeight, knightCenterBonus, diagWeight) {
		const centerSquares = new Set([27, 28, 35, 36]);
		let white = 0;
		let black = 0;

		const mobilityForColor = (color) => {
			let moves = 0;
			for (const n of knights[color]) moves += mobilityKnight(board, n.x, n.y, color);
			for (const b of bishops[color]) moves += mobilitySlider(board, b.x, b.y, color, [[1,1],[1,-1],[-1,1],[-1,-1]]);
			for (const r of rooks[color]) moves += mobilitySlider(board, r.x, r.y, color, [[1,0],[-1,0],[0,1],[0,-1]]);
			for (const q of queens[color]) moves += mobilitySlider(board, q.x, q.y, color, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
			return moves;
		};

		const wMob = mobilityForColor(LIGHT);
		const bMob = mobilityForColor(DARK);
		white += wMob * mobilityWeight;
		black += bMob * mobilityWeight;

		for (const n of knights[LIGHT]) {
			const idx = n.y * 8 + n.x;
			if (centerSquares.has(idx)) white += knightCenterBonus + 6;
		}
		for (const n of knights[DARK]) {
			const idx = n.y * 8 + n.x;
			if (centerSquares.has(idx)) black += knightCenterBonus + 6;
		}

		// Bonus for rooks/queens on open/semi-open files
		for (const r of rooks[LIGHT]) {
			if (isFileOpen(pawns, LIGHT, r.x)) white += 10;
			else if (isFileSemiOpen(pawns, LIGHT, r.x)) white += 5;
		}
		for (const r of rooks[DARK]) {
			if (isFileOpen(pawns, DARK, r.x)) black += 10;
			else if (isFileSemiOpen(pawns, DARK, r.x)) black += 5;
		}
		for (const q of queens[LIGHT]) {
			if (isFileOpen(pawns, LIGHT, q.x)) white += 6;
			else if (isFileSemiOpen(pawns, LIGHT, q.x)) white += 3;
		}
		for (const q of queens[DARK]) {
			if (isFileOpen(pawns, DARK, q.x)) black += 6;
			else if (isFileSemiOpen(pawns, DARK, q.x)) black += 3;
		}

		const diagSpan = (color) => {
			let s = 0;
			for (const b of bishops[color]) {
				for (const [dx, dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
					let nx = b.x + dx, ny = b.y + dy;
					while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
						const pc = board[ny][nx];
						if (pc) { s += diagWeight; break; }
						s += diagWeight;
						nx += dx; ny += dy;
					}
				}
			}
			return s;
		};

		white += diagSpan(LIGHT);
		black += diagSpan(DARK);

		return white - black;
	}

	function evaluateKingTropism(board, knights, bishops, rooks, queens, kingPos, phase, maxPhase) {
		const TROPISM_BASE = 18;
		const applyPhase = phase / maxPhase; // stronger in middlegame
		const scoreSide = (color) => {
			const enemy = color === LIGHT ? DARK : LIGHT;
			const target = kingPos[enemy];
			if (!target) return 0;
			let s = 0;
			const add = (pieces, weight = 1) => {
				for (const p of pieces[color]) {
					const dist = Math.max(Math.abs(p.x - target.x), Math.abs(p.y - target.y));
					const bonus = TROPISM_BASE * weight / (1 + dist);
					s += bonus;
				}
			};
			add(knights, 1.0);
			add(bishops, 0.9);
			add(rooks, 0.8);
			add(queens, 1.1);
			return s * applyPhase;
		};
		return scoreSide(LIGHT) - scoreSide(DARK);
	}

	function evaluateRookOnSeventh(board, rooks, pawns, kingPos, phase, maxPhase) {
		const BASE = 16;
		const EXTRA_PAWN = 6;
		const phaseScale = 0.6 + 0.4 * (maxPhase - phase) / maxPhase; // a bit more in endgame
		const scoreSide = (color) => {
			const enemy = color === LIGHT ? DARK : LIGHT;
			const targetRank = color === LIGHT ? 1 : 6; // 0-based: rank7 for white is y=1
			let s = 0;
			for (const r of rooks[color]) {
				if (r.y !== targetRank) continue;
				let bonus = BASE;
				const enemyKing = kingPos[enemy];
				if (enemyKing && enemyKing.y === targetRank) bonus += 6;
				const enemyPawns = pawns[enemy];
				if (enemyPawns.some(p => p.y === targetRank)) bonus += EXTRA_PAWN;
				s += bonus;
			}
			return s * phaseScale;
		};
		return scoreSide(LIGHT) - scoreSide(DARK);
	}

	function isFileOpen(pawnFiles, color, file) {
		const enemy = color === LIGHT ? DARK : LIGHT;
		return pawnFiles[color][file] === 0 && pawnFiles[enemy][file] === 0;
	}

	function isFileSemiOpen(pawnFiles, color, file) {
		const enemy = color === LIGHT ? DARK : LIGHT;
		return pawnFiles[color][file] === 0 && pawnFiles[enemy][file] > 0;
	}

	function isIsolatedPawn(pawnFiles, color, file) {
		const left = file > 0 ? pawnFiles[color][file - 1] : 0;
		const right = file < COLS - 1 ? pawnFiles[color][file + 1] : 0;
		return left === 0 && right === 0;
	}

	function isPassedPawn(board, pawn, color) {
		const enemy = color === LIGHT ? DARK : LIGHT;
		const dir = color === LIGHT ? -1 : 1;
		for (let y = pawn.y + dir; y >= 0 && y < ROWS; y += dir) {
			for (let dx = -1; dx <= 1; dx++) {
				const x = pawn.x + dx;
				if (x < 0 || x >= COLS) continue;
				const pc = board[y][x];
				if (pc && pc.color === enemy && pc.type === "P") return false;
			}
		}
		return true;
	}

	function isBackwardPawn(board, pawnFiles, pawn, color) {
		const dir = color === LIGHT ? -1 : 1;
		const aheadY = pawn.y + dir;
		if (aheadY < 0 || aheadY >= ROWS) return false;
		const file = pawn.x;
		if (pawnFiles[color][file] > 1) return false;
		const supportLeft = file > 0 ? hasFriendlyPawnAhead(board, color, file - 1, pawn.y, dir) : false;
		const supportRight = file < COLS - 1 ? hasFriendlyPawnAhead(board, color, file + 1, pawn.y, dir) : false;
		if (supportLeft || supportRight) return false;
		const aheadPiece = board[aheadY][file];
		if (aheadPiece) return false;
		return true;
	}

	function hasFriendlyPawnAhead(board, color, file, y, dir) {
		for (let ny = y + dir; ny >= 0 && ny < ROWS; ny += dir) {
			const pc = board[ny][file];
			if (pc && pc.type === "P" && pc.color === color) return true;
		}
		return false;
	}

	function clearPathVertical(board, file, y1, y2) {
		const step = y2 > y1 ? 1 : -1;
		for (let y = y1 + step; y !== y2; y += step) {
			if (y < 0 || y >= board.length || file < 0 || file >= board[0].length) return false;
			if (board[y][file]) return false;
		}
		return true;
	}

	function mobilityKnight(board, x, y, color) {
		let n = 0;
		const jumps = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
		for (const [dx, dy] of jumps) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
			const pc = board[ny][nx];
			if (!pc || pc.color !== color) n++;
		}
		return n;
	}

	function mobilitySlider(board, x, y, color, dirs) {
		let n = 0;
		for (const [dx, dy] of dirs) {
			let nx = x + dx, ny = y + dy;
			while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
				const pc = board[ny][nx];
				if (pc) {
					if (pc.color !== color) n++;
					break;
				}
				n++;
				nx += dx; ny += dy;
			}
		}
		return n;
	}
function evaluateDevelopment(board, knights, bishops, rooks, queens, kingPos, povColor) {
    let s = 0;

    const devSquaresWhite = new Set(["c3","d2","e2","f3","c4","d3","e3","f4"]);
    const devSquaresBlack = new Set(["c6","d7","e7","f6","c5","d6","e6","f5"]);
    const toSq = (x,y) => String.fromCharCode(97+x) + (8-y);

    for (const n of knights[LIGHT]) if (devSquaresWhite.has(toSq(n.x,n.y))) s += 12;
    for (const n of knights[DARK]) if (devSquaresBlack.has(toSq(n.x,n.y))) s -= 12;

    for (const b of bishops[LIGHT]) if (b.y < 7) s += 10;
    for (const b of bishops[DARK]) if (b.y > 0) s -= 10;

    for (const n of knights[LIGHT]) if (n.y === 7) s -= 8;
    for (const n of knights[DARK]) if (n.y === 0) s += 8;

    if (kingPos[LIGHT] && kingPos[LIGHT].y === 7 && (kingPos[LIGHT].x === 6 || kingPos[LIGHT].x === 2)) s += 20;
    if (kingPos[DARK] && kingPos[DARK].y === 0 && (kingPos[DARK].x === 6 || kingPos[DARK].x === 2)) s -= 20;

    return (povColor === LIGHT ? s : -s);
}

function evaluateCenterControl(board, povColor) {
    const center = [
        [3,3],[4,3],[3,4],[4,4],
        [2,3],[5,3],[2,4],[5,4],
    ];

    let s = 0;

    for (const [x,y] of center) {
        const pc = board[y][x];
        if (!pc) continue;
        if (pc.color === LIGHT) s += 6;
        else s -= 6;
    }

    return (povColor === LIGHT ? s : -s);
}
function evaluateMobility(board, povColor) {
    let score = 0;

    // Mobility weights (tuned for your engine)
    const MOB = {
        P: 0,
        N: 4,
        B: 5,
        R: 2,
        Q: 1,
        K: 0
    };

    const castling = (typeof state !== 'undefined' && state.castling) ? state.castling : initialCastling();
    const enPassant = (typeof state !== 'undefined' && state.enPassant) ? state.enPassant : null;

    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const pc = board[y][x];
            if (!pc) continue;

            const moves = genPseudoMovesForSquare(x, y, board, castling, enPassant);
            const mob = moves.length * MOB[pc.type];

            if (pc.color === povColor) score += mob;
            else score -= mob;
        }
    }

    return score;
}

function evaluateKingSafetyPhase(phase) {
	// Returns a scale factor (unitless) applied to king-safety penalties.
	// Goal: king safety is middlegame-heavy, endgame-light.
	const mg = Math.max(0, Math.min(1, phase / 20));
	return 0.15 + 0.85 * mg; // 0.15 in pure endgames, up to 1.0 in middlegame
}
function evaluateRookActivity(board, rooks, pawns, povColor) {
    let score = 0;

    // Track pawn files for open/semi-open detection
    const pawnFilesWhite = new Set();
    const pawnFilesBlack = new Set();

    for (const p of pawns[LIGHT]) pawnFilesWhite.add(p.x);
    for (const p of pawns[DARK]) pawnFilesBlack.add(p.x);

    function rookScore(rook, color) {
        let s = 0;
        const file = rook.x;
		const rank = rook.y;

        const friendlyPawns = color === LIGHT ? pawnFilesWhite : pawnFilesBlack;
        const enemyPawns = color === LIGHT ? pawnFilesBlack : pawnFilesWhite;

        // Semi-open file: no friendly pawns
        if (!friendlyPawns.has(file)) s += 12;

        // Open file: no pawns at all
        if (!friendlyPawns.has(file) && !enemyPawns.has(file)) s += 18;

        return s;
    }

    for (const r of rooks[LIGHT]) score += rookScore(r, LIGHT);
    for (const r of rooks[DARK]) score -= rookScore(r, DARK);

    return (povColor === LIGHT ? score : -score);
}

