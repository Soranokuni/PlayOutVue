// Shared drag state module - bypasses Tauri WebView2 dataTransfer restrictions
import { ref } from 'vue';
export const draggingItem = ref(null);
