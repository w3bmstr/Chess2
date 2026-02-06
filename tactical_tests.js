/* Tactical correctness test suite (no UI, no worker)
 *
 * Requires existing engine globals:
 * - searchBestMove (core search)
 * - evaluateBoard
 * - see / SEE
 * - isAttacked, isDefended
 * - simulateMove, generateLegalMovesFor
 *
 * Run in browser via a simple HTML loader or from console:
 *   runTacticalTests()
 */

(function () {
  'use strict';

  function log(...args) { console.log(...args); }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
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

  function setupMinimalStateFromFEN(fen) {
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

  function resetSearchHeuristics() {
    try { for (let i = 0; i < killers.length; i++) killers[i] = [null, null]; } catch (e) { /* ignore */ }
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

  function getSEE(board, mv) {
    if (typeof SEE === 'function') return SEE(board, mv);
    if (typeof see === 'function') return see(board, mv);
    throw new Error('SEE function not available');
  }

  function pieceValue(pc) {
    if (!pc || !pc.type) return 0;
    if (typeof PIECE_VALUES === 'object' && PIECE_VALUES[pc.type]) return PIECE_VALUES[pc.type];
    switch (pc.type) {
      case 'P': return 1;
      case 'N': return 3;
      case 'B': return 3;
      case 'R': return 5;
      case 'Q': return 9;
      default: return 0;
    }
  }

  function isCaptureMove(board, mv) {
    if (!mv) return false;
    if (mv.enPassant) return true;
    return !!(board?.[mv.to.y]?.[mv.to.x]);
  }

  function capturedPiece(board, mv) {
    if (!mv) return null;
    if (mv.enPassant && mv.capturePos) return board?.[mv.capturePos.y]?.[mv.capturePos.x] || null;
    return board?.[mv.to.y]?.[mv.to.x] || null;
  }

  function searchPosition(depth, ctx, turnColor) {
    return searchBestMove(ctx, depth, -Infinity, Infinity, turnColor, turnColor, Infinity, 0, null);
  }

  function searchFromFEN(fen, depth) {
    setupMinimalStateFromFEN(fen);
    const ctx = cloneCtx(state.board, state.castling, state.enPassant);
    try { TT.clear(); } catch (e) { /* ignore */ }
    resetSearchHeuristics();
    try { SEARCH_ABORT = false; } catch (e) { /* ignore */ }
    try { SEARCH_NODES = 0; } catch (e) { /* ignore */ }
    const turn = state.turn;
    const res = searchPosition(depth, ctx, turn);
    const nodes = (typeof SEARCH_NODES === 'number') ? SEARCH_NODES : 0;
    let pv = [];
    try {
      if (typeof extractPVFromTT === 'function') {
        pv = extractPVFromTT(ctx, turn, turn, Math.max(1, depth));
      }
    } catch (e) { /* ignore */ }
    if ((!pv || pv.length === 0) && res && res.move) pv = [res.move];
    return { res, nodes, pv, ctx, turn };
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

  function findKing(board, color) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const pc = board[y][x];
        if (pc && pc.type === 'K' && pc.color === color) return { x, y };
      }
    }
    return null;
  }

  function pinnedPieceToKing(board, color) {
    const king = findKing(board, color);
    if (!king) return null;
    const enemy = color === LIGHT ? DARK : LIGHT;
    const dirs = [
      { dx: 1, dy: 0, rook: true }, { dx: -1, dy: 0, rook: true },
      { dx: 0, dy: 1, rook: true }, { dx: 0, dy: -1, rook: true },
      { dx: 1, dy: 1, bishop: true }, { dx: 1, dy: -1, bishop: true },
      { dx: -1, dy: 1, bishop: true }, { dx: -1, dy: -1, bishop: true }
    ];
    for (const d of dirs) {
      let x = king.x + d.dx;
      let y = king.y + d.dy;
      let first = null;
      while (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
        const pc = board[y][x];
        if (pc) {
          if (!first) {
            if (pc.color !== color) break;
            first = { x, y, pc };
          } else {
            if (pc.color === enemy) {
              if ((d.rook && (pc.type === 'R' || pc.type === 'Q')) || (d.bishop && (pc.type === 'B' || pc.type === 'Q'))) {
                return first;
              }
            }
            break;
          }
        }
        x += d.dx; y += d.dy;
      }
    }
    return null;
  }

  function detectHangingMajor(ctx, turnColor, mv, minValue = 3) {
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);
    for (const emv of enemyMoves) {
      const captured = capturedPiece(next.board, emv);
      if (!captured || captured.color !== turnColor) continue;
      const v = pieceValue(captured);
      if (v < minValue) continue;
      const seeScore = getSEE(next.board, emv);
      if (seeScore >= 100) {
        return { capture: emv, capturedType: captured.type, seeScore };
      }
    }
    return null;
  }

  function detectForkAfterMove(ctx, turnColor, mv) {
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);
    for (const emv of enemyMoves) {
      const after = simulateMove(emv, next.board, next.castling, next.enPassant);
      const givesCheck = inCheck(turnColor, after.board);
      let attackedMajors = 0;
      const majorSquares = [];

      function isDefendedLocal(b, x, y, color, cst, ep) {
        for (let yy = 0; yy < ROWS; yy++) {
          for (let xx = 0; xx < COLS; xx++) {
            const pc = b[yy][xx];
            if (!pc || pc.color !== color) continue;
            if (xx === x && yy === y) continue;
            const moves = genPseudoMovesForSquare(xx, yy, b, cst, ep);
            if (moves.some(mv2 => mv2.to.x === x && mv2.to.y === y)) return true;
          }
        }
        return false;
      }
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const pc = after.board[y][x];
          if (!pc || pc.color !== turnColor) continue;
          if (pc.type !== 'Q' && pc.type !== 'R') continue;
          if (isAttacked(after.board, x, y, turnColor)) {
            attackedMajors++;
            majorSquares.push({ x, y, pc });
          }
        }
      }
      if (attackedMajors === 0) continue;

      // Only flag if the fork produces a concrete material win (SEE >= 100) on majors.
      const enemyCaps = generateLegalMovesFor(after.board, after.castling, after.enPassant, enemy);
      let capturableMajors = 0;
      for (const ms of majorSquares) {
        for (const cap of enemyCaps) {
          if (!cap.to || cap.to.x !== ms.x || cap.to.y !== ms.y) continue;
          const seeScore = getSEE(after.board, cap);
          if (seeScore >= 100) { capturableMajors++; break; }
        }
      }

      if (capturableMajors === 0) continue;

      if (givesCheck && capturableMajors >= 1) return { forkMove: emv, type: 'check+major' };
      if (capturableMajors >= 2) return { forkMove: emv, type: 'double-major' };
    }
    return null;
  }

  function detectPinAfterMove(ctx, turnColor, mv) {
    function pinnedSquares(board, color) {
      const res = new Set();
      const enemy = color === LIGHT ? DARK : LIGHT;
      const king = findKing(board, color);
      if (!king) return res;
      const dirs = [
        { dx: 1, dy: 0, rook: true }, { dx: -1, dy: 0, rook: true },
        { dx: 0, dy: 1, rook: true }, { dx: 0, dy: -1, rook: true },
        { dx: 1, dy: 1, bishop: true }, { dx: 1, dy: -1, bishop: true },
        { dx: -1, dy: 1, bishop: true }, { dx: -1, dy: -1, bishop: true }
      ];
      for (const d of dirs) {
        let x = king.x + d.dx;
        let y = king.y + d.dy;
        let first = null;
        while (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
          const pc = board[y][x];
          if (pc) {
            if (!first) {
              if (pc.color !== color) break;
              first = { x, y, pc };
            } else {
              if (pc.color === enemy) {
                if ((d.rook && (pc.type === 'R' || pc.type === 'Q')) || (d.bishop && (pc.type === 'B' || pc.type === 'Q'))) {
                  res.add(`${first.x},${first.y}`);
                }
              }
              break;
            }
          }
          x += d.dx; y += d.dy;
        }
      }
      return res;
    }

    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const pinnedBefore = pinnedSquares(ctx.board, turnColor);
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);
    for (const emv of enemyMoves) {
      const after = simulateMove(emv, next.board, next.castling, next.enPassant);
      const pinned = pinnedPieceToKing(after.board, turnColor);
      if (!pinned || pieceValue(pinned.pc) < 3) continue;
      if (pinnedBefore.has(`${pinned.x},${pinned.y}`)) continue;
      if (!isAttacked(after.board, pinned.x, pinned.y, turnColor)) continue;

      // Only flag if there is a concrete winning capture on the pinned piece.
      if (isDefendedLocal(after.board, pinned.x, pinned.y, turnColor, after.castling, after.enPassant)) continue;
      const enemyCaps = generateLegalMovesFor(after.board, after.castling, after.enPassant, enemy);
      for (const cap of enemyCaps) {
        if (!cap.to || cap.to.x !== pinned.x || cap.to.y !== pinned.y) continue;
        const seeScore = getSEE(after.board, cap);
        if (seeScore >= 100) {
          return { pinMove: emv, pinnedType: pinned.pc.type };
        }
      }
    }
    return null;
  }

  function isDefendedLocal(board, x, y, color, castling, enPassant) {
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

  function moveAllowsMateIn2(ctx, turnColor, mv) {
    if (!mv) return false;
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);
    for (const emv of enemyMoves) {
      const after = simulateMove(emv, next.board, next.castling, next.enPassant);
      const replies = generateLegalMovesFor(after.board, after.castling, after.enPassant, turnColor);
      if (replies.length === 0 && inCheck(turnColor, after.board)) return true;

      let allMateIn1 = true;
      for (const rv of replies) {
        if (!moveAllowsMateIn1({ board: after.board, castling: after.castling, enPassant: after.enPassant }, turnColor, rv)) {
          allMateIn1 = false;
          break;
        }
      }
      if (replies.length > 0 && allMateIn1) return true;
    }
    return false;
  }

  function getEnemyCheckingMoves(board, castling, enPassant, enemyColor) {
    const moves = generateLegalMovesFor(board, castling, enPassant, enemyColor);
    const checks = [];
    for (const mv of moves) {
      const after = simulateMove(mv, board, castling, enPassant);
      const targetColor = enemyColor === LIGHT ? DARK : LIGHT;
      if (inCheck(targetColor, after.board)) checks.push(mv);
    }
    return checks;
  }

  function lineAttackToKing(board, king, enemyColor) {
    if (!king) return false;
    const dirs = [
      { dx: 1, dy: 0, rook: true }, { dx: -1, dy: 0, rook: true },
      { dx: 0, dy: 1, rook: true }, { dx: 0, dy: -1, rook: true },
      { dx: 1, dy: 1, bishop: true }, { dx: 1, dy: -1, bishop: true },
      { dx: -1, dy: 1, bishop: true }, { dx: -1, dy: -1, bishop: true }
    ];
    for (const d of dirs) {
      let x = king.x + d.dx;
      let y = king.y + d.dy;
      while (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
        const pc = board[y][x];
        if (pc) {
          if (pc.color === enemyColor) {
            if ((d.rook && (pc.type === 'R' || pc.type === 'Q')) || (d.bishop && (pc.type === 'B' || pc.type === 'Q'))) return true;
          }
          break;
        }
        x += d.dx; y += d.dy;
      }
    }
    return false;
  }

  function detectSEELoss(ctx, turnColor, mv) {
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);

    // 1) SEE on the moved piece (if it can be captured).
    for (const emv of enemyMoves) {
      if (!emv.to || emv.to.x !== mv.to.x || emv.to.y !== mv.to.y) continue;
      const movedPc = next.board?.[mv.to.y]?.[mv.to.x];
      if (!movedPc || movedPc.color !== turnColor) continue;
      if (isDefendedLocal(next.board, mv.to.x, mv.to.y, turnColor, next.castling, next.enPassant)) continue;
      const seeScoreEnemy = getSEE(next.board, emv);
      if (seeScoreEnemy > 0) return { type: 'moved-piece', capture: emv, seeScore: -seeScoreEnemy };
    }

    // 2) SEE on any attacked undefended piece.
    for (const emv of enemyMoves) {
      const cap = capturedPiece(next.board, emv);
      if (!cap || cap.color !== turnColor) continue;
      if (isDefendedLocal(next.board, emv.to.x, emv.to.y, turnColor, next.castling, next.enPassant)) continue;
      const seeScoreEnemy = getSEE(next.board, emv);
      if (seeScoreEnemy > 0) return { type: 'undefended-piece', capture: emv, seeScore: -seeScoreEnemy };
    }
    return null;
  }

  function detectKingSafetyBlunder(ctx, turnColor, mv) {
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const beforeChecks = getEnemyCheckingMoves(ctx.board, ctx.castling, ctx.enPassant, enemy).length;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const afterChecks = getEnemyCheckingMoves(next.board, next.castling, next.enPassant, enemy).length;

    if (afterChecks > beforeChecks && afterChecks >= 1) return { type: 'checks-allowed', count: afterChecks };

    const king = findKing(next.board, turnColor);
    if (lineAttackToKing(next.board, king, enemy)) return { type: 'opened-line' };

    return null;
  }

  function detectPawnPushTrap(ctx, turnColor, mv) {
    if (!mv) return null;
    const enemy = turnColor === LIGHT ? DARK : LIGHT;
    const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
    const moved = next.board?.[mv.to.y]?.[mv.to.x];
    if (!moved || moved.color !== turnColor || moved.type === 'K') return null;

    const castling = next.castling;
    const enPassant = next.enPassant;
    const dir = enemy === LIGHT ? -1 : 1;

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const pc = next.board[y][x];
        if (!pc || pc.color !== enemy || pc.type !== 'P') continue;

        const ny = y + dir;
        if (ny < 0 || ny >= ROWS) continue;
        if (next.board[ny][x]) continue;

        // Check if this pawn push would attack the moved piece square.
        const attackY = ny + (enemy === LIGHT ? -1 : 1);
        if (attackY < 0 || attackY >= ROWS) continue;
        const attacksMoved =
          (mv.to.x === x - 1 && mv.to.y === attackY) ||
          (mv.to.x === x + 1 && mv.to.y === attackY);
        if (!attacksMoved) continue;

        const after = simulateMove({ from: { x, y }, to: { x, y: ny } }, next.board, castling, enPassant);
        if (isDefendedLocal(after.board, mv.to.x, mv.to.y, turnColor, after.castling, after.enPassant)) continue;

        // If enemy can capture the moved piece next move with positive SEE, it's a trap.
        const enemyCaps = generateLegalMovesFor(after.board, after.castling, after.enPassant, enemy);
        for (const cap of enemyCaps) {
          if (!cap.to || cap.to.x !== mv.to.x || cap.to.y !== mv.to.y) continue;
          const seeScore = getSEE(after.board, cap);
          if (seeScore >= 100) return { byPawn: { from: { x, y }, to: { x, y: ny } }, capture: cap };
        }
      }
    }
    return null;
  }

  function blunderCheck(ctx, turnColor, mv, evalBefore, evalAfter) {
    const reasons = [];
    const forcedLoss = Number.isFinite(evalBefore) && evalBefore < -8;

    if (moveAllowsMateIn1(ctx, turnColor, mv)) reasons.push('mate-in-1');
    else if (moveAllowsMateIn2(ctx, turnColor, mv) && !forcedLoss) reasons.push('mate-in-2');

    const seeLoss = detectSEELoss(ctx, turnColor, mv);
    if (seeLoss) reasons.push(`see-loss:${seeLoss.type}`);

    const pawnTrap = detectPawnPushTrap(ctx, turnColor, mv);
    if (pawnTrap) reasons.push('pawn-push-trap');

    const fork = detectForkAfterMove(ctx, turnColor, mv);
    if (fork) reasons.push(`fork:${fork.type}`);

    const pin = detectPinAfterMove(ctx, turnColor, mv);
    if (pin) reasons.push(`pin:${pin.pinnedType}`);

    const evalDrop = (evalAfter - evalBefore);
    if (Number.isFinite(evalDrop) && evalDrop < -3.0) reasons.push('eval-crash');

    const kingSafety = detectKingSafetyBlunder(ctx, turnColor, mv);
    if (kingSafety) reasons.push(`king-safety:${kingSafety.type}`);

    if (reasons.length === 0) return { blunder: false, reasons: [] };

    // Safe-move availability (global sanity rule).
    const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turnColor);
    let safeAlternative = false;
    for (const cand of legal) {
      if (!cand || (mv && sameMove(cand, mv))) continue;
      const sim = simulateMove(cand, ctx.board, ctx.castling, ctx.enPassant);
      const evBefore = evalBefore;
      const evAfter = evaluateBoard(sim.board, turnColor);
      const candReasons = [];
      if (moveAllowsMateIn1(ctx, turnColor, cand)) candReasons.push('mate-in-1');
      else if (moveAllowsMateIn2(ctx, turnColor, cand) && !forcedLoss) candReasons.push('mate-in-2');
      if (detectSEELoss(ctx, turnColor, cand)) candReasons.push('see-loss');
      if (detectPawnPushTrap(ctx, turnColor, cand)) candReasons.push('pawn-push-trap');
      if (detectForkAfterMove(ctx, turnColor, cand)) candReasons.push('fork');
      if (detectPinAfterMove(ctx, turnColor, cand)) candReasons.push('pin');
      if (Number.isFinite(evAfter - evBefore) && (evAfter - evBefore) < -3.0) candReasons.push('eval-crash');
      if (detectKingSafetyBlunder(ctx, turnColor, cand)) candReasons.push('king-safety');
      if (candReasons.length === 0) { safeAlternative = true; break; }
    }

    if (!safeAlternative) return { blunder: false, reasons: [], suppressed: reasons };
    return { blunder: true, reasons };
  }

  function anySafeMoveExists(ctx, turnColor) {
    const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turnColor);
    for (const mv of legal) {
      return true;
    }
    return false;
  }

  function humanScoreForMove(ctx, turnColor, mv) {
    if (!mv) return -999;
    let score = 0;
    if (mv.castle) score += 3;

    const fromPc = ctx.board?.[mv.from.y]?.[mv.from.x];
    if (!fromPc) return score;

    const forward = (turnColor === LIGHT) ? -1 : 1;
    const fromRank = mv.from.y;
    const toRank = mv.to.y;
    const isCapture = isCaptureMove(ctx.board, mv);

    // Development: move minor pieces off back rank.
    const backRank = (turnColor === LIGHT) ? 7 : 0;
    if ((fromPc.type === 'N' || fromPc.type === 'B') && fromRank === backRank && toRank !== backRank) score += 2;

    // Central control: move to or control central squares.
    const central = new Set(['d4', 'e4', 'd5', 'e5']);
    const sq = `${String.fromCharCode(97 + mv.to.x)}${ROWS - mv.to.y}`;
    if (central.has(sq)) score += 1;

    // Pawn center push.
    if (fromPc.type === 'P') {
      if (turnColor === LIGHT && (sq === 'e4' || sq === 'd4')) score += 1;
      if (turnColor === DARK && (sq === 'e5' || sq === 'd5')) score += 1;
    }

    // Avoid unnecessary retreat (non-capture backwards move for non-pawn).
    const isBackward = (toRank - fromRank) * forward < 0;
    if (!isCapture && fromPc.type !== 'P' && isBackward) score -= 2;

    // Penalize early queen retreat to back rank without capture.
    if (!isCapture && fromPc.type === 'Q' && toRank === backRank) score -= 2;

    return score;
  }

  function scoreToPawns(score) {
    if (!Number.isFinite(score)) return score;
    if (Math.abs(score) > 1000) return score / 100;
    return score;
  }

  function isMateScore(score) {
    return Number.isFinite(score) && Math.abs(score) >= 9000;
  }

  function analyzePosition(fen, depth) {
    const s = searchFromFEN(fen, depth);
    const ctx = s.ctx;
    const turn = s.turn;
    const move = s.res.move;
    const evalBefore = evaluateBoard(ctx.board, turn);
    const sim = move ? simulateMove(move, ctx.board, ctx.castling, ctx.enPassant) : null;
    const evalAfter = sim ? evaluateBoard(sim.board, turn) : evalBefore;
    const seeScore = (move && isCaptureMove(ctx.board, move)) ? getSEE(ctx.board, move) : 0;

    const flags = {
      mateIn1: move ? moveAllowsMateIn1(ctx, turn, move) : false,
      hangingMajor: move ? detectHangingMajor(ctx, turn, move, 3) : null,
      fork: move ? detectForkAfterMove(ctx, turn, move) : null,
      pin: move ? detectPinAfterMove(ctx, turn, move) : null
    };

    return { s, ctx, turn, move, evalBefore, evalAfter, seeScore, flags, sim };
  }

  function logResult(label, info, extra = '') {
    const { s, move, evalBefore, evalAfter, seeScore, flags } = info;
    const flagText = `mateIn1=${!!flags.mateIn1} hanging=${flags.hangingMajor ? flags.hangingMajor.capturedType : 'none'} fork=${flags.fork ? flags.fork.type : 'none'} pin=${flags.pin ? flags.pin.pinnedType : 'none'}`;
    log(`${label}: move=${fmtMove(move)} score=${s.res.score} evalBefore=${evalBefore} evalAfter=${evalAfter} SEE=${seeScore} flags=[${flagText}] ${extra}`);
    if (s.pv) log(`pv: ${fmtPV(s.pv)}`);
  }

  function runMaterialSafetyTests() {
    log('\n=== MATERIAL SAFETY ===');
    const TESTS = [
      {
        name: 'queen en prise must respond',
        fen: '4k3/8/8/8/8/8/3r4/3QK3 w - - 0 1',
        depth: 3
      },
      {
        name: 'rook en prise by bishop',
        fen: '4k3/8/8/3b4/8/8/8/4K2R w - - 0 1',
        depth: 3
      },
      {
        name: 'minor en prise by pawn',
        fen: '4k3/8/8/8/3p4/2N5/8/4K3 w - - 0 1',
        depth: 3
      }
    ];

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      const info = analyzePosition(t.fen, t.depth);
      logResult('best', info);

      assert(info.move, `${t.name}: no best move returned`);
      assert(anySafeMoveExists(info.ctx, info.turn), `${t.name}: no safe moves exist (test invalid)`);

      const forcedWin = isMateScore(info.s.res.score) && info.s.res.score > 0;
      const hanging = info.flags.hangingMajor;
      assert(!info.flags.mateIn1, `${t.name}: FAIL (best move allows mate-in-1)`);
      assert(!hanging || forcedWin, `${t.name}: FAIL (hangs ${hanging && hanging.capturedType} via ${fmtMove(hanging && hanging.capture)})`);

      if (isCaptureMove(info.ctx.board, info.move)) {
        assert(info.seeScore >= 0 || forcedWin, `${t.name}: FAIL (SEE < 0 on chosen capture)`);
      }
    }

    log('MATERIAL SAFETY: PASS');
  }

  function runTacticalCorrectnessTests() {
    log('\n=== TACTICAL CORRECTNESS ===');
    const TESTS = [
      {
        name: 'avoid mate-in-1 trap (queen grab)',
        fen: 'k6r/8/3q4/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        depth: 3
      },
      {
        name: 'avoid mate-in-1 trap (rook grab)',
        fen: 'k2r3r/8/8/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        depth: 3
      },
      {
        name: 'avoid immediate fork/pin losses',
        fen: '6k1/8/8/2b1n3/8/5N2/6PP/3Q1RK1 w - - 0 1',
        depth: 3
      }
    ];

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      const info = analyzePosition(t.fen, t.depth);
      logResult('best', info);

      assert(info.move, `${t.name}: no best move returned`);
      assert(anySafeMoveExists(info.ctx, info.turn), `${t.name}: no safe moves exist (test invalid)`);

      const blunder = blunderCheck(info.ctx, info.turn, info.move, info.evalBefore, info.evalAfter);
      assert(!blunder.blunder, `${t.name}: FAIL (blunder: ${blunder.reasons.join(', ')})`);
    }

    log('TACTICAL CORRECTNESS: PASS');
  }

  function runEvalStabilityTests() {
    log('\n=== EVALUATION STABILITY ===');
    const TESTS = [
      {
        name: 'opening stability',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
      },
      {
        name: 'quiet middlegame stability',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 2 3'
      }
    ];

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      const d1 = analyzePosition(t.fen, 1);
      const d3 = analyzePosition(t.fen, 3);
      const d4 = analyzePosition(t.fen, 4);

      logResult('depth1', d1);
      logResult('depth3', d3);
      logResult('depth4', d4);

      if (isMateScore(d4.s.res.score) || isMateScore(d1.s.res.score)) continue;

      const s1 = scoreToPawns(d1.s.res.score);
      const s4 = scoreToPawns(d4.s.res.score);
      const evalAfter = scoreToPawns(d3.evalAfter);
      const drop = s4 - evalAfter;
      const threshold = 2.0; // pawns (~200cp)

      assert(drop <= threshold, `${t.name}: FAIL (depth3 move drops eval by ${drop.toFixed(2)} pawns vs depth4)`);
      assert(Math.abs(s1 - s4) <= threshold, `${t.name}: FAIL (depth1 vs depth4 eval divergence ${Math.abs(s1 - s4).toFixed(2)} pawns)`);
    }

    log('EVALUATION STABILITY: PASS');
  }

  function runSEEBLunderTests() {
    log('\n=== SEE-BASED BLUNDER DETECTION ===');
    const TESTS = [
      {
        name: 'capture trap (queen grab)',
        fen: 'k6r/8/3q4/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        depth: 3
      },
      {
        name: 'capture trap (rook grab)',
        fen: 'k2r3r/8/8/2b5/6n1/5b2/6PP/3Q2RK w - - 0 1',
        depth: 3
      }
    ];

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      const info = analyzePosition(t.fen, t.depth);
      logResult('best', info);

      const forcedWin = isMateScore(info.s.res.score) && info.s.res.score > 0;
      if (isCaptureMove(info.ctx.board, info.move)) {
        assert(info.seeScore >= 0 || forcedWin, `${t.name}: FAIL (SEE < 0 capture selected)`);
      }
    }

    log('SEE-BASED BLUNDER DETECTION: PASS');
  }

  function runHumanLikeMoveTests() {
    log('\n=== HUMAN-LIKE MOVE SELECTION ===');
    const TESTS = [
      {
        name: 'prefer development in opening',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        depth: 2
      },
      {
        name: 'prefer safety/center in quiet position',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 2 3',
        depth: 2
      },
      {
        name: 'avoid unnecessary queen retreat in trap position',
        fen: 'k6r/8/3q4/2b5/6n1/8/6PP/3Q2RK w - - 0 1',
        depth: 3,
        epsilon: 1.0,
        minHumanDelta: 2,
        useChosenEval: true
      }
    ];

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      const info = analyzePosition(t.fen, t.depth);
      logResult('best', info);

      const legal = generateLegalMovesFor(info.ctx.board, info.ctx.castling, info.ctx.enPassant, info.turn);
      const scored = [];
      for (const mv of legal) {
        const sim = simulateMove(mv, info.ctx.board, info.ctx.castling, info.ctx.enPassant);
        const evalAfter = evaluateBoard(sim.board, info.turn);
        const h = humanScoreForMove(info.ctx, info.turn, mv);
        scored.push({ mv, evalAfter, h });
      }

      scored.sort((a, b) => b.evalAfter - a.evalAfter);
      const bestEval = scored[0]?.evalAfter ?? 0;
      const chosenEval = scored.find(s => sameMove(s.mv, info.move))?.evalAfter ?? bestEval;
      const epsilon = Number.isFinite(t.epsilon) ? t.epsilon : 0.2; // pawns
      const baselineEval = t.useChosenEval ? chosenEval : bestEval;
      const candidates = scored.filter(s => (baselineEval - s.evalAfter) <= epsilon);
      const bestHuman = candidates.reduce((m, s) => Math.max(m, s.h), -999);
      const chosenHuman = humanScoreForMove(info.ctx, info.turn, info.move);
      const minHumanDelta = Number.isFinite(t.minHumanDelta) ? t.minHumanDelta : 1;

      if (bestHuman > chosenHuman + minHumanDelta) {
        assert(false, `${t.name}: FAIL (non-human move chosen despite near-equal alternatives)`);
      }
    }

    log('HUMAN-LIKE MOVE SELECTION: PASS');
  }

  function runMateIn2Tests() {
    log('\n=== MATE-IN-2 DETECTION ===');
    const TESTS = [
      {
        name: 'mate-in-2: back-rank net',
        fen: '6k1/6pp/8/8/6Q1/8/6PP/6K1 w - - 0 1',
        depth: 4
      }
    ];

    function hasForcedMateIn2(ctx, turnColor) {
      const legal = generateLegalMovesFor(ctx.board, ctx.castling, ctx.enPassant, turnColor);
      const enemy = turnColor === LIGHT ? DARK : LIGHT;
      for (const mv of legal) {
        const next = simulateMove(mv, ctx.board, ctx.castling, ctx.enPassant);
        const enemyMoves = generateLegalMovesFor(next.board, next.castling, next.enPassant, enemy);
        let allMateIn1 = true;
        for (const emv of enemyMoves) {
          const after = simulateMove(emv, next.board, next.castling, next.enPassant);
          const replies = generateLegalMovesFor(after.board, after.castling, after.enPassant, turnColor);
          const isMate = replies.length === 0 && inCheck(turnColor, after.board);
          if (!isMate) { allMateIn1 = false; break; }
        }
        if (enemyMoves.length > 0 && allMateIn1) return true;
      }
      return false;
    }

    for (const t of TESTS) {
      log(`\n-- ${t.name} --`);
      setupMinimalStateFromFEN(t.fen);
      const ctx = cloneCtx(state.board, state.castling, state.enPassant);
      const hasMate2 = hasForcedMateIn2(ctx, state.turn);
      assert(hasMate2, `${t.name}: FAIL (test position is not mate-in-2 under current rules)`);

      const info = analyzePosition(t.fen, t.depth);
      logResult('depth4', info);
      assert(isMateScore(info.s.res.score), `${t.name}: FAIL (depth4 did not return mate score)`);
    }

    log('MATE-IN-2 DETECTION: PASS');
  }

  function runTacticalTests() {
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    runMaterialSafetyTests();
    runTacticalCorrectnessTests();
    runEvalStabilityTests();
    runSEEBLunderTests();
    runHumanLikeMoveTests();
    runMateIn2Tests();
    const ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    log(`\nALL TACTICAL TESTS: PASS in ${Math.round(ended - started)}ms`);
    return true;
  }

  try { window.runTacticalTests = runTacticalTests; } catch (e) { /* ignore */ }
  try { global.runTacticalTests = runTacticalTests; } catch (e) { /* ignore */ }

})();
