/**
 * Minimal Whiteboard - Application Controller
 * Orchestrates pointer input, tool selection, undo/redo history,
 * infinite expandable viewport (pan/zoom), and UI interactions.
 */

import { StrokeEngine } from './stroke.js';
import { CanvasManager } from './canvas.js';
import { HistoryManager } from './history.js';

class WhiteboardApp {
  constructor() {
    // Current Tool & Style State
    this.currentTool = 'pen';
    this.currentColor = '#f8fafc';
    this.currentSize = 4;
    this.theme = 'dark';

    // Drawing & Interaction State
    this.isDrawing = false;
    this.currentStroke = null;
    this.isPointerInsideCanvas = false;

    // Viewport Navigation (Pan & Zoom)
    this.isPanning = false;
    this.isSpacePressed = false;
    this.lastPanPos = { x: 0, y: 0 };
    this.activePointers = new Map();
    this.initialPinchDistance = null;
    this.initialPinchZoom = 1.0;

    // Ephemeral Laser Pointer State
    this.laserPoints = [];
    this.laserAnimationId = null;

    // Stroke Eraser Session State
    this.deletedStrokesSession = [];
    this.lastEraserPos = null;

    // Selection & Move State
    this.selectedStrokes = [];
    this.selectionBBox = null;
    this.selectionDragMode = null; // 'move' | 'marquee' | null
    this.dragStartWorld = null;
    this.currentDragOffset = { dx: 0, dy: 0 };

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

    // Floating Selection Action Bar Elements
    this.selectionOverlayBar = document.getElementById('selection-overlay-bar');
    this.btnDeleteSelected = document.getElementById('btn-delete-selected');
    this.btnDeselect = document.getElementById('btn-deselect');

    // Zoom & Viewport Dock Elements
    this.zoomPercentage = document.getElementById('zoom-percentage');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomReset = document.getElementById('btn-zoom-reset');
    this.btnZoomFit = document.getElementById('btn-zoom-fit');

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
      if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
        this.updateSelectionUI();
      }
    });

    // Restore previous session if exists
    const restored = this.historyManager.loadFromStorage();
    if (restored && restored.length > 0) {
      this.canvasManager.redrawAll(restored);
    }

    this.bindPointerEvents();
    this.bindViewportNavigation();
    this.bindToolbarEvents();
    this.bindKeyboardShortcuts();
    this.bindModals();

    this.container.setAttribute('data-tool', this.currentTool);
    this.draftCanvas.setAttribute('data-tool', this.currentTool);
    this.updateSizeDisplay();
    this.updateZoomDisplay();
  }

  /* ========================================================================
     High-Performance Pointer Events (Pen / Stylus / Touch / Mouse)
     ======================================================================== */

  bindPointerEvents() {
    this.draftCanvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    this.draftCanvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    this.draftCanvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    this.draftCanvas.addEventListener('pointercancel', (e) => this.handlePointerUp(e));

    // Canvas container enter/leave tracking
    this.container.addEventListener('pointerenter', () => {
      this.isPointerInsideCanvas = true;
    });

    this.container.addEventListener('pointerleave', () => {
      this.isPointerInsideCanvas = false;
    });
  }

  handlePointerDown(e) {
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Multi-touch pinch-to-zoom check (2 fingers down)
    if (this.activePointers.size === 2) {
      this.isDrawing = false;
      this.currentStroke = null;
      this.canvasManager.clearDraft();
      this.isPanning = true;
      const pts = Array.from(this.activePointers.values());
      this.initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.initialPinchZoom = this.canvasManager.zoom;
      this.lastPanPos = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
      return;
    }

    // Panning navigation (Middle Mouse Button, Spacebar held, or Pan Tool active)
    if (e.button === 1 || this.isSpacePressed || this.currentTool === 'pan') {
      this.isPanning = true;
      this.lastPanPos = { x: e.clientX, y: e.clientY };
      this.container.classList.add('is-panning');
      this.draftCanvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Only handle primary button for drawing / selecting
    if (e.button !== 0) return;

    this.isDrawing = true;
    this.draftCanvas.setPointerCapture(e.pointerId);

    const rect = this.canvasManager.getRect();
    const transform = this.canvasManager.getViewTransform();

    // Select & Move mode: click or marquee selection and live displacement
    if (this.currentTool === 'select') {
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.dragStartWorld = { x: world.x, y: world.y };
      this.currentDragOffset = { dx: 0, dy: 0 };

      // 1. Check if clicking inside already selected bounding box to initiate move
      const isInsideSelection = this.selectedStrokes.length > 0 &&
        StrokeEngine.isPointInBox(world.x, world.y, this.selectionBBox, 8 / this.canvasManager.zoom);

      if (isInsideSelection) {
        this.selectionDragMode = 'move';
        this.container.classList.add('is-moving-selection');
        if (this.selectionOverlayBar) this.selectionOverlayBar.style.display = 'none';
        this.canvasManager.redrawAllExcept(this.historyManager.getStrokes(), this.selectedStrokes);
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, this.currentDragOffset);
        return;
      }

      // 2. Check if clicking directly on a stroke to select it
      const strokes = this.historyManager.getStrokes();
      let hitStroke = null;
      const hitTolerance = Math.max(8 / this.canvasManager.zoom, 4);

      for (let i = strokes.length - 1; i >= 0; i--) {
        if (StrokeEngine.intersectsStroke(strokes[i], world.x, world.y, hitTolerance)) {
          hitStroke = strokes[i];
          break;
        }
      }

      if (hitStroke) {
        if (e.shiftKey) {
          const idx = this.selectedStrokes.findIndex(s => s.id === hitStroke.id);
          if (idx !== -1) {
            this.selectedStrokes.splice(idx, 1);
          } else {
            this.selectedStrokes.push(hitStroke);
          }
        } else {
          const alreadySelected = this.selectedStrokes.some(s => s.id === hitStroke.id);
          if (!alreadySelected) {
            this.selectedStrokes = [hitStroke];
          }
        }

        this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
        this.selectionDragMode = 'move';
        this.container.classList.add('is-moving-selection');
        if (this.selectionOverlayBar) this.selectionOverlayBar.style.display = 'none';
        this.canvasManager.redrawAllExcept(this.historyManager.getStrokes(), this.selectedStrokes);
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, this.currentDragOffset);
        return;
      }

      // 3. Clicked empty space: clear selection unless Shift is held, and start marquee drag
      if (!e.shiftKey) {
        this.clearSelection();
      }
      this.selectionDragMode = 'marquee';
      this.container.classList.add('is-marquee-selecting');
      return;
    }

    // Laser pointer mode: ephemeral glowing trail in world space
    if (this.currentTool === 'laser') {
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.laserPoints = [{
        x: world.x,
        y: world.y,
        time: performance.now()
      }];
      this.startLaserAnimation();
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    // Stroke Eraser mode: touch or swipe across any stroke to delete it completely
    if (this.currentTool === 'eraser') {
      this.deletedStrokesSession = [];
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.lastEraserPos = { x: world.x, y: world.y };
      this.performStrokeEraser(world.x, world.y);
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    // Normal stroke creation in world coordinates
    this.currentStroke = StrokeEngine.createStroke(
      this.currentTool,
      this.currentColor,
      this.currentSize
    );

    const firstPoint = StrokeEngine.extractPoint(e, null, this.currentTool, rect, transform);
    this.currentStroke.points.push(firstPoint);

    // Initial render
    this.canvasManager.updateDraft(this.currentStroke);
    this.updatePressureBadge(firstPoint.pressure, e.pointerType);
  }

  handlePointerMove(e) {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch-to-zoom & two-finger pan
    if (this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const currentCenter = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };

      if (this.initialPinchDistance && this.initialPinchDistance > 10) {
        const factor = currentDist / this.initialPinchDistance;
        const rect = this.canvasManager.getRect();
        this.canvasManager.setZoom(this.initialPinchZoom * factor, currentCenter.x - rect.left, currentCenter.y - rect.top);
      }

      if (this.lastPanPos) {
        const dx = currentCenter.x - this.lastPanPos.x;
        const dy = currentCenter.y - this.lastPanPos.y;
        this.canvasManager.panBy(dx, dy);
      }

      this.lastPanPos = currentCenter;
      this.canvasManager.redrawAll(this.historyManager.getStrokes());
      this.updateZoomDisplay();
      return;
    }

    // Active Panning
    if (this.isPanning) {
      const dx = e.clientX - this.lastPanPos.x;
      const dy = e.clientY - this.lastPanPos.y;
      this.lastPanPos = { x: e.clientX, y: e.clientY };
      this.canvasManager.panBy(dx, dy);
      this.canvasManager.redrawAll(this.historyManager.getStrokes());
      if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
        this.updateSelectionUI();
      }
      return;
    }

    // Select Tool Move / Hover handling
    if (this.currentTool === 'select') {
      const rect = this.canvasManager.getRect();
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      if (!this.selectionDragMode) {
        // Update hover cursor when over selected bounding box
        const isHovering = this.selectedStrokes.length > 0 &&
          StrokeEngine.isPointInBox(world.x, world.y, this.selectionBBox, 6 / this.canvasManager.zoom);
        this.container.classList.toggle('is-hovering-selection', isHovering);
        return;
      }

      if (this.selectionDragMode === 'move') {
        const dx = world.x - this.dragStartWorld.x;
        const dy = world.y - this.dragStartWorld.y;
        this.currentDragOffset = { dx, dy };
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, this.currentDragOffset);
        return;
      }

      if (this.selectionDragMode === 'marquee') {
        this.canvasManager.renderMarquee(this.dragStartWorld, world);
        return;
      }
      return;
    }

    if (!this.isDrawing) return;

    const rect = this.canvasManager.getRect();
    const transform = this.canvasManager.getViewTransform();

    // Handle laser trail movement in world coordinates
    if (this.currentTool === 'laser') {
      const events = (typeof e.getCoalescedEvents === 'function')
        ? e.getCoalescedEvents()
        : [e];
      for (const sub of events) {
        const world = this.canvasManager.screenToWorld(sub.clientX - rect.left, sub.clientY - rect.top);
        const last = this.laserPoints[this.laserPoints.length - 1];
        if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= (2.5 / this.canvasManager.zoom)) {
          this.laserPoints.push({
            x: world.x,
            y: world.y,
            time: performance.now()
          });
        }
      }
      this.startLaserAnimation();
      this.updatePressureBadge(1.0, e.pointerType);
      return;
    }

    // Handle Stroke Eraser continuous collision sweep
    if (this.currentTool === 'eraser') {
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      if (this.lastEraserPos) {
        const dist = Math.hypot(world.x - this.lastEraserPos.x, world.y - this.lastEraserPos.y);
        const stepSize = Math.max(2, 5 / this.canvasManager.zoom);
        const steps = Math.max(1, Math.ceil(dist / stepSize));
        for (let s = 1; s <= steps; s++) {
          const ix = this.lastEraserPos.x + (world.x - this.lastEraserPos.x) * (s / steps);
          const iy = this.lastEraserPos.y + (world.y - this.lastEraserPos.y) * (s / steps);
          this.performStrokeEraser(ix, iy);
        }
      } else {
        this.performStrokeEraser(world.x, world.y);
      }

      this.lastEraserPos = { x: world.x, y: world.y };
      return;
    }

    if (!this.currentStroke) return;

    // Retrieve high-frequency coalesced sub-events
    const events = (typeof e.getCoalescedEvents === 'function')
      ? e.getCoalescedEvents()
      : [e];

    for (const subEvent of events) {
      const prevPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
      const point = StrokeEngine.extractPoint(subEvent, prevPoint, this.currentTool, rect, transform);
      this.currentStroke.points.push(point);
      this.updatePressureBadge(point.pressure, subEvent.pointerType);
    }

    // Render active ribbon draft in real-time
    this.canvasManager.updateDraft(this.currentStroke);
  }

  handlePointerUp(e) {
    if (e && e.pointerId) {
      this.activePointers.delete(e.pointerId);
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.container.classList.remove('is-panning');
      if (e && e.pointerId && this.draftCanvas.hasPointerCapture(e.pointerId)) {
        this.draftCanvas.releasePointerCapture(e.pointerId);
      }
      return;
    }

    // Select Tool Finalization
    if (this.currentTool === 'select') {
      this.isDrawing = false;
      if (e && e.pointerId && this.draftCanvas.hasPointerCapture(e.pointerId)) {
        this.draftCanvas.releasePointerCapture(e.pointerId);
      }
      this.container.classList.remove('is-moving-selection', 'is-marquee-selecting');

      const rect = this.canvasManager.getRect();
      const world = this.canvasManager.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      if (this.selectionDragMode === 'move') {
        const dx = this.currentDragOffset.dx;
        const dy = this.currentDragOffset.dy;

        if (Math.hypot(dx, dy) > 1 && this.selectedStrokes.length > 0) {
          for (const stroke of this.selectedStrokes) {
            StrokeEngine.offsetStroke(stroke, dx, dy);
            this.historyManager.computeBoundingBox(stroke);
          }
          this.historyManager.recordStrokeMove(this.selectedStrokes, dx, dy);
        }

        this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
        this.updateSelectionUI();
      } else if (this.selectionDragMode === 'marquee') {
        if (this.dragStartWorld) {
          const minX = Math.min(this.dragStartWorld.x, world.x);
          const maxX = Math.max(this.dragStartWorld.x, world.x);
          const minY = Math.min(this.dragStartWorld.y, world.y);
          const maxY = Math.max(this.dragStartWorld.y, world.y);
          const boxW = maxX - minX;
          const boxH = maxY - minY;

          if (boxW > 3 || boxH > 3) {
            const marqueeBox = { minX, maxX, minY, maxY };
            const strokes = this.historyManager.getStrokes();
            const matched = strokes.filter(s => StrokeEngine.intersectsBox(s, marqueeBox));

            if (e.shiftKey) {
              const currentIds = new Set(this.selectedStrokes.map(s => s.id));
              for (const m of matched) {
                if (!currentIds.has(m.id)) {
                  this.selectedStrokes.push(m);
                }
              }
            } else {
              this.selectedStrokes = matched;
            }

            this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
          }
        }
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
        this.updateSelectionUI();
      }

      this.selectionDragMode = null;
      this.dragStartWorld = null;
      this.currentDragOffset = { dx: 0, dy: 0 };
      this.resetPressureBadge();
      return;
    }

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
   * Perform instantaneous stroke deletion on collision in world coordinates
   */
  performStrokeEraser(worldX, worldY) {
    const strokes = this.historyManager.getStrokes();
    if (!strokes || strokes.length === 0) return;

    // Eraser radius in world space
    const eraserRadius = Math.max(this.currentSize * 2.5, 12) / this.canvasManager.zoom;
    let anyDeleted = false;

    // Check backwards so splice doesn't skip subsequent items
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      if (StrokeEngine.intersectsStroke(stroke, worldX, worldY, eraserRadius)) {
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

  /**
   * 60–120fps Laser Pointer Animation Loop
   */
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

  /* ========================================================================
     Viewport Navigation: Mouse Wheel, Touchpad, & Zoom Controls
     ======================================================================== */

  bindViewportNavigation() {
    // Mouse Wheel / Trackpad zoom and pan
    this.container.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

    // Zoom Dock Buttons
    if (this.btnZoomIn) {
      this.btnZoomIn.addEventListener('click', () => {
        this.canvasManager.zoomAt(this.canvasManager.width / 2, this.canvasManager.height / 2, 1.25);
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      });
    }

    if (this.btnZoomOut) {
      this.btnZoomOut.addEventListener('click', () => {
        this.canvasManager.zoomAt(this.canvasManager.width / 2, this.canvasManager.height / 2, 0.8);
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      });
    }

    if (this.btnZoomReset) {
      this.btnZoomReset.addEventListener('click', () => {
        this.canvasManager.resetView();
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      });
    }

    if (this.btnZoomFit) {
      this.btnZoomFit.addEventListener('click', () => {
        this.canvasManager.fitToContent(this.historyManager.getStrokes());
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      });
    }
  }

  handleWheel(e) {
    e.preventDefault();

    const rect = this.canvasManager.getRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // Ctrl + Wheel or Pinch gesture: Zoom In & Out
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.canvasManager.zoomAt(screenX, screenY, factor);
      this.canvasManager.redrawAll(this.historyManager.getStrokes());
      this.updateZoomDisplay();
      return;
    }

    // Shift + Wheel: Horizontal shift (Left & Right)
    if (e.shiftKey) {
      this.canvasManager.panBy(-e.deltaY, 0);
      this.canvasManager.redrawAll(this.historyManager.getStrokes());
      if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
        this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
        this.updateSelectionUI();
      }
      return;
    }

    // Natural 2D Pan:
    // Vertical scroll (wheel) shifts Up & Down
    // Horizontal scroll (touchpad) shifts Left & Right
    const dx = -e.deltaX;
    const dy = -e.deltaY;
    this.canvasManager.panBy(dx, dy);
    this.canvasManager.redrawAll(this.historyManager.getStrokes());
    if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
      this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
      this.updateSelectionUI();
    }
  }

  updateZoomDisplay() {
    if (this.zoomPercentage) {
      this.zoomPercentage.textContent = `${Math.round(this.canvasManager.zoom * 100)}%`;
    }
  }

  updatePressureBadge(pressure, pointerType) {
    if (!this.pressureText) return;
    const percentage = Math.round(pressure * 100);
    const typeLabel = pointerType === 'pen' ? 'Stylus' : 'Velocity';
    this.pressureText.textContent = `${typeLabel}: ${percentage}%`;
  }

  resetPressureBadge() {
    if (!this.pressureText) return;
    this.pressureText.textContent = 'Stylus / Mouse Ready';
  }

  /* ========================================================================
     Toolbar & Interactive Controls
     ======================================================================== */

  bindToolbarEvents() {
    // Tool buttons (Pen, Brush, Laser, Eraser, Pan)
    const toolButtons = document.querySelectorAll('.tool-group .dock-btn');
    toolButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        toolButtons.forEach((b) => {
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

    // Selection Overlay Actions
    if (this.btnDeleteSelected) {
      this.btnDeleteSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSelectedStrokes();
      });
    }

    if (this.btnDeselect) {
      this.btnDeselect.addEventListener('click', (e) => {
        e.stopPropagation();
        this.clearSelection();
      });
    }
  }

  updateSelectionUI() {
    if (
      this.currentTool === 'select' &&
      this.selectedStrokes.length > 0 &&
      this.selectionBBox &&
      !this.selectionDragMode
    ) {
      const centerWorldX = this.selectionBBox.minX + this.selectionBBox.width / 2;
      const screenPos = this.canvasManager.worldToScreen(centerWorldX, this.selectionBBox.minY);
      this.selectionOverlayBar.style.left = `${Math.round(screenPos.x)}px`;
      this.selectionOverlayBar.style.top = `${Math.round(Math.max(screenPos.y - 12, 60))}px`;
      this.selectionOverlayBar.style.display = 'flex';
    } else if (this.selectionOverlayBar) {
      this.selectionOverlayBar.style.display = 'none';
    }
  }

  setTool(tool) {
    if (tool !== 'select') {
      this.clearSelection();
    }
    this.currentTool = tool;
    this.container.setAttribute('data-tool', tool);
    this.draftCanvas.setAttribute('data-tool', tool);

    if (tool === 'select' && this.selectedStrokes.length > 0) {
      this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
      this.updateSelectionUI();
    }
  }

  clearSelection() {
    this.selectedStrokes = [];
    this.selectionBBox = null;
    this.selectionDragMode = null;
    this.currentDragOffset = { dx: 0, dy: 0 };
    if (this.selectionOverlayBar) {
      this.selectionOverlayBar.style.display = 'none';
    }
    this.container.classList.remove('is-hovering-selection', 'is-moving-selection', 'is-marquee-selecting');
    this.canvasManager.clearDraft();
  }

  deleteSelectedStrokes() {
    if (!this.selectedStrokes || this.selectedStrokes.length === 0) return;
    const strokes = this.historyManager.getStrokes();
    const deletedItems = [];

    for (const selected of this.selectedStrokes) {
      const idx = strokes.findIndex(s => s.id === selected.id);
      if (idx !== -1) {
        deletedItems.push({ stroke: strokes[idx], index: idx });
        strokes.splice(idx, 1);
      }
    }

    if (deletedItems.length > 0) {
      this.historyManager.recordStrokeDeletion(deletedItems);
    }

    this.clearSelection();
    this.canvasManager.redrawAll(this.historyManager.getStrokes());
  }

  nudgeSelectedStrokes(screenDx, screenDy) {
    if (!this.selectedStrokes || this.selectedStrokes.length === 0) return;
    const worldDx = screenDx / this.canvasManager.zoom;
    const worldDy = screenDy / this.canvasManager.zoom;

    for (const stroke of this.selectedStrokes) {
      StrokeEngine.offsetStroke(stroke, worldDx, worldDy);
      this.historyManager.computeBoundingBox(stroke);
    }
    this.historyManager.recordStrokeMove(this.selectedStrokes, worldDx, worldDy);
    this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
    this.canvasManager.redrawAll(this.historyManager.getStrokes());
    this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
    this.updateSelectionUI();
  }

  setColor(color) {
    this.currentColor = color;
  }

  setSize(size) {
    this.currentSize = size;
    this.sizeSlider.value = size;
    this.updateSizeDisplay();
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
      if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
        const ids = new Set(remainingStrokes.map(s => s.id));
        this.selectedStrokes = this.selectedStrokes.filter(s => ids.has(s.id));
        this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
        if (this.selectedStrokes.length > 0) {
          this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
          this.updateSelectionUI();
        } else {
          this.clearSelection();
        }
      }
    }
  }

  handleRedo() {
    const nextStrokes = this.historyManager.redo();
    if (nextStrokes !== null) {
      this.canvasManager.redrawAll(nextStrokes);
      if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
        const ids = new Set(nextStrokes.map(s => s.id));
        this.selectedStrokes = this.selectedStrokes.filter(s => ids.has(s.id));
        this.selectionBBox = StrokeEngine.getStrokesBoundingBox(this.selectedStrokes, 6);
        if (this.selectedStrokes.length > 0) {
          this.canvasManager.renderSelectionOverlay(this.selectedStrokes, { dx: 0, dy: 0 });
          this.updateSelectionUI();
        } else {
          this.clearSelection();
        }
      }
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
     Keyboard & Shortcut Listeners
     ======================================================================== */

  bindKeyboardShortcuts() {
    // Space key hold for quick pan
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space' && !this.isSpacePressed) {
        this.isSpacePressed = true;
        this.container.classList.add('is-panning');
        e.preventDefault();
        return;
      }

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
      } else if (key === 'v' || (!isCtrlOrCmd && key === 's')) {
        this.triggerToolClick('select');
      } else if (key === 'escape') {
        this.clearSelection();
      } else if (key === 'delete' || key === 'backspace') {
        if (this.selectedStrokes.length > 0) {
          e.preventDefault();
          this.deleteSelectedStrokes();
        }
      } else if (key === 'p') {
        this.triggerToolClick('pen');
      } else if (key === 'b') {
        this.triggerToolClick('brush');
      } else if (key === 'l') {
        this.triggerToolClick('laser');
      } else if (key === 'e') {
        this.triggerToolClick('eraser');
      } else if (key === 'h') {
        this.triggerToolClick('pan');
      } else if (key === '+' || key === '=') {
        e.preventDefault();
        this.canvasManager.zoomAt(this.canvasManager.width / 2, this.canvasManager.height / 2, 1.2);
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      } else if (key === '-' || key === '_') {
        e.preventDefault();
        this.canvasManager.zoomAt(this.canvasManager.width / 2, this.canvasManager.height / 2, 0.82);
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      } else if (key === '0') {
        e.preventDefault();
        this.canvasManager.resetView();
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
        this.updateZoomDisplay();
      } else if (e.shiftKey && key === '!') {
        e.preventDefault();
        this.canvasManager.fitToContent(this.historyManager.getStrokes());
        this.canvasManager.redrawAll(this.historyManager.getStrokes());
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
          this.nudgeSelectedStrokes(e.shiftKey ? -25 : -5, 0);
        } else {
          this.canvasManager.panBy(e.shiftKey ? 120 : 45, 0);
          this.canvasManager.redrawAll(this.historyManager.getStrokes());
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
          this.nudgeSelectedStrokes(e.shiftKey ? 25 : 5, 0);
        } else {
          this.canvasManager.panBy(e.shiftKey ? -120 : -45, 0);
          this.canvasManager.redrawAll(this.historyManager.getStrokes());
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
          this.nudgeSelectedStrokes(0, e.shiftKey ? -25 : -5);
        } else {
          this.canvasManager.panBy(0, e.shiftKey ? 120 : 45);
          this.canvasManager.redrawAll(this.historyManager.getStrokes());
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.currentTool === 'select' && this.selectedStrokes.length > 0) {
          this.nudgeSelectedStrokes(0, e.shiftKey ? 25 : 5);
        } else {
          this.canvasManager.panBy(0, e.shiftKey ? -120 : -45);
          this.canvasManager.redrawAll(this.historyManager.getStrokes());
        }
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

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (!this.isPanning && this.currentTool !== 'pan') {
          this.container.classList.remove('is-panning');
        }
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
      this.clearSelection();
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
      const dataUrl = this.canvasManager.exportImage(this.historyManager.getStrokes(), selectedBg, 'content');
      
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
