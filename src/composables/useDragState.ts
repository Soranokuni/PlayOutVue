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
    inPoint?: number;
    outPoint?: number;
    complianceRating?: ComplianceRating;
    playoutvueId?: string;
    display_name?: string;
    virtual_folder?: string;
    current_path?: string;
    duration_ms?: number;
    trim_in_ms?: number;
    trim_out_ms?: number;
    tp_flag?: boolean;
    content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
}

export const draggingItem = ref<DragPayload | null>(null);

