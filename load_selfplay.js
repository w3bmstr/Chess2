// Loads and parses selfplay_games.pgn, prints moves for each game, and can display them in the moves window.
// Usage: Call loadAndShowSelfplayGames() from the browser console or UI.


function loadAndShowSelfplayGames() {
    if (!window.selfplayGames || !window.selfplayGames.length) {
        alert('No self-play games available.');
        return;
    }
    const games = window.selfplayGames;
    // Always load the starting FEN (standard chess)
    const startFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    if (typeof restoreFromFEN === 'function') {
        restoreFromFEN(startFEN);
    } else if (typeof window.setBoardFromFEN === 'function') {
        window.setBoardFromFEN(startFEN);
    }
    if (window.moveList) {
        window.moveList.innerHTML = `<pre>${games[0].moves.join(' ')}</pre>`;
    }
}

// To use: open the browser console and run loadAndShowSelfplayGames();
