// puzzles.js
// Stores chess puzzles for training and practice

window.puzzles = [
  {
    id: 1,
    title: "Mate in 1",
    fen: "6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
    solution: ["g2g3"],
    description: "White to move and checkmate in one."
  },
  {
    id: 2,
    title: "Fork Tactic",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 4",
    solution: ["Bxf7+", "Kxf7", "Nxe5+"],
    description: "White to move and win a pawn with a fork."
  },
  {
    id: 3,
    title: "Pin and Win",
    fen: "rnbqkb1r/ppp2ppp/3p1n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5",
    solution: ["Ng5", "Be6", "Nxe6"],
    description: "White to move and attack the pinned knight."
  },
  {
    id: 4,
    title: "Remove the Defender",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 4",
    solution: ["Ng5", "Qxg5", "Nxg5"],
    description: "White to move and remove the defender."
  },
  {
    id: 5,
    title: "Open the f-file",
    fen: "rnbqkbnr/ppp2ppp/3p4/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5",
    solution: ["Bxe6", "fxe6"],
    description: "White to move and open the f-file."
  }
];
