/**
 * A small particle system for the unlock celebration. Pure simulation
 * (no DOM) so the timing and lifecycle can be unit-tested;
 * FireworksOverlay.vue owns the canvas and calls `step()` once per
 * animation frame.
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
  size: number;
}

export interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetY: number;
  hue: number;
}

export interface FireworksOptions {
  /**
   * Approximate total show length in ms: launches stop early enough that
   * the last burst has faded by about this point.
   */
  durationMs?: number;
  /** Average ms between launches. */
  launchEveryMs?: number;
  particlesPerBurst?: number;
  random?: () => number;
}

const GRAVITY = 0.00055; // px per ms^2
const DRAG = 0.9985;
const PARTICLE_LIFE_MIN_MS = 900;
const PARTICLE_LIFE_MAX_MS = 1_800;
// Rocket flight (< 1 s at the tallest arc) plus the longest particle life:
// nothing launched with less than this left can still be alive at the end.
const LAST_LAUNCH_LEAD_MS = 2_700;

export class FireworksShow {
  readonly rockets: Rocket[] = [];
  readonly particles: Particle[] = [];
  private elapsed = 0;
  private sinceLaunch = 0;
  private readonly durationMs: number;
  private readonly launchEveryMs: number;
  private readonly particlesPerBurst: number;
  private readonly random: () => number;

  constructor(
    private width: number,
    private height: number,
    options: FireworksOptions = {},
  ) {
    this.durationMs = options.durationMs ?? 8_000;
    this.launchEveryMs = options.launchEveryMs ?? 260;
    this.particlesPerBurst = options.particlesPerBurst ?? 70;
    this.random = options.random ?? Math.random;
    // The first frame must already be a spectacle: two bursts in the air
    // right away, with a volley of rockets following them up.
    for (let i = 0; i < 2; i += 1) {
      this.burst({
        x: this.width * (0.25 + this.random() * 0.5),
        y: this.height * (0.18 + this.random() * 0.3),
        vx: 0,
        vy: 0,
        targetY: 0,
        hue: Math.floor(this.random() * 360),
      });
    }
    for (let i = 0; i < 3; i += 1) this.launch();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** True once launches have stopped and every particle has faded. */
  get finished(): boolean {
    return !this.launching
      && this.rockets.length === 0
      && this.particles.length === 0;
  }

  get launching(): boolean {
    return this.elapsed < this.durationMs - LAST_LAUNCH_LEAD_MS;
  }

  step(dtMs: number): void {
    const dt = Math.min(Math.max(dtMs, 0), 50);
    this.elapsed += dt;
    this.sinceLaunch += dt;
    if (this.launching && this.sinceLaunch >= this.launchEveryMs) {
      this.sinceLaunch = 0;
      this.launch();
      if (this.random() < 0.35) this.launch();
    }

    for (let i = this.rockets.length - 1; i >= 0; i -= 1) {
      const rocket = this.rockets[i];
      rocket.x += rocket.vx * dt;
      rocket.y += rocket.vy * dt;
      rocket.vy += GRAVITY * dt * 0.6;
      if (rocket.y <= rocket.targetY || rocket.vy >= 0) {
        this.rockets.splice(i, 1);
        this.burst(rocket);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vx *= DRAG ** dt;
      p.vy = p.vy * DRAG ** dt + GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  private launch(): void {
    const x = this.width * (0.15 + this.random() * 0.7);
    const targetY = this.height * (0.12 + this.random() * 0.4);
    const distance = this.height - targetY;
    // Solve v0 so the rocket just reaches targetY under the reduced gravity.
    const vy = -Math.sqrt(2 * GRAVITY * 0.6 * distance) * (1 + this.random() * 0.08);
    this.rockets.push({
      x,
      y: this.height,
      vx: (this.random() - 0.5) * 0.08,
      vy,
      targetY,
      hue: Math.floor(this.random() * 360),
    });
  }

  private burst(rocket: Rocket): void {
    const count = this.particlesPerBurst;
    const speed = 0.16 + this.random() * 0.14;
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + this.random() * 0.2;
      const magnitude = speed * (0.55 + this.random() * 0.45);
      this.particles.push({
        x: rocket.x,
        y: rocket.y,
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        life: 0,
        maxLife: PARTICLE_LIFE_MIN_MS + this.random() * (PARTICLE_LIFE_MAX_MS - PARTICLE_LIFE_MIN_MS),
        hue: (rocket.hue + (this.random() - 0.5) * 40 + 360) % 360,
        size: 1.6 + this.random() * 1.8,
      });
    }
  }
}

export function drawFireworks(
  ctx: CanvasRenderingContext2D,
  show: FireworksShow,
  width: number,
  height: number,
): void {
  // Fade the previous frame instead of clearing: cheap motion trails.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';

  for (const rocket of show.rockets) {
    ctx.fillStyle = `hsl(${rocket.hue} 100% 75%)`;
    ctx.beginPath();
    ctx.arc(rocket.x, rocket.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const p of show.particles) {
    const alpha = 1 - p.life / p.maxLife;
    ctx.fillStyle = `hsla(${p.hue} 100% 65% / ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}
