// PGN Parser for Chess2
// Usage: const games = parsePGN(pgnString);

function parsePGN(pgn) {
	// Remove semicolon-prefixed comments (entire lines)
	pgn = pgn.replace(/^;.*$/gm, '');
	// Split into games (by blank lines between games)
	const games = [];
	const gameStrings = pgn.split(/\n\s*\n/).filter(s => s.match(/[a-zA-Z0-9]/));
	for (const gameStr of gameStrings) {
		const tags = {};
		let moves = [];
		let comments = [];
		let variations = [];
		// Extract tags
		const tagRegex = /\[(\w+)\s+"([^"]*)"\]/g;
		let tagMatch;
		while ((tagMatch = tagRegex.exec(gameStr)) !== null) {
			tags[tagMatch[1]] = tagMatch[2];
		}
		// Extract comments and moves
		// Find all comments and their positions
		let commentMatches = [];
		const commentRegex = /\{([^}]*)\}/g;
		let match;
		while ((match = commentRegex.exec(gameStr)) !== null) {
			commentMatches.push({ text: match[1].trim(), index: match.index });
		}
		// --- Variation Parsing ---
		// Find all variations and their positions
		let variationMatches = [];
		const variationRegex = /\(([^()]*)\)/g;
		let vmatch;
		while ((vmatch = variationRegex.exec(gameStr)) !== null) {
			variationMatches.push({ text: vmatch[1].trim(), index: vmatch.index });
		}
		// Remove tags, comments, and variations for move parsing
		let movesSection = gameStr.replace(/\[.*?\]/gs, '').replace(/\{[^}]*\}/g, '').replace(/\([^()]*\)/g, '');
		movesSection = movesSection.replace(/\d+\.(\.\.\.)?/g, ''); // Remove move numbers
		movesSection = movesSection.replace(/\s+/g, ' ');
		movesSection = movesSection.replace(/(1-0|0-1|1\/2-1\/2|\*)/g, '').trim();
		// Split moves
		if (movesSection.length > 0) {
			moves = movesSection.split(' ').filter(Boolean);
		}
		// Map comments to moves (approximate: after move, before next move)
		let moveComments = [];
		if (commentMatches.length > 0 && moves.length > 0) {
			// Find where each move appears in the original string
			let movePositions = [];
			let moveRegex = /([PNBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?|O-O(-O)?|0-0(-0)?)/g;
			let moveMatch;
			let lastIndex = 0;
			for (let m = 0; m < moves.length; m++) {
				let idx = gameStr.indexOf(moves[m], lastIndex);
				movePositions.push(idx);
				lastIndex = idx + 1;
			}
			// For each move, find comments that appear after it and before the next move
			for (let i = 0; i < moves.length; i++) {
				let cmt = null;
				for (let c = 0; c < commentMatches.length; c++) {
					if (commentMatches[c].index > (movePositions[i] || 0) && (i === moves.length - 1 || commentMatches[c].index < (movePositions[i + 1] || Infinity))) {
						cmt = commentMatches[c].text;
						break;
					}
				}
				moveComments.push(cmt);
			}
		} else {
			moveComments = moves.map(_ => null);
		}
		// Attach variations to moves (approximate: after move, before next move)
		let moveVariations = moves.map(_ => []);
		if (variationMatches.length > 0 && moves.length > 0) {
			let movePositions = [];
			let lastIndex = 0;
			for (let m = 0; m < moves.length; m++) {
				let idx = gameStr.indexOf(moves[m], lastIndex);
				movePositions.push(idx);
				lastIndex = idx + 1;
			}
			for (let v = 0; v < variationMatches.length; v++) {
				let vpos = variationMatches[v].index;
				for (let i = 0; i < moves.length; i++) {
					if (vpos > (movePositions[i] || 0) && (i === moves.length - 1 || vpos < (movePositions[i + 1] || Infinity))) {
						moveVariations[i].push(variationMatches[v].text);
						break;
					}
				}
			}
		}
		// Only add games with at least one move
		if (moves.length > 0) {
			games.push({ tags, moves, comments: moveComments, variations: moveVariations });
		}
	}
	return games;
}

// Example usage:
// const pgnText = ...; // Load from file or textarea

if (typeof window !== 'undefined') {
	window.parsePGN = parsePGN;
}
// const games = parsePGN(pgnText);
// games[0].moves -> array of SAN moves
// games[0].tags -> object of PGN tags
//



