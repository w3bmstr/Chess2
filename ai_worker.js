/* Dedicated engine worker for Chess2.
 * Runs search off the UI thread.
 */

/* eslint-disable no-restricted-globals */

let __difficultySettings = null;

// search.js expects this function; in the main app it comes from engine.js.
// In the worker we receive the full settings object from the main thread.
function getDifficultySettings(_level) {
	return __difficultySettings || {
		name: "Worker",
		searchDepth: 5,
		thinkTimeMs: 200,
		openingBookStrength: "none",
		moveNoise: 0,
		blunderChance: 0,
		seeMargins: { shallow: -90, deeper: -140, quiescence: -110 }
	};
}

function deepCloneMoveHistoryForWorker(moveHistory) {
	if (!Array.isArray(moveHistory)) return [];
	// Keep only fields needed by book/repetition simulation.
	return moveHistory.map(mv => {
		if (!mv || !mv.from || !mv.to) return null;
		return {
			from: { x: mv.from.x, y: mv.from.y },
			to: { x: mv.to.x, y: mv.to.y },
			castle: mv.castle,
			rookFrom: mv.rookFrom ? { x: mv.rookFrom.x, y: mv.rookFrom.y } : undefined,
			rookTo: mv.rookTo ? { x: mv.rookTo.x, y: mv.rookTo.y } : undefined,
			enPassant: !!mv.enPassant,
			capturePos: mv.capturePos ? { x: mv.capturePos.x, y: mv.capturePos.y } : undefined,
			promo: mv.promo,
			doubleStep: !!mv.doubleStep
		};
	}).filter(Boolean);
}

function setWorkerStateFromSnapshot(snap, aiLevel, aiColor) {
	// state is defined by state.js (importScripts)
	state.board = snap.board;
	state.turn = snap.turn;
	state.castling = snap.castling;
	state.enPassant = snap.enPassant;
	state.halfmove = snap.halfmove || 0;
	state.fullmove = snap.fullmove || 1;
	state.aiEnabled = true;
	state.aiLevel = aiLevel;
	state.aiColor = aiColor;
	state.gameOver = !!snap.gameOver;
	state.winner = snap.winner || null;
	state.message = "";
	state.moveHistory = deepCloneMoveHistoryForWorker(snap.moveHistory);
	state.positionHistory = Array.isArray(snap.positionHistory) ? snap.positionHistory.slice() : [];
	state.repetition = snap.repetition || null;
}

function sanitizeMoveForMainThread(mv) {
	if (!mv) return null;
	return {
		from: { x: mv.from.x, y: mv.from.y },
		to: { x: mv.to.x, y: mv.to.y },
		castle: mv.castle,
		rookFrom: mv.rookFrom ? { x: mv.rookFrom.x, y: mv.rookFrom.y } : undefined,
		rookTo: mv.rookTo ? { x: mv.rookTo.x, y: mv.rookTo.y } : undefined,
		enPassant: mv.enPassant,
		capturePos: mv.capturePos ? { x: mv.capturePos.x, y: mv.capturePos.y } : undefined,
		promo: mv.promo,
		doubleStep: mv.doubleStep
	};
}

function sanitizePVForMainThread(pvMoves) {
	if (!Array.isArray(pvMoves)) return [];
	return pvMoves.map(sanitizeMoveForMainThread).filter(Boolean);
}

function nowMs() {
	try {
		if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
	} catch (e) { /* ignore */ }
	return Date.now();
}

// Load the engine core (no ui.js, no engine.js).
// Order matters: board.js defines core helpers used by state.js.
importScripts("board.js", "state.js", "eval.js", "moves.js", "search.js");

self.onmessage = (ev) => {
	const msg = ev.data;
	if (!msg || typeof msg !== "object") return;

	if (msg.type === "abort") {
		try { SEARCH_ABORT = true; } catch (e) { /* ignore */ }
		return;
	}

	const requestId = msg.requestId;
	const token = msg.token;

	try {
		const snapshot = msg.snapshot;
		const settings = msg.settings;
		const aiColor = msg.aiColor;
		const aiLevel = msg.aiLevel;
		__difficultySettings = settings || __difficultySettings;
		try { SEARCH_ABORT = false; } catch (e) { /* ignore */ }
		try { SEARCH_NODES = 0; } catch (e) { /* ignore */ }
		if (snapshot) setWorkerStateFromSnapshot(snapshot, aiLevel, aiColor);

		if (msg.type === "search") {
			// aiChooseMove() is defined in search.js; it uses getDifficultySettings(state.aiLevel).
			const t0 = nowMs();
			const mv = aiChooseMove();
			const t1 = nowMs();
			self.postMessage({
				type: "result",
				requestId,
				token,
				kind: "search",
				move: sanitizeMoveForMainThread(mv),
				nodes: (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : 0,
				timeMs: Math.max(0, Math.round(t1 - t0))
			});
			return;
		}

		if (msg.type === "fixedDepth") {
			const depth = Math.max(1, msg.depth | 0);
			const povColor = msg.povColor;
			const turnColor = msg.turnColor;
			const ctx = cloneCtx(state.board, state.castling, state.enPassant);
			const t0 = nowMs();
			const res = searchBestMove(ctx, depth, -Infinity, Infinity, povColor, turnColor, Infinity, 0);
			const t1 = nowMs();
			self.postMessage({
				type: "result",
				requestId,
				token,
				kind: "fixedDepth",
				depth,
				score: res && Number.isFinite(res.score) ? res.score : 0,
				move: sanitizeMoveForMainThread(res && res.move),
				nodes: (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : 0,
				timeMs: Math.max(0, Math.round(t1 - t0))
			});
			return;
		}

		if (msg.type === "multiPV") {
			const depth = Math.max(1, msg.depth | 0);
			const lines = Math.max(1, msg.lines | 0);
			const povColor = msg.povColor;
			const turnColor = msg.turnColor;
			const ctx = cloneCtx(state.board, state.castling, state.enPassant);
			const t0 = nowMs();
			const pvResults = searchMultiPV(ctx, depth, povColor, turnColor, Infinity, lines) || [];
			const t1 = nowMs();
			self.postMessage({
				type: "result",
				requestId,
				token,
				kind: "multiPV",
				depth,
				lines,
				results: pvResults.map(r => ({
					depth: depth,
					score: r && Number.isFinite(r.score) ? r.score : 0,
					move: sanitizeMoveForMainThread(r && r.move),
					pv: sanitizePVForMainThread(r && r.pv),
					nodes: r && Number.isFinite(r.nodes) ? r.nodes : 0
				})),
				nodes: (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : 0,
				timeMs: Math.max(0, Math.round(t1 - t0))
			});
			return;
		}
	} catch (err) {
		self.postMessage({
			type: "error",
			requestId,
			token,
			error: String(err && err.message ? err.message : err)
		});
	}
};
