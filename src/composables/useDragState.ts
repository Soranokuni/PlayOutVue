// Shared drag state module - bypasses Tauri WebView2 dataTransfer restrictions
import { ref } from 'vue';
import type { ComplianceRating } from '../stores/rundown';

export type DragSource = 'library' | 'rundown' | 'external';

// Minimal fields needed for drag payloads across components.
export interface DragPayload {
    source?: DragSource;
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
