import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
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
app.use(cors());
app.use(express.json()); // Add JSON parsing middleware
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticPath = path.join(__dirname, '../build');
app.use(express.static(staticPath));

// Health check endpoint for Railway
app.get('/', (req, res) => res.send('OK'));

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
    try {
        const user = req.user;
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
        
        res.json({
            ...data,
            totalGames,
            winRate
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create user profile
app.post('/api/profile', authenticateToken, async (req: any, res) => {
    try {
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
        
        // Create new profile
        const newProfile = {
            id: userId,
            username: username.trim(),
            xp: 0,
            level: 1,
            wins: 0,
            losses: 0
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
        
        res.status(201).json(data);
    } catch (error) {
        console.error('Error creating profile:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Handle game result and update XP/stats
app.post('/api/game/result', authenticateToken, async (req: any, res) => {
    try {
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
        
        // Update profile with new stats
        const updates = {
            xp: newXp,
            level: newLevel,
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
        
        res.json({
            xpGained,
            oldLevel,
            newLevel,
            newStats: updatedProfile
        });
        
    } catch (error) {
        console.error('Error processing game result:', error);
        res.status(500).json({ error: 'Internal server error' });
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
        
        res.json(leaderboard);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ error: 'Internal server error' });
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
    
    // Store disconnected player data for potential reconnection
    const client = clients.get(socketId);
    if (client && client.supabaseId) {
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

function tryToMatch(socketId: string) {
    if (queue.length === 0) {
        queue.push(socketId);
        return;
    }
    let opponentId: string | undefined;
    while (queue.length > 0) {
        const candidate = queue.shift();
        if (candidate && candidate !== socketId && sockets.has(candidate) && clients.has(candidate)) {
            opponentId = candidate;
            break;
        }
    }
    if (!opponentId) {
        if (!queue.includes(socketId)) queue.push(socketId);
        return;
    }
    const player1 = clients.get(socketId);
    const player2 = clients.get(opponentId);
    const socket1 = sockets.get(socketId);
    const socket2 = sockets.get(opponentId);
    if (player1 && player2 && socket1 && socket2) {
        const gameId = `game-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const gameState = createNewGame(gameId, player1, player2);
        games.set(gameId, gameState);
        player1.gameId = gameId;
        player2.gameId = gameId;
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
        socket1.emit('syncState', gameState);
        socket2.emit('syncState', gameState);
    } else {
        if (socketId && !queue.includes(socketId)) queue.push(socketId);
        if (opponentId && !queue.includes(opponentId)) queue.push(opponentId);
    }
}

// Socket.IO authentication middleware with logging
io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    console.log('Received token:', token);
    if (!token) {
        console.log('No token received');
        return next(new Error('Authentication required'));
    }
    const user = await verifyToken(token);
    if (!user) {
        console.log('Token verification failed for:', token);
        return next(new Error('Invalid token'));
    }
    (socket as any).user = user;
    next();
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
            supabaseId: user.id,
            xp: user.xp,
            level: user.level,
            cards: [],
            deadCards: [],
            inPlayCards: []
        });
    }

    socket.on('disconnect', () => {
        console.log('Backend: Client disconnected:', socket.id);
        
        // Handle disconnection during active game
        handlePlayerDisconnection(socket.id);
        
        // Clean up client data
        clients.delete(socket.id);
        sockets.delete(socket.id);
        rateLimits.delete(socket.id); // Clean up rate limits
        
        // Remove from queue if present
        const idx = queue.indexOf(socket.id);
        if (idx !== -1) queue.splice(idx, 1);
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
        const client = clients.get(socket.id);
        if (client) client.username = username.trim();
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
            // SECURITY: Rate limiting
            if (!checkRateLimit(socket.id)) {
                console.log(`Rate limit exceeded for ${socket.id}`);
                socket.emit('error', 'Too many actions. Please slow down.');
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
            const attacker = game.players[playerIndex].inPlayCards[detail.attacker];
            const defender = game.players[opponentIndex].inPlayCards[detail.opponent];
            if (!attacker || !defender) {
                console.log(`Invalid cards for attack from ${socket.id}`);
                return;
            }
            
            // SECURITY: Validate attacker card index and stat
            if (!attacker.index || attacker.index < 0 || attacker.index >= strains.length) {
                console.log(`Invalid attacker card index: ${attacker.index}`);
                return;
            }
            
            const strain = strains[attacker.index];
            if (!strain || !strain[detail.stat] || typeof strain[detail.stat] !== 'number') {
                console.log(`Invalid stat ${detail.stat} for strain ${attacker.index}`);
                return;
            }
            
            // SECURITY: Validate defender is alive
            if (defender.hp <= 0) {
                console.log(`Attacking dead card from ${socket.id}`);
                return;
            }
            
            // Process attack
            const attackerStat = strain[detail.stat];
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
                defenderName: strains[game.players[opponentIndex].inPlayCards[detail.opponent]?.index]?.Strain || 'Unknown',
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
                defenderName: strains[game.players[opponentIndex].inPlayCards[detail.opponent]?.index]?.Strain || 'Unknown',
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
                delete game.players[opponentIndex].inPlayCards[detail.opponent];
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
                        const newCard = game.players[opponentIndex].cards.shift();
                        if (newCard) {
                            // Find first empty slot and place the card
                            for (let i = 0; i < 4; i++) {
                                if (!game.players[opponentIndex].inPlayCards[i]) {
                                    game.players[opponentIndex].inPlayCards[i] = newCard;
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
        const game = games.get(gameId);
        if (!game) return;
        const playerIndex = game.players.findIndex((p) => p.id === socket.id);
        if (playerIndex === -1 || playerIndex !== game.currentTurn) return;
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

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
