/**
 * Robust API fetch utility wrapper to handle invalid JSON and empty responses safely.
 */
export async function safeFetch<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallbackValue: T = {} as T
): Promise<T> {
  try {
    const res = await fetch(input, init);
    
    // Check if the response is not OK
    if (!res.ok) {
      console.warn(`[SafeFetch] HTTP Error: ${res.status} ${res.statusText}`);
      return fallbackValue;
    }
    
    // Read the response as text first to handle empty body/invalid JSON
    const text = await res.text();
    if (!text || text.trim() === '') {
      return fallbackValue;
    }
    
    try {
      return JSON.parse(text) as T;
    } catch (parseError) {
      console.error('[SafeFetch] Failed to parse JSON response:', parseError, '\nResponse text:', text);
      return fallbackValue;
    }
  } catch (error) {
    console.error('[SafeFetch] Request failed:', error);
    return fallbackValue;
  }
}
