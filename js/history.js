/**
 * History & State Manager
 * Handles action-based undo/redo (add stroke, delete stroke via stroke eraser, clear),
 * and localStorage auto-persistence.
 */

export class HistoryManager {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || 60;
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.onStateChange = options.onStateChange || null;
    this.storageKey = 'minimal_whiteboard_state_v1';
  }

  /**
   * Add a newly committed stroke
   */
  addStroke(stroke) {
    // Generate unique ID and bounding box for fast collision detection
    stroke.id = stroke.id || `stroke_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    this.computeBoundingBox(stroke);

    this.strokes.push(stroke);
    this.undoStack.push({
      type: 'add',
      stroke
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    this.redoStack = [];
    this.notifyStateChange();
    this.saveToStorage();
  }

  /**
   * Delete a batch of strokes (used by Stroke Eraser)
   */
  recordStrokeDeletion(deletedItems) {
    if (!deletedItems || deletedItems.length === 0) return;

    this.undoStack.push({
      type: 'delete',
      items: deletedItems // [{ stroke, index }]
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    this.redoStack = [];
    this.notifyStateChange();
    this.saveToStorage();
  }

  /**
   * Record movement/displacement of strokes
   */
  recordStrokeMove(strokes, dx, dy) {
    if (!strokes || strokes.length === 0 || (dx === 0 && dy === 0)) return;

    this.undoStack.push({
      type: 'move',
      strokes: [...strokes],
      dx,
      dy
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    this.redoStack = [];
    this.notifyStateChange();
    this.saveToStorage();
  }

  /**
   * Undo the last action (add, delete, move, or clear)
   */
  undo() {
    if (!this.canUndo()) return null;

    const action = this.undoStack.pop();

    if (action.type === 'add') {
      // Remove the added stroke
      const idx = this.strokes.indexOf(action.stroke);
      if (idx !== -1) {
        this.strokes.splice(idx, 1);
      }
      this.redoStack.push(action);
    } else if (action.type === 'delete') {
      // Restore deleted strokes in ascending order of original index
      const sorted = [...action.items].sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        const insertIdx = Math.min(item.index, this.strokes.length);
        this.strokes.splice(insertIdx, 0, item.stroke);
      }
      this.redoStack.push(action);
    } else if (action.type === 'move') {
      // Reverse displacement
      for (const stroke of action.strokes) {
        for (const p of stroke.points) {
          p.x -= action.dx;
          p.y -= action.dy;
        }
        this.computeBoundingBox(stroke);
      }
      this.redoStack.push(action);
    } else if (action.type === 'clear') {
      // Restore all strokes
      this.strokes = [...action.strokes];
      this.redoStack.push(action);
    }

    this.notifyStateChange();
    this.saveToStorage();
    return this.strokes;
  }

  /**
   * Redo the previously undone action
   */
  redo() {
    if (!this.canRedo()) return null;

    const action = this.redoStack.pop();

    if (action.type === 'add') {
      this.strokes.push(action.stroke);
      this.undoStack.push(action);
    } else if (action.type === 'delete') {
      // Re-remove the strokes
      for (const item of action.items) {
        const idx = this.strokes.findIndex(s => s.id === item.stroke.id);
        if (idx !== -1) {
          this.strokes.splice(idx, 1);
        }
      }
      this.undoStack.push(action);
    } else if (action.type === 'move') {
      // Re-apply displacement
      for (const stroke of action.strokes) {
        for (const p of stroke.points) {
          p.x += action.dx;
          p.y += action.dy;
        }
        this.computeBoundingBox(stroke);
      }
      this.undoStack.push(action);
    } else if (action.type === 'clear') {
      this.strokes = [];
      this.undoStack.push(action);
    }

    this.notifyStateChange();
    this.saveToStorage();
    return this.strokes;
  }

  /**
   * Clear all strokes with complete undo capability
   */
  clearAll() {
    if (this.strokes.length === 0) return;

    this.undoStack.push({
      type: 'clear',
      strokes: [...this.strokes]
    });

    this.strokes = [];
    this.redoStack = [];
    this.notifyStateChange();
    this.saveToStorage();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  getStrokes() {
    return this.strokes;
  }

  computeBoundingBox(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = (stroke.baseSize || 4) + 4;
    stroke.bbox = {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad
    };
  }

  notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        canUndo: this.canUndo(),
        canRedo: this.canRedo(),
        strokeCount: this.strokes.length
      });
    }
  }

  saveToStorage() {
    try {
      const serialized = JSON.stringify(this.strokes);
      localStorage.setItem(this.storageKey, serialized);
    } catch (e) {
      console.warn('LocalStorage auto-save failed:', e);
    }
  }

  loadFromStorage() {
    try {
      const data = localStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.strokes = parsed;
          for (const s of this.strokes) {
            this.computeBoundingBox(s);
          }
          this.undoStack = [];
          this.redoStack = [];
          this.notifyStateChange();
          return this.strokes;
        }
      }
    } catch (e) {
      console.warn('LocalStorage restore failed:', e);
    }
    return null;
  }
}
