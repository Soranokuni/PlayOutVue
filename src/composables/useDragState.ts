// Shared drag state module - bypasses Tauri WebView2 dataTransfer restrictions
import { ref } from 'vue';

// Only the minimal fields needed to create a RundownItem.
// The rundown store's makeItem() factory fills in inPoint, outPoint, plannedDuration, note etc.
export interface DragPayload {
    filename: string;
    path: string;
    type: 'video' | 'live' | 'graphic';
    duration: number;
    seek: number;
    length: number;
}

export const draggingItem = ref<DragPayload | null>(null);

