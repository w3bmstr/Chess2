// Enhanced SAN generator for PGN matching (handles disambiguation)
function generateSAN(move, allMoves = []) {
    const sq = (x, y) => `${String.fromCharCode(97 + x)}${ROWS - y}`;
    if (move.castle === "kingside") return "O-O";
    if (move.castle === "queenside") return "O-O-O";
    const piece = move.piece || state.board[move.from.y][move.from.x];
    const capture = move.captured ? "x" : "";
    const promo = move.promo ? `=${move.promo}` : "";

    // Disambiguation for pieces (when multiple same-type pieces can move to the same square)
    let disamb = "";
    if (piece.type !== "P" && allMoves && allMoves.length) {
        const sameTo = allMoves.filter(mv => {
            const mvPiece = mv.piece || state.board[mv.from.y][mv.from.x];
            return mvPiece && mvPiece.type === piece.type && mv.to.x === move.to.x && mv.to.y === move.to.y && !(mv.from.x === move.from.x && mv.from.y === move.from.y);
        });
        if (sameTo.length > 0) {
            const conflictFile = sameTo.some(mv => mv.from.x === move.from.x);
            const conflictRank = sameTo.some(mv => mv.from.y === move.from.y);
            if (!conflictFile) disamb = String.fromCharCode(97 + move.from.x);
            else if (!conflictRank) disamb = String(ROWS - move.from.y);
            else disamb = `${String.fromCharCode(97 + move.from.x)}${ROWS - move.from.y}`;
        }
    }

    const fromFile = piece.type === "P" && capture ? String.fromCharCode(97 + move.from.x) : "";
    const pieceLetter = piece.type === "P" ? "" : piece.type;
    return `${pieceLetter}${disamb}${fromFile}${capture}${sq(move.to.x, move.to.y)}${promo}`;
}

// ========== PGN Multi-Game State ==========
let pgnGames = [];
let currentGameIndex = 0;

// Render basic game info (tags) and update UI buttons
function renderGameInfo() {
    if (typeof document === 'undefined') return;
    const wrapperEl = document.getElementById('pgn-nav-wrapper');
    const infoEl = document.getElementById('pgn-info');
    const idxEl = document.getElementById('pgn-game-index');
    const prevBtn = document.getElementById('btn-prev-pgn');
    const nextBtn = document.getElementById('btn-next-pgn');
    if (!infoEl) return;

    // Hide the whole PGN navigation block until we actually have games.
    if (!pgnGames || pgnGames.length === 0) {
        if (wrapperEl) wrapperEl.style.display = 'none';
        infoEl.innerHTML = '';
        if (idxEl) idxEl.textContent = '';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        const existingSelect = document.getElementById('pgn-game-select');
        if (existingSelect) existingSelect.remove();
        const existingMeta = document.getElementById('pgn-metadata');
        if (existingMeta) existingMeta.remove();
        return;
    }

    if (typeof currentGameIndex !== 'number' || currentGameIndex < 0 || currentGameIndex >= pgnGames.length) {
        currentGameIndex = 0;
    }

    const game = pgnGames[currentGameIndex];
    console.log('[PGN LOADER] renderGameInfo index:', currentGameIndex, 'total:', pgnGames.length, 'game:', game);
    if (!game) {
        if (wrapperEl) wrapperEl.style.display = 'none';
        infoEl.innerHTML = '';
        if (idxEl) idxEl.textContent = '';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        const existingSelect = document.getElementById('pgn-game-select');
        if (existingSelect) existingSelect.remove();
        const existingMeta = document.getElementById('pgn-metadata');
        if (existingMeta) existingMeta.remove();
        return;
    }

    if (wrapperEl) wrapperEl.style.display = 'flex';

    const tags = game.tags || {};
    let rows = [
        ['Event', tags.Event],
        ['Site', tags.Site],
        ['Date', tags.Date],
        ['Round', tags.Round],
        ['White', tags.White],
        ['Black', tags.Black],
        ['Result', tags.Result],
        ['ECO', tags.ECO]
    ].filter(r => r[1]);

    // If no standard tags found, show everything present in tags object
    if (rows.length === 0 && Object.keys(tags).length > 0) {
        rows = Object.keys(tags).map(k => [k, tags[k]]).filter(r => r[1]);
        console.log('[PGN LOADER] renderGameInfo using generic tags:', rows);
    }

    let html = '';
    for (const [k, v] of rows) html += `<div style="font-size:12px;color:var(--muted);margin:2px 0;"><strong style='color:var(--text)'>${k}:</strong> ${v}</div>`;
    if (!html) {
        // If tags exist but were empty strings, show raw tags for debugging
        if (Object.keys(tags).length > 0) {
            html = `<div style="font-size:12px;color:var(--muted);margin:2px 0;">${JSON.stringify(tags)}</div>`;
        } else {
            html = '<div style="color:var(--muted)">No metadata</div>';
        }
    }
    infoEl.innerHTML = html;

    // Also render metadata inside the Moves panel for easier discovery
    const moveListPanel = document.getElementById('move-list');
    if (moveListPanel) {
        let metaDiv = document.getElementById('pgn-metadata');
        if (!metaDiv) {
            metaDiv = document.createElement('div');
            metaDiv.id = 'pgn-metadata';
            metaDiv.style.fontSize = '12px';
            metaDiv.style.color = 'var(--muted)';
            metaDiv.style.margin = '6px 0 12px 0';
            metaDiv.style.paddingBottom = '6px';
            metaDiv.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
            moveListPanel.parentNode.insertBefore(metaDiv, moveListPanel);
        }
        metaDiv.innerHTML = html || '<div style="color:var(--muted)">No metadata</div>';
    } else {
        // Remove if panel doesn't exist
        const existingMeta = document.getElementById('pgn-metadata');
        if (existingMeta) existingMeta.remove();
    }

    // Update index and total
    if (idxEl) idxEl.textContent = `Game ${currentGameIndex + 1} / ${pgnGames.length}`;
    if (prevBtn) prevBtn.disabled = currentGameIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentGameIndex >= pgnGames.length - 1;

    // Create or populate a game select if multiple games
    let select = document.getElementById('pgn-game-select');
    if (!select && pgnGames.length > 1) {
        select = document.createElement('select');
        select.id = 'pgn-game-select';
        select.style.width = '100%';
        select.style.marginTop = '6px';
        select.addEventListener('change', function() {
            const v = parseInt(this.value, 10);
            if (!isNaN(v) && v >= 0 && v < pgnGames.length) {
                currentGameIndex = v;
                loadSingleGame(pgnGames[currentGameIndex]);
            }
        });
        infoEl.appendChild(select);
    }

    if (select) {
        // Populate options
        select.innerHTML = '';
        for (let i = 0; i < pgnGames.length; i++) {
            const g = pgnGames[i];
            const t = g.tags || {};
            const label = `${i + 1}: ${t.White || 'White'} vs ${t.Black || 'Black'} (${t.Date || 'unknown'})`;
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = label;
            if (i === currentGameIndex) opt.selected = true;
            select.appendChild(opt);
        }
        // Avoid accidental board interactions when the select is used on touch devices.
        select.addEventListener('mousedown', (e) => { try { e.stopPropagation(); } catch (err) {} }, { passive: true });
        select.addEventListener('touchstart', (e) => { try { e.stopPropagation(); } catch (err) {} }, { passive: true });
    } else {
        // If only one game, remove any existing select
        const existing = document.getElementById('pgn-game-select');
        if (existing) existing.remove();
    }
}

// Keyboard navigation support
(function() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', (e) => {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
        if (e.key === 'ArrowLeft') {
            if (currentGameIndex > 0) {
                currentGameIndex--; loadSingleGame(pgnGames[currentGameIndex]);
            }
        } else if (e.key === 'ArrowRight') {
            if (currentGameIndex < pgnGames.length - 1) {
                currentGameIndex++; loadSingleGame(pgnGames[currentGameIndex]);
            }
        }
    });
})();

// ========== PGN Loader: Multi-Game Support ==========
function loadPGNFromText(text) {
    console.log('[PGN LOADER] loadPGNFromText called with length:', text.length);

    // Sanitize input: strip BOM and normalize line endings
    if (text && text.length > 0) {
        text = text.replace(/^\uFEFF/, ''); // strip BOM if present
        text = text.replace(/\r\n/g, '\n');
    }

    let games = parsePGN(text);

    // Helper to build a raw PGN string from a parsed game object
    function buildRawFromGame(g) {
        const tags = g.tags || {};
        let s = '';
        for (const k of Object.keys(tags)) {
            s += `[${k} "${tags[k]}"]\n`;
        }
        s += '\n';
        if (g.moves && g.moves.length) s += g.moves.join(' ');
        return s;
    }

    // If parser returned games, ensure tags exist by extracting from original raw chunks
    if (games && games.length > 0 && typeof text === 'string') {
        // Split raw text into chunks (approximates parser's split)
        const rawParts = text.split(/\n\s*\n/).filter(s => s.match(/[a-zA-Z0-9]/));
        for (let i = 0; i < games.length; i++) {
            // Extract tags if missing
            if (!games[i].tags || Object.keys(games[i].tags).length === 0) {
                const part = rawParts[i] || '';
                const tags = {};
                part.replace(/\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g, (m, key, value) => { tags[key] = value; });
                if (Object.keys(tags).length > 0) {
                    console.log('[PGN LOADER] Extracted tags for game', i, tags);
                    games[i].tags = tags;
                }
            }
            // Ensure raw text is available for re-loading
            if (!games[i].raw) {
                games[i].raw = rawParts[i] ? rawParts[i].trim() : buildRawFromGame(games[i]);
            }
        }
    }

    // Fallback: if parsePGN returned no games, try manual extraction of game blocks
    if ((!games || games.length === 0) && typeof text === 'string') {
        console.warn('[PGN LOADER] parsePGN returned 0 games — attempting fallback extraction');
        const gameRegex = /(\[[^\]]+\][\s\S]*?)(?=\n\s*\n\[|$)/g;
        let m;
        const fallback = [];
        while ((m = gameRegex.exec(text)) !== null) {
            const chunk = m[1].trim();
            if (chunk) {
                const parsed = parsePGN(chunk);
                if (parsed && parsed.length > 0) {
                    fallback.push(parsed[0]);
                }
            }
        }
        if (fallback.length > 0) {
            games = fallback;
            console.log('[PGN LOADER] Fallback extracted games:', games.length);            // Ensure raw is set for fallback games
            for (let k = 0; k < games.length; k++) {
                if (!games[k].raw) games[k].raw = buildRawFromGame(games[k]);
            }        }
    }

    pgnGames = games || [];
    currentGameIndex = 0;
    console.log('[PGN LOADER] Parsed games:', pgnGames.length);

    // Update UI with count and selection
    try { renderGameInfo(); } catch (e) { console.warn('[PGN LOADER] renderGameInfo error:', e); }

    if (pgnGames.length > 0) {
        loadSingleGame(pgnGames[currentGameIndex]);
    } else {
        console.warn('[PGN LOADER] No valid PGN games found.');
        alert('No valid PGN games found. Please check file encoding or format.');
        console.log('[PGN LOADER] First 512 chars of input:', text.slice(0, 512));
    }
}

function loadSingleGame(game) {
    console.log('[PGN LOADER] loadSingleGame called with game:', game);

    // Accept raw PGN string or parsed game object. Ensure tags exist and save to state for UI.
    if (typeof game === 'string') {
        // Try to parse with parsePGN (preferred)
        const parsed = parsePGN(game);
        if (parsed && parsed.length > 0) {
            game = parsed[0];
        } else {
            // Extract tags manually BEFORE we strip them
            const tags = {};
            game.replace(/\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g, (m, key, value) => { tags[key] = value; });
            // Basic move extraction as fallback
            let body = game.replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').replace(/\([^)]*\)/g, '');
            body = body.replace(/\d+\.(\.\.\.)?/g, '').replace(/(1-0|0-1|1\/2-1\/2|\*)/g, '').replace(/\s+/g, ' ').trim();
            const moves = body.length > 0 ? body.split(' ').filter(Boolean) : [];
            game = { tags, moves, comments: [] };
        }
    }

    // Ensure tags are stored on the game object and in global state for UI
    if (!game.tags) game.tags = {};
    state.pgnTags = { ...(state.pgnTags || {}), ...game.tags };
    // Also ensure pgnGames[currentGameIndex] reflects full game object
    if (typeof currentGameIndex === 'number' && pgnGames && pgnGames.length > currentGameIndex) {
        pgnGames[currentGameIndex] = game;
    }

    console.log('[PGN LOADER] move count:', (game.moves || []).length, 'first moves:', (game.moves || []).slice(0, 10));

    if (typeof resetBoard === 'function') {
        console.log('[PGN LOADER] Calling resetBoard');
        resetBoard();
    }
    if (typeof render === 'function') {
        console.log('[PGN LOADER] Calling render');
        render();
        if (typeof resize === 'function') {
            console.log('[PGN LOADER] Calling resize after render');
            resize();
        }
    }

    let turnColor = LIGHT;
    for (let i = 0; i < game.moves.length; i++) {
        const rawSan = String(game.moves[i] || '').trim();
        const san = rawSan.replace(/[\+\#\!\?]+$/g, ''); // strip trailing check/mate/annotation symbols
        console.log('[PGN LOADER] Applying move:', rawSan, 'normalized:', san, 'index:', i);
        const legalMoves = generateLegalMoves(turnColor);
        let found = null;
        // Pre-populate piece/captured/promo fields for legal moves to enable disambiguation
        for (let j = 0; j < legalMoves.length; j++) {
            const mv = legalMoves[j];
            mv.piece = mv.piece || state.board[mv.from.y][mv.from.x];
            // Detect captures: explicit flag OR a piece currently on the destination OR en-passant
            const destPiece = state.board[mv.to.y][mv.to.x];
            mv.captured = !!mv.capture || (!!destPiece && mv.piece && destPiece.color !== mv.piece.color) || !!mv.enPassant;
            mv.promoted = mv.promo;
        }
        // Try exact SAN match first, then a permissive fallback (by piece+dest+capture)
        for (let j = 0; j < legalMoves.length; j++) {
            const move = legalMoves[j];
            const moveSan = generateSAN(move, legalMoves);
            // Only log matches or probable matches to reduce noise
            if (moveSan === san) console.log('[PGN LOADER] Match found (exact):', moveSan);
            if (i < 4 || moveSan === san) console.log('[PGN LOADER] Checking move:', moveSan, 'vs', san);
            if (moveSan === san) {
                found = move;
                break;
            }
        }
        // Fallback: permissive SAN matching
        if (!found) {
            const normalized = san;
            const dest = normalized.slice(-2);
            const destOk = /^[a-h][1-8]$/.test(dest);
            if (destOk) {
                for (let j = 0; j < legalMoves.length; j++) {
                    const mv = legalMoves[j];
                    const mvPiece = mv.piece || state.board[mv.from.y][mv.from.x];
                    const mvDest = `${String.fromCharCode(97 + mv.to.x)}${ROWS - mv.to.y}`;
                    const wantsCapture = normalized.includes('x');
                    const wantsPiece = /^[NBRQK]/.test(normalized) ? normalized[0] : 'P';
                    // Pawn-capture like exd5 indicates source file
                    let sourceFileReq = null;
                    if (!/^[NBRQK]/.test(normalized) && normalized.includes('x')) {
                        sourceFileReq = normalized[0];
                    }
                    if (mvDest !== dest) continue;
                    if ((mvPiece.type !== wantsPiece) && !(mvPiece.type === 'P' && wantsPiece === 'P')) continue;
                    if (wantsCapture && !mv.captured) continue;
                    if (sourceFileReq) {
                        const sf = String.fromCharCode(97 + mv.from.x);
                        if (sf !== sourceFileReq) continue;
                    }
                    console.log('[PGN LOADER] Match found (fallback):', generateSAN(mv, legalMoves), 'for requested', san);
                    found = mv;
                    break;
                }
            }
        }
        if (found) {
            const ok = makeMove(found);
            console.log('[PGN LOADER] makeMove returned:', ok, 'moveHistoryLen:', state.moveHistory.length, 'gameOver:', state.gameOver);
            if (!ok) {
                console.warn('[PGN LOADER] makeMove failed for SAN:', san, 'at index', i, 'stopping.');
                break;
            }
            if (game.comments[i]) {
                state.moveHistory[state.moveHistory.length - 1].pgnComment = game.comments[i];
            }
            // If the game ended after this move, stop processing further moves
            if (state.gameOver) {
                console.warn('[PGN LOADER] Game ended after move', san, 'at index', i, 'with result:', state.winner || state.message);
                break;
            }
            // Log current FEN for diagnostics
            try {
                console.log('[PGN LOADER] Current FEN:', boardToFEN());
            } catch (e) {
                console.log('[PGN LOADER] Could not compute FEN:', e);
            }
            turnColor = (turnColor === LIGHT ? DARK : LIGHT);
        } else {
            console.warn('[PGN LOADER] Could not find legal move for SAN:', san, 'at index', i, 'turn', turnColor ? 'DARK' : 'LIGHT');
            // Detailed dump of legal moves for diagnosis
            const detailed = legalMoves.map((mv, idx) => {
                const piece = state.board[mv.from.y][mv.from.x];
                const fromSq = `${String.fromCharCode(97 + mv.from.x)}${ROWS - mv.from.y}`;
                const toSq = `${String.fromCharCode(97 + mv.to.x)}${ROWS - mv.to.y}`;
                const sanGen = generateSAN(mv, legalMoves);
                return { idx, piece: piece ? piece.type : null, color: piece ? piece.color : null, from: fromSq, to: toSq, san: sanGen, captured: !!mv.capture, promo: mv.promo || null };
            });
            console.warn('[PGN LOADER] Legal moves detail (first 60):', detailed.slice(0, 60));

            // List candidates matching destination and piece type
            const dest = san.slice(-2);
            const wantsPiece = /^[NBRQK]/.test(san) ? san[0] : 'P';
            const candidates = detailed.filter(d => d.to === dest && (d.piece === wantsPiece || (wantsPiece === 'P' && d.piece === 'P')));
            console.warn('[PGN LOADER] Candidates for dest', dest, ':', candidates);

            if (candidates.length > 0) {
                const candidatesInfo = candidates.map(c => {
                    const mv = legalMoves[c.idx];
                    // Ensure piece info
                    mv.piece = mv.piece || state.board[mv.from.y][mv.from.x];
                    // Simulate move to check legality
                    const sim = simulateMove(mv, state.board, state.castling, state.enPassant);
                    const moverColor = mv.piece ? mv.piece.color : null;
                    const moverStillInCheck = moverColor !== null ? inCheck(moverColor, sim.board) : null;
                    return {
                        idx: c.idx,
                        piece: c.piece,
                        from: c.from,
                        to: c.to,
                        san: c.san,
                        captured: c.captured,
                        promo: c.promo,
                        simLegal: moverStillInCheck === false,
                        simBoardSnippet: sim.board.map(row => row.map(pc => pc ? pc.type + (pc.color === LIGHT ? 'w' : 'b') : '.').join('')).slice(0, 8)
                    };
                });
                console.warn('[PGN LOADER] Candidates simulated:', JSON.stringify(candidatesInfo, null, 2));
            }

            // Also show current board and last few moves for context
            try {
                console.warn('[PGN LOADER] Current FEN at failure:', boardToFEN());
            } catch (e) {
                console.warn('[PGN LOADER] Could not compute FEN at failure:', e);
            }
            console.warn('[PGN LOADER] Recent moveHistory:', state.moveHistory.slice(-6));
            break;
        }
    }
    if (typeof updateHud === 'function') updateHud();
    // Refresh UI info for the loaded game
    try { renderGameInfo(); } catch (e) { console.warn('[PGN LOADER] renderGameInfo error:', e); }
    console.log('[PGN LOADER] loadSingleGame complete');
}

// Define window.loadPGN immediately after functions
window.loadPGN = function(pgn) {
    loadPGNFromText(pgn);
};

// ========== PGN Navigation Buttons ==========
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        function mountPGNNavigation() {
            const wrapper = document.getElementById('pgn-nav-wrapper');
            if (!wrapper) return;
            const isMobileNav = !!(document.body && document.body.classList && document.body.classList.contains('mobile-nav'));

            const tools = document.getElementById('move-list-tools');
            if (tools && isMobileNav) {
                if (wrapper.parentNode !== tools) {
                    tools.appendChild(wrapper);
                }
                return;
            }

            if (isMobileNav) {
                // Prefer the Moves panel so it naturally lives inside the mobile drawer.
                const moveListPanel = document.getElementById('move-list');
                if (moveListPanel && moveListPanel.parentNode) {
                    const metaDiv = document.getElementById('pgn-metadata');
                    const anchor = metaDiv && metaDiv.parentNode === moveListPanel.parentNode ? metaDiv : moveListPanel;
                    if (wrapper.parentNode !== moveListPanel.parentNode) {
                        moveListPanel.parentNode.insertBefore(wrapper, anchor);
                    } else if (wrapper.nextSibling !== anchor) {
                        // Keep stable ordering: wrapper above metadata/move list.
                        moveListPanel.parentNode.insertBefore(wrapper, anchor);
                    }
                    return;
                }
            }

            // Desktop (or fallback): keep it with the standard controls.
            const controlsPanel = document.getElementById('controls');
            if (controlsPanel && wrapper.parentNode !== controlsPanel) {
                controlsPanel.appendChild(wrapper);
            }
        }
        window.mountPGNNavigation = mountPGNNavigation;

        const controlsPanel = document.getElementById('controls');
        if (controlsPanel && !document.getElementById('pgn-nav-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.id = 'pgn-nav-wrapper';
            wrapper.className = 'pgn-nav-wrapper';
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';
            wrapper.style.gap = '8px';

            const prevBtn = document.createElement('button');
            prevBtn.id = 'btn-prev-pgn';
            prevBtn.textContent = '◀ Prev';
            prevBtn.className = 'primary';
            prevBtn.onclick = function() {
                if (currentGameIndex > 0) {
                    currentGameIndex--;
                    loadSingleGame(pgnGames[currentGameIndex]);
                }
            };

            const infoDiv = document.createElement('div');
            infoDiv.id = 'pgn-info';
            infoDiv.style.minWidth = '220px';
            infoDiv.style.maxWidth = '420px';

            const idxSpan = document.createElement('div');
            idxSpan.id = 'pgn-game-index';
            idxSpan.style.fontSize = '12px';
            idxSpan.style.color = 'var(--muted)';

            const nextBtn = document.createElement('button');
            nextBtn.id = 'btn-next-pgn';
            nextBtn.textContent = 'Next ▶';
            nextBtn.className = 'primary';
            nextBtn.onclick = function() {
                if (currentGameIndex < pgnGames.length - 1) {
                    currentGameIndex++;
                    loadSingleGame(pgnGames[currentGameIndex]);
                }
            };

            const spacer = document.createElement('div');
            spacer.style.flex = '1';

            wrapper.appendChild(prevBtn);
            wrapper.appendChild(infoDiv);
            wrapper.appendChild(spacer);
            wrapper.appendChild(idxSpan);
            wrapper.appendChild(nextBtn);

            controlsPanel.appendChild(wrapper);
            // Initialize state and mount appropriately (desktop vs mobile drawer)
            renderGameInfo();
            mountPGNNavigation();

            // Keep placement correct if mobile-nav toggles on resize.
            let _pgnMountTimer = null;
            window.addEventListener('resize', () => {
                if (_pgnMountTimer) clearTimeout(_pgnMountTimer);
                _pgnMountTimer = setTimeout(() => {
                    try { mountPGNNavigation(); } catch (e) {}
                }, 80);
            });
        }
    });
}

// PGN Search Box removed: unified search lives in ui.js (Openings/PGN/Both).

// ========== Move List Comment Display ==========
// Patch for move list rendering: show comment under move in smaller font
if (typeof renderMoveList === 'function') {
    const origRenderMoveList = renderMoveList;
    window.renderMoveList = function() {
        let html = '';
        const moves = state.moveHistory;
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
            if (whiteMove && whiteMove.pgnComment) {
                html += `<div style='font-size:11px; color:var(--muted); margin:2px 0 4px 0; padding-left:8px;'>${whiteMove.pgnComment}</div>`;
            }
            html += '</div>';
            if (blackMove) {
                html += `<div style="cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.15s;" 
                    class="move-item" data-index="${i + 1}" 
                    onmouseover="this.style.background='rgba(110,193,255,0.15)'" 
                    onmouseout="this.style.background='transparent'">`;
                html += formatMove(blackMove);
                if (blackMove.pgnComment) {
                    html += `<div style='font-size:11px; color:var(--muted); margin:2px 0 4px 0; padding-left:8px;'>${blackMove.pgnComment}</div>`;
                }
                html += '</div>';
            } else {
                html += '<div></div>';
            }
        }
        document.getElementById('move-list').innerHTML = html;
    };
}
// Chess2: Add PGN load/copy button logic
// This file is auto-included for PGN support.
// See pgn_buttons.js for implementation.

// Chess2: PGN Loader and Search Integration
// This file exposes PGN loading and search for UI and button integration.

window.loadPGN = function(pgn) {
    // Accepts either a single PGN string or an array of games
    if (typeof pgn === 'string') {
        loadPGNFromText(pgn);
    } else if (Array.isArray(pgn) && pgn.length > 0) {
        loadPGNFromText(pgn.join('\n\n'));
    } else {
        alert('Invalid PGN data.');
    }
};

// Expose helper to inspect parsed PGN games
window.getPGNGames = function() {
    return pgnGames;
};

// Search PGN games by tag or move
window.searchPGNGames = function(query) {
    if (typeof window.getPGNGames === 'function') {
        const games = window.getPGNGames();
        // Simple search: match query in tags or moves
        return games.filter(g => {
            const tagMatch = Object.values(g.tags || {}).some(v => v && v.toLowerCase().includes(query.toLowerCase()));
            const moveMatch = (g.moves || []).join(' ').toLowerCase().includes(query.toLowerCase());
            return tagMatch || moveMatch;
        });
    }
    alert('PGN games not available for search.');
    return [];
};

// ========== PGN Loader: Reliable File Input and Button Integration ==========
(function() {
    if (typeof document === 'undefined') return;
    document.addEventListener('DOMContentLoaded', function() {
        // Ensure a single persistent hidden file input exists
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
                    try {
                        // Prefer ArrayBuffer so we can detect encoding reliably
                        const buffer = evt.target.result;
                        let encoding = 'utf-8';
                        const bytes = new Uint8Array(buffer);
                        if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
                            encoding = 'utf-16le';
                        } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
                            encoding = 'utf-16be';
                        } else if (bytes.includes(0)) {
                            // Presence of null bytes suggests UTF-16LE/BE; try little-endian first
                            encoding = 'utf-16le';
                        }
                        let text;
                        try {
                            text = new TextDecoder(encoding).decode(buffer);
                        } catch (e) {
                            console.warn('[PGN LOADER] TextDecoder failed for', encoding, e, 'falling back to utf-8');
                            text = new TextDecoder('utf-8').decode(buffer);
                            encoding = 'utf-8';
                        }
                        console.log('[PGN LOADER] File read; detected encoding:', encoding);
                        if (typeof window.loadPGN === 'function') {
                            window.loadPGN(text);
                        } else {
                            alert('PGN loader not found.');
                        }
                    } catch (err) {
                        console.error('[PGN LOADER] Failed to read file', err);
                        alert('Failed to read PGN file.');
                    }
                };
                // Read as ArrayBuffer for encoding detection
                reader.readAsArrayBuffer(file);
            });
            document.body.appendChild(fileInput);
        }

        // Ensure the Load PGN button triggers the file input
        function wireLoadPGNButton() {
            const btn = document.getElementById('btn-load-pgn');
            if (btn) {
                btn.onclick = function() {
                    fileInput.value = '';
                    fileInput.click();
                };
            }
        }
        // Try to wire immediately and also after any DOM changes
        wireLoadPGNButton();
        // Observe DOM changes to re-wire if needed
        const observer = new MutationObserver(wireLoadPGNButton);
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();