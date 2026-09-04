/**
 * Stroke Mathematics & Smoothing Engine
 * Handles pointer coalescing, pressure sensitivity, velocity fallback,
 * and smooth quadratic spline curve rendering.
 */

export class StrokeEngine {
  /**
   * Tool profiles defining dynamics and pressure response.
   */
  static TOOL_PROFILES = {
    pen: {
      minWidthFactor: 0.35,
      maxWidthFactor: 1.4,
      smoothing: 0.45,
      velocityFactor: 0.6,
      opacity: 1.0,
      taperEnd: true
    },
    brush: {
      minWidthFactor: 0.2,
      maxWidthFactor: 2.2,
      smoothing: 0.6,
      velocityFactor: 0.85,
      opacity: 1.0,
      taperEnd: true
    },
    laser: {
      minWidthFactor: 1.0,
      maxWidthFactor: 1.0,
      smoothing: 0.3,
      velocityFactor: 0.0,
      opacity: 1.0,
      taperEnd: false
    },
    eraser: {
      minWidthFactor: 1.0,
      maxWidthFactor: 1.0,
      smoothing: 0.2,
      velocityFactor: 0.0,
      opacity: 1.0,
      taperEnd: false
    }
  };

  /**
   * Create a new stroke instance
   */
  static createStroke(tool, color, size) {
    return {
      tool: tool || 'pen',
      color: color || '#f8fafc',
      baseSize: size || 4,
      points: [],
      timestamp: Date.now()
    };
  }

  /**
   * Create a standardized point from a PointerEvent in world space.
   * Handles real stylus pressure or calculates velocity-based fallback for mouse/touch.
   */
  static extractPoint(e, prevPoint, toolType, canvasRect, viewTransform = null) {
    const screenX = e.clientX - canvasRect.left;
    const screenY = e.clientY - canvasRect.top;

    // Convert screen coordinates to world space
    let x = screenX;
    let y = screenY;
    const zoom = (viewTransform && typeof viewTransform.zoom === 'number') ? viewTransform.zoom : 1;
    if (viewTransform) {
      x = (screenX - (viewTransform.panX || 0)) / zoom;
      y = (screenY - (viewTransform.panY || 0)) / zoom;
    }

    const time = e.timeStamp || Date.now();
    const isStylus = e.pointerType === 'pen';

    let pressure = 0.5;
    let velocity = 0;

    if (prevPoint) {
      const dt = Math.max(time - prevPoint.time, 8); // clamp to prevent div by 0
      const dx = (x - prevPoint.x) * zoom; // evaluate velocity in screen pixels
      const dy = (y - prevPoint.y) * zoom;
      const dist = Math.hypot(dx, dy);
      const instantVelocity = dist / dt;

      // Exponential moving average for velocity
      velocity = prevPoint.velocity * 0.4 + instantVelocity * 0.6;

      if (isStylus && typeof e.pressure === 'number' && e.pressure > 0) {
        // Hardware stylus detected
        pressure = prevPoint.pressure * 0.3 + e.pressure * 0.7;
      } else {
        // Mouse / standard touch: simulate natural pressure inversely from velocity
        const profile = this.TOOL_PROFILES[toolType] || this.TOOL_PROFILES.pen;
        const normalizedVel = Math.min(Math.max((velocity - 0.1) / 2.0, 0), 1);
        const simPressure = 0.85 - normalizedVel * profile.velocityFactor;
        pressure = prevPoint.pressure * 0.5 + simPressure * 0.5;
      }
    } else {
      if (isStylus && typeof e.pressure === 'number' && e.pressure > 0) {
        pressure = e.pressure;
      } else {
        pressure = 0.5;
      }
    }

    // Clamp pressure between 0.05 and 1.0
    pressure = Math.max(0.05, Math.min(pressure, 1.0));

    return { x, y, pressure, time, velocity };
  }

  /**
   * Calculates the width for a given point based on tool profile, pressure, and entry/exit tapers
   */
  static getPointWidth(point, baseSize, toolType, index = 0, totalPoints = 1) {
    const profile = this.TOOL_PROFILES[toolType] || this.TOOL_PROFILES.pen;
    const range = profile.maxWidthFactor - profile.minWidthFactor;
    const factor = profile.minWidthFactor + range * point.pressure;
    let width = baseSize * factor;

    // Apply natural entry and exit tapering for pen and brush
    if (profile.taperEnd && totalPoints > 3) {
      if (index === 0) width *= 0.45;
      else if (index === 1) width *= 0.75;
      else if (index === totalPoints - 1) width *= 0.45;
      else if (index === totalPoints - 2) width *= 0.75;
    }

    return Math.max(width, 1.0);
  }

  /**
   * Render a stroke cleanly to a canvas context without hollow loops or donut artifacts.
   */
  static renderStroke(ctx, stroke) {
    const points = stroke.points;
    if (!points || points.length === 0) return;

    const tool = stroke.tool;
    const baseSize = stroke.baseSize;
    const color = stroke.color;
    const n = points.length;

    ctx.save();

    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
      ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    } else if (tool === 'highlighter') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = this.TOOL_PROFILES.highlighter.opacity;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Single point (Dot / click)
    if (n === 1) {
      const w = this.getPointWidth(points[0], baseSize, tool, 0, 1);
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Two points (short line segment)
    if (n === 2) {
      const w = (this.getPointWidth(points[0], baseSize, tool, 0, 2) +
                 this.getPointWidth(points[1], baseSize, tool, 1, 2)) / 2;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo(points[1].x, points[1].y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Highlighter: render as a single continuous smooth curve to avoid joint darkening
    if (tool === 'highlighter') {
      ctx.lineWidth = baseSize * 2.8;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < n - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
      }
      ctx.lineTo(points[n - 1].x, points[n - 1].y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Pen, Brush, Eraser: render variable-width quadratic bezier segments with round joins
    let prevMid = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2
    };

    // First segment from p[0] to mid(0,1)
    const firstWidth = this.getPointWidth(points[0], baseSize, tool, 0, n);
    ctx.lineWidth = firstWidth;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(prevMid.x, prevMid.y);
    ctx.stroke();

    // Intermediate segments between midpoints
    for (let i = 1; i < n - 1; i++) {
      const currMid = {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2
      };

      const segWidth = this.getPointWidth(points[i], baseSize, tool, i, n);
      ctx.lineWidth = segWidth;
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(points[i].x, points[i].y, currMid.x, currMid.y);
      ctx.stroke();

      prevMid = currMid;
    }

    // Final segment from last mid to p[n-1]
    const lastWidth = this.getPointWidth(points[n - 1], baseSize, tool, n - 1, n);
    ctx.lineWidth = lastWidth;
    ctx.beginPath();
    ctx.moveTo(prevMid.x, prevMid.y);
    ctx.lineTo(points[n - 1].x, points[n - 1].y);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Fast geometric collision check between an eraser circle and a stroke
   */
  static intersectsStroke(stroke, ex, ey, eraserRadius) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return false;

    // Fast Bounding Box check
    const bbox = stroke.bbox;
    if (bbox) {
      if (
        ex + eraserRadius < bbox.minX ||
        ex - eraserRadius > bbox.maxX ||
        ey + eraserRadius < bbox.minY ||
        ey - eraserRadius > bbox.maxY
      ) {
        return false;
      }
    }

    const points = stroke.points;
    const n = points.length;
    const threshold = eraserRadius + (stroke.baseSize || 4) / 2 + 2;
    const threshSq = threshold * threshold;

    // Single point / dot check
    if (n === 1) {
      const dx = ex - points[0].x;
      const dy = ey - points[0].y;
      return (dx * dx + dy * dy) <= threshSq;
    }

    // Check each line segment of the stroke
    for (let i = 0; i < n - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      const vx = p2.x - p1.x;
      const vy = p2.y - p1.y;
      const wx = ex - p1.x;
      const wy = ey - p1.y;

      const c1 = wx * vx + wy * vy;
      if (c1 <= 0) {
        if ((wx * wx + wy * wy) <= threshSq) return true;
        continue;
      }

      const c2 = vx * vx + vy * vy;
      if (c2 <= c1) {
        const dx = ex - p2.x;
        const dy = ey - p2.y;
        if ((dx * dx + dy * dy) <= threshSq) return true;
        continue;
      }

      const b = c1 / c2;
      const projX = p1.x + b * vx;
      const projY = p1.y + b * vy;
      const dx = ex - projX;
      const dy = ey - projY;
      if ((dx * dx + dy * dy) <= threshSq) return true;
    }

    return false;
  }

  /**
   * Check if a stroke intersects or lies within an axis-aligned bounding box
   */
  static intersectsBox(stroke, box) {
    if (!stroke || !stroke.points || stroke.points.length === 0 || !box) return false;

    // Fast check: stroke bounding box vs selection box
    const sBox = stroke.bbox;
    if (sBox) {
      if (
        sBox.maxX < box.minX ||
        sBox.minX > box.maxX ||
        sBox.maxY < box.minY ||
        sBox.minY > box.maxY
      ) {
        return false;
      }
    }

    const points = stroke.points;
    const n = points.length;

    // Check if any point is inside the box
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY) {
        return true;
      }
    }

    // Check if any line segment intersects the 4 rectangle boundaries
    const boxEdges = [
      { x1: box.minX, y1: box.minY, x2: box.maxX, y2: box.minY },
      { x1: box.maxX, y1: box.minY, x2: box.maxX, y2: box.maxY },
      { x1: box.maxX, y1: box.maxY, x2: box.minX, y2: box.maxY },
      { x1: box.minX, y1: box.maxY, x2: box.minX, y2: box.minY }
    ];

    const segsIntersect = (a1, a2, b1, b2) => {
      const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
      return (ccw(a1, b1, b2) !== ccw(a2, b1, b2)) && (ccw(a1, a2, b1) !== ccw(a1, a2, b2));
    };

    for (let i = 0; i < n - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      for (const edge of boxEdges) {
        if (segsIntersect(p1, p2, { x: edge.x1, y: edge.y1 }, { x: edge.x2, y: edge.y2 })) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Calculate composite bounding box enclosing an array of strokes
   */
  static getStrokesBoundingBox(strokes, padding = 8) {
    if (!strokes || strokes.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;

    for (const stroke of strokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      count++;
      for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    if (count === 0 || minX === Infinity) return null;

    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
      width: (maxX - minX) + padding * 2,
      height: (maxY - minY) + padding * 2
    };
  }

  /**
   * Check if a point (x, y) is inside a bounding box
   */
  static isPointInBox(x, y, box, padding = 0) {
    if (!box) return false;
    return (
      x >= box.minX - padding &&
      x <= box.maxX + padding &&
      y >= box.minY - padding &&
      y <= box.maxY + padding
    );
  }

  /**
   * Offset all points in a stroke by delta (dx, dy)
   */
  static offsetStroke(stroke, dx, dy) {
    if (!stroke || !stroke.points) return;
    for (const p of stroke.points) {
      p.x += dx;
      p.y += dy;
    }
    if (stroke.bbox) {
      stroke.bbox.minX += dx;
      stroke.bbox.maxX += dx;
      stroke.bbox.minY += dy;
      stroke.bbox.maxY += dy;
    }
  }
}

