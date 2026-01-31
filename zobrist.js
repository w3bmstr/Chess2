// zobrist.js
function initZobrist() {
    const rand64 = function() { return BigInt.asUintN(64, BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) ^ (BigInt(Date.now()) << 21n)); };
    var pieces = [
        Array.from({ length: 6 }, function() { return Array.from({ length: 64 }, rand64); }),
        Array.from({ length: 6 }, function() { return Array.from({ length: 64 }, rand64); })
    ];
    var castling = Array.from({ length: 4 }, rand64); // WK, WQ, BK, BQ
    var ep = Array.from({ length: 8 }, rand64);
    var side = rand64();
    return { pieces: pieces, castling: castling, ep: ep, side: side };
}

var ZOBRIST = initZobrist();
