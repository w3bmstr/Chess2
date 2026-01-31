// puzzle_ui.js
// Handles puzzle selection, display, and user interaction

(function() {
  let currentPuzzle = null;
  let puzzleIndex = 0;

  function loadPuzzle(index) {
    if (!window.puzzles || index < 0 || index >= window.puzzles.length) return;
    currentPuzzle = window.puzzles[index];
    puzzleIndex = index;
    // Set up board from FEN
    if (window.setBoardFromFEN) window.setBoardFromFEN(currentPuzzle.fen);
    // Show puzzle description and FEN
    const puzzleDesc = document.getElementById('puzzle-desc');
    if (puzzleDesc) puzzleDesc.textContent = currentPuzzle.description || '';
    const puzzleFen = document.getElementById('puzzle-fen');
    if (puzzleFen) puzzleFen.textContent = currentPuzzle.fen;
    const puzzleTitle = document.getElementById('puzzle-title');
    if (puzzleTitle) puzzleTitle.textContent = currentPuzzle.title || `Puzzle ${index+1}`;
  }

  function checkSolution(moveHistory) {
    if (!currentPuzzle) return false;
    const solution = currentPuzzle.solution;
    for (let i = 0; i < moveHistory.length && i < solution.length; i++) {
      if (moveHistory[i] !== solution[i]) return false;
    }
    return moveHistory.length === solution.length;
  }

  window.nextPuzzle = function() {
    loadPuzzle((puzzleIndex + 1) % window.puzzles.length);
  };

  window.prevPuzzle = function() {
    loadPuzzle((puzzleIndex - 1 + window.puzzles.length) % window.puzzles.length);
  };


  function showPuzzleFeedback() {
    if (!window.state || !window.state.moveHistory) return;
    const correct = checkSolution(window.state.moveHistory);
    const feedback = document.getElementById('puzzle-feedback');
    if (feedback) feedback.textContent = correct ? "Correct!" : (window.state.moveHistory.length > 0 ? "Try again." : "");
    if (correct) {
      setTimeout(() => { window.nextPuzzle && window.nextPuzzle(); }, 1200);
    }
  }

  window.checkPuzzleSolution = function() {
    showPuzzleFeedback();
    return checkSolution(window.state.moveHistory);
  };

  // Listen for move events to show feedback automatically
  document.addEventListener('moveMade', function() {
    showPuzzleFeedback();
  });

  window.loadPuzzle = loadPuzzle;

  // Initialize first puzzle on load
  document.addEventListener('DOMContentLoaded', function() {
    loadPuzzle(0);
  });
})();
