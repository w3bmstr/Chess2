// ============================================================================
// Auto-Play (Engine vs Engine)
// ============================================================================


let autoPlayActive = false;
let autoPlayTimer = null;
let autoPlayThinkToken = 0;
let _autoPlayMakingMove = false;

function scheduleAutoPlayStep(delayMs) {
  if (autoPlayTimer) clearTimeout(autoPlayTimer);
  autoPlayTimer = setTimeout(autoPlayStep, Math.max(0, delayMs | 0));
}

// Track last move arrow timestamp
let lastMoveArrowTimestamp = 0;

function autoPlayStep() {
	if (!autoPlayActive || state.gameOver) {
		autoPlayActive = false;
		updateAutoPlayButton();
		return;
	}
  // Avoid overlapping search cycles (can cause out-of-turn / illegal moves).
  if (state.thinking) {
    scheduleAutoPlayStep(50);
    return;
  }
	state.aiEnabled = true;
	state.aiColor = state.turn;
	state.menuActive = false;
	setBoardInput(false);
	const { thinkTimeMs } = getDifficultySettings(state.aiLevel);
	state.thinking = true;
  const myToken = ++autoPlayThinkToken;
	setTimeout(() => {
    if (!autoPlayActive || state.gameOver) {
      state.thinking = false;
      return;
    }
    // If a newer auto-play cycle started, drop this stale callback.
    if (myToken !== autoPlayThinkToken) {
      state.thinking = false;
      return;
    }

    // Preferred: compute in Worker (keeps UI responsive).
    if (ensureAIWorker()) {
      const snapshot = snapshotForAIWorker();
      const settings = getDifficultySettings(state.aiLevel);
      postAIWorkerRequest({
        type: 'search',
        token: myToken,
        snapshot,
        settings,
        aiColor: state.turn,
        aiLevel: state.aiLevel
      }, {
        onResult: (msg) => {
          if (!autoPlayActive || state.gameOver) { state.thinking = false; return; }
          if (myToken !== autoPlayThinkToken) { state.thinking = false; return; }

          const mv = msg.move;
          if (mv) {
            try {
              _autoPlayMakingMove = true;
              makeMove(mv);
            } finally {
              _autoPlayMakingMove = false;
            }
            try { syncTrainingNotes?.(); } catch (e) { /* ignore */ }
          }

          state.thinking = false;
          render();
          updateHud();

          if (autoPlayActive && !state.gameOver) {
            scheduleAutoPlayStep(200); // Short delay between moves
          } else {
            autoPlayActive = false;
            updateAutoPlayButton();
          }
        },
        onError: () => {
          state.thinking = false;
          autoPlayActive = false;
          updateAutoPlayButton();
        }
      });
      return;
    }

    // Fallback (file://): synchronous search on main thread.
    const mv = aiChooseMove();
    if (mv) {
      try {
        _autoPlayMakingMove = true;
        makeMove(mv);
      } finally {
        _autoPlayMakingMove = false;
      }
      syncTrainingNotes?.();
    }
    state.thinking = false;
    render();
    updateHud();
    if (autoPlayActive && !state.gameOver) {
      scheduleAutoPlayStep(200); // Short delay between moves
    } else {
      autoPlayActive = false;
      updateAutoPlayButton();
    }
	}, thinkTimeMs);
}

function toggleAutoPlay() {
	autoPlayActive = !autoPlayActive;
	updateAutoPlayButton();
	if (autoPlayActive) {
    scheduleAutoPlayStep(0);
	} else {
		if (autoPlayTimer) clearTimeout(autoPlayTimer);
		autoPlayTimer = null;
    autoPlayThinkToken++;
	}
}

function updateAutoPlayButton() {
	const btn = document.getElementById('btn-autoplay');
	if (btn) {
		btn.textContent = autoPlayActive ? 'Stop Auto-Play' : 'Auto-Play';
		btn.style.background = autoPlayActive ? 'linear-gradient(135deg, #ffd166, #ff6e6e)' : '';
	}
}

// Add Auto-Play button to controls
function addAutoPlayButton() {
	const controlsPanel = document.getElementById('controls');
	if (!controlsPanel) return;
	if (document.getElementById('btn-autoplay')) return;
	const btn = document.createElement('button');
	btn.id = 'btn-autoplay';
	btn.textContent = 'Auto-Play';
	btn.style.marginLeft = '8px';
	btn.style.padding = '6px 14px';
	btn.style.fontSize = '13px';
	btn.style.borderRadius = '6px';
	btn.style.cursor = 'pointer';
	btn.addEventListener('click', toggleAutoPlay);
	controlsPanel.appendChild(btn);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', addAutoPlayButton);
} else {
	addAutoPlayButton();
}

// Stop auto-play on manual move or reset
const _originalMakeMove = typeof makeMove === 'function' ? makeMove : null;
if (_originalMakeMove) {
	window.makeMove = function(mv) {
		// Only set lastMoveArrowTimestamp if this is an AI move
		if (state.aiEnabled && state.aiColor === state.turn) {
			lastMoveArrowTimestamp = Date.now();
		}
		const result = _originalMakeMove(mv);
		// If auto-play is active and game is not over, continue auto-play
    if (autoPlayActive && !state.gameOver && !_autoPlayMakingMove) {
      // Manual move while auto-play is running: keep it going, but don't create
      // duplicate cycles when auto-play itself makes the move.
      scheduleAutoPlayStep(200);
		}
		return result;
	};
}
const _originalResetBoard = typeof resetBoard === 'function' ? resetBoard : null;
if (_originalResetBoard) {
	window.resetBoard = function() {
    try { if (typeof window.abortSearch === 'function') window.abortSearch(); } catch (e) { /* ignore */ }
		if (autoPlayActive) {
			autoPlayActive = false;
			updateAutoPlayButton();
			if (autoPlayTimer) clearTimeout(autoPlayTimer);
			autoPlayTimer = null;
		}
		return _originalResetBoard();
	};
}

function _abortSearchIfAny() {
  try { if (typeof window.abortSearch === 'function') window.abortSearch(); } catch (e) { /* ignore */ }
  // Also cancel any pending AI move timers so navigation (goToMove, undo, etc.) works immediately.
  try {
    if (typeof window.__aiThinkToken === 'number') window.__aiThinkToken++;
    if (typeof window.__aiThinkTimer !== 'undefined' && window.__aiThinkTimer) {
      clearTimeout(window.__aiThinkTimer);
      window.__aiThinkTimer = null;
    }
    if (state && state.thinking) state.thinking = false;
  } catch (e) { /* ignore */ }
}

// ============================================================================
// AI Worker (runs engine search off the main thread)
// ============================================================================

let __aiWorker = null;
let __aiWorkerReqId = 0;
let __aiWorkerInitFailed = false;
let __aiWorkerInitWarned = false;
const __aiWorkerPending = new Map();

function __aiWorkerNextId() {
  __aiWorkerReqId += 1;
  return __aiWorkerReqId;
}

function __aiWorkerDispatchMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const requestId = msg.requestId;
  if (requestId && __aiWorkerPending.has(requestId)) {
    const pending = __aiWorkerPending.get(requestId);
    __aiWorkerPending.delete(requestId);
    if (msg.type === 'result') {
      try { pending.onResult && pending.onResult(msg); } catch (e) { /* ignore */ }
    } else if (msg.type === 'error') {
      try { pending.onError && pending.onError(msg); } catch (e) { /* ignore */ }
    }
    return;
  }

  // Back-compat path: older worker responses without per-request callbacks.
  if (msg.type === 'result') {
    try { handleAIWorkerResult(msg); } catch (e) { /* ignore */ }
  } else if (msg.type === 'error') {
    console.warn('[AI Worker] error', msg.error);
    try { state.thinking = false; } catch (e) { /* ignore */ }
  }
}

function ensureAIWorker() {
  if (__aiWorker) return __aiWorker;
  if (__aiWorkerInitFailed) return null;
  if (typeof Worker === 'undefined') return null;

  // Browsers block Workers for file:// origins. Avoid throwing a SecurityError
  // (and spamming console) by opting out early.
  try {
    if (typeof location !== 'undefined' && location && location.protocol === 'file:') {
      __aiWorkerInitFailed = true;
      if (!__aiWorkerInitWarned) {
        __aiWorkerInitWarned = true;
        console.warn('[AI Worker] disabled for file://. Use a local server (VS Code Live Server).');
      }
      return null;
    }
  } catch (e) { /* ignore */ }

  try {
    __aiWorker = new Worker('ai_worker.js');
    __aiWorker.onmessage = (ev) => {
      __aiWorkerDispatchMessage(ev.data);
    };
    __aiWorker.onerror = (e) => {
      console.warn('[AI Worker] failed', e && (e.message || e));
      try { state.thinking = false; } catch (err) { /* ignore */ }
    };
    return __aiWorker;
  } catch (e) {
    __aiWorkerInitFailed = true;
    if (!__aiWorkerInitWarned) {
      __aiWorkerInitWarned = true;
      console.warn('[AI Worker] could not start (likely file:// restrictions). Use a local server (VS Code Live Server).', e);
    }
    __aiWorker = null;
    return null;
  }
}

function snapshotForAIWorker() {
  // Keep the payload small but sufficient for legality/book/repetition.
  return {
    board: state.board,
    turn: state.turn,
    castling: state.castling,
    enPassant: state.enPassant,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    gameOver: state.gameOver,
    winner: state.winner,
    moveHistory: Array.isArray(state.moveHistory)
      ? state.moveHistory.map(mv => ({
        from: mv.from,
        to: mv.to,
        castle: mv.castle,
        rookFrom: mv.rookFrom,
        rookTo: mv.rookTo,
        enPassant: mv.enPassant,
        capturePos: mv.capturePos,
        promo: mv.promo,
        doubleStep: mv.doubleStep
      }))
      : [],
    positionHistory: Array.isArray(state.positionHistory) ? state.positionHistory : [],
    repetition: state.repetition || null
  };
}

function abortAIWorkerSearch() {
  try {
    // Don't try to construct a worker just to abort.
    if (__aiWorker) __aiWorker.postMessage({ type: 'abort' });
    __aiWorkerPending.clear();
  } catch (e) { /* ignore */ }
}

function postAIWorkerRequest(message, handlers) {
  const worker = ensureAIWorker();
  if (!worker) return null;
  const requestId = __aiWorkerNextId();
  __aiWorkerPending.set(requestId, {
    onResult: handlers && handlers.onResult,
    onError: handlers && handlers.onError
  });
  try {
    worker.postMessage(Object.assign({ requestId }, message));
    return requestId;
  } catch (e) {
    __aiWorkerPending.delete(requestId);
    return null;
  }
}

// Provide a global abortSearch so existing navigation hooks cancel worker searches too.
if (typeof window.abortSearch !== 'function') {
  window.abortSearch = function () {
    abortAIWorkerSearch();
  };
}

function handleAIWorkerResult(msg) {
  // Token checks are owned by maybeRunAI() scheduling.
  const token = msg.token;
  if (typeof window.__aiThinkToken === 'number' && token !== window.__aiThinkToken) return;
  if (!state.aiEnabled || state.menuActive || state.gameOver) { state.thinking = false; return; }
  if (state.turn !== state.aiColor) { state.thinking = false; return; }
  const mv = msg.move;
  if (mv) makeMove(mv);
  try { syncTrainingNotes(); } catch (e) { /* ignore */ }
  state.thinking = false;
}

// ============================================================================
// Clipboard helpers (PGN/FEN copy must work on http:// too)
// ============================================================================

function copyTextToClipboard(text) {
  const str = (text === null || text === undefined) ? '' : String(text);

  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);

      // iOS Safari needs explicit selection range.
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (e) { /* ignore */ }

      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve(!!ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && (window.isSecureContext || location.hostname === 'localhost')) {
      return navigator.clipboard.writeText(str).then(() => true).catch(() => fallback());
    }
  } catch (e) { /* ignore */ }
  return fallback();
}

// Generate a minimal PGN for the current game.
// (We keep this in ui.js so the Copy PGN button always works even if no separate PGN-export module exists.)
function generatePGN() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const dateTag = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  const resultTag = (state && state.gameOver)
    ? (state.winner === 'White' ? '1-0' : state.winner === 'Black' ? '0-1' : state.winner === 'Draw' ? '1/2-1/2' : '*')
    : '*';

  const tags = [
    ['Event', 'Casual Game'],
    ['Site', (typeof location !== 'undefined' && location.href) ? location.href : 'Local'],
    ['Date', dateTag],
    ['Round', '-'],
    ['White', 'White'],
    ['Black', 'Black'],
    ['Result', resultTag]
  ];

  const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
  const moveToSanSimple = (mv) => {
    if (!mv) return '';
    if (mv.castle === 'kingside') return `O-O${mv.mate ? '#' : mv.check ? '+' : ''}`;
    if (mv.castle === 'queenside') return `O-O-O${mv.mate ? '#' : mv.check ? '+' : ''}`;
    const pieceType = mv.piece && mv.piece.type ? mv.piece.type : 'P';
    const isPawn = pieceType === 'P';
    const captureMark = (mv.captured || mv.enPassant) ? 'x' : '';
    const fromFile = isPawn && captureMark ? String.fromCharCode(97 + mv.from.x) : '';
    const pieceLetter = isPawn ? '' : pieceType;
    const dest = sq(mv.to.x, mv.to.y);
    const promo = mv.promo ? `=${mv.promo}` : '';
    const suffix = mv.mate ? '#' : mv.check ? '+' : '';
    return `${pieceLetter}${fromFile}${captureMark}${dest}${promo}${suffix}`;
  };

  const moves = (state && Array.isArray(state.moveHistory)) ? state.moveHistory : [];
  let body = '';
  for (let i = 0; i < moves.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const w = moves[i];
    const b = moves[i + 1];
    const wSan = moveToSanSimple(w);
    const bSan = b ? moveToSanSimple(b) : '';
    body += `${moveNum}. ${wSan}`;
    if (w && w.pgnComment) body += ` {${String(w.pgnComment).replace(/[{}]/g, '')}}`;
    if (bSan) {
      body += ` ${bSan}`;
      if (b && b.pgnComment) body += ` {${String(b.pgnComment).replace(/[{}]/g, '')}}`;
    }
    body += ' ';
  }
  body = body.trim();
  if (body.length) body += ` ${resultTag}`;
  else body = resultTag;

  let out = '';
  for (const [k, v] of tags) out += `[${k} "${String(v).replace(/"/g, "'")}"]\n`;
  out += `\n${body}\n`;
  return out;
}

// Expose for other scripts/UI buttons.
try { window.generatePGN = generatePGN; } catch (e) { /* ignore */ }

// Abort engine thinking on navigation actions (undo/redo/go-to-start/end)
const _originalUndo = typeof undo === 'function' ? undo : null;
if (_originalUndo) {
  window.undo = function(...args) {
    _abortSearchIfAny();
    return _originalUndo.apply(this, args);
  };
}

const _originalUndoMove = typeof undoMove === 'function' ? undoMove : null;
if (_originalUndoMove) {
  window.undoMove = function(...args) {
    _abortSearchIfAny();
    return _originalUndoMove.apply(this, args);
  };
}

const _originalRedoMove = typeof redoMove === 'function' ? redoMove : null;
if (_originalRedoMove) {
  window.redoMove = function(...args) {
    _abortSearchIfAny();
    return _originalRedoMove.apply(this, args);
  };
}

const _originalUndoToStart = typeof undoToStart === 'function' ? undoToStart : null;
if (_originalUndoToStart) {
  window.undoToStart = function(...args) {
    _abortSearchIfAny();
    return _originalUndoToStart.apply(this, args);
  };
}

const _originalRedoToEnd = typeof redoToEnd === 'function' ? redoToEnd : null;
if (_originalRedoToEnd) {
  window.redoToEnd = function(...args) {
    _abortSearchIfAny();
    return _originalRedoToEnd.apply(this, args);
  };
}
// ============================================================================
// UI: Engine Info Panel
// ============================================================================

function createEngineInfoPanel() {
	let panel = document.getElementById('engine-info-panel');
	if (panel) return panel;
	panel = document.createElement('div');
	panel.id = 'engine-info-panel';
	panel.className = 'panel';
	panel.style.cssText = 'margin-top: 8px; padding: 8px 12px; background: #181b22; color: var(--muted); font-size: 13px; border-radius: 8px; min-width: 180px;';
	panel.innerHTML = `
		<div style="font-weight: 600; color: var(--accent); margin-bottom: 4px;">Engine Info</div>
		<div id="engine-info-depth">Depth: --</div>
		<div id="engine-info-nodes">Nodes: --</div>
		<div id="engine-info-eval">Eval: --</div>
	`;
	// Place below controls or at top right
	const controls = document.getElementById('controls');
	if (controls && controls.parentNode) {
		controls.parentNode.insertBefore(panel, controls.nextSibling);
	} else {
		document.body.appendChild(panel);
	}
	return panel;
}

function updateEngineInfo({ depth, nodes, evalScore }) {
  // Throttle DOM updates to keep mobile smooth.
  if (!updateEngineInfo._state) {
    updateEngineInfo._state = {
      lastFlush: 0,
      timer: null,
      latest: null,
      minIntervalMs: 80
    };
  }
  const s = updateEngineInfo._state;
  s.latest = { depth, nodes, evalScore };

  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const dueIn = s.minIntervalMs - (now - s.lastFlush);

  const apply = () => {
    const info = s.latest || { depth: '--', nodes: '--', evalScore: undefined };
    const dEl = document.getElementById('engine-info-depth');
    const nEl = document.getElementById('engine-info-nodes');
    const eEl = document.getElementById('engine-info-eval');
    if (dEl) dEl.textContent = `Depth: ${info.depth ?? '--'}`;
    if (nEl) nEl.textContent = `Nodes: ${info.nodes ?? '--'}`;
    if (eEl) eEl.textContent = `Eval: ${info.evalScore !== undefined ? formatScore(info.evalScore) : '--'}`;
  };

  const flush = () => {
    s.timer = null;
    s.lastFlush = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    apply();
  };

  if (dueIn <= 0) {
    flush();
    return;
  }
  if (!s.timer) {
    s.timer = setTimeout(flush, Math.max(0, Math.ceil(dueIn)));
  }
}

updateEngineInfo.flush = function() {
  const s = updateEngineInfo._state;
  if (!s) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.lastFlush = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const info = s.latest || { depth: '--', nodes: '--', evalScore: undefined };
  const dEl = document.getElementById('engine-info-depth');
  const nEl = document.getElementById('engine-info-nodes');
  const eEl = document.getElementById('engine-info-eval');
  if (dEl) dEl.textContent = `Depth: ${info.depth ?? '--'}`;
  if (nEl) nEl.textContent = `Nodes: ${info.nodes ?? '--'}`;
  if (eEl) eEl.textContent = `Eval: ${info.evalScore !== undefined ? formatScore(info.evalScore) : '--'}`;
};

function clearEngineInfo() {
	updateEngineInfo({ depth: '--', nodes: '--', evalScore: undefined });
}

// Patch searchBestMove and aiChooseMove to update info
let engineInfo = { depth: 0, nodes: 0, evalScore: 0 };

// IMPORTANT: Do NOT override the engine's recursive searchBestMove.
// Instead, expose a separate UI wrapper that calls the original and updates HUD once per root call.
if (typeof searchBestMove === 'function') {
  const _originalSearchBestMove = searchBestMove;
  window.searchBestMoveWithInfo = function(ctx, depth, alpha, beta, color, rootColor, deadline, ply) {
    // Optional node counter from search.js (var SEARCH_NODES)
	try { if (typeof SEARCH_NODES !== 'undefined') SEARCH_NODES = 0; } catch (e) { /* ignore */ }
    const result = _originalSearchBestMove(ctx, depth, alpha, beta, color, rootColor, deadline, ply);
    if (result && typeof result.score === 'number') engineInfo.evalScore = result.score;
    engineInfo.depth = depth;
	try { if (typeof SEARCH_NODES !== 'undefined') engineInfo.nodes = SEARCH_NODES; } catch (e) { /* ignore */ }
    updateEngineInfo(engineInfo);
    return result;
  };
}

// Patch aiChooseMove to clear and update info
// NOTE: Do not override aiChooseMove here.
// When hosted over HTTP/HTTPS, heavy search runs in the Web Worker.

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', createEngineInfoPanel);
} else {
	createEngineInfoPanel();
}
const container = document.getElementById("game-container");
const boardLayer = document.getElementById("board-layer");
const piecesLayer = document.getElementById("pieces-layer");
const uiLayer = document.getElementById("ui-layer");
const trainingNotesEl = document.getElementById("trainingNotes");

const startOverlay = document.getElementById("start-overlay");
const btn1p = document.getElementById("btn-1p");
const btn2p = document.getElementById("btn-2p");
const diffSelect = document.getElementById("difficulty-select");
const btnStartOverlay = document.getElementById("btn-start-overlay");
const btnRules = document.getElementById("btn-rules");
const rulesOverlay = document.getElementById("rules-overlay");
const closeRules = document.getElementById("close-rules");
const hudBtnStart = document.getElementById("btn-start");
const hudBtnReset = document.getElementById("btn-reset");
const btnHint = document.getElementById("btn-hint");
const btnHint2 = document.getElementById("btn-hint-2");
const hudBtnHistory = document.getElementById("btn-history");
const btnHistoryClose = document.getElementById("btn-history-close");
const historyPanel = document.getElementById("history");
const turnText = document.getElementById("turn-text");
const aiText = document.getElementById("ai-text");
const msgText = document.getElementById("msg-text");
const capText = document.getElementById("cap-text");
const lastMoveText = document.getElementById("lastmove-text");
const openingText = document.getElementById("opening-text");
const moveList = document.getElementById("move-list");
const difficultyMobile = document.getElementById("difficulty-mobile");


// ============================================================================
// Opening Book (Mini ECO)
// ============================================================================

const OPENINGS = 

[
  {
    "eco": "A00",
    "name": "Polish (Sokolsky) opening",
    "moves": [
      "b2b4"
    ]
  },
  {
    "eco": "A00",
    "name": "Polish, Tuebingen variation",
    "moves": [
      "b2b4",
      "b1h6"
    ]
  },
  {
    "eco": "A00",
    "name": "Polish, Outflank variation",
    "moves": [
      "b2b4",
      "c7c6"
    ]
  },
  {
    "eco": "A00",
    "name": "Benko's opening",
    "moves": [
      "g2g3"
    ]
  },
  {
    "eco": "A00",
    "name": "Lasker simul special",
    "moves": [
      "g2g3",
      "h7h5"
    ]
  },
  {
    "eco": "A00",
    "name": "Benko's opening, reversed Alekhine",
    "moves": [
      "g2g3",
      "e7e5",
      "b1f3"
    ]
  },
  {
    "eco": "A00",
    "name": "Grob's attack",
    "moves": [
      "g2g4"
    ]
  },
  {
    "eco": "A00",
    "name": "Grob, spike attack",
    "moves": [
      "g2g4",
      "d7d5",
      "c1g2",
      "c7c6",
      "g7g5"
    ]
  },
  {
    "eco": "A00",
    "name": "Grob, Fritz gambit",
    "moves": [
      "g2g4",
      "d7d5",
      "c1g2",
      "f1g4",
      "c2c4"
    ]
  },
  {
    "eco": "A00",
    "name": "Grob, Romford counter-gambit",
    "moves": [
      "g2g4",
      "d7d5",
      "c1g2",
      "f1g4",
      "c2c4",
      "d2d4"
    ]
  },
  {
    "eco": "A00",
    "name": "Clemenz (Mead's, Basman's or de Klerk's) opening",
    "moves": [
      "h2h3"
    ]
  },
  {
    "eco": "A00",
    "name": "Global opening",
    "moves": [
      "h2h3",
      "e7e5",
      "a2a3"
    ]
  },
  {
    "eco": "A00",
    "name": "Amar (Paris) opening",
    "moves": [
      "b1h3"
    ]
  },
  {
    "eco": "A00",
    "name": "Amar gambit",
    "moves": [
      "b1h3",
      "d7d5",
      "g2g3",
      "e7e5",
      "f2f4",
      "c1h3",
      "f1h3",
      "e2f4"
    ]
  },
  {
    "eco": "A00",
    "name": "Dunst (Sleipner, Heinrichsen) opening",
    "moves": [
      "b1c3"
    ]
  },
  {
    "eco": "A00",
    "name": "Dunst (Sleipner,Heinrichsen) opening",
    "moves": [
      "b1c3",
      "e7e5"
    ]
  },
  {
    "eco": "A00",
    "name": "Battambang opening",
    "moves": [
      "b1c3",
      "e7e5",
      "a2a3"
    ]
  },
  {
    "eco": "A00",
    "name": "Novosibirsk opening",
    "moves": [
      "b1c3",
      "c7c5",
      "d2d4",
      "c2d4",
      "d1d4",
      "g1c6",
      "d8h4"
    ]
  },
  {
    "eco": "A00",
    "name": "Anderssen's opening",
    "moves": [
      "a2a3"
    ]
  },
  {
    "eco": "A00",
    "name": "Ware (Meadow Hay) opening",
    "moves": [
      "a2a4"
    ]
  },
  {
    "eco": "A00",
    "name": "Crab opening",
    "moves": [
      "a2a4",
      "e7e5",
      "h2h4"
    ]
  },
  {
    "eco": "A00",
    "name": "Saragossa opening",
    "moves": [
      "c2c3"
    ]
  },
  {
    "eco": "A00",
    "name": "Mieses opening",
    "moves": [
      "d2d3"
    ]
  },
  {
    "eco": "A00",
    "name": "Mieses opening",
    "moves": [
      "d2d3",
      "e7e5"
    ]
  },
  {
    "eco": "A00",
    "name": "Valencia opening",
    "moves": [
      "d2d3",
      "e7e5",
      "b1d2"
    ]
  },
  {
    "eco": "A00",
    "name": "Venezolana opening",
    "moves": [
      "d2d3",
      "c7c5",
      "b1c3",
      "g1c6",
      "g2g3"
    ]
  },
  {
    "eco": "A00",
    "name": "Van't Kruijs opening",
    "moves": [
      "e2e3"
    ]
  },
  {
    "eco": "A00",
    "name": "Amsterdam attack",
    "moves": [
      "e2e3",
      "e7e5",
      "c2c4",
      "d7d6",
      "b1c3",
      "g1c6",
      "b2b3",
      "b8f6"
    ]
  },
  {
    "eco": "A00",
    "name": "Gedult's opening",
    "moves": [
      "f2f3"
    ]
  },
  {
    "eco": "A00",
    "name": "Hammerschlag (Fried fox/Pork chop opening)",
    "moves": [
      "f2f3",
      "e7e5",
      "e1f2"
    ]
  },
  {
    "eco": "A00",
    "name": "Anti-Borg (Desprez) opening",
    "moves": [
      "h2h4"
    ]
  },
  {
    "eco": "A00",
    "name": "Durkin's attack",
    "moves": [
      "b1a3"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack",
    "moves": [
      "b2b3"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, modern variation",
    "moves": [
      "b2b3",
      "e7e5"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, Indian variation",
    "moves": [
      "b2b3",
      "b1f6"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, classical variation",
    "moves": [
      "b2b3",
      "d7d5"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, English variation",
    "moves": [
      "b2b3",
      "c7c5"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, Dutch variation",
    "moves": [
      "b2b3",
      "f7f5"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, Polish variation",
    "moves": [
      "b2b3",
      "b7b5"
    ]
  },
  {
    "eco": "A01",
    "name": "Nimzovich-Larsen attack, symmetrical variation",
    "moves": [
      "b2b3",
      "b7b6"
    ]
  },
  {
    "eco": "A02",
    "name": "-A03 Bird's opening",
    "moves": [
      "f2f4"
    ]
  },
  {
    "eco": "A04",
    "name": "-A09 Reti opening",
    "moves": [
      "b1f3"
    ]
  },
  {
    "eco": "A10",
    "name": "-A39 English opening",
    "moves": [
      "c2c4"
    ]
  },
  {
    "eco": "A40",
    "name": "-A41 Queen's pawn",
    "moves": [
      "d2d4"
    ]
  },
  {
    "eco": "A42",
    "name": "Modern defence, Averbakh system",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "c1g7",
      "e2e4"
    ]
  },
  {
    "eco": "A42",
    "name": "Pterodactyl defence",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "c1g7",
      "e2e4",
      "c7c5",
      "g1f3",
      "d1a5"
    ]
  },
  {
    "eco": "A42",
    "name": "Modern defence, Averbakh system, Randspringer variation",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "c1g7",
      "e2e4",
      "f7f5"
    ]
  },
  {
    "eco": "A42",
    "name": "Modern defence, Averbakh system, Kotov variation",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "c1g7",
      "e2e4",
      "g1c6"
    ]
  },
  {
    "eco": "A43",
    "name": "-A44 Old Benoni defence",
    "moves": [
      "d2d4",
      "c7c5"
    ]
  },
  {
    "eco": "A45",
    "name": "-A46 Queen's pawn game",
    "moves": [
      "d2d4",
      "b1f6"
    ]
  },
  {
    "eco": "A47",
    "name": "Queen's Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "g1f3",
      "b7b6"
    ]
  },
  {
    "eco": "A47",
    "name": "Queen's Indian, Marienbad system",
    "moves": [
      "d2d4",
      "b1f6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c1b7",
      "f1g2",
      "c7c5"
    ]
  },
  {
    "eco": "A47",
    "name": "Queen's Indian, Marienbad system, Berg variation",
    "moves": [
      "d2d4",
      "b1f6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c1b7",
      "f1g2",
      "c7c5",
      "c2c4",
      "c2d4",
      "d1d4"
    ]
  },
  {
    "eco": "A48",
    "name": "-A49 King's Indian, East Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "g1f3",
      "g7g6"
    ]
  },
  {
    "eco": "A50",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4"
    ]
  },
  {
    "eco": "A50",
    "name": "Kevitz-Trajkovich defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "g1c6"
    ]
  },
  {
    "eco": "A50",
    "name": "Queen's Indian accelerated",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "b7b6"
    ]
  },
  {
    "eco": "A51",
    "name": "-A52 Budapest defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e5"
    ]
  },
  {
    "eco": "A53",
    "name": "-A55 Old Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "d7d6"
    ]
  },
  {
    "eco": "A56",
    "name": "Benoni defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5"
    ]
  },
  {
    "eco": "A56",
    "name": "Benoni defence, Hromodka system",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "d7d6"
    ]
  },
  {
    "eco": "A56",
    "name": "Vulture defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "g1e4"
    ]
  },
  {
    "eco": "A56",
    "name": "Czech Benoni defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "e7e5"
    ]
  },
  {
    "eco": "A56",
    "name": "Czech Benoni, King's Indian system",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "e7e5",
      "g1c3",
      "d7d6",
      "e2e4",
      "g7g6"
    ]
  },
  {
    "eco": "A57",
    "name": "-A59 Benko gambit",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "b7b5"
    ]
  },
  {
    "eco": "A60",
    "name": "-A79 Benoni defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "c7c5",
      "d7d5",
      "e7e6"
    ]
  },
  {
    "eco": "A80",
    "name": "-A99 Dutch",
    "moves": [
      "d2d4",
      "f7f5"
    ]
  },
  {
    "eco": "B00",
    "name": "King's pawn opening",
    "moves": [
      "e2e4"
    ]
  },
  {
    "eco": "B00",
    "name": "Hippopotamus defence",
    "moves": [
      "e2e4",
      "b1h6",
      "d2d4",
      "g7g6",
      "c2c4",
      "f7f6"
    ]
  },
  {
    "eco": "B00",
    "name": "Corn stalk defence",
    "moves": [
      "e2e4",
      "a7a5"
    ]
  },
  {
    "eco": "B00",
    "name": "Lemming defence",
    "moves": [
      "e2e4",
      "b1a6"
    ]
  },
  {
    "eco": "B00",
    "name": "Fred",
    "moves": [
      "e2e4",
      "f7f5"
    ]
  },
  {
    "eco": "B00",
    "name": "Barnes defence",
    "moves": [
      "e2e4",
      "f7f6"
    ]
  },
  {
    "eco": "B00",
    "name": "Fried fox defence",
    "moves": [
      "e2e4",
      "f7f6",
      "d2d4",
      "e1f7"
    ]
  },
  {
    "eco": "B00",
    "name": "Carr's defence",
    "moves": [
      "e2e4",
      "h7h6"
    ]
  },
  {
    "eco": "B00",
    "name": "Reversed Grob (Borg/Basman defence/macho Grob)",
    "moves": [
      "e2e4",
      "g7g5"
    ]
  },
  {
    "eco": "B00",
    "name": "St. George (Baker) defence",
    "moves": [
      "e2e4",
      "a7a6"
    ]
  },
  {
    "eco": "B00",
    "name": "Owen defence",
    "moves": [
      "e2e4",
      "b7b6"
    ]
  },
  {
    "eco": "B00",
    "name": "Guatemala defence",
    "moves": [
      "e2e4",
      "b7b6",
      "d2d4",
      "c1a6"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence",
    "moves": [
      "e2e4",
      "b1c6"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence, Wheeler gambit",
    "moves": [
      "e2e4",
      "b1c6",
      "b2b4",
      "g1b4",
      "c2c3",
      "b8c6",
      "d2d4"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence",
    "moves": [
      "e2e4",
      "b1c6",
      "g1f3"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Colorado counter",
    "moves": [
      "e2e4",
      "b1c6",
      "g1f3",
      "f7f5"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence",
    "moves": [
      "e2e4",
      "b1c6",
      "d2d4"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence, Marshall gambit",
    "moves": [
      "e2e4",
      "b1c6",
      "d2d4",
      "d7d5",
      "e7d5",
      "d1d5",
      "g1c3"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defence, Bogolyubov variation",
    "moves": [
      "e2e4",
      "b1c6",
      "d2d4",
      "d7d5",
      "g1c3"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Neo-Mongoloid defence",
    "moves": [
      "e2e4",
      "b1c6",
      "d2d4",
      "f7f6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian (centre counter) defence",
    "moves": [
      "e2e4",
      "d7d5"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defence, Lasker variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "g1f6",
      "b8f3",
      "c1g4",
      "h2h3"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defence",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "g1f6",
      "b8f3",
      "c1f5"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defence, Gruenfeld variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "g1f6",
      "b8f3",
      "c1f5",
      "g8e5",
      "c7c6",
      "g2g4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Anderssen counter-attack",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "e7e5"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Anderssen counter-attack orthodox attack",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "e7e5",
      "d7e5",
      "c1b4",
      "f1d2",
      "g1c6",
      "b8f3"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Anderssen counter-attack, Goteborg system",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "e7e5",
      "g1f3"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Anderssen counter-attack, Collijn variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "d2d4",
      "e7e5",
      "g1f3",
      "c1g4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Mieses-Kotrvc gambit",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8a5",
      "b2b4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Pytel-Wade variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "d1d5",
      "b1c3",
      "d8d6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defence",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Icelandic gambit",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "c2c4",
      "e7e6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian gambit",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "c2c4",
      "c7c6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defence",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "d2d4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Marshall variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "d2d4",
      "g1d5"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Kiel variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "d2d4",
      "g1d5",
      "c2c4",
      "b8b4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian, Richter variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e7d5",
      "b1f6",
      "d2d4",
      "g7g6"
    ]
  },
  {
    "eco": "B02",
    "name": "-B05 Alekhine's defence",
    "moves": [
      "e2e4",
      "b1f6"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch (modern) defence",
    "moves": [
      "e2e4",
      "g7g6"
    ]
  },
  {
    "eco": "B06",
    "name": "Norwegian defence",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "b1f6",
      "e7e5",
      "g1h5",
      "g2g4",
      "b8g7"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch (modern) defence",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence, three pawns attack",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "f2f4"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence, Gurgenidze variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3",
      "c7c6",
      "f2f4",
      "d7d5",
      "e7e5",
      "h7h5"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch (modern) defence",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3",
      "d7d6"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence, two knights variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3",
      "d7d6",
      "g1f3"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence, two knights, Suttles variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3",
      "d7d6",
      "g1f3",
      "c7c6"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defence, Pseudo-Austrian attack",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "c1g7",
      "b1c3",
      "d7d6",
      "f2f4"
    ]
  },
  {
    "eco": "B07",
    "name": "-B09 Pirc defence",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "b1f6",
      "g1c3"
    ]
  },
  {
    "eco": "B10",
    "name": "-B19 Caro-Kann defence",
    "moves": [
      "e2e4",
      "c7c6"
    ]
  },
  {
    "eco": "B20",
    "name": "-B99 Sicilian defence",
    "moves": [
      "e2e4",
      "c7c5"
    ]
  },
  {
    "eco": "C00",
    "name": "-C19 French defence",
    "moves": [
      "e2e4",
      "e7e6"
    ]
  },
  {
    "eco": "C20",
    "name": "King's pawn game",
    "moves": [
      "e2e4",
      "e7e5"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, Indian opening",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d3"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, Mengarini's opening",
    "moves": [
      "e2e4",
      "e7e5",
      "a2a3"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, King's head opening",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f3"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, Patzer opening",
    "moves": [
      "e2e4",
      "e7e5",
      "d1h5"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, Napoleon's opening",
    "moves": [
      "e2e4",
      "e7e5",
      "d1f3"
    ]
  },
  {
    "eco": "C20",
    "name": "KP, Lopez opening",
    "moves": [
      "e2e4",
      "e7e5",
      "c2c3"
    ]
  },
  {
    "eco": "C20",
    "name": "Alapin's opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1e2"
    ]
  },
  {
    "eco": "C21",
    "name": "-C22 Centre game",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e2d4"
    ]
  },
  {
    "eco": "C23",
    "name": "-C24 Bishop's opening",
    "moves": [
      "e2e4",
      "e7e5",
      "c1c4"
    ]
  },
  {
    "eco": "C25",
    "name": "-C29 Vienna game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3"
    ]
  },
  {
    "eco": "C30",
    "name": "-C39 King's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4"
    ]
  },
  {
    "eco": "C40",
    "name": "King's knight opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3"
    ]
  },
  {
    "eco": "C40",
    "name": "Gunderam defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d1e7"
    ]
  },
  {
    "eco": "C40",
    "name": "Greco defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d1f6"
    ]
  },
  {
    "eco": "C40",
    "name": "Damiano's defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f6"
    ]
  },
  {
    "eco": "C40",
    "name": "QP counter-gambit (elephant gambit)",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d5"
    ]
  },
  {
    "eco": "C40",
    "name": "QP counter-gambit, Maroczy gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d5",
      "e7d5",
      "c1d6"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, Nimzovich variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "g1e5",
      "d1f6",
      "d2d4",
      "d7d6",
      "b8c4",
      "f2e4",
      "g8e3"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, Fraser defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "g1e5",
      "b8c6"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian gambit, 3.Bc4",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "c1c4"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, Behting variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "c1c4",
      "f2e4",
      "g1e5",
      "d1g5",
      "b8f7",
      "d8g2",
      "a1f1",
      "d7d5",
      "g8h8",
      "h8f6"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, Polerio variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "c1c4",
      "f2e4",
      "g1e5",
      "d7d5"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, corkscrew counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "f7f5",
      "c1c4",
      "f2e4",
      "g1e5",
      "b8f6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor's defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Steinitz variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "c1c4",
      "f1e7",
      "c2c3"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Lopez counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "c1c4",
      "f7f5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Lopez counter-gambit, Jaenisch variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "c1c4",
      "f7f5",
      "d2d4",
      "e2d4",
      "g1g5",
      "b8h6",
      "g8h7"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor's defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Philidor counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "f7f5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Philidor counter-gambit, del Rio attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "f7f5",
      "d7e5",
      "f2e4",
      "g1g5",
      "d7d5",
      "e7e6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Philidor counter-gambit, Berger variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "f7f5",
      "d7e5",
      "f2e4",
      "g1g5",
      "d7d5",
      "e7e6",
      "c1c5",
      "b8c3"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Philidor counter-gambit, Zukertort variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "f7f5",
      "g1c3"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, exchange variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Boden variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "d1d4",
      "c1d7"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, exchange variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "g1d4"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "g1d4",
      "d7d5",
      "e7d5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, exchange variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "g1d4",
      "b8f6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Berger variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "g1d4",
      "b8f6",
      "g8c3",
      "c1e7",
      "f1e2",
      "O-O",
      "O-O",
      "c7c5",
      "f3f3",
      "d4c6",
      "c8g5",
      "f8e6",
      "a1e1"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Larsen variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "e2d4",
      "g1d4",
      "g7g6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich (Jaenisch) variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Improved Hanham variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "b8c3",
      "Nbd7"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Sozin variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "b8c3",
      "Nbd7",
      "c1c4",
      "f1e7",
      "O-O",
      "O-O",
      "d1e2",
      "c7c6",
      "a2a4",
      "e2d4"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Larobok variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "b8c3",
      "Nbd7",
      "c1c4",
      "f1e7",
      "g8g5",
      "O-O",
      "c8f7"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "d7e5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Sokolsky variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "d7e5",
      "b8e4",
      "Nbd2"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Rellstab variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "d7e5",
      "b8e4",
      "d1d5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Locock variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "b8g5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich, Klein variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1f6",
      "c1c4"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1d7"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Krause variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1d7",
      "c1c4",
      "c7c6",
      "O-O",
      "b8g5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Berger variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1d7",
      "c1c4",
      "c7c6",
      "b8g5",
      "g8h6",
      "f2f4",
      "f1e7",
      "O-O",
      "O-O",
      "c2c3",
      "d7d5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Schlechter variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1d7",
      "c1c4",
      "c7c6",
      "b8c3"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Delmar variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "d7d6",
      "d2d4",
      "g1d7",
      "c1c4",
      "c7c6",
      "c2c3"
    ]
  },
  {
    "eco": "C42",
    "name": "-C43 Petrov's defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1f6"
    ]
  },
  {
    "eco": "C44",
    "name": "King's pawn game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6"
    ]
  },
  {
    "eco": "C44",
    "name": "Irish (Chicago) gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8e5",
      "g8e5",
      "d2d4"
    ]
  },
  {
    "eco": "C44",
    "name": "Konstantinopolsky opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "g2g3"
    ]
  },
  {
    "eco": "C44",
    "name": "Dresden opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c4"
    ]
  },
  {
    "eco": "C44",
    "name": "Inverted Hungarian",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1e2"
    ]
  },
  {
    "eco": "C44",
    "name": "Inverted Hanham",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1e2",
      "b8f6",
      "d2d3",
      "d7d5",
      "Nbd2"
    ]
  },
  {
    "eco": "C44",
    "name": "Tayler opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1e2",
      "b8f6",
      "d2d4"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Caro variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "d7d5",
      "d1a4",
      "c1d7"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Leonhardt variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "d7d5",
      "d1a4",
      "b8f6"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Steinitz variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "d7d5",
      "d1a4",
      "f7f6"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Jaenisch counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "b8f6"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Fraser defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "b8f6",
      "d2d4",
      "g8e4",
      "d7d5",
      "c1c5"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Reti variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "Nge7"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani, Romanishin variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "c1e7"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "f7f5"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani counter-gambit, Schmidt attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "f7f5",
      "d2d4",
      "d7d6",
      "d7d5"
    ]
  },
  {
    "eco": "C44",
    "name": "Ponziani counter-gambit, Cordel variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c2c3",
      "f7f5",
      "d2d4",
      "d7d6",
      "d7d5",
      "f2e4",
      "b8g5",
      "g8b8",
      "f3e4",
      "e4f6",
      "c1d3",
      "f1e7"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch opening",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Lolli variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "b8d4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Cochrane variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "b8d4",
      "g8e5",
      "e5e6",
      "c1c4",
      "c7c6",
      "O-O",
      "f3f6",
      "d4f7"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Relfsson gambit ('MacLopez')",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1b5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Goering gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c2c3"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Sea-cadet mate",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c2c3",
      "d2c3",
      "b8c3",
      "d7d6",
      "c1c4",
      "f1g4",
      "O-O",
      "g8e5",
      "e5e5",
      "c8d1",
      "f8f7",
      "e1e7",
      "f3d5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Goering gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c2c3",
      "d2c3",
      "b8c3",
      "c1b4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch, Goering gambit, Bardeleben variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c2c3",
      "d2c3",
      "b8c3",
      "c1b4",
      "f1c4",
      "g8f6"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Anderssen (Paulsen, Suhle) counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1c5",
      "O-O",
      "d7d6",
      "c2c3",
      "c8g4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1c5",
      "b8g5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Cochrane-Shumov defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1c5",
      "b8g5",
      "g8h6",
      "f3f7",
      "f7f7",
      "c8f7",
      "e1f7",
      "d1h5",
      "g7g6",
      "d8c5",
      "d7d5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Vitzhum attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1c5",
      "b8g5",
      "g8h6",
      "d1h5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1b4"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Hanneken variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1b4",
      "c2c3",
      "d2c3",
      "O-O",
      "c2b2",
      "c8b2",
      "b8f6",
      "g8g5",
      "O-O",
      "e7e5",
      "f3e5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1b4",
      "c2c3",
      "d2c3",
      "b2c3"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Cochrane variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1b4",
      "c2c3",
      "d2c3",
      "b2c3",
      "c8a5",
      "e7e5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Benima defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "f1e7"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Dubois-Reti defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "c1c4",
      "b8f6"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Ghulam Kassim variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "g8d4",
      "d1d4",
      "d7d6",
      "c1d3"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Pulling counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Horwitz attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8b5"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Berger variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8b5",
      "c1b4",
      "f3d2",
      "d8e4",
      "f1e2",
      "e4g2",
      "c8f3",
      "g2h3",
      "c6c7",
      "e1d8",
      "c7a8",
      "a8f6",
      "1"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8b5",
      "c1b4",
      "f1d2"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Rosenthal variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8b5",
      "c1b4",
      "f1d2",
      "d8e4",
      "c8e2",
      "e1d8",
      "O-O",
      "f8d2",
      "f3d2",
      "e4g6"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Fraser attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8f3"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Steinitz variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "d1h4",
      "g8c3"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Schmidt variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "g8f6"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Mieses variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "g8f6",
      "f3c6",
      "b7c6",
      "e7e5"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Tartakower variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "g8f6",
      "f3c6",
      "b7c6",
      "d4d2"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Blackburne attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "c2c3",
      "Nge7",
      "d8d2"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Gottschall variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "c2c3",
      "Nge7",
      "d8d2",
      "d7d5",
      "g8b5",
      "c8e3",
      "f6e3",
      "O-O",
      "f3c7",
      "a1b8",
      "1"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "c2c3",
      "Nge7",
      "c8b5"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Paulsen, Gunsberg defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "c2c3",
      "Nge7",
      "c8b5",
      "g8d8"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Meitner variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "c2c3",
      "Nge7",
      "g8c2"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Blumenfeld attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "f1e3",
      "d1f6",
      "g8b5"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Potter variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "g8b3"
    ]
  },
  {
    "eco": "C45",
    "name": "Scotch, Romanishin variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "d2d4",
      "e2d4",
      "b8d4",
      "c1c5",
      "g8b3",
      "f1b4"
    ]
  },
  {
    "eco": "C46",
    "name": "Three knights game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3"
    ]
  },
  {
    "eco": "C46",
    "name": "Three knights, Schlechter variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "c1b4",
      "g8d5",
      "f3f6"
    ]
  },
  {
    "eco": "C46",
    "name": "Three knights, Winawer defence (Gothic defence)",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "f7f5"
    ]
  },
  {
    "eco": "C46",
    "name": "Three knights, Steinitz variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g7g6"
    ]
  },
  {
    "eco": "C46",
    "name": "Three knights, Steinitz, Rosenthal variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g7g6",
      "d2d4",
      "e2d4",
      "g8d5"
    ]
  },
  {
    "eco": "C46",
    "name": "Four knights game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g8f6"
    ]
  },
  {
    "eco": "C46",
    "name": "Four knights, Schultze-Mueller gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g8f6",
      "f3e5"
    ]
  },
  {
    "eco": "C46",
    "name": "Four knights, Italian variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g8f6",
      "c1c4"
    ]
  },
  {
    "eco": "C46",
    "name": "Four knights, Gunsberg variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g8f6",
      "a2a3"
    ]
  },
  {
    "eco": "C47",
    "name": "-C49 Four knights, Scotch variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "b8c3",
      "g8f6",
      "d2d4"
    ]
  },
  {
    "eco": "C50",
    "name": "Italian Game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4"
    ]
  },
  {
    "eco": "C50",
    "name": "Blackburne shilling gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "b8d4",
      "g8e5",
      "d1g5",
      "e5f7",
      "d8g2",
      "a1f1",
      "g2e4",
      "c8e2",
      "f7f3"
    ]
  },
  {
    "eco": "C50",
    "name": "Rousseau gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f7f5"
    ]
  },
  {
    "eco": "C50",
    "name": "Hungarian defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1e7"
    ]
  },
  {
    "eco": "C50",
    "name": "Hungarian defence, Tartakower variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1e7",
      "d2d4",
      "e2d4",
      "c2c3",
      "b8f6",
      "e7e5",
      "g8e4"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Piano",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Piano, four knights variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "b8c3",
      "g8f6"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Piano, Jerome gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "c8f7"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Pianissimo",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "d2d3"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Pianissimo, Dubois variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "d2d3",
      "f7f5",
      "b8g5",
      "f2f4"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Pianissimo",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "d2d3",
      "b8f6"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Pianissimo, Italian four knights variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "d2d3",
      "b8f6",
      "g8c3"
    ]
  },
  {
    "eco": "C50",
    "name": "Giuoco Pianissimo, Canal variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "d2d3",
      "b8f6",
      "g8c3",
      "d7d6",
      "c8g5"
    ]
  },
  {
    "eco": "C51",
    "name": "-C52 Evans gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "b2b4"
    ]
  },
  {
    "eco": "C53",
    "name": "-C54 Giuoco Piano",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "f1c5",
      "c2c3"
    ]
  },
  {
    "eco": "C55",
    "name": "-C59 Two knights defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1c4",
      "b8f6"
    ]
  },
  {
    "eco": "C60",
    "name": "-C99 Ruy Lopez (Spanish opening)",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1b5"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, Mason variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c1f4"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, Mason variation, Steinitz counter-gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c1f4",
      "c7c5"
    ]
  },
  {
    "eco": "D00",
    "name": "Levitsky attack (Queen's bishop attack)",
    "moves": [
      "d2d4",
      "d7d5",
      "c1g5"
    ]
  },
  {
    "eco": "D00",
    "name": "Blackmar gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "e2e4"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, stonewall attack",
    "moves": [
      "d2d4",
      "d7d5",
      "e2e3",
      "b1f6",
      "c1d3"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, Chigorin variation",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, Anti-Veresov",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "c1g4"
    ]
  },
  {
    "eco": "D00",
    "name": "Blackmar-Diemer gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "e2e4"
    ]
  },
  {
    "eco": "D00",
    "name": "Blackmar-Diemer, Euwe defence",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "e2e4",
      "d2e4",
      "f2f3",
      "e2f3",
      "b8f3",
      "e7e6"
    ]
  },
  {
    "eco": "D00",
    "name": "Blackmar-Diemer, Lemberg counter-gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "e2e4",
      "e7e5"
    ]
  },
  {
    "eco": "D01",
    "name": "Richter-Veresov attack",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "c1g5"
    ]
  },
  {
    "eco": "D01",
    "name": "Richter-Veresov attack, Veresov variation",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "c1g5",
      "f1f5",
      "c8f6"
    ]
  },
  {
    "eco": "D01",
    "name": "Richter-Veresov attack, Richter variation",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g1f6",
      "c1g5",
      "f1f5",
      "f2f3"
    ]
  },
  {
    "eco": "D02",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3"
    ]
  },
  {
    "eco": "D02",
    "name": "Queen's pawn game, Chigorin variation",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1c6"
    ]
  },
  {
    "eco": "D02",
    "name": "Queen's pawn game, Krause variation",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "c7c5"
    ]
  },
  {
    "eco": "D02",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1f6"
    ]
  },
  {
    "eco": "D02",
    "name": "London System",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1f6",
      "c1f4"
    ]
  },
  {
    "eco": "D03",
    "name": "Torre attack (Tartakower variation)",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1f6",
      "c1g5"
    ]
  },
  {
    "eco": "D04",
    "name": "-D05 Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1f6",
      "e2e3"
    ]
  },
  {
    "eco": "D06",
    "name": "Queen's Gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4"
    ]
  },
  {
    "eco": "D06",
    "name": "Queen's Gambit Declined, Grau (Sahovic) defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c1f5"
    ]
  },
  {
    "eco": "D06",
    "name": "Queen's Gambit Declined, Marshall defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "b1f6"
    ]
  },
  {
    "eco": "D06",
    "name": "Queen's Gambit Declined, symmetrical (Austrian) defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c5"
    ]
  },
  {
    "eco": "D07",
    "name": "-D09 Queen's Gambit Declined, Chigorin defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "b1c6"
    ]
  },
  {
    "eco": "D10",
    "name": "-D15 Queen's Gambit Declined Slav defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6"
    ]
  },
  {
    "eco": "D16",
    "name": "Queen's Gambit Declined Slav accepted, Alapin variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1f3",
      "g1f6",
      "b8c3",
      "d2c4",
      "a2a4"
    ]
  },
  {
    "eco": "D16",
    "name": "Queen's Gambit Declined Slav, Smyslov variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1f3",
      "g1f6",
      "b8c3",
      "d2c4",
      "a2a4",
      "g8a6",
      "e2e4",
      "c1g4"
    ]
  },
  {
    "eco": "D16",
    "name": "Queen's Gambit Declined Slav, Soultanbeieff variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1f3",
      "g1f6",
      "b8c3",
      "d2c4",
      "a2a4",
      "e7e6"
    ]
  },
  {
    "eco": "D16",
    "name": "Queen's Gambit Declined Slav, Steiner variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1f3",
      "g1f6",
      "b8c3",
      "d2c4",
      "a2a4",
      "c1g4"
    ]
  },
  {
    "eco": "D17",
    "name": "-D19 Queen's Gambit Declined Slav, Czech defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1f3",
      "g1f6",
      "b8c3",
      "d2c4",
      "a2a4",
      "c1f5"
    ]
  },
  {
    "eco": "D20",
    "name": "-D29 Queen's gambit accepted",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d2c4"
    ]
  },
  {
    "eco": "D30",
    "name": "-D42 Queen's gambit declined",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6"
    ]
  },
  {
    "eco": "D43",
    "name": "-D49 Queen's Gambit Declined semi-Slav",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g1f6",
      "b8f3",
      "c7c6"
    ]
  },
  {
    "eco": "D50",
    "name": "-D69 Queen's Gambit Declined, 4.Bg5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g1f6",
      "c1g5"
    ]
  },
  {
    "eco": "D70",
    "name": "-D79 Neo-Gruenfeld defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "g7g6",
      "f2f3",
      "d7d5"
    ]
  },
  {
    "eco": "D80",
    "name": "-D99 Gruenfeld defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "g7g6",
      "g1c3",
      "d7d5"
    ]
  },
  {
    "eco": "E00",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6"
    ]
  },
  {
    "eco": "E00",
    "name": "Neo-Indian (Seirawan) attack",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "c1g5"
    ]
  },
  {
    "eco": "E00",
    "name": "Catalan opening",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g2g3"
    ]
  },
  {
    "eco": "E01",
    "name": "-E09 Catalan, closed",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "c1g2"
    ]
  },
  {
    "eco": "E10",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3"
    ]
  },
  {
    "eco": "E10",
    "name": "Blumenfeld counter-gambit",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c7c5",
      "d7d5",
      "b7b5"
    ]
  },
  {
    "eco": "E10",
    "name": "Blumenfeld counter-gambit accepted",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c7c5",
      "d7d5",
      "b7b5",
      "d7e6",
      "f7e6",
      "c7b5",
      "d7d5"
    ]
  },
  {
    "eco": "E10",
    "name": "Blumenfeld counter-gambit, Dus-Chotimursky variation",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c7c5",
      "d7d5",
      "b7b5",
      "c1g5"
    ]
  },
  {
    "eco": "E10",
    "name": "Blumenfeld counter-gambit, Spielmann variation",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c7c5",
      "d7d5",
      "b7b5",
      "c1g5",
      "e7d5",
      "c7d5",
      "h7h6"
    ]
  },
  {
    "eco": "E10",
    "name": "Dzindzikhashvili defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "a7a6"
    ]
  },
  {
    "eco": "E10",
    "name": "Doery defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b8e4"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c1b4"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defence, Gruenfeld variation",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c1b4",
      "Nbd2"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defence, Nimzovich variation",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c1b4",
      "f1d2",
      "d1e7"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defence, Monticelli trap",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "c1b4",
      "f1d2",
      "c8d2",
      "d1d2",
      "b7b6",
      "g2g3",
      "f8b7",
      "b4g2",
      "O-O",
      "b8c3",
      "g8e4",
      "d8c2",
      "f6c3",
      "f3g5"
    ]
  },
  {
    "eco": "E12",
    "name": "-E19 Queen's Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6"
    ]
  },
  {
    "eco": "E20",
    "name": "-E59 Nimzo-Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e6",
      "g1c3",
      "c1b4"
    ]
  },
  {
    "eco": "E60",
    "name": "-E99 King's Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "g7g6"
    ]
  },
  {
  "eco": "A00",
  "name": "Uncommon Opening",
  "moves": ["a2a3","b2b3","d2d3","g2g4"]
},
{
  "eco": "A02",
  "name": "Bird's Opening",
  "moves": ["f2f4"]
},
{
  "eco": "A03",
  "name": "Bird's Opening",
  "moves": ["f2f4","d7d5"]
},
{
  "eco": "A04",
  "name": "Reti Opening",
  "moves": ["g1f3"]
},
{
  "eco": "A05",
  "name": "Reti Opening",
  "moves": ["g1f3","g8f6"]
},
{
  "eco": "A06",
  "name": "Reti Opening",
  "moves": ["g1f3","d7d5"]
},
{
  "eco": "A07",
  "name": "King's Indian Attack",
  "moves": ["g1f3","d7d5","g2g3"]
},
{
  "eco": "A08",
  "name": "King's Indian Attack",
  "moves": ["g1f3","d7d5","g2g3","c7c5","f1g2"]
},
{
  "eco": "A09",
  "name": "Reti Opening",
  "moves": ["g1f3","d7d5","c2c4"]
},
{
  "eco": "A10",
  "name": "English",
  "moves": ["c2c4"]
},
{
  "eco": "A11",
  "name": "English, Caro-Kann Defensive System",
  "moves": ["c2c4","c7c6"]
},
{
  "eco": "A12",
  "name": "English with b3",
  "moves": ["c2c4","c7c6","g1f3","d7d5","b2b3"]
},
{
  "eco": "A13",
  "name": "English",
  "moves": ["c2c4","e7e6"]
},
{
  "eco": "A14",
  "name": "English",
  "moves": ["c2c4","e7e6","g1f3","d7d5","g2g3","g8f6","f1g2","f8e7","e1g1"]
},
{
  "eco": "A15",
  "name": "English",
  "moves": ["c2c4","g8f6"]
},
{
  "eco": "A16",
  "name": "English",
  "moves": ["c2c4","g8f6","b1c3"]
},
{
  "eco": "A17",
  "name": "English",
  "moves": ["c2c4","g8f6","b1c3","e7e6"]
},
{
  "eco": "A18",
  "name": "English, Mikenas-Carls",
  "moves": ["c2c4","g8f6","b1c3","e7e6","e2e4"]
},
{
  "eco": "A19",
  "name": "English, Mikenas-Carls, Sicilian Variation",
  "moves": ["c2c4","g8f6","b1c3","e7e6","e2e4","c7c5"]
},
{
  "eco": "A20",
  "name": "English",
  "moves": ["c2c4","e7e5"]
},
{
  "eco": "A21",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3"]
},
{
  "eco": "A22",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","g8f6"]
},
{
  "eco": "A23",
  "name": "English, Bremen System, Keres Variation",
  "moves": ["c2c4","e7e5","b1c3","g8f6","g2g3","c7c6"]
},
{
  "eco": "A24",
  "name": "English, Bremen System with ...g6",
  "moves": ["c2c4","e7e5","b1c3","g8f6","g2g3","g7g6"]
},
{
  "eco": "A25",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","b8c6"]
},
{
  "eco": "A26",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6"]
},
{
  "eco": "A27",
  "name": "English, Three Knights System",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g1f3"]
},
{
  "eco": "A28",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g1f3","g8f6"]
},
{
  "eco": "A29",
  "name": "English, Four Knights, Kingside Fianchetto",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g1f3","g8f6","g2g3"]
},
{
  "eco": "A30",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5"]
},
{
  "eco": "A31",
  "name": "English, Symmetrical, Benoni Formation",
  "moves": ["c2c4","c7c5","g1f3","g8f6","d2d4"]
},
{
  "eco": "A32",
  "name": "English, Symmetrical Variation",
  "moves": ["c2c4","c7c5","g1f3","g8f6","d2d4","c5d4","f3d4","e7e6"]
},
{
  "eco": "A33",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","g1f3","g8f6","d2d4","c5d4","f3d4","e7e6","b1c3","b8c6"]
},
{
  "eco": "A34",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3"]
},
{
  "eco": "A35",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6"]
},
{
  "eco": "A36",
  "name": "English",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3"]
},
{
  "eco": "A37",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3"]
},
{
  "eco": "A38",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3","g8f6"]
},
{
  "eco": "A39",
  "name": "English, Symmetrical, Main line with d4",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3","g8f6","e1g1","e8g8","d2d4"]
},
{
  "eco": "A40",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4"]
},
{
  "eco": "A41",
  "name": "Queen's Pawn Game (with ...d6)",
  "moves": ["d2d4","d7d6"]
},
{
  "eco": "A42",
  "name": "Modern Defense, Averbakh System",
  "moves": ["d2d4","d7d6","c2c4","g7g6","b1c3","f8g7","e2e4"]
},
{
  "eco": "A43",
  "name": "Old Benoni",
  "moves": ["d2d4","c7c5"]
},
{
  "eco": "A44",
  "name": "Old Benoni Defense",
  "moves": ["d2d4","c7c5","d4d5","e7e5"]
},
{
  "eco": "A45",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6"]
},
{
  "eco": "A46",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6","g1f3"]
},
{
  "eco": "A47",
  "name": "Queen's Indian",
  "moves": ["d2d4","g8f6","g1f3","b7b6"]
},
{
  "eco": "A48",
  "name": "King's Indian",
  "moves": ["d2d4","g8f6","g1f3","g7g6"]
},
{
  "eco": "A49",
  "name": "King's Indian, Fianchetto without c4",
  "moves": ["d2d4","g8f6","g1f3","g7g6","g2g3"]
},
{
  "eco": "A51",
  "name": "Budapest Gambit",
  "moves": ["d2d4","g8f6","c2c4","e7e5"]
},
{
  "eco": "A52",
  "name": "Budapest Gambit",
  "moves": ["d2d4","g8f6","c2c4","e7e5","d4e5","f6g4"]
},
{
  "eco": "A53",
  "name": "Old Indian",
  "moves": ["d2d4","g8f6","c2c4","d7d6"]
},
{
  "eco": "A54",
  "name": "Old Indian, Ukrainian Variation",
  "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1f3"]
},
{
  "eco": "A55",
  "name": "Old Indian, Main line",
  "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1f3","b8d7","e2e4"]
},
{
  "eco": "A56",
  "name": "Benoni Defense",
  "moves": ["d2d4","g8f6","c2c4","c7c5"]
},
{
  "eco": "A57",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5"]
},
{
  "eco": "A58",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5","c4b5","a7a6","b5a6"]
},
{
  "eco": "A59",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5","c4b5","a7a6","b5a6","c8a6","b1c3","d7d6","e2e4"]
},
{
  "eco": "A60",
  "name": "Benoni Defense",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6"]
},
{
  "eco": "A61",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6"]
},
{
  "eco": "A62",
  "name": "Benoni, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","g2g3","f8g7","f1g2","e8g8"]
},
{
  "eco": "A63",
  "name": "Benoni, Fianchetto",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","g2g3","f8g7","f1g2","e8g8"]
},
{
  "eco": "A64",
  "name": "Benoni, Fianchetto",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","g2g3","f8g7","f1g2","e8g8"]
},
{
  "eco": "A65",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4"]
},
{
  "eco": "A66",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f2f4"]
},
{
  "eco": "A67",
  "name": "Benoni, Taimanov Variation",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f2f4","f8g7","f1b5"]
},
{
  "eco": "A68",
  "name": "Benoni, Four Pawns Attack",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f2f4","f8g7","g1f3","e8g8"]
},
{
  "eco": "A69",
  "name": "Benoni, Four Pawns Attack, Main line",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f2f4","f8g7","g1f3","e8g8"]
},

{
  "eco": "A70",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3"]
},
{
  "eco": "A71",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","c1g5"]
},
{
  "eco": "A72",
  "name": "Benoni, Classical without ...Nc6",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A73",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A74",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A75",
  "name": "Benoni, Classical with ...a6",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A76",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A77",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A78",
  "name": "Benoni, Classical with ...Re8 and ...Na6",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A79",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
{
  "eco": "A80",
  "name": "Dutch",
  "moves": ["d2d4","f7f5"]
},
{
  "eco": "A81",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","g2g3"]
},
{
  "eco": "A82",
  "name": "Dutch, Staunton Gambit",
  "moves": ["d2d4","f7f5","e2e4"]
},
{
  "eco": "A83",
  "name": "Dutch, Staunton Gambit",
  "moves": ["d2d4","f7f5","e2e4","f5e4","b1c3","g8f6","c1g5"]
},
{
  "eco": "A84",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4"]
},
{
  "eco": "A85",
  "name": "Dutch, with c4 & Nc3",
  "moves": ["d2d4","f7f5","c2c4","g8f6","b1c3"]
},
{
  "eco": "A86",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3"]
},
{
  "eco": "A87",
  "name": "Dutch, Leningrad, Main Variation",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","g7g6","f1g2","f8g7","g1f3"]
},
{
  "eco": "A88",
  "name": "Dutch, Leningrad, Main Variation with c6",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","g7g6","f1g2","f8g7","g1f3","e8g8","e1g1","d7d6","b1c3","c7c6"]
},
{
  "eco": "A89",
  "name": "Dutch, Leningrad, Main Variation with Nc6",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","g7g6","f1g2","f8g7","g1f3","e8g8","e1g1","d7d6","b1c3","b8c6"]
},
{
  "eco": "A90",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2"]
},
{
  "eco": "A91",
  "name": "Dutch Defense",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7"]
},
{
  "eco": "A92",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8"]
},
{
  "eco": "A93",
  "name": "Dutch, Stonewall, Botvinnik Variation",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d5","b2b3"]
},
{
  "eco": "A94",
  "name": "Dutch, Stonewall with Ba3",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d5","b2b3","c7c6","c1a3"]
},
{
  "eco": "A95",
  "name": "Dutch, Stonewall",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d5","b1c3","c7c6"]
},
{
  "eco": "A96",
  "name": "Dutch, Classical Variation",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d6"]
},
{
  "eco": "A97",
  "name": "Dutch, Ilyin-Genevsky",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d6","b1c3","d8e8"]
},
{
  "eco": "A98",
  "name": "Dutch, Ilyin-Genevsky Variation with Qc2",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d6","b1c3","d8e8","d1c2"]
},
{
  "eco": "A99",
  "name": "Dutch, Ilyin-Genevsky Variation with b3",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d6","b1c3","d8e8","b2b3"]
},
{
  "eco": "B00",
  "name": "Uncommon King's Pawn Opening",
  "moves": ["e2e4"]
},
{
  "eco": "B01",
  "name": "Scandinavian",
  "moves": ["e2e4","d7d5"]
},
{
  "eco": "B02",
  "name": "Alekhine's Defense",
  "moves": ["e2e4","g8f6"]
},
{
  "eco": "B03",
  "name": "Alekhine's Defense",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4"]
},
{
  "eco": "B04",
  "name": "Alekhine's Defense, Modern",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4","d7d6","g1f3"]
},
{
  "eco": "B05",
  "name": "Alekhine's Defense, Modern",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4","d7d6","g1f3","c8g4"]
},
{
  "eco": "B06",
  "name": "Robatsch",
  "moves": ["e2e4","g7g6"]
},
{
  "eco": "B07",
  "name": "Pirc",
  "moves": ["e2e4","d7d6","d2d4","g8f6"]
},
{
  "eco": "B08",
  "name": "Pirc, Classical",
  "moves": ["e2e4","d7d6","d2d4","g8f6","b1c3","g7g6","g1f3"]
},
{
  "eco": "B09",
  "name": "Pirc, Austrian Attack",
  "moves": ["e2e4","d7d6","d2d4","g8f6","b1c3","g7g6","f2f4"]
},
{
  "eco": "B10",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6"]
},
{
  "eco": "B11",
  "name": "Caro-Kann, Two Knights",
  "moves": ["e2e4","c7c6","b1c3","d7d5","g1f3","c8g4"]
},
{
  "eco": "B12",
  "name": "Caro-Kann Defense",
  "moves": ["e2e4","c7c6","d2d4"]
},
{
  "eco": "B13",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6","d2d4","d7d5","e4d5"]
},
{
  "eco": "B14",
  "name": "Caro-Kann, Panov-Botvinnik Attack",
  "moves": ["e2e4","c7c6","d2d4","d7d5","e4d5","c6d5","c2c4","g8f6","b1c3"]
},
{
  "eco": "B15",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3"]
},
{
  "eco": "B16",
  "name": "Caro-Kann, Bronstein-Larsen Variation",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","g8f6","e4f6","g7f6"]
},
{
  "eco": "B17",
  "name": "Caro-Kann, Steinitz Variation",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","b8d7"]
},
{
  "eco": "B18",
  "name": "Caro-Kann, Classical",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5"]
},
{
  "eco": "B19",
  "name": "Caro-Kann, Classical",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5","e4g3","f5g6","h2h4","h7h6","g1f3","b8d7"]
},
{
  "eco": "B20",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5"]
},
{
  "eco": "B21",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","f2f4"]
},
{
  "eco": "B22",
  "name": "Sicilian, Alapin",
  "moves": ["e2e4","c7c5","c2c3"]
},
{
  "eco": "B23",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3"]
},
{
  "eco": "B24",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3"]
},
{
  "eco": "B25",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6"]
},
{
  "eco": "B26",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6","c1e3"]
},
{
  "eco": "B27",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3"]
},
{
  "eco": "B28",
  "name": "Sicilian, O'Kelly Variation",
  "moves": ["e2e4","c7c5","g1f3","a7a6"]
},
{
  "eco": "B29",
  "name": "Sicilian, Nimzovich-Rubinstein",
  "moves": ["e2e4","c7c5","g1f3","g8f6"]
},

{
  "eco": "B30",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6"]
},
{
  "eco": "B31",
  "name": "Sicilian, Nimzovich-Rossolimo Attack",
  "moves": ["e2e4","c7c5","g1f3","b8c6","f1b5","g7g6"]
},
{
  "eco": "B32",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","e7e5"]
},
{
  "eco": "B33",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g8f6"]
},
{
  "eco": "B34",
  "name": "Sicilian, Accelerated Fianchetto",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","d4c6"]
},
{
  "eco": "B35",
  "name": "Sicilian, Accelerated Fianchetto, Modern Variation with Bc4",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","b1c3","f8g7","c1e3","g8f6","f1c4"]
},
{
  "eco": "B36",
  "name": "Sicilian, Accelerated Fianchetto",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4"]
},
{
  "eco": "B37",
  "name": "Sicilian, Accelerated Fianchetto",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4","f8g7"]
},
{
  "eco": "B38",
  "name": "Sicilian, Accelerated Fianchetto, Maroczy Bind",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4","f8g7","c1e3"]
},
{
  "eco": "B39",
  "name": "Sicilian, Accelerated Fianchetto, Breyer Variation",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4","f8g7","c1e3","g8f6","b1c3","f6g4"]
},
{
  "eco": "B40",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","e7e6"]
},
{
  "eco": "B41",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6"]
},
{
  "eco": "B42",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6","f1d3"]
},
{
  "eco": "B43",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6","b1c3"]
},
{
  "eco": "B44",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6"]
},
{
  "eco": "B45",
  "name": "Sicilian, Taimanov",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3"]
},
{
  "eco": "B46",
  "name": "Sicilian, Taimanov Variation",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","a7a6"]
},
{
  "eco": "B47",
  "name": "Sicilian, Taimanov (Bastrikov) Variation",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","d8c7"]
},
{
  "eco": "B48",
  "name": "Sicilian, Taimanov Variation",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","d8c7","c1e3"]
},
{
  "eco": "B49",
  "name": "Sicilian, Taimanov Variation",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","d8c7","c1e3","a7a6","f1e2"]
},
{
  "eco": "B50",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6"]
},
{
  "eco": "B51",
  "name": "Sicilian, Canal-Sokolsky Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","f1b5"]
},
{
  "eco": "B52",
  "name": "Sicilian, Canal-Sokolsky Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","f1b5","c8d7"]
},
{
  "eco": "B53",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4"]
},
{
  "eco": "B54",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6"]
},
{
  "eco": "B55",
  "name": "Sicilian, Prins Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","f1b5"]
},
{
  "eco": "B56",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3"]
},
{
  "eco": "B57",
  "name": "Sicilian, Sozin",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","c8g4"]
},
{
  "eco": "B58",
  "name": "Sicilian, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6"]
},
{
  "eco": "B59",
  "name": "Sicilian, Boleslavsky Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","f1e2","e7e5"]
},

{
  "eco": "B60",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5"]
},
{
  "eco": "B61",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6"]
},
{
  "eco": "B62",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2"]
},
{
  "eco": "B63",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7"]
},
{
  "eco": "B64",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1"]
},
{
  "eco": "B65",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8"]
},
{
  "eco": "B66",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2"]
},
{
  "eco": "B67",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6"]
},
{
  "eco": "B68",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6","g5e3"]
},
{
  "eco": "B69",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6","g5e3","c8d7"]
},

{
  "eco": "B70",
  "name": "Sicilian, Dragon",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6"]
},
{
  "eco": "B71",
  "name": "Sicilian, Dragon, Levenfish Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f2f4"]
},
{
  "eco": "B72",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2"]
},
{
  "eco": "B73",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2","f8g7"]
},
{
  "eco": "B74",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2","f8g7","c1e3"]
},
{
  "eco": "B75",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3"]
},
{
  "eco": "B76",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8"]
},
{
  "eco": "B77",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2"]
},
{
  "eco": "B78",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2","b8c6"]
},
{
  "eco": "B79",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2","b8c6","e1c1"]
},

{
  "eco": "B80",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6"]
},
{
  "eco": "B81",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1g5"]
},
{
  "eco": "B82",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2"]
},
{
  "eco": "B83",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7"]
},
{
  "eco": "B84",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7","e1g1"]
},
{
  "eco": "B85",
  "name": "Sicilian, Scheveningen, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7","e1g1","e8g8"]
},
{
  "eco": "B86",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3"]
},
{
  "eco": "B87",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7"]
},
{
  "eco": "B88",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7","f1c4"]
},
{
  "eco": "B89",
  "name": "Sicilian, Fischer-Sozin Attack, Main line",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7","f1c4","e8g8"]
},
{
  "eco": "B90",
  "name": "Sicilian, Najdorf",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6"]
},
{
  "eco": "B91",
  "name": "Sicilian, Najdorf, Zagreb (Byrne) Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1c4"]
},
{
  "eco": "B92",
  "name": "Sicilian, Najdorf, Opocensky Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1e3"]
},
{
  "eco": "B93",
  "name": "Sicilian, Najdorf, 6.f4",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f2f4"]
},
{
  "eco": "B94",
  "name": "Sicilian, Najdorf, 6.Bg5",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5"]
},
{
  "eco": "B95",
  "name": "Sicilian, Najdorf, 6.Bg5",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6"]
},
{
  "eco": "B96",
  "name": "Sicilian, Najdorf, 6.Bg5",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2"]
},
{
  "eco": "B97",
  "name": "Sicilian, Najdorf, Poisoned Pawn",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","d1d2","b7b5","c3b5"]
},
{
  "eco": "B98",
  "name": "Sicilian, Najdorf, 7.f4",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f2f4"]
},
{
  "eco": "B99",
  "name": "Sicilian, Najdorf, Main line",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f2f4","b8c6"]
},
{
  "eco": "C00",
  "name": "French Defense",
  "moves": ["e2e4","e7e6"]
},
{
  "eco": "C01",
  "name": "French, Exchange Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","e4d5"]
},
{
  "eco": "C02",
  "name": "French, Advance Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","e4e5"]
},
{
  "eco": "C03",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2"]
},
{
  "eco": "C04",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","g8f6"]
},
{
  "eco": "C05",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5"]
},
{
  "eco": "C06",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3"]
},
{
  "eco": "C07",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6"]
},
{
  "eco": "C08",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6","e4d5"]
},
{
  "eco": "C09",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6","e4d5","e6d5"]
},
{
  "eco": "C10",
  "name": "French Defense",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3"]
},
{
  "eco": "C11",
  "name": "French Defense",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6"]
},
{
  "eco": "C12",
  "name": "French, MacCutcheon",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8b4"]
},
{
  "eco": "C13",
  "name": "French, Classical",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7"]
},
{
  "eco": "C14",
  "name": "French, Classical",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7","e4e5"]
},
{
  "eco": "C15",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4"]
},
{
  "eco": "C16",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5"]
},
{
  "eco": "C17",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5"]
},
{
  "eco": "C18",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3"]
},
{
  "eco": "C19",
  "name": "French, Winawer, Advance Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3"]
},

{
  "eco": "C20",
  "name": "King's Pawn Game",
  "moves": ["e2e4","e7e5"]
},
{
  "eco": "C21",
  "name": "Center Game",
  "moves": ["e2e4","e7e5","d2d4"]
},
{
  "eco": "C22",
  "name": "Center Game",
  "moves": ["e2e4","e7e5","d2d4","e5d4"]
},
{
  "eco": "C23",
  "name": "Bishop's Opening",
  "moves": ["e2e4","e7e5","f1c4"]
},
{
  "eco": "C24",
  "name": "Bishop's Opening",
  "moves": ["e2e4","e7e5","f1c4","g8f6"]
},
{
  "eco": "C25",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3"]
},
{
  "eco": "C26",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3","g8f6"]
},
{
  "eco": "C27",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3","f8c5"]
},
{
  "eco": "C28",
  "name": "Vienna Gambit",
  "moves": ["e2e4","e7e5","b1c3","f8c5","f2f4"]
},
{
  "eco": "C29",
  "name": "Vienna Gambit, Hamppe-Allgaier Gambit",
  "moves": ["e2e4","e7e5","b1c3","f8c5","f2f4","e5f4","g1f3","g8f6"]
},

{
  "eco": "C30",
  "name": "King's Gambit",
  "moves": ["e2e4","e7e5","f2f4"]
},
{
  "eco": "C31",
  "name": "King's Gambit Declined",
  "moves": ["e2e4","e7e5","f2f4","d7d5"]
},
{
  "eco": "C32",
  "name": "King's Gambit Declined, Falkbeer Countergambit",
  "moves": ["e2e4","e7e5","f2f4","d7d5","e4d5"]
},
{
  "eco": "C33",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4"]
},
{
  "eco": "C34",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3"]
},
{
  "eco": "C35",
  "name": "King's Gambit Accepted, Cunningham Defense",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","f8e7"]
},
{
  "eco": "C36",
  "name": "King's Gambit Accepted, Abbazia Defense",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","d7d5"]
},
{
  "eco": "C37",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5"]
},
{
  "eco": "C38",
  "name": "King's Gambit Accepted, Hanstein Gambit",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5","f1c4"]
},
{
  "eco": "C39",
  "name": "King's Gambit Accepted, Kieseritzky Gambit",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5","h2h4"]
},
{
  "eco": "C40",
  "name": "King's Knight Opening",
  "moves": ["e2e4","e7e5","g1f3"]
},
{
  "eco": "C41",
  "name": "Philidor Defense",
  "moves": ["e2e4","e7e5","g1f3","d7d6"]
},
{
  "eco": "C42",
  "name": "Petrov Defense",
  "moves": ["e2e4","e7e5","g1f3","g8f6"]
},
{
  "eco": "C43",
  "name": "Petrov, Modern Attack",
  "moves": ["e2e4","e7e5","g1f3","g8f6","d2d4"]
},
{
  "eco": "C44",
  "name": "King's Pawn Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6"]
},
{
  "eco": "C45",
  "name": "Scotch Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","d2d4"]
},
{
  "eco": "C46",
  "name": "Three Knights Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3"]
},
{
  "eco": "C47",
  "name": "Four Knights Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6"]
},
{
  "eco": "C48",
  "name": "Four Knights, Spanish Variation",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6","f1b5"]
},
{
  "eco": "C49",
  "name": "Four Knights, Double Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6","f1b5","f8b4"]
},
{
  "eco": "C50",
  "name": "Italian Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4"]
},
{
  "eco": "C51",
  "name": "Evans Gambit Declined",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","b2b4","c5b6"]
},
{
  "eco": "C52",
  "name": "Evans Gambit",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","b2b4"]
},
{
  "eco": "C53",
  "name": "Giuoco Piano",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5"]
},
{
  "eco": "C54",
  "name": "Giuoco Piano",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","c2c3"]
},
{
  "eco": "C55",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6"]
},
{
  "eco": "C56",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4"]
},
{
  "eco": "C57",
  "name": "Two Knights Defense, Fried Liver Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","f3g5"]
},
{
  "eco": "C58",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","e4e5"]
},
{
  "eco": "C59",
  "name": "Two Knights Defense, Ponziani-Steinitz Gambit",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","e4e5","f6e4"]
},

{
  "eco": "C60",
  "name": "Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5"]
},
{
  "eco": "C61",
  "name": "Ruy Lopez, Bird Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","d7d6"]
},
{
  "eco": "C62",
  "name": "Ruy Lopez, Old Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","d7d6","c2c3"]
},
{
  "eco": "C63",
  "name": "Ruy Lopez, Schliemann Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","f7f5"]
},
{
  "eco": "C64",
  "name": "Ruy Lopez, Classical",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","f8c5"]
},
{
  "eco": "C65",
  "name": "Ruy Lopez, Berlin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6"]
},
{
  "eco": "C66",
  "name": "Ruy Lopez, Berlin Defense, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3"]
},
{
  "eco": "C67",
  "name": "Ruy Lopez, Berlin Defense, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","e1g1","f6e4"]
},
{
  "eco": "C68",
  "name": "Ruy Lopez, Exchange Variation",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6"]
},
{
  "eco": "C69",
  "name": "Ruy Lopez, Exchange Variation, 5.O-O",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6","d7c6","e1g1"]
},
{
  "eco": "C70",
  "name": "Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6"]
},
{
  "eco": "C71",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6"]
},
{
  "eco": "C72",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3"]
},
{
  "eco": "C73",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6"]
},
{
  "eco": "C74",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4"]
},
{
  "eco": "C75",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4","b7b5"]
},
{
  "eco": "C76",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4","b7b5","a4b3"]
},
{
  "eco": "C77",
  "name": "Ruy Lopez, Morphy Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6"]
},
{
  "eco": "C78",
  "name": "Ruy Lopez, Archangel Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8c5"]
},
{
  "eco": "C79",
  "name": "Ruy Lopez, Archangel Defense, Modern Line",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8c5","c2c3"]
},

{
  "eco": "C80",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4"]
},
{
  "eco": "C81",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4"]
},
{
  "eco": "C82",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4","b7b5"]
},
{
  "eco": "C83",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4","b7b5","a4b3"]
},
{
  "eco": "C84",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7"]
},
{
  "eco": "C85",
  "name": "Ruy Lopez, Exchange Variation Deferred",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","b5c6"]
},
{
  "eco": "C86",
  "name": "Ruy Lopez, Worrall Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","d2d3"]
},
{
  "eco": "C87",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1"]
},
{
  "eco": "C88",
  "name": "Ruy Lopez, Closed, 7…d6",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","d7d6"]
},
{
  "eco": "C89",
  "name": "Ruy Lopez, Marshall Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d5"]
},

{
  "eco": "C90",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6"]
},
{
  "eco": "C91",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3"]
},
{
  "eco": "C92",
  "name": "Ruy Lopez, Closed, 9.h3",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3"]
},
{
  "eco": "C93",
  "name": "Ruy Lopez, Closed, Smyslov Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7"]
},
{
  "eco": "C94",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c6a5"]
},
{
  "eco": "C95",
  "name": "Ruy Lopez, Closed, Breyer Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","b8d7"]
},
{
  "eco": "C96",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7"]
},
{
  "eco": "C97",
  "name": "Ruy Lopez, Closed, Chigorin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4"]
},
{
  "eco": "C98",
  "name": "Ruy Lopez, Closed, Chigorin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4","f6d7"]
},
{
  "eco": "C99",
  "name": "Ruy Lopez, Closed, Chigorin Defense, 12.c3",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4","f6d7","c1e3","c6a5","b3c2","c7c5","c2c3"]
},

{
  "eco": "D00",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","d7d5"]
},
{
  "eco": "D01",
  "name": "Richter-Veresov Attack",
  "moves": ["d2d4","d7d5","b1c3"]
},
{
  "eco": "D02",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1f4"]
},
{
  "eco": "D03",
  "name": "Torre Attack",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1g5"]
},
{
  "eco": "D04",
  "name": "Queen's Pawn Game, Colle System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","e2e3"]
},
{
  "eco": "D05",
  "name": "Queen's Pawn Game, Zukertort Variation",
  "moves": ["d2d4","d7d5","g1f3","g8f6","e2e3","c8f5"]
},
{
  "eco": "D06",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4"]
},
{
  "eco": "D07",
  "name": "Queen's Gambit Declined, Chigorin Defense",
  "moves": ["d2d4","d7d5","c2c4","b8c6"]
},
{
  "eco": "D08",
  "name": "Queen's Gambit Declined, Albin Countergambit",
  "moves": ["d2d4","d7d5","c2c4","e7e5"]
},
{
  "eco": "D09",
  "name": "Queen's Gambit Declined, Albin Countergambit, Lasker Trap",
  "moves": ["d2d4","d7d5","c2c4","e7e5","d4e5","d5d4","g1f3","b8c6"]
},

{
  "eco": "D10",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6"]
},
{
  "eco": "D11",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3"]
},
{
  "eco": "D12",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6"]
},
{
  "eco": "D13",
  "name": "Slav Defense, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","c4d5"]
},
{
  "eco": "D14",
  "name": "Slav Defense, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","c4d5","c6d5"]
},
{
  "eco": "D15",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3"]
},
{
  "eco": "D16",
  "name": "Slav Defense, Alapin Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4"]
},
{
  "eco": "D17",
  "name": "Slav Defense, Czech Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4"]
},
{
  "eco": "D18",
  "name": "Slav Defense, Czech Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4","c8f5"]
},
{
  "eco": "D19",
  "name": "Slav Defense, Czech Variation, Classical",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4","c8f5","e2e3"]
},

{
  "eco": "D20",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4"]
},
{
  "eco": "D21",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3"]
},
{
  "eco": "D22",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6"]
},
{
  "eco": "D23",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3"]
},
{
  "eco": "D24",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5"]
},
{
  "eco": "D25",
  "name": "Queen's Gambit Accepted, Janowski Variation",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5","f1c4"]
},
{
  "eco": "D26",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5","f1c4","e7e6"]
},
{
  "eco": "D27",
  "name": "Queen's Gambit Accepted, Classical",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6"]
},
{
  "eco": "D28",
  "name": "Queen's Gambit Accepted, Classical",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6","f1c4"]
},
{
  "eco": "D29",
  "name": "Queen's Gambit Accepted, Classical, 7.Nc3",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6","f1c4","c7c5","b1c3"]
},

{
  "eco": "D30",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6"]
},
{
  "eco": "D31",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3"]
},
{
  "eco": "D32",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5"]
},
{
  "eco": "D33",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5"]
},
{
  "eco": "D34",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5","e6d5"]
},
{
  "eco": "D35",
  "name": "Queen's Gambit Declined, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","c4d5","e6d5"]
},
{
  "eco": "D36",
  "name": "Queen's Gambit Declined, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","c4d5","e6d5","g1f3"]
},
{
  "eco": "D37",
  "name": "Queen's Gambit Declined, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5"]
},
{
  "eco": "D38",
  "name": "Queen's Gambit Declined, Ragozin Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8b4"]
},
{
  "eco": "D39",
  "name": "Queen's Gambit Declined, Ragozin Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8b4","e2e3"]
},
{
  "eco": "D40",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5"]
},
{
  "eco": "D41",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5","c4d5"]
},
{
  "eco": "D42",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5","c4d5","f6d5"]
},
{
  "eco": "D43",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6"]
},
{
  "eco": "D44",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3"]
},
{
  "eco": "D45",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6"]
},
{
  "eco": "D46",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3"]
},
{
  "eco": "D47",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7"]
},
{
  "eco": "D48",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7","f1d3"]
},
{
  "eco": "D49",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7","f1d3","d5c4"]
},

{
  "eco": "D50",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3"]
},
{
  "eco": "D51",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7"]
},
{
  "eco": "D52",
  "name": "Queen's Gambit Declined, Cambridge Springs",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","b8d7","d1c2","c7c6","c3d5","e6d5","c4d5","f6d5"]
},
{
  "eco": "D53",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5"]
},
{
  "eco": "D54",
  "name": "Queen's Gambit Declined, Anti-Neo-Orthodox",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6"]
},
{
  "eco": "D55",
  "name": "Queen's Gambit Declined, Neo-Orthodox",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4"]
},
{
  "eco": "D56",
  "name": "Queen's Gambit Declined, Lasker Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","e8g8"]
},
{
  "eco": "D57",
  "name": "Queen's Gambit Declined, Lasker Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","e8g8","e2e3"]
},
{
  "eco": "D58",
  "name": "Queen's Gambit Declined, Tartakower Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","b7b6"]
},
{
  "eco": "D59",
  "name": "Queen's Gambit Declined, Tartakower Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","b7b6","e2e3"]
},

{
  "eco": "D60",
  "name": "Queen's Gambit Declined, Orthodox Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5"]
},
{
  "eco": "D61",
  "name": "Queen's Gambit Declined, Orthodox Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7"]
},
{
  "eco": "D62",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3"]
},
{
  "eco": "D63",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8"]
},
{
  "eco": "D64",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","a2a3"]
},
{
  "eco": "D65",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","a2a3","b8d7"]
},
{
  "eco": "D66",
  "name": "Queen's Gambit Declined, Orthodox Defense, Capablanca Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3"]
},
{
  "eco": "D67",
  "name": "Queen's Gambit Declined, Orthodox Defense, Capablanca Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7"]
},
{
  "eco": "D68",
  "name": "Queen's Gambit Declined, Orthodox Defense, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7","a1c1"]
},
{
  "eco": "D69",
  "name": "Queen's Gambit Declined, Orthodox Defense, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7","a1c1","c7c6"]
},

{
  "eco": "D70",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5"]
},
{
  "eco": "D71",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5"]
},
{
  "eco": "D72",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5"]
},
{
  "eco": "D73",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4"]
},
{
  "eco": "D74",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3"]
},
{
  "eco": "D75",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3"]
},
{
  "eco": "D76",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3"]
},
{
  "eco": "D77",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7"]
},
{
  "eco": "D78",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5"]
},
{
  "eco": "D79",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5","d5c4"]
},

{
  "eco": "D80",
  "name": "Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5"]
},
{
  "eco": "D81",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5"]
},
{
  "eco": "D82",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5"]
},
{
  "eco": "D83",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4"]
},
{
  "eco": "D84",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3"]
},
{
  "eco": "D85",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3"]
},
{
  "eco": "D86",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7"]
},
{
  "eco": "D87",
  "name": "Grünfeld Defense, Exchange Variation, Spassky Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","c1e3"]
},
{
  "eco": "D88",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4"]
},
{
  "eco": "D89",
  "name": "Grünfeld Defense, Exchange Variation, Simagin Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4","c7c5"]
},

{
  "eco": "D90",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3"]
},
{
  "eco": "D91",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7"]
},
{
  "eco": "D92",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5"]
},
{
  "eco": "D93",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5","d5c4"]
},
{
  "eco": "D94",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3"]
},
{
  "eco": "D95",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7"]
},
{
  "eco": "D96",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2"]
},
{
  "eco": "D97",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5"]
},
{
  "eco": "D98",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5","c4d5"]
},
{
  "eco": "D99",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5","c4d5","f6d5"]
},

{
  "eco": "E00",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6"]
},
{
  "eco": "E01",
  "name": "Catalan Opening",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3"]
},
{
  "eco": "E02",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5"]
},
{
  "eco": "E03",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2"]
},
{
  "eco": "E04",
  "name": "Catalan Opening, Open",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4"]
},
{
  "eco": "E05",
  "name": "Catalan Opening, Open",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4","g1f3"]
},
{
  "eco": "E06",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7"]
},
{
  "eco": "E07",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3"]
},
{
  "eco": "E08",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3","e8g8"]
},
{
  "eco": "E09",
  "name": "Catalan Opening, Closed, Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3","e8g8","e1g1","d5c4"]
},

{
  "eco": "E10",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6","c2c4","e7e6"]
},
{
  "eco": "E11",
  "name": "Bogo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4"]
},
{
  "eco": "E12",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6"]
},
{
  "eco": "E13",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3"]
},
{
  "eco": "E14",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7"]
},
{
  "eco": "E15",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2"]
},
{
  "eco": "E16",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7"]
},
{
  "eco": "E17",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1"]
},
{
  "eco": "E18",
  "name": "Queen's Indian Defense, Old Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1","e8g8"]
},
{
  "eco": "E19",
  "name": "Queen's Indian Defense, Old Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1","e8g8","b1c3"]
},

{
  "eco": "E20",
  "name": "Nimzo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4"]
},
{
  "eco": "E21",
  "name": "Nimzo-Indian Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g1f3"]
},
{
  "eco": "E22",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3"]
},
{
  "eco": "E23",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3","b4c3"]
},
{
  "eco": "E24",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3","b4c3","b2c3"]
},
{
  "eco": "E25",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2"]
},
{
  "eco": "E26",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5"]
},
{
  "eco": "E27",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3"]
},
{
  "eco": "E28",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3","b4c3"]
},
{
  "eco": "E29",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3","b4c3","b2c3"]
},

{
  "eco": "E30",
  "name": "Nimzo-Indian Defense, Leningrad Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g2g3"]
},
{
  "eco": "E31",
  "name": "Nimzo-Indian Defense, Leningrad Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g2g3","c7c5"]
},
{
  "eco": "E32",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5"]
},
{
  "eco": "E33",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6"]
},
{
  "eco": "E34",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4"]
},
{
  "eco": "E35",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4","c7c5"]
},
{
  "eco": "E36",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4","c7c5","e2e3"]
},
{
  "eco": "E37",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2"]
},
{
  "eco": "E38",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2","b8c6"]
},
{
  "eco": "E39",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2","b8c6","a2a3"]
},

{
  "eco": "E40",
  "name": "Nimzo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4"]
},
{
  "eco": "E41",
  "name": "Nimzo-Indian Defense, Hübner Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2"]
},
{
  "eco": "E42",
  "name": "Nimzo-Indian Defense, Hübner Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","c7c5"]
},
{
  "eco": "E43",
  "name": "Nimzo-Indian Defense, Fischer Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","b8c6"]
},
{
  "eco": "E44",
  "name": "Nimzo-Indian Defense, Fischer Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","b8c6","a2a3"]
},
{
  "eco": "E45",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3"]
},
{
  "eco": "E46",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8"]
},
{
  "eco": "E47",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3"]
},
{
  "eco": "E48",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3","d7d5"]
},
{
  "eco": "E49",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0, 5.Bd3 d5",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3","d7d5","e1g1"]
},

{
  "eco": "E50",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3"]
},
{
  "eco": "E51",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8"]
},
{
  "eco": "E52",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3"]
},
{
  "eco": "E53",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5"]
},
{
  "eco": "E54",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3"]
},
{
  "eco": "E55",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5"]
},
{
  "eco": "E56",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1"]
},
{
  "eco": "E57",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6"]
},
{
  "eco": "E58",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6","a2a3"]
},
{
  "eco": "E59",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6","a2a3","b4c3"]
},
{
  "eco": "E60",
  "name": "King's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6"]
},
{
  "eco": "E61",
  "name": "King's Indian Defense, 3.Nc3",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3"]
},
{
  "eco": "E62",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3"]
},
{
  "eco": "E63",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7"]
},
{
  "eco": "E64",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2"]
},
{
  "eco": "E65",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6"]
},
{
  "eco": "E66",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3"]
},
{
  "eco": "E67",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8"]
},
{
  "eco": "E68",
  "name": "King's Indian Defense, Fianchetto Variation, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8","e1g1"]
},
{
  "eco": "E69",
  "name": "King's Indian Defense, Fianchetto Variation, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8","e1g1","c7c6"]
},
{
  "eco": "E70",
  "name": "King's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7"]
},
{
  "eco": "E71",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4"]
},
{
  "eco": "E72",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6"]
},
{
  "eco": "E73",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3"]
},
{
  "eco": "E74",
  "name": "King's Indian Defense, Averbakh Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","c1g5"]
},
{
  "eco": "E75",
  "name": "King's Indian Defense, Averbakh Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","c1g5","e8g8"]
},
{
  "eco": "E76",
  "name": "King's Indian Defense, Four Pawns Attack",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f4"]
},
{
  "eco": "E77",
  "name": "King's Indian Defense, Four Pawns Attack",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f4","e8g8"]
},
{
  "eco": "E78",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8"]
},
{
  "eco": "E79",
  "name": "King's Indian Defense, Classical, 7…Nc6",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","b8c6"]
},
{
  "eco": "E80",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3"]
},
{
  "eco": "E81",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8"]
},
{
  "eco": "E82",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3"]
},
{
  "eco": "E83",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5"]
},
{
  "eco": "E84",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5"]
},
{
  "eco": "E85",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5","e7e6"]
},
{
  "eco": "E86",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5","e7e6","g1e2"]
},
{
  "eco": "E87",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6"]
},
{
  "eco": "E88",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6","g1e2"]
},
{
  "eco": "E89",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6","g1e2","a7a6"]
},
{
  "eco": "E90",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2"]
},
{
  "eco": "E91",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5"]
},
{
  "eco": "E92",
  "name": "King's Indian Defense, Classical, 7…e5",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1"]
},
{
  "eco": "E93",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5"]
},
{
  "eco": "E94",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5","b8d7"]
},
{
  "eco": "E95",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5","b8d7","f3d2"]
},
{
  "eco": "E96",
  "name": "King's Indian Defense, Classical, Orthodox",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7"]
},
{
  "eco": "E97",
  "name": "King's Indian Defense, Classical, Orthodox",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5"]
},
{
  "eco": "E98",
  "name": "King's Indian Defense, Classical, Orthodox, Aronin–Taimanov",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5","c7c6"]
},
{
  "eco": "E99",
  "name": "King's Indian Defense, Classical, Orthodox, Aronin–Taimanov",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5","c7c6","d1d2"]
},

{
  "eco": "F00",
  "name": "Irregular Opening",
  "moves": ["g2g4"]
},
{
  "eco": "F01",
  "name": "Nimzowitsch–Larsen Attack",
  "moves": ["b2b3"]
},
{
  "eco": "F02",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","d7d5","g1f3"]
},
{
  "eco": "F03",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1g5"]
},
{
  "eco": "F04",
  "name": "Queen's Pawn Game, Colle System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","e2e3"]
},
{
  "eco": "F05",
  "name": "Queen's Pawn Game, Zukertort Variation",
  "moves": ["d2d4","d7d5","g1f3","g8f6","b1d2"]
},
{
  "eco": "F06",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c2c3"]
},
{
  "eco": "F07",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1g5","c7c5"]
},
{
  "eco": "F08",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1f4"]
},
{
  "eco": "F09",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1f4","c7c5"]
},

{
  "eco": "F10",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5"]
},
{
  "eco": "F11",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","d7d5"]
},
{
  "eco": "F12",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","d7d5","e2e3"]
},
{
  "eco": "F13",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","d7d5","e2e3","c7c5"]
},
{
  "eco": "F14",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","h7h6"]
},
{
  "eco": "F15",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5"]
},
{
  "eco": "F16",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","f6e4"]
},
{
  "eco": "F17",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","f6e4","g5f4"]
},
{
  "eco": "F18",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","f6e4","g5f4","d7d5"]
},
{
  "eco": "F19",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","f6e4","g5f4","d7d5","e2e3"]
},

{
  "eco": "F20",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","d7d5","c1g5"]
},
{
  "eco": "F21",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6"]
},
{
  "eco": "F22",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3"]
},
{
  "eco": "F23",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3","c7c5"]
},
{
  "eco": "F24",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3","c7c5","c2c3"]
},
{
  "eco": "F25",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3","c7c5","c2c3","b8c6"]
},
{
  "eco": "F26",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3"]
},
{
  "eco": "F27",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","d7d5","c1g5","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6"]
},
{
  "eco": "F28",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","d7d5"]
},
{
  "eco": "F29",
  "name": "Queen's Pawn Game, Trompowsky Attack",
  "moves": ["d2d4","g8f6","c1g5","d7d5","e2e3"]
},

{
  "eco": "F30",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6"]
},
{
  "eco": "F31",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3"]
},
{
  "eco": "F32",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6"]
},
{
  "eco": "F33",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3"]
},
{
  "eco": "F34",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5"]
},
{
  "eco": "F35",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3"]
},
{
  "eco": "F36",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6"]
},
{
  "eco": "F37",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1"]
},
{
  "eco": "F38",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7"]
},
{
  "eco": "F39",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2"]
},

{
  "eco": "F40",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6"]
},
{
  "eco": "F41",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3"]
},
{
  "eco": "F42",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5"]
},
{
  "eco": "F43",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3"]
},
{
  "eco": "F44",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6"]
},
{
  "eco": "F45",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3"]
},
{
  "eco": "F46",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6"]
},
{
  "eco": "F47",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3"]
},
{
  "eco": "F48",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6"]
},
{
  "eco": "F49",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3"]
},

{
  "eco": "F50",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8"]
},
{
  "eco": "F51",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2"]
},
{
  "eco": "F52",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7"]
},
{
  "eco": "F53",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2"]
},
{
  "eco": "F54",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6"]
},
{
  "eco": "F55",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6","e1g1"]
},
{
  "eco": "F56",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6","e1g1","a7a5"]
},
{
  "eco": "F57",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6","e1g1","a7a5","f4g5"]
},
{
  "eco": "F58",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6","e1g1","a7a5","f4g5","f6d7"]
},
{
  "eco": "F59",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","c1f4","g8f6","e2e3","c7c5","c2c3","b8c6","g1f3","e7e6","h2h3","f8d6","f1d3","e8g8","b1d2","d8c7","d1e2","b7b6","e1g1","a7a5","f4g5","f6d7","e3e4"]
},

{
  "eco": "F60",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7"]
},
{
  "eco": "F61",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2"]
},
{
  "eco": "F62",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6"]
},
{
  "eco": "F63",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4"]
},
{
  "eco": "F64",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7"]
},
{
  "eco": "F65",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3"]
},
{
  "eco": "F66",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4"]
},
{
  "eco": "F67",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4e7"]
},
{
  "eco": "F68",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4e7","d8e7"]
},
{
  "eco": "F69",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4e7","d8e7","d1c2"]
},

{
  "eco": "F70",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3"]
},
{
  "eco": "F71",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3"]
},
{
  "eco": "F72",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3"]
},
{
  "eco": "F73",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3"]
},
{
  "eco": "F74",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2"]
},
{
  "eco": "F75",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2"]
},
{
  "eco": "F76",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2"]
},
{
  "eco": "F77",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7"]
},
{
  "eco": "F78",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7","g3e5"]
},
{
  "eco": "F79",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7","g3e5","c7e5"]
},

{
  "eco": "F70",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3"]
},
{
  "eco": "F71",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3"]
},
{
  "eco": "F72",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3"]
},
{
  "eco": "F73",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3"]
},
{
  "eco": "F74",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2"]
},
{
  "eco": "F75",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2"]
},
{
  "eco": "F76",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2"]
},
{
  "eco": "F77",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7"]
},
{
  "eco": "F78",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7","g3e5"]
},
{
  "eco": "F79",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7","g3e5","c7e5"]
},

{
  "eco": "F80",
  "name": "Queen's Pawn Game, Levitsky Attack",
  "moves": ["d2d4","d7d5","c1g5","c7c6","e2e3","g8f6","g1f3","c8f5","f1d3","e7e6","e1g1","f8e7","b1d2","h7h6","g5h4","b8d7","h2h3","f6e4","h4g3","e4g3","f2g3","f5d3","d1e2","d3e2","e2e2","d8c7","g3e5","c7e5","d4e5"]
},
{
  "eco": "F81",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7"]
},
{
  "eco": "F82",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3"]
},
{
  "eco": "F83",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6"]
},
{
  "eco": "F84",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4"]
},
{
  "eco": "F85",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4","b7b6"]
},
{
  "eco": "F86",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4","b7b6","f1d3"]
},
{
  "eco": "F87",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4","b7b6","f1d3","c8b7"]
},
{
  "eco": "F88",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4","b7b6","f1d3","c8b7","b1d2"]
},
{
  "eco": "F89",
  "name": "Queen's Pawn Game, Torre Attack",
  "moves": ["d2d4","g8f6","g1f3","e7e6","c1g5","f8e7","e2e3","h7h6","g5h4","b7b6","f1d3","c8b7","b1d2","d7d5"]
},

{
  "eco": "F90",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4"]
},
{
  "eco": "F91",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4"]
},
{
  "eco": "F92",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3"]
},
{
  "eco": "F93",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6"]
},
{
  "eco": "F94",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5"]
},
{
  "eco": "F95",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5","c8f5"]
},
{
  "eco": "F96",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5","c8f5","f2f3"]
},
{
  "eco": "F97",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5","c8f5","f2f3","e4f3"]
},
{
  "eco": "F98",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5","c8f5","f2f3","e4f3","g5f6"]
},
{
  "eco": "F99",
  "name": "Queen's Pawn Game, Blackmar–Diemer Gambit",
  "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5","c8f5","f2f3","e4f3","g5f6","e7f6"]
}

]



// ============================================================================
// Openings: Explorer + Position-based Detection (transposition-safe)
// ============================================================================

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const OPENING_INDEX_MAX_PLIES = 16; // keep indexing fast; enough for most named openings

let __openingIndexBuilt = false;
let __openingPosIndex = null; // Map(positionKey -> {eco,name,moves,plies})
let __openingListSorted = null;

function __openingPositionKey(board, turn, castling, enPassant) {
  let out = '';
  for (let y = 0; y < ROWS; y++) {
    let empty = 0;
    for (let x = 0; x < COLS; x++) {
      const pc = board[y][x];
      if (!pc) { empty++; continue; }
      if (empty) { out += String(empty); empty = 0; }
      const t = pc.type;
      const letter = (typeof t === 'string' && t.length) ? t[0].toUpperCase() : '?';
      out += (pc.color === LIGHT) ? letter : letter.toLowerCase();
    }
    if (empty) out += String(empty);
    if (y < ROWS - 1) out += '/';
  }

  out += ' ' + (turn === LIGHT ? 'w' : 'b');

  let c = '';
  try {
    if (castling?.[LIGHT]?.kingside) c += 'K';
    if (castling?.[LIGHT]?.queenside) c += 'Q';
    if (castling?.[DARK]?.kingside) c += 'k';
    if (castling?.[DARK]?.queenside) c += 'q';
  } catch (e) { /* ignore */ }
  out += ' ' + (c || '-');

  if (enPassant && Number.isFinite(enPassant.x) && Number.isFinite(enPassant.y)) {
    out += ' ' + String.fromCharCode(97 + enPassant.x) + (ROWS - enPassant.y);
  } else {
    out += ' -';
  }
  return out;
}

function __openingParseSq(s) {
  if (typeof s !== 'string' || s.length !== 2) return null;
  const f = s.charCodeAt(0);
  const r = s.charCodeAt(1);
  if (f < 97 || f > 104) return null;
  if (r < 49 || r > 56) return null;
  const x = f - 97;
  const rank = r - 48;
  const y = 8 - rank;
  return { x, y };
}

function __openingFindMoveByToken(token, legalMoves, board, turnColor) {
  if (!token) return null;
  if (token === 'O-O' || token === '0-0') return legalMoves.find(m => m.castle === 'kingside') || null;
  if (token === 'O-O-O' || token === '0-0-0') return legalMoves.find(m => m.castle === 'queenside') || null;
  if (typeof token !== 'string') return null;

  const stripped = token.replace(/[\+\#\!\?]+$/g, '');
  const sqStr = (mxy) => String.fromCharCode(97 + mxy.x) + (8 - mxy.y);

  // SAN-ish support (very small subset): e4, Nbd7, exd5, e8=Q
  // We treat these as "move to <dest>" with optional disambiguation.
  try {
    let base = stripped;
    let promo = null;
    const eqIdx = base.indexOf('=');
    if (eqIdx >= 0 && eqIdx + 1 < base.length) {
      promo = base[eqIdx + 1].toUpperCase();
      base = base.slice(0, eqIdx);
    }
    base = base.replace(/x/g, '');
    if (base.length >= 2) {
      const dest = base.slice(-2);
      const destSq = __openingParseSq(dest);
      if (destSq) {
        let mid = base.slice(0, -2);
        let pieceLetter = null;
        let disFile = null;
        let disRank = null;
        if (mid.length && 'KQRBN'.includes(mid[0])) {
          pieceLetter = mid[0];
          mid = mid.slice(1);
        }
        if (mid.length && /[a-h]/.test(mid[0])) {
          disFile = mid[0];
          mid = mid.slice(1);
        }
        if (mid.length && /[1-8]/.test(mid[0])) {
          disRank = mid[0];
        }

        let candidates = legalMoves.filter(m => sqStr(m.to) === dest);
        if (promo) candidates = candidates.filter(m => (m.promo || null) === promo);
        if (disFile) {
          const fx = disFile.charCodeAt(0) - 97;
          candidates = candidates.filter(m => m.from.x === fx);
        }
        if (disRank) {
          const fy = 8 - (disRank.charCodeAt(0) - 48);
          candidates = candidates.filter(m => m.from.y === fy);
        }
        if (pieceLetter) {
          candidates = candidates.filter(m => {
            const pc = board?.[m.from.y]?.[m.from.x] || null;
            return pc && String(pc.type || '').toUpperCase() === pieceLetter;
          });
        }
        if (candidates.length === 1) return candidates[0];
      }
    }
  } catch (e) { /* ignore */ }

  if (stripped.length < 4) return null;

  const from = token.slice(0, 2);
  const to = token.slice(2, 4);
  const promo = stripped.length >= 5 ? stripped[4].toUpperCase() : null;

  let mv = legalMoves.find(m => {
    const f = sqStr(m.from);
    const t = sqStr(m.to);
    if ((f + t) !== (from + to)) return false;
    if (promo) return (m.promo || null) === promo;
    return true;
  }) || null;
  if (mv) return mv;

  const hintSq = __openingParseSq(from);
  let hintType = null;
  try {
    if (hintSq) {
      const pc = board?.[hintSq.y]?.[hintSq.x] || null;
      if (pc && pc.color === turnColor && pc.type) hintType = pc.type;
    }
  } catch (e) { /* ignore */ }

  let candidates = legalMoves.filter(m => {
    if (sqStr(m.to) !== to) return false;
    if (promo && (m.promo || null) !== promo) return false;
    return true;
  });
  if (hintType) {
    candidates = candidates.filter(m => {
      const pc = board?.[m.from.y]?.[m.from.x] || null;
      return pc && pc.type === hintType;
    });
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && hintSq) {
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const dx = c.from.x - hintSq.x;
      const dy = c.from.y - hintSq.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
  return candidates.length ? candidates[0] : null;
}

function ensureOpeningIndexes() {
  if (__openingIndexBuilt) return;
  __openingIndexBuilt = true;
  __openingPosIndex = new Map();

  __openingListSorted = Array.isArray(OPENINGS) ? OPENINGS.slice() : [];
  __openingListSorted.sort((a, b) => {
    const ea = String(a.eco || '');
    const eb = String(b.eco || '');
    if (ea !== eb) return ea.localeCompare(eb);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const start = fenToBoard(STARTPOS_FEN);
  for (const entry of __openingListSorted) {
    const moves = Array.isArray(entry.moves) ? entry.moves : [];
    if (!moves.length) continue;

    let ctx = cloneCtx(start.board, start.castling, start.enPassant);
    let turn = start.turn;
    let plies = 0;
    const maxPlies = Math.min(moves.length, OPENING_INDEX_MAX_PLIES);

    for (let i = 0; i < maxPlies; i++) {
      const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turn);
      const mv = __openingFindMoveByToken(moves[i], legal, ctx.board, turn);
      if (!mv) break;
      const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
      ctx = { board: next.board, castling: next.castling, enPassant: next.enPassant };
      turn = (turn === LIGHT) ? DARK : LIGHT;
      plies++;

      const key = __openingPositionKey(ctx.board, turn, ctx.castling, ctx.enPassant);
      const existing = __openingPosIndex.get(key);
      const cand = { eco: entry.eco || '', name: entry.name || '', moves: moves, plies };

      if (!existing) __openingPosIndex.set(key, cand);
      else if ((cand.plies || 0) > (existing.plies || 0)) __openingPosIndex.set(key, cand);
      else if ((cand.plies || 0) === (existing.plies || 0)) {
        const a = `${cand.eco} ${cand.name}`;
        const b = `${existing.eco} ${existing.name}`;
        if (a.localeCompare(b) < 0) __openingPosIndex.set(key, cand);
      }
    }
  }
}

function getCurrentOpeningInfo() {
  try {
    ensureOpeningIndexes();
    if (!__openingPosIndex) return null;
    const key = __openingPositionKey(state.board, state.turn, state.castling, state.enPassant);
    return __openingPosIndex.get(key) || null;
  } catch (e) {
    return null;
  }
}

function applyOpeningLine(openingEntry, opts) {
  if (!openingEntry) return false;
  const o = openingEntry;

  try { if (typeof _abortSearchIfAny === 'function') _abortSearchIfAny(); } catch (e) { /* ignore */ }
  try { if (state && state.thinking) state.thinking = false; } catch (e) { /* ignore */ }

  const prevAiEnabled = state.aiEnabled;
  const prevAiColor = state.aiColor;
  const prevMenuActive = state.menuActive;
  const prevAutoPlayActive = (typeof autoPlayActive !== 'undefined') ? autoPlayActive : false;
  try {
    state.aiEnabled = false;
    state.menuActive = true;
    if (typeof autoPlayActive !== 'undefined') {
      autoPlayActive = false;
      try { updateAutoPlayButton(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  let applied = 0;
  try {
    if (typeof resetBoard !== 'function') return false;
    resetBoard();
    for (const token of (o.moves || [])) {
      const legal = generateLegalMoves(state.turn);
      const mv = __openingFindMoveByToken(token, legal, state.board, state.turn);
      if (!mv) break;
      const ok = makeMove(mv);
      if (ok === false) break;
      applied++;
    }
  } finally {
    try {
      state.aiEnabled = prevAiEnabled;
      state.aiColor = prevAiColor;
      state.menuActive = prevMenuActive;
      if (typeof autoPlayActive !== 'undefined') {
        autoPlayActive = prevAutoPlayActive;
        try { updateAutoPlayButton(); } catch (e) { /* ignore */ }
      }
      state.thinking = false;
    } catch (e) { /* ignore */ }
  }

  try { render(); } catch (e) { /* ignore */ }
  try { updateHud(); } catch (e) { /* ignore */ }
  try { opts?.afterApply?.(applied); } catch (e) { /* ignore */ }
  return applied > 0;
}



function getOpeningName(moveHistory) {
  const current = getCurrentOpeningInfo();
  if (current && current.name) return (current.eco ? `${current.eco} — ` : '') + current.name;

  // Fallback: prefix match by move list.
  const uciMoves = (moveHistory || []).map(mv => {
    if (!mv || !mv.from || !mv.to) return "";
    return (
      String.fromCharCode(97 + mv.from.x) + (8 - mv.from.y) +
      String.fromCharCode(97 + mv.to.x) + (8 - mv.to.y)
    );
  });
  let best = { name: "(Unrecognized Opening)", len: 0, eco: "" };
  for (const entry of OPENINGS) {
    let match = true;
    for (let i = 0; i < entry.moves.length; i++) {
      if (uciMoves[i] !== entry.moves[i]) { match = false; break; }
    }
    if (match && entry.moves.length > best.len) best = { name: entry.name, len: entry.moves.length, eco: entry.eco || "" };
  }
  if (best.len > 0) return (best.eco ? `${best.eco} — ` : '') + best.name;
  return "(Unrecognized Opening)";
}

// ============================================================================
// Move List Rendering (Two-Column Format)
// ============================================================================


function renderMoveList() {
	if (!moveList) return;
	const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
	const moves = state.moveHistory;

	// Opening name display
	const openingName = getOpeningName(moves);
  let html = `<div id="opening-name" style="margin-bottom: 6px; color: var(--accent); font-weight: 600; font-size: 13px; text-align: center;">${openingName}</div>`;

	html += '<div style="display: grid; grid-template-columns: auto 1fr 1fr; gap: 2px 8px; font-size: 12px;">';
	for (let i = 0; i < moves.length; i += 2) {
		const moveNum = Math.floor(i / 2) + 1;
		const whiteMove = moves[i];
		const blackMove = moves[i + 1];
		html += `<div style="text-align: right; color: var(--muted); user-select: none;">${moveNum}.</div>`;
		html += `<div style="cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.15s;" 
			class="move-item" data-index="${i}" 
			onmouseover="this.style.background='rgba(110,193,255,0.15)'" 
			onmouseout="this.style.background='transparent'">`;
		html += formatMove(whiteMove);
		html += '</div>';
		if (blackMove) {
			html += `<div style="cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.15s;" 
				class="move-item" data-index="${i + 1}" 
				onmouseover="this.style.background='rgba(110,193,255,0.15)'" 
				onmouseout="this.style.background='transparent'">`;
			html += formatMove(blackMove);
			html += '</div>';
		} else {
			html += '<div></div>';
		}
	}
	html += '</div>';
	moveList.innerHTML = html;

	// Attach click handlers
	const items = moveList.querySelectorAll('.move-item');
	items.forEach(item => {
		item.addEventListener('click', () => {
			const index = parseInt(item.dataset.index, 10);
      try { if (typeof _abortSearchIfAny === 'function') _abortSearchIfAny(); } catch (e) { /* ignore */ }
      try { if (state && state.thinking) state.thinking = false; } catch (e) { /* ignore */ }
      // Use window.goToMove if present so any wrappers apply.
      if (typeof window.goToMove === 'function') window.goToMove(index);
      else if (typeof goToMove === 'function') goToMove(index);
		});
	});

	// Remove old FEN/PGN button appends if present
	const oldFenBtn = document.getElementById('btn-load-fen');
	if (oldFenBtn && oldFenBtn.parentNode === moveList) moveList.removeChild(oldFenBtn);
	const oldCopyFenBtn = document.getElementById('btn-copy-fen');
	if (oldCopyFenBtn && oldCopyFenBtn.parentNode === moveList) moveList.removeChild(oldCopyFenBtn);
	const oldPgnBtn = document.getElementById('btn-load-pgn');
	if (oldPgnBtn && oldPgnBtn.parentNode === moveList) moveList.removeChild(oldPgnBtn);
	const oldCopyPgnBtn = document.getElementById('btn-copy-pgn');
	if (oldCopyPgnBtn && oldCopyPgnBtn.parentNode === moveList) moveList.removeChild(oldCopyPgnBtn);

	// Create a single row for FEN and PGN buttons
	const btnRow = document.createElement('div');
	btnRow.style.display = 'flex';
	btnRow.style.gap = '6px';
	btnRow.style.marginTop = '8px';

	// FEN buttons
	const fenBtn = document.createElement('button');
	fenBtn.id = 'btn-load-fen';
	fenBtn.textContent = 'Load FEN';
	fenBtn.style.padding = '4px 8px';
	fenBtn.style.fontSize = '12px';
	fenBtn.style.cursor = 'pointer';
	fenBtn.style.borderRadius = '4px';
	fenBtn.onclick = () => {
		const fen = prompt('Paste FEN:');
		if (fen) {
			restoreFromFEN(fen);
			state.positionHistory = [fen];
      if (typeof rebuildRepetitionTracker === 'function') rebuildRepetitionTracker();
			render();
		}
	};
	btnRow.appendChild(fenBtn);

	const copyFenBtn = document.createElement('button');
	copyFenBtn.id = 'btn-copy-fen';
	copyFenBtn.textContent = 'Copy FEN';
	copyFenBtn.style.padding = '4px 8px';
	copyFenBtn.style.fontSize = '12px';
	copyFenBtn.style.cursor = 'pointer';
	copyFenBtn.style.borderRadius = '4px';
	copyFenBtn.onclick = () => {
		const fen = boardToFEN();
    copyTextToClipboard(fen).then((ok) => {
      if (ok) alert('FEN copied!');
      else prompt('Copy FEN:', fen);
    });
	};
	btnRow.appendChild(copyFenBtn);

	// Load PGN button
	const loadPgnBtn = document.createElement('button');
	loadPgnBtn.id = 'btn-load-pgn';
	loadPgnBtn.textContent = 'Load PGN';
	loadPgnBtn.style.padding = '4px 8px';
	loadPgnBtn.style.fontSize = '12px';
	loadPgnBtn.style.cursor = 'pointer';
	loadPgnBtn.style.borderRadius = '4px';
	loadPgnBtn.onclick = function() {
		let fileInput = document.getElementById('pgnFileInput');
		if (!fileInput) {
			fileInput = document.createElement('input');
			fileInput.type = 'file';
			fileInput.accept = '.pgn,text/plain';
			fileInput.style.display = 'none';
			fileInput.id = 'pgnFileInput';
			fileInput.addEventListener('change', function(e) {
				const file = fileInput.files && fileInput.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = function(evt) {
					const text = evt.target.result;
					if (typeof window.loadPGN === 'function') {
						window.loadPGN(text);
					} else {
						alert('PGN loader not found.');
					}
				};
				reader.readAsText(file);
			});
			document.body.appendChild(fileInput);
		}
		fileInput.value = '';
		fileInput.click();
	};
	btnRow.appendChild(loadPgnBtn);

	const copyPgnBtn = document.createElement('button');
	copyPgnBtn.id = 'btn-copy-pgn';
	copyPgnBtn.textContent = 'Copy PGN';
	copyPgnBtn.style.padding = '4px 8px';
	copyPgnBtn.style.fontSize = '12px';
	copyPgnBtn.style.cursor = 'pointer';
	copyPgnBtn.style.borderRadius = '4px';
	copyPgnBtn.onclick = () => {
		if (typeof generatePGN === 'function') {
			const pgn = generatePGN();
      copyTextToClipboard(pgn).then((ok) => {
        if (ok) alert('PGN copied!');
        else prompt('Copy PGN:', pgn);
      });
		}
	};
	btnRow.appendChild(copyPgnBtn);

  // Opening Explorer button
  const openExplorerBtn = document.createElement('button');
  openExplorerBtn.id = 'btn-openings-explorer';
  openExplorerBtn.textContent = 'Openings';
  openExplorerBtn.style.padding = '4px 8px';
  openExplorerBtn.style.fontSize = '12px';
  openExplorerBtn.style.cursor = 'pointer';
  openExplorerBtn.style.borderRadius = '4px';
  btnRow.appendChild(openExplorerBtn);

  // Opening Explorer panel (rendered under the buttons)
  let explorer = document.getElementById('openings-explorer');
  if (explorer && explorer.parentNode === moveList) moveList.removeChild(explorer);
	
  explorer = document.createElement('div');
  explorer.id = 'openings-explorer';
  explorer.style.display = 'none';
  explorer.style.marginTop = '8px';
  explorer.style.padding = '8px';
  explorer.style.border = '1px solid #333';
  explorer.style.borderRadius = '8px';
  explorer.style.background = 'rgba(0,0,0,0.12)';

  const explorerHeader = document.createElement('div');
  explorerHeader.style.display = 'flex';
  explorerHeader.style.gap = '6px';
  explorerHeader.style.alignItems = 'center';

  const explorerFilter = document.createElement('input');
  explorerFilter.id = 'openings-explorer-filter';
  explorerFilter.type = 'text';
  explorerFilter.placeholder = 'Filter openings (e.g. B90, Najdorf)';
  explorerFilter.style.flex = '1';
  explorerFilter.style.fontSize = '12px';
  explorerFilter.style.padding = '4px 8px';
  explorerFilter.style.borderRadius = '6px';

  const explorerGroup = document.createElement('select');
  explorerGroup.id = 'openings-explorer-group';
  explorerGroup.style.fontSize = '12px';
  explorerGroup.style.padding = '4px 6px';
  explorerGroup.style.borderRadius = '6px';
  for (const v of ['All', 'A', 'B', 'C', 'D', 'E', 'F']) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    explorerGroup.appendChild(opt);
  }

  const explorerClose = document.createElement('button');
  explorerClose.textContent = 'Close';
  explorerClose.style.fontSize = '12px';
  explorerClose.style.padding = '4px 8px';
  explorerClose.style.borderRadius = '6px';
  explorerClose.style.cursor = 'pointer';

  explorerHeader.appendChild(explorerFilter);
  explorerHeader.appendChild(explorerGroup);
  explorerHeader.appendChild(explorerClose);

  const explorerMeta = document.createElement('div');
  explorerMeta.id = 'openings-explorer-meta';
  explorerMeta.style.marginTop = '6px';
  explorerMeta.style.fontSize = '11px';
  explorerMeta.style.color = 'var(--muted)';

  const explorerResults = document.createElement('div');
  explorerResults.id = 'openings-explorer-results';
  explorerResults.style.marginTop = '8px';
  // Avoid nested scrolling issues on mobile; render a capped list.
  explorerResults.style.maxHeight = 'none';
  explorerResults.style.overflow = 'visible';

  explorer.appendChild(explorerHeader);
  explorer.appendChild(explorerMeta);
  explorer.appendChild(explorerResults);

  function renderExplorerResults() {
    ensureOpeningIndexes();
    const q = (explorerFilter.value || '').trim().toLowerCase();
    const group = explorerGroup.value || 'All';
    const list = __openingListSorted || [];
    let filtered = list;
    if (group !== 'All') {
      filtered = filtered.filter(o => String(o.eco || '').startsWith(group));
    }
    if (q) {
      filtered = filtered.filter(o => {
        const eco = String(o.eco || '').toLowerCase();
        const name = String(o.name || '').toLowerCase();
        if (eco.includes(q) || name.includes(q)) return true;
        try { if ((o.moves || []).join(' ').toLowerCase().includes(q)) return true; } catch (e) { /* ignore */ }
        return false;
      });
    }
    const cap = 250;
    const shown = filtered.slice(0, cap);
    explorerMeta.textContent = `Showing ${shown.length} of ${filtered.length} openings`;
    explorerResults.innerHTML = '';
    for (const o of shown) {
      const item = document.createElement('div');
      item.className = 'pgn-search-item';
      item.style.padding = '6px 8px';
      item.style.borderRadius = '6px';
      item.style.cursor = 'pointer';
      item.style.color = 'var(--accent)';
      item.style.marginBottom = '4px';
      item.textContent = `${o.eco || ''} — ${o.name || ''}`;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      const onPick = (ev) => {
        try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch (e) { /* ignore */ }
        applyOpeningLine(o, {
          afterApply: () => {
            explorer.style.display = 'none';
          }
        });
      };
      item.addEventListener('pointerdown', onPick);
      item.addEventListener('click', onPick);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onPick(e); });
      explorerResults.appendChild(item);
    }
  }

  openExplorerBtn.onclick = () => {
    const isOpen = explorer.style.display !== 'none';
    explorer.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      // Prevent Android keyboard from popping up when opening the explorer.
      // Only show the keyboard if the user explicitly taps the filter field.
      try {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
      } catch (e) { /* ignore */ }
      try { explorerFilter.blur(); } catch (e) { /* ignore */ }

      renderExplorerResults();
    }
  };
  explorerClose.onclick = () => { explorer.style.display = 'none'; };
  explorerFilter.addEventListener('input', renderExplorerResults);
  explorerGroup.addEventListener('change', renderExplorerResults);

	// Add PGN search box below the buttons row
	const searchBox = document.createElement('input');
	searchBox.id = 'pgnSearch';
	searchBox.type = 'text';
	searchBox.placeholder = 'Search games...';
	searchBox.style.fontSize = '12px';
	searchBox.style.padding = '4px 8px';
	searchBox.style.borderRadius = '4px';
	searchBox.style.margin = '8px 0 0 0';
	searchBox.style.width = '100%';
    // Ensure it's clickable and focusable even if other DOM handlers exist
    searchBox.style.pointerEvents = 'auto';
    searchBox.style.zIndex = '20';
  const _focusSearchBox = function(e) { e.stopPropagation(); this.focus(); };
  searchBox.addEventListener('mousedown', _focusSearchBox);
  searchBox.addEventListener('touchstart', _focusSearchBox, { passive: true });
    // Show search results list and let user click to load specific game
    const resultsDiv = document.createElement('div');
    resultsDiv.id = 'pgnSearchResults';
    // Avoid nested scrolling: the parent panel/drawer is already scrollable.
    // Nested `overflow:auto` containers on mobile often swallow taps as scroll gestures.
    resultsDiv.style.maxHeight = 'none';
    resultsDiv.style.overflow = 'visible';
    resultsDiv.style.margin = '6px 0 12px 0';
    resultsDiv.style.display = 'none';
    resultsDiv.style.touchAction = 'manipulation';

    function buildLabelUI(g, i) {
        const t = g.tags || {};
        return `${i + 1}: ${t.White || 'White'} vs ${t.Black || 'Black'}${t.Event ? ' — ' + t.Event : ''}${t.Date ? ' (' + t.Date + ')' : ''}`;
    }
// ...inside renderMoveList, after searchBox and resultsDiv are created...

searchBox.addEventListener('input', function() {
    const val = this.value.trim().toLowerCase();
    resultsDiv.innerHTML = '';
    if (!val || val.length < 2) { resultsDiv.style.display = 'none'; return; }

  const appendResultsMessage = (text) => {
    const msg = document.createElement('div');
    msg.style.padding = '6px';
    msg.style.color = 'var(--muted)';
    msg.textContent = text;
    resultsDiv.appendChild(msg);
  };

    // --- Opening search: match name, eco, or moves ---
    const openingMatches = OPENINGS.filter(o => {
        // Match by name
        if (o.name.toLowerCase().includes(val)) return true;
        // Match by ECO code
        if (o.eco && o.eco.toLowerCase().includes(val)) return true;
        // Match by moves (as space-separated UCI)
        if (o.moves && o.moves.join(' ').toLowerCase().includes(val)) return true;
        return false;
    });

    if (openingMatches.length > 0) {
        for (let i = 0; i < Math.min(openingMatches.length, 10); i++) {
            const o = openingMatches[i];
            const item = document.createElement('div');
            item.className = 'pgn-search-item';
            item.style.padding = '6px 8px';
            item.style.borderRadius = '6px';
            item.style.cursor = 'pointer';
            item.style.color = 'var(--accent)';
            item.style.marginBottom = '4px';
      item.style.pointerEvents = 'auto';
      item.style.position = 'relative';
      item.style.zIndex = '25';
            item.textContent = `[Opening] ${o.eco} — ${o.name}`;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');

        const applyOpening = (ev) => {
        try {
          if (ev) {
            // On mobile, taps can blur the input / close overlays before `click` fires.
            ev.preventDefault?.();
            ev.stopPropagation?.();
          }
        } catch (e) { /* ignore */ }

			applyOpeningLine(o, {
				afterApply: () => {
					resultsDiv.style.display = 'none';
					searchBox.value = '';
				}
			});
          };

    			// Prefer early events for touch devices.
    			item.addEventListener('pointerdown', applyOpening);
    			item.addEventListener('touchstart', applyOpening, { passive: false });
    			item.addEventListener('mousedown', applyOpening);
    			item.addEventListener('click', applyOpening);
    			item.addEventListener('keydown', (e) => {
    				if (e.key === 'Enter' || e.key === ' ') applyOpening(e);
    			});
            resultsDiv.appendChild(item);
        }
        // Divider if there are also PGN matches
        if (typeof window.searchPGNGames === 'function' && window.searchPGNGames(val).length > 0) {
            const divider = document.createElement('div');
            divider.style.cssText = 'border-bottom:1px solid #333;margin:6px 0;';
            resultsDiv.appendChild(divider);
        }
    }

    // --- Existing PGN search code ---
    if (!pgnGames || pgnGames.length === 0) {
      appendResultsMessage('No PGN games loaded. Click "Load PGN" to import games.');
        resultsDiv.style.display = 'block';
        return;
    }
    const results = typeof window.searchPGNGames === 'function' ? window.searchPGNGames(val) : window.getPGNGames().filter(g => ((Object.values(g.tags||{}).join(' ') + ' ' + (g.moves||[]).join(' ')).toLowerCase().includes(val)));
    if (!results || results.length === 0) { appendResultsMessage('No matches'); resultsDiv.style.display = 'block'; return; }
    for (let r = 0; r < Math.min(results.length, 20); r++) {
        const g = results[r];
        const idx = pgnGames.indexOf(g);
        const item = document.createElement('div');
        item.className = 'pgn-search-item';
        item.style.padding = '6px 8px';
        item.style.borderRadius = '6px';
        item.style.cursor = 'pointer';
        item.style.color = 'var(--text)';
        item.style.marginBottom = '4px';
        item.textContent = buildLabelUI(g, idx >= 0 ? idx : r);
        item.addEventListener('click', () => {
            if (idx >= 0) {
                currentGameIndex = idx;
                loadSingleGame(pgnGames[currentGameIndex]);
            } else {
                const raw = g.raw || buildRawFromGame(g);
                loadPGN(raw);
            }
            resultsDiv.style.display = 'none';
            searchBox.value = '';
        });
        resultsDiv.appendChild(item);
    }
    resultsDiv.style.display = 'block';
});

    // Remove any existing search bar and button row to prevent duplicates
    const oldSearch = moveList.querySelector('#pgnSearch');
    if (oldSearch) moveList.removeChild(oldSearch);
    const oldBtnRow = moveList.querySelector('.fen-pgn-btn-row');
    if (oldBtnRow) moveList.removeChild(oldBtnRow);
    btnRow.className = 'fen-pgn-btn-row';


  const isMobileNav = document.body.classList.contains('mobile-nav');
  if (isMobileNav) {
    const header = moveList.querySelector('#opening-name');
    const anchor = header ? header.nextElementSibling : null;
    if (anchor) {
      moveList.insertBefore(btnRow, anchor);
      moveList.insertBefore(explorer, anchor);
      moveList.insertBefore(searchBox, anchor);
      moveList.insertBefore(resultsDiv, anchor);
    } else {
      moveList.appendChild(btnRow);
      moveList.appendChild(explorer);
      moveList.appendChild(searchBox);
      moveList.appendChild(resultsDiv);
    }
  } else {
    moveList.appendChild(btnRow);
    moveList.appendChild(explorer);
    moveList.appendChild(searchBox);
    moveList.appendChild(resultsDiv);
  }
    // Scroll to bottom
    moveList.scrollTop = moveList.scrollHeight;

}






function formatMove(mv) {
	const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;

	if (mv.castle === "kingside") {
		return `O-O${mv.mate ? "#" : mv.check ? "+" : ""}`;
	}
	if (mv.castle === "queenside") {
		return `O-O-O${mv.mate ? "#" : mv.check ? "+" : ""}`;
	}

	const captureMark = mv.captured ? "x" : "";
	const promo = mv.promoted ? "=Q" : "";
	const suffix = mv.mate ? "#" : mv.check ? "+" : "";
	const piecePart = mv.piece.type === "P" ? (captureMark ? String.fromCharCode(97 + mv.from.x) : "") : mv.piece.type;

	// Use GLYPHS from board.js for the piece glyph
	let pieceSymbol = "";
	if (typeof GLYPHS !== "undefined" && mv.piece && mv.piece.type && mv.piece.color) {
		pieceSymbol = GLYPHS[mv.piece.type]?.[mv.piece.color] || "";
	}

	return `<span class='piece-symbol' style='font-size:16px;vertical-align:middle;'>${pieceSymbol}</span> ${piecePart}${captureMark}${sq(mv.to.x, mv.to.y)}${promo}${suffix}`;
}


// ============================================================================
// UI Button Attachments
// ============================================================================

function attachUIButtons() {
	// Create navigation buttons container
	const controlsPanel = document.getElementById('controls');
	if (!controlsPanel) return;
	
	// Check if nav buttons already exist
	let navContainer = document.getElementById('nav-buttons');
	if (!navContainer) {
		navContainer = document.createElement('div');
		navContainer.id = 'nav-buttons';
		navContainer.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; width: 100%;';
		
		const btnUndoToStart = document.createElement('button');
		btnUndoToStart.id = 'btn-undo-to-start';
		btnUndoToStart.textContent = '⏮ Start';
		btnUndoToStart.title = 'Go to start';
		
		const btnUndoOne = document.createElement('button');
		btnUndoOne.id = 'btn-undo-one';
		btnUndoOne.textContent = '◀ Undo';
		btnUndoOne.title = 'Undo one move';
		
		const btnRedoOne = document.createElement('button');
		btnRedoOne.id = 'btn-redo-one';
		btnRedoOne.textContent = 'Redo ▶';
		btnRedoOne.title = 'Redo one move';
		
		const btnRedoToEnd = document.createElement('button');
		btnRedoToEnd.id = 'btn-redo-to-end';
		btnRedoToEnd.textContent = 'End ⏭';
		btnRedoToEnd.title = 'Go to end';
		
		navContainer.append(btnUndoToStart, btnUndoOne, btnRedoOne, btnRedoToEnd);
		controlsPanel.appendChild(navContainer);
		
		// Attach event listeners
		btnUndoToStart.addEventListener('click', undoToStart);
		btnUndoOne.addEventListener('click', undoMove);
		btnRedoOne.addEventListener('click', redoMove);
		btnRedoToEnd.addEventListener('click', redoToEnd);
	}
	
	// Update renderHistory to use new renderMoveList
	window.originalRenderHistory = renderHistory;
	window.renderHistory = renderMoveList;
}



// Update updateHud to call renderMoveList
const originalUpdateHud = updateHud;
updateHud = function() {
	turnText.textContent = `Turn: ${state.turn === LIGHT ? "WHITE" : "BLACK"}`;
	const diff = getDifficultySettings(state.aiLevel);
	aiText.textContent = state.aiEnabled ? `AI: ${diff.name} (${state.aiColor === LIGHT ? "WHITE" : "BLACK"})` : "AI: OFF";
	if (state.gameOver && state.winner) msgText.textContent = state.winner === "Draw" ? "Draw" : `${state.winner} wins`;
	else msgText.textContent = state.message || "Ready";
	capText.textContent = `Captures W:${state.captures[LIGHT]} B:${state.captures[DARK]}`;
	if (state.lastMove) {
		const { from, to } = state.lastMove;
		lastMoveText.textContent = `Last: ${String.fromCharCode(97 + from.x)}${ROWS - from.y}${String.fromCharCode(97 + to.x)}${ROWS - to.y}`;
	} else {
		lastMoveText.textContent = "Last: --";
	}
  try {
    const oi = getCurrentOpeningInfo();
    if (openingText) openingText.textContent = oi ? `Opening: ${oi.eco ? oi.eco + ' — ' : ''}${oi.name}` : 'Opening: --';
  } catch (e) { /* ignore */ }
	renderMoveList();
};

// Initialize navigation UI on load
attachUIButtons();


	function updateTrainingNotes(msg) {
		const el = trainingNotesEl || document.getElementById("trainingNotes");
		trainingMessage = msg ?? "--";
		if (!el) return;
		el.textContent = trainingMessage;
		el.classList.remove("tn-flash");
		void el.offsetWidth;
		el.classList.add("tn-flash");
	}

	function clearTrainingNotes() {
		const el = trainingNotesEl || document.getElementById("trainingNotes");
		trainingMessage = "--";
		if (el) el.textContent = trainingMessage;
	}

	function syncTrainingNotes() {
		updateTrainingNotes(trainingMessage);
	}
	function setBoardInput(enabled) {
		uiLayer.style.pointerEvents = enabled ? "auto" : "none";
	}

	function resize() {
		const rect = container.getBoundingClientRect();
		layout.width = rect.width;
		layout.height = rect.height;
		[boardLayer, piecesLayer, uiLayer].forEach(c => {
			c.width = layout.width * dpr;
			c.height = layout.height * dpr;
			c.style.width = `${layout.width}px`;
			c.style.height = `${layout.height}px`;
			const ctx = c.getContext("2d");
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		});

		const boardSize = Math.min(layout.width, layout.height) * 0.94;
		layout.cell = boardSize / Math.max(COLS, ROWS);
		layout.offsetX = (layout.width - layout.cell * COLS) / 2;
		layout.offsetY = (layout.height - layout.cell * ROWS) / 2;
		maybeRunAI();
	}
	function drawBoard(ctx) {
		ctx.clearRect(0, 0, layout.width, layout.height);
		const boardW = layout.cell * COLS;
		const boardH = layout.cell * ROWS;

		ctx.fillStyle = "#0f1117"; // Set background color for the board
		ctx.fillRect(0, 0, layout.width, layout.height);
		ctx.fillStyle = "#1b1f29";
		ctx.fillRect(layout.offsetX - 6, layout.offsetY - 6, boardW + 12, boardH + 12);

		const light = "#2f303a";
		const dark = "#454552";
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const even = (x + y) % 2 === 0;
				ctx.fillStyle = even ? light : dark;
				ctx.fillRect(layout.offsetX + x * layout.cell, layout.offsetY + y * layout.cell, layout.cell, layout.cell);
			}
		}

		ctx.strokeStyle = "#2f3340";
		ctx.lineWidth = 4;
		ctx.strokeRect(layout.offsetX - 2, layout.offsetY - 2, boardW + 4, boardH + 4);

		// (Removed last move arrow)
	}

	// Draw an arrow from one square to another
	function drawArrow(ctx, from, to, color = "#6ec1ff", width = 5, head = 16) {
		const fx = layout.offsetX + (from.x + 0.5) * layout.cell;
		const fy = layout.offsetY + (from.y + 0.5) * layout.cell;
		const tx = layout.offsetX + (to.x + 0.5) * layout.cell;
		const ty = layout.offsetY + (to.y + 0.5) * layout.cell;
		const dx = tx - fx, dy = ty - fy;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len < 10) return;
		const nx = dx / len, ny = dy / len;
		const arrowHead = head;
		const arrowWidth = width;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = arrowWidth;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(fx, fy);
		ctx.lineTo(tx - nx * arrowHead, ty - ny * arrowHead);
		ctx.stroke();
		// Arrowhead
		ctx.beginPath();
		ctx.moveTo(tx - nx * arrowHead, ty - ny * arrowHead);
		ctx.lineTo(tx - ny * arrowHead * 0.4 - nx * arrowHead * 0.3, ty + nx * arrowHead * 0.4 - ny * arrowHead * 0.3);
		ctx.lineTo(tx, ty);
		ctx.lineTo(tx + ny * arrowHead * 0.4 - nx * arrowHead * 0.3, ty - nx * arrowHead * 0.4 - ny * arrowHead * 0.3);
		ctx.lineTo(tx - nx * arrowHead, ty - ny * arrowHead);
		ctx.fillStyle = color;
		ctx.fill();
		ctx.restore();
	}

	function drawPieces(ctx) {
		ctx.clearRect(0, 0, layout.width, layout.height);
		ctx.font = `${layout.cell * 0.58}px "Segoe UI Symbol"`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const piece = state.board[y][x];
				if (!piece) continue;
				const cx = layout.offsetX + x * layout.cell + layout.cell / 2;
				const cy = layout.offsetY + y * layout.cell + layout.cell / 2;
				ctx.fillStyle = piece.color === LIGHT ? "#f5f5f5" : "#0c0c0f";
				if (GLYPHS[piece.type] && GLYPHS[piece.type][piece.color]) {
					ctx.fillText(GLYPHS[piece.type][piece.color], cx, cy + layout.cell * 0.02);
				}
			}
		}

		const ui = uiLayer.getContext("2d");
		ui.clearRect(0, 0, layout.width, layout.height);

		// Highlight hint move (arrow)
		if (hintMove) {
			drawArrow(ui, hintMove.from, hintMove.to, "#ffd166", 6, 18);
			drawCellFill(ui, hintMove.from.x, hintMove.from.y, "rgba(255, 209, 102, 0.32)");
			drawCellFill(ui, hintMove.to.x, hintMove.to.y, "rgba(110, 193, 255, 0.30)");
		}

		// Highlight selected piece and legal moves
		if (state.selected) {
			drawCellOutline(ui, state.selected.x, state.selected.y, "#6ec1ff", 3);
			state.legal.forEach(m => {
				drawCellFill(ui, m.to.x, m.to.y, "rgba(255, 255, 0, 0.18)");
				drawCellOutline(ui, m.to.x, m.to.y, "#ffd166", 2);
			});
		}

		// Highlight last move squares if within 3 seconds
		if (state.lastMove && lastMoveArrowTimestamp && Date.now() - lastMoveArrowTimestamp < 3000) {
			drawCellOutline(ui, state.lastMove.from.x, state.lastMove.from.y, "#64b5f6", 2);
			drawCellOutline(ui, state.lastMove.to.x, state.lastMove.to.y, "#64b5f6", 2);
		}

		drawCursor(ui);
		drawUI(ui);
	}

	function drawCellFill(ctx, x, y, fill) {
		ctx.fillStyle = fill;
		ctx.fillRect(Math.round(layout.offsetX + x * layout.cell + 2), Math.round(layout.offsetY + y * layout.cell + 2), Math.round(layout.cell - 4), Math.round(layout.cell - 4));
	}

	function drawCellOutline(ctx, x, y, color, w) {
		ctx.strokeStyle = color;
		ctx.lineWidth = w;
		ctx.strokeRect(Math.round(layout.offsetX + x * layout.cell + 2) + 0.5, Math.round(layout.offsetY + y * layout.cell + 2) + 0.5, Math.round(layout.cell - 4), Math.round(layout.cell - 4));
	}

	function drawCursor(ctx) {
		const { x, y } = state.cursor;
		drawCellOutline(ctx, x, y, "#6ec1ff", 2);
	}

	function drawUI(ctx) {
		if (state.gameOver) {
			ctx.fillStyle = "rgba(0,0,0,0.7)";
			ctx.fillRect(14, 14, 240, 46);
			ctx.fillStyle = "#fff";
			ctx.font = "16px system-ui, sans-serif";
			ctx.fillText(`Result: ${state.winner || "Draw"}`, 24, 42);
		}
	}

	function getPieceSprite(type, color, size) {
		const key = `${type}-${color}-${Math.round(size)}-${dpr}`;
		if (pieceCache.has(key)) return pieceCache.get(key);
		const canvas = document.createElement("canvas");
		const dim = Math.ceil(size);
		canvas.width = dim * dpr;
		canvas.height = dim * dpr;
		const c = canvas.getContext("2d");
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.textAlign = "center";
		c.textBaseline = "middle";
		c.font = `700 ${size * 0.9}px "Segoe UI Symbol", "Noto Sans Symbols", serif`;
		c.fillStyle = color === LIGHT ? "#f5f5f5" : "#0c0c0f";
		const g = GLYPHS[type][color];
		c.fillText(g, dim / 2, dim / 2 + size * 0.02);
		pieceCache.set(key, canvas);
		return canvas;
	}

	function clickCell(x, y) {
		if (state.menuActive) return;
		const piece = state.board[y][x];
		if (state.selected) {
			const mv = state.legal.find(m => m.to.x === x && m.to.y === y);
			if (mv) {
				makeMove(mv);
				state.selected = null;
				state.legal = [];
				return;
			}
		}
		if (piece && piece.color === state.turn) {
			state.selected = { x, y };
			state.legal = genLegalMovesForSquare(x, y);
			state.cursor = { x, y };
			state.message = "";
		} else {
			state.selected = null;
			state.legal = [];
		}
		updateHud();
		render();
	}


	function moveCursor(dx, dy) {
		if (state.menuActive) return;
		state.cursor.x = Math.max(0, Math.min(COLS - 1, state.cursor.x + dx));
		state.cursor.y = Math.max(0, Math.min(ROWS - 1, state.cursor.y + dy));
		state.message = "";
		render();
		updateHud();
	}


	function maybeRunAI() {
		if (!state.aiEnabled) return;
		if (state.menuActive) return;
		if (state.gameOver) return;
		if (state.turn !== state.aiColor) return;
		if (state.thinking) return;
    // Prevent stale AI callbacks from making moves after navigation/undo/goToMove.
    if (typeof window.__aiThinkToken !== 'number') window.__aiThinkToken = 0;
    if (typeof window.__aiThinkTimer === 'undefined') window.__aiThinkTimer = null;
    const myToken = ++window.__aiThinkToken;
    const turnAtSchedule = state.turn;
    const aiColorAtSchedule = state.aiColor;
    state.thinking = true;
    const { thinkTimeMs } = getDifficultySettings(state.aiLevel);
    if (window.__aiThinkTimer) clearTimeout(window.__aiThinkTimer);
    window.__aiThinkTimer = setTimeout(() => {
      // Drop if superseded or context changed.
      if (myToken !== window.__aiThinkToken) { state.thinking = false; return; }
      if (!state.aiEnabled || state.menuActive || state.gameOver) { state.thinking = false; return; }
      if (state.turn !== turnAtSchedule || state.aiColor !== aiColorAtSchedule) { state.thinking = false; return; }
      const w = ensureAIWorker();
      if (!w) {
        // Fallback: keep old behavior if worker can't start.
        // Note: this will block the UI thread.
        const mv = aiChooseMove();
        if (mv) makeMove(mv);
        try { syncTrainingNotes(); } catch (e) { /* ignore */ }
        state.thinking = false;
        return;
      }
      // Post a search request; the worker will reply asynchronously.
      const snapshot = snapshotForAIWorker();
      const settings = getDifficultySettings(state.aiLevel);
      postAIWorkerRequest({
        type: 'search',
        token: myToken,
        snapshot,
        settings,
        aiColor: state.aiColor,
        aiLevel: state.aiLevel
      }, {
        onResult: (msg) => {
          if (myToken !== window.__aiThinkToken) { state.thinking = false; return; }
          if (!state.aiEnabled || state.menuActive || state.gameOver) { state.thinking = false; return; }
          if (state.turn !== turnAtSchedule || state.aiColor !== aiColorAtSchedule) { state.thinking = false; return; }
          if (msg && Number.isFinite(msg.nodes)) {
            updateEngineInfo({ depth: settings.searchDepth, nodes: msg.nodes, evalScore: undefined });
            if (typeof updateEngineInfo.flush === 'function') updateEngineInfo.flush();
            setTimeout(() => { try { clearEngineInfo(); } catch (e) { /* ignore */ } }, 800);
          }
          const mv = msg.move;
          if (mv) makeMove(mv);
          try { syncTrainingNotes(); } catch (e) { /* ignore */ }
          state.thinking = false;
        },
        onError: () => { state.thinking = false; }
      });
    }, thinkTimeMs);
	}

	function renderHistory() {
		const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
		moveList.innerHTML = state.moveHistory.map((mv, i) => {
			if (mv.castle === "kingside") return `<div class="move-line">${i + 1}. O-O${mv.mate ? "#" : mv.check ? "+" : ""}</div>`;
			if (mv.castle === "queenside") return `<div class="move-line">${i + 1}. O-O-O${mv.mate ? "#" : mv.check ? "+" : ""}</div>`;
			const captureMark = mv.captured ? "x" : "";
			const promo = mv.promoted ? "=Q" : "";
			const suffix = mv.mate ? "#" : mv.check ? "+" : "";
			const piecePart = mv.piece.type === "P" ? (captureMark ? String.fromCharCode(97 + mv.from.x) : "") : mv.piece.type;
			return `<div class="move-line">${i + 1}. ${piecePart}${captureMark}${sq(mv.to.x, mv.to.y)}${promo}${suffix}</div>`;
		}).join("");
	}

	function toggleHistory(force) {
    if (document.body.classList.contains('mobile-nav')) {
      if (force === false) {
        if (typeof closeDrawer === 'function') closeDrawer();
        return;
      }
      if (typeof openMovesPanel === 'function') openMovesPanel();
      return;
    }
    const show = force !== undefined ? force : !historyPanel.classList.contains("show");
    historyPanel.classList.toggle("show", show);
	}

	function toggleRules(force) {
		const show = force !== undefined ? force : !rulesOverlay.classList.contains("show");
		rulesOverlay.classList.toggle("show", show);
	}


  // ============================================================================
  // Mobile Navigation: Bottom Toolbar + Slide-up Drawer
  // ============================================================================

  let _mobileNavState = {
    enabled: false,
    lastPanel: 'moves',
    originalHomes: new Map()
  };

  function _isMobileNavCandidate() {
    return window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
  }

  function _rememberHome(node) {
    if (!node || _mobileNavState.originalHomes.has(node)) return;
    _mobileNavState.originalHomes.set(node, { parent: node.parentNode, next: node.nextSibling });
  }

  function _restoreHome(node) {
    const home = _mobileNavState.originalHomes.get(node);
    if (!node || !home || !home.parent) return;
    try {
      home.parent.insertBefore(node, home.next);
    } catch (e) {
      // Ignore DOM errors (e.g., parent removed)
    }
  }

  function _setMobileNavEnabled(on) {
    _mobileNavState.enabled = !!on;
    document.body.classList.toggle('mobile-nav', _mobileNavState.enabled);
  }

  function _drawerEls() {
    return {
      drawer: document.getElementById('drawer'),
      scrim: document.getElementById('drawer-scrim'),
      content: document.getElementById('drawer-content'),
      toolbar: document.getElementById('bottom-toolbar')
    };
  }

  function _blurActiveEditable() {
    try {
      const el = document.activeElement;
      if (!el) return;
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        el.blur();
      }
    } catch (e) {
      // ignore
    }
  }

  function openDrawer(panelKey) {
    const { drawer, scrim } = _drawerEls();
    if (!drawer || !scrim) return;
    if (!_mobileNavState.enabled) return;

    // Avoid Android keyboard popping due to stale focus.
    _blurActiveEditable();

    if (panelKey) _mobileNavState.lastPanel = panelKey;
    drawer.classList.add('open');
    scrim.classList.add('show');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.setAttribute('aria-hidden', 'false');
    setBoardInput(false);
  }

  function closeDrawer() {
    const { drawer, scrim } = _drawerEls();
    if (!drawer || !scrim) return;

    // Ensure no input remains focused (prevents Android keyboard reopening).
    _blurActiveEditable();

    drawer.classList.remove('open');
    scrim.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.setAttribute('aria-hidden', 'true');
    setBoardInput(!state.menuActive);
  }

  function _setActiveDrawerTab(panelKey) {
    const { drawer } = _drawerEls();
    if (!drawer) return;
    const tabs = drawer.querySelectorAll('[data-panel]');
    tabs.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-panel') === panelKey));
  }

  function _mountIntoDrawer(node) {
    const { content } = _drawerEls();
    if (!content || !node) return;
    content.innerHTML = '';
    content.appendChild(node);
  }

  function openMovesPanel() {
    if (!_mobileNavState.enabled) return;
    // On small screens CSS normally hides #history unless it has .show.
    historyPanel.classList.add('show');
    _rememberHome(historyPanel);
    _mountIntoDrawer(historyPanel);
    _setActiveDrawerTab('moves');
    openDrawer('moves');
  }

  function openSearchPanel(opts) {
    if (!_mobileNavState.enabled) return;
    const shouldFocus = !(opts && opts.focus === false);
    openMovesPanel();
    _setActiveDrawerTab('search');
    openDrawer('search');
    if (shouldFocus) {
      setTimeout(() => {
        const el = document.getElementById('pgnSearch');
        if (el) {
          el.focus();
          try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
        }
      }, 0);
    }
  }

  function openEnginePanel() {
    if (!_mobileNavState.enabled) return;
    const enginePanel = document.getElementById('engine-info-panel') || (typeof createEngineInfoPanel === 'function' ? createEngineInfoPanel() : null);
    if (!enginePanel) return;
    _rememberHome(enginePanel);
    _mountIntoDrawer(enginePanel);
    _setActiveDrawerTab('engine');
    openDrawer('engine');
  }

  function openTrainingPanel() {
    if (!_mobileNavState.enabled) return;
    const trainingPanel = document.getElementById('training-panel');
    if (!trainingPanel) return;
    _rememberHome(trainingPanel);
    _mountIntoDrawer(trainingPanel);
    _setActiveDrawerTab('training');
    openDrawer('training');
  }

  function openMetaPanel() {
    if (!_mobileNavState.enabled) return;
    const meta = document.getElementById('meta-panel');
    const status = document.getElementById('status-panel');
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '12px';
    wrap.id = 'drawer-meta-wrap';

    // Restore any previous wrap content to avoid duplicates
    const oldWrap = document.getElementById('drawer-meta-wrap');
    if (oldWrap && oldWrap.parentNode) oldWrap.parentNode.removeChild(oldWrap);

    if (meta) { _rememberHome(meta); wrap.appendChild(meta); }
    if (status) { _rememberHome(status); wrap.appendChild(status); }

    _mountIntoDrawer(wrap);
    _setActiveDrawerTab('meta');
    openDrawer('meta');
  }

  function openControlsPanel() {
    if (!_mobileNavState.enabled) return;
    const controlsPanel = document.getElementById('controls');
    if (!controlsPanel) return;
    _rememberHome(controlsPanel);
    _mountIntoDrawer(controlsPanel);
    _setActiveDrawerTab(null);
    openDrawer('controls');
  }

  function _wireMobileToolbar() {
    const { toolbar } = _drawerEls();
    if (!toolbar) return;

    const btnStart = toolbar.querySelector('[data-action="start"]');
    const btnUndo = toolbar.querySelector('[data-action="undo"]');
    const btnRedo = toolbar.querySelector('[data-action="redo"]');
    const btnEnd = toolbar.querySelector('[data-action="end"]');
    const btnMenu = toolbar.querySelector('[data-action="menu"]');

    if (btnStart) btnStart.onclick = undoToStart;
    if (btnUndo) btnUndo.onclick = undoMove;
    if (btnRedo) btnRedo.onclick = redoMove;
    if (btnEnd) btnEnd.onclick = redoToEnd;
    if (btnMenu) btnMenu.onclick = () => {
      // Default to last panel, fall back to controls
      const last = _mobileNavState.lastPanel || 'moves';
      if (last === 'engine') openEnginePanel();
      else if (last === 'training') openTrainingPanel();
      else if (last === 'meta') openMetaPanel();
      else if (last === 'search') openSearchPanel({ focus: false });
      else openMovesPanel();
    };
  }

  function _wireDrawerChrome() {
    const { drawer, scrim } = _drawerEls();
    if (!drawer || !scrim) return;

    const closeBtn = drawer.querySelector('[data-action="close-drawer"]');
    if (closeBtn) closeBtn.onclick = closeDrawer;
    scrim.onclick = closeDrawer;

    const tabs = drawer.querySelectorAll('[data-panel]');
    tabs.forEach(btn => {
      btn.onclick = () => {
        const key = btn.getAttribute('data-panel');
        if (key === 'moves') openMovesPanel();
        else if (key === 'search') openSearchPanel({ focus: true });
        else if (key === 'controls') openControlsPanel();
        else if (key === 'engine') openEnginePanel();
        else if (key === 'training') openTrainingPanel();
        else if (key === 'meta') openMetaPanel();
      };
    });
  }

  function _enableMobileNav() {
    _setMobileNavEnabled(true);
	try { if (typeof window.mountPGNNavigation === 'function') window.mountPGNNavigation(); } catch (e) {}
    _wireMobileToolbar();
    _wireDrawerChrome();

    // Move core panels into drawer so they remain usable even when the sidebar is hidden.
    // Default content: Moves panel.
    openMovesPanel();
    closeDrawer();
  }


  function _disableMobileNav() {
    _setMobileNavEnabled(false);
    closeDrawer();
	try { if (typeof window.mountPGNNavigation === 'function') window.mountPGNNavigation(); } catch (e) {}

    // Restore moved panels back to their original homes.
    const controlsPanel = document.getElementById('controls');
    const enginePanel = document.getElementById('engine-info-panel');
    const trainingPanel = document.getElementById('training-panel');
    const meta = document.getElementById('meta-panel');
    const status = document.getElementById('status-panel');

    _restoreHome(historyPanel);
    _restoreHome(controlsPanel);
    _restoreHome(enginePanel);
    _restoreHome(trainingPanel);
    _restoreHome(meta);
    _restoreHome(status);
  }

  function initMobileNav() {
    const { drawer, content, toolbar } = _drawerEls();
    if (!drawer || !content || !toolbar) return;

    const shouldEnable = _isMobileNavCandidate();
    if (shouldEnable && !_mobileNavState.enabled) _enableMobileNav();
    else if (!shouldEnable && _mobileNavState.enabled) _disableMobileNav();
  }

	function showStartOverlay() {
		startOverlay.classList.add("show");
		state.menuActive = true;
		setBoardInput(false);
	}
function updateHud() {
		turnText.textContent = `Turn: ${state.turn === LIGHT ? "WHITE" : "BLACK"}`;
		const diff = getDifficultySettings(state.aiLevel);
		aiText.textContent = state.aiEnabled ? `AI: ${diff.name} (${state.aiColor === LIGHT ? "WHITE" : "BLACK"})` : "AI: OFF";
		if (state.gameOver && state.winner) msgText.textContent = state.winner === "Draw" ? "Draw" : `${state.winner} wins`;
		else msgText.textContent = state.message || "Ready";
		capText.textContent = `Captures W:${state.captures[LIGHT]} B:${state.captures[DARK]}`;
		if (state.lastMove) {
			const { from, to } = state.lastMove;
			lastMoveText.textContent = `Last: ${String.fromCharCode(97 + from.x)}${ROWS - from.y}${String.fromCharCode(97 + to.x)}${ROWS - to.y}`;
		} else {
			lastMoveText.textContent = "Last: --";
		}
		renderHistory();
	}

	function start1P() {
		state.aiEnabled = true;
		state.aiColor = DARK;
		state.menuActive = false;
		setBoardInput(true);
		startOverlay.classList.remove("show");
		resetBoard();
		applyDifficultyUI();
		render();
		updateHud();
		maybeRunAI();
	}

	function start2P() {
		state.aiEnabled = false;
		state.menuActive = false;
		setBoardInput(true);
		startOverlay.classList.remove("show");
		resetBoard();
		applyDifficultyUI();
		render();
		updateHud();
	}

	function startSelected() {
		setDifficulty(selectedDiff);
		if (selectedMode === "1p") start1P(); else start2P();
	}

	function setDifficulty(level) {
		state.aiLevel = Math.min(15, Math.max(1, Math.round(level)));
		selectedDiff = state.aiLevel;
		currentDifficulty = getDifficultySettings(state.aiLevel);
		mobileExpandedLevel = state.aiLevel;
		applyDifficultyUI();
		updateHud();
	}

	function applyModeUI() {
		[btn1p, btn2p].forEach(b => b.classList.remove("active"));
		if (selectedMode === "1p") btn1p.classList.add("active"); else btn2p.classList.add("active");
	}

	function applyDifficultyUI() {
		if (diffSelect) diffSelect.value = String(state.aiLevel);
		selectedDiff = state.aiLevel;
		updateMobileDifficultyUI();
	}

	function cycleDiff(delta) {
		const next = selectedDiff + delta;
		selectedDiff = next < 1 ? 15 : next > 15 ? 1 : next;
		state.aiLevel = selectedDiff;
		currentDifficulty = getDifficultySettings(state.aiLevel);
		applyDifficultyUI();
	}

	function renderMobileDifficulty() {
		if (!difficultyMobile) return;
		const frag = document.createDocumentFragment();
		for (let lvl = 1; lvl <= 15; lvl++) {
			const info = getDifficultySettings(lvl);
			const item = document.createElement("div");
			item.className = "diff-mobile-item";
			item.dataset.level = String(lvl);
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "diff-mobile-btn";
			btn.innerHTML = `<span>${lvl}. ${info.name}</span><span class="range">${info.mobile?.range || ""}</span>`;
			btn.addEventListener("click", () => {
				const expandTo = mobileExpandedLevel === lvl ? null : lvl;
				setDifficulty(lvl);
				mobileExpandedLevel = expandTo;
				updateMobileDifficultyUI();
			});
			const detail = document.createElement("div");
			detail.className = "diff-mobile-detail";
			const range = info.mobile?.range || "";
			const desc = info.mobile?.desc || "";
			detail.innerHTML = `<div class="elo">${range}</div><p>${desc}</p>`;
			item.append(btn, detail);
			frag.appendChild(item);
		}
		difficultyMobile.innerHTML = "";
		difficultyMobile.appendChild(frag);
		updateMobileDifficultyUI();
	}

	function updateMobileDifficultyUI() {
		if (!difficultyMobile) return;
		const items = difficultyMobile.querySelectorAll(".diff-mobile-item");
		items.forEach(item => {
			const lvl = Number(item.dataset.level);
			const isSelected = state.aiLevel === lvl;
			const isExpanded = mobileExpandedLevel === lvl;
			item.classList.toggle("selected", isSelected);
			item.classList.toggle("expanded", isExpanded);
			const detail = item.querySelector(".diff-mobile-detail");
			if (detail) detail.style.maxHeight = isExpanded ? `${detail.scrollHeight}px` : "0px";
		});
	}

	function handlePointer(e) {
		if (state.menuActive) return;
		const rect = uiLayer.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const x = Math.floor((mx - layout.offsetX) / layout.cell);
		const y = Math.floor((my - layout.offsetY) / layout.cell);
		if (!onBoard(x, y)) return;
		state.cursor = { x, y };
		clickCell(x, y);
	}

	function handleKey(e) {
		// Do not intercept keys when typing into inputs/textareas/contenteditable elements
		const active = document.activeElement;
		if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
		const key = e.key.toLowerCase();
		if (rulesOverlay.classList.contains("show")) {
			if (["h","escape","enter"," "].includes(key)) toggleRules(false);
			return;
		}
		if (state.menuActive) {
			if (key === "1") { selectedMode = "1p"; applyModeUI(); }
			else if (key === "2") { selectedMode = "2p"; applyModeUI(); }
			else if (key === "arrowup" || key === "w") { cycleDiff(-1); }
			else if (key === "arrowdown" || key === "s") { cycleDiff(1); }
			else if (key === "enter" || key === " ") { startSelected(); }
			return;
		}
		if (key === "arrowup" || key === "w") moveCursor(0, -1);
		else if (key === "arrowdown" || key === "s") moveCursor(0, 1);
		else if (key === "arrowleft" || key === "a") moveCursor(-1, 0);
		else if (key === "arrowright" || key === "d") moveCursor(1, 0);
		else if (key === "enter" || key === " ") { clickCell(state.cursor.x, state.cursor.y); }
		else if (key === "escape") { state.selected = null; state.legal = []; state.message = ""; render(); updateHud(); return; }
		else if (key === "u") { undo(); }
		else if (key === "r") { resetBoard(); render(); updateHud(); }
		else if (key === "h") { toggleRules(); }
		render();
		updateHud();
	}

	function requestHintDepth2() {
		requestHint(2);
	}

	function requestHintDepth4() {
		requestHint(4);
	}
	function setHintToggle(hint1Active) {
		if (!btnHint || !btnHint2) return;
		if (hint1Active === null || hint1Active === undefined) {
			btnHint.classList.remove("active-hint");
			btnHint2.classList.remove("active-hint");
			return;
		}
		btnHint.classList.toggle("active-hint", hint1Active);
		btnHint2.classList.toggle("active-hint", hint1Active === false);
	}

	function requestHint(depth) {
		// Always reset all hint state before computing
		clearHintHighlight();
		clearHintCache();
		resetHintRequestState();
		clearTrainingNotes();
		hintVisible = false;
		render();
		const ctxSnap = cloneCtx(state.board, state.castling, state.enPassant);
		const turnColor = state.turn;
		const mv = depth === 2 ? computeHint2(ctxSnap, turnColor) : computeHint4(ctxSnap, turnColor);
		hintMove = mv;
		hintVisible = !!mv;
		hintBusy = false;
		hintTimer = null;
		if (mv) {
			const evalBefore = evaluateBoard(ctxSnap.board, turnColor);
			const sim = simulateMove(mv, ctxSnap.board, ctxSnap.castling, ctxSnap.enPassant);
			const evalAfter = evaluateBoard(sim.board, turnColor);
			const note = explainMove(mv, evalBefore, evalAfter);
			updateTrainingNotes(note);
		}
		render();
	}

	function computeHint2(ctxSnapshot, color) { // depth 2 fixed
		return computeHintFixedDepth(ctxSnapshot, color, 2);
	}

	function computeHint4(ctxSnapshot, color) { // depth 4 fixed
		return computeHintFixedDepth(ctxSnapshot, color, 4);
	}

	function computeHintFixedDepth(ctxSnapshot, color, depth) {
		const legal = generateLegalMovesFor(ctxSnapshot.board, ctxSnapshot.castling, ctxSnapshot.enPassant, color);
		if (!legal.length) return null;
		const deadline = Infinity; // ensure full fixed-depth search; no iterative deepening
		const res = searchBestMove(ctxSnapshot, depth, -Infinity, Infinity, color, color, deadline, 0);
		return res?.move || null;
	}

	function render() {
		drawBoard(boardLayer.getContext("2d"));
		drawPieces(piecesLayer.getContext("2d"));
	}

	function clearHint() {
		hintMove = null;
		hintBusy = false;
		if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
		setHintToggle(null);
	}

	function clearHintHighlight() {
		hintMove = null;
		hintVisible = false;
		// Remove any visual hint artifacts immediately
		setHintToggle(null);
		render();
	}

	function clearHintCache() {
		// Reset all caches used by hint searches to avoid stale data.
		if (TT?.clear) TT.clear();
		if (Array.isArray(PAWN_TT)) PAWN_TT.fill(null);
		if (Array.isArray(EVAL_TT)) EVAL_TT.fill(null);
	}


	function resetHintRequestState() {
		if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
		hintBusy = false;
		hintMove = null;
		hintRequestToken += 1;
	}

	resetBoard();
	resize();
	applyDifficultyUI();
	applyModeUI();
	renderMobileDifficulty();
	setBoardInput(false);
	render();
	updateHud();

  if (window.PointerEvent) {
    uiLayer.addEventListener("pointerdown", handlePointer);
  } else {
    uiLayer.addEventListener("mousedown", handlePointer);
    uiLayer.addEventListener("touchstart", handlePointer, { passive: true });
  }
  window.addEventListener("resize", () => {
    resize();
    render();
    if (typeof initMobileNav === 'function') initMobileNav();
  });
	window.addEventListener("keydown", handleKey);
	btn1p.addEventListener("click", () => { selectedMode = "1p"; applyModeUI(); });
	btn2p.addEventListener("click", () => { selectedMode = "2p"; applyModeUI(); });
	if (diffSelect) diffSelect.addEventListener("change", () => setDifficulty(Number(diffSelect.value)));
	btnStartOverlay.addEventListener("click", startSelected);
	btnRules.addEventListener("click", () => toggleRules(true));
	closeRules.addEventListener("click", () => toggleRules(false));
	hudBtnStart.addEventListener("click", showStartOverlay);
	hudBtnReset.addEventListener("click", () => { resetBoard(); render(); updateHud(); });
	btnHint.addEventListener("click", () => { setHintToggle(true); requestHintDepth2(); });
	btnHint2.addEventListener("click", () => { setHintToggle(false); requestHintDepth4(); });
	hudBtnHistory.addEventListener("click", () => toggleHistory());
	btnHistoryClose.addEventListener("click", () => toggleHistory(false));

  // Mobile navigation (bottom toolbar + drawer)
  if (typeof initMobileNav === 'function') initMobileNav();


// ============================================================================
// Score Formatting
// ============================================================================

function formatScore(score) {
	if (!Number.isFinite(score)) return "0.00";

	// Check for mate scores
	const MATE_THRESHOLD = 9000;
	if (score > MATE_THRESHOLD) {
		const movesToMate = Math.ceil((10000 - score) / 2);
		return `#${movesToMate}`;
	}
	if (score < -MATE_THRESHOLD) {
		const movesToMate = Math.ceil((10000 + score) / 2);
		return `#-${movesToMate}`;
	}

  // Regular centipawn score (score is in pawns, convert to +/- format)
  const centipawns = Math.round(score * 100);
  const sign = centipawns >= 0 ? "+" : "";
  return `${sign}${(centipawns / 100).toFixed(2)}`;
}


// ============================================================================
// PV Line Formatting
// ============================================================================

function formatPVLine(pvMoves) {
	if (!pvMoves || pvMoves.length === 0) return "—";

	const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
	const formatted = [];

	for (let i = 0; i < Math.min(pvMoves.length, 8); i++) {
		const mv = pvMoves[i];
		
		if (mv.castle === "kingside") {
			formatted.push("O-O");
		} else if (mv.castle === "queenside") {
			formatted.push("O-O-O");
		} else {
			const piece = mv.piece?.type || "?";
			const capture = mv.captured || mv.enPassant ? "x" : "";
			const promo = mv.promo ? `=${mv.promo}` : "";
			const piecePart = piece === "P" ? (capture ? String.fromCharCode(97 + mv.from.x) : "") : piece;
			formatted.push(`${piecePart}${capture}${sq(mv.to.x, mv.to.y)}${promo}`);
		}
	}

	return formatted.join(" ");
}
// ============================================================================
// UI: Multi-PV Panel
// ============================================================================

function createMultiPVPanel() {
	const existingPanel = document.getElementById('multipv-panel');
	if (existingPanel) return existingPanel;

	const panel = document.createElement('div');
	panel.id = 'multipv-panel';
	panel.className = 'panel';
	panel.style.display = 'none'; // Hidden by default
	panel.innerHTML = `
		<h4>Analysis Lines</h4>
		<div id="multipv-lines" style="font-family: monospace; font-size: 12px; line-height: 1.6;"></div>
	`;

	// Insert after training panel
	const trainingPanel = document.getElementById('training-panel');
	if (trainingPanel && trainingPanel.parentNode) {
		trainingPanel.parentNode.insertBefore(panel, trainingPanel.nextSibling);
	}

	return panel;
}

function renderMultiPVLines(pvResults) {
	const panel = document.getElementById('multipv-panel');
	const linesContainer = document.getElementById('multipv-lines');
	
	if (!panel || !linesContainer) return;

	if (!pvResults || pvResults.length === 0 || multiPVConfig.lines <= 1) {
		panel.style.display = 'none';
		return;
	}

	panel.style.display = 'block';

	let html = '';
	for (let i = 0; i < pvResults.length; i++) {
		const result = pvResults[i];
		const isMain = i === 0;
		const lineNum = i + 1;
    const depth = result.depth ?? '--';
    const nodes = Number.isFinite(result.nodes) ? result.nodes : 0;
    const timeMs = Number.isFinite(result.timeMs) ? result.timeMs : 0;
    const nps = timeMs > 0 ? Math.round(nodes * 1000 / timeMs) : 0;
    const stats = `d${depth} · n${nodes.toLocaleString()} · ${timeMs}ms · ${nps.toLocaleString()} nps`;

		const bgColor = isMain ? 'rgba(110, 193, 255, 0.08)' : 'transparent';
		const borderLeft = isMain ? '3px solid var(--accent)' : '3px solid transparent';
		
		html += `
			<div style="
				margin-bottom: 8px;
				padding: 6px 8px;
				background: ${bgColor};
				border-left: ${borderLeft};
				border-radius: 6px;
				transition: background 0.2s;
			" 
			onmouseover="this.style.background='rgba(110, 193, 255, 0.12)'"
			onmouseout="this.style.background='${bgColor}'">
				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
					<span style="color: ${isMain ? 'var(--accent)' : 'var(--muted)'}; font-weight: ${isMain ? '700' : '400'};">
						${lineNum}.
					</span>
					<span style="
						color: ${result.score > 0 ? '#81c784' : result.score < 0 ? '#e57373' : 'var(--text)'};
						font-weight: 700;
						font-size: 13px;
					">
						${formatScore(result.score)}
					</span>
				</div>
        <div style="color: var(--muted); font-size: 10px; margin-bottom: 4px;">
          ${stats}
        </div>
				<div style="color: var(--muted); font-size: 11px; overflow-x: auto; white-space: nowrap;">
					${formatPVLine(result.pv)}
				</div>
			</div>
		`;
	}

	linesContainer.innerHTML = html;
}

// ============================================================================
// UI: Multi-PV Settings Control
// ============================================================================

function createMultiPVControl() {
	const controls = document.getElementById('controls');
	if (!controls) return;

	const existingControl = document.getElementById('multipv-control');
	if (existingControl) return;

	const controlDiv = document.createElement('div');
	controlDiv.id = 'multipv-control';
	controlDiv.style.cssText = 'display: flex; gap: 4px; width: 100%; margin-top: 8px;';

	const label = document.createElement('span');
	label.textContent = 'Lines:';
	label.style.cssText = 'color: var(--muted); font-size: 12px; align-self: center; margin-right: 4px;';

	const options = [
		{ value: 1, label: '1' },
		{ value: 2, label: '2' },
		{ value: 3, label: '3' },
		{ value: 5, label: '5' }
	];

	const buttons = [];
	for (const opt of options) {
		const btn = document.createElement('button');
		btn.textContent = opt.label;
		btn.dataset.lines = opt.value;
		btn.style.cssText = 'flex: 1; padding: 6px; font-size: 12px;';
		
		if (opt.value === multiPVConfig.lines) {
			btn.classList.add('active');
			btn.style.background = 'linear-gradient(135deg, #6ec1ff, #3f7cff)';
			btn.style.color = '#0b0d13';
		}

		btn.addEventListener('click', () => {
			const lines = parseInt(btn.dataset.lines, 10);
			setMultiPVLines(lines);
			
			// Update button states
			buttons.forEach(b => {
				b.classList.remove('active');
				b.style.background = '';
				b.style.color = '';
			});
			btn.classList.add('active');
			btn.style.background = 'linear-gradient(135deg, #6ec1ff, #3f7cff)';
			btn.style.color = '#0b0d13';
// Force hide panel immediately if single-PV
	if (lines <= 1) {
		const panel = document.getElementById('multipv-panel');
		if (panel) panel.style.display = 'none';
	}


		});

		buttons.push(btn);
		controlDiv.appendChild(btn);
	}

	controls.appendChild(label);
	controls.appendChild(controlDiv);
}

function setMultiPVLines(lines) {
	multiPVConfig.lines = lines;
	multiPVConfig.enabled = lines > 1;
	
	if (lines <= 1) {
		// Clear Multi-PV state when switching to single-PV
		multiPVConfig.currentResults = [];
		const panel = document.getElementById('multipv-panel');
		if (panel) {
			panel.style.display = 'none';
		}
		const linesContainer = document.getElementById('multipv-lines');
		if (linesContainer) {
			linesContainer.innerHTML = '';
		}
	}
}

// ============================================================================
// Integration: Update AI Move Selection
// ============================================================================

// NOTE: Do not override aiChooseMove here.
// When hosted over HTTP/HTTPS, AI move selection runs in the Web Worker (see maybeRunAI/autoplay).

function requestFixedDepthHintFromWorker(depth, color, onDone) {
	const d = Math.max(1, depth | 0);
	if (ensureAIWorker()) {
    if (typeof window.__aiAnalysisToken !== 'number') window.__aiAnalysisToken = 0;
		const snapshot = snapshotForAIWorker();
		const settings = getDifficultySettings(state.aiLevel);
		postAIWorkerRequest({
			type: 'fixedDepth',
      token: ++window.__aiAnalysisToken,
			snapshot,
			settings,
			aiColor: state.aiColor,
			aiLevel: state.aiLevel,
			depth: d,
			povColor: color,
			turnColor: color
		}, {
			onResult: onDone,
			onError: () => onDone && onDone({ type: 'error' })
		});
		return true;
	}
	return false;
}

function requestMultiPVFromWorker(depth, lines, color, onDone) {
	const d = Math.max(1, depth | 0);
	const l = Math.max(1, lines | 0);
	if (ensureAIWorker()) {
    if (typeof window.__aiAnalysisToken !== 'number') window.__aiAnalysisToken = 0;
		const snapshot = snapshotForAIWorker();
		const settings = getDifficultySettings(state.aiLevel);
		postAIWorkerRequest({
			type: 'multiPV',
      token: ++window.__aiAnalysisToken,
			snapshot,
			settings,
			aiColor: state.aiColor,
			aiLevel: state.aiLevel,
			depth: d,
			lines: l,
			povColor: color,
			turnColor: color
		}, {
			onResult: onDone,
			onError: () => onDone && onDone({ type: 'error' })
		});
		return true;
	}
	return false;
}

// ============================================================================
// Hint System Integration with Multi-PV
// ============================================================================

// Update hint functions to show Multi-PV analysis
const originalRequestHint = requestHint;

requestHint = function(depth) {
	clearHintHighlight();
	clearHintCache();
	resetHintRequestState();
	clearTrainingNotes();
	hintVisible = false;
	render();

	const ctxSnap = cloneCtx(state.board, state.castling, state.enPassant);
	const turnColor = state.turn;

	// If Multi-PV is enabled, show multiple lines
  const isMobileNav = !!(document.body && document.body.classList && document.body.classList.contains('mobile-nav'));
  const effectiveLines = isMobileNav ? Math.min(multiPVConfig.lines, 2) : multiPVConfig.lines;
  const effectiveDepth = isMobileNav ? Math.min(depth, 10) : depth;

	hintBusy = true;
	hintTimer = null;
	render();

  if (multiPVConfig.enabled && effectiveLines > 1) {
    const started = requestMultiPVFromWorker(effectiveDepth, effectiveLines, turnColor, (msg) => {
      const pvResults = (msg && msg.kind === 'multiPV' && Array.isArray(msg.results))
        ? msg.results.map(r => Object.assign({}, r, { timeMs: msg.timeMs }))
        : [];
      multiPVConfig.currentResults = pvResults;
      renderMultiPVLines(pvResults);

      const bestMove = pvResults[0]?.move;
      if (bestMove) {
        hintMove = bestMove;
        hintVisible = true;
        const evalBefore = evaluateBoard(ctxSnap.board, turnColor);
        const sim = simulateMove(bestMove, ctxSnap.board, ctxSnap.castling, ctxSnap.enPassant);
        const evalAfter = evaluateBoard(sim.board, turnColor);
        const note = explainMove(bestMove, evalBefore, evalAfter);
        updateTrainingNotes(note);
      }
      hintBusy = false;
      render();
    });

    if (!started) {
      // Fallback (file://)
      const pvResultsSync = searchMultiPV(ctxSnap, effectiveDepth, turnColor, turnColor, Infinity, effectiveLines);
      multiPVConfig.currentResults = pvResultsSync;
      renderMultiPVLines(pvResultsSync);
      const bestMove = pvResultsSync && pvResultsSync[0] && pvResultsSync[0].move;
      if (bestMove) {
        hintMove = bestMove;
        hintVisible = true;
        const evalBefore = evaluateBoard(ctxSnap.board, turnColor);
        const sim = simulateMove(bestMove, ctxSnap.board, ctxSnap.castling, ctxSnap.enPassant);
        const evalAfter = evaluateBoard(sim.board, turnColor);
        const note = explainMove(bestMove, evalBefore, evalAfter);
        updateTrainingNotes(note);
      }
      hintBusy = false;
      render();
    }
    return;
  }

  const started = requestFixedDepthHintFromWorker(effectiveDepth, turnColor, (msg) => {
    const mv = (msg && msg.kind === 'fixedDepth') ? msg.move : null;
    hintMove = mv;
    hintVisible = !!mv;
    if (mv) {
      const evalBefore = evaluateBoard(ctxSnap.board, turnColor);
      const sim = simulateMove(mv, ctxSnap.board, ctxSnap.castling, ctxSnap.enPassant);
      const evalAfter = evaluateBoard(sim.board, turnColor);
      const note = explainMove(mv, evalBefore, evalAfter);
      updateTrainingNotes(note);
    }
    hintBusy = false;
    render();
  });

  if (!started) {
    // Fallback (file://): keep old behavior.
    const mv = depth === 2 ? computeHint2(ctxSnap, turnColor) : computeHint4(ctxSnap, turnColor);
    hintMove = mv;
    hintVisible = !!mv;
    if (mv) {
      const evalBefore = evaluateBoard(ctxSnap.board, turnColor);
      const sim = simulateMove(mv, ctxSnap.board, ctxSnap.castling, ctxSnap.enPassant);
      const evalAfter = evaluateBoard(sim.board, turnColor);
      const note = explainMove(mv, evalBefore, evalAfter);
      updateTrainingNotes(note);
    }
    hintBusy = false;
    render();
  }
};

// ============================================================================
// Initialize Multi-PV UI
// ============================================================================

function initializeMultiPV() {
	createMultiPVPanel();
	createMultiPVControl();
}

// Call initialization after DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializeMultiPV);
} else {
	initializeMultiPV();
}

// ============================================================================
// Export Multi-PV API (for external access if needed)
// ============================================================================

window.multiPV = {
	setLines: setMultiPVLines,
	getConfig: () => ({ ...multiPVConfig }),
	getCurrentResults: () => multiPVConfig.currentResults,
	formatScore: formatScore,
	formatPVLine: formatPVLine
};



