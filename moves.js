function findKing(board, color) {
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (pc && pc.type === "K" && pc.color === color) return { x, y };
			}
		}
		return null;
	}

	function isSquareAttacked(board, x, y, byColor) {
		// Pawns attack one step forward relative to their color, so from the
		// perspective of the target square we look one step opposite the pawn
		// advance direction.
		const pawnDir = byColor === LIGHT ? -1 : 1;
		for (const dx of [-1, 1]) {
			const px = x + dx;
			const py = y - pawnDir;
			if (onBoard(px, py)) {
				const pc = board[py][px];
				if (pc && pc.color === byColor && pc.type === "P") return true;
			}
		}

		const knightSteps = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
		for (const [dx, dy] of knightSteps) {
			const nx = x + dx, ny = y + dy;
			if (!onBoard(nx, ny)) continue;
			const pc = board[ny][nx];
			if (pc && pc.color === byColor && pc.type === "N") return true;
		}

		const sliders = [
			{ dirs: [[1,0],[-1,0],[0,1],[0,-1]], types: ["R", "Q"] },
			{ dirs: [[1,1],[1,-1],[-1,1],[-1,-1]], types: ["B", "Q"] }
		];
		for (const group of sliders) {
			for (const [dx, dy] of group.dirs) {
				let nx = x + dx, ny = y + dy;
				while (onBoard(nx, ny)) {
					const pc = board[ny][nx];
					if (pc) {
						if (pc.color === byColor && group.types.includes(pc.type)) return true;
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
			if (pc && pc.color === byColor && pc.type === "K") return true;
		}
		return false;
	}
function countAttackers(board, x, y, byColor) {
    let count = 0;

    // Pawns
    const pawnDir = byColor === LIGHT ? -1 : 1;
    for (const dx of [-1, 1]) {
        const px = x + dx;
        const py = y - pawnDir;
        if (onBoard(px, py)) {
            const pc = board[py][px];
            if (pc && pc.color === byColor && pc.type === "P") count++;
        }
    }

    // Knights
    const knightSteps = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
    for (const [dx, dy] of knightSteps) {
        const nx = x + dx, ny = y + dy;
        if (!onBoard(nx, ny)) continue;
        const pc = board[ny][nx];
        if (pc && pc.color === byColor && pc.type === "N") count++;
    }

    // Sliding pieces
    const sliders = [
        { dirs: [[1,0],[-1,0],[0,1],[0,-1]], types: ["R", "Q"] },
        { dirs: [[1,1],[1,-1],[-1,1],[-1,-1]], types: ["B", "Q"] }
    ];
    for (const group of sliders) {
        for (const [dx, dy] of group.dirs) {
            let nx = x + dx, ny = y + dy;
            while (onBoard(nx, ny)) {
                const pc = board[ny][nx];
                if (pc) {
                    if (pc.color === byColor && group.types.includes(pc.type)) count++;
                    break;
                }
                nx += dx; ny += dy;
            }
        }
    }

    // King
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!onBoard(nx, ny)) continue;
        const pc = board[ny][nx];
        if (pc && pc.color === byColor && pc.type === "K") count++;
    }

    return count;
}

	function inCheck(color, board) {
		const k = findKing(board, color);
		if (!k) return false;
		return isSquareAttacked(board, k.x, k.y, color === LIGHT ? DARK : LIGHT);
	}

	function disableRookRights(color, x, y, castling) {
		if (color === LIGHT && y === 7) {
			if (x === 0) castling[LIGHT].queenside = false;
			if (x === 7) castling[LIGHT].kingside = false;
		}
		if (color === DARK && y === 0) {
			if (x === 0) castling[DARK].queenside = false;
			if (x === 7) castling[DARK].kingside = false;
		}
	}

	function canCastle(color, side, board, castling) {
		if (!castling[color][side]) return false;
		const rank = color === LIGHT ? 7 : 0;
		const enemy = color === LIGHT ? DARK : LIGHT;
		const kingX = 4;
		const king = board[rank][kingX];
		if (!king || king.type !== "K" || king.color !== color) return false;
		if (isSquareAttacked(board, kingX, rank, enemy)) return false;
		if (side === "kingside") {
			const rook = board[rank][7];
			if (!rook || rook.type !== "R" || rook.color !== color) return false;
			if (board[rank][5] || board[rank][6]) return false;
			if (isSquareAttacked(board, 5, rank, enemy) || isSquareAttacked(board, 6, rank, enemy)) return false;
			return true;
		}
		const rook = board[rank][0];
		if (!rook || rook.type !== "R" || rook.color !== color) return false;
		if (board[rank][1] || board[rank][2] || board[rank][3]) return false;
		if (isSquareAttacked(board, 3, rank, enemy) || isSquareAttacked(board, 2, rank, enemy)) return false;
		return true;
	}

	function genPseudoMovesForSquare(x, y, board, castling, enPassant) {
		const piece = board[y][x];
		if (!piece) return [];
		const moves = [];
		const push = (nx, ny, extras = {}) => {
			if (!onBoard(nx, ny)) return;
			const target = board[ny][nx];
			if (!target || target.color !== piece.color) moves.push({ from: { x, y }, to: { x: nx, y: ny }, ...extras });
		};

		switch (piece.type) {
			case "P": {
				const dir = piece.color === LIGHT ? -1 : 1;
				const startRank = piece.color === LIGHT ? ROWS - 2 : 1;
				const one = y + dir;
				const promoExtras = ny => ((ny === 0 || ny === ROWS - 1) ? { promo: "Q" } : {});
				if (onBoard(x, one) && !board[one][x]) {
					push(x, one, { ...promoExtras(one) });
					const two = y + dir * 2;
					if (y === startRank && !board[two][x]) push(x, two, { doubleStep: true });
				}
				for (const dx of [-1, 1]) {
					const nx = x + dx;
					const ny = y + dir;
					if (!onBoard(nx, ny)) continue;
					if (board[ny][nx] && board[ny][nx].color !== piece.color) push(nx, ny, { capture: true, ...promoExtras(ny) });
					if (enPassant && enPassant.x === nx && enPassant.y === ny) {
						push(nx, ny, { enPassant: true, capturePos: { x: nx, y: y } });
					}
				}
				break;
			}
			case "N": {
				const steps = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
				for (const [dx, dy] of steps) push(x + dx, y + dy, {});
				break;
			}
			case "B": slideDirs([[1,1],[1,-1],[-1,1],[-1,-1]], x, y, board, piece.color, moves); break;
			case "R": slideDirs([[1,0],[-1,0],[0,1],[0,-1]], x, y, board, piece.color, moves); break;
			case "Q": slideDirs([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]], x, y, board, piece.color, moves); break;
			case "K": {
				const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
				for (const [dx, dy] of dirs) push(x + dx, y + dy, {});
				if (canCastle(piece.color, "kingside", board, castling)) {
					moves.push({ from: { x, y }, to: { x: 6, y }, castle: "kingside", rookFrom: { x: 7, y }, rookTo: { x: 5, y } });
				}
				if (canCastle(piece.color, "queenside", board, castling)) {
					moves.push({ from: { x, y }, to: { x: 2, y }, castle: "queenside", rookFrom: { x: 0, y }, rookTo: { x: 3, y } });
				}
				break;
			}
		}
		return moves;
	}


	function slideDirs(dirs, x, y, board, color, out) {
		for (const [dx, dy] of dirs) {
			let nx = x + dx, ny = y + dy;
			while (onBoard(nx, ny)) {
				const pc = board[ny][nx];
				if (!pc) out.push({ from: { x, y }, to: { x: nx, y: ny } });
				else {
					if (pc.color !== color) out.push({ from: { x, y }, to: { x: nx, y: ny }, capture: true });
					break;
				}
				nx += dx; ny += dy;
			}
		}
	}

	function simulateMove(move, board, castling, enPassant) {
		const nb = cloneBoard(board);
		const nc = cloneCastling(castling);
		let ep = null;
		const piece = { ...nb[move.from.y][move.from.x] };
		nb[move.from.y][move.from.x] = null;

		let captured = null;
		if (move.castle) {
			nb[move.to.y][move.to.x] = piece;
			nb[move.rookTo.y][move.rookTo.x] = nb[move.rookFrom.y][move.rookFrom.x];
			nb[move.rookFrom.y][move.rookFrom.x] = null;
		} else {
			if (move.enPassant) {
				captured = nb[move.capturePos.y][move.capturePos.x];
				nb[move.capturePos.y][move.capturePos.x] = null;
			}
			captured = captured || nb[move.to.y][move.to.x];
			nb[move.to.y][move.to.x] = piece;
			if (move.promo) nb[move.to.y][move.to.x].type = move.promo;
			if (move.doubleStep) ep = { x: move.to.x, y: move.from.y + (piece.color === LIGHT ? -1 : 1) };
		}

		nc[piece.color].kingside = nc[piece.color].kingside && piece.type !== "K";
		nc[piece.color].queenside = nc[piece.color].queenside && piece.type !== "K";
		if (piece.type === "R") disableRookRights(piece.color, move.from.x, move.from.y, nc);
		if (captured && captured.type === "R") {
			const cx = move.enPassant && move.capturePos ? move.capturePos.x : move.to.x;
			const cy = move.enPassant && move.capturePos ? move.capturePos.y : move.to.y;
			disableRookRights(captured.color, cx, cy, nc);
		}

		return { board: nb, castling: nc, enPassant: ep };
	}

	function genLegalMovesForSquare(x, y) {
		const pseudo = genPseudoMovesForSquare(x, y, state.board, state.castling, state.enPassant);
		const legal = [];
		const piece = state.board[y][x];
		if (!piece) return legal;
		const enemy = piece.color === LIGHT ? DARK : LIGHT;
		for (const mv of pseudo) {
			const next = simulateMove(mv, state.board, state.castling, state.enPassant);
			const kingPos = findKing(next.board, piece.color);
			if (!kingPos) continue;
			if (!isSquareAttacked(next.board, kingPos.x, kingPos.y, enemy)) legal.push(mv);
		}
		return legal;
	}

	function generateLegalMoves(color) {
		const all = [];
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = state.board[y][x];
				if (!pc || pc.color !== color) continue;
				const moves = genLegalMovesForSquare(x, y);
				all.push(...moves);
			}
		}
		return all;
	}

	function generateLegalMovesFor(board, castling, enPassant, color) {
		const all = [];
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const pc = board[y][x];
				if (!pc || pc.color !== color) continue;
				const pseudo = genPseudoMovesForSquare(x, y, board, castling, enPassant);
				const enemy = color === LIGHT ? DARK : LIGHT;
				for (const mv of pseudo) {
					const next = simulateMove(mv, board, castling, enPassant);
					const kingPos = findKing(next.board, color);
					if (!kingPos) continue;
					if (!isSquareAttacked(next.board, kingPos.x, kingPos.y, enemy)) all.push(mv);
				}
			}
		}
		return all;
	}
