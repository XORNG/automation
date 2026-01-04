/**
 * XORNG Automation - Utilities
 */

export { 
  CircuitBreaker, 
  CircuitBreakerRegistry, 
  circuitBreakerRegistry,
  type CircuitBreakerConfig,
  type CircuitState,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

export {
  StatePersistence,
  createStatePersistence,
  type StatePersistenceConfig,
  type PersistedFixAttempt,
  type PersistedRepoLock,
  type PersistedAnalysis,
} from './state-persistence.js';
