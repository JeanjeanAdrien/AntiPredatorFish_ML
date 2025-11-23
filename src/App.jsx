import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, FastForward, RefreshCw, Brain, Eye, ShieldAlert } from 'lucide-react';

/**
 * CONFIGURATION & CONSTANTS
 */
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 400;
const FISH_SIZE = 12;
const PREDATOR_SIZE = 20;
const PREDATOR_SPEED = 2.0;
const FISH_SPEED = 3.5; // Le poisson est plus rapide s'il bouge bien
const N_ACTIONS = 5; // 0: Stay, 1: Up, 2: Down, 3: Left, 4: Right
const ACTIONS = [
  { x: 0, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 }
];

// Q-Learning Hyperparameters
const ALPHA = 0.1; // Learning Rate
const GAMMA = 0.9; // Discount Factor
const EPSILON_DECAY = 0.995;
const MIN_EPSILON = 0.01;

/**
 * UTILITIES
 */
const getDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Discretisation de l'état pour la Q-Table
// On simplifie l'état pour que l'apprentissage soit rapide dans le navigateur
const getStateKey = (fish, predator, obstacles) => {
  // 1. Direction du prédateur (8 quadrants)
  const dx = predator.x - fish.x;
  const dy = predator.y - fish.y;
  const angle = Math.atan2(dy, dx);
  const octant = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 8);

  // 2. Distance du prédateur (3 niveaux : Danger immédiat, Proche, Loin)
  const dist = getDistance(fish, predator);
  let distState = 'FAR';
  if (dist < 60) distState = 'CRITICAL';
  else if (dist < 150) distState = 'CLOSE';

  // 3. Proximité des murs (4 bits : Haut, Bas, Gauche, Droite)
  // 1 si < 40px du mur
  const wallN = fish.y < 40 ? '1' : '0';
  const wallS = fish.y > CANVAS_HEIGHT - 40 ? '1' : '0';
  const wallW = fish.x < 40 ? '1' : '0';
  const wallE = fish.x > CANVAS_WIDTH - 40 ? '1' : '0';

  // 4. Est-ce qu'on est dans une cachette ? (Booléen)
  const inHiding = obstacles.some(obs =>
    fish.x > obs.x && fish.x < obs.x + obs.w &&
    fish.y > obs.y && fish.y < obs.y + obs.h
  ) ? '1' : '0';

  return `${octant}|${distState}|${wallN}${wallS}${wallW}${wallE}|${inHiding}`;
};

export default function AntiPredatorFish() {
  // UI State
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // 1 = normal, 10 = fast, 50 = hyper
  const [generation, setGeneration] = useState(0);
  const [bestTime, setBestTime] = useState(0);
  const [lastTime, setLastTime] = useState(0);
  const [epsilon, setEpsilon] = useState(1.0); // Exploration rate
  const [showSensors, setShowSensors] = useState(true);

  // Game Refs (Mutable state avoiding re-renders loop)
  const canvasRef = useRef(null);
  const requestRef = useRef();
  const qTable = useRef({}); // La mémoire du poisson

  const gameState = useRef({
    fish: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
    predator: { x: 50, y: 50 },
    obstacles: [
      { x: 100, y: 100, w: 80, h: 80, type: 'algae' },
      { x: 400, y: 250, w: 100, h: 60, type: 'rock' },
      { x: 350, y: 50, w: 60, h: 60, type: 'algae' },
      { x: 50, y: 300, w: 70, h: 70, type: 'rock' },
    ],
    timeAlive: 0,
    gameOver: false,
    scoreHistory: []
  });

  // Initialisation de la Q-Table si vide
  const getQ = (state, action) => {
    if (!qTable.current[state]) {
      qTable.current[state] = new Array(N_ACTIONS).fill(0);
    }
    return qTable.current[state][action];
  };

  const setQ = (state, action, value) => {
    if (!qTable.current[state]) {
      qTable.current[state] = new Array(N_ACTIONS).fill(0);
    }
    qTable.current[state][action] = value;
  };

  const chooseAction = (state) => {
    // Epsilon-Greedy Strategy
    if (Math.random() < epsilon) {
      return Math.floor(Math.random() * N_ACTIONS); // Random exploration
    } else {
      // Exploitation: choisir la meilleure action connue
      if (!qTable.current[state]) return Math.floor(Math.random() * N_ACTIONS);
      const actions = qTable.current[state];
      let maxVal = Math.max(...actions);
      // Gérer les égalités aléatoirement pour éviter les blocages
      const bestActions = actions.map((val, idx) => val === maxVal ? idx : -1).filter(idx => idx !== -1);
      return bestActions[Math.floor(Math.random() * bestActions.length)];
    }
  };

  const resetEpisode = () => {
    const s = gameState.current;

    // Position aléatoire sécurisée pour le poisson
    s.fish = {
      x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 100,
      y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100
    };

    // Le prédateur commence dans un coin aléatoire
    const corners = [
      { x: 20, y: 20 }, { x: CANVAS_WIDTH - 20, y: 20 },
      { x: 20, y: CANVAS_HEIGHT - 20 }, { x: CANVAS_WIDTH - 20, y: CANVAS_HEIGHT - 20 }
    ];
    s.predator = corners[Math.floor(Math.random() * corners.length)];

    s.timeAlive = 0;
    s.gameOver = false;

    // Decay Epsilon
    setEpsilon(prev => Math.max(MIN_EPSILON, prev * EPSILON_DECAY));
    setGeneration(prev => prev + 1);
  };

  const update = () => {
    const s = gameState.current;
    if (s.gameOver) {
      s.scoreHistory.push(s.timeAlive);
      if (s.timeAlive > bestTime) setBestTime(s.timeAlive);
      setLastTime(s.timeAlive);
      resetEpisode();
      return;
    }

    // 1. Get Current State
    const stateKey = getStateKey(s.fish, s.predator, s.obstacles);

    // 2. Choose Action
    const actionIdx = chooseAction(stateKey);
    const move = ACTIONS[actionIdx];

    // 3. Apply Action (Move Fish)
    const oldFishPos = { ...s.fish };
    s.fish.x += move.x * FISH_SPEED;
    s.fish.y += move.y * FISH_SPEED;

    // Boundaries check
    if (s.fish.x < FISH_SIZE) s.fish.x = FISH_SIZE;
    if (s.fish.x > CANVAS_WIDTH - FISH_SIZE) s.fish.x = CANVAS_WIDTH - FISH_SIZE;
    if (s.fish.y < FISH_SIZE) s.fish.y = FISH_SIZE;
    if (s.fish.y > CANVAS_HEIGHT - FISH_SIZE) s.fish.y = CANVAS_HEIGHT - FISH_SIZE;

    // 4. Move Predator
    let predSpeed = PREDATOR_SPEED;

    // Check if Predator is in obstacles (slow down)
    const predInObs = s.obstacles.some(obs =>
      s.predator.x > obs.x && s.predator.x < obs.x + obs.w &&
      s.predator.y > obs.y && s.predator.y < obs.y + obs.h
    );
    if (predInObs) predSpeed *= 0.5;

    const angle = Math.atan2(s.fish.y - s.predator.y, s.fish.x - s.predator.x);
    s.predator.x += Math.cos(angle) * predSpeed;
    s.predator.y += Math.sin(angle) * predSpeed;

    // 5. Calculate Reward & Next State
    s.timeAlive++;
    const nextStateKey = getStateKey(s.fish, s.predator, s.obstacles);

    // Check Collision
    const dist = getDistance(s.fish, s.predator);
    let reward = 1; // Survival reward

    // Incentive to find hiding spots (small bonus)
    const fishInObs = s.obstacles.some(obs =>
      s.fish.x > obs.x && s.fish.x < obs.x + obs.w &&
      s.fish.y > obs.y && s.fish.y < obs.y + obs.h
    );
    if (fishInObs && dist < 150) reward += 0.5; // Good to hide when threatened

    if (dist < FISH_SIZE + PREDATOR_SIZE) {
      s.gameOver = true;
      reward = -100; // Death penalty
    }

    // Update Q-Value
    const oldQ = getQ(stateKey, actionIdx);
    const maxNextQ = Math.max(...(qTable.current[nextStateKey] || new Array(N_ACTIONS).fill(0)));
    const newQ = oldQ + ALPHA * (reward + GAMMA * maxNextQ - oldQ);
    setQ(stateKey, actionIdx, newQ);
  };

  const draw = (ctx) => {
    const s = gameState.current;

    // Clear
    ctx.fillStyle = '#1e293b'; // Slate 800 background (Deep water)
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Draw Obstacles
    s.obstacles.forEach(obs => {
      ctx.fillStyle = obs.type === 'algae' ? '#15803d' : '#475569'; // Green or Grey
      ctx.globalAlpha = 0.6;
      ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
      ctx.globalAlpha = 1.0;

      // Decorations
      if (obs.type === 'algae') {
        ctx.strokeStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(obs.x + 10, obs.y + obs.h);
        ctx.quadraticCurveTo(obs.x + 10, obs.y, obs.x + 20, obs.y + 10);
        ctx.stroke();
      }
    });

    // Draw Predator
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(s.predator.x, s.predator.y, PREDATOR_SIZE, 0, Math.PI * 2);
    ctx.fill();
    // Eye
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(s.predator.x, s.predator.y - 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(s.predator.x, s.predator.y - 5, 2, 0, Math.PI * 2);
    ctx.fill();

    // Draw Fish
    ctx.save();
    ctx.translate(s.fish.x, s.fish.y);
    // Orient fish sprite based on last movement if desired, usually just a circle for abstract agent
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-5, -5);
    ctx.fill();
    ctx.restore();

    // Draw Sensors (Debug View)
    if (showSensors) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.moveTo(s.fish.x, s.fish.y);
      ctx.lineTo(s.predator.x, s.predator.y);
      ctx.stroke();

      // Detection radius
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.2)';
      ctx.beginPath();
      ctx.arc(s.fish.x, s.fish.y, 60, 0, Math.PI * 2); // Critical
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.2)';
      ctx.beginPath();
      ctx.arc(s.fish.x, s.fish.y, 150, 0, Math.PI * 2); // Warning
      ctx.stroke();
    }
  };

  const gameLoop = useCallback(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');

    if (isPlaying) {
      // Pour accélérer, on exécute update plusieurs fois par frame
      // Mais on dessine (draw) une seule fois
      for (let i = 0; i < speed; i++) {
        update();
      }
    }

    draw(ctx);
    requestRef.current = requestAnimationFrame(gameLoop);
  }, [isPlaying, speed, showSensors]); // Dependencies

  useEffect(() => {
    requestRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(requestRef.current);
  }, [gameLoop]);

  // Handlers
  const togglePlay = () => setIsPlaying(!isPlaying);

  const resetBrain = () => {
    qTable.current = {};
    setEpsilon(1.0);
    setGeneration(0);
    setBestTime(0);
    gameState.current.scoreHistory = [];
    resetEpisode();
  };

  const setDemoMode = () => {
    setEpsilon(0); // Pure exploitation
    setIsPlaying(true);
    setSpeed(1); // Normal speed to watch
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-slate-100 font-sans p-4">
      <div className="max-w-4xl w-full">

        <header className="mb-6 flex justify-between items-center border-b border-slate-700 pb-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-teal-300 bg-clip-text text-transparent">
              Anti-Predator Fish AI
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Reinforcement Learning (Q-Learning) Interactif
            </p>
          </div>
          <div className="flex gap-4 text-sm text-right">
            <div>
              <div className="text-slate-400">Génération</div>
              <div className="font-mono text-xl text-blue-400">{generation}</div>
            </div>
            <div>
              <div className="text-slate-400">Meilleure Survie</div>
              <div className="font-mono text-xl text-green-400">{(bestTime / 60).toFixed(1)}s</div>
            </div>
            <div>
              <div className="text-slate-400">Dernière</div>
              <div className="font-mono text-xl text-white">{(lastTime / 60).toFixed(1)}s</div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* MAIN GAME VIEW */}
          <div className="lg:col-span-2 relative bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-slate-700">
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className="w-full h-auto block cursor-crosshair"
            />

            {/* Overlay Stats */}
            <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none">
              <span className="bg-black/50 px-2 py-1 rounded text-xs text-yellow-300 backdrop-blur-sm">
                Exploration (Epsilon): {(epsilon * 100).toFixed(1)}%
              </span>
              <span className="bg-black/50 px-2 py-1 rounded text-xs text-blue-300 backdrop-blur-sm">
                States Learned: {Object.keys(qTable.current).length}
              </span>
            </div>
          </div>

          {/* CONTROLS PANEL */}
          <div className="space-y-6">

            {/* Control Deck */}
            <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Brain className="w-5 h-5 text-purple-400" />
                Contrôles de l'IA
              </h2>

              <div className="space-y-4">
                <div className="flex gap-2">
                  <button
                    onClick={togglePlay}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-bold transition-colors ${isPlaying
                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                      : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      }`}
                  >
                    {isPlaying ? <><Pause className="w-4 h-4" /> Pause</> : <><Play className="w-4 h-4" /> Start</>}
                  </button>

                  <button
                    onClick={resetBrain}
                    className="flex items-center justify-center p-3 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                    title="Réinitialiser le cerveau"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block flex justify-between">
                    <span>Vitesse d'Apprentissage</span>
                    <span className="text-white">x{speed}</span>
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="50"
                    value={speed}
                    onChange={(e) => setSpeed(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>Réel</span>
                    <span>Turbo</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-700">
                  <button
                    onClick={setDemoMode}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    <FastForward className="w-4 h-4" />
                    Mode Expert (Démo)
                  </button>
                  <p className="text-xs text-slate-500 mt-2 text-center">
                    Force l'IA à utiliser uniquement ses connaissances actuelles (Epsilon = 0).
                  </p>
                </div>
              </div>
            </div>

            {/* Options Deck */}
            <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Eye className="w-5 h-5 text-teal-400" />
                Visualisation
              </h2>

              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-300">Afficher Capteurs</span>
                <button
                  onClick={() => setShowSensors(!showSensors)}
                  className={`w-12 h-6 rounded-full transition-colors relative ${showSensors ? 'bg-teal-500' : 'bg-slate-600'}`}
                >
                  <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${showSensors ? 'translate-x-6' : ''}`} />
                </button>
              </div>

              <div className="bg-slate-900/50 p-3 rounded-lg text-xs text-slate-400 mt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                  <span>Agent (Apprend)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <span>Prédateur (Suit)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 bg-green-800 border border-green-600"></div>
                  <span>Cachette (Ralentit prédateur)</span>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Instructions / Legend */}
        <div className="mt-6 bg-slate-800/50 p-6 rounded-xl border border-slate-700/50">
          <h3 className="text-white font-semibold mb-2 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-yellow-500" />
            Comment ça marche ?
          </h3>
          <p className="text-slate-400 text-sm leading-relaxed">
            Le poisson bleu utilise le <strong>Q-Learning</strong>. Au début, il bouge au hasard (Exploration).
            Quand il survit, il reçoit une récompense (+1). S'il meurt, une grosse punition (-100).
            Petit à petit, il remplit sa "Table Q" (mémoire) et associe l'état de ses capteurs (position du requin, murs)
            à la meilleure action (Fuire, se cacher).
            <br /><br />
            <strong>Astuce :</strong> Montez la vitesse à <strong>x50</strong> pendant quelques secondes pour entraîner le poisson rapidement,
            puis remettez à <strong>x1</strong> et cliquez sur "Mode Expert" pour voir le résultat !
          </p>
        </div>

      </div>
    </div>
  );
}