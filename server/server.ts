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

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const clients = new Map<string, GamePlayer>();
const sockets = new Map<string, Socket>();
const queue: string[] = [];
const games = new Map<string, GameState>();

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
        const payload = jwt.decode(token) as { sub: string; email: string };
        console.log('Decoded JWT payload:', payload);
        if (!payload?.sub) {
            console.log('JWT missing sub field');
            return null;
        }
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', payload.sub)
            .single();
        if (error || !data) {
            console.log('Supabase profile lookup failed:', error);
            return null;
        }
        return data;
    } catch (err) {
        console.log('JWT decode error:', err);
        return null;
    }
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

    socket.on('disconnect', () => {
        console.log('Backend: Client disconnected:', socket.id);
        clients.delete(socket.id);
        sockets.delete(socket.id);
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
        const game = games.get(gameId);
        if (!game) return;
        const playerIndex = game.players.findIndex((p) => p.id === socket.id);
        if (playerIndex === -1 || playerIndex !== game.currentTurn) return;
        const opponentIndex = 1 - playerIndex;
        const attacker = game.players[playerIndex].inPlayCards[detail.attacker];
        const defender = game.players[opponentIndex].inPlayCards[detail.opponent];
        if (!attacker || !defender) return;
        const attackerStat = strains[attacker.index][detail.stat];
        defender.hp -= attackerStat;
        const isKilled = defender.hp <= 0;
        if (isKilled) defender.hp = 0;
        game.players[playerIndex].inPlayCards[detail.attacker] = attacker;
        game.players[opponentIndex].inPlayCards[detail.opponent] = defender;
        socket.emit('attack', { yourIndex: detail.attacker, theirIndex: detail.opponent, kill: isKilled });
        const opponentSocket = sockets.get(game.players[opponentIndex].id);
        opponentSocket?.emit('attack', { yourIndex: detail.opponent, theirIndex: detail.attacker, kill: isKilled });
        if (isKilled) {
            delete game.players[opponentIndex].inPlayCards[detail.opponent];
            game.players[opponentIndex].deadCards.push(defender);
            if (game.players[opponentIndex].inPlayCards.every((c) => !c)) {
                if (game.players[opponentIndex].cards.length === 0) {
                    // Game over - XP/level updates now handled by secure API
                    const winner = clients.get(game.players[playerIndex].id);
                    const loser = clients.get(game.players[opponentIndex].id);
                    
                    // Send game over messages
                    socket.emit('gameMessage', `You win! Victory achieved!`);
                    socket.emit('gameOver', { winner: winner?.username });
                    
                    opponentSocket?.emit('gameMessage', `You lose! Better luck next time!`);
                    opponentSocket?.emit('gameOver', { winner: winner?.username });
                    
                    // Clean up game
                    games.delete(gameId);
                    return;
                }
            }
        }
        
        // Only switch turns if this is the last attack
        if (detail.lastAttack) {
            game.currentTurn = opponentIndex;
        }
        
        socket.emit('syncState', game);
        opponentSocket?.emit('syncState', game);
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
