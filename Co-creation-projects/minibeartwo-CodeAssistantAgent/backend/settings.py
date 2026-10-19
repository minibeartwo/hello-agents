"""Public model configuration and OS-keyring backed secrets."""
from __future__ import annotations

import os
from urllib.parse import urlparse

from .store import Store


class Settings:
    def __init__(self, store: Store, persist_secrets: bool = True):
        self.store = store
        self.memory_key = os.getenv("LLM_API_KEY", "")
        self.storage = "environment" if self.memory_key else "none"
        self.keyring = None
        if not persist_secrets:
            return
        try:
            import keyring
            self.keyring = keyring
            stored = keyring.get_password("CodeAssistantAgent", "model-api-key")
            if stored:
                self.memory_key, self.storage = stored, "keyring"
        except Exception:
            self.keyring = None

    def public(self) -> dict:
        saved = self.store.settings()
        return {"model": saved.get("model", os.getenv("LLM_MODEL_ID", "")),
                "base_url": saved.get("base_url", os.getenv("LLM_BASE_URL", "")),
                "max_steps": saved.get("max_steps", 12), "task_timeout": saved.get("task_timeout", 300),
                "has_api_key": bool(self.memory_key), "key_storage": self.storage}

    def save(self, values: dict) -> dict:
        endpoint = values.get("base_url", "").rstrip("/")
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("模型地址需要为有效的 HTTP(S) API 地址。")
        if not values.get("model", "").strip():
            raise ValueError("请输入模型名称。")
        public = {"model": values["model"].strip(), "base_url": endpoint,
                  "max_steps": max(1, min(int(values.get("max_steps", 12)), 30)),
                  "task_timeout": max(30, min(int(values.get("task_timeout", 300)), 1800))}
        if values.get("api_key"):
            self.memory_key = values["api_key"]
            self.storage = "memory"
            if self.keyring:
                try:
                    self.keyring.set_password("CodeAssistantAgent", "model-api-key", self.memory_key)
                    self.storage = "keyring"
                except Exception:
                    pass
        self.store.set_settings(public)
        return self.public()
