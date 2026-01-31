// ============================================================================
// FEN Serialization & Deserialization
// ============================================================================
const COLS = 8;
const ROWS = 8;
const dpr = window.devicePixelRatio || 1;
const LIGHT = 1;
const DARK = 2;

const PIECE_VALUES = { K: 100, Q: 9, R: 5, B: 3, N: 3, P: 1 };

const GLYPHS = {
    K: { [LIGHT]: "♔", [DARK]: "♚" },
    Q: { [LIGHT]: "♕", [DARK]: "♛" },
    R: { [LIGHT]: "♖", [DARK]: "♜" },
    B: { [LIGHT]: "♗", [DARK]: "♝" },
    N: { [LIGHT]: "♘", [DARK]: "♞" },
    P: { [LIGHT]: "♙", [DARK]: "♟" }
};

const PIECE_IDX = { P: 0, N: 1, B: 2, R: 3, Q: 4, K: 5 };






function boardToFEN() {
	let fen = "";
	
	// 1. Piece placement
	for (let y = 0; y < ROWS; y++) {
		let empty = 0;
		for (let x = 0; x < COLS; x++) {
			const pc = state.board[y][x];
			if (!pc) {
				empty++;
			} else {
				if (empty > 0) {
					fen += empty;
					empty = 0;
				}
				const letter = pc.type;
				if (typeof letter === 'string' && letter.length > 0) {
					fen += pc.color === LIGHT ? letter : letter.toLowerCase();
				} else {
					fen += '?'; // fallback for undefined or invalid piece type
				}
			}
		}
		if (empty > 0) fen += empty;
		if (y < ROWS - 1) fen += "/";
	}
	
	// 2. Active color
	fen += " " + (state.turn === LIGHT ? "w" : "b");
	
	// 3. Castling availability
	let castling = "";
	if (state.castling[LIGHT].kingside) castling += "K";
	if (state.castling[LIGHT].queenside) castling += "Q";
	if (state.castling[DARK].kingside) castling += "k";
	if (state.castling[DARK].queenside) castling += "q";
	fen += " " + (castling || "-");
	
	// 4. En passant target square
	if (state.enPassant) {
		const file = String.fromCharCode(97 + state.enPassant.x);
		const rank = ROWS - state.enPassant.y;
		fen += " " + file + rank;
	} else {
		fen += " -";
	}
	
	// 5. Halfmove clock
	fen += " " + state.halfmove;
	
	// 6. Fullmove number
	fen += " " + state.fullmove;
	
	return fen;
}

function fenToBoard(fen) {
	const parts = fen.split(" ");
	const board = createEmptyBoard();
	
	// 1. Parse piece placement
	const rows = parts[0].split("/");
	for (let y = 0; y < rows.length && y < ROWS; y++) {
		let x = 0;
		for (const char of rows[y]) {
			if (char >= '1' && char <= '8') {
				x += parseInt(char, 10);
			} else {
				const isLight = char === char.toUpperCase();
				const type = char.toUpperCase();
				board[y][x] = { type, color: isLight ? LIGHT : DARK };
				x++;
			}
		}
	}
	
	// 2. Active color
	const turn = parts[1] === "w" ? LIGHT : DARK;
	
	// 3. Castling
	const castlingStr = parts[2] || "-";
	const castling = {
		[LIGHT]: {
			kingside: castlingStr.includes("K"),
			queenside: castlingStr.includes("Q")
		},
		[DARK]: {
			kingside: castlingStr.includes("k"),
			queenside: castlingStr.includes("q")
		}
	};
	
	// 4. En passant
	let enPassant = null;
	const epStr = parts[3] || "-";
	if (epStr !== "-") {
		const file = epStr.charCodeAt(0) - 97;
		const rank = parseInt(epStr[1], 10);
		enPassant = { x: file, y: ROWS - rank };
	}
	
	// 5. Halfmove clock
	const halfmove = parseInt(parts[4] || "0", 10);
	
	// 6. Fullmove number
	const fullmove = parseInt(parts[5] || "1", 10);
	
	return { board, turn, castling, enPassant, halfmove, fullmove };
}

function restoreFromFEN(fen) {
	const restored = fenToBoard(fen);
	state.board = restored.board;
	state.turn = restored.turn;
	state.castling = restored.castling;
	state.enPassant = restored.enPassant;
	state.halfmove = restored.halfmove;
	state.fullmove = restored.fullmove;
	
	// Recalculate captures from board state
	state.captures = { [LIGHT]: 0, [DARK]: 0 };
	const startMaterial = { P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1 };
	const currentMaterial = { [LIGHT]: {}, [DARK]: {} };
	
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const pc = state.board[y][x];
			if (pc) {
				currentMaterial[pc.color][pc.type] = (currentMaterial[pc.color][pc.type] || 0) + 1;
			}
		}
	}
	
	for (const type of Object.keys(startMaterial)) {
		if (type === "K") continue;
		const lightLost = startMaterial[type] - (currentMaterial[LIGHT][type] || 0);
		const darkLost = startMaterial[type] - (currentMaterial[DARK][type] || 0);
		state.captures[DARK] += lightLost * (PIECE_VALUES[type] || 1);
		state.captures[LIGHT] += darkLost * (PIECE_VALUES[type] || 1);
	}
	
	// Update lastMove from moveHistory
	const historyLen = state.moveHistory.length;
	state.lastMove = historyLen > 0 ? state.moveHistory[historyLen - 1] : null;
	
	// Check game over state
	const legal = generateLegalMoves(state.turn);
	if (!legal.length) {
		state.gameOver = true;
		const inChk = inCheck(state.turn, state.board);
		if (inChk) {
			state.winner = state.turn === LIGHT ? "Black" : "White";
			state.message = "Checkmate";
		} else {
			state.winner = "Draw";
			state.message = "Stalemate";
		}
	} else {
		state.gameOver = false;
		state.winner = null;
		const inChk = inCheck(state.turn, state.board);
		state.message = inChk ? "Check" : "";
	}
}


	function createEmptyBoard() {
		return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
	}

	function initZobrist() {
		const rand64 = () => BigInt.asUintN(64, BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) ^ (BigInt(Date.now()) << 21n));
		const pieces = [
			Array.from({ length: 6 }, () => Array.from({ length: 64 }, rand64)),
			Array.from({ length: 6 }, () => Array.from({ length: 64 }, rand64))
		];
		const castling = Array.from({ length: 4 }, rand64); // WK, WQ, BK, BQ
		const ep = Array.from({ length: 8 }, rand64);
		const side = rand64();
		return { pieces, castling, ep, side };
	}

	function p(type, color) { return { type: type.toUpperCase(), color }; }

	function initialCastling() {
		return {
			[LIGHT]: { kingside: true, queenside: true },
			[DARK]: { kingside: true, queenside: true }
		};
	}



	function onBoard(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

	function cloneBoard(board) {
		return board.map(row => row.map(pc => pc ? { ...pc } : null));
	}

	function cloneCastling(c) {
		return {
			[LIGHT]: { ...c[LIGHT] },
			[DARK]: { ...c[DARK] }
		};
	}

	function cloneCtx(board, castling, enPassant) {
		return {
			board: cloneBoard(board),
			castling: cloneCastling(castling),
			enPassant: enPassant ? { ...enPassant } : null
		};
	}

