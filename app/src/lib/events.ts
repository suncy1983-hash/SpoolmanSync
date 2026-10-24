/**
 * Simple event emitter for server-side events
 * Used to broadcast spool updates to connected SSE clients
 */

type EventCallback = (data: unknown) => void;

class EventEmitter {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  on(event: string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  emit(event: string, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      }
    }
  }
}

// Singleton instance for app-wide event broadcasting
export const spoolEvents = new EventEmitter();

// Event types
export const SPOOL_UPDATED = 'spool_updated';
export const ACTIVITY_LOG_CREATED = 'activity_log_created';
export const ALERT_UPDATED = 'alert_updated';

export interface SpoolUpdateEvent {
  type: 'usage' | 'assign' | 'unassign' | 'tray_change' | 'weight_sync';
  spoolId?: number;
  spoolName?: string;
  deducted?: number;
  newWeight?: number;
  trayId?: string;
  timestamp: number;
}

export interface ActivityLogEvent {
  id: string;
  type: string;
  message: string;
  details: string | null;
  createdAt: string;
}
