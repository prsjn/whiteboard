/**
 * History & State Manager
 * Handles undo/redo stack, action dispatching, and optional local auto-persistence.
 */

export class HistoryManager {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || 60;
    this.undoStack = [];
    this.redoStack = [];
    this.onStateChange = options.onStateChange || null;
    this.storageKey = 'minimal_whiteboard_state_v1';
  }

  /**
   * Push a completed stroke or action onto the history stack
   */
  pushStroke(stroke) {
    this.undoStack.push(stroke);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    // Any new action clears redo stack
    this.redoStack = [];
    this.notifyStateChange();
    this.saveToStorage();
  }

  /**
   * Undo the last stroke
   */
  undo() {
    if (!this.canUndo()) return null;
    const stroke = this.undoStack.pop();
    this.redoStack.push(stroke);
    this.notifyStateChange();
    this.saveToStorage();
    return this.undoStack;
  }

  /**
   * Redo the previously undone stroke
   */
  redo() {
    if (!this.canRedo()) return null;
    const stroke = this.redoStack.pop();
    this.undoStack.push(stroke);
    this.notifyStateChange();
    this.saveToStorage();
    return this.undoStack;
  }

  /**
   * Clear all strokes with undo capability
   */
  clearAll() {
    if (this.undoStack.length === 0) return;
    // Push a snapshot action or empty
    this.redoStack = [];
    this.undoStack = [];
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
    return this.undoStack;
  }

  notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        canUndo: this.canUndo(),
        canRedo: this.canRedo(),
        strokeCount: this.undoStack.length
      });
    }
  }

  saveToStorage() {
    try {
      const serialized = JSON.stringify(this.undoStack);
      localStorage.setItem(this.storageKey, serialized);
    } catch (e) {
      // Storage quota or private mode fallback
      console.warn('LocalStorage auto-save failed:', e);
    }
  }

  loadFromStorage() {
    try {
      const data = localStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.undoStack = parsed;
          this.redoStack = [];
          this.notifyStateChange();
          return this.undoStack;
        }
      }
    } catch (e) {
      console.warn('LocalStorage restore failed:', e);
    }
    return null;
  }
}
