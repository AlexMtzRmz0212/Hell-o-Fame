import threading
import time
from typing import Callable, Generic, Optional, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    """Holds one value for `ttl` seconds. If a refresh fails, the stale value is served instead."""

    def __init__(self, ttl: float):
        self.ttl = ttl
        self._value: Optional[T] = None
        self._loaded_at = 0.0
        self._lock = threading.Lock()

    def get(self, load: Callable[[], T]) -> T:
        with self._lock:
            fresh = self._value is not None and time.monotonic() - self._loaded_at < self.ttl
            if fresh:
                return self._value
            try:
                self._value = load()
                self._loaded_at = time.monotonic()
            except Exception:
                if self._value is None:
                    raise
            return self._value

    def refresh(self, load: Callable[[], T]) -> T:
        """Load a new value now. If that fails the error is raised and the old value stays in place."""
        with self._lock:
            self._value = load()
            self._loaded_at = time.monotonic()
            return self._value

    def clear(self) -> None:
        with self._lock:
            self._value = None
