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
const btnEngineTests = document.getElementById("btn-engine-tests");
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
  "eco": "A00",
  "name": "Uncommon Opening",
  "moves": ["a2a3","b2b3","d2d3","g2g4"]
},
  {
  "eco": "A00",
  "name": "Clemenz (Mead's-Basman's-de Klerk's) opening",
  "moves": [
    "h2h3"
  ]
},
  {
  "eco": "A00",
  "name": "Counter-counter (e4/d4) attack",
  "moves": [
    "e2e4","d7d5","d2d4"
  ]
},
  {
  "eco": "A00",
  "name": "Trident opening",
  "moves": [
    "g2g4"
  ]
},
  {
  "eco": "A00",
  "name": "Trident opening",
  "moves": [
    "g2g4"
  ]
},
  {
    "name": "Barnes Opening",
    "eco": "A00",
    "moves": ["f2f3"],
    "normalized": "barnes opening",
    "loose": "barnes opening"
  },
  {
    "name": "Clemenz Opening",
    "eco": "A00",
    "moves": ["h2h3"],
    "normalized": "clemenz opening",
    "loose": "clemenz opening"
  },
  {
    "name": "Creepy Crawly Opening (Basman)",
    "eco": "A00",
    "moves": ["h7h6"],
    "normalized": "creepy crawly opening basman",
    "loose": "creepy crawly opening basman"
  },
  {
    "name": "Fried Fox",
    "eco": "A00",
    "moves": ["f2f3","g7g5"],
    "normalized": "fried fox",
    "loose": "fried fox"
  },
  {
    "name": "Grob Gambit",
    "eco": "A00",
    "moves": ["g2g4","d7d5","f1g2","e7e5"],
    "normalized": "grob gambit",
    "loose": "grob gambit"
  },
  {
    "name": "Grob Gambit Accepted",
    "eco": "A00",
    "moves": ["g2g4","d7d5","g4g5","d5g4"],
    "normalized": "grob gambit accepted",
    "loose": "grob gambit accepted"
  },
  {
    "name": "Grob Gambit Accepted: Fritz Gambit",
    "eco": "A00",
    "moves": ["g2g4","d7d5","g4g5","d5g4","h2h3"],
    "normalized": "grob gambit accepted fritz gambit",
    "loose": "grob gambit accepted fritz gambit"
  },
  {
    "name": "Grob Gambit: 2...c6",
    "eco": "A00",
    "moves": ["g2g4","d7d5","f1g2","c7c6"],
    "normalized": "grob gambit 2 c6",
    "loose": "grob gambit 2 c6"
  },
  {
    "name": "Grob Gambit: e5",
    "eco": "A00",
    "moves": ["g2g4","d7d5","f1g2","e7e5"],
    "normalized": "grob gambit e5",
    "loose": "grob gambit e5"
  },
  {
    "name": "Grob Gambit: Hurst Attack",
    "eco": "A00",
    "moves": ["g2g4","d7d5","f1g2","c7c6","h2h3"],
    "normalized": "grob gambit hurst attack",
    "loose": "grob gambit hurst attack"
  },
  {
    "name": "Grob Gambit: Spike Attack",
    "eco": "A00",
    "moves": ["g2g4","d7d5","h2h4"],
    "normalized": "grob gambit spike attack",
    "loose": "grob gambit spike attack"
  },
  {
    "name": "Kadas Opening",
    "eco": "A00",
    "moves": ["h2h4"],
    "normalized": "kadas opening",
    "loose": "kadas opening"
  },
  {
    "name": "Spike Deferred",
    "eco": "A00",
    "moves": ["g2g4","d7d5","h2h3"],
    "normalized": "spike deferred",
    "loose": "spike deferred"
  },
  {
    "name": "Start position",
    "eco": "A00",
    "moves": [],
    "normalized": "start position",
    "loose": "start position"
  },
  {
    "name": "Van Geet",
    "eco": "A00",
    "moves": ["b1c3"],
    "normalized": "van geet",
    "loose": "van geet"
  },
  {
    "name": "Van Geet (Dunst) Opening",
    "eco": "A00",
    "moves": ["b1c3"],
    "normalized": "van geet dunst opening",
    "loose": "van geet dunst opening"
  },
  {
    "name": "Van Geet: Hector Gambit",
    "eco": "A00",
    "moves": ["b1c3","d7d5","e2e4"],
    "normalized": "van geet hector gambit",
    "loose": "van geet hector gambit"
  },
  {
    "name": "Van Geet: Sicilian Variation",
    "eco": "A00",
    "moves": ["b1c3","c7c5"],
    "normalized": "van geet sicilian variation",
    "loose": "van geet sicilian variation"
  },
  {
    "name": "Van Geet: Sicilian Variation, 2.Nf3",
    "eco": "A00",
    "moves": ["b1c3","c7c5","g1f3"],
    "normalized": "van geet sicilian variation 2 nf3",
    "loose": "van geet sicilian variation 2 nf3"
  },
  {
    "name": "Van Geet: Sicilian Variation, 2.Nf3 Nc6",
    "eco": "A00",
    "moves": ["b1c3","c7c5","g1f3","b8c6"],
    "normalized": "van geet sicilian variation 2 nf3 nc6",
    "loose": "van geet sicilian variation 2 nf3 nc6"
  },
  {
    "name": "Van Geet: Tuebingen Gambit",
    "eco": "A00",
    "moves": ["b1c3","d7d5","e2e4","d5e4","c3e4"],
    "normalized": "van geet tuebingen gambit",
    "loose": "van geet tuebingen gambit"
  },
  {
    "name": "Van Kruijs",
    "eco": "A00",
    "moves": ["e2e3"],
    "normalized": "van kruijs",
    "loose": "van kruijs"
  },
  {
    "name": "Ware Opening",
    "eco": "A00",
    "moves": ["a2a4"],
    "normalized": "ware opening",
    "loose": "ware opening"
  },
  {
    "name": "Ware Opening: 2.b3",
    "eco": "A00",
    "moves": ["a2a4","b7b6","b2b3"],
    "normalized": "ware opening 2 b3",
    "loose": "ware opening 2 b3"
  },
  {
    "name": "Ware Opening: 2.h4",
    "eco": "A00",
    "moves": ["a2a4","h7h5","h2h4"],
    "normalized": "ware opening 2 h4",
    "loose": "ware opening 2 h4"
  },
  {
    "name": "Ware Opening: Cologne Gambit",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5"],
    "normalized": "ware opening cologne gambit",
    "loose": "ware opening cologne gambit"
  },
  {
    "name": "Ware Opening: Meadow Hay Gambit",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","d7d5"],
    "normalized": "ware opening meadow hay gambit",
    "loose": "ware opening meadow hay gambit"
  },
  {
    "name": "Ware Opening: Ware Gambit",
    "eco": "A00",
    "moves": ["a2a4","d7d5","a4a5","e7e5"],
    "normalized": "ware opening ware gambit",
    "loose": "ware opening ware gambit"
  },
  {
    "name": "Ware Opening: Wing Gambit",
    "eco": "A00",
    "moves": ["a2a4","c7c5","a4a5"],
    "normalized": "ware opening wing gambit",
    "loose": "ware opening wing gambit"
  },
  {
    "name": "Ware Opening: Wing Gambit Deferred",
    "eco": "A00",
    "moves": ["a2a4","c7c5","g1f3","a4a5"],
    "normalized": "ware opening wing gambit deferred",
    "loose": "ware opening wing gambit deferred"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5"],
    "normalized": "ware opening zilbermints gambit",
    "loose": "ware opening zilbermints gambit"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4"],
    "normalized": "ware opening zilbermints gambit 3 e4",
    "loose": "ware opening zilbermints gambit 3 e4"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+ Qe7",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5","d8e7"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+ Qe7 6.Qxh8",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5","d8e7","e5h8"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+ Qe7 6.Qxh8 Nf6",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5","d8e7","e5h8","g8f6"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+ Qe7 6.Qxh8 Nf6 7.Bg5",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5","d8e7","e5h8","g8f6","c1g5"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6 7 bg5",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6 7 bg5"
  },
  {
    "name": "Ware Opening: Zilbermints Gambit, 3.e4 fxe4 4.Qh5+ g6 5.Qxe5+ Qe7 6.Qxh8 Nf6 7.Bg5 Kf7",
    "eco": "A00",
    "moves": ["a2a4","e7e5","a4a5","f7f5","e2e4","f5e4","d1h5","g7g6","h5e5","d8e7","e5h8","g8f6","c1g5","e8f7"],
    "normalized": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6 7 bg5 kf7",
    "loose": "ware opening zilbermints gambit 3 e4 fxe4 4 qh5 g6 5 qxe5 qe7 6 qxh8 nf6 7 bg5 kf7"
  },
  {
    "name": "Reversed Grob (Borg/Basman Defence)",
    "eco": "A00",
    "moves": ["g7g5"],
    "normalized": "reversed grob(borg/basman defense)",
    "loose": "reversed grob borg basman defense"
  },
  {
    "name": "Basman's Creepy-Crawly System (as Black)",
    "eco": "A00",
    "moves": ["g7g5","h7h6"],
    "normalized": "basman’s creepy-crawly system(as black)",
    "loose": "basman s creepy crawly system as black"
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
    "name": "Bird's opening",
    "moves": [
      "f2f4"
    ]
  },
  {
  "eco": "A02",
  "name": "Bird's Opening",
  "moves": ["f2f4"]
},
  {
    "eco": "A02",
    "name": "Bird, From gambit",
    "moves": [
      "f2f4",
      "e7e5"
    ]
  },
  {
    "eco": "A02",
    "name": "Bird, From gambit, Lasker Variation",
    "moves": [
      "f2f4",
      "e7e5",
      "f4e5",
      "d7d6",
      "e5d6",
      "f8d6",
      "g1f3",
      "g7g5"
    ]
  },
  {
    "eco": "A02",
    "name": "Bird, From gambit, Lipke Variation",
    "moves": [
      "f2f4",
      "e7e5",
      "f4e5",
      "d7d6",
      "e5d6",
      "f8d6",
      "g1f3",
      "g8h6",
      "d2d4"
    ]
  },
  {
    "eco": "A02",
    "name": "Bird, Hobbs gambit",
    "moves": [
      "f2f4",
      "g7g5"
    ]
  },
  {
    "eco": "A02",
    "name": "Bird's Opening, Swiss gambit",
    "moves": [
      "f2f4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "g2g4"
    ]
  },
  {
  "eco": "A03",
  "name": "Bird's Opening",
  "moves": ["f2f4","d7d5"]
},
  {
    "eco": "A03",
    "name": "Bird's Opening, Lasker Variation",
    "moves": [
      "f2f4",
      "d7d5",
      "g1f3",
      "g8f6",
      "e2e3",
      "c7c5"
    ]
  },
  {
    "eco": "A03",
    "name": "Bird's Opening, Williams gambit",
    "moves": [
      "f2f4",
      "d7d5",
      "e2e4"
    ]
  },
  {
    "eco": "A03",
    "name": "Mujannah Opening",
    "moves": [
      "f2f4",
      "d7d5",
      "c2c4"
    ]
  },
  {
    "eco": "A04",
    "name": "Reti opening",
    "moves": [
      "b1f3"
    ]
  },
  {
  "eco": "A04",
  "name": "Reti Opening",
  "moves": ["g1f3"]
},
  {
    "eco": "A04",
    "name": "Reti v Dutch",
    "moves": [
      "g1f3",
      "f7f5"
    ]
  },
  {
    "eco": "A04",
    "name": "Reti, Herrstroem gambit",
    "moves": [
      "g1f3",
      "g7g5"
    ]
  },
  {
    "eco": "A04",
    "name": "Reti, Lisitsin gambit deferred",
    "moves": [
      "g1f3",
      "f7f5",
      "d2d3",
      "g8f6",
      "e2e4"
    ]
  },
  {
    "eco": "A04",
    "name": "Reti, Pirc-Lisitsin gambit",
    "moves": [
      "g1f3",
      "f7f5",
      "e2e4"
    ]
  },
  {
    "eco": "A04",
    "name": "Reti, Wade defense",
    "moves": [
      "g1f3",
      "d7d6",
      "e2e4",
      "c8g4"
    ]
  },
  {
  "eco": "A04",
  "name": "King's Indian: Nimzovich–Larsen attack",
  "moves": [
    "b2b3","d7d5","c1b2","g8f6","g2g3"
  ]
},
  {
  "eco": "A04",
  "name": "Reti: Nimzovich–Larsen attack (...Bf5)",
  "moves": [
    "b2b3","d7d5","c1b2","c8f5"
  ]
},
  {
  "eco": "A04",
  "name": "Reti: Nimzovich–Larsen attack (...Bg4)",
  "moves": [
    "b2b3","d7d5","c1b2","c8g4"
  ]
},
  {
  "eco": "A04",
  "name": "Reti: Nimzovich–Larsen attack (...g6)",
  "moves": [
    "b2b3","d7d5","c1b2","g7g6"
  ]
},
  {
  "eco": "A05",
  "name": "Reti Opening",
  "moves": ["g1f3","g8f6"]
},
  {
    "eco": "A05",
    "name": "Reti, King's Indian attack",
    "moves": [
      "g1f3",
      "g8f6",
      "g2g3",
      "g7g6"
    ]
  },
  {
    "eco": "A05",
    "name": "Reti, King's Indian attack, Reti-Smyslov Variation",
    "moves": [
      "g1f3",
      "g8f6",
      "g2g3",
      "g7g6",
      "b2b4"
    ]
  },
  {
    "eco": "A05",
    "name": "Reti, King's Indian attack, Spassky's Variation",
    "moves": [
      "g1f3",
      "g8f6",
      "g2g3",
      "b7b5"
    ]
  },
  {
  "eco": "A06",
  "name": "Reti Opening",
  "moves": ["g1f3","d7d5"]
},
  {
    "eco": "A06",
    "name": "Reti, Nimzovich-Larsen attack",
    "moves": [
      "g1f3",
      "d7d5",
      "b2b3"
    ]
  },
  {
    "eco": "A06",
    "name": "Reti, Old Indian attack",
    "moves": [
      "g1f3",
      "d7d5",
      "d2d3"
    ]
  },
  {
    "eco": "A06",
    "name": "Santasiere's folly",
    "moves": [
      "g1f3",
      "d7d5",
      "b2b4"
    ]
  },
  {
    "eco": "A06",
    "name": "Tennison (Lemberg, Zukertort) gambit",
    "moves": [
      "g1f3",
      "d7d5",
      "e2e4"
    ]
  },
  {
  "eco": "A07",
  "name": "King's Indian Attack",
  "moves": ["g1f3","d7d5","g2g3"]
},
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "g7g6"
    ]
  },
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack (Barcza system)",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3"
    ]
  },
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack (with ...c5)",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "c7c5"
    ]
  },
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack, Keres Variation",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "c8g4",
      "f1g2",
      "b8d7"
    ]
  },
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack, Pachman system",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "e1g1",
      "e7e5",
      "d2d3",
      "g8e7"
    ]
  },
  {
    "eco": "A07",
    "name": "Reti, King's Indian attack, Yugoslav Variation",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "g8f6",
      "f1g2",
      "c7c6",
      "e1g1",
      "c8g4"
    ]
  },
  {
  "eco": "A07",
  "name": "Reti: King's Indian attack (...e5)",
  "moves": [
    "g1f3","d7d5","g2g3","g8f6","f1g2","e7e5"
  ]
},
  {
  "eco": "A07",
  "name": "Reti: King's Indian attack, herringbone variation",
  "moves": [
    "g1f3","d7d5","g2g3","g8f6","f1g2","c7c5","e1g1","b8c6","d2d3","e7e5","b1d2"
  ]
},
  {
  "eco": "A07",
  "name": "Reti: King's Indian attack, Neo-closed Sicilian",
  "moves": [
    "g1f3","d7d5","g2g3","g8f6","f1g2","c7c5","e1g1","b8c6","d2d3","e7e5","c2c4"
  ]
},
  {
  "eco": "A07",
  "name": "Reti: King's Indian attack, Petrosian variation",
  "moves": [
    "g1f3","d7d5","g2g3","g8f6","f1g2","c7c5","e1g1","b8c6","d2d3","e7e5","b1d2","f8e7"
  ]
},
  {
  "eco": "A08",
  "name": "King's Indian Attack",
  "moves": ["g1f3","d7d5","g2g3","c7c5","f1g2"]
},
  {
    "eco": "A08",
    "name": "Reti, King's Indian attack",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "c7c5",
      "f1g2"
    ]
  },
  {
    "eco": "A08",
    "name": "Reti, King's Indian attack, French Variation",
    "moves": [
      "g1f3",
      "d7d5",
      "g2g3",
      "c7c5",
      "f1g2",
      "b8c6",
      "e1g1",
      "e7e6",
      "d2d3",
      "g8f6",
      "b1d2",
      "f8e7",
      "e2e4",
      "e8g8",
      "f1e1"
    ]
  },
  {
  "eco": "A09",
  "name": "Reti Opening",
  "moves": ["g1f3","d7d5","c2c4"]
},
  {
    "eco": "A09",
    "name": "Reti accepted",
    "moves": [
      "g1f3",
      "d7d5",
      "c2c4",
      "d5c4"
    ]
  },
  {
    "eco": "A09",
    "name": "Reti accepted, Keres Variation",
    "moves": [
      "g1f3",
      "d7d5",
      "c2c4",
      "d5c4",
      "e2e3",
      "c8e6"
    ]
  },
  {
    "eco": "A09",
    "name": "Reti, Advance Variation",
    "moves": [
      "g1f3",
      "d7d5",
      "c2c4",
      "d5d4"
    ]
  },
  {
    "eco": "A10",
    "name": "English opening",
    "moves": [
      "c2c4"
    ]
  },
  {
  "eco": "A10",
  "name": "English",
  "moves": ["c2c4"]
},
  {
    "eco": "A10",
    "name": "English Opening",
    "moves": [
      "c2c4"
    ]
  },
  {
    "eco": "A10",
    "name": "English, Adorjan defense",
    "moves": [
      "c2c4",
      "g7g6",
      "e2e4",
      "e7e5"
    ]
  },
  {
    "eco": "A10",
    "name": "English, Anglo-Dutch defense",
    "moves": [
      "c2c4",
      "f7f5"
    ]
  },
  {
    "eco": "A10",
    "name": "English, Jaenisch gambit",
    "moves": [
      "c2c4",
      "b7b5"
    ]
  },
  {
  "name": "English, Caro-Kann Defensive System",
  "eco": "A11",
  "moves": ["c2c4","c7c6","g1f3","d7d5"]
},
  {
  "eco": "A12",
  "name": "English with b3",
  "moves": ["c2c4","c7c6","g1f3","d7d5","b2b3"]
},
  {
    "eco": "A12",
    "name": "English, Bled Variation",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "c1b2",
      "g7g6"
    ]
  },
  {
    "eco": "A12",
    "name": "English, Capablanca's Variation",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "c1b2",
      "c8g4"
    ]
  },
  {
    "eco": "A12",
    "name": "English, Caro-Kann defensive system",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3"
    ]
  },
  {
    "eco": "A12",
    "name": "English, Caro-Kann defensive system, Bogolyubov Variation",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "c8g4"
    ]
  },
  {
    "eco": "A12",
    "name": "English, London defensive system",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "g2g3",
      "c8f5"
    ]
  },
  {
    "eco": "A12",
    "name": "English, New York (London) defensive system",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "c1b2",
      "c8f5"
    ]
  },
  {
    "eco": "A12",
    "name": "English, Torre defensive system",
    "moves": [
      "c2c4",
      "c7c6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "g2g3",
      "c8g4"
    ]
  },
  {
  "eco": "A13",
  "name": "English",
  "moves": ["c2c4","e7e6"]
},
  {
    "eco": "A13",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "e7e6"
    ]
  },
  {
    "eco": "A13",
    "name": "English Opening, Agincourt Variation",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5"
    ]
  },
  {
    "eco": "A13",
    "name": "English, Kurajica defense",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "g2g3",
      "c7c6"
    ]
  },
  {
    "eco": "A13",
    "name": "English, Neo-Catalan",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "g2g3",
      "g8f6"
    ]
  },
  {
    "eco": "A13",
    "name": "English, Neo-Catalan accepted",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "g2g3",
      "g8f6",
      "f1g2",
      "d5c4"
    ]
  },
  {
    "eco": "A13",
    "name": "English, Romanishin gambit",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "g2g3",
      "a7a6",
      "f1g2",
      "b7b5"
    ]
  },
  {
    "eco": "A13",
    "name": "English, Wimpey system",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "b2b3",
      "g8f6",
      "c1b2",
      "c7c5",
      "e2e3"
    ]
  },
  {
  "eco": "A14",
  "name": "English",
  "moves": ["c2c4","e7e6","g1f3","d7d5","g2g3","g8f6","f1g2","f8e7","e1g1"]
},
  {
    "eco": "A14",
    "name": "English, Neo-Catalan declined",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1"
    ]
  },
  {
    "eco": "A14",
    "name": "English, Symmetrical, Keres defense",
    "moves": [
      "c2c4",
      "e7e6",
      "g1f3",
      "d7d5",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "c7c5",
      "c4d5",
      "f6d5",
      "b1c3",
      "b8c6"
    ]
  },
  {
  "eco": "A15",
  "name": "English",
  "moves": ["c2c4","g8f6"]
},
  {
    "eco": "A15",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "g8f6",
      "g1f3"
    ]
  },
  {
    "eco": "A15",
    "name": "English orang-utan",
    "moves": [
      "c2c4",
      "g8f6",
      "b2b4"
    ]
  },
  {
    "eco": "A15",
    "name": "English, 1...Nf6 (Anglo-Indian defense)",
    "moves": [
      "c2c4",
      "g8f6"
    ]
  },
  {
  "eco": "A16",
  "name": "English",
  "moves": ["c2c4","g8f6","b1c3"]
},
  {
    "eco": "A16",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "A16",
    "name": "English, Anglo-Gruenfeld defense",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "d7d5"
    ]
  },
  {
    "eco": "A16",
    "name": "English, Anglo-Gruenfeld defense, Korchnoi Variation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "g1f3",
      "g7g6",
      "g2g3",
      "f8g7",
      "f1g2",
      "e7e5"
    ]
  },
  {
    "eco": "A16",
    "name": "English, Anglo-Gruenfeld, Czech defense",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "g2g3",
      "g7g6",
      "f1g2",
      "d5b6"
    ]
  },
  {
    "eco": "A16",
    "name": "English, Anglo-Gruenfeld, Smyslov defense",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "g2g3",
      "g7g6",
      "f1g2",
      "d5c3"
    ]
  },
  {
  "eco": "A16",
  "name": "English-KID fianchetto",
  "moves": [
    "c2c4","g8f6","g2g3","g7g6","f1g2","f8g7","d2d4","d7d6"
  ]
},
  {
  "eco": "A16",
  "name": "English: Anglo-Gruenfeld (without ...d5)",
  "moves": [
    "c2c4","g8f6","g1f3","g7g6","b1c3","f8g7"
  ]
},
  {
  "eco": "A16",
  "name": "English: Anglo-Gruenfeld Bremen",
  "moves": [
    "c2c4","g8f6","g1f3","g7g6","b1c3","d7d5"
  ]
},
  {
  "eco": "A16",
  "name": "English: Bremen",
  "moves": [
    "c2c4","g8f6","g1f3","g7g6","b1c3","d7d6"
  ]
},
  {
  "eco": "A16",
  "name": "English: Bremen, modern line",
  "moves": [
    "c2c4","g8f6","g1f3","g7g6","b1c3","d7d6","d2d4"
  ]
},
  {
  "eco": "A17",
  "name": "English",
  "moves": ["c2c4","g8f6","b1c3","e7e6"]
},
  {
    "eco": "A17",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6"
    ]
  },
  {
    "eco": "A17",
    "name": "English, Nimzo-English Opening",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "g1f3",
      "f8b4"
    ]
  },
  {
    "eco": "A17",
    "name": "English, Queens Indian formation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "g1f3",
      "b7b6"
    ]
  },
  {
    "eco": "A17",
    "name": "English, Queens Indian, Romanishin Variation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "g1f3",
      "b7b6",
      "e2e4",
      "c8b7",
      "f1d3"
    ]
  },
  {
  "eco": "A17",
  "name": "English: Queens Indian formation (postponed d4)",
  "moves": [
    "c2c4","e7e6","g2g3","d7d5","f1g2","g8f6","b1c3","f8b4"
  ]
},
  {
  "eco": "A18",
  "name": "English, Mikenas-Carls",
  "moves": ["c2c4","g8f6","b1c3","e7e6","e2e4"]
},
  {
    "eco": "A18",
    "name": "English, Mikenas-Carls Variation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "e2e4"
    ]
  },
  {
    "eco": "A18",
    "name": "English, Mikenas-Carls, Flohr Variation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "e2e4",
      "d7d5",
      "e4e5"
    ]
  },
  {
    "eco": "A18",
    "name": "English, Mikenas-Carls, Kevitz Variation",
    "moves": [
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6",
      "e2e4",
      "b8c6"
    ]
  },
  {
  "eco": "A19",
  "name": "English, Mikenas-Carls, Sicilian Variation",
  "moves": ["c2c4","g8f6","b1c3","e7e6","e2e4","c7c5"]
},
{
  "name": "English Opening: Reversed Sicilian",
  "eco": "A20",
  "moves": ["c2c4","e7e5"],
  "normalized": "english opening reversed sicilian",
  "loose": "reversed sicilian"
},
{
  "name": "English Opening: Reversed Sicilian",
  "eco": "A20",
  "moves": ["c2c4","e7e5"],
  "normalized": "english opening reversed sicilian",
  "loose": "reversed sicilian"
},
  {
  "eco": "A20",
  "name": "English",
  "moves": ["c2c4","e7e5"]
},
  {
    "eco": "A20",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "e7e5"
    ]
  },
  {
    "eco": "A20",
    "name": "English, Nimzovich Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "g1f3"
    ]
  },
  {
    "eco": "A20",
    "name": "English, Nimzovich, Flohr Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "g1f3",
      "e5e4"
    ]
  },
  {
  "eco": "A20",
  "name": "English: decoy line",
  "moves": [
    "c2c4","e7e5","b1c3","g8f6","g2g3","d7d5"
  ]
},
  {
  "eco": "A20",
  "name": "English: Kramnik–Shirov counter-attack",
  "moves": [
    "c2c4","e7e5","b1c3","g8f6","g2g3","c7c6"
  ]
},
  {
  "eco": "A20",
  "name": "English: Kurajica exchange",
  "moves": [
    "c2c4","e7e5","b1c3","g8f6","g2g3","d7d5","c4d5"
  ]
},
  {
  "eco": "A20",
  "name": "English: modern Nimzovich",
  "moves": [
    "c2c4","e7e5","b1c3","g8f6","g2g3","c7c6","d2d4"
  ]
},
  {
  "eco": "A21",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3"]
},
  {
    "eco": "A21",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3"
    ]
  },
  {
    "eco": "A21",
    "name": "English, Keres Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "d7d6",
      "g2g3",
      "c7c6"
    ]
  },
  {
    "eco": "A21",
    "name": "English, Kramnik-Shirov counterattack",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "f8b4"
    ]
  },
  {
    "eco": "A21",
    "name": "English, Smyslov defense",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "d7d6",
      "g1f3",
      "c8g4"
    ]
  },
  {
    "eco": "A21",
    "name": "English, Troeger defense",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "d7d6",
      "g2g3",
      "c8e6",
      "f1g2",
      "b8c6"
    ]
  },
  {
  "eco": "A21",
  "name": "English (...d5) reverse dragon",
  "moves": [
    "c2c4","e7e5","g1f3","d7d5","c4d5","g8f6","b1c3","f8d6","d2d3","e5e4","d3e4"
  ]
},
  {
  "eco": "A21",
  "name": "English: closed system (with ...f5)",
  "moves": [
    "c2c4","e7e5","g2g3","f7f5"
  ]
},
  {
  "eco": "A21",
  "name": "English: closed system, modern line",
  "moves": [
    "c2c4","e7e5","g2g3","d7d6","f1g2","g8f6"
  ]
},
  {
  "eco": "A22",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","g8f6"]
},
  {
    "eco": "A22",
    "name": "English Opening",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "g8f6"
    ]
  },
  {
    "eco": "A22",
    "name": "English, Bellon gambit",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "g8f6",
      "g1f3",
      "e5e4",
      "f3g5",
      "b7b5"
    ]
  },
  {
    "eco": "A22",
    "name": "English, Bremen, reverse Dragon",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "g8f6",
      "g2g3",
      "d7d5"
    ]
  },
  {
    "eco": "A22",
    "name": "English, Bremen, Smyslov system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "g8f6",
      "g2g3",
      "f8b4"
    ]
  },
  {
    "eco": "A22",
    "name": "English, Carls' Bremen system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "g8f6",
      "g2g3"
    ]
  },
  {
  "eco": "A22",
  "name": "English: closed, Old Indian formation",
  "moves": [
    "c2c4","e7e5","g2g3","d7d6","b1c3","g8f6","d2d3"
  ]
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
    "eco": "A25",
    "name": "English, Closed system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Closed system (without ...d6)",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Closed, 5.Rb1",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "a1b1"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Closed, 5.Rb1 Taimanov Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "a1b1",
      "g8h6"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Closed, Hort Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "e2e3",
      "d7d6",
      "g1e2",
      "c8e6"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Closed, Taimanov Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "e2e3",
      "d7d6",
      "g1e2",
      "g8h6"
    ]
  },
  {
    "eco": "A25",
    "name": "English, Sicilian Reversed",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6"
    ]
  },
  {
  "eco": "A26",
  "name": "English",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6"]
},
  {
    "eco": "A26",
    "name": "English, Botvinnik system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6",
      "e2e4"
    ]
  },
  {
    "eco": "A26",
    "name": "English, Closed system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6"
    ]
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
    "eco": "A28",
    "name": "English, Bradley Beach Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5e4"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights system",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, 4.e3",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "e2e3"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, Capablanca Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "d2d3"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, Marini Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "a2a3"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, Nimzovich Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "e2e4"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, Romanishin Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "f8b4",
      "d1c2",
      "b4c3"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Four knights, Stean Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "f8b4",
      "d1c2",
      "e8g8",
      "c3d5",
      "f8e8",
      "c2f5"
    ]
  },
  {
    "eco": "A28",
    "name": "English, Nenarokov Variation",
    "moves": [
      "c2c4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5d4",
      "f3d4",
      "f8b4",
      "c1g5",
      "h7h6",
      "g5h4",
      "b4c3",
      "b2c3",
      "c6e5"
    ]
  },
  {
  "eco": "A29",
  "name": "English, Four Knights, Kingside Fianchetto",
  "moves": ["c2c4","e7e5","b1c3","b8c6","g1f3","g8f6","g2g3"]
},
{
  "name": "English Opening: Hedgehog System",
  "eco": "A30",
  "moves": ["c2c4","c7c5","g1f3","b8c6","b1c3","g7g6","e2e3","f8g7","d2d4","c5d4","e3d4","d7d6","f1e2","e7e6"],
  "normalized": "english opening hedgehog system",
  "loose": "hedgehog system"
},
{
  "name": "English Opening: Hedgehog System",
  "eco": "A30",
  "moves": ["c2c4","c7c5","g1f3","b8c6","b1c3","g7g6","e2e3","f8g7","d2d4","c5d4","e3d4","d7d6","f1e2","e7e6"],
  "normalized": "english opening hedgehog system",
  "loose": "hedgehog system"
},
  {
  "eco": "A30",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5"]
},
  {
    "eco": "A30",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5"
    ]
  },
  {
    "eco": "A30",
    "name": "English, Symmetrical, hedgehog system",
    "moves": [
      "c2c4",
      "c7c5",
      "g1f3",
      "g8f6",
      "g2g3",
      "b7b6",
      "f1g2",
      "c8b7",
      "e1g1",
      "e7e6",
      "b1c3",
      "f8e7"
    ]
  },
  {
    "eco": "A30",
    "name": "English, Symmetrical, hedgehog, flexible formation",
    "moves": [
      "c2c4",
      "c7c5",
      "g1f3",
      "g8f6",
      "g2g3",
      "b7b6",
      "f1g2",
      "c8b7",
      "e1g1",
      "e7e6",
      "b1c3",
      "f8e7",
      "d2d4",
      "c5d4",
      "d1d4",
      "d7d6",
      "f1d1",
      "a7a6",
      "b2b3",
      "b8d7"
    ]
  },
  {
  "eco": "A30",
  "name": "English: symmetrical (...Nc6 g3)",
  "moves": [
    "c2c4","c7c5","g2g3","b8c6"
  ]
},
  {
  "eco": "A30",
  "name": "English: symmetrical, hedgehog",
  "moves": [
    "c2c4","c7c5","g2g3","b8c6","f1g2","g7g6","b1c3","f8g7","d2d3","d7d6"
  ]
},
  {
  "eco": "A30",
  "name": "English: symmetrical, hedgehog, natural line",
  "moves": [
    "c2c4","c7c5","g2g3","b8c6","f1g2","g7g6","b1c3","f8g7","d2d3","d7d6","e2e4"
  ]
},
  {
  "eco": "A30",
  "name": "English: symmetrical, main line knight exchange",
  "moves": [
    "c2c4","c7c5","g1f3","g8f6","d2d4","c5d4","f3d4"
  ]
},
  {
  "eco": "A30",
  "name": "English: symmetrical, modern Botvinnik system",
  "moves": [
    "c2c4","c7c5","g2g3","g7g6","f1g2","f8g7","b1c3","b8c6","d2d3","d7d6","e2e4","e7e5"
  ]
},
  {
  "eco": "A30",
  "name": "English: symmetrical, modern line",
  "moves": [
    "c2c4","c7c5","g2g3","g7g6","f1g2","f8g7","g1f3","b8c6"
  ]
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
    "eco": "A33",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "g1f3",
      "g8f6",
      "d2d4",
      "c5d4",
      "f3d4",
      "e7e6",
      "b1c3",
      "b8c6"
    ]
  },
  {
    "eco": "A33",
    "name": "English, Symmetrical, Geller Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "g1f3",
      "g8f6",
      "d2d4",
      "c5d4",
      "f3d4",
      "e7e6",
      "b1c3",
      "b8c6",
      "g2g3",
      "d8b6"
    ]
  },
  {
  "eco": "A34",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3"]
},
  {
    "eco": "A34",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3"
    ]
  },
  {
    "eco": "A34",
    "name": "English, Symmetrical, Rubinstein system",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "g8f6",
      "g2g3",
      "d7d5",
      "c4d5",
      "f6d5",
      "f1g2",
      "d5c7"
    ]
  },
  {
    "eco": "A34",
    "name": "English, Symmetrical, Three knights system",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "g8f6",
      "g1f3",
      "d7d5",
      "c4d5",
      "f6d5"
    ]
  },
  {
  "eco": "A35",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6"]
},
  {
    "eco": "A35",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6"
    ]
  },
  {
    "eco": "A35",
    "name": "English, Symmetrical, Four knights system",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g1f3",
      "g8f6"
    ]
  },
  {
  "eco": "A36",
  "name": "English",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3"]
},
  {
    "eco": "A36",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3"
    ]
  },
  {
    "eco": "A36",
    "name": "English, Symmetrical, Botvinnik system",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "e2e4"
    ]
  },
  {
    "eco": "A36",
    "name": "English, Symmetrical, Botvinnik system Reversed",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "e2e3",
      "e7e5"
    ]
  },
  {
    "eco": "A36",
    "name": "English, ultra-Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7"
    ]
  },
  {
  "eco": "A37",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3"]
},
  {
    "eco": "A37",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3"
    ]
  },
  {
    "eco": "A37",
    "name": "English, Symmetrical, Botvinnik system Reversed",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3",
      "e7e5"
    ]
  },
  {
  "eco": "A38",
  "name": "English, Symmetrical",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3","g8f6"]
},
  {
    "eco": "A38",
    "name": "English, Symmetrical Variation",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3",
      "g8f6"
    ]
  },
  {
    "eco": "A38",
    "name": "English, Symmetrical, Main line with b3",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3",
      "g8f6",
      "e1g1",
      "e8g8",
      "b2b3"
    ]
  },
  {
    "eco": "A38",
    "name": "English, Symmetrical, Main line with d3",
    "moves": [
      "c2c4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3",
      "g8f6",
      "e1g1",
      "e8g8",
      "d2d3"
    ]
  },
  {
  "eco": "A39",
  "name": "English, Symmetrical, Main line with d4",
  "moves": ["c2c4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","g1f3","g8f6","e1g1","e8g8","d2d4"]
},
  {
    "eco": "A40",
    "name": "Queen's pawn",
    "moves": [
      "d2d4"
    ]
  },
  {
  "eco": "A40",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4"]
},
  {
    "eco": "A40",
    "name": "Beefeater defense",
    "moves": [
      "d2d4",
      "g7g6",
      "c2c4",
      "f8g7",
      "b1c3",
      "c7c5",
      "d4d5",
      "g7c3",
      "b2c3",
      "f7f5"
    ]
  },
  {
    "eco": "A40",
    "name": "Modern defense",
    "moves": [
      "d2d4",
      "g7g6"
    ]
  },
  {
    "eco": "A40",
    "name": "Polish defense",
    "moves": [
      "d2d4",
      "b7b5"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn",
    "moves": [
      "d2d4"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, Charlick (Englund) gambit",
    "moves": [
      "d2d4",
      "e7e5"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, English defense",
    "moves": [
      "d2d4",
      "b7b6"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, Englund gambit",
    "moves": [
      "d2d4",
      "e7e5",
      "d4e5",
      "b8c6",
      "g1f3",
      "d8e7",
      "d1d5",
      "f7f6",
      "e5f6",
      "g8f6"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, Franco-Indian (Keres) defense",
    "moves": [
      "d2d4",
      "e7e6",
      "c2c4",
      "f8b4"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, Keres defense",
    "moves": [
      "d2d4",
      "e7e6",
      "c2c4",
      "b7b6"
    ]
  },
  {
    "eco": "A40",
    "name": "Queen's pawn, Lundin (Kevitz-Mikenas) defense",
    "moves": [
      "d2d4",
      "b8c6"
    ]
  },
  {
  "eco": "A40",
  "name": "Lagenheinicke defence",
  "moves": [
    "d2d4","g8f6","c1g5","f6e4"
  ]
},
  {
  "eco": "A40",
  "name": "Poisoned spike (Gibbins-Wiedenhagen) gambit",
  "moves": [
    "d2d4","g8f6","c1g5","f6e4","g5h4","d7d5","f2f3"
  ]
},
  {
  "eco": "A40",
  "name": "Poisoned spike (Gibbins-Wiedenhagen) gambit",
  "moves": [
    "d2d4","g8f6","c1g5","f6e4","g5h4","d7d5","f2f3"
  ]
},
  {
    "name": "Englund Gambit",
    "eco": "A40",
    "moves": ["d2d4","e7e5"],
    "normalized": "englund gambit",
    "loose": "englund gambit"
  },
  {
    "name": "Englund Gambit Accepted",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5"],
    "normalized": "englund gambit accepted",
    "loose": "englund gambit accepted"
  },
  {
    "name": "Englund Gambit: 2.dxe5 Nc6",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","b8c6"],
    "normalized": "englund gambit 2 dxe5 nc6",
    "loose": "englund gambit 2 dxe5 nc6"
  },
  {
    "name": "Englund Gambit: 2.dxe5 Nc6 3.Nf3",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","b8c6","g1f3"],
    "normalized": "englund gambit 2 dxe5 nc6 3 nf3",
    "loose": "englund gambit 2 dxe5 nc6 3 nf3"
  },
  {
    "name": "Englund Gambit: 2.dxe5 Nc6 3.Nf3 Qe7",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","b8c6","g1f3","d8e7"],
    "normalized": "englund gambit 2 dxe5 nc6 3 nf3 qe7",
    "loose": "englund gambit 2 dxe5 nc6 3 nf3 qe7"
  },
  {
    "name": "Englund Gambit: Hartlaub Gambit",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","d7d6"],
    "normalized": "englund gambit hartlaub",
    "loose": "englund gambit hartlaub"
  },
  {
    "name": "Englund Gambit: Soller Gambit",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","f8c5"],
    "normalized": "englund gambit soller",
    "loose": "englund gambit soller"
  },
  {
    "name": "Englund Gambit: Soller Deferred",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","b8c6","f1c4"],
    "normalized": "englund gambit soller deferred",
    "loose": "englund gambit soller deferred"
  },
  {
    "name": "Englund Gambit: Zilbermints Gambit",
    "eco": "A40",
    "moves": ["d2d4","e7e5","d4e5","f7f6"],
    "normalized": "englund gambit zilbermints",
    "loose": "englund gambit zilbermints"
  },
  {
    "name": "Indian: Blackmar-Diemer Gambit (without Nc3)",
    "eco": "A40",
    "moves": ["d2d4","d7d5","e2e4","d5e4"],
    "normalized": "indian blackmar diemer gambit without nc3",
    "loose": "indian blackmar diemer gambit without nc3"
  },
  {
    "name": "Indian: Canard Opening",
    "eco": "A40",
    "moves": ["d2d4","d7d5","g2g3"],
    "normalized": "indian canard opening",
    "loose": "indian canard opening"
  },
  {
    "name": "Indian: Doery Defence",
    "eco": "A40",
    "moves": ["d2d4","d7d5","c1g5","c8f5"],
    "normalized": "indian doery defense",
    "loose": "indian doery defense"
  },
  {
    "name": "Indian: Gibbins Gambit",
    "eco": "A40",
    "moves": ["d2d4","d7d5","e2e4","d5e4","f1c4"],
    "normalized": "indian gibbins gambit",
    "loose": "indian gibbins gambit"
  },
  {
    "name": "Indian: Gibbins Gambit Accepted",
    "eco": "A40",
    "moves": ["d2d4","d7d5","e2e4","d5e4","f1c4","g8f6"],
    "normalized": "indian gibbins gambit accepted",
    "loose": "indian gibbins gambit accepted"
  },
  {
    "name": "Indian: Gibbins Gambit, Oshima Defence",
    "eco": "A40",
    "moves": ["d2d4","d7d5","e2e4","d5e4","f1c4","c7c6"],
    "normalized": "indian gibbins gambit oshima defense",
    "loose": "indian gibbins gambit oshima defense"
  },
  {
    "name": "Indian: Lazard Gambit",
    "eco": "A40",
    "moves": ["d2d4","d7d5","c1g5","c8g4"],
    "normalized": "indian lazard gambit",
    "loose": "indian lazard gambit"
  },
  {
    "name": "Indian: Omega Gambit",
    "eco": "A40",
    "moves": ["d2d4","d7d5","e2e4","d5e4","b1c3"],
    "normalized": "indian omega gambit",
    "loose": "indian omega gambit"
  },
  {
  "eco": "A41",
  "name": "Queen's Pawn Game (with ...d6)",
  "moves": ["d2d4","d7d6"]
},
  {
    "eco": "A41",
    "name": "Modern defense",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7"
    ]
  },
  {
    "eco": "A41",
    "name": "Old Indian defense",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4"
    ]
  },
  {
    "eco": "A41",
    "name": "Old Indian, Tartakower (Wade) Variation",
    "moves": [
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4"
    ]
  },
  {
    "eco": "A41",
    "name": "Queen's Pawn",
    "moves": [
      "d2d4",
      "d7d6"
    ]
  },
  {
    "eco": "A41",
    "name": "Robatsch defense, Rossolimo Variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "g1f3",
      "d7d6",
      "c2c4",
      "c8g4"
    ]
  },
  {
    "name": "Pirc/Reti: Wade Defence",
    "eco": "A41",
    "moves": ["d2d4","g8f6","g1f3","d7d6"],
    "normalized": "pirc/reti, wade defense",
    "loose": "pirc reti wade defense"
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
  "eco": "A42",
  "name": "Modern Defense, Averbakh System",
  "moves": ["d2d4","d7d6","c2c4","g7g6","b1c3","f8g7","e2e4"]
},
  {
    "eco": "A42",
    "name": "Modern defense, Averbakh system, Kotov Variation",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "b8c6"
    ]
  },
  {
    "eco": "A42",
    "name": "Modern defense, Averbakh system, Randspringer Variation",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "f7f5"
    ]
  },
  {
    "eco": "A42",
    "name": "Pterodactyl defense",
    "moves": [
      "d2d4",
      "d7d6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "c7c5",
      "g1f3",
      "d8a5"
    ]
  },
  {
    "eco": "A43",
    "name": "Old Benoni defence",
    "moves": [
      "d2d4",
      "c7c5"
    ]
  },
  {
  "eco": "A43",
  "name": "Old Benoni",
  "moves": ["d2d4","c7c5"]
},
  {
    "eco": "A43",
    "name": "Hawk (Habichd) defense",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "g8f6",
      "g1f3",
      "c5c4"
    ]
  },
  {
    "eco": "A43",
    "name": "Old Benoni defense",
    "moves": [
      "d2d4",
      "c7c5"
    ]
  },
  {
    "eco": "A43",
    "name": "Old Benoni, Franco-Benoni defense",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "e7e6",
      "e2e4"
    ]
  },
  {
    "eco": "A43",
    "name": "Old Benoni, Mujannah formation",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "f7f5"
    ]
  },
  {
    "eco": "A43",
    "name": "Old Benoni, Schmid's system",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "d7d6",
      "b1c3",
      "g7g6"
    ]
  },
  {
    "eco": "A43",
    "name": "Woozle defense",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "g8f6",
      "b1c3",
      "d8a5"
    ]
  },
  {
  "eco": "A44",
  "name": "Old Benoni Defense",
  "moves": ["d2d4","c7c5","d4d5","e7e5"]
},
  {
    "eco": "A44",
    "name": "Semi-Benoni (`blockade Variation ')",
    "moves": [
      "d2d4",
      "c7c5",
      "d4d5",
      "e7e5",
      "e2e4",
      "d7d6"
    ]
  },
  {
    "eco": "A45",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "b1f6"
    ]
  },
  {
  "eco": "A45",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6"]
},
  {
    "eco": "A45",
    "name": "Blackmar-Diemer gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "f2f3",
      "d7d5",
      "e2e4"
    ]
  },
  {
    "eco": "A45",
    "name": "Canard Opening",
    "moves": [
      "d2d4",
      "g8f6",
      "f2f4"
    ]
  },
  {
    "eco": "A45",
    "name": "Gedult attack",
    "moves": [
      "d2d4",
      "g8f6",
      "f2f3",
      "d7d5",
      "g2g4"
    ]
  },
  {
    "eco": "A45",
    "name": "Paleface attack",
    "moves": [
      "d2d4",
      "g8f6",
      "f2f3"
    ]
  },
  {
    "eco": "A45",
    "name": "Queen's pawn, Bronstein gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "g2g4"
    ]
  },
  {
    "eco": "A45",
    "name": "Trompovsky attack (Ruth, Opovcensky Opening)",
    "moves": [
      "d2d4",
      "g8f6",
      "c1g5"
    ]
  },
  {
  "eco": "A45",
  "name": "Trompovsky attack: Hodgson variation",
  "moves": [
    "d2d4","g8f6","c1g5","f6e4","g5f4"
  ]
},
  {
  "eco": "A45",
  "name": "Trompovsky attack: Hodgson variation",
  "moves": [
    "d2d4","g8f6","c1g5","f6e4","g5f4"
  ]
},
  {
    "name": "Indian",
    "eco": "A45",
    "moves": ["d2d4","g8f6"],
    "normalized": "indian",
    "loose": "indian"
  },
  {
    "name": "Indian: 2.c3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c2c3"],
    "normalized": "indian 2 c3",
    "loose": "indian 2 c3"
  },
  {
    "name": "Indian: 2.c3 g6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c2c3","g7g6"],
    "normalized": "indian 2 c3 g6",
    "loose": "indian 2 c3 g6"
  },
  {
    "name": "Indian: 2.c3 g6 3.Bg5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c2c3","g7g6","c1g5"],
    "normalized": "indian 2 c3 g6 3 bg5",
    "loose": "indian 2 c3 g6 3 bg5"
  },
  {
    "name": "Indian: 2.e3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","e2e3"],
    "normalized": "indian 2 e3",
    "loose": "indian 2 e3"
  },
  {
    "name": "Indian: 2.e3 e6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","e2e3","e7e6"],
    "normalized": "indian 2 e3 e6",
    "loose": "indian 2 e3 e6"
  },
  {
    "name": "Indian: 2.e3 g6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","e2e3","g7g6"],
    "normalized": "indian 2 e3 g6",
    "loose": "indian 2 e3 g6"
  },
  {
    "name": "Indian: 2.g3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","g2g3"],
    "normalized": "indian 2 g3",
    "loose": "indian 2 g3"
  },
  {
    "name": "Indian: 2.g3 c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","g2g3","c7c5"],
    "normalized": "indian 2 g3 c5",
    "loose": "indian 2 g3 c5"
  },
  {
    "name": "Indian: 2.g3 c5 3.d5 b5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","g2g3","c7c5","d4d5","b7b5"],
    "normalized": "indian 2 g3 c5 3 d5 b5",
    "loose": "indian 2 g3 c5 3 d5 b5"
  },
  {
    "name": "Indian: 2.g3 g6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","g2g3","g7g6"],
    "normalized": "indian 2 g3 g6",
    "loose": "indian 2 g3 g6"
  },
  {
    "name": "Indian: Arafat Gambit",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4"],
    "normalized": "indian arafat gambit",
    "loose": "indian arafat gambit"
  },
  {
    "name": "Indian: Gedult Attack",
    "eco": "A45",
    "moves": ["d2d4","g8f6","f2f3"],
    "normalized": "indian gedult attack",
    "loose": "indian gedult attack"
  },
  {
    "name": "Indian: Paleface Attack",
    "eco": "A45",
    "moves": ["d2d4","g8f6","f2f3","d7d5","c1g5"],
    "normalized": "indian paleface attack",
    "loose": "indian paleface attack"
  },
  {
    "name": "Trompowsky 2...d6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","d7d6"],
    "normalized": "trompowsky 2 d6",
    "loose": "trompowsky 2 d6"
  },
  {
    "name": "Trompowsky 2...d6 3.Bxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","d7d6","g5f6"],
    "normalized": "trompowsky 2 d6 3 bxf6",
    "loose": "trompowsky 2 d6 3 bxf6"
  },
  {
    "name": "Trompowsky 2...d6 3.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","d7d6","b1c3"],
    "normalized": "trompowsky 2 d6 3 nc3",
    "loose": "trompowsky 2 d6 3 nc3"
  },
  {
    "name": "Trompowsky 2...g6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","g7g6"],
    "normalized": "trompowsky 2 g6",
    "loose": "trompowsky 2 g6"
  },
  {
    "name": "Trompowsky 2...g6 3.Bxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","g7g6","g5f6"],
    "normalized": "trompowsky 2 g6 3 bxf6",
    "loose": "trompowsky 2 g6 3 bxf6"
  },
  {
    "name": "Trompowsky 2...g6 3.Bxf6 exf6 4.e3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","g7g6","g5f6","e7f6","e2e3"],
    "normalized": "trompowsky 2 g6 3 bxf6 exf6 4 e3",
    "loose": "trompowsky 2 g6 3 bxf6 exf6 4 e3"
  },
  {
    "name": "Trompowsky 2...g6 3.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","g7g6","b1c3"],
    "normalized": "trompowsky 2 g6 3 nc3",
    "loose": "trompowsky 2 g6 3 nc3"
  },
  {
    "name": "Trompowsky Opening",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5"],
    "normalized": "trompowsky opening",
    "loose": "trompowsky opening"
  },
  {
    "name": "Trompowsky: 2...c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5"],
    "normalized": "trompowsky 2 c5",
    "loose": "trompowsky 2 c5"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6"],
    "normalized": "trompowsky 2 c5 3 bxf6",
    "loose": "trompowsky 2 c5 3 bxf6"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1 f5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1","f6f5"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1 f5 6.c4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1","f6f5","c2c4"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 c4",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 c4"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1 f5 6.e3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1","f6f5","e2e3"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 e3",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 e3"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1 f5 6.e3 Bg7",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1","f6f5","e2e3","f8g7"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 e3 bg7",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 e3 bg7"
  },
  {
    "name": "Trompowsky: 2...c5 3.Bxf6 gxf6 4.d5 Qb6 5.Qc1 f5 6.g3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","g5f6","g7f6","d4d5","d8b6","d1c1","f6f5","g2g3"],
    "normalized": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 g3",
    "loose": "trompowsky 2 c5 3 bxf6 gxf6 4 d5 qb6 5 qc1 f5 6 g3"
  },
  {
    "name": "Trompowsky: 2...c5 3.d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","d4d5"],
    "normalized": "trompowsky 2 c5 3 d5",
    "loose": "trompowsky 2 c5 3 d5"
  },
  {
    "name": "Trompowsky: 2...c5 3.d5 Qb6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","d4d5","d8b6"],
    "normalized": "trompowsky 2 c5 3 d5 qb6",
    "loose": "trompowsky 2 c5 3 d5 qb6"
  },
  {
    "name": "Trompowsky: 2...c5 3.d5 Qb6 4.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","d4d5","d8b6","b1c3"],
    "normalized": "trompowsky 2 c5 3 d5 qb6 4 nc3",
    "loose": "trompowsky 2 c5 3 d5 qb6 4 nc3"
  },
  {
    "name": "Trompowsky: 2...c5 3.dxc5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","d4c5"],
    "normalized": "trompowsky 2 c5 3 dxc5",
    "loose": "trompowsky 2 c5 3 dxc5"
  },
  {
    "name": "Trompowsky: 2...c5 3.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","c7c5","b1c3"],
    "normalized": "trompowsky 2 c5 3 nc3",
    "loose": "trompowsky 2 c5 3 nc3"
  },
  {
    "name": "Trompowsky: 2...e6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6"],
    "normalized": "trompowsky 2 e6",
    "loose": "trompowsky 2 e6"
  },
  {
    "name": "Trompowsky: 2...e6 3.e3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e3"],
    "normalized": "trompowsky 2 e6 3 e3",
    "loose": "trompowsky 2 e6 3 e3"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4"],
    "normalized": "trompowsky 2 e6 3 e4",
    "loose": "trompowsky 2 e6 3 e4"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6"],
    "normalized": "trompowsky 2 e6 3 e4 h6",
    "loose": "trompowsky 2 e6 3 e4 h6"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.c3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","c2c3"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 c3",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 c3"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","b1c3"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.Nc3 Bb4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","b1c3","f8b4"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 bb4",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 bb4"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.Nc3 d6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","b1c3","d7d6"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.Nc3 d6 6.Qd2",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","b1c3","d7d6","d1d2"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6 6 qd2",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6 6 qd2"
  },
  {
    "name": "Trompowsky: 2...e6 3.e4 h6 4.Bxf6 Qxf6 5.Nc3 d6 6.Qd2 g5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","b1c3","d7d6","d1d2","g7g5"],
    "normalized": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6 6 qd2 g5",
    "loose": "trompowsky 2 e6 3 e4 h6 4 bxf6 qxf6 5 nc3 d6 6 qd2 g5"
  },
  {
    "name": "Trompowsky: 2...e6 3.Nc3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","b1c3"],
    "normalized": "trompowsky 2 e6 3 nc3",
    "loose": "trompowsky 2 e6 3 nc3"
  },
  {
    "name": "Trompowsky: 2...e6 3.Nd2",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","e7e6","b1d2"],
    "normalized": "trompowsky 2 e6 3 nd2",
    "loose": "trompowsky 2 e6 3 nd2"
  },
  {
    "name": "Trompowsky: 2...Ne4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4"],
    "normalized": "trompowsky 2 ne4",
    "loose": "trompowsky 2 ne4"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4"],
    "normalized": "trompowsky 2 ne4 3 bf4",
    "loose": "trompowsky 2 ne4 3 bf4"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5",
    "loose": "trompowsky 2 ne4 3 bf4 c5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","d4d5"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 d5",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 d5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.d5 Qb6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","d4d5","d8b6"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 d5 qb6",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 d5 qb6"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.f3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","f2f3"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 f3",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 f3"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.f3 Qa5+",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","f2f3","d8a5"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.f3 Qa5+ 5.c3 Nf6 6.d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","f2f3","d8a5","c2c3","g8f6","d4d5"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5 5 c3 nf6 6 d5",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5 5 c3 nf6 6 d5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 c5 4.f3 Qa5+ 5.c3 Nf6 6.Nd2",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","c7c5","f2f3","d8a5","c2c3","g8f6","b1d2"],
    "normalized": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5 5 c3 nf6 6 nd2",
    "loose": "trompowsky 2 ne4 3 bf4 c5 4 f3 qa5 5 c3 nf6 6 nd2"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5",
    "loose": "trompowsky 2 ne4 3 bf4 d5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5 4.e3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5","e2e3"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5 4 e3",
    "loose": "trompowsky 2 ne4 3 bf4 d5 4 e3"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5 4.e3 c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5","e2e3","c7c5"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5 4 e3 c5",
    "loose": "trompowsky 2 ne4 3 bf4 d5 4 e3 c5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5 4.f3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5","f2f3"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5 4 f3",
    "loose": "trompowsky 2 ne4 3 bf4 d5 4 f3"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5 4.f3 Nf6",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5","f2f3","g8f6"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5 4 f3 nf6",
    "loose": "trompowsky 2 ne4 3 bf4 d5 4 f3 nf6"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bf4 d5 4.Nd2",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","c1f4","d7d5","b1d2"],
    "normalized": "trompowsky 2 ne4 3 bf4 d5 4 nd2",
    "loose": "trompowsky 2 ne4 3 bf4 d5 4 nd2"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bh4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5h4"],
    "normalized": "trompowsky 2 ne4 3 bh4",
    "loose": "trompowsky 2 ne4 3 bh4"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bh4 c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5h4","c7c5"],
    "normalized": "trompowsky 2 ne4 3 bh4 c5",
    "loose": "trompowsky 2 ne4 3 bh4 c5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bh4 c5 4.f3",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5h4","c7c5","f2f3"],
    "normalized": "trompowsky 2 ne4 3 bh4 c5 4 f3",
    "loose": "trompowsky 2 ne4 3 bh4 c5 4 f3"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bh4 d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5h4","d7d5"],
    "normalized": "trompowsky 2 ne4 3 bh4 d5",
    "loose": "trompowsky 2 ne4 3 bh4 d5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.Bh4 g5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5h4","g7g5"],
    "normalized": "trompowsky 2 ne4 3 bh4 g5",
    "loose": "trompowsky 2 ne4 3 bh4 g5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.h4",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","h2h4"],
    "normalized": "trompowsky 2 ne4 3 h4",
    "loose": "trompowsky 2 ne4 3 h4"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.h4 c5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","h2h4","c7c5"],
    "normalized": "trompowsky 2 ne4 3 h4 c5",
    "loose": "trompowsky 2 ne4 3 h4 c5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.h4 c5 4.d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","h2h4","c7c5","d4d5"],
    "normalized": "trompowsky 2 ne4 3 h4 c5 4 d5",
    "loose": "trompowsky 2 ne4 3 h4 c5 4 d5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.h4 c5 4.dxc5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","h2h4","c7c5","d4c5"],
    "normalized": "trompowsky 2 ne4 3 h4 c5 4 dxc5",
    "loose": "trompowsky 2 ne4 3 h4 c5 4 dxc5"
  },
  {
    "name": "Trompowsky: 2...Ne4 3.h4 d5",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","h2h4","d7d5"],
    "normalized": "trompowsky 2 ne4 3 h4 d5",
    "loose": "trompowsky 2 ne4 3 h4 d5"
  },
  {
    "name": "Trompowsky: Borg Variation",
    "eco": "A45",
    "moves": ["d2d4","g8f6","c1g5","f6e4","g5f4"],
    "normalized": "trompowsky borg variation",
    "loose": "trompowsky borg variation"
  },
  {
  "eco": "A46",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6","g1f3"]
},
  {
    "eco": "A46",
    "name": "Doery defense",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "f6e4"
    ]
  },
  {
    "eco": "A46",
    "name": "Queen's pawn, Torre attack",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "e7e6",
      "c1g5"
    ]
  },
  {
    "eco": "A46",
    "name": "Queen's pawn, Torre attack, Wagner gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "e7e6",
      "c1g5",
      "c7c5",
      "e2e4"
    ]
  },
  {
    "eco": "A46",
    "name": "Queen's pawn, Yusupov-Rubinstein system",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "e7e6",
      "e2e3"
    ]
  },
  {
    "name": "Indian: 2.Bf4",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4"],
    "normalized": "indian 2 bf4",
    "loose": "indian 2 bf4"
  },
  {
    "name": "Indian: 2.c4",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c2c4"],
    "normalized": "indian 2 c4",
    "loose": "indian 2 c4"
  },
  {
    "name": "Indian: 2.c4 a6",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c2c4","a7a6"],
    "normalized": "indian 2 c4 a6",
    "loose": "indian 2 c4 a6"
  },
  {
    "name": "Indian: 2.Nc3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","b1c3"],
    "normalized": "indian 2 nc3",
    "loose": "indian 2 nc3"
  },
  {
    "name": "Indian: 2.Nd2",
    "eco": "A46",
    "moves": ["d2d4","g8f6","b1d2"],
    "normalized": "indian 2 nd2",
    "loose": "indian 2 nd2"
  },
  {
    "name": "Indian: 2.Nf3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3"],
    "normalized": "indian 2 nf3",
    "loose": "indian 2 nf3"
  },
  {
    "name": "Indian: 2.Nf3 b5",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","b7b5"],
    "normalized": "indian 2 nf3 b5",
    "loose": "indian 2 nf3 b5"
  },
  {
    "name": "Indian: 2.Nf3 b5 3.g3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","b7b5","g2g3"],
    "normalized": "indian 2 nf3 b5 3 g3",
    "loose": "indian 2 nf3 b5 3 g3"
  },
  {
    "name": "Indian: 2.Nf3 d6",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","d7d6"],
    "normalized": "indian 2 nf3 d6",
    "loose": "indian 2 nf3 d6"
  },
  {
    "name": "Indian: 2.Nf3 d6 3.Bg5",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","d7d6","c1g5"],
    "normalized": "indian 2 nf3 d6 3 bg5",
    "loose": "indian 2 nf3 d6 3 bg5"
  },
  {
    "name": "Indian: 2.Nf3 d6 3.Bg5 Nbd7",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","d7d6","c1g5","b8d7"],
    "normalized": "indian 2 nf3 d6 3 bg5 nbd7",
    "loose": "indian 2 nf3 d6 3 bg5 nbd7"
  },
  {
    "name": "Indian: 2.Nf3 d6 3.g3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","d7d6","g2g3"],
    "normalized": "indian 2 nf3 d6 3 g3",
    "loose": "indian 2 nf3 d6 3 g3"
  },
  {
    "name": "Indian: 2.Nf3 e6",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","e7e6"],
    "normalized": "indian 2 nf3 e6",
    "loose": "indian 2 nf3 e6"
  },
  {
    "name": "Indian: 2.Nf3 e6 3.c3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","e7e6","c2c3"],
    "normalized": "indian 2 nf3 e6 3 c3",
    "loose": "indian 2 nf3 e6 3 c3"
  },
  {
    "name": "Indian: 2.Nf3 e6 3.c3 b6",
    "eco": "A46",
    "moves": ["d2d4","g8f6","g1f3","e7e6","c2c3","b7b6"],
    "normalized": "indian 2 nf3 e6 3 c3 b6",
    "loose": "indian 2 nf3 e6 3 c3 b6"
  },
  {
    "name": "Indian: London System",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4"],
    "normalized": "indian london system",
    "loose": "indian london system"
  },
  {
    "name": "Indian: London, 3...c5",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4","c7c5"],
    "normalized": "indian london 3 c5",
    "loose": "indian london 3 c5"
  },
  {
    "name": "Indian: London, 3...c5 4.c3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4","c7c5","c2c3"],
    "normalized": "indian london 3 c5 4 c3",
    "loose": "indian london 3 c5 4 c3"
  },
  {
    "name": "Indian: London, 3...c5 4.e3",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4","c7c5","e2e3"],
    "normalized": "indian london 3 c5 4 e3",
    "loose": "indian london 3 c5 4 e3"
  },
  {
    "name": "Indian: London, 3...c5 4.e3 Qb6",
    "eco": "A46",
    "moves": ["d2d4","g8f6","c1f4","c7c5","e2e3","d8b6"],
    "normalized": "indian london 3 c5 4 e3 qb6",
    "loose": "indian london 3 c5 4 e3 qb6"
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
  "eco": "A47",
  "name": "Queen's Indian",
  "moves": ["d2d4","g8f6","g1f3","b7b6"]
},
  {
    "eco": "A47",
    "name": "Queen's Indian defense",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "b7b6"
    ]
  },
  {
    "name": "Indian: Queen’s Indian Accelerated",
    "eco": "A47",
    "moves": ["d2d4","g8f6","c2c4","b7b6"],
    "normalized": "indian queen s indian accelerated",
    "loose": "indian queen s indian accelerated"
  },
  {
    "name": "Neo-Queen’s Indian",
    "eco": "A47",
    "moves": ["d2d4","g8f6","c2c4","b7b6"],
    "normalized": "neo queen s indian",
    "loose": "neo queen s indian"
  },
  {
    "name": "Neo-Queen’s Indian: Marienbad System",
    "eco": "A47",
    "moves": ["d2d4","g8f6","c2c4","b7b6","b1c3"],
    "normalized": "neo queen s indian marienbad system",
    "loose": "neo queen s indian marienbad system"
  },
  {
    "name": "Neo-Queen’s Indian: Marienbad System, Berg Variation",
    "eco": "A47",
    "moves": ["d2d4","g8f6","c2c4","b7b6","b1c3","c8b7"],
    "normalized": "neo queen s indian marienbad system berg variation",
    "loose": "neo queen s indian marienbad system berg variation"
  },
  {
    "eco": "A48",
    "name": "King's Indian, East Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "g1f3",
      "g7g6"
    ]
  },
  {
  "eco": "A48",
  "name": "King's Indian",
  "moves": ["d2d4","g8f6","g1f3","g7g6"]
},
  {
    "eco": "A48",
    "name": "King's Indian, East Indian defense",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "g7g6"
    ]
  },
  {
    "eco": "A48",
    "name": "King's Indian, London system",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "g7g6",
      "c1f4"
    ]
  },
  {
    "eco": "A48",
    "name": "King's Indian, Torre attack",
    "moves": [
      "d2d4",
      "g8f6",
      "g1f3",
      "g7g6",
      "c1g5"
    ]
  },
  {
  "eco": "A49",
  "name": "King's Indian, Fianchetto without c4",
  "moves": ["d2d4","g8f6","g1f3","g7g6","g2g3"]
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
    "eco": "A50",
    "name": "Kevitz-Trajkovich defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "b8c6"
    ]
  },
  {
    "name": "Indian: Mexican Defence (Two Knights Tango)",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6"],
    "normalized": "indian mexican defense two knights tango",
    "loose": "indian mexican defense two knights tango"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nc3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","b1c3"],
    "normalized": "indian mexican defense 3 nc3",
    "loose": "indian mexican defense 3 nc3"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nf3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","g1f3"],
    "normalized": "indian mexican defense 3 nf3",
    "loose": "indian mexican defense 3 nf3"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nf3 d6",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","g1f3","d7d6"],
    "normalized": "indian mexican defense 3 nf3 d6",
    "loose": "indian mexican defense 3 nf3 d6"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nf3 e6",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","g1f3","e7e6"],
    "normalized": "indian mexican defense 3 nf3 e6",
    "loose": "indian mexican defense 3 nf3 e6"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nf3 e6 4.a3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","g1f3","e7e6","a2a3"],
    "normalized": "indian mexican defense 3 nf3 e6 4 a3",
    "loose": "indian mexican defense 3 nf3 e6 4 a3"
  },
  {
    "name": "Indian: Mexican Defence, 3.Nf3 e6 4.Nc3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","b8c6","g1f3","e7e6","b1c3"],
    "normalized": "indian mexican defense 3 nf3 e6 4 nc3",
    "loose": "indian mexican defense 3 nf3 e6 4 nc3"
  },
  {
    "name": "Indian: Slav-Indian",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","c7c6"],
    "normalized": "indian slav indian",
    "loose": "indian slav indian"
  },
  {
    "name": "Indian: Slav-Indian, 3.Nc3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","c7c6","b1c3"],
    "normalized": "indian slav indian 3 nc3",
    "loose": "indian slav indian 3 nc3"
  },
  {
    "name": "Indian: Slav-Indian, 3.Nf3",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","c7c6","g1f3"],
    "normalized": "indian slav indian 3 nf3",
    "loose": "indian slav indian 3 nf3"
  },
  {
    "name": "Neo-King’s Indian",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","g7g6"],
    "normalized": "neo king s indian",
    "loose": "neo king s indian"
  },
  {
    "name": "Neo-King’s Indian: Double Fianchetto System",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","b7b6"],
    "normalized": "neo king s indian double fianchetto system",
    "loose": "neo king s indian double fianchetto system"
  },
  {
    "name": "Neo-King’s Indian: Fianchetto System",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3"],
    "normalized": "neo king s indian fianchetto system",
    "loose": "neo king s indian fianchetto system"
  },
  {
    "name": "Neo-King’s Indian: London System",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","g7g6","c1f4"],
    "normalized": "neo king s indian london system",
    "loose": "neo king s indian london system"
  },
  {
    "name": "Neo-King’s Indian: Torre Attack",
    "eco": "A50",
    "moves": ["d2d4","g8f6","c2c4","g7g6","c1g5"],
    "normalized": "neo king s indian torre attack",
    "loose": "neo king s indian torre attack"
  },
  {
    "eco": "A51",
    "name": "Budapest defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "e7e5"
    ]
  },
  {
  "eco": "A51",
  "name": "Budapest Gambit",
  "moves": ["d2d4","g8f6","c2c4","e7e5"]
},
  {
    "eco": "A51",
    "name": "Budapest defense declined",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5"
    ]
  },
  {
    "eco": "A51",
    "name": "Budapest, Fajarowicz Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6e4"
    ]
  },
  {
    "eco": "A51",
    "name": "Budapest, Fajarowicz, Steiner Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6e4",
      "d1c2"
    ]
  },
  {
  "eco": "A52",
  "name": "Budapest Gambit",
  "moves": ["d2d4","g8f6","c2c4","e7e5","d4e5","f6g4"]
},
  {
    "eco": "A52",
    "name": "Budapest defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4"
    ]
  },
  {
    "eco": "A52",
    "name": "Budapest, Adler Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4",
      "g1f3"
    ]
  },
  {
    "eco": "A52",
    "name": "Budapest, Alekhine Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4",
      "e2e4"
    ]
  },
  {
    "eco": "A52",
    "name": "Budapest, Alekhine Variation , Balogh gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4",
      "e2e4",
      "d7d6"
    ]
  },
  {
    "eco": "A52",
    "name": "Budapest, Alekhine, Abonyi Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4",
      "e2e4",
      "g4e5",
      "f2f4",
      "e5c6"
    ]
  },
  {
    "eco": "A52",
    "name": "Budapest, Rubinstein Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e5",
      "d4e5",
      "f6g4",
      "c1f4"
    ]
  },
  {
    "eco": "A53",
    "name": "Old Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "d7d6"
    ]
  },
  {
  "eco": "A53",
  "name": "Old Indian",
  "moves": ["d2d4","g8f6","c2c4","d7d6"]
},
  {
    "eco": "A53",
    "name": "Old Indian defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "d7d6"
    ]
  },
  {
    "eco": "A53",
    "name": "Old Indian, Janowski Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "d7d6",
      "b1c3",
      "c8f5"
    ]
  },
  {
  "eco": "A53",
  "name": "Old Indian: 4.Ng5",
  "moves": [
    "d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1g5"
  ]
},
  {
  "eco": "A53",
  "name": "Old Indian: Bg4",
  "moves": [
    "d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","c1g5"
  ]
},
  {
  "eco": "A53",
  "name": "Old Indian: exchange",
  "moves": [
    "d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","d4e5"
  ]
},
  {
  "eco": "A53",
  "name": "Old Indian: Steiner–Wade variation",
  "moves": [
    "d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1f3","b8d7","c1g5"
  ]
},
  {
    "name": "Neo-Old Indian",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6"],
    "normalized": "neo old indian",
    "loose": "neo old indian"
  },
  {
    "name": "Neo-Old Indian / Modern",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g2g3"],
    "normalized": "neo old indian modern",
    "loose": "neo old indian modern"
  },
  {
    "name": "Neo-Old Indian / Modern: 3.Bf4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c1f4"],
    "normalized": "neo old indian modern 3 bf4",
    "loose": "neo old indian modern 3 bf4"
  },
  {
    "name": "Neo-Old Indian / Modern: 3.g3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g2g3"],
    "normalized": "neo old indian modern 3 g3",
    "loose": "neo old indian modern 3 g3"
  },
  {
    "name": "Neo-Old Indian: 2.Bg5",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c1g5"],
    "normalized": "neo old indian 2 bg5",
    "loose": "neo old indian 2 bg5"
  },
  {
    "name": "Neo-Old Indian: 2.c4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6"],
    "normalized": "neo old indian 2 c4",
    "loose": "neo old indian 2 c4"
  },
  {
    "name": "Neo-Old Indian: 2.c4 e5",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e7e5"],
    "normalized": "neo old indian 2 c4 e5",
    "loose": "neo old indian 2 c4 e5"
  },
  {
    "name": "Neo-Old Indian: 2.c4 e5 3.d5",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e7e5","d4d5"],
    "normalized": "neo old indian 2 c4 e5 3 d5",
    "loose": "neo old indian 2 c4 e5 3 d5"
  },
  {
    "name": "Neo-Old Indian: 2.c4 e5 3.dxe5",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e7e5","d4e5"],
    "normalized": "neo old indian 2 c4 e5 3 dxe5",
    "loose": "neo old indian 2 c4 e5 3 dxe5"
  },
  {
    "name": "Neo-Old Indian: 2.c4 e5 3.Nf3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e7e5","g1f3"],
    "normalized": "neo old indian 2 c4 e5 3 nf3",
    "loose": "neo old indian 2 c4 e5 3 nf3"
  },
  {
    "name": "Neo-Old Indian: 2.c4 e5 3.Nf3 e4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e7e5","g1f3","e5e4"],
    "normalized": "neo old indian 2 c4 e5 3 nf3 e4",
    "loose": "neo old indian 2 c4 e5 3 nf3 e4"
  },
  {
    "name": "Neo-Old Indian: 2.g3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g2g3"],
    "normalized": "neo old indian 2 g3",
    "loose": "neo old indian 2 g3"
  },
  {
    "name": "Neo-Old Indian: 2.Nf3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3"],
    "normalized": "neo old indian 2 nf3",
    "loose": "neo old indian 2 nf3"
  },
  {
    "name": "Neo-Old Indian: Modern",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g2g3"],
    "normalized": "neo old indian modern",
    "loose": "neo old indian modern"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.e4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e4"],
    "normalized": "neo old indian modern 3 e4",
    "loose": "neo old indian modern 3 e4"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.e4 Bg7",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e4","f8g7"],
    "normalized": "neo old indian modern 3 e4 bg7",
    "loose": "neo old indian modern 3 e4 bg7"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3"],
    "normalized": "neo old indian modern 3 nc3",
    "loose": "neo old indian modern 3 nc3"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3 Bg7",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","f8g7"],
    "normalized": "neo old indian modern 3 nc3 bg7",
    "loose": "neo old indian modern 3 nc3 bg7"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3 Bg7 4.Nf3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","f8g7","g1f3"],
    "normalized": "neo old indian modern 3 nc3 bg7 4 nf3",
    "loose": "neo old indian modern 3 nc3 bg7 4 nf3"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3 Bg7 4.Nf3 Bf4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","f8g7","g1f3","c8f5"],
    "normalized": "neo old indian modern 3 nc3 bg7 4 nf3 bf4",
    "loose": "neo old indian modern 3 nc3 bg7 4 nf3 bf4"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3 Bg7 4.Nf3 Bf4 5.e3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","f8g7","g1f3","c8f5","e2e3"],
    "normalized": "neo old indian modern 3 nc3 bg7 4 nf3 bf4 5 e3",
    "loose": "neo old indian modern 3 nc3 bg7 4 nf3 bf4 5 e3"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nc3 Bg7 4.Nf3 Bf4 5.e3 Nc6",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","f8g7","g1f3","c8f5","e2e3","b8c6"],
    "normalized": "neo old indian modern 3 nc3 bg7 4 nf3 bf4 5 e3 nc6",
    "loose": "neo old indian modern 3 nc3 bg7 4 nf3 bf4 5 e3 nc6"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nf3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3"],
    "normalized": "neo old indian modern 3 nf3",
    "loose": "neo old indian modern 3 nf3"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nf3 Bg7",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3","f8g7"],
    "normalized": "neo old indian modern 3 nf3 bg7",
    "loose": "neo old indian modern 3 nf3 bg7"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nf3 Bg7 4.e4",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3","f8g7","e2e4"],
    "normalized": "neo old indian modern 3 nf3 bg7 4 e4",
    "loose": "neo old indian modern 3 nf3 bg7 4 e4"
  },
  {
    "name": "Neo-Old Indian: Modern, 3.Nf3 Bg7 4.g3",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3","f8g7","g2g3"],
    "normalized": "neo old indian modern 3 nf3 bg7 4 g3",
    "loose": "neo old indian modern 3 nf3 bg7 4 g3"
  },
  {
    "name": "Neo-Old Indian: Modern, Rossolimo Variation",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","g7g6"],
    "normalized": "neo old indian modern rossolimo variation",
    "loose": "neo old indian modern rossolimo variation"
  },
  {
    "name": "Neo-Old Indian: Queenswap",
    "eco": "A53",
    "moves": ["d2d4","g8f6","c2c4","d7d6","d1a4"],
    "normalized": "neo old indian queenswap",
    "loose": "neo old indian queenswap"
  },
  {
  "eco": "A54",
  "name": "Old Indian, Ukrainian Variation",
  "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1f3"]
},
  {
    "eco": "A54",
    "name": "Old Indian, Dus-Khotimirsky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "d7d6",
      "b1c3",
      "e7e5",
      "e2e3",
      "b8d7",
      "f1d3"
    ]
  },
  {
    "eco": "A54",
    "name": "Old Indian, Ukrainian Variation , 4.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "d7d6",
      "b1c3",
      "e7e5",
      "g1f3"
    ]
  },
  {
    "name": "Neo-Old Indian: Wade Defence",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","g1f3","c8g4"],
    "normalized": "neo old indian wade defense",
    "loose": "neo old indian wade defense"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4"],
    "normalized": "neo old indian wade defense 3 c4",
    "loose": "neo old indian wade defense 3 c4"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 Bxf3",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","c8f5","g2f3"],
    "normalized": "neo old indian wade defense 3 c4 bxf3",
    "loose": "neo old indian wade defense 3 c4 bxf3"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 e5",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","e7e5"],
    "normalized": "neo old indian wade defense 3 c4 e5",
    "loose": "neo old indian wade defense 3 c4 e5"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 e5 4.dxe5",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","e7e5","d4e5"],
    "normalized": "neo old indian wade defense 3 c4 e5 4 dxe5",
    "loose": "neo old indian wade defense 3 c4 e5 4 dxe5"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 e5 4.dxe5 Nc6 Gambit",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","e7e5","d4e5","b8c6"],
    "normalized": "neo old indian wade defense 3 c4 e5 4 dxe5 nc6 gambit",
    "loose": "neo old indian wade defense 3 c4 e5 4 dxe5 nc6 gambit"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 e5 4.Nc3",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","e7e5","b1c3"],
    "normalized": "neo old indian wade defense 3 c4 e5 4 nc3",
    "loose": "neo old indian wade defense 3 c4 e5 4 nc3"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 e5 4.Nc3 Nc6",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","e7e5","b1c3","b8c6"],
    "normalized": "neo old indian wade defense 3 c4 e5 4 nc3 nc6",
    "loose": "neo old indian wade defense 3 c4 e5 4 nc3 nc6"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 Nd7",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","b8d7"],
    "normalized": "neo old indian wade defense 3 c4 nd7",
    "loose": "neo old indian wade defense 3 c4 nd7"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 Nd7 4.Nc3",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","b8d7","b1c3"],
    "normalized": "neo old indian wade defense 3 c4 nd7 4 nc3",
    "loose": "neo old indian wade defense 3 c4 nd7 4 nc3"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.c4 Nd7 4.Nc3 e5",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","c2c4","b8d7","b1c3","e7e5"],
    "normalized": "neo old indian wade defense 3 c4 nd7 4 nc3 e5",
    "loose": "neo old indian wade defense 3 c4 nd7 4 nc3 e5"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.e3",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e3"],
    "normalized": "neo old indian wade defense 3 e3",
    "loose": "neo old indian wade defense 3 e3"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.e3 Nd7",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e3","b8d7"],
    "normalized": "neo old indian wade defense 3 e3 nd7",
    "loose": "neo old indian wade defense 3 e3 nd7"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.e3 Nf6",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e3","g8f6"],
    "normalized": "neo old indian wade defense 3 e3 nf6",
    "loose": "neo old indian wade defense 3 e3 nf6"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.e4",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e4"],
    "normalized": "neo old indian wade defense 3 e4",
    "loose": "neo old indian wade defense 3 e4"
  },
  {
    "name": "Neo-Old Indian: Wade Defence, 3.e4 Nf6",
    "eco": "A54",
    "moves": ["d2d4","g8f6","c2c4","d7d6","e2e4","g8f6"],
    "normalized": "neo old indian wade defense 3 e4 nf6",
    "loose": "neo old indian wade defense 3 e4 nf6"
  },
  {
  "eco": "A55",
  "name": "Old Indian, Main line",
  "moves": ["d2d4","g8f6","c2c4","d7d6","b1c3","e7e5","g1f3","b8d7","e2e4"]
},
{
  "name": "Benoni Defense: Czech Variation",
  "eco": "A56",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e5"],
  "normalized": "benoni defense czech variation",
  "loose": "czech benoni"
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
  "eco": "A56",
  "name": "Benoni Defense",
  "moves": ["d2d4","g8f6","c2c4","c7c5"]
},
  {
    "eco": "A56",
    "name": "Benoni defense, Hromodka system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "d7d6"
    ]
  },
  {
    "eco": "A56",
    "name": "Czech Benoni defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e5"
    ]
  },
  {
    "eco": "A56",
    "name": "Vulture defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "f6e4"
    ]
  },
  {
  "eco": "A56",
  "name": "Benoni (Bd3)",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","f8e7","c1d3"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni (g3)",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","g2g3"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: 7.Bf4",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","c1f4"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: classical (with ...a6 & ...Bg4)",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","c1g5","f8g7","h2h3","a7a6","g5g4"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: classical (with ...Re8 & ...Na6)",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","c1g5","f8g7","e2e3","e8e8","f1e2","b8a6"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: Kramer–Saemisch",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: modern variation",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6"
  ]
},
  {
  "eco": "A56",
  "name": "Benoni: Saemisch formation",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","f2f3"
  ]
},
  {
    "name": "Neo-Benoni",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5"],
    "normalized": "neo benoni",
    "loose": "neo benoni"
  },
  {
    "name": "Neo-Benoni 3.dxc5",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","d4c5"],
    "normalized": "neo benoni 3 dxc5",
    "loose": "neo benoni 3 dxc5"
  },
  {
    "name": "Neo-Benoni: 3.c3",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","c2c3"],
    "normalized": "neo benoni 3 c3",
    "loose": "neo benoni 3 c3"
  },
  {
    "name": "Neo-Benoni: 3.c3 b6",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","c2c3","b7b6"],
    "normalized": "neo benoni 3 c3 b6",
    "loose": "neo benoni 3 c3 b6"
  },
  {
    "name": "Neo-Benoni: 3.c3 cxd4",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","c2c3","c5d4"],
    "normalized": "neo benoni 3 c3 cxd4",
    "loose": "neo benoni 3 c3 cxd4"
  },
  {
    "name": "Neo-Benoni: 3.c3 e6",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","c2c3","e7e6"],
    "normalized": "neo benoni 3 c3 e6",
    "loose": "neo benoni 3 c3 e6"
  },
  {
    "name": "Neo-Benoni: 3.c3 g6",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","c2c3","g7g6"],
    "normalized": "neo benoni 3 c3 g6",
    "loose": "neo benoni 3 c3 g6"
  },
  {
    "name": "Neo-Benoni: 3.e3",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","e2e3"],
    "normalized": "neo benoni 3 e3",
    "loose": "neo benoni 3 e3"
  },
  {
    "name": "Neo-Benoni: 3.e3 cxd4",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","e2e3","c5d4"],
    "normalized": "neo benoni 3 e3 cxd4",
    "loose": "neo benoni 3 e3 cxd4"
  },
  {
    "name": "Neo-Benoni: 3.g3",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","g2g3"],
    "normalized": "neo benoni 3 g3",
    "loose": "neo benoni 3 g3"
  },
  {
    "name": "Neo-Benoni: 3.g3 cxd4",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","g2g3","c5d4"],
    "normalized": "neo benoni 3 g3 cxd4",
    "loose": "neo benoni 3 g3 cxd4"
  },
  {
    "name": "Neo-Benoni: 3.g3 cxd4 4.Nxd4",
    "eco": "A56",
    "moves": ["d2d4","g8f6","c2c4","c7c5","g2g3","c5d4","c3d4"],
    "normalized": "neo benoni 3 g3 cxd4 4 nxd4",
    "loose": "neo benoni 3 g3 cxd4 4 nxd4"
  },
  {
    "eco": "A57",
    "name": "Benko gambit",
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
  "eco": "A57",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5"]
},
  {
    "eco": "A57",
    "name": "Benko gambit half accepted",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6"
    ]
  },
  {
    "eco": "A57",
    "name": "Benko gambit, Nescafe Frappe attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b1c3",
      "a6b5",
      "e2e4",
      "b5b4",
      "c3b5",
      "d7d6",
      "f1c4"
    ]
  },
  {
    "eco": "A57",
    "name": "Benko gambit, Zaitsev system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b1c3"
    ]
  },
  {
  "eco": "A57",
  "name": "Benko gambit (Volga gambit)",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4c5","b7b5"
  ]
},
  {
  "eco": "A57",
  "name": "Benko gambit: 4.Nf3",
  "moves": [
    "d2d4","g8f6","c2c4","c7c5","d4c5","b7b5","g1f3"
  ]
},
  {
  "eco": "A58",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5","c4b5","a7a6","b5a6"]
},
  {
    "eco": "A58",
    "name": "Benko gambit accepted",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6"
    ]
  },
  {
    "eco": "A58",
    "name": "Benko gambit, Fianchetto Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6",
      "c8a6",
      "b1c3",
      "d7d6",
      "g1f3",
      "g7g6",
      "g2g3"
    ]
  },
  {
    "eco": "A58",
    "name": "Benko gambit, Nd2 Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6",
      "c8a6",
      "b1c3",
      "d7d6",
      "g1f3",
      "g7g6",
      "f3d2"
    ]
  },
  {
  "eco": "A59",
  "name": "Benko Gambit",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","b7b5","c4b5","a7a6","b5a6","c8a6","b1c3","d7d6","e2e4"]
},
  {
    "eco": "A59",
    "name": "Benko gambit, 7.e4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6",
      "c8a6",
      "b1c3",
      "d7d6",
      "e2e4"
    ]
  },
  {
    "eco": "A59",
    "name": "Benko gambit, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6",
      "c8a6",
      "b1c3",
      "d7d6",
      "e2e4",
      "a6f1",
      "e1f1",
      "g7g6",
      "g2g3",
      "f8g7",
      "f1g2",
      "e8g8",
      "g1f3"
    ]
  },
  {
    "eco": "A59",
    "name": "Benko gambit, Ne2 Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "b7b5",
      "c4b5",
      "a7a6",
      "b5a6",
      "c8a6",
      "b1c3",
      "d7d6",
      "e2e4",
      "a6f1",
      "e1f1",
      "g7g6",
      "g1e2"
    ]
  },
  {
    "eco": "A60",
    "name": "Benoni defence",
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
  "eco": "A60",
  "name": "Benoni Defense",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6"]
},
{
  "name": "Benoni Defense: Flick-Knife Attack",
  "eco": "A61",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f1b5"],
  "normalized": "benoni defense flick knife attack",
  "loose": "benoni flick knife"
},
  {
  "eco": "A61",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6"]
},
  {
    "eco": "A61",
    "name": "Benoni defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6"
    ]
  },
  {
    "eco": "A61",
    "name": "Benoni, Fianchetto Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6",
      "g2g3"
    ]
  },
  {
    "eco": "A61",
    "name": "Benoni, Nimzovich (knight's tour) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6",
      "f3d2"
    ]
  },
  {
    "eco": "A61",
    "name": "Benoni, Uhlmann Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6",
      "c1g5"
    ]
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
    "eco": "A63",
    "name": "Benoni, Fianchetto, 9...Nbd7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6",
      "g2g3",
      "f8g7",
      "f1g2",
      "e8g8",
      "e1g1",
      "b8d7"
    ]
  },
  {
  "eco": "A64",
  "name": "Benoni, Fianchetto",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","g1f3","g7g6","g2g3","f8g7","f1g2","e8g8"]
},
  {
    "eco": "A64",
    "name": "Benoni, Fianchetto, 11...Re8",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "g1f3",
      "g7g6",
      "g2g3",
      "f8g7",
      "f1g2",
      "e8g8",
      "e1g1",
      "b8d7",
      "f3d2",
      "a7a6",
      "a2a4",
      "f8e8"
    ]
  },
  {
  "eco": "A65",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4"]
},
  {
    "eco": "A65",
    "name": "Benoni, 6.e4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4"
    ]
  },
  {
  "eco": "A66",
  "name": "Benoni",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","f2f4"]
},
  {
    "eco": "A66",
    "name": "Benoni, Mikenas Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "f2f4",
      "f8g7",
      "e4e5"
    ]
  },
  {
    "eco": "A66",
    "name": "Benoni, pawn storm Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "f2f4"
    ]
  },
  {
  "name": "Benoni Defense: Taimanov Variation",
  "eco": "A67",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6"],
  "normalized": "benoni defense taimanov variation",
  "loose": "benoni taimanov"
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
    "eco": "A70",
    "name": "Benoni, Classical with e4 and Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3"
    ]
  },
  {
    "eco": "A70",
    "name": "Benoni, Classical without 9.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2"
    ]
  },
  {
  "eco": "A71",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","c1g5"]
},
  {
    "eco": "A71",
    "name": "Benoni, Classical, 8.Bg5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "c1g5"
    ]
  },
  {
  "eco": "A72",
  "name": "Benoni, Classical without ...Nc6",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A72",
    "name": "Benoni, Classical without 9.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8"
    ]
  },
  {
  "eco": "A73",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A73",
    "name": "Benoni, Classical, 9.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1"
    ]
  },
  {
  "eco": "A74",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A74",
    "name": "Benoni, Classical, 9...a6, 10.a4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1",
      "a7a6",
      "a2a4"
    ]
  },
  {
  "eco": "A75",
  "name": "Benoni, Classical with ...a6",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A75",
    "name": "Benoni, Classical with ...a6 and 10...Bg4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1",
      "a7a6",
      "a2a4",
      "c8g4"
    ]
  },
  {
  "eco": "A76",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A76",
    "name": "Benoni, Classical, 9...Re8",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1",
      "f8e8"
    ]
  },
  {
  "eco": "A77",
  "name": "Benoni, Classical",
  "moves": ["d2d4","g8f6","c2c4","c7c5","d4d5","e7e6","b1c3","e6d5","c4d5","d7d6","e2e4","g7g6","g1f3","f8g7","f1e2","e8g8"]
},
  {
    "eco": "A77",
    "name": "Benoni, Classical, 9...Re8, 10.Nd2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1",
      "f8e8",
      "f3d2"
    ]
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
    "eco": "A79",
    "name": "Benoni, Classical, 11.f3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "c7c5",
      "d4d5",
      "e7e6",
      "b1c3",
      "e6d5",
      "c4d5",
      "d7d6",
      "e2e4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2",
      "e8g8",
      "e1g1",
      "f8e8",
      "f3d2",
      "b8a6",
      "f2f3"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch",
    "moves": [
      "d2d4",
      "f7f5"
    ]
  },
  {
  "eco": "A80",
  "name": "Dutch",
  "moves": ["d2d4","f7f5"]
},
  {
    "eco": "A80",
    "name": "Dutch, 2.Bg5 Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c1g5"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch, Korchnoi attack",
    "moves": [
      "d2d4",
      "f7f5",
      "h2h3"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch, Krejcik gambit",
    "moves": [
      "d2d4",
      "f7f5",
      "g2g4"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch, Manhattan (Alapin, Ulvestad) Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "d1d3"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch, Spielmann gambit",
    "moves": [
      "d2d4",
      "f7f5",
      "b1c3",
      "g8f6",
      "g2g4"
    ]
  },
  {
    "eco": "A80",
    "name": "Dutch, Von Pretzel gambit",
    "moves": [
      "d2d4",
      "f7f5",
      "d1d3",
      "e7e6",
      "g2g4"
    ]
  },
  {
  "eco": "A80",
  "name": "Reti-Dutch",
  "moves": [
    "g1f3","f7f5","d2d4"
  ]
},
  {
  "eco": "A80",
  "name": "Reti-Dutch",
  "moves": [
    "g1f3","f7f5","d2d4"
  ]
},
  {
  "eco": "A81",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","g2g3"]
},
  {
    "eco": "A81",
    "name": "Dutch defense",
    "moves": [
      "d2d4",
      "f7f5",
      "g2g3"
    ]
  },
  {
    "eco": "A81",
    "name": "Dutch defense, Blackburne Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "g2g3",
      "g8f6",
      "f1g2",
      "e7e6",
      "g1h3"
    ]
  },
  {
    "eco": "A81",
    "name": "Dutch, Leningrad, Basman system",
    "moves": [
      "d2d4",
      "f7f5",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1f3",
      "c7c6",
      "e1g1",
      "g8h6"
    ]
  },
  {
    "eco": "A81",
    "name": "Dutch, Leningrad, Karlsbad Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "g1h3"
    ]
  },
  {
  "eco": "A81",
  "name": "Dutch: Leningrad, main variation (7...Qe8)",
  "moves": [
    "d2d4","f7f5","g2g3","g8f6","f1g2","g7g6","c2c4","f8g7","g1f3","d7d6","e1g1","e8e8"
  ]
},
  {
  "eco": "A82",
  "name": "Dutch, Staunton Gambit",
  "moves": ["d2d4","f7f5","e2e4"]
},
  {
    "eco": "A82",
    "name": "Dutch, Balogh defense",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "d7d6"
    ]
  },
  {
    "eco": "A82",
    "name": "Dutch, Staunton gambit, Tartakower Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "g2g4"
    ]
  },
  {
  "eco": "A83",
  "name": "Dutch, Staunton Gambit",
  "moves": ["d2d4","f7f5","e2e4","f5e4","b1c3","g8f6","c1g5"]
},
  {
    "eco": "A83",
    "name": "Dutch, Staunton gambit, Alekhine Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "c1g5",
      "g7g6",
      "h2h4"
    ]
  },
  {
    "eco": "A83",
    "name": "Dutch, Staunton gambit, Chigorin Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c6"
    ]
  },
  {
    "eco": "A83",
    "name": "Dutch, Staunton gambit, Lasker Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "c1g5",
      "g7g6",
      "f2f3"
    ]
  },
  {
    "eco": "A83",
    "name": "Dutch, Staunton gambit, Nimzovich Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "c1g5",
      "b7b6"
    ]
  },
  {
    "eco": "A83",
    "name": "Dutch, Staunton gambit, Staunton's line",
    "moves": [
      "d2d4",
      "f7f5",
      "e2e4",
      "f5e4",
      "b1c3",
      "g8f6",
      "c1g5"
    ]
  },
  {
  "eco": "A84",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4"]
},
  {
    "eco": "A84",
    "name": "Dutch defense",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4"
    ]
  },
  {
    "eco": "A84",
    "name": "Dutch defense, Bladel Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g7g6",
      "b1c3",
      "g8h6"
    ]
  },
  {
    "eco": "A84",
    "name": "Dutch defense, Rubinstein Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "e7e6",
      "b1c3"
    ]
  },
  {
    "eco": "A84",
    "name": "Dutch, Staunton gambit deferred",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "e7e6",
      "e2e4"
    ]
  },
  {
  "eco": "A85",
  "name": "Dutch, with c4 & Nc3",
  "moves": ["d2d4","f7f5","c2c4","g8f6","b1c3"]
},
  {
    "eco": "A85",
    "name": "Dutch with c4 & Nc3",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "b1c3"
    ]
  },
  {
  "eco": "A86",
  "name": "Dutch",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3"]
},
  {
    "eco": "A86",
    "name": "Dutch with c4 & g3",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3"
    ]
  },
  {
    "eco": "A86",
    "name": "Dutch, Hort-Antoshin system",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "d7d6",
      "f1g2",
      "c7c6",
      "b1c3",
      "d8c7"
    ]
  },
  {
    "eco": "A86",
    "name": "Dutch, Leningrad Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "g7g6"
    ]
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
    "eco": "A90",
    "name": "Dutch defense",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2"
    ]
  },
  {
    "eco": "A90",
    "name": "Dutch defense, Dutch-Indian (Nimzo-Dutch) Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8b4"
    ]
  },
  {
    "eco": "A90",
    "name": "Dutch-Indian, Alekhine Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8b4",
      "c1d2",
      "b4e7"
    ]
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
    "eco": "A92",
    "name": "Dutch defense",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8"
    ]
  },
  {
    "eco": "A92",
    "name": "Dutch defense, Alekhine Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "f6e4"
    ]
  },
  {
    "eco": "A92",
    "name": "Dutch, Stonewall Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d5"
    ]
  },
  {
    "eco": "A92",
    "name": "Dutch, Stonewall with Nc3",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d5",
      "b1c3"
    ]
  },
  {
  "eco": "A93",
  "name": "Dutch, Stonewall, Botvinnik Variation",
  "moves": ["d2d4","f7f5","c2c4","g8f6","g2g3","e7e6","f1g2","f8e7","g1f3","e8g8","e1g1","d7d5","b2b3"]
},
  {
    "eco": "A93",
    "name": "Dutch, Stonewall, Botwinnik Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d5",
      "b2b3"
    ]
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
    "eco": "A95",
    "name": "Dutch, Stonewall with Nc3",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d5",
      "b1c3",
      "c7c6"
    ]
  },
  {
    "eco": "A95",
    "name": "Dutch, Stonewall: Chekhover Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d5",
      "b1c3",
      "c7c6",
      "d1c2",
      "d8e8",
      "c1g5"
    ]
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
    "eco": "A97",
    "name": "Dutch, Ilyin-Genevsky Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d6",
      "b1c3",
      "d8e8"
    ]
  },
  {
    "eco": "A97",
    "name": "Dutch, Ilyin-Genevsky, Winter Variation",
    "moves": [
      "d2d4",
      "f7f5",
      "c2c4",
      "g8f6",
      "g2g3",
      "e7e6",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "d7d6",
      "b1c3",
      "d8e8",
      "f1e1"
    ]
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
  "eco": "B00",
  "name": "Uncommon King's Pawn Opening",
  "moves": ["e2e4"]
},
  {
    "eco": "B00",
    "name": "Barnes defense",
    "moves": [
      "e2e4",
      "f7f6"
    ]
  },
  {
    "eco": "B00",
    "name": "Carr's defense",
    "moves": [
      "e2e4",
      "h7h6"
    ]
  },
  {
    "eco": "B00",
    "name": "Corn stalk defense",
    "moves": [
      "e2e4",
      "a7a5"
    ]
  },
  {
    "eco": "B00",
    "name": "Fried fox defense",
    "moves": [
      "e2e4",
      "f7f6",
      "d2d4",
      "e8f7"
    ]
  },
  {
    "eco": "B00",
    "name": "Guatemala defense",
    "moves": [
      "e2e4",
      "b7b6",
      "d2d4",
      "c8a6"
    ]
  },
  {
    "eco": "B00",
    "name": "Hippopotamus defense",
    "moves": [
      "e2e4",
      "g8h6",
      "d2d4",
      "g7g6",
      "c2c4",
      "f7f6"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Neo-Mongoloid defense",
    "moves": [
      "e2e4",
      "b8c6",
      "d2d4",
      "f7f6"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defense",
    "moves": [
      "e2e4",
      "b8c6"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defense, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "b8c6",
      "d2d4",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defense, Marshall gambit",
    "moves": [
      "e2e4",
      "b8c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "d8d5",
      "b1c3"
    ]
  },
  {
    "eco": "B00",
    "name": "KP, Nimzovich defense, Wheeler gambit",
    "moves": [
      "e2e4",
      "b8c6",
      "b2b4",
      "c6b4",
      "c2c3",
      "b4c6",
      "d2d4"
    ]
  },
  {
    "eco": "B00",
    "name": "Lemming defense",
    "moves": [
      "e2e4",
      "b8a6"
    ]
  },
  {
    "eco": "B00",
    "name": "Owen defense",
    "moves": [
      "e2e4",
      "b7b6"
    ]
  },
  {
    "eco": "B00",
    "name": "Reversed Grob (Borg/Basman defense/macho Grob)",
    "moves": [
      "e2e4",
      "g7g5"
    ]
  },
  {
    "eco": "B00",
    "name": "St. George (Baker) defense",
    "moves": [
      "e2e4",
      "a7a6"
    ]
  },
  {
    "name": "Nimzowitsch Defence: Bogoljubow, 3...dxe4",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","b1c3","d5e4"],
    "normalized": "nimzowitsch defense, bogoljubow, 3…dxe4",
    "loose": "nimzowitsch defense bogoljubow 3 dxe4"
  },
  {
    "name": "Nimzowitsch Defence: Bogoljubow, 3...e5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","b1c3","e7e5"],
    "normalized": "nimzowitsch defense, bogoljubow, 3…e5",
    "loose": "nimzowitsch defense bogoljubow 3 e5"
  },
  {
    "name": "Nimzowitsch Defence: Bogoljubow, 3...Nf6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","b1c3","g8f6"],
    "normalized": "nimzowitsch defense, bogoljubow, 3…nf6",
    "loose": "nimzowitsch defense bogoljubow 3 nf6"
  },
  {
    "name": "Nimzowitsch Defence: Colorado Counter",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","f7f5"],
    "normalized": "nimzowitsch defense, colorado counter",
    "loose": "nimzowitsch defense colorado counter"
  },
  {
    "name": "Nimzowitsch Defence: Marshall Gambit",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4d5","d8d5"],
    "normalized": "nimzowitsch defense, marshall gambit",
    "loose": "nimzowitsch defense marshall gambit"
  },
  {
    "name": "Nimzowitsch Defence: Wheeler Gambit",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","e7e5","d4e5","c6e5","f2f4"],
    "normalized": "nimzowitsch defense, wheeler gambit",
    "loose": "nimzowitsch defense wheeler gambit"
  },
  {
    "name": "King's Pawn",
    "eco": "B00",
    "moves": ["e2e4"],
    "normalized": "king’s pawn",
    "loose": "king s pawn"
  },
  {
    "name": "King's Pawn: Fred",
    "eco": "B00",
    "moves": ["e2e4","f7f5"],
    "normalized": "king’s pawn, fred",
    "loose": "king s pawn fred"
  },
  {
    "name": "King's Pawn: Hippopotamus Defence",
    "eco": "B00",
    "moves": ["e2e4","g7g6","d7d6","e7e6","b7b6"],
    "normalized": "king’s pawn, hippopotamus defense",
    "loose": "king s pawn hippopotamus defense"
  },
  {
    "name": "Nimzowitsch Defence",
    "eco": "B00",
    "moves": ["e2e4","b8c6"],
    "normalized": "nimzowitsch defense",
    "loose": "nimzowitsch defense"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4"],
    "normalized": "nimzowitsch defense, 2.d4",
    "loose": "nimzowitsch defense 2 d4"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5"],
    "normalized": "nimzowitsch defense, 2.d4 d5",
    "loose": "nimzowitsch defense 2 d4 d5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.e5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4e5"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.e5",
    "loose": "nimzowitsch defense 2 d4 d5 3 e5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.e5 Bf5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4e5","c8f5"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.e5 bf5",
    "loose": "nimzowitsch defense 2 d4 d5 3 e5 bf5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.e5 Bf5 4.c3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4e5","c8f5","c2c3"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.e5 bf5 4.c3",
    "loose": "nimzowitsch defense 2 d4 d5 3 e5 bf5 4 c3"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.exd5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4d5"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.exd5",
    "loose": "nimzowitsch defense 2 d4 d5 3 exd5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.exd5 Qxd5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4d5","d8d5"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.exd5 qxd5",
    "loose": "nimzowitsch defense 2 d4 d5 3 exd5 qxd5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d5 3.exd5 Qxd5 4.Nf3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4d5","d8d5","g1f3"],
    "normalized": "nimzowitsch defense, 2.d4 d5 3.exd5 qxd5 4.nf3",
    "loose": "nimzowitsch defense 2 d4 d5 3 exd5 qxd5 4 nf3"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d6"],
    "normalized": "nimzowitsch defense, 2.d4 d6",
    "loose": "nimzowitsch defense 2 d4 d6"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 d6 3.Nc3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d6","b1c3"],
    "normalized": "nimzowitsch defense, 2.d4 d6 3.nc3",
    "loose": "nimzowitsch defense 2 d4 d6 3 nc3"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 e5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","e7e5"],
    "normalized": "nimzowitsch defense, 2.d4 e5",
    "loose": "nimzowitsch defense 2 d4 e5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 e5 3.d5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","e7e5","d4d5"],
    "normalized": "nimzowitsch defense, 2.d4 e5 3.d5",
    "loose": "nimzowitsch defense 2 d4 e5 3 d5"
  },
  {
    "name": "Nimzowitsch Defence: 2.d4 e5 3.dxe5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","e7e5","d4e5"],
    "normalized": "nimzowitsch defense, 2.d4 e5 3.dxe5",
    "loose": "nimzowitsch defense 2 d4 e5 3 dxe5"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nc3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","b1c3"],
    "normalized": "nimzowitsch defense, 2.nc3",
    "loose": "nimzowitsch defense 2 nc3"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nc3 e6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","b1c3","e7e6"],
    "normalized": "nimzowitsch defense, 2.nc3 e6",
    "loose": "nimzowitsch defense 2 nc3 e6"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nc3 Nf6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","b1c3","g8f6"],
    "normalized": "nimzowitsch defense, 2.nc3 nf6",
    "loose": "nimzowitsch defense 2 nc3 nf6"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3"],
    "normalized": "nimzowitsch defense, 2.nf3",
    "loose": "nimzowitsch defense 2 nf3"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6"],
    "normalized": "nimzowitsch defense, 2.nf3 d6",
    "loose": "nimzowitsch defense 2 nf3 d6"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Bg4",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","c8g4"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 bg4",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 bg4"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 Bg4",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","c8g4"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 bg4",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 bg4"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 Bg4 5.Bb5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","c8g4","f1b5"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 bg4 5.bb5",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 bg4 5 bb5"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 Bg4 5.Be2",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","c8g4","f1e2"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 bg4 5.be2",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 bg4 5 be2"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 Bg4 5.Be3",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","c8g4","c1e3"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 bg4 5.be3",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 bg4 5 be3"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 Bg4 5.d5",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","c8g4","d4d5"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 bg4 5.d5",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 bg4 5 d5"
  },
  {
    "name": "Nimzowitsch Defence: 2.Nf3 d6 3.d4 Nf6 4.Nc3 g6",
    "eco": "B00",
    "moves": ["e2e4","b8c6","g1f3","d7d6","d2d4","g8f6","b1c3","g7g6"],
    "normalized": "nimzowitsch defense, 2.nf3 d6 3.d4 nf6 4.nc3 g6",
    "loose": "nimzowitsch defense 2 nf3 d6 3 d4 nf6 4 nc3 g6"
  },
  {
    "name": "Nimzowitsch Defence: Aachen Gambit",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","e7e5","d4e5","c6e5"],
    "normalized": "nimzowitsch defense, aachen gambit",
    "loose": "nimzowitsch defense aachen gambit"
  },
  {
    "name": "Nimzowitsch Defence: Bielefelder Gambit",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","e4e5","c8f5"],
    "normalized": "nimzowitsch defense, bielefelder gambit",
    "loose": "nimzowitsch defense bielefelder gambit"
  },
  {
    "name": "Nimzowitsch Defence: Bogoljubow Variation",
    "eco": "B00",
    "moves": ["e2e4","b8c6","d2d4","d7d5","b1c3"],
    "normalized": "nimzowitsch defense, bogoljubow variation",
    "loose": "nimzowitsch defense bogoljubow variation"
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
  "eco": "B01",
  "name": "Scandinavian",
  "moves": ["e2e4","d7d5"]
},
  {
    "eco": "B01",
    "name": "Scandinavian (center counter) defense",
    "moves": [
      "e2e4",
      "d7d5"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defense",
    "moves": [
      "e2e4",
      "d7d5",
      "e4d5",
      "g8f6"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defense, Gruenfeld Variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e4d5",
      "d8d5",
      "b1c3",
      "d5a5",
      "d2d4",
      "g8f6",
      "g1f3",
      "c8f5",
      "f3e5",
      "c7c6",
      "g2g4"
    ]
  },
  {
    "eco": "B01",
    "name": "Scandinavian defense, Lasker Variation",
    "moves": [
      "e2e4",
      "d7d5",
      "e4d5",
      "d8d5",
      "b1c3",
      "d5a5",
      "d2d4",
      "g8f6",
      "g1f3",
      "c8g4",
      "h2h3"
    ]
  },
  {
  "name": "Intercontinental Ballistic Missile Variation",
  "eco": "B01",
  "moves": [
    "e2e4","d7d5",
    "g1f3","d5e4",
    "f3g5","g8f6",
    "d2d3","e4d3",
    "f1d3","h7h6",
    "g5f7","e8f7",
    "d3g6","f7g6",
    "d1d8"
  ],
  "normalized": "intercontinental ballistic missile variation",
  "loose": "intercontinental ballistic missile variation"
},
  {
    "eco": "B02",
    "name": "Alekhine's defence",
    "moves": [
      "e2e4",
      "b1f6"
    ]
  },
  {
  "eco": "B02",
  "name": "Alekhine's Defense",
  "moves": ["e2e4","g8f6"]
},
  {
    "eco": "B02",
    "name": "Alekhine's defense, Brooklyn defense",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6g8"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Kmoch Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "f1c4",
      "d5b6",
      "c4b3",
      "c7c5",
      "d2d3"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Krejcik Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "f1c4"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Maroczy Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "d2d3"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Mokele Mbembe (Buecker) Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6e4"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Saemisch attack",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "b1c3"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Scandinavian Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "b1c3",
      "d7d5"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Spielmann Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "b1c3",
      "d7d5",
      "e4e5",
      "f6d7",
      "e5e6"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Steiner Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "c2c4",
      "d5b6",
      "b2b3"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Two pawns' (Lasker's) attack",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "c2c4",
      "d5b6",
      "c4c5"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Two pawns' attack, Mikenas Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "c2c4",
      "d5b6",
      "c4c5",
      "b6d5",
      "f1c4",
      "e7e6",
      "b1c3",
      "d7d6"
    ]
  },
  {
    "eco": "B02",
    "name": "Alekhine's defense, Welling Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "b2b3"
    ]
  },
  {
  "eco": "B03",
  "name": "Alekhine's Defense",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4"]
},
  {
    "eco": "B03",
    "name": "Alekhine's defense, Balogh Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "f1c4"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Exchange Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "e5d6"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Exchange, Karpov Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "e5d6",
      "c7d6",
      "g1f3",
      "g7g6",
      "f1e2",
      "f8g7",
      "e1g1",
      "e8g8",
      "h2h3",
      "b8c6",
      "b1c3",
      "c8f5",
      "c1f4"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, 6...Nc6",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "d6e5",
      "f4e5",
      "b8c6"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, 7.Be3",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "d6e5",
      "f4e5",
      "b8c6",
      "c1e3"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Fianchetto Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "g7g6"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Ilyin-Genevsky var.",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "d6e5",
      "f4e5",
      "b8c6",
      "g1f3",
      "c8g4",
      "e5e6",
      "f7e6",
      "c4c5"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Korchnoi Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "d6e5",
      "f4e5",
      "c8f5",
      "b1c3",
      "e7e6",
      "g1f3",
      "f8e7",
      "f1e2",
      "e8g8",
      "e1g1",
      "f7f6"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Planinc Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "g7g5"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Tartakower Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "d6e5",
      "f4e5",
      "b8c6",
      "c1e3",
      "c8f5",
      "b1c3",
      "e7e6",
      "g1f3",
      "d8d7",
      "f1e2",
      "e8c8",
      "e1g1",
      "f8e7"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, Four pawns attack, Trifunovic Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "c2c4",
      "d5b6",
      "f2f4",
      "c8f5"
    ]
  },
  {
    "eco": "B03",
    "name": "Alekhine's defense, O'Sullivan gambit",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "b7b5"
    ]
  },
  {
  "eco": "B04",
  "name": "Alekhine's Defense, Modern",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4","d7d6","g1f3"]
},
  {
    "eco": "B04",
    "name": "Alekhine's defense, Modern Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3"
    ]
  },
  {
    "eco": "B04",
    "name": "Alekhine's defense, Modern, Fianchetto Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "g7g6"
    ]
  },
  {
    "eco": "B04",
    "name": "Alekhine's defense, Modern, Keres Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "g7g6",
      "f1c4",
      "d5b6",
      "c4b3",
      "f8g7",
      "a2a4"
    ]
  },
  {
    "eco": "B04",
    "name": "Alekhine's defense, Modern, Larsen Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "d6e5"
    ]
  },
  {
    "eco": "B04",
    "name": "Alekhine's defense, Modern, Schmid Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "d5b6"
    ]
  },
  {
  "eco": "B05",
  "name": "Alekhine's Defense, Modern",
  "moves": ["e2e4","g8f6","e4e5","f6d5","d2d4","d7d6","g1f3","c8g4"]
},
  {
    "eco": "B05",
    "name": "Alekhine's defense, Modern Variation , 4...Bg4",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4"
    ]
  },
  {
    "eco": "B05",
    "name": "Alekhine's defense, Modern, Alekhine Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4",
      "c2c4"
    ]
  },
  {
    "eco": "B05",
    "name": "Alekhine's defense, Modern, Flohr Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4",
      "f1e2",
      "c7c6"
    ]
  },
  {
    "eco": "B05",
    "name": "Alekhine's defense, Modern, Panov Variation",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4",
      "h2h3"
    ]
  },
  {
    "eco": "B05",
    "name": "Alekhine's defense, Modern, Vitolins attack",
    "moves": [
      "e2e4",
      "g8f6",
      "e4e5",
      "f6d5",
      "d2d4",
      "d7d6",
      "g1f3",
      "c8g4",
      "c2c4",
      "d5b6",
      "d4d5"
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
  "eco": "B06",
  "name": "Robatsch",
  "moves": ["e2e4","g7g6"]
},
  {
    "eco": "B06",
    "name": "Norwegian defense",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "g8f6",
      "e4e5",
      "f6h5",
      "g2g4",
      "h5g7"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch (Modern) defense",
    "moves": [
      "e2e4",
      "g7g6"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "b1c3"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense, Gurgenidze Variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "b1c3",
      "c7c6",
      "f2f4",
      "d7d5",
      "e4e5",
      "h7h5"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense, Pseudo-Austrian attack",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "b1c3",
      "d7d6",
      "f2f4"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense, Three pawns attack",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "f2f4"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense, Two knights Variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "b1c3",
      "d7d6",
      "g1f3"
    ]
  },
  {
    "eco": "B06",
    "name": "Robatsch defense, Two knights, Suttles Variation",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "b1c3",
      "d7d6",
      "g1f3",
      "c7c6"
    ]
  },
  {
  "eco": "B06",
  "name": "Robatsch defence: 4.Bc4",
  "moves": [
    "e2e4","g7g6","d2d4","f8g7","b1c3","d7d6","f1c4"
  ]
},
  {
  "eco": "B06",
  "name": "Robatsch defence: 4.Be2",
  "moves": [
    "e2e4","g7g6","d2d4","f8g7","b1c3","d7d6","f1e2"
  ]
},
  {
  "eco": "B06",
  "name": "Robatsch defence: 4.c4",
  "moves": [
    "e2e4","g7g6","d2d4","f8g7","c2c4"
  ]
},
  {
  "eco": "B06",
  "name": "Robatsch defence: Root variation",
  "moves": [
    "e2e4","g7g6","d2d4","f8g7","c1e3","d7d6","b1c3","a7a6"
  ]
},
  {
  "eco": "B06",
  "name": "Robatsch: Gurgenidze (Bc4)",
  "moves": [
    "e2e4","g7g6","d2d4","f8g7","f1c4","d7d6","c2c3"
  ]
},
{
  "name": "Pirc Defense: Hromadka System",
  "eco": "B07",
  "moves": ["d2d4","d7d6","e2e4","g8f6","b1c3","c7c6"],
  "normalized": "pirc defense hromadka system",
  "loose": "hromadka system"
},
{
  "name": "Pirc Defense: Hromadka System",
  "eco": "B07",
  "moves": ["d2d4","d7d6","e2e4","g8f6","b1c3","c7c6"],
  "normalized": "pirc defense hromadka system",
  "loose": "hromadka system"
},
  {
    "eco": "B07",
    "name": "Pirc defence",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "b1f6",
      "g1c3"
    ]
  },
  {
  "eco": "B07",
  "name": "Pirc",
  "moves": ["e2e4","d7d6","d2d4","g8f6"]
},
  {
    "eco": "B07",
    "name": "Pirc defense",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, 150 attack",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "c7c6",
      "d1d2"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, bayonet (Mariotti) attack",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f1e2",
      "f8g7",
      "h2h4"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, Byrne Variation",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1g5"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, Chinese Variation",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f1e2",
      "f8g7",
      "g2g4"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, Holmov system",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f1c4"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, Sveshnikov system",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "g2g3"
    ]
  },
  {
    "eco": "B07",
    "name": "Pirc, Ufimtsev-Pytel Variation",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "c7c6"
    ]
  },
  {
    "eco": "B07",
    "name": "Robatsch defense, Geller's system",
    "moves": [
      "e2e4",
      "g7g6",
      "d2d4",
      "f8g7",
      "g1f3",
      "d7d6",
      "c2c3"
    ]
  },
  {
  "eco": "B07",
  "name": "Pirc-Robatsch",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch (4.Be3 b6)",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","b7b6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch (4.Be3 Nd7)",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","b8d7"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch (4.Be3 Nh6)",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","g8h6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch (Bg5)",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","f1g5"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch: 4.Be3 a6",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","a7a6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch: 4.Be3 c6",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","c7c6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch: 4.Be3 e5",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","e7e5"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch: 4.Be3 Nf6",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","g8f6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc-Robatsch: 4.Be3 Nf6",
  "moves": [
    "e2e4","d7d6","d2d4","g7g6","c1e3","g8f6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc: 150 attack (4...Bg7)",
  "moves": [
    "e2e4","d7d6","d2d4","g8f6","b1c3","g7g6","c1e3","f8g7"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc: 3.Bd3",
  "moves": [
    "e2e4","d7d6","d2d4","g8f6","f1d3"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc: 3.Nc3 c6",
  "moves": [
    "e2e4","d7d6","d2d4","g8f6","b1c3","c7c6"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc: step variation",
  "moves": [
    "e2e4","d7d6","d2d4","g8f6","b1c3","c7c6","a2a4"
  ]
},
  {
  "eco": "B07",
  "name": "Pirc: Ufimtsev–Pytel variation (Pribyl defence)",
  "moves": [
    "e2e4","d7d6","d2d4","g8f6","b1c3","c7c6","f1d3","g7g6","c1g5"
  ]
},
  {
  "eco": "B08",
  "name": "Pirc, Classical",
  "moves": ["e2e4","d7d6","d2d4","g8f6","b1c3","g7g6","g1f3"]
},
  {
    "eco": "B08",
    "name": "Pirc, Classical (Two knights) system",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "g1f3"
    ]
  },
  {
    "eco": "B08",
    "name": "Pirc, Classical system, 5.Be2",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1e2"
    ]
  },
  {
    "eco": "B08",
    "name": "Pirc, Classical, h3 system",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "g1f3",
      "f8g7",
      "h2h3"
    ]
  },
  {
  "eco": "B09",
  "name": "Pirc, Austrian Attack",
  "moves": ["e2e4","d7d6","d2d4","g8f6","b1c3","g7g6","f2f4"]
},
  {
    "eco": "B09",
    "name": "Pirc, Austrian attack, 6.Bd3",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "f8g7",
      "g1f3",
      "e8g8",
      "f1d3"
    ]
  },
  {
    "eco": "B09",
    "name": "Pirc, Austrian attack, 6.Be3",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "f8g7",
      "g1f3",
      "e8g8",
      "c1e3"
    ]
  },
  {
    "eco": "B09",
    "name": "Pirc, Austrian attack, 6.e5",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "f8g7",
      "g1f3",
      "e8g8",
      "e4e5"
    ]
  },
  {
    "eco": "B09",
    "name": "Pirc, Austrian attack, Dragon formation",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "f8g7",
      "g1f3",
      "c7c5"
    ]
  },
  {
    "eco": "B09",
    "name": "Pirc, Austrian attack, Ljubojevic Variation",
    "moves": [
      "e2e4",
      "d7d6",
      "d2d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "f8g7",
      "f1c4"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann defence",
    "moves": [
      "e2e4",
      "c7c6"
    ]
  },
  {
  "eco": "B10",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6"]
},
  {
    "eco": "B10",
    "name": "Caro-Kann defense",
    "moves": [
      "e2e4",
      "c7c6"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, Anti-anti-Caro-Kann defense",
    "moves": [
      "e2e4",
      "c7c6",
      "c2c4",
      "d7d5"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, Anti-Caro-Kann defense",
    "moves": [
      "e2e4",
      "c7c6",
      "c2c4"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, Closed (Breyer) Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d3"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, GOldman (Spielmann) Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "b1c3",
      "d7d5",
      "d1f3"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, Hillbilly attack",
    "moves": [
      "e2e4",
      "c7c6",
      "f1c4"
    ]
  },
  {
    "eco": "B10",
    "name": "Caro-Kann, Two knights Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "b1c3",
      "d7d5",
      "g1f3"
    ]
  },
  {
  "eco": "B10",
  "name": "Caro-Kann-Robatsch",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","b1c3","g7g6"
  ]
},
  {
  "eco": "B10",
  "name": "Caro-Kann: 3.e5 c5",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4e5","c6c5"
  ]
},
  {
  "eco": "B10",
  "name": "Caro-Kann: anti-anti-Caro-Kann, Neo-Nimzo-Gligoric",
  "moves": [
    "e2e4","c7c6","g1f3","d7d5","b1c3"
  ]
},
  {
  "eco": "B11",
  "name": "Caro-Kann, Two Knights",
  "moves": ["e2e4","c7c6","b1c3","d7d5","g1f3","c8g4"]
},
  {
    "eco": "B11",
    "name": "Caro-Kann, Two knights, 3...Bg4",
    "moves": [
      "e2e4",
      "c7c6",
      "b1c3",
      "d7d5",
      "g1f3",
      "c8g4"
    ]
  },
  {
  "eco": "B12",
  "name": "Caro-Kann Defense",
  "moves": ["e2e4","c7c6","d2d4"]
},
  {
    "eco": "B12",
    "name": "Caro-Kann, 3.Nd2",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1d2"
    ]
  },
  {
    "eco": "B12",
    "name": "Caro-Kann, Advance Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4e5"
    ]
  },
  {
    "eco": "B12",
    "name": "Caro-Kann, Advance, Short Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c8f5",
      "c2c3",
      "e7e6",
      "f1e2"
    ]
  },
  {
    "eco": "B12",
    "name": "Caro-Kann, Edinburgh Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1d2",
      "d8b6"
    ]
  },
  {
    "eco": "B12",
    "name": "Caro-Kann, Tartakower (fantasy) Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "f2f3"
    ]
  },
  {
    "eco": "B12",
    "name": "Caro-Masi defense",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "g8f6"
    ]
  },
  {
    "eco": "B12",
    "name": "de Bruycker defense",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "b8a6",
      "b1c3",
      "a6c7"
    ]
  },
  {
  "eco": "B12",
  "name": "Caro-Kann: advance (Karpov, Seirawan)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4e5","c8f5","g1f3","e7e6"
  ]
},
  {
  "eco": "B12",
  "name": "Caro-Kann: advance, main line",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4e5","c8f5","g1f3","e7e6","c2c3"
  ]
},
  {
  "eco": "B12",
  "name": "Caro-Kann: Gurgenidze (e5 f4)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4e5","c8f5","f2f4"
  ]
},
  {
  "eco": "B12",
  "name": "Caro-Kann: Gurgenidze (f4 e5)",
  "moves": [
    "e2e4","c7c6","f2f4","d7d5","e4e5"
  ]
},
  {
  "eco": "B13",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6","d2d4","d7d5","e4d5"]
},
  {
    "eco": "B13",
    "name": "Caro-Kann, Exchange Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Exchange, Rubinstein Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "f1d3",
      "b8c6",
      "c2c3",
      "g8f6",
      "c1f4"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik attack",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik, Czerniak Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "d8a5"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik, Gunderam attack",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "c4c5"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik, Herzog defense",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "d5c4",
      "d4d5",
      "c6a5"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik, normal Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6"
    ]
  },
  {
    "eco": "B13",
    "name": "Caro-Kann, Panov-Botvinnik, Reifir (Spielmann) Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "d8b6"
    ]
  },
  {
  "eco": "B13",
  "name": "Caro-Kann: Panov-Botvinnik attack (6.Nf3 Bb4)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4d5","c6d5","c2c4","g8f6","b1c3","e7e6","g1f3","f8b4"
  ]
},
  {
  "eco": "B13",
  "name": "Caro-Kann: Panov-Botvinnik attack (6.Nf3 Be7)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4d5","c6d5","c2c4","g8f6","b1c3","e7e6","g1f3","f8e7"
  ]
},
  {
  "eco": "B13",
  "name": "Caro-Kann: Panov-Botvinnik attack (7.Bd3)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","e4d5","c6d5","c2c4","g8f6","b1c3","e7e6","g1f3","f8e7","c1d3"
  ]
},
  {
  "eco": "B14",
  "name": "Caro-Kann, Panov-Botvinnik Attack",
  "moves": ["e2e4","c7c6","d2d4","d7d5","e4d5","c6d5","c2c4","g8f6","b1c3"]
},
  {
    "eco": "B14",
    "name": "Caro-Kann, Panov-Botvinnik attack, 5...e6",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "e7e6"
    ]
  },
  {
    "eco": "B14",
    "name": "Caro-Kann, Panov-Botvinnik attack, 5...g6",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c2c4",
      "g8f6",
      "b1c3",
      "g7g6"
    ]
  },
  {
  "eco": "B15",
  "name": "Caro-Kann",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3"]
},
  {
    "eco": "B15",
    "name": "Caro-Kann defense",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Alekhine gambit",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "g8f6",
      "f1d3"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Forgacs Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "g8f6",
      "e4f6",
      "e7f6",
      "f1c4"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Gurgenidze counter-attack",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "b7b5"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Gurgenidze system",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g7g6"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Rasa-Studier gambit",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "f2f3"
    ]
  },
  {
    "eco": "B15",
    "name": "Caro-Kann, Tartakower (Nimzovich) Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "g8f6",
      "e4f6",
      "e7f6"
    ]
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
  "eco": "B17",
  "name": "Caro-Kann: Steinitz variation (8.Bd3)",
  "moves": [
    "e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5","f1d3"
  ]
},
  {
  "eco": "B18",
  "name": "Caro-Kann, Classical",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5"]
},
  {
    "eco": "B18",
    "name": "Caro-Kann, Classical Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5"
    ]
  },
  {
    "eco": "B18",
    "name": "Caro-Kann, Classical, 6.h4",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5",
      "e4g3",
      "f5g6",
      "h2h4"
    ]
  },
  {
    "eco": "B18",
    "name": "Caro-Kann, Classical, Flohr Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5",
      "e4g3",
      "f5g6",
      "g1h3"
    ]
  },
  {
    "eco": "B18",
    "name": "Caro-Kann, Classical, Maroczy attack",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5",
      "e4g3",
      "f5g6",
      "f2f4"
    ]
  },
  {
  "eco": "B19",
  "name": "Caro-Kann, Classical",
  "moves": ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5","e4g3","f5g6","h2h4","h7h6","g1f3","b8d7"]
},
  {
    "eco": "B19",
    "name": "Caro-Kann, Classical, 7...Nd7",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5",
      "e4g3",
      "f5g6",
      "h2h4",
      "h7h6",
      "g1f3",
      "b8d7"
    ]
  },
  {
    "eco": "B19",
    "name": "Caro-Kann, Classical, Spassky Variation",
    "moves": [
      "e2e4",
      "c7c6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8f5",
      "e4g3",
      "f5g6",
      "h2h4",
      "h7h6",
      "g1f3",
      "b8d7",
      "h4h5"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian defence",
    "moves": [
      "e2e4",
      "c7c5"
    ]
  },
  {
  "eco": "B20",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5"]
},
  {
    "eco": "B20",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, Gloria Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "c2c4",
      "d7d6",
      "b1c3",
      "b8c6",
      "g2g3",
      "h7h5"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, Keres Variation (2.Ne2)",
    "moves": [
      "e2e4",
      "c7c5",
      "g1e2"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, Steinitz Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g2g3"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, wing gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "b2b4"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, wing gambit, Carlsbad Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b2b4",
      "c5b4",
      "a2a3",
      "b4a3"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, wing gambit, Marienbad Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b2b4",
      "c5b4",
      "a2a3",
      "d7d5",
      "e4d5",
      "d8d5",
      "c1b2"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, wing gambit, Marshall Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b2b4",
      "c5b4",
      "a2a3"
    ]
  },
  {
    "eco": "B20",
    "name": "Sicilian, wing gambit, Santasiere Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b2b4",
      "c5b4",
      "c2c4"
    ]
  },
  {
  "eco": "B20",
  "name": "Sicilian-KIA",
  "moves": [
    "e2e4","c7c5","g1f3","e7e6","d2d3","b8c6","g2g3","f8e7","f1g2"
  ]
},
  {
  "eco": "B20",
  "name": "Sicilian-KIA",
  "moves": [
    "e2e4","c7c5","g1f3","e7e6","d2d3","b8c6","g2g3","f8e7","f1g2"
  ]
},
  {
  "eco": "B20",
  "name": "Sicilian: 3.d3",
  "moves": [
    "e2e4","c7c5","d2d3"
  ]
},
  {
  "eco": "B20",
  "name": "Sicilian: 3.g3",
  "moves": [
    "e2e4","c7c5","g2g3"
  ]
},
  {
  "eco": "B20",
  "name": "Sicilian: Burger attack",
  "moves": [
    "e2e4","c7c5","f2f4"
  ]
},
  {
  "eco": "B20",
  "name": "Sicilian: Burger attack",
  "moves": [
    "e2e4","c7c5","f2f4"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","f2f4"]
},
  {
    "eco": "B21",
    "name": "Sicilian, Andreaschek gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "d2d4",
      "c5d4",
      "g1f3",
      "e7e5",
      "c2c3"
    ]
  },
  {
    "eco": "B21",
    "name": "Sicilian, Grand Prix attack",
    "moves": [
      "e2e4",
      "c7c5",
      "f2f4"
    ]
  },
  {
    "eco": "B21",
    "name": "Sicilian, Smith-Morra gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "d2d4"
    ]
  },
  {
    "eco": "B21",
    "name": "Sicilian, Smith-Morra gambit, Chicago defense",
    "moves": [
      "e2e4",
      "c7c5",
      "d2d4",
      "c5d4",
      "c2c3",
      "d4c3",
      "b1c3",
      "b8c6",
      "g1f3",
      "d7d6",
      "f1c4",
      "e7e6",
      "e1g1",
      "a7a6",
      "d1e2",
      "b7b5",
      "c4b3",
      "a8a7"
    ]
  },
  {
  "eco": "B21",
  "name": "Sicilian-Alekhine-Alapin (Smith-Morra)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3","d4c3","b2c3","g8f6"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian-Alekhine-Alapin (Smith-Morra)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3","d4c3","b2c3","g8f6"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian: Alapin's variation (Smith-Morra gambit)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3","d4c3","b2c3"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian: Andreaschek (Smith-Morra) gambit",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3","d4c3","b2c3","d7d5"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian: Alapin's variation (Smith–Morra gambit)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3"
  ]
},
  {
  "eco": "B21",
  "name": "Sicilian: Andreaschek (Smith–Morra) gambit",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c3c3","d4c3","b2c3","d7d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian, Alapin",
  "moves": ["e2e4","c7c5","c2c3"]
},
  {
    "eco": "B22",
    "name": "Sicilian, 2.c3, Heidenfeld Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "c2c3",
      "g8f6",
      "e4e5",
      "f6d5",
      "g1f3",
      "b8c6",
      "b1a3"
    ]
  },
  {
    "eco": "B22",
    "name": "Sicilian, Alapin's Variation (2.c3)",
    "moves": [
      "e2e4",
      "c7c5",
      "c2c3"
    ]
  },
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...d5 exd5...exd5)",
  "moves": [
    "e2e4","c7c5","c2c3","d7d5","e4d5","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...d5 exd5...Qxd5)",
  "moves": [
    "e2e4","c7c5","c2c3","d7d5","e4d5","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...Qxd5 without...Nf6)",
  "moves": [
    "e2e4","c7c5","c2c3","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin-French (c3/e5...d4)",
  "moves": [
    "e2e4","c7c5","c2c3","e7e5","d2d4"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin's variation (3.c3)",
  "moves": [
    "e2e4","c7c5","c2c3"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin's variation (Smith-Morra declined)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c2c3"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...d5 exd5...exd5)",
  "moves": [
    "e2e4","c7c5","c2c3","d7d5","e4d5","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...d5 exd5...Qxd5)",
  "moves": [
    "e2e4","c7c5","c2c3","d7d5","e4d5","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin (...Qxd5 without ...Nf6)",
  "moves": [
    "e2e4","c7c5","c2c3","d8d5"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin–French (c3/e5...d4)",
  "moves": [
    "e2e4","c7c5","c2c3","e7e5","d2d4"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin's variation (3.c3)",
  "moves": [
    "e2e4","c7c5","c2c3"
  ]
},
  {
  "eco": "B22",
  "name": "Sicilian: Alapin's variation (Smith–Morra declined)",
  "moves": [
    "e2e4","c7c5","d2d4","c5d4","c3c3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3"]
},
  {
    "eco": "B23",
    "name": "Sicilian, chameleon Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g1e2"
    ]
  },
  {
    "eco": "B23",
    "name": "Sicilian, Closed, 2...Nc6",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6"
    ]
  },
  {
    "eco": "B23",
    "name": "Sicilian, Closed, Korchnoi Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "e7e6",
      "g2g3",
      "d7d5"
    ]
  },
  {
    "eco": "B23",
    "name": "Sicilian, Grand Prix attack",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "f2f4"
    ]
  },
  {
    "eco": "B23",
    "name": "Sicilian, Grand Prix attack, Schofman Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "f2f4",
      "g7g6",
      "g1f3",
      "f8g7",
      "f1c4",
      "e7e6",
      "f4f5"
    ]
  },
  {
  "eco": "B23",
  "name": "Sicilian: closed (with g3)",
  "moves": [
    "e2e4","c7c5","g2g3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & f4)",
  "moves": [
    "e2e4","c7c5","b1c3","f2f4"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & Bg2)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f1g2"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3 & c3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3","c2c3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3 & c3 & Qf2)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3","c2c3","d2f2"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3 & c3 & Qf2 & Qg3)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3","c2c3","d2f2","f2g3"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3 & c3 & Qf2 & Qg3 & h4)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3","c2c3","d2f2","f2g3","h3h4"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: closed (with Nc3 & g3 & f4 & Bg2 & Nf3 & O-O & d3 & h3 & Be3 & Qd2 & g4 & f5 & Rae1 & Nd1 & Ne3 & c3 & Qf2 & Qg3 & h4 & g5)",
  "moves": [
    "e2e4","c7c5","b1c3","g2g3","f2f4","f1g2","g1f3","e1g1","d2d3","h2h3","c1e3","d1d2","g3g4","f4f5","a1e1","c3d1","d1e3","c2c3","d2f2","f2g3","h3h4","g4g5"
  ]
},
  {
  "eco": "B23",
  "name": "Sicilian: Kopec system",
  "moves": [
    "e2e4","c7c5","b1c3","d7d6","g2g3"
  ]
},
  {
  "eco": "B24",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3"]
},
  {
    "eco": "B24",
    "name": "Sicilian, Closed, Smyslov Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "e7e6",
      "c1e3",
      "c6d4",
      "c3e2"
    ]
  },
  {
  "eco": "B25",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6"]
},
  {
    "eco": "B25",
    "name": "Sicilian, Closed, 6.f4",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6",
      "f2f4"
    ]
  },
  {
    "eco": "B25",
    "name": "Sicilian, Closed, 6.f4 e5 (Botvinnik)",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6",
      "f2f4",
      "e7e5"
    ]
  },
  {
    "eco": "B25",
    "name": "Sicilian, Closed, 6.Ne2 e5 (Botvinnik)",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6",
      "g1e2",
      "e7e5"
    ]
  },
  {
  "eco": "B26",
  "name": "Sicilian, Closed",
  "moves": ["e2e4","c7c5","b1c3","b8c6","g2g3","g7g6","f1g2","f8g7","d2d3","d7d6","c1e3"]
},
  {
    "eco": "B26",
    "name": "Sicilian, Closed, 6.Be3",
    "moves": [
      "e2e4",
      "c7c5",
      "b1c3",
      "b8c6",
      "g2g3",
      "g7g6",
      "f1g2",
      "f8g7",
      "d2d3",
      "d7d6",
      "c1e3"
    ]
  },
  {
  "eco": "B27",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3"]
},
  {
    "eco": "B27",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3"
    ]
  },
  {
    "eco": "B27",
    "name": "Sicilian, Acton extension",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "g7g6",
      "c2c4",
      "f8h6"
    ]
  },
  {
    "eco": "B27",
    "name": "Sicilian, Hungarian Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "g7g6"
    ]
  },
  {
    "eco": "B27",
    "name": "Sicilian, Katalimov Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b7b6"
    ]
  },
  {
    "eco": "B27",
    "name": "Sicilian, Quinteros Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d8c7"
    ]
  },
  {
    "eco": "B27",
    "name": "Sicilian, Stiletto (Althouse) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d8a5"
    ]
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
    "eco": "B29",
    "name": "Sicilian, Nimzovich-Rubinstein Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "g8f6"
    ]
  },
  {
    "eco": "B29",
    "name": "Sicilian, Nimzovich-Rubinstein; Rubinstein counter-gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "g8f6",
      "e4e5",
      "f6d5",
      "b1c3",
      "e7e6",
      "c3d5",
      "e6d5",
      "d2d4",
      "b8c6"
    ]
  },
  {
  "eco": "B30",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6"]
},
  {
    "eco": "B30",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6"
    ]
  },
  {
    "eco": "B30",
    "name": "Sicilian, Nimzovich-Rossolimo attack (without ...d6)",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "f1b5"
    ]
  },
  {
  "eco": "B30",
  "name": "Sicilian: Nimzovich–Rossolimo attack (3...d6)",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","f1b5","d7d6"
  ]
},
  {
  "eco": "B30",
  "name": "Sicilian: Nimzovich–Rossolimo attack, Zagrebelny variation",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","f1b5","g7g6","c2c3","a7a6"
  ]
},
  {
  "eco": "B31",
  "name": "Sicilian, Nimzovich-Rossolimo Attack",
  "moves": ["e2e4","c7c5","g1f3","b8c6","f1b5","g7g6"]
},
  {
    "eco": "B31",
    "name": "Sicilian, Nimzovich-Rossolimo attack (with ...g6, without ...d6)",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g7g6"
    ]
  },
  {
    "eco": "B31",
    "name": "Sicilian, Nimzovich-Rossolimo attack, Gurgenidze Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g7g6",
      "e1g1",
      "f8g7",
      "f1e1",
      "e7e5",
      "b2b4"
    ]
  },
  {
  "eco": "B32",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","e7e5"]
},
  {
    "eco": "B32",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4"
    ]
  },
  {
    "eco": "B32",
    "name": "Sicilian, Flohr Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "d8c7"
    ]
  },
  {
    "eco": "B32",
    "name": "Sicilian, Labourdonnais-Loewenthal (Kalashnikov) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "e7e5",
      "d4b5",
      "d7d6"
    ]
  },
  {
    "eco": "B32",
    "name": "Sicilian, Labourdonnais-Loewenthal Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "e7e5"
    ]
  },
  {
    "eco": "B32",
    "name": "Sicilian, Nimzovich Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "d7d5"
    ]
  },
  {
  "eco": "B32",
  "name": "Sicilian: Kalishnikov, Neo‑Sveshnikov variation",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","e7e5"
  ]
},
  {
  "eco": "B32",
  "name": "Sicilian: Labourdonnais–Loewenthal (Kalishnikov) variation",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","e7e5","d4b5"
  ]
},
  {
  "eco": "B33",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g8f6"]
},
  {
    "eco": "B33",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6"
    ]
  },
  {
    "eco": "B33",
    "name": "Sicilian, Pelikan (Lasker/Sveshnikov) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e5"
    ]
  },
  {
    "eco": "B33",
    "name": "Sicilian, Pelikan, Bird Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e5",
      "d4b5",
      "d7d6",
      "c1g5",
      "a7a6",
      "b5a3",
      "c8e6"
    ]
  },
  {
    "eco": "B33",
    "name": "Sicilian, Pelikan, Chelyabinsk Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e5",
      "d4b5",
      "d7d6",
      "c1g5",
      "a7a6",
      "b5a3",
      "b7b5"
    ]
  },
  {
    "eco": "B33",
    "name": "Sicilian, Sveshnikov Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e5",
      "d4b5",
      "d7d6",
      "c1g5",
      "a7a6",
      "b5a3",
      "b7b5",
      "g5f6",
      "g7f6",
      "c3d5",
      "f6f5"
    ]
  },
  {
  "eco": "B33",
  "name": "Sicilian: Sveshnikov (5...e6)",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6"
  ]
},
  {
  "eco": "B33",
  "name": "Sicilian: Sveshnikov (a4)",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e5","d4b5","a7a6","b5a3","b7b5","a2a4"
  ]
},
  {
  "eco": "B33",
  "name": "Sicilian: Sveshnikov, Kramnik (12...e4)",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e5","d4b5","d7d6","c1g5","a7a6","b5a3","b7b5","g5f6","g7f6","c3d5","e6e4"
  ]
},
  {
  "eco": "B34",
  "name": "Sicilian, Accelerated Fianchetto",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","d4c6"]
},
  {
    "eco": "B34",
    "name": "Sicilian, Accelerated Fianchetto, Exchange Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "d4c6"
    ]
  },
  {
    "eco": "B34",
    "name": "Sicilian, Accelerated Fianchetto, Modern Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "b1c3"
    ]
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
    "eco": "B36",
    "name": "Sicilian, Accelerated Fianchetto, Gurgenidze Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "c2c4",
      "g8f6",
      "b1c3",
      "c6d4",
      "d1d4",
      "d7d6"
    ]
  },
  {
    "eco": "B36",
    "name": "Sicilian, Accelerated Fianchetto, Maroczy bind",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "c2c4"
    ]
  },
  {
  "eco": "B37",
  "name": "Sicilian, Accelerated Fianchetto",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4","f8g7"]
},
  {
    "eco": "B37",
    "name": "Sicilian, Accelerated Fianchetto, Maroczy bind, 5...Bg7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "c2c4",
      "f8g7"
    ]
  },
  {
    "eco": "B37",
    "name": "Sicilian, Accelerated Fianchetto, Simagin Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "c2c4",
      "f8g7",
      "d4c2",
      "d7d6",
      "f1e2",
      "g8h6"
    ]
  },
  {
  "eco": "B38",
  "name": "Sicilian, Accelerated Fianchetto, Maroczy Bind",
  "moves": ["e2e4","c7c5","g1f3","b8c6","d2d4","c5d4","f3d4","g7g6","c2c4","f8g7","c1e3"]
},
  {
    "eco": "B38",
    "name": "Sicilian, Accelerated Fianchetto, Maroczy bind, 6.Be3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g7g6",
      "c2c4",
      "f8g7",
      "c1e3"
    ]
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
    "eco": "B40",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6"
    ]
  },
  {
    "eco": "B40",
    "name": "Sicilian, Anderssen Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6"
    ]
  },
  {
    "eco": "B40",
    "name": "Sicilian, Marshall Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "d7d5"
    ]
  },
  {
    "eco": "B40",
    "name": "Sicilian, Pin Variation (Sicilian counter-attack)",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "f8b4"
    ]
  },
  {
    "eco": "B40",
    "name": "Sicilian, Pin, Jaffe Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "f8b4",
      "f1d3",
      "e6e5"
    ]
  },
  {
    "eco": "B40",
    "name": "Sicilian, Pin, Koch Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "f8b4",
      "e4e5"
    ]
  },
  {
  "eco": "B40",
  "name": "Sicilian: Flohr (Lady Godiva) variation",
  "moves": [
    "e2e4","c7c5","c2c3","d7d5","e4d5","d8d5","d2d4","g8f6","g1f3"
  ]
},
  {
  "eco": "B41",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6"]
},
  {
    "eco": "B41",
    "name": "Sicilian, Kan Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6"
    ]
  },
  {
    "eco": "B41",
    "name": "Sicilian, Kan, Maroczy bind - Bronstein Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "c2c4",
      "g8f6",
      "b1c3",
      "f8b4",
      "f1d3",
      "b8c6",
      "d3c2"
    ]
  },
  {
    "eco": "B41",
    "name": "Sicilian, Kan, Maroczy bind (Reti Variation )",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "c2c4"
    ]
  },
  {
  "eco": "B42",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6","f1d3"]
},
  {
    "eco": "B42",
    "name": "Sicilian, Kan, 5.Bd3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "f1d3"
    ]
  },
  {
    "eco": "B42",
    "name": "Sicilian, Kan, Gipslis Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "f1d3",
      "g8f6",
      "e1g1",
      "d7d6",
      "c2c4",
      "g7g6"
    ]
  },
  {
    "eco": "B42",
    "name": "Sicilian, Kan, Polugaievsky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "f1d3",
      "f8c5"
    ]
  },
  {
    "eco": "B42",
    "name": "Sicilian, Kan, Swiss cheese Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "f1d3",
      "g7g6"
    ]
  },
  {
  "eco": "B43",
  "name": "Sicilian, Kan",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","a7a6","b1c3"]
},
  {
    "eco": "B43",
    "name": "Sicilian, Kan, 5.Nc3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "a7a6",
      "b1c3"
    ]
  },
  {
  "eco": "B44",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6"]
},
  {
    "eco": "B44",
    "name": "Sicilian defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6"
    ]
  },
  {
    "eco": "B44",
    "name": "Sicilian, Szen (`anti-Taimanov') Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6",
      "d4b5"
    ]
  },
  {
    "eco": "B44",
    "name": "Sicilian, Szen Variation , Dely-Kasparov gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6",
      "d4b5",
      "d7d6",
      "c2c4",
      "g8f6",
      "b1c3",
      "a7a6",
      "b5a3",
      "d6d5"
    ]
  },
  {
    "eco": "B44",
    "name": "Sicilian, Szen, hedgehog Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6",
      "d4b5",
      "d7d6",
      "c2c4",
      "g8f6",
      "b1c3",
      "a7a6",
      "b5a3",
      "f8e7",
      "f1e2",
      "e8g8",
      "e1g1",
      "b7b6"
    ]
  },
  {
  "eco": "B45",
  "name": "Sicilian, Taimanov",
  "moves": ["e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3"]
},
  {
    "eco": "B45",
    "name": "Sicilian, Taimanov Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6",
      "b1c3"
    ]
  },
  {
    "eco": "B45",
    "name": "Sicilian, Taimanov, American attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "e7e6",
      "d2d4",
      "c5d4",
      "f3d4",
      "b8c6",
      "b1c3",
      "g8f6",
      "d4b5",
      "f8b4",
      "b5d6"
    ]
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
  "eco": "B48",
  "name": "Sicilian: Taimanov variation (5...d6)",
  "moves": [
    "e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","d7d6"
  ]
},
  {
  "eco": "B48",
  "name": "Sicilian: Taimanov, Flohr variation",
  "moves": [
    "e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","a7a6","c1e3","g8f6","f1e2","f8b4"
  ]
},
  {
  "eco": "B48",
  "name": "Sicilian: Taimanov, Portisch variation",
  "moves": [
    "e2e4","c7c5","g1f3","e7e6","d2d4","c5d4","f3d4","b8c6","b1c3","a7a6","c1e3","g8f6","d4c6","b7c6"
  ]
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
    "eco": "B50",
    "name": "Sicilian, wing gambit deferred",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "b2b4"
    ]
  },
  {
  "eco": "B50",
  "name": "Sicilian: 3.d3",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d3"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: 3.g3",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","g2g3"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: closed fianchetto (with d3)",
  "moves": [
    "e2e4","c7c5","g2g3","b8c6","f1g2","d7d3"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: closed, modern Botvinnik variation",
  "moves": [
    "e2e4","c7c5","g2g3","b8c6","f1g2","g7g6","d2d3","f8g7"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: double fianchetto, Reti",
  "moves": [
    "g1f3","c7c5","g2g3","b8c6","f1g2","g7g6"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: fianchetto (...e6 Nc3...a6)",
  "moves": [
    "e2e4","c7c5","g2g3","e7e6","b1c3","a7a6"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: fianchetto, Reti (...d5 Nbd2)",
  "moves": [
    "e2e4","c7c5","g2g3","d7d5","b1d2"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: fianchetto, Reti (...d5 Qe2)",
  "moves": [
    "e2e4","c7c5","g2g3","d7d5","d1e2"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: fianchetto, Reti, French",
  "moves": [
    "e2e4","c7c5","g2g3","e7e6","f1g2","d7d5"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: four knights fianchetto variation",
  "moves": [
    "e2e4","c7c5","g1f3","b8c6","b1c3","g7g6","g2g3"
  ]
},
  {
  "eco": "B50",
  "name": "Sicilian: Neo‑King's Indian attack–Reti",
  "moves": [
    "g1f3","c7c5","g2g3","b8c6","f1g2","e7e5","e1g1","d7d6"
  ]
},
  {
  "eco": "B51",
  "name": "Sicilian, Canal-Sokolsky Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","f1b5"]
},
  {
    "eco": "B51",
    "name": "Sicilian, Canal-Sokolsky (Nimzovich-Rossolimo, Moscow) attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "f1b5"
    ]
  },
  {
  "eco": "B52",
  "name": "Sicilian, Canal-Sokolsky Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","f1b5","c8d7"]
},
  {
    "eco": "B52",
    "name": "Sicilian, Canal-Sokolsky attack, 3...Bd7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "f1b5",
      "c8d7"
    ]
  },
  {
    "eco": "B52",
    "name": "Sicilian, Canal-Sokolsky attack, Bronstein gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "f1b5",
      "c8d7",
      "b5d7",
      "d8d7",
      "e1g1",
      "b8c6",
      "c2c3",
      "g8f6",
      "d2d4"
    ]
  },
  {
    "eco": "B52",
    "name": "Sicilian, Canal-Sokolsky attack, Sokolsky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "f1b5",
      "c8d7",
      "b5d7",
      "d8d7",
      "c2c4"
    ]
  },
  {
  "eco": "B53",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4"]
},
  {
    "eco": "B53",
    "name": "Sicilian, Chekhover Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "d1d4"
    ]
  },
  {
    "eco": "B53",
    "name": "Sicilian, Chekhover, Zaitsev Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "d1d4",
      "b8c6",
      "f1b5",
      "d8d7"
    ]
  },
  {
  "eco": "B54",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6"]
},
  {
    "eco": "B54",
    "name": "Sicilian, Prins (Moscow) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "f2f3"
    ]
  },
  {
  "eco": "B55",
  "name": "Sicilian, Prins Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","f1b5"]
},
  {
    "eco": "B55",
    "name": "Sicilian, Prins Variation , Venice attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "f2f3",
      "e7e5",
      "f1b5"
    ]
  },
  {
  "eco": "B56",
  "name": "Sicilian",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3"]
},
  {
    "eco": "B56",
    "name": "Sicilian, Venice attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e5",
      "f1b5"
    ]
  },
  {
  "eco": "B57",
  "name": "Sicilian, Sozin",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","c8g4"]
},
  {
    "eco": "B57",
    "name": "Sicilian, Magnus Smith trap",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "f1c4",
      "g7g6",
      "d4c6",
      "b7c6",
      "e4e5"
    ]
  },
  {
    "eco": "B57",
    "name": "Sicilian, Sozin, Benko Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "f1c4",
      "d8b6"
    ]
  },
  {
    "eco": "B57",
    "name": "Sicilian, Sozin, not Scheveningen",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "f1c4"
    ]
  },
  {
  "eco": "B58",
  "name": "Sicilian, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6"]
},
  {
    "eco": "B58",
    "name": "Sicilian, Boleslavsky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "d7d6",
      "f1e2",
      "e7e5"
    ]
  },
  {
    "eco": "B58",
    "name": "Sicilian, Boleslavsky, Louma Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "d7d6",
      "f1e2",
      "e7e5",
      "d4c6"
    ]
  },
  {
  "eco": "B59",
  "name": "Sicilian, Boleslavsky Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","f1e2","e7e5"]
},
  {
    "eco": "B59",
    "name": "Sicilian, Boleslavsky Variation , 7.Nb3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "b8c6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "d7d6",
      "f1e2",
      "e7e5",
      "d4b3"
    ]
  },
  {
  "eco": "B60",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5"]
},
  {
    "eco": "B60",
    "name": "Sicilian, Richter-Rauzer, Bondarevsky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "g7g6"
    ]
  },
  {
    "eco": "B60",
    "name": "Sicilian, Richter-Rauzer, Larsen Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "c8d7"
    ]
  },
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer (Fedorowicz)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","f2f4"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...a6 11.Bxf6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","g5f6"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...a6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...a6...Bd7) defence",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","d1d2","f8d7"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...a6...Be7) defence",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","f8e7"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...a6...h6) defence",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","h7h6"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...Be7...f4)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e7","f2f4"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (...Be7...Nxd4) defence",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e7","d4b5","f6d5"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (11.a3)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","a2a3"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (11.Bd3)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","c1d3"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (11.e5)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","e4e5"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (11.Kb1)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2","b8d7","e1c1"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack (9.Be2)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2"
  ]
},
  {
  "eco": "B60",
  "name": "Sicilian: Richter–Rauzer, Rauzer attack ...Be7 ...Nxd4 defence",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e7","d4b5","f6d5"
  ]
},
  {
  "eco": "B61",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6"]
},
  {
    "eco": "B61",
    "name": "Sicilian, Richter-Rauzer, Larsen Variation , 7.Qd2",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "c8d7",
      "d1d2"
    ]
  },
  {
  "eco": "B62",
  "name": "Sicilian, Richter-Rauzer",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2"]
},
  {
    "eco": "B62",
    "name": "Sicilian, Richter-Rauzer, 6...e6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6"
    ]
  },
  {
    "eco": "B62",
    "name": "Sicilian, Richter-Rauzer, Keres Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d3"
    ]
  },
  {
    "eco": "B62",
    "name": "Sicilian, Richter-Rauzer, Margate (Alekhine) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "f1b5"
    ]
  },
  {
    "eco": "B62",
    "name": "Sicilian, Richter-Rauzer, Podvebrady Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d4b3"
    ]
  },
  {
    "eco": "B62",
    "name": "Sicilian, Richter-Rauzer, Richter attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d4c6"
    ]
  },
  {
  "eco": "B63",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7"]
},
  {
    "eco": "B63",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...Be7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "f8e7"
    ]
  },
  {
  "eco": "B64",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1"]
},
  {
    "eco": "B64",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...Be7 defense, 9.f4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "f8e7",
      "e1c1",
      "e8g8",
      "f2f4"
    ]
  },
  {
    "eco": "B64",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, Geller Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "f8e7",
      "e1c1",
      "e8g8",
      "f2f4",
      "e6e5"
    ]
  },
  {
  "eco": "B65",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8"]
},
  {
    "eco": "B65",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...Be7 defense, 9...Nxd4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "f8e7",
      "e1c1",
      "e8g8",
      "f2f4",
      "c6d4"
    ]
  },
  {
  "eco": "B66",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2"]
},
  {
    "eco": "B66",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...a6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "a7a6"
    ]
  },
  {
  "eco": "B67",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6"]
},
  {
    "eco": "B67",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...a6 defense, 8...Bd7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "a7a6",
      "e1c1",
      "c8d7"
    ]
  },
  {
  "eco": "B68",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6","g5e3"]
},
  {
    "eco": "B68",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...a6 defense, 9...Be7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "a7a6",
      "e1c1",
      "c8d7",
      "f2f4",
      "f8e7"
    ]
  },
  {
  "eco": "B69",
  "name": "Sicilian, Richter-Rauzer, Rauzer Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","c1g5","e7e6","d1d2","f8e7","e1c1","e8g8","f1e2","h7h6","g5e3","c8d7"]
},
  {
    "eco": "B69",
    "name": "Sicilian, Richter-Rauzer, Rauzer attack, 7...a6 defense, 11.Bxf6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "b8c6",
      "c1g5",
      "e7e6",
      "d1d2",
      "a7a6",
      "e1c1",
      "c8d7",
      "f2f4",
      "f8e7",
      "d4f3",
      "b7b5",
      "g5f6"
    ]
  },
  {
  "eco": "B70",
  "name": "Sicilian, Dragon",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6"]
},
  {
    "eco": "B70",
    "name": "Sicilian, Dragon Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6"
    ]
  },
  {
  "eco": "B71",
  "name": "Sicilian, Dragon, Levenfish Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f2f4"]
},
  {
    "eco": "B71",
    "name": "Sicilian, Dragon, Levenfish Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4"
    ]
  },
  {
    "eco": "B71",
    "name": "Sicilian, Dragon, Levenfish; Flohr Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "f2f4",
      "b8d7"
    ]
  },
  {
  "eco": "B72",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2"]
},
  {
    "eco": "B72",
    "name": "Sicilian, Dragon, 6.Be3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3"
    ]
  },
  {
    "eco": "B72",
    "name": "Sicilian, Dragon, Classical attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2"
    ]
  },
  {
    "eco": "B72",
    "name": "Sicilian, Dragon, Classical, Amsterdam Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "d1d2"
    ]
  },
  {
    "eco": "B72",
    "name": "Sicilian, Dragon, Classical, Grigoriev Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "d1d2",
      "e8g8",
      "e1c1"
    ]
  },
  {
    "eco": "B72",
    "name": "Sicilian, Dragon, Classical, Nottingham Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "d4b3"
    ]
  },
  {
  "eco": "B73",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2","f8g7"]
},
  {
    "eco": "B73",
    "name": "Sicilian, Dragon, Classical, 8.O-O",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1"
    ]
  },
  {
    "eco": "B73",
    "name": "Sicilian, Dragon, Classical, Richter Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d1d2"
    ]
  },
  {
    "eco": "B73",
    "name": "Sicilian, Dragon, Classical, Zollner gambit",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "f2f4",
      "d8b6",
      "e4e5"
    ]
  },
  {
  "eco": "B74",
  "name": "Sicilian, Dragon, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","f1e2","f8g7","c1e3"]
},
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, 9.Nb3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3"
    ]
  },
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, Alekhine Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3",
      "a7a5"
    ]
  },
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, Bernard defense",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3",
      "c8e6",
      "f2f4",
      "c6a5",
      "f4f5",
      "e6c4",
      "e2d3",
      "c4d3",
      "c2d3",
      "d6d5"
    ]
  },
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, Reti-Tartakower Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3",
      "c8e6",
      "f2f4",
      "d8c8"
    ]
  },
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, Spielmann Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3",
      "c8e6",
      "f2f4",
      "c6a5",
      "f4f5",
      "e6c4",
      "e2d3"
    ]
  },
  {
    "eco": "B74",
    "name": "Sicilian, Dragon, Classical, Stockholm attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f1e2",
      "b8c6",
      "e1g1",
      "e8g8",
      "d4b3",
      "c8e6",
      "f2f4",
      "c6a5",
      "f4f5",
      "e6c4",
      "b3a5",
      "c4e2",
      "d1e2",
      "d8a5",
      "g2g4"
    ]
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
    "eco": "B76",
    "name": "Sicilian, Dragon, Yugoslav attack, 7...O-O",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8"
    ]
  },
  {
    "eco": "B76",
    "name": "Sicilian, Dragon, Yugoslav attack, Rauser Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "e1c1"
    ]
  },
  {
  "eco": "B77",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2"]
},
  {
    "eco": "B77",
    "name": "Sicilian, Dragon, Yugoslav attack, 9...Bd7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "f1c4",
      "c8d7"
    ]
  },
  {
    "eco": "B77",
    "name": "Sicilian, Dragon, Yugoslav attack, 9.Bc4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "f1c4"
    ]
  },
  {
    "eco": "B77",
    "name": "Sicilian, Dragon, Yugoslav attack, Byrne Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "f1c4",
      "a7a5"
    ]
  },
  {
  "eco": "B78",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2","b8c6"]
},
  {
    "eco": "B78",
    "name": "Sicilian, Dragon, Yugoslav attack, 10.O-O-O",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "f1c4",
      "c8d7",
      "e1c1"
    ]
  },
  {
  "eco": "B79",
  "name": "Sicilian, Dragon, Yugoslav Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","g7g6","c1e3","f8g7","f2f3","e8g8","d1d2","b8c6","e1c1"]
},
  {
    "eco": "B79",
    "name": "Sicilian, Dragon, Yugoslav attack, 12.h4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "g7g6",
      "c1e3",
      "f8g7",
      "f2f3",
      "e8g8",
      "d1d2",
      "b8c6",
      "f1c4",
      "c8d7",
      "e1c1",
      "d8a5",
      "c4b3",
      "f8c8",
      "h2h4"
    ]
  },
  {
  "eco": "B80",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6"]
},
  {
    "eco": "B80",
    "name": "Sicilian, Scheveningen Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6"
    ]
  },
  {
    "eco": "B80",
    "name": "Sicilian, Scheveningen, English Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "c1e3",
      "a7a6",
      "d1d2"
    ]
  },
  {
    "eco": "B80",
    "name": "Sicilian, Scheveningen, Fianchetto Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "g2g3"
    ]
  },
  {
    "eco": "B80",
    "name": "Sicilian, Scheveningen, Vitolins Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1b5"
    ]
  },
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen (6.f4 e6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f2f4"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, classical (Ndb5)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c3b5"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, classical variation (with ...Qc7 & ...Nc6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","c1e3","b8c6","d1d2","d8c7"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, classical, Maroczy (...b6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","c1e3","b7b6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Qc7)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4","d8c7"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Nc6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4","b8c6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Be7)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…e6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…d6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…Qc7)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4","d8c7"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…Nc6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","b8c6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…Be7)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…e6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","e7e6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…d6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, classical, Maroczy (...b6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","c1e3","b7b6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…a6…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Qc7…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4","d8c7","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Nc6…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","b8c6","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…Be7…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","f8e7","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…e6…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (…d6…g6)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","g7g6"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (complete setup)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","f2f4","d8c7","g7g6","c1e3"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (...Bd7 Qe1)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","c1e3","c8d7","d1e1"
  ]
},
  {
  "eco": "B80",
  "name": "Sicilian: Scheveningen, modern main line (...Qb8)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1e2","e7e6","e1g1","f8e7","d8b8"
  ]
},
  {
  "eco": "B81",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1g5"]
},
  {
    "eco": "B81",
    "name": "Sicilian, Scheveningen, Keres attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "g2g4"
    ]
  },
  {
  "eco": "B82",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2"]
},
  {
    "eco": "B82",
    "name": "Sicilian, Scheveningen, 6.f4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f2f4"
    ]
  },
  {
    "eco": "B82",
    "name": "Sicilian, Scheveningen, Tal Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f2f4",
      "b8c6",
      "c1e3",
      "f8e7",
      "d1f3"
    ]
  },
  {
  "eco": "B83",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7"]
},
  {
    "eco": "B83",
    "name": "Sicilian, Modern Scheveningen",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "b8c6"
    ]
  },
  {
    "eco": "B83",
    "name": "Sicilian, Modern Scheveningen, Main line",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "b8c6",
      "e1g1",
      "f8e7",
      "c1e3",
      "e8g8",
      "f2f4"
    ]
  },
  {
    "eco": "B83",
    "name": "Sicilian, Modern Scheveningen, Main line with Nb3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "b8c6",
      "e1g1",
      "f8e7",
      "c1e3",
      "e8g8",
      "f2f4",
      "c8d7",
      "d4b3"
    ]
  },
  {
    "eco": "B83",
    "name": "Sicilian, Scheveningen, 6.Be2",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2"
    ]
  },
  {
  "eco": "B84",
  "name": "Sicilian, Scheveningen",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7","e1g1"]
},
  {
    "eco": "B84",
    "name": "Sicilian, Scheveningen (Paulsen), Classical Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "a7a6"
    ]
  },
  {
    "eco": "B84",
    "name": "Sicilian, Scheveningen, Classical, Nd7 system",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "a7a6",
      "e1g1",
      "b8d7"
    ]
  },
  {
  "eco": "B85",
  "name": "Sicilian, Scheveningen, Classical",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","f1e2","f8e7","e1g1","e8g8"]
},
  {
    "eco": "B85",
    "name": "Sicilian, Scheveningen, Classical Main line",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "a7a6",
      "e1g1",
      "d8c7",
      "f2f4",
      "b8c6",
      "c1e3",
      "f8e7",
      "d1e1",
      "e8g8"
    ]
  },
  {
    "eco": "B85",
    "name": "Sicilian, Scheveningen, Classical Variation with ...Qc7 and ...Nc6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "a7a6",
      "e1g1",
      "d8c7",
      "f2f4",
      "b8c6"
    ]
  },
  {
    "eco": "B85",
    "name": "Sicilian, Scheveningen, Classical, Maroczy system",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1e2",
      "a7a6",
      "e1g1",
      "d8c7",
      "f2f4",
      "b8c6",
      "g1h1",
      "f8e7",
      "a2a4"
    ]
  },
  {
  "eco": "B86",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3"]
},
  {
    "eco": "B86",
    "name": "Sicilian, Sozin attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4"
    ]
  },
  {
  "eco": "B87",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7"]
},
  {
    "eco": "B87",
    "name": "Sicilian, Sozin with ...a6 and ...b5",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4",
      "a7a6",
      "c4b3",
      "b7b5"
    ]
  },
  {
  "eco": "B87",
  "name": "Sicilian: Sozin (with ...a6 & ...b5)",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1c4","b7b5"
  ]
},
  {
  "eco": "B88",
  "name": "Sicilian, Fischer-Sozin Attack",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7","f1c4"]
},
  {
    "eco": "B88",
    "name": "Sicilian, Sozin, Fischer Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4",
      "b8c6",
      "c4b3",
      "f8e7",
      "c1e3",
      "e8g8",
      "f2f4"
    ]
  },
  {
    "eco": "B88",
    "name": "Sicilian, Sozin, Leonhardt Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4",
      "b8c6"
    ]
  },
  {
  "eco": "B89",
  "name": "Sicilian, Fischer-Sozin Attack, Main line",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","e7e6","c1e3","f8e7","f1c4","e8g8"]
},
  {
    "eco": "B89",
    "name": "Sicilian, Sozin, 7.Be3",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4",
      "b8c6",
      "c1e3"
    ]
  },
  {
    "eco": "B89",
    "name": "Sicilian, Velimirovic attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "e7e6",
      "f1c4",
      "b8c6",
      "c1e3",
      "f8e7",
      "d1e2"
    ]
  },
  {
  "eco": "B90",
  "name": "Sicilian, Najdorf",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6"]
},
  {
    "eco": "B90",
    "name": "Sicilian, Najdorf, Adams attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "h2h3"
    ]
  },
  {
    "eco": "B90",
    "name": "Sicilian, Najdorf, Byrne (English) attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1e3"
    ]
  },
  {
    "eco": "B90",
    "name": "Sicilian, Najdorf, Lipnitzky attack",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "f1c4"
    ]
  },
  {
  "eco": "B90",
  "name": "Sicilian: Najdorf, Byrne–Almasi attack",
  "moves": [
    "e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1c4"
  ]
},
  {
  "eco": "B91",
  "name": "Sicilian, Najdorf, Zagreb (Byrne) Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","f1c4"]
},
  {
    "eco": "B91",
    "name": "Sicilian, Najdorf, Zagreb (Fianchetto) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "g2g3"
    ]
  },
  {
  "eco": "B92",
  "name": "Sicilian, Najdorf, Opocensky Variation",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1e3"]
},
  {
    "eco": "B92",
    "name": "Sicilian, Najdorf, Opovcensky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "f1e2"
    ]
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
    "eco": "B94",
    "name": "Sicilian, Najdorf, Ivkov Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "b8d7",
      "f1c4",
      "d8a5",
      "d1d2",
      "e7e6",
      "e1c1",
      "b7b5",
      "c4b3",
      "c8b7",
      "h1e1",
      "d7c5",
      "e4e5"
    ]
  },
  {
  "eco": "B95",
  "name": "Sicilian, Najdorf, 6.Bg5",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6"]
},
  {
    "eco": "B95",
    "name": "Sicilian, Najdorf, 6...e6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6"
    ]
  },
  {
  "eco": "B96",
  "name": "Sicilian, Najdorf, 6.Bg5",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f1e2"]
},
  {
    "eco": "B96",
    "name": "Sicilian, Najdorf, 7.f4",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4"
    ]
  },
  {
    "eco": "B96",
    "name": "Sicilian, Najdorf, Polugayevsky Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "b7b5"
    ]
  },
  {
    "eco": "B96",
    "name": "Sicilian, Najdorf, Polugayevsky, Simagin Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "b7b5",
      "e4e5",
      "d6e5",
      "f4e5",
      "d8c7",
      "d1e2"
    ]
  },
  {
  "eco": "B97",
  "name": "Sicilian, Najdorf, Poisoned Pawn",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","d1d2","b7b5","c3b5"]
},
  {
    "eco": "B97",
    "name": "Sicilian, Najdorf, 7...Qb6",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "d8b6"
    ]
  },
  {
    "eco": "B97",
    "name": "Sicilian, Najdorf, Poisoned pawn Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "d8b6",
      "d1d2",
      "b6b2",
      "a1b1",
      "b2a3"
    ]
  },
  {
  "eco": "B98",
  "name": "Sicilian, Najdorf, 7.f4",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f2f4"]
},
  {
    "eco": "B98",
    "name": "Sicilian, Najdorf Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "f8e7",
      "d1f3",
      "d8c7"
    ]
  },
  {
    "eco": "B98",
    "name": "Sicilian, Najdorf, 7...Be7",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "f8e7"
    ]
  },
  {
    "eco": "B98",
    "name": "Sicilian, Najdorf, Browne Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "f8e7",
      "d1f3",
      "h7h6",
      "g5h4",
      "d8c7"
    ]
  },
  {
    "eco": "B98",
    "name": "Sicilian, Najdorf, Goteborg (Argentine) Variation",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "f8e7",
      "d1f3",
      "h7h6",
      "g5h4",
      "g7g5"
    ]
  },
  {
  "eco": "B99",
  "name": "Sicilian, Najdorf, Main line",
  "moves": ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6","c1g5","e7e6","f2f4","b8c6"]
},
  {
    "eco": "B99",
    "name": "Sicilian, Najdorf, 7...Be7 Main line",
    "moves": [
      "e2e4",
      "c7c5",
      "g1f3",
      "d7d6",
      "d2d4",
      "c5d4",
      "f3d4",
      "g8f6",
      "b1c3",
      "a7a6",
      "c1g5",
      "e7e6",
      "f2f4",
      "f8e7",
      "d1f3",
      "d8c7",
      "e1c1",
      "b8d7"
    ]
  },
  {
    "eco": "C00",
    "name": "French defence",
    "moves": [
      "e2e4",
      "e7e6"
    ]
  },
  {
  "eco": "C00",
  "name": "French Defense",
  "moves": ["e2e4","e7e6"]
},
  {
    "eco": "C00",
    "name": "French defense, Steiner Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "c2c4"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Alapin Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "c1e3"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Chigorin Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d1e2"
    ]
  },
  {
    "eco": "C00",
    "name": "French, King's Indian attack",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d3"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Labourdonnais Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "f2f4"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Pelikan Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "b1c3",
      "d7d5",
      "f2f4"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Reti (Spielmann) Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "b2b3"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Reversed Philidor formation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d3",
      "d7d5",
      "b1d2",
      "g8f6",
      "g1f3",
      "b8c6",
      "f1e2"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Schlechter Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "f1d3"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Steinitz attack",
    "moves": [
      "e2e4",
      "e7e6",
      "e4e5"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Two knights Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "b1c3",
      "d7d5",
      "g1f3"
    ]
  },
  {
    "eco": "C00",
    "name": "French, Wing gambit",
    "moves": [
      "e2e4",
      "e7e6",
      "g1f3",
      "d7d5",
      "e4e5",
      "c7c5",
      "b2b4"
    ]
  },
  {
    "eco": "C00",
    "name": "Lengfellner system",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d6"
    ]
  },
  {
    "eco": "C00",
    "name": "St. George defense",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "a7a6"
    ]
  },
  {
  "eco": "C00",
  "name": "French: Steiner variation",
  "moves": [
    "e2e4","e7e6","d2d3"
  ]
},
  {
  "eco": "C01",
  "name": "French, Exchange Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","e4d5"]
},
  {
    "eco": "C01",
    "name": "French, Exchange, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4d5",
      "e6d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8c6"
    ]
  },
  {
    "eco": "C01",
    "name": "French, Exchange, Svenonius Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4d5",
      "e6d5",
      "b1c3",
      "g8f6",
      "c1g5"
    ]
  },
  {
  "eco": "C01",
  "name": "French: exchange (3.Nc3)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","e4d5","e6d5","b1c3"
  ]
},
  {
  "eco": "C01",
  "name": "French: exchange, Blackburne variation",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","e4d5","e6d5","c1d2","f8d6"
  ]
},
  {
  "eco": "C02",
  "name": "French, Advance Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","e4e5"]
},
  {
    "eco": "C02",
    "name": "French, Advance, Euwe Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "c2c3",
      "b8c6",
      "g1f3",
      "c8d7"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Milner-Barry gambit",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "c2c3",
      "b8c6",
      "g1f3",
      "d8b6",
      "f1d3"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Nimzovich system",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "g1f3"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Nimzovich Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "d1g4"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "c2c3",
      "b8c6",
      "g1f3"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "d4c5"
    ]
  },
  {
    "eco": "C02",
    "name": "French, Advance, Wade Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "e4e5",
      "c7c5",
      "c2c3",
      "d8b6",
      "g1f3",
      "c8d7"
    ]
  },
  {
  "eco": "C03",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2"]
},
  {
    "eco": "C03",
    "name": "French, Tarrasch, Guimard Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "b8c6"
    ]
  },
  {
    "eco": "C03",
    "name": "French, Tarrasch, Haberditz Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "f7f5"
    ]
  },
  {
  "eco": "C04",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","g8f6"]
},
  {
    "eco": "C04",
    "name": "French, Tarrasch, Guimard Main line",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "b8c6",
      "g1f3",
      "g8f6"
    ]
  },
  {
  "eco": "C05",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5"]
},
  {
    "eco": "C05",
    "name": "French, Tarrasch, Botvinnik Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "g8f6",
      "e4e5",
      "f6d7",
      "f1d3",
      "c7c5",
      "c2c3",
      "b7b6"
    ]
  },
  {
    "eco": "C05",
    "name": "French, Tarrasch, Closed Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "g8f6"
    ]
  },
  {
  "eco": "C06",
  "name": "French, Tarrasch",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3"]
},
  {
    "eco": "C06",
    "name": "French, Tarrasch, Closed Variation , Main line",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "g8f6",
      "e4e5",
      "f6d7",
      "f1d3",
      "c7c5",
      "c2c3",
      "b8c6",
      "g1e2",
      "c5d4",
      "c3d4"
    ]
  },
  {
    "eco": "C06",
    "name": "French, Tarrasch, Leningrad Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "g8f6",
      "e4e5",
      "f6d7",
      "f1d3",
      "c7c5",
      "c2c3",
      "b8c6",
      "g1e2",
      "c5d4",
      "c3d4",
      "d7b6"
    ]
  },
  {
  "eco": "C07",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6"]
},
  {
    "eco": "C07",
    "name": "French, Tarrasch, Eliskases Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "c7c5",
      "e4d5",
      "d8d5",
      "g1f3",
      "c5d4",
      "f1c4",
      "d5d8"
    ]
  },
  {
  "eco": "C07",
  "name": "French: Tarrasch, open (4.exd5 exd5)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1d2","d5e4","d2e4","e6e5"
  ]
},
  {
  "eco": "C07",
  "name": "French: Tarrasch, open variation (Huebner)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1d2","g8f6","e4e5","f6d7","f1d3","c7c5"
  ]
},
  {
  "eco": "C08",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6","e4d5"]
},
  {
    "eco": "C08",
    "name": "French, Tarrasch, Open, 4.ed ed",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "c7c5",
      "e4d5",
      "e6d5"
    ]
  },
  {
  "eco": "C09",
  "name": "French, Tarrasch, Open Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1d2","c7c5","g1f3","g8f6","e4d5","e6d5"]
},
  {
    "eco": "C09",
    "name": "French, Tarrasch, Open Variation , Main line",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1d2",
      "c7c5",
      "e4d5",
      "e6d5",
      "g1f3",
      "b8c6"
    ]
  },
  {
  "eco": "C10",
  "name": "French Defense",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3"]
},
  {
    "eco": "C10",
    "name": "French, Fort Knox Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "c8d7",
      "g1f3",
      "d7c6"
    ]
  },
  {
    "eco": "C10",
    "name": "French, Frere (Becker) Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "d8d5"
    ]
  },
  {
    "eco": "C10",
    "name": "French, Marshall Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "c7c5"
    ]
  },
  {
    "eco": "C10",
    "name": "French, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "C10",
    "name": "French, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4"
    ]
  },
  {
    "eco": "C10",
    "name": "French, Rubinstein, Capablanca line",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "d5e4",
      "c3e4",
      "b8d7",
      "g1f3",
      "g8f6",
      "e4f6",
      "d7f6",
      "f3e5"
    ]
  },
  {
  "eco": "C11",
  "name": "French Defense",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6"]
},
  {
    "eco": "C11",
    "name": "French, Burn Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "d5e4"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Henneberger Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1e3"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e4e5"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Steinitz, Boleslavsky Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e4e5",
      "f6d7",
      "f2f4",
      "c7c5",
      "g1f3",
      "b8c6",
      "c1e3"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Steinitz, Bradford attack",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e4e5",
      "f6d7",
      "f2f4",
      "c7c5",
      "d4c5",
      "f8c5",
      "d1g4"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Steinitz, Brodsky-Jones Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e4e5",
      "f6d7",
      "f2f4",
      "c7c5",
      "d4c5",
      "b8c6",
      "a2a3",
      "f8c5",
      "d1g4",
      "e8g8",
      "g1f3",
      "f7f6"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Steinitz, Gledhill attack",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e4e5",
      "f6d7",
      "d1g4"
    ]
  },
  {
    "eco": "C11",
    "name": "French, Swiss Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "f1d3"
    ]
  },
  {
  "eco": "C11",
  "name": "French: classical, Vistaneckis (Nimzovich) variation",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7","e4e5","f6d7"
  ]
},
  {
  "eco": "C12",
  "name": "French, MacCutcheon",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8b4"]
},
  {
    "eco": "C12",
    "name": "French, MacCutcheon Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Advance Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Bernstein Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5h4"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4d5",
      "d8d5",
      "g5f6",
      "g7f6",
      "d1d2",
      "d5a5"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Chigorin Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "e5f6"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Dr. Olland (Dutch) Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5c1"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Duras Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5d2",
      "b4c3",
      "b2c3",
      "f6e4",
      "d1g4",
      "e8f8",
      "d2c1"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Grigoriev Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "e5f6",
      "h6g5",
      "f6g7",
      "h8g8",
      "h2h4",
      "g5h4",
      "d1g4"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Janowski Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5e3"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Lasker Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5d2",
      "b4c3"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Lasker Variation , 8...g6",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5d2",
      "b4c3",
      "b2c3",
      "f6e4",
      "d1g4",
      "g7g6"
    ]
  },
  {
    "eco": "C12",
    "name": "French, MacCutcheon, Tartakower Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8b4",
      "e4e5",
      "h7h6",
      "g5d2",
      "f6d7"
    ]
  },
  {
  "eco": "C13",
  "name": "French, Classical",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7"]
},
  {
    "eco": "C13",
    "name": "French, Albin-Alekhine-Chatard attack",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "h2h4"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Albin-Alekhine-Chatard attack, Breyer Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "h2h4",
      "c7c5"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Albin-Alekhine-Chatard attack, Maroczy Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "h2h4",
      "a7a6"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Albin-Alekhine-Chatard attack, Spielmann Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "h2h4",
      "e8g8"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Albin-Alekhine-Chatard attack, Teichmann Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "h2h4",
      "f7f6"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Classical, Anderssen Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "g5f6"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Classical, Anderssen-Richter Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "g5f6",
      "e7f6",
      "e4e5",
      "f6e7",
      "d1g4"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Classical, Frankfurt Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6g8",
      "g5e3",
      "b7b6"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Classical, Tartakower Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6e4"
    ]
  },
  {
    "eco": "C13",
    "name": "French, Classical, Vistaneckis (Nimzo )    Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6g8"
    ]
  },
  {
  "eco": "C14",
  "name": "French, Classical",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7","e4e5"]
},
  {
    "eco": "C14",
    "name": "French, Classical Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Alapin Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "c3b5"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Pollock Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "d1g4"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "d1d2"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Stahlberg Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "f2f4",
      "e8g8",
      "g1f3",
      "c7c5",
      "d1d2",
      "b8c6",
      "e1c1",
      "c5c4"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "f2f4"
    ]
  },
  {
    "eco": "C14",
    "name": "French, Classical, Tarrasch Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e4e5",
      "f6d7",
      "g5e7",
      "d8e7",
      "f1d3"
    ]
  },
  {
  "eco": "C15",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4"]
},
  {
    "eco": "C15",
    "name": "French, Winawer (Nimzovich) Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, Alekhine (Maroczy) gambit",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "g1e2"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, Alekhine gambit",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "g1e2",
      "d5e4",
      "a2a3",
      "b4c3"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, Alekhine gambit, Alatortsev Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "g1e2",
      "d5e4",
      "a2a3",
      "b4e7",
      "c3e4",
      "g8f6",
      "e2g3",
      "e8g8",
      "f1e2",
      "b8c6"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, Alekhine gambit, Kan Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "g1e2",
      "d5e4",
      "a2a3",
      "b4c3",
      "e2c3",
      "b8c6"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, fingerslip Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "c1d2"
    ]
  },
  {
    "eco": "C15",
    "name": "French, Winawer, Kondratiyev Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "f1d3",
      "c7c5",
      "e4d5",
      "d8d5",
      "c1d2"
    ]
  },
  {
  "eco": "C15",
  "name": "French: Winawer, classical variation (7.Nf3)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3","g8e7","g1f3"
  ]
},
  {
  "eco": "C16",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5"]
},
  {
    "eco": "C16",
    "name": "French, Winawer, Advance Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5"
    ]
  },
  {
    "eco": "C16",
    "name": "French, Winawer, Petrosian Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "d8d7"
    ]
  },
  {
  "eco": "C17",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5"]
},
  {
    "eco": "C17",
    "name": "French, Winawer, Advance Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5"
    ]
  },
  {
    "eco": "C17",
    "name": "French, Winawer, Advance, 5.a3",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3"
    ]
  },
  {
    "eco": "C17",
    "name": "French, Winawer, Advance, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "c1d2"
    ]
  },
  {
    "eco": "C17",
    "name": "French, Winawer, Advance, Rauzer Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "c5d4",
      "a3b4",
      "d4c3",
      "g1f3"
    ]
  },
  {
    "eco": "C17",
    "name": "French, Winawer, Advance, Russian Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "d1g4"
    ]
  },
  {
  "eco": "C18",
  "name": "French, Winawer",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3"]
},
  {
    "eco": "C18",
    "name": "French, Winawer, Advance Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3"
    ]
  },
  {
    "eco": "C18",
    "name": "French, Winawer, Classical Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "d8c7"
    ]
  },
  {
  "eco": "C18",
  "name": "French: Winawer, advance (7.h4)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3","h7h6","h2h4"
  ]
},
  {
  "eco": "C18",
  "name": "French: Winawer, advance (without 7...Qc7)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3","g8e7"
  ]
},
  {
  "eco": "C18",
  "name": "French: Winawer, advance, poisoned pawn, Konstantinopolsky",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3","d8a5"
  ]
},
  {
  "eco": "C18",
  "name": "French: Winawer, advance, positional main line (with ...Qc7)",
  "moves": [
    "e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3","d8c7"
  ]
},
  {
  "eco": "C19",
  "name": "French, Winawer, Advance Variation",
  "moves": ["e2e4","e7e6","d2d4","d7d5","b1c3","f8b4","e4e5","c7c5","a2a3","b4c3","b2c3"]
},
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, 6...Ne7",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7"
    ]
  },
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, poisoned pawn Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7",
      "d1g4"
    ]
  },
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, poisoned pawn, Euwe-Gligoric Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7",
      "d1g4",
      "d8c7",
      "g4g7",
      "h8g8",
      "g7h7",
      "c5d4",
      "e1d1"
    ]
  },
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, poisoned pawn, Konstantinopolsky Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7",
      "d1g4",
      "d8c7",
      "g4g7",
      "h8g8",
      "g7h7",
      "c5d4",
      "g1e2"
    ]
  },
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, positional Main line",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7",
      "g1f3"
    ]
  },
  {
    "eco": "C19",
    "name": "French, Winawer, Advance, Smyslov Variation",
    "moves": [
      "e2e4",
      "e7e6",
      "d2d4",
      "d7d5",
      "b1c3",
      "f8b4",
      "e4e5",
      "c7c5",
      "a2a3",
      "b4c3",
      "b2c3",
      "g8e7",
      "a3a4"
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
  "eco": "C20",
  "name": "King's Pawn Game",
  "moves": ["e2e4","e7e5"]
},
  {
    "eco": "C21",
    "name": "Centre game",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e2d4"
    ]
  },
  {
  "eco": "C21",
  "name": "Center Game",
  "moves": ["e2e4","e7e5","d2d4"]
},
  {
    "eco": "C21",
    "name": "center game, Kieseritsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "g1f3",
      "c7c5",
      "f1c4",
      "b7b5"
    ]
  },
  {
    "eco": "C21",
    "name": "Danish gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "c2c3"
    ]
  },
  {
    "eco": "C21",
    "name": "Danish gambit, Collijn defense",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "c2c3",
      "d4c3",
      "f1c4",
      "c3b2",
      "c1b2",
      "d8e7"
    ]
  },
  {
    "eco": "C21",
    "name": "Danish gambit, Schlechter defense",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "c2c3",
      "d4c3",
      "f1c4",
      "c3b2",
      "c1b2",
      "d7d5"
    ]
  },
  {
    "eco": "C21",
    "name": "Danish gambit, Soerensen defense",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "c2c3",
      "d7d5"
    ]
  },
  {
    "eco": "C21",
    "name": "Halasz gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "f2f4"
    ]
  },
  {
  "eco": "C21",
  "name": "Centre game: Kupreichik variation",
  "moves": [
    "e2e4","e7e5","d2d4","e5d4","c1f4"
  ]
},
  {
  "eco": "C22",
  "name": "Center Game",
  "moves": ["e2e4","e7e5","d2d4","e5d4"]
},
  {
    "eco": "C22",
    "name": "center game, Berger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4e3",
      "g8f6"
    ]
  },
  {
    "eco": "C22",
    "name": "center game, Charousek Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4e3",
      "f8b4",
      "c2c3",
      "b4e7"
    ]
  },
  {
    "eco": "C22",
    "name": "center game, Hall Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4c4"
    ]
  },
  {
    "eco": "C22",
    "name": "center game, Kupr )   k Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4e3",
      "g8f6",
      "b1c3",
      "f8b4",
      "c1d2",
      "e8g8",
      "e1c1",
      "f8e8",
      "f1c4",
      "d7d6",
      "g1h3"
    ]
  },
  {
    "eco": "C22",
    "name": "center game, l'Hermet Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4e3",
      "f7f5"
    ]
  },
  {
    "eco": "C22",
    "name": "center game, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "d2d4",
      "e5d4",
      "d1d4",
      "b8c6",
      "d4e3"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's opening",
    "moves": [
      "e2e4",
      "e7e5",
      "c1c4"
    ]
  },
  {
  "eco": "C23",
  "name": "Bishop's Opening",
  "moves": ["e2e4","e7e5","f1c4"]
},
  {
    "eco": "C23",
    "name": "Bishop's Opening, Calabrese counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f7f5"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Calabrese counter-gambit, Jaenisch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f7f5",
      "d2d3"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Classical Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, del Rio Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8g5"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Four pawns' gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "f2f4",
      "e5f4",
      "g1f3",
      "b4e7",
      "d2d4",
      "e7h4",
      "g2g3",
      "f4g3",
      "e1g1",
      "g3h2",
      "g1h1"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Lewis counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "c2c3",
      "d7d5"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Lewis gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "d2d4"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Lisitsyn Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "c7c6",
      "d2d4",
      "d7d5",
      "e4d5",
      "c6d5",
      "c4b5",
      "c8d7",
      "b5d7",
      "b8d7",
      "d4e5",
      "d7e5",
      "g1e2"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Lopez gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "d1e2",
      "b8c6",
      "c2c3",
      "g8f6",
      "f2f4"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, MacDonnell double gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "f2f4"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Philidor counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "c7c6"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Philidor Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "c2c3"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Pratt Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "d1h5",
      "e8g8"
    ]
  },
  {
    "eco": "C23",
    "name": "Bishop's Opening, Wing gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "f8c5",
      "b2b4"
    ]
  },
  {
  "eco": "C24",
  "name": "Bishop's Opening",
  "moves": ["e2e4","e7e5","f1c4","g8f6"]
},
  {
    "eco": "C24",
    "name": "Bishop's Opening, Berlin defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "g8f6"
    ]
  },
  {
    "eco": "C24",
    "name": "Bishop's Opening, Greco gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "g8f6",
      "f2f4"
    ]
  },
  {
    "eco": "C24",
    "name": "Bishop's Opening, Ponziani gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "g8f6",
      "d2d4"
    ]
  },
  {
    "eco": "C24",
    "name": "Bishop's Opening, Urusov gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "g1f3"
    ]
  },
  {
    "eco": "C24",
    "name": "Bishop's Opening, Urusov gambit, Panov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "g1f3",
      "d7d5",
      "e4d5",
      "f8b4",
      "c2c3",
      "d8e7"
    ]
  },
  {
  "eco": "C24",
  "name": "Bishop's opening (with 3.d3)",
  "moves": [
    "e2e4","e7e5","f1c4","g8f6","d2d3"
  ]
},
  {
  "eco": "C24",
  "name": "Bishop's opening: Burger attack",
  "moves": [
    "e2e4","e7e5","f1c4","f8c5","d1g4"
  ]
},
  {
    "eco": "C25",
    "name": "Vienna game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3"
    ]
  },
  {
  "eco": "C25",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3"]
},
  {
    "eco": "C25",
    "name": "Vienna gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna game, Max Lange defense",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Fyfe gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "d2d4"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Hamppe-Allgaier gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Hamppe-Allgaier gambit, Alapin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "d7d6"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Hamppe-Muzio gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Hamppe-Muzio, Dubois Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "g4f3",
      "d1f3",
      "c6e5",
      "f3f4",
      "d8f6"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "g2g3"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Pierce gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "d2d4"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Pierce gambit, Rushmere attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "d2d4",
      "g5g4",
      "f1c4",
      "g4f3",
      "e1g1",
      "d7d5",
      "e4d5",
      "c8g4",
      "d5c6"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Steinitz gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "d2d4"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Steinitz gambit, Fraser-Minckwitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "d2d4",
      "d8h4",
      "e1e2",
      "b7b6"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Steinitz gambit, Zukertort defense",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "b8c6",
      "f2f4",
      "e5f4",
      "d2d4",
      "d8h4",
      "e1e2",
      "d7d5"
    ]
  },
  {
    "eco": "C25",
    "name": "Vienna, Zhuravlev countergambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "f8b4",
      "d1g4",
      "g8f6"
    ]
  },
  {
  "eco": "C25",
  "name": "Vienna game (Bc4...Bc5)",
  "moves": [
    "e2e4","e7e5","b1c3","b8c6","f1c4","f8c5"
  ]
},
  {
  "eco": "C25",
  "name": "Vienna game: 4.d3",
  "moves": [
    "e2e4","e7e5","b1c3","b8c6","f1c4","f8c5","d2d3"
  ]
},
  {
  "eco": "C26",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3","g8f6"]
},
  {
    "eco": "C26",
    "name": "Vienna, Falkbeer Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6"
    ]
  },
  {
    "eco": "C26",
    "name": "Vienna, Mengarini Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "a2a3"
    ]
  },
  {
    "eco": "C26",
    "name": "Vienna, Paulsen-Mieses Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "g2g3"
    ]
  },
  {
  "eco": "C27",
  "name": "Vienna Game",
  "moves": ["e2e4","e7e5","b1c3","f8c5"]
},
  {
    "eco": "C27",
    "name": "Boden-Kieseritsky gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "f6e4",
      "g1f3"
    ]
  },
  {
    "eco": "C27",
    "name": "Boden-Kieseritsky gambit, Lichtenhein defense",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "f6e4",
      "g1f3",
      "d7d5"
    ]
  },
  {
    "eco": "C27",
    "name": "Vienna, `Frankenstein-Dracula' Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "f6e4",
      "d1h5",
      "e4d6",
      "c4b3",
      "b8c6",
      "c3b5",
      "g7g6",
      "h5f3",
      "f7f5",
      "f3d5",
      "d8e7",
      "b5c7",
      "e8d8",
      "c7a8",
      "b7b6"
    ]
  },
  {
    "eco": "C27",
    "name": "Vienna, Adams' gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "f6e4",
      "d1h5",
      "e4d6",
      "c4b3",
      "b8c6",
      "d2d4"
    ]
  },
  {
    "eco": "C27",
    "name": "Vienna, Alekhine Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "f6e4",
      "d1h5",
      "e4d6",
      "c4b3",
      "f8e7",
      "g1f3",
      "b8c6",
      "f3e5"
    ]
  },
  {
  "eco": "C28",
  "name": "Vienna Gambit",
  "moves": ["e2e4","e7e5","b1c3","f8c5","f2f4"]
},
  {
    "eco": "C28",
    "name": "Vienna game",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f1c4",
      "b8c6"
    ]
  },
  {
  "eco": "C29",
  "name": "Vienna Gambit, Hamppe-Allgaier Gambit",
  "moves": ["e2e4","e7e5","b1c3","f8c5","f2f4","e5f4","g1f3","g8f6"]
},
  {
    "eco": "C29",
    "name": "Vienna gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Bardeleben Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "d1f3",
      "f7f5"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Breyer Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "g1f3",
      "f8e7"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Heyde Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "d1f3",
      "f7f5",
      "d2d4"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Kaufmann Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "g1f3",
      "c8g4",
      "d1e2"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "d1f3"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "d2d3"
    ]
  },
  {
    "eco": "C29",
    "name": "Vienna gambit, Wurzburger trap",
    "moves": [
      "e2e4",
      "e7e5",
      "b1c3",
      "g8f6",
      "f2f4",
      "d7d5",
      "f4e5",
      "f6e4",
      "d2d3",
      "d8h4",
      "g2g3",
      "e4g3",
      "g1f3",
      "h4h5",
      "c3d5"
    ]
  },
  {
    "eco": "C30",
    "name": "King's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4"
    ]
  },
  {
  "eco": "C30",
  "name": "King's Gambit",
  "moves": ["e2e4","e7e5","f2f4"]
},
  {
    "eco": "C30",
    "name": "KGD, 2...Nf6",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "g8f6"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "c2c3",
      "f7f5"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, 4.c3",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "c2c3"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, Hanham Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "b1c3",
      "b8d7"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, Heath Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "b2b4"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, Marshall attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "c2c3",
      "c8g4",
      "f4e5",
      "d6e5",
      "d1a4"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, Reti Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "c2c3",
      "f7f5",
      "f4e5",
      "d6e5",
      "d2d4",
      "e5d4",
      "f1c4"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, SOldatenkov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "f4e5"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Classical, Svenonius Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "f8c5",
      "g1f3",
      "d7d6",
      "b1c3",
      "g8f6",
      "f1c4",
      "b8c6",
      "d2d3",
      "c8g4",
      "h2h3",
      "g4f3",
      "d1f3",
      "e5f4"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Keene's defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d8h4",
      "g2g3",
      "h4e7"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Mafia defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "c7c5"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Norwalde Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d8f6"
    ]
  },
  {
    "eco": "C30",
    "name": "KGD, Norwalde Variation , Buecker gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d8f6",
      "g1f3",
      "f6f4",
      "b1c3",
      "f8b4",
      "f1c4"
    ]
  },
  {
  "eco": "C31",
  "name": "King's Gambit Declined",
  "moves": ["e2e4","e7e5","f2f4","d7d5"]
},
  {
    "eco": "C31",
    "name": "KGD, Falkbeer counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, 3...e4",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, 4.d3",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, Milner-Barry Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, Morphy gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "b1c3",
      "f8b4",
      "c1d2",
      "e4e3"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, Nimzovich Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "f1b5"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "b1c3",
      "g8f6",
      "d1e2"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Falkbeer, Tartakower Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "g1f3"
    ]
  },
  {
    "eco": "C31",
    "name": "KGD, Nimzovich counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "c7c6"
    ]
  },
  {
  "eco": "C31",
  "name": "KGD: Falkbeer (5.dxe4)",
  "moves": [
    "e2e4","e7e5","f2f4","d7d5","e4d5","e5f4","d1e2","f8e7","d5e4"
  ]
},
  {
  "eco": "C32",
  "name": "King's Gambit Declined, Falkbeer Countergambit",
  "moves": ["e2e4","e7e5","f2f4","d7d5","e4d5"]
},
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, 5.de",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Alapin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4",
      "f6e4",
      "g1f3",
      "f8c5",
      "d1e2",
      "c5f2",
      "e1d1",
      "d8d5",
      "f3d2"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Charousek gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4",
      "f6e4",
      "d1e2"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Charousek Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4",
      "f6e4",
      "d1e2",
      "d8d5",
      "b1d2",
      "f7f5",
      "g2g4"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Keres Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "b1d2"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Main line, 7...Bf5",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4",
      "f6e4",
      "g1f3",
      "f8c5",
      "d1e2",
      "c8f5"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Reti Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d1e2"
    ]
  },
  {
    "eco": "C32",
    "name": "KGD, Falkbeer, Tarrasch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "d7d5",
      "e4d5",
      "e5e4",
      "d2d3",
      "g8f6",
      "d3e4",
      "f6e4",
      "g1f3",
      "f8c5",
      "d1e2",
      "c8f5",
      "g2g4",
      "e8g8"
    ]
  },
  {
  "eco": "C33",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4"]
},
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Anderssen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d7d5",
      "c4d5",
      "c7c6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Bledow Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d7d5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Boden defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "b8c6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Boren-Svenonius Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d7d5",
      "c4d5",
      "d8h4",
      "e1f1",
      "f8d6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Bryan counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "b7b5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Chigorin's attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "d7d5",
      "c4d5",
      "g7g5",
      "g2g3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Classical defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "g7g5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Classical defense, Cozio attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "g7g5",
      "d1f3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Cozio (Morphy) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "g8f6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Fraser Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "g7g5",
      "b1c3",
      "f8g7",
      "g2g3",
      "f4g3",
      "d1f3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Gifford Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d7d5",
      "c4d5",
      "d8h4",
      "e1f1",
      "g7g5",
      "g2g3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Greco Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "f8c5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Grimm attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "g7g5",
      "b1c3",
      "f8g7",
      "d2d4",
      "d7d6",
      "e4e5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Jaenisch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "g8f6",
      "b1c3",
      "c7c6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Lopez-Gianutio counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "f7f5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Maurian defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "b8c6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, McDonnell attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d8h4",
      "e1f1",
      "g7g5",
      "b1c3",
      "f8g7",
      "g2g3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Morphy Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "d7d5",
      "c4d5",
      "g8f6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "g8f6",
      "b1c3",
      "f8b4",
      "e4e5"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Ruy Lopez defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "c7c6"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Bishop's gambit, Steinitz defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "g8e7"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Breyer gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "d1f3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Carrera (Basman) gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "d1e2"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Keres (Mason-Steinitz) gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "b1c3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Lesser Bishop's (Petroff-Jaenisch-Tartakower) gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1e2"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Lopez-Gianutio counter-gambit, Hein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1c4",
      "f7f5",
      "d1e2",
      "d8h4",
      "e1d1",
      "f5e4",
      "b1c3",
      "e8d8"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Orsini gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "b2b3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Pawn's gambit (Stamma gambit)",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "h2h4"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Schurig gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "f1d3"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Tumbleweed gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "e1f2"
    ]
  },
  {
    "eco": "C33",
    "name": "KGA, Villemson (Steinitz) gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "d2d4"
    ]
  },
  {
  "eco": "C34",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3"]
},
  {
    "eco": "C34",
    "name": "KGA, Becker defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "h7h6"
    ]
  },
  {
    "eco": "C34",
    "name": "KGA, Bonsch-Osmolovsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g8e7"
    ]
  },
  {
    "eco": "C34",
    "name": "KGA, Fischer defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "d7d6"
    ]
  },
  {
    "eco": "C34",
    "name": "KGA, Gianutio counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "f7f5"
    ]
  },
  {
    "eco": "C34",
    "name": "KGA, Schallop defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g8f6"
    ]
  },
  {
    "eco": "C34",
    "name": "King's knight's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3"
    ]
  },
  {
  "eco": "C35",
  "name": "King's Gambit Accepted, Cunningham Defense",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","f8e7"]
},
  {
    "eco": "C35",
    "name": "KGA, Cunningham defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "f8e7"
    ]
  },
  {
    "eco": "C35",
    "name": "KGA, Cunningham, Bertin gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "f8e7",
      "f1c4",
      "e7h4",
      "g2g3"
    ]
  },
  {
    "eco": "C35",
    "name": "KGA, Cunningham, Euwe defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "f8e7",
      "f1c4",
      "g8f6"
    ]
  },
  {
    "eco": "C35",
    "name": "KGA, Cunningham, Three pawns gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "f8e7",
      "f1c4",
      "e7h4",
      "g2g3",
      "f4g3",
      "e1g1",
      "g3h2",
      "g1h1"
    ]
  },
  {
  "eco": "C36",
  "name": "King's Gambit Accepted, Abbazia Defense",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","d7d5"]
},
  {
    "eco": "C36",
    "name": "KGA, Abbazia defense (Classical defense, Modern defense[!])",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "d7d5"
    ]
  },
  {
    "eco": "C36",
    "name": "KGA, Abbazia defense, Botvinnik Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "d7d5",
      "e4d5",
      "g8f6",
      "f1b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "b5c4",
      "f6d5"
    ]
  },
  {
    "eco": "C36",
    "name": "KGA, Abbazia defense, Modern Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "d7d5",
      "e4d5",
      "g8f6"
    ]
  },
  {
  "eco": "C37",
  "name": "King's Gambit Accepted",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5"]
},
  {
    "eco": "C37",
    "name": "KGA, Blachly gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "b8c6"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Cochrane gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "f3e5",
      "d8h4",
      "e1f1",
      "f4f3"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, double Muzio gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "g4f3",
      "d1f3",
      "d8f6",
      "e4e5",
      "f6e5",
      "c4f7"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Ghulam Kassim gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "d2d4"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Herzfeld gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "f3e5",
      "d8h4",
      "e1f1",
      "b8c6"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, King's knight's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Lolli gambit (wild Muzio gambit)",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "c4f7"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Lolli gambit, Young Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "c4f7",
      "e8f7",
      "e1g1",
      "g4f3",
      "d1f3",
      "d8f6",
      "d2d4",
      "f6d4",
      "c1e3",
      "d4f6",
      "b1c3"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, MacDonnell gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "b1c3"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit, Brentano defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "d7d5"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit, From defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "g4f3",
      "d1f3",
      "d8e7"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit, Holloway defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "g4f3",
      "d1f3",
      "b8c6"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit, Kling and Horwitz counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "d8e7"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Muzio gambit, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "e1g1",
      "g4f3",
      "d1f3",
      "d8f6",
      "e4e5",
      "f6e5",
      "d2d3",
      "f8h6",
      "b1c3",
      "g8e7",
      "c1d2",
      "b8c6",
      "a1e1"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Quaade gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "b1c3"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Rosentreter gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "d2d4"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Salvio gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "f3e5"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Salvio gambit, Anderssen counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "f3e5",
      "d8h4",
      "e1f1",
      "g8h6",
      "d2d4",
      "d7d6"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Silberschmidt gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "g5g4",
      "f3e5",
      "d8h4",
      "e1f1",
      "g8h6",
      "d2d4",
      "f4f3"
    ]
  },
  {
    "eco": "C37",
    "name": "KGA, Soerensen gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "d2d4",
      "g5g4",
      "f3e5"
    ]
  },
  {
  "eco": "C38",
  "name": "King's Gambit Accepted, Hanstein Gambit",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5","f1c4"]
},
  {
    "eco": "C38",
    "name": "KGA, Greco gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "f8g7",
      "h2h4",
      "h7h6",
      "d2d4",
      "d7d6",
      "b1c3",
      "c7c6",
      "h4g5",
      "h6g5",
      "h1h8",
      "g7h8",
      "f3e5"
    ]
  },
  {
    "eco": "C38",
    "name": "KGA, Hanstein gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "f8g7",
      "e1g1"
    ]
  },
  {
    "eco": "C38",
    "name": "KGA, Philidor gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "f8g7",
      "h2h4"
    ]
  },
  {
    "eco": "C38",
    "name": "KGA, Philidor gambit, Schultz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "f8g7",
      "h2h4",
      "h7h6",
      "d2d4",
      "d7d6",
      "d1d3"
    ]
  },
  {
    "eco": "C38",
    "name": "King's knight's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "f1c4",
      "f8g7"
    ]
  },
  {
  "eco": "C39",
  "name": "King's Gambit Accepted, Kieseritzky Gambit",
  "moves": ["e2e4","e7e5","f2f4","e5f4","g1f3","g7g5","h2h4"]
},
  {
    "eco": "C39",
    "name": "KGA, Allgaier gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Blackburne gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "b1c3"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Cook Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "d2d4",
      "d7d5",
      "c1f4",
      "d5e4",
      "f1c4",
      "f7g7",
      "f4e5"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Horny defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "d1g4",
      "g8f6",
      "g4f4",
      "f8d6"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Schlechter defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "g8f6"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, ThorOld Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "d2d4"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Urusov attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "f1c4",
      "d7d5",
      "c4d5",
      "f7g7",
      "d2d4"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Allgaier, Walker attack",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3g5",
      "h7h6",
      "g5f7",
      "e8f7",
      "f1c4"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Berlin defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "g8f6"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Berlin defense, 6.Bc4",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "g8f6",
      "f1c4"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Berlin defense, Riviere Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "g8f6",
      "e5g4",
      "d7d5"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Brentano (Campbell) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d7d5"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Brentano defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d7d5",
      "d2d4",
      "g8f6",
      "c1f4"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Brentano defense, Caro Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d7d5",
      "d2d4",
      "g8f6",
      "c1f4",
      "f6e4",
      "b1d2"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Brentano defense, Kaplanek Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d7d5",
      "d2d4",
      "g8f6",
      "e4d5",
      "d8d5",
      "b1c3",
      "f8b4",
      "e1f2"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Kolisch defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d7d6"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, long whip (Stockwhip, Classical) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "h7h5"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, long whip defense, Jaenisch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "h7h5",
      "f1c4",
      "h8h7",
      "d2d4",
      "f8h6",
      "b1c3"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Neumann defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "b8c6"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Paulsen defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "f8g7"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Polerio defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "f8e7"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Rice gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "g8f6",
      "f1c4",
      "d7d5",
      "e4d5",
      "f8d6",
      "e1g1"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Salvio (Rosenthal) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d8e7"
    ]
  },
  {
    "eco": "C39",
    "name": "KGA, Kieseritsky, Salvio defense, Cozio Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4",
      "g5g4",
      "f3e5",
      "d8e7",
      "d2d4",
      "f7f5",
      "f1c4"
    ]
  },
  {
    "eco": "C39",
    "name": "King's knight's gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "f2f4",
      "e5f4",
      "g1f3",
      "g7g5",
      "h2h4"
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
  "eco": "C40",
  "name": "King's Knight Opening",
  "moves": ["e2e4","e7e5","g1f3"]
},
  {
    "eco": "C40",
    "name": "Damiano's defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "f7f6"
    ]
  },
  {
    "eco": "C40",
    "name": "Greco defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d8f6"
    ]
  },
  {
    "eco": "C40",
    "name": "Gunderam defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d8e7"
    ]
  },
  {
    "eco": "C40",
    "name": "Latvian, Fraser defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "f7f5",
      "f3e5",
      "b8c6"
    ]
  },
  {
  "name": "Petrov Defense: Stafford Gambit",
  "eco": "C41",
  "moves": ["e2e4","e7e5","g1f3","g8f6","f3e5","b8c6"],
  "normalized": "petrov defense stafford gambit",
  "loose": "stafford gambit"
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
  "eco": "C41",
  "name": "Philidor Defense",
  "moves": ["e2e4","e7e5","g1f3","d7d6"]
},
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Kmoch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d7d6",
      "d2d4",
      "b8d7",
      "f1c4",
      "c7c6",
      "f3g5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Hanham, Steiner Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d7d6",
      "d2d4",
      "b8d7",
      "f1c4",
      "c7c6",
      "e1g1",
      "f8e7",
      "d4e5"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor, Nimzovich (Jaen 3    Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d7d6",
      "d2d4",
      "g8f6"
    ]
  },
  {
    "eco": "C41",
    "name": "Philidor's defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "d7d6"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov's defence",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1f6"
    ]
  },
  {
  "eco": "C42",
  "name": "Petrov Defense",
  "moves": ["e2e4","e7e5","g1f3","g8f6"]
},
  {
    "eco": "C42",
    "name": "Petrov Three knights game",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Berger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "b8c6",
      "f1e1",
      "c8g4",
      "c2c3",
      "f7f5",
      "b1d2"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Chigorin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "b8c6",
      "f1e1"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, close Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "e4f6"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Jaenisch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "b8c6",
      "c2c4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Krause Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "b8c6",
      "f1e1",
      "c8g4",
      "c2c3",
      "f7f5",
      "c3c4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Maroczy Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "b8c6",
      "f1e1",
      "c8g4",
      "c2c3",
      "f7f5",
      "c3c4",
      "e7h4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Marshall trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8d6",
      "e1g1",
      "e8g8",
      "c2c4",
      "c8g4",
      "c4d5",
      "f7f5",
      "f1e1",
      "d6h2"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Marshall Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8d6"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Mason Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8e7",
      "e1g1",
      "e8g8"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Classical attack, Tarrasch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d4",
      "d6d5",
      "f1d3",
      "f8d6",
      "e1g1",
      "e8g8",
      "c2c4",
      "c8g4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Cochrane gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f7"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Cozio (Lasker) attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d1e2"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Damiano Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "f6e4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, French attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "d2d3"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Italian Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f1c4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Kaufmann attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "c2c4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Nimzovich attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5f3",
      "f6e4",
      "b1c3"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov, Paulsen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "f3e5",
      "d7d6",
      "e5c4"
    ]
  },
  {
    "eco": "C42",
    "name": "Petrov's defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6"
    ]
  },
  {
  "eco": "C42",
  "name": "Russian defence: (Petroff's)",
  "moves": [
    "e2e4","e7e5","g1f3","g8f6"
  ]
},
  {
  "eco": "C42",
  "name": "Russian defence: (Petroff's) Lichtehein variation",
  "moves": [
    "e2e4","e7e5","g1f3","g8f6","f3e5","d8e7"
  ]
},
  {
  "eco": "C42",
  "name": "Russian defence: (Petroff's)",
  "moves": [
    "e2e4","e7e5","g1f3","g8f6"
  ]
},
  {
  "eco": "C42",
  "name": "Russian defence: (Petroff's) Lichtehein variation",
  "moves": [
    "e2e4","e7e5","g1f3","g8f6","f3e5","d8e7"
  ]
},
  {
  "eco": "C43",
  "name": "Petrov, Modern Attack",
  "moves": ["e2e4","e7e5","g1f3","g8f6","d2d4"]
},
  {
    "eco": "C43",
    "name": "Petrov, Modern (Steinitz) attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Modern attack, Bardeleben Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "f6e4",
      "d1e2",
      "e4c5",
      "f3d4",
      "b8c6"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Modern attack, Main line",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "f6e4",
      "d1d4"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Modern attack, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "f6e4",
      "d1e2"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Modern attack, Symmetrical Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "f6e4"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Modern attack, Trifunovic Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "f6e4",
      "f1d3",
      "d7d5",
      "f3e5",
      "f8d6",
      "e1g1",
      "e8g8",
      "c2c4",
      "d6e5"
    ]
  },
  {
    "eco": "C43",
    "name": "Petrov, Urusov gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "g8f6",
      "d2d4",
      "e5d4",
      "f1c4"
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
  "eco": "C44",
  "name": "King's Pawn Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6"]
},
  {
    "eco": "C44",
    "name": "Ponziani, Fraser defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "c2c3",
      "g8f6",
      "d2d4",
      "f6e4",
      "d4d5",
      "f8c5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Benima defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "d2d4",
      "e5d4",
      "f1c4",
      "f8e7"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Cochrane-Shumov defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "d2d4",
      "e5d4",
      "f1c4",
      "f8c5",
      "f3g5",
      "g8h6",
      "g5f7",
      "h6f7",
      "c4f7",
      "e8f7",
      "d1h5",
      "g7g6",
      "h5c5",
      "d7d5"
    ]
  },
  {
    "eco": "C44",
    "name": "Scotch gambit, Dubois-Reti defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "d2d4",
      "e5d4",
      "f1c4",
      "g8f6"
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
  "eco": "C45",
  "name": "Scotch Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","d2d4"]
},
  {
    "eco": "C45",
    "name": "Scotch, Paulsen, Gunsberg defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "d2d4",
      "e5d4",
      "f3d4",
      "f8c5",
      "c1e3",
      "d8f6",
      "c2c3",
      "g8e7",
      "f1b5",
      "c6d8"
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
  "eco": "C46",
  "name": "Three Knights Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3"]
},
  {
    "eco": "C46",
    "name": "Three knights, Winawer defense (Gothic defense)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "f7f5"
    ]
  },
  {
    "eco": "C47",
    "name": "Four knights, Scotch variation",
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
  "eco": "C47",
  "name": "Four Knights Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6"]
},
  {
    "eco": "C47",
    "name": "Four knights, Belgrade gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d5"
    ]
  },
  {
    "eco": "C47",
    "name": "Four knights, Scotch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "d2d4"
    ]
  },
  {
    "eco": "C47",
    "name": "Four knights, Scotch, 4...exd4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "d2d4",
      "e5d4"
    ]
  },
  {
    "eco": "C47",
    "name": "Four knights, Scotch, Krause Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "d2d4",
      "f8b4",
      "f3e5"
    ]
  },
  {
  "eco": "C47",
  "name": "Four knights: Scotch (4...exd4 5.Nxd4)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","d2d4","e5d4","f3d4"
  ]
},
{
  "name": "Four Knights Game: Halloween Gambit",
  "eco": "C47",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6","c3d5"],
  "normalized": "four knights game halloween gambit",
  "loose": "halloween gambit"
},
  {
  "eco": "C48",
  "name": "Four Knights, Spanish Variation",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6","f1b5"]
},
  {
    "eco": "C48",
    "name": "Four knights, Bardeleben Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8c5",
      "e1g1",
      "e8g8",
      "f3e5",
      "c6e5",
      "d2d4",
      "c5d6",
      "f2f4",
      "e5c6",
      "e4e5",
      "d6b4"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Marshall Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8c5",
      "e1g1",
      "e8g8",
      "f3e5",
      "c6d4"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Ranken Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "a7a6",
      "b5c6"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit Maroczy Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4",
      "b5e2",
      "d4f3",
      "e2f3",
      "f8c5",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c3a4",
      "c5b6"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit, 5.Be2",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4",
      "b5e2"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4",
      "f3e5",
      "d8e7",
      "f2f4"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit, Exchange Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4",
      "f3d4"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Rubinstein counter-gambit, Henneberger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "c6d4",
      "e1g1"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Spanish, Classical defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8c5"
    ]
  },
  {
    "eco": "C48",
    "name": "Four knights, Spielmann Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "f3e5",
      "f6e4",
      "c3e4",
      "d8d4",
      "e1g1",
      "d4e5",
      "f1e1",
      "c8e6",
      "d2d4",
      "e5d5"
    ]
  },
  {
  "eco": "C48",
  "name": "Four knights: Ioseliani–Glek variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3"
  ]
},
  {
  "eco": "C48",
  "name": "Ruy Lopez: four knights (Tarrasch) variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","b5c6","d7c6","d2d3"
  ]
},
  {
  "eco": "C49",
  "name": "Four Knights, Double Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","b1c3","g8f6","f1b5","f8b4"]
},
  {
    "eco": "C49",
    "name": "Four knights",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "b4c3"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Alatortsev Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d8e7",
      "c3e2",
      "d7d5"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Gunsberg counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "c3d5",
      "f6d5",
      "e4d5",
      "e5e4"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Janowski Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "b4c3",
      "b2c3",
      "d7d6",
      "f1e1"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Nimzovich (Paulsen) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "b5c6"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Svenonius Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "b4c3",
      "b2c3",
      "d7d5"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Blake Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c1g5",
      "c6e7",
      "f3h4",
      "c7c6",
      "b5c4",
      "d6d5",
      "c4b3",
      "d8d6"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Capablanca Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c1g5",
      "b4c3",
      "b2c3",
      "d8e7",
      "f1e1",
      "c6d8",
      "d3d4",
      "c8g4"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Maroczy system",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c3e2"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Metger unpin",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c1g5",
      "b4c3",
      "b2c3",
      "d8e7"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Pillsbury Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c1g5",
      "c6e7"
    ]
  },
  {
    "eco": "C49",
    "name": "Four knights, Symmetrical, Tarrasch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "b1c3",
      "g8f6",
      "f1b5",
      "f8b4",
      "e1g1",
      "e8g8",
      "d2d3",
      "d7d6",
      "c1g5",
      "c8e6"
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
  "eco": "C50",
  "name": "Italian Game",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4"]
},
  {
    "eco": "C50",
    "name": "Hungarian defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8e7"
    ]
  },
  {
    "eco": "C50",
    "name": "Hungarian defense, Tartakower Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8e7",
      "d2d4",
      "e5d4",
      "c2c3",
      "g8f6",
      "e4e5",
      "f6e4"
    ]
  },
  {
    "eco": "C50",
    "name": "King's pawn game",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit",
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
  "eco": "C51",
  "name": "Evans Gambit Declined",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","b2b4","c5b6"]
},
  {
    "eco": "C51",
    "name": "Evans counter-gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "d7d5"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, 5.a4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "a2a4"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Cordel Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "c1b2"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Hicken Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "b4b5",
      "c6a5",
      "f3e5",
      "d8g5",
      "d1f3",
      "g5e5",
      "f3f7",
      "e8d8",
      "c1b2"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Hirschbach Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "b4b5",
      "c6a5",
      "f3e5",
      "d8g5"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Lange Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "b4b5",
      "c6a5",
      "f3e5",
      "g8h6"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Pavlov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "b4b5",
      "c6a5",
      "f3e5",
      "g8h6",
      "d2d4",
      "d7d6",
      "c1h6",
      "d6e5",
      "h6g7",
      "h8g8",
      "c4f7",
      "e8f7",
      "g7e5",
      "d8g5",
      "b1d2"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Showalter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "a2a4",
      "a7a6",
      "b1c3"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit declined, Vasquez Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b6",
      "b4b5",
      "c6a5",
      "f3e5",
      "d8g5",
      "c4f7",
      "e8e7",
      "d1h5"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, 5...Be7",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4e7"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Cordel Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4e7",
      "d2d4",
      "c6a5"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Fraser attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "b1c3",
      "c8g4",
      "d1a4"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Fraser-Mortimer attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "b1c3",
      "c8g4",
      "d1a4",
      "g4d7",
      "a4b3",
      "c6a5",
      "c4f7",
      "e8f8",
      "b3c2"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Goering attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "b1c3",
      "c6a5",
      "c1g5"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Mayet defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4f8"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Morphy attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "b1c3"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, normal Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "d4d5",
      "c6a5",
      "c1b2",
      "g8e7"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "b1c3",
      "c6a5",
      "c1g5",
      "f7f6",
      "g5e3"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Stone-Ware Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4d6"
    ]
  },
  {
    "eco": "C51",
    "name": "Evans gambit, Ulvestad Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4c5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d7d6",
      "c3d4",
      "c5b6",
      "d4d5",
      "c6a5",
      "c1b2"
    ]
  },
  {
  "eco": "C52",
  "name": "Evans Gambit",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","b2b4"]
},
  {
    "eco": "C52",
    "name": "Evans gambit, Alapin-Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8g4"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, compromised defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d4c3"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, compromised defense, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d4c3",
      "d1b3",
      "d8f6",
      "e4e5",
      "f6g6",
      "b1c3",
      "g8e7",
      "c1a3"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, compromised defense, Potter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "e5d4",
      "e1g1",
      "d4c3",
      "d1b3",
      "d8f6",
      "e4e5",
      "f6g6",
      "b1c3",
      "g8e7",
      "f1d1"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Lasker defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "e1g1",
      "d7d6",
      "d2d4",
      "a5b6"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Leonhardt Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "b7b5"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Levenfish Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "d7d6",
      "d1b3",
      "d8d7",
      "d4e5",
      "d6e5",
      "e1g1",
      "a5b6",
      "c1a3",
      "c6a5",
      "f3e5"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Richardson attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "e1g1",
      "g8f6",
      "d2d4",
      "e8g8",
      "f3e5"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Sanders-Alapin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Sokolsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "d7d6",
      "c1g5"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Tartakower attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "d2d4",
      "d7d6",
      "d1b3"
    ]
  },
  {
    "eco": "C52",
    "name": "Evans gambit, Waller attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "b2b4",
      "c5b4",
      "c2c3",
      "b4a5",
      "e1g1",
      "d7d6",
      "d2d4",
      "e5d4",
      "d1b3"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano",
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
  "eco": "C53",
  "name": "Giuoco Piano",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5"]
},
  {
    "eco": "C53",
    "name": "Giuoco Piano, Anderssen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "d7d5",
      "c4b5",
      "f6e4",
      "c3d4",
      "c5b4"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, Bird's attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "b2b4"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, center-hOlding Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8e7",
      "d2d4",
      "c5b6"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, close Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8e7"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, Eisinger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8e7",
      "d2d4",
      "c5b6",
      "d4d5",
      "c6b8",
      "d5d6"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, Ghulam Kassim Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "f6e4",
      "c4d5",
      "e4f2",
      "e1f2",
      "d4c3",
      "f2g3"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, LaBourdonnais Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d7d6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b6"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, Mestel Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8e7",
      "d2d4",
      "c5b6",
      "c1g5"
    ]
  },
  {
    "eco": "C53",
    "name": "Giuoco Piano, Tarrasch Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "d8e7",
      "d2d4",
      "c5b6",
      "e1g1",
      "g8f6",
      "a2a4",
      "a7a6",
      "f1e1",
      "d7d6",
      "h2h3"
    ]
  },
  {
  "eco": "C54",
  "name": "Giuoco Piano",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","c2c3"]
},
  {
    "eco": "C54",
    "name": "Giuoco Piano, Aitken Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "e4c3",
      "b2c3",
      "b4c3",
      "c1a3"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Bernstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "e4c3",
      "b2c3",
      "b4c3",
      "d1b3",
      "d7d5"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Cracow Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "e1f1"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Greco Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "e4c3"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Greco's attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Krause Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "c1d2",
      "f6e4",
      "d2b4",
      "c6b4",
      "c4f7",
      "e8f7",
      "d1b3",
      "d7d5",
      "f3e5",
      "f7f6",
      "f2f3"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Moeller (Therkatz) attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "b4c3",
      "d4d5"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Moeller, bayonet attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "b4c3",
      "d4d5",
      "c3f6",
      "f1e1",
      "c6e7",
      "e1e4",
      "d7d6",
      "g2g4"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "b4c3",
      "b2c3",
      "d7d5",
      "c1a3"
    ]
  },
  {
    "eco": "C54",
    "name": "Giuoco Piano, Therkatz-Herzog Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "f8c5",
      "c2c3",
      "g8f6",
      "d2d4",
      "e5d4",
      "c3d4",
      "c5b4",
      "b1c3",
      "f6e4",
      "e1g1",
      "b4c3",
      "d4d5",
      "c3f6",
      "f1e1",
      "c6e7",
      "e1e4",
      "d7d6",
      "c1g5",
      "f6g5",
      "f3g5",
      "e8g8",
      "g5h7"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights defence",
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
  "eco": "C55",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6"]
},
  {
    "eco": "C55",
    "name": "Giuoco piano",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "e1g1",
      "f8c5",
      "d2d4",
      "c5d4",
      "f3d4",
      "c6d4",
      "c1g5",
      "d7d6"
    ]
  },
  {
    "eco": "C55",
    "name": "Giuoco piano, Holzhausen attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "e1g1",
      "f8c5",
      "d2d4",
      "c5d4",
      "f3d4",
      "c6d4",
      "c1g5",
      "d7d6",
      "f2f4",
      "d8e7",
      "f4e5",
      "d6e5",
      "b1c3"
    ]
  },
  {
    "eco": "C55",
    "name": "Giuoco piano, Rosentreter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "e1g1",
      "f8c5",
      "d2d4",
      "c5d4",
      "f3d4",
      "c6d4",
      "c1g5",
      "h7h6",
      "g5h4",
      "g7g5",
      "f2f4"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights defense (Modern Bishop's Opening)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d3"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights defense, Keidanz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e4e5",
      "d7d5",
      "c4b5",
      "f6e4",
      "f3d4",
      "f8c5",
      "d4c6",
      "c5f2",
      "e1f1",
      "d8h4"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights defense, Perreux Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "f3g5"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Berger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "f1e1",
      "c8e6",
      "f3g5",
      "d8d5",
      "b1c3",
      "d5f5",
      "g2g4",
      "f5g6",
      "c3e4",
      "c5b6",
      "f2f4",
      "e8c8"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Krause Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "f6g4",
      "c2c3"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Loman defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "f1e1",
      "c8e6",
      "f3g5",
      "g7g6"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Marshall Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "f1e1",
      "c8e6",
      "f3g5",
      "d8d5",
      "b1c3",
      "d5f5",
      "c3e4"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "f1e1",
      "c8e6",
      "f3g5",
      "d8d5",
      "b1c3",
      "d5f5",
      "c3e4",
      "c5f8"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Schlechter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "d7d5",
      "e5f6",
      "d5c4",
      "f1e1",
      "c8e6",
      "f6g7"
    ]
  },
  {
    "eco": "C55",
    "name": "Two knights, Max Lange attack, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f8c5",
      "e4e5",
      "f6g4"
    ]
  },
  {
  "eco": "C56",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4"]
},
  {
    "eco": "C56",
    "name": "Two knights defense, Canal Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f6e4",
      "f1e1",
      "d7d5",
      "b1c3"
    ]
  },
  {
    "eco": "C56",
    "name": "Two knights defense, Yurdansky attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1",
      "f6e4",
      "f1e1",
      "d7d5",
      "c4d5",
      "d8d5",
      "b1c3",
      "d5a5",
      "c3e4",
      "c8e6",
      "c1g5",
      "h7h6",
      "g5h4",
      "g7g5",
      "e4f6",
      "e8e7",
      "b2b4"
    ]
  },
  {
  "eco": "C57",
  "name": "Two Knights Defense, Fried Liver Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","f3g5"]
},
  {
    "eco": "C57",
    "name": "Two knights defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Fegatello attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "f6d5",
      "g5f7"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Fegatello attack, Leonhardt Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "f6d5",
      "g5f7",
      "e8f7",
      "d1f3",
      "f7e6",
      "b1c3",
      "c6b4",
      "f3e4",
      "c7c6",
      "a2a3",
      "b4a6",
      "d2d4",
      "a6c7"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Fegatello attack, Polerio defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "f6d5",
      "g5f7",
      "e8f7",
      "d1f3",
      "f7e6",
      "b1c3",
      "c6e7"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Fritz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6d4"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Fritz, Gruber Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6d4",
      "c2c3",
      "b7b5",
      "c4f1",
      "f6d5",
      "g5e4"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Lolli attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "f6d5",
      "d2d4"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Pincus Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "f6d5",
      "d2d4",
      "f8b4"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Ulvestad Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "b7b5"
    ]
  },
  {
    "eco": "C57",
    "name": "Two knights defense, Wilkes Barre (Traxler) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "f8c5"
    ]
  },
  {
  "eco": "C58",
  "name": "Two Knights Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","e4e5"]
},
  {
    "eco": "C58",
    "name": "Two knights defense, Blackburne Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "d1f3",
      "c6b5"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "d1f3"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Colman Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "d1f3",
      "a8b8"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Kieseritsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "d2d3"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Maroczy Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "d2d3",
      "h7h6",
      "g5f3",
      "e5e4",
      "d1e2",
      "a5c4",
      "d3c4",
      "f8e7"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Paoli Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "d1f3",
      "d8c7",
      "b5d3"
    ]
  },
  {
    "eco": "C58",
    "name": "Two knights defense, Yankovich Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "d2d3",
      "h7h6",
      "g5f3",
      "e5e4",
      "d1e2",
      "a5c4",
      "d3c4",
      "f8c5",
      "f3d2"
    ]
  },
  {
  "eco": "C59",
  "name": "Two Knights Defense, Ponziani-Steinitz Gambit",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1c4","g8f6","d2d4","e5d4","e4e5","f6e4"]
},
  {
    "eco": "C59",
    "name": "Two knights defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "b5e2",
      "h7h6"
    ]
  },
  {
    "eco": "C59",
    "name": "Two knights defense, Goering Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "b5e2",
      "h7h6",
      "g5f3",
      "e5e4",
      "f3e5",
      "d8c7"
    ]
  },
  {
    "eco": "C59",
    "name": "Two knights defense, Knorre Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "b5e2",
      "h7h6",
      "g5f3",
      "e5e4",
      "f3e5",
      "f8d6",
      "d2d4",
      "d8c7",
      "c1d2"
    ]
  },
  {
    "eco": "C59",
    "name": "Two knights defense, Steinitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
      "g8f6",
      "f3g5",
      "d7d5",
      "e4d5",
      "c6a5",
      "c4b5",
      "c7c6",
      "d5c6",
      "b7c6",
      "b5e2",
      "h7h6",
      "g5h3"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez (Spanish opening)",
    "moves": [
      "e2e4",
      "e7e5",
      "b1f3",
      "g1c6",
      "c1b5"
    ]
  },
  {
  "eco": "C60",
  "name": "Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5"]
},
  {
    "eco": "C60",
    "name": "Ruy Lopez (Spanish Opening)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Brentano defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g7g5"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Cozio defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8e7"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Cozio defense, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8e7",
      "b1c3",
      "g7g6"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Fianchetto (Smyslov/Barnes) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g7g6"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Lucena defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8e7"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Nuernberg Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f7f6"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Pollock defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "c6a5"
    ]
  },
  {
    "eco": "C60",
    "name": "Ruy Lopez, Vinogradov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "d8e7"
    ]
  },
  {
  "eco": "C61",
  "name": "Ruy Lopez, Bird Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","d7d6"]
},
  {
    "eco": "C61",
    "name": "Ruy Lopez, Bird's defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "c6d4"
    ]
  },
  {
    "eco": "C61",
    "name": "Ruy Lopez, Bird's defense, Paulsen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "c6d4",
      "f3d4",
      "e5d4",
      "e1g1",
      "g8e7"
    ]
  },
  {
  "eco": "C62",
  "name": "Ruy Lopez, Old Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","d7d6","c2c3"]
},
  {
    "eco": "C62",
    "name": "Ruy Lopez, Old Steinitz defense, Nimzovich attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "g8f6",
      "b5c6"
    ]
  },
  {
    "eco": "C62",
    "name": "Ruy Lopez, Old Steinitz defense, Semi-Duras Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "d7d6",
      "d2d4",
      "c8d7",
      "c2c4"
    ]
  },
  {
  "eco": "C63",
  "name": "Ruy Lopez, Schliemann Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","f7f5"]
},
  {
    "eco": "C63",
    "name": "Ruy Lopez, Schliemann defense, Berger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f7f5",
      "b1c3"
    ]
  },
  {
  "eco": "C64",
  "name": "Ruy Lopez, Classical",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","f8c5"]
},
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical (Cordel) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical defense, 4.c3",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "c2c3"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical defense, Benelux Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "c2c3",
      "g8f6",
      "e1g1",
      "e8g8",
      "d2d4",
      "c5b6"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical defense, Boden Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "c2c3",
      "d8e7"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical defense, Charousek Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "c2c3",
      "c5b6"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Classical defense, Zaitsev Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "e1g1",
      "c6d4",
      "b2b4"
    ]
  },
  {
    "eco": "C64",
    "name": "Ruy Lopez, Cordel gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "f8c5",
      "c2c3",
      "f7f5"
    ]
  },
  {
  "eco": "C65",
  "name": "Ruy Lopez, Berlin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6"]
},
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, 4.O-O",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Anderssen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d3",
      "d7d6",
      "b5c6"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Beverwijk Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f8c5"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Duras Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d3",
      "d7d6",
      "c2c4"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Kaufmann Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d3",
      "f8c5",
      "c1e3"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Mortimer trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d3",
      "c6e7",
      "f3e5",
      "c7c6"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Mortimer Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d3",
      "c6e7"
    ]
  },
  {
    "eco": "C65",
    "name": "Ruy Lopez, Berlin defense, Nyholm attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "d2d4",
      "e5d4",
      "e1g1"
    ]
  },
  {
  "eco": "C66",
  "name": "Ruy Lopez, Berlin Defense, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3"]
},
  {
    "eco": "C66",
    "name": "Ruy Lopez, Berlin defense, 4.O-O, d6",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Berlin defense, hedgehog Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "f8e7"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Berlin defense, Tarrasch trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "f8e7",
      "f1e1",
      "e8g8"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Closed Berlin defense, Bernstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "f8e7",
      "c1g5"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Closed Berlin defense, Chigorin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "f6d7"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Closed Berlin defense, Showalter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "f8e7",
      "b5c6"
    ]
  },
  {
    "eco": "C66",
    "name": "Ruy Lopez, Closed Berlin defense, Wolf Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "d7d6",
      "d2d4",
      "c8d7",
      "b1c3",
      "e5d4"
    ]
  },
  {
  "eco": "C67",
  "name": "Ruy Lopez, Berlin Defense, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","e1g1","f6e4"]
},
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Cordel Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "e4d6",
      "b5c6",
      "b7c6",
      "d4e5",
      "d6f5"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Minckwitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d4e5"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Open Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Pillsbury Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "e4d6",
      "b5c6",
      "b7c6",
      "d4e5",
      "d6b7",
      "b2b3"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Rio de Janeiro Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "e4d6",
      "b5c6",
      "b7c6",
      "d4e5",
      "d6b7",
      "b1c3",
      "e8g8",
      "f1e1",
      "b7c5",
      "f3d4",
      "c5e6",
      "c1e3",
      "e6d4",
      "e3d4",
      "c6c5"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Rosenthal Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "a7a6"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Trifunovic Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "d7d5"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Winawer attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "e4d6",
      "b5c6",
      "b7c6",
      "d4e5",
      "d6b7",
      "f3d4"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Berlin defense, Zukertort Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7",
      "d1e2",
      "e4d6",
      "b5c6",
      "b7c6",
      "d4e5",
      "d6b7",
      "c2c4"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Open Berlin defense, 5...Be7",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "f8e7"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Open Berlin defense, l'Hermet Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "e4d6",
      "d4e5"
    ]
  },
  {
    "eco": "C67",
    "name": "Ruy Lopez, Open Berlin defense, Showalter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "e4d6",
      "b5a4"
    ]
  },
  {
  "eco": "C68",
  "name": "Ruy Lopez, Exchange Variation",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6"]
},
  {
    "eco": "C68",
    "name": "Ruy Lopez, Exchange, Alekhine Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "d2d4",
      "e5d4",
      "d1d4",
      "d8d4",
      "f3d4",
      "c8d7"
    ]
  },
  {
    "eco": "C68",
    "name": "Ruy Lopez, Exchange, Keres Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "b1c3"
    ]
  },
  {
    "eco": "C68",
    "name": "Ruy Lopez, Exchange, Romanovsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "b1c3",
      "f7f6",
      "d2d3"
    ]
  },
  {
  "eco": "C68",
  "name": "Ruy Lopez: exchange variation doubly deferred",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6","d7c6","d2d4","e5d4"
  ]
},
  {
  "eco": "C68",
  "name": "Ruy Lopez: exchange, Pachman–Romanishin variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6","d7c6","d2d4","e5d4","d1d4","d8d4","f3d4","c8d7"
  ]
},
  {
  "eco": "C68",
  "name": "Ruy Lopez: Treybal (Bayreuth) variation (exchange deferred)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6","d7c6","d2d3","f8d6"
  ]
},
  {
  "eco": "C69",
  "name": "Ruy Lopez, Exchange Variation, 5.O-O",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5c6","d7c6","e1g1"]
},
  {
    "eco": "C69",
    "name": "Ruy Lopez, Exchange Variation , 5.O-O",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "e1g1"
    ]
  },
  {
    "eco": "C69",
    "name": "Ruy Lopez, Exchange Variation , Alapin gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "e1g1",
      "c8g4",
      "h2h3",
      "h7h5"
    ]
  },
  {
    "eco": "C69",
    "name": "Ruy Lopez, Exchange, Bronstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "e1g1",
      "d8d6"
    ]
  },
  {
    "eco": "C69",
    "name": "Ruy Lopez, Exchange, Gligoric Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5c6",
      "d7c6",
      "e1g1",
      "f7f6"
    ]
  },
  {
  "eco": "C70",
  "name": "Ruy Lopez",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6"]
},
  {
    "eco": "C70",
    "name": "Ruy Lopez, Alapin's defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "f8b4"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Bird's defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "c6d4"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Caro Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "b7b5"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Classical defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "f8c5"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Cozio defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8e7"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Fianchetto defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g7g6"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Graz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "b7b5",
      "a4b3",
      "f8c5"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Schliemann defense deferred",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "f7f5"
    ]
  },
  {
    "eco": "C70",
    "name": "Ruy Lopez, Taimanov (chase/wing/Accelerated counterthrust) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "b7b5",
      "a4b3",
      "c6a5"
    ]
  },
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, modern line",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","f8c5"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, Schmid variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","c6d4"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, Taimanov variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","f8b4"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, Vienna hybrid",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","c7c6"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, delayed exchange",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","a7a6","b5c6"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, anti-Berlin structure",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","f6g4"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, quiet system",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","h7h6"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, flexible line",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","d7d6"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early c3",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","c2c3"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early a4",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","a2a4"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early Bg5",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","c8g4"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early Nd2",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","b1d2"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early Nc3",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","b1c3"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: Graz, early O-O",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","g8f6","d2d3","e1g1"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: modern Steinitz defence, fianchetto (Bronstein)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g7g6"
  ]
},
  {
  "eco": "C70",
  "name": "Ruy Lopez: modern Steinitz defence, Rubinstein–Geller variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","f8e7","d2d4","b7b5","a4c2","c8g4"
  ]
},
  {
  "eco": "C71",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6"]
},
  {
    "eco": "C71",
    "name": "Ruy Lopez, Modern Steinitz defense, Duras (Keres) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "c2c4"
    ]
  },
  {
    "eco": "C71",
    "name": "Ruy Lopez, Modern Steinitz defense, Three knights Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "b1c3"
    ]
  },
  {
    "eco": "C71",
    "name": "Ruy Lopez, Noah's ark trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "d2d4",
      "b7b5",
      "a4b3",
      "c6d4",
      "f3d4",
      "e5d4",
      "d1d4",
      "c7c5"
    ]
  },
  {
  "eco": "C72",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3"]
},
  {
    "eco": "C72",
    "name": "Ruy Lopez, Modern Steinitz defense, 5.O-O",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "e1g1"
    ]
  },
  {
  "eco": "C73",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6"]
},
  {
    "eco": "C73",
    "name": "Ruy Lopez, Modern Steinitz defense, Alapin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "a4c6",
      "b7c6",
      "d2d4",
      "f7f6"
    ]
  },
  {
    "eco": "C73",
    "name": "Ruy Lopez, Modern Steinitz defense, Richter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "a4c6",
      "b7c6",
      "d2d4"
    ]
  },
  {
  "eco": "C74",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4"]
},
  {
    "eco": "C74",
    "name": "Ruy Lopez, Modern Steinitz defense, siesta Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "c2c3",
      "f7f5"
    ]
  },
  {
    "eco": "C74",
    "name": "Ruy Lopez, Siesta, Kopayev Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "c2c3",
      "f7f5",
      "e4f5",
      "c8f5",
      "e1g1"
    ]
  },
  {
  "eco": "C75",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4","b7b5"]
},
  {
    "eco": "C75",
    "name": "Ruy Lopez, Modern Steinitz defense, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "c2c3",
      "c8d7",
      "d2d4",
      "g8e7"
    ]
  },
  {
  "eco": "C76",
  "name": "Ruy Lopez, Modern Steinitz Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","d7d6","c2c3","g8f6","d2d4","b7b5","a4b3"]
},
  {
    "eco": "C76",
    "name": "Ruy Lopez, Modern Steinitz defense, Fianchetto (Bronstein) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "d7d6",
      "c2c3",
      "c8d7",
      "d2d4",
      "g7g6"
    ]
  },
  {
  "eco": "C77",
  "name": "Ruy Lopez, Morphy Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6"]
},
  {
    "eco": "C77",
    "name": "Ruy Lopez, Anderssen Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "d2d3"
    ]
  },
  {
    "eco": "C77",
    "name": "Ruy Lopez, Four knights (Tarr 3    Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "C77",
    "name": "Ruy Lopez, Morphy defense, Duras Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "d2d3",
      "d7d6",
      "c2c4"
    ]
  },
  {
    "eco": "C77",
    "name": "Ruy Lopez, Treybal (Bayreuth) Variation (Exchange var. deferred)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "a4c6"
    ]
  },
  {
    "eco": "C77",
    "name": "Ruy Lopez, Wormald (Alapin) attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "d1e2"
    ]
  },
  {
    "eco": "C77",
    "name": "Ruy Lopez, Wormald attack, Gruenfeld Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "d1e2",
      "b7b5",
      "a4b3",
      "f8e7",
      "d2d4",
      "d7d6",
      "c2c3",
      "c8g4"
    ]
  },
  {
  "eco": "C78",
  "name": "Ruy Lopez, Archangel Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8c5"]
},
  {
    "eco": "C78",
    "name": "Ruy Lopez, ...b5 & ...d6",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "b7b5",
      "a4b3",
      "d7d6"
    ]
  },
  {
    "eco": "C78",
    "name": "Ruy Lopez, 5.O-O",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1"
    ]
  },
  {
    "eco": "C78",
    "name": "Ruy Lopez, Archangelsk (counterthrust) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "b7b5",
      "a4b3",
      "c8b7"
    ]
  },
  {
    "eco": "C78",
    "name": "Ruy Lopez, Moeller defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8c5"
    ]
  },
  {
    "eco": "C78",
    "name": "Ruy Lopez, Rabinovich Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "b7b5",
      "a4b3",
      "d7d6",
      "f3g5",
      "d6d5",
      "e4d5",
      "c6d4",
      "f1e1",
      "f8c5",
      "e1e5",
      "e8f8"
    ]
  },
  {
    "eco": "C78",
    "name": "Ruy Lopez, Wing attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "b7b5",
      "a4b3",
      "f8e7",
      "a2a4"
    ]
  },
  {
  "eco": "C78",
  "name": "Ruy Lopez: Archangel variation",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8c5"
  ]
},
  {
  "eco": "C78",
  "name": "Ruy Lopez: Taimanov (chase wing accelerated counterthrust)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","d2d3","b7b5","a4b3","d7d6","c2c3","c8g4"
  ]
},
  {
  "eco": "C79",
  "name": "Ruy Lopez, Archangel Defense, Modern Line",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8c5","c2c3"]
},
  {
    "eco": "C79",
    "name": "Ruy Lopez, Steinitz defense deferred (Russian defense)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "d7d6"
    ]
  },
  {
    "eco": "C79",
    "name": "Ruy Lopez, Steinitz defense deferred, Boleslavsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "d7d6",
      "a4c6",
      "b7c6",
      "d2d4",
      "f6e4",
      "f1e1",
      "f7f5",
      "d4e5",
      "d6d5",
      "b1c3"
    ]
  },
  {
    "eco": "C79",
    "name": "Ruy Lopez, Steinitz defense deferred, Lipnitsky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "d7d6",
      "a4c6",
      "b7c6",
      "d2d4",
      "c8g4"
    ]
  },
  {
    "eco": "C79",
    "name": "Ruy Lopez, Steinitz defense deferred, Rubinstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "d7d6",
      "a4c6",
      "b7c6",
      "d2d4",
      "f6e4"
    ]
  },
  {
  "eco": "C80",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4"]
},
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open (Tarrasch) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, 6.d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, 6.d4 b5",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, 7.Bb3",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, 8...Be6",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, 8.de",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Berger Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "a2a4",
      "c6d4",
      "f3d4",
      "e5d4",
      "b1c3"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Bernstein Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "b1d2"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Bernstein Variation , Karpov gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "b1d2",
      "e4c5",
      "c2c3",
      "d5d4",
      "f3g5"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Friess attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "f3e5"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Harksen gambit",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "c2c4"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Knorre Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "b1c3"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Richter Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "d4d5"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Riga Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "e5d4"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Schlechter defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "a2a4",
      "c6d4"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Tartakower Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d1e2"
    ]
  },
  {
    "eco": "C80",
    "name": "Ruy Lopez, Open, Zukertort Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c6e7"
    ]
  },
  {
  "eco": "C80",
  "name": "Ruy Lopez: open (8.dxe5)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4","b7b5","a4b3","d7d5","d4e5"
  ]
},
  {
  "eco": "C81",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4"]
},
  {
    "eco": "C81",
    "name": "Ruy Lopez, Open, Howell attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "d1e2"
    ]
  },
  {
    "eco": "C81",
    "name": "Ruy Lopez, Open, Howell attack, Adam Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "d1e2",
      "f8e7",
      "c2c4"
    ]
  },
  {
    "eco": "C81",
    "name": "Ruy Lopez, Open, Howell attack, Ekstroem Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "d1e2",
      "f8e7",
      "f1d1",
      "e8g8",
      "c2c4",
      "b5c4",
      "b3c4",
      "d8d7"
    ]
  },
  {
  "eco": "C82",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4","b7b5"]
},
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, 9.c3",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, Berlin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "e4c5"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, Dilworth Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8c5",
      "b1d2",
      "e8g8",
      "b3c2",
      "e4f2"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, Italian Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8c5"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, Motzko attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8c5",
      "d1d3"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, Motzko attack, Nenarokov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8c5",
      "d1d3",
      "c6e7"
    ]
  },
  {
    "eco": "C82",
    "name": "Ruy Lopez, Open, St. Petersburg Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8c5",
      "b1d2"
    ]
  },
  {
  "eco": "C83",
  "name": "Ruy Lopez, Open",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f6e4","d2d4","b7b5","a4b3"]
},
  {
    "eco": "C83",
    "name": "Ruy Lopez, Open, 9...Be7, 10.Re1",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8e7",
      "f1e1"
    ]
  },
  {
    "eco": "C83",
    "name": "Ruy Lopez, Open, Breslau Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8e7",
      "f1e1",
      "e8g8",
      "f3d4",
      "c6e5"
    ]
  },
  {
    "eco": "C83",
    "name": "Ruy Lopez, Open, Classical defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8e7"
    ]
  },
  {
    "eco": "C83",
    "name": "Ruy Lopez, Open, Malkin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8e7",
      "b1d2",
      "e8g8",
      "d1e2"
    ]
  },
  {
    "eco": "C83",
    "name": "Ruy Lopez, Open, Tarrasch trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f6e4",
      "d2d4",
      "b7b5",
      "a4b3",
      "d7d5",
      "d4e5",
      "c8e6",
      "c2c3",
      "f8e7",
      "f1e1",
      "e8g8",
      "f3d4",
      "d8d7",
      "d4e6",
      "f7e6",
      "e1e4"
    ]
  },
  {
  "eco": "C84",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7"]
},
  {
    "eco": "C84",
    "name": "Ruy Lopez, Closed defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7"
    ]
  },
  {
    "eco": "C84",
    "name": "Ruy Lopez, Closed, Basque gambit (North Spanish Variation )",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "d2d4",
      "e5d4",
      "e4e5",
      "f6e4",
      "c2c3"
    ]
  },
  {
    "eco": "C84",
    "name": "Ruy Lopez, Closed, center attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "d2d4"
    ]
  },
  {
  "eco": "C84",
  "name": "Ruy Lopez: closed (7...h6 8.d4)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","d2d4","h7h6"
  ]
},
  {
  "eco": "C84",
  "name": "Ruy Lopez: closed centre (5...b5)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","b7b5"
  ]
},
  {
  "eco": "C84",
  "name": "Ruy Lopez: closed centre (6.d3)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","b7b5","d2d3"
  ]
},
  {
  "eco": "C84",
  "name": "Ruy Lopez: closed centre (7...Bb7)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","b7b5","d2d3","c8b7"
  ]
},
  {
  "eco": "C84",
  "name": "Ruy Lopez: closed centre (7...d6)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","b7b5","d2d3","d7d6"
  ]
},
  {
  "eco": "C85",
  "name": "Ruy Lopez, Exchange Variation Deferred",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","b5c6"]
},
  {
    "eco": "C85",
    "name": "Ruy Lopez, Exchange Variation doubly deferred (DERLD)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "a4c6"
    ]
  },
  {
  "eco": "C86",
  "name": "Ruy Lopez, Worrall Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","d2d3"]
},
  {
    "eco": "C86",
    "name": "Ruy Lopez, Worrall attack, sharp line",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "d1e2",
      "b7b5",
      "a4b3",
      "e8g8"
    ]
  },
  {
    "eco": "C86",
    "name": "Ruy Lopez, Worrall attack, solid line",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "d1e2",
      "b7b5",
      "a4b3",
      "d7d6"
    ]
  },
  {
  "eco": "C87",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1"]
},
  {
    "eco": "C87",
    "name": "Ruy Lopez, Closed, Averbach Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "d7d6"
    ]
  },
  {
  "eco": "C88",
  "name": "Ruy Lopez, Closed, 7…d6",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","d7d6"]
},
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, 7...d6, 8.d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "d7d6",
      "d2d4"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, 7...O-O",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, 8.c3",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, anti-Marshall 8.a4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "a2a4"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, Balla Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "d7d6",
      "c2c3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "a2a4"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Closed, Leonhardt Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "d7d6",
      "c2c3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "h2h3",
      "a5c6",
      "d4d5",
      "c6b8",
      "b1d2",
      "g7g5"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Noah's ark trap",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "d7d6",
      "d2d4",
      "c6d4",
      "f3d4",
      "e5d4",
      "d1d4",
      "c7c5"
    ]
  },
  {
    "eco": "C88",
    "name": "Ruy Lopez, Trajkovic counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "c8b7"
    ]
  },
  {
  "eco": "C89",
  "name": "Ruy Lopez, Marshall Attack",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d5"]
},
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall counter-attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall counter-attack, 11...c6",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "f6d5",
      "f3e5",
      "c6e5",
      "e1e5",
      "c7c6"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall, Herman Steiner Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "e5e4"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall, Kevitz Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "f6d5",
      "f3e5",
      "c6e5",
      "e1e5",
      "c7c6",
      "b3d5",
      "c6d5",
      "d2d4",
      "e7d6",
      "e5e3"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall, Main line, 12.d2d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "f6d5",
      "f3e5",
      "c6e5",
      "e1e5",
      "c7c6",
      "d2d4"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall, Main line, 14...Qh3",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "f6d5",
      "f3e5",
      "c6e5",
      "e1e5",
      "c7c6",
      "d2d4",
      "e7d6",
      "e5e1",
      "d8h4",
      "g2g3",
      "h4h3"
    ]
  },
  {
    "eco": "C89",
    "name": "Ruy Lopez, Marshall, Main line, Spassky Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d5",
      "e4d5",
      "f6d5",
      "f3e5",
      "c6e5",
      "e1e5",
      "c7c6",
      "d2d4",
      "e7d6",
      "e5e1",
      "d8h4",
      "g2g3",
      "h4h3",
      "c1e3",
      "c8g4",
      "d1d3",
      "a8e8",
      "b1d2",
      "e8e6",
      "a2a4",
      "h3h5"
    ]
  },
  {
  "eco": "C89",
  "name": "Ruy Lopez: Marshall, main line",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","d2d4","e5d4","f3d4","b7b5","a4b3","c6d4","d1d4","c7c5","d4e3","c5c4","b3c2","d7d6"
  ]
},
  {
  "eco": "C89",
  "name": "Ruy Lopez: Marshall, main line (12.d4)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","d2d4","e5d4","f3d4","b7b5","a4b3","c6d4","d1d4","c7c5","d4e3"
  ]
},
  {
  "eco": "C90",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6"]
},
  {
    "eco": "C90",
    "name": "Ruy Lopez, Closed (with ...d6)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6"
    ]
  },
  {
    "eco": "C90",
    "name": "Ruy Lopez, Closed, Lutikov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "b3c2"
    ]
  },
  {
    "eco": "C90",
    "name": "Ruy Lopez, Closed, Pilnik Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "d2d3"
    ]
  },
  {
    "eco": "C90",
    "name": "Ruy Lopez, Closed, Suetin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "a2a3"
    ]
  },
  {
  "eco": "C91",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3"]
},
  {
    "eco": "C91",
    "name": "Ruy Lopez, Closed, 9.d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "d2d4"
    ]
  },
  {
    "eco": "C91",
    "name": "Ruy Lopez, Closed, Bogolyubov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "d2d4",
      "c8g4"
    ]
  },
  {
  "eco": "C92",
  "name": "Ruy Lopez, Closed, 9.h3",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3"]
},
  {
    "eco": "C92",
    "name": "Ruy Lopez, Closed, Flohr-Zaitsev system (Lenzerheide Variation )",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c8b7"
    ]
  },
  {
    "eco": "C92",
    "name": "Ruy Lopez, Closed, Keres (9...a5) Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "a6a5"
    ]
  },
  {
    "eco": "C92",
    "name": "Ruy Lopez, Closed, Kholmov Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c8e6"
    ]
  },
  {
    "eco": "C92",
    "name": "Ruy Lopez, Closed, Ragozin-Petrosian (`Keres') Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "f6d7"
    ]
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
    "eco": "C94",
    "name": "Ruy Lopez, Closed, Breyer defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6b8"
    ]
  },
  {
  "eco": "C95",
  "name": "Ruy Lopez, Closed, Breyer Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","b8d7"]
},
  {
    "eco": "C95",
    "name": "Ruy Lopez, Closed, Breyer, 10.d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6b8",
      "d2d4"
    ]
  },
  {
    "eco": "C95",
    "name": "Ruy Lopez, Closed, Breyer, Borisenko Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6b8",
      "d2d4",
      "b8d7"
    ]
  },
  {
    "eco": "C95",
    "name": "Ruy Lopez, Closed, Breyer, Gligoric Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6b8",
      "d2d4",
      "b8d7",
      "b1d2",
      "c8b7",
      "b3c2",
      "c7c5"
    ]
  },
  {
    "eco": "C95",
    "name": "Ruy Lopez, Closed, Breyer, Simagin Variation",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6b8",
      "d2d4",
      "b8d7",
      "f3h4"
    ]
  },
  {
  "eco": "C96",
  "name": "Ruy Lopez, Closed",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7"]
},
  {
    "eco": "C96",
    "name": "Ruy Lopez, Closed (10...c5)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5"
    ]
  },
  {
    "eco": "C96",
    "name": "Ruy Lopez, Closed (8...Na5)",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2"
    ]
  },
  {
    "eco": "C96",
    "name": "Ruy Lopez, Closed, Borisenko defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "a5c6"
    ]
  },
  {
    "eco": "C96",
    "name": "Ruy Lopez, Closed, Keres (...Nd7) defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "f6d7"
    ]
  },
  {
    "eco": "C96",
    "name": "Ruy Lopez, Closed, Rossolimo defense",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c6",
      "d2d4",
      "d8c7"
    ]
  },
  {
  "eco": "C96",
  "name": "Ruy Lopez: closed, Chigorin (...cxd4)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","d2d4","e5d4"
  ]
},
  {
  "eco": "C96",
  "name": "Ruy Lopez: closed, Chigorin (...cxd4...Bb7)",
  "moves": [
    "e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","d2d4","e5d4","f1e1","c8b7"
  ]
},
  {
  "eco": "C97",
  "name": "Ruy Lopez, Closed, Chigorin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4"]
},
  {
    "eco": "C97",
    "name": "Ruy Lopez, Closed, Chigorin, Yugoslav system",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "b1d2",
      "c8d7",
      "d2f1",
      "f8e8",
      "f1e3",
      "g7g6"
    ]
  },
  {
  "eco": "C98",
  "name": "Ruy Lopez, Closed, Chigorin Defense",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4","f6d7"]
},
  {
    "eco": "C98",
    "name": "Ruy Lopez, Closed, Chigorin, 12...Nc6",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "b1d2",
      "a5c6"
    ]
  },
  {
    "eco": "C98",
    "name": "Ruy Lopez, Closed, Chigorin, Rauzer attack",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "b1d2",
      "a5c6",
      "d4c5"
    ]
  },
  {
  "eco": "C99",
  "name": "Ruy Lopez, Closed, Chigorin Defense, 12.c3",
  "moves": ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","f8e7","e1g1","b7b5","a4b3","d7d6","c2c3","e8g8","h2h3","c8b7","d2d4","f6d7","c1e3","c6a5","b3c2","c7c5","c2c3"]
},
  {
    "eco": "C99",
    "name": "Ruy Lopez, Closed, Chigorin, 12...c5d4",
    "moves": [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "e8g8",
      "c2c3",
      "d7d6",
      "h2h3",
      "c6a5",
      "b3c2",
      "c7c5",
      "d2d4",
      "d8c7",
      "b1d2",
      "c5d4",
      "c3d4"
    ]
  },
  {
  "name": "Jobava London System",
  "eco": "D00",
  "moves": ["d2d4","d7d5","b1c3","g8f6","c1f4"],
  "normalized": "jobava london system",
  "loose": "jobava london"
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
  "eco": "D00",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","d7d5"]
},
  {
    "eco": "D00",
    "name": "Blackmar-Diemer, Euwe defense",
    "moves": [
      "d2d4",
      "d7d5",
      "b1c3",
      "g8f6",
      "e2e4",
      "d5e4",
      "f2f3",
      "e4f3",
      "g1f3",
      "e7e6"
    ]
  },
  {
    "eco": "D00",
    "name": "Queen's pawn, Mason Variation , Steinitz counter-gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c1f4",
      "c7c5"
    ]
  },
  {
  "eco": "D00",
  "name": "Blackmar-Diemer: Huebsch gambit",
  "moves": [
    "d2d4","d7d5","e2e4","d5e4","f1c4","g8f6","f3e5","e7e6","c1g5"
  ]
},
  {
  "eco": "D00",
  "name": "Blackmar-Diemer: Teichmann defence",
  "moves": [
    "d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f3e2","c8f5"
  ]
},
  {
  "eco": "D00",
  "name": "Lemberger counter (Blackmar) gambit",
  "moves": [
    "d2d4","d7d5","e2e4","d5e4","b1c3","g8f6","f1g5"
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
  "eco": "D01",
  "name": "Richter-Veresov Attack",
  "moves": ["d2d4","d7d5","b1c3"]
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
  "eco": "D02",
  "name": "Queen's Pawn Game, London System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1f4"]
},
  {
    "eco": "D02",
    "name": "Queen's Bishop game",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "c1f4"
    ]
  },
  {
  "eco": "D02",
  "name": "Queen's bishop game: London System",
  "moves": [
    "d2d4","d7d5","g1f3","g8f6","c1f4"
  ]
},
  {
  "eco": "D02",
  "name": "Queen's pawn game, anti-Gruenfeld",
  "moves": [
    "d2d4","g8f6","g1f3","d7d5","c1g5","g7g6"
  ]
},
  {
  "eco": "D02",
  "name": "Queen's pawn: Andersson system",
  "moves": [
    "d2d4","g8f6","g1f3","e7e6","c1g5","h7h6","g5h4","d7d5"
  ]
},
  {
  "eco": "D02",
  "name": "Queen's pawn: Lasker fianchetto",
  "moves": [
    "d2d4","g8f6","g1f3","e7e6","g2g3","f8e7","f1g2"
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
  "eco": "D03",
  "name": "Torre Attack",
  "moves": ["d2d4","d7d5","g1f3","g8f6","c1g5"]
},
  {
    "eco": "D03",
    "name": "Torre attack (Tartakower Variation )",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "c1g5"
    ]
  },
  {
    "eco": "D04",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "b1f3",
      "g1f6",
      "e2e3"
    ]
  },
  {
  "eco": "D04",
  "name": "Queen's Pawn Game, Colle System",
  "moves": ["d2d4","d7d5","g1f3","g8f6","e2e3"]
},
  {
    "eco": "D04",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "e2e3"
    ]
  },
  {
  "eco": "D05",
  "name": "Queen's Pawn Game, Zukertort Variation",
  "moves": ["d2d4","d7d5","g1f3","g8f6","e2e3","c8f5"]
},
  {
    "eco": "D05",
    "name": "Colle system",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1d3",
      "c7c5",
      "c2c3"
    ]
  },
  {
    "eco": "D05",
    "name": "Queen's pawn game",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6"
    ]
  },
  {
    "eco": "D05",
    "name": "Queen's pawn game, Rubinstein (Colle-Zukertort) Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1d3",
      "c7c5",
      "b2b3"
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
  "eco": "D06",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4"]
},
  {
    "eco": "D06",
    "name": "QGD, Grau (Sahovic) defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c8f5"
    ]
  },
  {
    "eco": "D06",
    "name": "QGD, Marshall defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "g8f6"
    ]
  },
  {
    "eco": "D06",
    "name": "QGD, Symmetrical (Austrian) defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c5"
    ]
  },
  {
    "eco": "D07",
    "name": "Queen's Gambit Declined, Chigorin defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "b1c6"
    ]
  },
  {
  "eco": "D07",
  "name": "Queen's Gambit Declined, Chigorin Defense",
  "moves": ["d2d4","d7d5","c2c4","b8c6"]
},
  {
    "eco": "D07",
    "name": "QGD, Chigorin defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "b8c6"
    ]
  },
  {
    "eco": "D07",
    "name": "QGD, Chigorin defense, Janowski Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "b8c6",
      "b1c3",
      "d5c4",
      "g1f3"
    ]
  },
  {
  "eco": "D08",
  "name": "Queen's Gambit Declined, Albin Countergambit",
  "moves": ["d2d4","d7d5","c2c4","e7e5"]
},
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5"
    ]
  },
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit, Alapin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "g1f3",
      "b8c6",
      "b1d2"
    ]
  },
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit, Balogh Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "g1f3",
      "b8c6",
      "b1d2",
      "d8e7"
    ]
  },
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit, Janowski Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "g1f3",
      "b8c6",
      "b1d2",
      "f7f6"
    ]
  },
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit, Krenosz Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "g1f3",
      "b8c6",
      "b1d2",
      "c8g4",
      "h2h3",
      "g4f3",
      "d2f3",
      "f8b4",
      "c1d2",
      "d8e7"
    ]
  },
  {
    "eco": "D08",
    "name": "QGD, Albin counter-gambit, Lasker trap",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "e2e3",
      "f8b4",
      "c1d2",
      "d4e3"
    ]
  },
  {
  "eco": "D09",
  "name": "Queen's Gambit Declined, Albin Countergambit, Lasker Trap",
  "moves": ["d2d4","d7d5","c2c4","e7e5","d4e5","d5d4","g1f3","b8c6"]
},
  {
    "eco": "D09",
    "name": "QGD, Albin counter-gambit, 5.g3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e5",
      "d4e5",
      "d5d4",
      "g1f3",
      "b8c6",
      "g2g3"
    ]
  },
  {
  "name": "Slav Defense: Gusev Variation",
  "eco": "D10",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","d5c4","a2a4"],
  "normalized": "slav defense gusev variation",
  "loose": "slav gusev"
},
  {
    "eco": "D10",
    "name": "Queen's Gambit Declined Slav defence",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6"
    ]
  },
  {
  "eco": "D10",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6"]
},
  {
    "eco": "D10",
    "name": "QGD Slav defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6"
    ]
  },
  {
    "eco": "D10",
    "name": "QGD Slav defense, Alekhine Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1c3",
      "d5c4",
      "e2e4"
    ]
  },
  {
    "eco": "D10",
    "name": "QGD Slav defense, Exchange Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "c4d5"
    ]
  },
  {
    "eco": "D10",
    "name": "QGD Slav, Winawer counter-gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "b1c3",
      "e7e5"
    ]
  },
  {
  "eco": "D10",
  "name": "QGD Slav (with Nc3)",
  "moves": [
    "d2d4","d7d5","c2c4","c7c6","b1c3"
  ]
},
  {
  "eco": "D10",
  "name": "QGD Slav: 2...Bf5",
  "moves": [
    "d2d4","d7d5","c2c4","c8f5"
  ]
},
  {
  "eco": "D10",
  "name": "QGD Slav: 4.Qc2",
  "moves": [
    "d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","d1c2"
  ]
},
  {
  "eco": "D10",
  "name": "QGD Slav: Dutch, Slav gambit",
  "moves": [
    "d2d4","d7d5","c2c4","c7c6","g2g4"
  ]
},
  {
  "eco": "D10",
  "name": "QGD Slav: exchange, Wuss attack",
  "moves": [
    "d2d4","d7d5","c2c4","c7c6","c4d5","c6d5","c1f4"
  ]
},
  {
  "eco": "D11",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3"]
},
  {
    "eco": "D11",
    "name": "QGD Slav, 3.Nf3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3"
    ]
  },
  {
    "eco": "D11",
    "name": "QGD Slav, 4.e3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "e2e3"
    ]
  },
  {
    "eco": "D11",
    "name": "QGD Slav, Breyer Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1d2"
    ]
  },
  {
  "eco": "D12",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6"]
},
  {
    "eco": "D12",
    "name": "QGD Slav, 4.e3 Bf5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8f5"
    ]
  },
  {
    "eco": "D12",
    "name": "QGD Slav, Amsterdam Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8f5",
      "c4d5",
      "c6d5",
      "b1c3",
      "e7e6",
      "f3e5",
      "f6d7"
    ]
  },
  {
    "eco": "D12",
    "name": "QGD Slav, Exchange Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8f5",
      "c4d5",
      "c6d5",
      "b1c3"
    ]
  },
  {
    "eco": "D12",
    "name": "QGD Slav, Landau Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8f5",
      "c4d5",
      "c6d5",
      "d1b3",
      "d8c8",
      "c1d2",
      "e7e6",
      "b1a3"
    ]
  },
  {
  "eco": "D13",
  "name": "Slav Defense, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","c4d5"]
},
  {
    "eco": "D13",
    "name": "QGD Slav, Exchange Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "c4d5",
      "c6d5"
    ]
  },
  {
  "eco": "D14",
  "name": "Slav Defense, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","c4d5","c6d5"]
},
  {
    "eco": "D14",
    "name": "QGD Slav, Exchange Variation , 6.Bf4 Bf5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "c4d5",
      "c6d5",
      "b1c3",
      "b8c6",
      "c1f4",
      "c8f5"
    ]
  },
  {
    "eco": "D14",
    "name": "QGD Slav, Exchange, Trifunovic Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "c4d5",
      "c6d5",
      "b1c3",
      "b8c6",
      "c1f4",
      "c8f5",
      "e2e3",
      "e7e6",
      "d1b3",
      "f8b4"
    ]
  },
  {
  "name": "Slav Defense: Chameleon Variation",
  "eco": "D15",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","a7a6","b1c3"],
  "normalized": "slav defense chameleon variation",
  "loose": "slav chameleon"
},
{
  "name": "Slav Defense: Chebanenko Variation",
  "eco": "D15",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","a7a6"],
  "normalized": "slav defense chebanenko variation",
  "loose": "slav chebanenko"
},
  {
  "eco": "D15",
  "name": "Slav Defense",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3"]
},
  {
    "eco": "D15",
    "name": "QGD Slav accepted",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, 4.Nc3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, 5.e3 (Alekhine Variation )",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "e2e3"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, Schlechter Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "g7g6"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, Slav gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "e2e4"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, Suechting Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d8b6"
    ]
  },
  {
    "eco": "D15",
    "name": "QGD Slav, Tolush-Geller gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5"
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
  "eco": "D16",
  "name": "Slav Defense, Alapin Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4"]
},
  {
    "eco": "D16",
    "name": "QGD Slav accepted, Alapin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4"
    ]
  },
  {
    "eco": "D16",
    "name": "QGD Slav, Smyslov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "b8a6",
      "e2e4",
      "c8g4"
    ]
  },
  {
    "eco": "D16",
    "name": "QGD Slav, Soultanbeieff Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "e7e6"
    ]
  },
  {
    "eco": "D16",
    "name": "QGD Slav, Steiner Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8g4"
    ]
  },
  {
    "eco": "D17",
    "name": "Queen's Gambit Declined Slav, Czech defence",
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
  "eco": "D17",
  "name": "Slav Defense, Czech Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4"]
},
  {
    "eco": "D17",
    "name": "QGD Slav, Carlsbad Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "f3e5",
      "b8d7",
      "e5c4",
      "d8c7",
      "g2g3",
      "e7e5"
    ]
  },
  {
    "eco": "D17",
    "name": "QGD Slav, Czech defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5"
    ]
  },
  {
    "eco": "D17",
    "name": "QGD Slav, Krause attack",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "f3e5"
    ]
  },
  {
    "eco": "D17",
    "name": "QGD Slav, Wiesbaden Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "f3e5",
      "e7e6"
    ]
  },
  {
  "eco": "D18",
  "name": "Slav Defense, Czech Variation",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4","c8f5"]
},
  {
    "eco": "D18",
    "name": "QGD Slav, Dutch Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "e2e3"
    ]
  },
  {
    "eco": "D18",
    "name": "QGD Slav, Dutch, Lasker Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "e2e3",
      "b8a6"
    ]
  },
  {
  "eco": "D19",
  "name": "Slav Defense, Czech Variation, Classical",
  "moves": ["d2d4","d7d5","c2c4","c7c6","g1f3","g8f6","b1c3","d5c4","a2a4","c8f5","e2e3"]
},
  {
    "eco": "D19",
    "name": "QGD Slav, Dutch Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "e2e3",
      "e7e6",
      "f1c4",
      "f8b4",
      "e1g1"
    ]
  },
  {
    "eco": "D19",
    "name": "QGD Slav, Dutch Variation , Main line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "e2e3",
      "e7e6",
      "f1c4",
      "f8b4",
      "e1g1",
      "e8g8",
      "d1e2"
    ]
  },
  {
    "eco": "D19",
    "name": "QGD Slav, Dutch, Saemisch Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "c7c6",
      "g1f3",
      "g8f6",
      "b1c3",
      "d5c4",
      "a2a4",
      "c8f5",
      "e2e3",
      "e7e6",
      "f1c4",
      "f8b4",
      "e1g1",
      "e8g8",
      "d1e2",
      "f6e4",
      "g2g4"
    ]
  },
  {
    "eco": "D20",
    "name": "Queen's gambit accepted",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d2c4"
    ]
  },
  {
  "eco": "D20",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4"]
},
  {
    "eco": "D20",
    "name": "QGA, 3.e4",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "e2e4"
    ]
  },
  {
    "eco": "D20",
    "name": "QGA, Linares Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "e2e4",
      "c7c5",
      "d4d5",
      "g8f6",
      "b1c3",
      "b7b5"
    ]
  },
  {
    "eco": "D20",
    "name": "QGA, Schwartz defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "e2e4",
      "f7f5"
    ]
  },
  {
  "eco": "D20",
  "name": "QGA: 4.Qc2",
  "moves": [
    "d2d4","d7d5","c2c4","d5c4","d1c2"
  ]
},
  {
  "eco": "D20",
  "name": "QGA: 4.Qc2",
  "moves": [
    "d2d4","d7d5","c2c4","d5c4","d1c2"
  ]
},
  {
  "eco": "D21",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3"]
},
  {
    "eco": "D21",
    "name": "QGA, 3.Nf3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3"
    ]
  },
  {
    "eco": "D21",
    "name": "QGA, Alekhine defense, Borisenko-Furman Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "a7a6",
      "e2e4"
    ]
  },
  {
    "eco": "D21",
    "name": "QGA, Ericson Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "b7b5"
    ]
  },
  {
  "eco": "D22",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6"]
},
  {
    "eco": "D22",
    "name": "QGA, Alekhine defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "a7a6"
    ]
  },
  {
    "eco": "D22",
    "name": "QGA, Alekhine defense, Alatortsev Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "a7a6",
      "e2e3",
      "c8g4",
      "f1c4",
      "e7e6",
      "d4d5"
    ]
  },
  {
    "eco": "D22",
    "name": "QGA, Haberditz Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "a7a6",
      "e2e3",
      "b7b5"
    ]
  },
  {
  "eco": "D23",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3"]
},
  {
    "eco": "D23",
    "name": "QGA, Mannheim Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "d1a4"
    ]
  },
  {
  "eco": "D24",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5"]
},
  {
    "eco": "D24",
    "name": "QGA, 4.Nc3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "b1c3"
    ]
  },
  {
    "eco": "D24",
    "name": "QGA, Bogolyubov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "b1c3",
      "a7a6",
      "e2e4"
    ]
  },
  {
  "eco": "D25",
  "name": "Queen's Gambit Accepted, Janowski Variation",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5","f1c4"]
},
  {
    "eco": "D25",
    "name": "QGA, 4.e3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3"
    ]
  },
  {
    "eco": "D25",
    "name": "QGA, Flohr Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8e6"
    ]
  },
  {
    "eco": "D25",
    "name": "QGA, Janowsky-Larsen Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "c8g4"
    ]
  },
  {
    "eco": "D25",
    "name": "QGA, Smyslov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "g7g6"
    ]
  },
  {
  "eco": "D26",
  "name": "Queen's Gambit Accepted",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","c7c5","f1c4","e7e6"]
},
  {
    "eco": "D26",
    "name": "QGA, 4...e6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6"
    ]
  },
  {
    "eco": "D26",
    "name": "QGA, Classical Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5"
    ]
  },
  {
    "eco": "D26",
    "name": "QGA, Classical Variation , 6.O-O",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1"
    ]
  },
  {
    "eco": "D26",
    "name": "QGA, Classical, Furman Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "d1e2",
      "a7a6",
      "d4c5",
      "f8c5",
      "e1g1",
      "b8c6",
      "e3e4",
      "b7b5",
      "e4e5"
    ]
  },
  {
    "eco": "D26",
    "name": "QGA, Classical, Steinitz Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "c5d4"
    ]
  },
  {
  "eco": "D27",
  "name": "Queen's Gambit Accepted, Classical",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6"]
},
  {
    "eco": "D27",
    "name": "QGA, Classical, 6...a6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6"
    ]
  },
  {
    "eco": "D27",
    "name": "QGA, Classical, Geller Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "e3e4"
    ]
  },
  {
    "eco": "D27",
    "name": "QGA, Classical, Rubinstein Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "a2a4"
    ]
  },
  {
  "eco": "D28",
  "name": "Queen's Gambit Accepted, Classical",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6","f1c4"]
},
  {
    "eco": "D28",
    "name": "QGA, Classical, 7...b5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "d1e2",
      "b7b5"
    ]
  },
  {
    "eco": "D28",
    "name": "QGA, Classical, 7.Qe2",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "d1e2"
    ]
  },
  {
    "eco": "D28",
    "name": "QGA, Classical, Flohr Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "d1e2",
      "b7b5",
      "c4b3",
      "b8c6",
      "f1d1",
      "c5c4",
      "b3c2",
      "c6b4",
      "b1c3",
      "b4c2",
      "e2c2",
      "c8b7",
      "d4d5",
      "d8c7"
    ]
  },
  {
  "eco": "D29",
  "name": "Queen's Gambit Accepted, Classical, 7.Nc3",
  "moves": ["d2d4","d7d5","c2c4","d5c4","g1f3","g8f6","e2e3","e7e6","f1c4","c7c5","b1c3"]
},
  {
    "eco": "D29",
    "name": "QGA, Classical, 8...Bb7",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "d1e2",
      "b7b5",
      "c4b3",
      "c8b7"
    ]
  },
  {
    "eco": "D29",
    "name": "QGA, Classical, Smyslov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "d5c4",
      "g1f3",
      "g8f6",
      "e2e3",
      "e7e6",
      "f1c4",
      "c7c5",
      "e1g1",
      "a7a6",
      "d1e2",
      "b7b5",
      "c4b3",
      "c8b7",
      "f1d1",
      "b8d7",
      "b1c3",
      "f8d6"
    ]
  },
  {
    "eco": "D30",
    "name": "Queen's gambit declined",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6"
    ]
  },
  {
  "eco": "D30",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6"]
},
  {
    "eco": "D30",
    "name": "QGD",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "c1g5"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD Slav",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c7c6",
      "b1d2"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD Slav, Semmering Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c7c6",
      "b1d2",
      "b8d7",
      "f1d3",
      "c6c5"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Capablanca Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "b1d2"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Capablanca-Duras Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "c1g5",
      "h7h6"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Hastings Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "c1g5",
      "h7h6",
      "g5f6",
      "d8f6",
      "b1c3",
      "c7c6",
      "d1b3"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Spielmann Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c7c6",
      "b1d2",
      "g7g6"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Stonewall Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "e2e3",
      "c7c6",
      "b1d2",
      "f6e4",
      "f1d3",
      "f7f5"
    ]
  },
  {
    "eco": "D30",
    "name": "QGD, Vienna Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "g1f3",
      "g8f6",
      "c1g5",
      "f8b4"
    ]
  },
  {
  "eco": "D31",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3"]
},
  {
    "eco": "D31",
    "name": "QGD, 3.Nc3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Alapin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "b7b6"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Charousek (Petrosian) Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8e7"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Janowski Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "a7a6"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav, Abrahams Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6",
      "g1f3",
      "d5c4",
      "a2a4",
      "f8b4",
      "e2e3",
      "b7b5",
      "c1d2",
      "a7a5"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav, Junge Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6",
      "g1f3",
      "d5c4",
      "a2a4",
      "f8b4",
      "e2e3",
      "b7b5",
      "c1d2",
      "d8b6"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav, Koomen Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6",
      "g1f3",
      "d5c4",
      "a2a4",
      "f8b4",
      "e2e3",
      "b7b5",
      "c1d2",
      "d8e7"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav, Marshall gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6",
      "e2e4"
    ]
  },
  {
    "eco": "D31",
    "name": "QGD, Semi-Slav, Noteboom Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c6",
      "g1f3",
      "d5c4"
    ]
  },
  {
  "eco": "D32",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5"]
},
  {
    "eco": "D32",
    "name": "QGD, Tarrasch defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5"
    ]
  },
  {
    "eco": "D32",
    "name": "QGD, Tarrasch defense, 4.cd ed",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5"
    ]
  },
  {
    "eco": "D32",
    "name": "QGD, Tarrasch defense, Marshall gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "e2e4"
    ]
  },
  {
    "eco": "D32",
    "name": "QGD, Tarrasch defense, Tarrasch gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "d4c5",
      "d5d4",
      "c3a4",
      "b7b5"
    ]
  },
  {
    "eco": "D32",
    "name": "QGD, Tarrasch, von Hennig-Schara gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "c5d4"
    ]
  },
  {
  "eco": "D32",
  "name": "QGD: Tarrasch defence (6.e3)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5","e6d5","g1f3","b8c6","e2e3"
  ]
},
  {
  "eco": "D33",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5"]
},
  {
    "eco": "D33",
    "name": "QGD, Tarrasch, Folkestone (Swedish) Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "c5c4"
    ]
  },
  {
    "eco": "D33",
    "name": "QGD, Tarrasch, Prague Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6"
    ]
  },
  {
    "eco": "D33",
    "name": "QGD, Tarrasch, Schlechter-Rubinstein system",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3"
    ]
  },
  {
    "eco": "D33",
    "name": "QGD, Tarrasch, Schlechter-Rubinstein system, Rey Ardid Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "c5c4",
      "e2e4"
    ]
  },
  {
    "eco": "D33",
    "name": "QGD, Tarrasch, Wagner Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "c8g4"
    ]
  },
  {
  "eco": "D34",
  "name": "Queen's Gambit Declined, Tarrasch Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5","e6d5"]
},
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Bogolyubov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "c1g5",
      "c8e6",
      "a1c1",
      "c5c4"
    ]
  },
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Prague Variation , 7...Be7",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7"
    ]
  },
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Prague Variation , 9.Bg5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "c1g5"
    ]
  },
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Prague Variation , Normal position",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8"
    ]
  },
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Reti Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "d4c5",
      "e7c5",
      "c3a4"
    ]
  },
  {
    "eco": "D34",
    "name": "QGD, Tarrasch, Stoltz Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "c7c5",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8c6",
      "g2g3",
      "g8f6",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "c1g5",
      "c8e6",
      "a1c1",
      "b7b6"
    ]
  },
  {
  "eco": "D35",
  "name": "Queen's Gambit Declined, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","c4d5","e6d5"]
},
  {
    "eco": "D35",
    "name": "QGD, 3...Nf6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Exchange Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Exchange, chameleon Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5",
      "e6d5",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "f1d3",
      "b8d7",
      "d1c2",
      "f8e8",
      "g1e2",
      "d7f8",
      "e1c1"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Exchange, positional line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5",
      "e6d5",
      "c1g5"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Exchange, positional line, 5...c6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5",
      "e6d5",
      "c1g5",
      "c7c6"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Exchange, Saemisch Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5",
      "e6d5",
      "g1f3",
      "b8d7",
      "c1f4"
    ]
  },
  {
    "eco": "D35",
    "name": "QGD, Harrwitz attack",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1f4"
    ]
  },
  {
  "eco": "D35",
  "name": "QGD: exchange, modern line",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","c4d5","e6d5","g1f3","g8f6","c1g5"
  ]
},
  {
  "eco": "D36",
  "name": "Queen's Gambit Declined, Exchange Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","c4d5","e6d5","g1f3"]
},
  {
    "eco": "D36",
    "name": "QGD, Exchange, positional line, 6.Qc2",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c4d5",
      "e6d5",
      "c1g5",
      "c7c6",
      "d1c2"
    ]
  },
  {
  "eco": "D37",
  "name": "Queen's Gambit Declined, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5"]
},
  {
    "eco": "D37",
    "name": "QGD, 4.Nf3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3"
    ]
  },
  {
    "eco": "D37",
    "name": "QGD, Classical Variation (5.Bf4)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "f8e7",
      "c1f4"
    ]
  },
  {
  "eco": "D38",
  "name": "Queen's Gambit Declined, Ragozin Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8b4"]
},
  {
    "eco": "D38",
    "name": "QGD, Ragozin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "f8b4"
    ]
  },
  {
  "eco": "D39",
  "name": "Queen's Gambit Declined, Ragozin Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8b4","e2e3"]
},
  {
    "eco": "D39",
    "name": "QGD, Ragozin, Vienna Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "f8b4",
      "c1g5",
      "d5c4"
    ]
  },
  {
  "eco": "D40",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5"]
},
  {
    "eco": "D40",
    "name": "QGD, Semi-Tarrasch defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5"
    ]
  },
  {
    "eco": "D40",
    "name": "QGD, Semi-Tarrasch defense, Pillsbury Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c1g5"
    ]
  },
  {
    "eco": "D40",
    "name": "QGD, Semi-Tarrasch, Levenfish Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "e2e3",
      "b8c6",
      "f1d3",
      "f8d6",
      "e1g1",
      "e8g8",
      "d1e2",
      "d8e7",
      "d4c5",
      "d6c5",
      "e3e4"
    ]
  },
  {
    "eco": "D40",
    "name": "QGD, Semi-Tarrasch, Symmetrical Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "e2e3",
      "b8c6",
      "f1d3",
      "f8d6",
      "e1g1",
      "e8g8"
    ]
  },
  {
  "eco": "D40",
  "name": "QGD: semi-Tarrasch (3...c5)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","c7c5"
  ]
},
  {
  "eco": "D40",
  "name": "QGD: semi-Tarrasch (5.cxd5)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5"
  ]
},
  {
  "eco": "D40",
  "name": "QGD: semi-Tarrasch, exchange variation",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","c4d5","e6d5"
  ]
},
  {
  "eco": "D40",
  "name": "QGD: semi-Tarrasch, modern line",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","c7c5","g1f3"
  ]
},
  {
  "eco": "D41",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5","c4d5"]
},
  {
    "eco": "D41",
    "name": "QGD, Semi-Tarrasch with e3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c4d5",
      "f6d5",
      "e2e3"
    ]
  },
  {
    "eco": "D41",
    "name": "QGD, Semi-Tarrasch, 5.cd",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c4d5"
    ]
  },
  {
    "eco": "D41",
    "name": "QGD, Semi-Tarrasch, Kmoch Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "c5d4",
      "c3d4",
      "f8b4",
      "c1d2",
      "b4d2",
      "d1d2",
      "e8g8",
      "f1b5"
    ]
  },
  {
    "eco": "D41",
    "name": "QGD, Semi-Tarrasch, San Sebastian Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "c5d4",
      "c3d4",
      "f8b4",
      "c1d2",
      "d8a5"
    ]
  },
  {
  "eco": "D42",
  "name": "Queen's Gambit Declined, Semi-Tarrasch",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","c7c5","c4d5","f6d5"]
},
  {
    "eco": "D42",
    "name": "QGD, Semi-Tarrasch, 7.Bd3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c5",
      "c4d5",
      "f6d5",
      "e2e3",
      "b8c6",
      "f1d3"
    ]
  },
  {
    "eco": "D43",
    "name": "Queen's Gambit Declined semi-Slav",
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
  "eco": "D43",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6"]
},
  {
    "eco": "D43",
    "name": "QGD Semi-Slav",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6"
    ]
  },
  {
    "eco": "D43",
    "name": "QGD Semi-Slav, Hastings Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "h7h6",
      "g5f6",
      "d8f6",
      "d1b3"
    ]
  },
  {
  "eco": "D43",
  "name": "QGD: semi-Slav (5.Bg5 dxc4)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","c1g5","d5c4"
  ]
},
  {
  "eco": "D43",
  "name": "QGD: semi-Slav (Qc2/Bd3)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","d1c2","f8d6"
  ]
},
  {
  "eco": "D43",
  "name": "QGD: semi-Slav (without Nc3)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","e2e3","c7c6"
  ]
},
  {
  "eco": "D44",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3"]
},
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, 5.Bg5 dc",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Anti-Meran gambit",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5",
      "h7h6",
      "g5h4",
      "g7g5",
      "f3g5"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Anti-Meran, Alatortsev system",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5",
      "h7h6",
      "g5h4",
      "g7g5",
      "f3g5",
      "f6d5"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Anti-Meran, Lilienthal Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5",
      "h7h6",
      "g5h4",
      "g7g5",
      "f3g5",
      "h6g5",
      "h4g5",
      "b8d7",
      "g2g3"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Anti-Meran, Szabo Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5",
      "h7h6",
      "g5h4",
      "g7g5",
      "f3g5",
      "h6g5",
      "h4g5",
      "b8d7",
      "d1f3"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Botvinnik system (anti-Meran)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4"
    ]
  },
  {
    "eco": "D44",
    "name": "QGD Semi-Slav, Ekstrom Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "c1g5",
      "d5c4",
      "e2e4",
      "b7b5",
      "e4e5",
      "h7h6",
      "g5h4",
      "g7g5",
      "e5f6",
      "g5h4",
      "f3e5"
    ]
  },
  {
  "eco": "D44",
  "name": "QGD: semi-Slav, anti-Meran (4...dxc4)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","c1g5","d5c4"
  ]
},
  {
  "eco": "D44",
  "name": "QGD: semi-Slav, anti-Meran, Denker variation",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","c1g5","d5c4","e2e4","b7b5"
  ]
},
  {
  "eco": "D44",
  "name": "QGD: semi-Slav, Botvinnik system (anti-Meran with a4)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","c1g5","d5c4","e2e4","b7b5","a2a4"
  ]
},
  {
  "eco": "D45",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6"]
},
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, 5...Nd7",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7"
    ]
  },
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, 5.e3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3"
    ]
  },
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, Accelerated Meran (Alekhine Variation )",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "a7a6"
    ]
  },
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, Rubinstein (anti-Meran) system",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f3e5"
    ]
  },
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, Stoltz Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "d1c2"
    ]
  },
  {
    "eco": "D45",
    "name": "QGD Semi-Slav, Stonewall defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "f6e4",
      "f1d3",
      "f7f5"
    ]
  },
  {
  "eco": "D46",
  "name": "Queen's Gambit Declined, Semi-Slav",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3"]
},
  {
    "eco": "D46",
    "name": "QGD Semi-Slav, 6.Bd3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3"
    ]
  },
  {
    "eco": "D46",
    "name": "QGD Semi-Slav, Bogolyubov Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "f8e7"
    ]
  },
  {
    "eco": "D46",
    "name": "QGD Semi-Slav, Chigorin defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "f8d6"
    ]
  },
  {
    "eco": "D46",
    "name": "QGD Semi-Slav, Romih Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "f8b4"
    ]
  },
  {
  "eco": "D46",
  "name": "QGD: semi-Slav, Meran, Reynold's variation",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","c7c6","e2e3","b8d7","f1d3","d5c4","d3c4","b7b5"
  ]
},
  {
  "eco": "D47",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7"]
},
  {
    "eco": "D47",
    "name": "QGD Semi-Slav, 7.Bc4",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4"
    ]
  },
  {
    "eco": "D47",
    "name": "QGD Semi-Slav, Meran Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5"
    ]
  },
  {
    "eco": "D47",
    "name": "QGD Semi-Slav, Meran, Wade Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "c8b7"
    ]
  },
  {
    "eco": "D47",
    "name": "QGD Semi-Slav, neo-Meran (Lundin Variation )",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "b5b4"
    ]
  },
  {
  "eco": "D48",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7","f1d3"]
},
  {
    "eco": "D48",
    "name": "QGD Semi-Slav, Meran",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5"
    ]
  },
  {
    "eco": "D48",
    "name": "QGD Semi-Slav, Meran, 8...a6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6"
    ]
  },
  {
    "eco": "D48",
    "name": "QGD Semi-Slav, Meran, Old Main line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5"
    ]
  },
  {
    "eco": "D48",
    "name": "QGD Semi-Slav, Meran, Pirc Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "b5b4"
    ]
  },
  {
    "eco": "D48",
    "name": "QGD Semi-Slav, Meran, ReynOlds' Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "d4d5"
    ]
  },
  {
  "eco": "D49",
  "name": "Queen's Gambit Declined, Semi-Slav, Meran",
  "moves": ["d2d4","d7d5","c2c4","e7e6","b1c3","c7c6","g1f3","g8f6","e2e3","b8d7","f1d3","d5c4"]
},
  {
    "eco": "D49",
    "name": "QGD Semi-Slav, Meran, Blumenfeld Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5",
      "c5d4",
      "c3b5"
    ]
  },
  {
    "eco": "D49",
    "name": "QGD Semi-Slav, Meran, Rabinovich Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5",
      "c5d4",
      "c3b5",
      "f6g4"
    ]
  },
  {
    "eco": "D49",
    "name": "QGD Semi-Slav, Meran, Rellstab attack",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5",
      "c5d4",
      "c3b5",
      "d7e5",
      "f3e5",
      "a6b5",
      "e1g1",
      "d8d5",
      "d1e2",
      "c8a6",
      "c1g5"
    ]
  },
  {
    "eco": "D49",
    "name": "QGD Semi-Slav, Meran, Sozin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5",
      "c5d4",
      "c3b5",
      "d7e5"
    ]
  },
  {
    "eco": "D49",
    "name": "QGD Semi-Slav, Meran, Stahlberg Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "g1f3",
      "c7c6",
      "e2e3",
      "b8d7",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5",
      "c4d3",
      "a7a6",
      "e3e4",
      "c6c5",
      "e4e5",
      "c5d4",
      "c3b5",
      "d7e5",
      "f3e5",
      "a6b5",
      "d1f3"
    ]
  },
  {
    "eco": "D50",
    "name": "Queen's Gambit Declined, 4.Bg5",
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
  "eco": "D50",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3"]
},
  {
    "eco": "D50",
    "name": "QGD, 4.Bg5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5"
    ]
  },
  {
    "eco": "D50",
    "name": "QGD, Been-Koomen Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c5"
    ]
  },
  {
    "eco": "D50",
    "name": "QGD, Canal (Venice) Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c5",
      "c4d5",
      "d8b6"
    ]
  },
  {
    "eco": "D50",
    "name": "QGD, Semi-Tarrasch",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c5",
      "c4d5"
    ]
  },
  {
    "eco": "D50",
    "name": "QGD, Semi-Tarrasch, Krause Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c5",
      "g1f3",
      "c5d4",
      "f3d4",
      "e6e5",
      "d4b5",
      "a7a6",
      "d1a4"
    ]
  },
  {
    "eco": "D50",
    "name": "QGD, Semi-Tarrasch, Primitive Pillsbury Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "c7c5",
      "g1f3",
      "c5d4",
      "d1d4"
    ]
  },
  {
  "eco": "D51",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7"]
},
  {
    "eco": "D51",
    "name": "QGD",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, 4.Bg5 Nbd7",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, 5...c6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, Alekhine Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "g1f3",
      "c7c6",
      "e2e4"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, Capablanca anti-Cambridge Springs Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "a2a3"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, Manhattan Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "f8b4"
    ]
  },
  {
    "eco": "D51",
    "name": "QGD, Rochlin Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "g1f3",
      "c7c6",
      "a1c1",
      "d8a5",
      "g5d2"
    ]
  },
  {
  "eco": "D52",
  "name": "Queen's Gambit Declined, Cambridge Springs",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","b8d7","d1c2","c7c6","c3d5","e6d5","c4d5","f6d5"]
},
  {
    "eco": "D52",
    "name": "QGD",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, 7.cd",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "c4d5"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, Argentine Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "f3d2",
      "f8b4",
      "d1c2",
      "e8g8",
      "g5h4"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, Bogoljubow Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "f3d2",
      "f8b4",
      "d1c2"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, Capablanca Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "g5f6"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, Rubinstein Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "f3d2",
      "d5c4"
    ]
  },
  {
    "eco": "D52",
    "name": "QGD, Cambridge Springs defense, Yugoslav Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "b8d7",
      "e2e3",
      "c7c6",
      "g1f3",
      "d8a5",
      "c4d5",
      "f6d5"
    ]
  },
  {
  "eco": "D52",
  "name": "QGD: Cambridge Springs defence (7.cxd5)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8b4","e2e3","b8d7","c4d5"
  ]
},
  {
  "eco": "D53",
  "name": "Queen's Gambit Declined",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5"]
},
  {
    "eco": "D53",
    "name": "QGD, 4.Bg5 Be7",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7"
    ]
  },
  {
    "eco": "D53",
    "name": "QGD, 4.Bg5 Be7, 5.e3 O-O",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8"
    ]
  },
  {
    "eco": "D53",
    "name": "QGD, Lasker Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "f6e4"
    ]
  },
  {
  "eco": "D54",
  "name": "Queen's Gambit Declined, Anti-Neo-Orthodox",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6"]
},
  {
    "eco": "D54",
    "name": "QGD, Anti-neo-Orthodox Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "a1c1"
    ]
  },
  {
  "eco": "D55",
  "name": "Queen's Gambit Declined, Neo-Orthodox",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4"]
},
  {
    "eco": "D55",
    "name": "QGD, 6.Nf3",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3"
    ]
  },
  {
    "eco": "D55",
    "name": "QGD, Neo-Orthodox Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6"
    ]
  },
  {
    "eco": "D55",
    "name": "QGD, Neo-Orthodox Variation , 7.Bh4",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4"
    ]
  },
  {
    "eco": "D55",
    "name": "QGD, Neo-Orthodox Variation , 7.Bxf6",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5f6"
    ]
  },
  {
    "eco": "D55",
    "name": "QGD, Petrosian Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5f6",
      "e7f6",
      "a1c1",
      "c7c6",
      "f1d3",
      "b8d7",
      "e1g1",
      "d5c4",
      "d3c4"
    ]
  },
  {
    "eco": "D55",
    "name": "QGD, Pillsbury attack",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b7b6",
      "f1d3",
      "c8b7",
      "c4d5",
      "e6d5",
      "f3e5"
    ]
  },
  {
  "eco": "D55",
  "name": "QGD: classical variation",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7"
  ]
},
  {
  "eco": "D55",
  "name": "QGD: Neo-orthodox accelerated (5.Bg5 h6) variation",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","h7h6"
  ]
},
  {
  "eco": "D56",
  "name": "Queen's Gambit Declined, Lasker Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","e8g8"]
},
  {
    "eco": "D56",
    "name": "QGD, Lasker defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "f6e4"
    ]
  },
  {
    "eco": "D56",
    "name": "QGD, Lasker defense, Russian Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "f6e4",
      "h4e7",
      "d8e7",
      "d1c2",
      "e4f6",
      "f1d3",
      "d5c4",
      "d3c4",
      "c7c5",
      "e1g1",
      "b8c6",
      "f1d1",
      "c8d7"
    ]
  },
  {
    "eco": "D56",
    "name": "QGD, Lasker defense, Teichmann Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "f6e4",
      "h4e7",
      "d8e7",
      "d1c2"
    ]
  },
  {
  "eco": "D57",
  "name": "Queen's Gambit Declined, Lasker Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","e8g8","e2e3"]
},
  {
    "eco": "D57",
    "name": "QGD, Lasker defense, Bernstein Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "f6e4",
      "h4e7",
      "d8e7",
      "c4d5",
      "e4c3",
      "b2c3",
      "e6d5",
      "d1b3",
      "e7d6"
    ]
  },
  {
    "eco": "D57",
    "name": "QGD, Lasker defense, Main line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "f6e4",
      "h4e7",
      "d8e7",
      "c4d5",
      "e4c3",
      "b2c3"
    ]
  },
  {
  "eco": "D58",
  "name": "Queen's Gambit Declined, Tartakower Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","b7b6"]
},
  {
    "eco": "D58",
    "name": "QGD, Tartakower (Makagonov-Bondarevsky) system",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "b7b6"
    ]
  },
  {
  "eco": "D58",
  "name": "QGD: Tartakower (Kasparov–Beliavsky) system",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7","e2e3","h7h6","g5h4","e8g8","a2a3","b7b6"
  ]
},
  {
  "eco": "D58",
  "name": "QGD: Tartakower (Nikolic–Vaganian) system",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7","e2e3","h7h6","g5h4","e8g8","f1d3","b7b6"
  ]
},
  {
  "eco": "D59",
  "name": "Queen's Gambit Declined, Tartakower Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","b1c3","f8e7","c1g5","h7h6","g5h4","b7b6","e2e3"]
},
  {
    "eco": "D59",
    "name": "QGD, Tartakower (Makagonov-Bondarevsky) system, 8.cd Nxd5",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "b7b6",
      "c4d5",
      "f6d5"
    ]
  },
  {
    "eco": "D59",
    "name": "QGD, Tartakower Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "h7h6",
      "g5h4",
      "b7b6",
      "c4d5",
      "f6d5",
      "h4e7",
      "d8e7",
      "c3d5",
      "e6d5",
      "a1c1",
      "c8e6"
    ]
  },
  {
  "eco": "D60",
  "name": "Queen's Gambit Declined, Orthodox Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5"]
},
  {
    "eco": "D60",
    "name": "QGD, Orthodox defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7"
    ]
  },
  {
    "eco": "D60",
    "name": "QGD, Orthodox defense, Botvinnik Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "f1d3"
    ]
  },
  {
    "eco": "D60",
    "name": "QGD, Orthodox defense, Rauzer Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "d1b3"
    ]
  },
  {
  "eco": "D60",
  "name": "QGD: Orthodox defence, classical (13.dxe5)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7","e2e3","e8g8","g1f3","h7h6","g5h4","b8d7","f1e2","d5c4","e2c4","a7a6","e1g1","b7b5","c4d3","c8b7","d1e2","c6c5","d4c5","d7c5","d3c2","d8c7","e3e4","b5b4","c3a4","c5e4","a4b6","e4c5","b6a8","c7a5","a8c6","a5c7","c6e7","g8h7","e7d5","e6d5","e4d6","e2d3","h7g8","d3d4","c5e6","d4b6","c7b6","d6b6"
  ]
},
  {
  "eco": "D60",
  "name": "QGD: Orthodox defence, classical (13.Qb1, Maroczy)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7","e2e3","e8g8","g1f3","h7h6","g5h4","b8d7","f1e2","d5c4","e2c4","a7a6","e1g1","b7b5","c4d3","c8b7","d1b1"
  ]
},
  {
  "eco": "D60",
  "name": "QGD: Orthodox defence, classical (13.Qc2, Vidmar)",
  "moves": [
    "d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7","e2e3","e8g8","g1f3","h7h6","g5h4","b8d7","f1e2","d5c4","e2c4","a7a6","e1g1","b7b5","c4d3","c8b7","d1c2"
  ]
},
  {
  "eco": "D61",
  "name": "Queen's Gambit Declined, Orthodox Defense",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7"]
},
  {
    "eco": "D61",
    "name": "QGD, Orthodox defense, Rubinstein Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "d1c2"
    ]
  },
  {
  "eco": "D62",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3"]
},
  {
    "eco": "D62",
    "name": "QGD, Orthodox defense, 7.Qc2 c5, 8.cd (Rubinstein)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "d1c2",
      "c7c5",
      "c4d5"
    ]
  },
  {
  "eco": "D63",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8"]
},
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6"
    ]
  },
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense, 7.Rc1",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1"
    ]
  },
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense, Capablanca Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "b7b6",
      "c4d5",
      "e6d5",
      "f1b5"
    ]
  },
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense, Pillsbury attack",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "b7b6",
      "c4d5",
      "e6d5",
      "f1d3"
    ]
  },
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense, Swiss (Henneberger) Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "a7a6"
    ]
  },
  {
    "eco": "D63",
    "name": "QGD, Orthodox defense, Swiss, Karlsbad Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "a7a6",
      "c4d5"
    ]
  },
  {
  "eco": "D64",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","a2a3"]
},
  {
    "eco": "D64",
    "name": "QGD, Orthodox defense, Rubinstein attack (with Rc1)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "d1c2"
    ]
  },
  {
    "eco": "D64",
    "name": "QGD, Orthodox defense, Rubinstein attack, Gruenfeld Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "d1c2",
      "a7a6",
      "a2a3"
    ]
  },
  {
    "eco": "D64",
    "name": "QGD, Orthodox defense, Rubinstein attack, Karlsbad Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "d1c2",
      "a7a6"
    ]
  },
  {
    "eco": "D64",
    "name": "QGD, Orthodox defense, Rubinstein attack, Wolf Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "d1c2",
      "f6e4"
    ]
  },
  {
  "eco": "D65",
  "name": "Queen's Gambit Declined, Orthodox Defense, Rubinstein",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","a2a3","b8d7"]
},
  {
    "eco": "D65",
    "name": "QGD, Orthodox defense, Rubinstein attack, Main line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "d1c2",
      "a7a6",
      "c4d5"
    ]
  },
  {
  "eco": "D66",
  "name": "Queen's Gambit Declined, Orthodox Defense, Capablanca Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3"]
},
  {
    "eco": "D66",
    "name": "QGD, Orthodox defense, Bd3 line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3"
    ]
  },
  {
    "eco": "D66",
    "name": "QGD, Orthodox defense, Bd3 line, Fianchetto Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "b7b5"
    ]
  },
  {
  "eco": "D67",
  "name": "Queen's Gambit Declined, Orthodox Defense, Capablanca Variation",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7"]
},
  {
    "eco": "D67",
    "name": "QGD, Orthodox defense, Bd3 line",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7"
    ]
  },
  {
    "eco": "D67",
    "name": "QGD, Orthodox defense, Bd3 line, 11.O-O",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "e1g1"
    ]
  },
  {
    "eco": "D67",
    "name": "QGD, Orthodox defense, Bd3 line, Alekhine Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "c3e4"
    ]
  },
  {
    "eco": "D67",
    "name": "QGD, Orthodox defense, Bd3 line, Capablanca freeing manoevre",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5"
    ]
  },
  {
    "eco": "D67",
    "name": "QGD, Orthodox defense, Bd3 line, Janowski Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "h2h4"
    ]
  },
  {
  "eco": "D68",
  "name": "Queen's Gambit Declined, Orthodox Defense, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7","a1c1"]
},
  {
    "eco": "D68",
    "name": "QGD, Orthodox defense, Classical Variation",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "e1g1",
      "d5c3",
      "c1c3",
      "e6e5"
    ]
  },
  {
    "eco": "D68",
    "name": "QGD, Orthodox defense, Classical, 13.d1b1 (Maroczy)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "e1g1",
      "d5c3",
      "c1c3",
      "e6e5",
      "d1b1"
    ]
  },
  {
    "eco": "D68",
    "name": "QGD, Orthodox defense, Classical, 13.d1c2 (Vidmar)",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "e1g1",
      "d5c3",
      "c1c3",
      "e6e5",
      "d1c2"
    ]
  },
  {
  "eco": "D69",
  "name": "Queen's Gambit Declined, Orthodox Defense, Classical",
  "moves": ["d2d4","d7d5","c2c4","e7e6","g1f3","g8f6","c1g5","f8e7","e2e3","e8g8","b1c3","b8d7","a1c1","c7c6"]
},
  {
    "eco": "D69",
    "name": "QGD, Orthodox defense, Classical, 13.de",
    "moves": [
      "d2d4",
      "d7d5",
      "c2c4",
      "e7e6",
      "b1c3",
      "g8f6",
      "c1g5",
      "f8e7",
      "e2e3",
      "e8g8",
      "g1f3",
      "b8d7",
      "a1c1",
      "c7c6",
      "f1d3",
      "d5c4",
      "d3c4",
      "f6d5",
      "g5e7",
      "d8e7",
      "e1g1",
      "d5c3",
      "c1c3",
      "e6e5",
      "d4e5",
      "d7e5",
      "f3e5",
      "e7e5"
    ]
  },
  {
    "eco": "D70",
    "name": "Neo-Gruenfeld defence",
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
  "eco": "D70",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5"]
},
  {
    "eco": "D70",
    "name": "Neo-Gruenfeld (Kemeri) defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5"
    ]
  },
  {
    "eco": "D70",
    "name": "Neo-Gruenfeld defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "f2f3",
      "d7d5"
    ]
  },
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld (5.cxd5)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld (with...Nb6)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5b6"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 5.cxd5, main line",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 6.cxd5",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","g7g6","c3d5"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 6.cxd5 Nxd5 7.O-O",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","g7g6","c3d5","g8d5","g1f3","e7e6","e1g1"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 6.cxd5 Nxd5 7.O-O Nb6",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","g7g6","c3d5","g8d5","g1f3","e7e6","e1g1","d5b6"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 7...c5 8.dxc5",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","c7c5","g1f3","c5c4","d3c5"
  ]
},
  {
  "eco": "D70",
  "name": "Neo-Gruenfeld: 7...c5 8.Nc3",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","c7c5","g1f3","b8c6"
  ]
},
  {
  "eco": "D71",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5"]
},
  {
    "eco": "D71",
    "name": "Neo-Gruenfeld, 5.cd",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "c4d5",
      "f6d5"
    ]
  },
  {
  "eco": "D72",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5"]
},
  {
    "eco": "D72",
    "name": "Neo-Gruenfeld, 5.cd, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5b6",
      "g1e2"
    ]
  },
  {
  "eco": "D73",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4"]
},
  {
    "eco": "D73",
    "name": "Neo-Gruenfeld, 5.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3"
    ]
  },
  {
  "eco": "D74",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3"]
},
  {
    "eco": "D74",
    "name": "Neo-Gruenfeld, 6.cd Nxd5, 7.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "c4d5",
      "f6d5",
      "e1g1"
    ]
  },
  {
  "eco": "D75",
  "name": "Neo-Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3"]
},
  {
    "eco": "D75",
    "name": "Neo-Gruenfeld, 6.cd Nxd5, 7.O-O c5, 8.dc",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "c4d5",
      "f6d5",
      "e1g1",
      "c7c5",
      "d4c5"
    ]
  },
  {
    "eco": "D75",
    "name": "Neo-Gruenfeld, 6.cd Nxd5, 7.O-O c5, 8.Nc3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "c4d5",
      "f6d5",
      "e1g1",
      "c7c5",
      "b1c3"
    ]
  },
  {
  "eco": "D76",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3"]
},
  {
    "eco": "D76",
    "name": "Neo-Gruenfeld, 6.cd Nxd5, 7.O-O Nb6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "c4d5",
      "f6d5",
      "e1g1",
      "d5b6"
    ]
  },
  {
  "eco": "D77",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7"]
},
  {
    "eco": "D77",
    "name": "Neo-Gruenfeld, 6.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "e1g1"
    ]
  },
  {
  "eco": "D78",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5"]
},
  {
    "eco": "D78",
    "name": "Neo-Gruenfeld, 6.O-O c6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "e1g1",
      "c7c6"
    ]
  },
  {
  "eco": "D79",
  "name": "Neo-Grünfeld Defense, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5","d5c4"]
},
  {
    "eco": "D79",
    "name": "Neo-Gruenfeld, 6.O-O, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8g7",
      "g1f3",
      "e8g8",
      "e1g1",
      "c7c6",
      "c4d5",
      "c6d5"
    ]
  },
  {
    "eco": "D80",
    "name": "Gruenfeld defence",
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
  "eco": "D80",
  "name": "Grünfeld Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5"]
},
  {
    "eco": "D80",
    "name": "Gruenfeld defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5"
    ]
  },
  {
    "eco": "D80",
    "name": "Gruenfeld, Lundin Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1g5",
      "f6e4",
      "c3e4",
      "d5e4",
      "d1d2",
      "c7c5"
    ]
  },
  {
    "eco": "D80",
    "name": "Gruenfeld, Spike gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g2g4"
    ]
  },
  {
    "eco": "D80",
    "name": "Gruenfeld, Stockholm Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1g5"
    ]
  },
  {
  "eco": "D81",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5"]
},
  {
    "eco": "D81",
    "name": "Gruenfeld, Russian Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "d1b3"
    ]
  },
  {
  "eco": "D82",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5"]
},
  {
    "eco": "D82",
    "name": "Gruenfeld, 4.Bf4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1f4"
    ]
  },
  {
  "eco": "D83",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4"]
},
  {
    "eco": "D83",
    "name": "Gruenfeld, Gruenfeld gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1f4",
      "f8g7",
      "e2e3",
      "e8g8"
    ]
  },
  {
    "eco": "D83",
    "name": "Gruenfeld, Gruenfeld gambit, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1f4",
      "f8g7",
      "e2e3",
      "e8g8",
      "a1c1",
      "c7c5",
      "d4c5",
      "c8e6"
    ]
  },
  {
    "eco": "D83",
    "name": "Gruenfeld, Gruenfeld gambit, Capablanca Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1f4",
      "f8g7",
      "e2e3",
      "e8g8",
      "a1c1"
    ]
  },
  {
  "eco": "D84",
  "name": "Grünfeld Defense, Russian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3"]
},
  {
    "eco": "D84",
    "name": "Gruenfeld, Gruenfeld gambit accepted",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c1f4",
      "f8g7",
      "e2e3",
      "e8g8",
      "c4d5",
      "f6d5",
      "c3d5",
      "d8d5",
      "f4c7"
    ]
  },
  {
  "eco": "D85",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3"]
},
  {
    "eco": "D85",
    "name": "Gruenfeld, Exchange Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5"
    ]
  },
  {
    "eco": "D85",
    "name": "Gruenfeld, Modern Exchange Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "g1f3"
    ]
  },
  {
  "eco": "D85",
  "name": "Gruenfeld (...c5 dxc5)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","c7c5","d4c5"
  ]
},
  {
  "eco": "D85",
  "name": "Gruenfeld (Qb3)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","c7c5","d4d5","d8b6"
  ]
},
  {
  "eco": "D85",
  "name": "Gruenfeld: 5.e3 c6",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","e2e3","c7c6"
  ]
},
  {
  "eco": "D85",
  "name": "Gruenfeld: modern exchange (Bb5+)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","c8b5","c1d2"
  ]
},
  {
  "eco": "D86",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7"]
},
  {
    "eco": "D86",
    "name": "Gruenfeld, Exchange, Classical Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4"
    ]
  },
  {
    "eco": "D86",
    "name": "Gruenfeld, Exchange, Larsen Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "d8d7",
      "e1g1",
      "b7b6"
    ]
  },
  {
    "eco": "D86",
    "name": "Gruenfeld, Exchange, Simagin's improved Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "b8c6"
    ]
  },
  {
    "eco": "D86",
    "name": "Gruenfeld, Exchange, Simagin's lesser Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "b7b6"
    ]
  },
  {
  "eco": "D87",
  "name": "Grünfeld Defense, Exchange Variation, Spassky Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","c1e3"]
},
  {
    "eco": "D87",
    "name": "Gruenfeld, Exchange, Seville Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "c7c5",
      "e1g1",
      "b8c6",
      "c1e3",
      "c8g4",
      "f2f3",
      "c6a5",
      "c4f7"
    ]
  },
  {
    "eco": "D87",
    "name": "Gruenfeld, Exchange, Spassky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "c7c5"
    ]
  },
  {
  "eco": "D87",
  "name": "Gruenfeld: Schlechter",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4","c7c5"
  ]
},
  {
  "eco": "D88",
  "name": "Grünfeld Defense, Exchange Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4"]
},
  {
    "eco": "D88",
    "name": "Gruenfeld, Spassky Variation , Main line, 10...cd, 11.cd",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "c7c5",
      "e1g1",
      "b8c6",
      "c1e3",
      "c5d4",
      "c3d4"
    ]
  },
  {
  "eco": "D89",
  "name": "Grünfeld Defense, Exchange Variation, Simagin Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4","c7c5"]
},
  {
    "eco": "D89",
    "name": "Gruenfeld, Exchange, Sokolsky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "c7c5",
      "e1g1",
      "b8c6",
      "c1e3",
      "c5d4",
      "c3d4",
      "c8g4",
      "f2f3",
      "c6a5",
      "c4d3",
      "g4e6",
      "d4d5"
    ]
  },
  {
    "eco": "D89",
    "name": "Gruenfeld, Spassky Variation , Main line, 13.Bd3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "c4d5",
      "f6d5",
      "e2e4",
      "d5c3",
      "b2c3",
      "f8g7",
      "f1c4",
      "e8g8",
      "g1e2",
      "c7c5",
      "e1g1",
      "b8c6",
      "c1e3",
      "c5d4",
      "c3d4",
      "c8g4",
      "f2f3",
      "c6a5",
      "c4d3",
      "g4e6"
    ]
  },
  {
  "eco": "D90",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3"]
},
  {
    "eco": "D90",
    "name": "Gruenfeld, Flohr Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1a4"
    ]
  },
  {
    "eco": "D90",
    "name": "Gruenfeld, Schlechter Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "c7c6"
    ]
  },
  {
    "eco": "D90",
    "name": "Gruenfeld, Three knights Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3"
    ]
  },
  {
  "eco": "D91",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7"]
},
  {
    "eco": "D91",
    "name": "Gruenfeld, 5.Bg5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "c1g5"
    ]
  },
  {
  "eco": "D92",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5"]
},
  {
    "eco": "D92",
    "name": "Gruenfeld, 5.Bf4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "c1f4"
    ]
  },
  {
  "eco": "D93",
  "name": "Grünfeld Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","g1f3","f8g7","c1g5","d5c4"]
},
  {
    "eco": "D93",
    "name": "Gruenfeld with Bf4    e3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "c1f4",
      "e8g8",
      "e2e3"
    ]
  },
  {
  "eco": "D94",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3"]
},
  {
    "eco": "D94",
    "name": "Gruenfeld with e3    Bd3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "f1d3"
    ]
  },
  {
    "eco": "D94",
    "name": "Gruenfeld, 5.e3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3"
    ]
  },
  {
    "eco": "D94",
    "name": "Gruenfeld, Flohr defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "f1d3",
      "c7c6",
      "e1g1",
      "c8f5"
    ]
  },
  {
    "eco": "D94",
    "name": "Gruenfeld, Makogonov Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "b2b4"
    ]
  },
  {
    "eco": "D94",
    "name": "Gruenfeld, Opovcensky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "c1d2"
    ]
  },
  {
    "eco": "D94",
    "name": "Gruenfeld, Smyslov defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "f1d3",
      "c7c6",
      "e1g1",
      "c8g4"
    ]
  },
  {
  "eco": "D95",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7"]
},
  {
    "eco": "D95",
    "name": "Gruenfeld with e3 & Qb3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "d1b3"
    ]
  },
  {
    "eco": "D95",
    "name": "Gruenfeld, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "d1b3",
      "e7e6"
    ]
  },
  {
    "eco": "D95",
    "name": "Gruenfeld, Pachman Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "e2e3",
      "e8g8",
      "d1b3",
      "d5c4",
      "f1c4",
      "b8d7",
      "f3g5"
    ]
  },
  {
  "eco": "D96",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2"]
},
  {
    "eco": "D96",
    "name": "Gruenfeld, Russian Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3"
    ]
  },
  {
  "eco": "D97",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5"]
},
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian Variation with e4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4"
    ]
  },
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian, Alekhine (Hungarian) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "a7a6"
    ]
  },
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian, Byrne (Simagin) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "b8c6"
    ]
  },
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian, Levenfish Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "b7b6"
    ]
  },
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian, Prins Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "b8a6"
    ]
  },
  {
    "eco": "D97",
    "name": "Gruenfeld, Russian, Szabo (Boleslavsky) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "c7c6"
    ]
  },
  {
  "eco": "D97",
  "name": "Gruenfeld: Spassky variation, main line (10...cxd4 11.cxd4)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5","c4d5","f6d5","e2e4","d5c3","b2c3","f8g7","f1c4","c7c5",
    "g1f3","c5d4","c3d4"
  ]
},
  {
  "eco": "D98",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5","c4d5"]
},
  {
    "eco": "D98",
    "name": "Gruenfeld, Russian, Keres Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "c8g4",
      "c1e3",
      "f6d7",
      "f1e2",
      "d7b6",
      "c4d3",
      "b8c6",
      "e1c1"
    ]
  },
  {
    "eco": "D98",
    "name": "Gruenfeld, Russian, Smyslov Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "c8g4"
    ]
  },
  {
  "eco": "D99",
  "name": "Grünfeld Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d5","c4d5","f6d5"]
},
  {
    "eco": "D99",
    "name": "Gruenfeld defense, Smyslov, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "c8g4",
      "c1e3",
      "f6d7",
      "c4b3"
    ]
  },
  {
    "eco": "D99",
    "name": "Gruenfeld defense, Smyslov, Yugoslav Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "d7d5",
      "g1f3",
      "f8g7",
      "d1b3",
      "d5c4",
      "b3c4",
      "e8g8",
      "e2e4",
      "c8g4",
      "c1e3",
      "f6d7",
      "c4b3",
      "c7c5"
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
  "eco": "E00",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6"]
},
  {
    "eco": "E01",
    "name": "Catalan, closed",
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
  "eco": "E01",
  "name": "Catalan Opening",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3"]
},
  {
    "eco": "E01",
    "name": "Catalan, Closed",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2"
    ]
  },
  {
  "eco": "E02",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5"]
},
  {
    "eco": "E02",
    "name": "Catalan, Open, 5.Qa4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "d5c4",
      "d1a4"
    ]
  },
  {
  "eco": "E03",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2"]
},
  {
    "eco": "E03",
    "name": "Catalan, Open, 5.Qa4 Nbd7, 6.Qxc4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "d5c4",
      "d1a4",
      "b8d7",
      "a4c4"
    ]
  },
  {
    "eco": "E03",
    "name": "Catalan, Open, Alekhine Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "d5c4",
      "d1a4",
      "b8d7",
      "a4c4",
      "a7a6",
      "c4c2"
    ]
  },
  {
  "eco": "E04",
  "name": "Catalan Opening, Open",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4"]
},
  {
    "eco": "E04",
    "name": "Catalan, Open, 5.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "d5c4",
      "g1f3"
    ]
  },
  {
  "eco": "E04",
  "name": "Catalan: Lobron-Morozevich variation",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4","g1f3","a7a6"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: open (5.Nf3 c5)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","g1f3","d5c4","f3e5","c7c5"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: open (5.Nf3 Nc6)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","g1f3","d5c4","f3e5","b8c6"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: open (Nc3)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","b1c3","d5c4","f1g2"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: open, Alekhine (English line)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4","g1f3","a7a6","a2a4"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: closed, modern line",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7"
  ]
},
  {
  "eco": "E04",
  "name": "Catalan: closed, modern line (Bb4+)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8b4"
  ]
},
  {
  "eco": "E05",
  "name": "Catalan Opening, Open",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","d5c4","g1f3"]
},
  {
    "eco": "E05",
    "name": "Catalan, Open, Classical line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "d5c4",
      "g1f3",
      "f8e7"
    ]
  },
  {
  "eco": "E06",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7"]
},
  {
    "eco": "E06",
    "name": "Catalan, Closed, 5.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3"
    ]
  },
  {
  "eco": "E07",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3"]
},
  {
    "eco": "E07",
    "name": "Catalan, Closed, 6...Nbd7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7"
    ]
  },
  {
    "eco": "E07",
    "name": "Catalan, Closed, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "b1c3",
      "c7c6",
      "d1d3"
    ]
  },
  {
  "eco": "E08",
  "name": "Catalan Opening, Closed",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3","e8g8"]
},
  {
    "eco": "E08",
    "name": "Catalan, Closed, 7.Qc2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2"
    ]
  },
  {
    "eco": "E08",
    "name": "Catalan, Closed, Qc2 & b3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2",
      "c7c6",
      "b2b3"
    ]
  },
  {
    "eco": "E08",
    "name": "Catalan, Closed, Spassky gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2",
      "c7c6",
      "b2b3",
      "b7b6",
      "f1d1",
      "c8b7",
      "b1c3",
      "b6b5"
    ]
  },
  {
    "eco": "E08",
    "name": "Catalan, Closed, Zagoryansky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2",
      "c7c6",
      "f1d1",
      "b7b6",
      "a2a4"
    ]
  },
  {
  "eco": "E09",
  "name": "Catalan Opening, Closed, Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g2g3","d7d5","f1g2","f8e7","g1f3","e8g8","e1g1","d5c4"]
},
  {
    "eco": "E09",
    "name": "Catalan, Closed, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2",
      "c7c6",
      "b1d2"
    ]
  },
  {
    "eco": "E09",
    "name": "Catalan, Closed, Sokolsky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g2g3",
      "d7d5",
      "f1g2",
      "f8e7",
      "g1f3",
      "e8g8",
      "e1g1",
      "b8d7",
      "d1c2",
      "c7c6",
      "b1d2",
      "b7b6",
      "b2b3",
      "a7a5",
      "c1b2",
      "c8a6"
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
  "eco": "E10",
  "name": "Queen's Pawn Game",
  "moves": ["d2d4","g8f6","c2c4","e7e6"]
},
  {
    "eco": "E10",
    "name": "Doery defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "f6e4"
    ]
  },
  {
    "eco": "E10",
    "name": "Dzindzikhashvili defense",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "a7a6"
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
  "eco": "E11",
  "name": "Bogo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4"]
},
  {
    "eco": "E11",
    "name": "Bogo-Indian defense, Gruenfeld Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "f8b4",
      "b1d2"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defense, Monticelli trap",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "f8b4",
      "c1d2",
      "b4d2",
      "d1d2",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "e8g8",
      "b1c3",
      "f6e4",
      "d2c2",
      "e4c3",
      "f3g5"
    ]
  },
  {
    "eco": "E11",
    "name": "Bogo-Indian defense, Nimzovich Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "f8b4",
      "c1d2",
      "d8e7"
    ]
  },
  {
  "eco": "E11",
  "name": "Bogo-Indian defence (...Be7 retreat)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","c1d2","b4e7"
  ]
},
  {
  "eco": "E11",
  "name": "Bogo-Indian defence (Be7 retreat)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","b1c3","b4e7"
  ]
},
  {
    "eco": "E12",
    "name": "Queen's Indian defence",
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
  "eco": "E12",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6"]
},
  {
    "eco": "E12",
    "name": "Queen's Indian, 4.Nc3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "b1c3"
    ]
  },
  {
    "eco": "E12",
    "name": "Queen's Indian, 4.Nc3, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "b1c3",
      "c8b7",
      "c1g5",
      "h7h6",
      "g5h4",
      "g7g5",
      "h4g3",
      "f6h5"
    ]
  },
  {
    "eco": "E12",
    "name": "Queen's Indian, Miles Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "c1f4"
    ]
  },
  {
    "eco": "E12",
    "name": "Queen's Indian, Petrosian system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "a2a3"
    ]
  },
  {
  "eco": "E12",
  "name": "Queen's Indian (with e3)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","e2e3"
  ]
},
  {
  "eco": "E12",
  "name": "Queen's Indian: main line",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","a2a3","c8b7"
  ]
},
  {
  "eco": "E12",
  "name": "Queen's Indian: modern Averbakh variation",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8a6"
  ]
},
  {
  "eco": "E12",
  "name": "Queen's Indian: old main line",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","a2a3","c8b7","b1c3","d7d5"
  ]
},
  {
  "eco": "E12",
  "name": "Queen's Indian: Vaganian variation",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","b1c3","c8b7","d1c2"
  ]
},
  {
  "eco": "E13",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3"]
},
  {
    "eco": "E13",
    "name": "Queen's Indian, 4.Nc3, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "b1c3",
      "c8b7",
      "c1g5",
      "h7h6",
      "g5h4",
      "f8b4"
    ]
  },
  {
  "eco": "E14",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7"]
},
  {
    "eco": "E14",
    "name": "Queen's Indian, 4.e3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "e2e3"
    ]
  },
  {
    "eco": "E14",
    "name": "Queen's Indian, Averbakh Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "e2e3",
      "c8b7",
      "f1d3",
      "c7c5",
      "e1g1",
      "f8e7",
      "b2b3",
      "e8g8",
      "c1b2",
      "c5d4",
      "f3d4"
    ]
  },
  {
  "eco": "E15",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2"]
},
  {
    "eco": "E15",
    "name": "Queen's Indian, 4.g3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3"
    ]
  },
  {
    "eco": "E15",
    "name": "Queen's Indian, 4.g3 Bb7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7"
    ]
  },
  {
    "eco": "E15",
    "name": "Queen's Indian, Buerger Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "c7c5",
      "d4d5",
      "e6d5",
      "f3g5"
    ]
  },
  {
    "eco": "E15",
    "name": "Queen's Indian, Nimzovich Variation (exaggerated Fianchetto)",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8a6"
    ]
  },
  {
    "eco": "E15",
    "name": "Queen's Indian, Rubinstein Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "c7c5",
      "d4d5",
      "e6d5",
      "f3h4"
    ]
  },
  {
  "eco": "E16",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7"]
},
  {
    "eco": "E16",
    "name": "Queen's Indian, Capablanca Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8b4"
    ]
  },
  {
    "eco": "E16",
    "name": "Queen's Indian, Riumin Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8b4",
      "c1d2",
      "b4e7"
    ]
  },
  {
    "eco": "E16",
    "name": "Queen's Indian, Yates Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8b4",
      "c1d2",
      "a7a5"
    ]
  },
  {
  "eco": "E17",
  "name": "Queen's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1"]
},
  {
    "eco": "E17",
    "name": "Queen's Indian, 5.Bg2 Be7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7"
    ]
  },
  {
    "eco": "E17",
    "name": "Queen's Indian, Anti-Queen's Indian system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "b1c3"
    ]
  },
  {
    "eco": "E17",
    "name": "Queen's Indian, Euwe Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "b2b3"
    ]
  },
  {
    "eco": "E17",
    "name": "Queen's Indian, Old Main line, 6.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "e1g1"
    ]
  },
  {
    "eco": "E17",
    "name": "Queen's Indian, Opovcensky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "b1c3",
      "f6e4",
      "c1d2"
    ]
  },
  {
  "eco": "E18",
  "name": "Queen's Indian Defense, Old Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1","e8g8"]
},
  {
    "eco": "E18",
    "name": "Queen's Indian, Old Main line, 7.Nc3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "b1c3"
    ]
  },
  {
  "eco": "E19",
  "name": "Queen's Indian Defense, Old Main Line",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","b7b6","g2g3","c8b7","f1g2","f8e7","e1g1","e8g8","b1c3"]
},
  {
    "eco": "E19",
    "name": "Queen's Indian, Old Main line, 9.Qxc3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "g1f3",
      "b7b6",
      "g2g3",
      "c8b7",
      "f1g2",
      "f8e7",
      "e1g1",
      "e8g8",
      "b1c3",
      "f6e4",
      "d1c2",
      "e4c3",
      "c2c3"
    ]
  },
  {
    "eco": "E20",
    "name": "Nimzo-Indian defence",
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
  "eco": "E20",
  "name": "Nimzo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4"]
},
  {
    "eco": "E20",
    "name": "Nimzo-Indian, Kmoch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "f2f3"
    ]
  },
  {
    "eco": "E20",
    "name": "Nimzo-Indian, Mikenas attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1d3"
    ]
  },
  {
    "eco": "E20",
    "name": "Nimzo-Indian, Romanishin-Kasparov (Steiner) system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "g2g3"
    ]
  },
  {
  "eco": "E21",
  "name": "Nimzo-Indian Defense, Three Knights Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g1f3"]
},
  {
    "eco": "E21",
    "name": "Nimzo-Indian, Three knights Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "g1f3"
    ]
  },
  {
    "eco": "E21",
    "name": "Nimzo-Indian, Three knights, Euwe Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "g1f3",
      "c7c5",
      "d4d5",
      "f6e4"
    ]
  },
  {
    "eco": "E21",
    "name": "Nimzo-Indian, Three knights, Korchnoi Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "g1f3",
      "c7c5",
      "d4d5"
    ]
  },
  {
  "eco": "E22",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3"]
},
  {
    "eco": "E22",
    "name": "Nimzo-Indian, Spielmann Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1b3"
    ]
  },
  {
  "eco": "E23",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3","b4c3"]
},
  {
    "eco": "E23",
    "name": "Nimzo-Indian, Spielmann, 4...c5, 5.dc Nc6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1b3",
      "c7c5",
      "d4c5",
      "b8c6"
    ]
  },
  {
    "eco": "E23",
    "name": "Nimzo-Indian, Spielmann, Karlsbad Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1b3",
      "c7c5",
      "d4c5",
      "b8c6",
      "g1f3",
      "f6e4",
      "c1d2",
      "e4d2"
    ]
  },
  {
    "eco": "E23",
    "name": "Nimzo-Indian, Spielmann, San Remo Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1b3",
      "c7c5",
      "d4c5",
      "b8c6",
      "g1f3",
      "f6e4",
      "c1d2",
      "e4c5"
    ]
  },
  {
    "eco": "E23",
    "name": "Nimzo-Indian, Spielmann, Staahlberg Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1b3",
      "c7c5",
      "d4c5",
      "b8c6",
      "g1f3",
      "f6e4",
      "c1d2",
      "e4c5",
      "b3c2",
      "f7f5",
      "g2g3"
    ]
  },
  {
  "eco": "E24",
  "name": "Nimzo-Indian Defense, Spielmann Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","a2a3","b4c3","b2c3"]
},
  {
    "eco": "E24",
    "name": "Nimzo-Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3"
    ]
  },
  {
    "eco": "E24",
    "name": "Nimzo-Indian, Saemisch, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "f2f3",
      "d7d5",
      "e2e3",
      "e8g8",
      "c4d5",
      "f6d5"
    ]
  },
  {
  "eco": "E25",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2"]
},
  {
    "eco": "E25",
    "name": "Nimzo-Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "f2f3",
      "d7d5",
      "c4d5"
    ]
  },
  {
    "eco": "E25",
    "name": "Nimzo-Indian, Saemisch, Keres Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "f2f3",
      "d7d5",
      "c4d5",
      "f6d5",
      "d4c5"
    ]
  },
  {
    "eco": "E25",
    "name": "Nimzo-Indian, Saemisch, Romanovsky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "f2f3",
      "d7d5",
      "c4d5",
      "f6d5",
      "d4c5",
      "f7f5"
    ]
  },
  {
  "eco": "E26",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5"]
},
  {
    "eco": "E26",
    "name": "Nimzo-Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "e2e3"
    ]
  },
  {
    "eco": "E26",
    "name": "Nimzo-Indian, Saemisch, O'Kelly Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "c7c5",
      "e2e3",
      "b7b6"
    ]
  },
  {
  "eco": "E27",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3"]
},
  {
    "eco": "E27",
    "name": "Nimzo-Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "e8g8"
    ]
  },
  {
  "eco": "E28",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3","b4c3"]
},
  {
    "eco": "E28",
    "name": "Nimzo-Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "e8g8",
      "e2e3"
    ]
  },
  {
  "eco": "E29",
  "name": "Nimzo-Indian Defense, Saemisch Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1d2","d7d5","a2a3","b4c3","b2c3"]
},
  {
    "eco": "E29",
    "name": "Nimzo-Indian, Saemisch, Capablanca Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "e8g8",
      "e2e3",
      "c7c5",
      "f1d3",
      "b8c6",
      "g1e2",
      "b7b6",
      "e3e4",
      "f6e8"
    ]
  },
  {
    "eco": "E29",
    "name": "Nimzo-Indian, Saemisch, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "a2a3",
      "b4c3",
      "b2c3",
      "e8g8",
      "e2e3",
      "c7c5",
      "f1d3",
      "b8c6"
    ]
  },
  {
  "eco": "E30",
  "name": "Nimzo-Indian Defense, Leningrad Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g2g3"]
},
  {
    "eco": "E30",
    "name": "Nimzo-Indian, Leningrad Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "c1g5"
    ]
  },
  {
    "eco": "E30",
    "name": "Nimzo-Indian, Leningrad, ...b5 gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "c1g5",
      "h7h6",
      "g5h4",
      "c7c5",
      "d4d5",
      "b7b5"
    ]
  },
  {
  "eco": "E31",
  "name": "Nimzo-Indian Defense, Leningrad Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g2g3","c7c5"]
},
  {
    "eco": "E31",
    "name": "Nimzo-Indian, Leningrad, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "c1g5",
      "h7h6",
      "g5h4",
      "c7c5",
      "d4d5",
      "d7d6"
    ]
  },
  {
  "eco": "E32",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5"]
},
  {
    "eco": "E32",
    "name": "Nimzo-Indian, Classical Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2"
    ]
  },
  {
    "eco": "E32",
    "name": "Nimzo-Indian, Classical, Adorjan gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "e8g8",
      "a2a3",
      "b4c3",
      "c2c3",
      "b7b5"
    ]
  },
  {
  "eco": "E32",
  "name": "Nimzo-Indian: 4.e3 O-O 5.Nf3 d5",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","g1f3","d7d5"
  ]
},
  {
  "eco": "E32",
  "name": "Nimzo-Indian: classical (4...c5/5...Na6)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","c7c5","g1f3","b8a6"
  ]
},
  {
  "eco": "E32",
  "name": "Nimzo-Indian: classical (without a3)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","b8c6"
  ]
},
  {
  "eco": "E32",
  "name": "Nimzo-Indian: Gligoric system (with 7...dxc4) phantom line",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","g1f3","d7d5","a2a3","b4c3","b2c3","d5c4"
  ]
},
  {
  "eco": "E32",
  "name": "Nimzo-Indian: Kasparov system",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g1f3","b8c6","a2a3"
  ]
},
  {
  "eco": "E32",
  "name": "Nimzo-Indian: three knights (...b6)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g1f3","b7b6"
  ]
},
  {
  "eco": "E33",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6"]
},
  {
    "eco": "E33",
    "name": "Nimzo-Indian, Classical, 4...Nc6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "b8c6"
    ]
  },
  {
    "eco": "E33",
    "name": "Nimzo-Indian, Classical, Milner-Barry (Zurich) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "b8c6",
      "g1f3",
      "d7d6"
    ]
  },
  {
  "eco": "E33",
  "name": "Nimzo-Indian: Spielmann (4...c5 5.dxc5 Nc6)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","g1f3","c7c5","d4c5","b8c6"
  ]
},
  {
  "eco": "E34",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4"]
},
  {
    "eco": "E34",
    "name": "Nimzo-Indian, Classical, Noa Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5"
    ]
  },
  {
  "eco": "E35",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4","c7c5"]
},
  {
    "eco": "E35",
    "name": "Nimzo-Indian, Classical, Noa Variation , 5.cd ed",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "c4d5",
      "e6d5"
    ]
  },
  {
  "eco": "E36",
  "name": "Nimzo-Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","c1g5","h7h6","g5h4","c7c5","e2e3"]
},
  {
    "eco": "E36",
    "name": "Nimzo-Indian, Classical, Botvinnik Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "a2a3",
      "b4c3",
      "c2c3",
      "b8c6"
    ]
  },
  {
    "eco": "E36",
    "name": "Nimzo-Indian, Classical, Noa Variation , 5.a3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "a2a3"
    ]
  },
  {
    "eco": "E36",
    "name": "Nimzo-Indian, Classical, Noa Variation , Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "a2a3",
      "b4c3",
      "c2c3",
      "f6e4"
    ]
  },
  {
  "eco": "E37",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2"]
},
  {
    "eco": "E37",
    "name": "Nimzo-Indian, Classical, Noa Variation , Main line, 7.Qc2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "a2a3",
      "b4c3",
      "c2c3",
      "f6e4",
      "c3c2"
    ]
  },
  {
    "eco": "E37",
    "name": "Nimzo-Indian, Classical, San Remo Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "d7d5",
      "a2a3",
      "b4c3",
      "c2c3",
      "f6e4",
      "c3c2",
      "b8c6",
      "e2e3",
      "e6e5"
    ]
  },
  {
  "eco": "E38",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2","b8c6"]
},
  {
    "eco": "E38",
    "name": "Nimzo-Indian, Classical, 4...c5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "c7c5"
    ]
  },
  {
  "eco": "E39",
  "name": "Nimzo-Indian Defense, Classical, 4.Qc2",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","d1c2","b8c6","a2a3"]
},
  {
    "eco": "E39",
    "name": "Nimzo-Indian, Classical, Pirc Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "d1c2",
      "c7c5",
      "d4c5",
      "e8g8"
    ]
  },
  {
  "eco": "E40",
  "name": "Nimzo-Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4"]
},
  {
    "eco": "E40",
    "name": "Nimzo-Indian, 4.e3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3"
    ]
  },
  {
    "eco": "E40",
    "name": "Nimzo-Indian, 4.e3, Taimanov Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "b8c6"
    ]
  },
  {
  "eco": "E41",
  "name": "Nimzo-Indian Defense, Hübner Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2"]
},
  {
    "eco": "E41",
    "name": "Nimzo-Indian, 4.e3 c5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "c7c5"
    ]
  },
  {
    "eco": "E41",
    "name": "Nimzo-Indian, e3, Huebner Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "c7c5",
      "f1d3",
      "b8c6",
      "g1f3",
      "b4c3",
      "b2c3",
      "d7d6"
    ]
  },
  {
  "eco": "E41",
  "name": "Nimzo-Indian: Huebner variation (e3)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","b8c6","g1f3","d7d6"
  ]
},
  {
  "eco": "E41",
  "name": "Nimzo-Indian: 4.e3 O-O, 5.Nf3, without ...d5",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","g1f3"
  ]
},
  {
  "eco": "E41",
  "name": "Nimzo-Indian: 4.e3, Bondarevskij variation",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","c7c5","g1e2"
  ]
},
  {
  "eco": "E41",
  "name": "Nimzo-Indian: 4.e3, main line (with 8...dxc4 & 9...cxd4)",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","g1f3","d7d5","a2a3","b4c3","b2c3","c7c5","c4d5","e6d5","f1e2","c5c4","e1g1","c4d4"
  ]
},
  {
  "eco": "E41",
  "name": "Nimzo-Indian: 4.e3, modern line",
  "moves": [
    "d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","b8c6"
  ]
},
  {
  "eco": "E42",
  "name": "Nimzo-Indian Defense, Hübner Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","c7c5"]
},
  {
    "eco": "E42",
    "name": "Nimzo-Indian, 4.e3 c5, 5.Ne2 (Rubinstein)",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "c7c5",
      "g1e2"
    ]
  },
  {
  "eco": "E43",
  "name": "Nimzo-Indian Defense, Fischer Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","b8c6"]
},
  {
    "eco": "E43",
    "name": "Nimzo-Indian, Fischer Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "b7b6"
    ]
  },
  {
  "eco": "E44",
  "name": "Nimzo-Indian Defense, Fischer Variation",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","d1c2","b8c6","a2a3"]
},
  {
    "eco": "E44",
    "name": "Nimzo-Indian, Fischer Variation , 5.Ne2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "b7b6",
      "g1e2"
    ]
  },
  {
  "eco": "E45",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3"]
},
  {
    "eco": "E45",
    "name": "Nimzo-Indian, 4.e3, Bronstein (Byrne) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "b7b6",
      "g1e2",
      "c8a6"
    ]
  },
  {
  "eco": "E46",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8"]
},
  {
    "eco": "E46",
    "name": "Nimzo-Indian, 4.e3 O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8"
    ]
  },
  {
    "eco": "E46",
    "name": "Nimzo-Indian, Reshevsky Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1e2"
    ]
  },
  {
    "eco": "E46",
    "name": "Nimzo-Indian, Simagin Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1e2",
      "d7d5",
      "a2a3",
      "b4d6"
    ]
  },
  {
  "eco": "E47",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3"]
},
  {
    "eco": "E47",
    "name": "Nimzo-Indian, 4.e3 O-O, 5.Bd3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "f1d3"
    ]
  },
  {
  "eco": "E48",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3","d7d5"]
},
  {
    "eco": "E48",
    "name": "Nimzo-Indian, 4.e3 O-O, 5.Bd3 d5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "f1d3",
      "d7d5"
    ]
  },
  {
  "eco": "E49",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0, 5.Bd3 d5",
  "moves": ["d2d4","g8f6","c2c4","e7e6","g1f3","f8b4","e2e3","e8g8","f1d3","d7d5","e1g1"]
},
  {
    "eco": "E49",
    "name": "Nimzo-Indian, 4.e3, Botvinnik system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "f1d3",
      "d7d5",
      "a2a3",
      "b4c3",
      "b2c3"
    ]
  },
  {
  "eco": "E50",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3"]
},
  {
    "eco": "E50",
    "name": "Nimzo-Indian, 4.e3 e8g8, 5.Nf3, without ...d5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3"
    ]
  },
  {
  "eco": "E51",
  "name": "Nimzo-Indian Defense, 4.e3",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8"]
},
  {
    "eco": "E51",
    "name": "Nimzo-Indian, 4.e3 e8g8, 5.Nf3 d7d5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5"
    ]
  },
  {
    "eco": "E51",
    "name": "Nimzo-Indian, 4.e3, Ragozin Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "b8c6",
      "e1g1",
      "d5c4"
    ]
  },
  {
  "eco": "E52",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3"]
},
  {
    "eco": "E52",
    "name": "Nimzo-Indian, 4.e3, Main line with ...b6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "b7b6"
    ]
  },
  {
  "eco": "E53",
  "name": "Nimzo-Indian Defense, 4.e3, 0–0",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5"]
},
  {
    "eco": "E53",
    "name": "Nimzo-Indian, 4.e3, Gligoric system with 7...Nbd7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b8d7"
    ]
  },
  {
    "eco": "E53",
    "name": "Nimzo-Indian, 4.e3, Keres Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b7b6"
    ]
  },
  {
    "eco": "E53",
    "name": "Nimzo-Indian, 4.e3, Main line with ...c5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5"
    ]
  },
  {
  "eco": "E54",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3"]
},
  {
    "eco": "E54",
    "name": "Nimzo-Indian, 4.e3, Gligoric system with 7...dc",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "d5c4",
      "d3c4"
    ]
  },
  {
    "eco": "E54",
    "name": "Nimzo-Indian, 4.e3, Gligoric system, Smyslov Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "d5c4",
      "d3c4",
      "d8e7"
    ]
  },
  {
  "eco": "E55",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5"]
},
  {
    "eco": "E55",
    "name": "Nimzo-Indian, 4.e3, Gligoric system, Bronstein Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "d5c4",
      "d3c4",
      "b8d7"
    ]
  },
  {
  "eco": "E56",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1"]
},
  {
    "eco": "E56",
    "name": "Nimzo-Indian, 4.e3, Main line with 7...Nc6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b8c6"
    ]
  },
  {
  "eco": "E57",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6"]
},
  {
    "eco": "E57",
    "name": "Nimzo-Indian, 4.e3, Main line with 8...dc and 9...cd",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b8c6",
      "a2a3",
      "d5c4",
      "d3c4",
      "c5d4"
    ]
  },
  {
  "eco": "E58",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6","a2a3"]
},
  {
    "eco": "E58",
    "name": "Nimzo-Indian, 4.e3, Main line with 8...Bxc3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b8c6",
      "a2a3",
      "b4c3",
      "b2c3"
    ]
  },
  {
  "eco": "E59",
  "name": "Nimzo-Indian Defense, 4.e3, Gligoric System",
  "moves": ["d2d4","g8f6","c2c4","e7e6","b1c3","f8b4","e2e3","e8g8","f1d3","d7d5","g1f3","c7c5","e1g1","b8c6","a2a3","b4c3"]
},
  {
    "eco": "E59",
    "name": "Nimzo-Indian, 4.e3, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "e7e6",
      "b1c3",
      "f8b4",
      "e2e3",
      "e8g8",
      "g1f3",
      "d7d5",
      "f1d3",
      "c7c5",
      "e1g1",
      "b8c6",
      "a2a3",
      "b4c3",
      "b2c3",
      "d5c4",
      "d3c4"
    ]
  },
  {
    "eco": "E60",
    "name": "King's Indian defence",
    "moves": [
      "d2d4",
      "b1f6",
      "c2c4",
      "g7g6"
    ]
  },
  {
  "eco": "E60",
  "name": "King's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6"]
},
  {
    "eco": "E60",
    "name": "King's Indian, 3.g3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3"
    ]
  },
  {
    "eco": "E60",
    "name": "King's Indian, 3.g3, counterthrust Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g2g3",
      "f8g7",
      "f1g2",
      "d7d5"
    ]
  },
  {
    "eco": "E60",
    "name": "King's Indian, 3.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "g1f3"
    ]
  },
  {
    "eco": "E60",
    "name": "King's Indian, Anti-Gruenfeld",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "d4d5"
    ]
  },
  {
    "eco": "E60",
    "name": "King's Indian, Danube gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "d4d5",
      "b7b5"
    ]
  },
  {
    "eco": "E60",
    "name": "Queen's pawn, Mengarini attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "d1c2"
    ]
  },
  {
  "eco": "E60",
  "name": "Pirc-KID-East Indian",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6"
  ]
},
  {
  "eco": "E60",
  "name": "Pirc-Queen's pawn-KID-East Indian",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","g1f3","d7d6"
  ]
},
  {
  "eco": "E60",
  "name": "King's Indian: 3.Nc3",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3"
  ]
},
  {
  "eco": "E60",
  "name": "King's Indian: Benoni formation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","c7c5"
  ]
},
  {
  "eco": "E60",
  "name": "King's Indian: Kluger variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","d7d5"
  ]
},
  {
  "eco": "E61",
  "name": "King's Indian Defense, 3.Nc3",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3"]
},
  {
    "eco": "E61",
    "name": "King's Indian, Smyslov system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "c1g5"
    ]
  },
  {
  "eco": "E61",
  "name": "King's Indian (Bf4)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","c1f4"
  ]
},
  {
  "eco": "E62",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3"]
},
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto with ...Nc6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8c6"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto, Kavalek (Bronstein) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "c7c6",
      "e1g1",
      "d8a5"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto, Larsen system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "c7c6",
      "e1g1",
      "c8f5"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto, lesser Simagin (Spassky) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8c6",
      "e1g1",
      "c8f5"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto, Simagin Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8c6",
      "e1g1",
      "c8g4"
    ]
  },
  {
    "eco": "E62",
    "name": "King's Indian, Fianchetto, Uhlmann (Szabo) Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8c6",
      "e1g1",
      "e7e5"
    ]
  },
  {
  "eco": "E62",
  "name": "King's Indian: fianchetto (without c4, 6.Nc3)",
  "moves": [
    "d2d4","g8f6","g2g3","g7g6","f1g2","f8g7","g1f3","d7d6","e1g1","b1c3"
  ]
},
  {
  "eco": "E62",
  "name": "King's Indian: fianchetto, Panno system",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","g2g3","d7d6","f1g2","e7e5","g1f3","b8c6","d4d5","c6e7"
  ]
},
  {
  "eco": "E63",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7"]
},
  {
    "eco": "E63",
    "name": "King's Indian, Fianchetto, Panno Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8c6",
      "e1g1",
      "a7a6"
    ]
  },
  {
  "eco": "E64",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2"]
},
  {
    "eco": "E64",
    "name": "King's Indian, Fianchetto, Yugoslav system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "c7c5"
    ]
  },
  {
  "eco": "E65",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6"]
},
  {
    "eco": "E65",
    "name": "King's Indian, Fianchetto, Yugoslav, 7.O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "c7c5",
      "e1g1"
    ]
  },
  {
  "eco": "E66",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3"]
},
  {
    "eco": "E66",
    "name": "King's Indian, Fianchetto, Yugoslav Panno",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "c7c5",
      "e1g1",
      "b8c6",
      "d4d5"
    ]
  },
  {
  "eco": "E67",
  "name": "King's Indian Defense, Fianchetto Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8"]
},
  {
    "eco": "E67",
    "name": "King's Indian, Fianchetto with ...Nd7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8d7"
    ]
  },
  {
    "eco": "E67",
    "name": "King's Indian, Fianchetto, Classical Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8d7",
      "e1g1",
      "e7e5"
    ]
  },
  {
  "eco": "E68",
  "name": "King's Indian Defense, Fianchetto Variation, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8","e1g1"]
},
  {
    "eco": "E68",
    "name": "King's Indian, Fianchetto, Classical Variation , 8.e4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8d7",
      "e1g1",
      "e7e5",
      "e2e4"
    ]
  },
  {
  "eco": "E69",
  "name": "King's Indian Defense, Fianchetto Variation, Classical",
  "moves": ["d2d4","g8f6","c2c4","g7g6","g2g3","f8g7","f1g2","d7d6","g1f3","e8g8","e1g1","c7c6"]
},
  {
    "eco": "E69",
    "name": "King's Indian, Fianchetto, Classical Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "g1f3",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "b8d7",
      "e1g1",
      "e7e5",
      "e2e4",
      "c7c6",
      "h2h3"
    ]
  },
  {
  "eco": "E70",
  "name": "King's Indian Defense",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7"]
},
  {
    "eco": "E70",
    "name": "King's Indian, 4.e4",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4"
    ]
  },
  {
    "eco": "E70",
    "name": "King's Indian, Accelerated Averbakh system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "c1g5"
    ]
  },
  {
    "eco": "E70",
    "name": "King's Indian, Kramer system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1e2"
    ]
  },
  {
  "eco": "E71",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4"]
},
  {
    "eco": "E71",
    "name": "King's Indian, Makagonov system (5.h3)",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "h2h3"
    ]
  },
  {
  "eco": "E72",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6"]
},
  {
    "eco": "E72",
    "name": "King's Indian with e4 & g3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g2g3"
    ]
  },
  {
    "eco": "E72",
    "name": "King's Indian, Pomar system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g2g3",
      "e8g8",
      "f1g2",
      "e7e5",
      "g1e2"
    ]
  },
  {
  "eco": "E73",
  "name": "King's Indian Defense, Normal Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3"]
},
  {
    "eco": "E73",
    "name": "King's Indian, 5.Be2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f1e2"
    ]
  },
  {
    "eco": "E73",
    "name": "King's Indian, Averbakh system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f1e2",
      "e8g8",
      "c1g5"
    ]
  },
  {
    "eco": "E73",
    "name": "King's Indian, Semi-Averbakh system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f1e2",
      "e8g8",
      "c1e3"
    ]
  },
  {
  "eco": "E74",
  "name": "King's Indian Defense, Averbakh Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","c1g5"]
},
  {
    "eco": "E74",
    "name": "King's Indian, Averbakh, 6...c5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f1e2",
      "e8g8",
      "c1g5",
      "c7c5"
    ]
  },
  {
  "eco": "E75",
  "name": "King's Indian Defense, Averbakh Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","c1g5","e8g8"]
},
  {
    "eco": "E75",
    "name": "King's Indian, Averbakh, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f1e2",
      "e8g8",
      "c1g5",
      "c7c5",
      "d4d5",
      "e7e6"
    ]
  },
  {
  "eco": "E76",
  "name": "King's Indian Defense, Four Pawns Attack",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f4"]
},
  {
    "eco": "E76",
    "name": "King's Indian, Four pawns attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4"
    ]
  },
  {
    "eco": "E76",
    "name": "King's Indian, Four pawns attack, dynamic line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "g1f3",
      "c7c5",
      "d4d5"
    ]
  },
  {
  "eco": "E76",
  "name": "King's Indian: four pawns attack (with Be2 & Nf3)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","e2e4","d7d6","b1c3","f8g7","f1e2","e8g8","g1f3"
  ]
},
  {
  "eco": "E76",
  "name": "King's Indian: four pawns attack, Benoni formation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","e2e4","d7d6","b1c3","f8g7","f2f4","c7c5"
  ]
},
  {
  "eco": "E76",
  "name": "King's Indian: four pawns attack, exchange",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","e2e4","d7d6","b1c3","f8g7","f2f4","c7c5","d4c5"
  ]
},
  {
  "eco": "E77",
  "name": "King's Indian Defense, Four Pawns Attack",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f4","e8g8"]
},
  {
    "eco": "E77",
    "name": "King's Indian, Four pawns attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2",
      "c7c5",
      "d4d5",
      "e7e6",
      "g1f3"
    ]
  },
  {
    "eco": "E77",
    "name": "King's Indian, Four pawns attack, 6.Be2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2"
    ]
  },
  {
    "eco": "E77",
    "name": "King's Indian, Four pawns attack, Florentine gambit",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2",
      "c7c5",
      "d4d5",
      "e7e6",
      "g1f3",
      "e6d5",
      "e4e5"
    ]
  },
  {
    "eco": "E77",
    "name": "King's Indian, Six pawns attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2",
      "c7c5",
      "d4d5",
      "e7e6",
      "d5e6",
      "f7e6",
      "g2g4",
      "b8c6",
      "h2h4"
    ]
  },
  {
  "eco": "E78",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8"]
},
  {
    "eco": "E78",
    "name": "King's Indian, Four pawns attack, with Be2 and Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2",
      "c7c5",
      "g1f3"
    ]
  },
  {
  "eco": "E79",
  "name": "King's Indian Defense, Classical, 7…Nc6",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","b8c6"]
},
  {
    "eco": "E79",
    "name": "King's Indian, Four pawns attack, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f4",
      "e8g8",
      "f1e2",
      "c7c5",
      "g1f3",
      "c5d4",
      "f3d4",
      "b8c6",
      "c1e3"
    ]
  },
  {
  "eco": "E80",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3"]
},
  {
    "eco": "E80",
    "name": "King's Indian, Saemisch Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3"
    ]
  },
  {
  "eco": "E80",
  "name": "King's Indian: Kramer system Saemisch",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","c1g5"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8"]
},
  {
    "eco": "E81",
    "name": "King's Indian, Saemisch, 5...O-O",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8"
    ]
  },
  {
    "eco": "E81",
    "name": "King's Indian, Saemisch, Byrne Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "c7c6",
      "f1d3",
      "a7a6"
    ]
  },
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (...c5)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (6...Na6)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","b8a6"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (6...Nfd7)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","f6d7"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (6.Bg5 7...Na6)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","c1g5","b8a6"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (6.Bg5 7...Nbd7)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","c1g5","b8d7"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch (6.Bg5 7...Qa5)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","c1g5","d8a5"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch, Commons variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","h7h6"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch, orthodox, Karpov–Topalov variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","b8c6","d4d5","c6e5"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch, Sax variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","a7a6"
  ]
},
  {
  "eco": "E81",
  "name": "King's Indian: Saemisch, Zaitsev variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","b8c6","d4d5","c6b8"
  ]
},
  {
  "eco": "E82",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3"]
},
  {
    "eco": "E82",
    "name": "King's Indian, Saemisch, double Fianchetto Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "b7b6"
    ]
  },
  {
  "eco": "E83",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5"]
},
  {
    "eco": "E83",
    "name": "King's Indian, Saemisch, 6...Nc6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "b8c6"
    ]
  },
  {
    "eco": "E83",
    "name": "King's Indian, Saemisch, Panno formation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "b8c6",
      "g1e2",
      "a7a6"
    ]
  },
  {
    "eco": "E83",
    "name": "King's Indian, Saemisch, Ruban Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "b8c6",
      "g1e2",
      "a8b8"
    ]
  },
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch–Benoni, exchange",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5","d4c5"
  ]
},
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch–Benoni, Kremeneckij variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5","d4d5","e7e6","c1g5"
  ]
},
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch–Benoni, Petrosian variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5","d4d5","h7h6","c1e3"
  ]
},
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch, Benoni formation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5"
  ]
},
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch–Benoni (d5...a6)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5","d4d5","a7a6"
  ]
},
  {
  "eco": "E83",
  "name": "King's Indian: Saemisch–Benoni (d5...Nbd7)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","c7c5","d4d5","b8d7"
  ]
},
  {
  "eco": "E84",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5"]
},
  {
    "eco": "E84",
    "name": "King's Indian, Saemisch, Panno Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "b8c6",
      "g1e2",
      "a7a6",
      "d1d2",
      "a8b8"
    ]
  },
  {
  "eco": "E85",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5","e7e6"]
},
  {
    "eco": "E85",
    "name": "King's Indian, Saemisch, Orthodox Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5"
    ]
  },
  {
  "eco": "E86",
  "name": "King's Indian Defense, Sämisch Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","c7c5","d4d5","e7e6","g1e2"]
},
  {
    "eco": "E86",
    "name": "King's Indian, Saemisch, Orthodox, 7.Nge2 c6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5",
      "g1e2",
      "c7c6"
    ]
  },
  {
  "eco": "E87",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6"]
},
  {
    "eco": "E87",
    "name": "King's Indian, Saemisch, Orthodox, 7.d5",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5",
      "d4d5"
    ]
  },
  {
    "eco": "E87",
    "name": "King's Indian, Saemisch, Orthodox, Bronstein Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5",
      "d4d5",
      "f6h5",
      "d1d2",
      "d8h4",
      "g2g3",
      "h5g3",
      "d2f2",
      "g3f1",
      "f2h4",
      "f1e3",
      "e1e2",
      "e3c4"
    ]
  },
  {
  "eco": "E88",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6","g1e2"]
},
  {
    "eco": "E88",
    "name": "King's Indian, Saemisch, Orthodox, 7.d5 c6",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5",
      "d4d5",
      "c7c6"
    ]
  },
  {
  "eco": "E89",
  "name": "King's Indian Defense, Sämisch Variation, Panno",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f2f3","e8g8","c1e3","b8c6","g1e2","a7a6"]
},
  {
    "eco": "E89",
    "name": "King's Indian, Saemisch, Orthodox Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "f2f3",
      "e8g8",
      "c1e3",
      "e7e5",
      "d4d5",
      "c7c6",
      "g1e2",
      "c6d5"
    ]
  },
  {
  "eco": "E90",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2"]
},
  {
    "eco": "E90",
    "name": "King's Indian, 5.Nf3",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3"
    ]
  },
  {
    "eco": "E90",
    "name": "King's Indian, Larsen Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "c1e3"
    ]
  },
  {
    "eco": "E90",
    "name": "King's Indian, Zinnowitz Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "c1g5"
    ]
  },
  {
  "eco": "E91",
  "name": "King's Indian Defense, Classical Variation",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5"]
},
  {
    "eco": "E91",
    "name": "King's Indian, 6.Be2",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2"
    ]
  },
  {
    "eco": "E91",
    "name": "King's Indian, Kazakh Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "b8a6"
    ]
  },
  {
  "eco": "E92",
  "name": "King's Indian Defense, Classical, 7…e5",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1"]
},
  {
    "eco": "E92",
    "name": "King's Indian, Andersson Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "d4e5"
    ]
  },
  {
    "eco": "E92",
    "name": "King's Indian, Classical Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5"
    ]
  },
  {
    "eco": "E92",
    "name": "King's Indian, Gligoric-Taimanov system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "c1e3"
    ]
  },
  {
    "eco": "E92",
    "name": "King's Indian, Petrosian system",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "d4d5"
    ]
  },
  {
    "eco": "E92",
    "name": "King's Indian, Petrosian system, Stein Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "d4d5",
      "a7a5"
    ]
  },
  {
  "eco": "E93",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5"]
},
  {
    "eco": "E93",
    "name": "King's Indian, Petrosian system, Keres Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "d4d5",
      "b8d7",
      "c1g5",
      "h7h6",
      "g5h4",
      "g6g5",
      "h4g3",
      "f6h5",
      "h2h4"
    ]
  },
  {
    "eco": "E93",
    "name": "King's Indian, Petrosian system, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "d4d5",
      "b8d7"
    ]
  },
  {
  "eco": "E94",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5","b8d7"]
},
  {
    "eco": "E94",
    "name": "King's Indian, Orthodox Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1"
    ]
  },
  {
    "eco": "E94",
    "name": "King's Indian, Orthodox, 7...Nbd7",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8d7"
    ]
  },
  {
    "eco": "E94",
    "name": "King's Indian, Orthodox, Donner Variation",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "c7c6"
    ]
  },
  {
  "eco": "E95",
  "name": "King's Indian Defense, Classical, Petrosian System",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","d4d5","b8d7","f3d2"]
},
  {
    "eco": "E95",
    "name": "King's Indian, Orthodox, 7...Nbd7, 8.Re1",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8d7",
      "f1e1"
    ]
  },
  {
  "eco": "E96",
  "name": "King's Indian Defense, Classical, Orthodox",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7"]
},
  {
    "eco": "E96",
    "name": "King's Indian, Orthodox, 7...Nbd7, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8d7",
      "f1e1",
      "c7c6",
      "e2f1",
      "a7a5"
    ]
  },
  {
  "eco": "E97",
  "name": "King's Indian Defense, Classical, Orthodox",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5"]
},
  {
    "eco": "E97",
    "name": "King's Indian, Orthodox, Aronin-Taimanov Variation (Yugoslav attack / Mar del Plata Variation )",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8c6"
    ]
  },
  {
    "eco": "E97",
    "name": "King's Indian, Orthodox, Aronin-Taimanov, bayonet attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8c6",
      "d4d5",
      "c6e7",
      "b2b4"
    ]
  },
  {
  "eco": "E97",
  "name": "King's Indian: orthodox (7...exd4)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","e5d4"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox (7...Na6)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8a6"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox (7.d5)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","d4d5"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox (8.Re1)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8c6","e1e1"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox, Aronin–Taimanov (with 9.Nd2)",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8c6","d1d2","c8g4","d2d2","c3d2"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox, Aronin–Taimanov variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8c6","d1d2"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox, Bonsch–Gurevich variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8c6","d1d2","c8g4","d2d1"
  ]
},
  {
  "eco": "E97",
  "name": "King's Indian: orthodox, Gelfand variation",
  "moves": [
    "d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","f1e2","e8g8","g1f3","e7e5","e1g1","b8c6","d1d2","c8g4","f3e1"
  ]
},
  {
  "eco": "E98",
  "name": "King's Indian Defense, Classical, Orthodox, Aronin–Taimanov",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5","c7c6"]
},
  {
    "eco": "E98",
    "name": "King's Indian, Orthodox, Aronin-Taimanov, 9.Ne1",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8c6",
      "d4d5",
      "c6e7",
      "f3e1"
    ]
  },
  {
  "eco": "E99",
  "name": "King's Indian Defense, Classical, Orthodox, Aronin–Taimanov",
  "moves": ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8","f1e2","e7e5","e1g1","b8d7","c1g5","c7c6","d1d2"]
},
  {
    "eco": "E99",
    "name": "King's Indian, Orthodox, Aronin-Taimanov, Benko attack",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8c6",
      "d4d5",
      "c6e7",
      "f3e1",
      "f6d7",
      "f2f3",
      "f7f5",
      "g2g4"
    ]
  },
  {
    "eco": "E99",
    "name": "King's Indian, Orthodox, Aronin-Taimanov, Main line",
    "moves": [
      "d2d4",
      "g8f6",
      "c2c4",
      "g7g6",
      "b1c3",
      "f8g7",
      "e2e4",
      "d7d6",
      "g1f3",
      "e8g8",
      "f1e2",
      "e7e5",
      "e1g1",
      "b8c6",
      "d4d5",
      "c6e7",
      "f3e1",
      "f6d7",
      "f2f3",
      "f7f5"
    ]
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
  const isMobileNav = document.body.classList.contains('mobile-nav');
  const showSearchUI = !isMobileNav || (typeof _mobileNavState !== 'undefined' && _mobileNavState && _mobileNavState.lastPanel === 'search');
  const drawerContent = isMobileNav ? document.getElementById('drawer-content') : null;
  const prevDrawerScrollTop = drawerContent ? drawerContent.scrollTop : null;
  const prevMoveListScrollTop = moveList.scrollTop;
  const prevMoveListAtBottom = (moveList.scrollTop + moveList.clientHeight >= moveList.scrollHeight - 4);
  const prevExplorer = document.getElementById('openings-explorer');
  const prevExplorerOpen = !!(prevExplorer && prevExplorer.style.display !== 'none');
  const prevExplorerFilter = document.getElementById('openings-explorer-filter');
  const prevExplorerFilterVal = prevExplorerFilter ? prevExplorerFilter.value : '';
  const prevExplorerGroup = document.getElementById('openings-explorer-group');
  const prevExplorerGroupVal = prevExplorerGroup ? prevExplorerGroup.value : 'All';
  const prevExplorerScope = document.getElementById('openings-explorer-scope');
  const prevExplorerScopeVal = prevExplorerScope ? prevExplorerScope.value : 'openings';
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
  openExplorerBtn.type = 'button';
  openExplorerBtn.textContent = 'Search';
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
  explorer.style.marginTop = '8px';
  explorer.style.padding = '8px';
  explorer.style.border = '1px solid #333';
  explorer.style.borderRadius = '8px';
  explorer.style.background = 'rgba(0,0,0,0.12)';
  explorer.style.height = isMobileNav ? '55vh' : '420px';
  explorer.style.overflow = 'hidden';
  explorer.style.flexDirection = 'column';
  explorer.style.display = 'none';
  explorer.style.maxWidth = '100%';

  const explorerHeader = document.createElement('div');
  explorerHeader.style.display = 'flex';
  explorerHeader.style.gap = '6px';
  explorerHeader.style.alignItems = 'center';
  explorerHeader.style.flexWrap = 'wrap';
  explorerHeader.style.rowGap = '6px';
  explorerHeader.style.background = 'rgba(16,16,21,0.96)';
  explorerHeader.style.padding = '4px';
  explorerHeader.style.borderRadius = '6px';

  const explorerFilter = document.createElement('input');
  explorerFilter.id = 'openings-explorer-filter';
  explorerFilter.type = 'text';
  explorerFilter.inputMode = 'search';
  explorerFilter.placeholder = 'Filter openings (e.g. B90, Najdorf)';
  explorerFilter.style.flex = '1';
  explorerFilter.style.fontSize = '12px';
  explorerFilter.style.padding = '4px 8px';
  explorerFilter.style.borderRadius = '6px';
  explorerFilter.style.minWidth = '140px';

  // Android quirk: sometimes opening the explorer causes the keyboard to appear
  // because an input ends up focused. Keep the filter readOnly on touch devices
  // unless the user explicitly taps the field.
  let __isCoarsePointer = false;
  try {
	__isCoarsePointer = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
		(typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
		('ontouchstart' in window);
  } catch (e) { /* ignore */ }
  // On Android, just having a visible input near the tap target can steal focus
  // (especially when opening on pointer events) and pop up the keyboard.
  // On coarse/touch pointers, replace the inline input with a safe button that
  // uses a prompt only when the user explicitly wants to type.
  let explorerFilterBtn = null;
  if (__isCoarsePointer) {
  explorerFilter.disabled = true;
  explorerFilter.style.display = 'none';
  explorerFilterBtn = document.createElement('button');
  explorerFilterBtn.type = 'button';
  explorerFilterBtn.textContent = 'Filter…';
  explorerFilterBtn.style.flex = '1';
  explorerFilterBtn.style.fontSize = '12px';
  explorerFilterBtn.style.padding = '4px 8px';
  explorerFilterBtn.style.borderRadius = '6px';
  explorerFilterBtn.style.cursor = 'pointer';
  explorerFilterBtn.addEventListener('click', (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* ignore */ }
    const current = explorerFilter.value || '';
    const next = prompt('Filter openings / PGN (ECO, name, moves, players):', current);
    if (next === null) return;
    explorerFilter.value = String(next);
    renderExplorerResults();
  });
  }

  const explorerGroup = document.createElement('select');
  explorerGroup.id = 'openings-explorer-group';
  explorerGroup.style.fontSize = '12px';
  explorerGroup.style.padding = '4px 6px';
  explorerGroup.style.borderRadius = '6px';
  explorerGroup.style.minWidth = '70px';
  for (const v of ['All', 'A', 'B', 'C', 'D', 'E', 'F']) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    explorerGroup.appendChild(opt);
  }

  const explorerScope = document.createElement('select');
  explorerScope.id = 'openings-explorer-scope';
  explorerScope.style.fontSize = '12px';
  explorerScope.style.padding = '4px 6px';
  explorerScope.style.borderRadius = '6px';
  explorerScope.style.minWidth = '90px';
  const scopeOptions = [
    { value: 'openings', label: 'Openings' },
    { value: 'pgn', label: 'PGN' },
    { value: 'both', label: 'Both' }
  ];
  for (const opt of scopeOptions) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    explorerScope.appendChild(o);
  }

  const explorerClose = document.createElement('button');
  explorerClose.textContent = 'Close';
  explorerClose.style.fontSize = '12px';
  explorerClose.style.padding = '4px 8px';
  explorerClose.style.borderRadius = '6px';
  explorerClose.style.cursor = 'pointer';
  explorerClose.style.whiteSpace = 'nowrap';

  if (explorerFilterBtn) explorerHeader.appendChild(explorerFilterBtn);
  else explorerHeader.appendChild(explorerFilter);
  explorerHeader.appendChild(explorerGroup);
  explorerHeader.appendChild(explorerScope);
  explorerHeader.appendChild(explorerClose);

  const explorerMeta = document.createElement('div');
  explorerMeta.id = 'openings-explorer-meta';
  explorerMeta.style.marginTop = '6px';
  explorerMeta.style.fontSize = '11px';
  explorerMeta.style.color = 'var(--muted)';

  const explorerResults = document.createElement('div');
  explorerResults.id = 'openings-explorer-results';
  explorerResults.style.marginTop = '8px';
  explorerResults.style.flex = '1 1 auto';
  explorerResults.style.overflowY = 'auto';
  explorerResults.style.overflowX = 'hidden';
  explorerResults.style.webkitOverflowScrolling = 'touch';
  explorerResults.style.maxWidth = '100%';
  explorerResults.style.minHeight = isMobileNav ? '30vh' : '280px';

  explorer.appendChild(explorerHeader);
  explorer.appendChild(explorerMeta);
  explorer.appendChild(explorerResults);

  function renderExplorerResults() {
    ensureOpeningIndexes();
    const q = (explorerFilter.value || '').trim().toLowerCase();
    const group = explorerGroup.value || 'All';
    const scope = explorerScope.value || 'openings';
    const list = __openingListSorted || [];
    let filtered = list;
    const showOpenings = (scope === 'openings' || scope === 'both');
    const showPGN = (scope === 'pgn' || scope === 'both');

    explorerGroup.disabled = !showOpenings;
    explorerFilter.placeholder = showPGN && !showOpenings
      ? 'Search PGN (players, event, moves)'
      : showPGN
        ? 'Search openings or PGN'
        : 'Filter openings (e.g. B90, Najdorf)';

    const cap = 250;
    explorerResults.innerHTML = '';
    let openingShown = 0;
    let openingTotal = 0;
    let pgnShown = 0;
    let pgnTotal = 0;

    if (showOpenings) {
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
      openingTotal = filtered.length;
      const shown = filtered.slice(0, cap);
      openingShown = shown.length;
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
			// Don't preventDefault here; it breaks touch scrolling on mobile.
			try { ev?.stopPropagation?.(); } catch (e) { /* ignore */ }
          applyOpeningLine(o, {
            afterApply: () => {
              explorer.style.display = 'none';
            }
          });
        };
		item.addEventListener('click', onPick);
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onPick(e); });
        explorerResults.appendChild(item);
      }
    }

    if (showPGN) {
      if (showOpenings && openingShown > 0) {
        const divider = document.createElement('div');
        divider.style.cssText = 'border-bottom:1px solid #333;margin:6px 0;';
        explorerResults.appendChild(divider);
      }

      const buildLabelUI = (g, i) => {
        const t = g.tags || {};
        return `${i + 1}: ${t.White || 'White'} vs ${t.Black || 'Black'}${t.Event ? ' — ' + t.Event : ''}${t.Date ? ' (' + t.Date + ')' : ''}`;
      };

      if (!pgnGames || pgnGames.length === 0) {
        const msg = document.createElement('div');
        msg.style.padding = '6px';
        msg.style.color = 'var(--muted)';
        msg.textContent = 'No PGN games loaded. Click "Load PGN" to import games.';
        explorerResults.appendChild(msg);
      } else if (q && q.length >= 2) {
        const results = typeof window.searchPGNGames === 'function'
          ? window.searchPGNGames(q)
          : window.getPGNGames().filter(g => ((Object.values(g.tags || {}).join(' ') + ' ' + (g.moves || []).join(' ')).toLowerCase().includes(q)));
        pgnTotal = results ? results.length : 0;
        const limited = (results || []).slice(0, 20);
        pgnShown = limited.length;
        if (!limited.length) {
          const msg = document.createElement('div');
          msg.style.padding = '6px';
          msg.style.color = 'var(--muted)';
          msg.textContent = 'No matches';
          explorerResults.appendChild(msg);
        } else {
          for (let r = 0; r < limited.length; r++) {
            const g = limited[r];
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
              explorer.style.display = 'none';
            });
            explorerResults.appendChild(item);
          }
        }
      }
    }

    if (showPGN && (!q || q.length < 2)) {
      const msg = document.createElement('div');
      msg.style.padding = '6px';
      msg.style.color = 'var(--muted)';
      msg.textContent = 'Type at least 2 characters to search PGN games.';
      explorerResults.appendChild(msg);
    }

    const metaParts = [];
    if (showOpenings) metaParts.push(`Openings ${openingShown}/${openingTotal}`);
    if (showPGN && q && q.length >= 2) metaParts.push(`PGN ${pgnShown}/${pgnTotal}`);
    explorerMeta.textContent = metaParts.length ? metaParts.join(' • ') : 'Search openings or PGN';
  }

  const __toggleExplorer = (ev) => {
    try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch (e) { /* ignore */ }
    const isOpen = explorer.style.display !== 'none';
    explorer.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) {
      // Defensive blur: if any input was focused, drop it so the keyboard stays hidden.
      try {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
      } catch (e) { /* ignore */ }
	  try { explorerFilter.blur(); } catch (e) { /* ignore */ }

      renderExplorerResults();
    }
  };

  // Use click (not pointerdown) so the release doesn't retarget onto newly shown elements.
  openExplorerBtn.addEventListener('click', __toggleExplorer);
  explorerClose.onclick = () => { explorer.style.display = 'none'; };
  explorerFilter.addEventListener('input', renderExplorerResults);
  explorerGroup.addEventListener('change', renderExplorerResults);
  explorerScope.addEventListener('change', renderExplorerResults);

  // Remove any legacy PGN search UI to prevent duplicates
  try {
    const oldSearch = moveList.querySelector('#pgnSearch');
    if (oldSearch) oldSearch.remove();
    const oldResults = moveList.querySelector('#pgnSearchResults');
    if (oldResults) oldResults.remove();
  } catch (e) { /* ignore */ }

  // Remove any existing button row/tools to prevent duplicates
  const oldBtnRow = moveList.querySelector('.fen-pgn-btn-row');
  if (oldBtnRow && oldBtnRow.parentNode) oldBtnRow.parentNode.removeChild(oldBtnRow);
  const oldTools = (historyPanel || moveList.parentNode)?.querySelector('#move-list-tools');
  const pgnWrapper = document.getElementById('pgn-nav-wrapper');
  if (isMobileNav && oldTools && pgnWrapper && oldTools.contains(pgnWrapper)) {
    oldTools.removeChild(pgnWrapper);
  }
  if (oldTools && oldTools.parentNode) oldTools.parentNode.removeChild(oldTools);
  btnRow.className = 'fen-pgn-btn-row';

  // Create a fixed tools container above the move list
  const toolsWrap = document.createElement('div');
  toolsWrap.id = 'move-list-tools';
  toolsWrap.style.display = 'flex';
  toolsWrap.style.flexDirection = 'column';
  toolsWrap.style.gap = '8px';
  toolsWrap.appendChild(btnRow);
  if (isMobileNav && pgnWrapper) toolsWrap.appendChild(pgnWrapper);
  toolsWrap.appendChild(explorer);

  const historyRoot = historyPanel || moveList.parentNode;
  if (historyRoot && moveList && moveList.parentNode === historyRoot) {
    historyRoot.insertBefore(toolsWrap, moveList);
  } else {
    moveList.parentNode.insertBefore(toolsWrap, moveList);
  }

  if (!isMobileNav && historyPanel && moveList) {
    historyPanel.style.display = 'flex';
    historyPanel.style.flexDirection = 'column';
    historyPanel.style.maxHeight = 'none';
    historyPanel.style.height = '520px';
    historyPanel.style.overflow = 'hidden';
    moveList.style.flex = '1 1 auto';
    moveList.style.minHeight = '0';
    moveList.style.overflowY = 'auto';
    moveList.style.paddingTop = '4px';
  } else if (moveList) {
    if (historyPanel) {
      historyPanel.style.display = '';
      historyPanel.style.flexDirection = '';
      historyPanel.style.maxHeight = '';
      historyPanel.style.height = '';
      historyPanel.style.overflow = '';
    }
    moveList.style.flex = '';
    moveList.style.minHeight = '';
    moveList.style.overflowY = '';
    moveList.style.paddingTop = '';
  }
    // Restore explorer open state + filter selection after rerenders.
    try {
      const explorerNow = document.getElementById('openings-explorer');
      const filterNow = document.getElementById('openings-explorer-filter');
      const groupNow = document.getElementById('openings-explorer-group');
      const scopeNow = document.getElementById('openings-explorer-scope');
      if (groupNow) groupNow.value = prevExplorerGroupVal;
      if (scopeNow) scopeNow.value = prevExplorerScopeVal;
      if (filterNow) filterNow.value = prevExplorerFilterVal;
      const shouldAutoOpen = !!(isMobileNav && showSearchUI);
      if (explorerNow && (prevExplorerOpen || shouldAutoOpen)) {
        explorerNow.style.display = 'flex';
        try {
          if (filterNow && typeof filterNow.dispatchEvent === 'function') {
            filterNow.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            renderExplorerResults();
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }

    // Avoid forcing scroll while the user is browsing (especially on mobile).
    if (drawerContent && prevDrawerScrollTop !== null) {
      drawerContent.scrollTop = prevDrawerScrollTop;
    } else if (!isMobileNav && prevMoveListAtBottom && !prevExplorerOpen) {
      moveList.scrollTop = moveList.scrollHeight;
    } else {
      moveList.scrollTop = prevMoveListScrollTop;
    }

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
		ctx.font = `${layout.cell * 0.72}px "Segoe UI Symbol"`;
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
        const settings = getDifficultySettings(state.aiLevel);
        try { if (typeof SEARCH_NODES !== 'undefined') SEARCH_NODES = 0; } catch (e) { /* ignore */ }
        const mv = aiChooseMove();
        try {
          const nodes = (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : undefined;
          const info = (typeof SEARCH_LAST_INFO === 'object' && SEARCH_LAST_INFO) ? SEARCH_LAST_INFO : null;
          const depth = info && Number.isFinite(info.depth) && info.depth > 0 ? info.depth : settings.searchDepth;
          const evalScore = info && Number.isFinite(info.score) ? info.score : undefined;
          if (nodes !== undefined) {
            updateEngineInfo({ depth, nodes, evalScore });
            if (typeof updateEngineInfo.flush === 'function') updateEngineInfo.flush();
            setTimeout(() => { try { clearEngineInfo(); } catch (e) { /* ignore */ } }, 800);
          }
        } catch (e) { /* ignore */ }
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
            const depth = (msg && Number.isFinite(msg.depth)) ? msg.depth : settings.searchDepth;
            const evalScore = (msg && Number.isFinite(msg.score)) ? msg.score : undefined;
            updateEngineInfo({ depth, nodes: msg.nodes, evalScore });
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
	try { document.body.classList.add('drawer-open'); } catch (e) { /* ignore */ }
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
	try { document.body.classList.remove('drawer-open'); } catch (e) { /* ignore */ }
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
	try { renderMoveList(); } catch (e) { /* ignore */ }
  }

  function openSearchPanel(opts) {
    if (!_mobileNavState.enabled) return;
    const shouldFocus = !(opts && opts.focus === false);
    openMovesPanel();
    _setActiveDrawerTab('search');
    openDrawer('search');
	try { renderMoveList(); } catch (e) { /* ignore */ }
    if (shouldFocus) {
      setTimeout(() => {
        const el = document.getElementById('openings-explorer-filter');
        if (el && !el.disabled) {
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
    // Apply the currently-selected difficulty at the moment Start is pressed.
    // This prevents falling back to the default (level 5) if the <select>
    // change event didn’t fire (e.g. some mobile/UI edge cases).
    const level = (diffSelect && diffSelect.value) ? Number(diffSelect.value) : selectedDiff;
    setDifficulty(level);
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
  if (btnEngineTests) {
    btnEngineTests.addEventListener("click", () => {
      try { window.open('core_engine_tests.html', '_blank', 'noopener'); } catch (e) { /* ignore */ }
    });
  }
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




