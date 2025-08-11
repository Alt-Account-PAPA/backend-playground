import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import createNewGame, { GameState, GamePlayer } from '../src/lib/util/createNewGame';
import { strains } from '../src/lib/config';
import { fileURLToPath } from 'url';
import path from 'path';

// Attack type determination
type AttackType = 'fire' | 'ice' | 'arcane' | 'dark';

function getAttackType(cardIndex: number, stat: string): AttackType {
    const card = strains[cardIndex];
    if (!card) return 'ice';
    
    const ability = card.Abliity?.toLowerCase() || '';
    const description = card.Description?.toLowerCase() || '';
    const strain = card.Strain?.toLowerCase() || '';
    
    // Fire type
    if (
        ability.includes('fire') ||
        ability.includes('inferno') ||
        ability.includes('flame') ||
        description.includes('fire') ||
        description.includes('inferno') ||
        strain.includes('red') ||
        strain.includes('cheetos') ||
        strain.includes('ak-47')
    ) {
        return 'fire';
    }
    
    // Ice type
    if (
        ability.includes('frost') ||
        ability.includes('ice') ||
        ability.includes('chill') ||
        description.includes('frost') ||
        description.includes('ice') ||
        description.includes('icy') ||
        strain.includes('gelato') ||
        strain.includes('mint')
    ) {
        return 'ice';
    }
    
    // Dark type
    if (
        ability.includes('dark') ||
        ability.includes('toxic') ||
        ability.includes('venom') ||
        ability.includes('rotten') ||
        description.includes('dark') ||
        description.includes('toxic') ||
        description.includes('venom') ||
        description.includes('noxious') ||
        strain.includes('venom') ||
        strain.includes('skunk') ||
        strain.includes('oreoz')
    ) {
        return 'dark';
    }
    
    // Arcane type
    if (
        ability.includes('celestial') ||
        ability.includes('space') ||
        ability.includes('cosmic') ||
        ability.includes('lunar') ||
        ability.includes('dismiss') ||
        ability.includes('sunborn') ||
        description.includes('celestial') ||
        description.includes('space') ||
        description.includes('cosmic') ||
        description.includes('galaxy') ||
        strain.includes('alien') ||
        strain.includes('divine') ||
        strain.includes('star') ||
        strain.includes('moon') ||
        strain.includes('malawi')
    ) {
        return 'arcane';
    }
    
    // Default based on card class
    switch (card.Class) {
        case 'Legendary': return 'arcane';
        case 'Epic': return 'fire';
        case 'Ultra Rare': return 'dark';
        default: return 'ice';
    }
}

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const clients = new Map<string, GamePlayer>();
const sockets = new Map<string, Socket>();
const queue: string[] = [];
const games = new Map<string, GameState>();

// Track players currently in matchmaking to prevent double-matching
const playersInMatchmaking = new Set<string>();

// Track disconnected players for reconnection
const disconnectedPlayers = new Map<string, { 
    gameId: string; 
    playerData: GamePlayer; 
    disconnectTime: number;
    opponentSocketId: string;
}>();

// Reconnection timeout (30 seconds)
const RECONNECTION_TIMEOUT = 30000;

// Rate limiting for security
const rateLimits = new Map<string, { lastAction: number; actionCount: number }>();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_ACTIONS_PER_WINDOW = 5;

// Security: Check rate limits
function checkRateLimit(socketId: string): boolean {
    const now = Date.now();
    const limit = rateLimits.get(socketId) || { lastAction: 0, actionCount: 0 };
    
    if (now - limit.lastAction > RATE_LIMIT_WINDOW) {
        // Reset window
        limit.lastAction = now;
        limit.actionCount = 1;
    } else {
        limit.actionCount++;
        if (limit.actionCount > MAX_ACTIONS_PER_WINDOW) {
            return false; // Rate limited
        }
    }
    
    rateLimits.set(socketId, limit);
    return true;
}

// Security: Validate attack input
function validateAttackInput(detail: any): boolean {
    if (!detail || typeof detail !== 'object') return false;
    
    // Validate attacker index
    if (typeof detail.attacker !== 'number' || detail.attacker < 0 || detail.attacker > 3) {
        return false;
    }
    
    // Validate opponent index
    if (typeof detail.opponent !== 'number' || detail.opponent < 0 || detail.opponent > 3) {
        return false;
    }
    
    // Validate stat name
    if (typeof detail.stat !== 'string' || !detail.stat.trim()) {
        return false;
    }
    
    // Validate lastAttack flag
    if (typeof detail.lastAttack !== 'boolean') {
        return false;
    }
    
    return true;
}

const app = express();

// Enhanced CORS configuration for Railway deployment with preflight support
app.use(cors({
    origin: [
        'https://frontend-production-a9be.up.railway.app',
        'https://www.straintradingcardgame.com',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 200 // For legacy browser support
}));

// Explicit OPTIONS handler for all routes to handle CORS preflight requests
app.options('*', (req, res) => {
    console.log(`OPTIONS request for: ${req.path}`);
    res.header('Access-Control-Allow-Origin', 'https://frontend-production-a9be.up.railway.app');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200);
});

app.use(express.json()); // Add JSON parsing middleware
const httpServer = createServer(app);
const io = new Server(httpServer, { 
    cors: { origin: '*' },
    // Enhanced server-side connection stability
    pingTimeout: 120000, // 2 minutes - match client timeout
    pingInterval: 45000,  // 45 seconds - match client interval
    // Connection recovery settings
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    // Upgrade settings
    upgradeTimeout: 30000,
    // Additional stability options
    maxHttpBufferSize: 1e6, // 1MB
    allowRequest: (req, callback) => {
        // Basic rate limiting at connection level
        callback(null, true);
    }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticPath = path.join(__dirname, '../build');
app.use(express.static(staticPath));

// Health check endpoint for Railway
app.get('/', (req, res) => res.send('OK'));

// Debug endpoint to check server state
app.get('/debug/state', (req, res) => {
    const state = {
        queue: queue.length,
        activeGames: games.size,
        connectedClients: clients.size,
        connectedSockets: sockets.size,
        disconnectedPlayers: disconnectedPlayers.size,
        playersInMatchmaking: playersInMatchmaking.size,
        games: Array.from(games.entries()).map(([id, game]) => ({
            id,
            players: game.players.map(p => ({ id: p.id, username: p.username })),
            currentTurn: game.currentTurn
        }))
    };
    res.json(state);
});

// Authentication middleware for API routes
async function authenticateToken(req: any, res: any, next: any) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    const user = await verifyToken(token);
    if (!user) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    req.user = user;
    next();
}

// XP and Level calculation functions
function calculateLevel(xp: number): number {
    return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function getXpForLevel(level: number): number {
    return Math.pow(level - 1, 2) * 100;
}

function calculateXpGain(isWin: boolean, gameDuration?: number): number {
    const baseXp = isWin ? 100 : 25;
    const bonusXp = Math.floor(Math.random() * 50); // 0-49 random bonus
    return baseXp + bonusXp;
}

// API Routes

// Get user profile
app.get('/api/profile', authenticateToken, async (req: any, res) => {
    console.log('GET /api/profile request received');
    console.log('Headers:', req.headers);
    try {
        const user = req.user;
        
        // SECURITY: Guests don't have database profiles
        if (user.isGuest) {
            return res.status(403).json({ error: 'Guests do not have persistent profiles' });
        }
        
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();
            
        if (error) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        
        // Calculate additional stats
        const totalGames = data.wins + data.losses;
        const winRate = totalGames > 0 ? Math.round((data.wins / totalGames) * 100) : 0;
        
        return res.json({
            ...data,
            totalGames,
            winRate,
            coins: data.coins || 0 // Ensure coins field is included
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Update user profile (authenticated users only)
app.put('/api/profile', authenticateToken, async (req: any, res) => {
    try {
        // SECURITY: Prevent guests from updating database profiles
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests cannot update persistent profiles' });
        }
        
        const { username } = req.body;
        const userId = req.user.id;
        
        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'Valid username required' });
        }
        
        // SECURITY: Validate and sanitize username
        const sanitizedUsername = username.trim().replace(/[<>"'&]/g, '');
        if (sanitizedUsername.length < 3 || sanitizedUsername.length > 20) {
            return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
        }
        
        if (!/^[a-zA-Z0-9_\-\s]+$/.test(sanitizedUsername)) {
            return res.status(400).json({ error: 'Username contains invalid characters' });
        }
        
        // Get current profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
            
        if (profileError || !profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        
        // Update profile
        const { data: updatedProfile, error: updateError } = await supabase
            .from('profiles')
            .update({ username: sanitizedUsername })
            .eq('id', userId)
            .select()
            .single();
            
        if (updateError) {
            console.error('Error updating profile:', updateError);
            return res.status(500).json({ error: 'Failed to update profile' });
        }
        
        // Calculate additional stats
        const totalGames = updatedProfile.wins + updatedProfile.losses;
        const winRate = totalGames > 0 ? Math.round((updatedProfile.wins / totalGames) * 100) : 0;
        
        return res.json({
            ...updatedProfile,
            totalGames,
            winRate
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Create user profile
app.post('/api/profile', authenticateToken, async (req: any, res) => {
    try {
        // SECURITY: Prevent guests from creating database profiles
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests cannot create persistent profiles' });
        }
        
        const { username } = req.body;
        const userId = req.user.id;
        
        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'Valid username required' });
        }
        
        // Check if profile already exists
        const { data: existing } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', userId)
            .single();
            
        if (existing) {
            return res.status(409).json({ error: 'Profile already exists' });
        }
        
        // Create new profile with starter coins
        const newProfile = {
            id: userId,
            username: username.trim(),
            xp: 0,
            level: 1,
            wins: 0,
            losses: 0,
            coins: 200 // Starting coins for new players
        };
        
        const { data, error } = await supabase
            .from('profiles')
            .insert([newProfile])
            .select()
            .single();
            
        if (error) {
            console.error('Error creating profile:', error);
            return res.status(500).json({ error: 'Failed to create profile' });
        }
        
        // Assign starter cards (2 uncommon + 6 common)
        await assignStarterCards(userId);
        
        return res.status(201).json(data);
    } catch (error) {
        console.error('Error creating profile:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Handle game result and update XP/stats
app.post('/api/game/result', authenticateToken, async (req: any, res) => {
    try {
        // SECURITY: Prevent guests from submitting results to database
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guest results are not saved to database' });
        }
        
        const { gameId, result, gameData } = req.body;
        const userId = req.user.id;
        
        // Validate input
        if (!gameId || !result || !['win', 'loss'].includes(result)) {
            return res.status(400).json({ error: 'Invalid game result data' });
        }
        
        // Get current profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
            
        if (profileError || !profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        
        // Calculate XP gain
        const xpGained = calculateXpGain(result === 'win');
        const newXp = profile.xp + xpGained;
        const oldLevel = profile.level;
        const newLevel = calculateLevel(newXp);
        
        // Calculate coin reward (10 coins for win, 5 for loss)
        const coinReward = result === 'win' ? 10 : 5;
        const newCoins = (profile.coins || 0) + coinReward;
        
        // Update profile with new stats
        const updates = {
            xp: newXp,
            level: newLevel,
            coins: newCoins,
            ...(result === 'win' ? { wins: profile.wins + 1 } : { losses: profile.losses + 1 })
        };
        
        const { data: updatedProfile, error: updateError } = await supabase
            .from('profiles')
            .update(updates)
            .eq('id', userId)
            .select()
            .single();
            
        if (updateError) {
            console.error('Error updating profile:', updateError);
            return res.status(500).json({ error: 'Failed to update profile' });
        }
        
        // Log game result for audit trail
        await supabase
            .from('game_results')
            .insert({
                game_id: gameId,
                player_id: userId,
                result,
                xp_gained: xpGained
            });
        
        return res.json({
            xpGained,
            oldLevel,
            newLevel,
            coinReward,
            newStats: updatedProfile
        });
        
    } catch (error) {
        console.error('Error processing game result:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to assign starter cards to new players
async function assignStarterCards(userId: string) {
    try {
        // Get all common and uncommon cards from strains
        const commonCards: number[] = [];
        const uncommonCards: number[] = [];
        
        for (let i = 0; i < strains.length; i++) {
            const card = strains[i];
            if (card.Class === 'Common') {
                commonCards.push(i);
            } else if (card.Class === 'Uncommon') {
                uncommonCards.push(i);
            }
        }
        
        // Randomly select 2 uncommon and 6 common cards
        const selectedUncommon: number[] = [];
        const selectedCommon: number[] = [];
        
        // Select 2 random uncommon cards
        while (selectedUncommon.length < 2 && uncommonCards.length > 0) {
            const randomIndex = Math.floor(Math.random() * uncommonCards.length);
            const cardIndex = uncommonCards[randomIndex];
            if (!selectedUncommon.includes(cardIndex)) {
                selectedUncommon.push(cardIndex);
            }
        }
        
        // Select 6 random common cards
        while (selectedCommon.length < 6 && commonCards.length > 0) {
            const randomIndex = Math.floor(Math.random() * commonCards.length);
            const cardIndex = commonCards[randomIndex];
            if (!selectedCommon.includes(cardIndex)) {
                selectedCommon.push(cardIndex);
            }
        }
        
        // Combine all starter cards
        const starterCards = [...selectedUncommon, ...selectedCommon];
        
        // Insert cards into player inventory
        const inventoryInserts = starterCards.map(cardIndex => ({
            player_id: userId,
            card_index: cardIndex,
            quantity: 1
        }));
        
        const { error: inventoryError } = await supabase
            .from('player_inventory')
            .insert(inventoryInserts);
            
        if (inventoryError) {
            console.error('Error inserting starter cards:', inventoryError);
            throw inventoryError;
        }
        
        console.log(`Assigned ${starterCards.length} starter cards to user ${userId}`);
    } catch (error) {
        console.error('Error assigning starter cards:', error);
        throw error;
    }
}

// Get player's card inventory
app.get('/api/inventory', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests do not have persistent inventory' });
        }
        
        const { data, error } = await supabase
            .from('player_inventory')
            .select('*')
            .eq('player_id', req.user.id)
            .order('card_index');
            
        if (error) {
            console.error('Error fetching inventory:', error);
            return res.status(500).json({ error: 'Failed to fetch inventory' });
        }
        
        const totalCards = data?.reduce((sum, card) => sum + card.quantity, 0) || 0;
        
        return res.json({
            cards: data || [],
            totalCards
        });
    } catch (error) {
        console.error('Error fetching inventory:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Buy a card pack
app.post('/api/cards/buy-pack', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests cannot buy card packs' });
        }
        
        const userId = req.user.id;
        const packCost = 100;
        
        // Get current profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('coins')
            .eq('id', userId)
            .single();
            
        if (profileError || !profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        
        if (profile.coins < packCost) {
            return res.status(400).json({ error: 'Insufficient coins' });
        }
        
        // Determine card rarity based on probability
        const random = Math.random() * 100;
        let rarity: string;
        let cardIndex: number;
        
        if (random < 0.5) {
            rarity = 'Legendary';
        } else if (random < 2) {
            rarity = 'Ultra Rare';
        } else if (random < 8) {
            rarity = 'Epic';
        } else if (random < 20) {
            rarity = 'Rare';
        } else if (random < 50) {
            rarity = 'Uncommon';
        } else {
            rarity = 'Common';
        }
        
        // Get cards of the selected rarity
        const cardsOfRarity: number[] = [];
        for (let i = 0; i < strains.length; i++) {
            if (strains[i].Class === rarity) {
                cardsOfRarity.push(i);
            }
        }
        
        if (cardsOfRarity.length === 0) {
            // Fallback to common if no cards of selected rarity
            for (let i = 0; i < strains.length; i++) {
                if (strains[i].Class === 'Common') {
                    cardsOfRarity.push(i);
                }
            }
            rarity = 'Common';
        }
        
        // Select random card from the rarity
        cardIndex = cardsOfRarity[Math.floor(Math.random() * cardsOfRarity.length)];
        
        // Update player coins
        const { error: coinsError } = await supabase
            .from('profiles')
            .update({ coins: profile.coins - packCost })
            .eq('id', userId);
            
        if (coinsError) {
            console.error('Error updating coins:', coinsError);
            return res.status(500).json({ error: 'Failed to update coins' });
        }
        
        // Add card to inventory
        const { data: existingCard } = await supabase
            .from('player_inventory')
            .select('quantity')
            .eq('player_id', userId)
            .eq('card_index', cardIndex)
            .single();
            
        if (existingCard) {
            // Update existing card quantity
            const { error: updateError } = await supabase
                .from('player_inventory')
                .update({ quantity: existingCard.quantity + 1 })
                .eq('player_id', userId)
                .eq('card_index', cardIndex);
                
            if (updateError) {
                console.error('Error updating card quantity:', updateError);
                return res.status(500).json({ error: 'Failed to update inventory' });
            }
        } else {
            // Insert new card
            const { error: insertError } = await supabase
                .from('player_inventory')
                .insert({
                    player_id: userId,
                    card_index: cardIndex,
                    quantity: 1
                });
                
            if (insertError) {
                console.error('Error inserting new card:', insertError);
                return res.status(500).json({ error: 'Failed to add card to inventory' });
            }
        }
        
        return res.json({
            card_index: cardIndex,
            rarity: rarity,
            remaining_coins: profile.coins - packCost
        });
        
    } catch (error) {
        console.error('Error buying card pack:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get player's decks
app.get('/api/decks', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests do not have persistent decks' });
        }
        
        const { data, error } = await supabase
            .from('player_decks')
            .select('*')
            .eq('player_id', req.user.id)
            .order('created_at');
            
        if (error) {
            console.error('Error fetching decks:', error);
            return res.status(500).json({ error: 'Failed to fetch decks' });
        }
        
        return res.json(data || []);
    } catch (error) {
        console.error('Error fetching decks:', error);
        return res.status(500).json({ error: 'Failed to fetch decks' });
    }
});

// Get player's active deck
app.get('/api/decks/active', authenticateToken, async (req: any, res) => {
    console.log('GET /api/decks/active request received');
    console.log('Headers:', req.headers);
    try {
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests do not have persistent decks' });
        }
        
        const { data, error } = await supabase
            .from('player_decks')
            .select('*')
            .eq('player_id', req.user.id)
            .eq('is_active', true)
            .single();
            
        if (error && error.code !== 'PGRST116') {
            console.error('Error fetching active deck:', error);
            return res.status(500).json({ error: 'Failed to fetch active deck' });
        }
        
        return res.json(data || null);
    } catch (error) {
        console.error('Error fetching active deck:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new deck
app.post('/api/decks', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.isGuest) {
            return res.status(403).json({ error: 'Guests cannot create persistent decks' });
        }
        
        const { name, cards, isActive } = req.body;
        const userId = req.user.id;
        
        if (!name || !cards || !Array.isArray(cards)) {
            return res.status(400).json({ error: 'Name and cards array required' });
        }
        
        if (cards.length !== 8) {
            return res.status(400).json({ error: 'Deck must contain exactly 8 cards' });
        }
        
        // Validate no duplicate cards
        const cardIndexes = cards.map(c => c.cardIndex);
        const uniqueIndexes = new Set(cardIndexes);
        if (uniqueIndexes.size !== cardIndexes.length) {
            return res.status(400).json({ error: 'Deck cannot contain duplicate cards' });
        }
        
        // Validate player owns all cards
        for (const card of cards) {
            const { data: inventoryCard } = await supabase
                .from('player_inventory')
                .select('quantity')
                .eq('player_id', userId)
                .eq('card_index', card.cardIndex)
                .single();
                
            if (!inventoryCard || inventoryCard.quantity === 0) {
                return res.status(400).json({ error: `You don't own card ${card.cardIndex}` });
            }
        }
        
        // If setting as active, deactivate other decks first
        if (isActive) {
            await supabase
                .from('player_decks')
                .update({ is_active: false })
                .eq('player_id', userId);
        }
        
        const { data, error } = await supabase
            .from('player_decks')
            .insert({
                player_id: userId,
                name,
                cards,
                is_active: isActive || false
            })
            .select()
            .single();
            
        if (error) {
            console.error('Error creating deck:', error);
            return res.status(500).json({ error: 'Failed to create deck' });
        }
        
        return res.status(201).json(data);
    } catch (error) {
        console.error('Error creating deck:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('username, level, xp, wins, losses')
            .order('level', { ascending: false })
            .order('xp', { ascending: false })
            .limit(50);
            
        if (error) {
            console.error('Error fetching leaderboard:', error);
            return res.status(500).json({ error: 'Failed to fetch leaderboard' });
        }
        
        const leaderboard = data.map((player, index) => ({
            rank: index + 1,
            ...player,
            totalGames: player.wins + player.losses,
            winRate: player.wins + player.losses > 0 
                ? Math.round((player.wins / (player.wins + player.losses)) * 100) 
                : 0
        }));
        
        return res.json(leaderboard);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper: Verify Supabase JWT and get user profile
async function verifyToken(token: string) {
    try {
        // SECURITY FIX: Properly verify JWT signature with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            console.log('JWT verification failed:', error);
            return null;
        }
        
        // Get profile data
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();
            
        if (profileError || !profile) {
            console.log('Profile lookup failed:', profileError);
            return null;
        }
        
        return profile;
    } catch (err) {
        console.log('JWT verification error:', err);
        return null;
    }
}

// Helper function to find game by player socket ID
function findGameByPlayerId(socketId: string): GameState | null {
    for (const [gameId, game] of games.entries()) {
        if (game.players.some(player => player.id === socketId)) {
            return game;
        }
    }
    return null;
}

// Helper function to handle player disconnection during game
function handlePlayerDisconnection(socketId: string) {
    const game = findGameByPlayerId(socketId);
    if (!game) return;
    
    const playerIndex = game.players.findIndex(p => p.id === socketId);
    if (playerIndex === -1) return;
    
    const opponentIndex = 1 - playerIndex;
    const opponent = game.players[opponentIndex];
    const opponentSocket = sockets.get(opponent.id);
    
    // Store disconnected player data for potential reconnection (only for authenticated users)
    const client = clients.get(socketId);
    if (client && client.supabaseId && !client.isGuest) {
        disconnectedPlayers.set(client.supabaseId, {
            gameId: game.id,
            playerData: game.players[playerIndex],
            disconnectTime: Date.now(),
            opponentSocketId: opponent.id
        });
        
        console.log(`Player ${client.username} disconnected from game ${game.id}, allowing reconnection`);
        
        // Notify opponent about disconnection
        if (opponentSocket) {
            opponentSocket.emit('opponentDisconnected', {
                message: `${client.username} disconnected. They have ${RECONNECTION_TIMEOUT / 1000} seconds to reconnect.`,
                canReconnect: true,
                timeoutSeconds: RECONNECTION_TIMEOUT / 1000
            });
        }
        
        // Set timeout to clean up if no reconnection
        setTimeout(() => {
            const disconnectedData = disconnectedPlayers.get(client.supabaseId!);
            if (disconnectedData && disconnectedData.gameId === game.id) {
                // Player didn't reconnect, end the game
                console.log(`Player ${client.username} failed to reconnect, ending game ${game.id}`);
                
                disconnectedPlayers.delete(client.supabaseId!);
                games.delete(game.id);
                
                // Notify opponent of game end
                const currentOpponentSocket = sockets.get(disconnectedData.opponentSocketId);
                if (currentOpponentSocket) {
                    currentOpponentSocket.emit('gameOver', {
                        reason: 'opponent_disconnected',
                        message: `${client.username} failed to reconnect. You win by default!`,
                        winner: opponent.username
                    });
                    
                    // Put opponent back in queue
                    currentOpponentSocket.emit('opponentDisconnected', {
                        message: 'Opponent disconnected. Returning to lobby.',
                        canReconnect: false
                    });
                }
            }
        }, RECONNECTION_TIMEOUT);
    } else {
        // No reconnection possible, immediately end game
        console.log(`Player disconnected from game ${game.id}, ending game immediately`);
        
        games.delete(game.id);
        
        if (opponentSocket) {
            opponentSocket.emit('gameOver', {
                reason: 'opponent_disconnected',
                message: 'Opponent disconnected. You win by default!',
                winner: opponent.username
            });
            
            opponentSocket.emit('opponentDisconnected', {
                message: 'Opponent disconnected. Returning to lobby.',
                canReconnect: false
            });
        }
    }
}

// Helper function to attempt player reconnection
function attemptReconnection(socket: Socket, user: any): boolean {
    const disconnectedData = disconnectedPlayers.get(user.id);
    if (!disconnectedData) return false;
    
    const game = games.get(disconnectedData.gameId);
    if (!game) {
        // Game no longer exists
        disconnectedPlayers.delete(user.id);
        return false;
    }
    
    // Check if reconnection timeout has passed
    if (Date.now() - disconnectedData.disconnectTime > RECONNECTION_TIMEOUT) {
        disconnectedPlayers.delete(user.id);
        return false;
    }
    
    // Reconnect the player
    const playerIndex = game.players.findIndex(p => p.id === disconnectedData.playerData.id);
    if (playerIndex !== -1) {
        // Update the player's socket ID
        game.players[playerIndex].id = socket.id;
        
        // Update our tracking maps
        clients.set(socket.id, {
            ...disconnectedData.playerData,
            id: socket.id
        });
        sockets.set(socket.id, socket);
        
        // Notify both players of successful reconnection
        const opponentIndex = 1 - playerIndex;
        const opponentSocket = sockets.get(game.players[opponentIndex].id);
        
        socket.emit('gameReconnected', {
            gameState: game,
            playerNumber: playerIndex,
            opponentNumber: opponentIndex,
            message: 'Successfully reconnected to game!'
        });
        
        if (opponentSocket) {
            opponentSocket.emit('opponentReconnected', {
                message: `${user.username} reconnected to the game!`
            });
        }
        
        // Sync game state
        socket.emit('syncState', game);
        if (opponentSocket) {
            opponentSocket.emit('syncState', game);
        }
        
        // Clean up disconnection data
        disconnectedPlayers.delete(user.id);
        
        console.log(`Player ${user.username} successfully reconnected to game ${game.id}`);
        return true;
    }
    
    return false;
}

// Clean up stale queue entries
function cleanupQueue() {
    const validQueue: string[] = [];
    
    for (const socketId of queue) {
        if (sockets.has(socketId) && clients.has(socketId) && !findGameByPlayerId(socketId)) {
            validQueue.push(socketId);
        }
    }
    
    if (validQueue.length !== queue.length) {
        console.log(`Queue cleanup: ${queue.length} -> ${validQueue.length}`);
        queue.length = 0;
        queue.push(...validQueue);
    }
}

// Validate game state consistency
function validateGameState(gameId: string): boolean {
    const game = games.get(gameId);
    if (!game) return false;
    
    // Check if both players are still connected
    for (const player of game.players) {
        if (!sockets.has(player.id) || !clients.has(player.id)) {
            console.log(`Game ${gameId} has disconnected player ${player.id}`);
            return false;
        }
    }
    
    // Check if players are in different games
    for (const player of game.players) {
        const client = clients.get(player.id);
        if (client && client.gameId && client.gameId !== gameId) {
            console.log(`Player ${player.id} is in different game ${client.gameId} vs ${gameId}`);
            return false;
        }
    }
    
    return true;
}

// Fix game state conflicts
function resolveGameConflicts() {
    const gamesToRemove: string[] = [];
    
    for (const [gameId, game] of games.entries()) {
        if (!validateGameState(gameId)) {
            console.log(`Removing invalid game ${gameId}`);
            gamesToRemove.push(gameId);
            
            // Notify players if they're still connected
            for (const player of game.players) {
                const socket = sockets.get(player.id);
                if (socket) {
                    socket.emit('gameOver', {
                        reason: 'game_state_conflict',
                        message: 'Game ended due to connection issues. Please try again.'
                    });
                }
            }
        }
    }
    
    // Remove invalid games
    for (const gameId of gamesToRemove) {
        games.delete(gameId);
    }
    
    return gamesToRemove.length;
}

function tryToMatch(socketId: string) {
    // Prevent double-matching
    if (playersInMatchmaking.has(socketId)) {
        console.log(`Player ${socketId} already in matchmaking process`);
        return;
    }
    
    // Check if player is already in a game
    const existingGame = findGameByPlayerId(socketId);
    if (existingGame) {
        console.log(`Player ${socketId} already in game ${existingGame.id}`);
        return;
    }
    
    // Clean up stale queue entries
    cleanupQueue();
    
    if (queue.length === 0) {
        if (!queue.includes(socketId)) {
            queue.push(socketId);
            console.log(`Player ${socketId} added to queue. Queue length: ${queue.length}`);
        }
        return;
    }
    
    // Find a valid opponent
    let opponentId: string | undefined;
    while (queue.length > 0) {
        const candidate = queue.shift();
        if (candidate && 
            candidate !== socketId && 
            sockets.has(candidate) && 
            clients.has(candidate) &&
            !playersInMatchmaking.has(candidate) &&
            !findGameByPlayerId(candidate)) {
            opponentId = candidate;
            break;
        }
    }
    
    if (!opponentId) {
        if (!queue.includes(socketId)) {
            queue.push(socketId);
            console.log(`No valid opponent found. Player ${socketId} added to queue. Queue length: ${queue.length}`);
        }
        return;
    }
    
    // Mark both players as in matchmaking
    playersInMatchmaking.add(socketId);
    playersInMatchmaking.add(opponentId);
    
    const player1 = clients.get(socketId);
    const player2 = clients.get(opponentId);
    const socket1 = sockets.get(socketId);
    const socket2 = sockets.get(opponentId);
    
    if (player1 && player2 && socket1 && socket2) {
        try {
            const gameId = `game-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            const gameState = createNewGame(gameId, player1, player2);
            
            // Validate game creation
            if (!gameState || !gameState.players || gameState.players.length !== 2) {
                throw new Error('Failed to create valid game state');
            }
            
            games.set(gameId, gameState);
            player1.gameId = gameId;
            player2.gameId = gameId;
            
            console.log(`Match created: ${player1.username} vs ${player2.username} (Game: ${gameId})`);
            
            // Send match notifications
            socket1.emit('matchFound', {
                gameId,
                gameState,
                opponent: player2.username,
                playerNumber: 0,
                opponentNumber: 1
            });
            
            socket2.emit('matchFound', {
                gameId,
                gameState,
                opponent: player1.username,
                playerNumber: 1,
                opponentNumber: 0
            });
            
            // Sync initial game state
            socket1.emit('syncState', gameState);
            socket2.emit('syncState', gameState);
            
        } catch (error) {
            console.error('Error creating match:', error);
            
            // Return players to queue on error
            if (!queue.includes(socketId)) queue.push(socketId);
            if (!queue.includes(opponentId)) queue.push(opponentId);
        }
    } else {
        console.log('Invalid player data for match creation');
        
        // Return valid players to queue
        if (socketId && sockets.has(socketId) && clients.has(socketId) && !queue.includes(socketId)) {
            queue.push(socketId);
        }
        if (opponentId && sockets.has(opponentId) && clients.has(opponentId) && !queue.includes(opponentId)) {
            queue.push(opponentId);
        }
    }
    
    // Remove from matchmaking tracking
    playersInMatchmaking.delete(socketId);
    playersInMatchmaking.delete(opponentId);
}

// SECURITY: Socket.IO authentication middleware with guest support
// - Validates all tokens (both Supabase JWT and guest tokens)
// - Creates secure user objects for both authenticated and guest users
// - Prevents privilege escalation between user types
io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const isGuest = socket.handshake.auth?.isGuest;
    console.log('Received token:', token, 'isGuest:', isGuest);
    
    if (!token) {
        console.log('No token received');
        return next(new Error('Authentication required'));
    }
    
    if (isGuest) {
        // Handle guest users
        if (!token.startsWith('guest_')) {
            console.log('Invalid guest token format');
            return next(new Error('Invalid guest token'));
        }
        
        // Create a guest user object
        const guestId = token;
        const guestNumber = Math.floor(Math.random() * 9999) + 1;
        const guestUser = {
            id: guestId,
            username: `Guest${guestNumber}`,
            xp: 0,
            level: 1,
            wins: 0,
            losses: 0,
            isGuest: true
        };
        
        console.log('Guest user authenticated:', guestUser.username);
        (socket as any).user = guestUser;
        next();
    } else {
        // Handle regular authenticated users
        const user = await verifyToken(token);
        if (!user) {
            console.log('Token verification failed for:', token);
            return next(new Error('Invalid token'));
        }
        (socket as any).user = user;
        next();
    }
});

io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    console.log('Backend: Client connected:', socket.id, 'User:', user?.username);
    
    // Check if this is a reconnection to an existing game
    const reconnected = attemptReconnection(socket, user);
    
    if (!reconnected) {
        // New connection, set up normally
        sockets.set(socket.id, socket);
        clients.set(socket.id, {
            id: socket.id,
            username: user.username,
            supabaseId: user.isGuest ? null : user.id, // No supabase ID for guests
            xp: user.xp || 0,
            level: user.level || 1,
            cards: [],
            deadCards: [],
            inPlayCards: [],
            isGuest: user.isGuest || false
        });
    }

    socket.on('disconnect', () => {
        console.log('Backend: Client disconnected:', socket.id);
        
        // Handle disconnection during active game
        handlePlayerDisconnection(socket.id);
        
        // Clean up matchmaking tracking
        playersInMatchmaking.delete(socket.id);
        
        // Clean up client data
        clients.delete(socket.id);
        sockets.delete(socket.id);
        rateLimits.delete(socket.id);
        
        // Remove from queue if present
        const idx = queue.indexOf(socket.id);
        if (idx !== -1) {
            queue.splice(idx, 1);
            console.log(`Removed ${socket.id} from queue. Queue length: ${queue.length}`);
        }
        
        // Clean up any stale queue entries
        cleanupQueue();
    });

    // Robust joinQueue handler
    socket.on('joinQueue', (payload) => {
        if (!payload || typeof payload !== 'object') {
            socket.emit('error', 'Invalid payload');
            return;
        }
        
        const { username } = payload;
        if (!username || typeof username !== 'string' || !username.trim()) {
            socket.emit('error', 'Username required');
            return;
        }
        
        // SECURITY: Validate and sanitize username for all users (including guests)
        const sanitizedUsername = username.trim().replace(/[<>"'&]/g, '');
        if (sanitizedUsername.length < 3 || sanitizedUsername.length > 20) {
            socket.emit('error', 'Username must be between 3 and 20 characters');
            return;
        }
        
        if (!/^[a-zA-Z0-9_\-\s]+$/.test(sanitizedUsername)) {
            socket.emit('error', 'Username contains invalid characters');
            return;
        }
        
        // Check if player is already in a game
        const existingGame = findGameByPlayerId(socket.id);
        if (existingGame) {
            console.log(`Player ${socket.id} tried to join queue while in game ${existingGame.id}`);
            socket.emit('error', 'Already in a game');
            return;
        }
        
        // Check if player is already in matchmaking
        if (playersInMatchmaking.has(socket.id)) {
            console.log(`Player ${socket.id} tried to join queue while in matchmaking`);
            return;
        }
        
        const client = clients.get(socket.id);
        if (client) {
            client.username = sanitizedUsername; // Use sanitized username
            console.log(`Player ${client.username} (${socket.id}) joining queue`);
        }
        
        tryToMatch(socket.id);
    });

    const sendMessage = (game: GameState, msg: string) => {
        socket.emit('gameMessage', msg);
        const opponentIndex = 1 - game.currentTurn;
        const opponentSocket = sockets.get(game.players[opponentIndex].id);
        if (opponentSocket) opponentSocket.emit('gameMessage', msg);
    };

    socket.on('attack', async ({ gameId, detail }) => {
        try {
            // SECURITY: Rate limiting (applies to all users including guests)
            if (!checkRateLimit(socket.id)) {
                console.log(`Rate limit exceeded for ${socket.id}`);
                socket.emit('error', 'Too many actions. Please slow down.');
                return;
            }
            
            // SECURITY: Additional validation for all users
            const user = (socket as any).user;
            if (!user) {
                console.log(`No user data for ${socket.id}`);
                socket.emit('error', 'Authentication required');
                return;
            }
            
            // SECURITY: Input validation
            if (!validateAttackInput(detail)) {
                console.log(`Invalid attack input from ${socket.id}:`, detail);
                socket.emit('error', 'Invalid attack data');
                return;
            }
            
            // SECURITY: Validate game exists
            const game = games.get(gameId);
            if (!game) {
                console.log(`Game not found: ${gameId}`);
                return;
            }
            
            // SECURITY: Validate player and turn
            const playerIndex = game.players.findIndex((p) => p.id === socket.id);
            if (playerIndex === -1 || playerIndex !== game.currentTurn) {
                console.log(`Invalid turn for ${socket.id}`);
                return;
            }
            
            const opponentIndex = 1 - playerIndex;
            
            // SECURITY: Validate cards exist
            const attacker = game.players[playerIndex]?.inPlayCards[detail.attacker];
            const defender = game.players[opponentIndex]?.inPlayCards[detail.opponent];
            if (!attacker || !defender) {
                console.log(`Invalid cards for attack from ${socket.id}`);
                return;
            }
            
            // SECURITY: Validate attacker card index and stat
            if (attacker.index === undefined || attacker.index < 0 || attacker.index >= strains.length) {
                console.log(`Invalid attacker card index: ${attacker.index}`);
                return;
            }
            
            const strain = strains[attacker.index];
            if (!strain || !strain[detail.stat as keyof typeof strain] || typeof strain[detail.stat as keyof typeof strain] !== 'number') {
                console.log(`Invalid stat ${detail.stat} for strain ${attacker.index}`);
                return;
            }
            
            // SECURITY: Validate defender is alive
            if (defender.hp <= 0) {
                console.log(`Attacking dead card from ${socket.id}`);
                return;
            }
            
            // Process attack
            const attackerStat = strain[detail.stat as keyof typeof strain] as number;
            defender.hp -= attackerStat;
            const isKilled = defender.hp <= 0;
            if (isKilled) defender.hp = 0;
            
            // Update game state
            game.players[playerIndex].inPlayCards[detail.attacker] = attacker;
            game.players[opponentIndex].inPlayCards[detail.opponent] = defender;
            
            // Determine attack type
            const attackType = getAttackType(attacker.index, detail.stat);
            
            // Send attack events with detailed information
            const attackInfo = {
                yourIndex: detail.attacker,
                theirIndex: detail.opponent,
                kill: isKilled,
                attackerName: strain.Strain,
                defenderName: strains[defender.index]?.Strain || 'Unknown',
                stat: detail.stat,
                damage: attackerStat,
                color: strain.Primary,
                attackType: attackType
            };
            
            const opponentAttackInfo = {
                yourIndex: detail.opponent,
                theirIndex: detail.attacker,
                kill: isKilled,
                attackerName: strain.Strain,
                defenderName: strains[defender.index]?.Strain || 'Unknown',
                stat: detail.stat,
                damage: attackerStat,
                color: strain.Primary,
                attackType: attackType
            };
            
            socket.emit('attack', attackInfo);
            const opponentSocket = sockets.get(game.players[opponentIndex].id);
            opponentSocket?.emit('attack', opponentAttackInfo);
            
            // Handle death
            if (isKilled) {
                game.players[opponentIndex].inPlayCards[detail.opponent] = undefined;
                game.players[opponentIndex].deadCards.push(defender);
                
                // Check for game over
                if (game.players[opponentIndex].inPlayCards.every((c) => !c)) {
                    if (game.players[opponentIndex].cards.length === 0) {
                        // Game over - opponent has no cards left at all
                        const winner = clients.get(game.players[playerIndex].id);
                        
                        socket.emit('gameMessage', `You win! Victory achieved!`);
                        socket.emit('gameOver', { winner: winner?.username });
                        
                        opponentSocket?.emit('gameMessage', `You lose! Better luck next time!`);
                        opponentSocket?.emit('gameOver', { winner: winner?.username });
                        
                        // Clean up
                        games.delete(gameId);
                        rateLimits.delete(socket.id);
                        rateLimits.delete(game.players[opponentIndex].id);
                        return;
                    } else {
                        // Opponent has no cards in play but still has cards to draw
                        // Force opponent to draw a card if possible
                        const newCard = game.players[opponentIndex]?.cards.shift();
                        if (newCard) {
                            // Find first empty slot and place the card
                            for (let i = 0; i < 4; i++) {
                                if (!game.players[opponentIndex]?.inPlayCards[i]) {
                                    if (game.players[opponentIndex]) {
                                        game.players[opponentIndex].inPlayCards[i] = newCard;
                                    }
                                    break;
                                }
                            }
                            
                            // Notify players about the forced draw
                            socket.emit('gameMessage', `Opponent was forced to draw a card!`);
                            opponentSocket?.emit('gameMessage', `You were forced to draw a card since you had no cards in play!`);
                        }
                    }
                }
            }
            
            // Only switch turns if this is the last attack
            if (detail.lastAttack) {
                game.currentTurn = opponentIndex;
            }
            
            // Sync game state
            socket.emit('syncState', game);
            opponentSocket?.emit('syncState', game);
            
        } catch (error) {
            console.error(`Attack error for ${socket.id}:`, error);
            socket.emit('error', 'Attack failed');
        }
    });

    socket.on('makeMove', ({ gameId, detail }) => {
        // SECURITY: Rate limiting and validation for all users
        if (!checkRateLimit(socket.id)) {
            console.log(`Rate limit exceeded for ${socket.id}`);
            socket.emit('error', 'Too many actions. Please slow down.');
            return;
        }
        
        // SECURITY: User validation
        const user = (socket as any).user;
        if (!user) {
            console.log(`No user data for ${socket.id}`);
            socket.emit('error', 'Authentication required');
            return;
        }
        
        const game = games.get(gameId);
        if (!game) {
            console.log(`Game not found: ${gameId}`);
            return;
        }
        
        const playerIndex = game.players.findIndex((p) => p.id === socket.id);
        if (playerIndex === -1 || playerIndex !== game.currentTurn) {
            console.log(`Invalid turn for ${socket.id}`);
            return;
        }
        if (detail.type === 'drawCard') {
            const newCard = game.players[playerIndex].cards.shift();
            if (newCard) {
                for (let i = 0; i < 4; i++) {
                    if (!game.players[playerIndex].inPlayCards[i]) {
                        game.players[playerIndex].inPlayCards[i] = newCard;
                        break;
                    }
                }
            }
        }
        game.currentTurn = 1 - playerIndex;
        const opponentSocket = sockets.get(game.players[game.currentTurn].id);
        socket.emit('syncState', game);
        opponentSocket?.emit('syncState', game);
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
    });
});

// Periodic cleanup to prevent memory leaks and stale data
setInterval(() => {
    // Clean up stale queue entries
    cleanupQueue();
    
    // Resolve game state conflicts
    const conflictsResolved = resolveGameConflicts();
    if (conflictsResolved > 0) {
        console.log(`Resolved ${conflictsResolved} game state conflicts`);
    }
    
    // Clean up expired disconnected players
    const now = Date.now();
    for (const [userId, data] of disconnectedPlayers.entries()) {
        if (now - data.disconnectTime > RECONNECTION_TIMEOUT) {
            console.log(`Cleaning up expired disconnection data for user ${userId}`);
            disconnectedPlayers.delete(userId);
        }
    }
    
    // Clean up stale rate limits
    for (const [socketId, limit] of rateLimits.entries()) {
        if (now - limit.lastAction > RATE_LIMIT_WINDOW * 10) { // 10x the window
            rateLimits.delete(socketId);
        }
    }
    
    // Clean up matchmaking tracking for disconnected players
    for (const socketId of playersInMatchmaking) {
        if (!sockets.has(socketId)) {
            playersInMatchmaking.delete(socketId);
        }
    }
    
    // Log current state
    console.log(`Cleanup: ${queue.length} in queue, ${games.size} active games, ${disconnectedPlayers.size} disconnected players`);
}, 30000); // Every 30 seconds

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    console.log('✅ Matchmaking system initialized with conflict prevention');
    console.log('✅ CORS preflight handling enabled');
    console.log('✅ Ready to handle requests from frontend');
});
