/**
 * Whiteboard Main Application Bootstrap
 * Connects CanvasManager, StrokeEngine, HistoryManager, UI controls,
 * and high-frequency pointer input listeners.
 */

import { CanvasManager } from './canvas.js';
import { StrokeEngine } from './stroke.js';
import { HistoryManager } from './history.js';

class WhiteboardApp {
  constructor() {
    // Application State
    this.currentTool = 'pen';
    this.currentColor = '#f8fafc';
    this.currentSize = 4;
    this.isDrawing = false;
    this.currentStroke = null;
    this.theme = 'dark';

    // Ephemeral Laser Pointer State
    this.laserPoints = [];
    this.laserAnimationId = null;

    // Stroke Eraser Session State
    this.deletedStrokesSession = [];
    this.lastEraserPos = null;

    // DOM Elements
    this.container = document.getElementById('canvas-container');
    this.gridCanvas = document.getElementById('grid-canvas');
    this.mainCanvas = document.getElementById('main-canvas');
    this.draftCanvas = document.getElementById('draft-canvas');
    this.brushCursor = document.getElementById('brush-cursor');
    this.pressureText = document.getElementById('pressure-text');
    this.sizeDisplay = document.getElementById('size-display');
    this.sizeSlider = document.getElementById('size-slider');
    this.sizePreviewDot = document.getElementById('size-preview-dot');
    this.customColorInput = document.getElementById('custom-color-input');
    this.customColorPreview = document.getElementById('custom-color-preview');
    this.btnUndo = document.getElementById('btn-undo');
    this.btnRedo = document.getElementById('btn-redo');

    // Modals
    this.modalClear = document.getElementById('modal-clear-confirm');
    this.modalExport = document.getElementById('modal-export');
    this.modalShortcuts = document.getElementById('modal-shortcuts');

    // Core Subsystems
    this.canvasManager = new CanvasManager({
      container: this.container,
      gridCanvas: this.gridCanvas,
      mainCanvas: this.mainCanvas,
      draftCanvas: this.draftCanvas
    });

    this.historyManager = new HistoryManager({
      onStateChange: (state) => this.handleHistoryStateChange(state)
    });

    this.init();
  }

  init() {
    // Redraw on window resize
    this.canvasManager.setResizeCallback(() => {
      this.canvasManager.redrawAll(this.historyManager.getStrokes());
    });

    // Restore previous session if exists
    const restored = this.historyManager.loadFromStorage();
    if (restored && restored.length > 0) {
      this.canvasManager.redrawAll(restored);
    }

    this.bindPointerEvents();
    this.bindToolbarEvents();
    this.bindKeyboardShortcuts();
    this.bindModals();
    this.updateCursorVisual();
    this.updateSizeDisplay();
  }

  /* ========================================================================
     High-Performance Pointer Events (Pen / Stylus / Touch / Mouse)
     ======================================================================== */

  bindPointerEvents() {
    this.draftCanvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    this.draftCanvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    this.draftCanvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    this.draftCanvas.addEventListener('pointercancel', (e) => this.handlePointerUp(e));

    // Hide/show brush cursor when entering or leaving canvas
    this.container.addEventListener('pointerenter', () => {
      this.brushCursor.classList.add('active');
    });

    this.container.addEventListener('pointerleave', () => {
      this.brushCursor.classList.remove('active');
    });
  }

  handlePointerDown(e) {
    // Only handle primary button
    if (e.button !== 0) return;

    this.isDrawing = true;
    this.draftCanvas.setPointerCapture(e.pointerId);

    const rect = this.canvasManager.getRect();

    // Laser pointer mode: ephemeral glowing trail
    if (this.currentTool === 'laser') {
      const pt = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        time: performance.now()
      };
      this.laserPoints = [pt];
      this.startLaserAnimation();
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    // Stroke Eraser mode: touch or swipe across any stroke to delete it completely
    if (this.currentTool === 'eraser') {
      this.deletedStrokesSession = [];
      const ex = e.clientX - rect.left;
      const ey = e.clientY - rect.top;
      this.lastEraserPos = { x: ex, y: ey };
      this.performStrokeEraser(ex, ey);
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    this.currentStroke = StrokeEngine.createStroke(
      this.currentTool,
      this.currentColor,
      this.currentSize
    );

    const firstPoint = StrokeEngine.extractPoint(e, null, this.currentTool, rect);
    this.currentStroke.points.push(firstPoint);

    // Initial render
    this.canvasManager.updateDraft(this.currentStroke);
    this.updatePressureBadge(firstPoint.pressure, e.pointerType);
  }

  handlePointerMove(e) {
    const rect = this.canvasManager.getRect();
    const x = e.clientX;
    const y = e.clientY;

    // Update floating circular cursor
    this.updateCursorPosition(x, y);

    if (!this.isDrawing) return;

    // Handle laser trail movement
    if (this.currentTool === 'laser') {
      const events = (typeof e.getCoalescedEvents === 'function')
        ? e.getCoalescedEvents()
        : [e];
      for (const sub of events) {
        const px = sub.clientX - rect.left;
        const py = sub.clientY - rect.top;
        const last = this.laserPoints[this.laserPoints.length - 1];
        if (!last || Math.hypot(px - last.x, py - last.y) >= 2.5) {
          this.laserPoints.push({
            x: px,
            y: py,
            time: performance.now()
          });
        }
      }
      this.startLaserAnimation();
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    // Handle Stroke Eraser continuous collision during sweep
    if (this.currentTool === 'eraser') {
      const currX = e.clientX - rect.left;
      const currY = e.clientY - rect.top;

      if (this.lastEraserPos) {
        const dist = Math.hypot(currX - this.lastEraserPos.x, currY - this.lastEraserPos.y);
        const steps = Math.max(1, Math.ceil(dist / 5));
        for (let s = 1; s <= steps; s++) {
          const ix = this.lastEraserPos.x + (currX - this.lastEraserPos.x) * (s / steps);
          const iy = this.lastEraserPos.y + (currY - this.lastEraserPos.y) * (s / steps);
          this.performStrokeEraser(ix, iy);
        }
      } else {
        this.performStrokeEraser(currX, currY);
      }

      this.lastEraserPos = { x: currX, y: currY };
      return;
    }

    if (!this.currentStroke) return;

    // Retrieve high-frequency coalesced sub-events if supported by browser/hardware
    const events = (typeof e.getCoalescedEvents === 'function')
      ? e.getCoalescedEvents()
      : [e];

    for (const subEvent of events) {
      const prevPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
      const point = StrokeEngine.extractPoint(subEvent, prevPoint, this.currentTool, rect);
      this.currentStroke.points.push(point);
      this.updatePressureBadge(point.pressure, subEvent.pointerType);
    }

    // Render active ribbon draft in real-time
    this.canvasManager.updateDraft(this.currentStroke);
  }

  handlePointerUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (e && e.pointerId && this.draftCanvas.hasPointerCapture(e.pointerId)) {
      this.draftCanvas.releasePointerCapture(e.pointerId);
    }

    // Laser pointer does not persist to main canvas or history
    if (this.currentTool === 'laser') {
      this.resetPressureBadge();
      return;
    }

    // Finalize Stroke Eraser gesture and record undo entry
    if (this.currentTool === 'eraser') {
      if (this.deletedStrokesSession && this.deletedStrokesSession.length > 0) {
        this.historyManager.recordStrokeDeletion(this.deletedStrokesSession);
      }
      this.deletedStrokesSession = [];
      this.lastEraserPos = null;
      this.resetPressureBadge();
      return;
    }

    if (this.currentStroke && this.currentStroke.points.length > 0) {
      // Commit stroke to main static canvas layer
      this.canvasManager.commitDraft(this.currentStroke);
      this.historyManager.addStroke(this.currentStroke);
    }

    this.currentStroke = null;
    this.resetPressureBadge();
  }

  /**
   * Perform instantaneous stroke deletion on collision
   */
  performStrokeEraser(ex, ey) {
    const strokes = this.historyManager.getStrokes();
    if (!strokes || strokes.length === 0) return;

    const eraserRadius = Math.max(this.currentSize * 2.5, 12);
    let anyDeleted = false;

    // Check backwards so splice doesn't skip subsequent items
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      if (StrokeEngine.intersectsStroke(stroke, ex, ey, eraserRadius)) {
        this.deletedStrokesSession.push({
          stroke,
          index: i
        });
        strokes.splice(i, 1);
        anyDeleted = true;
      }
    }

    if (anyDeleted) {
      this.canvasManager.redrawAll(strokes);
    }
  }

  startLaserAnimation() {
    if (this.laserAnimationId) return;

    const animate = () => {
      const now = performance.now();
      const LASER_LIFETIME = 1100;
      this.laserPoints = this.laserPoints.filter(p => (now - p.time) < LASER_LIFETIME);

      if (this.laserPoints.length > 0) {
        const laserColor = (this.currentColor === '#f8fafc' || this.currentColor === '#0f172a')
          ? '#f43f5e'
          : this.currentColor;
        this.canvasManager.renderLaserTrail(this.laserPoints, laserColor, this.currentSize);
        this.laserAnimationId = requestAnimationFrame(animate);
      } else {
        this.canvasManager.clearDraft();
        this.laserAnimationId = null;
      }
    };

    this.laserAnimationId = requestAnimationFrame(animate);
  }

  updateCursorPosition(x, y) {
    this.brushCursor.style.left = `${x}px`;
    this.brushCursor.style.top = `${y}px`;
  }

  updateCursorVisual() {
    const size = Math.max(this.currentSize, 4);
    this.brushCursor.style.width = `${size}px`;
    this.brushCursor.style.height = `${size}px`;

    if (this.currentTool === 'laser') {
      const laserColor = (this.currentColor === '#f8fafc' || this.currentColor === '#0f172a')
        ? '#f43f5e'
        : this.currentColor;
      this.brushCursor.style.borderColor = laserColor;
      this.brushCursor.style.backgroundColor = 'rgba(244, 63, 94, 0.4)';
      this.brushCursor.style.boxShadow = `0 0 10px ${laserColor}`;
    } else if (this.currentTool === 'eraser') {
      const r = Math.max(this.currentSize * 2.5, 12);
      this.brushCursor.style.width = `${r * 2}px`;
      this.brushCursor.style.height = `${r * 2}px`;
      this.brushCursor.style.borderColor = 'var(--danger)';
      this.brushCursor.style.backgroundColor = 'rgba(244, 63, 94, 0.12)';
      this.brushCursor.style.boxShadow = '0 0 0 1px rgba(244, 63, 94, 0.35)';
    } else {
      this.brushCursor.style.borderColor = this.currentColor;
      this.brushCursor.style.backgroundColor = 'transparent';
      this.brushCursor.style.boxShadow = 'none';
    }
  }

  updatePressureBadge(pressure, pointerType) {
    const percentage = Math.round(pressure * 100);
    const typeLabel = pointerType === 'pen' ? 'Stylus' : 'Velocity';
    this.pressureText.textContent = `${typeLabel}: ${percentage}%`;
  }

  resetPressureBadge() {
    this.pressureText.textContent = 'Stylus / Mouse Ready';
  }

  /* ========================================================================
     Toolbar & Interactive Controls
     ======================================================================== */

  bindToolbarEvents() {
    // Tool selection buttons
    const toolBtns = document.querySelectorAll('.dock-btn[data-tool]');
    toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        toolBtns.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
        this.setTool(btn.dataset.tool);
      });
    });

    // Preset color swatches
    const swatches = document.querySelectorAll('.swatch-btn');
    swatches.forEach((swatch) => {
      swatch.addEventListener('click', () => {
        swatches.forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        this.setColor(swatch.dataset.color);
      });
    });

    // Custom color input
    this.customColorInput.addEventListener('input', (e) => {
      const color = e.target.value;
      swatches.forEach((s) => s.classList.remove('active'));
      this.customColorPreview.style.backgroundColor = color;
      this.setColor(color);
    });

    // Stroke size slider
    this.sizeSlider.addEventListener('input', (e) => {
      this.setSize(parseInt(e.target.value, 10));
    });

    // Undo / Redo
    this.btnUndo.addEventListener('click', () => this.handleUndo());
    this.btnRedo.addEventListener('click', () => this.handleRedo());

    // Grid toggle
    document.getElementById('btn-grid-toggle').addEventListener('click', () => {
      const active = this.canvasManager.toggleGrid();
      document.getElementById('btn-grid-toggle').classList.toggle('active', active);
    });

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });

    // Clear confirmation trigger
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (this.historyManager.getStrokes().length === 0) return;
      this.modalClear.showModal();
    });

    // Export trigger
    document.getElementById('btn-export').addEventListener('click', () => {
      this.modalExport.showModal();
    });

    // Shortcuts trigger
    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      this.modalShortcuts.showModal();
    });
  }

  setTool(tool) {
    this.currentTool = tool;
    this.updateCursorVisual();
  }

  setColor(color) {
    this.currentColor = color;
    this.updateCursorVisual();
  }

  setSize(size) {
    this.currentSize = size;
    this.sizeSlider.value = size;
    this.updateSizeDisplay();
    this.updateCursorVisual();
  }

  updateSizeDisplay() {
    this.sizeDisplay.textContent = `${this.currentSize}px`;
    const dotSize = Math.max(2, Math.min(this.currentSize / 2, 20));
    this.sizePreviewDot.style.width = `${dotSize}px`;
    this.sizePreviewDot.style.height = `${dotSize}px`;
  }

  handleUndo() {
    const remainingStrokes = this.historyManager.undo();
    if (remainingStrokes !== null) {
      this.canvasManager.redrawAll(remainingStrokes);
    }
  }

  handleRedo() {
    const remainingStrokes = this.historyManager.redo();
    if (remainingStrokes !== null) {
      this.canvasManager.redrawAll(remainingStrokes);
    }
  }

  handleHistoryStateChange(state) {
    this.btnUndo.disabled = !state.canUndo;
    this.btnRedo.disabled = !state.canRedo;
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', this.theme);
    this.canvasManager.setTheme(this.theme);

    // Auto-adjust default pen color if using default white/black
    if (this.theme === 'light' && this.currentColor === '#f8fafc') {
      this.selectSwatchByColor('#0f172a');
    } else if (this.theme === 'dark' && this.currentColor === '#0f172a') {
      this.selectSwatchByColor('#f8fafc');
    }
  }

  selectSwatchByColor(color) {
    const swatches = document.querySelectorAll('.swatch-btn');
    swatches.forEach((s) => {
      const match = s.dataset.color.toLowerCase() === color.toLowerCase();
      s.classList.toggle('active', match);
    });
    this.setColor(color);
  }

  /* ========================================================================
     Keyboard Shortcuts
     ======================================================================== */

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't trigger if user is interacting with an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (isCtrlOrCmd && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.handleRedo();
        } else {
          this.handleUndo();
        }
      } else if (isCtrlOrCmd && key === 'y') {
        e.preventDefault();
        this.handleRedo();
      } else if (isCtrlOrCmd && key === 's') {
        e.preventDefault();
        this.modalExport.showModal();
      } else if (key === 'p') {
        this.triggerToolClick('pen');
      } else if (key === 'b') {
        this.triggerToolClick('brush');
      } else if (key === 'l' || key === 'h') {
        this.triggerToolClick('laser');
      } else if (key === 'e') {
        this.triggerToolClick('eraser');
      } else if (key === 'g') {
        document.getElementById('btn-grid-toggle').click();
      } else if (key === '[') {
        this.setSize(Math.max(1, this.currentSize - 2));
      } else if (key === ']') {
        this.setSize(Math.min(48, this.currentSize + 2));
      } else if (key === '?') {
        this.modalShortcuts.showModal();
      }
    });
  }

  triggerToolClick(toolName) {
    const btn = document.querySelector(`.dock-btn[data-tool="${toolName}"]`);
    if (btn) btn.click();
  }

  /* ========================================================================
     Modals: Clear Confirmation & Export
     ======================================================================== */

  bindModals() {
    // Clear Modal
    document.getElementById('btn-cancel-clear').addEventListener('click', () => {
      this.modalClear.close();
    });

    document.getElementById('btn-confirm-clear').addEventListener('click', () => {
      this.historyManager.clearAll();
      this.canvasManager.clearMain();
      this.modalClear.close();
    });

    // Export Modal
    document.getElementById('btn-cancel-export').addEventListener('click', () => {
      this.modalExport.close();
    });

    document.getElementById('btn-download-png').addEventListener('click', () => {
      const selectedBg = document.querySelector('input[name="export-bg"]:checked')?.value || 'theme';
      const dataUrl = this.canvasManager.exportImage(this.historyManager.getStrokes(), selectedBg);
      
      const link = document.createElement('a');
      link.download = `whiteboard-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();

      this.modalExport.close();
    });

    // Shortcuts Modal
    document.getElementById('btn-close-shortcuts').addEventListener('click', () => {
      this.modalShortcuts.close();
    });
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.__whiteboardApp = new WhiteboardApp();
});
