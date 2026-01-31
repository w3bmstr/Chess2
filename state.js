const layout = { width: 0, height: 0, cell: 0, offsetX: 0, offsetY: 0 };

const state = {
    board: createEmptyBoard(),
    turn: LIGHT,
    moveHistory: [],
    lastMove: null,
    captures: { [LIGHT]: 0, [DARK]: 0 },
    gameOver: false,
    winner: null,
    message: "",
    cursor: { x: 4, y: 7 },
    selected: null,
    legal: [],
    aiEnabled: true,
    aiColor: DARK,
    aiLevel: 5,
    thinking: false,
    menuActive: true,
    castling: initialCastling(),
    enPassant: null,
    halfmove: 0,
    fullmove: 1
};


state.redoStack = [];
state.positionHistory = [];

// ============================================================================
// Move Navigation Functions
// ============================================================================

function undoMove() {
	if (state.moveHistory.length === 0) return;
	if (state.thinking) return;
	
	const undoneMove = state.moveHistory.pop();
	state.redoStack.push(undoneMove);
	state.positionHistory.pop();
	
	// Restore position
	if (state.positionHistory.length > 0) {
		const prevFEN = state.positionHistory[state.positionHistory.length - 1];
		restoreFromFEN(prevFEN);
	} else {
		// Return to starting position
		resetToInitialPosition();
	}
	
	state.selected = null;
	state.legal = [];
	clearHint();
	clearTrainingNotes();
	updateHud();
	render();
}

function redoMove() {
	if (state.redoStack.length === 0) return;
	if (state.thinking) return;
	
	const redoneMove = state.redoStack.pop();
	
	// Re-execute the move
	const nextSim = simulateMove(redoneMove, state.board, state.castling, state.enPassant);
	
	// Apply the move
	state.board = nextSim.board;
	state.castling = nextSim.castling;
	state.enPassant = nextSim.enPassant;
	state.turn = redoneMove.piece.color === LIGHT ? DARK : LIGHT;
	
	// Restore halfmove and fullmove from the move record
	if (redoneMove.piece.type === "P" || redoneMove.captured) {
		state.halfmove = 0;
	} else {
		state.halfmove++;
	}
	
	if (redoneMove.piece.color === DARK) {
		state.fullmove++;
	}
	
	// Restore captures
	if (redoneMove.captured) {
		state.captures[redoneMove.piece.color] += PIECE_VALUES[redoneMove.captured.type] || 1;
	}
	
	state.moveHistory.push(redoneMove);
	state.lastMove = redoneMove;
	
	// Save FEN
	const currentFEN = boardToFEN();
	state.positionHistory.push(currentFEN);
	
	// Check game state
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
	
	state.selected = null;
	state.legal = [];
	clearHint();
	clearTrainingNotes();
	updateHud();
	render();
}

function undoToStart() {
	if (state.thinking) return;
	
	while (state.moveHistory.length > 0) {
		const undoneMove = state.moveHistory.pop();
		state.redoStack.push(undoneMove);
	}
	
	state.positionHistory = [];
	resetToInitialPosition();
	
	state.selected = null;
	state.legal = [];
	clearHint();
	clearTrainingNotes();
	updateHud();
	render();
}

function redoToEnd() {
	if (state.thinking) return;
	
	while (state.redoStack.length > 0) {
		redoMove();
	}
}

function goToMove(index) {
	if (state.thinking) return;
	if (index < 0) return;
	
	const currentIndex = state.moveHistory.length - 1;
	
	if (index === currentIndex) {
		// Already at this position
		return;
	}
	
	if (index < currentIndex) {
		// Go backward
		while (state.moveHistory.length > index + 1) {
			const undoneMove = state.moveHistory.pop();
			state.redoStack.push(undoneMove);
			state.positionHistory.pop();
		}
		
		if (index === -1) {
			// Go to start position
			resetToInitialPosition();
		} else if (state.positionHistory.length > 0) {
			const targetFEN = state.positionHistory[state.positionHistory.length - 1];
			restoreFromFEN(targetFEN);
		}
	} else {
		// Go forward
		while (state.moveHistory.length <= index && state.redoStack.length > 0) {
			redoMove();
		}
	}
	
	state.selected = null;
	state.legal = [];
	clearHint();
	clearTrainingNotes();
	updateHud();
	render();
}

function resetToInitialPosition() {
	const b = createEmptyBoard();
	b[0] = [p("R", DARK), p("N", DARK), p("B", DARK), p("Q", DARK), p("K", DARK), p("B", DARK), p("N", DARK), p("R", DARK)];
	b[1] = Array(COLS).fill(null).map(() => p("P", DARK));
	b[ROWS - 2] = Array(COLS).fill(null).map(() => p("P", LIGHT));
	b[ROWS - 1] = [p("R", LIGHT), p("N", LIGHT), p("B", LIGHT), p("Q", LIGHT), p("K", LIGHT), p("B", LIGHT), p("N", LIGHT), p("R", LIGHT)];
	
	state.board = b;
	state.turn = LIGHT;
	state.moveHistory = [];
	state.lastMove = null;
	state.captures = { [LIGHT]: 0, [DARK]: 0 };
	state.gameOver = false;
	state.winner = null;
	state.message = "";
	state.castling = initialCastling();
	state.enPassant = null;
	state.halfmove = 0;
	state.fullmove = 1;
	
	// Save initial FEN
	const initialFEN = boardToFEN();
	state.positionHistory = [initialFEN];
}

function restoreFromFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const boardPart    = parts[0];
    const turnPart     = parts[1] || "w";
    const castlingPart = parts[2] || "-";
    const epPart       = parts[3] || "-";
    const halfmovePart = parts[4] || "0";
    const fullmovePart = parts[5] || "1";

    // 1) Rebuild board from FEN
    const rows = boardPart.split("/");
    const b = createEmptyBoard();

    for (let rank = 0; rank < ROWS; rank++) {
        const row = rows[rank];
        let file = 0;
        for (const ch of row) {
            if (ch >= "1" && ch <= "8") {
                file += parseInt(ch, 10);
            } else {
                const isWhite = ch === ch.toUpperCase();
                const type = ch.toUpperCase();
                b[rank][file] = p(type, isWhite ? LIGHT : DARK);
                file++;
            }
        }
    }

    state.board = b;

    // 2) Side to move
    state.turn = (turnPart === "w") ? LIGHT : DARK;

    // 3) Castling rights
    state.castling = {
        [LIGHT]: { kingside: false, queenside: false },
        [DARK]:  { kingside: false, queenside: false }
    };

    if (castlingPart.includes("K")) state.castling[LIGHT].kingside = true;
    if (castlingPart.includes("Q")) state.castling[LIGHT].queenside = true;
    if (castlingPart.includes("k")) state.castling[DARK].kingside = true;
    if (castlingPart.includes("q")) state.castling[DARK].queenside = true;

    // 4) En passant
    if (epPart !== "-" && epPart.length === 2) {
        const file = epPart.charCodeAt(0) - 97;
        const rank = ROWS - parseInt(epPart[1], 10);
        state.enPassant = { x: file, y: rank };
    } else {
        state.enPassant = null;
    }

    // 5) Halfmove / fullmove
    state.halfmove = parseInt(halfmovePart, 10) || 0;
    state.fullmove = parseInt(fullmovePart, 10) || 1;

    // 6) Reset other state that depends on history
    state.selected = null;
    state.legal = [];
    state.gameOver = false;
    state.winner = null;
    state.message = "";
    state.lastMove = null;
    state.captures = { [LIGHT]: 0, [DARK]: 0 }; // you can recompute if you want
}


function makeMoveAndRecord(move) {
	if (state.gameOver) return false;
	
	clearHint();
	
	// Clear redo stack when making a new move (branching)
	state.redoStack = [];
	
	const prevBoard = cloneBoard(state.board);
	const pieceBefore = { ...state.board[move.from.y][move.from.x] };
	const moverColor = pieceBefore.color;
	const opponent = moverColor === LIGHT ? DARK : LIGHT;
	const prevCastling = cloneCastling(state.castling);
	const prevEnPassant = state.enPassant ? { ...state.enPassant } : null;
	const prevHalfmove = state.halfmove;
	const prevFullmove = state.fullmove;
	
	state.enPassant = null;
	
	let capturedPiece = null;
	state.board[move.from.y][move.from.x] = null;
	
	if (move.castle) {
		state.board[move.to.y][move.to.x] = { ...pieceBefore };
		state.board[move.rookTo.y][move.rookTo.x] = state.board[move.rookFrom.y][move.rookFrom.x];
		state.board[move.rookFrom.y][move.rookFrom.x] = null;
	} else {
		if (move.enPassant) {
			capturedPiece = state.board[move.capturePos.y][move.capturePos.x];
			state.board[move.capturePos.y][move.capturePos.x] = null;
		}
		capturedPiece = capturedPiece || state.board[move.to.y][move.to.x];
		state.board[move.to.y][move.to.x] = { ...pieceBefore };
		if (move.promo) state.board[move.to.y][move.to.x].type = move.promo;
		state.enPassant = move.doubleStep ? { x: move.to.x, y: move.from.y + (moverColor === LIGHT ? -1 : 1) } : null;
	}
	
	if (!move.castle && !move.doubleStep && !move.enPassant) state.enPassant = null;
	
	if (state.castling && state.castling[moverColor]) {
		if (typeof state.castling[moverColor].kingside !== "undefined") {
			state.castling[moverColor].kingside = state.castling[moverColor].kingside && pieceBefore.type !== "K";
		}
		if (typeof state.castling[moverColor].queenside !== "undefined") {
			state.castling[moverColor].queenside = state.castling[moverColor].queenside && pieceBefore.type !== "K";
		}
	}
	
	if (pieceBefore.type === "R") disableRookRights(moverColor, move.from.x, move.from.y, state.castling);
	if (capturedPiece && capturedPiece.type === "R") {
		disableRookRights(capturedPiece.color, move.enPassant ? move.capturePos.x : move.to.x, move.enPassant ? move.capturePos.y : move.to.y, state.castling);
	}
	
	state.halfmove = (pieceBefore.type === "P" || capturedPiece) ? 0 : state.halfmove + 1;
	if (moverColor === DARK) state.fullmove += 1;
	
	if (capturedPiece) state.captures[moverColor] += PIECE_VALUES[capturedPiece.type] || 1;
	
	const moverStillInCheck = inCheck(moverColor, state.board);
	if (moverStillInCheck) {
		// Illegal move - restore state
		state.board = prevBoard;
		state.castling = prevCastling;
		state.enPassant = prevEnPassant;
		state.halfmove = prevHalfmove;
		state.fullmove = prevFullmove;
		state.message = "Illegal move: king in check";
		updateHud();
		render();
		return false;
	}
	
	const oppInCheck = inCheck(opponent, state.board);
	const oppMoves = generateLegalMoves(opponent);
	
	let resultMessage = "";
	let winner = null;
	if (!oppMoves.length) {
		state.gameOver = true;
		if (oppInCheck) {
			winner = moverColor === LIGHT ? "White" : "Black";
			resultMessage = "Checkmate";
		} else {
			winner = "Draw";
			resultMessage = "Stalemate";
		}
	} else {
		state.gameOver = false;
		resultMessage = oppInCheck ? "Check" : "";
	}
	
	const record = {
		...move,
		piece: pieceBefore,
		captured: capturedPiece ? { ...capturedPiece } : null,
		promoted: !!move.promo,
		prevCastling,
		prevEnPassant,
		prevHalfmove,
		prevFullmove,
		check: oppInCheck,
		mate: state.gameOver && oppInCheck,
		message: resultMessage
	};
	
	state.moveHistory.push(record);
	state.lastMove = record;
	state.turn = opponent;
	state.winner = winner;
	state.message = resultMessage;
	
	// Save FEN for this position
	const currentFEN = boardToFEN();
	state.positionHistory.push(currentFEN);
	
	// Training notes for human moves
	if (!state.aiEnabled || moverColor !== state.aiColor) {
		const evalBefore = evaluateBoard(prevBoard, moverColor);
		const evalAfter = evaluateBoard(state.board, moverColor);
		const note = detectBlunder(evalBefore, evalAfter, record) || explainMove(record, evalBefore, evalAfter);
		updateTrainingNotes(note);
	}
	
	updateHud();
	render();
	
	if (!state.gameOver) maybeRunAI();
	
	return true;
}

if (!state.positionHistory || state.positionHistory.length === 0) {
    const currentFEN = boardToFEN();
    state.positionHistory = [currentFEN];
}

	function resetBoard() {
		clearTrainingNotes();
		const b = createEmptyBoard();
		b[0] = [p("R", DARK), p("N", DARK), p("B", DARK), p("Q", DARK), p("K", DARK), p("B", DARK), p("N", DARK), p("R", DARK)];
		b[1] = Array(COLS).fill(p("P", DARK)); // Fill the second row with dark pawns
		b[ROWS - 2] = Array(COLS).fill(p("P", LIGHT));
		b[ROWS - 1] = [p("R", LIGHT), p("N", LIGHT), p("B", LIGHT), p("Q", LIGHT), p("K", LIGHT), p("B", LIGHT), p("N", LIGHT), p("R", LIGHT)];

		state.board = b;
		state.turn = LIGHT;
		state.moveHistory = [];
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
		updateHud();
		clearHint();
	}

	function makeMove(move) {
		if (state.gameOver) return;
		clearHint();
		const prevBoard = cloneBoard(state.board);
		const prevCaptures = { ...state.captures };
		const prevWinner = state.winner;
		const prevMessage = state.message;
		const pieceBefore = { ...state.board[move.from.y][move.from.x] };
		const moverColor = pieceBefore.color;
		const opponent = moverColor === LIGHT ? DARK : LIGHT;
		const prevCastling = cloneCastling(state.castling);
		const prevEnPassant = state.enPassant ? { ...state.enPassant } : null;
		const prevHalfmove = state.halfmove;
		const prevFullmove = state.fullmove;

		state.enPassant = null;

		let capturedPiece = null;
		state.board[move.from.y][move.from.x] = null;
		if (move.castle) {
			state.board[move.to.y][move.to.x] = { ...pieceBefore };
			state.board[move.rookTo.y][move.rookTo.x] = state.board[move.rookFrom.y][move.rookFrom.x];
			state.board[move.rookFrom.y][move.rookFrom.x] = null;
		} else {
			if (move.enPassant) {
				capturedPiece = state.board[move.capturePos.y][move.capturePos.x];
				state.board[move.capturePos.y][move.capturePos.x] = null;
			}
			capturedPiece = capturedPiece || state.board[move.to.y][move.to.x];
			state.board[move.to.y][move.to.x] = { ...pieceBefore };
			if (move.promo) state.board[move.to.y][move.to.x].type = move.promo;
			state.enPassant = move.doubleStep ? { x: move.to.x, y: move.from.y + (moverColor === LIGHT ? -1 : 1) } : null;
		}

		if (!move.castle && !move.doubleStep && !move.enPassant) state.enPassant = null;

		if (state.castling && state.castling[moverColor]) {
			if (typeof state.castling[moverColor].kingside !== "undefined") {
				state.castling[moverColor].kingside = state.castling[moverColor].kingside && pieceBefore.type !== "K";
			}
			if (typeof state.castling[moverColor].queenside !== "undefined") {
				state.castling[moverColor].queenside = state.castling[moverColor].queenside && pieceBefore.type !== "K";
			}
		}
		if (pieceBefore.type === "R") disableRookRights(moverColor, move.from.x, move.from.y, state.castling);
		if (capturedPiece && capturedPiece.type === "R") disableRookRights(capturedPiece.color, move.enPassant ? move.capturePos.x : move.to.x, move.enPassant ? move.capturePos.y : move.to.y, state.castling);

		state.halfmove = (pieceBefore.type === "P" || capturedPiece) ? 0 : state.halfmove + 1;
		if (moverColor === DARK) state.fullmove += 1;

		if (capturedPiece) state.captures[moverColor] += PIECE_VALUES[capturedPiece.type] || 1;

		const moverStillInCheck = inCheck(moverColor, state.board);
		if (moverStillInCheck) {
			state.board = prevBoard;
			state.castling = prevCastling;
			state.enPassant = prevEnPassant;
			state.halfmove = prevHalfmove;
			state.fullmove = prevFullmove;
			state.captures = prevCaptures;
			state.winner = prevWinner;
			state.message = "Illegal move: king in check";
			state.gameOver = false;
			render();
			updateHud();
			return;
		}

		const oppInCheck = inCheck(opponent, state.board);
		const oppMoves = generateLegalMoves(opponent);

		let resultMessage = "";
		let winner = null;
		if (!oppMoves.length) {
			state.gameOver = true;
			if (oppInCheck) {
				winner = moverColor === LIGHT ? "White" : "Black";
				resultMessage = "Checkmate";
			} else {
				winner = "Draw";
				resultMessage = "Stalemate";
			}
		} else {
			state.gameOver = false;
			resultMessage = oppInCheck ? "Check" : "";
		}

		const record = {
			...move,
			piece: pieceBefore,
			captured: capturedPiece ? { ...capturedPiece } : null,
			promoted: !!move.promo,
			prevCastling,
			prevEnPassant,
			prevHalfmove,
			prevFullmove,
			check: oppInCheck,
			mate: state.gameOver && oppInCheck,
			message: resultMessage
		};

		state.moveHistory.push(record);
		state.lastMove = record;
		state.turn = opponent;
		state.winner = winner;
		state.message = resultMessage;

		// Match ModernChess: evaluate from the mover's POV on the pre/post boards and only annotate human moves.
		if (!state.aiEnabled || moverColor !== state.aiColor) {
			const evalBefore = evaluateBoard(prevBoard, moverColor);
			const evalAfter = evaluateBoard(state.board, moverColor);
			const note = detectBlunder(evalBefore, evalAfter, record) || explainMove(record, evalBefore, evalAfter);
			updateTrainingNotes(note);
		}

		updateHud();
		render();
		if (!state.gameOver) maybeRunAI();
	}

	function undo() {
		const mv = state.moveHistory.pop();
		if (!mv) return;

		state.castling = cloneCastling(mv.prevCastling);
		state.enPassant = mv.prevEnPassant ? { ...mv.prevEnPassant } : null;
		state.halfmove = mv.prevHalfmove;
		state.fullmove = mv.prevFullmove;
		state.gameOver = false;
		state.winner = null;
		state.message = "";

		if (mv.castle) {
			state.board[mv.from.y][mv.from.x] = { ...mv.piece };
			state.board[mv.to.y][mv.to.x] = null;
			state.board[mv.rookFrom.y][mv.rookFrom.x] = state.board[mv.rookTo.y][mv.rookTo.x];
			state.board[mv.rookTo.y][mv.rookTo.x] = null;
		} else {
			state.board[mv.from.y][mv.from.x] = { ...mv.piece };
			state.board[mv.to.y][mv.to.x] = mv.enPassant ? null : (mv.captured ? { ...mv.captured } : null);
			if (mv.enPassant && mv.capturePos) state.board[mv.capturePos.y][mv.capturePos.x] = { ...mv.captured };
			if (mv.promoted) state.board[mv.from.y][mv.from.x].type = "P";
		}

		if (mv.captured) state.captures[mv.piece.color] -= PIECE_VALUES[mv.captured.type] || 1;
		state.turn = mv.piece.color;
		state.lastMove = state.moveHistory[state.moveHistory.length - 1] || null;
		state.selected = null;
		state.legal = [];
		clearHint();
		updateHud();
		render();
	}

// --- Draw detection: threefold repetition and 50-move rule ---
const DrawDetection = (() => {
	// Need to access these from the parent scope
	const LIGHT = 1;
	const DARK = 2;
	const COLS = 8;
	const ROWS = 8;
	
	function createEmptyBoard() {
		return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
	}
	
	function initialCastling() {
		return {
			[LIGHT]: { kingside: true, queenside: true },
			[DARK]: { kingside: true, queenside: true }
		};
	}
	
	function simulateMove(move, board, castling, enPassant) {
		// This is a simplified version - reuse the main one if needed
		const nb = board.map(row => row.map(pc => pc ? { ...pc } : null));
		const nc = {
			[LIGHT]: { ...castling[LIGHT] },
			[DARK]: { ...castling[DARK] }
		};
		let ep = null;
		
		const piece = { ...nb[move.from.y][move.from.x] };
		nb[move.from.y][move.from.x] = null;
		
		if (move.castle) {
			nb[move.to.y][move.to.x] = piece;
			nb[move.rookTo.y][move.rookTo.x] = nb[move.rookFrom.y][move.rookFrom.x];
			nb[move.rookFrom.y][move.rookFrom.x] = null;
		} else {
			if (move.enPassant) {
				nb[move.capturePos.y][move.capturePos.x] = null;
			}
			nb[move.to.y][move.to.x] = piece;
			if (move.promo) nb[move.to.y][move.to.x].type = move.promo;
			if (move.doubleStep) ep = { x: move.to.x, y: move.from.y + (piece.color === LIGHT ? -1 : 1) };
		}
		
		nc[piece.color].kingside = nc[piece.color].kingside && piece.type !== "K";
		nc[piece.color].queenside = nc[piece.color].queenside && piece.type !== "K";
		
		return { board: nb, castling: nc, enPassant: ep };
	}
	
	function isDrawByRepetition() {
		if (typeof state === 'undefined') return false;
		
		const positions = {};
		let board = createEmptyBoard();
		let castling = initialCastling();
		let enPassant = null;
		let turn = LIGHT;
		
		// Initialize starting position
		board[0] = [
			{type:"R",color:DARK}, {type:"N",color:DARK}, {type:"B",color:DARK}, {type:"Q",color:DARK},
			{type:"K",color:DARK}, {type:"B",color:DARK}, {type:"N",color:DARK}, {type:"R",color:DARK}
		];
		board[1] = Array(COLS).fill(null).map(() => ({type:"P",color:DARK}));
		board[ROWS-2] = Array(COLS).fill(null).map(() => ({type:"P",color:LIGHT}));
		board[ROWS-1] = [
			{type:"R",color:LIGHT}, {type:"N",color:LIGHT}, {type:"B",color:LIGHT}, {type:"Q",color:LIGHT},
			{type:"K",color:LIGHT}, {type:"B",color:LIGHT}, {type:"N",color:LIGHT}, {type:"R",color:LIGHT}
		];
		
		positions[fenKey(board, castling, enPassant, turn)] = 1;
		
		for (const mv of state.moveHistory) {
			const sim = simulateMove(mv, board, castling, enPassant);
			board = sim.board;
			castling = sim.castling;
			enPassant = sim.enPassant;
			turn = turn === LIGHT ? DARK : LIGHT;
			const key = fenKey(board, castling, enPassant, turn);
			positions[key] = (positions[key] || 0) + 1;
			if (positions[key] >= 3) return true;
		}
		return false;
	}
	
	function isDrawByFiftyMoveRule() {
		if (typeof state === 'undefined') return false;
		return state.halfmove >= 100;
	}
	
	function fenKey(board, castling, enPassant, turn) {
		let s = "";
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				s += pc ? pc.type + pc.color : "-";
			}
		}
		s += ":" + (castling ? JSON.stringify(castling) : "-");
		s += ":" + (enPassant ? enPassant.x + "," + enPassant.y : "-");
		s += ":" + turn;
		return s;
	}
	
	return { isDrawByRepetition, isDrawByFiftyMoveRule, fenKey };
})();