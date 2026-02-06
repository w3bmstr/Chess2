/* Engine-core verification tests (no UI, no worker)
 *
 * Covers:
 * - perft (move generation / branching integrity)
 * - eval ordering sanity on trivial positions
 * - search depth behavior on tactical positions
 *
 * Run in browser via core_engine_tests.html or in Node via run_core_engine_tests_node.js.
 */

(function () {
  'use strict';

  function log(...args) { console.log(...args); }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  function assertEq(actual, expected, label) {
    if (actual !== expected) {
      throw new Error(`${label || 'assertEq failed'}: expected ${expected}, got ${actual}`);
    }
  }

  function fmtMove(mv) {
    if (!mv) return '(none)';
    const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
    if (mv.castle === 'kingside') return 'O-O';
    if (mv.castle === 'queenside') return 'O-O-O';
    const promo = mv.promo ? `=${mv.promo}` : '';
    const ep = mv.enPassant ? ' e.p.' : '';
    return `${sq(mv.from.x, mv.from.y)}${sq(mv.to.x, mv.to.y)}${promo}${ep}`;
  }

  function fmtPV(pv) {
    if (!pv || !pv.length) return '(no pv)';
    return pv.slice(0, 8).map(fmtMove).join(' ');
  }

  function sameMove(a, b) {
    if (!a || !b) return false;
    if (a.castle || b.castle) return a.castle === b.castle;
    return (
      a.from.x === b.from.x && a.from.y === b.from.y &&
      a.to.x === b.to.x && a.to.y === b.to.y &&
      (a.promo || null) === (b.promo || null) &&
      !!a.enPassant === !!b.enPassant
    );
  }

  function isMoveLegalInCtx(ctx, turnColor, mv) {
    if (!mv) return false;
    const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turnColor);
    return legal.some(m => sameMove(m, mv));
  }

  function moveAllowsMateIn1(ctx, turnColor, mv) {
    if (!mv) return false;
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);

    for (const emv of enemyMoves) {
      const after = simulateMove(emv, next.board, next.castling, next.enPassant);
      const replies = generateLegalMovesFor(after.board, after.castling, after.enPassant, turnColor);
      if (replies.length === 0 && inCheck(turnColor, after.board)) return true;
    }
    return false;
  }

  function anySafeMoveExists(ctx, turnColor) {
    const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turnColor);
    for (const mv of legal) {
      if (!moveAllowsMateIn1(ctx, turnColor, mv)) return true;
    }
    return false;
  }

  function fmtSearchResult(label, s) {
    const cutInfo = (s && s.res && Object.prototype.hasOwnProperty.call(s.res, 'cut')) ? ` cut=${!!s.res.cut}` : '';
    return `${label}: move=${fmtMove(s.res.move)} score=${s.res.score} nodes=${s.nodes}${cutInfo} pv=${fmtPV(s.pv)}`;
  }

  function resetSearchHeuristics() {
    // Keep tests deterministic across multiple searches by clearing move-ordering
    // heuristics that intentionally learn during search.
    try {
      for (let i = 0; i < killers.length; i++) killers[i] = [null, null];
    } catch (e) { /* ignore */ }

    try {
      for (let c = 0; c < historyHeur.length; c++) {
        for (let i = 0; i < 64; i++) {
          for (let j = 0; j < 64; j++) historyHeur[c][i][j] = 0;
        }
      }
    } catch (e) { /* ignore */ }

    try {
      for (let c = 0; c < continuationHistory.length; c++) {
        for (let i = 0; i < 64; i++) {
          for (let j = 0; j < 64; j++) continuationHistory[c][i][j] = 0;
        }
      }
    } catch (e) { /* ignore */ }

    try {
      for (let c = 0; c < counterMoves.length; c++) {
        for (let i = 0; i < 64; i++) {
          for (let j = 0; j < 64; j++) counterMoves[c][i][j] = null;
        }
      }
    } catch (e) { /* ignore */ }
  }

  function setupMinimalStateFromFEN(fen) {
    // Ensure we have a global state object for eval/search code paths.
    if (typeof state === 'undefined' || !state) {
      // eslint-disable-next-line no-global-assign
      state = {};
    }
    const restored = fenToBoard(fen);
    state.board = restored.board;
    state.turn = restored.turn;
    state.castling = restored.castling;
    state.enPassant = restored.enPassant;
    state.halfmove = restored.halfmove || 0;
    state.fullmove = restored.fullmove || 1;
    state.moveHistory = [];
    state.positionHistory = [fen];
    state.repetition = { counts: Object.create(null) };
    state.gameOver = false;
    state.winner = null;
  }

  function perftFromPos(board, castling, enPassant, turnColor, depth) {
    if (depth <= 0) return 1;
    const moves = generateLegalMovesFor(board, castling, enPassant, turnColor);
    if (depth === 1) return moves.length;
    let nodes = 0;
    const nextTurn = turnColor === LIGHT ? DARK : LIGHT;
    for (const mv of moves) {
      const next = simulateMove(mv, board, castling, enPassant);
      nodes += perftFromPos(next.board, next.castling, next.enPassant, nextTurn, depth - 1);
    }
    return nodes;
  }

  function perftFromFEN(fen, depth) {
    const p = fenToBoard(fen);
    return perftFromPos(p.board, p.castling, p.enPassant, p.turn, depth);
  }

  function runPerftTests() {
    log('\n=== PERFT ===');

    // Standard startpos.
    const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const expected = [
      [1, 20],
      [2, 400],
      [3, 8902],
      [4, 197281]
    ];

    for (const [d, exp] of expected) {
      const got = perftFromFEN(STARTPOS, d);
      log(`startpos depth ${d}:`, got);
      assertEq(got, exp, `perft startpos depth ${d}`);
    }

    // Kiwipete (tests castling/complex legality). Known perft values.
    const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    const expectedK = [
      [1, 48],
      [2, 2039],
      [3, 97862]
    ];
    for (const [d, exp] of expectedK) {
      const got = perftFromFEN(KIWIPETE, d);
      log(`kiwipete depth ${d}:`, got);
      assertEq(got, exp, `perft kiwipete depth ${d}`);
    }

    log('PERFT: PASS');
  }

  function evalFenForWhite(fen) {
    setupMinimalStateFromFEN(fen);
    return evaluateBoard(state.board, LIGHT);
  }

  function runEvalTests() {
    log('\n=== EVAL ===');

    const EQUAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1';
    const WHITE_UP_QUEEN = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'; // black queen removed
    const BLACK_UP_ROOK = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w - - 0 1'; // white rook a1 removed

    const eq = evalFenForWhite(EQUAL);
    const wq = evalFenForWhite(WHITE_UP_QUEEN);
    const br = evalFenForWhite(BLACK_UP_ROOK);

    log('equal material eval:', eq);
    log('white up queen eval:', wq);
    log('black up rook eval:', br);

    assert(wq > eq + 3.0, 'eval should strongly prefer white up a queen');
    assert(eq > br + 2.0, 'eval should prefer equal over being down a rook');

    // Mate-in-1 is primarily a search/terminal property; static eval should at least
    // not contradict it catastrophically (queen near king should not be negative).
    const MATE_IN_1 = '7k/6Q1/7K/8/8/8/8/8 w - - 0 1';
    const m1 = evalFenForWhite(MATE_IN_1);
    log('mate-in-1 position static eval:', m1);
    assert(m1 > 0, 'static eval for mate-in-1 position should not be negative');

    log('EVAL: PASS');
  }

  function searchFromFEN(fen, depth) {
    setupMinimalStateFromFEN(fen);
    const ctx = cloneCtx(state.board, state.castling, state.enPassant);
    try { TT.clear(); } catch (e) { /* ignore */ }
    resetSearchHeuristics();
    try { SEARCH_ABORT = false; } catch (e) { /* ignore */ }
    try { SEARCH_NODES = 0; } catch (e) { /* ignore */ }
    const turn = state.turn;
    const res = searchBestMove(ctx, depth, -Infinity, Infinity, turn, turn, Infinity, 0, null);
    const nodes = (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : 0;
    let pv = [];
    try {
      if (typeof extractPVFromTT === 'function') {
        pv = extractPVFromTT(ctx, turn, turn, Math.max(1, depth));
      }
    } catch (e) { /* ignore */ }
    // Some fast-cutoff returns don't store a TT root entry, so PV extraction can be empty.
    // Fall back to showing at least the root best move.
    if ((!pv || pv.length === 0) && res && res.move) pv = [res.move];
    return { res, nodes, pv, ctx, turn };
  }

  function runSearchTests() {
    log('\n=== SEARCH ===');

    // 1) Mate-in-1 should be found at depth 1.
    const MATE_IN_1 = '7k/6Q1/7K/8/8/8/8/8 w - - 0 1';
    const e1 = evalFenForWhite(MATE_IN_1);
    const s1 = searchFromFEN(MATE_IN_1, 1);
    const s3 = searchFromFEN(MATE_IN_1, 3);
    log('mate-in-1 static eval:', e1);
    log(fmtSearchResult('mate-in-1 depth1', s1));
    log(fmtSearchResult('mate-in-1 depth3', s3));
    assert(Math.abs(s1.res.score) > 9000, 'depth1 search should return a mate score for mate-in-1');

    assert(isMoveLegalInCtx(s1.ctx, s1.turn, s1.res.move), 'mate-in-1: depth1 returned an illegal move');
    assert(isMoveLegalInCtx(s3.ctx, s3.turn, s3.res.move), 'mate-in-1: depth3 returned an illegal move');

    // 2) Tactical blunder avoidance: depth 3 should avoid moves that allow
    // an immediate mate-in-1 response (often missed by depth 1 due to quiescence
    // not exploring non-capture checks).
    const TACTICAL_BLUNDER_TESTS = [
      {
        name: 'queen grab loses to Nf2#',
        fen: 'k6r/8/3q4/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        trap: 'd1d6'
      },
      {
        name: 'rook grab loses to Nf2#',
        fen: 'k2r3r/8/8/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        trap: 'd1d8'
      },
      {
        name: 'another queen grab loses to Nf2#',
        fen: 'k6r/8/3q4/2b5/6n1/8/6PP/3Q2RK w - - 0 1',
        trap: 'd1d6'
      }
    ];

    for (const pos of TACTICAL_BLUNDER_TESTS) {
      log(`\n-- tactical blunder test: ${pos.name} --`);
      const te = evalFenForWhite(pos.fen);
      const t1 = searchFromFEN(pos.fen, 1);
      const t3 = searchFromFEN(pos.fen, 3);
      log('static eval:', te);
      log(fmtSearchResult('depth1', t1));
      log(fmtSearchResult('depth3', t3));

      assert(Number.isFinite(t1.res.score) && Number.isFinite(t3.res.score), `${pos.name}: search scores must be finite`);
      assert(!!t1.res.move && !!t3.res.move, `${pos.name}: search must return a move at depth 1 and depth 3`);
      assert(isMoveLegalInCtx(t1.ctx, t1.turn, t1.res.move), `${pos.name}: depth1 returned an illegal move`);
      assert(isMoveLegalInCtx(t3.ctx, t3.turn, t3.res.move), `${pos.name}: depth3 returned an illegal move`);

      // Sanity: ensure there exists at least one safe move (otherwise the test is invalid).
      assert(anySafeMoveExists(t3.ctx, t3.turn), `${pos.name}: no safe moves exist (mate-in-1 unavoidable?)`);

      const t1Trap = pos.trap ? fmtMove(t1.res.move) === pos.trap : false;
      const t3Trap = pos.trap ? fmtMove(t3.res.move) === pos.trap : false;
      const t1Mated = moveAllowsMateIn1(t1.ctx, t1.turn, t1.res.move);
      const t3Mated = moveAllowsMateIn1(t3.ctx, t3.turn, t3.res.move);

      log(`blunder check: trap=${pos.trap || '(none)'} depth1Trap=${t1Trap} depth3Trap=${t3Trap} depth1AllowsMateIn1=${t1Mated} depth3AllowsMateIn1=${t3Mated}`);

      // PASS/FAIL criterion:
      // depth 3 must avoid the blunder (i.e., must NOT allow an immediate mate-in-1 response).
      assert(!t3Mated, `${pos.name}: FAIL (depth 3 still allows mate-in-1)`);

      // Note: we intentionally do NOT assert a strict node expansion ratio here.
      // Some positions will produce early cutoffs at higher depth, and we only
      // care about the tactical blunder-avoidance property for these cases.
    }

    log('SEARCH: PASS');
  }

  function runCoreEngineTests() {
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    runPerftTests();
    runEvalTests();
    runSearchTests();
    const ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    log(`\nALL CORE TESTS: PASS in ${Math.round(ended - started)}ms`);
    return true;
  }

  // Expose for browser console and for the Node harness.
  const api = {
    runAll: runCoreEngineTests,
    runPerftTests,
    runEvalTests,
    runSearchTests,
    perftFromFEN,
    evalFenForWhite,
    searchFromFEN,
    resetSearchHeuristics,
    setupMinimalStateFromFEN,
    fmtMove,
    fmtPV
  };

  try { window.runCoreEngineTests = runCoreEngineTests; } catch (e) { /* ignore */ }
  try { global.runCoreEngineTests = runCoreEngineTests; } catch (e) { /* ignore */ }
  try { window.coreEngineTest = api; } catch (e) { /* ignore */ }
  try { global.coreEngineTest = api; } catch (e) { /* ignore */ }

})();
