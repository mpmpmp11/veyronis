// ═══════════════════════════════════════════════════════
// WAVE-PARTICLE FIELD ENGINE
// ═══════════════════════════════════════════════════════
class ParticleField {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.animationId = null;
        this.time = 0;
        this.isRunning = false;
        
        this.resize = this.resize.bind(this);
        this.draw = this.draw.bind(this);
    }

    init() {
        this.resize();
        window.addEventListener('resize', this.resize);
        this.isRunning = true;
        this.loop();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width * dpr;
        this.canvas.height = this.height * dpr;
        this.ctx.scale(dpr, dpr);

        // Responsive grid spacing
        const spacing = this.width < 768 ? 24 : 20;
        
        this.particles = [];
        for (let x = 0; x < this.width + spacing; x += spacing) {
            for (let y = 0; y < this.height + spacing; y += spacing) {
                this.particles.push({ x, y, baseX: x, baseY: y });
            }
        }
    }

    loop() {
        if (!this.isRunning) return;
        this.time += 0.015;
        this.draw();
        this.animationId = requestAnimationFrame(() => this.loop());
    }

    draw() {
        // Clear with trail effect
        this.ctx.fillStyle = 'rgba(5, 5, 8, 1)';
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.particles.forEach(p => {
            // 3D Sine Wave Math
            const wave1 = Math.sin(p.baseX * 0.005 + this.time) * Math.cos(p.baseY * 0.005 + this.time * 0.8);
            const wave2 = Math.sin(p.baseY * 0.008 - this.time * 0.6) * Math.cos(p.baseX * 0.008 - this.time * 0.5);
            
            const val = (wave1 + wave2) / 2; // -1 to 1
            
            // Displace
            const offsetY = val * 20;
            const scale = 1 + (val * 0.8); // Size variation
            const opacity = Math.max(0.15, 0.4 + val * 0.6);
            
            // Colors: Cyan to Violet based on wave height
            const r = Math.floor(6 + val * 60);
            const g = Math.floor(182 + val * 40);
            const b = Math.floor(212 + val * 40);

            this.ctx.beginPath();
            this.ctx.arc(p.baseX, p.baseY + offsetY, Math.max(0.5, 1.5 * scale), 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
            this.ctx.fill();
            
            // Add subtle glow to peaks
            if (val > 0.6) {
                this.ctx.shadowBlur = 10;
                this.ctx.shadowColor = 'rgba(6, 182, 212, 0.8)';
            } else {
                this.ctx.shadowBlur = 0;
            }
        });
    }

    destroy() {
        this.isRunning = false;
        cancelAnimationFrame(this.animationId);
        window.removeEventListener('resize', this.resize);
    }
}
// ═══════════════════════════════════════════════════════
// SNAKE GAME ENGINE
// ═══════════════════════════════════════════════════════
let snakeCanvas, snakeCtx, snakeInterval;
let snake = [], snakeDir = { x: 0, y: 0 }, snakeNextDir = { x: 0, y: 0 };
let food = { x: 0, y: 0 }, score = 0, gridSize = 20, tileCount = 20;
let isSnakePaused = false, isSnakeOver = false;
let touchStartX = 0, touchStartY = 0;

function openSnakeGame() {
    document.getElementById('snake-panel').classList.remove('hidden');
    document.getElementById('snake-gameover').classList.add('hidden');
    document.getElementById('snake-paused').classList.add('hidden');
    startSnakeGame();
}

function closeSnakeGame() {
    document.getElementById('snake-panel').classList.add('hidden');
    clearInterval(snakeInterval);
    isSnakePaused = true;
}

function startSnakeGame() {
    snakeCanvas = document.getElementById('snake-canvas');
    snakeCtx = snakeCanvas.getContext('2d');
    
    // Responsive canvas size
    const size = snakeCanvas.parentElement.clientWidth;
    snakeCanvas.width = size;
    snakeCanvas.height = size;
    gridSize = size / tileCount;

    snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    snakeDir = { x: 1, y: 0 };
    snakeNextDir = { x: 1, y: 0 };
    score = 0;
    isSnakeOver = false;
    isSnakePaused = false;
    
    document.getElementById('snake-score').textContent = score;
    document.getElementById('snake-gameover').classList.add('hidden');
    document.getElementById('snake-paused').classList.add('hidden');

    spawnFood();
    clearInterval(snakeInterval);
    snakeInterval = setInterval(updateSnake, 120); // Speed
}

function spawnFood() {
    let valid = false;
    while (!valid) {
        food = {
            x: Math.floor(Math.random() * tileCount),
            y: Math.floor(Math.random() * tileCount)
        };
        valid = !snake.some(s => s.x === food.x && s.y === food.y);
    }
}

function updateSnake() {
    if (isSnakePaused || isSnakeOver) return;

    // Apply next direction (prevent 180 turns)
    if (snakeNextDir.x !== -snakeDir.x || snakeNextDir.y !== -snakeDir.y) {
        snakeDir = { ...snakeNextDir };
    }

    const head = { x: snake[0].x + snakeDir.x, y: snake[0].y + snakeDir.y };

    // Collision with walls
    if (head.x < 0 || head.x >= tileCount || head.y < 0 || head.y >= tileCount) {
        return gameOver();
    }
    // Collision with self
    if (snake.some(s => s.x === head.x && s.y === head.y)) {
        return gameOver();
    }

    snake.unshift(head);

    // Eat food
    if (head.x === food.x && head.y === food.y) {
        score += 10;
        document.getElementById('snake-score').textContent = score;
        spawnFood();
        // Speed up slightly
        if (score % 50 === 0) {
            clearInterval(snakeInterval);
            snakeInterval = setInterval(updateSnake, Math.max(50, 120 - (score / 10)));
        }
    } else {
        snake.pop();
    }

    drawSnake();
}

function drawSnake() {
    snakeCtx.fillStyle = '#000000';
    snakeCtx.fillRect(0, 0, snakeCanvas.width, snakeCanvas.height);

    // Draw Food
    snakeCtx.fillStyle = '#06b6d4';
    snakeCtx.shadowBlur = 10;
    snakeCtx.shadowColor = '#06b6d4';
    snakeCtx.beginPath();
    snakeCtx.arc(
        food.x * gridSize + gridSize / 2, 
        food.y * gridSize + gridSize / 2, 
        gridSize / 2 - 2, 0, Math.PI * 2
    );
    snakeCtx.fill();

    // Draw Snake
    snakeCtx.shadowBlur = 0;
    snake.forEach((s, i) => {
        snakeCtx.fillStyle = i === 0 ? '#a78bfa' : `rgba(167, 139, 250, ${Math.max(0.3, 1 - (i / snake.length))})`;
        snakeCtx.beginPath();
        snakeCtx.roundRect(s.x * gridSize + 1, s.y * gridSize + 1, gridSize - 2, gridSize - 2, 4);
        snakeCtx.fill();
    });
}

function gameOver() {
    isSnakeOver = true;
    clearInterval(snakeInterval);
    document.getElementById('snake-final-score').textContent = score;
    document.getElementById('snake-gameover').classList.remove('hidden');
}

function toggleSnakePause() {
    if (isSnakeOver) return;
    isSnakePaused = !isSnakePaused;
    document.getElementById('snake-paused').classList.toggle('hidden', !isSnakePaused);
}

// Keyboard Controls
document.addEventListener('keydown', (e) => {
    if (document.getElementById('snake-panel').classList.contains('hidden')) return;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { e.preventDefault(); snakeNextDir = { x: 0, y: -1 }; }
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { e.preventDefault(); snakeNextDir = { x: 0, y: 1 }; }
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); snakeNextDir = { x: -1, y: 0 }; }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); snakeNextDir = { x: 1, y: 0 }; }
});

// Touch Controls
const snakeMobileArea = document.getElementById('snake-mobile-controls');
snakeMobileArea.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
}, { passive: true });

snakeMobileArea.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy)) {
        snakeNextDir = { x: dx > 0 ? 1 : -1, y: 0 };
    } else {
        snakeNextDir = { x: 0, y: dy > 0 ? 1 : -1 };
    }
}, { passive: true });