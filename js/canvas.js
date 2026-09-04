/**
 * Canvas Manager
 * Orchestrates multi-layer canvas rendering (Grid, Main, Draft),
 * Retina / High-DPI scaling, and stroke compositing.
 */

import { StrokeEngine } from './stroke.js';

export class CanvasManager {
  constructor(options) {
    this.container = options.container;
    this.gridCanvas = options.gridCanvas;
    this.mainCanvas = options.mainCanvas;
    this.draftCanvas = options.draftCanvas;

    this.gridCtx = this.gridCanvas.getContext('2d');
    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });
    this.draftCtx = this.draftCanvas.getContext('2d');

    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;
    this.showGrid = true;
    this.theme = 'dark';

    this.initResizeObserver();
  }

  /**
   * Monitor container sizing and adjust resolution to devicePixelRatio
   */
  initResizeObserver() {
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
      if (this.onResizeCallback) {
        this.onResizeCallback();
      }
    });
  }

  setResizeCallback(callback) {
    this.onResizeCallback = callback;
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    const canvases = [this.gridCanvas, this.mainCanvas, this.draftCanvas];
    const contexts = [this.gridCtx, this.mainCtx, this.draftCtx];

    canvases.forEach((canvas, idx) => {
      canvas.width = Math.floor(this.width * this.dpr);
      canvas.height = Math.floor(this.height * this.dpr);
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;

      const ctx = contexts[idx];
      ctx.resetTransform();
      ctx.scale(this.dpr, this.dpr);
    });

    this.renderGrid();
  }

  getRect() {
    return this.container.getBoundingClientRect();
  }

  setTheme(theme) {
    this.theme = theme;
    this.renderGrid();
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.renderGrid();
    return this.showGrid;
  }

  /**
   * Render subtle dot-matrix background pattern
   */
  renderGrid() {
    this.gridCtx.clearRect(0, 0, this.width, this.height);
    if (!this.showGrid) return;

    const dotSize = 1.25;
    const spacing = 28;
    const dotColor = this.theme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';

    this.gridCtx.fillStyle = dotColor;
    this.gridCtx.beginPath();

    for (let x = spacing / 2; x < this.width; x += spacing) {
      for (let y = spacing / 2; y < this.height; y += spacing) {
        this.gridCtx.moveTo(x, y);
        this.gridCtx.arc(x, y, dotSize, 0, Math.PI * 2);
      }
    }

    this.gridCtx.fill();
  }

  /**
   * Render a single stroke to a given canvas context
   */
  drawStrokeToContext(ctx, stroke) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    StrokeEngine.renderStroke(ctx, stroke);
  }

  /**
   * Update the active draft stroke in real-time
   */
  updateDraft(stroke) {
    this.draftCtx.clearRect(0, 0, this.width, this.height);
    if (stroke && stroke.points.length > 0) {
      this.drawStrokeToContext(this.draftCtx, stroke);
    }
  }

  /**
   * Clear the active draft canvas
   */
  clearDraft() {
    this.draftCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Render ephemeral glowing laser trail as a continuous tapered ribbon (no snake / segmented artifacts)
   */
  renderLaserTrail(points, color, baseSize) {
    this.draftCtx.clearRect(0, 0, this.width, this.height);
    if (!points || points.length === 0) return;

    const ctx = this.draftCtx;
    const now = performance.now();
    const LASER_LIFETIME = 1100; // ms

    const activePoints = points.filter(p => (now - p.time) < LASER_LIFETIME);
    if (activePoints.length === 0) return;

    const laserColor = color || '#f43f5e';
    const n = activePoints.length;

    // Single point: render luminous glowing laser dot
    if (n === 1) {
      const p = activePoints[0];
      const age = now - p.time;
      const alpha = Math.max(0, 1 - (age / LASER_LIFETIME));
      const radius = Math.max(baseSize * 1.5, 5);

      ctx.save();
      ctx.shadowColor = laserColor;
      ctx.shadowBlur = Math.max(baseSize * 3, 14);
      ctx.fillStyle = laserColor;
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Ensure at least 3 points for smooth spline normals
    let pts = activePoints;
    if (pts.length === 2) {
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        time: (pts[0].time + pts[1].time) / 2
      };
      pts = [pts[0], mid, pts[1]];
    }

    const count = pts.length;
    const outerWidths = [];
    const coreWidths = [];

    // Calculate dynamic tapering width based on age along the trail
    for (let i = 0; i < count; i++) {
      const age = now - pts[i].time;
      const progress = Math.max(0, 1 - (age / LASER_LIFETIME));
      // Taper smoothly: thin at tail (age -> 1100ms), bold at head (age -> 0)
      const factor = Math.pow(progress, 0.65);
      const w = Math.max(baseSize * 2.2 * factor, 1.5);
      outerWidths.push(w);
      coreWidths.push(Math.max(w * 0.45, 1.0));
    }

    // Helper to build a closed smooth polygon path for a given set of widths
    const buildRibbonPath = (widths) => {
      const leftPoints = [];
      const rightPoints = [];

      for (let i = 0; i < count; i++) {
        let tx, ty;
        if (i === 0) {
          tx = pts[1].x - pts[0].x;
          ty = pts[1].y - pts[0].y;
        } else if (i === count - 1) {
          tx = pts[count - 1].x - pts[count - 2].x;
          ty = pts[count - 1].y - pts[count - 2].y;
        } else {
          tx = pts[i + 1].x - pts[i - 1].x;
          ty = pts[i + 1].y - pts[i - 1].y;
        }

        const len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len;
        const ny = tx / len;
        const r = widths[i] / 2;

        leftPoints.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r });
        rightPoints.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r });
      }

      ctx.beginPath();
      ctx.moveTo(leftPoints[0].x, leftPoints[0].y);

      // Forward pass along left edge with smooth quadratic splines
      for (let i = 1; i < count; i++) {
        const midX = (leftPoints[i - 1].x + leftPoints[i].x) / 2;
        const midY = (leftPoints[i - 1].y + leftPoints[i].y) / 2;
        ctx.quadraticCurveTo(leftPoints[i - 1].x, leftPoints[i - 1].y, midX, midY);
      }
      ctx.lineTo(leftPoints[count - 1].x, leftPoints[count - 1].y);

      // Round cap at the laser head
      const headR = widths[count - 1] / 2;
      const lastTx = pts[count - 1].x - pts[count - 2].x;
      const lastTy = pts[count - 1].y - pts[count - 2].y;
      const lastLen = Math.hypot(lastTx, lastTy) || 1;
      const headTipX = pts[count - 1].x + (lastTx / lastLen) * headR * 1.33;
      const headTipY = pts[count - 1].y + (lastTy / lastLen) * headR * 1.33;
      ctx.quadraticCurveTo(headTipX, headTipY, rightPoints[count - 1].x, rightPoints[count - 1].y);

      // Backward pass along right edge
      for (let i = count - 2; i >= 0; i--) {
        const midX = (rightPoints[i + 1].x + rightPoints[i].x) / 2;
        const midY = (rightPoints[i + 1].y + rightPoints[i].y) / 2;
        ctx.quadraticCurveTo(rightPoints[i + 1].x, rightPoints[i + 1].y, midX, midY);
      }
      ctx.lineTo(rightPoints[0].x, rightPoints[0].y);

      // Round cap at the laser tail
      const tailR = widths[0] / 2;
      const firstTx = pts[1].x - pts[0].x;
      const firstTy = pts[1].y - pts[0].y;
      const firstLen = Math.hypot(firstTx, firstTy) || 1;
      const tailTipX = pts[0].x - (firstTx / firstLen) * tailR * 1.33;
      const tailTipY = pts[0].y - (firstTy / firstLen) * tailR * 1.33;
      ctx.quadraticCurveTo(tailTipX, tailTipY, leftPoints[0].x, leftPoints[0].y);

      ctx.closePath();
    };

    ctx.save();

    // Pass 1: Outer glowing neon aura
    buildRibbonPath(outerWidths);
    ctx.shadowColor = laserColor;
    ctx.shadowBlur = Math.max(baseSize * 3.2, 16);
    ctx.fillStyle = laserColor;
    ctx.globalAlpha = 0.88;
    ctx.fill();

    // Second fill to intensify the laser bloom
    ctx.shadowBlur = Math.max(baseSize * 1.8, 8);
    ctx.globalAlpha = 0.95;
    ctx.fill();

    // Pass 2: Intense white laser core (solid, no segments, perfectly seamless)
    buildRibbonPath(coreWidths);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.95;
    ctx.fill();

    // Pass 3: Radiant laser head dot
    const latest = pts[count - 1];
    const tipAge = now - latest.time;
    if (tipAge < 350) {
      const tipRadius = Math.max(baseSize * 1.4, 6);

      // Outer Halo
      ctx.shadowColor = laserColor;
      ctx.shadowBlur = Math.max(baseSize * 4, 18);
      ctx.fillStyle = laserColor;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(latest.x, latest.y, tipRadius, 0, Math.PI * 2);
      ctx.fill();

      // Bright white core
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      ctx.arc(latest.x, latest.y, tipRadius * 0.48, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Finalize and bake draft stroke into the main static canvas
   */
  commitDraft(stroke) {
    this.draftCtx.clearRect(0, 0, this.width, this.height);
    if (stroke && stroke.points.length > 0) {
      this.drawStrokeToContext(this.mainCtx, stroke);
    }
  }

  /**
   * Full redraw of all strokes (used for undo/redo and resize)
   */
  redrawAll(strokes) {
    this.mainCtx.clearRect(0, 0, this.width, this.height);
    if (!strokes) return;
    for (const stroke of strokes) {
      this.drawStrokeToContext(this.mainCtx, stroke);
    }
  }

  /**
   * Clear the main committed drawing canvas
   */
  clearMain() {
    this.mainCtx.clearRect(0, 0, this.width, this.height);
    this.draftCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Export whiteboard as an image data URL with chosen background
   */
  exportImage(strokes, bgType = 'theme') {
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.floor(this.width * this.dpr);
    offscreen.height = Math.floor(this.height * this.dpr);
    const offCtx = offscreen.getContext('2d');
    offCtx.scale(this.dpr, this.dpr);

    // Apply Background
    if (bgType === 'theme') {
      offCtx.fillStyle = this.theme === 'dark' ? '#0b0f17' : '#f8fafc';
      offCtx.fillRect(0, 0, this.width, this.height);
    } else if (bgType === 'white') {
      offCtx.fillStyle = '#ffffff';
      offCtx.fillRect(0, 0, this.width, this.height);
    } // 'transparent' leaves background clear

    // Render strokes
    if (strokes) {
      for (const stroke of strokes) {
        this.drawStrokeToContext(offCtx, stroke);
      }
    }

    return offscreen.toDataURL('image/png');
  }
}
