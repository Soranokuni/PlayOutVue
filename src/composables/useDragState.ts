// Shared drag state module - bypasses Tauri WebView2 dataTransfer restrictions
import { ref } from 'vue';
import type { ComplianceRating } from '../stores/rundown';

// Only the minimal fields needed to create a RundownItem.
// The rundown store's makeItem() factory fills in inPoint, outPoint, plannedDuration, note etc.
export interface DragPayload {
    filename: string;
    path: string;
    shortPath: string;
    type: 'video' | 'live' | 'graphic';
    duration: number;
    seek: number;
    length: number;
    complianceRating?: ComplianceRating;
}

export const draggingItem = ref<DragPayload | null>(null);

