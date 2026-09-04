/**
 * Canvas Manager
 * Orchestrates multi-layer canvas rendering (Grid, Main, Draft),
 * Infinite Pan & Zoom Viewport, Retina / High-DPI scaling,
 * and stroke compositing.
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

    // Viewport Navigation & Infinite World Coordinates
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1.0;
    this.minZoom = 0.1;
    this.maxZoom = 10.0;

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

  /* ==========================================================================
     Viewport & Coordinate Transformations
     ========================================================================== */

  /**
   * Convert screen client coordinates to infinite world coordinates
   */
  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.panX) / this.zoom,
      y: (screenY - this.panY) / this.zoom
    };
  }

  /**
   * Convert world coordinates back to screen client coordinates
   */
  worldToScreen(worldX, worldY) {
    return {
      x: worldX * this.zoom + this.panX,
      y: worldY * this.zoom + this.panY
    };
  }

  getViewTransform() {
    return {
      panX: this.panX,
      panY: this.panY,
      zoom: this.zoom
    };
  }

  /**
   * Pan the canvas viewport by screen deltas
   */
  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.renderGrid();
  }

  /**
   * Zoom centered at a specific screen coordinate (e.g. mouse pointer)
   */
  zoomAt(screenX, screenY, factor) {
    const world = this.screenToWorld(screenX, screenY);
    const oldZoom = this.zoom;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, oldZoom * factor));
    if (Math.abs(newZoom - oldZoom) < 0.001) return oldZoom;

    this.panX = screenX - world.x * newZoom;
    this.panY = screenY - world.y * newZoom;
    this.zoom = newZoom;
    this.renderGrid();
    return this.zoom;
  }

  /**
   * Set specific zoom level centered at screen point
   */
  setZoom(targetZoom, screenX = this.width / 2, screenY = this.height / 2) {
    const world = this.screenToWorld(screenX, screenY);
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, targetZoom));
    this.panX = screenX - world.x * newZoom;
    this.panY = screenY - world.y * newZoom;
    this.zoom = newZoom;
    this.renderGrid();
    return this.zoom;
  }

  /**
   * Reset pan and zoom to default 100% centered
   */
  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1.0;
    this.renderGrid();
    return this.zoom;
  }

  /**
   * Automatically frame all strokes on screen with padding
   */
  fitToContent(strokes) {
    if (!strokes || strokes.length === 0) {
      this.resetView();
      return this.zoom;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasPoints = false;

    for (const stroke of strokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      hasPoints = true;
      for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }

    if (!hasPoints) {
      this.resetView();
      return this.zoom;
    }

    const contentWidth = Math.max(maxX - minX, 80);
    const contentHeight = Math.max(maxY - minY, 80);
    const padding = 80;

    const availableWidth = Math.max(this.width - padding * 2, 200);
    const availableHeight = Math.max(this.height - padding * 2, 200);

    const fitZoom = Math.min(
      availableWidth / contentWidth,
      availableHeight / contentHeight,
      2.0
    );
    const targetZoom = Math.max(this.minZoom, Math.min(fitZoom, 2.0));

    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    this.zoom = targetZoom;
    this.panX = (this.width / 2) - (contentCenterX * this.zoom);
    this.panY = (this.height / 2) - (contentCenterY * this.zoom);
    this.renderGrid();
    return this.zoom;
  }

  /**
   * Apply DPR, pan, and zoom transformation to context
   */
  applyTransform(ctx) {
    ctx.resetTransform();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
  }

  /**
   * Render subtle dot-matrix background pattern in world space with LOD
   */
  renderGrid() {
    this.gridCtx.resetTransform();
    this.gridCtx.scale(this.dpr, this.dpr);
    this.gridCtx.clearRect(0, 0, this.width, this.height);
    if (!this.showGrid) return;

    // Dynamic Level of Detail (LOD) grid spacing
    let step = 28;
    while (step * this.zoom < 16) step *= 2;
    while (step * this.zoom > 64) step /= 2;

    const dotSize = Math.max(0.8, 1.25 * Math.min(this.zoom, 1.4));
    const dotColor = this.theme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';

    const minX = -this.panX / this.zoom;
    const minY = -this.panY / this.zoom;
    const maxX = (this.width - this.panX) / this.zoom;
    const maxY = (this.height - this.panY) / this.zoom;

    const startX = Math.floor(minX / step) * step;
    const startY = Math.floor(minY / step) * step;

    this.gridCtx.fillStyle = dotColor;
    this.gridCtx.beginPath();

    for (let wx = startX; wx <= maxX; wx += step) {
      const sx = wx * this.zoom + this.panX;
      for (let wy = startY; wy <= maxY; wy += step) {
        const sy = wy * this.zoom + this.panY;
        this.gridCtx.moveTo(sx + dotSize, sy);
        this.gridCtx.arc(sx, sy, dotSize, 0, Math.PI * 2);
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
    this.draftCtx.resetTransform();
    this.draftCtx.scale(this.dpr, this.dpr);
    this.draftCtx.clearRect(0, 0, this.width, this.height);
    if (stroke && stroke.points.length > 0) {
      this.applyTransform(this.draftCtx);
      this.drawStrokeToContext(this.draftCtx, stroke);
    }
  }

  /**
   * Clear the active draft canvas
   */
  clearDraft() {
    this.draftCtx.resetTransform();
    this.draftCtx.scale(this.dpr, this.dpr);
    this.draftCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Render ephemeral glowing laser trail as a continuous tapered ribbon
   */
  renderLaserTrail(points, color, baseSize) {
    this.clearDraft();
    if (!points || points.length === 0) return;

    const ctx = this.draftCtx;
    const now = performance.now();
    const LASER_LIFETIME = 1100; // ms

    const activePoints = points.filter(p => (now - p.time) < LASER_LIFETIME);
    if (activePoints.length === 0) return;

    this.applyTransform(ctx);

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
      const factor = Math.pow(progress, 0.65);
      const w = Math.max(baseSize * 2.2 * factor, 1.5);
      outerWidths.push(w);
      coreWidths.push(Math.max(w * 0.45, 1.0));
    }

    const leftOuter = [];
    const rightOuter = [];
    const leftCore = [];
    const rightCore = [];

    for (let i = 0; i < count; i++) {
      let dx, dy;
      if (i === 0) {
        dx = pts[1].x - pts[0].x;
        dy = pts[1].y - pts[0].y;
      } else if (i === count - 1) {
        dx = pts[count - 1].x - pts[count - 2].x;
        dy = pts[count - 1].y - pts[count - 2].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x;
        dy = pts[i + 1].y - pts[i - 1].y;
      }

      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const ow = outerWidths[i] / 2;
      const cw = coreWidths[i] / 2;

      leftOuter.push({ x: pts[i].x + nx * ow, y: pts[i].y + ny * ow });
      rightOuter.push({ x: pts[i].x - nx * ow, y: pts[i].y - ny * ow });

      leftCore.push({ x: pts[i].x + nx * cw, y: pts[i].y + ny * cw });
      rightCore.push({ x: pts[i].x - nx * cw, y: pts[i].y - ny * cw });
    }

    ctx.save();

    // 1. Wide Neon Glow Bloom
    ctx.shadowColor = laserColor;
    ctx.shadowBlur = Math.max(baseSize * 3.5, 16);
    ctx.fillStyle = laserColor;
    ctx.globalAlpha = 0.55;

    ctx.beginPath();
    ctx.moveTo(leftOuter[0].x, leftOuter[0].y);
    for (let i = 1; i < count; i++) {
      const midX = (leftOuter[i - 1].x + leftOuter[i].x) / 2;
      const midY = (leftOuter[i - 1].y + leftOuter[i].y) / 2;
      ctx.quadraticCurveTo(leftOuter[i - 1].x, leftOuter[i - 1].y, midX, midY);
    }
    ctx.lineTo(leftOuter[count - 1].x, leftOuter[count - 1].y);
    ctx.lineTo(rightOuter[count - 1].x, rightOuter[count - 1].y);
    for (let i = count - 2; i >= 0; i--) {
      const midX = (rightOuter[i + 1].x + rightOuter[i].x) / 2;
      const midY = (rightOuter[i + 1].y + rightOuter[i].y) / 2;
      ctx.quadraticCurveTo(rightOuter[i + 1].x, rightOuter[i + 1].y, midX, midY);
    }
    ctx.lineTo(rightOuter[0].x, rightOuter[0].y);
    ctx.closePath();
    ctx.fill();

    // 2. Solid Crimson Body Ribbon
    ctx.shadowBlur = Math.max(baseSize * 1.5, 8);
    ctx.fillStyle = laserColor;
    ctx.globalAlpha = 0.9;
    ctx.fill();

    // 3. Ultra-Bright White Hot Core Ribbon
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.92;

    ctx.beginPath();
    ctx.moveTo(leftCore[0].x, leftCore[0].y);
    for (let i = 1; i < count; i++) {
      const midX = (leftCore[i - 1].x + leftCore[i].x) / 2;
      const midY = (leftCore[i - 1].y + leftCore[i].y) / 2;
      ctx.quadraticCurveTo(leftCore[i - 1].x, leftCore[i - 1].y, midX, midY);
    }
    ctx.lineTo(leftCore[count - 1].x, leftCore[count - 1].y);
    ctx.lineTo(rightCore[count - 1].x, rightCore[count - 1].y);
    for (let i = count - 2; i >= 0; i--) {
      const midX = (rightCore[i + 1].x + rightCore[i].x) / 2;
      const midY = (rightCore[i + 1].y + rightCore[i].y) / 2;
      ctx.quadraticCurveTo(rightCore[i + 1].x, rightCore[i + 1].y, midX, midY);
    }
    ctx.lineTo(rightCore[0].x, rightCore[0].y);
    ctx.closePath();
    ctx.fill();

    // 4. Luminous Pointer Orb at Leading Tip
    const latest = pts[count - 1];
    const tipRadius = Math.max(baseSize * 1.4, 4.5);

    ctx.shadowColor = laserColor;
    ctx.shadowBlur = Math.max(baseSize * 3, 16);
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

    ctx.restore();
  }

  /**
   * Finalize and bake draft stroke into the main static canvas
   */
  commitDraft(stroke) {
    this.clearDraft();
    if (stroke && stroke.points.length > 0) {
      this.applyTransform(this.mainCtx);
      this.drawStrokeToContext(this.mainCtx, stroke);
    }
  }

  /**
   * Full redraw of all strokes in world coordinates
   */
  redrawAll(strokes) {
    this.mainCtx.resetTransform();
    this.mainCtx.scale(this.dpr, this.dpr);
    this.mainCtx.clearRect(0, 0, this.width, this.height);
    if (!strokes) return;
    this.applyTransform(this.mainCtx);
    for (const stroke of strokes) {
      this.drawStrokeToContext(this.mainCtx, stroke);
    }
  }

  /**
   * Redraw all strokes except a specified set (used during active selection dragging)
   */
  redrawAllExcept(strokes, excludedStrokes) {
    this.mainCtx.resetTransform();
    this.mainCtx.scale(this.dpr, this.dpr);
    this.mainCtx.clearRect(0, 0, this.width, this.height);
    if (!strokes) return;
    const excludedIds = new Set(excludedStrokes.map(s => s.id));
    this.applyTransform(this.mainCtx);
    for (const stroke of strokes) {
      if (!excludedIds.has(stroke.id)) {
        this.drawStrokeToContext(this.mainCtx, stroke);
      }
    }
  }

  /**
   * Render selection bounding box, handles, and optionally translated preview strokes
   */
  renderSelectionOverlay(selectedStrokes, offset = { dx: 0, dy: 0 }) {
    this.clearDraft();
    if (!selectedStrokes || selectedStrokes.length === 0) return;

    const bbox = StrokeEngine.getStrokesBoundingBox(selectedStrokes, 6);
    if (!bbox) return;

    const ctx = this.draftCtx;
    this.applyTransform(ctx);

    const isDragging = offset.dx !== 0 || offset.dy !== 0;

    // If actively displacing, render moved strokes on the draft layer
    if (isDragging) {
      ctx.save();
      ctx.translate(offset.dx, offset.dy);
      for (const stroke of selectedStrokes) {
        StrokeEngine.renderStroke(ctx, stroke);
      }
      ctx.restore();
    }

    // Translated bounding box coordinates
    const x = bbox.minX + offset.dx;
    const y = bbox.minY + offset.dy;
    const w = bbox.width;
    const h = bbox.height;

    ctx.save();
    // Subtle translucent tint fill
    ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
    ctx.fillRect(x, y, w, h);

    // High-visibility dashed selection outline
    const dashSize = Math.max(4 / this.zoom, 2);
    ctx.setLineDash([dashSize, dashSize]);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(1.5 / this.zoom, 1);
    ctx.strokeRect(x, y, w, h);

    // Draw modern corner handles
    ctx.setLineDash([]);
    const handleSize = Math.max(7 / this.zoom, 4);
    const halfH = handleSize / 2;
    const corners = [
      { cx: x, cy: y },
      { cx: x + w, cy: y },
      { cx: x, cy: y + h },
      { cx: x + w, cy: y + h }
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = Math.max(1.5 / this.zoom, 1);

    for (const corner of corners) {
      ctx.fillRect(corner.cx - halfH, corner.cy - halfH, handleSize, handleSize);
      ctx.strokeRect(corner.cx - halfH, corner.cy - halfH, handleSize, handleSize);
    }

    ctx.restore();
  }

  /**
   * Render dynamic selection marquee rectangle during box drag
   */
  renderMarquee(startWorld, currentWorld) {
    this.clearDraft();
    if (!startWorld || !currentWorld) return;

    const minX = Math.min(startWorld.x, currentWorld.x);
    const minY = Math.min(startWorld.y, currentWorld.y);
    const w = Math.abs(currentWorld.x - startWorld.x);
    const h = Math.abs(currentWorld.y - startWorld.y);

    const ctx = this.draftCtx;
    this.applyTransform(ctx);

    ctx.save();
    // Marquee fill
    ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.fillRect(minX, minY, w, h);

    // Dashed border
    const dashSize = Math.max(4 / this.zoom, 2);
    ctx.setLineDash([dashSize, dashSize]);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(1.5 / this.zoom, 1);
    ctx.strokeRect(minX, minY, w, h);

    ctx.restore();
  }

  /**
   * Clear the main committed drawing canvas
   */
  clearMain() {
    this.mainCtx.resetTransform();
    this.mainCtx.scale(this.dpr, this.dpr);
    this.mainCtx.clearRect(0, 0, this.width, this.height);
    this.clearDraft();
  }

  /**
   * Export whiteboard as an image data URL
   * Supports 'content' (bounding box of all strokes) or 'viewport' (current screen)
   */
  exportImage(strokes, bgType = 'theme', scope = 'content') {
    const offscreen = document.createElement('canvas');

    if (scope === 'content' && strokes && strokes.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let hasPoints = false;

      for (const stroke of strokes) {
        if (!stroke.points) continue;
        for (const p of stroke.points) {
          hasPoints = true;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }

      if (hasPoints) {
        const padding = 50;
        const w = (maxX - minX) + padding * 2;
        const h = (maxY - minY) + padding * 2;

        offscreen.width = Math.floor(w * this.dpr);
        offscreen.height = Math.floor(h * this.dpr);
        const offCtx = offscreen.getContext('2d');
        offCtx.scale(this.dpr, this.dpr);

        if (bgType === 'theme') {
          offCtx.fillStyle = this.theme === 'dark' ? '#0b0f17' : '#f8fafc';
          offCtx.fillRect(0, 0, w, h);
        } else if (bgType === 'white') {
          offCtx.fillStyle = '#ffffff';
          offCtx.fillRect(0, 0, w, h);
        }

        offCtx.translate(-minX + padding, -minY + padding);
        for (const stroke of strokes) {
          this.drawStrokeToContext(offCtx, stroke);
        }
        return offscreen.toDataURL('image/png');
      }
    }

    // Viewport fallback export
    offscreen.width = Math.floor(this.width * this.dpr);
    offscreen.height = Math.floor(this.height * this.dpr);
    const offCtx = offscreen.getContext('2d');
    offCtx.scale(this.dpr, this.dpr);

    if (bgType === 'theme') {
      offCtx.fillStyle = this.theme === 'dark' ? '#0b0f17' : '#f8fafc';
      offCtx.fillRect(0, 0, this.width, this.height);
    } else if (bgType === 'white') {
      offCtx.fillStyle = '#ffffff';
      offCtx.fillRect(0, 0, this.width, this.height);
    }

    offCtx.translate(this.panX, this.panY);
    offCtx.scale(this.zoom, this.zoom);

    if (strokes) {
      for (const stroke of strokes) {
        this.drawStrokeToContext(offCtx, stroke);
      }
    }

    return offscreen.toDataURL('image/png');
  }
}
