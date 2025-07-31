import { CARDS_PER_PLAYER, strains } from '../../lib/config';

export type GameCard = {
	index: number;
	hp: number;
};
export type GamePlayer = {
	username: string;
	id: string;
	supabaseId?: string;
	xp?: number;
	level?: number;
	gameId?: string;
	cards: GameCard[];
	deadCards: GameCard[];
	inPlayCards: (GameCard | undefined)[];
};
export type GameState = {
	id: string;
	players: GamePlayer[];
	currentTurn: number;
};

export default function createNewGame(
	id: string,
	player1: GamePlayer,
	player2: GamePlayer
): GameState {
	player1.cards = createFixedDeck();
	player2.cards = createFixedDeck();
	player1.deadCards = [];
	player2.deadCards = [];
	player1.inPlayCards = [, player1.cards.shift()!, player1.cards.shift()!, undefined];
	player2.inPlayCards = [, player2.cards.shift()!, player2.cards.shift()!, undefined];
	const state = {
		id,
		players: [player1, player2],
		currentTurn: 0
	};
	return state;
}

const evaluateHP = (index: number): number => {
	const cardInfo = strains[index];
	if (cardInfo) {
		switch (cardInfo.Class) {
			case 'Rare':
				return 150;
				break;
			case 'Uncommon':
				return 120;
				break;
			case 'Epic':
				return 200;
				break;
			case 'Ultra Rare':
				return 175;
				break;
			case 'Legendary':
				return 250;
				break;
			default:
				return 100;
				break;
		}
	}

	return 0;
};

function createFixedDeck() {
	const shuffle = (array) => {
		for (let i = array.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[array[i], array[j]] = [array[j], array[i]];
		}
		return array;
	};

	const pickRandomIndexes = (indexes: number[], count: number): number[] => {
		const copy = [...indexes];
		const selected: number[] = [];
		for (let i = 0; i < count; i++) {
			const index = Math.floor(Math.random() * copy.length);
			selected.push(copy.splice(index, 1)[0]);
		}
		return selected;
	};

	// Collect indexes by class
	const byClass: Record<string, number[]> = {
		Legendary: [],
		Epic: [],
		'Ultra Rare': [],
		Rare: [],
		Uncommon: [],
		Common: []
	};

	strains.forEach((card, index) => {
		if (byClass[card.Class]) {
			byClass[card.Class].push(index);
		}
	});

	// Pick required number of indexes per class
	const selectedIndexes: number[] = [
		...pickRandomIndexes(byClass.Legendary, 1),
		...pickRandomIndexes(byClass.Epic, 1),
		...pickRandomIndexes(byClass['Ultra Rare'], 1),
		...pickRandomIndexes(byClass.Rare, 1),
		...pickRandomIndexes(byClass.Uncommon, 2),
		...pickRandomIndexes(byClass.Common, 2)
	];

	const values = selectedIndexes.map((i) => {
		return { index: i, hp: evaluateHP(i) };
	});

	return shuffle(values);
}

const createDeck = () => {
	const deck: GameCard[] = [];
	// get the maximum number of cards
	const maxCards = strains.length;

	// now fill deck with CARD_PER_PLAYER numbers between 0 and maxCards -1
	for (let i = 0; i < CARDS_PER_PLAYER; i++) {
		let card = Math.floor(Math.random() * maxCards);
		while (deck.some((c) => c.index === card)) {
			card = Math.floor(Math.random() * maxCards);
		}
		deck.push({ index: card, hp: evaluateHP(card) });
	}
	return deck;
};
