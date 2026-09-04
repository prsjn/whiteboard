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
