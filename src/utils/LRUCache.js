/**
 * Simple LRU (Least Recently Used) Cache implementation
 * Stores key-value pairs and evicts least recently used items when capacity is exceeded
 */
export class LRUCache {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Get value from cache
   * @param {string} key 
   * @returns {any|undefined} Cached value or undefined if not found
   */
  get(key) {
    if (this.cache.has(key)) {
      // Move to end (mark as recently used)
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return undefined;
  }

  /**
   * Set value in cache
   * @param {string} key 
   * @param {any} value 
   */
  set(key, value) {
    if (this.cache.has(key)) {
      // Update existing key
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Remove least recently used item (first item in Map)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  /**
   * Check if key exists in cache
   * @param {string} key 
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Clear all cached items
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get current cache size
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   * @returns {Object}
   */
  stats() {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      utilizationPercent: Math.round((this.cache.size / this.capacity) * 100)
    };
  }
}

// Create a singleton instance for explanation caching
export const explanationCache = new LRUCache(1000);